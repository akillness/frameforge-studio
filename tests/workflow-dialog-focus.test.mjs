// Browser regression coverage for agent://JSReview's F1-F4 findings against the
// focus-restoration patch in public/workflow.js (rememberOverlay / restoreOverlayFocus /
// paint()'s re-resolution chain / confirmDialogEpoch / generationEstimateRequest).
// Isolated createApp + temp data dir + mock providers per call, patterned on
// tests/workflow-menu-run.test.mjs and tests/node-workbench.test.mjs. No live service, no
// real provider, no project data.
//
// NOTE on naming: these F1-F4 labels are agent://JSReview's own numbering for THIS review
// round and are unrelated to the differently-scoped "F1" test already in
// tests/workflow-menu-run.test.mjs (toolbar undo/redo, independent review, 2026-10-28) --
// that one predates this review and happens to reuse the same letter+digit from a separate
// pass. F5 (the "more" expander focus-loss finding) is out of this file's scope.
//
// Mechanics read directly from the live source at write time (not trusted from description
// alone) -- summarized here so a future reader doesn't have to re-derive them:
//   F1 -- rememberOverlay now also records overlayScope ('card'|'panel'|null) via
//         trigger.closest('#wf-focused-node'|'.wf-node'). paint()'s re-resolution (the
//         block that runs when overlayTrigger got disconnected by a repaint) tries
//         nodeControl(overlayNodeId,overlayAction) for card scope BEFORE the
//         #wf-focused-node lookup, so a card's own port button no longer loses to the
//         panel's identically-named data-wf-action="output"/"input" button.
//   F2 -- loadGenerationEstimate now captures confirmDialogEpoch and a per-call
//         generationEstimateRequest sequence number (request=++generationEstimateRequest)
//         at call time. A stale() closure (epoch!==contextEpoch ||
//         dialogEpoch!==confirmDialogEpoch || request!==generationEstimateRequest) gates the
//         try block's success assignment and the catch block's error assignment. The
//         finally block's loading-flag reset is gated SEPARATELY, by request-identity alone
//         (request===generationEstimateRequest, independent of dialogEpoch/contextEpoch) --
//         gating it on the full stale() left the flag stuck true forever after the first
//         Escape/취소 before a quote resolved, since nothing else could ever both re-run
//         loadGenerationEstimate() (to reset it) and still count as "the latest" (the button
//         that starts a new request was itself disabled by the stuck flag -- a genuine
//         dead-end regression, caught and fixed during this file's own test runs below).
//         #wf-confirm-dialog's native 'close' listener ALSO now does
//         confirmDialogEpoch++;generationEstimateRequest++;generationEstimateLoading=false;
//         synchronously (Escape, the 취소/close-dialog button, or a project switch via
//         selectGraph), so an abandoned request's own lock on `pending` (the shared
//         mutating-action gate; see the F2 addendum test) releases promptly rather than
//         waiting on a response nobody is looking at anymore.
//   F3 -- openContextMenu now stashes the resolved anchor as context.opener; contextAction
//         uses it (when still connected) instead of always deriving $('#workflow-canvas'),
//         so a canvas-menu item opened via the header "⋯ 메뉴" button returns focus to that
//         button, not the canvas. The right-click-on-canvas path is untouched by this fix
//         (the canvas IS its own correct opener there) and is already covered by
//         tests/workflow-menu-run.test.mjs's U9b; this file deliberately does not
//         duplicate that coverage.
//   F4 -- the restore-workflow action handler now calls rememberOverlay(button) before
//         paint()+showModal(). The re-resolution fallback chain itself is now a shared
//         reresolveOverlayTrigger() helper (a no-op once overlayTrigger is reconnected)
//         called at the tail of BOTH paint() and updateSummary() -- needed because
//         restore-workflow's button lives in #wf-history, and #wf-history gets replaced via
//         innerHTML up to 4 times across one restore-workflow gesture (once inside paint()'s
//         own call to updateSummary(), again by action()'s shared finally block's own
//         separate updateSummary() call, and again inside updateExecution()'s own internal
//         updateSummary() call) -- a single one-shot re-resolution placed anywhere upstream
//         of all four would still get re-orphaned by whichever runs last.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createApp } from '../server/app.mjs';

const modulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();

const MODEL_ID = 'fixture-focus-model';
const RENDER_BYTES = Buffer.from('frameforge workflow-dialog-focus fixture render, not a real MP4');
const RENDER_SHA256 = createHash('sha256').update(RENDER_BYTES).digest('hex');

