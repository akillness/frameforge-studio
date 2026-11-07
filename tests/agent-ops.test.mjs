import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentOperations, OPERATIONS_VERSION, SCRIPT_AGENTS } from '../server/agent-ops.mjs';
import { Store } from '../server/store.mjs';
import { WorkflowEngine, NODE_CONFIG_FIELDS, TYPES } from '../server/workflows.mjs';
import { HttpError } from '../server/validation.mjs';
import { validateSchema } from '../server/schema.mjs';

const EXPECTED_OPERATIONS = [
  'episode_create', 'episode_get', 'episode_list', 'episode_propose_storyboard', 'episode_render', 'episode_update',
  'render_job_get', 'workflow_auto_layout', 'workflow_copy_from_template', 'workflow_get', 'workflow_list', 'workflow_node_types',
  'workflow_patch', 'workflow_plan', 'workflow_propose_blueprint', 'workflow_quote', 'workflow_run_cancel', 'workflow_run_get',
  'workflow_run_list', 'workflow_run_start', 'workflow_set_skip', 'workflow_validate',
];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real Store and WorkflowEngine over a temp directory. Everything that could cost money or leave
 * the machine is a recorder that the test asserts was never touched on the paths under test.
 */
async function fixture(t, { allowPaidGeneration = false, runAgent, validateAssets = (scenes) => scenes } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-agent-ops-'));
  const store = new Store(dataDir);
  const boundary = { generations: [], renders: [], providerCalls: [] };
  const touched = (what) => { boundary.generations.push(what); throw new Error(`generation boundary touched: ${what}`); };
  const provider = new Proxy({}, { get: (_, property) => () => touched(`provider.${String(property)}`) }); // reading the handle is harmless; calling it is spending
  const generations = new Proxy({ provider }, { get: (target, property) => property === 'provider' ? target.provider : touched(String(property)) });
  const engine = new WorkflowEngine({
    store, generations, platformSessions: {}, publication: {}, validateAssets,
    fetchTrends: async () => ({ trends: [{ keyword: '검증 키워드', source: 'fixture', url: 'https://example.com/trend' }], sources: [{ name: 'fixture', status: 'ok' }] }),
    runAgent: async () => { boundary.providerCalls.push('engine.runAgent'); throw new Error('engine agent must not run'); },
    render: async () => { boundary.renders.push('engine.render'); throw new Error('engine render must not run'); },
  });
  const starts = [];
  const realStart = engine.start.bind(engine);
  engine.start = (...args) => { starts.push(args); return realStart(...args); };
  const enqueued = [];
  const enqueueRender = (episode, wait, source) => {
    enqueued.push({ episodeId: episode.id, version: episode.version, source });
    return store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'queued', progress: 0 });
  };
  const ops = createAgentOperations({ store, workflows: engine, enqueueRender, validateAssets, runAgent, allowPaidGeneration });
  t.after(async () => {
    for (let attempt = 0; attempt < 200 && engine.activeExecutions.size; attempt++) await wait(10);
    engine.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    assert.deepEqual(boundary, { generations: [], renders: [], providerCalls: [] }, 'no paid, render or provider boundary may be touched by these tests');
  });
  const channel = store.list('channels')[0];
  const template = store.list('workflows').find((workflow) => !workflow.episodeId);
  const call = (name, args) => ops.invoke(name, args);
  const episode = async (title = '검증 에피소드') => (await call('episode_create', { channelId: channel.id, title, topic: '정보의 출처' })).episode;
  const project = async (target) => {
    const owner = target || await episode();
    const { workflow } = await call('workflow_copy_from_template', { templateId: template.id, channelId: channel.id, episodeId: owner.id, expectedTemplateVersion: template.version });
    return { episode: owner, workflow };
  };
  return { dataDir, store, engine, ops, call, channel, template, boundary, starts, enqueued, episode, project };
}

async function rejection(promise, status, code, contract) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof HttpError, `${contract}: expected an HttpError, got ${error?.stack || error}`);
    assert.equal(error.status, status, `${contract}: status`);
    if (code !== undefined) assert.equal(error.code, code, `${contract}: code`);
    return error;
  }
  assert.fail(`${contract}: expected a rejection with status ${status}`);
}
const snapshot = (store) => JSON.stringify(['episodes', 'workflows', 'workflowRuns', 'jobs', 'generationPlans', 'generationJobs', 'channels'].map((kind) => store.list(kind)));
const counts = (store) => Object.fromEntries(['episodes', 'workflows', 'workflowRuns', 'jobs', 'generationPlans'].map((kind) => [kind, store.list(kind).length]));
async function settle(call, runId, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { run } = await call('workflow_run_get', { runId });
    if (run.terminal) return run;
    await wait(10);
  }
  assert.fail('the run never reached a terminal status');
}

// ── catalog ───────────────────────────────────────────────────────────────────────────────
test('the catalog is exactly the reviewed operation list, sorted, with no review/publish/session/upload operation', (t) => {
  const catalog = createAgentOperations().catalog();
  assert.deepEqual(catalog.map((operation) => operation.name), EXPECTED_OPERATIONS, 'adding or removing an agent operation must be a deliberate, reviewed change to this list');
  assert.ok(!catalog.some((operation) => /review|publish|approve|upload|session|login|credential|token/.test(operation.name.replace('workflow_run_', ''))), 'human-only actions must never become agent operations');
  assert.equal(OPERATIONS_VERSION.split('.').length, 3, 'the catalog carries a semantic version');
  assert.ok(SCRIPT_AGENTS.includes('studio'));
});

