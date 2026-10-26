import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotData } from '../scripts/snapshot-data.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-snapshot-'));
  const source = path.join(root, 'live');
  const snapshotRoot = path.join(root, 'snapshots');
  await mkdir(source);
  await mkdir(snapshotRoot);
  for (const directory of ['uploads', 'exports']) await mkdir(path.join(source, directory));
  const db = new DatabaseSync(path.join(source, 'studio.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE entities (kind TEXT, id TEXT, data TEXT, PRIMARY KEY(kind,id));
    CREATE TABLE history (id INTEGER PRIMARY KEY, episode_id TEXT, version INTEGER, data TEXT);
    CREATE TABLE workflow_history (id INTEGER PRIMARY KEY, workflow_id TEXT, version INTEGER, data TEXT);
    CREATE TABLE workflow_reviews (id TEXT PRIMARY KEY, run_id TEXT, data TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  const save = (kind, id, data) => db.prepare('INSERT INTO entities VALUES (?,?,?)').run(kind, id, JSON.stringify(data));
  const audio = Buffer.from('Fixture audio bytes');
  const video = Buffer.from('Fixture video bytes');
  await writeFile(path.join(source, 'uploads', 'voice.wav'), audio);
  await writeFile(path.join(source, 'uploads', 'previous.wav'), 'Historical audio bytes');
  await writeFile(path.join(source, 'exports', 'render.mp4'), video);
  save('episodes', 'episode-1', { id: 'episode-1', version: 7, scenes: [{ audioSrc: '/api/uploads/voice.wav' }] });
  save('workflows', 'workflow-1', { id: 'workflow-1', version: 2 });
  save('jobs', 'job-1', { id: 'job-1', status: 'running' });
  save('jobs', 'job-2', { id: 'job-2', status: 'completed', outputUrl: '/api/exports/render.mp4', sha256: hash(video) });
  db.prepare('INSERT INTO history VALUES (1,?,?,?)').run('episode-1', 6, JSON.stringify({ version: 6, scenes: [{ audioSrc: '/api/uploads/previous.wav' }] }));
  db.prepare('INSERT INTO workflow_history VALUES (1,?,?,?)').run('workflow-1', 1, JSON.stringify({ version: 1 }));
  db.prepare('INSERT INTO workflow_reviews VALUES (?,?,?)').run('review-1', 'run-1', JSON.stringify({ outputUrl: '/api/exports/render.mp4', sha256: hash(video) }));
  db.prepare('INSERT INTO settings VALUES (?,?)').run('setting', 'retained');
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, source, snapshotRoot, db, save, target: path.join(snapshotRoot, 'new-snapshot') };
}

test('online snapshot preserves committed WAL, IDs, versions, history, review hashes and running job without opening Store', async t => {
  const f = await fixture(t);
  assert.ok((await stat(path.join(f.source, 'studio.sqlite-wal'))).size > 0);
  const sourceDatabase = await readFile(path.join(f.source, 'studio.sqlite'));
  const sourceWal = await readFile(path.join(f.source, 'studio.sqlite-wal'));
  f.db.exec('BEGIN');
  f.save('episodes', 'uncommitted', { id: 'uncommitted', version: 1 });
  const manifest = await snapshotData(f);
  f.db.exec('ROLLBACK');
  assert.deepEqual(await readFile(path.join(f.source, 'studio.sqlite')), sourceDatabase);
  assert.deepEqual(await readFile(path.join(f.source, 'studio.sqlite-wal')), sourceWal);
  assert.equal(manifest.integrity, 'ok');
  assert.deepEqual(manifest.episodeVersions, [{ id: 'episode-1', version: 7 }]);
  assert.deepEqual(manifest.workflowVersions, [{ id: 'workflow-1', version: 2 }]);
  assert.deepEqual(manifest.entityIds, { episodes: ['episode-1'], jobs: ['job-1', 'job-2'], workflows: ['workflow-1'] });
  assert.deepEqual(manifest.tableCounts, { entities: 4, history: 1, workflow_history: 1, workflow_reviews: 1, settings: 1 });
  assert.equal(manifest.mediaCount, 3);
  const copied = new DatabaseSync(path.join(f.target, 'studio.sqlite'), { readOnly: true });
  try {
    assert.equal(JSON.parse(copied.prepare("SELECT data FROM entities WHERE id='job-1'").get().data).status, 'running');
    assert.equal(copied.prepare("SELECT count(*) AS count FROM entities WHERE id='uncommitted'").get().count, 0);
    assert.equal(copied.prepare('SELECT value FROM settings').get().value, 'retained');
  } finally { copied.close(); }
  for (const media of manifest.media) {
    const relative = media.url.replace('/api/', '');
    const bytes = await readFile(path.join(f.target, relative));
    assert.equal(hash(bytes), media.sha256);
    assert.equal(bytes.length, media.bytes);
    assert.deepEqual(bytes, await readFile(path.join(f.source, relative)));
  }
  assert.equal(manifest.database.sha256, hash(await readFile(path.join(f.target, 'studio.sqlite'))));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.target, 'snapshot-manifest.json'), 'utf8')), manifest);
  assert.equal(await readFile(path.join(f.target, '.snapshot-complete'), 'utf8'), manifest.createdAt);
});

