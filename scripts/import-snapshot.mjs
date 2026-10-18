import { DatabaseSync } from 'node:sqlite';
import { constants, createReadStream } from 'node:fs';
import { chown, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tables = ['entities', 'history', 'workflow_history', 'workflow_reviews', 'settings'];
const samePath = (left, right) => path.relative(left, right) === '';
const within = (root, filename) => {
  const relative = path.relative(root, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function plainPath(filename, directory = false) {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) || !samePath(await realpath(filename), filename)) throw new Error('Import paths must be plain files or directories without symlinks');
  return info;
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function verifyDatabase(filename, manifest) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('Imported database failed integrity_check');
    const existing = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
    if (!existing.has('entities')) throw new Error('Imported database has no entities table');
    const counts = Object.fromEntries(tables.filter(table => existing.has(table)).map(table => [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
    const entityCounts = Object.fromEntries(db.prepare('SELECT kind,count(*) AS count FROM entities GROUP BY kind ORDER BY kind').all().map(row => [row.kind, row.count]));
    const entityIds = Object.fromEntries(Object.keys(entityCounts).map(kind => [kind, db.prepare('SELECT id FROM entities WHERE kind=? ORDER BY id').all(kind).map(row => row.id)]));
    const versions = kind => db.prepare('SELECT id,data FROM entities WHERE kind=? ORDER BY id').all(kind).map(row => ({ id: row.id, version: JSON.parse(row.data).version }));
    const observed = { tableCounts: counts, entityCounts, entityIds, episodeVersions: versions('episodes'), workflowVersions: versions('workflows') };
    for (const [key, value] of Object.entries(observed)) {
      if (manifest[key] !== undefined && !isDeepStrictEqual(manifest[key], value)) throw new Error(`Imported database ${key} differs from snapshot manifest`);
    }
    const media = new Map(manifest.media.map(entry => [entry.url, entry.sha256]));
    function verifyReferences(value) {
      if (typeof value === 'string' && /^\/api\/(uploads|exports)\//.test(value)) {
        if (!media.has(value)) throw new Error('Imported database references media absent from the snapshot manifest');
      } else if (Array.isArray(value)) value.forEach(verifyReferences);
      else if (value && typeof value === 'object') {
        Object.values(value).forEach(verifyReferences);
        const url = value.outputUrl || value.url;
        if (media.has(url) && /^[a-f0-9]{64}$/i.test(value.sha256 || '') && media.get(url) !== value.sha256.toLowerCase()) throw new Error('Imported media hash differs from its database review or render record');
      }
    }
    for (const table of ['entities', 'history', 'workflow_history', 'workflow_reviews'].filter(table => existing.has(table))) {
      for (const row of db.prepare(`SELECT data FROM ${table}`).iterate()) verifyReferences(JSON.parse(row.data));
    }
    return observed;
  } finally { db.close(); }
}

/** Run with the snapshot mounted read-only and a dedicated, empty target volume. */
export async function importSnapshot({ source, target, uid, gid }) {
  if (!source || !target) throw new Error('Explicit source and target directories are required');
  if ((uid !== undefined || gid !== undefined) && (![uid, gid].every(value => Number.isInteger(value) && value >= 0 && value <= 2147483647))) throw new Error('Ownership requires explicit nonnegative integer uid and gid');
  const sourceDir = path.resolve(source), destination = path.resolve(target);
  await plainPath(sourceDir, true);
  await plainPath(destination, true);
  if (samePath(sourceDir, destination) || within(sourceDir, destination) || within(destination, sourceDir)) throw new Error('Snapshot and target directories must not overlap');
  if ((await readdir(destination)).length) throw new Error('Import target must be empty; existing data will never be overwritten');
  const manifestFile = path.join(sourceDir, 'snapshot-manifest.json');
  const completeFile = path.join(sourceDir, '.snapshot-complete');
  await plainPath(manifestFile);
  await plainPath(completeFile);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.format !== 'frameforge-snapshot-v1' || manifest.integrity !== 'ok' || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || await readFile(completeFile, 'utf8') !== manifest.createdAt) throw new Error('Snapshot completion marker or manifest format is invalid');
  if (manifest.database?.filename !== 'studio.sqlite' || !validHash(manifest.database.sha256) || !Array.isArray(manifest.media) || manifest.mediaCount !== manifest.media.length) throw new Error('Snapshot database or media manifest is invalid');
  const entries = [{ relative: 'studio.sqlite', sha256: manifest.database.sha256 }];
  const seen = new Set();
  for (const media of manifest.media) {
    const match = typeof media.url === 'string' && /^\/api\/(uploads|exports)\/([a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)$/.exec(media.url);
    if (!match || !validHash(media.sha256) || !Number.isSafeInteger(media.bytes) || media.bytes < 0 || seen.has(media.url.toLowerCase())) throw new Error('Snapshot contains unsafe or duplicate media entries');
    seen.add(media.url.toLowerCase());
    entries.push({ relative: `${match[1]}/${match[2]}`, sha256: media.sha256, bytes: media.bytes });
  }
  // Validate all source bytes before touching the destination. Never open the
  // read-only snapshot database with SQLite: WAL may need writable sidecars.
  for (const entry of entries) {
    const filename = path.join(sourceDir, entry.relative);
    const info = await plainPath(filename);
    if ((entry.bytes !== undefined && info.size !== entry.bytes) || await hashFile(filename) !== entry.sha256) throw new Error(`Snapshot hash or size mismatch: ${entry.relative}`);
  }
  if ((await readdir(destination)).length) throw new Error('Import target changed during validation');
  const copied = [];
  for (const directory of ['uploads', 'exports']) {
    const filename = path.join(destination, directory);
    await mkdir(filename, { mode: 0o700 });
    copied.push(filename);
  }
  for (const entry of entries) {
    const filename = path.join(destination, entry.relative);
    await plainPath(path.dirname(filename), true);
    await copyFile(path.join(sourceDir, entry.relative), filename, constants.COPYFILE_EXCL);
    await plainPath(filename);
    await chmod(filename, 0o600);
    if (await hashFile(filename) !== entry.sha256) throw new Error(`Imported file hash mismatch: ${entry.relative}`);
    copied.push(filename);
  }
  const observed = verifyDatabase(path.join(destination, 'studio.sqlite'), manifest);
  if (await hashFile(path.join(destination, 'studio.sqlite')) !== manifest.database.sha256) throw new Error('Imported database changed during verification');
  // No deletion or rollback: a failed import remains clearly incomplete and
  // cannot overwrite anything on a retry. Use a different new empty volume.
  if (uid !== undefined) {
    for (const filename of copied) await chown(filename, uid, gid);
    // SQLite can create journal sidecars while validating WAL-mode databases.
    for (const suffix of ['-wal', '-shm']) {
      const filename = path.join(destination, `studio.sqlite${suffix}`);
      const info = await lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info) { await plainPath(filename); await chmod(filename, 0o600); await chown(filename, uid, gid); }
    }
    await chown(destination, uid, gid);
  }
  return { format: 'frameforge-import-v1', importedAt: new Date().toISOString(), sourceCreatedAt: manifest.createdAt, integrity: 'ok', database: manifest.database, mediaCount: manifest.mediaCount, ...observed, ownership: uid === undefined ? null : { uid, gid } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = { '--source': 'source', '--target': 'target', '--uid': 'uid', '--gid': 'gid' }[process.argv[index]];
      const value = process.argv[index + 1];
      if (!key || value === undefined || Object.hasOwn(options, key)) throw new Error('Usage: node scripts/import-snapshot.mjs --source <readonly-snapshot> --target <empty-data-volume> [--uid 1000 --gid 1000]');
      options[key] = ['uid', 'gid'].includes(key) ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
    }
    console.log(JSON.stringify(await importSnapshot(options), null, 2));
  } catch (error) { console.error(`Import failed: ${error.message}`); process.exitCode = 1; }
}