test('every catalog entry is self-describing JSON, and mutating is derived from readOnlyHint', () => {
  const catalog = createAgentOperations().catalog();
  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalog, 'entries must survive JSON transport (no functions leak from the registry)');
  for (const operation of catalog) {
    assert.ok(operation.title.trim() && operation.description.trim().length > 20, `${operation.name}: title and description are required so a model can choose tools`);
    assert.equal(operation.inputSchema.type, 'object', `${operation.name}: MCP requires object input schemas`);
    assert.equal(operation.outputSchema.type, 'object', `${operation.name}: MCP structuredContent must be an object`);
    assert.equal(operation.inputSchema.additionalProperties, false, `${operation.name}: unknown arguments must be rejected, not ignored`);
    assert.deepEqual(Object.keys(operation.annotations).sort(), ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'], operation.name);
    assert.ok(Object.values(operation.annotations).every((flag) => typeof flag === 'boolean'), operation.name);
    assert.equal(operation.mutating, !operation.annotations.readOnlyHint, `${operation.name}: mutating must mirror readOnlyHint (rate limiting depends on it)`);
    if (operation.annotations.readOnlyHint) assert.equal(operation.annotations.destructiveHint, false, `${operation.name}: a read-only tool cannot be destructive`);
    assert.deepEqual(validateSchema({ type: 'object' }, operation.inputSchema), []);
  }
  for (const name of ['workflow_patch', 'workflow_run_cancel', 'episode_update']) assert.equal(catalog.find((operation) => operation.name === name).annotations.destructiveHint, true, `${name} overwrites or stops work, so clients must be told it is destructive`);
  for (const name of ['workflow_run_start', 'workflow_quote', 'episode_propose_storyboard']) assert.equal(catalog.find((operation) => operation.name === name).annotations.openWorldHint, true, `${name} can reach outside the studio`);
  for (const name of ['workflow_patch', 'workflow_run_start', 'workflow_run_cancel', 'workflow_set_skip', 'workflow_copy_from_template', 'workflow_auto_layout', 'episode_create', 'episode_update', 'episode_render', 'workflow_quote']) assert.equal(catalog.find((operation) => operation.name === name).mutating, true, `${name} writes state and must be rate limited as a write`);
});

test('workflow_node_types mirrors the validator node catalog and marks the paid and human-gated types', async (t) => {
  const f = await fixture(t);
  const { types, limits, patchOps } = await f.call('workflow_node_types', {});
  assert.deepEqual(types.map((type) => type.type), TYPES);
  for (const type of types) assert.deepEqual(type.configFields, NODE_CONFIG_FIELDS[type.type], `${type.type}: advertised config fields must be the ones validateWorkflow accepts`);
  assert.deepEqual(types.filter((type) => type.paid).map((type) => type.type), ['generate'], 'only generate spends money');
  assert.deepEqual(types.filter((type) => type.humanGate).map((type) => type.type), ['review', 'publish'], 'review and publish are human gates');
  assert.deepEqual([limits.maxNodes, limits.maxEdges, limits.maxPatchOps], [128, 256, 100]);
  assert.ok(patchOps.includes('replaceGraph') && patchOps.includes('autoLayout'));
});

// ── invoke validation ─────────────────────────────────────────────────────────────────────
test('invoke validates arguments before touching the store', async (t) => {
  const f = await fixture(t);
  const before = snapshot(f.store);
  await rejection(f.call('no_such_operation', {}), 404, 'unknown_operation', 'unknown operations');
  await rejection(f.call('episode_get', {}), 400, 'invalid_arguments', 'missing required argument');
  await rejection(f.call('episode_get', { episodeId: 'a', extra: 1 }), 400, 'invalid_arguments', 'unknown argument');
  await rejection(f.call('episode_get', { episodeId: '../etc/passwd' }), 400, 'invalid_arguments', 'ids are pattern-checked');
  await rejection(f.call('workflow_patch', { workflowId: 'w', expectedVersion: '1', ops: [{ op: 'autoLayout' }] }), 400, 'invalid_arguments', 'expectedVersion must be an integer');
  await rejection(f.call('workflow_patch', { workflowId: 'w', expectedVersion: 0, ops: [{ op: 'autoLayout' }] }), 400, 'invalid_arguments', 'expectedVersion must be positive');
  await rejection(f.call('workflow_patch', { workflowId: 'w', expectedVersion: 1, ops: [] }), 400, 'invalid_arguments', 'at least one op');
  await rejection(f.call('workflow_patch', { workflowId: 'w', expectedVersion: 1, ops: [{ op: 'explode' }] }), 400, 'invalid_arguments', 'op name enum');
  await rejection(f.call('episode_get', null), 400, 'invalid_arguments', 'null arguments');
  assert.deepEqual(await f.call('workflow_node_types'), await f.call('workflow_node_types', {}), 'omitted arguments are the same as {}');
  assert.equal(snapshot(f.store), before, 'rejected calls must not change stored state');
});

test('invoke enforces the output schema and reports a server defect without leaking the stored value', async (t) => {
  const f = await fixture(t);
  const corrupted = { ...f.template, version: 'SECRET-corrupt-version' };
  f.store.save('workflows', corrupted);
  const errors = [];
  const original = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  let error;
  try { error = await rejection(f.call('workflow_list', {}), 500, 'invalid_result', 'a result violating the declared outputSchema'); } finally { console.error = original; }
  assert.ok(!error.message.includes('SECRET-corrupt-version'), 'the client-facing message must not echo bad data');
  assert.ok(errors.some((line) => /workflow_list violated its output schema/.test(line)), 'the defect must be logged for the operator');
});

// ── 409 classification ────────────────────────────────────────────────────────────────────
test('409s are classified once, centrally: stale_version (retryable), stale_quote, or conflict (not retryable)', async (t) => {
  const f = await fixture(t);
  const failing = (status, message, extra = {}) => createAgentOperations({ store: f.store, workflows: { listRuns: () => { throw Object.assign(new HttpError(status, message), extra); } } });
  const cases = [
    [409, 'Episode changed: current version is 7. Reload before saving.', { code: 'stale_version', currentVersion: 7 }],
    [409, 'Workflow changed: current version is 12. Reload before saving.', { code: 'stale_version', currentVersion: 12 }],
    [409, 'Template changed: current version is 3. Reload before copying.', { code: 'stale_version', currentVersion: 3 }],
    [409, 'Project changed since approval. Refresh and quote the current version.', { code: 'stale_version', currentVersion: undefined }],
    [409, 'Generation input changed. Obtain a fresh quote.', { code: 'stale_quote' }],
    [409, 'Generation quote expired before execution. Obtain a fresh quote.', { code: 'stale_quote' }],
    [409, 'Script, storyboard or layout differs from the quoted input. Save the new input and obtain a fresh quote.', { code: 'stale_quote' }],
    [409, 'Episode is archived. Unarchive it before editing or production.', { code: 'conflict' }],
    [409, 'This episode already has an active workflow', { code: 'conflict' }],
    [409, 'Execution requires a project-owned workflow copy for this exact episode and channel', { code: 'conflict' }],
  ];
  for (const [status, message, expected] of cases) {
    const error = await rejection(failing(status, message).invoke('workflow_run_list', { workflowId: f.template.id }), 409, expected.code, message);
    assert.equal(error.currentVersion, expected.currentVersion, `${message}: currentVersion`);
  }
  const preCoded = await rejection(failing(409, 'Episode changed: current version is 7.', { code: 'custom' }).invoke('workflow_run_list', { workflowId: f.template.id }), 409, 'custom', 'an operation that already set a code keeps it');
  assert.equal(preCoded.currentVersion, undefined);
  for (const status of [400, 403, 404, 429, 503]) {
    const error = await rejection(failing(status, 'Episode changed: current version is 7.').invoke('workflow_run_list', { workflowId: f.template.id }), status, undefined, `status ${status}`);
    assert.equal(error.code, undefined, `only 409s are classified; ${status} must pass through untouched`);
  }
});

