/** Real HTTP + Chromium coverage for the scene studio's transport/scene shortcuts and the AI storyboard draft panel.
 * Only the proposal endpoint is a fixture (page.route); the app, store and every other route are real.
 * Opening or navigating never writes; applying a proposal only stages a draft; 변경 저장 stays the only persistence path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';

const playwrightModulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const browserModule = playwrightModulePath
  ? await import(pathToFileURL(playwrightModulePath))
  : await import('playwright');
const chromiumExecutable = process.env.PLATFORM_CHROMIUM_PATH
  || process.env.CHROMIUM_PATH
  || process.env.PLAYWRIGHT_EXECUTABLE_PATH
  || browserModule.chromium.executablePath();

const PROPOSE_PATH = '/api/agent/operations/episode_propose_storyboard';
// Long durations so the per-scene playback timer never advances during a test step.
const SCENES = [
  ['scene-a', '장면 A 오프닝', 20],
  ['scene-b', '장면 B 전개', 30],
  ['scene-c', '장면 C 반전', 40],
  ['scene-d', '장면 D 마무리', 50],
].map(([id, title, duration]) => ({ id, title, text: `${title} 본문`, duration, background: '#294434', kind: 'title', layout: 'center', narration: `${title} 내레이션` }));
const TITLES = SCENES.map((scene) => scene.title);
const CURRENT_SECONDS = SCENES.reduce((sum, scene) => sum + scene.duration, 0);

function forbidden(name) {
  return async () => { throw new Error(`Forbidden in browser test: ${name}`); };
}

async function studioFixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-studio-authoring-'));
  const app = createApp({
    dataDir,
    loginToken: '',
    publicOrigin: '',
    integrations: {
      integrationStatus: async () => ({ studio: { available: false, status: 'unavailable', detail: 'Isolated browser test' } }),
      runAgent: forbidden('agent'),
      fetchTrends: forbidden('trends'),
    },
    speech: { listVoices: async () => ({ available: false, voices: [], detail: 'Isolated browser test' }), synthesize: forbidden('speech') },
    generation: { capability: async () => ({ available: false, status: 'unavailable' }), models: async () => [], modelSchema: forbidden('schema'), submit: forbidden('generation'), status: forbidden('generation-status') },
    renderer: forbidden('render'),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await browserModule.chromium.launch({ headless: true, executablePath: chromiumExecutable });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1120 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const pageErrors = [];
  const externalRequests = [];
  const writes = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await context.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== base) { externalRequests.push(req.url()); return route.abort(); }
    if (!['GET', 'HEAD'].includes(req.method()) && url.pathname !== '/api/login') writes.push({ method: req.method(), path: url.pathname, body: req.postData() });
    return route.continue();
  });
  t.after(async () => {
    await context.close();
    await browser.close();
    await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  await page.goto(base);
  await page.locator('#app .shell').waitFor();
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body ? { data: body } : {}) });
    assert.ok(response.ok(), `fixture ${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  return { app, base, browser, context, page, api, writes, externalRequests, pageErrors };
}

/** Intercepts ONLY the proposal operation. Requests are recorded; `gate` holds the reply until released. */
async function storyboardRoute(f) {
  const route = { requests: [], gate: null, respond: null, aborts: () => f.page.evaluate(() => window.__proposeAborts.length) };
  // The app calls the global fetch at request time, so wrapping it here records client-side AbortController aborts.
  await f.page.evaluate((path) => {
    window.__proposeAborts = [];
    const original = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes(path) && init?.signal) init.signal.addEventListener('abort', () => window.__proposeAborts.push(url), { once: true });
      return original.apply(this, arguments);
    };
  }, PROPOSE_PATH);
  await f.context.route((url) => url.pathname === PROPOSE_PATH, async (pending) => {
    route.requests.push({ method: pending.request().method(), body: JSON.parse(pending.request().postData() || '{}') });
    if (route.gate) await route.gate.promise;
    const reply = route.respond(route.requests.at(-1).body);
    try { await pending.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.body) }); }
    catch { /* The client aborted this request; nothing to deliver. */ }
  });
  return route;
}
function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}
function proposalScenes(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `proposal-${index + 1}`, title: `제안 장면 ${index + 1}`, text: `제안 본문 ${index + 1}`, duration: 5 + index,
    background: '#173940', kind: 'title', layout: 'center', narration: index === 1 ? '긴 내레이션 '.repeat(20) : `내레이션 ${index + 1}`,
  }));
}
function okProposal(episodeId, baseVersion, count, engine = 'rule-based') {
  return { status: 200, body: { ok: true, result: { episodeId, baseVersion, scenes: proposalScenes(count), rationale: ['소재를 훅-전개-마무리로 나눴습니다.', '장면당 길이는 5초 이상으로 맞췄습니다.'], engine } } };
}

