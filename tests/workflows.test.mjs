import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';
import { defaultWorkflow, validateWorkflow } from '../server/workflows.mjs';

const baseIntegrations = {
  integrationStatus: async () => ({ studio: { available: true } }),
  fetchTrends: async () => ({ trends: [{ keyword: '검증 소재', source: 'Fixture RSS', url: 'https://example.com/trend' }], sources: [{ name: 'Fixture RSS', status: 'ok' }] }),
  runAgent: async () => { throw new Error('No provider configured'); },
};

async function setup(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-workflow-'));
  let renderCount = 0;
  const renderer = async (episode, { dataDir }) => {
    renderCount++;
    const filename = `workflow-fixture-${renderCount}.mp4`;
    await writeFile(path.join(dataDir, 'exports', filename), 'fixture only');
    return { filename, outputUrl: `/api/exports/${filename}` };
  };
  let server, base;
  const start = async () => { server = createApp({ dataDir, integrations: baseIntegrations, renderer, ...overrides }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; };
  const stop = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await start();
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (url, method = 'GET', body) => fetch(base + url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const state = await (await request('/api/state')).json();
  const episode = await (await request('/api/episodes', 'POST', { channelId: state.channels[0].id, title: 'DAG 제작', topic: '출처 검토' })).json();
  return { request, episode, workflow: state.workflows[0], renderCount: () => renderCount, restart: async () => { await stop(); await start(); } };
}

async function waitRun(fixture, id, statuses = ['awaiting_review', 'failed', 'cancelled']) {
  for (let i = 0; i < 100; i++) {
    const runs = await (await fixture.request(`/api/workflows/${fixture.workflow.id}/runs`)).json();
    const run = runs.find((item) => item.id === id);
    if (statuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Workflow did not reach expected state');
}

test('typed DAG validator rejects cycles, unknown/disconnected nodes, invalid ports and missing agent config', () => {
  const valid = defaultWorkflow();
  assert.equal(validateWorkflow(valid).nodes.length, 6);
  const minimal = { ...valid, nodes: valid.nodes.slice(2), edges: valid.edges.slice(2) };
  assert.equal(validateWorkflow(minimal).nodes.length, 4);
  const invalid = [
    { ...valid, edges: [...valid.edges, { id: 'cycle', source: 'review', target: 'script' }] },
    { ...valid, edges: valid.edges.map((edge, index) => index === 0 ? { ...edge, source: 'missing' } : edge) },
    { ...valid, edges: valid.edges.slice(1) },
    { ...valid, nodes: valid.nodes.map((node) => node.type === 'script' ? { ...node, config: {} } : node) },
    { ...valid, nodes: valid.nodes.map((node) => node.type === 'trend' ? { ...node, config: { command: 'rm' } } : node) },
    { ...valid, nodes: valid.nodes.map((node) => node.type === 'trend' ? { ...node, type: 'shell' } : node) },
    { ...valid, edges: valid.edges.map((edge, index) => index === 0 ? { ...edge, sourcePort: 'shell' } : edge) },
    { ...valid, nodes: valid.nodes.map((node, index) => index === 0 ? { ...node, x: Infinity } : node) },
  ];
  for (const graph of invalid) assert.throws(() => validateWorkflow(graph), { status: 400 });
});

test('workflow CRUD persists versioned snapshots and rejects stale edits', async (t) => {
  const f = await setup(t);
  const created = await (await f.request('/api/workflows', 'POST', { ...defaultWorkflow(), name: '사용자 워크플로우' })).json();
  assert.equal(created.version, 1);
  const edit = await f.request(`/api/workflows/${created.id}`, 'PUT', { ...created, name: '수정한 DAG', expectedVersion: 1 });
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).version, 2);
  assert.equal((await f.request(`/api/workflows/${created.id}`, 'PUT', { ...created, expectedVersion: 1 })).status, 409);
  const history = await (await f.request(`/api/workflows/${created.id}/history`)).json();
  assert.equal(history.length, 2);
  assert.equal(history[1].snapshot.name, '사용자 워크플로우');
  await f.restart();
  const workflows = await (await f.request('/api/workflows')).json();
  assert.equal(workflows.find((item) => item.id === created.id).name, '수정한 DAG');
});

test('DAG executes trend, research, storyboard mutation and shared render queue then awaits human review', async (t) => {
  const f = await setup(t);
  await f.request('/api/references', 'POST', { title: '근거 자료', category: 'information', url: 'https://example.com/reference', channelId: f.episode.channelId, notes: '검증된 테스트 참고 자료' });
  const started = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id });
  assert.equal(started.status, 202);
  const initial = await started.json();
  const run = await waitRun(f, initial.id);
  assert.equal(run.status, 'awaiting_review');
  assert.deepEqual(run.nodeRuns.map((node) => node.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'awaiting_review']);
  assert.equal(run.nodeRuns.find((node) => node.type === 'research').output.references.length, 1);
  assert.equal(run.nodeRuns.find((node) => node.type === 'script').output.mode, 'deterministic');
  assert.equal(run.nodeRuns.find((node) => node.type === 'storyboard').output.version, 2);
  assert.equal(f.renderCount(), 1);
  const render = run.nodeRuns.find((node) => node.type === 'render').output;
  assert.ok(render.jobId);
  assert.equal((await f.request(render.outputUrl)).status, 200);
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.jobs[0].status, 'completed');
  assert.equal(state.episodes[0].version, 2);
  assert.equal(state.trends.length, 1);
  assert.ok(!state.events.some((event) => /publish/.test(event.type)));
  await f.restart();
  assert.equal((await waitRun(f, initial.id)).status, 'awaiting_review');
});