// ── workflow_patch ────────────────────────────────────────────────────────────────────────
test('workflow_patch requires the current version and a stale one changes nothing', async (t) => {
  const f = await fixture(t);
  const { workflow } = await f.project();
  const before = snapshot(f.store);
  const error = await rejection(f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version + 3, ops: [{ op: 'rename', name: 'Nope' }] }), 409, 'stale_version', 'stale expectedVersion');
  assert.equal(error.currentVersion, workflow.version, 'the error must say which version to re-read');
  assert.equal(snapshot(f.store), before);
  await rejection(f.call('workflow_auto_layout', { workflowId: workflow.id, expectedVersion: workflow.version + 1 }), 409, 'stale_version', 'auto layout shares the same guard');
  await rejection(f.call('workflow_patch', { workflowId: 'does-not-exist', expectedVersion: 1, ops: [{ op: 'autoLayout' }] }), 404, undefined, 'unknown workflow');
});

test('workflow_patch applies atomically: a failing op, or an invalid final graph, writes nothing', async (t) => {
  const f = await fixture(t);
  const { workflow } = await f.project();
  const before = snapshot(f.store);
  const historyBefore = f.store.workflowHistory(workflow.id).length;
  await rejection(f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, ops: [{ op: 'rename', name: 'Half applied?' }, { op: 'connect', source: 'script', target: 'ghost' }] }), 400, undefined, 'a bad op after a good one');
  assert.equal(snapshot(f.store), before, 'the rename before the failing op must not have been persisted');
  const invalid = [{ op: 'rename', name: 'Broken' }, { op: 'removeNode', id: 'script' }]; // leaves the graph disconnected
  const error = await rejection(f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, ops: invalid }), 400, 'invalid_graph', 'an invalid final graph');
  assert.match(error.message, /connected/);
  assert.equal(snapshot(f.store), before, 'an invalid final graph must not be persisted');
  assert.equal(f.store.workflowHistory(workflow.id).length, historyBefore, 'and must not create a history entry');
  await rejection(f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, ops: [{ op: 'addNode', type: 'layout', id: 'research' }] }), 400, undefined, 'a duplicate node id is refused');
  await rejection(f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, ops: [{ op: 'addNode', type: 'layout', id: 'publish' }] }), 400, 'invalid_graph', 'a node id that shadows another stage type fails final validation');
});

test('workflow_patch dryRun never writes and reports validation instead of throwing', async (t) => {
  const f = await fixture(t);
  const { workflow } = await f.project();
  const before = snapshot(f.store);
  const historyBefore = f.store.workflowHistory(workflow.id).length;
  const preview = await f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, dryRun: true, ops: [{ op: 'rename', name: 'Preview' }, { op: 'setConfig', id: 'research', config: { limit: 3 } }] });
  assert.deepEqual([preview.applied, preview.dryRun, preview.version, preview.validation], [false, true, workflow.version, { valid: true }]);
  assert.equal(preview.preview.name, 'Preview');
  assert.equal(preview.preview.nodes.find((node) => node.id === 'research').config.limit, 3, 'the preview shows the validated graph');
  assert.equal(preview.workflow, undefined, 'a dry run returns a preview, not a saved workflow');
  const invalid = await f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, dryRun: true, ops: [{ op: 'removeNode', id: 'script' }] });
  assert.equal(invalid.applied, false);
  assert.equal(invalid.validation.valid, false);
  assert.match(invalid.validation.error, /connected/, 'the reason an apply would fail is returned for the agent to fix');
  assert.equal(snapshot(f.store), before, 'dry runs must not change any stored entity');
  assert.equal(f.store.workflowHistory(workflow.id).length, historyBefore, 'dry runs must not write history');
  await rejection(f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version + 1, dryRun: true, ops: [{ op: 'autoLayout' }] }), 409, 'stale_version', 'even a dry run is checked against the version it claims to preview');
});

test('a successful workflow_patch writes exactly one new version tagged agent-api, and replaying it is stale', async (t) => {
  const f = await fixture(t);
  const { workflow } = await f.project();
  const historyBefore = f.store.workflowHistory(workflow.id);
  const ops = [{ op: 'rename', name: 'Agent edit' }, { op: 'addNode', type: 'layout', id: 'layout' }, { op: 'connect', source: 'storyboard', target: 'layout' }, { op: 'connect', source: 'layout', target: 'render' }, { op: 'setLabel', id: 'layout', label: '레이아웃' }];
  const applied = await f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, ops });
  assert.deepEqual([applied.applied, applied.dryRun, applied.version], [true, false, workflow.version + 1], 'five ops, one version bump');
  assert.deepEqual(applied.stats, { nodesAdded: 1, nodesRemoved: 0, edgesAdded: 2, edgesRemoved: 0, nodesChanged: 1 });
  assert.equal(applied.workflow.name, 'Agent edit');
  assert.ok(applied.workflow.nodes.some((node) => node.id === 'layout' && node.label === '레이아웃'));
  const stored = f.store.get('workflows', workflow.id);
  assert.deepEqual([stored.version, stored.episodeId, stored.templateId], [workflow.version + 1, workflow.episodeId, workflow.templateId], 'ownership fields survive an agent edit');
  const history = f.store.workflowHistory(workflow.id);
  assert.equal(history.length, historyBefore.length + 1, 'exactly one history entry per patch, however many ops');
  assert.equal(history[0].reason, 'agent-api');
  assert.equal(history[0].version, workflow.version + 1);
  const error = await rejection(f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, ops: [{ op: 'rename', name: 'Replay' }] }), 409, 'stale_version', 'replaying the old version');
  assert.equal(error.currentVersion, workflow.version + 1);
  assert.equal(f.store.get('workflows', workflow.id).name, 'Agent edit', 'the stale replay must not overwrite the newer edit');
});