test('snapshot refuses source overlap, root escape, existing destinations and symlink ancestors', async t => {
  const f = await fixture(t);
  await assert.rejects(snapshotData({ ...f, target: f.source }), /child/);
  await assert.rejects(snapshotData({ ...f, snapshotRoot: f.root, target: path.join(f.source, 'nested') }), /overlap/);
  await assert.rejects(snapshotData({ ...f, target: path.join(f.root, 'outside') }), /child/);
  await mkdir(f.target);
  await assert.rejects(snapshotData(f), /must be new/);
  await writeFile(path.join(f.target, 'sentinel'), 'keep');
  await assert.rejects(snapshotData(f), /must be new/);
  assert.equal(await readFile(path.join(f.target, 'sentinel'), 'utf8'), 'keep');
  const link = path.join(f.snapshotRoot, 'escape');
  await symlink(f.source, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(snapshotData({ ...f, target: path.join(link, 'nested') }), /ancestors/);
  assert.deepEqual((await readdir(f.source)).sort(), ['exports', 'studio.sqlite', 'studio.sqlite-shm', 'studio.sqlite-wal', 'uploads']);
});

test('missing historical media leaves an incomplete snapshot without changing live state or producing a manifest', async t => {
  const f = await fixture(t);
  f.save('events', 'missing-media', { url: '/api/uploads/missing.wav' });
  const rows = f.db.prepare('SELECT * FROM entities').all();
  await assert.rejects(snapshotData(f), /ENOENT/);
  await assert.rejects(readFile(path.join(f.target, 'snapshot-manifest.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(f.target, '.snapshot-complete')), { code: 'ENOENT' });
  assert.deepEqual(f.db.prepare('SELECT * FROM entities').all(), rows);
  await assert.rejects(snapshotData(f), /must be new/);
});

test('recorded render and review hash mismatch prevents a complete migration', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'exports', 'render.mp4'), 'Changed since review');
  await assert.rejects(snapshotData(f), /hash differs/);
  await assert.rejects(readFile(path.join(f.target, 'snapshot-manifest.json')), { code: 'ENOENT' });
});

test('unsafe media references and linked source media directories are rejected', async t => {
  const f = await fixture(t);
  f.save('events', 'unsafe', { url: '/api/uploads/../outside.wav' });
  await assert.rejects(snapshotData(f), /unsafe media reference/);
  f.db.prepare("DELETE FROM entities WHERE id='unsafe'").run();
  const external = path.join(f.root, 'external');
  await mkdir(external);
  await writeFile(path.join(external, 'voice.wav'), 'Outside source');
  await rm(path.join(f.source, 'uploads'), { recursive: true });
  await symlink(external, path.join(f.source, 'uploads'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(snapshotData({ ...f, target: path.join(f.snapshotRoot, 'linked-media') }), /regular file|ENOENT/);
});

test('snapshot preserves node-review-only media and every node-review row without writing the live database', async t => {
  const f = await fixture(t);
  f.db.exec('CREATE TABLE workflow_node_reviews (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, review_node_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(run_id,review_node_id))');
  const media = [
    { url: '/api/exports/node-review.mp4', bytes: Buffer.from('Node review render retained only by its decision') },
    { url: '/api/uploads/node-review.wav', bytes: Buffer.from('Node review audio retained only by its decision') },
  ];
  const reviews = media.map((item, index) => ({ id: `node-review-${index}`, runId: 'run-1', reviewNodeId: `review-${index}`, decision: 'approved', evidence: [{ outputUrl: item.url, sha256: hash(item.bytes) }] }));
  for (let index = 0; index < reviews.length; index++) {
    const review = reviews[index];
    f.db.prepare('INSERT INTO workflow_node_reviews VALUES (?,?,?,?)').run(review.id, review.runId, review.reviewNodeId, JSON.stringify(review));
    await writeFile(path.join(f.source, media[index].url.replace('/api/', '')), media[index].bytes);
  }
  const rows = f.db.prepare('SELECT * FROM workflow_node_reviews ORDER BY id').all();
  const schema = f.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
  const sourceDatabase = await readFile(path.join(f.source, 'studio.sqlite'));
  const sourceWal = await readFile(path.join(f.source, 'studio.sqlite-wal'));
  const manifest = await snapshotData(f);
  assert.equal(manifest.tableCounts.workflow_node_reviews, reviews.length);
  assert.equal(manifest.mediaCount, 5);
  const copied = new DatabaseSync(path.join(f.target, 'studio.sqlite'), { readOnly: true });
  try { assert.deepEqual(copied.prepare('SELECT * FROM workflow_node_reviews ORDER BY id').all(), rows); }
  finally { copied.close(); }
  for (const item of media) {
    assert.deepEqual(manifest.media.find(entry => entry.url === item.url), { url: item.url, bytes: item.bytes.length, sha256: hash(item.bytes) });
    assert.deepEqual(await readFile(path.join(f.target, item.url.replace('/api/', ''))), item.bytes);
  }
  assert.deepEqual(f.db.prepare('SELECT * FROM workflow_node_reviews ORDER BY id').all(), rows);
  assert.deepEqual(f.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
  assert.deepEqual(await readFile(path.join(f.source, 'studio.sqlite')), sourceDatabase);
  assert.deepEqual(await readFile(path.join(f.source, 'studio.sqlite-wal')), sourceWal);
});

test('node-review-only missing media and changed review hashes cannot produce a complete snapshot', async t => {
  for (const failure of ['missing media', 'changed review hash']) {
    await t.test(failure, async t => {
      const f = await fixture(t);
      f.db.exec('CREATE TABLE workflow_node_reviews (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, review_node_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(run_id,review_node_id))');
      const expected = Buffer.from('The approved node render');
      const review = { id: 'node-review-1', runId: 'run-1', reviewNodeId: 'review-render', outputUrl: '/api/exports/node-review.mp4', sha256: hash(expected) };
      f.db.prepare('INSERT INTO workflow_node_reviews VALUES (?,?,?,?)').run(review.id, review.runId, review.reviewNodeId, JSON.stringify(review));
      if (failure === 'changed review hash') await writeFile(path.join(f.source, 'exports', 'node-review.mp4'), 'Different render after approval');
      const sourceDatabase = await readFile(path.join(f.source, 'studio.sqlite'));
      const sourceWal = await readFile(path.join(f.source, 'studio.sqlite-wal'));
      await assert.rejects(snapshotData(f), failure === 'missing media' ? /ENOENT/ : /hash differs/);
      await assert.rejects(readFile(path.join(f.target, 'snapshot-manifest.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(f.target, '.snapshot-complete')), { code: 'ENOENT' });
      assert.deepEqual(await readFile(path.join(f.source, 'studio.sqlite')), sourceDatabase);
      assert.deepEqual(await readFile(path.join(f.source, 'studio.sqlite-wal')), sourceWal);
      assert.deepEqual(JSON.parse(f.db.prepare('SELECT data FROM workflow_node_reviews').get().data), review);
    });
  }
});

test('snapshot accepts absent optional history and review tables without migrating the live schema', async t => {
  const f = await fixture(t);
  f.db.exec('DROP TABLE history; DROP TABLE workflow_history; DROP TABLE workflow_reviews; DROP TABLE settings;');
  const schema = f.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
  const sourceDatabase = await readFile(path.join(f.source, 'studio.sqlite'));
  const sourceWal = await readFile(path.join(f.source, 'studio.sqlite-wal'));
  const manifest = await snapshotData(f);
  assert.deepEqual(manifest.tableCounts, { entities: 4 });
  assert.deepEqual(manifest.media.map(entry => entry.url).sort(), ['/api/exports/render.mp4', '/api/uploads/voice.wav']);
  const copied = new DatabaseSync(path.join(f.target, 'studio.sqlite'), { readOnly: true });
  try { assert.deepEqual(copied.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema); }
  finally { copied.close(); }
  assert.deepEqual(f.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
  assert.deepEqual(await readFile(path.join(f.source, 'studio.sqlite')), sourceDatabase);
  assert.deepEqual(await readFile(path.join(f.source, 'studio.sqlite-wal')), sourceWal);
});

test('snapshot rejects a database without entities rather than migrating unsupported state', async t => {
  const f = await fixture(t);
  f.db.exec('DROP TABLE entities;');
  const schema = f.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
  const sourceDatabase = await readFile(path.join(f.source, 'studio.sqlite'));
  const sourceWal = await readFile(path.join(f.source, 'studio.sqlite-wal'));
  await assert.rejects(snapshotData(f), /no entities table/);
  await assert.rejects(readFile(path.join(f.target, 'snapshot-manifest.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(f.target, '.snapshot-complete')), { code: 'ENOENT' });
  assert.deepEqual(f.db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
  assert.deepEqual(await readFile(path.join(f.source, 'studio.sqlite')), sourceDatabase);
  assert.deepEqual(await readFile(path.join(f.source, 'studio.sqlite-wal')), sourceWal);
});
