// Browser regression coverage for the knowledge-graph pan/zoom/drag/keyboard-move UI added to
// public/app.js's knowledgeView() (svg#knowledge-graph-svg / #graph-world / .graph-node) and its
// isolated stylesheet public/knowledge-graph.css. This file owns ONLY the knowledge graph;
// public/workflow.js's canvas has its own separate test coverage.
//
// Contract verified directly against the real public/app.js source at write time (coordinated
// with the implementing agent, then independently re-read from the applied diff):
//   - Pointer: pointerdown on `.graph-node` drags that node; pointerdown on empty svg background
//     pans the whole view. A 4 screen-px movement threshold distinguishes a click (toggle
//     selection / deselect) from a drag. pointercancel reverts to the pre-drag state exactly.
//   - Keyboard: a focused `.graph-node` + Arrow keys nudges THAT NODE 10 units/press and never
//     pans; the svg container itself focused + Arrow keys pans the VIEW 40 units/press and never
//     moves a node -- arrows never do double duty. Home resets a node's position. Enter/Space
//     toggles selection (aria-pressed + reveals the node move-toolbar). Escape deselects and
//     refocuses the svg. Every keyboard action also has a clickable toolbar button equivalent
//     (#graph-pan-*, #graph-zoom-*, #graph-node-move-*, #graph-node-reset) as the WCAG 2.5.7
//     non-drag/non-keyboard alternative.
//   - Spacing: a multi-pass pairwise relaxation keeps every visible node's center-to-center
//     distance >= radius(a)+radius(b)+14 (radius 20 for channel nodes, 12 otherwise) at rest,
//     after every render, drag commit, keyboard move and reset. nodes.slice(0,36) stays the
//     visible cap. A fresh Store always auto-seeds one sample channel, so dense-graph tests
//     verify node/visible counts against the live /api/knowledge response, never a guessed total.
//   - Responsive: the svg viewBox stays the fixed "0 0 700 390" at every width (no JS breakpoint
//     logic); only CSS (toolbar wrapping, pointer:coarse touch targets) adapts.
//   - Empty: nodes.length===0 renders only the byte-identical `.empty` message -- no svg, no
//     toolbar, no live region.
//   - All of pan/zoom/drag/select/keyboard-move/reset is session-only view state (graphPan,
//     graphZoom, graphNodePositions, graphSelectedNodeId are plain module `let`s): never
//     persisted, never mutates graph.nodes/edges, and all six actions are registered in
//     `readActions` so they are never gated behind login.
//   - Navigation: the sidebar's "..." workspace menu (`[data-action=sidebar-menu]`) is hidden by
//     a pre-existing, unrelated CSS rule (public/styles.css `@media (max-width: 920px)` hides
//     `.sidebar-label`, never reverted for the project workbench below the 700px tablet band) --
//     a genuine product defect on narrow viewports, confirmed independently by the implementing
//     agent. The real, always-visible entry point at every width is the topbar's
//     `[data-action=project-tools]` button, which this file uses exclusively.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';

const modulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();

async function fixture(t, { viewport = { width: 1440, height: 1080 }, hasTouch = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-knowledge-graph-'));
  const forbidden = async () => { assert.fail('Knowledge graph pan/zoom/drag/keyboard interactions cannot invoke external production'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), runAgent: forbidden, fetchTrends: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport, hasTouch, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const writes = [], external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname });
    return route.continue();
  });
  t.after(async () => {
    await context.close(); await browser.close();
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.deepEqual(external, [], 'knowledge graph interactions stay on the fixture origin');
    assert.deepEqual(errors, [], 'the real knowledge graph must not throw');
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  return { page, context, base, api, writes };
}

const svg = page => page.locator('#knowledge-graph-svg');
const world = page => page.locator('#graph-world');
const node = (page, id) => page.locator(`.graph-node[data-node-id="${id}"]`);
const menu = page => page.locator('.ff-context-menu[role=menu]');

async function openKnowledgeGraph(f) {
  const { page } = f;
  await page.goto(f.base);
  await page.locator('#app .shell').waitFor();
  await page.locator('[data-action=project-tools]').click();
  await menu(page).waitFor();
  await menu(page).getByRole('menuitem', { name: '지식 그래프', exact: true }).click();
  await page.locator('#project-tool-dialog[open]').waitFor();
  await svg(page).waitFor();
  return page;
}

const seedChannel = (f, name = 'Graph channel') => f.api('/api/channels', 'POST', { name, platform: 'youtube', category: 'information' });
const seedEpisode = (f, channel, title, topic = title) => f.api('/api/episodes', 'POST', { channelId: channel.id, title, topic });

async function seedSimpleGraph(f) {
  const channel = await seedChannel(f);
  const episode = await seedEpisode(f, channel, 'Alpha episode', 'Alpha topic');
  return { channel, episode };
}

async function seedDenseGraph(f) {
  const channels = [await seedChannel(f, 'Dense channel A'), await seedChannel(f, 'Dense channel B')];
  const episodes = [];
  for (let index = 0; index < 19; index++) episodes.push(await seedEpisode(f, channels[index % 2], `Dense episode ${index}`, `Dense topic ${index}`));
  return { channels, episodes };
}

async function nodePosition(page, id) {
  const [x, y] = await node(page, id).evaluate(element => [Number(element.dataset.x), Number(element.dataset.y)]);
  return { x, y };
}
const worldTransform = page => world(page).getAttribute('transform');

async function dragNodeStart(page, id, dxScreen, dyScreen, { steps = 6 } = {}) {
  const hit = node(page, id).locator('.graph-node-hit');
  const box = await hit.boundingBox();
  assert.ok(box, `node ${id} hit target is visible`);
  const startX = box.x + box.width / 2, startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dxScreen, startY + dyScreen, { steps });
}