test('workflow_patch on a project whose episode is archived is a non-retryable conflict', async (t) => {
  const f = await fixture(t);
  const { episode, workflow } = await f.project();
  f.store.setEpisodeArchived(episode.id, true, episode.version);
  const before = snapshot(f.store);
  await rejection(f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, ops: [{ op: 'rename', name: 'Archived edit' }] }), 409, 'conflict', 'archived project');
  assert.equal(snapshot(f.store), before);
});

test('workflow_auto_layout writes one version that changes only coordinates, on the grid', async (t) => {
  const f = await fixture(t);
  const { workflow } = await f.project();
  const result = await f.call('workflow_auto_layout', { workflowId: workflow.id, expectedVersion: workflow.version });
  assert.equal(result.version, workflow.version + 1);
  assert.deepEqual(result.workflow.nodes.map(({ x, y, ...rest }) => rest), workflow.nodes.map(({ x, y, ...rest }) => rest), 'ids and config must be untouched');
  assert.deepEqual(result.workflow.edges, workflow.edges);
  assert.ok(result.workflow.nodes.every((node) => node.x % 10 === 0 && node.y % 10 === 0));
  assert.equal(f.store.workflowHistory(workflow.id)[0].reason, 'agent-api:autoLayout');
});

test('workflow_set_skip toggles a project node, and a stale version is stale_version', async (t) => {
  const f = await fixture(t);
  const { workflow } = await f.project();
  const stale = await rejection(f.call('workflow_set_skip', { workflowId: workflow.id, nodeId: 'research', skipped: true, expectedVersion: workflow.version + 1 }), 409, 'stale_version', 'stale expectedVersion');
  assert.equal(stale.currentVersion, workflow.version);
  assert.deepEqual(f.store.get('workflows', workflow.id).skippedNodes || [], [], 'a rejected skip must not be applied');
  const skipped = await f.call('workflow_set_skip', { workflowId: workflow.id, nodeId: 'research', skipped: true, expectedVersion: workflow.version });
  assert.deepEqual(skipped.workflow.skippedNodes, ['research']);
  const restored = await f.call('workflow_set_skip', { workflowId: workflow.id, nodeId: 'research', skipped: false, expectedVersion: workflow.version });
  assert.deepEqual(restored.workflow.skippedNodes, []);
  await rejection(f.call('workflow_set_skip', { workflowId: workflow.id, nodeId: 'ghost', skipped: true, expectedVersion: workflow.version }), 400, undefined, 'unknown node');
  await rejection(f.call('workflow_set_skip', { workflowId: f.template.id, nodeId: 'research', skipped: true, expectedVersion: f.template.version }), 409, 'conflict', 'templates cannot have skips');
});

test('workflow_copy_from_template creates an independent versioned project workflow and enforces the template version', async (t) => {
  const f = await fixture(t);
  const owner = await f.episode();
  const stale = await rejection(f.call('workflow_copy_from_template', { templateId: f.template.id, channelId: f.channel.id, episodeId: owner.id, expectedTemplateVersion: f.template.version + 1 }), 409, 'stale_version', 'stale template version');
  assert.equal(stale.currentVersion, f.template.version);
  const other = await rejection(f.call('workflow_copy_from_template', { templateId: f.template.id, channelId: 'missing-channel', episodeId: owner.id, expectedTemplateVersion: f.template.version }), 404, undefined, 'unknown channel');
  assert.ok(other);
  assert.equal(f.store.list('workflows').filter((workflow) => workflow.episodeId === owner.id).length, 0, 'failed copies must not leave a workflow behind');
  const { workflow } = await f.call('workflow_copy_from_template', { templateId: f.template.id, channelId: f.channel.id, episodeId: owner.id, expectedTemplateVersion: f.template.version });
  assert.deepEqual([workflow.isTemplate, workflow.episodeId, workflow.channelId, workflow.templateId, workflow.templateVersion, workflow.version], [false, owner.id, f.channel.id, f.template.id, f.template.version, 1]);
  assert.notEqual(workflow.id, f.template.id);
  await f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, ops: [{ op: 'rename', name: 'Project only' }] });
  assert.equal(f.store.get('workflows', f.template.id).name, f.template.name, 'editing the project copy must never change the shared template');
  const listed = await f.call('workflow_list', { episodeId: owner.id });
  assert.deepEqual(listed.workflows.map((item) => item.id), [workflow.id], 'workflow_list filters by owning episode');
  assert.ok((await f.call('workflow_list', { templatesOnly: true })).workflows.every((item) => item.isTemplate), 'templatesOnly returns templates only');
});

test('workflow_validate checks a stored or candidate graph, requires exactly one, and never writes', async (t) => {
  const f = await fixture(t);
  const { workflow } = await f.project();
  const before = snapshot(f.store);
  const stored = await f.call('workflow_validate', { workflowId: workflow.id });
  assert.deepEqual([stored.valid, stored.nodeCount, stored.edgeCount], [true, workflow.nodes.length, workflow.edges.length]);
  const candidate = { name: 'c', nodes: [{ id: 'a', type: 'research', x: 0, y: 0, config: {} }, { id: 'b', type: 'research', x: 1, y: 0, config: {} }], edges: [] };
  const bad = await f.call('workflow_validate', { graph: candidate });
  assert.equal(bad.valid, false, 'a disconnected candidate is reported invalid, not thrown');
  assert.match(bad.error, /connected/);
  const good = await f.call('workflow_validate', { graph: { ...candidate, edges: [{ id: 'e', source: 'a', target: 'b' }] } });
  assert.equal(good.valid, true);
  await rejection(f.call('workflow_validate', {}), 400, 'invalid_arguments', 'neither workflowId nor graph');
  await rejection(f.call('workflow_validate', { workflowId: workflow.id, graph: candidate }), 400, 'invalid_arguments', 'both workflowId and graph');
  await rejection(f.call('workflow_validate', { workflowId: 'missing' }), 404, undefined, 'unknown workflow');
  assert.equal(snapshot(f.store), before);
});

