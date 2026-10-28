import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, starterScene } from '../server/store.mjs';
import { addWorkflowNode, createWorkflowEditor, findWorkflowNodeSlot, introducesNewOverlap, workflowErrors, WIDTH, HEIGHT, NODE_PLACEMENT_MARGIN } from '../public/workflow.js';

// Regression coverage for repeated "Add Node" and multi-scene generation-node placement
// (findWorkflowNodeSlot) and manual drag/keyboard collision-revert (introducesNewOverlap):
// both call sites are public/workflow.js:1589 (add-node handler) and :1709 (openGeneration
// anchor branch) for the former, and :1818 (finishDrag) / :1832 (arrow-key move) for the
// latter. Every assertion below checks the documented CONTRACT (margin-clear placement,
// true-pixel-overlap revert, preserved prior geometry, null-on-exhaustion -> thrown error
// -> unmutated graph) against an independently derived formula, not a transcription of the
// implementation's specific boolean expression.

// Standard 1D interval gap: positive when the intervals are separated by that many units,
// <=0 when they touch or overlap. This is textbook interval-distance math, derived from
// first principles -- not copied from findWorkflowNodeSlot's own `free()` closure.
function gap(aStart, aEnd, bStart, bEnd) {
  return Math.max(bStart - aEnd, aStart - bEnd);
}

// A candidate footprint is "comfortably clear" of one obstacle if the two footprints are
// separated by at least `margin` on the x axis OR the y axis (matches the documented
// "clears ... by at least margin on some axis" contract).
function clearOfObstacle(x, y, node, { width = WIDTH, height = HEIGHT, margin = NODE_PLACEMENT_MARGIN } = {}) {
  return gap(x, x + width, node.x, node.x + width) >= margin || gap(y, y + height, node.y, node.y + height) >= margin;
}

function assertSlotClear(slot, obstacles, options = {}) {
  assert.ok(slot && Number.isFinite(slot.x) && Number.isFinite(slot.y), `slot must be a finite {x,y}: ${JSON.stringify(slot)}`);
  for (const node of obstacles) {
    assert.ok(clearOfObstacle(slot.x, slot.y, node, options), `returned slot ${JSON.stringify(slot)} is not margin-clear of existing node ${node.id} at (${node.x},${node.y})`);
  }
}

function assertAllPairsClear(nodes, options = {}) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      assert.ok(clearOfObstacle(nodes[i].x, nodes[i].y, nodes[j], options), `nodes ${nodes[i].id} (${nodes[i].x},${nodes[i].y}) and ${nodes[j].id} (${nodes[j].x},${nodes[j].y}) are not margin-clear of each other`);
    }
  }
}

// True axis-aligned rectangle intersection (margin 0, touching edges excluded) -- the
// standard AABB overlap test, independent of introducesNewOverlap's own rectsOverlap.
function trueOverlap(ax, ay, bx, by, width = WIDTH, height = HEIGHT) {
  return ax < bx + width && bx < ax + width && ay < by + height && by < ay + height;
}

// ---------------------------------------------------------------------------
// Part 1: findWorkflowNodeSlot (pure) -- the function both the repeated-Add-Node
// handler and the per-scene generation handler route their desired point through.
// ---------------------------------------------------------------------------

test('findWorkflowNodeSlot returns the rounded, clamped desired point untouched when no obstacles exist', () => {
  assert.deepEqual(findWorkflowNodeSlot([], { x: 100, y: 120 }), { x: 100, y: 120 });
  assert.deepEqual(findWorkflowNodeSlot([], { x: 100.4, y: 119.6 }), { x: 100, y: 120 });
  assert.deepEqual(findWorkflowNodeSlot([], {}), { x: 0, y: 0 }, 'a missing desired point defaults to the origin');
  assert.deepEqual(findWorkflowNodeSlot([], { x: -50, y: 50000 }), { x: 0, y: 10000 }, 'defaults clamp to the documented [0,10000] world');
  assert.deepEqual(findWorkflowNodeSlot([], { x: 15, y: 15 }, { minX: 10, minY: 10, maxX: 20, maxY: 20 }), { x: 15, y: 15 }, 'custom bounds are honored when the point already fits');
  assert.deepEqual(findWorkflowNodeSlot([], { x: 5, y: 500 }, { minX: 10, minY: 10, maxX: 20, maxY: 20 }), { x: 10, y: 20 }, 'custom bounds clamp out-of-range points on both axes independently');
});

