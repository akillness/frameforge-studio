import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGraphOps, autoLayout, blueprintFor, storyboardFor, MAX_PATCH_OPS, BLUEPRINT_STYLES, STORYBOARD_TONES, PATCH_OP_NAMES } from '../server/graph-patch.mjs';
import { validateSchema } from '../server/schema.mjs';
import { defaultWorkflow, validateWorkflow, TYPES, NODE_CONFIG_FIELDS } from '../server/workflows.mjs';
import { scenes as validateScenes, HttpError } from '../server/validation.mjs';

const chain = () => defaultWorkflow(); // trend→research→script→storyboard→render→review
const ids = (graph) => graph.nodes.map((node) => node.id);
const positions = (nodes) => Object.fromEntries(nodes.map((node) => [node.id, [node.x, node.y]]));
const rejects400 = (fn, pattern, contract) => assert.throws(fn, (error) => error instanceof HttpError && error.status === 400 && pattern.test(error.message), contract);
const shuffled = (items, seed) => { // deterministic Fisher-Yates so a failing order reproduces exactly
  const copy = [...items]; let state = seed;
  for (let index = copy.length - 1; index > 0; index--) { state = (state * 1103515245 + 12345) % 2147483648; const swap = state % (index + 1); [copy[index], copy[swap]] = [copy[swap], copy[index]]; }
  return copy;
};

// ── validateSchema ────────────────────────────────────────────────────────────────────────
test('validateSchema enforces the JSON Schema subset that guards every agent input and output', () => {
  const cases = [
    ['integer rejects fractions', { type: 'integer' }, 1.5, /expected integer/],
    ['integer accepts whole numbers', { type: 'integer' }, 2, null],
    ['number accepts integers', { type: 'number' }, 2, null],
    ['number rejects NaN', { type: 'number' }, NaN, /expected number/],
    ['number rejects Infinity', { type: 'number' }, Infinity, /expected number/],
    ['integer rejects numeric strings', { type: 'integer' }, '1', /expected integer/],
    ['union type accepts null', { type: ['string', 'null'] }, null, null],
    ['union type rejects other types', { type: ['string', 'null'] }, 4, /string or null/],
    ['enum rejects unlisted values', { enum: ['a', 'b'] }, 'c', /must be one of/],
    ['enum accepts listed values', { enum: ['a', 'b'] }, 'b', null],
    ['const rejects different values', { const: 'rule-based' }, 'other', /must equal/],
    ['minLength counts code points, not UTF-16 units', { type: 'string', minLength: 2 }, '😀', /shorter than 2/],
    ['maxLength counts code points, not UTF-16 units', { type: 'string', maxLength: 2 }, '😀😀', null],
    ['maxLength rejects longer text', { type: 'string', maxLength: 3 }, 'abcd', /longer than 3/],
    ['pattern is enforced', { type: 'string', pattern: '^[a-z]+$' }, 'abc1', /does not match pattern/],
    ['minimum is inclusive', { type: 'integer', minimum: 1 }, 1, null],
    ['below minimum is rejected', { type: 'integer', minimum: 1 }, 0, /below minimum/],
    ['maximum is inclusive', { type: 'integer', maximum: 3 }, 3, null],
    ['above maximum is rejected', { type: 'integer', maximum: 3 }, 4, /above maximum/],
    ['minItems', { type: 'array', minItems: 1 }, [], /fewer than 1/],
    ['maxItems', { type: 'array', maxItems: 1 }, [1, 2], /more than 1/],
    ['anyOf needs one matching branch', { anyOf: [{ type: 'string' }, { type: 'integer' }] }, true, /does not match any allowed shape/],
    ['anyOf accepts a matching branch', { anyOf: [{ type: 'string' }, { type: 'integer' }] }, 3, null],
    ['$ref is rejected rather than silently ignored', { $ref: '#/x' }, 1, /\$ref is not supported/],
    ['false schema allows nothing', false, 1, /no value is allowed/],
    ['true schema allows everything', true, { any: 'thing' }, null],
  ];
  for (const [name, schema, value, expected] of cases) {
    const problems = validateSchema(schema, value);
    if (expected) assert.ok(problems.some((problem) => expected.test(problem)), `${name}: expected a problem matching ${expected}, got ${JSON.stringify(problems)}`);
    else assert.deepEqual(problems, [], name);
  }
});

