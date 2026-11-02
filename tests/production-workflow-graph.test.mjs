// RED-first regression tests for the PW-02 repeated-node workflow graph contract
// (.mex/context/decisions.md, "Repeated-node implementation contract").
// Exercises the exported validateWorkflow/WorkflowEngine surfaces from server/workflows.mjs.
// Does not import or assume any new method/field names beyond those two exports plus the
// existing createApp HTTP surface already used by tests/workflows.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-graph-'));
  let renderCount = 0;
  const renderer = async (_episode, { dataDir, sceneIntegrity = [] }) => {
    // This suite's episodes are text-only. Keep that contract explicit rather than
    // fabricating byte receipts if a future case adds scene media.
    assert.deepEqual(sceneIntegrity, [], 'media-bearing fixtures must use a renderer that verifies their bytes');
    renderCount++;
    const filename = `graph-fixture-${renderCount}.mp4`;
    const bytes = Buffer.from('fixture only');
    await writeFile(path.join(dataDir, 'exports', filename), bytes);
    return { filename, outputUrl: `/api/exports/${filename}`, sha256: createHash('sha256').update(bytes).digest('hex'), verifiedSceneAssets: [] };
  };
  let server, base;
  const start = async () => { server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations: baseIntegrations, renderer, ...overrides }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; };
  const stop = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await start();
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (url, method = 'GET', body) => fetch(base + url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const state = await (await request('/api/state')).json();
  const episode = await (await request('/api/episodes', 'POST', { channelId: state.channels[0].id, title: 'Graph contract', topic: 'Repeated node coverage' })).json();
  return { request, episode, dataDir, renderCount: () => renderCount };
}