test('findWorkflowNodeSlot leaves an already clear desired point unchanged even with unrelated obstacles present', () => {
  const far = { id: 'far', x: 5000, y: 5000 };
  const slot = findWorkflowNodeSlot([far], { x: 100, y: 120 });
  assert.deepEqual(slot, { x: 100, y: 120 });
});

test('findWorkflowNodeSlot ignores obstacles with non-finite coordinates instead of treating them as occupying space', () => {
  const malformed = [{ id: 'nan', x: NaN, y: 10 }, { id: 'missing-y', x: 10 }, { id: 'undefined', x: undefined, y: undefined }];
  assert.deepEqual(findWorkflowNodeSlot(malformed, { x: 10, y: 10 }), { x: 10, y: 10 }, 'malformed obstacles must not push an otherwise-free desired point away');
});

test('findWorkflowNodeSlot relocates a desired point that directly collides, and the relocation clears the colliding node by the margin', () => {
  const existing = [{ id: 'occupant', x: 100, y: 120 }];
  const slot = findWorkflowNodeSlot(existing, { x: 100, y: 120 });
  assert.notDeepEqual(slot, { x: 100, y: 120 }, 'a slot sitting exactly on an existing node must move');
  assertSlotClear(slot, existing);
  assert.ok(Number.isInteger(slot.x) && Number.isInteger(slot.y), 'returned coordinates stay integer (rounded)');
  assert.ok(slot.x >= 0 && slot.x <= 10000 && slot.y >= 0 && slot.y <= 10000, 'returned coordinates stay within the default world bounds');
});

test('findWorkflowNodeSlot treats a point exactly margin-distance away as already free (inclusive boundary)', () => {
  const existing = [{ id: 'occupant', x: 0, y: 0 }];
  // Exactly WIDTH+NODE_PLACEMENT_MARGIN to the right: the documented gap is ">= margin".
  const desired = { x: WIDTH + NODE_PLACEMENT_MARGIN, y: 0 };
  assert.deepEqual(findWorkflowNodeSlot(existing, desired), desired, 'a candidate exactly at the margin boundary must not be relocated');
});

test('findWorkflowNodeSlot relocates a point one pixel inside the margin boundary', () => {
  const existing = [{ id: 'occupant', x: 0, y: 0 }];
  const desired = { x: WIDTH + NODE_PLACEMENT_MARGIN - 1, y: 0 };
  const slot = findWorkflowNodeSlot(existing, desired);
  assert.notDeepEqual(slot, desired, 'a candidate one pixel inside the margin must be moved, not accepted');
  assertSlotClear(slot, existing);
});

test('findWorkflowNodeSlot never mutates the nodes array or node objects it is given (frozen-input safe)', () => {
  const nodes = Object.freeze([Object.freeze({ id: 'a', x: 100, y: 120, type: 'trend' }), Object.freeze({ id: 'b', x: 400, y: 400, type: 'trend' })]);
  const desired = Object.freeze({ x: 100, y: 120 });
  const before = structuredClone(nodes);
  assert.doesNotThrow(() => findWorkflowNodeSlot(nodes, desired), 'a pure function must not attempt to write through a frozen array or node');
  assert.deepEqual(nodes, before, 'nodes content must be byte-identical after the call');
});

test('repeated placement at the SAME fixed desired point (simulating repeated Add-Node clicks with no panning) keeps every new node pairwise separated', () => {
  // This is the exact shape of the pre-fix bug: public/workflow.js:1589 computes an
  // identical desired {x,y} from pan/scale on every click when the user never pans.
  const desired = { x: 100, y: 120 };
  const placed = [];
  for (let i = 0; i < 8; i++) {
    const slot = findWorkflowNodeSlot(placed, desired);
    assertSlotClear(slot, placed, {});
    placed.push({ id: `added-${i}`, x: slot.x, y: slot.y });
  }
  assert.equal(new Set(placed.map(node => `${node.x},${node.y}`)).size, 8, 'all 8 repeated placements landed on distinct coordinates');
  assertAllPairsClear(placed);
});

