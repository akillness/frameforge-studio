import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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
  const renderer = async (episode, { dataDir, sceneIntegrity }) => {
    renderCount++;
    const filename = `workflow-fixture-${renderCount}.mp4`;
    await writeFile(path.join(dataDir, 'exports', filename), 'fixture only');
    return { filename, outputUrl: `/api/exports/${filename}`, ...(sceneIntegrity ? { verifiedSceneAssets: sceneIntegrity } : {}) };
  };
  let server, base;
  const start = async () => { server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations: baseIntegrations, renderer, ...overrides }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; };
  const stop = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await start();
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (url, method = 'GET', body) => fetch(base + url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const state = await (await request('/api/state')).json();
  const episode = await (await request('/api/episodes', 'POST', { channelId: state.channels[0].id, title: 'DAG 제작', topic: '출처 검토' })).json();
  return { request, episode, workflow: await createOwnedWorkflow({ request, episode }, state.workflows[0]), dataDir, renderCount: () => renderCount, restart: async () => { await stop(); await start(); } };
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

function partialWorkflow() {
  const workflow = defaultWorkflow();
  workflow.nodes = workflow.nodes.filter((node) => !['trend', 'research'].includes(node.type));
  workflow.edges = [
    { id: 'edge-script-storyboard', source: 'script', target: 'storyboard' },
    { id: 'edge-storyboard-render', source: 'storyboard', target: 'render' },
    { id: 'edge-render-review', source: 'render', target: 'review' },
  ];
  return workflow;
}

function generationWorkflow() {
  const workflow = partialWorkflow();
  workflow.nodes = workflow.nodes.map(node => node.type === 'script' ? { ...node, config: { agent: 'existing' } } : node);
  workflow.nodes.push({ id: 'generate', type: 'generate', x: 600, y: 180, config: { model: 'fixture', prompt: 'Fixture visual', params: {}, sceneIndex: 0 } });
  workflow.edges = [
    { id: 'edge-script-storyboard', source: 'script', target: 'storyboard' },
    { id: 'edge-storyboard-generate', source: 'storyboard', target: 'generate' },
    { id: 'edge-generate-render', source: 'generate', target: 'render' },
    { id: 'edge-render-review', source: 'render', target: 'review' },
  ];
  return workflow;
}


test('typed DAG validator accepts a partial workflow that omits fixed trend and research stages', () => {
  const normalized = validateWorkflow(partialWorkflow());
  assert.deepEqual(normalized.nodes.map((node) => node.type), ['script', 'storyboard', 'render', 'review']);
  assert.deepEqual(normalized.edges.map(({ source, target }) => `${source}->${target}`), ['script->storyboard', 'storyboard->render', 'render->review']);
});

test('selected stage execution skips omitted stages while preserving the selected DAG order', async (t) => {
  const f = await setup(t);
  const started = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: ['script', 'storyboard', 'render', 'review'], startStage: 'script' });
  assert.equal(started.status, 202);
  const run = await waitRun(f, (await started.json()).id);
  assert.equal(run.status, 'awaiting_review');
  assert.equal(run.nodeRuns.find((node) => node.type === 'trend').status, 'skipped');
  assert.equal(run.nodeRuns.find((node) => node.type === 'research').status, 'skipped');
  assert.deepEqual(run.nodeRuns.filter((node) => ['script', 'storyboard', 'render', 'review'].includes(node.type)).map((node) => node.status), ['completed', 'completed', 'completed', 'awaiting_review']);
});

test('selected start stage rejects a missing prerequisite instead of executing a partial DAG with undefined inputs', async (t) => {
  const f = await setup(t);
  const response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: ['storyboard', 'render', 'review'], startStage: 'storyboard' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /prerequisite|resume/i);
});

