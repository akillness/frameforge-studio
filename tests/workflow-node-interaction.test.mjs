import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';
import { WIDTH, HEIGHT, NODE_PLACEMENT_MARGIN } from '../public/workflow.js';

// Real-browser regression coverage (not mocked/stubbed) for:
//  - repeated "Add Node" clicks keeping every new node margin-clear of prior nodes, with
//    all prior geometry preserved and undo restoring it exactly (public/workflow.js:1589);
//  - manual drag (public/workflow.js:1818 finishDrag) and keyboard arrow moves
//    (public/workflow.js:1832) reverting a move that would introduce a BRAND NEW overlap,
//    while a node that already started overlapping something else may still escape into
//    clear space, and boundary clamping still applies.
// Fixture pattern adapted from tests/workflow-empty-state.test.mjs (lightweight
// createWorkflowEditor mount via page.evaluate -- no channel/episode navigation needed).

const modulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-node-interaction-'));
  const forbidden = async () => { assert.fail('Node interaction geometry editing must never invoke an external producer'); };
  let app, browser, context;
  const writes = [], external = [], errors = [];
  t.after(async () => {
    try { await context?.close(); await browser?.close(); }
    finally {
      if (app?.listening) await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    assert.deepEqual(external, [], 'all browser traffic stays on the fixture origin');
    assert.deepEqual(errors, [], 'drag/keyboard/add-node editing cannot throw page errors');
  });
  app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), runAgent: forbidden, fetchTrends: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath });
  context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
    return route.continue();
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  return { page, context, base, writes, api };
}

async function mountEditor(f) {
  await f.context.route('**/__workflow-interaction-test', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workflow.css"></head><body><main id="test-root"><div id="workflow-host"></div></main></body></html>',
  }));
  await f.page.goto(`${f.base}/__workflow-interaction-test`);
  await f.page.evaluate(async () => {
    const { createWorkflowEditor } = await import('/workflow.js');
    window.editorErrors = [];
    window.editor = createWorkflowEditor({
      api: async (path, options = {}) => {
        const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        return result;
      },
      getEpisodes: () => [],
      toast: (message, isError) => { if (isError) window.editorErrors.push(message); },
    });
    window.editor.mount();
  });
}

// Mirrors tests/workflow-empty-state.test.mjs's loadAndRemount: load() alone updates
// internal state but mount() only paints once at mount time, so a workflow created via
// the real API (see fixture()'s api()) must be loaded through this destroy+reinject+
// remount cycle to actually render.
async function loadAndRemount(page) {
  await page.evaluate(async () => {
    await window.editor.load();
    window.editor.destroy();
    document.querySelector('#test-root').innerHTML = window.editor.html();
    window.editor.mount();
  });
}

async function canvas(page) {
  return page.locator('#workflow-canvas .wf-node').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.nodeId, x: Number.parseFloat(node.style.left), y: Number.parseFloat(node.style.top) })));
}

const node = (page, id) => page.locator(`.wf-node[data-node-id="${id}"]`);
const header = (page, id) => page.locator(`.wf-node-header[data-id="${id}"]`);

// Independently-derived margin-clearance / true-overlap checks -- see
// tests/workflow-node-placement.test.mjs for the full derivation and rationale; kept as
// local, duplicated pure helpers here per this repo's no-cross-test-file-import convention.
function gap(aStart, aEnd, bStart, bEnd) { return Math.max(bStart - aEnd, aStart - bEnd); }
function clearOfObstacle(a, b, { width = WIDTH, height = HEIGHT, margin = NODE_PLACEMENT_MARGIN } = {}) {
  return gap(a.x, a.x + width, b.x, b.x + width) >= margin || gap(a.y, a.y + height, b.y, b.y + height) >= margin;
}
function assertAllPairsClear(nodes, message) {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    assert.ok(clearOfObstacle(nodes[i], nodes[j]), `${message || 'nodes must stay margin-clear'}: ${nodes[i].id}(${nodes[i].x},${nodes[i].y}) vs ${nodes[j].id}(${nodes[j].x},${nodes[j].y})`);
  }
}
function trueOverlap(a, b, width = WIDTH, height = HEIGHT) {
  return a.x < b.x + width && b.x < a.x + width && a.y < b.y + height && b.y < a.y + height;
}
// Drag/arrow-key moves are gated by introducesNewOverlap, which only blocks TRUE pixel
// overlap (margin 0) -- a correctly-working move may legitimately leave nodes touching or
// close together, so this (not the margin-based assertAllPairsClear above, which is the
// right check only for findWorkflowNodeSlot's placement contract) is the correct invariant
// for the drag/arrow tests below.
function assertNoTrueOverlap(nodes, message) {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    assert.equal(trueOverlap(nodes[i], nodes[j]), false, `${message || 'nodes must not truly overlap'}: ${nodes[i].id}(${nodes[i].x},${nodes[i].y}) vs ${nodes[j].id}(${nodes[j].x},${nodes[j].y})`);
  }
}

