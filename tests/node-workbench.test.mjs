import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';
import { dimensions } from '../server/render.mjs';

const modulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();

async function fixture(t, { touch = false, sceneTarget = false, nativeLogin = false, persistedHistory = false, maximumConnections = false, generationSwitch = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-node-workbench-'));
  const forbidden = async () => { assert.fail('Opening or editing the workbench cannot invoke external production'); };
  const loginToken = nativeLogin ? 'fixture-native-login-token' : '';
  let preparingHistory = persistedHistory;
  const trendQueries = [];
  const fetchTrends = persistedHistory ? async query => {
    assert.equal(preparingHistory, true, 'only pre-navigation HTTP run setup may collect trends');
    trendQueries.push(query);
    return { trends: [{ keyword: query, source: 'Fixture RSS', url: 'https://example.com/persisted-workbench-evidence' }], sources: [{ name: 'Fixture RSS', status: 'ok' }] };
  } : forbidden;
  const modelA = 'fixture-image-a', modelB = 'fixture-video-b';
  const schemas = {
    [modelA]: { id: modelA, type: 'image', parameters: [{ name: 'image_strength', type: 'integer', required: true }] },
    [modelB]: { id: modelB, type: 'video', parameters: [{ name: 'video_motion', type: 'string', required: true }] },
  };
  const app = createApp({
    dataDir, loginToken, publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), runAgent: forbidden, fetchTrends },
    generation: { capability: async () => ({ available: false }), models: generationSwitch ? async () => [{ id: modelA, name: 'Image A', type: 'image' }, { id: modelB, name: 'Video B', type: 'video' }] : forbidden, modelSchema: generationSwitch ? async id => { assert.ok(schemas[id], `unexpected model ${id}`); return schemas[id]; } : forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 1080 }, hasTouch: touch, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const writes = [], external = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname, body: request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : null });
    return route.continue();
  });
  t.after(async () => {
    await context.close(); await browser.close();
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.deepEqual(external, [], 'browser external traffic is blocked');
    assert.deepEqual(errors, [], 'the real workbench must not throw');
    assert.equal(writes.some(w => /\/(run|quote|generations|publication)(\/|$)/.test(w.path)), false, 'context actions never execute, quote or publish');
  });
  let apiContext = context;
  if (nativeLogin) {
    apiContext = await browser.newContext();
    const login = await apiContext.request.post(`${base}/api/login`, { headers: { origin: base }, data: { token: loginToken } });
    assert.equal(login.status(), 200, 'only the separate fixture seed context is preauthenticated');
  }
  const api = async (path, method = 'GET', body) => {
    const response = await apiContext.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const channel = await api('/api/channels', 'POST', { name: 'Native workbench channel', platform: 'youtube', category: 'information' });
  let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Exact target project', topic: 'Local factual cards' });
  const slot = (id, role) => ({ id, name: id, role, x: 0, y: 0, w: 100, h: 100, zIndex: 1 });
  episode = await api(`/api/episodes/${episode.id}`, 'PUT', { ...episode, scenes: [generationSwitch ? { ...episode.scenes[0], slots: [slot('first-image-slot', 'image-gen')] } : episode.scenes[0], { ...episode.scenes[0], id: 'second-target-scene', title: 'Second explicit scene', ...(generationSwitch ? { slots: [slot('second-video-slot', 'video-bg')] } : {}) }], expectedVersion: episode.version });
  const types = sceneTarget ? ['script', 'storyboard', 'generate', 'render'] : ['trend', 'trend', 'trend', 'trend'];
  const nodes = maximumConnections
    ? Array.from({ length: 128 }, (_, index) => ({ id: `limit-node-${String(index).padStart(3, '0')}`, type: 'trend', label: `Limit node ${index}`, x: 40 + index % 16 * 260, y: 50 + Math.floor(index / 16) * 190, config: {} }))
    : ['a', 'b', 'c', 'd'].map((id, i) => ({ id, type: types[i], label: `Node ${id.toUpperCase()}`, x: 40 + i % 2 * 300, y: 50 + Math.floor(i / 2) * 240, config: types[i] === 'script' ? { agent: 'existing' } : types[i] === 'generate' ? { model: 'bytedance/seedance-2.5/text-to-video', sceneId: episode.scenes.at(-1).id, sceneIndex: 1, prompt: 'Explicit fixture illustration', params: {} } : {} }));
  if (generationSwitch) nodes.find(node => node.id === 'c').config = { model: modelA, sceneId: episode.scenes[0].id, sceneIndex: 0, slotId: 'first-image-slot', prompt: 'Explicit fixture illustration', params: { image_strength: 4 } };
  const edges = maximumConnections
    ? nodes.slice(1).map((node, index) => ({ id: `hub-${index + 1}`, source: nodes[0].id, target: node.id }))
    : [{ id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }, ...(sceneTarget ? [] : [{ id: 'ac', source: 'a', target: 'c' }]), { id: 'cd', source: 'c', target: 'd' }];
  if (maximumConnections) for (let gap = 1; edges.length < 256; gap++) for (let index = 1; index + gap < nodes.length && edges.length < 256; index++) edges.push({ id: `nonhub-${index}-${gap}`, source: nodes[index].id, target: nodes[index + gap].id });
  if (persistedHistory) nodes[0].config = { query: 'Persisted project A evidence' };
  const template = await api('/api/workflows', 'POST', { name: 'Exact editable graph', nodes, edges });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  if (persistedHistory) {
    const otherEpisode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Later-created history project B', topic: 'Independent project B content' });
    const otherTemplate = await api('/api/workflows', 'POST', { name: 'Independent history graph B', nodes: nodes.map(node => ({ ...node, label: `Project B ${node.label}`, config: node.id === 'a' ? { query: 'Persisted project B evidence' } : node.config })), edges });
    const otherWorkflow = await api(`/api/workflows/${otherTemplate.id}/copies`, 'POST', { channelId: channel.id, episodeId: otherEpisode.id, expectedTemplateVersion: otherTemplate.version });
    const seedRun = async (graph, owner) => {
      const started = await api(`/api/workflows/${graph.id}/run`, 'POST', { episodeId: owner.id, selectedStages: ['a'], startStage: 'a', expectedWorkflowVersion: graph.version, expectedEpisodeVersion: owner.version });
      for (let turn = 0; turn < 100; turn++) {
        const run = await api(`/api/workflow-runs/${started.id}`);
        if (!['completed', 'failed', 'cancelled'].includes(run.status)) continue;
        assert.equal(run.status, 'completed', JSON.stringify(run));
        assert.equal(run.workflowId, graph.id);
        assert.equal(run.episodeId, owner.id);
        assert.equal(run.workflowVersion, graph.version);
        assert.equal(run.episodeVersion, owner.version);
        assert.deepEqual(run.workflowSnapshot, graph);
        assert.deepEqual(run.selectedStages, ['a']);
        assert.equal(run.nodeRuns.find(node => node.nodeId === 'a').status, 'completed');
        assert.deepEqual(run.nodeRuns.find(node => node.nodeId === 'a').output.trends.map(trend => trend.keyword), [graph.nodes[0].config.query]);
        assert.equal(run.nodeRuns.filter(node => node.nodeId !== 'a').every(node => node.status === 'skipped'), true);
        return run;
      }
      assert.fail('Pre-navigation HTTP trend run did not reach its persisted terminal state');
    };
    const run = await seedRun(workflow, episode), otherRun = await seedRun(otherWorkflow, otherEpisode);
    preparingHistory = false;
    assert.deepEqual(trendQueries, ['Persisted project A evidence', 'Persisted project B evidence']);
    return { page, context, base, api, writes, channel, episode, workflow, run, otherEpisode, otherWorkflow, otherRun, trendQueries };
  }
  if (nativeLogin) {
    const otherChannel = await api('/api/channels', 'POST', { name: 'Later-created login channel', platform: 'youtube', category: 'information' });
    const otherEpisode = await api('/api/episodes', 'POST', { channelId: otherChannel.id, title: 'Not the selected login project', topic: 'Distinct latest project' });
    const otherTemplate = await api('/api/workflows', 'POST', { name: 'Equal-size distinct login decoy', nodes: nodes.map(node => ({ ...node, id: `other-${node.id}`, label: `Decoy ${node.label}` })), edges: edges.map(edge => ({ ...edge, id: `other-${edge.id}`, source: `other-${edge.source}`, target: `other-${edge.target}` })) });
    await api(`/api/workflows/${otherTemplate.id}/copies`, 'POST', { channelId: otherChannel.id, episodeId: otherEpisode.id, expectedTemplateVersion: otherTemplate.version });
    await apiContext.close(); apiContext = context;
    await page.goto(base); await page.locator('#login-form').waitFor();
    return { page, context, base, api, writes, channel, episode, workflow, loginToken, otherEpisode };
  }
  await page.goto(base); await page.locator('#app .shell').waitFor();
  if (maximumConnections) {
    await page.locator('#workflow-canvas').waitFor();
    return { page, context, base, api, writes, channel, episode, workflow };
  }
  const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(e => e.open)) await group.locator('summary').click();
  await channelButton.click(); await page.locator('#workflow-canvas').waitFor();
  return { page, context, base, api, writes, channel, episode, workflow };
}

const node = (page, id) => page.locator(`.wf-node[data-node-id="${id}"]`);
const header = (page, id) => page.locator(`.wf-node-header[data-id="${id}"]`);
const menu = page => page.locator('.ff-context-menu[role=menu]');
const item = (page, name) => menu(page).getByRole('menuitem', { name, exact: true });
const focused = page => page.locator('#wf-focused-node');
const focusedButton = (page, action) => focused(page).locator(`[data-wf-action="${action}"]`);
async function openNodeMenu(page, id, via = 'right-click') {
  if (via === 'more') await node(page, id).locator('[data-wf-action=node-menu]').click();
  else if (via === 'touch') await node(page, id).locator('[data-wf-action=node-menu]').tap();
  else if (via === 'right-click') await header(page, id).click({ button: 'right' });
  else { await header(page, id).focus(); await page.keyboard.press(via); }
  await menu(page).waitFor();
}
async function withinViewport(locator) {
  assert.equal(await locator.evaluate(e => {
    const r = e.getBoundingClientRect(), v = window.visualViewport;
    const left = v?.offsetLeft || 0, top = v?.offsetTop || 0;
    return r.left >= left && r.top >= top && r.right <= left + (v?.width || innerWidth) && r.bottom <= top + (v?.height || innerHeight);
  }), true, 'every context action remains inside the viewport');
}
async function saveGraph(f, status = 200) {
  const response = f.page.waitForResponse(r => r.url() === `${f.base}/api/workflows/${f.workflow.id}` && r.request().method() === 'PUT');
  await f.page.locator('[data-wf-action=save]').click();
  const actual = await response;
  assert.equal(actual.status(), status, await actual.text());
  assert.equal(actual.request().postDataJSON().expectedVersion, f.workflow.version, 'Save uses the draft original base');
  return actual;
}

