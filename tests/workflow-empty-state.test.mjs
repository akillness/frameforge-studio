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

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-workflow-empty-'));
  const forbidden = async () => { assert.fail('Empty-state editing must never invoke an external producer'); };
  let app, browser, context;
  const writes = [], external = [], errors = [];
  t.after(async () => {
    try {
      await context?.close();
      await browser?.close();
    } finally {
      if (app?.listening) await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
      await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    assert.deepEqual(external, [], 'all browser traffic stays on the fixture origin');
    assert.deepEqual(errors, [], 'cold mounting and graph switching cannot throw page errors');
    assert.equal(writes.some(write => /\/(run|quote|generations|publication)(\/|$)/.test(write.path)), false, 'editing never generates, executes, or publishes');
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
  return { page, context, base, api, writes };
}

async function project(f, name) {
  const channel = await f.api('/api/channels', 'POST', { name: `${name} channel`, platform: 'youtube', category: 'information' });
  const episode = await f.api('/api/episodes', 'POST', { channelId: channel.id, title: `${name} project`, topic: 'Local graph editing only' });
  return { channel, episode };
}

async function mountEditor(f, { episodes = [], binding = null, workflows = [] } = {}) {
  // Only the listing boundary is controlled: an empty account must be exercisable
  // even when createApp seeds shared templates. All saves/history use the real API.
  await f.context.route('**/api/workflows', route => route.request().method() === 'GET'
    ? route.fulfill({ json: workflows }) : route.fallback());
  await f.context.route('**/__workflow-empty-test', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/workflow.css"></head><body><main id="test-root"><div id="workflow-host"></div></main></body></html>',
  }));
  await f.page.goto(`${f.base}/__workflow-empty-test`);
  await f.page.evaluate(async ({ episodes, binding }) => {
    const { createWorkflowEditor } = await import('/workflow.js');
    window.editorToasts = [];
    window.editor = createWorkflowEditor({
      api: async (path, options = {}) => {
        const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        return result;
      },
      getEpisodes: () => episodes,
      toast: (message, error) => { if (error) window.editorToasts.push(message); },
    });
    if (binding) window.editor.bindProject(binding);
    window.editor.mount();
  }, { episodes, binding });
}

async function assertEmpty(page) {
  await page.getByRole('heading', { name: '실행 가능한 제작 흐름을 만드세요', exact: true }).waitFor();
  assert.match(await page.locator('#workflow-host .empty').innerText(), /새 워크플로우.*노드를 연결하고/s, 'the empty state explains how to create the first graph');
  assert.equal(await page.locator('[data-wf-action=new]').isEnabled(), true, 'explicit first creation is available');
  assert.equal(await page.locator('[data-wf-action=save]').isDisabled(), true, 'there is no graph to save yet');
  assert.equal(await page.locator('#workflow-canvas').count(), 0, 'empty mounting cannot fabricate a graph');
  assert.equal(await page.locator('#wf-add-node-dialog,#wf-connect-dialog,#wf-connect-dialog-form,#wf-connect-form').count(), 0, 'graphless mounting cannot construct node or connection forms');
  assert.equal(await page.evaluate(() => window.editor.hasChanges()), false, 'mounting does not create an unsaved draft');
  assert.deepEqual(await page.evaluate(() => window.editorToasts), []);
}

async function assertBoundEmpty(page, owner) {
  await page.getByRole('heading', { name: '프로젝트 워크플로우를 선택하세요', exact: true }).waitFor();
  const message = await page.locator('#workflow-host .empty').innerText();
  for (const instruction of [/공용 템플릿을 선택한 뒤 프로젝트용 복사본 만들기/, /목록이 비어 있으면 새로고침/, /템플릿을 명시적으로 등록/, /복사본을 만들기 전에는 새 구성·편집·저장을 할 수 없/]) assert.match(message, instruction);
  for (const action of ['new', 'preset-full-pipeline', 'save', 'create-project-copy', 'run']) assert.equal(await page.locator(`[data-wf-action="${action}"]`).isDisabled(), true, `${action} requires an explicitly copied project graph`);
  assert.equal(await page.locator('[data-wf-action=reload]').isEnabled(), true, 'an empty project can refresh the template list without creating anything');
  assert.equal(await page.locator('#wf-episode').inputValue(), owner.episode.id);
  assert.equal(await page.locator('#wf-episode').isDisabled(), true, 'empty state cannot change its project owner');
  assert.equal(await page.locator('#workflow-canvas,#wf-add-node-dialog,#wf-connect-dialog,#wf-connect-dialog-form,#wf-connect-form').count(), 0, 'a null graph has no canvas or native node/connection dialogs');
  const context = await page.evaluate(() => window.editor.getContext());
  assert.equal(context.episodeId, owner.episode.id);
  assert.equal(context.channelId, owner.channel.id);
  assert.equal(context.workflowId, null, 'empty state cannot invent an owned graph');
  assert.equal(await page.evaluate(() => window.editor.hasChanges()), false);
  assert.deepEqual(await page.evaluate(() => window.editorToasts), []);
}