test('findWorkflowNodeSlot returns null when the search space is exhausted (tiny world, no escape)', () => {
  // minX===maxX===minY===maxY===0 collapses the entire ring search AND the phase-2
  // exhaustive grid scan onto the single point (0,0), which is occupied.
  const existing = [{ id: 'occupant', x: 0, y: 0 }];
  const slot = findWorkflowNodeSlot(existing, { x: 0, y: 0 }, { minX: 0, maxX: 0, minY: 0, maxY: 0, maxRing: 3 });
  assert.equal(slot, null, 'total exhaustion must return null, never a clamped-but-colliding fallback point');
});

test('findWorkflowNodeSlot respects the maxCells defensive cap and returns null rather than scanning an oversized grid', () => {
  // cols*rows for the real default bounds/margin is 41*56=2296; a maxCells below that
  // must short-circuit phase 2 even though empty space genuinely exists in the world.
  const slot = findWorkflowNodeSlot([{ id: 'occupant', x: 0, y: 0 }], { x: 0, y: 0 }, { maxRing: 0, maxCells: 10 });
  assert.equal(slot, null);
});

// ---------------------------------------------------------------------------
// Part 2: introducesNewOverlap (pure) -- gates manual drag/keyboard moves so a move
// that creates a BRAND NEW collision is reverted, while a node that already started
// overlapping something else may still move freely (escape is always allowed).
// ---------------------------------------------------------------------------

test('introducesNewOverlap allows a move between two positions that are clear of every obstacle both before and after', () => {
  const others = [{ id: 'other', x: 1000, y: 1000 }];
  assert.equal(introducesNewOverlap(0, 0, 50, 50, others), false);
});

test('introducesNewOverlap blocks a move that creates a brand new collision with a previously-clear node', () => {
  const others = [{ id: 'target', x: 300, y: 0 }];
  assert.equal(trueOverlap(0, 0, 300, 0), false, 'sanity: the starting position does not already overlap target');
  assert.equal(trueOverlap(250, 0, 300, 0), true, 'sanity: the destination does overlap target');
  assert.equal(introducesNewOverlap(0, 0, 250, 0, others), true);
});

test('introducesNewOverlap allows a node to escape a pre-existing overlap into genuinely clear space', () => {
  const others = [{ id: 'stuck-with', x: 0, y: 0 }];
  assert.equal(trueOverlap(10, 10, 0, 0), true, 'sanity: the FROM position already overlaps the obstacle');
  assert.equal(introducesNewOverlap(10, 10, 2000, 2000, others), false, 'escaping a pre-existing overlap into clear space is always allowed');
});

test('introducesNewOverlap blocks escaping ONE pre-existing overlap by landing on a DIFFERENT, previously-clear node', () => {
  const stuckWith = { id: 'stuck-with', x: 0, y: 0 };
  const innocent = { id: 'innocent-bystander', x: 500, y: 0 };
  assert.equal(introducesNewOverlap(10, 10, 450, 0, [stuckWith, innocent]), true, 'escaping one collision into a brand new one is still blocked');
});

test('introducesNewOverlap does not flag an unrelated pre-existing overlap that the move never touches', () => {
  // obstacle A already overlaps the FROM position; obstacle B is irrelevant to this move
  // and stays clear throughout. Moving away must not be blocked by A's unrelated overlap.
  const stuckWith = { id: 'a', x: 5, y: 5 };
  const faraway = { id: 'b', x: 9000, y: 9000 };
  assert.equal(introducesNewOverlap(0, 0, 700, 700, [stuckWith, faraway]), false);
});

test('introducesNewOverlap treats exactly touching edges as NOT overlapping (strict inequality, matches rectsOverlap)', () => {
  const others = [{ id: 'adjacent', x: WIDTH, y: 0 }];
  assert.equal(introducesNewOverlap(1000, 1000, 0, 0, others), false, 'landing exactly edge-to-edge is not a new overlap');
});

test('introducesNewOverlap never mutates the obstacle list it is given', () => {
  const others = Object.freeze([Object.freeze({ id: 'a', x: 0, y: 0 }), Object.freeze({ id: 'b', x: 500, y: 500 })]);
  const before = structuredClone(others);
  assert.doesNotThrow(() => introducesNewOverlap(0, 0, 100, 100, others));
  assert.deepEqual(others, before);
});