// ── plan / run / paid generation ──────────────────────────────────────────────────────────
test('workflow_plan is free, checks the versions it is given, and refuses non-project workflows', async (t) => {
  const f = await fixture(t);
  const { episode, workflow } = await f.project();
  const before = snapshot(f.store);
  const execution = { mode: 'node', targetNodeId: 'script' };
  const plan = await f.call('workflow_plan', { workflowId: workflow.id, episodeId: episode.id, execution, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version });
  assert.equal(plan.requiresGeneration, false);
  assert.ok(plan.selectedStages.includes('script') && plan.selectedStages.includes('trend'), 'the target and its needed ancestors are selected');
  const staleWorkflow = await rejection(f.call('workflow_plan', { workflowId: workflow.id, episodeId: episode.id, execution, expectedWorkflowVersion: workflow.version + 1 }), 409, 'stale_version', 'stale expectedWorkflowVersion');
  assert.equal(staleWorkflow.currentVersion, undefined, 'project-level staleness carries no single version to re-read');
  await rejection(f.call('workflow_plan', { workflowId: workflow.id, episodeId: episode.id, execution, expectedEpisodeVersion: episode.version + 1 }), 409, 'stale_version', 'stale expectedEpisodeVersion');
  await rejection(f.call('workflow_plan', { workflowId: f.template.id, episodeId: episode.id, execution }), 409, 'conflict', 'planning against a shared template is a conflict, not a stale version');
  await rejection(f.call('workflow_plan', { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'node' } }), 400, undefined, 'node mode needs a target');
  assert.equal(snapshot(f.store), before, 'planning must not write');
  assert.deepEqual(f.boundary.generations, [], 'planning must never contact the generation provider');
});

/** A project workflow that really contains a paid generate node (storyboard → generate → render). */
async function paidProject(f) {
  const { episode, workflow } = await f.project();
  const patched = await f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, ops: [
    { op: 'addNode', type: 'generate', id: 'generate', config: { model: 'fixture/model', prompt: '검증 프롬프트' } },
    { op: 'connect', source: 'storyboard', target: 'generate' }, { op: 'connect', source: 'generate', target: 'render' },
  ] });
  assert.equal(patched.applied, true);
  return { episode, workflow: patched.workflow };
}
/**
 * Without prepared inputs the engine runs only the free prefix of an "all" selection (that is its
 * prepare-first rule), so the paid-consent rules are exercised once storyboard output exists.
 */
async function preparedPaidProject(f) {
  const { episode, workflow } = await paidProject(f);
  const { run } = await f.call('workflow_run_start', { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'all' } });
  assert.ok(!run.selectedStages.includes('generate'), 'the first run must be the free prefix only, never the paid node');
  const finished = await settle(f.call, run.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  return { episode: f.store.get('episodes', episode.id), workflow: f.store.get('workflows', workflow.id) };
}
const DISCLOSURE = { containsSyntheticMedia: true, rationale: 'reviewed by a person' };

test('workflow_run_start refuses every paid-generation argument before reaching the engine unless the operator enabled it', async (t) => {
  const f = await fixture(t);
  const { episode, workflow } = await paidProject(f);
  const base = { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'all' } };
  const before = snapshot(f.store);
  const triggers = [{ allowGeneration: true }, { generationPlanId: 'plan-1' }, { generationFingerprint: 'fingerprint' }, { acceptUnquotedEstimate: true }, { allowGeneration: true, generationPlanId: 'plan-1', generationFingerprint: 'f', acceptUnquotedEstimate: true, disclosure: DISCLOSURE }];
  for (const trigger of triggers) {
    const error = await rejection(f.call('workflow_run_start', { ...base, ...trigger }), 403, 'agent_paid_generation_disabled', `paid trigger ${JSON.stringify(trigger)}`);
    assert.match(error.message, /AGENT_API_ALLOW_PAID_GENERATION/, 'the refusal tells the operator how to enable it');
  }
  assert.deepEqual(f.starts, [], 'the engine must not even be asked to start: the refusal happens first');
  assert.equal(snapshot(f.store), before, 'a refused start must not create a run, quote or job');
  assert.deepEqual(f.boundary.generations, [], 'the generation provider must never be touched');
  assert.equal(f.engine.activeExecutions.size, 0);
  assert.deepEqual(f.store.list('generationPlans'), [], 'no quote may be created as a side effect');
});

test('with the operator flag set, paid arguments pass the gate and reach the engine, which still enforces disclosure, quote and consent', async (t) => {
  const f = await fixture(t, { allowPaidGeneration: true });
  const { episode, workflow } = await preparedPaidProject(f);
  const base = { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'all' } };
  const before = snapshot(f.store);
  const startsBefore = f.starts.length;
  const expectations = [
    [{}, 400, /explicit allowGeneration/],
    [{ allowGeneration: true }, 400, /disclosure/],
    [{ allowGeneration: true, disclosure: DISCLOSURE }, 400, /persisted exact-input quote/],
    [{ allowGeneration: true, disclosure: DISCLOSURE, generationPlanId: 'no-such-plan' }, 404, /generationPlans item not found/],
  ];
  for (const [extra, status, message] of expectations) {
    const error = await rejection(f.call('workflow_run_start', { ...base, ...extra }), status, undefined, `engine rule for ${JSON.stringify(extra)}`);
    assert.match(error.message, message);
    assert.notEqual(error.code, 'agent_paid_generation_disabled', 'the gate is open, so the engine made this decision');
  }
  assert.equal(f.starts.length - startsBefore, expectations.length, 'every call reached the engine');
  assert.equal(snapshot(f.store), before, 'none of the refused starts created a run');
  assert.deepEqual(f.boundary.generations, [], 'and none contacted the provider');
});

test('allowGeneration:false is not a paid request and is never stopped by the operator gate', async (t) => {
  const f = await fixture(t);
  const { episode, workflow } = await f.project();
  const { run } = await f.call('workflow_run_start', { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'trend' }, allowGeneration: false });
  assert.equal(f.starts.length, 1);
  assert.equal((await settle(f.call, run.id)).status, 'completed');
});