test('storyboard-only workflow rejects a selected storyboard without a script prerequisite', async (t) => {
  const f = await setup(t);
  const workflow = {
    ...defaultWorkflow(),
    name: 'Storyboard-only workflow',
    nodes: defaultWorkflow().nodes.filter((node) => ['storyboard', 'render', 'review'].includes(node.type)),
    edges: [
      { id: 'edge-storyboard-render', source: 'storyboard', target: 'render' },
      { id: 'edge-render-review', source: 'render', target: 'review' },
    ],
  };
  const created = await createOwnedWorkflow(f, await (await f.request('/api/workflows', 'POST', workflow)).json());
  const response = await f.request(`/api/workflows/${created.id}/run`, 'POST', {
    episodeId: f.episode.id,
    selectedStages: ['storyboard'],
    startStage: 'storyboard',
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /prerequisite|resume|script/i);
  assert.deepEqual(await (await f.request(`/api/workflows/${created.id}/runs`)).json(), []);
});

test('resumeRunId reruns selected downstream stages with reused prerequisites and accepts the new render candidate', async (t) => {
  const f = await setup(t);
  const firstResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: ['script', 'storyboard', 'render', 'review'], startStage: 'script' });
  const first = await waitRun(f, (await firstResponse.json()).id);
  const firstScript = first.nodeRuns.find((node) => node.type === 'script');
  const firstStoryboard = first.nodeRuns.find((node) => node.type === 'storyboard');
  const firstRender = first.nodeRuns.find((node) => node.type === 'render');
  const secondResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: ['storyboard', 'render', 'review'], startStage: 'storyboard', resumeRunId: first.id });
  assert.equal(secondResponse.status, 202);
  const second = await waitRun(f, (await secondResponse.json()).id);
  const secondTrend = second.nodeRuns.find((node) => node.type === 'trend');
  const secondResearch = second.nodeRuns.find((node) => node.type === 'research');
  const secondScript = second.nodeRuns.find((node) => node.type === 'script');
  const secondStoryboard = second.nodeRuns.find((node) => node.type === 'storyboard');
  const secondRender = second.nodeRuns.find((node) => node.type === 'render');
  const secondReview = second.nodeRuns.find((node) => node.type === 'review');
  assert.equal(second.status, 'awaiting_review');
  assert.equal(f.renderCount(), 2);
  assert.equal(secondTrend.status, 'skipped');
  assert.equal(secondResearch.status, 'skipped');
  assert.equal(secondScript.status, 'completed');
  assert.equal(secondScript.reused, true);
  assert.deepEqual(secondScript.output, firstScript.output);
  assert.equal(secondStoryboard.status, 'completed');
  assert.equal(secondStoryboard.output.version, firstStoryboard.output.version + 1);
  assert.equal(secondRender.status, 'completed');
  assert.notDeepEqual(secondRender.output, firstRender.output);
  assert.equal(secondReview.status, 'awaiting_review');
  assert.deepEqual(secondReview.output.render, secondRender.output);
  const reviewResponse = await f.request(`/api/workflows/${f.workflow.id}/runs/${second.id}/review`, 'POST', { reviewNodeId: secondReview.nodeId, decision: 'approved', notes: 'Approve the second render candidate.', expectedEpisodeVersion: second.episodeVersion });
  assert.equal(reviewResponse.status, 200);
  const reviewed = await reviewResponse.json();
  assert.equal(reviewed.status, 'approved');
  assert.equal(reviewed.review, undefined, 'the legacy singular run.review alias must never reappear on the new per-node review contract');
  assert.equal(reviewed.reviews[secondReview.nodeId].jobId, secondRender.output.jobId);
  assert.equal(reviewed.reviews[secondReview.nodeId].outputUrl, secondRender.output.outputUrl);
});

test('script-only resume skips all omitted descendants and completes without a review candidate', async (t) => {
  const f = await setup(t);
  const firstResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: ['script', 'storyboard', 'render', 'review'], startStage: 'script' });
  const first = await waitRun(f, (await firstResponse.json()).id);
  const secondResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: ['script'], startStage: 'script', resumeRunId: first.id });
  assert.equal(secondResponse.status, 202);
  const second = await waitRun(f, (await secondResponse.json()).id, ['completed', 'failed', 'cancelled']);
  assert.equal(second.status, 'completed');
  assert.equal(f.renderCount(), 1);
  for (const type of ['trend', 'research', 'storyboard', 'render', 'review']) {
    const node = second.nodeRuns.find((item) => item.type === type);
    assert.equal(node.status, 'skipped', `${type} should remain skipped`);
  }
  assert.equal(second.nodeRuns.find((node) => node.type === 'review').output, undefined);
});

test('resuming a generation workflow reuses the completed generation output without another provider request', async (t) => {
  let createCalls = 0;
  const generation = {
    transport: 'api',
    capability: async () => ({ available: true }),
    models: async () => [],
    modelSchema: async () => ({ type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    create: async () => { createCalls++; return { requestId: 'fixture-provider', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] }; },
    status: async () => { throw new Error('unexpected poll'); },
  };
  const f = await setup(t, { generation, generationOptions: { pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, 'fixture bytes'); return { bytes: 13, contentType: 'image/png' }; }, probe: async () => ({ kind: 'image', width: 64, height: 64 }) } });
  const workflow = await createOwnedWorkflow(f, await (await f.request('/api/workflows', 'POST', generationWorkflow())).json());
  const fixture = { ...f, workflow };
  const firstResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['script', 'storyboard', 'generate', 'render', 'review'], startStage: 'script' });
  assert.equal(firstResponse.status, 202);
  const first = await waitRun(fixture, (await firstResponse.json()).id);
  assert.equal(first.status, 'awaiting_review');
  assert.equal(createCalls, 1);
  const firstOutput = first.nodeRuns.find((node) => node.type === 'generate').output;
  const firstRender = first.nodeRuns.find((node) => node.type === 'render');
  const secondResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['generate', 'render', 'review'], startStage: 'generate', resumeRunId: first.id });
  assert.equal(secondResponse.status, 202);
  const second = await waitRun(fixture, (await secondResponse.json()).id);
  assert.equal(second.status, 'awaiting_review');
  assert.equal(createCalls, 1);
  assert.equal(f.renderCount(), 2);
  const secondGenerate = second.nodeRuns.find((node) => node.type === 'generate');
  const secondRender = second.nodeRuns.find((node) => node.type === 'render');
  const secondReview = second.nodeRuns.find((node) => node.type === 'review');
  assert.equal(secondGenerate.status, 'completed');
  assert.equal(secondGenerate.reused, true);
  assert.deepEqual(secondGenerate.output, firstOutput);
  assert.equal(secondRender.status, 'completed');
  assert.notDeepEqual(secondRender.output, firstRender.output);
  assert.equal(secondReview.status, 'awaiting_review');
  assert.deepEqual(secondReview.output.render, secondRender.output);
});

