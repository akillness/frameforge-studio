import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';

const integrations = {
  integrationStatus: async () => ({ studio: { available: true } }),
  runAgent: async () => { throw Object.assign(new Error('no bridge'), { code: 'UNAVAILABLE' }); },
  fetchTrends: async () => ({ trends: [], sources: [] }),
};

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-run-history-scope-'));
  const store = new Store(dataDir);
  const channelA = store.create('channels', { name: 'Channel A', platform: 'YouTube' });
  const channelB = store.create('channels', { name: 'Channel B', platform: 'YouTube' });
  const episodeA = store.create('episodes', { channelId: channelA.id, title: 'Project A', topic: 'Topic A', version: 1, status: 'draft' });
  const episodeA2 = store.create('episodes', { channelId: channelA.id, title: 'Project A2', topic: 'Topic A2', version: 1, status: 'draft' });
  const episodeB = store.create('episodes', { channelId: channelB.id, title: 'Project B', topic: 'Topic B', version: 1, status: 'draft' });
  const createdAt = (minute) => `2026-11-03T00:${String(minute).padStart(2, '0')}:00.000Z`;
  const run = (id, episode, minute, nodeRuns = []) => store.create('workflowRuns', {
    id, workflowId: `workflow-${id}`, workflowVersion: 1, workflowSnapshot: { name: `Workflow ${id}`, nodes: [] },
    episodeId: episode.id, episodeVersion: 1, episodeSnapshot: { title: episode.title }, status: 'completed',
    createdAt: createdAt(minute), updatedAt: createdAt(minute), selectedStages: [], nodeRuns,
  });
  const oldRun = run('run-a-old', episodeA, 1);
  const latestRun = run('run-a-new', episodeA, 2, [{
    nodeId: 'render', type: 'render', status: 'completed',
    output: { outputUrl: '/api/uploads/preview.mp4', summary: 'kept result' },
    logs: 'render completed locally',
  }]);
  const siblingRun = run('run-a2', episodeA2, 3);
  const otherProjectRun = run('run-b', episodeB, 4);
  store.close();
  await mkdir(join(dataDir, 'uploads'), { recursive: true });
  await writeFile(join(dataDir, 'uploads', 'preview.mp4'), Buffer.from('local-preview-fixture'));

  let server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations });
  const start = () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
  let base = await start();
  const close = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    channelA, channelB, episodeA, episodeA2, episodeB, oldRun, latestRun, siblingRun, otherProjectRun,
    request: (path) => fetch(base + path),
  };
}

const list = async (f, query = '') => f.request(`/api/workflow-runs${query}`).then(async (response) => ({ response, body: await response.json() }));

test('workflow run history filters by episode/channel and preserves the legacy unfiltered response', async (t) => {
  const f = await fixture(t);
  const all = await list(f);
  assert.equal(all.response.status, 200);
  assert.deepEqual(new Set(all.body.items.map((item) => item.id)), new Set([f.oldRun.id, f.latestRun.id, f.siblingRun.id, f.otherProjectRun.id]));
  assert.equal(all.body.total, 4);

  const project = await list(f, `?episodeId=${f.episodeA.id}`);
  assert.equal(project.response.status, 200);
  assert.deepEqual(project.body.items.map((item) => item.episodeId), [f.episodeA.id, f.episodeA.id]);
  assert.equal(project.body.total, 2);

  const channel = await list(f, `?channelId=${f.channelA.id}`);
  assert.equal(channel.response.status, 200);
  assert.deepEqual(new Set(channel.body.items.map((item) => item.episodeId)), new Set([f.episodeA.id, f.episodeA2.id]));
  assert.equal(channel.body.total, 3);

  const narrowed = await list(f, `?channelId=${f.channelA.id}&episodeId=${f.episodeA.id}`);
  assert.equal(narrowed.body.total, 2);
  assert.ok(narrowed.body.items.every((item) => item.episodeId === f.episodeA.id));
  const searched = await list(f, `?episodeId=${f.episodeA.id}&q=run-a-new`);
  assert.deepEqual(searched.body.items.map((item) => item.id), [f.latestRun.id], 'the existing q search composes with the new scope filters');

  const empty = await list(f, '?channelId=&episodeId=');
  assert.equal(empty.response.status, 200);
  assert.equal(empty.body.total, 4, 'empty filter values are identical to omitting those filters');
  assert.equal((await list(f, `?channelId=missing-${f.channelA.id}`)).response.status, 404);
  assert.equal((await list(f, `?episodeId=missing-${f.episodeA.id}`)).response.status, 404);
  assert.equal((await list(f, `?channelId=${f.channelA.id}&episodeId=${f.episodeB.id}`)).response.status, 404, 'cross-channel context is hidden as not found');
});

test('workflow history pagination totals and ordering are computed after filtering', async (t) => {
  const f = await fixture(t);
  const first = await list(f, `?episodeId=${f.episodeA.id}&page=1&limit=1`);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.total, 2);
  assert.equal(first.body.page, 1);
  assert.equal(first.body.pageSize, 1);
  assert.equal(first.body.pageCount, 2);
  assert.deepEqual(first.body.items.map((item) => item.id), [f.latestRun.id]);

  const second = await list(f, `?episodeId=${f.episodeA.id}&page=2&limit=1`);
  assert.equal(second.body.total, 2);
  assert.equal(second.body.pageCount, 2);
  assert.deepEqual(second.body.items.map((item) => item.id), [f.oldRun.id]);
});

test('run detail checks optional project/channel context while preserving full node results and local media URLs', async (t) => {
  const f = await fixture(t);
  const legacy = await f.request(`/api/workflow-runs/${f.latestRun.id}`);
  assert.equal(legacy.status, 200, 'existing unscoped detail callers remain compatible');
  const detail = await f.request(`/api/workflow-runs/${f.latestRun.id}?episodeId=${f.episodeA.id}&channelId=${f.channelA.id}`);
  assert.equal(detail.status, 200);
  const run = await detail.json();
  assert.deepEqual(run.nodeRuns[0].output, { outputUrl: '/api/uploads/preview.mp4', summary: 'kept result' });
  assert.equal(run.nodeRuns[0].logs, 'render completed locally');
  const media = await f.request(run.nodeRuns[0].output.outputUrl);
  assert.equal(media.status, 200, 'the existing authenticated local upload route remains usable for previews');
  assert.equal(await media.text(), 'local-preview-fixture');

  assert.equal((await f.request(`/api/workflow-runs/${f.latestRun.id}?episodeId=${f.episodeB.id}`)).status, 404);
  assert.equal((await f.request(`/api/workflow-runs/${f.latestRun.id}?channelId=${f.channelB.id}`)).status, 404);
  assert.equal((await f.request(`/api/workflow-runs/${f.latestRun.id}?channelId=${f.channelA.id}&episodeId=${f.episodeB.id}`)).status, 404);
  assert.equal((await f.request(`/api/workflow-runs/${f.latestRun.id}?episodeId=`)).status, 200, 'empty context is equivalent to legacy unscoped detail');
});

test('compact run history reports output presence and provenance without embedding result payloads', async (t) => {
  const f = await fixture(t);
  const { response, body } = await list(f, `?episodeId=${f.episodeA.id}`);
  assert.equal(response.status, 200);
  const run = body.items.find((item) => item.id === f.latestRun.id);
  assert.deepEqual(run.nodeRuns, [{ nodeId: 'render', type: 'render', status: 'completed', hasOutput: true }]);
  assert.equal(JSON.stringify(run).includes('render completed locally'), false);
  assert.equal(JSON.stringify(run).includes('/api/uploads/preview.mp4'), false);
});