test('generation model switch renders only the selected schema and saves only its edited parameters', async t => {
  const f = await fixture(t, { sceneTarget: true, generationSwitch: true }), { page } = f;
  const history = await f.api(`/api/workflows/${f.workflow.id}/history`);
  await openNodeMenu(page, 'c', 'more'); await item(page, '노드 설정 편집').click();
  const dialog = page.locator('#wf-tools-dialog[open]');
  await dialog.locator('[data-wf-action=refresh-generation]').click();
  const image = dialog.locator('[data-wf-param=image_strength]');
  await image.waitFor();
  assert.equal(await image.inputValue(), '4');
  await image.fill('7');
  await dialog.locator('[data-wf-config=model]').selectOption('fixture-video-b');
  const video = dialog.locator('[data-wf-param=video_motion]');
  await video.waitFor();
  assert.equal(await image.count(), 0, 'the previous model control is removed, not left editable');
  await video.fill('slow pan');
  assert.deepEqual(f.writes, [], 'opening and switching a model only changes the local draft');
  assert.deepEqual((await f.api('/api/workflows')).find(w => w.id === f.workflow.id), f.workflow);
  assert.deepEqual(await f.api(`/api/workflows/${f.workflow.id}/history`), history);
  await page.keyboard.press('Escape');
  await saveGraph(f);
  const saved = (await f.api('/api/workflows')).find(w => w.id === f.workflow.id);
  const config = saved.nodes.find(n => n.id === 'c').config;
  assert.equal(config.model, 'fixture-video-b');
  assert.deepEqual(config.params, { video_motion: 'slow pan' }, 'old model values cannot overwrite the new model');
  assert.equal(config.sceneId, f.episode.scenes[0].id);
  assert.equal(config.slotId, 'first-image-slot');
  assert.deepEqual(saved.nodes.filter(n => n.id !== 'c'), f.workflow.nodes.filter(n => n.id !== 'c'));
  assert.equal(saved.version, f.workflow.version + 1);
  assert.deepEqual((await f.api('/api/state')).episodes.find(e => e.id === f.episode.id), f.episode);
});

test('generation scene switch clears the old slot and allows a new scene slot without navigation writes', async t => {
  const f = await fixture(t, { sceneTarget: true, generationSwitch: true }), { page } = f;
  const history = await f.api(`/api/workflows/${f.workflow.id}/history`);
  await openNodeMenu(page, 'c', 'more'); await item(page, '노드 설정 편집').click();
  const dialog = page.locator('#wf-tools-dialog[open]');
  const scene = dialog.locator('[data-wf-config=sceneIndex]');
  const slot = dialog.locator('[data-wf-config=slotId]');
  assert.equal(await slot.inputValue(), 'first-image-slot');
  await scene.fill('2');
  await page.locator('#wf-tools-dialog [data-wf-field=label]').focus();
  await slot.locator('option[value="second-video-slot"]').waitFor({ state: 'attached' });
  assert.equal(await slot.inputValue(), '', 'the first scene slot is invalid after switching');
  assert.equal(await slot.locator('option[value="first-image-slot"]').count(), 0);
  assert.deepEqual(f.writes, [], 'scene navigation must not save a graph or episode');
  assert.deepEqual((await f.api('/api/workflows')).find(w => w.id === f.workflow.id), f.workflow);
  assert.deepEqual(await f.api(`/api/workflows/${f.workflow.id}/history`), history);
  await slot.selectOption('second-video-slot');
  assert.deepEqual(f.writes, [], 'slot selection is also a local draft');
  await page.keyboard.press('Escape');
  await saveGraph(f);
  const saved = (await f.api('/api/workflows')).find(w => w.id === f.workflow.id);
  const config = saved.nodes.find(n => n.id === 'c').config;
  assert.equal(config.sceneId, f.episode.scenes[1].id);
  assert.equal(config.sceneIndex, 1);
  assert.equal(config.slotId, 'second-video-slot');
  assert.deepEqual(config.params, { image_strength: 4 });
  assert.equal(config.prompt, 'Explicit fixture illustration');
  assert.deepEqual(saved.nodes.filter(n => n.id !== 'c'), f.workflow.nodes.filter(n => n.id !== 'c'));
  assert.equal(saved.version, f.workflow.version + 1);
  assert.deepEqual((await f.api('/api/state')).episodes.find(e => e.id === f.episode.id), f.episode);
});

// Removed from the node menu (contract 2.2); reachable via the always-visible #wf-focused-node
// panel. Select/invoke the node first (syncs data-id via updateSummary), then click its button.
async function connections(page, id) {
  await header(page, id).click(); await focusedButton(page, 'connections').click();
  await page.locator('#wf-connect-dialog[open]').waitFor();
  return page.locator('#wf-connect-dialog .wf-connection-list [data-wf-action=delete-edge]');
}