async function addNode(page, { type = 'trend', label }) {
  await page.locator('[data-wf-action=open-add-node]').click();
  await page.locator('#wf-add-node-dialog #wf-add-type').selectOption(type);
  if (label) await page.locator('#wf-add-node-dialog #wf-add-label').fill(label);
  await page.locator('#wf-add-node-dialog [data-wf-action=add-node]').click();
  await page.locator('#wf-tools-dialog[open]').waitFor();
  const addedId = await page.locator('.wf-node.selected').getAttribute('data-node-id');
  await page.keyboard.press('Escape');
  await page.locator('#wf-tools-dialog').waitFor({ state: 'hidden' });
  return addedId;
}

// Drags a node's header from its current rendered screen position to a TARGET WORLD
// coordinate, by deriving the live canvas scale from the node's own rendered bounding box
// (CSS sets `.wf-node { width: 210px }` in world space, so renderedWidth/WIDTH === scale)
// and converting the world-space delta into the matching screen-space mouse delta. This
// keeps the test exact and deterministic regardless of whatever scale/pan auto-fit chose.
async function dragNodeTo(page, id, targetX, targetY) {
  const before = (await canvas(page)).find(item => item.id === id);
  const box = await node(page, id).boundingBox();
  const scale = box.width / WIDTH;
  const headerBox = await header(page, id).boundingBox();
  const startX = headerBox.x + headerBox.width / 2, startY = headerBox.y + headerBox.height / 2;
  const endX = startX + (targetX - before.x) * scale, endY = startY + (targetY - before.y) * scale;
  const hitHeader = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.wf-node-header')?.dataset.id, { x: startX, y: startY });
  assert.equal(hitHeader, id, `the real pointer must hit node ${id}'s header before dragging`);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY);
  const duringDrag = (await canvas(page)).find(item => item.id === id);
  assert.ok(Math.abs(duringDrag.x - targetX) < 2 && Math.abs(duringDrag.y - targetY) < 2, `node ${id} follows the pointer to the intended drop before release`);
  await page.mouse.up();
}

test('repeated Add Node clicks (no panning between clicks, reproducing the identical-desired-point bug) keep every new node margin-clear of every prior node, and undo restores the exact original geometry', async t => {
  const f = await fixture(t);
  await mountEditor(f);
  await f.page.locator('[data-wf-action=new]').click();
  await f.page.locator('#workflow-canvas').waitFor();
  const original = await canvas(f.page);
  assert.equal(original.length, 6, 'the "new" preset starts with its usual 6-node chain');
  assertAllPairsClear(original, 'the unmodified default graph must already be self-consistent');

  const addedIds = [];
  for (let i = 0; i < 3; i++) {
    addedIds.push(await addNode(f.page, { type: 'trend', label: `Repeated add ${i}` }));
    const current = await canvas(f.page);
    assert.equal(current.length, 6 + addedIds.length, `node ${i} was actually added to the canvas`);
    for (const originalNode of original) assert.deepEqual(current.find(item => item.id === originalNode.id), originalNode, `original node ${originalNode.id} must stay at its exact prior position after add #${i}`);
    assertAllPairsClear(current, `after repeated add #${i}, no two rendered nodes may overlap within the placement margin`);
  }
  assert.equal(new Set(addedIds).size, 3, 'three distinct nodes were created, not the same node reselected');
  assert.deepEqual(f.writes, [], 'repeated Add Node is a local draft edit; it must never reach the server');

  for (let i = 2; i >= 0; i--) {
    await f.page.locator('[data-wf-action=undo]').click();
    const current = await canvas(f.page);
    assert.equal(current.some(item => item.id === addedIds[i]), false, `undo #${2 - i} removes exactly the most recently added node ${addedIds[i]}`);
    for (let kept = 0; kept < i; kept++) assert.ok(current.some(item => item.id === addedIds[kept]), `undo #${2 - i} must not remove earlier-added node ${addedIds[kept]}`);
  }
  assert.deepEqual(await canvas(f.page), original, 'three undos restore the exact original 6-node geometry, byte for byte');
  assert.equal(await f.page.locator('[data-wf-action=undo]').isDisabled(), true, 'undo history is exhausted back to the freshly-created baseline');
  assert.deepEqual(f.writes, [], 'add + undo never reaches the server');
});