async function dragBackground(page, dxScreen, dyScreen, { steps = 6 } = {}) {
  const box = await svg(page).boundingBox();
  const startX = box.x + 10, startY = box.y + 10;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dxScreen, startY + dyScreen, { steps });
  await page.mouse.up();
}

// --- 1. Pointer movement -----------------------------------------------------------------

test('dragging a node past the 4px threshold moves only that node, never selects it, and writes nothing to the server', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const target = node(page, channel.id);
  const before = await nodePosition(page, channel.id);
  await dragNodeStart(page, channel.id, 60, 40);
  await page.mouse.up();
  const after = await nodePosition(page, channel.id);
  assert.notDeepEqual(after, before, 'the dragged node actually changed position');
  assert.equal(await target.getAttribute('aria-pressed'), 'false', 'a committed drag never also selects the node');
  assert.equal(await target.getAttribute('class'), 'graph-node', 'the dragging class is removed once the pointer is released');
  assert.deepEqual(f.writes, [], 'moving a node is session-only view state -- it must never write to the server');
});

test('a sub-threshold press-and-release on a node toggles selection instead of registering as a drag', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const target = node(page, channel.id);
  const before = await nodePosition(page, channel.id);
  await dragNodeStart(page, channel.id, 1, 1); // well under the 4px threshold
  await page.mouse.up();
  const after = await nodePosition(page, channel.id);
  assert.deepEqual(after, before, 'a sub-threshold press cannot be mistaken for a drag');
  assert.equal(await target.getAttribute('aria-pressed'), 'true', 'releasing under the threshold toggles selection (click), not a move');
  await page.locator('#graph-node-move-up').waitFor({ state: 'visible' });
  assert.deepEqual(f.writes, []);
});

test('dragging the empty canvas background pans the whole view and leaves every node position untouched', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const beforePosition = await nodePosition(page, channel.id);
  const beforeTransform = await worldTransform(page);
  await dragBackground(page, 50, 30);
  const afterTransform = await worldTransform(page);
  const afterPosition = await nodePosition(page, channel.id);
  assert.notEqual(afterTransform, beforeTransform, 'dragging empty background pans #graph-world');
  assert.deepEqual(afterPosition, beforePosition, 'panning the canvas never moves a node\'s own position');
  assert.deepEqual(f.writes, []);
});

test('pointercancel mid-drag reverts a node to its exact pre-drag position', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const before = await nodePosition(page, channel.id);
  await dragNodeStart(page, channel.id, 80, 50);
  const midDrag = await nodePosition(page, channel.id);
  assert.notDeepEqual(midDrag, before, 'the drag actually started moving the node before it is cancelled');
  await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true, cancelable: true })));
  await page.mouse.up();
  const after = await nodePosition(page, channel.id);
  assert.deepEqual(after, before, 'pointercancel discards the in-progress drag entirely, not just stops it where it was');
  assert.deepEqual(f.writes, []);
});

// --- 2. Keyboard-accessible controls -------------------------------------------------------

