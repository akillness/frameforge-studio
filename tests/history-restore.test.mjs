import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';

async function setup(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-restore-'));
  const server = createApp({ dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (url, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const state = await (await request('/api/state')).json();
  const createEpisode = async (title) => (await request('/api/episodes', 'POST', { channelId: state.channels[0].id, title, topic: 'history fixture' })).json();
  return { request, dataDir, createEpisode, workflow: state.workflows[0] };
}

test('episode restore appends a draft version and preserves identity and immutable snapshots', async (t) => {
  const f = await setup(t);
  const original = await f.createEpisode('Original title');
  const url = `/api/episodes/${original.id}`;
  await f.request(url, 'PUT', { title: 'Ready title', status: 'ready', notes: 'new notes', expectedVersion: 1 });
  const before = await (await f.request(`${url}/history`)).json();
  const restoredResponse = await f.request(`${url}/restore`, 'POST', { version: 1, expectedVersion: 2, title: 'injected', id: 'replacement', channelId: 'replacement' });
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json();
  assert.equal(restored.version, 3);
  assert.equal(restored.title, original.title);
  assert.equal(restored.status, 'draft');
  assert.equal(restored.id, original.id);
  assert.equal(restored.channelId, original.channelId);
  assert.equal(restored.createdAt, original.createdAt);
  assert.deepEqual(restored.scenes.map((scene) => scene.id), original.scenes.map((scene) => scene.id));
  const history = await (await f.request(`${url}/history`)).json();
  assert.deepEqual(history.slice(1), before);
  assert.equal(history[0].reason, 'restore:v1');
  const restoreReady = await (await f.request(`${url}/restore`, 'POST', { version: 2, expectedVersion: 3 })).json();
  assert.equal(restoreReady.title, 'Ready title');
  assert.equal(restoreReady.status, 'draft');
});

test('restore requires version checks and rejects stale, missing and cross-entity versions without writes', async (t) => {
  const f = await setup(t);
  const first = await f.createEpisode('First');
  const second = await f.createEpisode('Second');
  await f.request(`/api/episodes/${first.id}`, 'PUT', { title: 'First edited', expectedVersion: 1 });
  const episodeUrl = `/api/episodes/${second.id}`;
  const workflowUrl = `/api/workflows/${f.workflow.id}`;
  for (const url of [episodeUrl, workflowUrl]) {
    const before = await (await f.request(`${url}/history`)).json();
    for (const body of [{ version: 1 }, { expectedVersion: 1 }, { version: 0, expectedVersion: 1 }, { version: 1, expectedVersion: '1' }, { version: 1.5, expectedVersion: 1 }]) {
      assert.equal((await f.request(`${url}/restore`, 'POST', body)).status, 400);
    }
    assert.equal((await f.request(`${url}/restore`, 'POST', { version: 2, expectedVersion: 1 })).status, 404);
    assert.equal((await f.request(`${url}/restore`, 'POST', { version: 1, expectedVersion: 20 })).status, 409);
    assert.deepEqual(await (await f.request(`${url}/history`)).json(), before);
  }
  assert.equal((await f.request('/api/episodes/unknown/restore', 'POST', { version: 1, expectedVersion: 1 })).status, 404);
  const restored = await (await f.request(`${episodeUrl}/restore`, 'POST', { version: 1, expectedVersion: 1, episodeId: first.id })).json();
  assert.equal(restored.title, 'Second');
});

test('workflow restore appends a validated version without modifying run or review records', async (t) => {
  const f = await setup(t);
  const url = `/api/workflows/${f.workflow.id}`;
  const edited = await f.request(url, 'PUT', { ...f.workflow, name: 'Edited workflow', expectedVersion: 1 });
  assert.equal(edited.status, 200);
  const before = await (await f.request(`${url}/history`)).json();
  const db = new DatabaseSync(path.join(f.dataDir, 'studio.sqlite'));
  db.prepare('INSERT INTO workflow_reviews(id,run_id,data) VALUES (?,?,?)').run('review-fixture', 'run-fixture', '{"decision":"approved"}');
  db.prepare('INSERT INTO entities(kind,id,data) VALUES (?,?,?)').run('workflowRuns', 'run-fixture', JSON.stringify({ id: 'run-fixture', workflowId: f.workflow.id, status: 'approved', workflowVersion: 2 }));
  db.close();
  const runsBefore = await (await f.request(`${url}/runs`)).json();
  const restored = await (await f.request(`${url}/restore`, 'POST', { version: 1, expectedVersion: 2 })).json();
  assert.equal(restored.version, 3);
  assert.equal(restored.name, f.workflow.name);
  assert.equal(restored.id, f.workflow.id);
  assert.equal(restored.createdAt, f.workflow.createdAt);
  const history = await (await f.request(`${url}/history`)).json();
  assert.equal(history[0].reason, 'restore:v1');
  assert.deepEqual(history.slice(1), before);
  assert.deepEqual(await (await f.request(`${url}/runs`)).json(), runsBefore);
  const verifyDb = new DatabaseSync(path.join(f.dataDir, 'studio.sqlite'));
  assert.equal(verifyDb.prepare('SELECT data FROM workflow_reviews WHERE id=?').get('review-fixture').data, '{"decision":"approved"}');
  verifyDb.close();
});

test('restore revalidates historical scene assets and DAGs before saving', async (t) => {
  const f = await setup(t);
  const episode = await f.createEpisode('Asset validation');
  const db = new DatabaseSync(path.join(f.dataDir, 'studio.sqlite'));
  const episodeEntry = JSON.parse(db.prepare('SELECT data FROM history WHERE episode_id=?').get(episode.id).data);
  episodeEntry.snapshot.scenes[0].kind = 'image';
  episodeEntry.snapshot.scenes[0].assetUrl = '/api/uploads/00000000-0000-0000-0000-000000000001.png';
  db.prepare('UPDATE history SET data=? WHERE episode_id=?').run(JSON.stringify(episodeEntry), episode.id);
  const workflowEntry = JSON.parse(db.prepare('SELECT data FROM workflow_history WHERE workflow_id=?').get(f.workflow.id).data);
  workflowEntry.snapshot.edges = [];
  db.prepare('UPDATE workflow_history SET data=? WHERE workflow_id=?').run(JSON.stringify(workflowEntry), f.workflow.id);
  db.close();
  assert.equal((await f.request(`/api/episodes/${episode.id}/restore`, 'POST', { version: 1, expectedVersion: 1 })).status, 400);
  assert.equal((await f.request(`/api/workflows/${f.workflow.id}/restore`, 'POST', { version: 1, expectedVersion: 1 })).status, 400);
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.episodes.find((item) => item.id === episode.id).version, 1);
  assert.equal(state.workflows.find((item) => item.id === f.workflow.id).version, 1);
});
