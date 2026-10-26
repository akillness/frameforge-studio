import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inspectKnowledge, searchKnowledge, renderKnowledgeIndex } from '../server/project-knowledge.mjs';
import { HARNESS_FILES, changeHarness } from '../scripts/version-harness.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const cli = fileURLToPath(new URL('../scripts/knowledge.mjs', import.meta.url));
const limits = { maxFiles: 32, maxFileBytes: 65536, maxCorpusBytes: 262144, maxResults: 10, maxCharacters: 16000, maxExcerptCharacters: 1200, maxQueryCharacters: 256 };
function page(title, body, type = 'Source', status = '') { return `---\ntype: ${type}\ntitle: ${title}\ndescription: Reviewed fixture evidence.\ntimestamp: 2026-10-26T00:00:00Z\n${status ? `status: ${status}\n` : ''}---\n\n# ${title}\n${body}\n`; }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'frameforge-project-knowledge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of HARNESS_FILES) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), `Fixture ${path}\n`); }
  changeHarness(root, 'promote', '1.0.0');
  const sourcePath = 'llm-wiki/wiki/sources/product.md';
  const reportPath = 'llm-wiki/wiki/reports/old-readiness.md';
  const source = page('Reviewed product', 'Copperfin production requires exact owner approval.');
  const report = page('Old readiness', 'Copperfin production historical claim: harness 0.1.0 is current and all providers are ready. Blocked, dropped and fixture-only results are not real execution.', 'Report');
  const policy = { schema: 'frameforge-knowledge-policy/v1', indexPath: 'llm-wiki/index.md', limits: { ...limits }, entries: [] };
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const add = (path, title, text, type = 'Source') => {
    put(path, text);
    const entry = { path, title, type, classification: type === 'Report' ? 'historical' : 'authored-reference', sha256: hash(text), provenance: { kind: type === 'Report' ? 'historical-report' : 'authored-source', evidence: [path] } };
    policy.entries.push(entry);
    return entry;
  };
  add(sourcePath, 'Reviewed product', source);
  add(reportPath, 'Old readiness', report, 'Report');
  const savePolicy = () => put('harness/knowledge-policy.json', `${JSON.stringify(policy, null, 2)}\n`);
  savePolicy();
  const bookkeeping = '# Historical navigation bookkeeping\nPreserve this original introduction verbatim.\n';
  put('llm-wiki/index.md', bookkeeping);
  put('llm-wiki/log.md', 'Immutable historical log fixture\n');
  put('llm-wiki/raw/manifest.json', '{"captures":[{"sha256":"retained-not-rewritten"}]}\n');
  put('llm-wiki/raw/capture.txt', 'Copperfin RAW_SECRET_NEVER_SEARCH');
  const refreshIndex = () => { const rendered = renderKnowledgeIndex({ root }); assert.equal(rendered.ok, true, JSON.stringify(rendered.errors)); put(rendered.path, rendered.content); return rendered; };
  refreshIndex();
  return { root, policy, sourcePath, reportPath, source, report, put, add, savePolicy, refreshIndex, bookkeeping };
}
function errors(result) { return result.errors.map(error => error.code); }
function command(root, ...args) { return spawnSync(process.execPath, [cli, ...args, '--root', root], { cwd: root, encoding: 'utf8', timeout: 15000 }); }

test('search returns reviewed exact source slices and hashes while historical prose cannot select the current harness', t => {
  const f = fixture(t);
  const result = searchKnowledge({ root: f.root, query: 'Copperfin production', limit: 5, maxCharacters: 8000 });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.results.map(entry => entry.path), [f.reportPath, f.sourcePath]);
  for (const item of result.results) {
    const text = item.path === f.sourcePath ? f.source : f.report;
    assert.equal(item.sha256, hash(text));
    assert.equal(item.excerpt.text, text.slice(item.excerpt.startCharacter, item.excerpt.endCharacter));
    assert.equal(item.excerpt.startLine, text.slice(0, item.excerpt.startCharacter).split('\n').length);
    assert.equal(item.excerpt.endLine, text.slice(0, item.excerpt.endCharacter).split('\n').length);
    assert.deepEqual(item.provenance.evidence, [item.path]);
    assert.equal(item.excerpt.semantics, 'excerpt-not-authority');
  }
  assert.equal(result.results.find(item => item.path === f.reportPath).classification, 'historical');
  assert.equal(result.currentHarness.version, '1.0.0');
  assert.equal(result.currentHarness.readiness, 'not-established');
  assert.equal(result.results.some(item => item.excerpt.text.includes('RAW_SECRET_NEVER_SEARCH')), false);
});