test('arrow keys pan the view when the svg container is focused, and never move a node', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const beforePosition = await nodePosition(page, channel.id);
  const beforeTransform = await worldTransform(page);
  await svg(page).focus();
  await page.keyboard.press('ArrowRight');
  const afterTransform = await worldTransform(page);
  assert.notEqual(afterTransform, beforeTransform, 'ArrowRight on the focused svg pans the view');
  assert.deepEqual(await nodePosition(page, channel.id), beforePosition, 'panning via keyboard never moves a node');
  assert.deepEqual(f.writes, []);
});

test('arrow keys nudge a focused node by exactly 10 units and never pan the view; Home resets it back', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const before = await nodePosition(page, channel.id);
  const beforeTransform = await worldTransform(page);
  await node(page, channel.id).focus();
  await page.keyboard.press('ArrowRight');
  const afterRight = await nodePosition(page, channel.id);
  assert.equal(afterRight.x, before.x + 10, 'ArrowRight nudges the focused node exactly +10 on x');
  assert.equal(afterRight.y, before.y, 'ArrowRight never changes y');
  assert.equal(await worldTransform(page), beforeTransform, 'nudging a node never pans the view');
  await page.keyboard.press('ArrowDown');
  const afterDown = await nodePosition(page, channel.id);
  assert.equal(afterDown.y, afterRight.y + 10, 'ArrowDown nudges +10 on y from the current position');
  await page.keyboard.press('Home');
  assert.deepEqual(await nodePosition(page, channel.id), before, 'Home resets the focused node back to its original layout position');
  assert.deepEqual(f.writes, []);
});

test('Enter selects a focused node (aria-pressed + reveals its move toolbar); Escape deselects and refocuses the svg', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const target = node(page, channel.id);
  await target.focus();
  assert.equal(await target.getAttribute('aria-pressed'), 'false');
  await page.keyboard.press('Enter');
  assert.equal(await node(page, channel.id).getAttribute('aria-pressed'), 'true', 'Enter selects the focused node');
  await page.locator('#graph-node-move-up').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  assert.equal(await node(page, channel.id).getAttribute('aria-pressed'), 'false', 'Escape deselects');
  assert.equal(await page.locator('#graph-node-move-up').count(), 0, 'the node move toolbar disappears once deselected');
  assert.equal(await svg(page).evaluate(element => element === document.activeElement), true, 'Escape returns keyboard focus to the svg container');
  assert.deepEqual(f.writes, []);
});

test('the toolbar pan/zoom/node-move buttons reproduce the same effects as their keyboard equivalents', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const beforeTransform = await worldTransform(page);
  await page.locator('#graph-pan-right').click();
  assert.notEqual(await worldTransform(page), beforeTransform, 'the pan-right button moves #graph-world, matching ArrowRight on the svg');
  assert.equal(await page.locator('#graph-zoom-value').innerText(), '100%');
  await page.locator('#graph-zoom-in').click();
  assert.equal(await page.locator('#graph-zoom-value').innerText(), '125%', 'zoom-in applies the documented 1.25x step, matching the + key');
  await page.locator('#graph-zoom-reset').click();
  assert.equal(await page.locator('#graph-zoom-value').innerText(), '100%', 'zoom-reset restores 100%, matching the 0 key');
  await node(page, channel.id).click(); // sub-4px synthetic click selects without dragging
  await page.locator('#graph-node-move-right').waitFor({ state: 'visible' });
  const before = await nodePosition(page, channel.id);
  await page.locator('#graph-node-move-right').click();
  assert.deepEqual(await nodePosition(page, channel.id), { x: before.x + 10, y: before.y }, 'the node move-right button nudges +10 on x, matching ArrowRight on a focused node');
  await page.locator('#graph-node-reset').click();
  assert.deepEqual(await nodePosition(page, channel.id), before, 'the node reset button matches the Home key');
  assert.deepEqual(f.writes, []);
});

// --- 3. Stable node separation at dense sizes ------------------------------------------------

async function allNodePositions(page) {
  return page.locator('.graph-node').evaluateAll(elements => elements.map(element => ({ id: element.dataset.nodeId, x: Number(element.dataset.x), y: Number(element.dataset.y) })));
}
function assertFullySeparated(positions, channelIds, label) {
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i], b = positions[j];
      const radiusA = channelIds.has(a.id) ? 20 : 12, radiusB = channelIds.has(b.id) ? 20 : 12;
      const minDistance = radiusA + radiusB + 14;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(distance >= minDistance - 1, `${label}: nodes ${a.id} and ${b.id} are only ${distance.toFixed(1)}px apart, need >= ${minDistance}px`);
    }
  }
}

