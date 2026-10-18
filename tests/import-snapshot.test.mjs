import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotData } from '../scripts/snapshot-data.mjs';
import { importSnapshot } from '../scripts/import-snapshot.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-import-'));
  const live = path.join(root, 'live'), snapshots = path.join(root, 'snapshots');
  const source = path.join(snapshots, 'snapshot'), target = path.join(root, 'volume');
  for (const directory of [live, snapshots, target, path.join(live, 'uploads'), path.join(live, 'exports')]) await mkdir(directory);
  const db = new DatabaseSync(path.join(live, 'studio.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE entities(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id)); CREATE TABLE history(id INTEGER PRIMARY KEY,data TEXT);');
  db.prepare('INSERT INTO entities VALUES (?,?,?)').run('episodes', 'episode-1', JSON.stringify({ id: 'episode-1', version: 9, scenes: [{ audioSrc: '/api/uploads/voice.wav' }] }));
  db.prepare('INSERT INTO history VALUES (?,?)').run(1, JSON.stringify({ version: 8, url: '/api/exports/old.mp4' }));
  await writeFile(path.join(live, 'uploads', 'voice.wav'), 'fixture voice');
  await writeFile(path.join(live, 'exports', 'old.mp4'), 'fixture render');
  try { await snapshotData({ source: live, snapshotRoot: snapshots, target: source }); }
  finally { db.close(); }
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(path.join(source, 'snapshot-manifest.json'), 'utf8'));
  const saveManifest = () => writeFile(path.join(source, 'snapshot-manifest.json'), JSON.stringify(manifest));
  return { root, source, target, manifest, saveManifest };
}

test('imports verified SQLite state and only declared media into an empty volume', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'undeclared.txt'), 'do not copy');
  const receipt = await importSnapshot(f);
  assert.equal(receipt.integrity, 'ok');
  assert.equal(receipt.mediaCount, 2);
  assert.deepEqual(receipt.episodeVersions, [{ id: 'episode-1', version: 9 }]);
  assert.deepEqual(receipt.entityIds, { episodes: ['episode-1'] });
  assert.equal(receipt.ownership, null);
  assert.deepEqual((await readdir(f.target)).filter(name => !['studio.sqlite-shm', 'studio.sqlite-wal'].includes(name)).sort(), ['exports', 'studio.sqlite', 'uploads']);
  for (const relative of ['studio.sqlite', 'uploads/voice.wav', 'exports/old.mp4']) assert.deepEqual(await readFile(path.join(f.target, relative)), await readFile(path.join(f.source, relative)));
  const copied = new DatabaseSync(path.join(f.target, 'studio.sqlite'), { readOnly: true });
  try { assert.equal(copied.prepare('SELECT count(*) AS count FROM history').get().count, 1); }
  finally { copied.close(); }
  await assert.rejects(importSnapshot(f), /must be empty/);
});

test('refuses existing destination data without overwrite or deletion', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.target, 'studio.sqlite'), 'existing data');
  await assert.rejects(importSnapshot(f), /must be empty/);
  assert.equal(await readFile(path.join(f.target, 'studio.sqlite'), 'utf8'), 'existing data');
  assert.deepEqual(await readdir(f.target), ['studio.sqlite']);
});

test('rejects incomplete snapshots and invalid completion markers before copying', async t => {
  const f = await fixture(t);
  await rm(path.join(f.source, '.snapshot-complete'));
  await assert.rejects(importSnapshot(f), /ENOENT/);
  await writeFile(path.join(f.source, '.snapshot-complete'), 'not the manifest timestamp');
  await assert.rejects(importSnapshot(f), /completion marker/);
  assert.deepEqual(await readdir(f.target), []);
});

test('rejects changed database or media bytes before touching empty target', async t => {
  const f = await fixture(t);
  const audio = path.join(f.source, 'uploads', 'voice.wav');
  const original = await readFile(audio);
  await writeFile(audio, 'tampered voice');
  await assert.rejects(importSnapshot(f), /hash or size mismatch/);
  await writeFile(audio, original);
  await writeFile(path.join(f.source, 'studio.sqlite'), 'not the captured database');
  await assert.rejects(importSnapshot(f), /hash or size mismatch/);
  assert.deepEqual(await readdir(f.target), []);
});

test('rejects traversal, duplicate paths and linked directories', async t => {
  const f = await fixture(t);
  const original = f.manifest.media[0].url;
  f.manifest.media[0].url = '/api/uploads/../outside.wav';
  await f.saveManifest();
  await assert.rejects(importSnapshot(f), /unsafe or duplicate/);
  f.manifest.media[0].url = original;
  f.manifest.media.push(f.manifest.media[0]); f.manifest.mediaCount++;
  await f.saveManifest();
  await assert.rejects(importSnapshot(f), /unsafe or duplicate/);
  f.manifest.media.pop(); f.manifest.mediaCount--;
  await f.saveManifest();
  const linked = path.join(f.root, 'linked-volume');
  await symlink(f.target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(importSnapshot({ ...f, target: linked }), /without symlinks/);
  await assert.rejects(importSnapshot({ ...f, target: f.source }), /overlap/);
  assert.deepEqual(await readdir(f.target), []);
});

test('database manifest counts and IDs are checked after copying, preserving incomplete files on failure', async t => {
  const f = await fixture(t);
  f.manifest.entityIds.episodes = ['incorrect-id'];
  await f.saveManifest();
  await assert.rejects(importSnapshot(f), /entityIds differs/);
  assert.ok((await readdir(f.target)).includes('studio.sqlite'));
  await assert.rejects(importSnapshot(f), /must be empty/);
  assert.deepEqual(await readFile(path.join(f.target, 'studio.sqlite')), await readFile(path.join(f.source, 'studio.sqlite')));
});

test('rejects invalid SQLite content even when its manifest hash matches and validates ownership arguments', async t => {
  const f = await fixture(t);
  await assert.rejects(importSnapshot({ ...f, uid: 1000 }), /uid and gid/);
  await assert.rejects(importSnapshot({ ...f, uid: -1, gid: 1000 }), /uid and gid/);
  const invalid = Buffer.from('invalid sqlite');
  await writeFile(path.join(f.source, 'studio.sqlite'), invalid);
  f.manifest.database.sha256 = createHash('sha256').update(invalid).digest('hex');
  await f.saveManifest();
  await assert.rejects(importSnapshot(f), /database|file is not/);
});

test('rejects a manifest that omits media still referenced by database history', async t => {
  const f = await fixture(t);
  f.manifest.media = f.manifest.media.filter(media => media.url !== '/api/exports/old.mp4');
  f.manifest.mediaCount = f.manifest.media.length;
  await f.saveManifest();
  await assert.rejects(importSnapshot(f), /references media absent/);
});