async function seedStudio(f) {
  const channel = await f.api('/api/channels', 'POST', { name: '스튜디오 저작 채널', platform: 'youtube', category: 'information' });
  const created = await f.api('/api/episodes', 'POST', { channelId: channel.id, title: '저작 UI 검증', topic: 'AI 스토리보드 초안 검증 소재' });
  const episode = await f.api(`/api/episodes/${created.id}`, 'PUT', { scenes: SCENES, expectedVersion: created.version });
  assert.equal(episode.scenes.length, 4);
  await f.page.reload();
  await f.page.locator('#app .shell').waitFor();
  await openChannel(f.page, channel.id);
  return { channel, episode };
}
async function openChannel(page, channelId) {
  await closeOverlays(page);
  const group = page.locator('.platform-group').filter({ has: page.locator(`[data-action=channel][data-id="${channelId}"]`) });
  if (!(await group.evaluate((element) => element.open))) await group.locator('summary').click();
  await group.locator(`[data-action=channel][data-id="${channelId}"]`).click();
  await openStudio(page);
}
async function closeOverlays(page) {
  for (const selector of ['#project-scene-dialog', '#project-tool-dialog']) {
    if (await page.locator(`${selector}[open]`).count()) {
      await page.keyboard.press('Escape');
      await page.locator(`${selector}[open]`).waitFor({ state: 'hidden' });
    }
  }
}
async function openStudio(page) {
  await page.locator('[data-action=open-scene-editor]').first().click();
  await page.locator('#project-scene-dialog[open] #preview').waitFor();
}

/** Every view of the selection: bin, timeline, inspector, monitor and transport counter must agree. */
async function selection(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('#project-scene-dialog');
    const text = (selector) => dialog.querySelector(selector)?.textContent.trim();
    return {
      bin: dialog.querySelector('.project-bin [aria-current="true"]')?.dataset.index,
      timeline: dialog.querySelector('.scene-card.selected')?.dataset.index,
      pressed: dialog.querySelector('.scene-card[aria-pressed="true"]')?.dataset.index,
      title: dialog.querySelector('[data-scene=title]')?.value,
      badge: text('.inspector .panel-header .badge'),
      monitor: text('#preview .preview-footer span:last-child'),
      counter: text('.transport > .hint'),
    };
  });
}
function expectedSelection(index, total = 4, titles = TITLES) {
  const n = String(index + 1);
  return { bin: String(index), timeline: String(index), pressed: String(index), title: titles[index], badge: `SCENE ${n.padStart(2, '0')}`, monitor: n.padStart(2, '0'), counter: `${n} / ${total} 장면` };
}
async function isPlaying(page) {
  return (await page.locator('#project-scene-dialog [data-action=play]').getAttribute('aria-label')) === '미리보기 정지';
}
async function episodeOnServer(f, id) {
  return (await f.api('/api/state')).episodes.find((item) => item.id === id);
}
async function focusInDialog(page) {
  return page.evaluate(() => document.querySelector('#project-scene-dialog').contains(document.activeElement));
}

/** CDP listener inspection. Handlers carry no description, so each listener is resolved through its script
 * location to the source line of the handler function, and only the studio handlers are counted. */