async function loadAndRemount(page) {
  await page.evaluate(async () => {
    await window.editor.load();
    window.editor.destroy();
    document.querySelector('#test-root').innerHTML = window.editor.html();
    window.editor.mount();
  });
}

async function renameDraft(page, name) {
  await page.locator('[data-wf-action=open-workflow-settings]').click();
  await page.locator('#wf-workflow-dialog[open] #wf-workflow-name').fill(name);
  await page.keyboard.press('Escape');
}

async function canvas(page) {
  return page.locator('#workflow-canvas .wf-node').evaluateAll(nodes => nodes.map(node => ({
    id: node.dataset.nodeId,
    label: node.querySelector('.wf-node-label').textContent,
    x: Number.parseFloat(node.style.left), y: Number.parseFloat(node.style.top),
    connections: node.querySelector('.wf-mobile-links').textContent,
  })));
}

async function assertCanvas(page, graph) {
  const actual = await canvas(page), labels = new Map(actual.map(node => [node.id, node.label]));
  assert.deepEqual(actual.map(({ id, x, y }) => ({ id, x, y })), graph.nodes.map(({ id, x, y }) => ({ id, x, y })), 'the real canvas has exactly this graph, not a template or another project');
  for (const node of graph.nodes) {
    const rendered = actual.find(item => item.id === node.id);
    if (node.label) assert.equal(rendered.label, node.label);
    const incoming = graph.edges.filter(edge => edge.target === node.id).map(edge => labels.get(edge.source)).join(', ') || '없음';
    const outgoing = graph.edges.filter(edge => edge.source === node.id).map(edge => labels.get(edge.target)).join(', ') || '없음';
    assert.equal(rendered.connections, `입력: ${incoming} · 출력: ${outgoing}`, `canvas connections belong to ${node.id}`);
  }
  assert.equal(await page.locator('#wf-edges path').count(), graph.edges.length, 'every actual canvas edge is rendered');
  assert.deepEqual(await page.locator('#wf-connect-dialog .wf-connection-list [data-edge-id]').evaluateAll(edges => edges.map(edge => ({ id: edge.dataset.edgeId, text: edge.querySelector('span').textContent }))), graph.edges.map(edge => ({
    id: edge.id,
    text: `${labels.get(edge.source)} [${edge.source}] → ${labels.get(edge.target)} [${edge.target}]`,
  })), 'the native connection editor renders the exact edge IDs and endpoints');
}

async function saveDraft(f, previous = null) {
  const path = previous ? `/api/workflows/${previous.id}` : '/api/workflows', method = previous ? 'PUT' : 'POST';
  const responsePromise = f.page.waitForResponse(response => response.url() === f.base + path && response.request().method() === method);
  await f.page.locator('[data-wf-action=save]').click();
  const response = await responsePromise;
  assert.equal(response.status(), previous ? 200 : 201, await response.text());
  const saved = await response.json();
  await f.page.waitForFunction(({ id, version }) => document.querySelector('#wf-select')?.value === id && document.querySelector('#wf-save-status')?.textContent.includes(`버전 ${version}`), saved);
  assert.equal(await f.page.locator('[data-wf-action=save]').isDisabled(), true, 'successful explicit Save clears the dirty draft');
  if (previous) assert.equal(response.request().postDataJSON().expectedVersion, previous.version);
  return { saved, body: response.request().postDataJSON() };
}