test('a free run starts, is polled to a terminal status, and a finished run cannot be cancelled', async (t) => {
  const f = await fixture(t);
  const { episode, workflow } = await f.project();
  const execution = { mode: 'node', targetNodeId: 'trend' };
  await rejection(f.call('workflow_run_start', { workflowId: workflow.id, episodeId: episode.id, execution, expectedWorkflowVersion: workflow.version + 1 }), 409, 'stale_version', 'stale version on start');
  assert.deepEqual(f.store.list('workflowRuns'), [], 'a stale start must not create a run');
  const { run } = await f.call('workflow_run_start', { workflowId: workflow.id, episodeId: episode.id, execution, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version });
  assert.deepEqual([run.workflowId, run.episodeId, run.terminal, run.awaitingReview], [workflow.id, episode.id, false, false]);
  assert.ok(['queued', 'running'].includes(run.status), `a started run is not terminal, got ${run.status}`);
  const finished = await settle(f.call, run.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.deepEqual(finished.selectedStages, ['trend'], 'only the requested node was selected');
  assert.deepEqual(finished.nodeRuns.filter((node) => node.status === 'completed').map((node) => node.nodeId), ['trend'], 'nothing beyond the requested node ran');
  assert.deepEqual((await f.call('workflow_run_list', { workflowId: workflow.id })).runs.map((item) => item.id), [run.id]);
  assert.deepEqual((await f.call('workflow_run_list', { workflowId: workflow.id, limit: 1 })).runs.map((item) => item.id), [run.id]);
  const error = await rejection(f.call('workflow_run_cancel', { workflowId: workflow.id, runId: run.id }), 409, 'conflict', 'cancelling a finished run');
  assert.match(error.message, /already terminal/);
  await rejection(f.call('workflow_run_cancel', { workflowId: f.template.id, runId: run.id }), 404, undefined, 'a run is only addressable through its own workflow');
  await rejection(f.call('workflow_run_get', { runId: 'missing' }), 404, undefined, 'unknown run');
  await rejection(f.call('workflow_run_list', { workflowId: workflow.id, limit: 0 }), 400, 'invalid_arguments', 'limit is schema-bounded');
});

test('workflow_quote needs a human-reviewed disclosure for generate nodes before any provider contact', async (t) => {
  const f = await fixture(t);
  const { episode, workflow } = await preparedPaidProject(f);
  const before = snapshot(f.store);
  await rejection(f.call('workflow_quote', { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'generate' } }), 400, undefined, 'quote without disclosure');
  await rejection(f.call('workflow_quote', { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'generate' }, disclosure: { containsSyntheticMedia: true } }), 400, 'invalid_arguments', 'disclosure needs a rationale');
  await rejection(f.call('workflow_quote', { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'generate' }, expectedWorkflowVersion: workflow.version + 1, disclosure: DISCLOSURE }), 409, 'stale_version', 'stale project version on quote');
  assert.equal(snapshot(f.store), before, 'a refused quote must not persist a plan');
  assert.deepEqual(f.boundary.generations, []);
});

// ── proposals persist nothing ─────────────────────────────────────────────────────────────
test('episode_propose_storyboard with the studio engine is offline, deterministic, and persists nothing', async (t) => {
  const f = await fixture(t);
  const target = await f.episode();
  const before = snapshot(f.store);
  const eventsBefore = f.store.list('events').length;
  const proposal = await f.call('episode_propose_storyboard', { episodeId: target.id, brief: '첫째 문장입니다. 둘째 문장입니다.', sceneCount: 5, tone: 'calm' });
  assert.deepEqual([proposal.engine, proposal.episodeId, proposal.baseVersion, proposal.scenes.length], ['rule-based', target.id, target.version, 5]);
  assert.deepEqual(await f.call('episode_propose_storyboard', { episodeId: target.id, brief: '첫째 문장입니다. 둘째 문장입니다.', sceneCount: 5, tone: 'calm' }), proposal, 'same input, same proposal');
  assert.equal(snapshot(f.store), before, 'a proposal must not create or modify any episode, workflow, run or job');
  assert.equal(f.store.get('episodes', target.id).scenes.length, 1, 'the episode keeps its original scenes');
  assert.equal(f.store.list('events').length, eventsBefore, 'the offline engine records no events either');
  await rejection(f.call('episode_propose_storyboard', { episodeId: target.id, sceneCount: 2 }), 400, 'invalid_arguments', 'sceneCount is schema-bounded');
  await rejection(f.call('episode_propose_storyboard', { episodeId: 'missing' }), 404, undefined, 'unknown episode');
  f.store.setEpisodeArchived(target.id, true, target.version);
  await rejection(f.call('episode_propose_storyboard', { episodeId: target.id }), 409, 'conflict', 'archived episode');
});

test('episode_propose_storyboard with a host agent is unavailable without a bridge and never falls back silently', async (t) => {
  const f = await fixture(t);
  const target = await f.episode();
  const before = snapshot(f.store);
  for (const agent of ['codex', 'jeo', 'jeopi', 'hermes']) await rejection(f.call('episode_propose_storyboard', { episodeId: target.id, agent }), 503, 'agent_unavailable', `${agent} without runAgent`);
  await rejection(f.call('episode_propose_storyboard', { episodeId: target.id, agent: 'gpt-9' }), 400, 'invalid_arguments', 'unknown agents are schema-rejected');
  assert.equal(snapshot(f.store), before);
});

test('episode_propose_storyboard with a host agent returns validated scenes tagged agent:<name> and persists nothing', async (t) => {
  const calls = [];
  const scenes = [{ id: 'a1', title: '첫 장면', text: '내용', duration: 4, background: '#112233' }, { id: 'a2', title: '둘째', duration: 6, background: '#445566' }];
  const f = await fixture(t, { runAgent: async (agent, message, episode) => { calls.push({ agent, message, episodeId: episode.id }); return { message: '  제안입니다  ', scenes }; } });
  const target = await f.episode();
  const before = snapshot(f.store);
  const proposal = await f.call('episode_propose_storyboard', { episodeId: target.id, agent: 'codex', brief: '짧은 설명', sceneCount: 3 });
  assert.equal(proposal.engine, 'agent:codex');
  assert.equal(proposal.baseVersion, target.version, 'apply it with episode_update using this baseVersion as expectedVersion');
  assert.deepEqual(proposal.scenes.map((scene) => [scene.id, scene.duration, scene.background, scene.kind, scene.layout]), [['a1', 4, '#112233', 'title', 'center'], ['a2', 6, '#445566', 'title', 'center']], 'returned scenes are the validated, normalised form');
  assert.equal(proposal.rationale[0], '제안입니다', 'the agent message is trimmed into the rationale');
  assert.deepEqual(calls.map((call) => [call.agent, call.episodeId]), [['codex', target.id]]);
  assert.match(calls[0].message, /짧은 설명/);
  assert.equal(f.store.get('episodes', target.id).scenes.length, 1, 'proposed scenes must not be written to the episode');
  const after = JSON.parse(snapshot(f.store));
  assert.deepEqual(after, JSON.parse(before), 'no entity changed');
  assert.ok(f.store.list('events').some((event) => event.type === 'agent.proposal.requested' && event.agent === 'codex'), 'the request to the host agent is audit-logged');
});