async function studioListeners(cdp) {
  await cdp.send('Debugger.enable');
  const sources = new Map();
  const handlerLine = async (listener) => {
    if (!sources.has(listener.scriptId)) sources.set(listener.scriptId, (await cdp.send('Debugger.getScriptSource', { scriptId: listener.scriptId })).scriptSource.split('\n'));
    return sources.get(listener.scriptId)[listener.lineNumber] || '';
  };
  const count = async (expression, type, needle) => {
    const { result } = await cdp.send('Runtime.evaluate', { expression });
    if (!result.objectId) return 0;
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    let found = 0;
    for (const listener of listeners) if (listener.type === type && (await handlerLine(listener)).includes(needle)) found += 1;
    return found;
  };
  const dialog = "document.querySelector('#project-scene-dialog')";
  return {
    documentKeydown: await count('document', 'keydown', 'function onStudioKeydown'),
    dialogClick: await count(dialog, 'click', 'function onStudioDialogClick'),
    dialogInput: await count(dialog, 'input', 'function onStoryboardField'),
    dialogChange: await count(dialog, 'change', 'function onStoryboardField'),
  };
}

test('Space/K/J/L/arrows/Home/End drive transport and keep bin, timeline, inspector and monitor on one scene', async (t) => {
  const f = await studioFixture(t), { page, writes, pageErrors, externalRequests } = f;
  const { episode } = await seedStudio(f);
  assert.deepEqual(await selection(page), expectedSelection(0));

  // Discoverable legend: native <details>, text only, closed until asked.
  const legend = page.locator('#project-scene-dialog details.studio-shortcuts');
  assert.equal(await legend.locator('summary').innerText(), '단축키');
  assert.equal(await legend.evaluate((element) => element.open), false);
  await legend.locator('summary').click();
  const legendText = await legend.innerText();
  for (const fragment of ['Space', '재생 / 일시정지', 'J', 'L', 'Home', 'End', 'Ctrl']) assert.ok(legendText.includes(fragment), `legend mentions ${fragment}`);

  // Focus on an unrelated dialog button: Space does not hijack playback (WCAG 2.1.4).
  await page.locator('#project-scene-dialog [data-action=open-generation]').focus();
  assert.equal(await isPlaying(page), false);
  assert.equal(await focusInDialog(page), true);
  await page.keyboard.press('Space');
  assert.equal(await isPlaying(page), false, 'Space on a focused dialog button does not hijack playback');

  // Focus on the sequence monitor container: Space is the transport shortcut.
  await page.locator('#program-monitor').focus();
  await page.keyboard.press('Space');
  assert.equal(await isPlaying(page), true, 'Space starts playback from monitor');
  await page.keyboard.press('Space');
  assert.equal(await isPlaying(page), false, 'Space pauses');
  await page.keyboard.press('k');
  assert.equal(await isPlaying(page), false, 'K while paused is a no-op');
  await page.keyboard.press('Space');
  assert.equal(await isPlaying(page), true, 'Space resumes playback');
  await page.keyboard.press('k');
  assert.equal(await isPlaying(page), false, 'K pauses');
  // Scene navigation: clamp at the ends, then every view agrees after every step.
  await page.keyboard.press('j');
  assert.deepEqual(await selection(page), expectedSelection(0), 'J at the first scene stays put');
  for (const [key, index] of [['l', 1], ['l', 2], ['j', 1], ['ArrowRight', 2], ['ArrowLeft', 1], ['End', 3], ['l', 3], ['Home', 0], ['ArrowLeft', 0]]) {
    await page.keyboard.press(key);
    assert.deepEqual(await selection(page), expectedSelection(index), `${key} -> scene ${index + 1}`);
  }
  // Focus stays in the zone the key came from: after shortcuts from the monitor it is still the monitor container...
  assert.equal(await page.evaluate(() => document.activeElement.id), 'program-monitor', 'monitor focus is kept across shortcut renders');
  // ...and from a timeline card, focus follows the newly selected card.
  await page.locator('.scene-card.selected').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal((await selection(page)).bin, '1');
  const cardFocus = await page.evaluate(() => { const active = document.activeElement; return { card: active.classList.contains('scene-card'), index: active.dataset.index, pressed: active.getAttribute('aria-pressed') }; });
  assert.deepEqual(cardFocus, { card: true, index: '1', pressed: 'true' }, 'focus follows the selected timeline card');
  // ...and from the project bin, to the selected bin entry.
  await page.locator('.project-bin [aria-current="true"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.project-bin') && document.activeElement.dataset.index), '2', 'focus follows the selected bin entry');
  await page.keyboard.press('Home');
  assert.equal(await legend.evaluate((element) => element.open), true, 'legend stays open across shortcut-driven renders');

  // While playing, J/L jump and keep playing; arrows behave like the prev/next buttons and stop.
  await page.keyboard.press('Space');
  assert.equal(await isPlaying(page), true);
  assert.deepEqual(await selection(page), expectedSelection(0), 'Home left us on the first scene');
  await page.keyboard.press('l');
  await page.keyboard.press('l');
  assert.deepEqual(await selection(page), expectedSelection(2));
  assert.equal(await isPlaying(page), true, 'L keeps playing');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  assert.deepEqual(await selection(page), expectedSelection(0), 'J clamps at the first scene');
  assert.equal(await isPlaying(page), true, 'J keeps playing, including when clamped');
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await selection(page), expectedSelection(1));
  assert.equal(await isPlaying(page), false, 'arrow navigation stops playback like the prev/next buttons');

  // The existing click paths still share the same selection path.
  await page.locator('.project-bin [data-action=scene][data-index="3"]').click();
  assert.deepEqual(await selection(page), expectedSelection(3));
  await page.locator('.scene-card[data-index="1"]').click();
  assert.deepEqual(await selection(page), expectedSelection(1));

  assert.deepEqual(writes, [], 'transport and navigation never write');
  assert.equal((await episodeOnServer(f, episode.id)).version, episode.version);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(pageErrors, []);
});