test('a manual drag that would introduce a brand new overlap reverts to the exact pre-drag position without dirtying the draft, while the same node can still drag away from its OWN pre-existing overlap into clear space', async t => {
  const f = await fixture(t);
  // p and q are seeded already overlapping (legacy/template data the real server never
  // validates geometrically); r is far away and genuinely clear of both. q sits directly
  // BELOW p at the same x so their 210x140 BODIES genuinely overlap (y 150-240), but their
  // 43px-tall HEADERS do not (p: y 100-143, q: y 150-193) -- q renders after p in DOM
  // order (nodesHtml() maps workflow.nodes in array order) so it paints on top wherever
  // they coincide; same-x/overlapping headers would make a synthetic click aimed at p's
  // header hit-test to q instead, silently dragging the wrong node.
  const seeded = {
    name: 'Drag fixture',
    nodes: [
      { id: 'p', type: 'trend', x: 100, y: 100, config: {} },
      { id: 'q', type: 'trend', x: 100, y: 150, config: {} },
      { id: 'r', type: 'trend', x: 3000, y: 3000, config: {} },
    ],
    edges: [{ id: 'pq', source: 'p', target: 'q' }, { id: 'qr', source: 'q', target: 'r' }],
  };
  assert.ok(trueOverlap(seeded.nodes[0], seeded.nodes[1]), 'sanity: p and q are seeded genuinely overlapping');
  assert.equal(trueOverlap(seeded.nodes[0], seeded.nodes[2]), false, 'sanity: p and r are seeded genuinely clear');
  await f.api('/api/workflows', 'POST', seeded);
  await mountEditor(f);
  await loadAndRemount(f.page);
  await f.page.locator('#workflow-canvas').waitFor();
  assert.deepEqual(await canvas(f.page), [{ id: 'p', x: 100, y: 100 }, { id: 'q', x: 100, y: 150 }, { id: 'r', x: 3000, y: 3000 }]);
  assert.equal(await f.page.locator('[data-wf-action=undo]').isDisabled(), true);

  // Drag p directly onto r: this would create a BRAND NEW overlap with r (p already
  // overlapped q, not r) -- must revert to p's exact pre-drag position.
  await dragNodeTo(f.page, 'p', 3000, 3000);
  assert.deepEqual(await canvas(f.page), [{ id: 'p', x: 100, y: 100 }, { id: 'q', x: 100, y: 150 }, { id: 'r', x: 3000, y: 3000 }], 'a move that newly overlaps r must revert p without moving the other nodes');
  assert.equal(await f.page.evaluate(() => window.editor.hasChanges()), false, 'a reverted drag must not create an unsaved draft');
  assert.equal(await f.page.locator('[data-wf-action=undo]').isDisabled(), true, 'a reverted drag must leave no undo-able step behind');

  // Drag p into genuinely clear space, far from both q (its old overlap) and r: this
  // escapes the pre-existing q overlap without creating any new one -- must succeed.
  await dragNodeTo(f.page, 'p', 3000, 100);
  const afterEscape = await canvas(f.page);
  assert.deepEqual(afterEscape.find(item => item.id === 'p'), { id: 'p', x: 3000, y: 100 }, 'escaping into clear space lands exactly where dropped (rounded to the nearest 10)');
  assert.deepEqual(afterEscape.filter(item => item.id !== 'p'), [{ id: 'q', x: 100, y: 150 }, { id: 'r', x: 3000, y: 3000 }], 'escaping does not move either other node');
  assertNoTrueOverlap(afterEscape, 'p must not truly overlap q or r once it has escaped');
  assert.equal(await f.page.evaluate(() => window.editor.hasChanges()), true, 'a genuinely new committed move marks the draft dirty');
  assert.equal(await f.page.locator('[data-wf-action=undo]').isDisabled(), false, 'a committed move is undo-able');

  await f.page.locator('[data-wf-action=undo]').click();
  assert.deepEqual((await canvas(f.page)).find(item => item.id === 'p'), { id: 'p', x: 100, y: 100 }, 'undo restores the exact pre-escape position');
  assert.equal(await f.page.evaluate(() => window.editor.hasChanges()), false);
  assert.deepEqual(f.writes, [], 'drag, revert and undo are local draft edits; none reach the server');
});