test('host agent failures map to stable errors: no scenes is 502, invalid scenes 400, bridge failures 503 without leaking details', async (t) => {
  let behaviour;
  const f = await fixture(t, { runAgent: async () => behaviour() });
  const target = await f.episode();
  behaviour = () => ({ message: 'no scenes' });
  await rejection(f.call('episode_propose_storyboard', { episodeId: target.id, agent: 'codex' }), 502, 'agent_no_scenes', 'missing scenes');
  behaviour = () => ({ scenes: [] });
  await rejection(f.call('episode_propose_storyboard', { episodeId: target.id, agent: 'codex' }), 502, 'agent_no_scenes', 'empty scenes');
  behaviour = () => ({ scenes: [{ id: 'x', title: 't', duration: 9999, background: '#112233' }] });
  await rejection(f.call('episode_propose_storyboard', { episodeId: target.id, agent: 'codex' }), 400, undefined, 'agent scenes that fail scene validation are refused, not stored');
  behaviour = () => { throw Object.assign(new Error('SECRET-bridge-detail'), { code: 'UNAVAILABLE' }); };
  const unavailable = await rejection(f.call('episode_propose_storyboard', { episodeId: target.id, agent: 'codex' }), 503, 'agent_unavailable', 'bridge not configured');
  behaviour = () => { throw new Error('SECRET-bridge-detail'); };
  const failed = await rejection(f.call('episode_propose_storyboard', { episodeId: target.id, agent: 'codex' }), 503, 'agent_unavailable', 'bridge error');
  for (const error of [unavailable, failed]) assert.ok(!error.message.includes('SECRET'), 'raw bridge errors must not reach the agent');
  assert.equal(f.store.get('episodes', target.id).scenes.length, 1);
});

