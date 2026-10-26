import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, closeSync, readSync, writeFileSync, renameSync, opendirSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join, parse, relative, resolve } from 'node:path';
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
export const MAX_HARNESS_MANIFEST_BYTES = 8192;
export const MAX_HARNESS_BUNDLE_BYTES = 16384;
export const MAX_HARNESS_FILE_BYTES = 262144;
export const MAX_HARNESS_TOTAL_BYTES = 1048576;
const snapshots = new WeakMap();
const bundleInventory = new Map([['', new Map()]]);
for (const name of [...HARNESS_FILES, 'bundle.json']) {
  const parts = name.split('/');
  let parent = '';
  for (let index = 0; index < parts.length; index += 1) {
    const directory = index < parts.length - 1;
    bundleInventory.get(parent).set(parts[index], directory);
    parent = parent ? `${parent}/${parts[index]}` : parts[index];
    if (directory && !bundleInventory.has(parent)) bundleInventory.set(parent, new Map());
  }
}

function tooLarge() {
  return Object.assign(new Error('Harness input exceeds the byte limit'), { code: 'HARNESS_INPUT_TOO_LARGE' });
}

function plainDirectory(directory) {
  directory = resolve(directory);
  let current = parse(directory).root;
  for (const part of relative(current, directory).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Harness directories must not be symbolic links');
  }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid bundle directory');
}
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
function regularFileInfo(path) {
  plainDirectory(dirname(path));
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
  return info;
}
function regularFile(path, maximum = MAX_HARNESS_FILE_BYTES) {
  const before = regularFileInfo(path);
  if (before.size > maximum) throw tooLarge();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw new Error('Harness file changed while opening');
    if (info.size > maximum) throw tooLarge();
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length !== info.size || fstatSync(fd).size !== info.size) throw new Error('Harness file changed while reading');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Harness directories must not be symbolic links');
}
function verifyInventory(directory) {
  for (const [parent, expected] of bundleInventory) {
    const current = join(directory, parent);
    plainDirectory(current);
    const handle = opendirSync(current, { bufferSize: 1 });
    let count = 0;
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        if (count >= expected.size || !expected.has(entry.name) || entry.isSymbolicLink() || (expected.get(entry.name) ? !entry.isDirectory() : !entry.isFile())) throw new Error('Unexpected files in immutable bundle');
        count += 1;
      }
    } finally { handle.closeSync(); }
    if (count !== expected.size) throw new Error('Unexpected files in immutable bundle');
  }
}
function verifyBundleSnapshot(directory, version, reservedBytes = 0) {
  versionParts(version);
  plainDirectory(directory);
  const bytes = regularFile(join(directory, 'bundle.json'), MAX_HARNESS_BUNDLE_BYTES);
  const bundle = JSON.parse(bytes);
  if (bundle.schema !== 'frameforge-harness-bundle/v1' || bundle.version !== version || !Array.isArray(bundle.files)) throw new Error('Invalid harness bundle identity');
  if (JSON.stringify(bundle.files.map(file => file.path).sort()) !== JSON.stringify(HARNESS_FILES)) throw new Error('Unexpected harness file inventory');
  verifyInventory(directory);
  let inputBytes = bytes.length + reservedBytes;
  for (const name of HARNESS_FILES) {
    const info = regularFileInfo(join(directory, name));
    if (info.size > MAX_HARNESS_FILE_BYTES || (inputBytes += info.size) > MAX_HARNESS_TOTAL_BYTES) throw tooLarge();
  }
  let totalBytes = bytes.length;
  const files = new Map();
  for (const file of bundle.files) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid harness checksum record');
    const maximum = Math.min(MAX_HARNESS_FILE_BYTES, MAX_HARNESS_TOTAL_BYTES - reservedBytes - totalBytes);
    if (file.bytes > maximum) throw tooLarge();
    const data = regularFile(join(directory, file.path), maximum);
    if (data.length !== file.bytes || hash(data) !== file.sha256) throw new Error(`Harness checksum mismatch: ${file.path}`);
    totalBytes += data.length;
    files.set(file.path, data);
  }
  const verified = { bundle, sha256: hash(bytes) };
  snapshots.set(verified, { files, totalBytes });
  return verified;
}
export function verifyBundle(directory, version) {
  return verifyBundleSnapshot(directory, version);
}
export function verifyCurrent(root) {
  const manifest = join(root, 'harness/manifest.json');
  const bytes = regularFile(manifest, MAX_HARNESS_MANIFEST_BYTES);
  const pointer = JSON.parse(bytes);
  versionParts(pointer.currentVersion);
  if (pointer.schema !== 'frameforge-harness-current/v1' || pointer.bundlePath !== `versions/${pointer.currentVersion}`) throw new Error('Invalid current harness pointer');
  const verified = verifyBundleSnapshot(join(root, 'harness', pointer.bundlePath), pointer.currentVersion, bytes.length);
  if (verified.sha256 !== pointer.bundleSha256) throw new Error('Current bundle manifest checksum mismatch');
  const snapshot = snapshots.get(verified);
  if (snapshot.totalBytes + bytes.length > MAX_HARNESS_TOTAL_BYTES) throw tooLarge();
  if (!regularFile(manifest, MAX_HARNESS_MANIFEST_BYTES).equals(bytes)) throw new Error('Current harness pointer changed during verification');
  const selected = { pointer, ...verified };
  snapshots.set(selected, snapshot);
  return selected;
}
export function readVerifiedHarnessFile(verification, name) {
  const bytes = snapshots.get(verification)?.files.get(name);
  if (!bytes) throw new Error('File is not part of this verified harness snapshot');
  return Buffer.from(bytes);
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