test('right-click and both keyboard context keys edit the invoked node, and opening never writes', async t => {
  const f = await fixture(t), { page } = f;
  assert.equal(await page.locator('#workflow-canvas').isVisible(), true);
  assert.equal(await page.locator('.project-modes, .task-nav [data-view=studio], .task-nav [data-view=workflow]').count(), 0, 'one canvas, not A/B tabs');
  const originalHistory = await f.api(`/api/workflows/${f.workflow.id}/history`);
  for (const via of ['right-click', 'Shift+F10', 'ContextMenu', 'more']) {
    await header(page, 'a').click();
    await openNodeMenu(page, 'b', via);
    assert.ok((await menu(page).innerText()).includes('Node B'), `${via} menu describes the invoked target`);
    await item(page, '노드 설정 편집').click();
    assert.equal(await page.locator('#wf-tools-dialog [data-wf-field=label]').inputValue(), 'Node B');
    assert.equal(await page.locator('.wf-node.selected').getAttribute('data-node-id'), 'b');
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(f.writes, [], 'all four opening paths are read-only');
  assert.deepEqual(await f.api(`/api/workflows/${f.workflow.id}/history`), originalHistory);
  await openNodeMenu(page, 'b'); await item(page, '노드 설정 편집').click();
  await page.locator('#wf-tools-dialog [data-wf-field=label]').fill('Only B edited');
  await page.keyboard.press('Escape');
  assert.deepEqual(f.writes, [], 'node editing creates only a local draft');
  await saveGraph(f);
  const saved = (await f.api('/api/workflows')).find(w => w.id === f.workflow.id);
  assert.equal(saved.nodes.find(n => n.id === 'b').label, 'Only B edited');
  assert.deepEqual(saved.nodes.filter(n => n.id !== 'b'), f.workflow.nodes.filter(n => n.id !== 'b'));
  assert.equal(saved.version, f.workflow.version + 1);
  const history = await f.api(`/api/workflows/${f.workflow.id}/history`);
  assert.ok(history.some(h => h.version === f.workflow.version));
  assert.ok(history.some(h => h.version === saved.version && h.snapshot.nodes.some(n => n.id === 'b' && n.label === 'Only B edited')));
});

test('exact edge unlink and node removal retain unrelated edges, undo restores incidents, and only Save persists', async t => {
  const f = await fixture(t), { page } = f;
  await connections(page, 'b');
  await page.locator('#wf-connect-dialog [data-wf-action=delete-edge][data-id=ab]').click();
  await page.keyboard.press('Escape');
  assert.deepEqual((await f.api('/api/workflows')).find(w => w.id === f.workflow.id).edges, f.workflow.edges, 'unlink is local until Save');
  await page.locator('[data-wf-action=undo]').click();
  const restored = await connections(page, 'b');
  assert.deepEqual((await restored.evaluateAll(es => es.map(e => e.dataset.id))).sort(), ['ab', 'bc']);
  await page.keyboard.press('Escape');
  await header(page, 'a').click(); await openNodeMenu(page, 'b'); await item(page, '노드 제거…').click();
  assert.equal(await page.locator('#wf-delete-node-name').innerText(), 'Node B');
  await page.locator('#wf-delete-node-dialog [data-wf-action=delete-node]').click();
  assert.equal(await node(page, 'b').count(), 0);
  assert.equal(await node(page, 'a').count(), 1, 'preselected node was not removed');
  assert.deepEqual(f.writes, []);
  await page.locator('[data-wf-action=undo]').click();
  assert.equal(await node(page, 'b').count(), 1);
  const incidents = await connections(page, 'b');
  assert.deepEqual((await incidents.evaluateAll(es => es.map(e => e.dataset.id))).sort(), ['ab', 'bc']);
  await page.keyboard.press('Escape');
  await openNodeMenu(page, 'b', 'more'); await item(page, '노드 제거…').click();
  await page.locator('#wf-delete-node-dialog [data-wf-action=delete-node]').click();
  await saveGraph(f);
  const saved = (await f.api('/api/workflows')).find(w => w.id === f.workflow.id);
  assert.deepEqual(saved.nodes.map(n => n.id), ['a', 'c', 'd']);
  assert.deepEqual(saved.edges, f.workflow.edges.filter(e => !['ab', 'bc'].includes(e.id)), 'no implicit rewiring or unrelated edge loss');
  const history = await f.api(`/api/workflows/${f.workflow.id}/history`);
  assert.deepEqual(history.find(h => h.version === f.workflow.version).snapshot.edges, f.workflow.edges);
  assert.deepEqual(history.find(h => h.version === saved.version).snapshot.edges, saved.edges);
});

test('stale graph Save rejects the original expectedVersion and retains the exact edited draft', async t => {
  const f = await fixture(t), { page } = f;
  await openNodeMenu(page, 'c', 'Shift+F10'); await item(page, '노드 설정 편집').click();
  await page.locator('#wf-tools-dialog [data-wf-field=label]').fill('Local C survives conflict'); await page.keyboard.press('Escape');
  const concurrent = await f.api(`/api/workflows/${f.workflow.id}`, 'PUT', { ...f.workflow, name: 'Concurrent saved graph', expectedVersion: f.workflow.version });
  await saveGraph(f, 409);
  await openNodeMenu(page, 'c', 'more'); await item(page, '노드 설정 편집').click();
  assert.equal(await page.locator('#wf-tools-dialog [data-wf-field=label]').inputValue(), 'Local C survives conflict');
  assert.equal(await page.locator('#wf-save-status').getAttribute('class'), 'unsaved');
  assert.deepEqual((await f.api('/api/workflows')).find(w => w.id === f.workflow.id), concurrent);
});

test('touch more menus clamp to the viewport, restore focus, dismiss outside, and describe tooltips without writes', async t => {
  const f = await fixture(t, { touch: true }), { page } = f;
  const more = node(page, 'd').locator('[data-wf-action=node-menu]');
  await openNodeMenu(page, 'd', 'touch'); await withinViewport(menu(page));
  await page.keyboard.press('End');
  assert.equal(await menu(page).getByRole('menuitem').last().evaluate(e => e === document.activeElement), true);
  await page.keyboard.press('Home');
  assert.equal(await menu(page).getByRole('menuitem').first().evaluate(e => e === document.activeElement), true);
  await page.keyboard.press('Escape'); await menu(page).waitFor({ state: 'hidden' });
  assert.equal(await more.evaluate(e => e === document.activeElement), true, 'Escape restores touch/more opener');
  await openNodeMenu(page, 'd', 'touch');
  const outside = page.locator('[data-action=project-tools]'); await outside.focus();
  await menu(page).waitFor({ state: 'hidden' });
  assert.equal(await outside.evaluate(e => e === document.activeElement), true, 'outside focus is never stolen');
  await openNodeMenu(page, 'd', 'touch');
  await page.locator('#project-navigation .project-context').tap(); await menu(page).waitFor({ state: 'hidden' });
  const tooltipTrigger = page.locator('[data-action=project-tools][data-tooltip]');
  const text = await tooltipTrigger.getAttribute('data-tooltip');
  assert.ok(text?.trim(), 'the visible tools entry has explanatory text');
  await tooltipTrigger.hover(); await page.locator('.ff-info-tooltip[role=tooltip]').waitFor();
  const tooltipId = await page.locator('.ff-info-tooltip').getAttribute('id');
  assert.equal(await page.locator('.ff-info-tooltip').innerText(), text);
  assert.ok((await tooltipTrigger.getAttribute('aria-describedby')).split(/\s+/).includes(tooltipId));
  await page.keyboard.press('Escape'); await page.locator('.ff-info-tooltip').waitFor({ state: 'hidden' });
  assert.equal((await tooltipTrigger.getAttribute('aria-describedby') || '').split(/\s+/).includes(tooltipId), false);
  await page.mouse.move(0, 0); await header(page, 'a').focus(); await tooltipTrigger.focus();
  await page.locator('.ff-info-tooltip[role=tooltip]').waitFor();
  assert.ok((await tooltipTrigger.getAttribute('aria-describedby')).split(/\s+/).includes(await page.locator('.ff-info-tooltip').getAttribute('id')));
  await withinViewport(page.locator('.ff-info-tooltip'));
  const focusedTooltipId = await page.locator('.ff-info-tooltip').getAttribute('id');
  await tooltipTrigger.evaluate(e => { e.style.display = 'none'; });
  await page.locator('.ff-info-tooltip').waitFor({ state: 'hidden' });
  assert.equal((await tooltipTrigger.getAttribute('aria-describedby') || '').split(/\s+/).includes(focusedTooltipId), false, 'hiding a focused trigger cannot leave a dangling description');
  assert.deepEqual(f.writes, []);
});

for (const { width, height } of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
  test(`${width}px portrait touch workbench keeps actions reachable and exact node and scene drafts through channel reselect without writes`, async t => {
    const f = await fixture(t, { touch: true, sceneTarget: true }), { page } = f;
    await page.setViewportSize({ width, height });
    const assertNoOverflow = async () => {
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, client: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      assert.equal(geometry.viewport, width, 'portrait viewport must not expand to fit desktop content');
      assert.ok(geometry.client <= width && geometry.document <= width + 1 && geometry.body <= width + 1, `no document horizontal overflow: ${JSON.stringify(geometry)}`);
    };
    const reachable = async locator => {
      await locator.scrollIntoViewIfNeeded();
      await withinViewport(locator);
      const target = await locator.boundingBox();
      assert.ok(target && target.width >= 24 && target.height >= 40, `touch action has a usable target: ${JSON.stringify(target)}`);
    };
    const channel = page.locator(`[data-action=channel][data-id="${f.channel.id}"]`);
    const projectMenu = page.locator('#project-navigation [data-action=project-menu]');
    const tools = page.locator('[data-action=project-tools]');
    await assertNoOverflow();
    for (const control of [channel, tools, page.locator('#project-episode'), page.locator('#project-stage'), projectMenu,
      page.locator('#project-navigation [data-action=open-scene-editor]'),
      page.locator('#project-navigation [data-action=project-section][data-section=source]'),
      page.locator('#project-navigation [data-action=project-section][data-section=delivery]'),
      page.locator('#wf-select'), page.locator('[data-wf-action=open-add-node]')]) await reachable(control);

    await projectMenu.tap(); await withinViewport(menu(page));
    assert.equal(await menu(page).locator('.ff-context-menu__title').innerText(), f.episode.title);
    await page.keyboard.press('Escape'); await menu(page).waitFor({ state: 'hidden' });
    assert.equal(await projectMenu.evaluate(element => element === document.activeElement), true, 'project menu dismiss restores its touch opener');
    await tools.tap(); await withinViewport(menu(page));
    await item(page, '소스 · 이용 권리').waitFor();
    await page.keyboard.press('Escape'); await menu(page).waitFor({ state: 'hidden' });
    assert.equal(await tools.evaluate(element => element === document.activeElement), true, 'tools menu dismiss restores its touch opener');

    await header(page, 'a').tap();
    await reachable(node(page, 'b').locator('[data-wf-action=node-menu]'));
    await openNodeMenu(page, 'b', 'touch'); await withinViewport(menu(page));
    assert.match(await menu(page).locator('.ff-context-menu__title').innerText(), /^Node B ·/);
    await reachable(item(page, '노드 설정 편집')); await item(page, '노드 설정 편집').tap();
    const nodeDialog = page.locator('#wf-tools-dialog[open]');
    await nodeDialog.waitFor(); await withinViewport(nodeDialog);
    assert.equal(await page.locator('.wf-node.selected').getAttribute('data-node-id'), 'b', 'touch invocation targets B rather than previously selected A');
    assert.equal(await nodeDialog.locator('[data-wf-field=label]').inputValue(), 'Node B');
    const graphDraft = `Phone ${width} node B draft`, sceneDraft = `Phone ${width} second-scene draft`;
    await nodeDialog.locator('[data-wf-field=label]').fill(graphDraft);
    await reachable(nodeDialog.locator('[data-wf-action=close-overlay]'));
    await nodeDialog.locator('[data-wf-action=close-overlay]').tap();
    await nodeDialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('.wf-node[data-node-id="b"] [data-wf-action=node-menu]') === document.activeElement);

    await openNodeMenu(page, 'c', 'touch'); await withinViewport(menu(page));
    assert.match(await menu(page).locator('.ff-context-menu__title').innerText(), /^Node C ·/);
    await page.locator('#project-navigation .project-context').tap(); await menu(page).waitFor({ state: 'hidden' });
    await header(page, 'c').tap(); await focusedButton(page, 'scene-editor').tap();
    const sceneDialog = page.locator('#project-scene-dialog[open]');
    await sceneDialog.waitFor(); await withinViewport(sceneDialog); await assertNoOverflow();
    assert.equal(await sceneDialog.locator('[data-scene=title]').inputValue(), f.episode.scenes.at(-1).title, 'node C opens its explicit second scene, not the first scene');
    await sceneDialog.locator('[data-scene=title]').fill(sceneDraft);
    assert.equal(await sceneDialog.locator('#save-status').getAttribute('class'), 'unsaved');
    await reachable(sceneDialog.locator('[data-action=close-scene-editor]'));
    await sceneDialog.locator('[data-action=close-scene-editor]').tap();
    await sceneDialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#wf-focused-node [data-wf-action="scene-editor"]') === document.activeElement);

    await channel.tap(); await page.locator('#workflow-canvas').waitFor();
    assert.equal(await page.locator('#project-episode').inputValue(), f.episode.id);
    assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
    assert.equal(await node(page, 'b').locator('.wf-node-label').innerText(), graphDraft, 'channel reselect retains the exact unsaved graph label');
    assert.equal(await node(page, 'a').locator('.wf-node-label').innerText(), 'Node A', 'the previously selected node was not edited');
    await header(page, 'c').tap(); await focusedButton(page, 'connections').tap();
    const connectionsDialog = page.locator('#wf-connect-dialog[open]');
    await connectionsDialog.waitFor(); await withinViewport(connectionsDialog);
    assert.deepEqual((await connectionsDialog.locator('[data-wf-action=delete-edge]').evaluateAll(elements => elements.map(element => element.dataset.id))).sort(), ['bc', 'cd'], 'touch context browsing preserves both exact incident connections');
    await connectionsDialog.getByRole('button', { name: '노드 연결 닫기', exact: true }).tap(); await connectionsDialog.waitFor({ state: 'hidden' });
    await header(page, 'c').tap(); await focusedButton(page, 'scene-editor').tap();
    await sceneDialog.waitFor();
    assert.equal(await sceneDialog.locator('[data-scene=title]').inputValue(), sceneDraft, 'channel reselect and node context reopening retain the unsaved exact-scene draft');
    assert.equal(await sceneDialog.locator('#save-status').getAttribute('class'), 'unsaved');
    assert.equal(await sceneDialog.evaluate(element => element.contains(document.activeElement)), true, 'reopened scene editor owns focus');
    await sceneDialog.locator('[data-action=close-scene-editor]').tap(); await sceneDialog.waitFor({ state: 'hidden' });
    await assertNoOverflow();
    assert.deepEqual(f.writes, [], 'touch navigation, menus, draft edits and dismissal cannot save, delete, generate, render or publish');
    assert.deepEqual((await f.api('/api/workflows')).find(workflow => workflow.id === f.workflow.id), f.workflow, 'saved graph and version remain unchanged');
    assert.deepEqual((await f.api('/api/state')).episodes.find(episode => episode.id === f.episode.id), f.episode, 'saved scenes and version remain unchanged');
  });
}