test('shortcuts are inert in text fields, steal nothing after close, leave Ctrl+S alone, and leak no listeners', async (t) => {
  const f = await studioFixture(t), { page, writes, pageErrors } = f;
  const { episode } = await seedStudio(f);
  const cdp = await f.context.newCDPSession(page);
  await page.evaluate(() => { window.__keys = []; window.addEventListener('keydown', (event) => window.__keys.push({ key: event.key, prevented: event.defaultPrevented })); });
  const keysSince = async (mark) => (await page.evaluate(() => window.__keys)).slice(mark);

  const none = { documentKeydown: 0, dialogClick: 0, dialogInput: 0, dialogChange: 0 };
  await closeOverlays(page);
  assert.deepEqual(await studioListeners(cdp), none, 'closed dialog: no studio listeners');
  await openStudio(page);
  const open = await studioListeners(cdp);
  assert.deepEqual(open, { documentKeydown: 1, dialogClick: 1, dialogInput: 1, dialogChange: 1 }, 'open dialog: exactly one of each');

  // Re-render a lot (selection, play toggles, panel open): the count must not grow.
  for (const key of ['l', 'l', 'j', 'Space', 'Space', 'End', 'Home']) await page.keyboard.press(key);
  await page.locator('#storyboard-toggle').click();
  assert.deepEqual(await studioListeners(cdp), open, 'renders replace listeners instead of stacking them');

  // Inert inside inputs: the scene title field and the storyboard brief textarea.
  const mark = (await page.evaluate(() => window.__keys.length));
  const title = page.locator('[data-scene=title]');
  await title.focus();
  for (const key of ['j', 'l', 'k', 'ArrowRight', 'ArrowLeft', 'Home', 'End']) await page.keyboard.press(key);
  assert.deepEqual(await selection(page).then(({ bin, timeline }) => ({ bin, timeline })), { bin: '0', timeline: '0' }, 'no scene change while typing in the title input');
  assert.equal(await isPlaying(page), false);
  assert.match(await title.inputValue(), /jlk/, 'letters were typed into the field');
  const brief = page.locator('#storyboard-brief');
  await brief.focus();
  const briefBefore = await brief.inputValue();
  await page.keyboard.press('Space');
  assert.equal(await isPlaying(page), false, 'Space in a textarea is a space, not play');
  assert.equal((await brief.inputValue()).length, briefBefore.length + 1, 'the space went into the textarea');
  assert.ok((await keysSince(mark)).every((entry) => entry.prevented === false), 'no key event was claimed while a text field had focus');

  // Ctrl+S is unchanged: the dirty title saves with the version the draft was based on.
  const before = writes.length;
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('저장됨'));
  const puts = writes.slice(before).filter((item) => item.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, `/api/episodes/${episode.id}`);
  assert.equal(JSON.parse(puts[0].body).expectedVersion, episode.version);

  // Focus on the body inside the open dialog still reaches the shortcuts.
  await page.evaluate(() => document.activeElement.blur());
  const openMark = await page.evaluate(() => window.__keys.length);
  await page.keyboard.press('l');
  assert.equal((await keysSince(openMark)).at(-1).prevented, true, 'claimed while the dialog is open');

  // Close, then drop focus on <body> so no button can absorb the keys.
  await page.keyboard.press('Escape');
  await page.locator('#project-scene-dialog[open]').waitFor({ state: 'hidden' });
  await page.evaluate(() => document.activeElement.blur());
  const closedMark = await page.evaluate(() => window.__keys.length);
  for (const key of ['Space', 'k', 'j', 'l', 'ArrowRight', 'ArrowLeft', 'Home', 'End']) await page.keyboard.press(key);
  const closedKeys = await keysSince(closedMark);
  assert.equal(closedKeys.length, 8);
  assert.ok(closedKeys.every((entry) => entry.prevented === false), 'a closed dialog steals no keys');
  assert.deepEqual(await studioListeners(cdp), none, 'closing removes every studio listener');
  assert.equal(await page.locator('#project-scene-dialog[open]').count(), 0, 'keys did not reopen the editor');

  // Reopening binds exactly one set again.
  await openStudio(page);
  assert.deepEqual(await studioListeners(cdp), open);
  assert.deepEqual(pageErrors, []);
});