test('a keyboard arrow move that would introduce a brand new overlap is a complete no-op (no position change, no dirty draft, no undo step), while a move into clear space commits and world-boundary clamping still applies', async t => {
  const f = await fixture(t);
  // g and h sit exactly edge-to-edge (touching, not overlapping): ArrowRight moves g 10px
  // into h, creating a brand new overlap; ArrowUp moves g away, staying clear of h.
  const seeded = {
    name: 'Arrow fixture',
    nodes: [
      { id: 'g', type: 'trend', x: 100, y: 100, config: {} },
      { id: 'h', type: 'trend', x: 310, y: 100, config: {} },
      { id: 'boundary-node', type: 'trend', x: 0, y: 700, config: {} },
    ],
    edges: [{ id: 'gh', source: 'g', target: 'h' }, { id: 'h-boundary', source: 'h', target: 'boundary-node' }],
  };
  assert.equal(trueOverlap(seeded.nodes[0], seeded.nodes[1]), false, 'sanity: g and h are seeded exactly touching, not overlapping');
  await f.api('/api/workflows', 'POST', seeded);
  await mountEditor(f);
  await loadAndRemount(f.page);
  await f.page.locator('#workflow-canvas').waitFor();

  await header(f.page, 'g').focus();
  await f.page.keyboard.press('ArrowRight');
  let current = await canvas(f.page);
  assert.deepEqual(current.find(item => item.id === 'g'), { id: 'g', x: 100, y: 100 }, 'a blocked arrow move leaves the node at its exact original position');
  assert.equal(await f.page.evaluate(() => window.editor.hasChanges()), false, 'a blocked arrow move must not dirty the draft');
  assert.equal(await f.page.locator('[data-wf-action=undo]').isDisabled(), true, 'a blocked arrow move must leave no undo-able step');

  await header(f.page, 'g').focus();
  await f.page.keyboard.press('ArrowUp');
  current = await canvas(f.page);
  assert.deepEqual(current.find(item => item.id === 'g'), { id: 'g', x: 100, y: 90 }, 'an arrow move into clear space commits exactly');
  assertNoTrueOverlap(current);
  assert.equal(await f.page.evaluate(() => window.editor.hasChanges()), true);
  assert.equal(await f.page.locator('[data-wf-action=undo]').isDisabled(), false);
  await f.page.locator('[data-wf-action=undo]').click();
  assert.deepEqual((await canvas(f.page)).find(item => item.id === 'g'), { id: 'g', x: 100, y: 100 }, 'undo restores the exact pre-move position');
  assert.equal(await f.page.evaluate(() => window.editor.hasChanges()), false);

  // boundary-node sits at the world's left edge in genuinely empty space: ArrowLeft must
  // clamp at x=0 (never go negative), independent of the new overlap-revert logic.
  await header(f.page, 'boundary-node').focus();
  await f.page.keyboard.press('ArrowLeft');
  const boundaryAfter = (await canvas(f.page)).find(item => item.id === 'boundary-node');
  assert.equal(boundaryAfter.x, 0, 'world-boundary clamping keeps x at 0 rather than going negative');
  assert.equal(boundaryAfter.y, 700, 'the unrelated y axis is untouched by the ArrowLeft press');
  assert.deepEqual(f.writes, [], 'arrow-key moves, blocks and undo are local draft edits; none reach the server');
});

