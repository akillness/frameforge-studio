import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHiggsfieldApi } from '../server/higgsfield.mjs';
import { GenerationQueue } from '../server/generations.mjs';
import { Store, starterScene } from '../server/store.mjs';
import { addWorkflowNode, createWorkflowEditor, fitWorkflowCanvas, workflowCanvasHintText, workflowErrors, workflowRunHistoryHtml } from '../public/workflow.js';

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
    nodes: order.map((type, index) => ({ id: ids[type], type, x: index * 10, y: 20, config: type === 'script' ? { agent: scriptAgent, prompt: '' } : type === 'generate' ? { model: model, prompt: 'existing', params: { duration: 5 }, sceneIndex: 1 } : {} })),
    edges: order.slice(1).map((type, index) => ({ id: `edge-${index}`, source: ids[order[index]], target: ids[type] })),
  };
}

async function editorFixture(t, templateGraph) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-white-editor-'));
  const store = new Store(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const channel = store.list('channels')[0];
  const episodes = [store.create('episodes', { id: 'episode-1', channelId: channel.id, version: 1, status: 'draft', format: '9:16', title: 'Episode one', topic: 'Local editor fixture', scenes: [starterScene('A', 'Keep A'), starterScene('B', 'Keep B')] })];
  const template = store.create('workflows', templateGraph);
  const workflow = store.createWorkflowCopy({ templateId: template.id, expectedTemplateVersion: template.version, episodeId: episodes[0].id, channelId: channel.id });
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

test('openGeneration adds an unsaved node to the owned project graph without spend or scene replacement', async t => {
  const existing = workflowFixture();
  const f = await editorFixture(t, existing);
  const draft = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 1 });
  assert.equal(draft.id, f.workflow.id);
  assert.equal(draft.templateId, existing.id);
  assert.equal(draft.nodes.find(node => node.type === 'script').config.agent, 'studio');
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
test('openGeneration preserves an appended unsaved scene identity without spending or mutating episodes', async t => {
  const existing = workflowFixture();
  const f = await editorFixture(t, existing);
  f.episodes[0].scenes.push(starterScene('C', 'Keep appended C'));
  const before = structuredClone(f.episodes[0].scenes);
  const draft = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 2 });
  assert.equal(draft.nodes.find(node => node.type === 'generate').config.sceneIndex, 2);
  assert.deepEqual(f.episodes[0].scenes, before);
  assert.equal(f.calls.some(call => call.method === 'POST' || call.url.includes('/api/trends') || call.url.includes('/generations')), false);
  assert.equal(f.calls.some(call => call.url.startsWith('/api/generation/models')), false, 'opening a local draft must not search provider models');
});


test('openGeneration targets an existing generation node without replacing graph or scene content', async t => {
  const existing = workflowFixture({ withGenerate: true, scriptAgent: 'existing' });
  const originalGraph = structuredClone(existing);
  const f = await editorFixture(t, existing);
  const result = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 1 });
  assert.equal(result.id, f.workflow.id);
  assert.equal(result.nodes.find(node => node.type === 'generate').config.sceneIndex, 1);
  assert.deepEqual(result.nodes.map(node => node.id), originalGraph.nodes.map(node => node.id));
  assert.deepEqual(result.edges, originalGraph.edges);
  assert.equal(result.nodes.find(node => node.type === 'script').config.agent, 'existing');
  assert.equal(f.calls.some(call => call.method === 'POST' || call.url.includes('/generations')), false);
});

test('openGeneration preserves the owned studio chain and its template while targeting the selected scene', async t => {
  const existing = workflowFixture({ withGenerate: true, scriptAgent: 'studio' });
  const originalGraph = structuredClone(existing);
  const f = await editorFixture(t, existing);
  const result = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 1 });
  assert.equal(result.id, f.workflow.id);
  assert.notEqual(result.id, existing.id);
  assert.equal(result.nodes.length, originalGraph.nodes.length);
  assert.equal(result.nodes.find(node => node.type === 'script').config.agent, 'studio');
  assert.equal(result.nodes.find(node => node.type === 'generate').config.sceneIndex, 1);
  assert.deepEqual(result.nodes.map(node => node.id), originalGraph.nodes.map(node => node.id));
  assert.deepEqual(result.edges, originalGraph.edges);
  assert.deepEqual(existing, originalGraph);
  assert.deepEqual(workflowErrors(result), []);
  assert.equal(f.calls.some(call => call.method === 'POST' || call.url.includes('/generations')), false);
});

test('workflow run history renders collapsed searchable pages with traceable run summaries', () => {
  const html = workflowRunHistoryHtml({
    items: [{
      id: 'run-123', workflowId: 'workflow-1', workflowName: 'Research flow', workflowVersion: 4,
      episodeId: 'episode-2', episodeTitle: 'Source check', episodeVersion: 7, status: 'failed',
      createdAt: '2026-10-19T03:00:00.000Z', nodeRuns: [{ nodeId: 'script-1', type: 'script', status: 'failed' }],
    }],
    total: 21, page: 2, pageSize: 20, pageCount: 2,
  }, 'source');

  assert.match(html, /<details class="wf-history-record" data-run-id="run-123">/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /data-run-history-search/);
  assert.match(html, /run-123/);
  assert.match(html, /workflow-1/);
  assert.match(html, /episode-2/);
  assert.match(html, /data-wf-action="history-page" data-page="1"/);
  assert.match(html, /data-wf-action="history-page" data-page="2"/);
  assert.match(html, /검색 결과 21개 · 2\/2 페이지/);
});