test('edited source is unsearchable until a reviewed hash update and canonical index round trip', t => {
  const f = fixture(t);
  const rawManifest = readFileSync(join(f.root, 'llm-wiki/raw/manifest.json'));
  const rawCapture = readFileSync(join(f.root, 'llm-wiki/raw/capture.txt'));
  const log = readFileSync(join(f.root, 'llm-wiki/log.md'));
  const changed = page('Reviewed product', 'Silverfin revised product requires separate exact publication consent.');
  f.put(f.sourcePath, changed);
  const rejected = searchKnowledge({ root: f.root, query: 'Silverfin', limit: 5, maxCharacters: 8000 });
  assert.equal(rejected.ok, false);
  assert.ok(errors(rejected).includes('source-hash-mismatch'));
  assert.deepEqual(rejected.results, []);
  const beforeReview = command(f.root, 'index', '--write');
  assert.equal(beforeReview.status, 1, beforeReview.stderr);
  f.policy.entries.find(entry => entry.path === f.sourcePath).sha256 = hash(changed);
  f.savePolicy();
  const index = command(f.root, 'index', '--write');
  assert.equal(index.status, 0, index.stderr + index.stdout);
  const checked = command(f.root, 'check');
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  const searched = command(f.root, 'search', 'Silverfin');
  assert.equal(searched.status, 0, searched.stderr + searched.stdout);
  const result = JSON.parse(searched.stdout);
  assert.deepEqual(result.results.map(entry => [entry.path, entry.sha256]), [[f.sourcePath, hash(changed)]]);
  assert.ok(result.results[0].excerpt.text.includes('separate exact publication consent'));
  assert.deepEqual(readFileSync(join(f.root, 'llm-wiki/raw/manifest.json')), rawManifest);
  assert.deepEqual(readFileSync(join(f.root, 'llm-wiki/raw/capture.txt')), rawCapture);
  assert.deepEqual(readFileSync(join(f.root, 'llm-wiki/log.md')), log);
});

for (const row of [
  { name: 'raw source', path: 'llm-wiki/raw/captured.md' },
  { name: 'automatic prompt stub', path: 'llm-wiki/wiki/sources/2026-10-26-123456-query.md' },
  { name: 'graph cache', path: 'llm-wiki/.graphify/cache/context.md' },
  { name: 'operational state', path: 'llm-wiki/.state/session.md' },
  { name: 'root traversal', path: '../outside.md' },
]) test(`explicit policy cannot admit ${row.name}`, t => {
  const f = fixture(t);
  f.policy.entries[0].path = row.path;
  f.savePolicy();
  const result = searchKnowledge({ root: f.root, query: 'Copperfin' });
  assert.equal(result.ok, false);
  assert.ok(errors(result).includes('unadmitted-path'));
  assert.equal(result.results?.length ?? 0, 0);
});

for (const status of ['submitted', 'draft', 'pending-synthesis', 'unreviewed']) test(`${status} source remains rejected even with an exact policy hash`, t => {
  const f = fixture(t);
  const text = page('Reviewed product', 'Copperfin unapproved material', 'Source', status);
  f.put(f.sourcePath, text);
  f.policy.entries[0].sha256 = hash(text);
  f.savePolicy();
  const result = searchKnowledge({ root: f.root, query: 'Copperfin' });
  assert.equal(result.ok, false);
  assert.ok(errors(result).includes('unreviewed-source'));
  assert.deepEqual(result.results, []);
});

test('historical reports cannot be relabelled as current reference authority', t => {
  const f = fixture(t);
  f.policy.entries[1].classification = 'authored-reference';
  f.savePolicy();
  const result = inspectKnowledge({ root: f.root });
  assert.equal(result.ok, false);
  assert.ok(errors(result).includes('invalid-classification'));
});