test('validateSchema reports required, unknown and nested-property errors with their paths', () => {
  const schema = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' }, items: { type: 'array', items: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } } } };
  assert.deepEqual(validateSchema(schema, { id: 'a', items: [{ n: 1 }] }), []);
  assert.deepEqual(validateSchema(schema, {}), ['$.id: required'], 'a missing required key is reported by path');
  assert.deepEqual(validateSchema(schema, { id: undefined }), ['$.id: required'], 'undefined must count as missing, because JSON drops it');
  assert.deepEqual(validateSchema(schema, { id: null }).length, 1, 'null is a present value of the wrong type, not a missing key');
  assert.ok(validateSchema(schema, { id: 'a', extra: 1 }).includes('$.extra: unknown field'), 'additionalProperties:false rejects unknown fields');
  assert.deepEqual(validateSchema({ ...schema, additionalProperties: true }, { id: 'a', extra: 1 }), [], 'additionalProperties:true tolerates unknown fields');
  const nested = validateSchema(schema, { id: 'a', items: [{ n: 1 }, { n: 'x' }, {}] });
  assert.ok(nested.some((problem) => problem.startsWith('$.items[1].n: expected integer')), `array index and property must appear in the path: ${nested}`);
  assert.ok(nested.some((problem) => problem === '$.items[2].n: required'));
  assert.ok(validateSchema(schema, []).some((problem) => /expected object/.test(problem)), 'an array is not an object');
  assert.ok(validateSchema({ type: 'object', additionalProperties: { type: 'integer' } }, { a: 1, b: 'x' }).some((problem) => problem.startsWith('$.b:')), 'schema-valued additionalProperties validates extra values');
});

test('validateSchema caps its error list and refuses pathologically deep schemas', () => {
  const problems = validateSchema({ type: 'array', items: { type: 'integer' } }, Array.from({ length: 100 }, () => 'x'));
  assert.ok(problems.length > 0 && problems.length <= 20, `error output must stay bounded, got ${problems.length}`);
  let schema = { type: 'integer' };
  for (let level = 0; level < 40; level++) schema = { type: 'array', items: schema };
  let value = 1;
  for (let level = 0; level < 40; level++) value = [value];
  assert.ok(validateSchema(schema, value).some((problem) => /nesting exceeds/.test(problem)), 'a too-deep schema must fail closed instead of recursing without bound');
});

// ── applyGraphOps ─────────────────────────────────────────────────────────────────────────
test('applyGraphOps is atomic: one bad op rejects the whole list and never mutates the input', () => {
  const workflow = chain();
  const before = structuredClone(workflow);
  assert.throws(() => applyGraphOps(workflow, [
    { op: 'rename', name: 'Renamed' },
    { op: 'addNode', type: 'layout', id: 'layout' },
    { op: 'setConfig', id: 'script', config: { agent: 'codex' } },
    { op: 'connect', source: 'nope', target: 'render' },
  ]), (error) => error instanceof HttpError && error.status === 400 && /Unknown source node "nope"/.test(error.message), 'the failing reason must be reported');
  assert.deepEqual(workflow, before, 'a rejected op list must leave the caller\'s workflow untouched');

  const ok = applyGraphOps(workflow, [{ op: 'rename', name: ' Next ' }, { op: 'setConfig', id: 'script', config: { agent: 'codex' } }]);
  assert.deepEqual(workflow, before, 'a successful apply must also not mutate its input');
  ok.graph.nodes.find((node) => node.id === 'script').config.agent = 'mutated';
  assert.equal(workflow.nodes.find((node) => node.id === 'script').config.agent, 'studio', 'the returned graph must be a deep copy');
});

test('applyGraphOps applies ops in order, so a node can be added and wired in one batch but not wired first', () => {
  const workflow = chain();
  const { graph, stats } = applyGraphOps(workflow, [
    { op: 'addNode', type: 'layout', id: 'layout', config: { preset: 'split' } },
    { op: 'connect', source: 'storyboard', target: 'layout' },
    { op: 'connect', source: 'layout', target: 'render' },
  ]);
  assert.deepEqual(stats, { nodesAdded: 1, nodesRemoved: 0, edgesAdded: 2, edgesRemoved: 0, nodesChanged: 0 });
  assert.equal(validateWorkflow(graph).nodes.length, workflow.nodes.length + 1, 'the batch result must be a valid workflow');
  assert.deepEqual(graph.nodes.at(-1).config, { preset: 'split' });
  rejects400(() => applyGraphOps(workflow, [{ op: 'connect', source: 'storyboard', target: 'layout' }, { op: 'addNode', type: 'layout', id: 'layout' }]), /Unknown target node "layout"/, 'order matters: connecting before adding must fail');
});