async function waitRun(fixture, id, statuses = ['awaiting_review', 'completed', 'failed', 'cancelled']) {
  for (let i = 0; i < 200; i++) {
    const runs = await (await fixture.request('/api/workflow-runs')).json();
    const run = (Array.isArray(runs) ? runs : runs.items || []).find((item) => item.id === id);
    if (run && statuses.includes(run.status)) {
      const response = await fixture.request(`/api/workflow-runs/${id}`);
      assert.equal(response.status, 200, 'node output assertions require the detailed run, not the sanitized list');
      const detailed = await response.json();
      assert.equal(detailed.id, id);
      return detailed;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Workflow run did not reach expected state');
}

/** Builds a fully connected, strictly acyclic chain (n0 -> n1 -> ... ) of a single repeated
 * supported type, padded with forward "shortcut" edges up to exactly edgeCount edges. The base
 * chain is always included first, so connectivity and acyclicity hold at any boundary tested. */
function denseAcyclicGraph(nodeCount, edgeCount) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}`, type: 'trend', x: i, y: 0 }));
  const chain = Array.from({ length: nodeCount - 1 }, (_, i) => ({ id: `chain-${i}`, source: `n${i}`, target: `n${i + 1}` }));
  const shortcuts = [];
  for (let i = 0; i < nodeCount && chain.length + shortcuts.length < edgeCount; i++) {
    for (let j = i + 2; j < nodeCount && chain.length + shortcuts.length < edgeCount; j++) {
      shortcuts.push({ id: `short-${i}-${j}`, source: `n${i}`, target: `n${j}` });
    }
  }
  return { name: `Dense acyclic graph ${nodeCount}x${edgeCount}`, nodes, edges: [...chain, ...shortcuts].slice(0, edgeCount) };
}

function parallelRenderReviewWorkflow() {
  return {
    name: 'Parallel render-review branches',
    nodes: [
      { id: 'script', type: 'script', x: 0, y: 0, config: { agent: 'studio' } },
      { id: 'storyboard', type: 'storyboard', x: 100, y: 0 },
      { id: 'render-1', type: 'render', x: 200, y: -80 },
      { id: 'review-1', type: 'review', x: 300, y: -80 },
      { id: 'render-2', type: 'render', x: 200, y: 80 },
      { id: 'review-2', type: 'review', x: 300, y: 80 },
    ],
    edges: [
      { id: 'edge-script-storyboard', source: 'script', target: 'storyboard' },
      { id: 'edge-storyboard-render1', source: 'storyboard', target: 'render-1' },
      { id: 'edge-render1-review1', source: 'render-1', target: 'review-1' },
      { id: 'edge-storyboard-render2', source: 'storyboard', target: 'render-2' },
      { id: 'edge-render2-review2', source: 'render-2', target: 'review-2' },
    ],
  };
}

// --- Group 1: repeated supported types with distinct IDs are legal, with real cycle/connectivity
// --- enforcement replacing the old one-type-per-node and type-order edge rules.

test('repeated supported node types validate with distinct IDs and a same-type edge between them when acyclic', () => {
  const normalized = validateWorkflow({
    name: 'Repeated trend instances',
    nodes: [
      { id: 'trend-a', type: 'trend', x: 0, y: 0, config: { query: 'first' } },
      { id: 'trend-b', type: 'trend', x: 100, y: 0, config: { query: 'second' } },
    ],
    edges: [{ id: 'edge-a-b', source: 'trend-a', target: 'trend-b' }],
  });
  assert.deepEqual(normalized.nodes.map((node) => node.id), ['trend-a', 'trend-b']);
  assert.deepEqual(normalized.nodes.map((node) => node.type), ['trend', 'trend']);
  assert.deepEqual(normalized.edges.map(({ source, target }) => `${source}->${target}`), ['trend-a->trend-b']);
});

test('a genuine cycle among repeated same-type nodes is rejected by real cycle detection, not a same-type-edge ban', () => {
  assert.throws(() => validateWorkflow({
    name: 'Same-type cycle',
    nodes: [
      { id: 'cycle-a', type: 'trend', x: 0, y: 0 },
      { id: 'cycle-b', type: 'trend', x: 100, y: 0 },
      { id: 'cycle-c', type: 'trend', x: 200, y: 0 },
    ],
    edges: [
      { id: 'e-ab', source: 'cycle-a', target: 'cycle-b' },
      { id: 'e-bc', source: 'cycle-b', target: 'cycle-c' },
      { id: 'e-ca', source: 'cycle-c', target: 'cycle-a' },
    ],
  }), { status: 400 });
});

test('a self-referencing edge remains rejected once same-type edges become generally valid', () => {
  assert.throws(() => validateWorkflow({
    name: 'Self edge',
    nodes: [{ id: 'self-trend', type: 'trend', x: 0, y: 0 }],
    edges: [{ id: 'e-self', source: 'self-trend', target: 'self-trend' }],
  }), { status: 400 });
});

test('duplicate node IDs across different supported types are rejected', () => {
  assert.throws(() => validateWorkflow({
    name: 'Duplicate ID across types',
    nodes: [
      { id: 'dup', type: 'trend', x: 0, y: 0 },
      { id: 'dup', type: 'research', x: 100, y: 0 },
    ],
    edges: [],
  }), { status: 400 });
});

test('duplicate edge IDs and duplicate source/target endpoint pairs are both rejected', () => {
  const nodes = [
    { id: 'edge-trend', type: 'trend', x: 0, y: 0 },
    { id: 'edge-research', type: 'research', x: 100, y: 0 },
    { id: 'edge-script', type: 'script', x: 200, y: 0, config: { agent: 'studio' } },
  ];
  assert.throws(() => validateWorkflow({
    name: 'Duplicate edge id', nodes,
    edges: [
      { id: 'dup-edge', source: 'edge-trend', target: 'edge-research' },
      { id: 'dup-edge', source: 'edge-trend', target: 'edge-script' },
    ],
  }), { status: 400 }, 'two edges sharing one id must be rejected even with different, individually valid endpoints');
  assert.throws(() => validateWorkflow({
    name: 'Duplicate endpoint pair', nodes: nodes.slice(0, 2),
    edges: [
      { id: 'edge-1', source: 'edge-trend', target: 'edge-research' },
      { id: 'edge-2', source: 'edge-trend', target: 'edge-research' },
    ],
  }), { status: 400 }, 'two distinct edge ids connecting the identical source/target pair must be rejected');
});

test('edges referencing an unknown node id are rejected', () => {
  assert.throws(() => validateWorkflow({
    name: 'Unknown endpoint',
    nodes: [{ id: 'only-node', type: 'trend', x: 0, y: 0 }],
    edges: [{ id: 'e1', source: 'only-node', target: 'missing-node' }],
  }), { status: 400 });
});

test('a node with no edges touching it is rejected even though every individual edge is otherwise valid', () => {
  assert.throws(() => validateWorkflow({
    name: 'Disconnected node',
    nodes: [
      { id: 'conn-trend', type: 'trend', x: 0, y: 0 },
      { id: 'conn-research', type: 'research', x: 100, y: 0 },
      { id: 'isolated-script', type: 'script', x: 200, y: 0, config: { agent: 'studio' } },
    ],
    edges: [{ id: 'e1', source: 'conn-trend', target: 'conn-research' }],
  }), { status: 400 });
});

test('a node ID equal to its own type is a valid exact ID, but an ID equal to a different supported type is rejected as shadowing', () => {
  const selfNamed = validateWorkflow({
    name: 'Self-named id',
    nodes: [{ id: 'render', type: 'render', x: 0, y: 0 }],
    edges: [],
  });
  assert.equal(selfNamed.nodes[0].id, 'render');
  assert.equal(selfNamed.nodes[0].type, 'render');
  assert.throws(() => validateWorkflow({
    name: 'Shadowing a different type',
    nodes: [{ id: 'render', type: 'layout', x: 0, y: 0, config: {} }],
    edges: [],
  }), { status: 400 }, 'an id equal to a type name must not be reused for a DIFFERENT node type');
});

test('the engineering graph bounds are exactly 128 nodes and 256 edges, independent of the number of supported stage types', () => {
  const atNodeCap = validateWorkflow(denseAcyclicGraph(128, 127));
  assert.equal(atNodeCap.nodes.length, 128);
  assert.throws(() => validateWorkflow(denseAcyclicGraph(129, 128)), { status: 400 }, 'one node beyond the 128 cap must still be rejected');

  const atEdgeCap = validateWorkflow(denseAcyclicGraph(24, 256));
  assert.equal(atEdgeCap.edges.length, 256);
  assert.throws(() => validateWorkflow(denseAcyclicGraph(24, 257)), { status: 400 }, 'one edge beyond the 256 cap must still be rejected');
});

// --- Group 2: execution order must come from actual edges, never node-array position or TYPES
// --- index, and selection must resolve by exact node ID, never role-type shorthand.

test('deterministic execution order follows real edges across shuffled same-type nodes, not array position or type order', async (t) => {
  const calls = [];
  const f = await setup(t, {
    integrations: {
      ...baseIntegrations,
      fetchTrends: async () => { const keyword = ['first', 'second', 'third'][calls.length]; calls.push(keyword); return { trends: [{ keyword, source: 'Fixture RSS', url: 'https://example.com/trend' }], sources: [] }; },
    },
  });
  const workflow = {
    name: 'Shuffled same-type trend chain',
    nodes: [
      { id: 'trend-c', type: 'trend', x: 0, y: 0, config: { query: 'third' } },
      { id: 'trend-a', type: 'trend', x: 100, y: 0, config: { query: 'first' } },
      { id: 'trend-b', type: 'trend', x: 200, y: 0, config: { query: 'second' } },
    ],
    edges: [
      { id: 'edge-a-b', source: 'trend-a', target: 'trend-b' },
      { id: 'edge-b-c', source: 'trend-b', target: 'trend-c' },
    ],
  };
  const createResponse = await ownedResponse(f, await f.request('/api/workflows', 'POST', workflow));
  assert.equal(createResponse.status, 201, 'a same-type edge chain with shuffled node array order must validate when acyclic');
  const created = await createResponse.json();
  const startResponse = await f.request(`/api/workflows/${created.id}/run`, 'POST', { episodeId: f.episode.id });
  assert.equal(startResponse.status, 202);
  const run = await waitRun(f, (await startResponse.json()).id, ['completed', 'failed', 'cancelled']);
  assert.equal(run.status, 'completed');
  assert.deepEqual(calls, ['first', 'second', 'third'], 'execution must follow the edge-defined order (a, b, c), not the shuffled node array order (c, a, b)');
});

test('selectedStages and startStage resolve by exact node ID only; a literal ID equal to a type name still resolves but a bare type string that is not an ID is rejected', async (t) => {
  const f = await setup(t);
  const template = defaultWorkflow();
  const workflow = {
    ...template,
    name: 'ID vs type shorthand workflow',
    nodes: template.nodes.map((node) => node.type === 'script' ? { ...node, id: 'main-script' } : node),
    edges: template.edges.map((edge) => ({
      ...edge,
      source: edge.source === 'script' ? 'main-script' : edge.source,
      target: edge.target === 'script' ? 'main-script' : edge.target,
    })),
  };
  const created = await (await ownedResponse(f, await f.request('/api/workflows', 'POST', workflow))).json();
  assert.equal(created.nodes.find((node) => node.type === 'script').id, 'main-script');

  const byId = await f.request(`/api/workflows/${created.id}/run`, 'POST', {
    episodeId: f.episode.id,
    selectedStages: ['trend', 'research', 'main-script', 'storyboard', 'render', 'review'],
    startStage: 'trend',
  });
  assert.equal(byId.status, 202, 'a literal node id equal to its own type name ("render", "review", ...) must still resolve for selection');
  const run = await waitRun(f, (await byId.json()).id);
  assert.equal(run.status, 'awaiting_review', 'exact-id selection must execute the full DAG successfully');

  const byType = await f.request(`/api/workflows/${created.id}/run`, 'POST', {
    episodeId: f.episode.id,
    selectedStages: ['trend', 'research', 'script', 'storyboard', 'render', 'review'],
    startStage: 'trend',
  });
  assert.equal(byType.status, 400, 'a bare type string ("script") that is not any node\'s literal id must be rejected, not resolved as role-type shorthand');
});

test('selected stages after startStage must be downstream per actual edges, not merely a later TYPES index, among repeated-type nodes', async (t) => {
  const f = await setup(t, {
    integrations: { ...baseIntegrations, fetchTrends: async () => ({ trends: [{ keyword: 'a b c', source: 'Fixture RSS', url: 'https://example.com/trend' }], sources: [] }) },
  });
  const workflow = {
    name: 'Same-type chain for downstream enforcement',
    nodes: [
      { id: 'trend-a', type: 'trend', x: 0, y: 0, config: { query: 'a' } },
      { id: 'trend-b', type: 'trend', x: 100, y: 0, config: { query: 'b' } },
      { id: 'trend-c', type: 'trend', x: 200, y: 0, config: { query: 'c' } },
    ],
    edges: [
      { id: 'edge-a-b', source: 'trend-a', target: 'trend-b' },
      { id: 'edge-b-c', source: 'trend-b', target: 'trend-c' },
    ],
  };
  const createResponse = await ownedResponse(f, await f.request('/api/workflows', 'POST', workflow));
  assert.equal(createResponse.status, 201, 'a linear same-type edge chain must validate when acyclic');
  const created = await createResponse.json();

  const validResponse = await f.request(`/api/workflows/${created.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: ['trend-b', 'trend-c'], startStage: 'trend-b' });
  assert.equal(validResponse.status, 202, 'selecting a start node and its genuine edge-downstream node must be accepted');
  const validRun = await waitRun(f, (await validResponse.json()).id, ['completed', 'failed', 'cancelled']);
  assert.equal(validRun.status, 'completed');
  assert.equal(validRun.nodeRuns.find((node) => node.nodeId === 'trend-a').status, 'skipped');

  const invalidResponse = await f.request(`/api/workflows/${created.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: ['trend-a', 'trend-b'], startStage: 'trend-b' });
  assert.equal(invalidResponse.status, 400, 'selecting a genuine edge-upstream node of startStage must be rejected even though same-type nodes share one TYPES index');
});

// --- Group 3: every node instance must satisfy its OWN upstream prerequisite via actual edges;
// --- selecting the "wrong" same-type sibling as a dependency is not acceptable.

test('parallel render->review branches each bind to their own edge-connected render, not the first node of that type', async (t) => {
  const f = await setup(t);
  const createResponse = await ownedResponse(f, await f.request('/api/workflows', 'POST', parallelRenderReviewWorkflow()));
  assert.equal(createResponse.status, 201, 'two independent render->review branches sharing one storyboard ancestor must validate as a repeated-role workflow');
  const workflow = await createResponse.json();

  const startResponse = await f.request(`/api/workflows/${workflow.id}/run`, 'POST', {
    episodeId: f.episode.id,
    selectedStages: ['script', 'storyboard', 'render-2', 'review-2'],
    startStage: 'script',
  });
  assert.equal(startResponse.status, 202, 'selecting the second branch by exact node id must not be rejected by a first-matching-type render lookup');
  const run = await waitRun(f, (await startResponse.json()).id);
  assert.equal(run.status, 'awaiting_review');
  assert.equal(f.renderCount(), 1, 'the unselected first branch render must never actually invoke the renderer');

  const render1 = run.nodeRuns.find((node) => node.nodeId === 'render-1');
  const render2 = run.nodeRuns.find((node) => node.nodeId === 'render-2');
  const review2 = run.nodeRuns.find((node) => node.nodeId === 'review-2');
  assert.equal(render1.status, 'skipped', 'the unselected first render branch must not execute');
  assert.equal(render2.status, 'completed');
  assert.equal(review2.status, 'awaiting_review');
  assert.ok(review2.output?.render, `review-2 lost its connected render output: ${JSON.stringify(review2)}`);
  assert.equal(review2.output.render.jobId, render2.output.jobId, 'review-2 must bind to its own edge-connected render-2 candidate, not any other render node');

  const reviewResponse = await f.request(`/api/workflows/${workflow.id}/runs/${run.id}/review`, 'POST', {
    reviewNodeId: 'review-2', decision: 'approved', notes: 'Approve branch 2 candidate.', expectedEpisodeVersion: run.episodeVersion,
  });
  assert.equal(reviewResponse.status, 200, 'approving the branch-2 awaiting_review candidate by its exact reviewNodeId must succeed and bind to render-2, not fall back to render-1');
  const reviewed = await reviewResponse.json();
  assert.equal(reviewed.reviews['review-2'].jobId, render2.output.jobId);
  assert.equal(reviewed.reviews['review-2'].outputUrl, render2.output.outputUrl);
});

function producerChainWorkflow() {
  return {
    name: 'Sequential render-review producer chain',
    nodes: [
      { id: 'script', type: 'script', x: 0, y: 0, config: { agent: 'studio' } },
      { id: 'storyboard', type: 'storyboard', x: 100, y: 0 },
      { id: 'render-1', type: 'render', x: 200, y: 0 },
      { id: 'review-1', type: 'review', x: 300, y: 0 },
      { id: 'render-2', type: 'render', x: 400, y: 0 },
      { id: 'review-2', type: 'review', x: 500, y: 0 },
    ],
    edges: [
      { id: 'edge-script-storyboard', source: 'script', target: 'storyboard' },
      { id: 'edge-storyboard-render1', source: 'storyboard', target: 'render-1' },
      { id: 'edge-render1-review1', source: 'render-1', target: 'review-1' },
      { id: 'edge-review1-render2', source: 'review-1', target: 'render-2' },
      { id: 'edge-render2-review2', source: 'render-2', target: 'review-2' },
    ],
  };
}

function ambiguousMergeWorkflow() {
  return {
    name: 'Ambiguous parallel merge into one review',
    nodes: [
      { id: 'script', type: 'script', x: 0, y: 0, config: { agent: 'studio' } },
      { id: 'storyboard', type: 'storyboard', x: 100, y: 0 },
      { id: 'render-left', type: 'render', x: 200, y: -60 },
      { id: 'render-right', type: 'render', x: 200, y: 60 },
      { id: 'review-merge', type: 'review', x: 300, y: 0 },
    ],
    edges: [
      { id: 'edge-script-storyboard', source: 'script', target: 'storyboard' },
      { id: 'edge-storyboard-render-left', source: 'storyboard', target: 'render-left' },
      { id: 'edge-storyboard-render-right', source: 'storyboard', target: 'render-right' },
      { id: 'edge-render-left-review', source: 'render-left', target: 'review-merge' },
      { id: 'edge-render-right-review', source: 'render-right', target: 'review-merge' },
    ],
  };
}

// --- Group 4: a shared boundary resolver must walk each incoming path to its NEAREST producer
// --- of the requested type (not any ancestor, not the first node of that type). A repeated-role
// --- chain binds the nearest producer; two equally-near producers into one consumer is a genuine
// --- ambiguity that must be rejected, never silently resolved to either candidate.

test('a sequential repeated producer chain (render1->review1->render2->review2) binds review2 to its nearest render, not an earlier reused producer', async (t) => {
  const f = await setup(t);
  const createResponse = await ownedResponse(f, await f.request('/api/workflows', 'POST', producerChainWorkflow()));
  assert.equal(createResponse.status, 201, 'a linear render->review->render->review producer chain must validate as a repeated-role acyclic graph');
  const workflow = await createResponse.json();

  const firstResponse = await f.request(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: ['script', 'storyboard', 'render-1', 'review-1'], startStage: 'script' });
  assert.equal(firstResponse.status, 202);
  const first = await waitRun(f, (await firstResponse.json()).id);
  assert.equal(first.status, 'awaiting_review');
  const render1 = first.nodeRuns.find((node) => node.nodeId === 'render-1');
  assert.equal(render1.status, 'completed');

  const secondResponse = await f.request(`/api/workflows/${workflow.id}/run`, 'POST', {
    episodeId: f.episode.id,
    selectedStages: ['render-2', 'review-2'],
    startStage: 'render-2',
    resumeRunId: first.id,
  });
  assert.equal(secondResponse.status, 202, 'resuming to the second render-review pair must not be rejected by a first-matching-type render lookup');
  const second = await waitRun(f, (await secondResponse.json()).id);
  assert.equal(second.status, 'awaiting_review');
  assert.equal(f.renderCount(), 2, 'render-2 must actually execute as a fresh candidate, not silently reuse render-1');

  const render2 = second.nodeRuns.find((node) => node.nodeId === 'render-2');
  const review2 = second.nodeRuns.find((node) => node.nodeId === 'review-2');
  assert.equal(render2.status, 'completed');
  assert.equal(review2.status, 'awaiting_review');
  assert.ok(review2.output?.render, `review-2 lost its nearest producer output: ${JSON.stringify(review2)}`);
  assert.equal(review2.output.render.jobId, render2.output.jobId, 'review-2 must bind to its nearest producer render-2, not the earlier reused render-1 candidate');
  assert.notEqual(review2.output.render.jobId, render1.output.jobId, "review-2 must not bind to render-1's stale job even though render-1 is also an ancestor");
});

test('a review node fed by two equally-near render candidates is a genuine ambiguous merge and must be rejected, not silently resolved to either one', async (t) => {
  const f = await setup(t);
  const createResponse = await f.request('/api/workflows', 'POST', ambiguousMergeWorkflow());
  assert.equal(createResponse.status, 201, 'two render producers feeding one review must still validate structurally as an acyclic repeated-role graph');
  const workflow = await createResponse.json();

  const startResponse = await f.request(`/api/workflows/${workflow.id}/run`, 'POST', {
    episodeId: f.episode.id,
    selectedStages: ['script', 'storyboard', 'render-left', 'render-right', 'review-merge'],
    startStage: 'script',
  });
  assert.equal(startResponse.status, 409, 'an ambiguous equally-near render merge into one review must be rejected rather than silently bound to either render-left or render-right');
});

async function ownedResponse(f, response) {
  assert.equal(response.status, 201, 'real shared template setup validates');
  const template = await response.json();
  return f.request(`/api/workflows/${template.id}/copies`, 'POST', { episodeId: f.episode.id, channelId: f.episode.channelId, expectedTemplateVersion: template.version });
}