test('adding nodes after manual zoom reveals each node without changing scale', async t => {
  const f = await fixture(t);
  await mountEditor(f);
  await f.page.locator('[data-wf-action=new]').click();
  await f.page.locator('#workflow-canvas').waitFor();
  const canvasElement = f.page.locator('#workflow-canvas');
  assert.notEqual(await canvasElement.getAttribute('data-layout'), 'stacked');

  const originalScale = await f.page.locator('#wf-world').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
  for (let i = 0; i < 10; i++) await f.page.locator('[data-wf-action=zoom-in]').click();
  const scale = await f.page.locator('#wf-world').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
  assert.ok(scale > originalScale, 'manual zoom must actually increase the canvas scale');

  let requiredReveal = false;
  for (let i = 0; i < 10; i++) {
    const before = await f.page.locator('#wf-world').evaluate(element => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f, scale: matrix.a };
    });
    const id = await addNode(f.page, { label: `Zoomed add ${i}` });
    const added = (await canvas(f.page)).find(item => item.id === id);
    const bounds = await canvasElement.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
    const x = before.x + added.x * before.scale, y = before.y + added.y * before.scale;
    if (x < 0 || y < 0 || x + WIDTH * before.scale > bounds.width || y + HEIGHT * before.scale > bounds.height) requiredReveal = true;

    const after = await f.page.locator('#wf-world').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
    assert.ok(Math.abs(after - scale) < 0.00001, 'adding a node preserves the manually chosen zoom');
    const visible = await node(f.page, id).evaluate(element => {
      const canvas = element.closest('#workflow-canvas');
      const card = element.getBoundingClientRect(), viewport = canvas.getBoundingClientRect();
      return { left: card.left - viewport.left - canvas.clientLeft, top: card.top - viewport.top - canvas.clientTop, right: card.right - viewport.left - canvas.clientLeft, bottom: card.bottom - viewport.top - canvas.clientTop, width: canvas.clientWidth, height: canvas.clientHeight };
    });
    assert.ok(visible.left >= -1 && visible.top >= -1 && visible.right <= visible.width + 1 && visible.bottom <= visible.height + 1, `added node ${i} must be fully visible within the canvas`);
  }
  assert.ok(requiredReveal, 'the scenario must include a node that would have been clipped without viewport adjustment');
  assert.deepEqual(f.writes, [], 'zoom and add remain local draft edits');
});

