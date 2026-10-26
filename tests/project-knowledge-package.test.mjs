import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectKnowledge, packageKnowledge, renderKnowledgeIndex, searchKnowledge } from '../server/project-knowledge.mjs';
import { HARNESS_FILES, changeHarness } from '../scripts/version-harness.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const policyPath = 'harness/knowledge-policy.json';
const indexPath = 'llm-wiki/index.md';
const proofPath = '.frameforge/knowledge-package.json';
const limits = { maxFiles: 32, maxFileBytes: 65536, maxCorpusBytes: 262144, maxResults: 10, maxCharacters: 16000, maxExcerptCharacters: 1200, maxQueryCharacters: 256 };
const sentinels = ['RAW_CAPTURE_SECRET', 'PRIVATE_RECEIPT_SECRET', 'PRIVATE_LINK_SECRET', 'AUTOMATIC_QUERY_SECRET', 'PRIVATE_HISTORY_SECRET', 'GRAPH_CACHE_SECRET', 'OPS_STATE_SECRET', 'SOURCE_INDEX_BOOKKEEPING_SECRET', 'UNADMITTED_AUTHORED_SECRET'];

function page(title, body, type = 'Source', status = '') {
  return `---\ntype: ${type}\ntitle: ${title}\ndescription: Reviewed packaging fixture.\ntimestamp: 2026-10-26T00:00:00Z\n${status ? `status: ${status}\n` : ''}---\n\n# ${title}\n${body}\n`;
}

function files(root, prefix = '') {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(join(root, entry.name), path) : [path];
  }).sort();
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'frameforge-knowledge-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  const output = join(directory, 'packaged');
  mkdirSync(root);
  const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  for (const path of HARNESS_FILES) put(path, `Fixture ${path}\n`);
  changeHarness(root, 'promote', '1.0.0');
  put('llm-wiki/raw/source.md', 'RAW_CAPTURE_SECRET\n');
  put('artifacts/review.json', '{"private":"PRIVATE_RECEIPT_SECRET"}\n');
  put('docs/dependency.md', 'PRIVATE_LINK_SECRET\n');
  put('llm-wiki/wiki/queries/query.md', 'AUTOMATIC_QUERY_SECRET\n');
  put('llm-wiki/wiki/sources/2026-10-26-123456-query.md', 'AUTOMATIC_QUERY_SECRET\n');
  put('llm-wiki/log.md', 'PRIVATE_HISTORY_SECRET\n');
  put('llm-wiki/.graphify/cache/context.md', 'GRAPH_CACHE_SECRET\n');
  put('.state/session.md', 'OPS_STATE_SECRET\n');
  put('llm-wiki/wiki/sources/not-admitted.md', page('Not admitted', 'UNADMITTED_AUTHORED_SECRET'));
  const policy = { schema: 'frameforge-knowledge-policy/v1', indexPath, limits: { ...limits }, entries: [] };
  const bodies = new Map();
  for (let index = 0; index < 10; index += 1) {
    const type = index === 9 ? 'Report' : 'Source';
    const path = `llm-wiki/wiki/${type === 'Report' ? 'reports' : 'sources'}/reviewed-${index}.md`;
    const title = `Reviewed ${index}`;
    const body = page(title, `Copperfin reviewed body ${index}: owner approval remains required.\n[Real dependency](../../../docs/dependency.md#details)\n[[wiki/sources/reviewed-0|Reviewed source]]`, type);
    put(path, body);
    bodies.set(path, body);
    policy.entries.push({ path, title, type, classification: type === 'Report' ? 'historical' : 'authored-reference', sha256: hash(body), provenance: { kind: type === 'Report' ? 'historical-report' : 'authored-source', evidence: ['llm-wiki/raw/source.md', 'artifacts/review.json'] } });
  }
  const savePolicy = () => put(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  savePolicy();
  put(indexPath, '# SOURCE_INDEX_BOOKKEEPING_SECRET\n');
  const rendered = renderKnowledgeIndex({ root, mode: 'source' });
  assert.equal(rendered.ok, true, JSON.stringify(rendered.errors));
  put(indexPath, rendered.content);
  assert.equal(inspectKnowledge({ root, mode: 'source' }).ok, true);
  return { directory, root, output, put, policy, bodies, savePolicy };
}

function packaged(f) {
  const result = packageKnowledge({ root: f.root, output: f.output });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  // The image copies the unchanged selected harness separately from the knowledge artifact.
  for (const path of ['harness/manifest.json', 'harness/versions']) cpSync(join(f.root, path), join(f.output, path), { recursive: true });
  return result;
}

