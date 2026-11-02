/** Real HTTP + Chromium coverage for one project canvas with native scene overlays.
 * Independent scene and graph drafts retain their own Save/version/unload contracts.
 * Only external transports are fixtures; opening and navigating never spends or publishes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';

const playwrightModulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const browserModule = playwrightModulePath
  ? await import(pathToFileURL(playwrightModulePath))
  : await import('playwright');
const chromiumExecutable = process.env.PLATFORM_CHROMIUM_PATH
  || process.env.CHROMIUM_PATH
  || process.env.PLAYWRIGHT_EXECUTABLE_PATH
  || browserModule.chromium.executablePath();

function forbidden(name) {
  return async () => { throw new Error(`Forbidden in browser test: ${name}`); };
}

/** Disposable app (loginToken:'' -> open loopback admin session, no login form) + a real
 * browser page wired to block external/provider traffic and record every non-GET/HEAD
 * request the *page itself* issues, so toggling modes can be asserted to cause zero
 * state-changing requests. */
async function workspaceFixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-workspace-ui-'));
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
    if (!['GET', 'HEAD'].includes(req.method()) && url.pathname !== '/api/login') {
      writes.push({ method: req.method(), path: url.pathname, body: req.postData() });
    }
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
  // loginToken:'' means every loopback request is already an authenticated admin session,
  // so fixture requests below via context.request never need a cookie and never touch `writes`.
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body ? { data: body } : {}) });
    assert.ok(response.ok(), `fixture ${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  return { app, base, browser, context, page, api, writes, externalRequests, pageErrors, dataDir };
}

function trendNodeGraph(name) {
  const nodeId = randomUUID();
  return { name, nodes: [{ id: nodeId, type: 'trend', x: 50, y: 50, config: {} }], edges: [] };
}

test('real Chromium shows Studio replacement disclosure and keeps the new-topic counter aligned with server limits', async t => {
  const f = await workspaceFixture(t), { page, api, writes, externalRequests, pageErrors } = f;
  const channel = await api('/api/channels', 'POST', { name: 'Studio disclosure fixture', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Disclosure project', topic: 'Browser-only test' });
  await page.reload();
  await openChannel(page, channel.id);
  const disclosure = page.locator('#chat-form .wf-review-warning');
  const notice = await disclosure.innerText();
  assert.match(notice, /규칙 기반/);
  assert.match(notice, /정확히 3장면/);
  assert.match(notice, /작업 기록에 그대로 저장/);
  const prompt = '브라우저에서 확인한 규칙 기반 재구성';
  await page.locator('#chat-form [name=message]').fill(prompt);
  let cancelledPrompt;
  page.once('dialog', async dialog => { cancelledPrompt = dialog.message(); await dialog.dismiss(); });
  await page.locator('#chat-form button[type=submit]').click();
  assert.match(cancelledPrompt, /정확히 3장면/);
  assert.equal(writes.length, 0, 'declining the native confirmation sends no mutating request');
  assert.equal((await api('/api/state')).episodes.find(item => item.id === episode.id).version, 1);
  let chatResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/episodes/${episode.id}/chat`);
  page.once('dialog', async dialog => { assert.match(dialog.message(), /그대로 저장/); await dialog.accept(); });
  await page.locator('#chat-form button[type=submit]').click();
  const chatResponse = await chatResponsePromise;
  assert.equal(chatResponse.status(), 200);
  const afterChat = (await api('/api/state')).episodes.find(item => item.id === episode.id);
  assert.equal(afterChat.version, 2);
  assert.equal(afterChat.scenes.length, 3);
  assert.ok(afterChat.scenes.some(scene => scene.text.includes(prompt)));
  const chatWrite = writes.find(item => item.path.endsWith('/chat'));
  assert.equal(JSON.parse(chatWrite.body).expectedVersion, 1, 'assistant request is tied to the version the browser saved');

  await closeProjectOverlay(page);
  await page.locator('[data-action=new-episode]').first().click();
  const topic = page.locator('#new-episode-topic');
  await topic.fill('😀'.repeat(250));
  assert.equal(await topic.inputValue(), '😀'.repeat(250));
  assert.equal((await page.locator('#new-episode-topic-count').innerText()).trim(), '500/500자', 'counter uses the server’s UTF-16 code-unit boundary');
  await page.locator('#modal-form input[name=title]').fill('Browser topic boundary');
  const createResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/episodes');
  await page.locator('#modal-form button[type=submit]').click();
  const createResponse = await createResponsePromise;
  assert.equal(createResponse.status(), 201);
  assert.ok((await api('/api/state')).episodes.some(item => item.title === 'Browser topic boundary' && item.topic === '😀'.repeat(250)));
  assert.deepEqual(externalRequests, [], 'the browser test makes no provider or outside requests');
  assert.deepEqual(pageErrors, []);
});