async function selectTemplate(page, template) {
  await page.locator('#wf-select').selectOption(template.id);
  await page.waitForFunction(({ id, version, nodeIds }) => document.querySelector('#wf-select')?.value === id && document.querySelector('#wf-save-status')?.textContent.includes(`버전 ${version}`) && JSON.stringify([...document.querySelectorAll('#workflow-canvas .wf-node')].map(node => node.dataset.nodeId)) === JSON.stringify(nodeIds), { id: template.id, version: template.version, nodeIds: template.nodes.map(node => node.id) });
  await assertCanvas(page, template);
  for (const action of ['new', 'preset-full-pipeline', 'save']) assert.equal(await page.locator(`[data-wf-action="${action}"]`).isDisabled(), true, `${action} remains disabled while previewing a shared template`);
  assert.equal(await page.locator('[data-wf-action=create-project-copy]').isEnabled(), true);
  assert.equal(await page.evaluate(() => window.editor.hasChanges()), false, 'selecting a template is read-only');
}

async function copyTemplate(f, template, owner) {
  const path = `/api/workflows/${template.id}/copies`;
  const responsePromise = f.page.waitForResponse(response => response.url() === f.base + path && response.request().method() === 'POST');
  await f.page.locator('[data-wf-action=create-project-copy]').click();
  const response = await responsePromise;
  assert.equal(response.status(), 201, await response.text());
  assert.deepEqual(response.request().postDataJSON(), { episodeId: owner.episode.id, channelId: owner.channel.id, expectedTemplateVersion: template.version }, 'only explicit copy approval sends the exact template version and project owner');
  const saved = await response.json();
  await f.page.waitForFunction(id => window.editor.getContext().workflowId === id && document.querySelector('#wf-select')?.value === id && document.querySelector('[data-wf-action=create-project-copy]')?.disabled, saved.id);
  assert.notEqual(saved.id, template.id, 'copying creates an independent persistent identity');
  assert.equal(saved.episodeId, owner.episode.id);
  assert.equal(saved.channelId, owner.channel.id);
  assert.equal(saved.templateId, template.id);
  assert.equal(saved.templateVersion, template.version);
  assert.deepEqual(saved.nodes, template.nodes);
  assert.deepEqual(saved.edges, template.edges);
  assert.deepEqual((await f.api('/api/workflows')).find(item => item.id === saved.id), saved);
  assert.equal(await f.page.locator('[data-wf-action=new]').isEnabled(), true);
  assert.equal(await f.page.locator('[data-wf-action=save]').isDisabled(), true, 'a newly copied graph has no unsaved edits');
  await assertCanvas(f.page, saved);
  return saved;
}

async function assertHistory(f, snapshots) {
  const history = await f.api(`/api/workflows/${snapshots[0].id}/history`);
  assert.deepEqual(history.map(entry => entry.version), snapshots.map(snapshot => snapshot.version).reverse(), 'only explicit copy and Saves append workflow history');
  for (const snapshot of snapshots) {
    const entry = history.find(item => item.version === snapshot.version);
    assert.equal(entry.workflowId, snapshot.id);
    assert.deepEqual(entry.snapshot, snapshot, 'history preserves the full graph, version, provenance and exact owner');
  }
}

test('cold unbound editor mounts before and after an empty load without writes, and first New persists only on Save', async t => {
  const f = await fixture(t), before = await f.api('/api/workflows');
  await mountEditor(f);
  await assertEmpty(f.page);
  await loadAndRemount(f.page);
  await assertEmpty(f.page);
  assert.deepEqual(f.writes, [], 'mount, load and remount never create a workflow');
  await f.page.locator('[data-wf-action=new]').click();
  await f.page.locator('#workflow-canvas').waitFor();
  await renameDraft(f.page, 'Explicit unbound first flow');
  const draftCanvas = await canvas(f.page);
  assert.equal(await f.page.evaluate(() => window.editor.hasChanges()), true);
  assert.deepEqual(f.writes, [], 'New and editing create only a local draft');
  assert.deepEqual(await f.api('/api/workflows'), before, 'no hidden create or autosave reaches persistence');
  const { saved, body } = await saveDraft(f);
  assert.equal(saved.name, 'Explicit unbound first flow');
  assert.equal(body.episodeId, undefined, 'unbound creation must not invent an episode owner');
  assert.equal(body.channelId, undefined, 'unbound creation must not invent a channel owner');
  assert.deepEqual(saved.nodes.map(({ id, x, y }) => ({ id, x, y })), draftCanvas.map(({ id, x, y }) => ({ id, x, y })));
  await assertCanvas(f.page, saved);
  const persisted = await f.api('/api/workflows');
  assert.deepEqual(persisted.find(item => item.id === saved.id), saved);
  for (const template of before) assert.deepEqual(persisted.find(item => item.id === template.id), template);
  assert.deepEqual(f.writes.map(({ method, path }) => ({ method, path })), [{ method: 'POST', path: '/api/workflows' }]);
});

