import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

const bytes = Buffer.from('local generation fixture');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const disclosure = { containsSyntheticMedia: true, rationale: 'Reviewed fixture illustration' };
const node = (id, type, config = {}) => ({ id, type, x: 0, y: 0, config });
const record = (run, id) => run.nodeRuns.find(item => item.nodeId === id);

async function fixture(t, { chained = false, firstFails = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'workflow-paid-reuse-'));
  let submits = 0;
  const rendered = [];
  const forbidden = async () => { throw new Error('Unexpected external operation'); };
  const generation = {
    transport: 'api', capability: async () => ({ available: true }), models: forbidden,
    modelSchema: async () => ({ type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    estimate: async () => ({ cost: 1, currency: 'USD' }),
    create: async () => { submits++; if (firstFails) throw Object.assign(new Error('Fixture rejection'), { code: 'INVALID_INPUT' }); return { requestId: `fixture-provider-${submits}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] }; },
    status: forbidden,
  };
  const app = createApp({ dataDir, loginToken: '', publicOrigin: '', generation,
    generationOptions: { download: async (_url, file) => { await writeFile(file, bytes); return { bytes: bytes.length, contentType: 'image/png' }; }, probe: async () => ({ kind: 'image', width: 64, height: 64 }) },
    integrations: { integrationStatus: async () => ({}) }, renderer: async (episode, { dataDir: root }) => { rendered.push(structuredClone(episode.scenes)); await writeFile(path.join(root, 'exports', 'fixture.mp4'), 'fixture render'); return { filename: 'fixture.mp4', outputUrl: '/api/exports/fixture.mp4' }; },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (route, method = 'GET', body) => fetch(base + route, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = async (route, method = 'GET', body) => { const response = await request(route, method, body); const value = await response.json(); assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(value)}`); return value; };
  const channel = await api('/api/channels', 'POST', { name: 'Reuse owner', category: 'information', platform: 'YouTube' });
  let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Reuse project', topic: 'Local fixture' });
  episode = await api(`/api/episodes/${episode.id}`, 'PUT', { expectedVersion: episode.version, scenes: [episode.scenes[0], { ...episode.scenes[0], id: 'sibling-scene', title: 'Sibling scene' }] });
  const nodes = [node('script', 'script', { agent: 'existing' }), node('board', 'storyboard'), node('generate', 'generate', { model: 'fixture', prompt: 'Fixture visual', params: {}, sceneIndex: 0 })];
  const edges = [{ id: 'a', source: 'script', target: 'board' }, { id: 'b', source: 'board', target: 'generate' }];
  if (chained === 'layout-only') {
    nodes.push(node('after-layout', 'layout'));
    edges.push({ id: 'c', source: 'generate', target: 'after-layout' });
  } else if (chained) {
    nodes.push(node('generate-next', 'generate', { model: 'fixture', prompt: 'Second visual', params: {}, sceneIndex: 1 }));
    if (chained === 'layout') {
      nodes.push(node('after-layout', 'layout'));
      edges.push({ id: 'c1', source: 'generate', target: 'after-layout' }, { id: 'c2', source: 'after-layout', target: 'generate-next' });
    } else if (chained === 'indirect') {
      nodes.push(node('context', 'research'));
      edges.push({ id: 'c1', source: 'generate', target: 'context' }, { id: 'c2', source: 'context', target: 'generate-next' });
    } else {
      edges.push({ id: 'c', source: 'generate', target: 'generate-next' });
    }
  }
  nodes.push(node('render', 'render'));
  edges.push({ id: 'd', source: chained === 'layout-only' ? 'after-layout' : chained ? 'generate-next' : 'generate', target: 'render' });
  const template = await api('/api/workflows', 'POST', { name: 'Paid reuse fixture', nodes, edges });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const current = async () => (await api('/api/state')).episodes.find(item => item.id === episode.id);
  const wait = async id => { for (let i = 0; i < 5000; i++) { const run = await api(`/api/workflow-runs/${id}`); if (['completed', 'failed', 'cancelled'].includes(run.status)) return run; await new Promise(resolve => setImmediate(resolve)); } assert.fail(`Run ${id} did not finish`); };
  const selection = (id, version, resumeRunId) => ({ episodeId: episode.id, expectedEpisodeVersion: version, expectedWorkflowVersion: workflow.version, selectedStages: [id], startStage: id, ...(resumeRunId ? { resumeRunId } : {}) });
  const quote = body => request(`/api/workflows/${workflow.id}/quote`, 'POST', { ...body, disclosure });
  const start = async (body, plan) => { const response = await request(`/api/workflows/${workflow.id}/run`, 'POST', { ...body, allowGeneration: true, disclosure, generationPlanId: plan.id, generationFingerprint: plan.fingerprint, acceptUnquotedEstimate: true }); assert.equal(response.status, 202, await response.clone().text()); return wait((await response.json()).id); };
  const preparation = await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, expectedEpisodeVersion: episode.version, expectedWorkflowVersion: workflow.version, selectedStages: ['script', 'board'], startStage: 'script' });
  const board = await wait(preparation.id);
  assert.equal(board.status, 'completed', JSON.stringify(board));
  const preparedEpisode = await current();
  if (chained === 'layout-only') return { api, current, wait, selection, workflow, board, preparedEpisode, rendered, submits: () => submits };
  const originalSelection = selection('generate', preparedEpisode.version, board.id);
  const quoteResponse = await quote(originalSelection);
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const first = await start(originalSelection, await quoteResponse.json());
  if (firstFails) {
    assert.equal(first.status, 'failed', JSON.stringify(first));
    assert.equal(record(first, 'generate').status, 'failed');
    assert.equal(submits, 1);
    return { api, request, current, quote, wait, selection, workflow, first, preparedEpisode, rendered, submits: () => submits };
  }
  assert.equal(first.status, 'completed', JSON.stringify(first));
  assert.equal(submits, 1);
  const output = record(first, 'generate').output;
  const job = await api(`/api/generations/${output.generationJobId}`);
  const applied = await current();
  assert.equal(job.status, 'completed');
  assert.equal(job.applied, true);
  assert.equal(job.episodeId, episode.id);
  assert.equal(job.sceneId, applied.scenes[0].id);
  assert.equal(job.appliedVersion, applied.version);
  assert.equal(output.sceneId, job.sceneId);
  assert.deepEqual(output.outputs, job.outputs);
  assert.equal(job.outputs[0].sha256, sha256(bytes));
  assert.equal(applied.scenes[0].assetUrl, job.outputs[0].url);
  assert.equal(applied.scenes[0].source.generationJobId, job.id);
  assert.equal(applied.scenes[0].source.sha256, sha256(bytes));
  const filename = path.join(dataDir, 'uploads', path.basename(job.outputs[0].url));
  assert.deepEqual(await readFile(filename), bytes);
  return { api, request, current, quote, start, wait, selection, workflow, first, output, job, applied, filename, rendered, submits: () => submits };
}