test('AI storyboard panel: no request on open, one POST on press, apply stages a dirty draft, save is the only write', async (t) => {
  const f = await studioFixture(t), { page, writes, pageErrors, externalRequests } = f;
  const { episode } = await seedStudio(f);
  const route = await storyboardRoute(f);
  route.respond = () => okProposal(episode.id, episode.version, 5);

  assert.equal(await page.locator('#storyboard-panel').count(), 0);
  await page.locator('#storyboard-toggle').click();
  const panel = page.locator('#storyboard-panel');
  await panel.waitFor();
  assert.equal(await page.locator('#storyboard-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#storyboard-brief').inputValue(), 'AI 스토리보드 초안 검증 소재', 'brief is prefilled from the episode topic');
  assert.equal(await page.locator('#storyboard-brief').getAttribute('maxlength'), '2000');
  assert.deepEqual(await page.locator('#storyboard-count option').evaluateAll((options) => options.map((option) => option.value)), ['3', '4', '5', '6', '7', '8']);
  assert.deepEqual(await page.locator('#storyboard-tone option').evaluateAll((options) => options.map((option) => option.value)), ['neutral', 'energetic', 'calm']);
  assert.equal(await page.locator('#storyboard-agent').inputValue(), 'studio');
  assert.match(await page.locator('#storyboard-result').innerText(), /아직 요청하지 않았습니다/);
  await page.waitForTimeout(250);
  assert.equal(route.requests.length, 0, 'opening the panel makes no request');
  assert.deepEqual(writes, []);

  const brief = '러닝 습관 만들기 3분 요약';
  await page.locator('#storyboard-brief').fill(brief);
  await page.locator('#storyboard-count').selectOption('5');
  await page.locator('#storyboard-tone').selectOption('energetic');
  // Loading state: aria-busy, locked fields, and a second press cannot send a second request.
  route.gate = deferred();
  await page.locator('[data-action=storyboard-propose]').click();
  await page.locator('#storyboard-result[aria-busy="true"]').waitFor();
  assert.equal(await page.locator('[data-action=storyboard-propose]').getAttribute('aria-disabled'), 'true');
  assert.equal(await page.locator('#storyboard-brief').isDisabled(), true);
  assert.match(await page.locator('#storyboard-result').innerText(), /만드는 중/);
  await page.locator('[data-action=storyboard-propose]').click({ force: true });
  await page.waitForTimeout(200);
  assert.equal(route.requests.length, 1, 'exactly one POST for the button press');
  route.gate.release(); route.gate = null;
  await page.locator('#storyboard-result[aria-busy="false"] .storyboard-engine').waitFor();

  assert.equal(route.requests[0].method, 'POST');
  assert.deepEqual(route.requests[0].body, { arguments: { episodeId: episode.id, sceneCount: 5, tone: 'energetic', brief } });
  assert.equal(await page.locator('.storyboard-engine').innerText(), '규칙 기반 초안');
  assert.doesNotMatch(await page.locator('.storyboard-engine').innerText(), /AI|에이전트/, 'a rule-based draft badge never claims AI or an agent');
  assert.match(await panel.innerText(), /AI가 생성한 결과가 아닙니다/, 'and the hint says so plainly');
  const items = page.locator('.storyboard-scenes > li');
  assert.equal(await items.count(), 5);
  const second = await items.nth(1).innerText();
  assert.match(second, /제안 장면 2/);
  assert.match(second, /6초/);
  assert.match(second, /제안 본문 2/);
  assert.match(second, /내레이션 · 긴 내레이션/);
  assert.ok(second.includes('…'), 'long narration is excerpted');
  assert.equal(await page.locator('.storyboard-rationale li').count(), 2);
  const summary = await page.locator('.storyboard-compare').innerText();
  assert.match(summary, new RegExp(`현재 초안\\s*4장면 · ${CURRENT_SECONDS}초`));
  assert.match(summary, /제안\s*5장면 · 35초/);
  assert.equal(await panel.locator('.primary').count(), 1, 'one primary action in the panel');
  assert.equal(await panel.locator('.primary').innerText(), '장면에 적용');
  assert.deepEqual(writes, [], 'a proposal alone writes nothing');
  assert.equal((await selection(page)).counter, '1 / 4 장면', 'the draft is untouched until apply');

  await panel.locator('[data-action=storyboard-apply]').click();
  await page.waitForFunction(() => document.querySelectorAll('#project-scene-dialog .scene-card').length === 5);
  assert.equal(await page.locator('#save-status').evaluate((element) => element.className), 'unsaved');
  assert.deepEqual(await page.locator('.project-bin .source-copy strong').allInnerTexts(), proposalScenes(5).map((scene) => scene.title));
  assert.deepEqual(await selection(page), { ...expectedSelection(0, 5, proposalScenes(5).map((scene) => scene.title)) });
  assert.match(await page.locator('#storyboard-result').innerText(), /아직 저장되지 않았습니다/);
  assert.deepEqual(writes, [], 'apply stages an unsaved draft: zero requests');
  let server = await episodeOnServer(f, episode.id);
  assert.equal(server.version, episode.version);
  assert.deepEqual(server.scenes.map((scene) => scene.id), SCENES.map((scene) => scene.id), 'the server still has the original scenes');

  await page.locator('#save-button').click();
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('저장됨'));
  const puts = writes.filter((item) => item.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(puts[0].path, `/api/episodes/${episode.id}`);
  const saved = JSON.parse(puts[0].body);
  assert.equal(saved.expectedVersion, episode.version, 'save sends the version the draft was based on');
  assert.deepEqual(saved.scenes.map((scene) => scene.id), proposalScenes(5).map((scene) => scene.id));
  server = await episodeOnServer(f, episode.id);
  assert.equal(server.version, episode.version + 1);
  assert.equal(route.requests.length, 1, 'saving does not re-request the proposal');
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(pageErrors, []);
});

