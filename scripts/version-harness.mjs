import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HARNESS_FILES = [
  '.claude/agents/production-director.md',
  '.claude/agents/production-editor.md',
  '.claude/agents/production-researcher.md',
  '.claude/agents/production-reviewer.md',
  '.claude/agents/production-supervisor.md',
  '.claude/skills/production-orchestrator/SKILL.md',
  'docs/harness.md',
  'docs/harness-versioning.md',
].sort();
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const versionParts = version => {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Use an exact numeric major.minor.patch version');
  const parts = version.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Version component is too large');
  return parts;
};
const newer = (candidate, previous) => {
  const left = versionParts(candidate), right = versionParts(previous);
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
};
function regularFile(path) {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
  return readFileSync(path);
}
function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Harness directories must not be symbolic links');
}
function contents(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are not allowed in a harness bundle');
    const name = `${prefix}${entry.name}`;
    return entry.isDirectory() ? contents(join(directory, entry.name), `${name}/`) : [name];
  }).sort();
}
export function verifyBundle(directory, version) {
  versionParts(version);
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid bundle directory');
  const bytes = regularFile(join(directory, 'bundle.json'));
  const bundle = JSON.parse(bytes);
  if (bundle.schema !== 'frameforge-harness-bundle/v1' || bundle.version !== version || !Array.isArray(bundle.files)) throw new Error('Invalid harness bundle identity');
  if (JSON.stringify(bundle.files.map(file => file.path).sort()) !== JSON.stringify(HARNESS_FILES)) throw new Error('Unexpected harness file inventory');
  if (JSON.stringify(contents(directory)) !== JSON.stringify([...HARNESS_FILES, 'bundle.json'].sort())) throw new Error('Unexpected files in immutable bundle');
  for (const file of bundle.files) {
    const data = regularFile(join(directory, file.path));
    if (data.length !== file.bytes || hash(data) !== file.sha256) throw new Error(`Harness checksum mismatch: ${file.path}`);
  }
  return { bundle, sha256: hash(bytes) };
}
export function verifyCurrent(root) {
  const pointer = JSON.parse(regularFile(join(root, 'harness/manifest.json')));
  versionParts(pointer.currentVersion);
  if (pointer.schema !== 'frameforge-harness-current/v1' || pointer.bundlePath !== `versions/${pointer.currentVersion}`) throw new Error('Invalid current harness pointer');
  const verified = verifyBundle(join(root, 'harness', pointer.bundlePath), pointer.currentVersion);
  if (verified.sha256 !== pointer.bundleSha256) throw new Error('Current bundle manifest checksum mismatch');
  return { pointer, ...verified };
}
function copyBundle(source, destination, version) {
  const original = verifyBundle(source, version);
  if (existsSync(destination)) {
    if (verifyBundle(destination, version).sha256 !== original.sha256) throw new Error('Existing archive differs; immutable archive was not replaced');
    return;
  }
  const stage = `${destination}.staging-${randomUUID()}`;
  try {
    ensureDirectory(stage);
    for (const name of [...HARNESS_FILES, 'bundle.json']) {
      ensureDirectory(resolve(stage, name, '..'));
      writeFileSync(join(stage, name), regularFile(join(source, name)), { flag: 'wx' });
    }
    verifyBundle(stage, version);
    renameSync(stage, destination);
  } finally { if (existsSync(stage)) rmSync(stage, { recursive: true }); }
}
export function changeHarness(root, action, version) {
  root = resolve(root);
  if (!['promote', 'rollback'].includes(action)) throw new Error('Action must be promote or rollback');
  versionParts(version);
  const base = join(root, 'harness');
  ensureDirectory(base);
  ensureDirectory(join(base, 'versions'));
  ensureDirectory(join(base, 'archive'));
  const lock = join(base, '.promotion.lock');
  let handle;
  try { handle = openSync(lock, 'wx'); } catch { throw new Error('Harness promotion is locked; inspect the existing operation before retrying'); }
  const stage = join(base, 'versions', `.staging-${randomUUID()}`);
  const pointerTemporary = join(base, `.manifest-${randomUUID()}.tmp`);
  try {
    writeFileSync(handle, encode({ pid: process.pid, createdAt: new Date().toISOString() }));
    const previous = existsSync(join(base, 'manifest.json')) ? verifyCurrent(root) : null;
    if (previous?.pointer.currentVersion === version) throw new Error('Version is already active; use verify or promote a new version');
    const destination = join(base, 'versions', version);
    if (action === 'promote') {
      if (previous && !newer(version, previous.pointer.currentVersion)) throw new Error('Promotion must increase the version; use rollback for a prior bundle');
      if (existsSync(destination)) throw new Error('Version already exists and is immutable');
      ensureDirectory(stage);
      const files = HARNESS_FILES.map(path => {
        const data = regularFile(join(root, path));
        ensureDirectory(resolve(stage, path, '..'));
        writeFileSync(join(stage, path), data, { flag: 'wx' });
        return { path, bytes: data.length, sha256: hash(data) };
      });
      writeFileSync(join(stage, 'bundle.json'), encode({ schema: 'frameforge-harness-bundle/v1', version, createdAt: new Date().toISOString(), files }), { flag: 'wx' });
      verifyBundle(stage, version);
      for (const file of files) if (hash(regularFile(join(root, file.path))) !== file.sha256) throw new Error('Harness sources changed during promotion; retry with stable sources');
      renameSync(stage, destination);
    } else {
      if (!previous) throw new Error('Cannot rollback an uninitialized harness');
      if (!existsSync(destination)) throw new Error('Rollback target does not exist');
    }
    const selected = verifyBundle(destination, version);
    if (previous) copyBundle(join(base, previous.pointer.bundlePath), join(base, 'archive', previous.pointer.currentVersion), previous.pointer.currentVersion);
    const pointer = { schema: 'frameforge-harness-current/v1', currentVersion: version, bundlePath: `versions/${version}`, bundleSha256: selected.sha256, previousVersion: previous?.pointer.currentVersion ?? null, action, updatedAt: new Date().toISOString() };
    writeFileSync(pointerTemporary, encode(pointer), { flag: 'wx' });
    // Only this same-directory rename changes the active version. Old bundles stay readable.
    renameSync(pointerTemporary, join(base, 'manifest.json'));
    return verifyCurrent(root).pointer;
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true });
    if (existsSync(pointerTemporary)) unlinkSync(pointerTemporary);
    closeSync(handle);
    unlinkSync(lock);
  }
}
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action, version] = process.argv.slice(2);
    const result = action === 'verify' ? verifyCurrent(root).pointer : changeHarness(root, action, version);
    process.stdout.write(encode({ ok: true, ...result }));
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
