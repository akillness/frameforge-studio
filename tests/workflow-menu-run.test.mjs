// Tests for the workflow-plan-contract.md section 2.1-2.4 UI contract (MenuImpl's region of
// public/workflow.js: context menu, node cards, run/skip flows, #wf-focused-node). Isolated
// createApp + temp data dir + mock providers per call, patterned on tests/node-workbench.test.mjs
// and tests/workflow-sequential-node-ui.test.mjs. No live service, no real providers.
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

const REFERENCE_MARKER = 'Research Marker ZQ77 Reference';
const TREND_QUERY = 'media-trend-keyword';
const MODEL_ID = 'fixture-generate-model';
const ENGLISH_NOT_SELECTED = 'Node was not selected for this execution';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------
// Default graph: trend -> research -> script -> storyboard. `script` is the
// deliberate mid-chain target matching the real "확인해봄" bug (contract
// section 0); a dedicated publish-exclusion graph lives in M5e (publish
// carries hard structural prerequisites this base graph does not).
// options:
//   generation  - adds a `generate` node wired after storyboard, and enables the
//                 generation provider (all calls tracked, none expected to fire
//                 unless a test explicitly drives the quote/confirm path).
//   loggedOut   - real loginToken configured; the *page* browser context is never
//                 logged in (seeding goes through a separately authenticated
//                 apiContext). Exercises canMutate()=false (M9).
async function fixture(t, { generation = false, loggedOut = false, runGate = false, layoutNode = false, scriptAgent = 'codex' } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-menu-run-'));
  const forbidden = async () => { assert.fail('Unexpected external or paid operation in a menu/run test'); };
  const loginToken = loggedOut ? 'fixture-menu-run-logged-out-token-01' : '';
  const trendCalls = [];
  const prompts = [];
  const providerCalls = [];
  let gateResolve = null;
  const gate = () => runGate ? new Promise(resolve => { gateResolve = resolve; }) : Promise.resolve();
  const fetchTrends = async query => {
    trendCalls.push(query);
    await gate();
    return { trends: [{ keyword: query, source: 'Fixture RSS', url: 'https://fixture.invalid/trend' }], sources: [{ name: 'Fixture RSS', status: 'ok' }] };
  };
  const runAgent = async (agent, prompt, episode) => {
    prompts.push(prompt);
    return { message: 'Scripted node output', scenes: episode.scenes };
  };
  const generationStubs = generation ? {
    capability: async () => { providerCalls.push('capability'); return { available: true, authenticated: true }; },
    models: async () => { providerCalls.push('models'); return [{ id: MODEL_ID, name: 'Fixture generate model', type: 'image' }]; },
    modelSchema: async id => { providerCalls.push(`modelSchema:${id}`); return { id, type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }; },
    estimate: async () => { providerCalls.push('estimate'); return { cost: 1, currency: 'USD' }; },
    create: async () => { providerCalls.push('create'); assert.fail('No generation job may be created before explicit consent confirmation'); },
    submit: async () => { providerCalls.push('submit'); assert.fail('No generation job may be submitted before explicit consent confirmation'); },
    status: async () => { providerCalls.push('status'); return { available: true, authenticated: true }; },
  } : { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden };
  const app = createApp({
    dataDir, loginToken, publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), fetchTrends, runAgent },
    generation: generationStubs,
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    renderer: forbidden, mediaOptions: { fetchImpl: forbidden },
    youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const external = [], errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
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
  });
  // Seeding always goes through an authenticated context, independent of whether
  // the page itself is logged in (loggedOut option).
  let apiContext = context;
  if (loggedOut) {
    apiContext = await browser.newContext();
    const login = await apiContext.request.post(`${base}/api/login`, { headers: { origin: base }, data: { token: loginToken } });
    assert.equal(login.status(), 200, 'seed context must authenticate for a logged-out page test');
  }
  const api = async (path, method = 'GET', body) => {
    const response = await apiContext.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  await api('/api/references', 'POST', { title: REFERENCE_MARKER, url: 'https://fixture.invalid/reference', category: 'context' });
  const channel = await api('/api/channels', 'POST', { name: 'Menu run channel', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Menu run project', topic: 'Local fixture only' });
  const nodes = [
    { id: 'trend', type: 'trend', label: 'Trend node', x: 40, y: 50, config: { query: TREND_QUERY } },
    { id: 'research', type: 'research', label: 'Research node', x: 340, y: 50, config: {} },
    { id: 'script', type: 'script', label: 'Script node', x: 640, y: 50, config: { agent: scriptAgent } },
    { id: 'storyboard', type: 'storyboard', label: 'Storyboard node', x: 940, y: 50, config: {} },
  ];
  const edges = [
    { id: 'trend-research', source: 'trend', target: 'research' },
    { id: 'research-script', source: 'research', target: 'script' },
    { id: 'script-storyboard', source: 'script', target: 'storyboard' },
  ];
  if (generation) {
    if (layoutNode) {
      nodes.push({ id: 'layout', type: 'layout', label: 'Layout node', x: 1090, y: 50, config: {} });
      edges.push({ id: 'storyboard-layout', source: 'storyboard', target: 'layout' });
      nodes.push({ id: 'generate', type: 'generate', label: 'Generate node', x: 1390, y: 50, config: { model: MODEL_ID, sceneId: episode.scenes[0].id, sceneIndex: 0, prompt: 'Fixture generation prompt', params: {} } });
      nodes.push({ id: 'render', type: 'render', label: 'Render node', x: 1690, y: 50, config: {} });
      edges.push({ id: 'layout-generate', source: 'layout', target: 'generate' });
      edges.push({ id: 'generate-render', source: 'generate', target: 'render' });
    } else {
      nodes.push({ id: 'generate', type: 'generate', label: 'Generate node', x: 1240, y: 50, config: { model: MODEL_ID, sceneId: episode.scenes[0].id, sceneIndex: 0, prompt: 'Fixture generation prompt', params: {} } });
      nodes.push({ id: 'render', type: 'render', label: 'Render node', x: 1540, y: 50, config: {} });
      edges.push({ id: 'storyboard-generate', source: 'storyboard', target: 'generate' });
      edges.push({ id: 'generate-render', source: 'generate', target: 'render' });
    }
  }
  const template = await api('/api/workflows', 'POST', { name: 'Menu run graph', nodes, edges });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const open = async () => {
    await page.goto(base);
    const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
    if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
    await channelButton.click();
    await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
    await page.locator('#workflow-canvas').waitFor();
    assert.equal(await page.locator('#wf-select').inputValue(), workflow.id);
  };
  await open();
  const waitRun = async id => {
    for (let turn = 0; turn < 400; turn++) {
      const run = await api(`/api/workflow-runs/${id}`);
      if (['completed', 'failed', 'cancelled', 'awaiting_review', 'approved'].includes(run.status)) return run;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`Run ${id} did not reach a terminal state`);
  };
  return { page, context, base, api, writes, channel, episode, workflow, trendCalls, prompts, providerCalls, waitRun, open, releaseRun: () => gateResolve?.() };
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const node = (page, id) => page.locator(`.wf-node[data-node-id="${id}"]`);
const header = (page, id) => page.locator(`.wf-node-header[data-id="${id}"]`);
const menu = page => page.locator('.ff-context-menu[role=menu]');
const item = (page, name) => menu(page).getByRole('menuitem', { name, exact: true });
async function openNodeMenu(page, id, via = 'right-click') {
  if (via === 'more') await node(page, id).locator('[data-wf-action=node-menu]').click();
  else if (via === 'right-click') await header(page, id).click({ button: 'right' });
  else { await header(page, id).focus(); await page.keyboard.press(via); }
  await menu(page).waitFor();
}
async function openCanvasMenu(page, via = 'right-click') {
  if (via === 'more') await page.locator('[data-wf-action=canvas-menu]').click();
  else if (via === 'right-click') await page.locator('#workflow-canvas').click({ button: 'right', position: { x: 10, y: 10 } });
  else { await page.locator('#workflow-canvas').focus(); await page.keyboard.press(via); }
  await menu(page).waitFor();
}
const focused = page => page.locator('#wf-focused-node');
const focusedButton = (page, action) => focused(page).locator(`[data-wf-action="${action}"]`);
const stateBadge = (page, id) => node(page, id).locator('[data-testid="wf-node-badge"]');
const cardState = async (page, id) => node(page, id).getAttribute('data-node-state');
function planPending(page, base, workflowId) {
  return page.waitForResponse(r => r.url() === `${base}/api/workflows/${workflowId}/plan` && r.request().method() === 'POST');
}
function runPending(page, base, workflowId) {
  return page.waitForResponse(r => r.url() === `${base}/api/workflows/${workflowId}/run` && r.request().method() === 'POST');
}
function skipsPending(page, base, workflowId) {
  return page.waitForResponse(r => r.url() === `${base}/api/workflows/${workflowId}/skips` && r.request().method() === 'POST');
}
// Native dialog close -> restoreOverlayFocus() focus restoration is not guaranteed
// observable to Playwright in the same tick as 'hidden' (restoreOverlayFocus's own
// "something newer already owns focus" guard reads document.activeElement at close time,
// and that value settles a few ms after the dialog itself reports hidden -- confirmed via a
// live timing probe, 18-88ms). Poll instead of reading synchronously so U9's assertions prove
// the real eventual focus target, never a transient mid-close value.
async function waitForActiveElement(page, predicate, description) {
  try {
    await page.waitForFunction(predicate, null, { timeout: 2000, polling: 20 });
  } catch {
    const got = await page.evaluate(() => ({ wfAction: document.activeElement?.dataset?.wfAction || null, dataId: document.activeElement?.dataset?.id || null, id: document.activeElement?.id || null, tag: document.activeElement?.tagName || null, outerHTML: document.activeElement?.outerHTML?.slice(0, 200) || null }));
    assert.fail(`${description} -- focus never settled, got ${JSON.stringify(got)}`);
  }
}

// ===========================================================================
// M1 - exact menu contents, order, labels; four open triggers for both menus
// ===========================================================================
test('M1: node context menu is exactly 6 items in contract order with shortcut hints on 복제 and 노드 제거…; canvas menu is exactly 3; all four triggers open both', async t => {
  const f = await fixture(t), { page } = f;
  const nodeItems = ['실행', '건너뛰기', '노드 설정 편집', '노드 추가…', '복제', '노드 제거…'];
  const shortcutHints = { '복제': 'Ctrl/⌘ D', '노드 제거…': 'Delete' };
  const canvasItems = ['노드 추가…', '전체 실행', '그래프 저장'];
  for (const via of ['right-click', 'Shift+F10', 'ContextMenu', 'more']) {
    await openNodeMenu(page, 'script', via);
    const items = menu(page).getByRole('menuitem');
    assert.equal(await items.count(), 6, `${via}: node menu must show exactly 6 items (the 5 contract items plus 복제), not the old 9-item menu`);
    assert.deepEqual(await items.locator('.ff-context-menu__label').allInnerTexts(), nodeItems, `${via}: exact contract order and labels`);
    // Fresh node, nothing run/dirty/skipped: every one of these 6 items is enabled. Only the two
    // shortcut-bearing items carry a description, and it is exactly the shortcut text (no long prose).
    for (const label of nodeItems) {
      const description = item(page, label).locator('.ff-context-menu__description');
      assert.equal(await item(page, label).isDisabled(), false, `${via}: "${label}" is enabled on a fresh, unlocked node`);
      if (shortcutHints[label]) {
        assert.equal(await description.count(), 1, `${via}: "${label}" shows its shortcut hint`);
        assert.equal(await description.innerText(), shortcutHints[label], `${via}: "${label}" hint is exactly the shortcut text`);
      } else assert.equal(await description.count(), 0, `${via}: enabled "${label}" must be a single line with no description`);
    }
    assert.match(await menu(page).locator('.ff-context-menu__title').innerText(), /^Script node ·/, `${via}: menu title keeps the "${'${name}'} · ${'${summary}'}" format`);
    await page.keyboard.press('Escape');
  }
  for (const via of ['right-click', 'Shift+F10', 'ContextMenu', 'more']) {
    await openCanvasMenu(page, via);
    const items = menu(page).getByRole('menuitem');
    assert.equal(await items.count(), 3, `${via}: canvas menu must show exactly 3 items`);
    assert.deepEqual(await items.locator('.ff-context-menu__label').allInnerTexts(), canvasItems, `${via}: exact contract order and labels`);
    // "노드 추가…" and "전체 실행" are enabled (nothing blocks them) and must be
    // single-line. "그래프 저장" is legitimately disabled here (nothing is dirty
    // yet on a freshly loaded, already-saved workflow) and may carry a short
    // (<=24 char) reason per the contract's own "disabled reason" allowance.
    for (const label of ['노드 추가…', '전체 실행']) assert.equal(await item(page, label).locator('.ff-context-menu__description').count(), 0, `${via}: enabled "${label}" must be a single line with no long description`);
    const saveDescription = item(page, '그래프 저장').locator('.ff-context-menu__description');
    if (await saveDescription.count()) assert.ok((await saveDescription.innerText()).length <= 24, `${via}: 그래프 저장 disabled reason must be <= 24 chars`);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(f.writes, [], 'opening every menu via every trigger must never write');
});

// ===========================================================================
// M2 - removed items stay reachable from #wf-focused-node
// ===========================================================================
test('M2: connections, node-history, node-results, input, output stay reachable from #wf-focused-node with data-id synced to the selection; scene-editor appears for a scene-target node', async t => {
  const f = await fixture(t, { generation: true }), { page } = f;
  await header(page, 'script').click();
  for (const action of ['connections', 'node-history', 'node-results', 'input', 'output']) {
    const button = focusedButton(page, action);
    assert.equal(await button.count(), 1, `#wf-focused-node must expose a "${action}" button`);
    assert.equal(await button.getAttribute('data-id'), 'script', `"${action}" button data-id tracks the selected node`);
  }
  await header(page, 'generate').click();
  for (const action of ['connections', 'node-history', 'node-results', 'input', 'output', 'scene-editor']) {
    assert.equal(await focusedButton(page, action).getAttribute('data-id'), 'generate', `"${action}" data-id updates when selection changes (scene-editor reachable for a node with a configured scene target)`);
  }
  assert.deepEqual(f.writes, [], 'inspecting the focused-node panel must never write');
});

// ===========================================================================
// M3 + M4 - the root-cause scenario: mid-chain run via the planner, ancestors
// executed in order with real data flow, completed ancestors reused (not
// rerun), an upstream rerun marks dependents stale, and the next dependent
// run reruns the stale chain instead of silently skipping it.
// ===========================================================================
test('M3+M4: run-node on a mid-chain target plans+runs ancestors in order with real data flow, reuses completed ancestors, and reruns the stale chain after an upstream rerun', async t => {
  const f = await fixture(t), { page, base, workflow, api, waitRun, trendCalls, prompts } = f;

  // --- M3: nothing completed yet. Right-click "script" (mid-chain: trend/research
  // are missing ancestors, storyboard is an untouched descendant) and run only it. ---
  // Both listeners are registered BEFORE the click: a single click drives plan-then-run
  // in one async chain, so registering runPending only after consuming the plan response
  // body (a real CDP round-trip) risks missing the /run request, which can already have
  // fired and completed by then.
  await openNodeMenu(page, 'script', 'right-click');
  const firstPlanPending = planPending(page, base, workflow.id);
  const firstRunPending = runPending(page, base, workflow.id);
  await item(page, '실행').click();
  const firstPlanResponse = await firstPlanPending;
  assert.equal(firstPlanResponse.status(), 200, `POST /plan for script: ${await firstPlanResponse.text()}`);
  const firstPlanBody = firstPlanResponse.request().postDataJSON();
  assert.deepEqual(firstPlanBody.execution, { mode: 'node', targetNodeId: 'script' });
  assert.equal(firstPlanBody.episodeId, f.episode.id);
  assert.equal(firstPlanBody.expectedWorkflowVersion, workflow.version, 'plan must carry optimistic concurrency for the workflow');
  assert.equal(firstPlanBody.expectedEpisodeVersion, f.episode.version, 'plan must carry optimistic concurrency for the episode');
  assert.equal(firstPlanBody.selectedStages, undefined, 'the client must never build selectedStages itself for /plan either');
  const firstPlan = await firstPlanResponse.json();
  assert.deepEqual(firstPlan.selectedStages, ['trend', 'research', 'script'], 'the planner must include the missing ancestors, not just the clicked node');
  assert.equal(firstPlan.blocked, false);
  const firstRunResponse = await firstRunPending;
  assert.equal(firstRunResponse.status(), 202, `POST /run for script: ${await firstRunResponse.text()}`);
  const firstRunBody = firstRunResponse.request().postDataJSON();
  assert.ok(firstRunBody.execution, 'the /run body must carry an execution intent');
  assert.deepEqual(firstRunBody.execution, { mode: 'node', targetNodeId: 'script' });
  assert.equal(firstRunBody.selectedStages, undefined, 'the client must never build selectedStages itself');
  assert.equal(firstRunBody.startStage, undefined);
  const firstRun = await waitRun((await firstRunResponse.json()).id);
  assert.equal(firstRun.status, 'completed', JSON.stringify(firstRun));
  assert.deepEqual(firstRun.nodeRuns.filter(n => ['trend', 'research', 'script'].includes(n.nodeId)).map(n => n.status), ['completed', 'completed', 'completed'], 'trend, research and script must all have actually executed, in order');
  assert.equal(prompts.length, 1, 'script must have executed exactly once');
  assert.ok(prompts[0].includes(REFERENCE_MARKER), 'script input must contain the connected research output (seeded reference)');
  assert.ok(prompts[0].includes(TREND_QUERY), 'script input must transitively contain the trend output research consumed');
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.dataset.nodeState === 'completed', 'script');
  for (const id of ['trend', 'research', 'script']) assert.equal(await cardState(page, id), 'completed', `${id} card must reach the completed state`);
  assert.equal(await cardState(page, 'storyboard'), 'idle', 'storyboard was never selected and must stay idle, not completed');
  // The toolbar run-all button is gated by the exact same running()/mutationReason() check
  // as every context-menu run action; waiting for it to be enabled is a direct signal that
  // the client's local run state has caught up with the server (not just one node's card),
  // so the next click below cannot be synchronously blocked by stale running() state.
  await page.waitForFunction(() => !document.querySelector('[data-wf-action="run"]')?.disabled);

  // --- M4a: run "storyboard" next. trend/research/script are completed+reusable
  // and must be REUSED, not rerun (no new runAgent call, no new trend fetch). ---
  const trendCallsBeforeReuse = trendCalls.length;
  await openNodeMenu(page, 'storyboard', 'right-click');
  const secondPlanPending = planPending(page, base, workflow.id);
  const secondRunPending = runPending(page, base, workflow.id);
  await item(page, '실행').click();
  const secondPlanResponse = await secondPlanPending;
  assert.equal(secondPlanResponse.status(), 200, await secondPlanResponse.text());
  const secondPlan = await secondPlanResponse.json();
  assert.deepEqual(secondPlan.selectedStages, ['storyboard'], 'already-completed ancestors must not be re-selected to run');
  assert.deepEqual(secondPlan.completedNodeIds.sort(), ['research', 'script', 'trend']);
  const secondRunResponse = await secondRunPending;
  assert.equal(secondRunResponse.status(), 202, await secondRunResponse.text());
  const secondRun = await waitRun((await secondRunResponse.json()).id);
  assert.equal(secondRun.status, 'completed', JSON.stringify(secondRun));
  assert.equal(secondRun.nodeRuns.find(n => n.nodeId === 'storyboard').status, 'completed');
  assert.equal(prompts.length, 1, 'script must NOT have run again: its completed output was reused');
  assert.equal(trendCalls.length, trendCallsBeforeReuse, 'trend must NOT have run again');
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.dataset.nodeState === 'completed', 'storyboard');
  assert.equal(await cardState(page, 'storyboard'), 'completed');
  await page.waitForFunction(() => !document.querySelector('[data-wf-action="run"]')?.disabled);

  // --- M4b: re-run the already-completed "trend" ancestor explicitly. Its
  // dependents (research, script, storyboard) must flip to stale because their
  // saved output no longer carries into the new lineage. ---
  const trendCallsBeforeRerun = trendCalls.length;
  await openNodeMenu(page, 'trend', 'right-click');
  const thirdPlanPending = planPending(page, base, workflow.id);
  const thirdRunPending = runPending(page, base, workflow.id);
  await item(page, '실행').click();
  const thirdPlanResponse = await thirdPlanPending;
  assert.equal(thirdPlanResponse.status(), 200, await thirdPlanResponse.text());
  const thirdPlan = await thirdPlanResponse.json();
  assert.deepEqual(thirdPlan.selectedStages, ['trend']);
  assert.deepEqual(thirdPlan.staleNodeIds.sort(), ['research', 'script', 'storyboard'], 'every reusable descendant of the rerun node must be marked stale');
  const thirdRunResponse = await thirdRunPending;
  const thirdRun = await waitRun((await thirdRunResponse.json()).id);
  assert.equal(thirdRun.status, 'completed', JSON.stringify(thirdRun));
  assert.equal(trendCalls.length, trendCallsBeforeRerun + 1, 'trend must have actually re-executed');
  for (const id of ['research', 'script', 'storyboard']) {
    const record = thirdRun.nodeRuns.find(n => n.nodeId === id);
    assert.equal(record.status, 'skipped', `${id} was not selected in this run`);
    assert.ok(record.staleFrom, `${id} nodeRun must carry staleFrom pointing at the superseded source run`);
  }
  await page.waitForFunction(() => document.querySelector('[data-node-id="research"]')?.dataset.nodeState === 'stale');
  for (const id of ['research', 'script', 'storyboard']) {
    assert.equal(await cardState(page, id), 'stale', `${id} card must show the stale state after trend reran`);
    assert.match(await stateBadge(page, id).innerText(), /갱신 필요/, `${id} badge must read 갱신 필요`);
  }
  await page.waitForFunction(() => !document.querySelector('[data-wf-action="run"]')?.disabled);

  // --- A2: the next dependent run must rerun the WHOLE stale chain, not
  // silently skip the stale research/script in between (the original bug). ---
  await openNodeMenu(page, 'storyboard', 'right-click');
  const fourthPlanPending = planPending(page, base, workflow.id);
  const fourthRunPending = runPending(page, base, workflow.id);
  await item(page, '실행').click();
  const fourthPlanResponse = await fourthPlanPending;
  assert.equal(fourthPlanResponse.status(), 200, await fourthPlanResponse.text());
  const fourthPlan = await fourthPlanResponse.json();
  assert.deepEqual(fourthPlan.selectedStages, ['research', 'script', 'storyboard'], 'the stale chain must be rerun, not silently reused or skipped');
  assert.deepEqual(fourthPlan.completedNodeIds, ['trend'], 'trend itself (not stale) is still reusable');
  const fourthRunResponse = await fourthRunPending;
  const fourthRun = await waitRun((await fourthRunResponse.json()).id);
  assert.equal(fourthRun.status, 'completed', JSON.stringify(fourthRun));
  assert.equal(prompts.length, 2, 'script must have executed a SECOND time: the stale chain reran instead of being silently skipped');
  assert.equal(trendCalls.length, trendCallsBeforeRerun + 1, 'trend must have been reused this time, not rerun again');
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.dataset.nodeState === 'completed', 'storyboard');
  for (const id of ['research', 'script', 'storyboard']) assert.equal(await cardState(page, id), 'completed');
  assert.equal(await cardState(page, 'trend'), 'completed');
});

// ===========================================================================
// M5 - run-all: keep / refresh / cancel decision, nothingToRun, publish never runs
// ===========================================================================
test('M5a: run-all with nothing completed runs directly without the decision dialog', async t => {
  const f = await fixture(t), { page, base, workflow, waitRun } = f;
  await openCanvasMenu(page, 'right-click');
  const plan = planPending(page, base, workflow.id);
  const run = runPending(page, base, workflow.id);
  await item(page, '전체 실행').click();
  const planResponse = await plan;
  assert.equal(planResponse.status(), 200, await planResponse.text());
  assert.deepEqual(planResponse.request().postDataJSON().execution, { mode: 'all', refresh: false });
  assert.equal(await page.locator('#wf-run-all-dialog[open]').count(), 0, 'no prior completed nodes means no keep/refresh decision is needed');
  const runResponse = await run;
  assert.equal(runResponse.status(), 202, await runResponse.text());
  assert.deepEqual(runResponse.request().postDataJSON().execution, { mode: 'all', refresh: false });
  const result = await waitRun((await runResponse.json()).id);
  assert.equal(result.status, 'completed', JSON.stringify(result));
});

test('M5b: run-all with completed nodes opens the exact decision dialog; keep runs only the remaining nodes and leaves completed output untouched', async t => {
  const f = await fixture(t), { page, base, workflow, api, waitRun, trendCalls } = f;
  // Pre-complete just "trend" via run-node so run-all has a real partial-completion decision to make.
  await openNodeMenu(page, 'trend', 'right-click');
  const firstPlan = planPending(page, base, workflow.id);
  const firstRun = runPending(page, base, workflow.id);
  await item(page, '실행').click();
  const firstPlanResponse = await firstPlan;
  assert.equal(firstPlanResponse.status(), 200, `priming POST /plan for trend: ${await firstPlanResponse.text()}`);
  const priorTrend = await waitRun((await (await firstRun).json()).id);
  assert.equal(priorTrend.status, 'completed', JSON.stringify(priorTrend));
  const priorOutput = priorTrend.nodeRuns.find(n => n.nodeId === 'trend').output;
  const trendCallsAfterPrime = trendCalls.length;

  // Wait for the UI's own poll (schedulePoll, 2200ms interval) to reflect the primed run as
  // terminal, not just the server: waitRun polls the API directly and resolves far faster, so
  // running() can still read true from stale local state and the run-all menu action would
  // throw synchronously (mutationReason()) before issuing any /plan request.
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.dataset.nodeState === 'completed', 'trend');
  await openCanvasMenu(page, 'right-click');
  const plan = planPending(page, base, workflow.id);
  await item(page, '전체 실행').click();
  const planResponse = await plan;
  assert.equal(planResponse.status(), 200, await planResponse.text());
  const planBody = await planResponse.json();
  assert.equal(planBody.needsDecision, true);
  assert.deepEqual(planBody.completedNodeIds, ['trend']);
  const dialog = page.locator('#wf-run-all-dialog[open]');
  await dialog.waitFor();
  assert.equal(await page.locator('#wf-run-all-dialog').getAttribute('class'), 'wf-overlay');
  assert.match(await dialog.innerText(), /전체 실행/);
  assert.match(await dialog.innerText(), /이미 완료된 노드 1개가 있습니다\. 새로 실행할까요\?/);
  const keep = dialog.getByRole('button', { name: '완료 노드 유지, 남은 노드만 실행', exact: true });
  const refresh = dialog.getByRole('button', { name: '완료 노드도 새로 실행', exact: true });
  const cancel = dialog.getByRole('button', { name: '취소', exact: true });
  assert.equal(await keep.count(), 1); assert.equal(await refresh.count(), 1); assert.equal(await cancel.count(), 1);
  assert.equal(await keep.getAttribute('data-wf-action'), 'run-all-keep');
  assert.equal(await refresh.getAttribute('data-wf-action'), 'run-all-refresh');
  assert.equal(await cancel.getAttribute('data-wf-action'), 'close-overlay');

  const run = runPending(page, base, workflow.id);
  await keep.click();
  const runResponse = await run;
  assert.equal(runResponse.status(), 202, await runResponse.text());
  const runBody = runResponse.request().postDataJSON();
  assert.deepEqual(runBody.execution, { mode: 'all', refresh: false });
  const result = await waitRun((await runResponse.json()).id);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(result.nodeRuns.find(n => n.nodeId === 'trend').output, priorOutput, 'kept node output must be byte-identical: it was reused, not refreshed');
  assert.equal(trendCalls.length, trendCallsAfterPrime, 'keep must not have refetched the already-completed trend');
  assert.equal(result.nodeRuns.find(n => n.nodeId === 'research').status, 'completed');
});