test('every visible node stays separated by at least radius(a)+radius(b)+14px at a dense graph exceeding the 36-node visible cap', async t => {
  const f = await fixture(t);
  await seedDenseGraph(f);
  const graph = await f.api('/api/knowledge');
  const total = graph.nodes.length;
  assert.ok(total > 36, `this test requires seeding past the 36-node visible cap; the fixture (sample channel + seeded data) actually produced ${total} real knowledge nodes`);
  const channelIds = new Set(graph.nodes.filter(node => node.type === 'channel').map(node => node.id));
  const page = await openKnowledgeGraph(f);
  const nodes = page.locator('.graph-node');
  assert.equal(await nodes.count(), 36, 'the visible cap stays at 36 even with more real knowledge nodes than that');
  assert.match(await page.locator('#graph-usage-hint').innerText(), new RegExp(`전체\\s*${total}개\\s*중\\s*36개만\\s*표시`), `the over-cap hint must report the real ${total}/36 split (verified against the live /api/knowledge count, not a guessed total)`);
  assertFullySeparated(await allNodePositions(page), channelIds, 'initial dense layout');
  assert.deepEqual(f.writes, []);
});

test('dragging one node directly onto a neighbor still leaves both separated once the drag commits', async t => {
  const f = await fixture(t);
  const { channels } = await seedDenseGraph(f);
  const graph = await f.api('/api/knowledge');
  const channelIds = new Set(graph.nodes.filter(node => node.type === 'channel').map(node => node.id));
  const page = await openKnowledgeGraph(f);
  const [channelA, channelB] = channels;
  const targetPosition = await nodePosition(page, channelB.id);
  const startPosition = await nodePosition(page, channelA.id);
  const hit = node(page, channelA.id).locator('.graph-node-hit');
  const box = await hit.boundingBox();
  const startX = box.x + box.width / 2, startY = box.y + box.height / 2;
  const ctmScale = await svg(page).evaluate(element => { const ctm = element.getScreenCTM(); return ctm ? Math.hypot(ctm.a, ctm.b) : 1; });
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + (targetPosition.x - startPosition.x) * ctmScale, startY + (targetPosition.y - startPosition.y) * ctmScale, { steps: 8 });
  await page.mouse.up();
  const endPosition = await nodePosition(page, channelA.id);
  assert.notDeepEqual(endPosition, startPosition, 'the drag toward the neighbor actually moved channel A');
  const finalGap = Math.hypot(endPosition.x - (await nodePosition(page, channelB.id)).x, endPosition.y - (await nodePosition(page, channelB.id)).y);
  assert.ok(finalGap <= 20 + 14 + 20 + 30, `the overlap resolver should settle the two channel nodes close to their minimum gap, not leave them far apart (gap=${finalGap.toFixed(1)}px)`);
  assertFullySeparated(await allNodePositions(page), channelIds, 'after dragging one node onto a neighbor');
  assert.deepEqual(f.writes, []);
});

test('dropping a node onto another at either horizontal boundary leaves their rendered circles separated', async t => {
  for (const { name, edge, outsideX } of [
    { name: 'minX', edge: 70, outsideX: 0 },
    { name: 'maxX', edge: 630, outsideX: 700 },
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t);
      await seedChannel(f, `Boundary channel A ${name}`);
      await seedChannel(f, `Boundary channel B ${name}`);
      const graph = await f.api('/api/knowledge');
      const channelIds = graph.nodes.filter(item => item.type === 'channel').map(item => item.id);
      assert.ok(channelIds.length >= 2, 'the fixture needs two channel nodes');
      const [earlier, later] = channelIds;
      const stationaryId = name === 'minX' ? earlier : later;
      const movingId = name === 'minX' ? later : earlier;
      const page = await openKnowledgeGraph(f);
      const circle = id => node(page, id).locator('.graph-node-dot');
      const geometry = id => circle(id).evaluate(element => ({
        x: Number(element.getAttribute('cx')), y: Number(element.getAttribute('cy')), r: Number(element.getAttribute('r')),
      }));
      const center = async id => {
        const box = await circle(id).boundingBox();
        assert.ok(box, `rendered circle ${id} is visible`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };

      const initial = await geometry(stationaryId);
      const start = await center(stationaryId);
      const outside = await svg(page).evaluate((element, point) => {
        const transformed = new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM());
        return { x: transformed.x, y: transformed.y };
      }, { x: outsideX, y: initial.y });
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(outside.x, outside.y, { steps: 8 });
      await page.mouse.up();
      const atEdge = await geometry(stationaryId);
      assert.ok(Math.abs(atEdge.x - edge) < 0.01, `${name}: first circle must reach the boundary, got ${atEdge.x}`);

      const movingStart = await center(movingId);
      const target = await center(stationaryId);
      await page.mouse.move(movingStart.x, movingStart.y);
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 8 });
      await page.mouse.up();
      const a = await geometry(stationaryId), b = await geometry(movingId);
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(distance >= a.r + b.r, `${name}: rendered circles overlap after the drop (distance ${distance}, radii ${a.r} + ${b.r})`);
      assert.ok(distance < a.r + b.r + 50, `${name}: the dragged node must finish near its target, got distance ${distance}`);
      assert.deepEqual(f.writes, []);
    });
  }
});