test('completed generation resume with missing generationJobId rejects before another provider request', async (t) => {
  let createCalls = 0;
  const generation = {
    transport: 'api',
    capability: async () => ({ available: true }),
    models: async () => [],
    modelSchema: async () => ({ type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    create: async () => { createCalls++; return { requestId: 'fixture-provider', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] }; },
    status: async () => { throw new Error('unexpected poll'); },
  };
  const f = await setup(t, { generation, generationOptions: { pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, 'fixture bytes'); return { bytes: 13, contentType: 'image/png' }; }, probe: async () => ({ kind: 'image', width: 64, height: 64 }) } });
  const workflow = await createOwnedWorkflow(f, await (await f.request('/api/workflows', 'POST', generationWorkflow())).json());
  const fixture = { ...f, workflow };
  const firstResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['script', 'storyboard', 'generate', 'render', 'review'], startStage: 'script' });
  assert.equal(firstResponse.status, 202);
  const first = await waitRun(fixture, (await firstResponse.json()).id);
  assert.equal(first.status, 'awaiting_review');
  assert.equal(createCalls, 1);

  const db = new DatabaseSync(path.join(f.dataDir, 'studio.sqlite'));
  const stored = JSON.parse(db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get('workflowRuns', first.id).data);
  stored.nodeRuns = stored.nodeRuns.map((node) => {
    if (node.type !== 'generate') return node;
    const { generationJobId: _generationJobId, ...output } = node.output;
    return { ...node, output };
  });
  db.prepare('UPDATE entities SET data=? WHERE kind=? AND id=?').run(JSON.stringify(stored), 'workflowRuns', first.id);
  db.close();

  const response = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['generate', 'render', 'review'], startStage: 'generate', resumeRunId: first.id });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /generation|job|resume|evidence/i);
  assert.equal(createCalls, 1);
  const runs = await (await f.request(`/api/workflows/${workflow.id}/runs`)).json();
  assert.equal(runs.length, 1);
});
test('cancellation during generation submission preserves the job for resume without a second provider request', async (t) => {
  let releaseCreate;
  let announceCreate;
  const createPending = new Promise((resolve) => { releaseCreate = resolve; });
  const createCalled = new Promise((resolve) => { announceCreate = resolve; });
  let createCalls = 0;
  const generation = {
    transport: 'api',
    capability: async () => ({ available: true }),
    models: async () => [],
    modelSchema: async () => ({ type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    create: async () => { createCalls++; announceCreate(); return createPending; },
    status: async () => { throw new Error('unexpected poll'); },
  };
  const f = await setup(t, { generation, generationOptions: { pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, 'fixture bytes'); return { bytes: 13, contentType: 'image/png' }; }, probe: async () => ({ kind: 'image', width: 64, height: 64 }) } });
  const workflow = await createOwnedWorkflow(f, await (await f.request('/api/workflows', 'POST', generationWorkflow())).json());
  const fixture = { ...f, workflow };
  const firstResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['script', 'storyboard', 'generate', 'render', 'review'], startStage: 'script' });
  assert.equal(firstResponse.status, 202);
  const firstId = (await firstResponse.json()).id;
  await createCalled;
  const cancelledResponse = await f.request(`/api/workflows/${workflow.id}/runs/${firstId}/cancel`, 'POST', {});
  assert.equal(cancelledResponse.status, 200);
  releaseCreate({ requestId: 'fixture-provider', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] });
  const cancelled = await waitRun(fixture, firstId);
  assert.equal(cancelled.status, 'cancelled');
  const firstOutput = cancelled.nodeRuns.find((node) => node.type === 'generate').output;
  assert.equal(typeof firstOutput.generationJobId, 'string');
  const secondResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['generate', 'render', 'review'], startStage: 'generate', resumeRunId: firstId });
  assert.equal(secondResponse.status, 202);
  const second = await waitRun(fixture, (await secondResponse.json()).id);
  assert.equal(second.status, 'awaiting_review');
  assert.equal(createCalls, 1);
  assert.equal(second.nodeRuns.find((node) => node.type === 'generate').output.generationJobId, firstOutput.generationJobId);
});