test('same-node quote and resume preserve the exact applied job, scene, and version without another submission', async t => {
  const f = await fixture(t);
  const body = f.selection('generate', f.applied.version, f.first.id);
  const response = await f.quote(body);
  assert.equal(response.status, 200, await response.clone().text());
  const resumed = await f.start(body, await response.json());
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  const generated = record(resumed, 'generate');
  assert.equal(generated.reused, true);
  assert.deepEqual(generated.output, f.output);
  assert.deepEqual(await f.api(`/api/generations/${f.job.id}`), f.job);
  assert.deepEqual(await f.current(), f.applied);
  assert.equal(f.submits(), 1, 'resume must not submit another paid job');
});

test('changed registered output bytes cannot be quoted as the original paid result', async t => {
  const f = await fixture(t);
  await writeFile(f.filename, Buffer.from('changed generation fixture'));
  const response = await f.quote(f.selection('generate', f.applied.version, f.first.id));
  assert.equal(response.status, 409, await response.text());
  assert.deepEqual(await f.current(), f.applied);
  assert.equal(f.submits(), 1);
});

test('moving the real output to a sibling scene cannot satisfy the original node receipt', async t => {
  const f = await fixture(t);
  const original = f.applied.scenes[0], sibling = f.applied.scenes[1];
  const edit = await f.request(`/api/episodes/${f.applied.id}`, 'PUT', { expectedVersion: f.applied.version, scenes: [{ ...original, kind: sibling.kind, assetUrl: '', source: undefined }, { ...sibling, kind: original.kind, assetUrl: original.assetUrl, source: original.source }] });
  assert.equal(edit.status, 200, await edit.clone().text());
  const moved = await edit.json();
  const response = await f.quote(f.selection('generate', moved.version, f.first.id));
  assert.equal(response.status, 409, await response.text());
  assert.deepEqual(await f.current(), moved);
  assert.equal(f.submits(), 1);
});