test('scene overlay binds the selected scene and Ctrl+S saves only the active episode or graph owner', async t => {
  const f = await fixture(t, { sceneTarget: true }), { page } = f;
  await openNodeMenu(page, 'c', 'more'); await item(page, '노드 설정 편집').click();
  await page.locator('#wf-tools-dialog [data-wf-field=label]').fill('Independent graph draft'); await page.keyboard.press('Escape');
  await header(page, 'c').click(); await focusedButton(page, 'scene-editor').click();
  await page.locator('#project-scene-dialog.project-scene-dialog[open]').waitFor();
  assert.equal(await page.locator('#project-episode').inputValue(), f.episode.id);
  assert.equal(await page.locator('[data-scene=title]').inputValue(), f.episode.scenes.at(-1).title);
  await page.locator('[data-scene=title]').fill('Selected scene draft');
  const sceneSave = page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${f.episode.id}` && r.request().method() === 'PUT');
  await page.keyboard.press('Control+s'); const response = await sceneSave;
  assert.equal(response.status(), 200, await response.text());
  assert.equal(response.request().postDataJSON().expectedVersion, f.episode.version);
  assert.equal(f.writes.filter(w => w.path === `/api/workflows/${f.workflow.id}`).length, 0, 'scene Save cannot flush graph draft');
  await page.locator('[data-action=close-scene-editor]').click();
  const graphSave = page.waitForResponse(r => r.url() === `${f.base}/api/workflows/${f.workflow.id}` && r.request().method() === 'PUT');
  await page.keyboard.press('Control+s'); assert.equal((await graphSave).status(), 200);
  assert.equal(f.writes.filter(w => w.path === `/api/episodes/${f.episode.id}`).length, 1, 'canvas Save cannot resave episode');
  await header(page, 'c').click(); await focusedButton(page, 'scene-editor').click();
  assert.equal(await page.locator('[data-scene=title]').inputValue(), 'Selected scene draft');
  const saved = (await f.api('/api/state')).episodes.find(e => e.id === f.episode.id);
  assert.equal(saved.scenes.at(-1).title, 'Selected scene draft');
  assert.deepEqual(saved.scenes.slice(0, -1), f.episode.scenes.slice(0, -1));
  const graph = (await f.api('/api/workflows')).find(w => w.id === f.workflow.id);
  assert.equal(graph.nodes.find(n => n.id === 'c').label, 'Independent graph draft');
});

test('project menu rename, archive confirmation and restore persist real versions without deleting history or graph', async t => {
  const f = await fixture(t), { page } = f;
  const second = await f.api('/api/episodes', 'POST', { channelId: f.channel.id, title: 'Inactive menu target', topic: 'Must not rename active project' });
  await page.reload(); await page.locator('#workflow-canvas').waitFor();
  await page.locator('#project-episode').selectOption(f.episode.id);
  const group = page.locator(`[data-action=channel][data-id="${f.channel.id}"]`).locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(e => e.open)) await group.locator('summary').click();
  const targetMenu = page.locator(`.project-list [data-action=episode-menu][data-id="${second.id}"]`);
  await targetMenu.click(); assert.deepEqual(f.writes, []);
  await item(page, '제목 변경').click();
  await page.locator('#modal-form [name=title]').fill('Renamed exact project');
  const renamed = page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${second.id}` && r.request().method() === 'PUT');
  await page.locator('#modal-form button[type=submit]').click(); const renameResponse = await renamed;
  assert.equal(renameResponse.status(), 200, await renameResponse.text());
  assert.equal(renameResponse.request().postDataJSON().expectedVersion, second.version);
  const renamedProject = await renameResponse.json();
  assert.equal(renamedProject.title, 'Renamed exact project');
  assert.equal((await f.api('/api/state')).episodes.find(e => e.id === f.episode.id).title, f.episode.title);
  await targetMenu.click(); await item(page, '프로젝트 보관').click();
  assert.equal(f.writes.some(w => w.path.endsWith('/archive')), false, 'opening archive confirmation is no-write');
  await page.keyboard.press('Escape');
  assert.equal((await f.api('/api/state')).episodes.find(e => e.id === second.id).status, second.status, 'cancel archive preserves project');
  await targetMenu.click(); await item(page, '프로젝트 보관').click();
  const archived = page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${second.id}/archive` && r.request().method() === 'POST');
  await page.locator('#modal-form button[type=submit]').click(); const archiveResponse = await archived;
  assert.equal(archiveResponse.status(), 200, await archiveResponse.text());
  assert.equal(archiveResponse.request().postDataJSON().expectedVersion, renamedProject.version);
  const archivedProject = await archiveResponse.json();
  assert.equal(archivedProject.status, 'archived');
  assert.equal(archivedProject.version, renamedProject.version + 1);
  assert.equal(await targetMenu.count(), 0, 'archived project leaves active navigation');
  await page.locator('[data-action=project-tools]').click(); await item(page, '보관된 프로젝트').click();
  await page.locator('#project-tool-dialog.project-tool-dialog[open]').waitFor();
  const restored = page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${second.id}/unarchive` && r.request().method() === 'POST');
  await page.locator(`[data-action=unarchive-project][data-id="${second.id}"]`).click();
  assert.equal(f.writes.some(w => w.path.endsWith('/unarchive')), false, 'opening restore confirmation is no-write');
  await page.locator('#modal-form button[type=submit]').click(); const restoreResponse = await restored;
  assert.equal(restoreResponse.status(), 200, await restoreResponse.text());
  assert.equal(restoreResponse.request().postDataJSON().expectedVersion, archivedProject.version);
  const restoredProject = await restoreResponse.json();
  assert.equal(restoredProject.status, 'draft');
  assert.equal(restoredProject.version, archivedProject.version + 1);
  assert.deepEqual(restoredProject.scenes, second.scenes);
  const history = await f.api(`/api/episodes/${second.id}/history`);
  for (const version of [second.version, renamedProject.version, archivedProject.version, restoredProject.version]) assert.ok(history.some(h => h.version === version), `history retains v${version}`);
  assert.deepEqual((await f.api('/api/workflows')).find(w => w.id === f.workflow.id), f.workflow, 'lifecycle actions cannot mutate another project graph');
});
test('cold owned canvas and native channel reselect defer tool reads until live first opening without losing source drafts', async t => {
  const f = await fixture(t), { page } = f;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const upload = await f.api('/api/uploads?name=existing-tool-source.png', 'POST', png);
  const rights = await f.api(`/api/uploads/${upload.id}/rights`, 'POST', { origin: 'third-party', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Existing_tool_source.png', licenseId: 'CC-BY-4.0', attribution: 'Existing local source artist' });
  const externalId = `UC${'L'.repeat(22)}`;
  await f.api(`/api/channels/${f.channel.id}/youtube`, 'PUT', { externalId, expectedUpdatedAt: f.channel.updatedAt });
  await page.waitForLoadState('networkidle');
  const toolReads = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === f.base && request.method() === 'GET' && (url.pathname === '/api/uploads' || /^\/api\/channels\/[^/]+\/youtube$/.test(url.pathname) || /^\/api\/episodes\/[^/]+\/publications$/.test(url.pathname))) toolReads.push(url.pathname);
  });
  await page.goto(f.base); await page.locator('#workflow-canvas').waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#wf-episode').inputValue(), f.episode.id);
  assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
  assert.deepEqual(await page.locator('.wf-node').evaluateAll(elements => elements.map(element => element.dataset.nodeId)), f.workflow.nodes.map(node => node.id));
  assert.deepEqual(toolReads, [], 'a cold owned canvas cannot read uploads, OAuth or publications before a production tool is opened');
  const channelButton = page.locator(`[data-action=channel][data-id="${f.channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click(); await page.locator('#workflow-canvas').waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#wf-episode').inputValue(), f.episode.id);
  assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
  assert.deepEqual(toolReads, [], 'a real native channel reselect cannot initialize still-closed production tools');

  await page.locator('[data-action=project-tools]').click(); await item(page, '소스 · 이용 권리').click();
  const dialog = page.locator('#project-tool-dialog[open]');
  const source = dialog.locator('[data-production-tools][data-mode=source]');
  await source.locator('#pt-uploads strong').getByText(upload.name, { exact: true }).waitFor();
  await source.locator(`[data-pt-action=open-rights][data-id="${upload.id}"]`).click();
  const rightsDialog = source.locator('#pt-rights-dialog[open]');
  await rightsDialog.getByText(rights.attribution, { exact: true }).waitFor();
  assert.equal(await rightsDialog.getByText(rights.licenseId, { exact: true }).innerText(), 'CC-BY-4.0');
  assert.equal(await rightsDialog.locator('code').innerText(), upload.sha256, 'first-open listeners load the rights of the actual existing local bytes');
  await rightsDialog.locator('[data-pt-action=close-rights]').click();
  const query = 'Retained source draft, never submitted';
  await source.locator('#pt-search-form [name=query]').fill(query);
  const laterUpload = await f.api('/api/uploads?name=added-after-first-opening.png', 'POST', png);
  await source.locator('[data-pt-action=reload-uploads]').click();
  await source.locator('#pt-uploads strong').getByText(laterUpload.name, { exact: true }).waitFor();
  assert.equal(await source.locator('#pt-search-form [name=query]').inputValue(), query, 'a live local refresh retains the unsubmitted source draft');

  await dialog.locator('[data-action=tool-menu]').click(); await item(page, '검토 · 공개').click();
  const delivery = dialog.locator('[data-production-tools][data-mode=delivery]');
  await delivery.locator('#pt-channel-form [name=externalId]').waitFor();
  assert.equal(await delivery.locator('#pt-channel-form [name=externalId]').inputValue(), externalId, 'first delivery opening hydrates the actual current channel record, not an unbound panel');
  await delivery.getByText(`채널 ID: ${externalId} · ${f.channel.name}`, { exact: true }).waitFor();
  await delivery.getByText(`${f.episode.title} · v${f.episode.version}`, { exact: true }).waitFor();
  await delivery.getByText('게시 기록이 없습니다.', { exact: true }).waitFor();
  for (const path of ['/api/uploads', `/api/channels/${f.channel.id}/youtube`, `/api/episodes/${f.episode.id}/publications`]) assert.ok(toolReads.includes(path), `visible tools must hydrate through their real local endpoint: ${path}`);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  await page.locator('[data-action=project-tools]').click(); await item(page, '소스 · 이용 권리').click();
  await source.waitFor();
  assert.equal(await source.locator('#pt-search-form [name=query]').inputValue(), query, 'closing and reopening the lazily initialized tool cannot discard its source draft');
  await source.locator('#pt-uploads strong').getByText(laterUpload.name, { exact: true }).waitFor();
  assert.equal(await page.locator('#wf-episode').inputValue(), f.episode.id);
  assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
  assert.deepEqual(f.writes, [], 'first opening, rights inspection, local refresh, switching and reopening cannot save, upload, authorize, generate or publish');
  assert.deepEqual((await f.api('/api/state')).episodes.find(episode => episode.id === f.episode.id), f.episode);
  assert.deepEqual((await f.api('/api/workflows')).find(workflow => workflow.id === f.workflow.id), f.workflow);
});

test('switching source to delivery waits out the old native close event without closing the new tool', async t => {
  const f = await fixture(t), { page } = f;
  await page.locator('[data-action=project-tools]').click(); await item(page, '소스 · 이용 권리').click();
  const dialog = page.locator('#project-tool-dialog.project-tool-dialog');
  await dialog.locator('[data-production-tools][data-mode=source]').waitFor();
  for (const [mode, label] of [['delivery', '검토 · 공개'], ['source', '소스 · 이용 권리'], ['delivery', '검토 · 공개']]) {
    await dialog.evaluate(element => {
      element.dataset.testClosed = 'pending';
      element.addEventListener('close', () => { element.dataset.testClosed = 'observed'; }, { once: true });
    });
    await dialog.locator('[data-action=tool-menu]').click(); await item(page, label).click();
    await page.waitForFunction(() => document.querySelector('#project-tool-dialog')?.dataset.testClosed === 'observed');
    await page.locator(`#project-tool-dialog[open] [data-production-tools][data-mode=${mode}]`).waitFor();
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'old close cannot steal focus from the replacement tool');
  }
  assert.deepEqual(f.writes, [], 'switching tools never saves, generates, or publishes');
  assert.deepEqual((await f.api('/api/state')).episodes.find(e => e.id === f.episode.id), f.episode);
  assert.deepEqual((await f.api('/api/workflows')).find(w => w.id === f.workflow.id), f.workflow);
});