function assertBlocked(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (code) assert.ok(result.errors.some(error => error.code === code), JSON.stringify(result.errors));
  if (result.results) assert.deepEqual(result.results, []);
}

for (const [name, dependency] of [['provenance', 'llm-wiki/raw/source.md'], ['local Markdown link', 'docs/dependency.md']]) test(`source mode and packaging reject missing ${name} before emitting any artifact`, t => {
  const f = fixture(t);
  rmSync(join(f.root, dependency));
  assertBlocked(inspectKnowledge({ root: f.root, mode: 'source' }), 'missing-path');
  assertBlocked(searchKnowledge({ root: f.root, mode: 'source', query: 'Copperfin' }), 'missing-path');
  assertBlocked(packageKnowledge({ root: f.root, output: f.output }), 'missing-path');
  assert.deepEqual(files(f.output), []);
});

for (const row of [
  { name: 'unreviewed body edit', code: 'source-hash-mismatch', mutate: f => f.put(f.policy.entries[0].path, `${f.bodies.get(f.policy.entries[0].path)}Unreviewed edit.\n`) },
  { name: 'reviewed hash with draft status', code: 'unreviewed-source', mutate: f => { const entry = f.policy.entries[0]; const body = page(entry.title, 'Copperfin draft body', entry.type, 'draft'); f.put(entry.path, body); entry.sha256 = hash(body); } },
  { name: 'reviewed hash with invalid authored metadata', code: 'invalid-frontmatter', mutate: f => { const entry = f.policy.entries[0]; const body = page('Wrong title', 'Copperfin wrong title'); f.put(entry.path, body); entry.sha256 = hash(body); } },
  { name: 'per-file byte overflow', code: 'file-too-large', mutate: f => { f.policy.limits.maxFileBytes = Buffer.byteLength(f.bodies.get(f.policy.entries[0].path)) - 1; } },
  { name: 'corpus byte overflow', code: 'corpus-too-large', mutate: f => { f.policy.limits.maxCorpusBytes = [...f.bodies.values()].reduce((sum, body) => sum + Buffer.byteLength(body), 0) - 1; } },
  { name: 'entry-count overflow', code: 'corpus-too-large', mutate: f => { f.policy.limits.maxFiles = 9; } },
]) test(`packaging rejects ${row.name} instead of blessing or truncating the reviewed corpus`, t => {
  const f = fixture(t);
  row.mutate(f);
  f.savePolicy();
  assertBlocked(packageKnowledge({ root: f.root, output: f.output }), row.code);
  assert.deepEqual(files(f.output), []);
});

test('packaging emits all ten exact reviewed bodies and no private, automatic, raw, receipt or bookkeeping bodies', t => {
  const f = fixture(t);
  const sourceIndex = readFileSync(join(f.root, indexPath));
  const originalFiles = files(f.root);
  const originalBytes = new Map(originalFiles.map(path => [path, readFileSync(join(f.root, path))]));
  const result = packageKnowledge({ root: f.root, output: f.output });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(files(f.output), [...f.bodies.keys(), policyPath, indexPath, proofPath].sort());
  for (const [path, body] of f.bodies) assert.deepEqual(readFileSync(join(f.output, path)), Buffer.from(body));
  assert.deepEqual(readFileSync(join(f.output, policyPath)), readFileSync(join(f.root, policyPath)));
  for (const path of files(f.output)) {
    const content = readFileSync(join(f.output, path), 'utf8');
    for (const sentinel of sentinels) assert.equal(content.includes(sentinel), false, `${path} leaked ${sentinel}`);
  }
  assert.deepEqual(files(f.root), originalFiles);
  for (const [path, bytes] of originalBytes) assert.deepEqual(readFileSync(join(f.root, path)), bytes, `Packaging rewrote ${path}`);
  assert.deepEqual(readFileSync(join(f.root, indexPath)), sourceIndex);
});