test('provider failure stops descendants and never renders fabricated output', async (t) => {
  const f = await setup(t);
  const nodes = f.workflow.nodes.map((node) => node.type === 'script' ? { ...node, config: { agent: 'codex', prompt: 'Create scenes' } } : node);
  await f.request(`/api/workflows/${f.workflow.id}`, 'PUT', { ...f.workflow, nodes, expectedVersion: 1 });
  const started = await (await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id })).json();
  const failed = await waitRun(f, started.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.nodeRuns.find((node) => node.type === 'script').status, 'failed');
  assert.equal(failed.nodeRuns.find((node) => node.type === 'render').status, 'skipped');
  assert.equal(f.renderCount(), 0);
  assert.equal((await (await f.request(`/api/episodes/${f.episode.id}/history`)).json()).length, 1);
});

test('workflow cancellation during provider call prevents later episode mutations and rendering', async (t) => {
  let release, announce;
  const pending = new Promise((resolve) => { release = resolve; });
  const called = new Promise((resolve) => { announce = resolve; });
  const f = await setup(t, { integrations: { ...baseIntegrations, runAgent: async () => { announce(); return pending; } } });
  const nodes = f.workflow.nodes.map((node) => node.type === 'script' ? { ...node, config: { agent: 'codex' } } : node);
  await f.request(`/api/workflows/${f.workflow.id}`, 'PUT', { ...f.workflow, nodes });
  const initial = await (await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id })).json();
  await called;
  assert.equal((await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id })).status, 409);
  const cancelled = await f.request(`/api/workflows/${f.workflow.id}/runs/${initial.id}/cancel`, 'POST', {});
  assert.equal(cancelled.status, 200);
  release({ message: 'Late result', scenes: f.episode.scenes });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await waitRun(f, initial.id)).status, 'cancelled');
  assert.equal(f.renderCount(), 0);
  assert.equal((await (await f.request(`/api/episodes/${f.episode.id}/history`)).json()).length, 1);
});

test('restart fails interrupted runs and late responses cannot write into a closed database', async (t) => {
  let release, announce;
  const pending = new Promise((resolve) => { release = resolve; });
  const called = new Promise((resolve) => { announce = resolve; });
  const f = await setup(t, { integrations: { ...baseIntegrations, runAgent: async () => { announce(); return pending; } } });
  const nodes = f.workflow.nodes.map((node) => node.type === 'script' ? { ...node, config: { agent: 'codex' } } : node);
  await f.request(`/api/workflows/${f.workflow.id}`, 'PUT', { ...f.workflow, nodes });
  const initial = await (await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id })).json();
  await called;
  await f.restart();
  release({ message: 'Interrupted response', scenes: f.episode.scenes });
  const failed = await waitRun(f, initial.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /restarted/);
  assert.equal(f.renderCount(), 0);
});