test('symlinked source ancestors reject even an otherwise reviewed corpus', t => {
  const f = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'frameforge-knowledge-external-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'product.md'), f.source);
  rmSync(join(f.root, 'llm-wiki/wiki/sources'), { recursive: true });
  symlinkSync(outside, join(f.root, 'llm-wiki/wiki/sources'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = searchKnowledge({ root: f.root, query: 'Copperfin' });
  assert.equal(result.ok, false);
  assert.ok(errors(result).includes('symlink'));
});

for (const row of [
  { name: 'per-file byte cap', mutate: f => { f.policy.limits.maxFileBytes = Buffer.byteLength(f.source) - 1; }, code: 'file-too-large' },
  { name: 'total corpus byte cap', mutate: f => { f.policy.limits.maxCorpusBytes = Buffer.byteLength(f.source) + Buffer.byteLength(f.report) - 1; }, code: 'corpus-too-large' },
  { name: 'corpus file-count cap', mutate: f => { f.policy.limits.maxFiles = 1; }, code: 'corpus-too-large' },
  { name: 'attempted ceiling increase', mutate: f => { f.policy.limits.maxCorpusBytes = 262145; }, code: 'invalid-bound' },
]) test(`${row.name} fails closed rather than searching a truncated trusted corpus`, t => {
  const f = fixture(t);
  row.mutate(f); f.savePolicy();
  const result = searchKnowledge({ root: f.root, query: 'Copperfin' });
  assert.equal(result.ok, false);
  assert.ok(errors(result).includes(row.code));
  assert.equal(result.results?.length ?? 0, 0);
});

test('bounded search response stays within its complete serialized envelope and exact excerpt offsets', t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i += 1) f.add(`llm-wiki/wiki/sources/extra-${i}.md`, `Reviewed extra ${i}`, page(`Reviewed extra ${i}`, `Copperfin ${'한😀 excerpt body '.repeat(130)}`));
  f.savePolicy(); f.refreshIndex();
  const result = searchKnowledge({ root: f.root, query: 'Copperfin', limit: 10, maxCharacters: 2048 });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.matchedEntries, 10);
  assert.equal(result.truncated, true);
  assert.ok(result.results.length > 0 && result.results.length < 10);
  assert.ok(JSON.stringify(result).length <= 2048);
  assert.equal(result.characters, JSON.stringify(result).length);
  for (const item of result.results) assert.equal(item.excerpt.text, readFileSync(join(f.root, item.path), 'utf8').slice(item.excerpt.startCharacter, item.excerpt.endCharacter));
});

for (const args of [{ query: '\nCopperfin' }, { query: 'x'.repeat(257) }, { query: 'Copperfin', limit: 11 }, { query: 'Copperfin', maxCharacters: 2047 }]) test('unsupported query or response bound is rejected rather than silently coerced', t => {
  const f = fixture(t);
  const result = searchKnowledge({ root: f.root, ...args });
  assert.equal(result.ok, false);
  assert.ok(errors(result).some(code => ['invalid-query', 'invalid-search-bound'].includes(code)));
});

test('canonical navigation repair is deterministic and preserves surrounding historical bookkeeping', t => {
  const f = fixture(t);
  const indexPath = join(f.root, 'llm-wiki/index.md');
  const original = readFileSync(indexPath, 'utf8');
  const expected = f.refreshIndex();
  assert.equal(expected.content, original);
  writeFileSync(indexPath, original.replace(hash(f.source), '0'.repeat(64)) + '\n# Original appendix\nKeep this historical note.\n');
  const broken = inspectKnowledge({ root: f.root });
  assert.equal(broken.ok, false);
  assert.ok(errors(broken).includes('index-inconsistent'));
  const repaired = f.refreshIndex();
  assert.ok(repaired.content.startsWith(f.bookkeeping));
  assert.ok(repaired.content.endsWith('\n# Original appendix\nKeep this historical note.\n'));
  assert.equal(inspectKnowledge({ root: f.root }).ok, true);
  assert.equal(f.refreshIndex().content, repaired.content);
});

test('regression: index EOL conversion admits CRLF navigation without changing historical bytes or reviewed sources', t => {
  const f = fixture(t);
  const indexPath = join(f.root, 'llm-wiki/index.md');
  const appendix = '\r\n# Historical appendix — 보존\r\nKeep these exact historical bytes.\r\n';
  const converted = readFileSync(indexPath, 'utf8').replace(/\n/g, '\r\n') + appendix;
  writeFileSync(indexPath, converted);
  const preservedPaths = [f.sourcePath, f.reportPath, 'harness/knowledge-policy.json', 'llm-wiki/log.md', 'llm-wiki/raw/manifest.json', 'llm-wiki/raw/capture.txt'];
  const before = preservedPaths.map(path => [path, readFileSync(join(f.root, path))]);
  const checked = inspectKnowledge({ root: f.root });
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  assert.equal(checked.index.status, 'passed');
  const searched = searchKnowledge({ root: f.root, query: 'Copperfin production', limit: 5, maxCharacters: 8000 });
  assert.equal(searched.ok, true, JSON.stringify(searched.errors));
  assert.deepEqual(searched.results.map(entry => [entry.path, entry.sha256]), [[f.reportPath, hash(f.report)], [f.sourcePath, hash(f.source)]]);
  for (const item of searched.results) {
    const text = item.path === f.sourcePath ? f.source : f.report;
    assert.equal(item.excerpt.text, text.slice(item.excerpt.startCharacter, item.excerpt.endCharacter));
  }
  const rendered = renderKnowledgeIndex({ root: f.root });
  assert.equal(rendered.ok, true, JSON.stringify(rendered.errors));
  assert.equal(rendered.content, converted, 'Fresh CRLF navigation must render without rewriting historical bytes or line endings');
  assert.deepEqual(readFileSync(indexPath), Buffer.from(converted));
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(join(f.root, path)), bytes, path);
});