test('generation requestId lineage recovers after workflow output persistence fails', async (t) => {
  let createCalls = 0;
  const generation = {
    transport: 'api',
    capability: async () => ({ available: true }),
    models: async () => [],
    modelSchema: async () => ({ type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    create: async () => { createCalls++; return { requestId: 'fixture-provider', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] }; },
    status: async () => { throw new Error('unexpected poll'); },
  };
  const f = await setup(t, { generation, generationOptions: { pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, 'fixture bytes'); return { bytes: 13, contentType: 'image/png' }; }, probe: async () => ({ kind: 'image', width: 64, height: 64 }) } });
  const workflow = await createOwnedWorkflow(f, await (await f.request('/api/workflows', 'POST', generationWorkflow())).json());
  const fixture = { ...f, workflow };
  const db = new DatabaseSync(path.join(f.dataDir, 'studio.sqlite'));
  db.exec(`CREATE TRIGGER workflow_runs_generation_link_failure BEFORE UPDATE ON entities
    WHEN NEW.kind = 'workflowRuns' AND json_extract(NEW.data, '$.status') = 'running' AND instr(NEW.data, '"generationJobId"') > 0
    BEGIN SELECT RAISE(ABORT, 'Injected workflowRuns generation-link persistence failure'); END;`);
  db.close();
  const firstResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['script', 'storyboard', 'generate', 'render', 'review'], startStage: 'script' });
  assert.equal(firstResponse.status, 202);
  const firstId = (await firstResponse.json()).id;
  const failed = await waitRun(fixture, firstId, ['failed']);
  assert.equal(failed.status, 'failed');
  let generationJob;
  for (let i = 0; i < 100; i++) {
    const state = await (await f.request('/api/state')).json();
    generationJob = state.generationJobs.find((job) => job.requestId === `${firstId}:generate`);
    if (generationJob?.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(generationJob?.status, 'completed');
  assert.equal(createCalls, 1);
  const restore = new DatabaseSync(path.join(f.dataDir, 'studio.sqlite'));
  restore.exec('DROP TRIGGER workflow_runs_generation_link_failure');
  restore.close();
  const resumedResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['generate', 'render', 'review'], startStage: 'generate', resumeRunId: firstId });
  assert.equal(resumedResponse.status, 202);
  const resumed = await waitRun(fixture, (await resumedResponse.json()).id);
  assert.equal(resumed.status, 'awaiting_review');
  assert.equal(createCalls, 1);
  assert.equal(resumed.nodeRuns.find((node) => node.type === 'generate').output.generationJobId, generationJob.id);
});
test('cancelled queued generation resume inherits pending provider job without resubmitting', async (t) => {
  let releaseStatus;
  let announceStatus;
  const pendingStatus = new Promise((resolve) => { releaseStatus = resolve; });
  const statusStarted = new Promise((resolve) => { announceStatus = resolve; });
  let statusCalls = 0;
  let createCalls = 0;
  const generation = {
    transport: 'api',
    capability: async () => ({ available: true }),
    models: async () => [],
    modelSchema: async () => ({ type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    create: async () => { createCalls++; return { requestId: 'fixture-provider', status: 'pending' }; },
    status: async () => {
      statusCalls++;
      if (statusCalls === 1) {
        announceStatus();
        return pendingStatus;
      }
      return { requestId: 'fixture-provider', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] };
    },
  };
  const f = await setup(t, { generation, generationOptions: { pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, 'fixture bytes'); return { bytes: 13, contentType: 'image/png' }; }, probe: async () => ({ kind: 'image', width: 64, height: 64 }) } });
  const workflow = await createOwnedWorkflow(f, await (await f.request('/api/workflows', 'POST', generationWorkflow())).json());
  const fixture = { ...f, workflow };
  const firstResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['script', 'storyboard', 'generate', 'render', 'review'], startStage: 'script' });
  assert.equal(firstResponse.status, 202);
  const firstId = (await firstResponse.json()).id;
  await statusStarted;
  assert.equal((await f.request(`/api/workflows/${workflow.id}/runs/${firstId}/cancel`, 'POST', {})).status, 200);
  const cancelledFirst = await waitRun(fixture, firstId);
  const firstJobId = cancelledFirst.nodeRuns.find((node) => node.type === 'generate').output.generationJobId;
  assert.equal(typeof firstJobId, 'string');

  const childId = `${firstId}-queued-child`;
  const queuedChild = {
    ...cancelledFirst,
    id: childId,
    status: 'queued',
    resumedFrom: firstId,
    selectedStages: ['generate', 'render', 'review'],
    startStage: 'generate',
    nodeRuns: cancelledFirst.nodeRuns.map((node) => {
      const { startedAt: _startedAt, completedAt: _completedAt, ...base } = node;
      if (node.type === 'generate' || node.type === 'render' || node.type === 'review') return { ...base, status: 'queued' };
      if (node.type === 'script' || node.type === 'storyboard') return { ...base, status: 'completed', reused: true };
      return { ...base, status: 'skipped' };
    }),
  };
  const childDb = new DatabaseSync(path.join(f.dataDir, 'studio.sqlite'));
  childDb.prepare('INSERT INTO entities(kind,id,data) VALUES (?,?,?)').run('workflowRuns', childId, JSON.stringify(queuedChild));
  childDb.close();
  const childCancel = await f.request(`/api/workflows/${workflow.id}/runs/${childId}/cancel`, 'POST', {});
  assert.equal(childCancel.status, 200);
  const cancelledChild = await waitRun(fixture, childId);
  const childGenerate = cancelledChild.nodeRuns.find((node) => node.type === 'generate');
  assert.equal(childGenerate.status, 'cancelled');
  assert.equal(childGenerate.startedAt, undefined);
  const db = new DatabaseSync(path.join(f.dataDir, 'studio.sqlite'));
  const storedChild = JSON.parse(db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get('workflowRuns', childId).data);
  storedChild.nodeRuns = storedChild.nodeRuns.map((node) => node.type === 'generate' ? { ...node, output: {} } : node);
  db.prepare('UPDATE entities SET data=? WHERE kind=? AND id=?').run(JSON.stringify(storedChild), 'workflowRuns', childId);
  db.close();

  const resumedResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['generate', 'render', 'review'], startStage: 'generate', resumeRunId: childId });
  const resumedBody = await resumedResponse.json();
  assert.equal(resumedResponse.status, 202, JSON.stringify(resumedBody));
  releaseStatus({ requestId: 'fixture-provider', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] });
  const resumed = await waitRun(fixture, resumedBody.id);
  assert.equal(resumed.status, 'awaiting_review');
  assert.equal(createCalls, 1);
  assert.equal(resumed.nodeRuns.find((node) => node.type === 'generate').output.generationJobId, firstJobId);
});

