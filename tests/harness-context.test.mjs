import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { existsSync, readdirSync, openSync, ftruncateSync, closeSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { HARNESS_FILES, changeHarness, verifyCurrent, verifyBundle, readVerifiedHarnessFile, MAX_HARNESS_MANIFEST_BYTES, MAX_HARNESS_BUNDLE_BYTES } from '../scripts/version-harness.mjs';
import { loadBridgeRuntimeContract, inspectHarnessContext, MAX_BRIDGE_CONTRACT_BYTES, MAX_HARNESS_FILE_BYTES, MAX_HARNESS_TOTAL_BYTES } from '../server/harness-context.mjs';
import { runAgent, parseBlogResult } from '../scripts/agent-bridge.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const contract = '## Bridge Runtime Contract\nPreserve owner approval and return the requested JSON only.\n### Evidence\nFixtures never establish real provider readiness.';
function fixture(t, document = `# Director-only context\nDO_NOT_INJECT_DIRECTOR\n${contract}\n\n## Production orchestration\nDO_NOT_INJECT_ORCHESTRATOR\n`) {
  const root = mkdtempSync(join(tmpdir(), 'frameforge-bridge-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of HARNESS_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), file === 'docs/harness.md' ? document : `Authoring fixture for ${file}\n`);
  }
  const pointer = changeHarness(root, 'promote', '1.0.0');
  return { root, pointer, document, selected: join(root, 'harness/versions/1.0.0') };
}

test('selected immutable section is exact, hash-bound and independent of editable or private source files', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'docs/harness.md'), '# Unpromoted editable instructions\nNEVER_IMPORT_EDITABLE');
  mkdirSync(join(f.root, 'llm-wiki/raw'), { recursive: true });
  writeFileSync(join(f.root, 'llm-wiki/raw/private.md'), 'NEVER_IMPORT_RAW');
  const result = loadBridgeRuntimeContract({ root: f.root });
  assert.equal(result.text, contract);
  assert.deepEqual(result.source, { version: '1.0.0', path: 'harness/versions/1.0.0/docs/harness.md', sha256: hash(f.document), bundleSha256: f.pointer.bundleSha256, contractSha256: hash(contract), bytes: Buffer.byteLength(contract) });
  const status = inspectHarnessContext({ root: f.root });
  assert.equal(status.status, 'verified');
  assert.deepEqual(status.source, result.source);
  assert.equal(JSON.stringify(status).includes('Preserve owner approval'), false);
});

for (const row of [
  { name: 'missing pointer', change: f => rmSync(join(f.root, 'harness/manifest.json')), code: 'HARNESS_CONTEXT_UNAVAILABLE' },
  { name: 'tampered selected source', change: f => writeFileSync(join(f.selected, 'docs/harness.md'), 'tampered bytes'), code: 'HARNESS_CONTEXT_UNAVAILABLE' },
  { name: 'tampered manifest hash', change: f => { const pointer = { ...f.pointer, bundleSha256: '0'.repeat(64) }; writeFileSync(join(f.root, 'harness/manifest.json'), JSON.stringify(pointer)); }, code: 'HARNESS_CONTEXT_UNAVAILABLE' },
  { name: 'escaping selected path', change: f => writeFileSync(join(f.root, 'harness/manifest.json'), JSON.stringify({ ...f.pointer, bundlePath: '../../outside' })), code: 'HARNESS_CONTEXT_UNAVAILABLE' },
  { name: 'oversized immutable file', change: f => writeFileSync(join(f.selected, HARNESS_FILES[0]), Buffer.alloc(MAX_HARNESS_FILE_BYTES + 1, 97)), code: 'HARNESS_CONTEXT_TOO_LARGE' },
]) test(`${row.name} fails closed before an agent execute effect`, async t => {
  const f = fixture(t);
  row.change(f);
  let effects = 0;
  const executeImpl = async () => { effects += 1; throw Error('A provider boundary must never be reached'); };
  await assert.rejects(runAgent({ agent: 'jeopi', message: 'No model effects', episode: {} }, { harnessRoot: f.root, executeImpl }), error => error.code === row.code && error.statusCode === 503);
  assert.equal(effects, 0);
  assert.equal(inspectHarnessContext({ root: f.root }).code, row.code);
});