test('M5e: run-all never selects a connected publish node', async t => {
  // Dedicated minimal graph: publish has hard structural prerequisites (render,
  // review) the base fixture graph does not carry, so this uses its own chain.
  const f = await fixture(t), { api } = f;
  const template = await api('/api/workflows', 'POST', {
    name: 'Publish exclusion graph',
    nodes: [
      { id: 'p-script', type: 'script', x: 40, y: 50, config: { agent: 'existing' } },
      { id: 'p-storyboard', type: 'storyboard', x: 340, y: 50, config: {} },
      { id: 'p-render', type: 'render', x: 640, y: 50, config: {} },
      { id: 'p-review', type: 'review', x: 940, y: 50, config: {} },
      { id: 'p-publish', type: 'publish', x: 1240, y: 50, config: {} },
    ],
    edges: [
      { id: 'p-e1', source: 'p-script', target: 'p-storyboard' },
      { id: 'p-e2', source: 'p-storyboard', target: 'p-render' },
      { id: 'p-e3', source: 'p-render', target: 'p-review' },
      { id: 'p-e4', source: 'p-review', target: 'p-publish' },
    ],
  });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: f.channel.id, episodeId: f.episode.id, expectedTemplateVersion: template.version });
  const planResponse = await api(`/api/workflows/${workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution: { mode: 'all' } });
  assert.equal(planResponse.blocked, false, JSON.stringify(planResponse));
  assert.equal(planResponse.selectedStages.includes('p-publish'), false, 'mode:"all" must never select publish, connected or not');
});

test('M5c: run-all refresh reruns every completed node (paid nodes still require consent) and cancel issues no request', async t => {
  // scriptAgent:'existing' so nothing in this graph needs free preparation (contract 5C): the
  // full selection always requires immediate consent, which is exactly what this test checks.
  const f = await fixture(t, { generation: true, scriptAgent: 'existing' }), { page, base, workflow, waitRun, trendCalls, providerCalls } = f;
  await openNodeMenu(page, 'trend', 'right-click');
  const firstPlan = planPending(page, base, workflow.id);
  const firstRun = runPending(page, base, workflow.id);
  await item(page, '실행').click();
  const firstPlanResponse = await firstPlan; assert.equal(firstPlanResponse.status(), 200, `priming POST /plan for trend: ${await firstPlanResponse.text()}`);
  const firstRunResponse = await firstRun; await waitRun((await firstRunResponse.json()).id);
  const trendCallsAfterPrime = trendCalls.length;
  // Same UI-poll-lag wait as M5b: the server already completed the primed run but the
  // client's own poll (2200ms) may not have caught up yet.
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.dataset.nodeState === 'completed', 'trend');

  // Cancel must issue zero writes.
  await openCanvasMenu(page, 'right-click');
  const cancelPlan = planPending(page, base, workflow.id); await item(page, '전체 실행').click();
  const cancelPlanResponse = await cancelPlan; assert.equal(cancelPlanResponse.status(), 200, `POST /plan for run-all (cancel path): ${await cancelPlanResponse.text()}`);
  const dialog = page.locator('#wf-run-all-dialog[open]'); await dialog.waitFor();
  const writesBeforeCancel = f.writes.length;
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(f.writes.slice(writesBeforeCancel), [], 'cancel must not issue any POST, including /run');

  // Refresh: every completed node reruns; the graph includes a generate node, so
  // paid generation consent must still gate it (no /run, zero provider calls yet).
  await openCanvasMenu(page, 'right-click');
  const refreshPlan = planPending(page, base, workflow.id); await item(page, '전체 실행').click();
  const refreshPlanResponse = await refreshPlan; assert.equal(refreshPlanResponse.status(), 200, `POST /plan for run-all (refresh path): ${await refreshPlanResponse.text()}`);
  const dialog2 = page.locator('#wf-run-all-dialog[open]'); await dialog2.waitFor();
  const writesBeforeRefresh = f.writes.length;
  await dialog2.getByRole('button', { name: '완료 노드도 새로 실행', exact: true }).click();
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  assert.deepEqual(f.writes.slice(writesBeforeRefresh).filter(w => /\/run$/.test(w.path)), [], 'refresh with a generate node in scope must open consent, not POST /run directly');
  assert.deepEqual(providerCalls, [], 'no provider call may happen before the user confirms the consent dialog');
  await page.locator('#wf-confirm-dialog [data-wf-action=close-dialog]').click();
  assert.deepEqual(f.writes.slice(writesBeforeRefresh).filter(w => /\/run$/.test(w.path)), [], 'cancelling consent must leave nothing started since the refresh priming (writesBeforeRefresh); the earlier /run for the trend prime is a separate, legitimate write');
  assert.equal(trendCalls.length, trendCallsAfterPrime, 'nothing reran before consent was granted');
});

test('M5d: nothingToRun disables the keep button with a hint once every node is already completed', async t => {
  const f = await fixture(t), { page, base, workflow, waitRun } = f;
  await openCanvasMenu(page, 'right-click');
  const firstPlan = planPending(page, base, workflow.id);
  const firstRun = runPending(page, base, workflow.id);
  await item(page, '전체 실행').click();
  const firstPlanResponse = await firstPlan; assert.equal(firstPlanResponse.status(), 200, `priming POST /plan for run-all: ${await firstPlanResponse.text()}`);
  const firstRunResponse = await firstRun; await waitRun((await firstRunResponse.json()).id);
  // Same UI-poll-lag wait as M5b/M5c: wait for the LAST node in this run-all priming
  // (storyboard) to show completed before the next mutating menu action.
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.dataset.nodeState === 'completed', 'storyboard');
  await openCanvasMenu(page, 'right-click');
  const plan = planPending(page, base, workflow.id); await item(page, '전체 실행').click();
  const planResponse = await plan;
  assert.equal(planResponse.status(), 200, `POST /plan for run-all: ${await planResponse.text()}`);
  const planBody = await planResponse.json();
  assert.equal(planBody.nothingToRun, true, 'every runnable node is already completed');
  const dialog = page.locator('#wf-run-all-dialog[open]'); await dialog.waitFor();
  const keep = dialog.getByRole('button', { name: '완료 노드 유지, 남은 노드만 실행', exact: true });
  assert.equal(await keep.isDisabled(), true);
  // U8: the hint is a VISIBLE <small id="wf-run-all-keep-hint"> next to the button (data-tooltip
  // never renders in project-embedded workbench mode -- mount() only calls
  // installInfoTooltips(host) when document.body.dataset.workbench!=='project', so the old
  // tooltip-only hint was invisible there; this was a real bug, not stylistic).
  assert.equal(await dialog.locator('#wf-run-all-keep-hint').innerText(), '남은 노드 없음');
  assert.equal(await keep.getAttribute('aria-describedby'), 'wf-run-all-keep-hint');
});

// ===========================================================================
// M6 - persistent skip
// ===========================================================================
test('M6: toggling skip persists without touching version/history, blocks run with the right reason, excludes from run-all, and requires a saved project workflow', async t => {
  const f = await fixture(t), { page, base, workflow, api, waitRun } = f;
  const historyBefore = await api(`/api/workflows/${workflow.id}/history`);
  const versionBefore = (await api('/api/workflows')).find(w => w.id === workflow.id).version;

  await openNodeMenu(page, 'research', 'right-click');
  const skipRequest = skipsPending(page, base, workflow.id);
  await item(page, '건너뛰기').click();
  const skipResponse = await skipRequest;
  assert.equal(skipResponse.status(), 200, await skipResponse.text());
  assert.deepEqual(skipResponse.request().postDataJSON(), { nodeId: 'research', skipped: true, expectedVersion: versionBefore });

  await page.waitForFunction(() => document.querySelector('[data-node-id="research"]')?.classList.contains('is-skipped'));
  assert.match(await stateBadge(page, 'research').innerText(), /건너뜀/);
  assert.equal(await page.locator('#wf-save-status').getAttribute('class'), 'saved', 'toggling skip must not mark the draft dirty');
  assert.deepEqual(await api(`/api/workflows/${workflow.id}/history`), historyBefore, 'skip must not create a version-history snapshot');
  const afterToggle = (await api('/api/workflows')).find(w => w.id === workflow.id);
  assert.equal(afterToggle.version, versionBefore, 'skip must not bump the workflow version');
  assert.deepEqual(afterToggle.skippedNodes, ['research']);

  await openNodeMenu(page, 'research', 'right-click');
  assert.equal(await item(page, '건너뛰기 해제').count(), 1, 'the menu item label flips once skipped');
  const runItem = item(page, '실행');
  assert.equal(await runItem.isDisabled(), true);
  assert.match((await menu(page).innerText()), /건너뜀 해제 필요/);
  await page.keyboard.press('Escape');

  // Reload: the skip must survive.
  await f.open();
  assert.equal(await page.locator('[data-node-id="research"]').evaluate(e => e.classList.contains('is-skipped')), true, 'skip must persist across reload');

  // Run-all must exclude the skipped node. This actually starts a real run (not just a plan);
  // it must be waited to completion, or the next mutating action below races against
  // running()/mutationReason() still reading true.
  await openCanvasMenu(page, 'right-click');
  const plan = planPending(page, base, workflow.id);
  const run = runPending(page, base, workflow.id);
  await item(page, '전체 실행').click();
  const planResponse = await plan;
  assert.equal(planResponse.status(), 200, `POST /plan for run-all after skip: ${await planResponse.text()}`);
  const planBody = await planResponse.json();
  assert.equal(planBody.selectedStages.includes('research'), false, 'run-all must never select a skipped node');
  assert.deepEqual(planBody.skippedNodeIds, ['research']);
  const runResponse = await run;
  assert.equal(runResponse.status(), 202, `POST /run for run-all after skip: ${await runResponse.text()}`);
  await waitRun((await runResponse.json()).id);
  await page.waitForFunction(() => !document.querySelector('[data-wf-action="run"]')?.disabled);

  // Undo and verify the toast + no-request boundary on an unsaved (dirty) draft of the SAME
  // owned project workflow. A disconnected template (no episodeId/channelId) is the WRONG
  // fixture for this: editable()=!project||owns(workflow) is false for it, so the generic
  // "공용 템플릿은 미리보기입니다" mutationReason() lock disables toggle-skip at menu-open
  // time and the click never lands -- it never reaches the toggle-skip action handler's own
  // "!workflow.id||dirty||!owns(workflow)" guard, which is what this scenario must exercise.
  // Nudging a node position (arrow key) dirties the still-owned, still-editable draft instead.
  await page.keyboard.press('Escape');
  const writesBefore = f.writes.length;
  await header(page, 'trend').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#wf-save-status')?.className === 'unsaved');
  await openNodeMenu(page, 'script', 'right-click');
  const skipItem = item(page, '건너뛰기');
  assert.equal(await skipItem.isDisabled(), false, 'toggle-skip stays enabled while merely dirty (not locked by mutationReason); the block is inside the action handler');
  await skipItem.click();
  await page.locator('#toast.visible').waitFor({ timeout: 4000 }).catch(() => {});
  assert.deepEqual(f.writes.slice(writesBefore).filter(w => /\/skips$/.test(w.path)), [], 'an unsaved (dirty) draft must never POST /skips');
  assert.match(await page.locator('body').innerText(), /저장한 뒤 건너뛰기를 설정할 수 있습니다\./);
});

// ===========================================================================
// M7 - every UI-issued /run POST carries execution, never a client-built selectedStages
// ===========================================================================
test('M7: toolbar run, stage overlay start/resume and prepare-generation-source all post execution, never selectedStages', async t => {
  const f = await fixture(t), { page, base, workflow } = f;

  // Toolbar "워크플로우 실행" is now the run-all entry point.
  const toolbarPlan = planPending(page, base, workflow.id);
  const toolbarRun = runPending(page, base, workflow.id);
  await page.locator('[data-wf-action=run]').click();
  await toolbarPlan;
  const toolbarRunResponse = await toolbarRun;
  const toolbarBody = toolbarRunResponse.request().postDataJSON();
  assert.ok(toolbarBody.execution, 'toolbar run must carry execution');
  assert.equal(toolbarBody.selectedStages, undefined);
  assert.equal(toolbarBody.startStage, undefined);
  await f.waitRun((await toolbarRunResponse.json()).id);

  // Stage overlay "실행" / resume: select a node, open its stage overlay, start.
  await header(page, 'trend').click();
  await page.locator('[data-wf-action=open-stage-overlay]').first().click();
  const stageDialog = page.locator('#wf-stage-dialog[open]'); await stageDialog.waitFor();
  const stagePlan = planPending(page, base, workflow.id);
  const stageRun = runPending(page, base, workflow.id);
  await stageDialog.locator('#wf-stage-start').click();
  await stagePlan;
  const stageRunResponse = await stageRun;
  const stageBody = stageRunResponse.request().postDataJSON();
  assert.ok(stageBody.execution, 'stage overlay start must carry execution');
  assert.deepEqual(stageBody.execution, { mode: 'node', targetNodeId: 'trend' });
  assert.equal(stageBody.selectedStages, undefined);
  await f.waitRun((await stageRunResponse.json()).id);
  await page.keyboard.press('Escape');
});

test('M7b: prepare-generation-source targets the first generate node directly (contract addendum 5C); when the full selection needs no free preparation it toasts and never POSTs /run, and it never builds selectedStages client-side', async t => {
  // Dedicated graph where script's agent is 'existing': prepareCandidate does NOT reject
  // [script, storyboard, generate] together (the "fresh script + generate" rule in contract
  // 5C only fires for agent != 'existing'), so the full selection needs no free preparatory
  // prefix -- this is the "nothing to prepare" branch, distinct from the deferred-prefix flow
  // M11 covers below.
  const f = await fixture(t, { generation: true }), { api, channel, episode } = f;
  const template = await api('/api/workflows', 'POST', {
    name: 'No-preparation-needed graph',
    nodes: [
      { id: 'np-script', type: 'script', x: 40, y: 50, config: { agent: 'existing' } },
      { id: 'np-storyboard', type: 'storyboard', x: 340, y: 50, config: {} },
      { id: 'np-generate', type: 'generate', x: 640, y: 50, config: { model: MODEL_ID, sceneId: episode.scenes[0].id, sceneIndex: 0, prompt: 'Fixture generation prompt', params: {} } },
      { id: 'np-render', type: 'render', x: 940, y: 50, config: {} },
    ],
    edges: [
      { id: 'np-e1', source: 'np-script', target: 'np-storyboard' },
      { id: 'np-e2', source: 'np-storyboard', target: 'np-generate' },
      { id: 'np-e3', source: 'np-generate', target: 'np-render' },
    ],
  });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const page = f.page, base = f.base;
  await page.goto(base);
  await page.locator('#workflow-canvas').waitFor().catch(() => {});
  await page.selectOption('#wf-select', workflow.id);
  await page.locator('#workflow-canvas').waitFor();
  assert.equal(await page.locator('#wf-select').inputValue(), workflow.id);

  // Prime the consent dialog open the same way any paid-generation entry point does: toolbar
  // run-all on a fresh (nothing completed) workflow with a generate node -> requiresGeneration.
  const toolbarPlan = planPending(page, base, workflow.id);
  await page.locator('[data-wf-action=run]').click();
  const toolbarPlanResponse = await toolbarPlan;
  assert.equal(toolbarPlanResponse.status(), 200, `priming POST /plan for run-all (opens consent): ${await toolbarPlanResponse.text()}`);
  assert.equal(toolbarPlanResponse.request().postDataJSON().selectedStages, undefined, 'no UI path ever POSTs a client-built selectedStages, not even the priming toolbar run');
  await page.locator('#wf-confirm-dialog[open]').waitFor();

  const dialogPlan = planPending(page, base, workflow.id);
  const writesBeforeClick = f.writes.length;
  await page.locator('[data-wf-action=prepare-generation-source]').click();
  const planResponse = await dialogPlan;
  assert.equal(planResponse.status(), 200, await planResponse.text());
  const planBody = planResponse.request().postDataJSON();
  assert.ok(planBody.execution, 'prepare-generation-source must go through the planner');
  assert.equal(planBody.execution.mode, 'node');
  assert.equal(planBody.execution.targetNodeId, 'np-generate', 'contract 5C: targets the first generate node directly, not a statically guessed storyboard/script ancestor');
  assert.equal(planBody.selectedStages, undefined, 'prepare-generation-source must never POST selectedStages directly');
  const plan = await planResponse.json();
  assert.equal(plan.requiresGeneration, true, 'the full ancestor chain including generate is selected (nothing completed yet)');
  assert.deepEqual(plan.deferredStages ?? [], [], 'script.agent==="existing" means the full selection needs no free preparatory prefix');

  // Nothing to prepare -> toast, no /run POST at all (neither a bare one nor one carrying
  // client-built selectedStages).
  await page.locator('#toast.visible').waitFor({ timeout: 4000 }).catch(() => {});
  assert.match(await page.locator('body').innerText(), /준비할 소스 노드가 없습니다\. 비용 확인으로 진행하세요\./);
  assert.deepEqual(f.writes.slice(writesBeforeClick).filter(w => /\/run$/.test(w.path)), [], 'nothing to prepare must never POST /run');
  assert.deepEqual(f.providerCalls, [], 'no provider call before explicit consent confirmation');
});

// ===========================================================================
// M11 - prepare-first through the UI (contract addendum 5C + UI consequence, 2026-10-27).
// EXPECTED RED until ServerImpl2 lands part C (local://progress-ServerImpl2.md: "C: STARTING
// NOW" as of this writing) -- the current planExecution() does not yet wrap prepareCandidate
// to compute deferredStages/notice, so the /plan response for this scenario will have
// requiresGeneration:true and no deferredStages, and the UI will open the paid-generation
// consent dialog on the FIRST click instead of running the free prefix straight away.
// ===========================================================================
test('M11: clicking run on a graph needing preparation runs the free prefix with no consent dialog and zero provider calls, then a second run opens consent for just the deferred paid chain', async t => {
  // trend -> research -> script(agent:'codex', NOT 'existing') -> storyboard -> layout ->
  // generate -> render. script's non-'existing' agent means prepareCandidate rejects
  // [..., script, ..., generate] selected together (contract 5C/addendum A's "fresh script +
  // generate" rule), so the full mode:'all' selection must defer generate+render.
  const f = await fixture(t, { generation: true, layoutNode: true }), { page, base, workflow, waitRun, providerCalls, prompts } = f;
  const NOTICE = '비용이 드는 생성은 준비 단계가 끝난 뒤 다시 실행해 비용을 확인합니다.';

  // --- First run (toolbar, nothing completed yet): the free prefix runs immediately, no
  // consent dialog, zero provider calls. ---
  const firstPlan = planPending(page, base, workflow.id);
  const firstRun = runPending(page, base, workflow.id);
  await page.locator('[data-wf-action=run]').click();
  const firstPlanResponse = await firstPlan;
  assert.equal(firstPlanResponse.status(), 200, `POST /plan for run-all: ${await firstPlanResponse.text()}`);
  assert.equal(firstPlanResponse.request().postDataJSON().selectedStages, undefined, 'no UI path ever POSTs a client-built selectedStages');
  const firstPlanBody = await firstPlanResponse.json();
  assert.equal(firstPlanBody.requiresGeneration, false, 'the deferred paid chain must not require consent on this prepare-first plan');
  assert.deepEqual(firstPlanBody.deferredStages, ['generate', 'render'], 'generate and its descendant render are deferred, topological order');
  assert.equal(firstPlanBody.notice, NOTICE);
  assert.deepEqual(firstPlanBody.selectedStages, ['trend', 'research', 'script', 'storyboard', 'layout'], 'the free preparatory prefix: everything except the deferred paid chain');
  // No consent dialog: the client must proceed straight to /run with the SAME execution intent.
  assert.equal(await page.locator('#wf-confirm-dialog[open]').count(), 0, 'deferring must never open the paid-generation consent dialog');
  const firstRunResponse = await firstRun;
  assert.equal(firstRunResponse.status(), 202, `POST /run for run-all: ${await firstRunResponse.text()}`);
  const firstRunBody = firstRunResponse.request().postDataJSON();
  assert.deepEqual(firstRunBody.execution, { mode: 'all', refresh: false }, 'the SAME execution intent from the plan, not a client-built selectedStages for just the prefix');
  assert.equal(firstRunBody.selectedStages, undefined);
  assert.deepEqual(providerCalls, [], 'no provider call for the free (non-generation) prefix');
  await page.locator('#toast.visible').waitFor({ timeout: 4000 }).catch(() => {});
  assert.match(await page.locator('body').innerText(), new RegExp(`${NOTICE} 5개 노드를 먼저 실행합니다\\.`));
  const firstRun_ = await waitRun((await firstRunResponse.json()).id);
  assert.equal(firstRun_.status, 'completed', JSON.stringify(firstRun_));
  assert.deepEqual(firstRun_.nodeRuns.filter(n => ['trend', 'research', 'script', 'storyboard', 'layout'].includes(n.nodeId)).map(n => n.status), ['completed', 'completed', 'completed', 'completed', 'completed'], 'the free prefix actually executed');
  assert.equal(prompts.length, 1, 'script executed exactly once as part of the free prefix');
  for (const id of ['generate', 'render']) {
    const record = firstRun_.nodeRuns.find(n => n.nodeId === id);
    assert.equal(record.status, 'skipped', `${id} is deferred, not run, in this first execution`);
  }
  await page.waitForFunction(() => !document.querySelector('[data-wf-action="run"]')?.disabled);
  for (const id of ['trend', 'research', 'script', 'storyboard', 'layout']) assert.equal(await cardState(page, id), 'completed', `${id} card must reach completed`);

  // --- Second run (toolbar run-all again): the free prefix is now completed, so this
  // triggers the keep/refresh/cancel decision (contract 2.3). The plan's selectedStages is
  // already the final computed selection regardless of needsDecision; with the free prefix
  // reused (not reselected), script is no longer part of THIS selection, so prepareCandidate's
  // rejection no longer applies and this plan is NOT deferred: requiresGeneration:true,
  // deferredStages empty. run-all-keep acts directly on this already-fetched plan (no second
  // /plan call; see runFromPlan({mode:'all',refresh:false}, runAllDialog) in the action
  // handler), opening the existing consent dialog; cancelling posts nothing.
  const secondPlan = planPending(page, base, workflow.id);
  await page.locator('[data-wf-action=run]').click();
  const secondPlanResponse = await secondPlan;
  assert.equal(secondPlanResponse.status(), 200, `POST /plan for run-all (second click): ${await secondPlanResponse.text()}`);
  const secondPlanBody = await secondPlanResponse.json();
  assert.equal(secondPlanBody.needsDecision, true, 'completed nodes now exist: the keep/refresh/cancel decision is required');
  assert.deepEqual(secondPlanBody.completedNodeIds.sort(), ['layout', 'research', 'script', 'storyboard', 'trend']);
  assert.deepEqual(secondPlanBody.selectedStages, ['generate', 'render'], 'the previously-free prefix is reused (not reselected); only the deferred paid chain remains');
  assert.equal(secondPlanBody.requiresGeneration, true, 'nothing left to defer: the only remaining selection IS the paid chain');
  assert.deepEqual(secondPlanBody.deferredStages ?? [], [], 'no further deferral once the free prefix is already satisfied');
  const dialog = page.locator('#wf-run-all-dialog[open]');
  await dialog.waitFor();
  const writesBeforeConsent = f.writes.length;
  await dialog.getByRole('button', { name: '완료 노드 유지, 남은 노드만 실행', exact: true }).click();
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  assert.deepEqual(f.writes.slice(writesBeforeConsent).filter(w => /\/run$/.test(w.path)), [], 'opening consent for the deferred chain must not have posted /run yet');
  assert.deepEqual(providerCalls, [], 'still no provider call before explicit confirmation');
  const writesBeforeCancel = f.writes.length;
  await page.locator('#wf-confirm-dialog [data-wf-action=close-dialog]').click();
  assert.deepEqual(f.writes.slice(writesBeforeCancel), [], 'cancelling the deferred-chain consent dialog must issue zero requests');
});

// ===========================================================================
// M8 - paid generation always requires existing consent, for both entry points
// ===========================================================================
test('M8: run-node and run-all on a graph with a generate node always open the existing consent dialog; nothing starts and no provider call happens until confirm', async t => {
  // scriptAgent:'existing' so nothing in this graph needs free preparation (contract 5C): both
  // entry points always require immediate consent for the generate node, which is what this
  // test checks; M11 covers the deferred-preparation flow separately.
  const f = await fixture(t, { generation: true, scriptAgent: 'existing' }), { page, base, workflow, providerCalls } = f;

  // run-node directly on the generate node.
  await openNodeMenu(page, 'generate', 'right-click');
  const plan = planPending(page, base, workflow.id);
  await item(page, '실행').click();
  const planResponse = await plan;
  assert.equal(planResponse.status(), 200, `POST /plan for generate node: ${await planResponse.text()}`);
  const planBody = await planResponse.json();
  assert.equal(planBody.requiresGeneration, true);
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  assert.deepEqual(f.writes.filter(w => /\/run$/.test(w.path)), [], 'opening the consent dialog must not have posted /run yet');
  assert.deepEqual(providerCalls, [], 'no provider call before explicit confirmation');
  await page.locator('#wf-confirm-dialog [data-wf-action=close-dialog]').click();
  assert.deepEqual(f.writes.filter(w => /\/run$/.test(w.path)), [], 'cancel leaves nothing started');
  assert.deepEqual(providerCalls, []);

  // run-all including the generate node.
  await openCanvasMenu(page, 'right-click');
  const allPlan = planPending(page, base, workflow.id);
  await item(page, '전체 실행').click();
  const allPlanResponse = await allPlan;
  assert.equal(allPlanResponse.status(), 200, `POST /plan for run-all with a generate node: ${await allPlanResponse.text()}`);
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  assert.deepEqual(f.writes.filter(w => /\/run$/.test(w.path)), [], 'run-all with a generate node must also stop at consent, not POST /run');
  assert.deepEqual(providerCalls, []);
  await page.locator('#wf-confirm-dialog [data-wf-action=close-dialog]').click();
  assert.deepEqual(f.writes.filter(w => /\/run$/.test(w.path)), []);
  assert.deepEqual(providerCalls, [], 'cancel on run-all leaves nothing started and calls no provider');
});

// ===========================================================================
// U1-U10 - independent UI review fixes (agent://UiReview-2, local://progress-MenuImpl3b.md)
// ===========================================================================
test('U3: starting a prepare-first (deferred) run from inside an already-open paid-generation consent dialog closes the dialog, clears consent state (reopening needs a fresh quote), and never POSTs execution:null/missing', async t => {
  // scriptAgent:'existing' keeps the INITIAL quote/consent-dialog-open path non-deferred and
  // realistic; the deferred plan from prepare-generation-source is then injected via route
  // interception (Main's exact spec) rather than engineered through a hard-to-reach server
  // graph state -- this test exercises the CLIENT's state handling, not server deferral logic.
  const f = await fixture(t, { generation: true, scriptAgent: 'existing' }), { page, base, workflow, providerCalls } = f;
  const allWrites = [];
  await page.route(`${base}/api/workflows/${workflow.id}/**`, async route => {
    if (!['POST'].includes(route.request().method())) return route.continue();
    allWrites.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return route.continue();
  });

  // Open the dialog normally and load a REAL full-candidate quote (sets generationEstimate +
  // generationConsentSnapshot), exactly as a user would before ever touching prepare-generation-source.
  await page.locator('[data-wf-action=run]').click();
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  await page.selectOption('#wf-disclosure', 'false');
  await page.fill('#wf-disclosure-rationale', 'No synthetic media disclosure required for this fixture run.');
  const quotePending = page.waitForResponse(r => r.url() === `${base}/api/workflows/${workflow.id}/quote` && r.request().method() === 'POST');
  await page.locator('[data-wf-action=quote-generation]').click();
  const quoteResponse = await quotePending;
  assert.equal(quoteResponse.status(), 200, `POST /quote: ${await quoteResponse.text()}`);
  await page.locator('[data-generation-quote]').waitFor();
  assert.deepEqual(providerCalls.filter(call => call === 'create' || call === 'submit'), [], 'a quote is a read-only cost estimate; it may call the provider for schema/estimate, but must never create or submit a paid job');

  // Intercept ONLY the next /plan (prepare-generation-source's own request) with a mocked
  // prepare-first (deferred) response, and the following /run with a synthetic 202 record --
  // deterministic, no real server deferral engineering, no provider calls either way.
  const mockRun = { id: 'mock-prepare-first-run', status: 'completed', workflowId: workflow.id, episodeId: f.episode.id, workflowVersion: workflow.version, episodeVersion: f.episode.version, selectedStages: ['trend', 'research', 'script', 'storyboard'], execution: { mode: 'node', targetNodeId: 'generate' }, nodeRuns: [] };
  await page.route(`${base}/api/workflows/${workflow.id}/plan`, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      mode: 'node', targetNodeId: 'generate', refresh: false, blocked: false,
      selectedStages: ['trend', 'research', 'script', 'storyboard'], resumeRunId: null,
      requiresGeneration: false, needsDecision: false, nothingToRun: false,
      completedNodeIds: [], staleNodeIds: [], skippedNodeIds: [],
      deferredStages: ['generate'], notice: '비용이 드는 생성은 준비 단계가 끝난 뒤 다시 실행해 비용을 확인합니다.',
      nodes: ['trend', 'research', 'script', 'storyboard'].map(nodeId => ({ nodeId, type: nodeId, action: 'run', reason: '이번 실행에서 실행됩니다' })),
    }),
  }), { times: 1 });
  await page.route(`${base}/api/workflows/${workflow.id}/run`, route => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(mockRun) }), { times: 1 });
  await page.locator('[data-wf-action=prepare-generation-source]').click();
  await page.locator('#toast.visible').waitFor({ timeout: 4000 }).catch(() => {});

  // The dialog must be closed and consent state cleared -- not just visually hidden.
  assert.equal(await page.locator('#wf-confirm-dialog[open]').count(), 0, 'the consent dialog must be closed once the prefix run starts, not left dangling');
  assert.match(await page.locator('body').innerText(), /비용이 드는 생성은 준비 단계가 끝난 뒤 다시 실행해 비용을 확인합니다\. 4개 노드를 먼저 실행합니다\./, 'notice + count toast from the mocked deferred plan');

  // Reopening (run-node on generate again, real server this time) must require a FRESH quote:
  // the stale generationEstimate/generationConsentSnapshot from before must be gone, so the
  // dialog reopens with no quote block and a disabled confirm button -- it cannot be pressed on data.
  await openNodeMenu(page, 'generate', 'right-click');
  const reopenPlan = planPending(page, base, workflow.id);
  await item(page, '실행').click();
  const reopenPlanResponse = await reopenPlan;
  assert.equal(reopenPlanResponse.status(), 200, `POST /plan for generate (reopen, real server): ${await reopenPlanResponse.text()}`);
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  assert.equal(await page.locator('[data-generation-quote]').count(), 0, 'reopening must not reuse the stale quote -- a fresh one is required');
  const confirmButton = page.locator('#wf-confirm-dialog [data-wf-action=confirm-generation-run]');
  assert.equal(await confirmButton.isDisabled(), true, 'the confirm button cannot be pressed on stale consent data; a fresh quote is required first');
  assert.deepEqual(providerCalls.filter(call => call === 'create' || call === 'submit'), [], 'no paid generation job was ever created or submitted anywhere in this whole scenario');

  // No request anywhere in this entire scenario ever carried execution:null or a missing
  // execution field -- the real bug class U3 exists to prevent.
  const planOrRunWrites = allWrites.filter(w => /\/(plan|run|quote)$/.test(w.path));
  assert.ok(planOrRunWrites.length > 0, 'sanity: some plan/run/quote writes were actually recorded');
  for (const write of planOrRunWrites) assert.notEqual(write.body?.execution, null, `${write.path} must never carry execution:null`);
});

test('U4: a coded 409 (active_run/skipped_target/skipped_prerequisite/nothing_to_run/publish_requires_review/generation_unresolved) shows the server Korean message; an uncoded 409 shows the generic "changed by another task" toast -- both the toolbar click path and the context-menu item path', async t => {
  const f = await fixture(t), { page, base, workflow } = f;
  // The two catch sites currently carry two DIFFERENT generic-conflict strings (confirmed from
  // source, not assumed): contextAction's (context-menu items) vs the outer click listener's
  // (toolbar/canvas-menu buttons). Flagged to Main/MenuImpl3 as a possible unintentional
  // inconsistency between two near-duplicate messages; not a test bug to paper over -- each
  // path is asserted against its own actual current text.
  const GENERIC_CONTEXT_MENU = '워크플로우가 다른 작업에서 변경됐습니다. 현재 초안을 보존했습니다.';
  const GENERIC_TOOLBAR = '워크플로우가 다른 작업에서 변경됐습니다. 현재 편집을 보존했습니다. 새 이름으로 복사하거나 변경을 되돌린 뒤 새로고침하세요.';
  const cases = [
    { code: undefined, message: 'A plain version-conflict message a client should never show verbatim' },
    { code: 'active_run', message: '이 에피소드에 실행 중인 워크플로우가 있습니다. 끝난 뒤 다시 시도하세요.' },
    { code: 'skipped_target', message: '건너뛰기가 설정된 노드입니다. 건너뛰기를 해제한 뒤 실행하세요.' },
    { code: 'skipped_prerequisite', message: '건너뛴 선행 노드에 저장된 결과가 없어 실행할 수 없습니다.' },
    { code: 'nothing_to_run', message: '실행할 노드가 없습니다. 완료된 결과를 유지합니다.' },
    { code: 'publish_requires_review', message: '게시는 같은 결과에 대한 승인된 검토가 있어야 실행할 수 있습니다.' },
    { code: 'generation_unresolved', message: '해결되지 않은 생성 작업이 있습니다. 먼저 상태를 확인하세요.' },
  ];
  const mock409 = ({ code, message }) => route => route.fulfill({
    status: 409, contentType: 'application/json',
    body: JSON.stringify(code ? { error: message, code } : { error: message }),
  });
  for (const testCase of cases) {
    // --- Toolbar click path: [data-wf-action=run] -> requestRunAll -> requestPlan -> /plan. ---
    const expectedToolbar = testCase.code ? testCase.message : GENERIC_TOOLBAR;
    await page.route(`${base}/api/workflows/${workflow.id}/plan`, mock409(testCase), { times: 1 });
    const toolbarPlan = planPending(page, base, workflow.id);
    await page.locator('[data-wf-action=run]').click();
    await toolbarPlan;
    await page.locator('#toast.visible').waitFor({ timeout: 4000 });
    assert.equal(await page.locator('#toast').innerText(), expectedToolbar, `toolbar path, code=${testCase.code ?? '(none)'}`);
    assert.equal(await page.locator('#wf-confirm-dialog[open]').count(), 0, 'a 409 must never open any dialog');
    assert.equal(await page.locator('#wf-run-all-dialog[open]').count(), 0, 'a 409 must never open any dialog');

    // --- Context-menu item path: right-click a node -> '실행' -> executionRequest -> /plan. ---
    const expectedMenu = testCase.code ? testCase.message : GENERIC_CONTEXT_MENU;
    await openNodeMenu(page, 'script', 'right-click');
    await page.route(`${base}/api/workflows/${workflow.id}/plan`, mock409(testCase), { times: 1 });
    const menuPlan = planPending(page, base, workflow.id);
    await item(page, '실행').click();
    await menuPlan;
    await page.locator('#toast.visible').waitFor({ timeout: 4000 });
    assert.equal(await page.locator('#toast').innerText(), expectedMenu, `context-menu path, code=${testCase.code ?? '(none)'}`);
    assert.equal(await page.locator('#wf-confirm-dialog[open]').count(), 0, 'a 409 must never open any dialog');
    assert.equal(await menu(page).count(), 0, 'the context menu itself must have closed on click regardless of the eventual error');
  }
});

// ===========================================================================
// U10 - node-state labels for changes_requested/cancelled; exactly one badge per
// card; an unselected never-run node always shows 미실행, never 건너뜀
// ===========================================================================
test('U10: changes_requested shows 수정 요청 (not styled as failed), cancelled shows 취소됨 (not idle/미실행), both on the node card badge and the focused-node status line; exactly one state badge per node card; a never-run node always shows 미실행, never 건너뜀', async t => {
  const f = await fixture(t), { page, base, api, workflow, episode, waitRun } = f;
  // Harvest one real, schema-correct nodeRun record (trend has no ancestors: cheap, fast,
  // deterministic -- no provider/network calls). Used as a template for the synthetic entries
  // below rather than hand-inventing a shape.
  const primed = await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'trend' } });
  await waitRun(primed.id);
  const realRuns = await api(`/api/workflows/${workflow.id}/runs`);
  const realRun = realRuns.find(run => run.id === primed.id);
  const trendRecord = realRun.nodeRuns.find(node => node.nodeId === 'trend');
  assert.equal(trendRecord.status, 'completed', 'sanity: harvested a real completed nodeRun to clone the shape from');

  // Synthetic run: trend keeps its real completed record (sanity anchor); script is cloned from
  // trend's own shape with status forced to changes_requested; storyboard likewise forced to
  // cancelled. research is deliberately ABSENT from nodeRuns -- genuinely never run, not merely
  // unselected-with-a-record, matching M10's finding for the idle/미실행 case.
  const cloneAs = (nodeId, type, status) => ({ ...trendRecord, nodeId, type, status });
  const syntheticRun = { ...realRun, nodeRuns: [trendRecord, cloneAs('script', 'script', 'changes_requested'), cloneAs('storyboard', 'storyboard', 'cancelled')] };
  await page.route(`${base}/api/workflows/${workflow.id}/runs`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([syntheticRun]) }));
  await page.locator('[data-wf-action="refresh-runs"]').click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.dataset.nodeState === 'changes_requested', 'script');

  // Card badge: changes_requested -> 수정 요청, not styled as a failure.
  assert.equal(await cardState(page, 'script'), 'changes_requested');
  assert.match(await stateBadge(page, 'script').innerText(), /^수정 요청$/);
  assert.doesNotMatch(await stateBadge(page, 'script').getAttribute('class'), /\bfailed\b/, 'changes_requested must not be styled as a failure');

  // Card badge: cancelled -> 취소됨, not idle/실행 전.
  assert.equal(await cardState(page, 'storyboard'), 'cancelled');
  assert.match(await stateBadge(page, 'storyboard').innerText(), /^취소됨$/);
  assert.notEqual(await cardState(page, 'storyboard'), 'idle');

  // Focused-node status line mirrors the same labels.
  await header(page, 'script').click();
  assert.match(await page.locator('#wf-focused-node [data-focused-status]').innerText(), /수정 요청/);
  await header(page, 'storyboard').click();
  assert.match(await page.locator('#wf-focused-node [data-focused-status]').innerText(), /취소됨/);

  // research was never run at all (absent from nodeRuns, no retained status anywhere): 미실행,
  // never 건너뜀, and never styled as a user skip.
  assert.equal(await cardState(page, 'research'), 'idle');
  assert.match(await stateBadge(page, 'research').innerText(), /^미실행$/);
  assert.doesNotMatch(await stateBadge(page, 'research').innerText(), /건너뜀/);
  assert.equal(await node(page, 'research').evaluate(el => el.classList.contains('is-skipped')), false);

  // Exactly one state badge per node card, for every node in the graph.
  for (const article of await page.locator('.wf-node').all()) {
    assert.equal(await article.locator('[data-testid="wf-node-badge"]').count(), 1, 'exactly one state badge per node card');
  }
  assert.deepEqual(f.writes, [], 'inspecting node states must never write');
});

// ===========================================================================
// U7 - read-only session: recent-runs-more/history-versions-more/history-page/
// refresh-run-history/refresh-run-detail/restore-workflow(opener)/estimate-ack still
// work and issue no mutation; run/skip/add/delete/save stay disabled
// ===========================================================================
test('U7: a non-admin/read-only session keeps the read-only expanders working (recent-runs-more, history-versions-more, history-page, refresh-run-history, refresh-run-detail, restore-workflow dialog opener, estimate-ack) with zero mutation requests, while mutating actions (run, skip, add/delete node, save) remain disabled', async t => {
  const f = await fixture(t), { page, base, api, workflow, episode, waitRun } = f;
  // Seed > 5 runs (recent-runs-more needs > 3) by repeatedly running the free, ancestor-less
  // 'trend' node via direct API calls -- cheap, fast, deterministic, no provider calls.
  for (let i = 0; i < 6; i++) {
    const run = await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'trend' } });
    await waitRun(run.id);
  }
  // Seed > 5 saved versions (the template copy already snapshots v1, so 6 saves reach v7).
  let expectedVersion = workflow.version;
  const baseNodes = workflow.nodes;
  for (let i = 0; i < 6; i++) {
    const saved = await api(`/api/workflows/${workflow.id}`, 'PUT', {
      name: workflow.name,
      nodes: baseNodes.map(node => node.id === 'trend' ? { ...node, x: node.x + i + 1 } : node),
      edges: workflow.edges,
      expectedVersion,
    });
    expectedVersion = saved.version;
  }

  // This server has no non-admin role at all (server/app.mjs sessionState(): every authenticated
  // session is role:'admin'; app.js's own canMutate() reads ONLY
  // state.session?.authenticated===true, and state.session is populated exclusively by the one
  // real GET /api/state response -- a 401 instead replaces #app with the login form entirely,
  // the same unreachability M9's own comment documents for "logged out but still viewing").
  // A literal authenticated-but-non-admin, UI-visible session cannot be constructed through the
  // real UI in this codebase. Smallest honest hook: intercept that one always-200 GET and
  // rewrite ONLY its session field to a non-mutating shape -- the exact field canMutate() reads,
  // nothing else faked; the HTTP status stays 200 so the UI renders fully.
  await page.route(`${base}/api/state`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.session = { authenticated: false, role: null, canMutate: false };
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await f.open();
  await page.locator('[data-testid="session-capability"]').waitFor();
  assert.equal(await page.locator('[data-testid="session-capability"]').innerText(), '로그인 확인 필요', 'the UI honestly reports the non-mutating session, not a silent admin default');

  // Mutating actions stay blocked: toolbar run/save, and every node/canvas context-menu item
  // (openContextMenu's own `locked` gate disables all node items uniformly when
  // mutationReason() is non-empty -- the same mechanism M9a exercises for an archived project).
  assert.equal(await page.locator('[data-wf-action="run"]').isDisabled(), true, 'toolbar run-all must be disabled in a read-only session');
  assert.equal(await page.locator('[data-wf-action="save"]').isDisabled(), true, 'toolbar save must be disabled in a read-only session');
  await openNodeMenu(page, 'trend', 'right-click');
  assert.equal(await item(page, '실행').isDisabled(), true);
  assert.equal(await item(page, '건너뛰기').isDisabled(), true);
  assert.equal(await item(page, '노드 추가…').isDisabled(), true);
  assert.equal(await item(page, '노드 제거…').isDisabled(), true);
  await page.keyboard.press('Escape');
  await openCanvasMenu(page, 'right-click');
  assert.equal(await item(page, '전체 실행').isDisabled(), true);
  assert.equal(await item(page, '그래프 저장').isDisabled(), true);
  await page.keyboard.press('Escape');

  // recent-runs-more: expands 3 -> 6 visible rows, zero writes (#wf-current-runs is open by
  // default).
  assert.equal(await page.locator('#wf-recent-runs [data-testid="wf-recent-run"]').count(), 3);
  await page.locator('#wf-recent-runs [data-wf-action="recent-runs-more"]').click();
  assert.equal(await page.locator('#wf-recent-runs [data-testid="wf-recent-run"]').count(), 6);

  // history-versions-more + restore-workflow (dialog opener only): open the version-history
  // section, expand past the default 5, select an older version, confirm restore-workflow
  // enables and opens the dialog with zero writes, confirm-restore (the real mutating action)
  // stays disabled.
  await page.locator('#wf-workflow-history > summary').click();
  assert.equal(await page.locator('.history-version').count(), 5);
  await page.locator('[data-wf-action="history-versions-more"]').click();
  assert.equal(await page.locator('.history-version').count(), 7);
  await page.locator('.history-version').nth(1).click();
  const restoreButton = page.locator('[data-wf-action="restore-workflow"]');
  assert.equal(await restoreButton.isDisabled(), false, 'restore-workflow is a dialog opener, not gated by the session lock');
  await restoreButton.click();
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  assert.equal(await page.locator('[data-wf-action="confirm-restore"]').isDisabled(), true, 'the real mutating restore action stays blocked');
  await page.keyboard.press('Escape');
  await page.locator('#wf-confirm-dialog[open]').waitFor({ state: 'hidden' });

  // history-page / refresh-run-history / refresh-run-detail: open the full run-history section
  // (triggers one real GET), click the page button, click refresh, force one failed detail
  // fetch then retry it -- all GET-only.
  await page.locator('#wf-run-history > summary').click();
  await page.locator('.wf-history-record').first().waitFor();
  await page.locator('.wf-history-pagination').getByRole('button', { name: '1', exact: true }).click();
  await page.locator('[data-wf-action="refresh-run-history"]').click();
  await page.locator('.wf-history-record').first().waitFor();
  const firstRunId = await page.locator('.wf-history-record').first().getAttribute('data-run-id');
  await page.route(`${base}/api/workflow-runs/${firstRunId}`, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture-forced failure' }) }), { times: 1 });
  await page.locator('.wf-history-record').first().locator('summary').click();
  await page.locator(`[data-wf-action="refresh-run-detail"][data-id="${firstRunId}"]`).waitFor();
  await page.locator(`[data-wf-action="refresh-run-detail"][data-id="${firstRunId}"]`).click();
  await page.waitForFunction(id => document.querySelector(`[data-run-detail="${id}"]`)?.textContent.includes('노드별 실행 기록'), firstRunId);

  // estimate-ack: every real entry point into the paid-generation consent dialog (run-node,
  // run-all, prepare-generation-source) is itself a mutating action gated by mutationReason()
  // BEFORE any /plan request fires (proven above: toolbar run and the node-menu 실행 item are
  // both disabled), so the checkbox genuinely cannot render in a reachable read-only session.
  // Proven live instead, against the real production gate rather than source text: inject a
  // real data-wf-action="estimate-ack" control (plus a genuinely-mutating sibling as a
  // discriminating control) and let the live MutationObserver-driven applySessionControls()
  // process both.
  const probeResult = await page.evaluate(async () => {
    const readonly = document.createElement('button');
    readonly.type = 'button'; readonly.dataset.wfAction = 'estimate-ack'; readonly.id = 'u7-probe-readonly';
    const mutating = document.createElement('button');
    mutating.type = 'button'; mutating.dataset.wfAction = 'confirm-generation-run'; mutating.id = 'u7-probe-mutating';
    document.body.append(readonly, mutating);
    await new Promise(resolve => setTimeout(resolve, 50));
    const result = { readonlyDisabled: readonly.disabled, mutatingDisabled: mutating.disabled };
    readonly.remove(); mutating.remove();
    return result;
  });
  assert.equal(probeResult.readonlyDisabled, false, 'estimate-ack is exempt from the session-mutation gate (readWorkflowActions), same mechanism proven live above');
  assert.equal(probeResult.mutatingDisabled, true, 'a genuinely mutating action name IS disabled by the same live gate, proving the check actually discriminates');

  assert.deepEqual(f.writes, [], 'no mutation request was ever issued in this read-only session');
});

// ===========================================================================
// U9 - Cancel/Escape on the run-all dialog and the paid-generation consent dialog
// return focus to the element that opened them (toolbar run, canvas-menu anchor,
// node-menu control); Escape on the consent dialog also clears consent state
// (reopening needs a fresh /quote POST)
// ===========================================================================
// U9a (toolbar), U9b (canvas-menu), U9c (node-menu) each verify Cancel AND Escape restore
// focus to the real opener. restoreOverlayFocus() (workflow.js L554-564) reads
// document.activeElement the instant the dialog's 'close' listener runs; that value is not
// guaranteed observable to Playwright in the exact same tick as the dialog reporting
// `hidden` (confirmed via a live timing probe: settles within 18-88ms of 'hidden', never
// longer, for every opener) -- all three assertions below poll via waitForActiveElement()
// instead of reading synchronously, so a transient mid-close value can never be mistaken
// for a real focus-restoration bug.
test('U9a: Cancel and Escape on #wf-run-all-dialog opened via the TOOLBAR run button both return focus to that toolbar button', async t => {
  const f = await fixture(t), { page, base, api, workflow, episode, waitRun } = f;
  const primed = await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'trend' } });
  await waitRun(primed.id);
  await page.locator('[data-wf-action="refresh-runs"]').click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.dataset.nodeState === 'completed', 'trend');
  for (const closeVia of ['Escape', 'cancel-button']) {
    const plan = planPending(page, base, workflow.id);
    await page.locator('[data-wf-action="run"]').click();
    await plan;
    const dialog = page.locator('#wf-run-all-dialog[open]');
    await dialog.waitFor();
    if (closeVia === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await waitForActiveElement(page, () => document.activeElement?.dataset?.wfAction === 'run', `toolbar opener (${closeVia}): focus must return to the toolbar run button`);
  }
});

test('U9b: Cancel and Escape on #wf-run-all-dialog opened via the canvas context-menu "전체 실행" entry both return focus to the canvas', async t => {
  const f = await fixture(t), { page, base, api, workflow, episode, waitRun } = f;
  const primed = await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'trend' } });
  await waitRun(primed.id);
  await page.locator('[data-wf-action="refresh-runs"]').click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.dataset.nodeState === 'completed', 'trend');
  for (const closeVia of ['Escape', 'cancel-button']) {
    await openCanvasMenu(page, 'right-click');
    const plan = planPending(page, base, workflow.id);
    await item(page, '전체 실행').click();
    await plan;
    const dialog = page.locator('#wf-run-all-dialog[open]');
    await dialog.waitFor();
    if (closeVia === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await waitForActiveElement(page, () => document.activeElement?.id === 'workflow-canvas', `canvas-menu opener (${closeVia}): focus must return to the canvas`);
  }
});

test('U9c: Cancel and Escape on #wf-confirm-dialog opened via the node context-menu "실행" entry on a generate node both return focus to that node\'s more-menu control; Escape also clears consent state so reopening needs a fresh /quote POST', async t => {
  const f = await fixture(t, { generation: true, scriptAgent: 'existing' }), { page, base, workflow, providerCalls } = f;
  const getQuote = async () => {
    await page.selectOption('#wf-disclosure', 'false');
    await page.fill('#wf-disclosure-rationale', 'No synthetic media disclosure required for this fixture run.');
    const quotePending = page.waitForResponse(r => r.url() === `${base}/api/workflows/${workflow.id}/quote` && r.request().method() === 'POST');
    await page.locator('[data-wf-action=quote-generation]').click();
    const response = await quotePending;
    assert.equal(response.status(), 200, `POST /quote: ${await response.text()}`);
    await page.locator('[data-generation-quote]').waitFor();
    return response;
  };

  // Cancel-button path.
  await openNodeMenu(page, 'generate', 'right-click');
  let plan = planPending(page, base, workflow.id);
  await item(page, '실행').click();
  await plan;
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  await getQuote();
  await page.locator('#wf-confirm-dialog [data-wf-action=close-dialog]').click();
  await page.locator('#wf-confirm-dialog[open]').waitFor({ state: 'hidden' });
  await waitForActiveElement(page, () => document.activeElement?.dataset?.wfAction === 'node-menu' && document.activeElement?.dataset?.id === 'generate', 'node-menu opener (cancel button): focus must return to the generate node\'s own more-menu control');

  // Escape path -- also proves consent state was cleared: reopening must need a FRESH /quote
  // (no stale [data-generation-quote]), and clicking quote-generation again must fire a NEW
  // POST /quote (not reuse the old response).
  await openNodeMenu(page, 'generate', 'right-click');
  plan = planPending(page, base, workflow.id);
  await item(page, '실행').click();
  await plan;
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  await getQuote();
  await page.keyboard.press('Escape');
  await page.locator('#wf-confirm-dialog[open]').waitFor({ state: 'hidden' });
  await waitForActiveElement(page, () => document.activeElement?.dataset?.wfAction === 'node-menu' && document.activeElement?.dataset?.id === 'generate', 'node-menu opener (Escape): focus must return to the generate node\'s own more-menu control');

  await openNodeMenu(page, 'generate', 'right-click');
  plan = planPending(page, base, workflow.id);
  await item(page, '실행').click();
  await plan;
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  assert.equal(await page.locator('[data-generation-quote]').count(), 0, 'Escape must have cleared the stale quote -- reopening never reuses it');
  await getQuote();
  await page.keyboard.press('Escape');

  assert.deepEqual(providerCalls.filter(call => call === 'create' || call === 'submit'), [], 'no paid generation job was ever created or submitted anywhere in this scenario');
});

// ===========================================================================
// F1 (independent UI review, 2026-10-28) -- confirmed from live source: the toolbar
// 실행 취소/다시 실행 (undo/redo) buttons already exist (.wf-toolbar .wf-save-state, never
// removed by the M1 menu compaction -- they were never in the context menu to begin with)
// and already have their own disabled-state wiring (workflow.js L1110-1111). Zero test
// coverage existed for either their real behavior or their disabled state before this.
// ===========================================================================
test('F1: toolbar 실행 취소/다시 실행 (undo/redo) buttons perform real draft undo/redo through the same handler as Ctrl/⌘+Z, and disabled state is gated independently by drafts.canUndo/canRedo AND the shared mutation lock', async t => {
  const f = await fixture(t, { runGate: true }), { page, base, workflow } = f;
  const undoButton = page.locator('[data-wf-action="undo"]');
  const redoButton = page.locator('[data-wf-action="redo"]');
  assert.equal(await undoButton.count(), 1, 'exactly one toolbar undo button');
  assert.equal(await redoButton.count(), 1, 'exactly one toolbar redo button');
  assert.equal((await undoButton.innerText()).trim(), '↶ 실행 취소');
  assert.equal((await redoButton.innerText()).trim(), '↷ 다시 실행');
  assert.equal(await undoButton.isDisabled(), true, 'undo starts disabled: no draft history yet');
  assert.equal(await redoButton.isDisabled(), true, 'redo starts disabled: no draft history yet');

  const originalLabel = await header(page, 'trend').locator('.wf-node-label').innerText();
  await header(page, 'trend').click();
  await focusedButton(page, 'node-tools').click();
  const toolsDialog = page.locator('#wf-tools-dialog[open]');
  await toolsDialog.waitFor();
  await toolsDialog.locator('[data-wf-field="label"]').fill('Trend node EDITED');
  await page.keyboard.press('Escape');
  await toolsDialog.waitFor({ state: 'hidden' });
  assert.equal(await header(page, 'trend').locator('.wf-node-label').innerText(), 'Trend node EDITED', 'the label edit landed on the real node card, not just internal state');

  assert.equal(await undoButton.isDisabled(), false, 'undo must enable the instant a draft edit is recorded');
  assert.equal(await redoButton.isDisabled(), true, 'redo stays disabled: nothing has been undone yet');

  await undoButton.click();
  assert.equal(await header(page, 'trend').locator('.wf-node-label').innerText(), originalLabel, 'undo must actually revert the real edit (same handler as Ctrl/⌘+Z), not just flip a flag');
  assert.equal(await undoButton.isDisabled(), true, 'undo disables again once back at the draft baseline');
  assert.equal(await redoButton.isDisabled(), false, 'redo enables once there is an undone edit to reapply');

  await redoButton.click();
  assert.equal(await header(page, 'trend').locator('.wf-node-label').innerText(), 'Trend node EDITED', 'redo must actually reapply the real edit, not just flip a flag');
  assert.equal(await undoButton.isDisabled(), false, 'undo re-enables after redo');
  assert.equal(await redoButton.isDisabled(), true, 'redo disables again once fully replayed');

  // Isolate the shared mutation-lock branch (Boolean(mutationReason())) from the
  // drafts.canUndo/canRedo branch: canUndo is genuinely true right now (just proved above
  // via real revert/reapply), so if disabled state came ONLY from drafts state, a live run
  // could never affect it. Start a gated run (same mechanism as M9b) and confirm BOTH
  // buttons go disabled anyway -- proving the OR-ed mutationReason() check is real, not
  // redundant/dead code.
  const plan = planPending(page, base, workflow.id);
  const runP = runPending(page, base, workflow.id);
  await page.locator('[data-wf-action="run"]').click();
  await plan;
  const runResponse = await runP;
  await page.waitForFunction(() => ['running', 'queued'].includes(document.querySelector('[data-node-id="trend"]')?.dataset.nodeState));
  assert.equal(await undoButton.isDisabled(), true, 'a live run must disable undo even though drafts.canUndo is still true -- proves the mutationReason() branch actually gates it, not just drafts state');
  assert.equal(await redoButton.isDisabled(), true, 'a live run must disable redo too, via the same shared mutation lock');
  f.releaseRun();
  await f.waitRun((await runResponse.json()).id);
});

// ===========================================================================
// U5 - plan-time version pinning (workflow.js L1263-1267, comment "U5: the plan's pinned
// versions may be stale if a decision dialog sat open a while"): requestPlan() pins
// workflow.version/episode.version into the plan's closure once, at /plan time; runFromPlan()
// sends THAT pinned value to /run verbatim, never a freshly re-read one -- even if the
// server-side version has since moved on from another save/tab/operator while the decision
// dialog sat open. The client has no live-sync channel to learn about a cross-actor edit
// mid-dialog, so the REAL final authority is the server's own assertVersions()
// (server/workflows.mjs L529-533, invoked from both plan() L687 and start() L829) -- this
// test proves the server-enforced half end to end through the real UI and a genuine
// cross-actor race (a real second PUT, not a mocked response; U4 already covers generic-409
// toast rendering against a synthetic 409 in isolation, this proves the actual mechanism that
// produces one here).
// ===========================================================================
test('U5: a workflow version bump that lands server-side WHILE the run-all decision dialog is open is sent to /run verbatim as the version PINNED at plan time (not the now-current one); the server rejects it, the generic 409 toast shows, the stale dialog is gone, and no run is ever created', async t => {
  const f = await fixture(t), { page, base, api, workflow } = f;
  const GENERIC_TOOLBAR = '워크플로우가 다른 작업에서 변경됐습니다. 현재 편집을 보존했습니다. 새 이름으로 복사하거나 변경을 되돌린 뒤 새로고침하세요.';
  const listRuns = async () => { const result = await api(`/api/workflows/${workflow.id}/runs`); return Array.isArray(result) ? result : result.runs || []; };

  // Prime 'trend' complete so run-all has a real keep/refresh decision to make (same setup as M5b).
  await openNodeMenu(page, 'trend', 'right-click');
  const primePlan = planPending(page, base, workflow.id);
  const primeRun = runPending(page, base, workflow.id);
  await item(page, '실행').click();
  await primePlan;
  await f.waitRun((await (await primeRun).json()).id);
  await page.locator('[data-wf-action="refresh-runs"]').click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.dataset.nodeState === 'completed', 'trend');

  // Open the decision dialog: this is the exact moment requestPlan() pins the workflow version.
  const current = (await api('/api/workflows')).find(w => w.id === workflow.id);
  const pinnedVersion = current.version;
  await openCanvasMenu(page, 'right-click');
  const plan = planPending(page, base, workflow.id);
  await item(page, '전체 실행').click();
  const planResponse = await plan;
  assert.equal((await planResponse.json()).needsDecision, true);
  const dialog = page.locator('#wf-run-all-dialog[open]');
  await dialog.waitFor();

  // Simulate a real external edit landing WHILE the dialog is open (another tab/operator) --
  // a genuine PUT through a second authenticated context, not a mock, so the server's own
  // version truly advances past what the open dialog already pinned.
  const bumped = await api(`/api/workflows/${workflow.id}`, 'PUT', {
    name: `${current.name} (external edit while dialog open)`, nodes: current.nodes, edges: current.edges, expectedVersion: pinnedVersion,
  });
  assert.equal(bumped.version, pinnedVersion + 1, 'the external edit really did land server-side while the dialog was still open');
  const runsBefore = await listRuns();

  const run = runPending(page, base, workflow.id);
  await dialog.getByRole('button', { name: '완료 노드 유지, 남은 노드만 실행', exact: true }).click();
  const runResponse = await run;
  assert.equal(runResponse.status(), 409, `the stale pinned version must be rejected by the server, got ${runResponse.status()}: ${await runResponse.text()}`);
  assert.equal(runResponse.request().postDataJSON().expectedWorkflowVersion, pinnedVersion, 'the real request must carry the version PINNED when /plan ran, not the now-current server version -- proves genuine pinning, not a silent re-read at confirm time');

  await page.locator('#toast.visible').waitFor({ timeout: 4000 });
  assert.equal(await page.locator('#toast').innerText(), GENERIC_TOOLBAR, 'an uncoded 409 (assertVersions\' plain "Project changed since approval", no .code) must show the generic conflict toast');
  assert.equal(await page.locator('#wf-run-all-dialog[open]').count(), 0, 'the stale decision dialog must not be left open after the run it was for was rejected');
  assert.equal(await page.locator('#wf-confirm-dialog[open]').count(), 0, 'no paid-generation dialog leaks open either');
  assert.deepEqual(await listRuns(), runsBefore, 'no workflowRun was ever created from the rejected stale-version request');
});

test('U1: a delayed POST /skips response that resolves after the user switches project must never apply to the now-current workflow, must not leak into the new project\'s stash, and must apply retroactively to the originating project\'s own stash (visible on switching back) -- including when the destination owns no workflow of its own (template-preview mode is the real product contract here, confirmed byte-identical in HEAD -- not an empty state; no TypeError, and the previewed template must never pick up the foreign skip either)', async t => {
  const f = await fixture(t), { page, base, api, channel, episode: episodeA, workflow: workflowA } = f;
  // A second project (episode B) with its OWN workflow that reuses the SAME node id
  // ('research') as workflow A -- the strongest version of "must not leak": even an
  // identical node id in a different workflow must not pick up the foreign skip.
  const episodeB = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'U1 second project B', topic: 'Independent B content' });
  const templateB = await api('/api/workflows', 'POST', {
    name: 'U1 graph B', nodes: [{ id: 'research', type: 'research', label: 'B research', x: 40, y: 50, config: {} }], edges: [],
  });
  const workflowB = await api(`/api/workflows/${templateB.id}/copies`, 'POST', { channelId: channel.id, episodeId: episodeB.id, expectedTemplateVersion: templateB.version });
  // A third project (episode C) with NO workflow at all.
  const episodeC = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'U1 third project C (no workflow)', topic: 'Empty' });

  // B and C were created via direct API calls AFTER the page already loaded (fixture()'s own
  // open() ran before this test body), so the client's cached episode list does not know about
  // them yet. ONE full reload picks up the fresh /api/state (including B and C) and renders
  // them into the sidebar; EVERY subsequent switch in this test is then a plain in-app sidebar
  // click with NO reload -- a page.goto() would wipe the exact in-memory epoch/stash state
  // (contextEpoch, graphStashes) that this race condition and its fix live in, defeating the
  // whole point of the test.
  const reloadToEpisode = async target => {
    await page.goto(base);
    const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
    if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
    await channelButton.click();
    await page.locator(`[data-action=episode][data-id="${target.id}"]`).click();
  };
  // Keyboard-driven (focus + Enter), not .click(): a native <button> activates identically
  // either way, and this sidesteps an UNRELATED pointer-hit-testing issue (a lingering
  // info-tooltip from installInfoTooltips() -- public/context-menu.js, untouched by this test
  // file -- can sit over the sidebar and fail .click()'s "receives pointer events" check after
  // a prior hover). A keyboard activation targets document.activeElement directly with no
  // coordinate-based hit-test, so it is immune to that overlay regardless of cause -- it does
  // NOT change, suppress, or work around what THIS test's own race-condition assertions below
  // actually verify (the late /skips response + no-workflow-target behavior).
  const switchTo = async target => {
    await page.locator(`[data-action=episode][data-id="${target.id}"]`).press('Enter');
  };
  await reloadToEpisode(episodeA);
  await page.locator('#workflow-canvas').waitFor();
  assert.equal(await page.locator('#wf-select').inputValue(), workflowA.id, 'back on A with the client now aware of B and C');

  // --- Phase 1: toggle skip on A's 'research', hold the response, switch to B. ---
  let releaseSkip;
  const skipGate = new Promise(resolve => { releaseSkip = resolve; });
  let skipRouteActive = true;
  await page.route(`${base}/api/workflows/${workflowA.id}/skips`, async route => {
    if (!skipRouteActive) return route.continue();
    await skipGate;
    return route.continue();
  });
  await openNodeMenu(page, 'research', 'right-click');
  await item(page, '건너뛰기').click();
  await page.keyboard.press('Escape').catch(() => {});

  await switchTo(episodeB);
  await page.locator('#workflow-canvas').waitFor();
  assert.equal(await page.locator('#wf-select').inputValue(), workflowB.id, 'B\'s own workflow is now current');
  assert.equal(await node(page, 'research').evaluate(el => el.classList.contains('is-skipped')), false, 'B\'s same-id node must NOT show the skip that is still pending against A');
  assert.doesNotMatch(await stateBadge(page, 'research').innerText(), /건너뜀/, 'B\'s badge must not read 건너뜀 from A\'s still-pending toggle');

  releaseSkip();
  skipRouteActive = false;
  await page.waitForTimeout(300); // let the resolved (now-foreign) response finish applying to A's stash, not B's live state.
  assert.equal(await page.locator('#wf-select').inputValue(), workflowB.id, 'still on B: the late response must not have redirected the UI back to A');
  assert.equal(await node(page, 'research').evaluate(el => el.classList.contains('is-skipped')), false, 'B must still show no skip after the late response resolved');
  const bSkipped = (await api('/api/workflows')).find(w => w.id === workflowB.id).skippedNodes;
  assert.deepEqual(bSkipped ?? [], [], 'B\'s OWN server-side skippedNodes must never have been touched by a toggle that targeted A (undefined = never toggled, the server\'s own convention)');

  // Switch back to A (still no reload -- must come from the in-memory stash, not a server
  // round-trip, proving the fix applied the late response to A's stash entry): the
  // server-confirmed skip must be visible.
  await switchTo(episodeA);
  await page.locator('#workflow-canvas').waitFor();
  assert.equal(await page.locator('#wf-select').inputValue(), workflowA.id);
  assert.equal(await node(page, 'research').evaluate(el => el.classList.contains('is-skipped')), true, 'A must show the server-confirmed skip after switching back');
  const aSkipped = (await api('/api/workflows')).find(w => w.id === workflowA.id).skippedNodes;
  assert.deepEqual(aSkipped, ['research'], 'the skip genuinely landed on A server-side');

  // --- Phase 2: toggle skip on A's 'script', hold the response, switch to C (owns no workflow
  // of its own) -- must never throw (the fixture's own t.after asserts errors===[] at
  // teardown) and must not leak into whatever C actually shows.
  //
  // CORRECTION (2026-10-28, per Main, product-policy confirmed): this phase originally
  // asserted `.empty h2` for C. That is WRONG -- verified against source, not guessed:
  // WorkflowService always auto-seeds one global template on first boot when the store has
  // zero workflows (server/workflows.mjs ~L676: `if (!store.list('workflows').length)
  // store.create('workflows', defaultWorkflow())`), and chooseProjectGraph() (public/workflow.js)
  // falls back to previewing `templates[0]` (the first global template) whenever a project owns
  // zero workflows -- never null while any global template exists, which given the
  // unconditional auto-seed is always true on a real server. Confirmed BYTE-IDENTICAL between
  // `git show HEAD` and the working tree for both functions, and live-verified in the real DOM:
  // `.empty` never renders here, `#workflow-canvas` does, `#wf-select`'s selected option reads
  // "...· 템플릿 미리보기". Main confirmed this preview-over-empty behavior IS the intended
  // product contract. The corrected assertions below keep the exact same race-condition
  // substance (late response, zero leak, no exception) and target the REAL reachable state.
  let releaseSkip2;
  const skipGate2 = new Promise(resolve => { releaseSkip2 = resolve; });
  let skipRoute2Active = true;
  await page.route(`${base}/api/workflows/${workflowA.id}/skips`, async route => {
    if (!skipRoute2Active) return route.continue();
    await skipGate2;
    return route.continue();
  });
  await openNodeMenu(page, 'script', 'right-click');
  await item(page, '건너뛰기').click();
  await page.keyboard.press('Escape').catch(() => {});

  const cOwnedWorkflows = (await api('/api/workflows')).filter(w => w.episodeId === episodeC.id);
  assert.deepEqual(cOwnedWorkflows, [], 'episode C genuinely owns no workflow of its own, confirmed server-side -- independent of whatever the UI previews for it');

  await switchTo(episodeC);
  await page.locator('#workflow-canvas').waitFor();
  assert.match(await page.locator('#wf-select option:checked').innerText(), /템플릿 미리보기/, 'C (owning no workflow) must land in template-preview mode -- the real, reachable contract, not an empty state');
  assert.equal(await page.locator('.wf-node.is-skipped').count(), 0, 'nothing in C\'s own context was ever skipped -- the previewed template must show zero skip contamination from A\'s still-pending toggle');

  releaseSkip2();
  skipRoute2Active = false;
  await page.waitForTimeout(300); // let the late (now-foreign) response resolve while viewing C's template preview.
  assert.match(await page.locator('#wf-select option:checked').innerText(), /템플릿 미리보기/, 'still viewing a template preview after the late response resolves -- it must not have redirected the UI, opened a dialog, or thrown');
  assert.equal(await page.locator('.wf-node.is-skipped').count(), 0, 'the late response must still not have leaked a skip into whatever C is previewing');
  const stillCOwned = (await api('/api/workflows')).filter(w => w.episodeId === episodeC.id);
  assert.deepEqual(stillCOwned, [], 'the late response must not have created or attached any workflow to C');
});

// ===========================================================================
// M9 - mutation-locked state (archived project), and a live run disabling controls
// ===========================================================================
// Note: a literal "logged-out but still viewing the loaded workflow UI" state is
// not reachable in this app — every /api/* route 401s without a session (see
// server/app.mjs sessionState()), and app.js's response handler immediately
// clears state.session and calls showLogin() on any 401, replacing the whole
// UI with the login form rather than leaving it visible-but-disabled. The
// concretely reachable "mutation-locked, UI fully visible" case that exercises
// the SAME mutationReason()/canMutate() gate is an archived project (one of
// mutationReason()'s three real branches). See contract 2.2's "로그인 필요/저장
// 필요/etc via existing mutationReason" — this test exercises that mechanism
// through the branch that is actually reachable from the real UI.
test('M9a: an archived (mutation-locked) project cannot run or skip a node', async t => {
  const f = await fixture(t), { page, api, episode } = f;
  const archived = await api(`/api/episodes/${episode.id}/archive`, 'POST', { expectedVersion: episode.version });
  assert.equal(archived.status, 'archived');
  await page.goto(f.base); await page.locator('#app .shell').waitFor();
  await page.locator('[data-action=view][data-view=archived]').click();
  await page.locator(`[data-action=inspect-archived][data-id="${episode.id}"]`).click();
  await page.locator('#workflow-canvas').waitFor();
  await header(page, 'trend').click();
  await openNodeMenu(page, 'trend', 'right-click');
  const runItem = item(page, '실행'), skipItem = item(page, '건너뛰기');
  assert.equal(await runItem.isDisabled(), true, 'an archived (mutation-locked) project must disable run-node');
  assert.equal(await skipItem.isDisabled(), true, 'an archived (mutation-locked) project must disable toggle-skip');
  await page.keyboard.press('Escape');
  const runButton = focusedButton(page, 'run-node');
  if (await runButton.count()) assert.equal(await runButton.isDisabled(), true, 'the focused-node run control must also respect the mutation lock');
  assert.deepEqual(f.writes.filter(w => !/\/archive$/.test(w.path)), [], 'no mutation can be issued against an archived (mutation-locked) project');
});

test('M9b: a live run disables run-node and run-all', async t => {
  const f = await fixture(t, { runGate: true }), { page, base, workflow } = f;
  await openCanvasMenu(page, 'right-click');
  const plan = planPending(page, base, workflow.id);
  await item(page, '전체 실행').click();
  const planResponse = await plan;
  assert.equal(planResponse.status(), 200, `POST /plan for run-all: ${await planResponse.text()}`);
  const run = runPending(page, base, workflow.id);
  const runResponse = await run;
  const runId = (await runResponse.json()).id;
  // fetchTrends is gated: the run is deterministically held at "running" on its
  // very first node until releaseRun() is called, no polling race.
  await page.waitForFunction(id => {
    const el = document.querySelector(`[data-node-id="${id}"]`);
    return el && ['running', 'queued'].includes(el.dataset.nodeState);
  }, 'trend');
  await openNodeMenu(page, 'research', 'right-click');
  const runItem = item(page, '실행');
  assert.equal(await runItem.isDisabled(), true, 'a live run must disable run-node everywhere, not just on the running node');
  await page.keyboard.press('Escape');
  const toolbarRun = page.locator('[data-wf-action=run]');
  assert.equal(await toolbarRun.isDisabled(), true, 'a live run must also disable the toolbar run-all entry point');
  f.releaseRun();
  await f.waitRun(runId);
});

// ===========================================================================
// M10 - an unselected node never shows 건너뜀; the old English string never leaks
// ===========================================================================
test('M10: a node not selected in the latest run shows its retained/idle state, never 건너뜀, and the legacy English not-selected text is never shown', async t => {
  const f = await fixture(t), { page, base, workflow, waitRun } = f;
  await openNodeMenu(page, 'trend', 'right-click');
  const plan = planPending(page, base, workflow.id);
  const run = runPending(page, base, workflow.id);
  await item(page, '실행').click();
  const planResponse = await plan;
  assert.equal(planResponse.status(), 200, `POST /plan for trend: ${await planResponse.text()}`);
  const runResponse = await run;
  await waitRun((await runResponse.json()).id);
  await page.waitForFunction(() => document.querySelector('[data-node-id="trend"]')?.dataset.nodeState === 'completed');
  for (const id of ['research', 'script', 'storyboard']) {
    const state = await cardState(page, id);
    assert.notEqual(state, 'skipped', `${id} was merely unselected, not user-skipped, and must not show the skipped state`);
    assert.doesNotMatch(await stateBadge(page, id).innerText(), /건너뜀/, `${id} badge must not read 건너뜀 for a node that just wasn't selected`);
  }
  assert.doesNotMatch(await page.locator('body').innerText(), new RegExp(ENGLISH_NOT_SELECTED), 'the legacy raw English string must never render anywhere in the workflow UI');
  // Also check the node-results surface, which historically rendered the raw error text.
  await header(page, 'research').click();
  await focusedButton(page, 'node-results').click();
  await page.locator('#wf-results-dialog[open]').waitFor();
  assert.doesNotMatch(await page.locator('#wf-results-dialog').innerText(), new RegExp(ENGLISH_NOT_SELECTED));
  // MenuImpl3 consolidated the node card to ONE visible status element (the precedence badge
  // doubles as [data-status-node], classes `badge wf-state-badge wf-node-status <rawStatus>`):
  // no `.wf-node` may show two competing status labels (the old legacy raw-STATUS span and the
  // precedence badge used to coexist, and the legacy one still said 건너뜀 for a merely
  // unselected node -- contract 2.1's whole point).
  for (const article of await page.locator('.wf-node').all()) {
    assert.equal(await article.locator('[data-testid="wf-node-badge"]').count(), 1, 'exactly one precedence badge per node card');
    assert.equal(await article.locator('.wf-node-status').count(), 1, 'exactly one status element per node card -- it must be the SAME element as the badge, not a separate sibling');
  }
  // trend's ancestors are empty, so research/script/storyboard were never run at all in this
  // test (not even unselected-in-a-run): they must show the idle label, never a leftover run status.
  for (const id of ['research', 'script', 'storyboard']) {
    assert.equal(await cardState(page, id), 'idle');
    assert.match(await stateBadge(page, id).innerText(), /^미실행$/, `${id} never ran: must show 미실행, not a raw/blank status`);
  }
});