for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) test(`regression: index EOL repair preserves ${name} navigation and historical bytes deterministically`, t => {
  const f = fixture(t);
  const indexPath = join(f.root, 'llm-wiki/index.md');
  const canonical = readFileSync(indexPath, 'utf8').replace(/\n/g, eol);
  const appendix = `${eol}# Original appendix — 보존${eol}Keep this historical note.\r\nMixed historical line endings stay untouched.\n`;
  const expected = Buffer.from(canonical + appendix);
  writeFileSync(indexPath, canonical.replace(hash(f.source), '0'.repeat(64)) + appendix);
  const preservedPaths = [f.sourcePath, f.reportPath, 'harness/knowledge-policy.json', 'llm-wiki/log.md', 'llm-wiki/raw/manifest.json', 'llm-wiki/raw/capture.txt'];
  const before = preservedPaths.map(path => [path, readFileSync(join(f.root, path))]);
  const broken = inspectKnowledge({ root: f.root });
  assert.equal(broken.ok, false);
  assert.ok(errors(broken).includes('index-inconsistent'));
  const repaired = command(f.root, 'index', '--write');
  assert.equal(repaired.status, 0, repaired.stderr + repaired.stdout);
  assert.deepEqual(readFileSync(indexPath), expected, 'Repair must replace only stale managed content and retain the existing navigation EOL');
  const checked = inspectKnowledge({ root: f.root });
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
  assert.equal(checked.index.status, 'passed');
  const repeated = command(f.root, 'index', '--write');
  assert.equal(repeated.status, 0, repeated.stderr + repeated.stdout);
  assert.deepEqual(readFileSync(indexPath), expected, 'Repeated canonical repair must be byte-for-byte deterministic');
  for (const [path, bytes] of before) assert.deepEqual(readFileSync(join(f.root, path)), bytes, path);
});

for (const [name, reviewedEol, changedEol] of [['LF-to-CRLF', '\n', '\r\n'], ['CRLF-to-LF', '\r\n', '\n']]) test(`regression: index EOL tolerance cannot admit an unreviewed ${name} authored source change`, t => {
  const f = fixture(t);
  const reviewedSource = f.source.replace(/\n/g, reviewedEol);
  f.put(f.sourcePath, reviewedSource);
  f.policy.entries.find(entry => entry.path === f.sourcePath).sha256 = hash(reviewedSource);
  f.savePolicy();
  f.refreshIndex();
  const admitted = searchKnowledge({ root: f.root, query: 'Copperfin production', limit: 5, maxCharacters: 8000 });
  assert.equal(admitted.ok, true, JSON.stringify(admitted.errors));
  assert.equal(admitted.results.find(entry => entry.path === f.sourcePath).sha256, hash(reviewedSource));
  const indexPath = join(f.root, 'llm-wiki/index.md');
  const policyPath = join(f.root, 'harness/knowledge-policy.json');
  const originalIndex = readFileSync(indexPath);
  const originalPolicy = readFileSync(policyPath);
  const changed = f.source.replace(/\n/g, changedEol);
  f.put(f.sourcePath, changed);
  const checked = inspectKnowledge({ root: f.root });
  assert.equal(checked.ok, false);
  assert.ok(errors(checked).includes('source-hash-mismatch'));
  const searched = searchKnowledge({ root: f.root, query: 'Copperfin production', limit: 5, maxCharacters: 8000 });
  assert.equal(searched.ok, false);
  assert.ok(errors(searched).includes('source-hash-mismatch'));
  assert.deepEqual(searched.results, [], 'Even unchanged report matches must not escape a corpus with an unreviewed source SHA');
  const repair = command(f.root, 'index', '--write');
  assert.equal(repair.status, 1, repair.stderr + repair.stdout);
  assert.ok(errors(JSON.parse(repair.stdout)).includes('source-hash-mismatch'));
  assert.deepEqual(readFileSync(indexPath), originalIndex);
  assert.deepEqual(readFileSync(policyPath), originalPolicy, 'Repair must never repin reviewed source hashes');
  assert.deepEqual(readFileSync(join(f.root, f.sourcePath)), Buffer.from(changed), 'Rejected authored source bytes must not be normalized');
});

