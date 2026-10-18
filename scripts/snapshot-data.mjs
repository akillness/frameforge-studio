import * as sqlite from 'node:sqlite';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tables = ['entities', 'history', 'workflow_history', 'workflow_reviews', 'settings'];
const samePath = (left, right) => path.relative(left, right) === '';
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function ensurePlainFile(filename, root) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(filename), filename) || !within(root, filename)) throw new Error('Snapshot source media must be a regular file inside its source directory');
  return info;
}

/** SQLite owns the online copy. Store is deliberately never imported or constructed. */
export async function snapshotData({ source, snapshotRoot, target }) {
  if (!source || !snapshotRoot || !target) throw new Error('Explicit source, snapshotRoot, and target paths are required');
  const sourceDir = await realpath(path.resolve(source));
  const root = await realpath(path.resolve(snapshotRoot));
  const destination = path.resolve(target);
  if (!(await lstat(sourceDir)).isDirectory() || !(await lstat(root)).isDirectory()) throw new Error('Source and snapshot root must be directories');
  if (!within(root, destination)) throw new Error('Snapshot target must be a child of the explicit snapshot root');
  if (samePath(destination, sourceDir) || within(sourceDir, destination) || within(destination, sourceDir)) throw new Error('Snapshot target and live source must not overlap');
  // Reject junction/symlink escapes, including an existing empty target.
  let ancestor = destination;
  while (!samePath(ancestor, root)) {
    const info = await lstat(ancestor).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (info.isSymbolicLink() || !info.isDirectory() || !samePath(await realpath(ancestor), ancestor))) throw new Error('Snapshot target ancestors must be plain directories within the snapshot root');
    ancestor = path.dirname(ancestor);
  }
  const targetExists = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (targetExists) throw new Error('Snapshot target must be new; existing directories will never be reused');
  const sourceDatabase = path.join(sourceDir, 'studio.sqlite');
  await ensurePlainFile(sourceDatabase, sourceDir);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  if (!samePath(await realpath(destination), destination)) throw new Error('Snapshot target changed during creation');
  const lock = await open(path.join(destination, '.snapshot-in-progress'), 'wx', 0o600);
  await lock.close();
  const targetDatabase = path.join(destination, 'studio.sqlite');
  const databaseReservation = await open(targetDatabase, 'wx', 0o600);
  await databaseReservation.close();
  const sourceDb = new sqlite.DatabaseSync(sourceDatabase, { readOnly: true });
  try {
    sourceDb.exec('PRAGMA busy_timeout=5000');
    if (typeof sqlite.backup === 'function') await sqlite.backup(sourceDb, targetDatabase);
    else sourceDb.prepare('VACUUM INTO ?').run(targetDatabase);
  } finally { sourceDb.close(); }

  const db = new sqlite.DatabaseSync(targetDatabase, { readOnly: true });
  const references = new Map();
  let manifest;
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('Snapshot database failed SQLite integrity_check');
    const existing = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
    if (!existing.has('entities')) throw new Error('Snapshot database has no entities table');
    const tableCounts = Object.fromEntries(tables.filter(table => existing.has(table)).map(table => [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
    const entityCounts = Object.fromEntries(db.prepare('SELECT kind,count(*) AS count FROM entities GROUP BY kind ORDER BY kind').all().map(row => [row.kind,row.count]));
    const entityIds = Object.fromEntries(Object.keys(entityCounts).map(kind => [kind, db.prepare('SELECT id FROM entities WHERE kind=? ORDER BY id').all(kind).map(row => row.id)]));
    const episodeVersions = db.prepare("SELECT id,data FROM entities WHERE kind='episodes' ORDER BY id").all().map(row => ({ id: row.id, version: JSON.parse(row.data).version }));
    const workflowVersions = db.prepare("SELECT id,data FROM entities WHERE kind='workflows' ORDER BY id").all().map(row => ({ id: row.id, version: JSON.parse(row.data).version }));
    function collect(value) {
      if (typeof value === 'string' && /^\/api\/(uploads|exports)\//.test(value)) {
        const match = /^\/api\/(uploads|exports)\/([a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)$/.exec(value);
        if (!match) throw new Error('Snapshot contains an unsafe media reference');
        if (!references.has(value)) references.set(value, { directory: match[1], filename: match[2], expectedHashes: new Set() });
      } else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') {
        Object.values(value).forEach(collect);
        const url = value.outputUrl || value.url;
        if (references.has(url) && /^[a-f0-9]{64}$/i.test(value.sha256 || '')) references.get(url).expectedHashes.add(value.sha256.toLowerCase());
      }
    }
    for (const table of ['entities', 'history', 'workflow_history', 'workflow_reviews'].filter(table => existing.has(table))) {
      for (const row of db.prepare(`SELECT data FROM ${table}`).iterate()) collect(JSON.parse(row.data));
    }
    manifest = { format: 'frameforge-snapshot-v1', createdAt: new Date().toISOString(), integrity: 'ok', tableCounts, entityCounts, entityIds, episodeVersions, workflowVersions, media: [] };
  } finally { db.close(); }

  for (const directory of ['uploads', 'exports']) await mkdir(path.join(destination, directory), { mode: 0o700 });
  for (const [url, reference] of [...references].sort(([left], [right]) => left.localeCompare(right))) {
    const filename = path.join(sourceDir, reference.directory, reference.filename);
    const before = await ensurePlainFile(filename, sourceDir);
    const initialHash = await hashFile(filename);
    const copy = path.join(destination, reference.directory, reference.filename);
    await copyFile(filename, copy, constants.COPYFILE_EXCL);
    const after = await ensurePlainFile(filename, sourceDir);
    const sha256 = await hashFile(copy);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || initialHash !== sha256 || sha256 !== await hashFile(filename)) throw new Error('Source media changed while copying; snapshot is incomplete');
    if ([...reference.expectedHashes].some(expected => expected !== sha256)) throw new Error('Snapshot media hash differs from its recorded render or review hash');
    manifest.media.push({ url, bytes: after.size, sha256 });
  }
  manifest.database = { filename: 'studio.sqlite', sha256: await hashFile(targetDatabase) };
  manifest.mediaCount = manifest.media.length;
  // A manifest exists only after every database/media check succeeded. Partial files
  // are retained for diagnosis; this utility never deletes source or target data.
  await writeFile(path.join(destination, 'snapshot-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(destination, '.snapshot-complete'), manifest.createdAt, { flag: 'wx', mode: 0o600 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = { '--source': 'source', '--snapshot-root': 'snapshotRoot', '--target': 'target' }[process.argv[index]];
      if (!key || !process.argv[index + 1] || options[key]) throw new Error('Usage: node scripts/snapshot-data.mjs --source <data-dir> --snapshot-root <existing-root> --target <new-child>');
      options[key] = process.argv[index + 1];
    }
    console.log(JSON.stringify(await snapshotData(options), null, 2));
  } catch (error) { console.error(`Snapshot failed: ${error.message}`); process.exitCode = 1; }
}