test('cold bound projects require an explicit shared-template copy before isolated drafts can be saved with owned versions', async t => {
  const f = await fixture(t), a = await project(f, 'First owner'), b = await project(f, 'Other owner');
  const binding = owner => ({ episodeId: owner.episode.id, channelId: owner.channel.id });
  const available = [], initiallyPersisted = await f.api('/api/workflows');
  await mountEditor(f, { episodes: [a.episode, b.episode], binding: binding(a), workflows: available });
  await assertBoundEmpty(f.page, a);
  await loadAndRemount(f.page);
  await assertBoundEmpty(f.page, a);
  await f.page.locator('[data-wf-action=reload]').click();
  await f.page.waitForFunction(() => !document.querySelector('[data-wf-action=reload]')?.disabled);
  await assertBoundEmpty(f.page, a);
  assert.deepEqual(f.writes, [], 'cold mount, empty load, remount and refresh never write a template or owned graph');
  assert.deepEqual(await f.api('/api/workflows'), initiallyPersisted);

  const templateInput = {
    name: 'Explicit copy source',
    nodes: [
      { id: 'late-source', type: 'trend', label: 'Late source', x: 40, y: 60, config: {} },
      { id: 'late-output', type: 'trend', label: 'Late output', x: 340, y: 60, config: {} },
    ],
    edges: [{ id: 'late-source-output', source: 'late-source', target: 'late-output' }],
  };
  const otherTemplate = await f.api('/api/workflows', 'POST', { ...templateInput, name: 'Do not copy this preview', nodes: [{ id: 'other-preview', type: 'trend', label: 'Unselected template', x: 80, y: 90, config: {} }], edges: [] });
  const firstTemplateVersion = await f.api('/api/workflows', 'POST', templateInput);
  const template = await f.api(`/api/workflows/${firstTemplateVersion.id}`, 'PUT', { ...templateInput, name: 'Explicit copy source revised', expectedVersion: firstTemplateVersion.version });
  const templateHistory = await f.api(`/api/workflows/${template.id}/history`);
  const beforeCopies = await f.api('/api/workflows');
  available.push(otherTemplate, template);
  const reloadResponse = f.page.waitForResponse(response => response.url() === `${f.base}/api/workflows` && response.request().method() === 'GET');
  await f.page.locator('[data-wf-action=reload]').click();
  await reloadResponse;
  await f.page.locator('.wf-node[data-node-id="other-preview"]').waitFor();
  await assertCanvas(f.page, otherTemplate);
  await selectTemplate(f.page, template);
  assert.deepEqual(f.writes, [], 'late template discovery and selection do not silently create a global template or project copy');
  assert.deepEqual(await f.api('/api/workflows'), beforeCopies);

  const copiedA = await copyTemplate(f, template, a);
  await assertHistory(f, [copiedA]);
  await f.page.locator('[data-wf-action=new]').click();
  await renameDraft(f.page, 'Owner A draft');
  const originalA = await f.page.evaluate(() => window.editor.getContext().workflow);
  assert.equal(originalA.id, copiedA.id, 'New replaces only the owned graph draft, not its persistent identity');
  assert.equal(originalA.episodeId, a.episode.id);
  assert.equal(originalA.channelId, a.channel.id);
  const first = originalA.nodes[0];
  await f.page.locator(`.wf-node-header[data-id="${first.id}"]`).focus();
  await f.page.keyboard.press('ArrowRight');
  const editedA = await f.page.evaluate(() => window.editor.getContext().workflow);
  assert.equal(editedA.nodes[0].x, first.x + 10, 'a real keyboard edit changes only this local graph');
  await assertCanvas(f.page, editedA);
  await f.page.evaluate(binding => window.editor.bindProject(binding), binding(b));
  await selectTemplate(f.page, template);
  assert.equal(f.writes.length, 1, 'New, editing and project switching add no writes after the approved A copy');
  const copiedB = await copyTemplate(f, template, b);
  assert.notEqual(copiedB.id, copiedA.id, 'each project owns a distinct copy of the selected template');
  await f.page.locator('[data-wf-action=new]').click();
  await renameDraft(f.page, 'Owner B draft');
  const originalB = await f.page.evaluate(() => window.editor.getContext().workflow);
  await f.page.locator(`.wf-node-header[data-id="${originalB.nodes[0].id}"]`).focus();
  await f.page.keyboard.press('ArrowDown');
  const draftB = await f.page.evaluate(() => window.editor.getContext().workflow);
  assert.equal(draftB.nodes[0].y, originalB.nodes[0].y + 10);
  await f.page.evaluate(binding => window.editor.bindProject(binding), binding(a));
  assert.deepEqual(await f.page.evaluate(() => window.editor.getContext().workflow), editedA, 'returning restores A, not the most recent B draft');
  await assertCanvas(f.page, editedA);
  await f.page.locator('[data-wf-action=undo]').click();
  assert.deepEqual(await f.page.evaluate(() => window.editor.getContext().workflow), originalA, 'A undo cannot replay B history or erase its own name');
  await assertCanvas(f.page, originalA);
  await f.page.locator('[data-wf-action=redo]').click();
  assert.deepEqual(await f.page.evaluate(() => window.editor.getContext().workflow), editedA);
  await assertCanvas(f.page, editedA);
  assert.equal(f.writes.length, 2, 'only the two explicit project-copy approvals wrote anything');
  const beforeSaves = await f.api('/api/workflows');
  assert.deepEqual(beforeSaves.find(item => item.id === copiedA.id), copiedA, 'New and editing cannot autosave A');
  assert.deepEqual(beforeSaves.find(item => item.id === copiedB.id), copiedB, 'New and editing cannot autosave B');
  await assertHistory(f, [copiedA]);
  await assertHistory(f, [copiedB]);

  const firstSave = await saveDraft(f, copiedA);
  assert.deepEqual(firstSave.body, { name: editedA.name, nodes: editedA.nodes, edges: editedA.edges, expectedVersion: copiedA.version });
  assert.equal(firstSave.saved.id, copiedA.id);
  assert.equal(firstSave.saved.episodeId, a.episode.id);
  assert.equal(firstSave.saved.channelId, a.channel.id);
  assert.equal(firstSave.saved.templateId, template.id);
  assert.equal(firstSave.saved.templateVersion, template.version);
  assert.equal(firstSave.saved.version, copiedA.version + 1);
  assert.deepEqual(firstSave.saved.nodes, editedA.nodes);
  assert.deepEqual(firstSave.saved.edges, editedA.edges);
  await assertCanvas(f.page, firstSave.saved);
  await renameDraft(f.page, 'Owner A second explicit version');
  assert.deepEqual((await f.api('/api/workflows')).find(item => item.id === copiedA.id), firstSave.saved, 'editing after Save cannot advance persistence');
  const secondSave = await saveDraft(f, firstSave.saved);
  assert.deepEqual(secondSave.body, { name: 'Owner A second explicit version', nodes: editedA.nodes, edges: editedA.edges, expectedVersion: firstSave.saved.version });
  assert.equal(secondSave.saved.version, firstSave.saved.version + 1);
  assert.equal(secondSave.saved.name, 'Owner A second explicit version');
  await assertHistory(f, [copiedA, firstSave.saved, secondSave.saved]);

  await f.page.evaluate(binding => window.editor.bindProject(binding), binding(b));
  assert.deepEqual(await f.page.evaluate(() => window.editor.getContext().workflow), draftB, 'saving A cannot consume or overwrite B unsaved draft');
  await assertCanvas(f.page, draftB);
  await f.page.locator('[data-wf-action=undo]').click();
  assert.deepEqual(await f.page.evaluate(() => window.editor.getContext().workflow), originalB, 'B undo retains B history after A has saved twice');
  await f.page.locator('[data-wf-action=redo]').click();
  assert.deepEqual(await f.page.evaluate(() => window.editor.getContext().workflow), draftB);
  await assertCanvas(f.page, draftB);
  const savedB = await saveDraft(f, copiedB);
  assert.deepEqual(savedB.body, { name: draftB.name, nodes: draftB.nodes, edges: draftB.edges, expectedVersion: copiedB.version });
  assert.equal(savedB.saved.id, copiedB.id);
  assert.equal(savedB.saved.episodeId, b.episode.id);
  assert.equal(savedB.saved.channelId, b.channel.id);
  assert.equal(savedB.saved.templateId, template.id);
  assert.equal(savedB.saved.templateVersion, template.version);
  assert.equal(savedB.saved.version, copiedB.version + 1);
  assert.deepEqual(savedB.saved.nodes, draftB.nodes);
  assert.deepEqual(savedB.saved.edges, draftB.edges);
  await assertCanvas(f.page, savedB.saved);
  await assertHistory(f, [copiedB, savedB.saved]);
  const persisted = await f.api('/api/workflows');
  assert.deepEqual(persisted.find(item => item.id === secondSave.saved.id), secondSave.saved);
  assert.deepEqual(persisted.find(item => item.id === savedB.saved.id), savedB.saved);
  for (const shared of beforeCopies) assert.deepEqual(persisted.find(item => item.id === shared.id), shared, 'owned edits never modify a shared workflow');
  assert.equal(persisted.length, beforeCopies.length + 2, 'no hidden template or extra owned graph was created');
  assert.deepEqual(await f.api(`/api/workflows/${template.id}/history`), templateHistory);
  assert.deepEqual(f.writes.map(({ method, path }) => ({ method, path })), [
    { method: 'POST', path: `/api/workflows/${template.id}/copies` },
    { method: 'POST', path: `/api/workflows/${template.id}/copies` },
    { method: 'PUT', path: `/api/workflows/${copiedA.id}` },
    { method: 'PUT', path: `/api/workflows/${copiedA.id}` },
    { method: 'PUT', path: `/api/workflows/${copiedB.id}` },
  ]);
  assert.deepEqual(await f.page.evaluate(() => window.editorToasts), []);
});