test('workflow canvas auto-fit scales uniformly and keeps graph bounds inside the resized viewport', () => {
  const nodes = [0, 1, 2, 3, 4, 5].map(index => ({ x: 80 + index * 260, y: 180, type: 'stage' }));
  const fit = fitWorkflowCanvas(nodes, 1019, 540);
  const left = Math.min(...nodes.map(node => node.x));
  const right = Math.max(...nodes.map(node => node.x + 210));
  const top = Math.min(...nodes.map(node => node.y));
  const bottom = Math.max(...nodes.map(node => node.y + 140));
  assert.ok(fit.scale > 0 && fit.scale < 1);
  assert.ok(fit.pan.x + left * fit.scale >= 0);
  assert.ok(fit.pan.x + right * fit.scale <= 1019);
  assert.ok(fit.pan.y + top * fit.scale >= 0);
  assert.ok(fit.pan.y + bottom * fit.scale <= 490);
  const mobile = fitWorkflowCanvas(nodes, 326, 420);
  assert.deepEqual(mobile, { scale: 1, pan: { x: 0, y: 0 }, layout: 'stacked' });
  const tablet = fitWorkflowCanvas(nodes, 631, 460);
  assert.deepEqual(tablet, { scale: 1, pan: { x: 0, y: 0 }, layout: 'stacked' });
  assert.match(workflowCanvasHintText('stacked'), /목록.*설정.*입력\/출력/);
  assert.match(workflowCanvasHintText('canvas'), /드래그.*확대\/축소/);
});

test('adding a workflow node inserts it at its stage position and rewires adjacent stages', () => {
  const workflow = {
    name: 'Connected flow',
    nodes: [
      { id: 'script', type: 'script', x: 0, y: 0, config: {} },
      { id: 'storyboard', type: 'storyboard', x: 1, y: 0, config: {} },
      { id: 'render', type: 'render', x: 2, y: 0, config: {} },
      { id: 'review', type: 'review', x: 3, y: 0, config: {} },
    ],
    edges: [
      { id: 'a', source: 'script', target: 'storyboard' },
      { id: 'b', source: 'storyboard', target: 'render' },
      { id: 'c', source: 'render', target: 'review' },
    ],
  };
  const result = addWorkflowNode(workflow, 'generate', { id: 'generate', x: 99, y: 42, config: { model: 'fixture' } });
  assert.deepEqual(result.nodes.map(node => node.id), ['script', 'storyboard', 'generate', 'render', 'review']);
  assert.ok(result.edges.some(edge => edge.source === 'storyboard' && edge.target === 'generate'));
  assert.ok(result.edges.some(edge => edge.source === 'generate' && edge.target === 'render'));
  assert.equal(result.edges.some(edge => edge.source === 'storyboard' && edge.target === 'render'), false);
  assert.deepEqual(workflowErrors(result), []);
  assert.equal(workflow.nodes.some(node => node.id === 'generate'), false);
  const repeated = addWorkflowNode(result, 'generate', { id: 'generate-second', afterNodeId: 'generate' });
  assert.deepEqual(repeated.nodes.filter(node => node.type === 'generate').map(node => node.id), ['generate', 'generate-second']);
  assert.ok(repeated.edges.some(edge => edge.source === 'generate' && edge.target === 'generate-second'));
  assert.ok(repeated.edges.some(edge => edge.source === 'generate-second' && edge.target === 'render'));
  assert.equal(repeated.edges.some(edge => edge.source === 'generate' && edge.target === 'render'), false);
  assert.deepEqual(workflowErrors(repeated), []);
  assert.equal(result.nodes.length, 5, 'inserting a repeated role must not mutate the original graph');
  assert.throws(() => addWorkflowNode(repeated, 'generate', { id: 'generate-second' }), /ID/);
  assert.throws(() => addWorkflowNode(repeated, 'generate', { id: 'third', afterNodeId: 'missing' }));
  assert.throws(() => addWorkflowNode({ ...result, nodes: Array.from({ length: 128 }, (_, i) => ({ id: `node-${i}`, type: 'script' })) }, 'script', { id: 'overflow' }), /128/);
  assert.throws(() => addWorkflowNode({ ...result, edges: Array.from({ length: 256 }, (_, i) => ({ id: `edge-${i}`, source: 'script', target: 'storyboard' })) }, 'generate', { id: 'edge-overflow', afterNodeId: 'generate' }), /256/);
  assert.ok(workflowErrors({ ...repeated, nodes: [...repeated.nodes, repeated.nodes[0]] }).length, 'duplicate node identities remain invalid');
  assert.ok(workflowErrors({ ...repeated, edges: [...repeated.edges, { id: 'cycle', source: 'review', target: 'script' }] }).length, 'cycles remain invalid');
  const ambiguous = { ...result, nodes: [...result.nodes, { id: 'render-alternate', type: 'render', x: 4, y: 1, config: {} }], edges: [...result.edges, { id: 'fork', source: 'generate', target: 'render-alternate' }, { id: 'merge', source: 'render-alternate', target: 'review' }] };
  assert.ok(workflowErrors(ambiguous).length, 'a review cannot guess between two connected render candidates');
});