// ---------------------------------------------------------------------------
// Shared fixture -- trend -> research -> script -> storyboard, matching the base graph in
// tests/workflow-menu-run.test.mjs. `extraPorts` adds two more plain 'trend' nodes
// (portOut/portIn), wired in from storyboard so the whole graph stays connected (the
// server's validateWorkflow requires every node reachable), without creating a cycle or an
// ambiguous same-type-ancestor hint anywhere in the chain -- purely so F1 can exercise the
// connect-dialog port buttons on nodes that start with no incident edge in the direction
// under test. `generation` adds a generate+render pair exactly like
// tests/workflow-menu-run.test.mjs's M8/U9c (scriptAgent:'existing' skips prepare-first
// deferral for the same reason those tests use it: this file isn't testing that flow).
async function fixture(t, { extraPorts = false, generation = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-dialog-focus-'));
  const forbidden = async () => { assert.fail('Unexpected external or paid operation in a dialog-focus test'); };
  const providerCalls = [];
  const estimateGates = [];
  const estimateStub = async () => {
    const index = estimateGates.length;
    let release;
    const released = new Promise(resolve => { release = resolve; });
    estimateGates.push({ release });
    providerCalls.push(`estimate:${index}`);
    return released;
  };
  const generationStubs = generation ? {
    capability: async () => { providerCalls.push('capability'); return { available: true, authenticated: true }; },
    models: async () => { providerCalls.push('models'); return [{ id: MODEL_ID, name: 'Fixture generate model', type: 'image' }]; },
    modelSchema: async id => { providerCalls.push(`modelSchema:${id}`); return { id, type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }; },
    estimate: estimateStub,
    create: async () => { providerCalls.push('create'); assert.fail('No generation job may be created before explicit consent confirmation'); },
    submit: async () => { providerCalls.push('submit'); assert.fail('No generation job may be submitted before explicit consent confirmation'); },
    status: async () => { providerCalls.push('status'); return { available: true, authenticated: true }; },
  } : { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), fetchTrends: async query => ({ trends: [{ keyword: query, source: 'Fixture RSS', url: 'https://fixture.invalid/trend' }], sources: [{ name: 'Fixture RSS', status: 'ok' }] }), runAgent: forbidden },
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
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const channel = await api('/api/channels', 'POST', { name: 'Dialog focus channel', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Dialog focus project', topic: 'Local fixture only' });
  const nodes = [
    { id: 'trend', type: 'trend', label: 'Trend node', x: 40, y: 50, config: { query: 'dialog-focus-fixture-keyword' } },
    { id: 'research', type: 'research', label: 'Research node', x: 340, y: 50, config: {} },
    { id: 'script', type: 'script', label: 'Script node', x: 640, y: 50, config: { agent: generation ? 'existing' : 'studio' } },
    { id: 'storyboard', type: 'storyboard', label: 'Storyboard node', x: 940, y: 50, config: {} },
  ];
  const edges = [
    { id: 'trend-research', source: 'trend', target: 'research' },
    { id: 'research-script', source: 'research', target: 'script' },
    { id: 'script-storyboard', source: 'script', target: 'storyboard' },
  ];
  if (extraPorts) {
    nodes.push({ id: 'portOut', type: 'trend', label: 'Port out node', x: 40, y: 400, config: {} });
    nodes.push({ id: 'portIn', type: 'trend', label: 'Port in node', x: 340, y: 400, config: {} });
    edges.push({ id: 'storyboard-portOut', source: 'storyboard', target: 'portOut' });
    edges.push({ id: 'storyboard-portIn', source: 'storyboard', target: 'portIn' });
  }
  if (generation) {
    nodes.push({ id: 'generate', type: 'generate', label: 'Generate node', x: 1240, y: 50, config: { model: MODEL_ID, sceneId: episode.scenes[0].id, sceneIndex: 0, prompt: 'Fixture generation prompt', params: {} } });
    nodes.push({ id: 'render', type: 'render', label: 'Render node', x: 1540, y: 50, config: {} });
    edges.push({ id: 'storyboard-generate', source: 'storyboard', target: 'generate' });
    edges.push({ id: 'generate-render', source: 'generate', target: 'render' });
  }
  const template = await api('/api/workflows', 'POST', { name: 'Dialog focus graph', nodes, edges });
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
  return { page, context, base, api, writes, providerCalls, estimateGates, channel, episode, workflow, waitRun, open };
}

// ---------------------------------------------------------------------------
// DOM helpers (per-file local copies -- matches the convention already established in
// tests/workflow-menu-run.test.mjs and tests/node-workbench.test.mjs; no shared helper
// module exists for these).
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
function planPending(page, base, workflowId) {
  return page.waitForResponse(r => r.url() === `${base}/api/workflows/${workflowId}/plan` && r.request().method() === 'POST');
}
function quotePending(page, base, workflowId) {
  return page.waitForResponse(r => r.url() === `${base}/api/workflows/${workflowId}/quote` && r.request().method() === 'POST');
}
async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}
async function waitForCondition(predicate, description, timeout = 2000, interval = 20) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(interval);
  }
  assert.fail(`${description} -- condition never became true`);
}
// Native dialog close -> restoreOverlayFocus() focus restoration is not guaranteed
// observable to Playwright in the exact same tick the dialog reports 'hidden' (same timing
// caveat documented in tests/workflow-menu-run.test.mjs's U9 section: restoreOverlayFocus
// reads document.activeElement the instant the 'close' listener runs, and that value
// settles a few ms after 'hidden' fires). Poll instead of reading synchronously.
async function waitForActiveElement(page, predicate, description, arg = null) {
  try {
    await page.waitForFunction(predicate, arg, { timeout: 2000, polling: 20 });
  } catch {
    const got = await page.evaluate(() => ({ wfAction: document.activeElement?.dataset?.wfAction || null, dataId: document.activeElement?.dataset?.id || null, id: document.activeElement?.id || null, closestNode: document.activeElement?.closest?.('.wf-node')?.dataset.nodeId || null, inPanel: Boolean(document.activeElement?.closest?.('#wf-focused-node')), tag: document.activeElement?.tagName || null }));
    assert.fail(`${description} -- focus never settled, got ${JSON.stringify(got)}`);
  }
}