test('applyGraphOps rejects malformed operation lists and unknown operations or fields', () => {
  const workflow = chain();
  for (const [name, ops] of [['undefined', undefined], ['empty list', []], ['non-array', 'rename'], ['over the cap', Array.from({ length: MAX_PATCH_OPS + 1 }, () => ({ op: 'autoLayout' }))]]) {
    rejects400(() => applyGraphOps(workflow, ops), /ops must contain 1–100/, `${name} must be rejected`);
  }
  assert.equal(applyGraphOps(workflow, Array.from({ length: MAX_PATCH_OPS }, () => ({ op: 'autoLayout' }))).graph.nodes.length, workflow.nodes.length, 'exactly the cap is allowed');
  for (const op of [null, 1, 'rename', []]) rejects400(() => applyGraphOps(workflow, [op]), /ops\[0\] must be an object/, `op ${JSON.stringify(op)} must be an object`);
  rejects400(() => applyGraphOps(workflow, [{ op: 'explode' }]), /ops\[0\]\.op must be one of/, 'unknown op names are refused');
  rejects400(() => applyGraphOps(workflow, [{ name: 'x' }]), /ops\[0\]\.op must be one of/, 'a missing op name is refused');
  rejects400(() => applyGraphOps(workflow, [{ op: 'rename', name: 'x', extra: true }]), /unknown field "extra" for rename/, 'unknown fields are refused, not ignored');
  rejects400(() => applyGraphOps(workflow, [{ op: 'removeNode', id: 'script', x: 1 }]), /unknown field "x" for removeNode/, 'a field valid for another op is still unknown here');
  assert.deepEqual([...PATCH_OP_NAMES].sort(), ['addNode', 'autoLayout', 'connect', 'disconnect', 'removeNode', 'rename', 'replaceGraph', 'setConfig', 'setLabel', 'setPosition'], 'the op vocabulary is part of the public contract');
});

test('rename trims and refuses blank or non-text names', () => {
  const workflow = chain();
  assert.equal(applyGraphOps(workflow, [{ op: 'rename', name: '  새 이름  ' }]).graph.name, '새 이름');
  for (const name of ['', '   ', undefined, 5, null]) rejects400(() => applyGraphOps(workflow, [{ op: 'rename', name }]), /name required/, `name ${JSON.stringify(name)} must be rejected`);
});

test('addNode allocates unique ids and positions right of the graph, and refuses bad ids and types', () => {
  const workflow = chain();
  const { graph } = applyGraphOps(workflow, [{ op: 'addNode', type: 'layout' }, { op: 'addNode', type: 'layout' }, { op: 'addNode', type: 'layout', id: 'layout-3', x: 5, y: 7, label: 'L', notes: 'N' }]);
  const added = graph.nodes.slice(workflow.nodes.length);
  assert.deepEqual(added.map((node) => node.id), ['layout-1', 'layout-2', 'layout-3']);
  assert.equal(new Set(ids(graph)).size, graph.nodes.length, 'generated ids must never collide');
  const rightmost = Math.max(...workflow.nodes.map((node) => node.x));
  assert.ok(added[0].x > rightmost && added[1].x > added[0].x, 'default positions advance to the right so nodes do not overlap');
  assert.deepEqual([added[2].x, added[2].y, added[2].label, added[2].notes], [5, 7, 'L', 'N'], 'explicit placement and text are honoured');
  const skipOccupied = applyGraphOps({ ...workflow, nodes: [...workflow.nodes, { id: 'layout-1', type: 'layout', x: 0, y: 0, config: {} }] }, [{ op: 'addNode', type: 'layout' }]);
  assert.equal(skipOccupied.graph.nodes.at(-1).id, 'layout-2', 'a generated id must skip ids already in use');
  rejects400(() => applyGraphOps(workflow, [{ op: 'addNode', type: 'layout', id: 'render' }]), /node "render" already exists/, 'duplicate ids are refused');
  rejects400(() => applyGraphOps(workflow, [{ op: 'addNode', type: 'layout', id: 'bad id!' }]), /id must use letters, digits/, 'unsafe ids are refused');
  rejects400(() => applyGraphOps(workflow, [{ op: 'addNode', type: 'explode' }]), /type must be one of/, 'unknown node types are refused');
  rejects400(() => applyGraphOps(workflow, [{ op: 'addNode' }]), /type must be one of/, 'a missing type is refused');
});

test('addNode refuses to grow a workflow past 128 nodes', () => {
  const nodes = Array.from({ length: 128 }, (_, index) => ({ id: `n${index}`, type: 'research', x: index, y: 0, config: {} }));
  rejects400(() => applyGraphOps({ name: 'big', nodes, edges: [] }, [{ op: 'addNode', type: 'research' }]), /already has 128 nodes/, 'the node cap must hold inside a patch, not only at save time');
});