test('packaging refuses an occupied destination without overwriting existing user files', t => {
  const f = fixture(t);
  mkdirSync(f.output);
  const owned = Buffer.from('Existing user artifact, not a packaging scratch directory.\n');
  writeFileSync(join(f.output, 'owned.txt'), owned);
  assertBlocked(packageKnowledge({ root: f.root, output: f.output }));
  assert.deepEqual(files(f.output), ['owned.txt']);
  assert.deepEqual(readFileSync(join(f.output, 'owned.txt')), owned);
});
for (const row of [
  { name: 'traversing evidence path', mutate: f => { f.policy.entries[0].provenance.evidence = ['../outside.md']; } },
  { name: 'absolute evidence path', mutate: f => { f.policy.entries[0].provenance.evidence = [join(f.directory, 'outside.md')]; } },
  { name: 'traversing admitted path', mutate: f => { f.policy.entries[0].path = 'llm-wiki/wiki/sources/../../raw/source.md'; } },
  { name: 'encoded local link escape', mutate: f => { const entry = f.policy.entries[0]; const body = page(entry.title, 'Copperfin [escape](%2e%2e/%2e%2e/%2e%2e/%2e%2e/outside.md)'); f.put(entry.path, body); entry.sha256 = hash(body); } },
]) test(`packaging rejects ${row.name} even when the outside target physically exists`, t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'outside.md'), 'Outside root is not project evidence.\n');
  row.mutate(f);
  f.savePolicy();
  assertBlocked(packageKnowledge({ root: f.root, output: f.output }));
  assert.deepEqual(files(f.output), []);
});

for (const path of ['llm-wiki/raw', 'docs', 'llm-wiki/wiki/sources']) test(`packaging rejects symlinked ${path} rather than hashing or copying external bytes`, t => {
  const f = fixture(t);
  const external = join(f.directory, 'external');
  cpSync(join(f.root, path), external, { recursive: true });
  rmSync(join(f.root, path), { recursive: true });
  symlinkSync(external, join(f.root, path), process.platform === 'win32' ? 'junction' : 'dir');
  assertBlocked(packageKnowledge({ root: f.root, output: f.output }), 'symlink');
  assert.deepEqual(files(f.output), []);
});

test('packaging rejects source aliases and symlinked destination ancestors without writing through either', t => {
  const f = fixture(t);
  const alias = join(f.directory, 'source-alias');
  symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assertBlocked(packageKnowledge({ root: alias, output: f.output }));
  assert.deepEqual(files(f.output), []);
  const external = join(f.directory, 'external');
  const destinationAlias = join(f.directory, 'destination-alias');
  mkdirSync(external);
  symlinkSync(external, destinationAlias, process.platform === 'win32' ? 'junction' : 'dir');
  assertBlocked(packageKnowledge({ root: f.root, output: join(destinationAlias, 'packaged') }));
  assert.deepEqual(files(external), []);
});

test('packaging cannot write an artifact inside the source tree', t => {
  const f = fixture(t);
  const output = join(f.root, 'packaged');
  assertBlocked(packageKnowledge({ root: f.root, output }));
  assert.deepEqual(files(output), []);
});

function editProof(f, mutate, { bind = false, referenceSet = false } = {}) {
  const path = join(f.output, proofPath);
  const proof = JSON.parse(readFileSync(path, 'utf8'));
  mutate(proof);
  if (referenceSet) proof.referencesSha256 = hash(JSON.stringify(proof.references));
  if (bind) {
    const { bindingSha256, ...envelope } = proof;
    proof.bindingSha256 = hash(JSON.stringify(envelope));
  }
  writeFileSync(path, `${JSON.stringify(proof, null, 2)}\n`);
}

function assertPackagedBlocked(f, code) {
  assertBlocked(inspectKnowledge({ root: f.output, mode: 'packaged' }), code);
  assertBlocked(searchKnowledge({ root: f.output, mode: 'packaged', query: 'Copperfin', limit: 10, maxCharacters: 16000 }), code);
  assertBlocked(renderKnowledgeIndex({ root: f.output, mode: 'packaged' }), code);
}

