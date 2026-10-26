#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectKnowledge, packageKnowledge, renderKnowledgeIndex, searchKnowledge } from '../server/project-knowledge.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Offline knowledge operations: status | check | search <query> [--limit 1..10] [--max-characters 2048..16000] | index [--write] | package --output <new-directory-outside-source>; accepts --root <repository> and --mode source|packaged (package always verifies source). JSON output, exit 0 passed, 1 failed/blocked. No providers or raw writes. Full-vault legacy lint is separate.';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function parse(argv) {
  const [operation, ...args] = argv;
  if (!['status', 'check', 'search', 'index', 'package'].includes(operation)) throw new Error(usage);
  const options = { root: defaultRoot };
  const seen = new Set();
  const query = [];
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--write') {
      if (operation !== 'index' || seen.has(key)) throw new Error(usage);
      options.write = true;
    } else if (['--root', '--mode', '--output', '--limit', '--max-characters'].includes(key)) {
      if (seen.has(key) || !args[index + 1] || args[index + 1].startsWith('--') || (['--limit', '--max-characters'].includes(key) && operation !== 'search') || (key === '--output' && operation !== 'package')) throw new Error(usage);
      const value = args[++index];
      if (key === '--root') options.root = resolve(value);
      else if (key === '--output') options.output = resolve(value);
      else if (key === '--mode') {
        if (!['source', 'packaged'].includes(value) || (operation === 'package' && value !== 'source')) throw new Error(usage);
        options.mode = value;
      }
      else {
        if (!/^[1-9]\d*$/u.test(value)) throw new Error(usage);
        options[key === '--limit' ? 'limit' : 'maxCharacters'] = Number(value);
      }
    } else if (operation === 'search' && !key.startsWith('--')) query.push(key);
    else throw new Error(usage);
    if (key.startsWith('--')) seen.add(key);
  }
  if (operation === 'search') options.query = query.join(' ');
  if (operation === 'package' && !options.output) throw new Error(usage);
  return { operation, options };
}
function indexLocation(root) {
  if (lstatSync(root).isSymbolicLink() || relative(root, realpathSync(root))) throw new Error('Index root changed or is a symbolic-link alias.');
  const directory = join(root, 'llm-wiki');
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || relative(directory, realpathSync(directory))) throw new Error('Index directory changed or is a symbolic link.');
  return { directory, target: join(directory, 'index.md') };
}
function existingIndex(target) {
  let handle;
  try { handle = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); } catch (error) { if (error.code === 'ENOENT') return { sha256: null, mode: 0o644 }; throw error; }
  try {
    if (lstatSync(target).isSymbolicLink()) throw new Error('Index target must not be a symbolic link.');
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size > 131072) throw new Error('Index must be a bounded regular file.');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(handle, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size !== stat.size || size > 131072) throw new Error('Index changed while preparing navigation.');
    return { sha256: hash(bytes.subarray(0, size)), mode: stat.mode & 0o777 };
  } finally { closeSync(handle); }
}
function checkStage(root, stagePath) {
  indexLocation(root);
  for (const path of ['.state', stagePath]) {
    const directory = join(root, path);
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || relative(directory, realpathSync(directory))) throw new Error('Index preservation directory must remain a real checkout-local directory.');
  }
}
function prepareStage(root) {
  const parent = join(root, '.state');
  try { mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory() || relative(parent, realpathSync(parent))) throw new Error('Index preservation cannot use an external or symbolic-link .state directory.');
  const path = `.state/knowledge-index-${randomUUID()}`;
  mkdirSync(join(root, path), { mode: 0o700 });
  checkStage(root, path);
  return { path, candidatePath: `${path}/candidate.md`, snapshotPath: `${path}/original.md` };
}
function writeIndex(root, rendered, mode) {
  const { target } = indexLocation(root);
  const previous = existingIndex(target);
  if (previous.sha256 !== rendered.previousSha256) throw new Error('Index changed after rendering; no historical bookkeeping was overwritten.');
  const stage = prepareStage(root);
  const candidate = join(root, stage.candidatePath);
  const snapshot = join(root, stage.snapshotPath);
  let movedOriginal = false;
  try {
    writeFileSync(candidate, rendered.content, { flag: 'wx', mode: previous.mode });
    const refreshed = renderKnowledgeIndex({ root, mode });
    if (!refreshed.ok || refreshed.sha256 !== rendered.sha256 || refreshed.previousSha256 !== rendered.previousSha256) throw new Error('Policy/source/index changed before preservation; review the retained candidate.');
    checkStage(root, stage.path);
    try {
      renameSync(target, snapshot);
      movedOriginal = true;
    } catch (error) {
      if (error.code !== 'ENOENT' || rendered.previousSha256 !== null) throw error;
    }
    if (movedOriginal && existingIndex(snapshot).sha256 !== rendered.previousSha256) throw new Error('The actual moved index differs from the rendered input; its late changes were preserved.');
    checkStage(root, stage.path);
    if (existingIndex(candidate).sha256 !== rendered.sha256) throw new Error('The staged navigation candidate changed before publication.');
    // Exclusive hard-link creation never replaces a target recreated by another writer.
    linkSync(candidate, target);
    return { ok: true, status: 'passed', path: rendered.path, sha256: rendered.sha256, previousSha256: rendered.previousSha256, bytes: Buffer.byteLength(rendered.content), written: true, snapshotPath: movedOriginal ? stage.snapshotPath : null, candidatePath: stage.candidatePath, preservationSemantics: 'The actual original inode is retained at snapshotPath. Candidate publication was exclusive, not a lock against external writers; later changes can make validation stale.', errors: [] };
  } catch (error) {
    let restoredOriginal = false;
    let restoreError = null;
    if (movedOriginal) {
      try {
        checkStage(root, stage.path);
        linkSync(snapshot, target);
        restoredOriginal = true;
      } catch (restoreFailure) { restoreError = restoreFailure.code || 'restore-unavailable'; }
    }
    return { ok: false, status: 'failed', scope: 'admitted-project-knowledge', errors: [{ code: 'index-write-conflict', path: rendered.path, message: error.message }], preservation: { snapshotPath: movedOriginal ? stage.snapshotPath : null, candidatePath: stage.candidatePath, restoredOriginal, restoreError }, recovery: 'Retained versions require explicit inspection and reconciliation. An existing live index was never overwritten; no retry or merge was attempted.' };
  }
}
export function runKnowledge(argv) {
  try {
    const { operation, options } = parse(argv);
    if (operation === 'package') return packageKnowledge(options);
    if (operation === 'status' || operation === 'check') return inspectKnowledge(options);
    if (operation === 'search') return searchKnowledge(options);
    const rendered = renderKnowledgeIndex(options);
    return options.write && rendered.ok ? writeIndex(options.root, rendered, options.mode) : rendered;
  } catch (error) {
    return { ok: false, status: 'blocked', scope: 'admitted-project-knowledge', errors: [{ code: 'cli-rejected', path: null, message: error.message }] };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = runKnowledge(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