// ===========================================================================
// F1 -- a node card's own input/output port button regains focus after the connect
// dialog's internal repaint (connect() calls paint() while #wf-connect-dialog is still
// open, before the submit handler's own dialog.close()) and after the explicit close --
// never the #wf-focused-node panel's identically-named button (both the card port buttons
// and the always-present focused-node panel use data-wf-action="output"/"input").
// ===========================================================================
test('F1: a node card\'s own output/input port button regains focus after the connect dialog repaints mid-submit and closes, never the #wf-focused-node panel\'s identically-named button', async t => {
  const f = await fixture(t, { extraPorts: true }), { page } = f;

  // Sub-case A: portOut's OUTPUT port (connect() presets source=portOut) -> target portIn
  // (portIn starts with no edges, so this cannot create a cycle or a duplicate).
  await node(page, 'portOut').locator('[data-wf-action="output"]').click();
  await page.locator('#wf-connect-dialog[open]').waitFor();
  assert.equal(await page.locator('#wf-connect-source').inputValue(), 'portOut');
  await page.selectOption('#wf-connect-target', 'portIn');
  await page.locator('#wf-connect-dialog-form button[type=submit]').click();
  await page.locator('#wf-connect-dialog[open]').waitFor({ state: 'hidden' });
  await waitForActiveElement(page, () => {
    const el = document.activeElement;
    return el?.closest('.wf-node')?.dataset.nodeId === 'portOut' && el?.dataset.wfAction === 'output' && !el.closest('#wf-focused-node');
  }, 'portOut\'s own output port button must regain focus, not #wf-focused-node\'s output button');

  // Sub-case B: portIn's INPUT port (connect() presets target=portIn) -> source trend (not
  // yet incident to portIn, and not a cycle since portIn still has no outgoing edges).
  await node(page, 'portIn').locator('[data-wf-action="input"]').click();
  await page.locator('#wf-connect-dialog[open]').waitFor();
  assert.equal(await page.locator('#wf-connect-target').inputValue(), 'portIn');
  await page.selectOption('#wf-connect-source', 'trend');
  await page.locator('#wf-connect-dialog-form button[type=submit]').click();
  await page.locator('#wf-connect-dialog[open]').waitFor({ state: 'hidden' });
  await waitForActiveElement(page, () => {
    const el = document.activeElement;
    return el?.closest('.wf-node')?.dataset.nodeId === 'portIn' && el?.dataset.wfAction === 'input' && !el.closest('#wf-focused-node');
  }, 'portIn\'s own input port button must regain focus, not #wf-focused-node\'s input button');

  assert.deepEqual(f.writes, [], 'connecting nodes is a local draft edit; nothing is posted until an explicit Save');
});

// ===========================================================================
// F2 -- dismissing the paid-generation consent dialog (Escape or the 취소/close-dialog
// button) while a /quote request is still in flight must never let that late response
// reopen #wf-confirm-dialog (it would otherwise render the WRONG variant -- "이전 버전을 새
// 버전으로 복원" -- since generationConsent was just reset to false by the close). Reopening
// afterward must always require a fresh /quote; no stale quote, error, or stuck-loading
// state may carry over.
// ===========================================================================
test('F2: Escape/취소 on the paid-generation consent dialog while /quote is in flight never lets that late response reopen the dialog, and reopening afterward always needs a fresh quote', async t => {
  const f = await fixture(t, { generation: true }), { page, base, workflow, providerCalls, estimateGates } = f;
  const startQuote = async () => {
    await page.selectOption('#wf-disclosure', 'false');
    await page.fill('#wf-disclosure-rationale', 'No synthetic media disclosure required for this fixture run.');
    const before = estimateGates.length;
    await page.locator('[data-wf-action=quote-generation]').click();
    await waitForCondition(() => estimateGates.length > before, 'quote-generation click must reach the gated estimate stub');
    return estimateGates.length - 1;
  };

  for (const closeVia of ['Escape', 'close-dialog']) {
    await openNodeMenu(page, 'generate', 'right-click');
    const plan = planPending(page, base, workflow.id);
    await item(page, '실행').click();
    await plan;
    await page.locator('#wf-confirm-dialog[open]').waitFor();
    const index = await startQuote();
    const pending = quotePending(page, base, workflow.id);
    if (closeVia === 'Escape') await page.keyboard.press('Escape');
    else await page.locator('#wf-confirm-dialog [data-wf-action=close-dialog]').click();
    await page.locator('#wf-confirm-dialog[open]').waitFor({ state: 'hidden' });
    f.estimateGates[index].release({ cost: 1, currency: 'USD' });
    const response = await pending;
    assert.equal(response.status(), 200, `delayed /quote (${closeVia}) must still resolve 200 server-side: ${await response.text()}`);
    await wait(150); // let the resolved call's finally settle (same 18-88ms-class timing documented in U9)
    assert.equal(await page.locator('#wf-confirm-dialog[open]').count(), 0, `a /quote response arriving after Escape/취소 (${closeVia}) must never reopen #wf-confirm-dialog`);
  }

  // Reopening must always require a fresh quote -- no stale [data-generation-quote], no
  // leaked error, the control not stuck disabled -- and must actually hit the network again.
  await openNodeMenu(page, 'generate', 'right-click');
  const plan = planPending(page, base, workflow.id);
  await item(page, '실행').click();
  await plan;
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  assert.equal(await page.locator('#wf-confirm-dialog h2').innerText(), '전체 후보 생성 승인', 'reopening on the same (generate) node must show the generation variant, never the leaked restore variant');
  assert.equal(await page.locator('[data-generation-quote]').count(), 0, 'no stale quote carries over from either abandoned attempt');
  assert.equal(await page.locator('.wf-review-warning[role=alert]').count(), 0, 'no leaked error from either abandoned attempt');
  assert.equal(await page.locator('[data-wf-action=quote-generation]').isDisabled(), false, 'quote-generation must not be stuck disabled from an abandoned attempt');
  const index = await startQuote();
  const pending = quotePending(page, base, workflow.id);
  f.estimateGates[index].release({ cost: 1, currency: 'USD' });
  const response = await pending;
  assert.equal(response.status(), 200);
  await page.locator('[data-generation-quote]').waitFor();
  await page.keyboard.press('Escape');

  assert.deepEqual(providerCalls.filter(call => call === 'create' || call === 'submit'), [], 'no paid generation job was ever created or submitted anywhere in this scenario');
});