test('removeNode drops incident edges, reports them, and never empties the graph', () => {
  const workflow = chain();
  const { graph, stats } = applyGraphOps(workflow, [{ op: 'removeNode', id: 'script' }]);
  assert.ok(!ids(graph).includes('script'));
  assert.ok(graph.edges.every((edge) => edge.source !== 'script' && edge.target !== 'script'), 'no dangling edge may reference a removed node');
  assert.deepEqual([stats.nodesRemoved, stats.edgesRemoved], [1, 2], 'both edges touching the removed node are counted');
  assert.throws(() => validateWorkflow(graph), /connected/, 'the unwired remainder is invalid, which is why the caller must validate before saving');
  const repaired = applyGraphOps(workflow, [{ op: 'removeNode', id: 'script' }, { op: 'connect', source: 'research', target: 'storyboard' }]);
  assert.doesNotThrow(() => validateWorkflow(repaired.graph), 'a later op in the same batch may repair an intermediate invalid state');
  rejects400(() => applyGraphOps(workflow, [{ op: 'removeNode', id: 'ghost' }]), /Unknown node "ghost"/, 'removing a missing node is an error, not a no-op');
  const single = { name: 's', nodes: [{ id: 'trend', type: 'trend', x: 0, y: 0, config: {} }], edges: [] };
  rejects400(() => applyGraphOps(single, [{ op: 'removeNode', id: 'trend' }]), /final node cannot be removed/, 'the last node must survive');
  rejects400(() => applyGraphOps(workflow, [{ op: 'removeNode', id: 'trend' }, { op: 'removeNode', id: 'trend' }]), /Unknown node "trend"/, 'ids are resolved against the working copy, not the original');
});

test('setConfig merges, unsets, and only accepts fields that belong to the node type', () => {
  const workflow = chain();
  const config = (graph, id) => graph.nodes.find((node) => node.id === id).config;
  const merged = applyGraphOps(workflow, [{ op: 'setConfig', id: 'script', config: { agent: 'codex' } }]).graph;
  assert.equal(config(merged, 'script').agent, 'codex');
  assert.equal(config(merged, 'script').prompt, config(workflow, 'script').prompt, 'untouched keys survive a merge');
  assert.deepEqual(config(applyGraphOps(workflow, [{ op: 'setConfig', id: 'script', config: { agent: 'codex' }, unset: ['prompt'] }]).graph, 'script'), { agent: 'codex' }, 'unset removes keys after the merge');
  const withNode = applyGraphOps(workflow, [{ op: 'setConfig', id: 'research', config: { limit: 3 } }, { op: 'setConfig', id: 'research', unset: ['limit'] }]).graph;
  assert.deepEqual(config(withNode, 'research'), {}, 'config may be omitted when only unsetting');
  rejects400(() => applyGraphOps(workflow, [{ op: 'setConfig', id: 'script', config: { model: 'm' } }]), /"model" is not a script configuration field/, 'a generate-only key must not be settable on a script node');
  rejects400(() => applyGraphOps(workflow, [{ op: 'setConfig', id: 'render', config: { anything: 1 } }]), /"anything" is not a render configuration field/, 'node types without config accept nothing');
  rejects400(() => applyGraphOps(workflow, [{ op: 'setConfig', id: 'script', unset: ['nope'] }]), /"nope" is not a script configuration field/, 'unset keys are checked against the same allow-list');
  rejects400(() => applyGraphOps(workflow, [{ op: 'setConfig', id: 'script', config: ['agent'] }]), /config must be an object/, 'config must be an object');
  rejects400(() => applyGraphOps(workflow, [{ op: 'setConfig', id: 'script', unset: 'prompt' }]), /unset must be an array/, 'unset must be an array');
  rejects400(() => applyGraphOps(workflow, [{ op: 'setConfig', id: 'ghost', config: {} }]), /Unknown node "ghost"/, 'unknown node');
  rejects400(() => applyGraphOps(workflow, [{ op: 'setConfig', id: 'script', config: JSON.parse('{"__proto__":{"x":1}}') }]), /"__proto__" is not a script configuration field/, 'prototype keys must not be accepted as config');
  for (const type of TYPES) assert.ok(Array.isArray(NODE_CONFIG_FIELDS[type]), `every node type has a config allow-list: ${type}`);
});