test('a bound project cannot mutate or save an existing shared template preview', async t => {
  const f = await fixture(t), owner = await project(f, 'Readonly preview');
  const template = await f.api('/api/workflows', 'POST', {
    name: 'Shared preview must survive',
    nodes: [
      { id: 'preview-a', type: 'trend', label: 'Shared source A', x: 40, y: 60, config: {} },
      { id: 'preview-b', type: 'trend', label: 'Shared source B', x: 340, y: 60, config: {} },
    ],
    edges: [{ id: 'shared-a-b', source: 'preview-a', target: 'preview-b' }],
  });
  const history = await f.api(`/api/workflows/${template.id}/history`);
  await mountEditor(f, { episodes: [owner.episode], binding: { episodeId: owner.episode.id, channelId: owner.channel.id }, workflows: [template] });
  await loadAndRemount(f.page);
  await assertCanvas(f.page, template);
  for (const action of ['new', 'preset-full-pipeline', 'save']) assert.equal(await f.page.locator(`[data-wf-action="${action}"]`).isDisabled(), true, `${action} cannot overwrite a shared template`);
  await f.page.locator('.wf-node-header[data-id="preview-a"]').focus();
  await f.page.keyboard.press('ArrowRight');
  await f.page.keyboard.press('Control+z');
  await assertCanvas(f.page, template);
  await f.page.locator('[data-wf-action=open-workflow-settings]').click();
  assert.equal(await f.page.locator('#wf-workflow-name').isDisabled(), true, 'template settings remain a preview');
  await f.page.keyboard.press('Escape');
  const rejected = await f.page.evaluate(async () => {
    try { await window.editor.save(); return null; }
    catch (error) { return error.message; }
  });
  assert.match(rejected, /공용 템플릿.*프로젝트용 복사본/s, 'the public Save API also enforces template protection');
  assert.equal(await f.page.evaluate(() => window.editor.hasChanges()), false);
  assert.deepEqual(f.writes, [], 'template preview cannot mutate, autosave or create a copy');
  assert.deepEqual((await f.api('/api/workflows')).find(item => item.id === template.id), template);
  assert.deepEqual(await f.api(`/api/workflows/${template.id}/history`), history);
  assert.deepEqual(await f.page.evaluate(() => window.editorToasts), []);
});