test('applying over unsaved scene edits asks first, says edits are discarded, and keeps the draft when declined', async (t) => {
  const f = await studioFixture(t), { page, writes, pageErrors } = f;
  const { episode } = await seedStudio(f);
  const route = await storyboardRoute(f);
  route.respond = () => okProposal(episode.id, episode.version, 4);

  await page.locator('[data-scene=title]').fill('저장 전 편집 제목');
  assert.equal(await page.locator('#save-status').evaluate((element) => element.className), 'unsaved');
  await page.locator('#storyboard-toggle').click();
  await page.locator('[data-action=storyboard-propose]').click();
  await page.locator('.storyboard-engine').waitFor();
  await page.locator('[data-action=storyboard-apply]').click();

  const confirm = page.locator('.storyboard-confirm');
  await confirm.waitFor();
  const warning = await confirm.innerText();
  assert.match(warning, /저장하지 않은 편집/);
  assert.match(warning, /복구할 수 없습니다/);
  assert.match(warning, /되돌리기가 없어/);
  assert.equal(await page.locator('#storyboard-panel .primary').count(), 1, 'the confirm button is the only primary action');
  assert.equal(await page.locator('#storyboard-panel .primary').innerText(), '교체하고 적용');
  assert.equal(await page.locator('[data-scene=title]').inputValue(), '저장 전 편집 제목', 'nothing replaced before confirmation');
  assert.equal(await page.locator('#project-scene-dialog .scene-card').count(), 4);

  await page.locator('[data-action=storyboard-keep]').click();
  assert.equal(await confirm.count(), 0);
  assert.equal(await page.locator('[data-action=storyboard-apply]').count(), 1);
  assert.equal(await page.locator('[data-scene=title]').inputValue(), '저장 전 편집 제목', 'declining keeps the unsaved edit');

  await page.locator('[data-action=storyboard-apply]').click();
  await page.locator('[data-action=storyboard-confirm]').click();
  await page.waitForFunction(() => document.querySelector('#project-scene-dialog [data-scene=title]')?.value === '제안 장면 1');
  assert.deepEqual(await page.locator('.project-bin .source-copy strong').allInnerTexts(), proposalScenes(4).map((scene) => scene.title));
  assert.equal(await page.locator('#save-status').evaluate((element) => element.className), 'unsaved');
  assert.deepEqual(writes, [], 'confirmed replacement still only stages the draft');
  assert.equal((await episodeOnServer(f, episode.id)).version, episode.version);
  assert.deepEqual(pageErrors, []);
});