test('completed generation resume rejects storyboard rerun before episode mutation', async (t) => {
  let createCalls = 0;
  const generation = {
    transport: 'api',
    capability: async () => ({ available: true }),
    models: async () => [],
    modelSchema: async () => ({ type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    create: async () => { createCalls++; return { requestId: 'fixture-provider', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] }; },
    status: async () => { throw new Error('unexpected poll'); },
  };
  const f = await setup(t, { generation, generationOptions: { pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, 'fixture bytes'); return { bytes: 13, contentType: 'image/png' }; }, probe: async () => ({ kind: 'image', width: 64, height: 64 }) } });
  const workflow = await createOwnedWorkflow(f, await (await f.request('/api/workflows', 'POST', generationWorkflow())).json());
  const fixture = { ...f, workflow };
  const firstResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['script', 'storyboard', 'generate', 'render', 'review'], startStage: 'script' });
  assert.equal(firstResponse.status, 202);
  const first = await waitRun(fixture, (await firstResponse.json()).id);
  assert.equal(first.status, 'awaiting_review');
  assert.equal(createCalls, 1);
  const before = (await (await f.request('/api/state')).json()).episodes.find((episode) => episode.id === f.episode.id);
  const beforeVersion = before.version;
  const beforeScenes = before.scenes;
  const beforeRenders = f.renderCount();
  const scriptOnlyResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['script'], startStage: 'script', resumeRunId: first.id });
  assert.equal(scriptOnlyResponse.status, 202);
  const scriptOnly = await waitRun(fixture, (await scriptOnlyResponse.json()).id, ['completed', 'failed', 'cancelled']);
  assert.equal(scriptOnly.status, 'completed');
  const resumeSourceId = scriptOnly.id;

  const response = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['storyboard', 'generate', 'render'], startStage: 'storyboard', resumeRunId: resumeSourceId });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /storyboard|generated|preserve/i);
  assert.equal(createCalls, 1);
  assert.equal(f.renderCount(), beforeRenders);
  const afterState = await (await f.request('/api/state')).json();
  const after = afterState.episodes.find((episode) => episode.id === f.episode.id);
  assert.equal(after.version, beforeVersion);
  assert.deepEqual(after.scenes, beforeScenes);
  assert.equal((await f.request(`/api/workflows/${workflow.id}/runs`)).status, 200);
  assert.equal((await (await f.request(`/api/workflows/${workflow.id}/runs`)).json()).length, 2);
});

test('legacy selectedStages with resumeRunId strictly rejects rerunning an upstream producer while a paid generation job is already applied', async (t) => {
  let createCalls = 0;
  const generation = {
    transport: 'api',
    capability: async () => ({ available: true }),
    models: async () => [],
    modelSchema: async () => ({ type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    create: async () => { createCalls++; return { requestId: 'fixture-provider', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] }; },
    status: async () => { throw new Error('unexpected poll'); },
  };
  const f = await setup(t, { generation, generationOptions: { pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, 'fixture bytes'); return { bytes: 13, contentType: 'image/png' }; }, probe: async () => ({ kind: 'image', width: 64, height: 64 }) } });
  const workflow = await createOwnedWorkflow(f, await (await f.request('/api/workflows', 'POST', generationWorkflow())).json());
  const fixture = { ...f, workflow };

  const firstResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['script', 'storyboard', 'generate', 'render', 'review'], startStage: 'script' });
  assert.equal(firstResponse.status, 202, await firstResponse.clone().text());
  const first = await waitRun(fixture, (await firstResponse.json()).id);
  assert.equal(first.status, 'awaiting_review', JSON.stringify(first));
  assert.equal(createCalls, 1);
  const jobId = first.nodeRuns.find((node) => node.type === 'generate').output.generationJobId;
  assert.equal(typeof jobId, 'string');

  const before = (await (await f.request('/api/state')).json()).episodes.find((episode) => episode.id === f.episode.id);

  // Single-hop legacy resume straight off the completed paid run: reselecting an upstream
  // scene producer (storyboard) alongside the already-paid generate node must stay strictly
  // blocked. This is the client-authored selectedStages+resumeRunId shape, never derived via
  // `execution`, and the existing guard (server/workflows.mjs ~419) must reject it regardless
  // of how the planner-driven execution-intent path treats the equivalent dirty propagation.
  const rerun = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['storyboard', 'generate', 'render'], startStage: 'storyboard', resumeRunId: first.id });
  assert.equal(rerun.status, 409, await rerun.clone().text());
  assert.equal((await rerun.json()).error, 'Cannot rerun script, storyboard or layout while reusing a paid generation job');
  assert.equal(createCalls, 1, 'a rejected legacy rerun must never reach the provider a second time');

  const after = (await (await f.request('/api/state')).json()).episodes.find((episode) => episode.id === f.episode.id);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.scenes, before.scenes);
  const runs = await (await f.request(`/api/workflows/${workflow.id}/runs`)).json();
  assert.equal(runs.length, 1, 'a rejected rerun must not persist a second run entity');
  assert.equal(runs[0].nodeRuns.find((node) => node.type === 'generate').output.generationJobId, jobId, 'the original paid job reference stays untouched');
});

