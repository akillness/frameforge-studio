import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHiggsfieldApi } from '../server/higgsfield.mjs';
import { GenerationQueue } from '../server/generations.mjs';
import { Store, starterScene } from '../server/store.mjs';
import { createWorkflowEditor, workflowErrors } from '../public/workflow.js';

const model = 'bytedance/seedance-2.5/text-to-video';
const validParams = { duration: 5, resolution: '720p', aspect_ratio: '16:9', output_format: 'mp4', generate_audio: true };

function response(body, init = {}) {
  return body instanceof Response ? body : Response.json(body, init);
}

test('Higgsfield REST estimate uses the verified model endpoint and exact validated body', async () => {
  const calls = [];
  const api = createHiggsfieldApi({
    env: { HF_API_KEY: 'fixture-key' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ credits: '1.500', usd: '0.094' });
    },
  });
  const estimate = await api.estimate({ model, prompt: 'white studio product shot', params: validParams });
  assert.deepEqual(estimate, { credits: 1.5, usd: 0.094 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.higgsfield.ai/estimate/${model}`);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { prompt: 'white studio product shot', ...validParams });
  assert.equal(calls[0].options.headers.authorization, 'Key fixture-key');
  assert.equal(calls[0].options.headers['Idempotency-Key'], undefined);
});

test('Higgsfield estimate rejects malformed, missing, non-finite, and negative billable values as provider errors', async () => {
  const invalidBodies = [
    {},
    { credits: 1.5 },
    { credits: -1, usd: 0.1 },
    { credits: 1, usd: -0.1 },
    { credits: 'NaN', usd: 0.1 },
    { credits: 'Infinity', usd: 0.1 },
    { credits: true, usd: 0.1 },
    { credits: 1, usd: false },
    { credits: '', usd: 0.1 },
    { credits: 1, usd: ' ' },
    { credits: { value: 1 }, usd: 0.1 },
    { credits: 1, usd: [0.1] },
    { credits: 1, usd: 'not-a-number' },
    [],
    null,
  ];
  for (const body of invalidBodies) {
    const api = createHiggsfieldApi({ env: { HF_API_KEY: 'fixture-key' }, fetchImpl: async () => response(body) });
    await assert.rejects(
      api.estimate({ model, prompt: 'fixture', params: { duration: 5 } }),
      error => error.code === 'PROVIDER_ERROR' && error.statusCode === 502 && error.code !== 'AMBIGUOUS_SUBMISSION',
      `invalid estimate body should be rejected: ${JSON.stringify(body)}`,
    );
  }
});

test('Higgsfield estimate timeout and invalid JSON remain non-ambiguous failures', async () => {
  const timeoutApi = createHiggsfieldApi({
    env: { HF_API_KEY: 'fixture-key' },
    fetchImpl: async () => { throw new Error('fixture timeout'); },
  });
  await assert.rejects(timeoutApi.estimate({ model, prompt: 'fixture', params: { duration: 5 } }), error => error.code === 'PROVIDER_UNAVAILABLE' && error.code !== 'AMBIGUOUS_SUBMISSION');

  const malformedApi = createHiggsfieldApi({
    env: { HF_API_KEY: 'fixture-key' },
    fetchImpl: async () => new Response('{not-json'),
  });
  await assert.rejects(malformedApi.estimate({ model, prompt: 'fixture', params: { duration: 5 } }), error => error.code === 'HIGGSFIELD_ERROR' && /invalid JSON/i.test(error.message) && error.code !== 'AMBIGUOUS_SUBMISSION');
});

test('Higgsfield REST create sends one stable Idempotency-Key and rejects header injection before fetch', async () => {
  const calls = [];
  const api = createHiggsfieldApi({
    env: { HF_API_KEY: 'fixture-key' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ request_id: 'provider-job', status: 'queued' });
    },
  });
  const first = await api.create({ model, prompt: 'fixture', params: { duration: 5 }, idempotencyKey: 'job-stable-1' });
  const second = await api.create({ model, prompt: 'fixture', params: { duration: 5 }, idempotencyKey: 'job-stable-1' });
  assert.equal(first.requestId, 'provider-job');
  assert.equal(second.requestId, 'provider-job');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'job-stable-1');
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'job-stable-1');
  assert.equal(calls[0].options.headers.authorization, 'Key fixture-key');

  let fetched = false;
  const protectedApi = createHiggsfieldApi({ env: { HF_API_KEY: 'fixture-key' }, fetchImpl: async () => { fetched = true; return response({}); } });
  for (const key of ['bad\r\nX-Evil: yes', 'bad\nX-Evil: yes', '']) {
    await assert.rejects(protectedApi.create({ model, prompt: 'fixture', params: { duration: 5 }, idempotencyKey: key }), error => error.code === 'INVALID_INPUT');
  }
  assert.equal(fetched, false);
});

async function queueFixture(t, transport) {
  const root = await mkdtemp(path.join(tmpdir(), `frameforge-white-${transport}-`));
  const store = new Store(root);
  const episode = store.create('episodes', {
    title: 'White studio fixture', topic: 'Fixture', channelId: store.list('channels')[0].id,
    version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Scene one', 'Preserve this scene')],
  });
  const createCalls = [];
  const provider = {
    transport,
    modelSchema: async () => ({ id: 'fixture_model', type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    create: async input => { createCalls.push(input); return { requestId: 'provider-job', status: 'queued', outputs: [], transport }; },
    status: async () => ({ requestId: 'provider-job', status: 'failed', outputs: [], transport }),
  };
  const queue = new GenerationQueue({ store, provider, pollIntervalMs: 1 });
  t.after(async () => { queue.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { queue, episode, createCalls };
}

test('generation queue uses persisted job identity for REST idempotency and leaves CLI provider input unchanged', async t => {
  const apiFixture = await queueFixture(t, 'api');
  const apiJob = await apiFixture.queue.start(apiFixture.episode.id, {
    requestId: 'request-api', expectedVersion: 1, sceneId: apiFixture.episode.scenes[0].id,
    model: 'fixture_model', prompt: 'fixture', params: {},
  });
  await assert.rejects(apiFixture.queue.wait(apiJob.id, { timeoutMs: 3000 }), /Provider did not complete/);
  assert.equal(apiFixture.createCalls.length, 1);
  assert.equal(apiFixture.createCalls[0].idempotencyKey, apiJob.id);
  assert.match(apiFixture.createCalls[0].idempotencyKey, /^[a-zA-Z0-9_-]+$/);

  const cliFixture = await queueFixture(t, 'cli');
  const cliJob = await cliFixture.queue.start(cliFixture.episode.id, {
    requestId: 'request-cli', expectedVersion: 1, sceneId: cliFixture.episode.scenes[0].id,
    model: 'fixture_model', prompt: 'fixture', params: {},
  });
  await assert.rejects(cliFixture.queue.wait(cliJob.id, { timeoutMs: 3000 }), /Provider did not complete/);
  assert.equal(cliFixture.createCalls.length, 1);
  assert.equal(Object.hasOwn(cliFixture.createCalls[0], 'idempotencyKey'), false);
});

function workflowFixture({ withGenerate = false, scriptAgent = 'studio' } = {}) {
  const ids = Object.fromEntries(['trend', 'research', 'script', 'storyboard', 'render', 'review', ...(withGenerate ? ['generate'] : [])].map(type => [type, `${type}-node`]));
  const order = withGenerate ? ['trend', 'research', 'script', 'storyboard', 'generate', 'render', 'review'] : ['trend', 'research', 'script', 'storyboard', 'render', 'review'];
  return {
    id: 'workflow-fixture', version: 2, name: 'Existing graph',
    nodes: order.map((type, index) => ({ id: ids[type], type, x: index * 10, y: 20, config: type === 'script' ? { agent: scriptAgent, prompt: '' } : type === 'generate' ? { model: model, prompt: 'existing', params: { duration: 5 }, sceneIndex: 0 } : {} })),
    edges: order.slice(1).map((type, index) => ({ id: `edge-${index}`, source: ids[order[index]], target: ids[type] })),
  };
}

function editorFixture(workflow) {
  const episodes = [{ id: 'episode-1', title: 'Episode one', scenes: [starterScene('A', 'Keep A'), starterScene('B', 'Keep B')] }];
  const calls = [];
  const api = async (url, options) => {
    calls.push({ url, method: options?.method || 'GET', body: options?.body });
    if (url === '/api/workflows') return [structuredClone(workflow)];
    if (url.endsWith('/runs') || url.endsWith('/history')) return [];
    if (url === '/api/generation/status') return { provider: 'higgsfield', configured: true, available: false, authenticated: false, detail: 'Fixture provider is not authenticated' };
    if (url === '/api/generation/models') return [{ id: model, name: 'Seedance fixture', type: 'video', transport: 'api' }];
    if (url.startsWith('/api/generation/models?model=')) return { id: model, type: 'video', parameters: [{ name: 'duration', type: 'integer', minimum: 4, maximum: 30 }] };
    throw new Error(`Unexpected editor API call: ${url}`);
  };
  const editor = createWorkflowEditor({ api, toast: () => {}, getEpisodes: () => episodes, hasEpisodeChanges: () => false });
  return { editor, calls, episodes, workflow };
}

test('openGeneration creates an unsaved draft without spend, preserves scenes, and keeps a valid graph', async () => {
  const existing = workflowFixture();
  const f = editorFixture(existing);
  const draft = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 1 });
  assert.equal(draft.id, undefined);
  assert.equal(draft.nodes.find(node => node.type === 'script').config.agent, 'existing');
  assert.equal(draft.nodes.find(node => node.type === 'generate').config.sceneIndex, 1);
  const generated = draft.nodes.find(node => node.type === 'generate');
  const storyboard = draft.nodes.find(node => node.type === 'storyboard');
  const render = draft.nodes.find(node => node.type === 'render');
  assert.ok(draft.edges.some(edge => edge.source === storyboard.id && edge.target === generated.id));
  assert.ok(draft.edges.some(edge => edge.source === generated.id && edge.target === render.id));
  assert.deepEqual(f.episodes[0].scenes.map(scene => scene.text), ['Keep A', 'Keep B']);
  assert.deepEqual(workflowErrors(draft), []);
  assert.equal(f.calls.some(call => call.method === 'POST' || call.url.includes('/generations')), false);
});
test('openGeneration preserves an appended unsaved scene identity without spending or mutating episodes', async () => {
  const existing = workflowFixture();
  const f = editorFixture(existing);
  f.episodes[0].scenes.push(starterScene('C', 'Keep appended C'));
  const before = structuredClone(f.episodes[0].scenes);
  const draft = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 2 });
  assert.equal(draft.nodes.find(node => node.type === 'generate').config.sceneIndex, 2);
  assert.deepEqual(f.episodes[0].scenes, before);
  assert.equal(f.calls.some(call => call.method === 'POST' || call.url.includes('/api/trends') || call.url.includes('/generations')), false);
  assert.ok(f.calls.some(call => call.url === '/api/generation/models'));
  assert.ok(f.calls.some(call => call.url.startsWith('/api/generation/models?model=')));
});


test('openGeneration targets an existing generation node without replacing graph or scene content', async () => {
  const existing = workflowFixture({ withGenerate: true, scriptAgent: 'existing' });
  const originalGraph = structuredClone(existing);
  const f = editorFixture(existing);
  const result = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 1 });
  assert.equal(result.id, existing.id);
  assert.equal(result.nodes.find(node => node.type === 'generate').config.sceneIndex, 1);
  assert.deepEqual(result.nodes.map(node => node.id), originalGraph.nodes.map(node => node.id));
  assert.deepEqual(result.edges, originalGraph.edges);
  assert.equal(result.nodes.find(node => node.type === 'script').config.agent, 'existing');
  assert.equal(f.calls.some(call => call.method === 'POST' || call.url.includes('/generations')), false);
});

test('openGeneration makes a safe five-node draft instead of reusing a saved studio chain', async () => {
  const existing = workflowFixture({ withGenerate: true, scriptAgent: 'studio' });
  const originalGraph = structuredClone(existing);
  const f = editorFixture(existing);
  const result = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 1 });
  assert.equal(result.id, undefined);
  assert.equal(result.nodes.length, 5);
  assert.equal(result.nodes.find(node => node.type === 'script').config.agent, 'existing');
  assert.equal(result.nodes.find(node => node.type === 'generate').config.sceneIndex, 1);
  assert.notDeepEqual(result.nodes.map(node => node.id), originalGraph.nodes.map(node => node.id));
  assert.deepEqual(existing, originalGraph);
  assert.deepEqual(workflowErrors(result), []);
  assert.equal(f.calls.some(call => call.method === 'POST' || call.url.includes('/generations')), false);
});