// ---------------------------------------------------------------------------
// Part 3: openGeneration integration (Node-only, Store-backed, no DOM) -- proves the
// real call site at public/workflow.js:1709 is actually wired to findWorkflowNodeSlot.
// ---------------------------------------------------------------------------

const model = 'bytedance/seedance-2.5/text-to-video';

// Hand-placed, non-overlapping base chain: script -> storyboard -> render -> review.
// Spacing (300 horizontal, 250 vertical) comfortably clears WIDTH/HEIGHT/MARGIN so the
// fixture's OWN geometry never trips the overlap assertions used against it below.
function baseGraph() {
  return {
    name: 'Placement fixture', version: 1,
    nodes: [
      { id: 'script', type: 'script', x: 40, y: 60, config: { agent: 'studio', prompt: '' } },
      { id: 'storyboard', type: 'storyboard', x: 340, y: 60, config: {} },
      { id: 'render', type: 'render', x: 640, y: 60, config: {} },
      { id: 'review', type: 'review', x: 940, y: 60, config: {} },
    ],
    edges: [
      { id: 'script-storyboard', source: 'script', target: 'storyboard' },
      { id: 'storyboard-render', source: 'storyboard', target: 'render' },
      { id: 'render-review', source: 'render', target: 'review' },
    ],
  };
}

async function editorFixture(t, templateGraph) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-node-placement-'));
  const store = new Store(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const channel = store.list('channels')[0];
  const episodes = [store.create('episodes', {
    id: 'episode-1', channelId: channel.id, version: 1, status: 'draft', format: '9:16', title: 'Placement episode',
    topic: 'Node placement fixture', scenes: [starterScene('A', 'Keep A'), starterScene('B', 'Keep B'), starterScene('C', 'Keep C')],
  })];
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

test('openGeneration creates a separate, non-overlapping generate node for each distinct scene instead of stacking them on the shared storyboard anchor', async t => {
  const existing = baseGraph();
  const f = await editorFixture(t, existing);
  const originalChain = structuredClone(f.workflow.nodes);

  const draftA = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 0 });
  assert.deepEqual(workflowErrors(draftA), []);
  const generateA = draftA.nodes.find(node => node.type === 'generate');
  assert.ok(generateA, 'scene 0 creates a generate node');
  assert.equal(generateA.config.sceneIndex, 0);
  for (const original of originalChain) assert.deepEqual(draftA.nodes.find(node => node.id === original.id), original, `${original.id} geometry must survive the first generation add untouched`);
  assertAllPairsClear(draftA.nodes);

  const draftB = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 1 });
  assert.deepEqual(workflowErrors(draftB), []);
  const generateNodesB = draftB.nodes.filter(node => node.type === 'generate');
  assert.equal(generateNodesB.length, 2, 'targeting a second distinct scene creates a second generate node rather than reusing the first');
  assert.ok(generateNodesB.some(node => node.config.sceneIndex === 1));
  assert.deepEqual(draftB.nodes.find(node => node.id === generateA.id), generateA, 'the first generate node is untouched by adding the second');
  for (const original of originalChain) assert.deepEqual(draftB.nodes.find(node => node.id === original.id), original, `${original.id} geometry must survive the second generation add untouched`);
  assertAllPairsClear(draftB.nodes);

  const draftC = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 2 });
  assert.deepEqual(workflowErrors(draftC), []);
  assert.equal(draftC.nodes.filter(node => node.type === 'generate').length, 3, 'a third distinct scene creates a third generate node');
  for (const original of originalChain) assert.deepEqual(draftC.nodes.find(node => node.id === original.id), original, `${original.id} geometry must survive all three generation adds untouched`);
  assertAllPairsClear(draftC.nodes);
});