test('explicit packaged mode searches every reviewed body with absent references clearly identified as build-time-only verification', t => {
  const f = fixture(t);
  // Packaging generates canonical navigation from reviewed inputs, not stale source navigation.
  f.put(indexPath, '# SOURCE_INDEX_BOOKKEEPING_SECRET\nStale navigation, not an admission source.\n');
  packaged(f);
  const dependencies = ['artifacts/review.json', 'docs/dependency.md', 'llm-wiki/raw/source.md'];
  for (const path of dependencies) assert.equal(existsSync(join(f.output, path)), false);
  const status = inspectKnowledge({ root: f.output, mode: 'packaged' });
  assert.equal(status.ok, true, JSON.stringify(status.errors));
  assert.deepEqual(status.entries.map(entry => entry.path), [...f.bodies.keys()].sort());
  assert.equal(status.index.status, 'passed');
  assert.equal(status.currentHarness.readiness, 'not-established');
  assert.equal(status.referenceVerification.verification, 'strict-source-build');
  assert.equal(status.referenceVerification.runtimePresent, 0);
  assert.equal(status.referenceVerification.runtimeAbsent, dependencies.length);
  assert.deepEqual(status.referenceVerification.absentPaths, dependencies);
  assert.match(status.referenceVerification.runtimeBodies, /verified only at build time.*not available/su);
  assert.match(status.referenceVerification.trust, /Unsigned SHA-256 integrity binding, not independent attestation/u);
  const search = searchKnowledge({ root: f.output, mode: 'packaged', query: 'Copperfin', limit: 10, maxCharacters: 16000 });
  assert.equal(search.ok, true, JSON.stringify(search.errors));
  assert.equal(search.matchedEntries, 10);
  assert.equal(search.returnedResults, 10);
  assert.equal(search.truncated, false);
  assert.deepEqual(search.results.map(entry => entry.path).sort(), [...f.bodies.keys()].sort());
  for (const item of search.results) {
    const body = f.bodies.get(item.path);
    assert.equal(item.sha256, hash(body));
    assert.equal(item.excerpt.text, body.slice(item.excerpt.startCharacter, item.excerpt.endCharacter));
    assert.deepEqual(item.provenance.evidence, f.policy.entries.find(entry => entry.path === item.path).provenance.evidence);
  }
  assert.equal(search.results.find(item => item.type === 'Report').classification, 'historical');
  assert.equal(search.referenceVerification.runtimeAbsent, dependencies.length);
  assert.match(search.referenceVerification.runtimeBodies, /Missing reference bodies.*verified only at build time.*not current readiness evidence/su);
  const index = renderKnowledgeIndex({ root: f.output, mode: 'packaged' });
  assert.equal(index.ok, true, JSON.stringify(index.errors));
  assert.equal(index.content, readFileSync(join(f.output, indexPath), 'utf8'));
  assert.equal(index.content.includes('SOURCE_INDEX_BOOKKEEPING_SECRET'), false);
  assertBlocked(inspectKnowledge({ root: f.output, mode: 'source' }), 'missing-path');
  assertBlocked(searchKnowledge({ root: f.output, mode: 'source', query: 'Copperfin' }), 'missing-path');
  assertBlocked(packageKnowledge({ root: f.output, output: join(f.directory, 'repackaged') }), 'missing-path');
});

for (const row of [
  { name: 'missing proof', code: 'missing-path', mutate: f => rmSync(join(f.output, proofPath)) },
  { name: 'malformed proof', code: 'invalid-json', mutate: f => writeFileSync(join(f.output, proofPath), '{') },
  { name: 'modified admitted body', mutate: f => writeFileSync(join(f.output, f.policy.entries[0].path), `${f.bodies.get(f.policy.entries[0].path)}Unreviewed changed bytes.\n`) },
  { name: 'modified policy bytes', code: 'package-binding-mismatch', mutate: f => writeFileSync(join(f.output, policyPath), `${readFileSync(join(f.output, policyPath), 'utf8')}\n`) },
  { name: 'modified selected bundle bytes', code: 'harness-identity-mismatch', mutate: f => { const path = join(f.output, 'harness/versions/1.0.0/bundle.json'); writeFileSync(path, `${readFileSync(path, 'utf8')}\n`); } },
  { name: 'modified packaged index', code: 'package-index-mismatch', mutate: f => writeFileSync(join(f.output, indexPath), `${readFileSync(join(f.output, indexPath), 'utf8')}PRIVATE_HISTORY_SECRET\n`) },
  { name: 'missing whole-envelope binding', code: 'package-binding-mismatch', mutate: f => editProof(f, proof => { delete proof.bindingSha256; }) },
  { name: 'modified whole-envelope binding', code: 'package-binding-mismatch', mutate: f => editProof(f, proof => { proof.bindingSha256 = '0'.repeat(64); }) },
  { name: 'missing dependency record despite recomputed digests', code: 'package-reference-set-mismatch', mutate: f => editProof(f, proof => { proof.references.pop(); }, { bind: true, referenceSet: true }) },
  { name: 'missing dependency digest despite recomputed envelope', code: 'invalid-package-reference', mutate: f => editProof(f, proof => { delete proof.references[0].sha256; }, { bind: true, referenceSet: true }) },
  { name: 'missing reference-set binding despite recomputed envelope', code: 'package-binding-mismatch', mutate: f => editProof(f, proof => { delete proof.referencesSha256; }, { bind: true }) },
  { name: 'wrong reference-set digest despite recomputed envelope', code: 'package-binding-mismatch', mutate: f => editProof(f, proof => { proof.referencesSha256 = '0'.repeat(64); }, { bind: true }) },
  { name: 'extra dependency record despite recomputed digests', code: 'package-reference-set-mismatch', mutate: f => editProof(f, proof => { proof.references.push({ path: 'llm-wiki/raw/not-reviewed.md', kind: 'file', bytes: 1, sha256: hash('x') }); }, { bind: true, referenceSet: true }) },
  { name: 'reordered dependency records despite recomputed digests', code: 'package-reference-set-mismatch', mutate: f => editProof(f, proof => { proof.references.reverse(); }, { bind: true, referenceSet: true }) },
  { name: 'unsafe dependency path despite recomputed digests', code: 'package-reference-set-mismatch', mutate: f => editProof(f, proof => { proof.references[0].path = '../outside.md'; }, { bind: true, referenceSet: true }) },
]) test(`packaged status, search and index rendering reject ${row.name}`, t => {
  const f = fixture(t);
  packaged(f);
  row.mutate(f);
  assertPackagedBlocked(f, row.code);
});