test('a downstream generation quote includes its unchanged upstream paid output and still requires consent', async t => {
  const f = await fixture(t, { chained: true });
  const body = f.selection('generate-next', f.applied.version, f.first.id);
  const response = await f.quote(body);
  assert.equal(response.status, 200, await response.clone().text());
  const plan = await response.json();
  const inherited = plan.candidate.episode.scenes.find(scene => scene.sceneId === f.job.sceneId);
  assert.equal(inherited.assetUrl, f.job.outputs[0].url);
  assert.deepEqual(inherited.source, f.applied.scenes[0].source);
  const asset = plan.candidate.assets.find(item => item.sceneId === f.job.sceneId && item.assetUrl === f.job.outputs[0].url);
  assert.equal(asset.sha256, sha256(bytes));
  assert.equal(asset.uploadId, f.job.outputs[0].uploadId);
  assert.equal(plan.candidate.nodes.find(node => node.nodeId === 'generate-next').sceneId, f.applied.scenes[1].id);
  const denied = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { ...body, disclosure, generationPlanId: plan.id, generationFingerprint: plan.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(denied.status, 400, await denied.text());
  assert.deepEqual(await f.current(), f.applied);
  assert.equal(f.submits(), 1);
});

test('a downstream generation quote rejects tampered bytes of its upstream paid output', async t => {
  const f = await fixture(t, { chained: true });
  await writeFile(f.filename, Buffer.from('changed generation fixture'));
  const response = await f.quote(f.selection('generate-next', f.applied.version, f.first.id));
  assert.equal(response.status, 409, await response.text());
  assert.deepEqual(await f.current(), f.applied);
  assert.equal(f.submits(), 1);
});

test('a downstream quote retains a completed generation through an intermediate node', async t => {
  const f = await fixture(t, { chained: 'indirect' });
  const response = await f.quote(f.selection('generate-next', f.applied.version, f.first.id));
  assert.equal(response.status, 200, await response.clone().text());
  const plan = await response.json();
  const inherited = plan.candidate.episode.scenes.find(scene => scene.sceneId === f.job.sceneId);
  assert.equal(inherited.assetUrl, f.job.outputs[0].url);
  assert.deepEqual(inherited.source, f.applied.scenes[0].source);
  const asset = plan.candidate.assets.find(item => item.sceneId === f.job.sceneId && item.assetUrl === f.job.outputs[0].url);
  assert.equal(asset.sha256, sha256(bytes));
  assert.equal(asset.uploadId, f.job.outputs[0].uploadId);
  assert.equal(plan.candidate.nodes.find(node => node.nodeId === 'generate-next').sceneId, f.applied.scenes[1].id);
  assert.deepEqual(await f.current(), f.applied);
  assert.equal(f.submits(), 1);
});

test('a later executed layout replaces earlier generation when quoting a downstream node', async t => {
  const f = await fixture(t, { chained: 'layout' });
  const started = await f.api(`/api/workflows/${f.workflow.id}/run`, 'POST', f.selection('after-layout', f.applied.version, f.first.id));
  const layoutRun = await f.wait(started.id);
  assert.equal(layoutRun.status, 'completed', JSON.stringify(layoutRun));
  const saved = await f.current();
  assert.deepEqual(record(layoutRun, 'after-layout').output.scenes, saved.scenes);
  assert.notEqual(saved.scenes[0].assetUrl, f.job.outputs[0].url);
  const response = await f.quote(f.selection('generate-next', saved.version, layoutRun.id));
  assert.equal(response.status, 200, await response.clone().text());
  const plan = await response.json();
  assert.equal(plan.candidate.episode.scenes.length, saved.scenes.length);
  for (const scene of saved.scenes) {
    const quoted = plan.candidate.episode.scenes.find(item => item.sceneId === scene.id);
    assert.ok(quoted, `Missing scene ${scene.id}`);
    for (const [key, value] of Object.entries(scene)) {
      if (key === 'slots') {
        assert.equal(quoted.slots.length, value.length);
        for (const [index, slot] of value.entries()) for (const [field, expected] of Object.entries(slot)) assert.deepEqual(quoted.slots[index][field], expected);
      } else assert.deepEqual(quoted[key], value, `Changed scene ${scene.id} field ${key}`);
    }
    assert.equal(quoted.assetUrl, scene.assetUrl || '');
    assert.deepEqual(quoted.source, scene.source ?? null);
  }
  assert.equal(plan.candidate.assets.some(asset => asset.uploadId === f.job.outputs[0].uploadId), false);
  assert.deepEqual(await f.current(), saved);
  assert.equal(f.submits(), 1, 'layout and quote cannot submit another paid job');
});

test('render uses the latest layout and downstream generation without reviving an older generation', async t => {
  const f = await fixture(t, { chained: 'layout' });
  const started = await f.api(`/api/workflows/${f.workflow.id}/run`, 'POST', f.selection('after-layout', f.applied.version, f.first.id));
  const layoutRun = await f.wait(started.id);
  assert.equal(layoutRun.status, 'completed', JSON.stringify(layoutRun));
  const layoutEpisode = await f.current();
  assert.deepEqual(record(layoutRun, 'after-layout').output.scenes, layoutEpisode.scenes);
  assert.notEqual(layoutEpisode.scenes[0].assetUrl, f.job.outputs[0].url);
  const generationSelection = f.selection('generate-next', layoutEpisode.version, layoutRun.id);
  const quoteResponse = await f.quote(generationSelection);
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const second = await f.start(generationSelection, await quoteResponse.json());
  assert.equal(second.status, 'completed', JSON.stringify(second));
  const secondOutput = record(second, 'generate-next').output;
  const secondJob = await f.api(`/api/generations/${secondOutput.generationJobId}`);
  const current = await f.current();
  assert.notEqual(secondJob.id, f.job.id);
  assert.equal(secondJob.sceneId, current.scenes[1].id);
  assert.equal(current.scenes[1].assetUrl, secondJob.outputs[0].url);
  assert.equal(current.scenes[1].source.generationJobId, secondJob.id);
  assert.deepEqual(current.scenes[0], layoutEpisode.scenes[0]);
  const renderStarted = await f.api(`/api/workflows/${f.workflow.id}/run`, 'POST', f.selection('render', current.version, second.id));
  const renderRun = await f.wait(renderStarted.id);
  assert.equal(renderRun.status, 'completed', JSON.stringify(renderRun));
  assert.deepEqual(record(renderRun, 'render').output.sceneSnapshot, current.scenes);
  assert.deepEqual(f.rendered, [current.scenes]);
  assert.deepEqual(await f.current(), current);
  assert.equal(f.submits(), 2, 'only the two explicitly approved mock generations may submit');
});

test('render-only uses a later layout without requiring a superseded unexecuted generation', async t => {
  const f = await fixture(t, { chained: 'layout-only' });
  const layoutStart = await f.api(`/api/workflows/${f.workflow.id}/run`, 'POST', f.selection('after-layout', f.preparedEpisode.version, f.board.id));
  const layoutRun = await f.wait(layoutStart.id);
  assert.equal(layoutRun.status, 'completed', JSON.stringify(layoutRun));
  const saved = await f.current();
  assert.deepEqual(record(layoutRun, 'after-layout').output.scenes, saved.scenes);
  assert.equal(record(layoutRun, 'generate').status, 'skipped');
  const renderStart = await f.api(`/api/workflows/${f.workflow.id}/run`, 'POST', f.selection('render', saved.version, layoutRun.id));
  const renderRun = await f.wait(renderStart.id);
  assert.equal(renderRun.status, 'completed', JSON.stringify(renderRun));
  assert.deepEqual(record(renderRun, 'render').output.sceneSnapshot, saved.scenes);
  assert.deepEqual(f.rendered, [saved.scenes]);
  assert.deepEqual(await f.current(), saved);
  assert.equal(f.submits(), 0);
});

test('downstream quote uses a later layout despite a superseded failed generation intent', async t => {
  const f = await fixture(t, { chained: 'layout', firstFails: true });
  const failedNode = record(f.first, 'generate');
  const failedJob = await f.api(`/api/generations/${failedNode.output.generationJobId}`);
  assert.equal(failedJob.status, 'failed');
  assert.equal(failedJob.applied, false);
  const afterFailure = await f.current();
  assert.deepEqual(afterFailure, f.preparedEpisode);
  const layoutStart = await f.api(`/api/workflows/${f.workflow.id}/run`, 'POST', f.selection('after-layout', afterFailure.version, f.first.id));
  const layoutRun = await f.wait(layoutStart.id);
  assert.equal(layoutRun.status, 'completed', JSON.stringify(layoutRun));
  const saved = await f.current();
  assert.deepEqual(record(layoutRun, 'after-layout').output.scenes, saved.scenes);
  const response = await f.quote(f.selection('generate-next', saved.version, layoutRun.id));
  assert.equal(response.status, 200, await response.clone().text());
  const plan = await response.json();
  assert.equal(plan.candidate.nodes.find(node => node.nodeId === 'generate-next').sceneId, saved.scenes[1].id);
  assert.equal(plan.candidate.episode.scenes.length, saved.scenes.length);
  for (const scene of saved.scenes) {
    const quoted = plan.candidate.episode.scenes.find(item => item.sceneId === scene.id);
    assert.equal(quoted.assetUrl, scene.assetUrl || '');
    assert.deepEqual(quoted.source, scene.source ?? null);
  }
  assert.deepEqual(await f.current(), saved);
  assert.equal(f.submits(), 1, 'layout and quote cannot resubmit the failed intent or submit a new generation');
});