test('setLabel, setPosition and disconnect validate their inputs', () => {
  const workflow = chain();
  const patched = applyGraphOps(workflow, [{ op: 'setLabel', id: 'script', label: '대본' }, { op: 'setLabel', id: 'script', notes: '메모' }, { op: 'setPosition', id: 'script', x: 12.5, y: -4 }]).graph.nodes.find((node) => node.id === 'script');
  assert.deepEqual([patched.label, patched.notes, patched.x, patched.y], ['대본', '메모', 12.5, -4]);
  rejects400(() => applyGraphOps(workflow, [{ op: 'setLabel', id: 'script' }]), /label or notes required/, 'an empty setLabel changes nothing and must say so');
  for (const [x, y] of [[NaN, 1], [1, Infinity], ['1', 1], [undefined, 1]]) rejects400(() => applyGraphOps(workflow, [{ op: 'setPosition', id: 'script', x, y }]), /x and y must be finite numbers/, `position ${String(x)},${String(y)} must be rejected`);
  const byId = applyGraphOps(workflow, [{ op: 'disconnect', id: 'edge-1' }]);
  assert.equal(byId.graph.edges.length, workflow.edges.length - 1);
  assert.equal(byId.stats.edgesRemoved, 1);
  const byEnds = applyGraphOps(workflow, [{ op: 'disconnect', source: 'research', target: 'script' }]);
  assert.ok(!byEnds.graph.edges.some((edge) => edge.source === 'research' && edge.target === 'script'));
  rejects400(() => applyGraphOps(workflow, [{ op: 'disconnect', source: 'research', target: 'review' }]), /no such edge/, 'disconnecting a missing edge is an error');
  rejects400(() => applyGraphOps(workflow, [{ op: 'disconnect', source: 'research' }]), /id or source\+target required/, 'half an edge reference is ambiguous');
});

test('connect refuses self edges, duplicates, unknown nodes and every kind of cycle', () => {
  const workflow = chain();
  rejects400(() => applyGraphOps(workflow, [{ op: 'connect', source: 'script', target: 'script' }]), /self edges are not allowed/, 'self edge');
  rejects400(() => applyGraphOps(workflow, [{ op: 'connect', source: 'trend', target: 'research' }]), /already exists/, 'duplicate edge');
  rejects400(() => applyGraphOps(workflow, [{ op: 'connect', source: 'research', target: 'trend' }]), /would create a cycle/, 'direct back-edge');
  rejects400(() => applyGraphOps(workflow, [{ op: 'connect', source: 'review', target: 'trend' }]), /would create a cycle/, 'a long back-edge must be caught transitively, not only between neighbours');
  rejects400(() => applyGraphOps(workflow, [{ op: 'connect', source: 'trend', target: 'ghost' }]), /Unknown target node "ghost"/, 'unknown target');
  rejects400(() => applyGraphOps(workflow, [{ op: 'connect', source: 'ghost', target: 'trend' }]), /Unknown source node "ghost"/, 'unknown source');
  const forward = applyGraphOps(workflow, [{ op: 'connect', source: 'trend', target: 'script' }, { op: 'connect', source: 'research', target: 'render' }]).graph;
  assert.equal(new Set(forward.edges.map((edge) => edge.id)).size, forward.edges.length, 'generated edge ids must be unique');
  assert.deepEqual(forward.edges.slice(-2).map((edge) => `${edge.source}>${edge.target}`), ['trend>script', 'research>render']);
  rejects400(() => applyGraphOps(workflow, [{ op: 'connect', source: 'trend', target: 'script', id: 'edge-1' }]), /edge id must be unique/, 'explicit edge ids must not collide');
  rejects400(() => applyGraphOps(workflow, [{ op: 'disconnect', source: 'research', target: 'script' }, { op: 'connect', source: 'script', target: 'research' }, { op: 'connect', source: 'research', target: 'script' }]), /would create a cycle/, 'cycle detection sees edges added earlier in the same batch');
});

test('replaceGraph swaps the whole graph and requires both arrays', () => {
  const workflow = chain();
  const nodes = [{ id: 'script', type: 'script', x: 0, y: 0, config: { agent: 'studio' } }];
  const { graph, stats } = applyGraphOps(workflow, [{ op: 'replaceGraph', name: ' Fresh ', nodes, edges: [] }]);
  assert.deepEqual([graph.name, graph.nodes, graph.edges], ['Fresh', nodes, []]);
  assert.deepEqual([stats.nodesRemoved, stats.nodesAdded, stats.edgesRemoved], [workflow.nodes.length, 1, workflow.edges.length]);
  graph.nodes[0].config.agent = 'mutated';
  assert.equal(nodes[0].config.agent, 'studio', 'the replacement must be copied, not aliased to the caller\'s array');
  rejects400(() => applyGraphOps(workflow, [{ op: 'replaceGraph', nodes }]), /nodes and edges arrays required/, 'edges are required');
  rejects400(() => applyGraphOps(workflow, [{ op: 'replaceGraph', nodes, edges: [], name: ' ' }]), /name must be text/, 'a blank replacement name is refused');
});