test('a stale proposal is refused with a visible message, whether the server moved or the user saved after proposing', async (t) => {
  const f = await studioFixture(t), { page, writes, pageErrors } = f;
  const { episode } = await seedStudio(f);
  const route = await storyboardRoute(f);

  // 1) Proposal based on an older version than the open draft.
  route.respond = () => okProposal(episode.id, episode.version - 1, 4);
  await page.locator('#storyboard-toggle').click();
  await page.locator('[data-action=storyboard-propose]').click();
  await page.locator('.storyboard-engine').waitFor();
  assert.match(await page.locator('.storyboard-error').innerText(), /버전 불일치/);
  await page.locator('[data-action=storyboard-apply]').click();
  await page.locator('#storyboard-result .storyboard-error', { hasText: '적용하지 않습니다' }).waitFor();
  assert.match(await page.locator('#storyboard-result .storyboard-error').first().innerText(), new RegExp(`v${episode.version - 1}.*v${episode.version}`));
  assert.equal(await page.locator('#project-scene-dialog .scene-card').count(), 4, 'scenes unchanged');
  assert.equal(await page.locator('#save-status').evaluate((element) => element.className), 'hint', 'draft stayed clean');
  assert.deepEqual(writes, []);

  // 2) Proposal was fresh, then the user saved: the version moved on, so apply is refused.
  route.respond = () => okProposal(episode.id, episode.version, 4);
  await page.locator('[data-action=storyboard-propose]').click();
  await page.waitForFunction(() => !document.querySelector('#storyboard-result .storyboard-error'));
  await page.locator('.storyboard-engine').waitFor();
  await page.locator('[data-scene=title]').fill('저장으로 버전을 올립니다');
  await page.locator('#save-button').click();
  await page.waitForFunction(() => document.querySelector('#save-status')?.textContent.includes('저장됨'));
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].body).expectedVersion, episode.version);
  await page.locator('[data-action=storyboard-apply]').click();
  await page.locator('#storyboard-result .storyboard-error', { hasText: '적용하지 않습니다' }).waitFor();
  assert.match(await page.locator('#storyboard-result .storyboard-error').first().innerText(), new RegExp(`v${episode.version}.*v${episode.version + 1}`));
  assert.equal(await page.locator('[data-scene=title]').inputValue(), '저장으로 버전을 올립니다');
  assert.equal(await page.locator('#project-scene-dialog .scene-card').count(), 4);
  assert.equal(writes.length, 1, 'the refused apply wrote nothing');
  assert.deepEqual(pageErrors, []);
});