test('a newly reviewed policy and extra body cannot expand an existing package without rebuilding its source-bound envelope', t => {
  const f = fixture(t);
  packaged(f);
  const path = 'llm-wiki/wiki/sources/newly-reviewed.md';
  const body = page('Newly reviewed', 'Copperfin additional source needs a newly verified package.');
  writeFileSync(join(f.output, path), body);
  const policy = JSON.parse(readFileSync(join(f.output, policyPath), 'utf8'));
  policy.entries.push({ path, title: 'Newly reviewed', type: 'Source', classification: 'authored-reference', sha256: hash(body), provenance: { kind: 'authored-source', evidence: [path] } });
  writeFileSync(join(f.output, policyPath), `${JSON.stringify(policy, null, 2)}\n`);
  assertPackagedBlocked(f, 'package-reference-set-mismatch');
});

test('runtime-present dependency bytes are verified rather than trusted because the package was verified at build time', t => {
  const f = fixture(t);
  packaged(f);
  const path = 'docs/dependency.md';
  mkdirSync(dirname(join(f.output, path)), { recursive: true });
  cpSync(join(f.root, path), join(f.output, path));
  const status = inspectKnowledge({ root: f.output, mode: 'packaged' });
  assert.equal(status.ok, true, JSON.stringify(status.errors));
  assert.equal(status.referenceVerification.runtimePresent, 1);
  assert.equal(status.referenceVerification.absentPaths.includes(path), false);
  writeFileSync(join(f.output, path), 'Replacement runtime body is not the build-verified source.\n');
  assertPackagedBlocked(f, 'package-reference-mismatch');
});

for (const path of ['.frameforge', 'llm-wiki/wiki/sources', 'docs']) test(`packaged mode rejects symlinked ${path} even with matching external bytes`, t => {
  const f = fixture(t);
  packaged(f);
  const external = join(f.directory, 'external');
  const original = join(f.output, path);
  cpSync(join(path === 'docs' ? f.root : f.output, path), external, { recursive: true });
  rmSync(original, { recursive: true, force: true });
  symlinkSync(external, original, process.platform === 'win32' ? 'junction' : 'dir');
  assertPackagedBlocked(f, 'symlink');
});

test('package dependency metadata hashes actual file bytes and records directories without admitting their children', t => {
  const f = fixture(t);
  const directory = 'reference-directory';
  const secret = 'DIRECTORY_CHILD_SECRET_NOT_A_REVIEWED_BODY';
  f.put(`${directory}/private.md`, secret);
  f.policy.entries[0].provenance.evidence.push(directory);
  f.savePolicy();
  packaged(f);
  const proof = JSON.parse(readFileSync(join(f.output, proofPath), 'utf8'));
  const expected = ['artifacts/review.json', 'docs/dependency.md', 'llm-wiki/raw/source.md'].map(path => {
    const bytes = readFileSync(join(f.root, path));
    return { path, kind: 'file', bytes: bytes.length, sha256: hash(bytes) };
  });
  expected.push({ path: directory, kind: 'directory', verification: 'existence-only' });
  expected.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  assert.deepEqual(proof.references, expected);
  assert.equal(proof.referencesSha256, hash(JSON.stringify(expected)));
  assert.equal(existsSync(join(f.output, directory)), false);
  for (const path of files(f.output)) assert.equal(readFileSync(join(f.output, path), 'utf8').includes(secret), false, `${path} leaked a directory child`);
  const status = inspectKnowledge({ root: f.output, mode: 'packaged' });
  assert.equal(status.ok, true, JSON.stringify(status.errors));
  assert.equal(status.referenceVerification.runtimeAbsent, expected.length);
  const search = searchKnowledge({ root: f.output, mode: 'packaged', query: secret });
  assert.equal(search.ok, true, JSON.stringify(search.errors));
  assert.equal(search.matchedEntries, 0);
  assert.deepEqual(search.results, []);
});