test('execution-intent refresh re-quotes a fresh paid generation after an upstream producer invalidates the prior job, but only with explicit consent', async (t) => {
  let createCalls = 0;
  const generation = {
    transport: 'api',
    capability: async () => ({ available: true }),
    models: async () => [],
    modelSchema: async () => ({ type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    create: async () => { createCalls++; return { requestId: `fixture-provider-${createCalls}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] }; },
    status: async () => { throw new Error('unexpected poll'); },
  };
  const f = await setup(t, { generation, generationOptions: { pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, 'fixture bytes'); return { bytes: 13, contentType: 'image/png' }; }, probe: async () => ({ kind: 'image', width: 64, height: 64 }) } });
  const workflow = await createOwnedWorkflow(f, await (await f.request('/api/workflows', 'POST', generationWorkflow())).json());
  const fixture = { ...f, workflow };

  const firstResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['script', 'storyboard', 'generate', 'render', 'review'], startStage: 'script' });
  assert.equal(firstResponse.status, 202, await firstResponse.clone().text());
  const first = await waitRun(fixture, (await firstResponse.json()).id);
  assert.equal(first.status, 'awaiting_review', JSON.stringify(first));
  assert.equal(createCalls, 1);
  const firstJobId = first.nodeRuns.find((node) => node.type === 'generate').output.generationJobId;

  // Contract 1.3 step 4 (mode 'all', refresh:true): source is dropped so paid generation is
  // re-quoted, never inherited. Submitting straight to /run without a persisted quote must
  // still be refused -- a fresh execution-intent rerun is never exempt from the quote/consent
  // gate that already protects the legacy path.
  const execution = { mode: 'all', refresh: true };
  const disclosure = { containsSyntheticMedia: true, rationale: 'Synthetic fixture illustration; owner reviewed complete candidate' };
  const noConsent = await f.request(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: f.episode.id, allowGeneration: true, execution, disclosure });
  assert.equal(noConsent.status, 400, await noConsent.clone().text());
  assert.match((await noConsent.json()).error, /quote/i);
  assert.equal(createCalls, 1, 'an execution-intent rerun must never submit without a persisted quote');

  const planResponse = await f.request(`/api/workflows/${workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.equal(plan.resumeRunId, null, 'refresh must drop resume so paid generation is never inherited');
  assert.equal(plan.requiresGeneration, true);
  assert.deepEqual(plan.selectedStages, ['script', 'storyboard', 'generate', 'render', 'review']);

  const refreshed = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, execution });
  assert.equal(refreshed.status, 202, await refreshed.clone().text());
  const refreshedRun = await waitRun(fixture, (await refreshed.json()).id);
  assert.equal(refreshedRun.status, 'awaiting_review', JSON.stringify(refreshedRun));
  assert.equal(createCalls, 2, 'the invalidated-by-refresh generate node must submit a genuinely new paid generation');
  const refreshedGenerate = refreshedRun.nodeRuns.find((node) => node.type === 'generate');
  assert.notEqual(refreshedGenerate.reused, true, 'a refreshed generation is fresh, never a silent reuse');
  assert.notEqual(refreshedGenerate.output.generationJobId, firstJobId, 'refresh must never carry forward the prior paid job id');
});

test('an unresolved paid generation job left by cancelled run history blocks a fresh submission for the same node', async (t) => {
  let releaseStatus;
  let announceStatus;
  const pendingStatus = new Promise((resolve) => { releaseStatus = resolve; });
  const statusStarted = new Promise((resolve) => { announceStatus = resolve; });
  let statusCalls = 0;
  let createCalls = 0;
  const generation = {
    transport: 'api',
    capability: async () => ({ available: true }),
    models: async () => [],
    modelSchema: async () => ({ type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    create: async () => { createCalls++; return { requestId: 'fixture-provider', status: 'pending' }; },
    status: async () => {
      statusCalls++;
      if (statusCalls === 1) { announceStatus(); return pendingStatus; }
      return { requestId: 'fixture-provider', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] };
    },
  };
  const f = await setup(t, { generation, generationOptions: { pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, 'fixture bytes'); return { bytes: 13, contentType: 'image/png' }; }, probe: async () => ({ kind: 'image', width: 64, height: 64 }) } });
  const workflow = await createOwnedWorkflow(f, await (await f.request('/api/workflows', 'POST', generationWorkflow())).json());
  const fixture = { ...f, workflow };

  const firstResponse = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['script', 'storyboard', 'generate', 'render', 'review'], startStage: 'script' });
  assert.equal(firstResponse.status, 202);
  const firstId = (await firstResponse.json()).id;
  await statusStarted;
  assert.equal((await f.request(`/api/workflows/${workflow.id}/runs/${firstId}/cancel`, 'POST', {})).status, 200);
  const cancelled = await waitRun(fixture, firstId);
  assert.equal(cancelled.status, 'cancelled');
  const orphanedJobId = cancelled.nodeRuns.find((node) => node.type === 'generate').output.generationJobId;
  assert.equal(typeof orphanedJobId, 'string');
  assert.equal(createCalls, 1);
  const runsBefore = await (await f.request(`/api/workflows/${workflow.id}/runs`)).json();

  // The cancelled run's job never settled (no terminal provider status, never recovered/applied).
  // A brand-new attempt that never references that run (no resumeRunId) must still find it via
  // the lineage-independent scan and refuse a second paid submission for the same node -- this
  // protection is independent of, and must survive, whatever fix restores the legacy guard above.
  const second = await consentedRun(f, workflow.id, { episodeId: f.episode.id, allowGeneration: true, selectedStages: ['script', 'storyboard', 'generate', 'render', 'review'], startStage: 'script' });
  assert.equal(second.status, 409, await second.clone().text());
  const secondBody = await second.json();
  assert.equal(secondBody.code, 'generation_unresolved');
  assert.match(secondBody.error, /복구|적용/);
  assert.equal(createCalls, 1, 'a second submission must never reach the provider while the first job is unresolved');

  const runsAfter = await (await f.request(`/api/workflows/${workflow.id}/runs`)).json();
  assert.equal(runsAfter.length, runsBefore.length, 'a blocked attempt must not persist a new run');

  releaseStatus({ requestId: 'fixture-provider', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] });
});

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