test('a hidden dirty graph alone protects a different clean active project from beforeunload and survives return', async t => {
  const f = await workspaceFixture(t), { page, api, writes } = f;
  const a = await api('/api/channels', 'POST', { name: 'Hidden graph A', platform: 'youtube', category: 'information' });
  const b = await api('/api/channels', 'POST', { name: 'Clean project B', platform: 'youtube', category: 'information' });
  const e1 = await api('/api/episodes', 'POST', { channelId: a.id, title: 'Clean A episode', topic: 'A' });
  const e2 = await api('/api/episodes', 'POST', { channelId: b.id, title: 'Clean B episode', topic: 'B' });
  const template = await api('/api/workflows', 'POST', trendNodeGraph('Shared graph'));
  for (const episode of [e1, e2]) await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: episode.channelId, episodeId: episode.id, expectedTemplateVersion: template.version });
  await page.reload(); await openChannel(page, a.id); await workbenchPanel(page, 'workflow');
  await page.locator('[data-wf-action=open-workflow-settings]').click();
  await page.locator('#wf-workflow-name').fill('Only graph A is dirty'); await page.keyboard.press('Escape');
  await workbenchPanel(page, 'studio'); await openChannel(page, b.id);
  assert.equal(await page.locator('#save-status').evaluate(e => e.className === 'unsaved'), false, 'active B episode is clean');
  let warning;
  page.once('dialog', async dialog => { warning = dialog.type(); await dialog.dismiss(); });
  await page.reload({ waitUntil: 'commit' }).catch(() => {});
  assert.equal(warning, 'beforeunload', 'hidden graph dirtiness is checked independently of episode dirtiness');
  await openChannel(page, a.id); await workbenchPanel(page, 'workflow');
  await page.locator('[data-wf-action=open-workflow-settings]').click();
  assert.equal(await page.locator('#wf-workflow-name').inputValue(), 'Only graph A is dirty');
  assert.deepEqual(writes, []);
  const state = await api('/api/state');
  for (const episode of [e1, e2]) assert.equal(state.episodes.find(e => e.id === episode.id).version, episode.version);
});

async function openChannel(page, channelId) {
  await closeProjectOverlay(page);
  const group = page.locator('.platform-group').filter({ has: page.locator(`[data-action=channel][data-id="${channelId}"]`) });
  if (!(await group.evaluate((element) => element.open))) await group.locator('summary').click();
  await group.locator(`[data-action=channel][data-id="${channelId}"]`).click();
  await workbenchPanel(page, 'studio');
}

async function closeProjectOverlay(page) {
  for (const selector of ['#project-scene-dialog', '#project-tool-dialog']) {
    if (await page.locator(`${selector}[open]`).count()) {
      await page.keyboard.press('Escape');
      await page.locator(`${selector}[open]`).waitFor({ state: 'hidden' });
    }
  }
}

async function selectEpisode(page, episodeId) {
  await closeProjectOverlay(page);
  await page.locator(`[data-action=episode][data-id="${episodeId}"]`).click();
  await workbenchPanel(page, 'studio');
}

/** Opens the "에피소드 설정" disclosure in the inspector so [data-episode=title] becomes fillable.
 * A fresh render() (e.g. after a mode switch) rebuilds #app and re-collapses this <details>. */
async function openEpisodeSettings(page) {
  const details = page.locator('.inspector details').first();
  if (!(await details.evaluate((element) => element.open))) await details.locator('summary').click();
  await page.locator('[data-episode=title]').waitFor();
}