test('an upload completing after its pinned slot is deleted cannot replace the scene fallback media', async t => {
  const f = await fixture(t), { page } = f;
  await page.locator('[data-action=open-scene-editor]').first().click();
  await page.locator('#project-scene-dialog [data-action=add-slot][data-role=image-gen]').click();
  const uploadButton = page.locator('#project-scene-dialog [data-action=upload-slot-media]');
  const slotId = await uploadButton.getAttribute('data-slot-id');
  let finishUpload, failUpload, releaseResponse;
  const uploadStored = new Promise((resolve, reject) => { finishUpload = resolve; failUpload = reject; });
  const responseReleased = new Promise(resolve => { releaseResponse = resolve; });
  let upload;
  await f.context.route('**/api/uploads?name=removed-slot.png', async route => {
    f.writes.push({ method: route.request().method(), path: new URL(route.request().url()).pathname, body: null });
    try {
      const response = await route.fetch();
      upload = await response.json(); finishUpload(response.status());
      await responseReleased;
      await route.fulfill({ response });
    } catch (error) { failUpload(error); await route.abort(); }
  });
  try {
    const chooser = page.waitForEvent('filechooser'); await uploadButton.click();
    await (await chooser).setFiles({ name: 'removed-slot.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
    assert.equal(await uploadStored, 201, 'barrier holds a real successfully stored upload response');
    await page.locator(`#project-scene-dialog [data-action=delete-slot][data-slot-id="${slotId}"]`).click();
  } finally { releaseResponse(); }
  await page.getByText('업로드는 완료했지만 대상 슬롯이 없어 연결하지 않았습니다. 소스 도구에서 업로드 파일을 확인하세요.', { exact: true }).waitFor();
  const saving = page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${f.episode.id}` && r.request().method() === 'PUT');
  await page.locator('#save-button').click(); const response = await saving;
  assert.equal(response.status(), 200, await response.text());
  assert.equal(response.request().postDataJSON().expectedVersion, f.episode.version);
  const saved = (await f.api('/api/state')).episodes.find(e => e.id === f.episode.id);
  const before = f.episode.scenes[0], current = saved.scenes.find(scene => scene.id === before.id);
  assert.equal(current.kind, before.kind, 'removed-slot upload cannot change the scene kind');
  assert.equal(current.assetUrl, before.assetUrl, 'removed-slot upload cannot become scene fallback media');
  assert.equal(current.slots?.some(slot => slot.id === slotId) || false, false, 'upload cannot resurrect the deleted slot');
  const uploads = await f.api('/api/uploads');
  assert.ok(uploads.some(item => item.id === upload.id && item.url === upload.url), 'real uploaded source remains available for explicit attachment');
});

test('a delayed history GET cannot replace the newer delivery tool or steal its keyboard focus', async t => {
  const f = await fixture(t), { page } = f;
  let historyFetched, historyFailed, releaseHistory;
  const fetched = new Promise((resolve, reject) => { historyFetched = resolve; historyFailed = reject; });
  const released = new Promise(resolve => { releaseHistory = resolve; });
  await f.context.route(`**/api/episodes/${f.episode.id}/history`, async route => {
    try {
      assert.equal(route.request().method(), 'GET');
      const response = await route.fetch(); historyFetched(response.status());
      await released; await route.fulfill({ response });
    } catch (error) { historyFailed(error); await route.abort(); }
  });
  const completed = page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${f.episode.id}/history` && r.request().method() === 'GET');
  try {
    await page.locator('[data-action=project-tools]').click(); await item(page, '제작 히스토리').click();
    assert.equal(await fetched, 200, 'history barrier holds an actual successful backend GET');
    await page.locator('[data-action=project-tools]').click(); await item(page, '검토 · 공개').click();
    await page.locator('#project-tool-dialog[open] [data-production-tools][data-mode=delivery]').waitFor();
  } finally { releaseHistory(); }
  const response = await completed; assert.equal(await response.finished(), null, 'held history response completes successfully before checking current UI');
  assert.equal(await page.locator('#project-tool-title').innerText(), '검토 · 공개', 'older history completion cannot overwrite the latest tool intent');
  assert.equal(await page.locator('#project-tool-dialog[open] [data-production-tools][data-mode=delivery]').isVisible(), true);
  assert.equal(await page.locator('#project-tool-dialog').evaluate(element => element.contains(document.activeElement)), true, 'stale response cannot move focus out of the current tool');
  assert.deepEqual(f.writes, [], 'read-only tool races cannot write or publish');
  assert.deepEqual((await f.api('/api/state')).episodes.find(e => e.id === f.episode.id), f.episode);
  assert.deepEqual((await f.api('/api/workflows')).find(w => w.id === f.workflow.id), f.workflow);
});

test('desktop and 320px previews project exported text coordinates without changing saved font or slot geometry', async t => {
  const f = await fixture(t), { page } = f;
  await page.locator('[data-action=open-scene-editor]').first().click();
  await page.locator('#project-scene-dialog [data-action=add-slot][data-role=text-overlay]').click();
  const slotId = await page.locator('#project-scene-dialog [data-action=delete-slot]').getAttribute('data-slot-id');
  await page.locator('[data-slot-field=text]').fill('Readable preview');
  await page.locator('[data-slot-style=fontSize]').fill('96');
  for (const [field, value] of Object.entries({ x: '5', y: '5', w: '90', h: '80' })) await page.locator(`[data-slot-field=${field}]`).fill(value);
  for (const format of ['9:16', '1:1', '16:9']) {
    const settings = page.locator('#project-scene-dialog .inspector details').first();
    if (!await settings.evaluate(element => element.open)) await settings.locator('summary').click();
    await page.locator('[data-episode=format]').selectOption(format);
    const saving = page.waitForResponse(response => response.url() === `${f.base}/api/episodes/${f.episode.id}` && response.request().method() === 'PUT');
    await page.locator('#save-button').click(); const response = await saving;
    assert.equal(response.status(), 200, await response.text());
    const saved = await response.json(), writesBeforePreview = f.writes.length;
    const slot = saved.scenes[0].slots.find(item => item.id === slotId);
    const copySelector = `#preview .preview-slot[data-slot-id="${slotId}"] .slot-copy`;
    for (const width of [1600, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 844 : 1080 });
      await page.locator('#preview').scrollIntoViewIfNeeded();
      await page.waitForFunction(({ selector, sourceWidth, fontSize }) => {
        const copy = document.querySelector(selector), preview = document.querySelector('#preview');
        return copy && preview && Math.abs(parseFloat(getComputedStyle(copy).fontSize) - fontSize * preview.clientWidth / sourceWidth) < 0.25;
      }, { selector: copySelector, sourceWidth: dimensions[format][0], fontSize: slot.style.fontSize });
      const projection = await page.locator(copySelector).evaluate(element => {
        const preview = document.querySelector('#preview'), bounds = element.closest('.preview-slot').getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(element); const text = range.getBoundingClientRect();
        return { fontSize: parseFloat(getComputedStyle(element).fontSize), previewWidth: preview.clientWidth, fits: text.left >= bounds.left - 1 && text.right <= bounds.right + 1 && text.top >= bounds.top - 1 && text.bottom <= bounds.bottom + 1 };
      });
      assert.ok(Math.abs(projection.fontSize / projection.previewWidth - slot.style.fontSize / dimensions[format][0]) < 0.001, `${format} ${width}px preview uses exported source-space font scale`);
      assert.equal(projection.fits, true, `${format} ${width}px preview text remains inside its saved slot`);
    }
    assert.deepEqual(f.writes.slice(writesBeforePreview), [], 'responsive preview never writes source geometry or font settings');
    const current = (await f.api('/api/state')).episodes.find(episode => episode.id === f.episode.id);
    assert.deepEqual(current, saved, 'read-only preview preserves the exact exported scene values and episode version');
    await page.setViewportSize({ width: 1600, height: 1080 });
  }
});