// ===========================================================================
// F2 addendum (requested by Main via IRC, 2026-10-28) -- a /quote response from an
// ABANDONED (Escaped) consent session must leave nothing for a later session to inherit:
// no stale result, no stale error, and the shared `pending` action-lock it holds must
// release cleanly once that late response is discarded.
//
// Design note: Main's literal description was "close -> reopen under the same conditions
// -> a NEW quote is pending when the old one responds". That exact interleaving turns out
// to be structurally UNREACHABLE through the real UI: quote-generation runs through
// action()'s single shared `pending` lock (workflow.js's `if(pending)return;` gate, the
// same one every mutating action incl. 실행/run-node goes through) -- Escape does not
// itself clear `pending`, only that original action() call's own `finally` does, once its
// awaited loadGenerationEstimate() settles. So a SECOND 실행 click cannot even open a new
// consent dialog while an earlier quote-generation call is still gated; there is no window
// where two independently-opened sessions are simultaneously in flight. Verified directly:
// a 실행 click issued while A is still gated is a confirmed no-op (asserted below), not an
// assumption. The actually-reachable, and still meaningful, version of Main's concern is
// this file's F2 test above (closing BEFORE a response + reopening afterward) plus this
// test's close-focused angle: an abandoned call's late resolution must (a) never leak into
// whatever session eventually does open next, and (b) correctly release the pending lock it
// holds so the editor doesn't deadlock waiting on a response nobody is looking at anymore.
// ===========================================================================
test('F2 addendum: a late response from an ABANDONED (Escaped) quote-generation call leaks nothing into a later session and correctly releases the shared pending action-lock it holds', async t => {
  const f = await fixture(t, { generation: true }), { page, base, workflow, providerCalls, estimateGates } = f;
  const startQuote = async () => {
    await page.selectOption('#wf-disclosure', 'false');
    await page.fill('#wf-disclosure-rationale', 'No synthetic media disclosure required for this fixture run.');
    const before = estimateGates.length;
    await page.locator('[data-wf-action=quote-generation]').click();
    await waitForCondition(() => estimateGates.length > before, 'quote-generation click must reach the gated estimate stub');
    return estimateGates.length - 1;
  };

  // Session 1 (abandoned): open consent, request a quote (A), Escape before it resolves.
  await openNodeMenu(page, 'generate', 'right-click');
  let plan = planPending(page, base, workflow.id);
  await item(page, '실행').click();
  await plan;
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  const indexA = await startQuote();
  await page.keyboard.press('Escape');
  await page.locator('#wf-confirm-dialog[open]').waitFor({ state: 'hidden' });

  // Confirm the ordering claim above directly: while A's gate is still held, the context
  // menu's own `locked` check (openContextMenu reads the same shared `pending`) renders
  // 실행 disabled -- no new consent dialog is reachable at all.
  await openNodeMenu(page, 'generate', 'right-click');
  assert.equal(await item(page, '실행').isDisabled(), true, '실행 must render disabled while an earlier abandoned quote-generation call still holds the shared pending lock');
  await page.keyboard.press('Escape');

  // Release the stale A now (late, well after the user moved on). Its own stale() check
  // must discard it silently, and the outer action() call it belongs to must still free the
  // shared pending lock once its awaited loadGenerationEstimate() settles.
  const pendingAResponse = quotePending(page, base, workflow.id);
  f.estimateGates[indexA].release({ cost: 1, currency: 'USD' });
  const responseA = await pendingAResponse;
  assert.equal(responseA.status(), 200, `abandoned A's /quote still resolves 200 server-side: ${await responseA.text()}`);
  await wait(150);

  // Session 2 (now actually reachable): reopen on the SAME node under the SAME conditions.
  // Must be a completely fresh session -- no trace of A, and the lock must be usable again.
  await openNodeMenu(page, 'generate', 'right-click');
  plan = planPending(page, base, workflow.id);
  await item(page, '실행').click();
  await plan;
  await page.locator('#wf-confirm-dialog[open]').waitFor();
  assert.equal(await page.locator('[data-generation-quote]').count(), 0, 'no trace of the abandoned A quote carries into session 2');
  assert.equal(await page.locator('.wf-review-warning[role=alert]').count(), 0, 'no leaked error from A carries into session 2');
  assert.equal(await page.locator('[data-wf-action=quote-generation]').isDisabled(), false, 'quote-generation must be usable again in session 2 -- the shared pending lock released cleanly');
  const indexB = await startQuote();
  const pendingB = quotePending(page, base, workflow.id);
  f.estimateGates[indexB].release({ cost: 1, currency: 'USD' });
  const responseB = await pendingB;
  assert.equal(responseB.status(), 200, `session 2's own /quote: ${await responseB.text()}`);
  await page.locator('[data-generation-quote]').waitFor();
  assert.equal(await page.locator('[data-wf-action=confirm-generation-run]').isDisabled(), false, 'session 2\'s own fresh quote must leave the confirm action enabled');
  await page.keyboard.press('Escape');

  assert.deepEqual(providerCalls.filter(call => call === 'create' || call === 'submit'), [], 'no paid generation job was ever created or submitted anywhere in this scenario');
});

// ===========================================================================
// F3 -- a canvas-menu item (here, "전체 실행") opened via the header "⋯ 메뉴" button (not
// right-click) must return focus to THAT HEADER BUTTON on Cancel/Escape, never to
// #workflow-canvas. contextAction used to always derive $('#workflow-canvas') as the
// canvas-menu opener regardless of which control actually opened the menu; the right-click
// path already works correctly today since the canvas genuinely IS its own opener there
// (tests/workflow-menu-run.test.mjs's U9b already covers it) -- this test deliberately
// exercises only the previously-uncovered header-button path.
// ===========================================================================
test('F3: 전체 실행 opened via the header "⋯ 메뉴" button returns focus to that button on Cancel/Escape, not the canvas', async t => {
  const f = await fixture(t), { page, base, api, workflow, episode, waitRun } = f;
  const run = await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'trend' } });
  await waitRun(run.id);
  await page.locator('[data-wf-action="refresh-runs"]').click();
  await page.waitForFunction(id => document.querySelector(`[data-node-id="${id}"]`)?.dataset.nodeState === 'completed', 'trend');

  for (const closeVia of ['Escape', 'cancel-button']) {
    await openCanvasMenu(page, 'more');
    const plan = planPending(page, base, workflow.id);
    await item(page, '전체 실행').click();
    await plan;
    const dialog = page.locator('#wf-run-all-dialog[open]');
    await dialog.waitFor();
    if (closeVia === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await waitForActiveElement(page, () => document.activeElement?.dataset?.wfAction === 'canvas-menu', `header "⋯ 메뉴" opener (${closeVia}): focus must return to that button, not the canvas`);
  }
});