async function workbenchPanel(page, view, { keyboard = false } = {}) {
  const sceneWasOpen = await page.locator('#project-scene-dialog[open]').count();
  await closeProjectOverlay(page);
  if (view === 'studio') {
    const button = page.locator('[data-action=open-scene-editor]').first();
    if (keyboard) { await button.focus(); await page.keyboard.press('Enter'); }
    else await button.click();
    await page.locator('#project-scene-dialog[open] #preview').waitFor();
    assert.equal(await page.locator('#project-scene-dialog').evaluate(e => e.contains(document.activeElement)), true, 'scene overlay receives focus');
  } else {
    await page.locator('#workflow-canvas').waitFor();
    if (sceneWasOpen) assert.equal(await page.locator('[data-action=open-scene-editor]').first().evaluate(e => e === document.activeElement), true, 'closing the native scene overlay restores its opener');
  }
  assert.equal(await page.locator('.task-nav [data-view=studio], .project-modes').count(), 0, 'there is no separate A/B workspace');
}

test('native scene overlay and canvas on the same project preserve both drafts and cause zero state-changing requests', async (t) => {
  const fixture = await workspaceFixture(t);
  const { page, api, writes, pageErrors, externalRequests } = fixture;
  const check = (name, condition, detail) => assert.ok(condition, `${name} :: ${JSON.stringify(detail ?? null)}`);

  const channel = await api('/api/channels', 'POST', { name: 'A/B 토글 검증 채널', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: '토글 검증 에피소드', topic: '격리된 테스트 자료' });
  const template = await api('/api/workflows', 'POST', trendNodeGraph('토글 검증 워크플로우'));
  await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  await page.reload();
  await page.locator('#app .shell').waitFor();
  await openChannel(page, channel.id);

  await openEpisodeSettings(page);
  await page.locator('[data-episode=title]').fill('스튜디오 드래프트 제목');
  await page.locator('[data-scene=title]').fill('장면 드래프트 제목');
  check('studio marks the draft unsaved before any mode switch', await page.locator('#save-status').evaluate((e) => e.className === 'unsaved'));
  check('no request has been issued by the page yet', writes.length === 0, writes);

  await workbenchPanel(page, 'workflow', { keyboard: true });
  await page.locator('#workflow-canvas').waitFor();
  check('switching to workflow mode alone must not save the studio draft (PW-01 / 2026-10-25 approval: toggling alone must not save)', writes.length === 0, writes);
  check('keyboard return restores focus to the native scene overlay opener', await page.locator('[data-action=open-scene-editor]').first().evaluate((e) => e === document.activeElement));

  await page.locator('[data-wf-action=open-workflow-settings]').click();
  await page.locator('#wf-workflow-name').fill('워크플로우 드래프트 이름');
  check('workflow settings dialog marks the draft unsaved', await page.locator('#wf-save-status').evaluate((e) => e.className === 'unsaved'));
  await page.keyboard.press('Escape');
  const writesAfterWorkflowEdit = writes.length;

  await workbenchPanel(page, 'studio', { keyboard: true });
  await page.locator('#preview').waitFor();
  check('switching back to studio mode alone must not save the workflow draft', writes.length === writesAfterWorkflowEdit, writes);
  check('studio scene draft survives the round trip instead of being reloaded from the server', await page.locator('[data-scene=title]').inputValue() === '장면 드래프트 제목');
  check('studio save status is still unsaved after the round trip (no silent save happened)', await page.locator('#save-status').evaluate((e) => e.className === 'unsaved'));

  await workbenchPanel(page, 'workflow');
  await page.locator('#workflow-canvas').waitFor();
  check('workflow name draft survives a second round trip without reopening the settings dialog', await page.locator('#wf-save-status').evaluate((e) => e.className === 'unsaved' && e.textContent.includes('저장되지 않은')));
  check('still zero state-changing requests after two full round trips', writes.length === 0, writes);

  await page.setViewportSize({ width: 375, height: 844 });
  const geometry = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  check('mode controls do not overflow a narrow viewport', geometry.scroll <= geometry.client, geometry);
  await workbenchPanel(page, 'studio');
  await page.locator('#preview').waitFor();
  check('narrow-viewport mode switch also causes zero state-changing requests', writes.length === 0, writes);
  check('narrow-viewport switch preserves the episode/scene draft', await page.locator('[data-scene=title]').inputValue() === '장면 드래프트 제목');

  const afterState = await api('/api/state');
  const serverEpisode = afterState.episodes.find((item) => item.id === episode.id);
  check('server-side episode is untouched: no write ever reached it while toggling modes', serverEpisode.version === episode.version && serverEpisode.title === episode.title);
  check('no external traffic, provider calls or script errors occurred', externalRequests.length === 0 && pageErrors.length === 0, { externalRequests, pageErrors });
});

