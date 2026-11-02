import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

async function fixture(t, renderer) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-render-source-'));
  let app = createApp({ dataDir, loginToken: '', renderer });
  const start = async () => {
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${app.address().port}`;
  };
  const stop = () => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
  let base = await start();
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (url, method = 'GET', body) => fetch(base + url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const state = await (await request('/api/state')).json();
  const episode = await (await request('/api/episodes', 'POST', { channelId: state.channels[0].id, title: 'Render source fixture', topic: 'Isolated render test' })).json();
  return {
    dataDir, episode, request,
    async restart() { await stop(); app = createApp({ dataDir, loginToken: '', renderer }); base = await start(); },
  };
}

test('concurrent manual render submissions for one episode version reuse a single server job', async t => {
  let calls = 0;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (episode, { dataDir, onProgress }) => {
    calls++;
    signalStarted();
    onProgress?.(37);
    await blocked;
    const filename = `manual-${episode.id}.mp4`;
    await writeFile(path.join(dataDir, 'exports', filename), 'fixture render');
    return { filename, outputUrl: `/api/exports/${filename}` };
  });
  const url = `/api/episodes/${f.episode.id}/render`;
  const [a, b] = await Promise.all([f.request(url, 'POST', { expectedVersion: f.episode.version }), f.request(url, 'POST', { expectedVersion: f.episode.version })]);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  const first = await a.json(), second = await b.json();
  assert.equal(first.id, second.id);
  assert.equal(first.source, 'manual');
  await started;
  const current = (await (await f.request('/api/state')).json()).jobs.find(job => job.id === first.id);
  assert.equal(current.source, 'manual');
  assert.equal(current.status, 'running');
  assert.equal(current.progress, 37);
  assert.equal(calls, 1, 'only one renderer may run for this episode version');
  release();
  for (let i = 0; i < 100; i++) {
    const job = (await (await f.request('/api/state')).json()).jobs.find(item => item.id === first.id);
    if (job.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const completed = (await (await f.request('/api/state')).json()).jobs.find(job => job.id === first.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.source, 'manual');
});

test('legacy and workflow jobs retain explicit or unknown origin and block same-version duplicate renders', async t => {
  const f = await fixture(t, async () => { assert.fail('duplicate submission must not invoke the renderer'); });
  const db = new DatabaseSync(path.join(f.dataDir, 'studio.sqlite'));
  const insertJob = db.prepare('INSERT INTO entities(kind,id,data) VALUES(?,?,?)');
  const legacy = { id: 'legacy-render-job', episodeId: f.episode.id, episodeVersion: f.episode.version, status: 'running', progress: 22, createdAt: new Date().toISOString() };
  const workflow = { id: 'workflow-render-job', episodeId: f.episode.id, episodeVersion: f.episode.version, source: 'workflow', status: 'running', progress: 41, createdAt: new Date().toISOString() };
  insertJob.run('jobs', legacy.id, JSON.stringify(legacy));
  insertJob.run('jobs', workflow.id, JSON.stringify(workflow));
  db.close();
  const state = await (await f.request('/api/state')).json();
  const oldRecord = state.jobs.find(job => job.id === legacy.id);
  const workflowRecord = state.jobs.find(job => job.id === workflow.id);
  assert.equal(Object.hasOwn(oldRecord, 'source'), false, 'historical source-less jobs are not backfilled or guessed');
  assert.equal(workflowRecord.source, 'workflow');
  const response = await f.request(`/api/episodes/${f.episode.id}/render`, 'POST', { expectedVersion: f.episode.version });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /already recorded as active/i);
  assert.equal((await (await f.request('/api/state')).json()).jobs.length, 2, 'no third duplicate job is persisted');
});

test('server restart fails queued and running render jobs independently without assigning legacy origin', async t => {
  const f = await fixture(t, async () => { assert.fail('interrupted jobs must not resume automatically'); });
  const db = new DatabaseSync(path.join(f.dataDir, 'studio.sqlite'));
  const queued = { id: 'interrupted-queued-job', episodeId: f.episode.id, episodeVersion: f.episode.version, status: 'queued', progress: 0, createdAt: new Date().toISOString() };
  const running = { id: 'interrupted-running-job', episodeId: f.episode.id, episodeVersion: f.episode.version, source: 'workflow', status: 'running', progress: 53, createdAt: new Date().toISOString() };
  const insert = db.prepare('INSERT INTO entities(kind,id,data) VALUES(?,?,?)');
  insert.run('jobs', queued.id, JSON.stringify(queued));
  insert.run('jobs', running.id, JSON.stringify(running));
  db.close();
  await f.restart();
  const jobs = (await (await f.request('/api/state')).json()).jobs;
  const recoveredQueued = jobs.find(item => item.id === queued.id);
  const recoveredRunning = jobs.find(item => item.id === running.id);
  for (const recovered of [recoveredQueued, recoveredRunning]) {
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.error, /Server restarted before render completed/);
  }
  assert.equal(Object.hasOwn(recoveredQueued, 'source'), false, 'queued legacy provenance remains unknown');
  assert.equal(recoveredRunning.source, 'workflow', 'explicit workflow provenance survives recovery');
});