test('inspector coordinates reject new overlaps without history while allowing escape from an existing overlap', async t => {
  const f = await fixture(t);
  const seeded = {
    name: 'Inspector overlap fixture',
    nodes: [
      { id: 'p', type: 'trend', x: 100, y: 100, config: {} },
      { id: 'q', type: 'trend', x: 100, y: 150, config: {} },
      { id: 'right', type: 'trend', x: 310, y: 100, config: {} },
      { id: 'below', type: 'trend', x: 100, y: 240, config: {} },
    ],
    edges: [{ id: 'pq', source: 'p', target: 'q' }, { id: 'qr', source: 'q', target: 'right' }, { id: 'rb', source: 'right', target: 'below' }],
  };
  assert.ok(trueOverlap(seeded.nodes[0], seeded.nodes[1]));
  assert.equal(trueOverlap(seeded.nodes[0], seeded.nodes[2]), false);
  assert.equal(trueOverlap(seeded.nodes[0], seeded.nodes[3]), false);
  await f.api('/api/workflows', 'POST', seeded);
  await mountEditor(f);
  await loadAndRemount(f.page);
  await header(f.page, 'p').click();
  await f.page.locator('[data-wf-action=open-tools]').click();
  const dialog = f.page.locator('#wf-tools-dialog');
  await dialog.locator('summary').filter({ hasText: '캔버스 위치' }).click();
  const original = await canvas(f.page);

  for (const axis of ['x', 'y']) {
    const input = dialog.locator(`#wf-node-${axis}`);
    await input.fill('110');
    await f.page.keyboard.press('Tab');
    assert.equal(await input.inputValue(), '100', `rejected ${axis} coordinate is restored in the inspector`);
    assert.deepEqual(await canvas(f.page), original, `rejected ${axis} coordinate leaves all nodes unchanged`);
    assert.equal(await f.page.evaluate(() => window.editor.hasChanges()), false, `rejected ${axis} coordinate does not dirty the draft`);
    assert.equal(await f.page.locator('[data-wf-action=undo]').isDisabled(), true, `rejected ${axis} coordinate adds no undo entry`);
  }

  await dialog.locator('#wf-node-x').fill('600');
  await f.page.keyboard.press('Tab');
  const escaped = await canvas(f.page);
  assert.deepEqual(escaped.find(item => item.id === 'p'), { id: 'p', x: 600, y: 100 });
  assert.equal(trueOverlap(escaped.find(item => item.id === 'p'), escaped.find(item => item.id === 'q')), false, 'the node escapes its original overlap');
  assert.equal(await f.page.evaluate(() => window.editor.hasChanges()), true);
  await f.page.keyboard.press('Escape');
  await f.page.locator('[data-wf-action=undo]').click();
  assert.deepEqual(await canvas(f.page), original, 'one undo restores the pre-escape geometry');
  assert.equal(await f.page.locator('[data-wf-action=undo]').isDisabled(), true, 'blocked coordinate edits left no additional history');
  assert.deepEqual(f.writes, [], 'inspector edits and undo stay local');
});
test('typing a coordinate through a colliding intermediate value commits the final clear position as one undo step', async t => {
  const f = await fixture(t);
  await f.api('/api/workflows', 'POST', {
    name: 'Typed coordinate fixture',
    nodes: [
      { id: 'p', type: 'trend', x: 100, y: 100, config: {} },
      { id: 'q', type: 'trend', x: 310, y: 100, config: {} },
    ],
    edges: [{ id: 'pq', source: 'p', target: 'q' }],
  });
  await mountEditor(f);
  await loadAndRemount(f.page);
  await header(f.page, 'p').click();
  await f.page.locator('[data-wf-action=open-tools]').click();
  const dialog = f.page.locator('#wf-tools-dialog');
  await dialog.locator('summary').filter({ hasText: '캔버스 위치' }).click();
  const input = dialog.locator('#wf-node-x');
  await input.focus();
  await input.selectText();
  await f.page.keyboard.type('110');
  assert.equal(await input.inputValue(), '110', 'a colliding intermediate value remains editable');
  await f.page.keyboard.type('0');
  await input.blur();
  assert.deepEqual((await canvas(f.page)).find(item => item.id === 'p'), { id: 'p', x: 1100, y: 100 }, 'the complete non-overlapping value is committed');
  await f.page.keyboard.press('Escape');
  await f.page.locator('[data-wf-action=undo]').click();
  assert.deepEqual((await canvas(f.page)).find(item => item.id === 'p'), { id: 'p', x: 100, y: 100 }, 'one undo restores the original coordinate');
  assert.equal(await f.page.locator('[data-wf-action=undo]').isDisabled(), true, 'typing creates only one history step');
  assert.deepEqual(f.writes, [], 'coordinate editing and undo remain local');
});

test('pointer cancellation restores the dragged node and does not create history', async t => {
  const f = await fixture(t);
  await f.api('/api/workflows', 'POST', {
    name: 'Cancelled drag fixture',
    nodes: [{ id: 'p', type: 'trend', x: 100, y: 100, config: {} }],
    edges: [],
  });
  await mountEditor(f);
  await loadAndRemount(f.page);
  const original = await canvas(f.page);
  const box = await header(f.page, 'p').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await f.page.mouse.move(x, y);
  await f.page.mouse.down();
  await f.page.mouse.move(x + 50, y + 50);
  assert.notDeepEqual(await canvas(f.page), original, 'the node actually moves before cancellation');
  await f.page.locator('#workflow-host').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true });
  await f.page.mouse.up();
  assert.deepEqual(await canvas(f.page), original, 'cancellation restores the exact original position');
  assert.equal(await f.page.evaluate(() => window.editor.hasChanges()), false, 'cancellation leaves the draft clean');
  assert.equal(await f.page.locator('[data-wf-action=undo]').isDisabled(), true, 'cancellation does not create an undo step');
  assert.deepEqual(f.writes, [], 'cancelled dragging stays local');
});

test('adding a node in stacked layout scrolls it into view', async t => {
  const f = await fixture(t);
  await f.page.setViewportSize({ width: 375, height: 640 });
  await mountEditor(f);
  await f.page.locator('[data-wf-action=new]').click();
  const canvasElement = f.page.locator('#workflow-canvas');
  await canvasElement.waitFor();
  assert.equal(await canvasElement.getAttribute('data-layout'), 'stacked');
  const id = await addNode(f.page, { label: 'Visible stacked node' });
  const bounds = await node(f.page, id).evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
  });
  assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.viewportHeight, 'the newly added card is fully visible in the viewport');
  assert.deepEqual(f.writes, [], 'adding a stacked node remains a local draft edit');
});