test('agent drafts are labelled by engine, host errors show text and fabricate nothing, and cancel aborts the request', async (t) => {
  const f = await studioFixture(t), { page, writes, pageErrors } = f;
  const { episode } = await seedStudio(f);
  const route = await storyboardRoute(f);
  await page.locator('#storyboard-toggle').click();
  assert.match(await page.locator('#storyboard-agent-hint').innerText(), /외부 에이전트를 호출하지 않습니다/);
  await page.locator('#storyboard-agent').selectOption('codex');
  assert.match(await page.locator('#storyboard-agent-hint').innerText(), /호스트 에이전트\(Codex\)로 .*전송/);

  // Host bridge unavailable: show the server's text, never a proposal.
  route.respond = () => ({ status: 503, body: { ok: false, error: '호스트 브리지를 사용할 수 없습니다.', code: 'bridge_unavailable' } });
  await page.locator('[data-action=storyboard-propose]').click();
  await page.locator('#storyboard-result .storyboard-error').waitFor();
  assert.match(await page.locator('#storyboard-result').innerText(), /호스트 브리지를 사용할 수 없습니다/);
  assert.equal(route.requests.at(-1).body.arguments.agent, 'codex');
  assert.equal(await page.locator('.storyboard-scenes').count(), 0, 'no scenes are fabricated');
  assert.equal(await page.locator('[data-action=storyboard-apply]').count(), 0);
  assert.equal(await page.locator('#storyboard-result').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#project-scene-dialog .scene-card').count(), 4);

  // ok:false in a 200 body is also an error, not a proposal.
  route.respond = () => ({ status: 200, body: { ok: false, error: '초안 형식을 만들지 못했습니다.' } });
  await page.locator('[data-action=storyboard-propose]').click();
  await page.locator('#storyboard-result .storyboard-error', { hasText: '초안 형식을 만들지 못했습니다' }).waitFor();
  assert.equal(await page.locator('.storyboard-scenes').count(), 0);

  // Agent success: labelled by engine with a transmission hint.
  route.respond = () => okProposal(episode.id, episode.version, 3, 'agent:codex');
  await page.locator('[data-action=storyboard-propose]').click();
  await page.locator('.storyboard-engine').waitFor();
  assert.equal(await page.locator('.storyboard-engine').innerText(), '에이전트 초안 (codex)');
  assert.match(await page.locator('#storyboard-result').innerText(), /호스트 에이전트\(codex\)로 전송/);
  assert.equal(await page.locator('.storyboard-scenes > li').count(), 3);

  // Cancel mid-flight: the request is aborted, nothing appears, reopening starts empty.
  route.gate = deferred();
  const sent = route.requests.length;
  await page.locator('[data-action=storyboard-propose]').click();
  await page.locator('#storyboard-result[aria-busy="true"]').waitFor();
  const abortsBefore = await route.aborts();
  await page.locator('[data-action=storyboard-cancel]').click();
  await page.locator('#storyboard-panel').waitFor({ state: 'detached' });
  assert.equal(route.requests.length, sent + 1);
  assert.equal(await route.aborts(), abortsBefore + 1, 'cancel aborts the in-flight request');
  route.gate.release(); route.gate = null;
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#storyboard-panel').count(), 0, 'a late reply does not reopen or fill the panel');
  assert.equal(await page.locator('#storyboard-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'storyboard-toggle', 'focus returns to the opener');
  await page.locator('#storyboard-toggle').click();
  assert.match(await page.locator('#storyboard-result').innerText(), /아직 요청하지 않았습니다/);
  assert.equal(await page.locator('.storyboard-scenes').count(), 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(pageErrors, []);
});

test('Space keeps native activation on the storyboard panel buttons instead of toggling playback', async (t) => {
  const f = await studioFixture(t), { page, pageErrors } = f;
  const { episode } = await seedStudio(f);
  const route = await storyboardRoute(f);
  route.respond = () => okProposal(episode.id, episode.version, 4);
  await page.locator('#storyboard-toggle').click();
  await page.locator('[data-action=storyboard-propose]').focus();
  await page.keyboard.press('Space');
  await page.locator('.storyboard-engine').waitFor();
  assert.equal(route.requests.length, 1, 'Space activated the focused propose button');
  assert.equal(await isPlaying(page), false, 'and did not start playback');
  assert.deepEqual(pageErrors, []);
});