// --- 4. Responsive widths ------------------------------------------------------------------

test('the svg viewBox stays fixed at "0 0 700 390" and the graph panel never overflows the page horizontally, at a narrow or a wide viewport', async t => {
  for (const viewport of [{ width: 375, height: 812 }, { width: 1600, height: 1120 }]) {
    const f = await fixture(t, { viewport });
    await seedSimpleGraph(f);
    const page = await openKnowledgeGraph(f);
    assert.equal(await svg(page).getAttribute('viewBox'), '0 0 700 390', `viewBox at ${viewport.width}px stays the fixed coordinate space -- no JS breakpoint resizing`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `the graph panel must not cause horizontal page overflow at ${viewport.width}px (overflow=${overflow}px)`);
  }
});

test('mobile graph opens with a visible node and preserves a user scroll when selecting it', async t => {
  for (const width of [320, 375]) {
    const f = await fixture(t, { viewport: { width, height: 812 }, hasTouch: true });
    await seedSimpleGraph(f);
    const page = await openKnowledgeGraph(f);
    const viewport = page.locator('#graph-viewport');
    const visibleNodeId = await viewport.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const dot = [...element.querySelectorAll('.graph-node-dot')].find(circle => {
        const box = circle.getBoundingClientRect();
        const style = getComputedStyle(circle);
        return style.visibility === 'visible' && style.display !== 'none' && box.width > 0 && box.height > 0 &&
          box.right > bounds.left && box.left < bounds.right && box.bottom > bounds.top && box.top < bounds.bottom;
      });
      return dot?.closest('.graph-node')?.dataset.nodeId;
    });
    assert.ok(visibleNodeId, `a rendered node intersects the graph viewport on first open at ${width}px, before any user scroll`);

    await viewport.scrollIntoViewIfNeeded();
    const initialScroll = await viewport.evaluate(element => element.scrollLeft);
    const maxScroll = await viewport.evaluate(element => element.scrollWidth - element.clientWidth);
    assert.ok(maxScroll > 0, `the graph can be horizontally scrolled at ${width}px`);
    const delta = initialScroll < maxScroll / 2 ? 80 : -80;
    await viewport.hover();
    await page.mouse.wheel(delta, 0);
    await page.waitForFunction(({ initial }) => document.querySelector('#graph-viewport').scrollLeft !== initial, { initial: initialScroll });
    const userScroll = await viewport.evaluate(element => element.scrollLeft);
    await node(page, visibleNodeId).evaluate(element => element.focus({ preventScroll: true }));
    await page.keyboard.press('Enter');
    assert.equal(await node(page, visibleNodeId).getAttribute('aria-pressed'), 'true', `the node is selected at ${width}px`);
    assert.equal(await viewport.evaluate(element => element.scrollLeft), userScroll, `selecting a node preserves the user's horizontal scroll at ${width}px`);
  }
});