test('workflow_propose_blueprint persists nothing, never invents a model, and its output can be applied with replaceGraph', async (t) => {
  const f = await fixture(t);
  const { workflow } = await f.project();
  const before = snapshot(f.store);
  const withoutModel = await f.call('workflow_propose_blueprint', { topic: '금리 인상', style: 'news', includeGeneration: true, includePublish: true });
  assert.equal(withoutModel.engine, 'rule-based');
  assert.ok(!withoutModel.nodes.some((node) => node.type === 'generate'), 'no model, no generate node');
  assert.ok(withoutModel.warnings.length > 0, 'and the omission is explained');
  const withModel = await f.call('workflow_propose_blueprint', { topic: '금리 인상', includeGeneration: true, model: 'bytedance/seedance-2.5/text-to-video' });
  assert.equal(withModel.nodes.find((node) => node.type === 'generate').config.model, 'bytedance/seedance-2.5/text-to-video');
  const long = await f.call('workflow_propose_blueprint', { topic: '가'.repeat(300) });
  assert.equal(long.nodes[0].config.query.length, 200, 'a topic at the schema maximum is accepted and its collector query clipped');
  assert.equal(snapshot(f.store), before, 'proposals persist no workflow');
  await rejection(f.call('workflow_propose_blueprint', { topic: 'x'.repeat(301) }), 400, 'invalid_arguments', 'topic maximum');
  await rejection(f.call('workflow_propose_blueprint', { topic: 'ok', style: 'documentary' }), 400, 'invalid_arguments', 'style enum');
  const applied = await f.call('workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, ops: [{ op: 'replaceGraph', name: withoutModel.name, nodes: withoutModel.nodes, edges: withoutModel.edges }] });
  assert.equal(applied.workflow.nodes.length, withoutModel.nodes.length, 'the documented apply path (proposal → replaceGraph patch) works end to end');
  assert.equal(applied.workflow.episodeId, workflow.episodeId, 'applying a blueprint must not change ownership');
});

// ── episodes ──────────────────────────────────────────────────────────────────────────────
test('episode_create makes a draft with one starter scene under an existing channel only', async (t) => {
  const f = await fixture(t);
  const { episode } = await f.call('episode_create', { channelId: f.channel.id, title: '새 에피소드', topic: '주제' });
  assert.deepEqual([episode.status, episode.format, episode.version, episode.sceneCount, episode.archived], ['draft', '9:16', 1, 1, false]);
  const { scenes } = await f.call('episode_get', { episodeId: episode.id });
  assert.equal(scenes.length, 1);
  await rejection(f.call('episode_create', { channelId: 'missing', title: 'x' }), 404, undefined, 'unknown channel');
  await rejection(f.call('episode_create', { channelId: f.channel.id, title: '' }), 400, 'invalid_arguments', 'blank title');
  assert.ok((await f.call('episode_list', {})).episodes.some((item) => item.id === episode.id));
});

test('episode_update needs the current version: stale is stale_version with currentVersion, and an archived episode is a conflict', async (t) => {
  const f = await fixture(t);
  const created = await f.episode();
  const before = snapshot(f.store);
  const stale = await rejection(f.call('episode_update', { episodeId: created.id, expectedVersion: created.version + 4, title: 'Stale' }), 409, 'stale_version', 'stale expectedVersion');
  assert.equal(stale.currentVersion, created.version);
  assert.equal(snapshot(f.store), before, 'a stale update must not change anything');
  const { episode: updated } = await f.call('episode_update', { episodeId: created.id, expectedVersion: created.version, title: '새 제목', notes: '메모' });
  assert.deepEqual([updated.title, updated.version], ['새 제목', created.version + 1]);
  assert.equal(f.store.history(created.id)[0].reason, 'agent-api', 'agent edits are attributed in episode history');
  const replay = await rejection(f.call('episode_update', { episodeId: created.id, expectedVersion: created.version, title: 'Replay' }), 409, 'stale_version', 'replaying the old version');
  assert.equal(replay.currentVersion, created.version + 1);
  assert.equal(f.store.get('episodes', created.id).title, '새 제목');
  await rejection(f.call('episode_update', { episodeId: created.id, expectedVersion: created.version + 1 }), 400, undefined, 'an update with no editable field');
  await rejection(f.call('episode_update', { episodeId: created.id, expectedVersion: created.version + 1, status: 'archived' }), 400, 'invalid_arguments', 'archiving is not an agent operation');
  await rejection(f.call('episode_update', { episodeId: created.id, expectedVersion: created.version + 1, music: { assetUrl: '/x' } }), 400, 'invalid_arguments', 'music is not editable through this operation');
  const archived = f.store.setEpisodeArchived(created.id, true, created.version + 1);
  const conflict = await rejection(f.call('episode_update', { episodeId: created.id, expectedVersion: archived.version, title: 'Late' }), 409, 'conflict', 'archived episode with the current version');
  assert.equal(conflict.currentVersion, undefined, 'retrying an archived episode cannot succeed, so no version to re-read is offered');
  assert.equal(f.store.get('episodes', created.id).title, '새 제목');
});

test('episode_update replaces scenes only through the asset validator, and writes nothing when it refuses', async (t) => {
  const seen = [];
  const f = await fixture(t, { validateAssets: (scenes) => { seen.push(scenes.map((scene) => scene.id)); if (scenes.some((scene) => scene.id === 'forbidden')) throw new HttpError(400, 'Scene refers to an unknown uploaded asset'); return scenes; } });
  const created = await f.episode();
  const before = snapshot(f.store);
  await rejection(f.call('episode_update', { episodeId: created.id, expectedVersion: created.version, scenes: [{ id: 'forbidden', title: 't', duration: 3, background: '#112233' }] }), 400, undefined, 'a scene set refused by asset validation');
  assert.equal(snapshot(f.store), before, 'a refused scene set must not be written');
  const { episode } = await f.call('episode_update', { episodeId: created.id, expectedVersion: created.version, scenes: [{ id: 's1', title: '하나', duration: 3, background: '#112233' }, { id: 's2', title: '둘', duration: 4.5, background: '#445566' }] });
  assert.deepEqual([episode.sceneCount, episode.totalDuration], [2, 7.5]);
  assert.deepEqual(seen.at(-1), ['s1', 's2'], 'the validator saw the normalised scenes before they were stored');
  await rejection(f.call('episode_update', { episodeId: created.id, expectedVersion: episode.version, scenes: [{ id: 's1', title: 't', duration: 0.1, background: '#112233' }] }), 400, undefined, 'scene validation applies');
});

test('episode_render requires the current version, refuses archived episodes, and only queues the exact version', async (t) => {
  const f = await fixture(t);
  const created = await f.episode();
  const stale = await rejection(f.call('episode_render', { episodeId: created.id, expectedVersion: created.version + 1 }), 409, 'stale_version', 'stale expectedVersion');
  assert.equal(stale.currentVersion, created.version);
  assert.deepEqual(f.enqueued, [], 'a stale render request must not enqueue anything');
  const { job } = await f.call('episode_render', { episodeId: created.id, expectedVersion: created.version });
  assert.deepEqual(f.enqueued, [{ episodeId: created.id, version: created.version, source: 'manual' }], 'exactly one manual render of the exact version');
  assert.deepEqual([job.episodeId, job.episodeVersion, job.status], [created.id, created.version, 'queued']);
  assert.equal((await f.call('render_job_get', { jobId: job.id })).job.id, job.id);
  await rejection(f.call('render_job_get', { jobId: 'missing' }), 404, undefined, 'unknown job');
  f.store.save('jobs', { ...f.store.get('jobs', job.id), status: 'completed', progress: 1 }); // an unfinished render legitimately blocks archiving
  const archived = f.store.setEpisodeArchived(created.id, true, created.version);
  await rejection(f.call('episode_render', { episodeId: created.id, expectedVersion: archived.version }), 409, 'conflict', 'archived episode with the current version');
  assert.equal(f.enqueued.length, 1);
});

// ── read-only honesty ─────────────────────────────────────────────────────────────────────
test('every operation annotated read-only really leaves all stored state untouched', async (t) => {
  const f = await fixture(t);
  const { episode, workflow } = await f.project();
  const { run } = await f.call('workflow_run_start', { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'trend' } });
  await settle(f.call, run.id);
  const job = (await f.call('episode_render', { episodeId: episode.id, expectedVersion: episode.version })).job;
  const current = f.store.get('episodes', episode.id);
  const samples = {
    workflow_node_types: {}, workflow_list: {}, workflow_get: { workflowId: workflow.id }, workflow_validate: { workflowId: workflow.id },
    workflow_plan: { workflowId: workflow.id, episodeId: current.id, execution: { mode: 'all' } },
    workflow_run_get: { runId: run.id }, workflow_run_list: { workflowId: workflow.id }, episode_list: {}, episode_get: { episodeId: current.id },
    render_job_get: { jobId: job.id }, workflow_propose_blueprint: { topic: '읽기 전용 확인', includePublish: true },
  };
  const readOnly = f.ops.catalog().filter((operation) => operation.annotations.readOnlyHint).map((operation) => operation.name).sort();
  assert.deepEqual(Object.keys(samples).sort(), readOnly, 'a newly read-only operation needs a sample here, so its honesty is checked');
  const before = snapshot(f.store);
  const eventsBefore = JSON.stringify(f.store.list('events'));
  const history = JSON.stringify([f.store.workflowHistory(workflow.id), f.store.history(episode.id)]);
  for (const [name, args] of Object.entries(samples)) await f.call(name, args);
  assert.equal(snapshot(f.store), before, 'read-only operations must not write entities');
  assert.equal(JSON.stringify(f.store.list('events')), eventsBefore, 'or audit events (those are reserved for real changes)');
  assert.equal(JSON.stringify([f.store.workflowHistory(workflow.id), f.store.history(episode.id)]), history, 'or history');
  assert.deepEqual(f.boundary.generations, []);
});

test('every operation result satisfies its own outputSchema across a realistic episode lifecycle', async (t) => {
  const f = await fixture(t);
  const { episode, workflow } = await f.project();
  const catalog = new Map(f.ops.catalog().map((operation) => [operation.name, operation]));
  const results = [
    ['workflow_get', await f.call('workflow_get', { workflowId: workflow.id })],
    ['workflow_list', await f.call('workflow_list', {})],
    ['episode_get', await f.call('episode_get', { episodeId: episode.id })],
    ['episode_list', await f.call('episode_list', {})],
    ['workflow_plan', await f.call('workflow_plan', { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'all' } })],
    ['workflow_auto_layout', await f.call('workflow_auto_layout', { workflowId: workflow.id, expectedVersion: workflow.version })],
    ['episode_propose_storyboard', await f.call('episode_propose_storyboard', { episodeId: episode.id })],
  ];
  for (const [name, result] of results) assert.deepEqual(validateSchema(catalog.get(name).outputSchema, JSON.parse(JSON.stringify(result))), [], `${name}: a transported result must still match its published outputSchema`);
});