// ===========================================================================
// F4 -- the restore-workflow action (버전 기록 -> select an older version -> 이 버전으로 복원)
// never called rememberOverlay before this patch, so Cancel/Escape on #wf-confirm-dialog
// fell back to focusNode(selected) (the currently-selected node's header) instead of the
// restore-workflow button itself.
// ===========================================================================
test('F4: Cancel and Escape on the restore-version confirm dialog return focus to the restore-workflow button, not the selected node', async t => {
  const f = await fixture(t), { page, api, workflow } = f;
  // Seed a second version so an older one is selectable (v1 from the template copy, v2 from
  // this trivial edit) -- matches tests/workflow-menu-run.test.mjs's U7 pattern.
  await api(`/api/workflows/${workflow.id}`, 'PUT', { name: workflow.name, nodes: workflow.nodes.map(n => n.id === 'trend' ? { ...n, x: n.x + 1 } : n), edges: workflow.edges, expectedVersion: workflow.version });
  await f.open();

  await page.locator('#wf-workflow-history > summary').click();
  await page.locator('.history-version').nth(1).click(); // versions render newest-first; index 1 is the older v1
  const restoreButton = page.locator('[data-wf-action="restore-workflow"]');
  assert.equal(await restoreButton.isDisabled(), false);

  for (const closeVia of ['Escape', 'close-dialog']) {
    await restoreButton.click();
    await page.locator('#wf-confirm-dialog[open]').waitFor();
    assert.equal(await page.locator('#wf-confirm-dialog h2').innerText(), '이전 버전을 새 버전으로 복원');
    if (closeVia === 'Escape') await page.keyboard.press('Escape');
    else await page.locator('#wf-confirm-dialog [data-wf-action=close-dialog]').click();
    await page.locator('#wf-confirm-dialog[open]').waitFor({ state: 'hidden' });
    await waitForActiveElement(page, () => document.activeElement?.dataset?.wfAction === 'restore-workflow', `restore-workflow opener (${closeVia}): focus must return to that button, not the selected node's header`);
  }
});