test('mobile graph labels and node targets remain readable and usable after selecting a node', async t => {
  for (const width of [320, 375]) {
    const f = await fixture(t, { viewport: { width, height: 812 }, hasTouch: true });
    const { channel } = await seedSimpleGraph(f);
    const page = await openKnowledgeGraph(f);
    await node(page, channel.id).focus();
    await page.keyboard.press('Enter');
    assert.equal(await node(page, channel.id).getAttribute('aria-pressed'), 'true', `a node is selected at ${width}px`);

    const labels = await page.locator('.graph-node text').evaluateAll(elements => elements
      .filter(element => getComputedStyle(element).visibility === 'visible' && element.textContent.trim())
      .map(element => {
        const ctm = element.getScreenCTM();
        return { text: element.textContent, screenFontSize: ctm && Number.parseFloat(getComputedStyle(element).fontSize) * Math.hypot(ctm.c, ctm.d) };
      }));
    assert.ok(labels.length > 0, `at least one graph label is visible at ${width}px`);
    for (const label of labels) {
      assert.ok(label.screenFontSize >= 10, `label ${JSON.stringify(label.text)} renders at ${label.screenFontSize}px on a ${width}px screen; minimum is 10px`);
    }

    const targets = await page.locator('.graph-node-hit').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect();
      return { id: element.parentElement.dataset.nodeId, width: box.width, height: box.height };
    }));
    assert.ok(targets.length > 0, `graph node targets exist at ${width}px`);
    for (const target of targets) {
      assert.ok(target.width >= 24 && target.height >= 24, `node ${target.id} has a ${target.width}×${target.height}px screen target at ${width}px; minimum is 24×24px`);
    }

    const reset = await page.locator('#graph-node-reset').evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const box = element.getBoundingClientRect();
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      return { text: element.textContent.trim(), fontSize: Number.parseFloat(getComputedStyle(element).fontSize), box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, rects: rects.map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })) };
    });
    assert.equal(reset.text, '위치 초기화', 'the selected-node reset label is intact');
    assert.ok(reset.fontSize >= 10, `reset label font is readable at ${width}px (got ${reset.fontSize}px)`);
    assert.equal(reset.rects.length, 1, `reset label stays on one line at ${width}px`);
    const text = reset.rects[0];
    assert.ok(text.left >= reset.box.left && text.right <= reset.box.right && text.top >= reset.box.top && text.bottom <= reset.box.bottom, `reset label is not clipped at ${width}px`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `the selected graph must not cause horizontal document overflow at ${width}px (overflow=${overflow}px)`);
  }
});

test('a coarse pointer grows the graph toolbar zoom button to the live --control-height touch target; a fine pointer does not', async t => {
  const fine = await fixture(t, { viewport: { width: 375, height: 812 }, hasTouch: false });
  await seedSimpleGraph(fine);
  const finePage = await openKnowledgeGraph(fine);
  const controlHeight = await finePage.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height')));
  const fineWidth = await finePage.locator('#graph-zoom-in').evaluate(element => element.getBoundingClientRect().width);
  assert.ok(fineWidth < controlHeight, `a fine pointer leaves the zoom button at its natural content width (${fineWidth}px), below --control-height (${controlHeight}px)`);

  const coarse = await fixture(t, { viewport: { width: 375, height: 812 }, hasTouch: true });
  await seedSimpleGraph(coarse);
  const coarsePage = await openKnowledgeGraph(coarse);
  const coarseControlHeight = await coarsePage.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-height')));
  const coarseWidth = await coarsePage.locator('#graph-zoom-in').evaluate(element => element.getBoundingClientRect().width);
  assert.ok(coarseWidth >= coarseControlHeight - 0.5, `a coarse pointer must grow the zoom button to at least --control-height (${coarseControlHeight}px), got ${coarseWidth}px`);
});

test('dragging a node after zooming out produces a correctly CTM-scaled position delta', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  await page.locator('#graph-zoom-out').click();
  const expectedScale = await world(page).evaluate(element => { const ctm = element.getScreenCTM(); return ctm ? 1 / Math.hypot(ctm.a, ctm.b) : 1; });
  assert.ok(Math.abs(expectedScale - 1) > 0.05, `the graph must be rendered at a non-unit scale for this regression (got ${expectedScale})`);
  const before = await nodePosition(page, channel.id);
  const screenDx = 40;
  await dragNodeStart(page, channel.id, screenDx, 0);
  await page.mouse.up();
  const after = await nodePosition(page, channel.id);
  const observedScale = (after.x - before.x) / screenDx;
  assert.ok(Math.abs(observedScale - expectedScale) / expectedScale < 0.1, `a ${screenDx}px screen drag must map through the world's screen CTM (${expectedScale.toFixed(3)}), got ${observedScale.toFixed(3)}; a naive 1:1 mapping would fail`);
});

// --- 5. Empty graph --------------------------------------------------------------------------