test('applyGraphOps leaves final validity to the caller: invalid results are returned, then rejected by validateWorkflow', () => {
  const workflow = chain();
  const { graph } = applyGraphOps(workflow, [{ op: 'addNode', type: 'layout', id: 'publish' }]); // id shadows a different stage type
  assert.equal(graph.nodes.length, workflow.nodes.length + 1, 'applyGraphOps itself does not run workflow validation');
  assert.throws(() => validateWorkflow(graph), (error) => error instanceof HttpError && error.status === 400, 'but the caller\'s validation must refuse that graph');
});

// ── autoLayout ────────────────────────────────────────────────────────────────────────────
const diamond = () => ({
  nodes: ['a', 'b', 'c', 'd', 'z'].map((id) => ({ id, type: 'research', x: 7, y: 3, config: {}, label: id.toUpperCase() })),
  edges: [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['a', 'd']].map(([source, target]) => ({ id: `${source}-${target}`, source, target })),
});

test('autoLayout produces a left-to-right longest-path layout on a 10px grid without touching anything but coordinates', () => {
  const fixtures = { default: chain(), diamond: diamond(), blueprint: blueprintFor({ topic: 't', includeGeneration: true, includePublish: true, model: 'm/x' }) };
  for (const [name, graph] of Object.entries(fixtures)) {
    const before = structuredClone(graph);
    const laid = autoLayout(graph.nodes, graph.edges);
    assert.deepEqual(graph, before, `${name}: input must not be mutated`);
    assert.deepEqual(laid.map(({ x, y, ...rest }) => rest), graph.nodes.map(({ x, y, ...rest }) => rest), `${name}: ids, order and every non-coordinate field are preserved`);
    for (const node of laid) assert.ok(node.x % 10 === 0 && node.y % 10 === 0 && Number.isFinite(node.x) && Number.isFinite(node.y), `${name}: ${node.id} must be on the 10px grid`);
    const at = Object.fromEntries(laid.map((node) => [node.id, node]));
    for (const edge of graph.edges) assert.ok(at[edge.source].x < at[edge.target].x, `${name}: edge ${edge.source}→${edge.target} must run left to right`);
    const cells = new Set(laid.map((node) => `${node.x},${node.y}`));
    assert.equal(cells.size, laid.length, `${name}: two nodes must never share a position`);
  }
});

test('autoLayout uses longest-path depth, so a join sits right of every branch that feeds it', () => {
  const { nodes, edges } = diamond();
  const at = Object.fromEntries(autoLayout(nodes, edges).map((node) => [node.id, node]));
  assert.ok(at.a.x < at.b.x && at.b.x === at.c.x && at.c.x < at.d.x, 'a shortcut edge a→d must not pull d next to b');
  assert.notEqual(at.b.y, at.c.y, 'parallel branches in one column take different rows');
  assert.equal(at.z.x, at.a.x, 'an isolated node starts in the first column');
});

test('autoLayout is deterministic and independent of input node order', () => {
  const { nodes, edges } = diamond();
  const expected = positions(autoLayout(nodes, edges));
  assert.deepEqual(positions(autoLayout(nodes, edges)), expected, 'same input, same output');
  for (const seed of [1, 2, 3, 4, 5]) assert.deepEqual(positions(autoLayout(shuffled(nodes, seed), edges)), expected, `shuffling nodes (seed ${seed}) must not move anything`);
  const blueprint = blueprintFor({ topic: 'x', includeGeneration: true, model: 'm/x' });
  const reference = positions(autoLayout(blueprint.nodes, blueprint.edges));
  for (const seed of [11, 12, 13]) assert.deepEqual(positions(autoLayout(shuffled(blueprint.nodes, seed), blueprint.edges)), reference, `blueprint layout must be stable under shuffling (seed ${seed})`);
});

test('autoLayout fails safe on empty input, unknown edge endpoints and an unexpected cycle', () => {
  assert.deepEqual(autoLayout([], []), []);
  const two = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 0 }];
  const dangling = autoLayout(two, [{ source: 'a', target: 'ghost' }, { source: 'ghost', target: 'b' }]);
  assert.equal(dangling.length, 2, 'edges to unknown nodes are ignored, nodes are kept');
  const cyclic = autoLayout(two, [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }]);
  assert.deepEqual(cyclic.map((node) => node.id), ['a', 'b'], 'a cycle that slipped past validation must not drop nodes or hang');
  assert.ok(cyclic.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
});

test('the autoLayout op moves coordinates only: names, ids, edges and config are unchanged', () => {
  const workflow = chain();
  const { graph } = applyGraphOps(workflow, [{ op: 'setPosition', id: 'script', x: 9999, y: 9999 }, { op: 'autoLayout' }]);
  assert.deepEqual(graph.edges, workflow.edges);
  assert.equal(graph.name, workflow.name);
  assert.deepEqual(graph.nodes.map(({ x, y, ...rest }) => rest), workflow.nodes.map(({ x, y, ...rest }) => rest));
  assert.notEqual(graph.nodes.find((node) => node.id === 'script').x, 9999, 'layout must override an earlier manual position in the same batch');
});