test('node labels, notes and bounded stage settings normalize and reject invalid values', () => {
  const workflow = defaultWorkflow();
  const normalized = validateWorkflow({ ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, label: '  Custom label  ', notes: '  Editing notes  ', config: node.type === 'trend' ? { query: '  소재  ' } : node.type === 'research' ? { limit: 2 } : node.type === 'review' ? { instructions: '  Check sources  ' } : node.config })) });
  assert.equal(normalized.nodes[0].label, 'Custom label');
  assert.equal(normalized.nodes[0].notes, 'Editing notes');
  assert.deepEqual(normalized.nodes.find((node) => node.type === 'trend').config, { query: '소재' });
  assert.deepEqual(normalized.nodes.find((node) => node.type === 'review').config, { instructions: 'Check sources' });
  for (const patch of [{ label: 'x'.repeat(81) }, { notes: 'x'.repeat(2001) }, { config: { query: 'x'.repeat(201) } }]) {
    assert.throws(() => validateWorkflow({ ...workflow, nodes: workflow.nodes.map((node) => node.type === 'trend' ? { ...node, ...patch } : node) }), { status: 400 });
  }
  for (const limit of [0, 51, 1.5, '2', null]) assert.throws(() => validateWorkflow({ ...workflow, nodes: workflow.nodes.map((node) => node.type === 'research' ? { ...node, config: { limit } } : node) }), { status: 400 });
  assert.throws(() => validateWorkflow({ ...workflow, nodes: workflow.nodes.map((node) => node.type === 'review' ? { ...node, config: { instructions: 'x'.repeat(2001) } } : node) }), { status: 400 });
});

test('saved node settings filter trends, bound research and retain instructions in the review checkpoint', async (t) => {
  const f = await setup(t, { integrations: { ...baseIntegrations, fetchTrends: async () => ({ trends: [{ keyword: '검증 소재', source: 'Fixture RSS', url: 'https://example.com/a' }, { keyword: '무관 키워드', source: 'Fixture RSS', url: 'https://example.com/b' }], sources: [] }) } });
  for (let i = 0; i < 3; i++) await f.request('/api/references', 'POST', { title: `Source ${i}`, category: 'information', url: `https://example.com/${i}`, channelId: f.episode.channelId });
  const nodes = f.workflow.nodes.map((node) => ({ ...node, label: `Edited ${node.type}`, notes: 'Saved node note', config: node.type === 'trend' ? { query: '소재' } : node.type === 'research' ? { limit: 2 } : node.type === 'review' ? { instructions: 'Check source attribution and subtitles' } : node.config }));
  const saved = await (await f.request(`/api/workflows/${f.workflow.id}`, 'PUT', { ...f.workflow, nodes, expectedVersion: 1 })).json();
  assert.equal(saved.nodes[0].label, 'Edited trend');
  assert.equal(saved.nodes[0].notes, 'Saved node note');
  assert.equal((await f.request(`/api/workflows/${f.workflow.id}`, 'PUT', { ...saved, expectedVersion: 1 })).status, 409);
  const started = await (await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id })).json();
  const run = await waitRun(f, started.id);
  assert.equal(run.status, 'awaiting_review');
  assert.deepEqual(run.nodeRuns.find((node) => node.type === 'trend').output.trends.map((trend) => trend.keyword), ['검증 소재']);
  assert.equal(run.nodeRuns.find((node) => node.type === 'research').output.references.length, 2);
  assert.equal(run.nodeRuns.find((node) => node.type === 'review').output.instructions, 'Check source attribution and subtitles');
  assert.equal(run.workflowSnapshot.nodes[0].label, 'Edited trend');
  const history = await (await f.request(`/api/workflows/${f.workflow.id}/history`)).json();
  assert.equal(history[0].snapshot.nodes[0].notes, 'Saved node note');
});

test('a trend filter with no matches fails downstream stages rather than fabricating research', async (t) => {
  const f = await setup(t);
  const nodes = f.workflow.nodes.map((node) => node.type === 'trend' ? { ...node, config: { query: 'does-not-match' } } : node);
  await f.request(`/api/workflows/${f.workflow.id}`, 'PUT', { ...f.workflow, nodes, expectedVersion: 1 });
  const started = await (await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id })).json();
  const run = await waitRun(f, started.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.nodeRuns[0].status, 'failed');
  assert.equal(f.renderCount(), 0);
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