test('a zero-node knowledge graph renders only the byte-identical empty message -- no svg, toolbar or live region', async t => {
  const f = await fixture(t);
  await f.page.route(`${f.base}/api/state`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.graph = { nodes: [], edges: [] };
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  const page = f.page;
  await page.goto(f.base);
  await page.locator('#app .shell').waitFor();
  await page.locator('[data-action=project-tools]').click();
  await menu(page).waitFor();
  await menu(page).getByRole('menuitem', { name: '지식 그래프', exact: true }).click();
  await page.locator('#project-tool-dialog[open]').waitFor();
  const empty = page.locator('.graph-panel .empty');
  await empty.waitFor();
  assert.equal(await empty.innerText(), '채널과 에피소드를 만들면 연결된 지식이 여기에 나타납니다.');
  assert.equal(await page.locator('#knowledge-graph-svg').count(), 0, 'an empty graph renders no svg at all');
  assert.equal(await page.locator('.graph-toolbar').count(), 0, 'an empty graph renders no pan/zoom/node toolbar');
  assert.equal(await page.locator('#graph-live-region').count(), 0, 'an empty graph renders no live region');
  assert.equal(await page.locator('#graph-usage-hint').count(), 0);
  assert.deepEqual(f.writes, []);
});

// --- 6. Preservation of content/links -------------------------------------------------------

test('an extended pan/zoom/drag/select/keyboard-move/reset sequence writes nothing and leaves server graph content byte-identical', async t => {
  const f = await fixture(t);
  const { channel, episode } = await seedSimpleGraph(f);
  const before = await f.api('/api/knowledge');
  const page = await openKnowledgeGraph(f);

  await dragBackground(page, 30, -20);
  await page.locator('#graph-zoom-in').click();
  await dragNodeStart(page, channel.id, -25, 15); await page.mouse.up();
  await node(page, episode.id).focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); // select
  await page.keyboard.press('Home'); // reset position while selected
  await page.keyboard.press('Escape'); // deselect
  await svg(page).focus();
  await page.keyboard.press('ArrowLeft');
  await page.locator('#graph-zoom-reset').click();
  await page.locator('#graph-pan-up').click();

  const after = await f.api('/api/knowledge');
  assert.deepEqual(after, before, 'no amount of pan/zoom/drag/keyboard-move/select/reset may change the real graph nodes, edges or atoms');
  assert.deepEqual(f.writes, [], 'none of these interactions may ever reach a mutating endpoint');
});

test('closing and reopening the knowledge-graph dialog preserves a moved node\'s position and the current pan/zoom', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);

  await dragNodeStart(page, channel.id, 45, 25); await page.mouse.up();
  const movedPosition = await nodePosition(page, channel.id);
  await page.locator('#graph-zoom-in').click();
  const movedTransform = await worldTransform(page);

  await page.locator('[data-action=close-project-tool]').click();
  await page.locator('#project-tool-dialog[open]').waitFor({ state: 'hidden' });
  await page.locator('[data-action=project-tools]').click();
  await menu(page).waitFor();
  await menu(page).getByRole('menuitem', { name: '지식 그래프', exact: true }).click();
  await page.locator('#project-tool-dialog[open]').waitFor();
  await svg(page).waitFor();

  assert.deepEqual(await nodePosition(page, channel.id), movedPosition, 'reopening the dialog preserves the moved node\'s position -- this is session view state, not a fresh layout');
  assert.equal(await worldTransform(page), movedTransform, 'reopening the dialog preserves the current pan/zoom');
  assert.deepEqual(f.writes, []);
});

test('browser modifier shortcuts on graph controls are not cancelled or interpreted as graph commands', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const beforePosition = await nodePosition(page, channel.id);
  const beforeTransform = await worldTransform(page);
  await page.evaluate(() => {
    window.graphShortcutEvents = [];
    window.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        window.graphShortcutEvents.push({ key: event.key, prevented: event.defaultPrevented, trusted: event.isTrusted });
      }
    });
  });
  await node(page, channel.id).focus();
  await page.keyboard.press('Control+ArrowRight');
  await svg(page).focus();
  await page.keyboard.press('Control+=');
  await page.keyboard.press('Meta+0');
  await page.keyboard.press('Alt+ArrowDown');
  const events = await page.evaluate(() => window.graphShortcutEvents.filter(event => ['ArrowRight', 'ArrowDown', '=', '0'].includes(event.key)));
  assert.deepEqual(events, [
    { key: 'ArrowRight', prevented: false, trusted: true },
    { key: '=', prevented: false, trusted: true },
    { key: '0', prevented: false, trusted: true },
    { key: 'ArrowDown', prevented: false, trusted: true },
  ], 'trusted modified key events reach the browser without cancellation');
  assert.deepEqual(await nodePosition(page, channel.id), beforePosition, 'modified arrows do not move a node');
  assert.equal(await worldTransform(page), beforeTransform, 'modified zoom/reset shortcuts do not transform the graph');
  assert.deepEqual(f.writes, []);
});