// ── blueprintFor ──────────────────────────────────────────────────────────────────────────
test('every blueprint style/generation/publish/model combination is a valid, human-gated workflow proposal', () => {
  for (const style of BLUEPRINT_STYLES) for (const includeGeneration of [false, true]) for (const includePublish of [false, true]) for (const model of [undefined, 'bytedance/seedance-2.5/text-to-video']) {
    const label = `${style} gen=${includeGeneration} publish=${includePublish} model=${model}`;
    const blueprint = blueprintFor({ topic: '검증 가능한 주제', style, includeGeneration, includePublish, model });
    assert.doesNotThrow(() => validateWorkflow(blueprint), `${label}: must pass the same validation as save`);
    assert.equal(blueprint.engine, 'rule-based', label);
    const generate = blueprint.nodes.filter((node) => node.type === 'generate');
    assert.equal(generate.length, includeGeneration && model ? 1 : 0, `${label}: a generate node exists only when generation was requested AND a model was supplied`);
    if (generate.length) assert.equal(generate[0].config.model, model, `${label}: the supplied model id is used verbatim`);
    assert.equal(blueprint.warnings.length > 0, includeGeneration && !model, `${label}: an omitted generate node must be explained by a warning`);
    for (const node of generate) assert.ok(blueprint.edges.some((edge) => edge.source === 'storyboard' && edge.target === node.id) && blueprint.edges.some((edge) => edge.source === node.id && edge.target === 'render'), `${label}: generate sits between storyboard and render`);
    const types = blueprint.nodes.map((node) => node.type);
    assert.ok(types.includes('render') && types.includes('review'), `${label}: render and human review are always present`);
    assert.equal(types.includes('publish'), includePublish, label);
    if (includePublish) {
      const publish = blueprint.nodes.find((node) => node.type === 'publish');
      assert.equal(publish.config.visibility, 'private', `${label}: publication must start private`);
      assert.deepEqual(blueprint.edges.filter((edge) => edge.target === publish.id).map((edge) => edge.source), ['review'], `${label}: publish is reachable only through review`);
    }
  }
});

test('blueprint node ids never shadow another stage type and the style picks the right source stage', () => {
  const news = blueprintFor({ topic: '금리', style: 'news' });
  assert.deepEqual(news.nodes.slice(0, 1).map((node) => [node.type, node.config.query]), [['news', '금리']]);
  assert.ok(!news.nodes.some((node) => node.type === 'trend'));
  const explainer = blueprintFor({ topic: '금리', style: 'explainer' });
  assert.equal(explainer.nodes[0].type, 'trend');
  assert.ok(explainer.nodes.find((node) => node.type === 'script').config.prompt.includes('금리'), 'the topic reaches the script prompt');
  assert.ok(explainer.name.includes('금리'));
  assert.deepEqual(blueprintFor({ topic: '금리', style: 'short-hook', includePublish: true }), blueprintFor({ topic: '금리', style: 'short-hook', includePublish: true }), 'blueprints are deterministic');
  assert.notDeepEqual(blueprintFor({ topic: 'a', style: 'news' }).nodes.find((node) => node.type === 'script').config.prompt, blueprintFor({ topic: 'a', style: 'short-hook' }).nodes.find((node) => node.type === 'script').config.prompt, 'styles produce different script prompts');
});

test('blueprintFor rejects blank, oversized and non-text topics and unknown styles', () => {
  for (const topic of [undefined, null, '', '   ', 5, 'x'.repeat(301)]) rejects400(() => blueprintFor({ topic }), /topic must be 1–300 characters/, `topic ${String(topic).slice(0, 10)} must be rejected`);
  rejects400(() => blueprintFor({ topic: 'ok', style: 'documentary' }), /style must be one of/, 'unknown style');
  assert.doesNotThrow(() => blueprintFor({ topic: 'x'.repeat(200) }));
});