test('openGeneration places a new scene\'s generate node clear of an already-saved generate node sharing the same storyboard anchor', async t => {
  const seeded = addWorkflowNode(baseGraph(), 'generate', {
    id: 'generate-existing', afterNodeId: 'storyboard', x: 340, y: 310,
    config: { model, prompt: 'existing', params: {}, sceneIndex: 0 },
  });
  assert.deepEqual(workflowErrors(seeded), []);
  const f = await editorFixture(t, seeded);
  const savedGenerate = structuredClone(f.workflow.nodes.find(node => node.type === 'generate'));

  const draft = await f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 1 });
  assert.deepEqual(workflowErrors(draft), []);
  const generateNodes = draft.nodes.filter(node => node.type === 'generate');
  assert.equal(generateNodes.length, 2, 'a scene with no sceneId/sceneIndex match creates a new node beside the existing one');
  assert.deepEqual(draft.nodes.find(node => node.id === savedGenerate.id), savedGenerate, 'the pre-existing saved generate node keeps its exact saved geometry and config');
  assertAllPairsClear(draft.nodes);
});

test('openGeneration throws a clear, non-destructive error and leaves the graph entirely unmutated when the canvas has no remaining space', async t => {
  // Builds the EXACT real-world worst case for public/workflow.js:1709's hardcoded,
  // non-overridable default bounds (world [0,10000]x[0,10000], width=210, height=140,
  // margin=40 -> stepX=250, stepY=180). Phase 1 (64 rings) and phase 2 (the full
  // 41-column x 56-row exhaustive grid, cols*rows=2296 <= maxCells=20000) both scan
  // grid-aligned points; an obstacle at EVERY point of that grid blocks phase 2
  // entirely. Phase 1's ring search is seeded from a grid-aligned anchor-derived
  // desired point (anchor.x+270=10000, anchor.y=9000, both multiples of the grid
  // step), so every non-clamped ring candidate also lands on a covered grid point;
  // candidates clamped to the y=10000 edge (reachable once a ring offset pushes
  // 9000+dy*180 past 10000, i.e. dy>=6) are NOT on the row-aligned grid (10000 is not
  // a multiple of 180), so one extra covering row at y=10000 closes that gap. x never
  // has an equivalent gap: every clamp target (x=0 or x=10000) already lands on an
  // existing grid column (0 and 10000 are both multiples of 250).
  const stepX = WIDTH + NODE_PLACEMENT_MARGIN, stepY = HEIGHT + NODE_PLACEMENT_MARGIN;
  const cols = Math.floor(10000 / stepX) + 1, rows = Math.floor(10000 / stepY) + 1;
  assert.equal(cols, 41); assert.equal(rows, 56);
  const packed = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) packed.push({ id: `pack-${row}-${col}`, type: 'trend', x: col * stepX, y: row * stepY, config: {} });
  for (let col = 0; col < cols; col++) packed.push({ id: `pack-edge-${col}`, type: 'trend', x: col * stepX, y: 10000, config: {} });

  // Pure-function proof that this exact construction truly exhausts the search, before
  // relying on it through the full editor/store integration below.
  const isolatedSlot = findWorkflowNodeSlot(packed, { x: 10000, y: 9000 });
  assert.equal(isolatedSlot, null, 'the hand-built obstacle grid must genuinely exhaust findWorkflowNodeSlot under its real default options');

  const graph = {
    name: 'Exhausted canvas fixture', version: 1,
    nodes: [
      { id: 'script', type: 'script', x: 9730, y: 8000, config: { agent: 'studio', prompt: '' } },
      { id: 'storyboard', type: 'storyboard', x: 9730, y: 9000, config: {} },
      ...packed,
    ],
    edges: [{ id: 'script-storyboard', source: 'script', target: 'storyboard' }],
  };
  const f = await editorFixture(t, graph);
  const before = structuredClone(f.workflow);
  assert.equal(f.editor.hasChanges(), false);

  await assert.rejects(
    f.editor.openGeneration({ episodeId: 'episode-1', sceneIndex: 0 }),
    error => error.message === '캔버스에 새 노드를 놓을 빈 공간이 없습니다. 기존 노드를 정리한 뒤 다시 시도하세요.',
    'an exhausted canvas must surface the exact documented no-space error',
  );
  assert.deepEqual(f.editor.getContext().workflow, before, 'a rejected placement must leave the loaded graph completely unmutated -- same node count, same ids, same geometry');
  assert.equal(f.editor.hasChanges(), false, 'a rejected placement must not create an unsaved dirty draft');
  assert.equal(f.calls.some(call => call.method && call.method !== 'GET'), false, 'a rejected placement must never reach a write API call');
});