// ===========================================================================
// Publish-readiness stage overlay (routed to this file by Main, 2026-10-28, since
// production-workspace-journey.test.mjs's "sequential reviewed producers..." scenario
// already covers the hand-authored blocked/idle shape and this needs a dedicated fixture
// per-scenario). Covers UIFocusFix's checkPublishReadiness()/publishReadinessResult
// addition: opening the stage overlay for a 'publish' node synchronously shows
// blocked+Start-disabled+a loading message FIRST (never a stale/placeholder 'idle'), fires
// exactly one read-only POST /plan, then patches to the server's real answer once that
// settles -- fail-closed on network/HTTP failure, and never applies an answer that arrived
// after the dialog closed, the node/project changed, or the draft was edited (all of which
// bump the guards checkPublishReadiness's own stale() closure reads: publishReadinessRequest
// via the close listener, contextEpoch via node/project switches, revision via any edit).
// ===========================================================================
async function fixturePublishReadiness(t, { withRetainedProof = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-publish-readiness-'));
  const forbidden = async () => { assert.fail('Unexpected external or paid operation in a publish-readiness test'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), fetchTrends: forbidden, runAgent: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    renderer: async (_episode, { dataDir: exportsDataDir, sceneIntegrity }) => {
      await mkdir(join(exportsDataDir, 'exports'), { recursive: true });
      const filename = `${randomUUID()}.mp4`;
      await writeFile(join(exportsDataDir, 'exports', filename), RENDER_BYTES);
      // job.sceneIntegrity is always computed server-side (enqueueRender's own
      // snapshotSceneIntegrity) regardless of what the renderer returns; review()'s scene
      // receipt check then requires job.verifiedSceneAssets to be a matching array -- echoing
      // the passed-through sceneIntegrity back is the proven pattern used by every other
      // passing test with a lightweight render stub (e.g. tests/workflow-plan.test.mjs,
      // tests/workflows.test.mjs). sha256 must match the actual written bytes (review-commit
      // independently digests the on-disk file), not something specific to this fixture.
      return { outputUrl: `/api/exports/${filename}`, filename, sha256: RENDER_SHA256, ...(sceneIntegrity ? { verifiedSceneAssets: sceneIntegrity } : {}) };
    },
    mediaOptions: { fetchImpl: forbidden },
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
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const channel = await api('/api/channels', 'POST', { name: 'Publish readiness channel', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Publish readiness project', topic: 'Local fixture only' });
  const nodes = [
    { id: 'script', type: 'script', label: 'Script node', x: 40, y: 50, config: { agent: 'existing' } },
    { id: 'storyboard', type: 'storyboard', label: 'Storyboard node', x: 340, y: 50, config: {} },
    { id: 'render', type: 'render', label: 'Render node', x: 640, y: 50, config: {} },
    { id: 'review', type: 'review', label: 'Review node', x: 940, y: 50, config: {} },
    { id: 'publish', type: 'publish', label: 'Publish node', x: 1240, y: 50, config: {} },
  ];
  const edges = [
    { id: 'script-storyboard', source: 'script', target: 'storyboard' },
    { id: 'storyboard-render', source: 'storyboard', target: 'render' },
    { id: 'render-review', source: 'render', target: 'review' },
    { id: 'review-publish', source: 'review', target: 'publish' },
  ];
  if (withRetainedProof) {
    // A leaf with no descendants, attached only as a child of 'script' -- running it alone
    // selects ONLY itself (invalidatedBySelection only marks DESCENDANTS of a selected node,
    // and this node has none), so review/render/storyboard are retained-forward unchanged,
    // never invalidated/stale. Connected for the server's required single-component graph.
    nodes.push({ id: 'research', type: 'research', label: 'Unrelated leaf node', x: 40, y: 400, config: {} });
    edges.push({ id: 'script-research', source: 'script', target: 'research' });
  }
  const template = await api('/api/workflows', 'POST', { name: 'Publish readiness graph', nodes, edges });
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
  return { page, context, base, api, writes, channel, episode, workflow, waitRun, open };
}
// Opens the publish stage overlay and returns the actual /plan response body (not just the
// Playwright Response -- tests want the server's exact resumeRunId/blocked/message).
async function openPublishStage(page, base, workflow) {
  await page.locator('.wf-node-header[data-id=publish]').click();
  const pending = page.waitForResponse(r => r.url() === `${base}/api/workflows/${workflow.id}/plan` && r.request().method() === 'POST');
  await page.locator('[data-wf-action=open-stage-overlay]').first().click();
  const response = await pending;
  assert.equal(response.status(), 200, `publish stage overlay's read-only /plan: ${await response.text()}`);
  const dialog = page.locator('#wf-stage-dialog');
  await dialog.waitFor();
  return { dialog, body: await response.json() };
}
async function waitForStageState(dialog, expectedState, expectedStartEnabled) {
  const status = dialog.locator('#wf-stage-status'), start = dialog.locator('#wf-stage-start');
  for (let i = 0; i < 100; i++) {
    if (await status.getAttribute('data-stage-state') === expectedState && await start.isEnabled() === expectedStartEnabled) return;
    await wait(20);
  }
  assert.fail(`stage overlay never settled to state=${expectedState} startEnabled=${expectedStartEnabled} -- got state=${await status.getAttribute('data-stage-state')} startEnabled=${await start.isEnabled()}`);
}

test('PR1: publish stage overlay is blocked before the nearest review is approved, and correctly idle (never falsely blocked) once that approval is retained-forward into a later, unrelated run -- the server, not the client, resolves which run is the compatible source', async t => {
  const f = await fixturePublishReadiness(t, { withRetainedProof: true }), { page, base, api, workflow, episode, waitRun } = f;

  const run1 = await waitRun((await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'review' } })).id);
  assert.equal(run1.status, 'awaiting_review', JSON.stringify(run1));
  await f.open(); // refresh the page's in-memory workflow/episode version after run1's direct-API execution, which it never observed

  let { dialog, body } = await openPublishStage(page, base, workflow);
  await waitForStageState(dialog, 'blocked', false);
  assert.equal(body.blocked?.code, 'publish_requires_review', JSON.stringify(body.blocked));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });

  await api(`/api/workflows/${workflow.id}/runs/${run1.id}/review`, 'POST', { reviewNodeId: 'review', decision: 'approved', expectedEpisodeVersion: run1.episodeVersion, notes: 'Fixture approval' });

  // A second, LATER run that does not touch review at all -- its own nodeRuns snapshot must
  // carry review forward as status:'skipped', retainedStatus:'approved', retainedFrom:run1.id
  // (not a freshly-decided 'approved' in the SAME run, which would never exercise the
  // retained-status-unwrapping path at all).
  const run2 = await waitRun((await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'research' } })).id);
  assert.equal(run2.status, 'completed', JSON.stringify(run2));
  const reviewInRun2 = run2.nodeRuns.find(n => n.nodeId === 'review');
  assert.equal(reviewInRun2.status, 'skipped', 'review must genuinely be retained-forward (skipped), not freshly re-decided, in run2\'s own snapshot');
  assert.equal(reviewInRun2.retainedStatus, 'approved', 'the retained status must still read approved');
  assert.equal(reviewInRun2.retainedFrom, run1.id, 'retained explicitly from the run where it was actually decided');

  await f.open(); // refresh the page's in-memory workflow/episode version after direct API mutations it never observed
  ({ dialog, body } = await openPublishStage(page, base, workflow));
  assert.equal(body.blocked, false, JSON.stringify(body));
  await waitForStageState(dialog, 'idle', true);
  assert.equal(body.resumeRunId, run2.id, 'the server must resolve run2 (the latest compatible run) as its source, not run1 or any other -- proves the retained-forward approval was read from the correct, current snapshot, not a stale or coincidentally-matching one');

  assert.deepEqual(f.writes.filter(w => /\/run$/.test(w.path)), f.writes.filter(w => /\/run$/.test(w.path) && (w.body?.execution?.targetNodeId === 'review' || w.body?.execution?.targetNodeId === 'research')), 'only the two explicit API-issued runs above ever posted /run -- opening the overlay itself never did');
  assert.equal(f.writes.filter(w => w.path.startsWith('/api/publication/')).length, 0, 'readiness-checking never publishes');
});

test('PR2: opening the publish stage overlay shows blocked+disabled+a loading message immediately (synchronously, before /plan resolves), then patches to the real settled answer once it does', async t => {
  const f = await fixturePublishReadiness(t), { page, base, workflow } = f;
  let releasePlan;
  const gate = new Promise(resolve => { releasePlan = resolve; });
  await page.route(`${base}/api/workflows/${workflow.id}/plan`, async route => { await gate; await route.continue(); });

  await page.locator('.wf-node-header[data-id=publish]').click();
  const pending = page.waitForResponse(r => r.url() === `${base}/api/workflows/${workflow.id}/plan` && r.request().method() === 'POST');
  await page.locator('[data-wf-action=open-stage-overlay]').first().click();
  const dialog = page.locator('#wf-stage-dialog');
  await dialog.waitFor();
  assert.equal(await dialog.locator('#wf-stage-status').getAttribute('data-stage-state'), 'blocked', 'the dialog must be visible immediately with the synchronous loading default, never waiting on the network before the user sees anything');
  assert.equal(await dialog.locator('#wf-stage-start').isDisabled(), true);
  const loadingText = await dialog.locator('#wf-stage-status').innerText();

  releasePlan();
  const response = await pending;
  assert.equal(response.status(), 200, await response.text());
  await waitForStageState(dialog, 'blocked', false); // review was never approved in this minimal fixture -- real answer is also blocked, but...
  const settledText = await dialog.locator('#wf-stage-status').innerText();
  assert.notEqual(settledText, loadingText, 'the settled (real, server-derived) message must differ from the transient loading placeholder -- proves the UI genuinely re-rendered from the response, not that it coincidentally started in the right state');
});