test('workflow run history is searchable, paginated, and directly traceable to its stored snapshot', async (t) => {
  const f = await setup(t);
  const db = new DatabaseSync(path.join(f.dataDir, 'studio.sqlite'));
  const insert = db.prepare('INSERT INTO entities(kind, id, data) VALUES (?, ?, ?)');
  for (let index = 0; index < 25; index++) {
    const id = index === 7 ? 'run-special-target' : `run-fixture-${String(index).padStart(2, '0')}`;
    const run = {
      id,
      workflowId: f.workflow.id,
      workflowVersion: 3,
      episodeId: f.episode.id,
      episodeVersion: index + 1,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      status: index === 7 ? 'failed' : 'awaiting_review',
      selectedStages: ['script', 'storyboard', 'render', 'review'],
      workflowSnapshot: { name: 'History fixture', nodes: [], edges: [] },
      episodeSnapshot: { title: index === 7 ? 'Searchable unique phrase' : `Episode ${index}` },
      nodeRuns: [{ nodeId: 'script-node', type: 'script', status: index === 7 ? 'failed' : 'completed', error: index === 7 ? 'Fixture failure' : null }],
    };
    insert.run('workflowRuns', id, JSON.stringify(run));
  }
  db.close();

  const firstResponse = await f.request('/api/workflow-runs?page=1&limit=20');
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.total, 25);
  assert.equal(first.page, 1);
  assert.equal(first.pageSize, 20);
  assert.equal(first.pageCount, 2);
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0].id, 'run-fixture-24');
  assert.equal(first.items[0].workflowSnapshot, undefined, 'list responses should be summaries, not unbounded snapshots');

  const second = await (await f.request('/api/workflow-runs?page=2&limit=20')).json();
  assert.equal(second.items.length, 5);
  assert.equal(second.items.at(-1).id, 'run-fixture-00');

  const search = await (await f.request('/api/workflow-runs?page=1&limit=20&q=searchable%20unique%20phrase')).json();
  assert.equal(search.total, 1);
  assert.equal(search.items[0].id, 'run-special-target');
  assert.equal(search.items[0].nodeRuns[0].status, 'failed');

  const detailResponse = await f.request('/api/workflow-runs/run-special-target');
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.episodeSnapshot.title, 'Searchable unique phrase');
  assert.equal(detail.workflowSnapshot.name, 'History fixture');
  assert.equal(detail.nodeRuns[0].error, 'Fixture failure');

  assert.equal((await f.request('/api/workflow-runs?page=0')).status, 400);
  assert.equal((await f.request('/api/workflow-runs?limit=101')).status, 400);
  assert.equal((await f.request('/api/workflow-runs/missing-run')).status, 404);
});

test('Hermes-selected script stages use the connected agent and expose saved execution progress', async (t) => {
  const calls = [];
  const hermesStatus = { available: true, status: 'installed', detail: 'Hermes CLI discovered; runtime response not yet verified' };
  const f = await setup(t, { integrations: {
    ...baseIntegrations,
    integrationStatus: async () => ({ studio: { available: true }, hermes: hermesStatus }),
    runAgent: async (agent, message, episode) => {
      calls.push({ agent, message, episodeId: episode.id });
      return { message: 'Hermes fixture response', scenes: episode.scenes };
    },
  } });
  const status = await (await f.request('/api/integrations')).json();
  assert.deepEqual(status.hermes, hermesStatus);

  const workflow = { ...f.workflow, nodes: f.workflow.nodes.map(node => node.type === 'script' ? { ...node, config: { agent: 'hermes', prompt: 'Return storyboard JSON' } } : node) };
  const save = await f.request(`/api/workflows/${workflow.id}`, 'PUT', { ...workflow, expectedVersion: 1 });
  assert.equal(save.status, 200);
  const started = await (await f.request(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: f.episode.id })).json();
  const run = await waitRun(f, started.id);
  assert.equal(run.status, 'awaiting_review');
  assert.deepEqual(calls.map(call => call.agent), ['hermes']);
  assert.equal(run.nodeRuns.find(node => node.type === 'script').output.agent, 'hermes');
  assert.equal(run.nodeRuns.find(node => node.type === 'script').status, 'completed');
  assert.equal(run.workflowSnapshot.nodes.find(node => node.type === 'script').config.agent, 'hermes');
});

async function createOwnedWorkflow(f, template) {
  assert.ok(template.id, 'real template creation succeeds before project copy');
  const response = await f.request(`/api/workflows/${template.id}/copies`, 'POST', { episodeId: f.episode.id, channelId: f.episode.channelId, expectedTemplateVersion: template.version });
  assert.equal(response.status, 201); return response.json();
}
async function consentedRun(f, workflowId, body) {
  const disclosure = { containsSyntheticMedia: true, rationale: 'Synthetic fixture illustration; owner reviewed complete candidate' };
  const response = await f.request(`/api/workflows/${workflowId}/quote`, 'POST', { ...body, disclosure });
  if (response.status !== 200) return response; // invalid resume is asserted by the original regression
  const plan = await response.json();
  return f.request(`/api/workflows/${workflowId}/run`, 'POST', { ...body, disclosure, generationPlanId: plan.id, generationFingerprint: plan.fingerprint, acceptUnquotedEstimate: true });
}