test('a normal wheel event over the graph remains available for browser scrolling without zooming the graph', async t => {
  const f = await fixture(t);
  await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const beforeTransform = await worldTransform(page);
  await page.evaluate(() => {
    window.graphWheelEvent = null;
    window.addEventListener('wheel', event => {
      window.graphWheelEvent = { prevented: event.defaultPrevented, trusted: event.isTrusted };
    }, { once: true });
  });
  const box = await svg(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => window.graphWheelEvent !== null);
  assert.deepEqual(await page.evaluate(() => window.graphWheelEvent), { prevented: false, trusted: true });
  assert.equal(await worldTransform(page), beforeTransform, 'ordinary scrolling does not zoom or pan the graph');
  assert.deepEqual(f.writes, []);
});

test('the enlarged node hit target is transparent but its outer ring still selects the node', async t => {
  const f = await fixture(t);
  const { channel } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const hit = node(page, channel.id).locator('.graph-node-hit');
  const appearance = await hit.evaluate(element => {
    const style = getComputedStyle(element);
    return { fill: style.fill, stroke: style.stroke };
  });
  assert.equal(appearance.fill, 'rgba(0, 0, 0, 0)', 'the hit target must not obscure the visible node');
  assert.equal(appearance.stroke, 'none', 'the hit target must not draw an extra ring');
  const box = await hit.boundingBox();
  const x = box.x + box.width - 2, y = box.y + box.height / 2;
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('graph-node-hit'), { x, y }), true, 'the outer ring is actually hit-testable');
  await page.mouse.click(x, y);
  assert.equal(await node(page, channel.id).getAttribute('aria-pressed'), 'true', 'clicking the transparent outer ring selects its node');
  assert.deepEqual(f.writes, []);
});

test('a moved node keeps its position after another node moves and the graph rerenders', async t => {
  const f = await fixture(t);
  const { channel, episode } = await seedSimpleGraph(f);
  const page = await openKnowledgeGraph(f);
  const original = await nodePosition(page, channel.id);
  await node(page, channel.id).focus();
  await page.keyboard.press('ArrowRight');
  const moved = await nodePosition(page, channel.id);
  assert.notDeepEqual(moved, original, 'the first node actually moves');
  const otherBefore = await nodePosition(page, episode.id);
  await node(page, episode.id).focus();
  await page.keyboard.press('ArrowDown');
  assert.notDeepEqual(await nodePosition(page, episode.id), otherBefore, 'the later move actually moves the other node');
  assert.deepEqual(await nodePosition(page, channel.id), moved, 'a later move does not revert the first position');
  await node(page, episode.id).click();
  assert.deepEqual(await nodePosition(page, channel.id), moved, 'selection rerender preserves the first position');
  assert.deepEqual(f.writes, []);
});

test('visible Korean labels have nonintersecting browser bounding boxes in a dense graph', async t => {
  const f = await fixture(t);
  const channels = [await seedChannel(f, '한국어 지식 채널 하나'), await seedChannel(f, '한국어 지식 채널 둘')];
  for (let index = 0; index < 19; index++) {
    await seedEpisode(f, channels[index % 2], `한국어 에피소드 제목 ${index}`, `한국어 주제 ${index}`);
  }
  const page = await openKnowledgeGraph(f);
  assert.equal(await page.locator('.graph-node').count(), 36, 'the fixture exercises the visible dense-graph limit');
  const labels = await page.locator('.graph-node text').evaluateAll(elements => elements
    .filter(element => getComputedStyle(element).visibility === 'visible' && element.textContent.trim())
    .map(element => {
      const box = element.getBoundingClientRect();
      return { text: element.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }));
  assert.ok(labels.filter(label => /[가-힣]/.test(label.text)).length >= 2, 'multiple Korean labels must actually be visible');
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i], b = labels[j];
      assert.ok(!(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top), `visible labels overlap: ${a.text} / ${b.text}`);
    }
  }
  assert.deepEqual(f.writes, []);
});
