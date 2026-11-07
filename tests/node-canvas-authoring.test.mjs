import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';
import { WIDTH, HEIGHT, findWorkflowNodeSlot, tidyWorkflowLayout, TIDY_ORIGIN, TIDY_GAP } from '../public/workflow.js';

// Node-canvas authoring: quick-add palette, Ctrl/Cmd+D and Delete shortcuts, deterministic tidy layout and the
// AI blueprint dialog. The browser tests mount the real editor against a real fixture server (forbidden provider
// stubs); only the read-only workflow_propose_blueprint operation is intercepted with a fixture response.

const modulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();

const OPERATION = '/api/agent/operations/workflow_propose_blueprint';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const TYPE_NAMES = ['트렌드 수집', '뉴스 검색', '리서치 정리', '대본 작성', '스토리보드', '레이아웃 연출', 'Higgsfield 생성', '영상 렌더', '사람의 검토', '플랫폼 공개'];

const node = (id, type, x, y, config = {}) => ({ id, type, x, y, config });
const edge = (id, source, target) => ({ id, source, target });
// A valid, connected chain: script -> storyboard -> render -> review (x spaced like the default graph).
const chain = () => ({
  nodes: [node('script-1', 'script', 50, 60, { agent: 'studio', prompt: '원본 지시문' }), node('board-1', 'storyboard', 320, 60), node('render-1', 'render', 590, 60), node('review-1', 'review', 860, 60)],
  edges: [edge('e1', 'script-1', 'board-1'), edge('e2', 'board-1', 'render-1'), edge('e3', 'render-1', 'review-1')],
});

const PROPOSAL = {
  name: '뉴스 설명 구성안',
  nodes: [
    node('bp-trend', 'trend', 50, 60), node('bp-research', 'research', 320, 60), node('bp-script', 'script', 590, 60, { agent: 'studio', prompt: '' }),
    node('bp-board', 'storyboard', 860, 60), node('bp-render', 'render', 1130, 60), node('bp-review', 'review', 1400, 60),
  ],
  edges: [edge('bp-e1', 'bp-trend', 'bp-research'), edge('bp-e2', 'bp-research', 'bp-script'), edge('bp-e3', 'bp-script', 'bp-board'), edge('bp-e4', 'bp-board', 'bp-render'), edge('bp-e5', 'bp-render', 'bp-review')],
  rationale: ['트렌드로 소재를 고릅니다.', '사람이 검토한 뒤에만 공개합니다.'],
  warnings: [],
  engine: 'rule-based',
};

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-canvas-authoring-'));
  const forbidden = async () => { assert.fail('Canvas authoring must never invoke an external producer'); };
  const writes = [], proposals = [], external = [], errors = [];
  let app, browser, context;
  t.after(async () => {
    try { await context?.close(); await browser?.close(); }
    finally {
      if (app?.listening) await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    assert.deepEqual(external, [], 'all browser traffic stays on the fixture origin');
    assert.deepEqual(errors, [], 'canvas authoring cannot throw page errors');
  });
  app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), runAgent: forbidden, fetchTrends: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
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
  const f = { page, context, base, writes, proposals, gate: null, reply: () => ({ status: 200, json: { ok: true, result: PROPOSAL } }), liveRun: false };
  // Registered after the catch-all, so it wins for exactly this endpoint and never counts as a workflow write.
  await context.route(`**${OPERATION}`, async route => {
    const request = route.request();
    proposals.push({ method: request.method(), body: request.postDataJSON() });
    if (f.gate) await f.gate;
    const reply = f.reply(proposals.at(-1).body);
    try { await route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.json) }); } catch { /* the page aborted this request */ }
  });
  await context.route(/\/api\/workflows\/[^/]+\/runs$/, route => {
    if (!f.liveRun || route.request().method() !== 'GET') return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/')[3];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'run-live', workflowId: id, episodeId: f.episode.id, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workflowVersion: 1, episodeVersion: 1, selectedStages: [], nodeRuns: [], reviews: {} }]) });
  });
  f.api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  f.channel = await f.api('/api/channels', 'POST', { name: 'Authoring channel', platform: 'youtube', category: 'information' });
  f.episode = await f.api('/api/episodes', 'POST', { channelId: f.channel.id, title: 'Authoring episode', topic: 'Canvas authoring' });
  return f;
}

// Seeds an owned (project) copy and mounts the real editor on it, without the full app shell.
async function openEditor(f, { nodes, edges, name = 'Authoring graph', liveRun = false } = {}) {
  const graph = nodes ? { nodes, edges } : chain();
  const template = await f.api('/api/workflows', 'POST', { name, nodes: graph.nodes, edges: graph.edges });
  f.workflow = await f.api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: f.channel.id, episodeId: f.episode.id, expectedTemplateVersion: template.version });
  f.liveRun = liveRun;
  await f.context.route('**/__canvas-authoring-test', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workflow.css"></head><body><main id="test-root"></main></body></html>',
  }));
  await f.page.goto(`${f.base}/__canvas-authoring-test`);
  await f.page.evaluate(async ({ episode, channel }) => {
    const { createWorkflowEditor } = await import('/workflow.js');
    window.editorToasts = [];
    window.__canMutate = true;
    window.__blockReason = '';
    window.editor = createWorkflowEditor({
      api: async (path, options = {}) => {
        const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        return result;
      },
      getEpisodes: () => [episode], getEpisode: id => id === episode.id ? episode : undefined,
      toast: (message, isError) => window.editorToasts.push({ message, isError: Boolean(isError) }),
      canMutate: () => window.__canMutate, mutationBlockReason: () => window.__blockReason,
    });
    document.querySelector('#test-root').innerHTML = window.editor.html();
    window.editor.bindProject({ episodeId: episode.id, channelId: channel.id });
    await window.editor.load();
    window.editor.mount();
  }, { episode: f.episode, channel: f.channel });
  await f.page.locator('#workflow-canvas').waitFor();
  await f.page.locator('.wf-node').first().waitFor();
}