test('malformed index markers and unadmitted wiki navigation fail instead of blessing a broken index', t => {
  const f = fixture(t);
  f.put('llm-wiki/index.md', '<!-- FRAMEFORGE-KNOWLEDGE:END -->\n<!-- FRAMEFORGE-KNOWLEDGE:START -->');
  assert.ok(errors(renderKnowledgeIndex({ root: f.root })).includes('invalid-index-markers'));
  f.put('llm-wiki/index.md', f.bookkeeping);
  const text = page('Reviewed product', 'Copperfin [[wiki/sources/not-reviewed]]');
  f.put(f.sourcePath, text); f.policy.entries[0].sha256 = hash(text); f.savePolicy();
  const result = renderKnowledgeIndex({ root: f.root });
  assert.equal(result.ok, false);
  assert.ok(errors(result).includes('unadmitted-wiki-link'));
});

for (const scenario of ['late-append', 'recreated-target', 'recreated-during-restore']) test(`regression: index write preserves historical bytes under ${scenario}`, t => {
  const f = fixture(t);
  const target = join(f.root, 'llm-wiki/index.md');
  const original = readFileSync(target, 'utf8');
  const appendix = '\n# Concurrent historical appendix\nNever erase these late bytes.\n';
  const recreated = '# Concurrently recreated index\nPreserve independently authored bytes.\n';
  const hook = join(f.root, 'filesystem-race.mjs');
  const receipt = join(f.root, 'race-receipt.json');
  writeFileSync(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const target = ${JSON.stringify(target)}, receipt = ${JSON.stringify(receipt)}, scenario = ${JSON.stringify(scenario)};
const rename = fs.renameSync, link = fs.linkSync;
let injected = false, restoreInjected = false;
const same = value => resolve(String(value)) === resolve(target);
const record = () => fs.writeFileSync(receipt, JSON.stringify({injected,restoreInjected}));
fs.renameSync = function(from,to,...args) {
  if (!injected && ((scenario !== 'recreated-target' && same(from)) || same(to))) {
    injected = true;
    if (scenario === 'recreated-target') fs.writeFileSync(target, ${JSON.stringify(recreated)});
    else fs.appendFileSync(target, ${JSON.stringify(appendix)});
    record();
  }
  return rename.call(this,from,to,...args);
};
fs.linkSync = function(from,to,...args) {
  if (same(to) && scenario === 'recreated-target' && !injected) {
    injected = true; fs.writeFileSync(target, ${JSON.stringify(recreated)}); record();
  }
  if (same(to) && scenario === 'recreated-during-restore' && /original\\.md$/.test(String(from)) && !restoreInjected) {
    restoreInjected = true; fs.writeFileSync(target, ${JSON.stringify(recreated)}); record();
  }
  return link.call(this,from,to,...args);
};
syncBuiltinESMExports();
`);
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, cli, 'index', '--write', '--root', f.root], { cwd: f.root, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.stderr, '', 'The CLI must execute rather than fail to load the filesystem injector');
  assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).injected, true, 'The real CLI must reach the injected filesystem boundary');
  const result = JSON.parse(child.stdout);
  assert.equal(child.status, 1, `Conflicts must be blocked, not reported as successful replacement: ${child.stdout}`);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'index-write-conflict');
  const savedOriginal = join(f.root, result.preservation.snapshotPath);
  assert.equal(readFileSync(savedOriginal, 'utf8'), original + (scenario === 'recreated-target' ? '' : appendix), 'Retain the actual moved original, including changes after the final render');
  assert.equal(readFileSync(target, 'utf8'), scenario === 'late-append' ? original + appendix : recreated, 'Restoration and publication must never overwrite a concurrently recreated target');
  assert.equal(result.preservation.restoredOriginal, scenario === 'late-append');
  if (scenario === 'recreated-during-restore') assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).restoreInjected, true);
});