test('PR3: a network failure or a 409 while checking publish readiness fails closed to blocked+disabled, never silently idle', async t => {
  for (const failureMode of ['abort', '409']) {
    const f = await fixturePublishReadiness(t), { page, base, workflow } = f;
    await page.route(`${base}/api/workflows/${workflow.id}/plan`, route => failureMode === 'abort' ? route.abort('failed') : route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture-forced conflict' }) }));

    await page.locator('.wf-node-header[data-id=publish]').click();
    await page.locator('[data-wf-action=open-stage-overlay]').first().click();
    const dialog = page.locator('#wf-stage-dialog');
    await dialog.waitFor();
    await waitForStageState(dialog, 'blocked', false);
    assert.equal(await dialog.locator('#wf-stage-start').isDisabled(), true, `${failureMode}: a failed readiness check must never leave the start button clickable`);
    await page.keyboard.press('Escape');
  }
});

test('PR4: a /plan answer that arrives after the dialog already closed, after the node/project changed, or after the draft was edited is discarded -- it never overwrites whatever the current, correct state actually is', async t => {
  const f = await fixturePublishReadiness(t), { page, base, api, workflow, episode, waitRun } = f;

  // --- close-then-reopen: the stale first check's answer must never win over the second's.
  let releaseStale;
  const staleGate = new Promise(resolve => { releaseStale = resolve; });
  let planCalls = 0;
  await page.route(`${base}/api/workflows/${workflow.id}/plan`, async route => { planCalls++; if (planCalls === 1) await staleGate; await route.continue(); });
  await page.locator('.wf-node-header[data-id=publish]').click();
  await page.locator('[data-wf-action=open-stage-overlay]').first().click();
  let dialog = page.locator('#wf-stage-dialog');
  await dialog.waitFor();
  await page.keyboard.press('Escape'); // closes while the first (gated) /plan call is still in flight
  await dialog.waitFor({ state: 'hidden' });

  const run1 = await waitRun((await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'review' } })).id);
  await api(`/api/workflows/${workflow.id}/runs/${run1.id}/review`, 'POST', { reviewNodeId: 'review', decision: 'approved', expectedEpisodeVersion: run1.episodeVersion, notes: 'Fixture approval' });
  await f.open(); // refresh the page's in-memory workflow/episode version after run1+approval, which it never observed

  const secondPending = page.waitForResponse(r => r.url() === `${base}/api/workflows/${workflow.id}/plan` && r.request().method() === 'POST');
  await page.locator('.wf-node-header[data-id=publish]').click();
  await page.locator('[data-wf-action=open-stage-overlay]').first().click();
  await secondPending;
  await waitForStageState(dialog, 'idle', true); // the second (fresh, post-approval) check's real answer
  releaseStale(); // now let the FIRST (abandoned, pre-approval) response land late
  await wait(200);
  await waitForStageState(dialog, 'idle', true); // must still read idle -- the stale 'blocked' must never flash in or overwrite it
  await page.keyboard.press('Escape');
  await page.unroute(`${base}/api/workflows/${workflow.id}/plan`);

  // --- node switch mid-flight: open on a non-publish node while a gated publish /plan call
  // from a moment ago is still pending is not reachable (the check only fires for a selected
  // publish node), so the meaningful variant is: open on publish, gate it, switch the
  // SELECTED node away before it resolves, then confirm the late answer never paints over
  // whatever is now showing for the newly selected node's own (non-publish, synchronous)
  // stageInfo.
  let releaseSwitch;
  const switchGate = new Promise(resolve => { releaseSwitch = resolve; });
  await page.route(`${base}/api/workflows/${workflow.id}/plan`, async route => { await switchGate; await route.continue(); });
  await page.locator('.wf-node-header[data-id=publish]').click();
  await page.locator('[data-wf-action=open-stage-overlay]').first().click();
  dialog = page.locator('#wf-stage-dialog');
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('.wf-node-header[data-id=script]').click();
  await page.locator('[data-wf-action=open-stage-overlay]').first().click();
  await dialog.waitFor();
  const scriptStateBeforeLateAnswer = await dialog.locator('#wf-stage-status').getAttribute('data-stage-state');
  releaseSwitch();
  await wait(200);
  assert.equal(await dialog.locator('#wf-stage-status').getAttribute('data-stage-state'), scriptStateBeforeLateAnswer, 'a late publish-readiness answer must never overwrite the now-selected, unrelated script node\'s own stage state');
  await page.keyboard.press('Escape');
  await page.unroute(`${base}/api/workflows/${workflow.id}/plan`);

  // --- draft-revision change after an abandoned check: #wf-stage-dialog is a native modal
  // (showModal()), so the rest of the page is inert while it's open -- there is no reachable
  // sequence where the user edits the draft WHILE a gated check for the SAME open dialog is
  // still in flight (the same class of "structurally unreachable" finding as this file's F2
  // addendum). The real, reachable sequence is: close first (which already bumps
  // publishReadinessRequest via the close listener), edit the draft (bumps revision, sets
  // dirty), THEN the abandoned check's gate releases late. Both guards have already moved
  // past what that abandoned call captured, so either alone would already discard it --
  // this proves the edit doesn't somehow un-stale it, and that reopening afterward gets a
  // genuinely fresh, correctly-dirty answer, not something corrupted by the late release.
  let releaseDirty;
  const dirtyGate = new Promise(resolve => { releaseDirty = resolve; });
  await page.route(`${base}/api/workflows/${workflow.id}/plan`, async route => { await dirtyGate; await route.continue(); });
  await page.locator('.wf-node-header[data-id=publish]').click();
  await page.locator('[data-wf-action=open-stage-overlay]').first().click();
  dialog = page.locator('#wf-stage-dialog');
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('.wf-node-header[data-id=script]').click();
  await page.locator('[data-wf-action=open-tools]').click();
  await page.locator('#wf-tools-dialog[open]').waitFor();
  await page.fill('[data-wf-field=label]', 'Edited mid-flight draft label');
  await page.keyboard.press('Escape');
  releaseDirty();
  await wait(200);
  await page.unroute(`${base}/api/workflows/${workflow.id}/plan`);
  assert.equal(f.writes.filter(w => w.path.startsWith('/api/publication/')).length, 0, 'none of this ever published');

  // checkPublishReadiness's dirty guard (workflow.js:967) is a synchronous, no-network
  // early-return when dirty -- it must never even attempt the stale saved-graph /plan check.
  const planRequests = [];
  const capturePlan = req => { if (req.method() === 'POST' && new URL(req.url()).pathname === `/api/workflows/${workflow.id}/plan`) planRequests.push(true); };
  page.on('request', capturePlan);
  await page.locator('.wf-node-header[data-id=publish]').click();
  await page.locator('[data-wf-action=open-stage-overlay]').first().click();
  const fresh = page.locator('#wf-stage-dialog');
  await fresh.waitFor();
  await waitForStageState(fresh, 'blocked', false);
  const freshText = await fresh.locator('#wf-stage-status').innerText();
  page.off('request', capturePlan);
  assert.ok(freshText.includes('저장되지 않은 변경'), `fresh re-check after the mid-sequence edit must show the unsaved-changes (dirty) message, not a stale or corrupted one -- got: ${freshText}`);
  assert.deepEqual(planRequests, [], 'the dirty guard must short-circuit before ever issuing the read-only /plan request, not merely discard its answer');
});