for (const document of ['# No universal runtime section\n', `${contract}\n${contract}\n`, '## Bridge Runtime Contract\n\n## Next\nOther rules']) test('missing, repeated or empty runtime section is not accepted as authority', t => {
  const f = fixture(t, document);
  assert.throws(() => loadBridgeRuntimeContract({ root: f.root }), { code: 'BRIDGE_CONTRACT_MISSING' });
});

test('the contract byte limit measures UTF-8 rather than character count without truncating instructions', t => {
  const prefix = '## Bridge Runtime Contract\n';
  const exact = prefix + 'x'.repeat(MAX_BRIDGE_CONTRACT_BYTES - Buffer.byteLength(prefix));
  const accepted = fixture(t, exact);
  assert.equal(loadBridgeRuntimeContract({ root: accepted.root }).text, exact);
  const rejected = fixture(t, exact.slice(0, -1) + '한');
  assert.throws(() => loadBridgeRuntimeContract({ root: rejected.root }), { code: 'HARNESS_CONTEXT_TOO_LARGE' });
});

test('aggregate immutable input limit rejects a corpus whose individual files fit', t => {
  const f = fixture(t);
  for (const file of HARNESS_FILES.filter(file => file !== 'docs/harness.md').slice(0, Math.ceil(MAX_HARNESS_TOTAL_BYTES / MAX_HARNESS_FILE_BYTES))) writeFileSync(join(f.selected, file), Buffer.alloc(MAX_HARNESS_FILE_BYTES, 97));
  assert.throws(() => loadBridgeRuntimeContract({ root: f.root }), { code: 'HARNESS_CONTEXT_TOO_LARGE' });
});