test('blueprint topics up to the advertised 300 characters validate; the collector query is clipped to 200 with a warning and the script keeps the full topic', () => {
  for (const style of BLUEPRINT_STYLES) {
    for (const length of [1, 100, 200]) {
      const blueprint = blueprintFor({ topic: 'a'.repeat(length), style });
      assert.doesNotThrow(() => validateWorkflow(blueprint), `${style}: topic of ${length} characters must validate`);
      assert.deepEqual(blueprint.warnings, [], `${style}: a topic that fits must not produce a truncation warning`);
    }
    for (const length of [201, 250, 300]) {
      const topic = `${'가'.repeat(length - 1)}끝`;
      const blueprint = blueprintFor({ topic, style });
      assert.doesNotThrow(() => validateWorkflow(blueprint), `${style}: topic of ${length} characters is accepted by blueprintFor, so its result must validate`);
      const source = blueprint.nodes.find((node) => node.type === (style === 'news' ? 'news' : 'trend'));
      assert.equal(source.config.query.length, 200, `${style}: the collector query is clipped to the 200-character validation cap`);
      assert.equal(source.config.query, topic.slice(0, 200), `${style}: the clipped query is a prefix of the topic`);
      assert.ok(blueprint.warnings.length > 0 && blueprint.warnings.every((line) => line.trim()), `${style}: clipping must be disclosed in warnings`);
      assert.ok(blueprint.nodes.find((node) => node.type === 'script').config.prompt.includes(topic), `${style}: the script prompt keeps the full topic`);
    }
  }
});

test('blueprint query clipping never splits a surrogate pair', () => {
  const topic = '😀'.repeat(150); // 300 UTF-16 units, 150 characters
  const blueprint = blueprintFor({ topic, style: 'explainer' });
  assert.doesNotThrow(() => validateWorkflow(blueprint), 'an emoji-only topic of maximum length must validate');
  const query = blueprint.nodes.find((node) => node.type === 'trend').config.query;
  assert.ok(query.length <= 200 && query === '😀'.repeat(query.length / 2), `query must be whole emoji, got ${JSON.stringify(query)}`);
  assert.ok(blueprint.warnings.length > 0);
});

// ── storyboardFor ─────────────────────────────────────────────────────────────────────────
test('storyboards of every supported size and tone pass scene validation, with or without a brief', () => {
  const brief = '첫째 근거입니다. 둘째 근거입니다! 셋째 근거입니까? 넷째 근거입니다. 다섯째 근거입니다. 여섯째 근거입니다.';
  for (const sceneCount of [3, 4, 5, 6, 7, 8]) for (const tone of STORYBOARD_TONES) for (const withBrief of [false, true]) {
    const label = `${sceneCount} scenes, ${tone}, brief=${withBrief}`;
    const { scenes, rationale } = storyboardFor({ title: '제목', topic: '주제', brief: withBrief ? brief : undefined, sceneCount, tone });
    assert.equal(scenes.length, sceneCount, label);
    assert.doesNotThrow(() => validateScenes(scenes), `${label}: scenes must pass the same validation as episode_update`);
    assert.equal(new Set(scenes.map((scene) => scene.id)).size, sceneCount, `${label}: scene ids are unique`);
    assert.ok(scenes.every((scene) => scene.text.trim() && scene.narration.trim() && !/undefined|null/.test(scene.text)), `${label}: no scene may be blank or contain a stringified undefined`);
    assert.ok(rationale.length >= 2 && rationale.every((line) => line.trim()), label);
    assert.ok(scenes[0].text.includes('주제') && scenes.at(-1).text.includes('주제'), `${label}: hook and wrap-up are about the subject`);
  }
});

test('storyboard places brief sentences on the middle scenes in order and admits when there is no brief', () => {
  const withBrief = storyboardFor({ title: 'T', brief: 'Alpha one. Bravo two! Charlie three?', sceneCount: 5 });
  assert.deepEqual(withBrief.scenes.slice(1, 4).map((scene) => scene.text), ['Alpha one.', 'Bravo two!', 'Charlie three?']);
  const without = storyboardFor({ title: 'T', sceneCount: 3 });
  assert.ok(without.rationale.some((line) => /직접 작성|주제만으로/.test(line)), 'a placeholder outline must say it is a placeholder');
  assert.equal(storyboardFor({ title: '제목만' }).scenes[0].text.includes('제목만'), true, 'title is the subject when no topic is given');
  assert.equal(storyboardFor({ title: '제목', topic: '주제' }).scenes[0].text.includes('주제'), true, 'topic wins over title');
});

test('storyboards stay valid for oversized topics and briefs and refuse out-of-range requests', () => {
  assert.doesNotThrow(() => validateScenes(storyboardFor({ topic: '가'.repeat(1500), brief: `${'문장입니다. '.repeat(400)}`, sceneCount: 8 }).scenes), 'oversized text must be clipped, not rejected downstream');
  for (const sceneCount of [2, 9, 4.5, '4', NaN, -1]) rejects400(() => storyboardFor({ title: 't', sceneCount }), /sceneCount must be an integer from 3 to 8/, `sceneCount ${String(sceneCount)} must be rejected`);
  rejects400(() => storyboardFor({ title: 't', tone: 'sarcastic' }), /tone must be one of/, 'unknown tone');
});