// ===========================================================================
// FinalWorkflowReview F4 (cross-project stage dialog leak) investigated, not covered here:
// empirically confirmed (via an isolated diagnostic, not committed) that switching projects
// via the sidebar's episode button while #wf-stage-dialog is open as a native showModal()
// dialog is NOT reachable -- Playwright's .click() times out, since the browser blocks
// pointer events to everything outside a modal dialog's own subtree while it is open. No
// other trigger exists either: grepped public/ for history/popstate/pushState (none), and
// public/app.js's only two global keydown listeners are ContextMenu/Shift+F10 and Ctrl/Cmd+S
// (neither switches episodes). The review's own "[INFERENCE] reachable only via a non-pointer
// route (history/back navigation)" framing was right that pointer clicks don't reach it, but
// that exact mechanism doesn't exist in this app either -- so the finding appears to describe
// a theoretically-possible-if-the-mechanism-existed defect, not a path a real user can hit
// today. Reported to Main rather than asserted as a test per "never assert impossible paths".
// ===========================================================================
test('PR6: publish readiness correctly reports unsaved-episode-changes (not a false idle) when a scene/episode edit made through the separate Studio editor is still unsaved -- the workflow draft itself was never touched', async t => {
  const f = await fixturePublishReadiness(t), { page, base, api, workflow, episode, waitRun } = f;

  const run1 = await waitRun((await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'review' } })).id);
  await api(`/api/workflows/${workflow.id}/runs/${run1.id}/review`, 'POST', { reviewNodeId: 'review', decision: 'approved', expectedEpisodeVersion: run1.episodeVersion, notes: 'Fixture approval' });
  await f.open();

  let { dialog } = await openPublishStage(page, base, workflow);
  await waitForStageState(dialog, 'idle', true); // confirmed genuinely ready before the episode edit
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });

  // Edit through the SEPARATE Studio/scene editor (episode-level), not a workflow node -- this
  // is the exact distinction hasEpisodeChanges exists for (public/app.js:90): the workflow
  // graph's own `dirty` flag never sees this edit at all.
  await page.locator('#project-navigation [data-action=open-scene-editor]').click();
  const sceneDialog = page.locator('#project-scene-dialog');
  await sceneDialog.waitFor();
  await sceneDialog.locator('.inspector summary').click();
  await sceneDialog.locator('[data-episode=title]').fill('Edited mid-flight episode title');
  await page.keyboard.press('Escape');
  await sceneDialog.waitFor({ state: 'hidden' });

  const planRequests = [];
  const capturePlan = req => { if (req.method() === 'POST' && new URL(req.url()).pathname === `/api/workflows/${workflow.id}/plan`) planRequests.push(true); };
  page.on('request', capturePlan);
  await page.locator('.wf-node-header[data-id=publish]').click();
  await page.locator('[data-wf-action=open-stage-overlay]').first().click();
  dialog = page.locator('#wf-stage-dialog');
  await dialog.waitFor();
  await waitForStageState(dialog, 'blocked', false);
  const statusText = await dialog.locator('#wf-stage-status').innerText();
  page.off('request', capturePlan);
  assert.ok(statusText.includes('에피소드에 저장되지 않은 변경'), `an unsaved episode-level edit must block with the episode-changes message, not a stale idle from before the edit -- got: ${statusText}`);
  assert.deepEqual(planRequests, [], 'this guard must also short-circuit before issuing the read-only /plan request, the same as the workflow-dirty guard');

  await page.keyboard.press('Escape');
  assert.equal(f.writes.filter(w => w.path.startsWith('/api/publication/')).length, 0, 'none of this ever published');
});