const node$ = (page, id) => page.locator(`.wf-node[data-node-id="${id}"]`);
const header = (page, id) => page.locator(`.wf-node-header[data-id="${id}"]`);
const menu = page => page.locator('.ff-context-menu[role=menu]');
const item = (page, name) => menu(page).getByRole('menuitem', { name, exact: true });
const graphOf = async page => (await page.evaluate(() => window.editor.getContext())).workflow;
const ids = graph => graph.nodes.map(entry => entry.id);
const toasts = page => page.evaluate(() => window.editorToasts);
const active = page => page.evaluate(() => ({ id: document.activeElement?.id || '', action: document.activeElement?.dataset?.wfAction || '', node: document.activeElement?.dataset?.id || '' }));
const dirty = page => page.evaluate(() => window.editor.hasChanges());
const undoButton = page => page.locator('[data-wf-action=undo]');
const status = page => page.locator('#wf-authoring-status');
const rect = (a) => ({ x: a.x, y: a.y, right: a.x + WIDTH, bottom: a.y + HEIGHT });
const overlaps = (a, b) => a.x < b.x + WIDTH && b.x < a.x + WIDTH && a.y < b.y + HEIGHT && b.y < a.y + HEIGHT;
function assertNoOverlap(nodes, message) {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) assert.equal(overlaps(nodes[i], nodes[j]), false, `${message}: ${nodes[i].id}(${nodes[i].x},${nodes[i].y}) vs ${nodes[j].id}(${nodes[j].x},${nodes[j].y})`);
}
async function view(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#workflow-canvas').getBoundingClientRect();
    const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(document.querySelector('#wf-world').style.transform);
    return { left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height, panX: Number(match[1]), panY: Number(match[2]), scale: Number(match[3]) };
  });
}
const snap = value => Math.round(value / 10) * 10;

// ===========================================================================
// Pure tidy layout (no browser)
// ===========================================================================
test('tidy layout: columns follow the longest path, rows follow parent barycenter, ids break ties', () => {
  const nodes = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  const positions = tidyWorkflowLayout(nodes, [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'a', target: 'c' }, { source: 'c', target: 'd' }]);
  const column = id => (positions.get(id).x - TIDY_ORIGIN.x) / (WIDTH + TIDY_GAP.x);
  assert.deepEqual(['a', 'b', 'c', 'd'].map(column), [0, 1, 2, 3], 'c sits behind b even though a->c is also a direct edge (longest path wins)');
  assert.deepEqual([...positions.values()].map(p => p.y), [60, 60, 60, 60]);
  assert.deepEqual(positions.get('a'), { x: 50, y: 60 });

  // p1 row 0, p2 row 1; c1 hangs off p2 and c2 off p1, so barycenter must put c2 above c1 despite c1 < c2 by id.
  const crossing = tidyWorkflowLayout(['p1', 'p2', 'c1', 'c2'].map(id => ({ id })), [{ source: 'p1', target: 'c2' }, { source: 'p2', target: 'c1' }]);
  assert.ok(crossing.get('c2').y < crossing.get('c1').y, 'children are ordered by their parents row, not alphabetically');
  const tied = tidyWorkflowLayout(['r', 'z', 'a'].map(id => ({ id })), [{ source: 'r', target: 'z' }, { source: 'r', target: 'a' }]);
  assert.ok(tied.get('a').y < tied.get('z').y, 'equal barycenter falls back to id order');
});