test('configured-token native login hydrates workflows before fast nonlatest project selection without reload', async t => {
  const f = await fixture(t, { nativeLogin: true }), { page } = f;
  const loginButton = page.getByRole('button', { name: '스튜디오 열기 →', exact: true });
  const rejected = page.waitForResponse(response => response.url() === `${f.base}/api/login` && response.request().method() === 'POST');
  await page.locator('#login-form [name=token]').fill('incorrect-fixture-token'); await loginButton.click();
  const rejectedResponse = await rejected; assert.equal(rejectedResponse.status(), 401);
  await page.locator('#login-form').getByRole('alert').filter({ hasText: /^Invalid login token$/ }).waitFor();
  assert.equal(await page.locator('#login-form').isVisible(), true, 'wrong-token submission cannot leave native authentication');
  assert.equal(await page.locator('#app .shell').count(), 0);
  const deniedState = await f.context.request.get(`${f.base}/api/state`);
  assert.equal(deniedState.status(), 401, 'wrong token cannot grant protected project access');
  assert.equal((await deniedState.json()).error, 'Login required');
  let workflowsFetched, workflowsFailed, releaseWorkflows;
  const fetched = new Promise((resolve, reject) => { workflowsFetched = resolve; workflowsFailed = reject; });
  const released = new Promise(resolve => { releaseWorkflows = resolve; });
  await f.context.route('**/api/workflows', async route => {
    try {
      assert.equal(route.request().method(), 'GET');
      const response = await route.fetch(); workflowsFetched(response.status());
      await released; await route.fulfill({ response });
    } catch (error) { workflowsFailed(error); await route.abort(); }
  });
  const workflowRequested = page.waitForRequest(request => request.url() === `${f.base}/api/workflows` && request.method() === 'GET');
  const loggedIn = page.waitForResponse(response => response.url() === `${f.base}/api/login` && response.request().method() === 'POST');
  try {
    await page.locator('#login-form [name=token]').fill(f.loginToken);
    await loginButton.click();
    const response = await loggedIn; assert.equal(response.status(), 200, await response.text());
    await workflowRequested; assert.equal(await fetched, 200, 'native login requests the real owned workflows before mounting the workbench');
    assert.equal(await page.locator('#login-form').isVisible(), true, 'incomplete graph hydration cannot mount a misleading empty canvas');
    assert.equal(await page.locator('#login-form button').isDisabled(), true, 'pending native authentication/hydration prevents duplicate submission');
    assert.equal(await page.locator('#app .shell').count(), 0);
  } finally { releaseWorkflows(); }
  await page.locator('#app .shell').waitFor();
  await page.locator('#workflow-canvas').waitFor();
  const channelButton = page.locator(`[data-action=channel][data-id="${f.channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click();
  await page.locator(`[data-action=episode][data-id="${f.episode.id}"]`).click();
  await page.locator('#workflow-canvas').waitFor();
  assert.equal(await page.locator('#wf-episode').inputValue(), f.episode.id, 'fast selection must not fall back to the latest-created episode');
  assert.notEqual(await page.locator('#wf-episode').inputValue(), f.otherEpisode.id);
  assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
  assert.equal(await page.locator('.wf-node').count(), f.workflow.nodes.length, 'the selected owned graph mounts on the first login without a reload');
  const rendered = await page.locator('.wf-node').evaluateAll(elements => elements.map(element => ({ id: element.dataset.nodeId, label: element.querySelector('.wf-node-label').textContent.trim() })));
  assert.deepEqual(rendered, f.workflow.nodes.map(node => ({ id: node.id, label: node.label })), 'first navigation renders target node identities and text, not an equal-size stale decoy canvas');
  const firstNode = f.workflow.nodes[0], incidentEdges = f.workflow.edges.filter(edge => edge.source === firstNode.id || edge.target === firstNode.id);
  const connectionButtons = await connections(page, firstNode.id);
  assert.deepEqual((await connectionButtons.evaluateAll(elements => elements.map(element => element.dataset.id))).sort(), incidentEdges.map(edge => edge.id).sort());
  for (const edge of incidentEdges) {
    const source = f.workflow.nodes.find(node => node.id === edge.source), target = f.workflow.nodes.find(node => node.id === edge.target);
    assert.equal(await page.locator(`#wf-connect-dialog [data-edge-id="${edge.id}"] > span`).innerText(), `${edge.target === firstNode.id ? '입력' : '출력'} · ${source.label} [${source.id}] → ${target.label} [${target.id}]`, 'rendered native connection endpoints belong to the target graph');
  }
  await page.keyboard.press('Escape');
  assert.deepEqual(f.writes.map(({ method, path }) => ({ method, path })), [{ method: 'POST', path: '/api/login' }, { method: 'POST', path: '/api/login' }], 'rejected and successful native login plus navigation cannot save, create or execute');
  assert.deepEqual((await f.api('/api/state')).episodes.find(episode => episode.id === f.episode.id), f.episode);
  assert.deepEqual((await f.api('/api/workflows')).find(workflow => workflow.id === f.workflow.id), f.workflow);
});

test('persisted node results survive fast nonlatest project remount and reject a delayed previous-owner history response', async t => {
  const f = await fixture(t, { persistedHistory: true }), { page } = f;
  // MenuImpl3 consolidated the node card to ONE visible status element: the precedence badge
  // now ALSO carries [data-status-node] and [data-testid="wf-node-badge"] (same element, no
  // separate legacy raw-status sibling). Its visible label follows the precedence rules
  // (contract 2.1: skipped(user) > running/queued > failed > stale >
  // awaiting_review/approved/completed (incl. retained output of unselected nodes) > idle),
  // NOT the raw nodeRun.status -- an unselected node with no output is '미실행' (idle), never
  // '건너뜀' (that used to be the bug: the old legacy span showed raw STATUS['skipped']
  // regardless of why a node was skipped). Its CSS class suffix is still the raw status (or
  // 'idle' with no record) for styling, independent of the precedence label text.
  const badgeProjection = () => page.locator('.wf-node [data-status-node]').evaluateAll(elements => elements.map(element => ({ nodeId: element.dataset.statusNode, label: element.textContent.trim(), visualClasses: [...element.classList].sort() })));
  // Independent precedence derivation straight from the fixture's own persisted nodeRun
  // records (never copied from the implementation's rendered output): this run has no
  // user-skip, no live/stale state and no retained output on the unselected nodes (first run
  // ever for this workflow), so it reduces to completed-family statuses -> their label, else idle.
  const PRECEDENCE_LABELS = { completed: '완료', succeeded: '완료', reused: '완료', awaiting_review: '검토 대기', approved: '승인됨' };
  const precedenceLabel = record => PRECEDENCE_LABELS[record?.status] || '미실행';
  const persistedBadgeProjection = f.workflow.nodes.map(node => {
    const record = f.run.nodeRuns.find(item => item.nodeId === node.id);
    return { nodeId: node.id, label: precedenceLabel(record), visualClasses: ['badge', 'wf-node-status', 'wf-state-badge', record?.status || 'idle'].sort() };
  });
  await page.goto(f.base); await page.locator('#app .shell').waitFor();
  const initialChannel = page.locator(`[data-action=channel]:not([data-id="${f.channel.id}"])`).first();
  const initialGroup = initialChannel.locator('xpath=ancestor::details[1]');
  if (!await initialGroup.evaluate(element => element.open)) await initialGroup.locator('summary').click();
  await initialChannel.click(); await page.locator('.shell').waitFor();
  await page.mouse.move(1000, 40); await page.keyboard.press('Escape');
  const holdHistory = async (workflow, run) => {
    let fetched, failed, release;
    const stored = new Promise((resolve, reject) => { fetched = resolve; failed = reject; });
    const released = new Promise(resolve => { release = resolve; });
    await f.context.route(`**/api/workflows/${workflow.id}/runs`, async route => {
      try {
        assert.equal(route.request().method(), 'GET');
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        assert.deepEqual((await response.json()).map(record => record.id), [run.id], 'barrier holds the real persisted exact-owner history, not invented run rows');
        fetched();
        await released; await route.fulfill({ response });
      } catch (error) { failed(error); await route.abort(); }
    });
    return { stored, release };
  };
  const oldHistory = await holdHistory(f.otherWorkflow, f.otherRun);
  const targetHistory = await holdHistory(f.workflow, f.run);
  try {
    const channelButton = page.locator(`[data-action=channel][data-id="${f.channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
    if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
    await page.mouse.move(1000, 40); await page.keyboard.press('Escape');
    await channelButton.click(); await oldHistory.stored;
    assert.equal(await page.locator('#wf-episode').inputValue(), f.otherEpisode.id, 'B is the later-created project before fast selection of A');
    await page.mouse.move(1000, 40); await page.keyboard.press('Escape');
    await page.locator(`[data-action=episode][data-id="${f.episode.id}"]`).click();
    await targetHistory.stored;
    await page.locator('#workflow-canvas').waitFor();
    assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
    assert.equal(await page.locator('#wf-episode').inputValue(), f.episode.id);
    const rendered = await page.locator('.wf-node').evaluateAll(elements => elements.map(element => ({ id: element.dataset.nodeId, label: element.querySelector('.wf-node-label').textContent.trim() })));
    assert.deepEqual(rendered, f.workflow.nodes.map(node => ({ id: node.id, label: node.label })), 'remount must bind A content even though B uses the same node IDs and types');
    assert.equal(await node(page, 'a').locator('[data-status-node]').isVisible(), true);
    assert.deepEqual(await badgeProjection(), f.workflow.nodes.map(node => ({ nodeId: node.id, label: '미실행', visualClasses: ['badge', 'idle', 'wf-node-status', 'wf-state-badge'].sort() })), 'while the real owner history is held, no badge may claim another project’s persisted execution status');
    await header(page, 'a').focus(); await page.keyboard.press('ArrowRight');
    const draftLeft = `${f.workflow.nodes[0].x + 10}px`;
    assert.equal(await node(page, 'a').evaluate(element => element.style.left), draftLeft);
    await header(page, 'a').click(); await focusedButton(page, 'node-results').click();
    const dialog = page.locator('#wf-results-dialog[open]');
    await dialog.waitFor();
    const targetCompleted = page.waitForResponse(response => response.url() === `${f.base}/api/workflows/${f.workflow.id}/runs` && response.request().method() === 'GET');
    targetHistory.release();
    assert.equal(await (await targetCompleted).finished(), null, 'A history completes only after its new canvas is mounted');
    await dialog.locator(`#wf-results-run option[value="${f.run.id}"]`).waitFor({ state: 'attached' });
    const assertTargetResults = async () => {
      assert.deepEqual(await dialog.locator('#wf-results-run option').evaluateAll(options => options.map(option => option.value)), [f.run.id], 'saved A execution must be selectable without an active run, polling, reload or manual run selection');
      assert.equal(await dialog.locator('#wf-results-run').inputValue(), f.run.id);
      assert.deepEqual(await dialog.locator('[data-testid="node-result-facts"] strong').allTextContents(), ['1', 'Persisted project A evidence'], 'rendered node output must come from A persisted HTTP execution, never the same-ID B node');
      assert.equal((await dialog.innerText()).includes('Persisted project B evidence'), false);
      assert.equal(await node(page, 'a').locator('[data-status-node]').isVisible(), true);
      assert.deepEqual(await badgeProjection(), persistedBadgeProjection, 'hydrating the selected real run must update both readable status labels and visual status classes; stale owner history cannot overwrite either');
      assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
      assert.equal(await page.locator('#wf-episode').inputValue(), f.episode.id);
      assert.equal(await node(page, 'a').evaluate(element => element.style.left), draftLeft, 'read completion cannot discard the current owner graph draft');
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'late owner history cannot dismiss the result dialog or steal its focus');
    };
    await dialog.locator('[data-testid="node-result-facts"] strong').getByText('Persisted project A evidence', { exact: true }).waitFor();
    await assertTargetResults();
    const oldCompleted = page.waitForResponse(response => response.url() === `${f.base}/api/workflows/${f.otherWorkflow.id}/runs` && response.request().method() === 'GET');
    oldHistory.release();
    assert.equal(await (await oldCompleted).finished(), null, 'stale B history is delivered successfully after A results are usable');
    await assertTargetResults();
    assert.deepEqual(f.writes, [], 'opening saved results and racing project reads cannot save, execute, generate, render, upload or publish');
    assert.deepEqual(f.trendQueries, ['Persisted project A evidence', 'Persisted project B evidence'], 'UI navigation cannot collect trends after the explicit setup executions');
    const state = await f.api('/api/state'), workflows = await f.api('/api/workflows');
    for (const owner of [f.episode, f.otherEpisode]) assert.deepEqual(state.episodes.find(episode => episode.id === owner.id), owner, 'both project versions and independent saved scene content remain unchanged');
    for (const graph of [f.workflow, f.otherWorkflow]) assert.deepEqual(workflows.find(workflow => workflow.id === graph.id), graph, 'both owned graphs retain their exact saved versions and content');
    assert.deepEqual(await f.api(`/api/workflow-runs/${f.run.id}`), f.run);
    assert.deepEqual(await f.api(`/api/workflow-runs/${f.otherRun.id}`), f.otherRun);
  } finally { targetHistory.release(); oldHistory.release(); }
});