test('switching modes targets the Workflow editor at the actually selected episode, never the first episode in global state', async (t) => {
  const fixture = await workspaceFixture(t);
  const { page, api } = fixture;
  const check = (name, condition, detail) => assert.ok(condition, `${name} :: ${JSON.stringify(detail ?? null)}`);

  // Global /api/state lists episodes rowid-DESC (most recently created first), so e2 is
  // state.episodes[0]. Selecting c1/e1 -- the *earlier-created*, non-first-in-global-list
  // episode -- means a naive "fall back to episodes[0]" bug would show e2, not e1.
  const c1 = await api('/api/channels', 'POST', { name: '실제 선택 채널', platform: 'youtube', category: 'information' });
  const e1 = await api('/api/episodes', 'POST', { channelId: c1.id, title: '실제로 선택한 에피소드', topic: '지금 작업 중인 에피소드' });
  const c2 = await api('/api/channels', 'POST', { name: '글로벌 목록상 최신 채널', platform: 'instagram', category: 'drama' });
  const e2 = await api('/api/episodes', 'POST', { channelId: c2.id, title: '글로벌 목록의 첫 항목', topic: '선택되지 않은 에피소드' });
  const template = await api('/api/workflows', 'POST', trendNodeGraph('타겟 검증 워크플로우'));
  await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: c1.id, episodeId: e1.id, expectedTemplateVersion: template.version });
  await page.reload();
  await page.locator('#app .shell').waitFor();

  await openChannel(page, c1.id);
  check('studio is actually showing the selected episode', await page.locator('.source-heading strong').innerText() === e1.title);

  await workbenchPanel(page, 'workflow');
  await page.locator('#workflow-canvas').waitFor();
  const selectedOption = await page.locator('#wf-episode').evaluate((select) => select.value);
  check(
    'A<->B switch must target the shared selected episode/channel (e1), not silently fall back to the most-recently-created episode in global state (e2)',
    selectedOption === e1.id,
    { selectedOption, expected: e1.id, wrongFallback: e2.id },
  );
});

test('switching episodes within a channel stashes each draft instead of saving or discarding it', async (t) => {
  const fixture = await workspaceFixture(t);
  const { page, api, writes } = fixture;
  const check = (name, condition, detail) => assert.ok(condition, `${name} :: ${JSON.stringify(detail ?? null)}`);

  const channel = await api('/api/channels', 'POST', { name: '에피소드 전환 검증 채널', platform: 'youtube', category: 'information' });
  const e1 = await api('/api/episodes', 'POST', { channelId: channel.id, title: '첫 번째 에피소드', topic: '첫 번째 소재' });
  const e2 = await api('/api/episodes', 'POST', { channelId: channel.id, title: '두 번째 에피소드', topic: '두 번째 소재' });
  await page.reload();
  await page.locator('#app .shell').waitFor();
  await openChannel(page, channel.id);
  await selectEpisode(page, e1.id);
  await page.locator('#preview').waitFor();
  check('studio targets the first episode once explicitly selected', await page.locator('.source-heading strong').innerText() === e1.title);

  await openEpisodeSettings(page);
  await page.locator('[data-episode=title]').fill('E1 드래프트');
  await selectEpisode(page, e2.id);
  check('switching episodes alone must not save the departing draft', writes.length === 0, writes);
  await page.locator('#preview').waitFor();
  check('studio now targets the second episode', await page.locator('.source-heading strong').innerText() === e2.title);

  await openEpisodeSettings(page);
  await page.locator('[data-episode=title]').fill('E2 드래프트');
  await selectEpisode(page, e1.id);
  check('switching back still causes zero writes', writes.length === 0, writes);
  await page.locator('#preview').waitFor();
  check('E1 draft is restored intact after the round trip, not reverted to its saved server title', await page.locator('.source-heading strong').innerText() === 'E1 드래프트');
  check('E1 is still marked unsaved after being restored', await page.locator('#save-status').evaluate((e) => e.className === 'unsaved'));

  await selectEpisode(page, e2.id);
  await page.locator('#preview').waitFor();
  check('E2 draft also survived the round trip through E1', await page.locator('.source-heading strong').innerText() === 'E2 드래프트');
  check('zero writes across the entire two-episode round trip', writes.length === 0, writes);
});