test('tidy layout: deterministic for any input order, pure, grid-snapped, and ignores unusable edges', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${String(i).padStart(2, '0')}`, x: i * 7, y: i * 3 }));
  const edges = [[0, 3], [1, 3], [2, 4], [3, 5], [4, 5], [5, 6], [5, 7], [6, 8], [7, 8], [8, 9], [1, 10], [10, 11]].map(([s, t], i) => ({ id: `e${i}`, source: nodes[s].id, target: nodes[t].id }));
  const reference = JSON.stringify([...tidyWorkflowLayout(nodes, edges)].sort());
  for (let round = 0; round < 6; round++) {
    const shuffle = list => list.map((value, i) => [Math.sin(round * 31 + i * 17), value]).sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
    assert.equal(JSON.stringify([...tidyWorkflowLayout(shuffle(nodes), shuffle(edges))].sort()), reference, `shuffle ${round}: same layout regardless of node/edge order`);
  }
  const frozen = Object.freeze(nodes.map(entry => Object.freeze({ ...entry }))), frozenEdges = Object.freeze(edges.map(entry => Object.freeze({ ...entry })));
  assert.doesNotThrow(() => tidyWorkflowLayout(frozen, frozenEdges), 'the input is never mutated');
  for (const { x, y } of tidyWorkflowLayout(nodes, edges).values()) assert.ok(x % 10 === 0 && y % 10 === 0, 'every coordinate is on the 10px grid');
  const noisy = tidyWorkflowLayout([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'a' }, { source: 'a', target: 'missing' }, { source: 'a', target: 'b' }, { source: 'a', target: 'b' }, null]);
  assert.equal(noisy.size, 2);
  assert.ok(noisy.get('b').x > noisy.get('a').x, 'self, dangling and duplicate edges neither crash nor distort the layering');
  assert.equal(tidyWorkflowLayout([], []).size, 0);
  assert.equal(tidyWorkflowLayout(undefined, undefined).size, 0);
});

test('tidy layout: a cycle (impossible in a valid graph) still places every node exactly once without hanging', () => {
  const positions = tidyWorkflowLayout(['x', 'y', 'z'].map(id => ({ id })), [{ source: 'x', target: 'y' }, { source: 'y', target: 'z' }, { source: 'z', target: 'x' }]);
  assert.equal(positions.size, 3);
  const keys = new Set([...positions.values()].map(p => `${p.x},${p.y}`));
  assert.equal(keys.size, 3, 'no two cycle members share a slot');
  for (const { x, y } of positions.values()) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  const loopOnly = tidyWorkflowLayout([{ id: 'only' }], [{ source: 'only', target: 'only' }]);
  assert.deepEqual(loopOnly.get('only'), { x: TIDY_ORIGIN.x, y: TIDY_ORIGIN.y });
});

test('tidy layout: 128 nodes stay linear-time, non-overlapping, in bounds and edge-monotonic (chain, hub, random DAG)', () => {
  const make = count => Array.from({ length: count }, (_, i) => ({ id: `n${String(i).padStart(3, '0')}` }));
  let seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const nodes = make(128);
  const shapes = {
    chain: nodes.slice(1).map((entry, i) => ({ source: nodes[i].id, target: entry.id })),
    hub: nodes.slice(1).map(entry => ({ source: nodes[0].id, target: entry.id })),
    dag: Array.from({ length: 250 }, () => { const a = Math.floor(random() * 127), b = a + 1 + Math.floor(random() * (127 - a)); return { source: nodes[a].id, target: nodes[b].id }; }),
  };
  for (const [shape, edges] of Object.entries(shapes)) {
    const startedAt = performance.now();
    const positions = tidyWorkflowLayout(nodes, edges);
    const elapsed = performance.now() - startedAt;
    assert.ok(elapsed < 250, `${shape}: layout took ${elapsed.toFixed(1)}ms`);
    const placed = nodes.map(entry => ({ id: entry.id, ...positions.get(entry.id) }));
    assert.equal(placed.length, 128);
    assertNoOverlap(placed, `${shape} layout`);
    for (const entry of placed) assert.ok(entry.x >= 0 && entry.y >= 0 && entry.x <= 100000 && entry.y <= 100000 && entry.x % 10 === 0 && entry.y % 10 === 0, `${shape}: ${entry.id} is in the validator bounds on the grid`);
    for (const link of edges) assert.ok(positions.get(link.source).x < positions.get(link.target).x, `${shape}: ${link.source}->${link.target} always flows left to right`);
  }
  assert.ok(Math.max(...nodes.map(entry => tidyWorkflowLayout(nodes, shapes.hub).get(entry.id).y)) < 10000, 'a 127-way fan-out wraps into extra columns instead of one 25000px strip');
});

// ===========================================================================
// Quick-add palette
// ===========================================================================
test('quick-add palette: double-click on empty canvas opens it at that point; filter, keyboard, add and auto-connect are one undo step', async t => {
  const f = await fixture(t), { page } = f;
  await openEditor(f);
  const original = await graphOf(page);
  await page.locator('[data-wf-action=zoom-out]').click();
  await page.locator('[data-wf-action=zoom-out]').click();
  await header(page, 'script-1').click();
  assert.equal(await page.locator('#wf-add-node-dialog').evaluate(dialog => dialog.open), false, 'nothing opens by itself');

  const v = await view(page);
  const clickX = Math.round(v.left + v.width - 120), clickY = Math.round(v.top + v.height / 2);
  await page.mouse.dblclick(clickX, clickY);
  const dialog = page.locator('#wf-add-node-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.getAttribute('role'), 'dialog');
  assert.ok((await dialog.getAttribute('aria-label')).length > 0, 'the palette is an accessible, labelled dialog');
  assert.deepEqual(await dialog.locator('[role=listbox] [role=option] strong').allTextContents(), TYPE_NAMES, 'all ten node types with their Korean names');
  assert.equal(await dialog.locator('[role=listbox]').getAttribute('aria-label'), '노드 종류');
  assert.equal((await dialog.locator('[role=option] small').allTextContents()).every(text => text.length > 0), true, 'each option carries its summary');
  assert.equal((await active(page)).id, 'wf-add-search', 'type-ahead search is focused on open');
  assert.equal(await dialog.locator('[aria-selected=true]').count(), 1);
  assert.deepEqual(f.writes, [], 'opening the palette writes nothing');
  assert.deepEqual(f.proposals, []);

  // type-ahead filter: by Korean name, summary and type key; empty state is announced
  await page.keyboard.type('렌더');
  assert.deepEqual(await dialog.locator('[role=option] strong').allTextContents(), ['영상 렌더']);
  await page.locator('#wf-add-search').fill('news');
  assert.deepEqual(await dialog.locator('[role=option] strong').allTextContents(), ['뉴스 검색']);
  await page.locator('#wf-add-search').fill('zzzz');
  assert.equal(await dialog.locator('[role=option]').count(), 0);
  assert.equal(await dialog.locator('#wf-add-empty').isVisible(), true);
  assert.equal(await dialog.locator('[data-wf-action=quick-add]').isDisabled(), true, 'nothing to add while nothing matches');
  await page.locator('#wf-add-search').fill('');
  assert.equal((await dialog.locator('[role=option]').count()), 10);

  // arrows move the active option (script is selected: first downstream stage is the storyboard), Enter adds
  assert.equal(await dialog.locator('[aria-selected=true] strong').innerText(), '스토리보드');
  await page.keyboard.press('ArrowDown');
  assert.equal(await dialog.locator('[aria-selected=true] strong').innerText(), '레이아웃 연출');
  assert.equal(await page.locator('#wf-add-search').getAttribute('aria-activedescendant'), 'wf-add-option-layout');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.equal(await dialog.locator('[aria-selected=true] strong').innerText(), '대본 작성', 'wraps and moves up through the whole list');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#wf-add-type').inputValue(), 'storyboard', 'the native value holder mirrors the active option');
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });

  const added = await graphOf(page);
  const created = added.nodes.find(entry => !ids(original).includes(entry.id));
  assert.ok(created, 'one node was added');
  assert.equal(created.type, 'storyboard');
  assert.equal(added.nodes.length, original.nodes.length + 1);
  assert.deepEqual(added.edges.filter(link => link.target !== created.id), original.edges, 'existing edges are untouched (no splicing)');
  const incoming = added.edges.filter(link => link.target === created.id);
  assert.equal(incoming.length, 1, 'auto-connected exactly once');
  assert.equal(incoming[0].source, 'script-1', 'selected -> new node');
  assert.equal(added.edges.filter(link => link.source === created.id).length, 0);
  assert.match(await status(page).innerText(), /연결했습니다/, 'a short status line says it connected');
  assert.equal(await page.locator('.wf-node.selected').getAttribute('data-node-id'), created.id);
  assert.equal(await dirty(page), true, 'a draft, not a saved graph');
  assert.deepEqual(f.writes, [], 'adding is a local draft edit');

  // placed at the double-click point (centered, grid-snapped, then the existing margin-clear slot search)
  const worldX = (clickX - v.left - v.panX) / v.scale, worldY = (clickY - v.top - v.panY) / v.scale;
  const expected = findWorkflowNodeSlot(original.nodes, { x: Math.max(0, snap(worldX - WIDTH / 2)), y: Math.max(0, snap(worldY - HEIGHT / 2)) });
  assert.deepEqual({ x: created.x, y: created.y }, expected, 'new node lands where the user double-clicked');
  assert.ok(created.x > Math.max(...original.nodes.map(entry => entry.x)), 'and that was in the empty space right of the graph');

  // node + connection is ONE undo step
  await undoButton(page).click();
  const undone = await graphOf(page);
  assert.deepEqual(undone.nodes, original.nodes);
  assert.deepEqual(undone.edges, original.edges);
  assert.equal(await dirty(page), false);
  assert.equal(await undoButton(page).isDisabled(), true, 'one undo exhausted the history');
  assert.deepEqual(f.writes, []);
});

test('quick-add palette: "/" and the add-node button open it, Escape closes and restores focus, only valid downstream stages connect', async t => {
  const f = await fixture(t), { page } = f;
  await openEditor(f);
  const canvas = page.locator('#workflow-canvas');
  await canvas.focus();
  await page.keyboard.press('/');
  const dialog = page.locator('#wf-add-node-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal((await active(page)).id, 'wf-add-search');
  assert.equal(await page.locator('#wf-add-search').inputValue(), '', 'the shortcut key itself is not typed into the search');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await active(page)).id, 'workflow-canvas', 'focus returns to the canvas');

  const button = page.locator('[data-wf-action=open-add-node]');
  await button.click();
  await dialog.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await active(page)).action, 'open-add-node', 'focus returns to the add-node button');
  assert.deepEqual(f.writes, []);

  // review is the last real stage here: adding a trend node after it is NOT a downstream stage -> added unconnected
  const before = await graphOf(page);
  await header(page, 'review-1').click();
  await button.click();
  await page.locator('#wf-add-search').fill('트렌드');
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  const after = await graphOf(page);
  const trend = after.nodes.find(entry => !ids(before).includes(entry.id));
  assert.equal(trend.type, 'trend');
  assert.deepEqual(after.edges, before.edges, 'an upstream-stage node is not auto-connected');
  assert.match(await status(page).innerText(), /연결되지 않았습니다/);
  // viewport-center default: the node is inside the visible canvas
  const v = await view(page);
  const screenX = trend.x * v.scale + v.panX, screenY = trend.y * v.scale + v.panY;
  assert.ok(screenX >= 0 && screenX < v.width && screenY >= 0 && screenY < v.height, 'default position is inside the visible viewport');

  // generate gets the real default generation config through the same add path
  await header(page, 'board-1').click();
  await button.click();
  await page.locator('#wf-add-search').fill('Higgsfield');
  await page.locator('[data-wf-action=quick-add]').click();
  const generated = (await graphOf(page)).nodes.find(entry => entry.type === 'generate');
  assert.ok(generated);
  assert.equal(generated.config.model, 'seedance_2_5');
  assert.equal((await graphOf(page)).edges.some(link => link.source === 'board-1' && link.target === generated.id), true);
  assert.deepEqual(f.writes, []);
});

test('quick-add palette: pointer pick adds immediately; the 128-node limit and locked sessions refuse visibly', async t => {
  const f = await fixture(t), { page } = f;
  await openEditor(f);
  await page.locator('[data-wf-action=open-add-node]').click();
  await page.locator('#wf-add-listbox [data-palette-type=research]').click();
  await page.locator('#wf-add-node-dialog').waitFor({ state: 'hidden' });
  assert.equal((await graphOf(page)).nodes.some(entry => entry.type === 'research'), true, 'clicking an option adds that type');

  // locked: the palette can still be browsed but adding is refused and explained
  await page.evaluate(() => { window.__canMutate = false; });
  await page.locator('[data-wf-action=open-add-node]').click();
  await page.locator('#wf-add-node-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#wf-add-node-dialog [data-wf-action=quick-add]').isDisabled(), true);
  assert.match(await page.locator('#wf-add-node-preview').innerText(), /로그인/);
  await page.locator('#wf-add-search').press('Enter');
  assert.equal((await toasts(page)).at(-1).isError, true, 'keyboard add is refused with a visible error');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.__canMutate = true; });

  // 128-node graph: the add path keeps its limit
  const full = await fixture(t);
  const nodes = Array.from({ length: 128 }, (_, i) => node(`limit-${String(i).padStart(3, '0')}`, 'trend', 40 + i % 16 * 260, 50 + Math.floor(i / 16) * 190));
  await openEditor(full, { nodes, edges: nodes.slice(1).map((entry, i) => edge(`limit-edge-${i}`, nodes[0].id, entry.id)), name: 'Full graph' });
  await full.page.locator('[data-wf-action=open-add-node]').click();
  await full.page.locator('#wf-add-node-dialog').waitFor({ state: 'visible' });
  assert.equal(await full.page.locator('#wf-add-node-dialog [data-wf-action=quick-add]').isDisabled(), true);
  assert.match(await full.page.locator('#wf-add-node-preview').innerText(), /128개/);
  await full.page.locator('#wf-add-search').press('Enter');
  assert.match((await toasts(full.page)).at(-1).message, /128/);
  assert.equal((await graphOf(full.page)).nodes.length, 128);
  assert.deepEqual(full.writes, []);
  await full.page.keyboard.press('Escape');

  // tidy on the full hub: still one undo step and no overlap at the maximum size
  const before = await graphOf(full.page);
  await full.page.locator('[data-wf-action=layout]').click();
  const tidied = await graphOf(full.page);
  assertNoOverlap(tidied.nodes, '128-node tidy');
  assert.deepEqual(tidied.edges, before.edges);
  assert.deepEqual(ids(tidied), ids(before));
  await undoButton(full.page).click();
  assert.deepEqual((await graphOf(full.page)).nodes, before.nodes, 'one undo restores all 128 positions');
});

// ===========================================================================
// Duplicate + delete shortcuts
// ===========================================================================
test('Ctrl/Cmd+D duplicates the selected node (fresh id, cloned config, +40/+40, no edges) as one undo step', async t => {
  const f = await fixture(t), { page } = f;
  await openEditor(f);
  await page.evaluate(() => { window.defaultPrevented = []; document.addEventListener('keydown', event => window.defaultPrevented.push([event.key, event.defaultPrevented])); });
  const original = await graphOf(page);
  await header(page, 'script-1').click();
  await page.keyboard.press(`${MOD}+d`);
  const duplicated = await graphOf(page);
  const clone = duplicated.nodes.find(entry => !ids(original).includes(entry.id));
  assert.ok(clone, 'a node was duplicated');
  assert.match(clone.id, /^[0-9a-f-]{36}$/, 'fresh id from the same generator as every other new node');
  assert.equal(clone.type, 'script');
  assert.deepEqual(clone.config, { agent: 'studio', prompt: '원본 지시문' });
  assert.deepEqual({ x: clone.x, y: clone.y }, { x: 90, y: 100 }, 'offset by +40,+40');
  assert.equal(duplicated.nodes.length, original.nodes.length + 1);
  assert.deepEqual(duplicated.edges, original.edges, 'no edges are copied or rewired');
  assert.equal(duplicated.edges.some(link => link.source === clone.id || link.target === clone.id), false);
  assert.equal(await page.locator('.wf-node.selected').getAttribute('data-node-id'), clone.id, 'the copy becomes the selection');
  assert.equal(await dirty(page), true);
  assert.deepEqual(await page.evaluate(() => window.defaultPrevented.find(([key]) => key === 'd')), ['d', true], "the browser's own Ctrl+D (bookmark) is suppressed");
  assert.deepEqual(f.writes, []);

  await undoButton(page).click();
  assert.deepEqual(await graphOf(page), original, 'one undo removes the duplicate completely');
  assert.equal(await dirty(page), false);
  assert.equal(await undoButton(page).isDisabled(), true);

  // repeated duplicates cascade instead of stacking on the same spot; the copy's config is independent
  await header(page, 'script-1').click();
  await page.keyboard.press(`${MOD}+d`);
  const second = (await graphOf(page)).nodes.find(entry => !ids(original).includes(entry.id));
  await page.keyboard.press(`${MOD}+d`);
  const third = (await graphOf(page)).nodes.find(entry => !ids(original).includes(entry.id) && entry.id !== second.id);
  assert.notDeepEqual({ x: third.x, y: third.y }, { x: second.x, y: second.y }, 'duplicating the duplicate does not stack on top of it');
  await page.locator('#wf-focused-node [data-wf-action=node-tools]').click();
  await page.locator('#wf-prompt').fill('복제본만 수정');
  await page.keyboard.press('Escape');
  const independent = await graphOf(page);
  assert.equal(independent.nodes.find(entry => entry.id === 'script-1').config.prompt, '원본 지시문', 'editing the clone never edits the original (deep clone)');
  assert.equal(independent.nodes.find(entry => entry.id === third.id).config.prompt, '복제본만 수정');
  assert.deepEqual(f.writes, []);

  // context menu entry with its shortcut hint
  await header(page, 'board-1').click({ button: 'right' });
  const entry = item(page, '복제');
  assert.equal(await entry.locator('.ff-context-menu__description').innerText(), 'Ctrl/⌘ D');
  const count = (await graphOf(page)).nodes.length;
  await entry.click();
  assert.equal((await graphOf(page)).nodes.length, count + 1);
  assert.equal((await page.evaluate(() => window.editor.getContext())).selectedNodeId !== 'board-1', true);
});

test('Delete/Backspace never delete silently: they open the confirmation, cancel keeps the node, confirm is one undo step, the last node is protected', async t => {
  const f = await fixture(t), { page } = f;
  await openEditor(f);
  const original = await graphOf(page);
  await header(page, 'board-1').click();
  await page.keyboard.press('Delete');
  const dialog = page.locator('#wf-delete-node-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.match(await dialog.locator('#wf-delete-node-name').innerText(), /스토리보드/);
  assert.deepEqual(await graphOf(page), original, 'pressing Delete alone removes nothing');
  assert.equal(await dirty(page), false);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(await graphOf(page), original, 'cancelling keeps the node and its edges');
  assert.deepEqual(await active(page), { id: '', action: 'select-node', node: 'board-1' }, 'focus returns to the node');

  await page.keyboard.press('Backspace');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('[data-wf-action=delete-node]').click();
  const removed = await graphOf(page);
  assert.deepEqual(ids(removed), ['script-1', 'render-1', 'review-1']);
  assert.deepEqual(removed.edges.map(link => link.id), ['e3'], "the removed node's connections go with it");
  assert.equal(await dirty(page), true);
  await undoButton(page).click();
  assert.deepEqual(await graphOf(page), original, 'one undo restores the node and every connection');
  assert.equal(await undoButton(page).isDisabled(), true);
  assert.deepEqual(f.writes, [], 'nothing was ever saved');

  // menu entry carries the shortcut hint and goes through the same confirmation
  await header(page, 'board-1').click({ button: 'right' });
  assert.equal(await item(page, '노드 제거…').locator('.ff-context-menu__description').innerText(), 'Delete');
  await page.keyboard.press('Escape');

  // the final node is protected exactly as before
  const solo = await fixture(t);
  await openEditor(solo, { nodes: [node('only', 'trend', 50, 60)], edges: [], name: 'Single node' });
  await header(solo.page, 'only').click();
  await solo.page.keyboard.press('Delete');
  assert.equal(await solo.page.locator('#wf-delete-node-dialog').evaluate(element => element.open), false, 'no confirmation for a node that cannot be removed');
  assert.match((await toasts(solo.page)).at(-1).message, /마지막 노드/);
  assert.equal((await graphOf(solo.page)).nodes.length, 1);

  // read-only sessions are refused visibly
  await page.evaluate(() => { window.__canMutate = false; });
  await header(page, 'board-1').click();
  await page.keyboard.press(`${MOD}+d`);
  await page.keyboard.press('Delete');
  assert.equal((await toasts(page)).filter(entry => entry.isError).length >= 2, true, 'both shortcuts explain the refusal');
  assert.equal(await page.locator('#wf-delete-node-dialog').evaluate(element => element.open), false);
  assert.deepEqual(await graphOf(page), original);
});

test('shortcuts are ignored while typing in fields and while a dialog is open', async t => {
  const f = await fixture(t), { page } = f;
  await openEditor(f);
  const original = await graphOf(page);
  await header(page, 'board-1').click();
  // fields inside the canvas (injected, test-only): input, textarea, select and contenteditable
  await page.evaluate(() => {
    const canvas = document.querySelector('#workflow-canvas');
    canvas.insertAdjacentHTML('beforeend', '<input id="probe-input"><textarea id="probe-text"></textarea><select id="probe-select"><option>a</option></select><div id="probe-editable" contenteditable="true"></div>');
  });
  for (const selector of ['#probe-input', '#probe-text', '#probe-editable']) {
    await page.locator(selector).focus();
    await page.keyboard.type('a/b');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    await page.keyboard.press(`${MOD}+d`);
    const typed = await page.locator(selector).evaluate(element => element.value ?? element.textContent);
    assert.equal(typed, 'a/', `${selector}: typing and editing keys behave natively (got ${JSON.stringify(typed)})`);
  }
  await page.locator('#probe-select').focus();
  await page.keyboard.press('/');
  await page.keyboard.press('Delete');
  await page.keyboard.press(`${MOD}+d`);
  assert.equal(await page.locator('#wf-add-node-dialog').evaluate(element => element.open), false, '"/" in a field does not open the palette');
  assert.equal(await page.locator('#wf-delete-node-dialog').evaluate(element => element.open), false);
  assert.deepEqual(await graphOf(page), original, 'no node was duplicated or removed from a field');

  // inside the palette's own search field and the blueprint topic field
  await page.locator('[data-wf-action=open-add-node]').click();
  await page.keyboard.type('a/b');
  await page.keyboard.press(`${MOD}+d`);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  assert.equal(await page.locator('#wf-add-search').inputValue(), 'a/', 'palette search edits natively');
  await page.keyboard.press('Escape');
  await page.locator('[data-wf-action=open-blueprint]').click();
  await page.locator('#wf-blueprint-topic').fill('');
  await page.keyboard.type('x/y');
  await page.keyboard.press(`${MOD}+d`);
  assert.equal(await page.locator('#wf-blueprint-topic').inputValue(), 'x/y');
  await page.keyboard.press('Escape');
  assert.deepEqual(await graphOf(page), original);

  // an open dialog also blocks the canvas shortcuts even for an event aimed at the canvas
  await page.locator('[data-wf-action=open-workflow-settings]').click();
  await page.locator('#wf-workflow-dialog').waitFor({ state: 'visible' });
  const handled = await page.evaluate(() => {
    const canvas = document.querySelector('#workflow-canvas');
    const events = ['/', 'Delete', 'd'].map(key => { const event = new KeyboardEvent('keydown', { key, ctrlKey: key === 'd', bubbles: true, cancelable: true }); canvas.dispatchEvent(event); return event.defaultPrevented; });
    return events;
  });
  assert.deepEqual(handled, [false, false, false], 'a modal dialog being open means the shortcuts do nothing');
  assert.deepEqual(await graphOf(page), original);
  assert.deepEqual(f.writes, []);
});

// ===========================================================================
// Tidy layout (UI)
// ===========================================================================
test('Tidy lays nodes out in deterministic layered columns as ONE undo step, without touching ids or edges', async t => {
  const f = await fixture(t), { page } = f;
  const nodes = [node('script-1', 'script', 800, 400, { agent: 'studio', prompt: '' }), node('board-1', 'storyboard', 60, 500), node('layout-a', 'layout', 400, 50), node('layout-b', 'layout', 410, 700), node('render-1', 'render', 100, 100), node('review-1', 'review', 900, 60)];
  const edges = [edge('e1', 'script-1', 'board-1'), edge('e2', 'board-1', 'layout-a'), edge('e3', 'board-1', 'layout-b'), edge('e4', 'layout-a', 'render-1'), edge('e5', 'layout-b', 'render-1'), edge('e6', 'render-1', 'review-1')];
  await openEditor(f, { nodes, edges });
  const original = await graphOf(page);
  assert.equal(await page.locator('[data-wf-action=layout]').innerText(), '노드 정리');
  await page.locator('[data-wf-action=layout]').click();
  const tidy = await graphOf(page);
  const at = id => tidy.nodes.find(entry => entry.id === id);
  const columnX = depth => TIDY_ORIGIN.x + depth * (WIDTH + TIDY_GAP.x);
  assert.deepEqual({ x: at('script-1').x, y: at('script-1').y }, { x: columnX(0), y: TIDY_ORIGIN.y });
  assert.equal(at('board-1').x, columnX(1));
  assert.equal(at('layout-a').x, columnX(2));
  assert.equal(at('layout-b').x, columnX(2), 'siblings share a column');
  assert.ok(at('layout-a').y < at('layout-b').y, 'rows are ordered (equal barycenter -> by id)');
  assert.equal(at('render-1').x, columnX(3));
  assert.equal(at('review-1').x, columnX(4));
  for (const link of tidy.edges) assert.ok(at(link.source).x < at(link.target).x, `${link.id} flows left to right`);
  assertNoOverlap(tidy.nodes, 'tidy result');
  assert.ok(tidy.nodes.every(entry => entry.x % 10 === 0 && entry.y % 10 === 0), 'snapped to the 10px grid');
  assert.deepEqual(ids(tidy), ids(original), 'node ids and order are untouched');
  assert.deepEqual(tidy.edges, original.edges, 'edges are untouched');
  assert.deepEqual(tidy.nodes.map(({ x, y, ...rest }) => rest), original.nodes.map(({ x, y, ...rest }) => rest), 'only positions changed');
  assert.equal(await dirty(page), true);
  assert.match(await status(page).innerText(), /정리/);
  const rendered = await page.locator('.wf-node').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.dataset.nodeId, [Number.parseFloat(element.style.left), Number.parseFloat(element.style.top)]])));
  assert.deepEqual(rendered['render-1'], [at('render-1').x, at('render-1').y], 'the DOM was repainted at the new positions');

  // tidy again is a no-op and must not add a second undo entry
  await page.locator('[data-wf-action=layout]').click();
  assert.match(await status(page).innerText(), /이미 정리/);
  assert.deepEqual(await graphOf(page), tidy);
  await undoButton(page).click();
  assert.deepEqual(await graphOf(page), original, 'a single undo returns every node to its old position');
  assert.equal(await dirty(page), false);
  assert.equal(await undoButton(page).isDisabled(), true, 'tidy was exactly one history step');
  await page.locator('[data-wf-action=redo]').click();
  assert.deepEqual(await graphOf(page), tidy);
  assert.deepEqual(f.writes, [], 'tidy never saves');
});

// ===========================================================================
// AI blueprint dialog
// ===========================================================================
test('AI blueprint: nothing is requested on open; preview, then explicit apply stages a dirty draft; Save is the first workflow write', async t => {
  const f = await fixture(t), { page } = f;
  await openEditor(f);
  const original = await graphOf(page);
  const open = page.locator('[data-wf-action=open-blueprint]');
  assert.equal(await open.innerText(), 'AI 구성');
  await open.click();
  const dialog = page.locator('#wf-blueprint-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.deepEqual(f.proposals, [], 'opening the dialog never calls the endpoint');
  assert.deepEqual(f.writes, []);
  assert.equal((await active(page)).id, 'wf-blueprint-topic');
  assert.equal(await dialog.locator('#wf-blueprint-generation').isChecked(), false, 'generation is opt-in');
  assert.equal(await dialog.locator('#wf-blueprint-publish').isChecked(), false, 'publish is opt-in');
  assert.equal(await dialog.getByText('Higgsfield 생성 노드는 실행 전 견적과 사용자 승인이 필요합니다').count(), 1, 'cost/consent hint');
  assert.equal(await dialog.locator('#wf-blueprint-topic').getAttribute('maxlength'), '300');
  assert.equal(await dialog.locator('#wf-blueprint-style option').evaluateAll(options => options.map(option => option.value)).then(values => values.join()), 'news,explainer,short-hook');
  assert.equal(await dialog.locator('#wf-blueprint-apply').isDisabled(), true, 'nothing to apply yet');
  assert.equal(await dialog.locator('.primary').count(), 1, 'exactly one primary action');
  assert.match(await dialog.innerText(), /규칙 기반/, 'labelled as a rule-based draft');

  // required topic: inline error, still no request
  await dialog.locator('#wf-blueprint-generate').click();
  assert.equal(await dialog.locator('#wf-blueprint-topic-error').isVisible(), true);
  assert.equal(await dialog.locator('#wf-blueprint-topic').getAttribute('aria-invalid'), 'true');
  assert.deepEqual(f.proposals, []);

  // loading state is visible, busy and abortable
  let release; f.gate = new Promise(resolve => { release = resolve; });
  await dialog.locator('#wf-blueprint-topic').fill('금리 인하가 가계에 미치는 영향');
  await dialog.locator('#wf-blueprint-style').selectOption('news');
  await dialog.locator('#wf-blueprint-generate').click();
  await page.waitForFunction(() => document.querySelector('#wf-blueprint-generate')?.disabled === true);
  assert.equal(await dialog.locator('#wf-blueprint-generate').getAttribute('aria-busy'), 'true');
  assert.equal(await dialog.locator('#wf-blueprint-result').getAttribute('aria-busy'), 'true');
  assert.equal(await dialog.locator('#wf-blueprint-apply').isDisabled(), true);
  assert.match(await dialog.locator('#wf-blueprint-reset').innerText(), /취소/);
  release(); f.gate = null;
  await dialog.locator('[data-blueprint-preview]').waitFor();
  assert.equal(await dialog.locator('#wf-blueprint-generate').isDisabled(), false);
  assert.equal(await dialog.locator('#wf-blueprint-result').getAttribute('aria-busy'), 'false');

  assert.deepEqual(f.proposals, [{ method: 'POST', body: { arguments: { topic: '금리 인하가 가계에 미치는 영향', style: 'news', includeGeneration: false, includePublish: false } } }], 'one POST, exactly the contract arguments, no model');
  assert.equal(await dialog.locator('[data-blueprint-name]').innerText(), '뉴스 설명 구성안');
  assert.match(await dialog.locator('[data-blueprint-preview]').innerText(), /규칙 기반 구성안/);
  assert.match(await dialog.locator('[data-blueprint-preview]').innerText(), /6개 노드/);
  assert.deepEqual(await dialog.locator('[data-blueprint-stages] li strong').allTextContents(), ['트렌드 수집', '리서치 정리', '대본 작성', '스토리보드', '영상 렌더', '사람의 검토'], 'ordered stage list with Korean type names');
  assert.deepEqual(await dialog.locator('[data-blueprint-rationale] li').allTextContents(), PROPOSAL.rationale);
  assert.equal(await dialog.locator('[data-blueprint-diff]').innerText(), '노드 +6 −4 · 연결 +5 −3', 'diff against the current draft');
  assert.equal(await dialog.locator('.change-item').count() > 0, true, 'the existing change list renders the detail');
  assert.equal(await dialog.locator('.primary').count(), 1);
  assert.equal(await dialog.locator('#wf-blueprint-apply').isDisabled(), false);
  assert.deepEqual(await graphOf(page), original, 'previewing changes nothing on the canvas');
  assert.equal(await dirty(page), false);
  assert.deepEqual(f.writes, []);

  await dialog.locator('#wf-blueprint-apply').click();
  await dialog.waitFor({ state: 'hidden' });
  const applied = await graphOf(page);
  assert.deepEqual(applied.nodes, PROPOSAL.nodes, 'the draft nodes are the proposal');
  assert.deepEqual(applied.edges, PROPOSAL.edges);
  assert.equal(applied.name, original.name, 'the workflow keeps its own name');
  assert.equal(await dirty(page), true, 'applied as an unsaved draft');
  assert.match(await page.locator('#wf-save-status').innerText(), /저장되지 않은 변경/);
  assert.match(await status(page).innerText(), /저장하지 않았습니다/);
  assert.deepEqual(f.writes, [], 'ZERO workflow writes happened: only the proposal POST went out');
  assert.equal(f.proposals.length, 1);
  assert.equal(await page.locator('.wf-node').count(), 6, 'the canvas repainted with the new graph');
  assert.equal((await active(page)).action, 'open-blueprint', 'focus returns to the AI button');

  await undoButton(page).click();
  assert.deepEqual(await graphOf(page), original, 'the whole replacement is one undo step');
  assert.equal(await dirty(page), false);
  assert.equal(await undoButton(page).isDisabled(), true);
  await page.locator('[data-wf-action=redo]').click();
  assert.deepEqual((await graphOf(page)).nodes, PROPOSAL.nodes);
  assert.deepEqual(f.writes, []);

  // the explicit Save is the first (and only) write to /api/workflows
  const saved = page.waitForResponse(response => response.url() === `${f.base}/api/workflows/${f.workflow.id}` && response.request().method() === 'PUT');
  await page.locator('[data-wf-action=save]').click();
  assert.equal((await saved).status(), 200);
  assert.deepEqual(f.writes.map(write => `${write.method} ${write.path}`), [`PUT /api/workflows/${f.workflow.id}`]);
  assert.deepEqual(f.writes[0].body.nodes, PROPOSAL.nodes);
  assert.equal(f.writes[0].body.expectedVersion, f.workflow.version);
  assert.equal(await dirty(page), false);
  assert.equal(f.proposals.length, 1, 'saving does not re-request a proposal');
});

test('AI blueprint: option flags, warnings, server errors and cancelling are all visible states', async t => {
  const f = await fixture(t), { page } = f;
  await openEditor(f);
  await page.locator('[data-wf-action=open-blueprint]').click();
  const dialog = page.locator('#wf-blueprint-dialog');
  await dialog.waitFor({ state: 'visible' });
  const topic = dialog.locator('#wf-blueprint-topic');

  // optional nodes + warning from the server (generate omitted: a model must be chosen first)
  f.reply = () => ({ status: 200, json: { ok: true, result: { ...PROPOSAL, warnings: ['생성 모델을 먼저 선택해야 하므로 Higgsfield 생성 노드는 제외했습니다.'] } } });
  await topic.fill('주제');
  await dialog.locator('#wf-blueprint-generation').check();
  await dialog.locator('#wf-blueprint-publish').check();
  await dialog.locator('#wf-blueprint-generate').click();
  await dialog.locator('[data-blueprint-preview]').waitFor();
  assert.deepEqual(f.proposals.at(-1).body, { arguments: { topic: '주제', style: 'explainer', includeGeneration: true, includePublish: true } }, 'flags go through; no model argument is ever sent');
  assert.deepEqual(await dialog.locator('[data-blueprint-warnings] li').allTextContents(), ['생성 모델을 먼저 선택해야 하므로 Higgsfield 생성 노드는 제외했습니다.'], 'server warnings are shown in the preview');

  // server failure: visible error, no fabricated proposal, apply stays disabled, retry possible
  f.reply = () => ({ status: 500, json: { ok: false, error: '규칙 엔진을 사용할 수 없습니다.' } });
  await dialog.locator('#wf-blueprint-generate').click();
  await dialog.locator('#wf-blueprint-result [role=alert]').waitFor();
  assert.match(await dialog.locator('#wf-blueprint-result').innerText(), /규칙 엔진을 사용할 수 없습니다/);
  assert.equal(await dialog.locator('[data-blueprint-preview]').count(), 0, 'a failed request never shows a proposal');
  assert.equal(await dialog.locator('#wf-blueprint-apply').isDisabled(), true);
  assert.equal(await dialog.locator('#wf-blueprint-generate').isDisabled(), false);

  // malformed success body is rejected, never applied
  f.reply = () => ({ status: 200, json: { ok: true, result: { name: 'x', nodes: 'nope', edges: [] } } });
  await dialog.locator('#wf-blueprint-generate').click();
  await dialog.locator('#wf-blueprint-result [role=alert]').waitFor();
  assert.match(await dialog.locator('#wf-blueprint-result').innerText(), /형식/);
  assert.equal(await dialog.locator('#wf-blueprint-apply').isDisabled(), true);

  // a proposal that fails the existing validation cannot be applied
  f.reply = () => ({ status: 200, json: { ok: true, result: { ...PROPOSAL, edges: PROPOSAL.edges.slice(0, 2) } } });
  await dialog.locator('#wf-blueprint-generate').click();
  await dialog.locator('[data-blueprint-preview]').waitFor();
  assert.equal(await dialog.locator('#wf-blueprint-apply').isDisabled(), true, 'a disconnected proposal is blocked by workflowErrors()');
  assert.match(await dialog.locator('[data-blueprint-preview] [role=alert]').innerText(), /적용할 수 없습니다/);

  // abortable: cancelling a held request drops the late response
  let release; f.gate = new Promise(resolve => { release = resolve; });
  f.reply = () => ({ status: 200, json: { ok: true, result: PROPOSAL } });
  const requests = f.proposals.length;
  await dialog.locator('#wf-blueprint-generate').click();
  await page.waitForFunction(() => document.querySelector('#wf-blueprint-generate')?.disabled === true);
  await dialog.locator('#wf-blueprint-reset').click();
  assert.equal(await dialog.locator('#wf-blueprint-generate').isDisabled(), false);
  assert.equal(await dialog.locator('[data-blueprint-preview]').count(), 0);
  release(); f.gate = null;
  await page.waitForTimeout(150);
  assert.equal(f.proposals.length, requests + 1, 'the cancelled request was the only extra call');
  assert.equal(await dialog.locator('[data-blueprint-preview]').count(), 0, 'the late response of a cancelled request is ignored');
  assert.equal(await dialog.locator('#wf-blueprint-apply').isDisabled(), true);

  // closing the dialog drops the preview (it may be stale on reopen) but keeps what the user typed
  await dialog.locator('#wf-blueprint-generate').click();
  await dialog.locator('[data-blueprint-preview]').waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('[data-wf-action=open-blueprint]').click();
  assert.equal(await dialog.locator('[data-blueprint-preview]').count(), 0);
  assert.equal(await topic.inputValue(), '주제');
  assert.deepEqual(f.writes, [], 'none of this ever wrote to the server');
});

test('AI blueprint: apply refuses with a visible message while a run is live or the session is read-only', async t => {
  for (const scenario of ['running', 'read-only']) {
    const f = await fixture(t), { page } = f;
    await openEditor(f, { liveRun: scenario === 'running' });
    const original = await graphOf(page);
    if (scenario === 'read-only') await page.evaluate(() => { window.__canMutate = false; });
    else await page.waitForFunction(() => window.editor.getContext().hasActiveRun === true);
    await page.locator('[data-wf-action=open-blueprint]').click();
    const dialog = page.locator('#wf-blueprint-dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await dialog.locator('#wf-blueprint-generate').isDisabled(), false, `${scenario}: previewing is read-only and stays available`);
    await dialog.locator('#wf-blueprint-topic').fill('실행 중에도 미리보기');
    await dialog.locator('#wf-blueprint-generate').click();
    await dialog.locator('[data-blueprint-preview]').waitFor();
    assert.equal(await dialog.locator('#wf-blueprint-apply').isDisabled(), true, `${scenario}: apply is disabled`);
    const note = dialog.locator('#wf-blueprint-lock');
    assert.equal(await note.isVisible(), true, `${scenario}: the reason is shown`);
    assert.match(await note.innerText(), scenario === 'running' ? /진행 중/ : /로그인/);
    // defense in depth: even a forced click is refused with a visible message and the draft stays untouched
    await dialog.locator('#wf-blueprint-apply').evaluate(button => { button.disabled = false; });
    await dialog.locator('#wf-blueprint-apply').click();
    assert.match(await dialog.locator('#wf-blueprint-result [role=alert]').innerText(), scenario === 'running' ? /진행 중/ : /로그인/);
    assert.equal((await toasts(page)).some(entry => entry.isError && (scenario === 'running' ? /진행 중/ : /로그인/).test(entry.message)), true, `${scenario}: also surfaced as an error toast`);
    assert.deepEqual(await graphOf(page), original, `${scenario}: nothing was applied`);
    assert.equal(await dirty(page), false);
    assert.deepEqual(f.writes, []);
  }
});

test('destroy removes the authoring listeners and aborts an in-flight proposal request', async t => {
  const f = await fixture(t), { page } = f;
  await openEditor(f);
  await page.locator('[data-wf-action=open-blueprint]').click();
  await page.locator('#wf-blueprint-topic').fill('파기 중 요청');
  let release; f.gate = new Promise(resolve => { release = resolve; });
  const failed = page.waitForEvent('requestfailed', request => request.url().endsWith(OPERATION));
  await page.locator('#wf-blueprint-generate').click();
  await page.waitForFunction(() => document.querySelector('#wf-blueprint-generate')?.disabled === true);
  await page.evaluate(() => window.editor.destroy());
  assert.match((await failed).failure()?.errorText || '', /ABORT/i, 'the pending fetch is aborted, not left running');
  release(); f.gate = null;
  assert.equal(await page.locator('#wf-blueprint-dialog, #wf-add-node-dialog, #workflow-canvas').count(), 0, 'all editor DOM is gone');
  // remount and make sure a destroyed instance leaves no handlers behind that could act on the new DOM twice
  await page.evaluate(async () => { document.querySelector('#test-root').innerHTML = window.editor.html(); window.editor.mount(); });
  await page.locator('#workflow-canvas').waitFor();
  const before = (await graphOf(page)).nodes.length;
  await header(page, 'script-1').click();
  await page.keyboard.press(`${MOD}+d`);
  assert.equal((await graphOf(page)).nodes.length, before + 1, 'exactly one duplicate per key press after destroy + remount (no doubled listeners)');
  await page.locator('#workflow-canvas').focus();
  await page.keyboard.press('/');
  assert.equal(await page.locator('#wf-add-node-dialog[open]').count(), 1);
  assert.deepEqual(f.writes, []);
});