test('native connections disable template mutations before display and retain a rejected cycle form without writes', async t => {
  const f = await fixture(t), { page } = f;
  const template = (await f.api('/api/workflows')).find(graph => graph.id === f.workflow.templateId);
  await page.locator('#wf-select').selectOption(template.id);
  await page.waitForFunction(id => document.querySelector('#wf-select')?.value === id && document.querySelector('[data-wf-action="create-project-copy"]')?.disabled === false, template.id);
  const readonlyEdges = await connections(page, 'a');
  const dialog = page.locator('#wf-connect-dialog');
  assert.deepEqual((await readonlyEdges.evaluateAll(elements => elements.map(element => element.dataset.id))).sort(), ['ab', 'ac']);
  assert.equal(await dialog.locator('button[type=submit]').isDisabled(), true, 'native template connection form cannot offer a writable submit when first shown');
  assert.equal(await readonlyEdges.evaluateAll(elements => elements.every(element => element.disabled)), true, 'every displayed template edge is protected from unlink');
  assert.equal(await dialog.evaluate(element => element.open && element.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await page.locator('#wf-select').selectOption(f.workflow.id);
  await page.waitForFunction(id => document.querySelector('#wf-select')?.value === id && document.querySelector('[data-wf-action="create-project-copy"]')?.disabled === true, f.workflow.id);
  const ownedEdges = await connections(page, 'b');
  await dialog.locator('#wf-connect-source').selectOption('c');
  await dialog.locator('#wf-connect-target').selectOption('a');
  await dialog.locator('button[type=submit]').click();
  await page.getByText('순환 연결은 실행할 수 없습니다.', { exact: true }).waitFor();
  assert.equal(await dialog.evaluate(element => element.open && element.contains(document.activeElement)), true, 'rejected connection keeps the current native form and keyboard owner');
  assert.equal(await dialog.locator('#wf-connect-source').inputValue(), 'c');
  assert.equal(await dialog.locator('#wf-connect-target').inputValue(), 'a');
  assert.deepEqual((await ownedEdges.evaluateAll(elements => elements.map(element => element.dataset.id))).sort(), ['ab', 'bc'], 'rejected cycle does not alter the node incident edges');
  assert.deepEqual(f.writes, [], 'preview inspection and rejected native connection cannot save or execute');
  const graphs = await f.api('/api/workflows');
  assert.deepEqual(graphs.find(graph => graph.id === template.id), template);
  assert.deepEqual(graphs.find(graph => graph.id === f.workflow.id), f.workflow);
});

test('maximum owned graph opens all 127 pinned hub connections and preserves unlink drafts through native repaint, reopen and Save', async t => {
  const f = await fixture(t, { maximumConnections: true }), { page } = f;
  const template = (await f.api('/api/workflows')).find(graph => graph.id === f.workflow.templateId);
  await page.waitForFunction(({ id, episodeId, version }) => {
    const status = document.querySelector('#wf-save-status'), history = document.querySelector(`#wf-history [data-wf-action="history-version"][data-version="${version}"]`);
    return document.querySelector('#wf-select')?.value === id && document.querySelector('#wf-episode')?.value === episodeId && status?.textContent?.trim() === `✓ 버전 ${version} · 저장됨` && history?.isConnected === true;
  }, { id: f.workflow.id, episodeId: f.episode.id, version: f.workflow.version });
  const canvasHint = page.locator('#wf-connect-hint'), cancelledHint = '연결 선택 취소됨 · 출력 → 입력으로 다시 연결하세요.';
  assert.equal(await canvasHint.isVisible(), true);
  const canonicalFitHint = await canvasHint.innerText();
  assert.notEqual(canonicalFitHint, cancelledHint, 'the fitted current canvas exposes its mode hint before native cancellation');
  assert.deepEqual(await page.locator('.wf-node').evaluateAll(elements => elements.map(element => ({ id: element.dataset.nodeId, label: element.querySelector('.wf-node-label').textContent.trim() }))), f.workflow.nodes.map(node => ({ id: node.id, label: node.label })), 'the default owned canvas exposes every exact node before native connection inspection');
  assert.equal(await page.locator('#wf-edges path').count(), 256);
  const hub = f.workflow.nodes[0], incident = f.workflow.edges.filter(edge => edge.source === hub.id || edge.target === hub.id), unrelated = f.workflow.edges.filter(edge => edge.source !== hub.id && edge.target !== hub.id);
  assert.equal(incident.length, 127); assert.equal(unrelated.length, 129);
  await header(page, hub.id).click(); await focusedButton(page, 'connections').click();
  const dialog = page.locator('#wf-connect-dialog'), edgeButtons = dialog.locator('.wf-connection-list [data-wf-action=delete-edge]');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('#wf-connect-title').innerText(), `${hub.label} · 입력·출력 연결`);
  assert.deepEqual((await edgeButtons.evaluateAll(elements => elements.map(element => element.dataset.id))).sort(), incident.map(edge => edge.id).sort(), 'all 127 real incident edge identities are available through the native dialog without truncation');
  assert.equal(await dialog.evaluate(element => element.open && element.contains(document.activeElement)), true);
  const removed = incident.at(-1), target = f.workflow.nodes.find(node => node.id === removed.target), remainingIncident = incident.filter(edge => edge.id !== removed.id), expectedEdges = f.workflow.edges.filter(edge => edge.id !== removed.id);
  assert.equal(await dialog.locator(`[data-edge-id="${removed.id}"] > span`).innerText(), `출력 · ${hub.label} [${hub.id}] → ${target.label} [${target.id}]`);
  await dialog.locator(`[data-wf-action=delete-edge][data-id="${removed.id}"]`).click();
  await page.waitForFunction(id => {
    const current = document.querySelector('#wf-connect-dialog');
    return current?.open === true && current.contains(document.activeElement) && current.querySelectorAll('.wf-connection-list [data-wf-action="delete-edge"]').length === 126 && document.querySelector('.wf-node.selected')?.dataset.nodeId === id;
  }, hub.id);
  assert.deepEqual((await edgeButtons.evaluateAll(elements => elements.map(element => element.dataset.id))).sort(), remainingIncident.map(edge => edge.id).sort(), 'the reopened native dialog reflects the exact unlink after graph repaint');
  assert.equal(await page.locator('#wf-edges path').count(), 255, 'the visible graph loses exactly one edge');
  assert.equal(await page.locator('#wf-save-status').getAttribute('class'), 'unsaved');
  assert.deepEqual(f.writes, [], 'opening and unlinking remain local draft operations');
  assert.deepEqual((await f.api('/api/workflows')).find(graph => graph.id === f.workflow.id), f.workflow, 'the server still owns the exact saved 256-edge graph before explicit Save');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#wf-connect-dialog')?.open && document.querySelector('#wf-focused-node [data-wf-action="connections"]') === document.activeElement);
  await page.mouse.move(1000, 40); await page.keyboard.press('Escape');
  assert.equal(await canvasHint.isVisible(), true);
  assert.equal(await canvasHint.innerText(), cancelledHint, 'native Escape closes connections and exposes its cancellation hint');
  await page.locator('[data-wf-action=fit]').click();
  assert.equal(await canvasHint.innerText(), canonicalFitHint, 'native Fit restores the visible mode hint after Escape even when the layout mode does not change');
  await header(page, hub.id).click(); await focusedButton(page, 'connections').click();
  await dialog.waitFor({ state: 'visible' });
  assert.deepEqual((await edgeButtons.evaluateAll(elements => elements.map(element => element.dataset.id))).sort(), remainingIncident.map(edge => edge.id).sort(), 'closing and reopening retains every exact remaining draft incident');
  assert.equal(await dialog.locator('#wf-connect-title').innerText(), `${hub.label} · 입력·출력 연결`);
  assert.equal(await dialog.evaluate(element => element.open && element.contains(document.activeElement)), true);
  assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
  assert.equal(await page.locator('#wf-episode').inputValue(), f.episode.id);
  await dialog.locator('[data-wf-action=close-overlay]').first().click();
  await page.waitForFunction(() => !document.querySelector('#wf-connect-dialog')?.open && document.querySelector('#wf-focused-node [data-wf-action="connections"]') === document.activeElement);
  const response = await saveGraph(f), request = response.request().postDataJSON();
  assert.deepEqual(request.edges, expectedEdges, 'explicit Save submits exactly the intended 255-edge draft with all unrelated connections unchanged');
  assert.deepEqual(request.nodes, f.workflow.nodes);
  const saved = (await f.api('/api/workflows')).find(graph => graph.id === f.workflow.id);
  assert.equal(saved.version, f.workflow.version + 1);
  assert.deepEqual(saved.edges, expectedEdges);
  assert.deepEqual(saved.edges.filter(edge => edge.source !== hub.id && edge.target !== hub.id), unrelated, 'all 129 nonincident connections survive unlink and Save');
  assert.deepEqual(saved.nodes, f.workflow.nodes);
  assert.deepEqual((await f.api('/api/workflows')).find(graph => graph.id === template.id), template, 'project unlink never edits its shared source template');
  await page.waitForFunction(({ id, version }) => document.querySelector('#wf-select')?.value === id && document.querySelector('#wf-save-status')?.textContent?.trim() === `✓ 버전 ${version} · 저장됨` && document.querySelector(`#wf-history [data-wf-action="history-version"][data-version="${version}"]`)?.isConnected === true, { id: saved.id, version: saved.version });
  assert.deepEqual(f.writes.map(({ method, path }) => ({ method, path })), [{ method: 'PUT', path: `/api/workflows/${f.workflow.id}` }]);
  assert.deepEqual((await f.api('/api/state')).episodes.find(episode => episode.id === f.episode.id), f.episode);
});

test('undoing an added pinned node keeps the native connection fallback on the current graph without writes', async t => {
  const f = await fixture(t), { page } = f;
  await page.locator('[data-wf-action=open-add-node]').click();
  await page.locator('#wf-add-node-dialog #wf-add-type').selectOption('trend');
  await page.locator('#wf-add-node-dialog #wf-add-label').fill('Transient pinned node');
  await page.locator('#wf-add-node-dialog [data-wf-action=add-node]').click();
  await page.locator('#wf-tools-dialog[open]').waitFor();
  const addedId = await page.locator('.wf-node.selected').getAttribute('data-node-id');
  assert.equal(f.workflow.nodes.some(node => node.id === addedId), false, 'the native add action selected a genuinely new draft node');
  assert.equal(await node(page, addedId).locator('.wf-node-label').innerText(), 'Transient pinned node');
  await page.keyboard.press('Escape');
  await header(page, addedId).click(); await focusedButton(page, 'connections').click();
  const dialog = page.locator('#wf-connect-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.locator('#wf-connect-title').innerText(), 'Transient pinned node · 입력·출력 연결');
  const closeButton = dialog.getByRole('button', { name: '노드 연결 닫기', exact: true });
  await closeButton.focus();
  assert.equal(await closeButton.evaluate(element => element === document.activeElement), true, 'graph Undo is invoked from a button rather than native text editing');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await page.waitForFunction(id => {
    const current = document.querySelector('#wf-connect-dialog');
    return !document.querySelector(`.wf-node[data-node-id="${id}"]`) && current?.open === true && current.contains(document.activeElement);
  }, addedId);
  assert.deepEqual(await page.locator('.wf-node').evaluateAll(elements => elements.map(element => element.dataset.nodeId)), f.workflow.nodes.map(node => node.id));
  assert.equal(await page.locator('#wf-edges path').count(), f.workflow.edges.length);
  assert.equal(await dialog.locator('#wf-connect-title').innerText(), '노드 연결 편집');
  assert.deepEqual((await dialog.locator('.wf-connection-list [data-wf-action=delete-edge]').evaluateAll(elements => elements.map(element => element.dataset.id))).sort(), f.workflow.edges.map(edge => edge.id).sort(), 'visible fallback exposes every original connection after Undo removes its pinned node');
  const labels = new Map(f.workflow.nodes.map(node => [node.id, node.label]));
  assert.deepEqual(await dialog.locator('.wf-connection-list [data-edge-id] > span').allTextContents(), f.workflow.edges.map(edge => `${labels.get(edge.source)} [${edge.source}] → ${labels.get(edge.target)} [${edge.target}]`), 'generic fallback endpoints belong to the unchanged current graph, not the removed node');
  for (const select of ['#wf-connect-source', '#wf-connect-target']) assert.deepEqual(await dialog.locator(`${select} option`).evaluateAll(options => options.map(option => option.value).filter(Boolean)), f.workflow.nodes.map(node => node.id), 'the current native form cannot target the removed node');
  assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
  assert.equal(await page.locator('#wf-episode').inputValue(), f.episode.id);
  assert.deepEqual(f.writes, [], 'adding, inspecting and undoing a draft node cannot write, execute or publish');
  assert.deepEqual((await f.api('/api/workflows')).find(graph => graph.id === f.workflow.id), f.workflow, 'native Undo fallback leaves the saved graph and version unchanged');
  assert.deepEqual((await f.api('/api/state')).episodes.find(episode => episode.id === f.episode.id), f.episode);
});

test('visible node tooltips cannot intercept native pointer activation of the focused-panel connections control', async t => {
  const f = await fixture(t, { maximumConnections: true }), { page } = f;
  const target = f.workflow.nodes[0], trigger = header(page, target.id);
  assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
  assert.equal(await page.locator('#wf-episode').inputValue(), f.episode.id);
  await trigger.hover(); await trigger.focus();
  const visibleHints = page.locator('.ff-info-tooltip[role=tooltip]:visible');
  await visibleHints.first().waitFor();
  const descriptions = await visibleHints.evaluateAll(elements => elements.map(element => ({ id: element.id, text: element.textContent })));
  const describedBy = (await trigger.getAttribute('aria-describedby') || '').split(/\s+/);
  for (const description of descriptions) {
    assert.ok(description.text.includes(f.workflow.nodes.at(-1).label), 'the actual visible node tooltip describes its real outgoing connections');
    assert.ok(describedBy.includes(description.id), 'every visible explanation is linked to the real hovered and focused node');
  }
  await focusedButton(page, 'connections').click();
  const dialog = page.getByRole('dialog', { name: `${target.label} · 입력·출력 연결`, exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.evaluate(element => element.open && element.contains(document.activeElement)), true, 'pointer activation opens the correctly labelled native dialog with keyboard focus');
  assert.equal(await page.locator('.wf-node.selected').getAttribute('data-node-id'), target.id);
  assert.deepEqual((await dialog.locator('.wf-connection-list [data-wf-action=delete-edge]').evaluateAll(elements => elements.map(element => element.dataset.id))).sort(), f.workflow.edges.filter(edge => edge.source === target.id || edge.target === target.id).map(edge => edge.id).sort(), 'the pointer-opened connections belong to the exact hovered node');
  assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
  assert.equal(await page.locator('#wf-episode').inputValue(), f.episode.id);
  assert.deepEqual(f.writes, [], 'hover, focus, opening and pointer activation cannot save, execute, generate or publish');
  assert.deepEqual((await f.api('/api/workflows')).find(graph => graph.id === f.workflow.id), f.workflow);
  assert.deepEqual((await f.api('/api/state')).episodes.find(episode => episode.id === f.episode.id), f.episode);
});

test('sidebar pointer, keyboard and click resizing changes visible width and survives reload without server writes', async t => {
  const f = await fixture(t), { page } = f;
  const sidebar = page.locator('.shell > .sidebar');
  const handle = page.getByRole('separator', { name: '사이드바 너비 조절' });
  const width = async () => (await sidebar.boundingBox()).width;
  const initial = await width(), box = await handle.boundingBox();
  assert.ok(box, 'the resize handle is visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2); await page.mouse.up();
  const dragged = await width();
  assert.ok(dragged > initial + 20, `pointer drag expands sidebar: ${initial} → ${dragged}`);
  await handle.focus(); await page.keyboard.press('ArrowLeft');
  const keyboard = await width();
  assert.ok(keyboard < dragged, `ArrowLeft narrows sidebar: ${dragged} → ${keyboard}`);
  await page.getByRole('button', { name: '사이드바 넓게', exact: true }).click();
  const clicked = await width();
  assert.ok(clicked > keyboard, `single click expands sidebar: ${keyboard} → ${clicked}`);
  await page.getByRole('button', { name: '사이드바 좁게', exact: true }).click();
  const saved = await width();
  assert.ok(saved < clicked, `single click narrows sidebar: ${clicked} → ${saved}`);
  await page.reload(); await page.locator('#app .shell').waitFor();
  assert.ok(Math.abs(await width() - saved) < 1, 'the browser restores the chosen width after reload');
  assert.deepEqual(f.writes, [], 'resizing and reload never save, execute or publish');
});

test('portrait sidebar resizing keeps the document and focused controls inside the viewport', async t => {
  const f = await fixture(t, { touch: true }), { page } = f;
  const wider = page.getByRole('button', { name: '사이드바 넓게', exact: true });
  await wider.tap();
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(geometry.document <= geometry.viewport + 1 && geometry.body <= geometry.viewport + 1, `no horizontal document overflow after resizing: ${JSON.stringify(geometry)}`);
  await wider.scrollIntoViewIfNeeded(); await withinViewport(wider);
  const stage = page.locator('#project-stage');
  await stage.scrollIntoViewIfNeeded(); await withinViewport(stage);
  assert.deepEqual(f.writes, [], 'mobile resizing never writes');
});

test('focused node actions show the selected node results and preserve a draft across navigation without writes', async t => {
  const f = await fixture(t, { persistedHistory: true }), { page } = f;
  await page.goto(f.base); await page.locator('#app .shell').waitFor();
  const channel = page.locator(`[data-action=channel][data-id="${f.channel.id}"]`), group = channel.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channel.click();
  await page.locator(`[data-action=episode][data-id="${f.episode.id}"]`).click();
  await page.locator('#workflow-canvas').waitFor();
  assert.equal(await page.locator('#wf-select').inputValue(), f.workflow.id);
  const focus = page.getByRole('region', { name: '선택한 노드' });
  await page.locator('#project-stage').selectOption('b');
  await focus.getByText('Node B', { exact: false }).waitFor();
  await focus.locator('[data-wf-action=node-tools]').click();
  const tools = page.locator('#wf-tools-dialog[open]'); await tools.waitFor();
  assert.equal(await tools.locator('[data-wf-field=label]').inputValue(), 'Node B');
  await tools.locator('[data-wf-field=label]').fill('Unsaved B focus draft');
  await page.keyboard.press('Escape');
  await page.locator('#project-stage').selectOption('a');
  await focus.locator('[data-wf-action=node-results]').click();
  const results = page.locator('#wf-results-dialog[open]'); await results.waitFor();
  await results.locator(`#wf-results-run option[value="${f.run.id}"]`).waitFor({ state: 'attached' });
  await results.locator('[data-testid="node-result-facts"] strong').filter({ hasText: /^Persisted project A evidence$/ }).waitFor();
  assert.deepEqual(await results.locator('[data-testid="node-result-facts"] strong').allTextContents(), ['1', 'Persisted project A evidence']);
  assert.equal((await results.innerText()).includes('Persisted project B evidence'), false);
  await page.keyboard.press('Escape');
  await page.locator('#project-stage').selectOption('b');
  await focus.locator('[data-wf-action=node-tools]').click(); await tools.waitFor();
  assert.equal(await tools.locator('[data-wf-field=label]').inputValue(), 'Unsaved B focus draft', 'changing focus does not discard another node draft');
  await page.keyboard.press('Escape');
  await focus.locator('[data-wf-action=node-results]').click(); await results.waitFor();
  assert.equal((await results.locator('#wf-overlay-result-inspector').innerText()).includes('Persisted project A evidence'), false, 'skipped B cannot show A output');
  assert.deepEqual(f.writes, [], 'selection, editing drafts and inspecting results never write');
  assert.deepEqual((await f.api('/api/workflows')).find(graph => graph.id === f.workflow.id), f.workflow);
  assert.deepEqual(await f.api(`/api/workflow-runs/${f.run.id}`), f.run);
});