test('switching channels stashes the departing channel\'s draft instead of saving or discarding it', async (t) => {
  const fixture = await workspaceFixture(t);
  const { page, api, writes } = fixture;
  const check = (name, condition, detail) => assert.ok(condition, `${name} :: ${JSON.stringify(detail ?? null)}`);

  const c1 = await api('/api/channels', 'POST', { name: '첫 번째 채널', platform: 'youtube', category: 'information' });
  const e1 = await api('/api/episodes', 'POST', { channelId: c1.id, title: 'C1 에피소드', topic: '채널1 소재' });
  const c2 = await api('/api/channels', 'POST', { name: '두 번째 채널', platform: 'instagram', category: 'drama' });
  const e2 = await api('/api/episodes', 'POST', { channelId: c2.id, title: 'C2 에피소드', topic: '채널2 소재' });
  await page.reload();
  await page.locator('#app .shell').waitFor();

  await openChannel(page, c1.id);
  await openEpisodeSettings(page);
  await page.locator('[data-episode=title]').fill('C1 드래프트 제목');
  check('C1 is dirty before switching channels', await page.locator('#save-status').evaluate((e) => e.className === 'unsaved'));

  await openChannel(page, c2.id);
  check('switching channels alone must not save the departing channel\'s draft', writes.length === 0, writes);
  check('workspace now shows the second channel\'s own episode', await page.locator('.source-heading strong').innerText() === e2.title);

  await openEpisodeSettings(page);
  await page.locator('[data-episode=title]').fill('C2 드래프트 제목');
  await openChannel(page, c1.id);
  check('zero writes switching back to the first channel', writes.length === 0, writes);
  check('C1 draft survives the cross-channel round trip', await page.locator('.source-heading strong').innerText() === 'C1 드래프트 제목');
  check('C1 is still marked unsaved after being restored', await page.locator('#save-status').evaluate((e) => e.className === 'unsaved'));

  await openChannel(page, c2.id);
  check('C2 draft also survives the cross-channel round trip', await page.locator('.source-heading strong').innerText() === 'C2 드래프트 제목');

  const afterState = await api('/api/state');
  check('neither channel\'s episode was ever written to the server', afterState.episodes.find((item) => item.id === e1.id).title === e1.title && afterState.episodes.find((item) => item.id === e2.id).title === e2.title);
});

test('restoring a draft keeps its original base version: an explicit Save rejects a stale version instead of silently rebasing', async (t) => {
  const fixture = await workspaceFixture(t);
  const { page, api, context, base } = fixture;
  const check = (name, condition, detail) => assert.ok(condition, `${name} :: ${JSON.stringify(detail ?? null)}`);

  const channel = await api('/api/channels', 'POST', { name: '버전 충돌 검증 채널', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: '원본 제목', topic: '버전 충돌 테스트' });
  await page.reload();
  await page.locator('#app .shell').waitFor();
  await openChannel(page, channel.id);
  await openEpisodeSettings(page);
  await page.locator('[data-episode=title]').fill('로컬 드래프트 제목');
  check('local draft is dirty against base version', await page.locator('#save-status').evaluate((e) => e.className === 'unsaved'));

  // Simulate a concurrent writer (another tab / B-mode run) bumping the server-side version
  // without the open page knowing. This call bypasses the page entirely (context.request,
  // not page navigation), so it is deliberately NOT one of the page's own writes.
  const externallyBumped = await (async () => {
    const response = await context.request.fetch(`${base}/api/episodes/${episode.id}`, {
      method: 'PUT',
      headers: { origin: base, 'content-type': 'application/json' },
      data: JSON.stringify({ title: '외부에서 변경된 제목', topic: episode.topic, status: episode.status, format: episode.format, scenes: episode.scenes, notes: episode.notes, expectedVersion: episode.version }),
    });
    assert.ok(response.ok(), `external bump: ${response.status()}`);
    return response.json();
  })();
  check('external writer bumped the server version while the page was mid-edit', externallyBumped.version === episode.version + 1);

  const saveResponse = page.waitForResponse((response) => response.url() === `${base}/api/episodes/${episode.id}` && response.request().method() === 'PUT');
  await page.locator('#save-button').click();
  const response = await saveResponse;
  check('explicit Save on a stale draft sends the original base version, not a silently rebased one', JSON.parse(response.request().postData()).expectedVersion === episode.version);
  check('the server rejects the stale save with a conflict instead of silently applying it', response.status() === 409);
  check('the local unsaved draft text is preserved, not reverted to the externally-written title', await page.locator('[data-episode=title]').inputValue() === '로컬 드래프트 제목');
  check('save status remains unsaved after the rejected save (no silent success)', await page.locator('#save-status').evaluate((e) => e.className === 'unsaved'));

  const finalState = await api('/api/state');
  const serverEpisode = finalState.episodes.find((item) => item.id === episode.id);
  check('the externally-written title is the one actually persisted; the rejected local draft never silently overwrote it', serverEpisode.title === '외부에서 변경된 제목' && serverEpisode.version === episode.version + 1);
});