test('a selected harness ancestor junction is rejected even when target hashes are valid', t => {
  const f = fixture(t);
  const actual = join(f.root, 'outside-harness');
  renameSync(join(f.root, 'harness'), actual);
  symlinkSync(actual, join(f.root, 'harness'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => loadBridgeRuntimeContract({ root: f.root }), { code: 'HARNESS_CONTEXT_UNAVAILABLE' });
});

test('selected runtime inputs load from a container-style root containing only the immutable harness', t => {
  const f = fixture(t);
  for (const file of HARNESS_FILES) rmSync(join(f.root, file));
  const selected = loadBridgeRuntimeContract({ root: f.root });
  assert.equal(selected.text, contract);
  assert.equal(selected.source.bundleSha256, f.pointer.bundleSha256);
});

for (const jobType of ['blog', 'video']) test(`actual fixture process receives section-only ${jobType} instructions without losing the tool-free JSON boundary`, t => {
  const f = fixture(t);
  const capture = join(f.root, 'fixture-input.json');
  const executable = join(f.root, 'fixture-agent.cjs');
  const response = jobType === 'blog'
    ? { title: '검증된 블로그', body: '사실만 담은 본문', sourceEvidence: [{ url: 'https://example.invalid/evidence', title: 'Isolated evidence' }] }
    : { message: '검증된 영상', scenes: Array.from({ length: 3 }, (_, i) => ({ id: `scene-${i + 1}`, title: `장면 ${i + 1}`, text: '확인된 사실', duration: 5, background: '#20342d', kind: 'title', layout: 'center' })) };
  writeFileSync(executable, `const fs = require('node:fs'); const args = process.argv.slice(2); if (!args.includes('--no-tools') || !args.includes('--no-rules') || !args.includes('--no-extensions') || !args.includes('--no-skills')) process.exit(71); fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args,prompt:args.at(-1)})); process.stdout.write(${JSON.stringify(JSON.stringify(response))});`);
  const runner = join(f.root, 'runner.mjs');
  const bridgeUrl = new URL('../scripts/agent-bridge.mjs', import.meta.url).href;
  const request = { agent: 'jeopi', message: 'Only use provided evidence', ...(jobType === 'blog' ? { jobType: 'blog', blog: { evidence: 'source only' } } : { episode: { title: '영상 입력' } }) };
  writeFileSync(runner, `import { spawnSync } from 'node:child_process'; import { writeFileSync } from 'node:fs'; import { runAgent } from ${JSON.stringify(bridgeUrl)}; const result = await runAgent(${JSON.stringify(request)}, {harnessRoot:${JSON.stringify(f.root)},executeImpl: async (_file,args,options) => { const child = spawnSync(process.execPath,[${JSON.stringify(executable)},...args],{cwd:options.cwd,encoding:'utf8',timeout:10000}); if(child.status!==0) throw Error('Fixture boundary rejected unsafe invocation: '+child.status); return {stdout:child.stdout}; }}); writeFileSync(${JSON.stringify(join(f.root, 'result.json'))},JSON.stringify(result));`);
  const child = spawnSync(process.execPath, [runner], { cwd: f.root, env: { ...process.env, JEOPI_CLI: process.execPath }, encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(readFileSync(join(f.root, 'result.json'), 'utf8'));
  if (jobType === 'blog') assert.deepEqual(result, response);
  else {
    assert.equal(result.message, response.message);
    assert.deepEqual(result.scenes.map(scene => Object.fromEntries(Object.keys(response.scenes[0]).map(key => [key, scene[key]]))), response.scenes);
  }
  const input = JSON.parse(readFileSync(capture, 'utf8'));
  assert.ok(input.prompt.includes(contract));
  for (const denied of ['DO_NOT_INJECT_DIRECTOR', 'DO_NOT_INJECT_ORCHESTRATOR']) assert.equal(input.prompt.includes(denied), false);
  assert.ok(input.prompt.includes(jobType === 'blog' ? 'Never return scenes' : '"scenes"'));
  assert.ok(input.prompt.includes('Only use provided evidence'));
});

test('blog JSON output byte cap accepts its exact boundary and rejects one extra byte without truncation', () => {
  const response = { title: '경계', body: '한😀'.repeat(4000), sourceEvidence: [{ url: 'https://example.invalid/source', title: 'Evidence' }] };
  const json = JSON.stringify(response);
  const bounded = json + ' '.repeat(262144 - Buffer.byteLength(json));
  assert.deepEqual(parseBlogResult(bounded), response);
  assert.throws(() => parseBlogResult(bounded + ' '), error => error.status === 502 && /exceeds/.test(error.message));
});

for (const jobType of ['blog', 'video']) test(`Codex ${jobType} execution retains its job schema and read-only tool boundary with the immutable contract`, async t => {
  const f = fixture(t);
  const executable = join(f.root, 'schema-consumer.cjs');
  const capture = join(f.root, 'codex-prompt.txt');
  const blog = { title: 'Schema-bound article', body: 'Only approved evidence.', sourceEvidence: [{ url: 'https://example.invalid/source', title: 'Fixture evidence' }] };
  const video = { message: 'Schema-bound video', scenes: [{ id: 'scene-1', title: 'Evidence', text: 'Confirmed source', duration: 5, background: '#20342d', kind: 'title', layout: 'center' }] };
  writeFileSync(executable, `const fs=require('node:fs'); const args=process.argv.slice(2); if(args[args.indexOf('--sandbox')+1]!=='read-only'||args[args.indexOf('--disable')+1]!=='shell_tool'||!args.includes('--ignore-user-config'))process.exit(61); const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8')); const result=schema.required.includes('body')?${JSON.stringify(blog)}:${JSON.stringify(video)}; fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result)); fs.writeFileSync(${JSON.stringify(capture)},fs.readFileSync(0,'utf8'));`);
  const body = { agent: 'codex', message: 'Requested bounded task', ...(jobType === 'blog' ? { jobType: 'blog', blog: { evidence: 'Fixture' } } : { episode: { title: 'Fixture' } }) };
  const result = await runAgent(body, { harnessRoot: f.root, jobRoot: join(f.root, 'jobs'), availabilityImpl: () => ({ codex: { available: true } }), executeImpl: async (_file, args, options) => {
    const child = spawnSync(process.execPath, [executable, ...args], { cwd: options.cwd, input: options.input, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    return { stdout: child.stdout };
  } });
  if (jobType === 'blog') assert.deepEqual(result, blog);
  else {
    assert.equal(result.message, video.message);
    assert.deepEqual(result.scenes.map(scene => Object.fromEntries(Object.keys(video.scenes[0]).map(key => [key, scene[key]]))), video.scenes);
  }
  const prompt = readFileSync(capture, 'utf8');
  assert.ok(prompt.includes(contract));
  assert.equal(prompt.includes('DO_NOT_INJECT_DIRECTOR'), false);
  assert.equal(prompt.includes('DO_NOT_INJECT_ORCHESTRATOR'), false);
});

for (const row of [{ name: 'missing', context: {} }, { name: 'array', context: { blog: [] } }]) test(`regression: malformed ${row.name} blog context rejects without executor effects or leaked job directories`, async t => {
  const f = fixture(t);
  const jobs = join(f.root, 'invalid-blog-jobs');
  let effects = 0;
  await assert.rejects(runAgent({ agent: 'jeopi', jobType: 'blog', message: 'Reject invalid context', ...row.context }, {
    harnessRoot: f.root,
    jobRoot: jobs,
    availabilityImpl: () => ({ jeopi: { available: true } }),
    executeImpl: async () => { effects += 1; throw Error('Invalid context reached executor'); },
  }), error => error.status === 400 && /blog context/i.test(error.message));
  assert.equal(effects, 0);
  assert.deepEqual(existsSync(jobs) ? readdirSync(jobs) : [], [], 'Rejected requests must not leave UUID workspaces behind');
});

function refreshBundle(f) {
  const manifest = join(f.selected, 'bundle.json');
  const bundle = JSON.parse(readFileSync(manifest));
  for (const file of bundle.files) {
    const bytes = readFileSync(join(f.selected, file.path));
    file.bytes = bytes.length;
    file.sha256 = hash(bytes);
  }
  writeFileSync(manifest, JSON.stringify(bundle));
  writeFileSync(join(f.root, 'harness/manifest.json'), JSON.stringify({ ...f.pointer, bundleSha256: hash(readFileSync(manifest)) }));
}

for (const kind of ['pointer', 'metadata', 'file']) test(`regression: central verification accepts the exact ${kind} byte boundary and rejects one extra byte before execution`, async t => {
  const f = fixture(t);
  const maximum = kind === 'pointer' ? MAX_HARNESS_MANIFEST_BYTES : kind === 'metadata' ? MAX_HARNESS_BUNDLE_BYTES : MAX_HARNESS_FILE_BYTES;
  const target = kind === 'pointer' ? join(f.root, 'harness/manifest.json') : join(f.selected, kind === 'metadata' ? 'bundle.json' : HARNESS_FILES[0]);
  if (kind === 'file') {
    writeFileSync(target, Buffer.alloc(maximum, 97));
    refreshBundle(f);
  } else {
    const bytes = readFileSync(target);
    writeFileSync(target, Buffer.concat([bytes, Buffer.alloc(maximum - bytes.length, 32)]));
    if (kind === 'metadata') writeFileSync(join(f.root, 'harness/manifest.json'), JSON.stringify({ ...f.pointer, bundleSha256: hash(readFileSync(target)) }));
  }
  assert.equal(loadBridgeRuntimeContract({ root: f.root }).text, contract);
  const descriptor = openSync(target, 'r+');
  try { ftruncateSync(descriptor, maximum + 1); } finally { closeSync(descriptor); }
  assert.throws(() => verifyCurrent(f.root), { code: 'HARNESS_INPUT_TOO_LARGE' });
  let effects = 0;
  await assert.rejects(runAgent({ agent: 'jeopi', message: 'No oversized authority', episode: {} }, { harnessRoot: f.root, jobRoot: join(f.root, 'jobs'), executeImpl: async () => { effects += 1; } }), { code: 'HARNESS_CONTEXT_TOO_LARGE' });
  assert.equal(effects, 0);
  assert.equal(existsSync(join(f.root, 'jobs')), false);
});

test('regression: checksum-valid individual files cannot exceed the aggregate immutable input budget', t => {
  const f = fixture(t);
  for (const file of HARNESS_FILES.filter(file => file !== 'docs/harness.md').slice(0, 4)) writeFileSync(join(f.selected, file), Buffer.alloc(MAX_HARNESS_FILE_BYTES, 97));
  refreshBundle(f);
  assert.throws(() => verifyCurrent(f.root), { code: 'HARNESS_INPUT_TOO_LARGE' });
  assert.throws(() => loadBridgeRuntimeContract({ root: f.root }), { code: 'HARNESS_CONTEXT_TOO_LARGE' });
});

test('regression: verified snapshots retain exact hashed bytes despite disk, metadata and caller Buffer mutations', t => {
  const f = fixture(t);
  const verified = verifyCurrent(f.root);
  const original = Buffer.from(f.document);
  const returned = readVerifiedHarnessFile(verified, 'docs/harness.md');
  assert.deepEqual(returned, original);
  returned.fill(0);
  writeFileSync(join(f.selected, 'docs/harness.md'), 'Changed after verification');
  verified.bundle.files.find(file => file.path === 'docs/harness.md').sha256 = hash('Changed after verification');
  assert.deepEqual(readVerifiedHarnessFile(verified, 'docs/harness.md'), original, 'Only the original verified snapshot authorizes file content');
  assert.throws(() => readVerifiedHarnessFile({ ...verified }, 'docs/harness.md'), /verified harness snapshot/);
  assert.throws(() => readVerifiedHarnessFile(verified, '../../outside'), /verified harness snapshot/);
  assert.throws(() => verifyCurrent(f.root), /checksum mismatch/);
});

for (const extra of ['unexpected.txt', 'docs/unexpected.txt', 'unexpected-directory']) test(`regression: unexpected immutable tree entry ${extra} fails before executor effects`, async t => {
  const f = fixture(t);
  if (extra === 'unexpected-directory') mkdirSync(join(f.selected, extra));
  else writeFileSync(join(f.selected, extra), 'Not authorized by bundle inventory');
  assert.throws(() => verifyBundle(f.selected, '1.0.0'), /Unexpected files/);
  let effects = 0;
  await assert.rejects(runAgent({ agent: 'jeopi', message: 'No tree escape', episode: {} }, { harnessRoot: f.root, executeImpl: async () => { effects += 1; } }), { code: 'HARNESS_CONTEXT_UNAVAILABLE' });
  assert.equal(effects, 0);
});

test('regression: historical immutable bundles still verify without pretending to supply a newer runtime contract', t => {
  const old = fileURLToPath(new URL('../harness/versions/1.0.0/', import.meta.url));
  const verification = verifyBundle(old, '1.0.0');
  const original = readFileSync(join(old, 'docs/harness.md'));
  assert.deepEqual(readVerifiedHarnessFile(verification, 'docs/harness.md'), original);
  assert.equal(verification.sha256, hash(readFileSync(join(old, 'bundle.json'))));
  const f = fixture(t);
  rmSync(f.selected, { recursive: true });
  cpSync(old, f.selected, { recursive: true });
  writeFileSync(join(f.root, 'harness/manifest.json'), JSON.stringify({ ...f.pointer, bundleSha256: verification.sha256 }));
  assert.equal(verifyCurrent(f.root).pointer.currentVersion, '1.0.0');
  assert.throws(() => loadBridgeRuntimeContract({ root: f.root }), { code: 'BRIDGE_CONTRACT_MISSING' });
});

for (const scenario of ['growing-file', 'growing-pointer', 'pointer-reselection', 'post-verification-mutation']) test(`regression: ${scenario} cannot substitute unverified execution authority`, t => {
  const f = fixture(t);
  const pointer = join(f.root, 'harness/manifest.json');
  const document = join(f.selected, 'docs/harness.md');
  const runner = join(f.root, 'snapshot-race.mjs');
  const bridge = new URL('../scripts/agent-bridge.mjs', import.meta.url).href;
  const response = { title: 'Snapshot evidence', body: 'Only verified source.', sourceEvidence: [{ url: 'https://example.invalid/source', title: 'Fixture' }] };
  writeFileSync(runner, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const pointer=${JSON.stringify(pointer)}, document=${JSON.stringify(document)}, scenario=${JSON.stringify(scenario)};
const open=fs.openSync, read=fs.readSync, close=fs.closeSync;
const descriptors=new Map(); let pointerReads=0, injected=false;
fs.openSync=function(file,...args) {
  const name=resolve(String(file));
  if(name===resolve(pointer)) {
    pointerReads+=1;
    if(scenario==='pointer-reselection' && pointerReads===2) { fs.appendFileSync(pointer,' '); injected=true; }
  }
  const fd=open.call(this,file,...args); descriptors.set(fd,name); return fd;
};
fs.readSync=function(fd,...args) {
  const target=scenario==='growing-pointer'?pointer:document;
  if(!injected && scenario.startsWith('growing-') && descriptors.get(fd)===resolve(target)) {
    fs.appendFileSync(target,'GROWTH_AFTER_STAT'); injected=true;
  }
  return read.call(this,fd,...args);
};
fs.closeSync=function(fd,...args) {
  const name=descriptors.get(fd); descriptors.delete(fd);
  const result=close.call(this,fd,...args);
  if(!injected && scenario==='post-verification-mutation' && name===resolve(pointer) && pointerReads===2) {
    fs.writeFileSync(document, '## Bridge Runtime Contract\\nUNVERIFIED_REPLACEMENT'); injected=true;
  }
  return result;
};
syncBuiltinESMExports();
const {runAgent}=await import(${JSON.stringify(bridge)});
let effects=0, prompt=null, result=null, error=null;
try { result=await runAgent({agent:'jeopi',jobType:'blog',message:'Keep snapshot authority',blog:{evidence:'Fixture only'}}, {
  harnessRoot:${JSON.stringify(f.root)},jobRoot:${JSON.stringify(join(f.root, 'race-jobs'))},availabilityImpl:()=>({jeopi:{available:true}}),
  executeImpl:async(_file,args)=>{effects+=1;prompt=args.at(-1);return {stdout:${JSON.stringify(JSON.stringify(response))}};}
}); } catch(cause) {error={code:cause.code,statusCode:cause.statusCode,message:cause.message};}
process.stdout.write(JSON.stringify({injected,effects,prompt,result,error}));
`);
  const child = spawnSync(process.execPath, [runner], { cwd: f.root, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const observed = JSON.parse(child.stdout);
  assert.equal(observed.injected, true, 'The race must occur at the intended live filesystem boundary');
  if (scenario === 'post-verification-mutation') {
    assert.deepEqual(observed.result, response);
    assert.equal(observed.error, null);
    assert.equal(observed.effects, 1);
    assert.ok(observed.prompt.includes(contract));
    assert.equal(observed.prompt.includes('UNVERIFIED_REPLACEMENT'), false);
    assert.equal(readFileSync(document, 'utf8'), '## Bridge Runtime Contract\nUNVERIFIED_REPLACEMENT');
  } else {
    assert.equal(observed.error.code, 'HARNESS_CONTEXT_UNAVAILABLE');
    assert.equal(observed.error.statusCode, 503);
    assert.equal(observed.effects, 0);
    assert.equal(existsSync(join(f.root, 'race-jobs')), false);
  }
});

test('regression: promotion rejects a linked editable source ancestor instead of importing external instructions', t => {
  const f = fixture(t);
  const outside = join(f.root, 'external-documents');
  renameSync(join(f.root, 'docs'), outside);
  symlinkSync(outside, join(f.root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  const originalPointer = readFileSync(join(f.root, 'harness/manifest.json'));
  assert.throws(() => changeHarness(f.root, 'promote', '1.1.0'), /symbolic links/);
  assert.deepEqual(readFileSync(join(f.root, 'harness/manifest.json')), originalPointer, 'Rejected source selection must not change current authority');
  assert.equal(verifyCurrent(f.root).pointer.currentVersion, '1.0.0');
});