test('closing or navigating away with an unsaved draft triggers the native unsaved-changes warning', async (t) => {
  const fixture = await workspaceFixture(t);
  const { page, api } = fixture;
  const check = (name, condition, detail) => assert.ok(condition, `${name} :: ${JSON.stringify(detail ?? null)}`);

  const channel = await api('/api/channels', 'POST', { name: '경고 검증 채널', platform: 'youtube', category: 'information' });
  await api('/api/episodes', 'POST', { channelId: channel.id, title: '경고 검증 에피소드', topic: '경고 검증 소재' });
  await page.reload();
  await page.locator('#app .shell').waitFor();
  await openChannel(page, channel.id);
  await openEpisodeSettings(page);
  await page.locator('[data-episode=title]').fill('떠나기 전 드래프트');
  check('draft is dirty before attempting to leave', await page.locator('#save-status').evaluate((e) => e.className === 'unsaved'));

  let dialogType = null;
  page.once('dialog', async (dialog) => { dialogType = dialog.type(); await dialog.dismiss(); });
  await page.reload({ waitUntil: 'commit' }).catch(() => {});
  check('an unsaved dirty draft triggers the native beforeunload confirmation when navigating away', dialogType === 'beforeunload', { dialogType });
});

test('hovered tooltip remains scrollable without intercepting adjacent channel clicks', async (t) => {
  const fixture = await workspaceFixture(t);
  const { page, api } = fixture;
  const first = await api('/api/channels', 'POST', { name: '첫 번째 툴팁 채널', platform: 'youtube', category: 'information' });
  const second = await api('/api/channels', 'POST', { name: '두 번째 툴팁 채널', platform: 'youtube', category: 'information' });
  await page.reload();
  await page.locator('#app .shell').waitFor();

  const group = page.locator('.platform-group').filter({ has: page.locator(`[data-action=channel][data-id="${first.id}"]`) });
  const summary = group.locator('summary');
  await summary.evaluate((element) => element.setAttribute('data-tooltip', '스크롤 가능한 안내 문구입니다. '.repeat(500)));
  await summary.hover();
  const tooltip = page.locator('.ff-info-tooltip');
  await tooltip.waitFor();
  const dimensions = await tooltip.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  assert.ok(dimensions.scrollHeight > dimensions.clientHeight, `tooltip must have scrollable content: ${JSON.stringify(dimensions)}`);

  await tooltip.hover();
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => document.querySelector('.ff-info-tooltip')?.scrollTop > 0);
  assert.ok(await tooltip.isVisible(), 'hovering and scrolling the tooltip must keep it open');

  if (!await group.evaluate((element) => element.open)) await summary.click();
  await page.locator(`[data-action=channel][data-id="${first.id}"]`).click();
  assert.equal(await page.locator(`[data-action=channel][data-id="${first.id}"]`).getAttribute('aria-current'), 'true');
  await page.locator(`[data-action=channel][data-id="${second.id}"]`).click();
  assert.equal(await page.locator(`[data-action=channel][data-id="${second.id}"]`).getAttribute('aria-current'), 'true');
});
