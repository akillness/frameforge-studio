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

async function fixture(t, width = 1440) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-caption-editor-'));
  const forbidden = async () => { assert.fail('Caption editing must not invoke external production'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), runAgent: forbidden, fetchTrends: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1080 }, hasTouch: width < 500, reducedMotion: 'reduce', serviceWorkers: 'block' });
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
    assert.deepEqual(external, [], 'browser cannot contact external services');
    assert.deepEqual(errors, [], 'scene editor cannot throw');
    assert.equal(writes.some(write => /\/(run|quote|generations|publication|render)(\/|$)/.test(write.path)), false, 'editing cannot execute or publish');
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const channel = await api('/api/channels', 'POST', { name: 'Caption fixture', platform: 'youtube', category: 'information' });
  let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Caption project', topic: 'Local cues' });
  const first = { ...episode.scenes[0], title: 'First cue scene', duration: 8, captions: [{ start: 0.5, end: 1.5, text: 'Original' }, { start: 2, end: 3, text: 'Remove me' }] };
  const second = { ...episode.scenes[0], id: 'legacy-second-scene', title: 'Legacy second scene', duration: 8 };
  delete second.captions;
  episode = await api(`/api/episodes/${episode.id}`, 'PUT', { ...episode, scenes: [first, second], expectedVersion: episode.version });
  const template = await api('/api/workflows', 'POST', { name: 'Caption fixture graph', nodes: [{ id: 'a', type: 'trend', label: 'A', x: 40, y: 50, config: {} }], edges: [] });
  await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  await page.goto(base); await page.locator('#app .shell').waitFor();
  const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click(); await page.locator('#workflow-canvas').waitFor();
  await page.locator('[data-action=open-scene-editor]').first().click();
  const dialog = page.locator('#project-scene-dialog[open]'); await dialog.waitFor();
  return { page, dialog, base, api, writes, episode };
}

const cue = (dialog, label, index = 0) => dialog.getByLabel(label, { exact: true }).nth(index);
async function setCue(dialog, index, start, end, text) {
  await cue(dialog, '시작 (초)', index).fill(String(start));
  await cue(dialog, '종료 (초)', index).fill(String(end));
  await cue(dialog, '자막 내용', index).fill(text);
}
async function selectScene(dialog, index) {
  await dialog.locator(`.project-bin [data-action=scene][data-index="${index}"]`).click();
}
async function save(f, expectedStatus) {
  const response = f.page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${f.episode.id}` && r.request().method() === 'PUT');
  await f.dialog.getByRole('button', { name: '변경 저장', exact: true }).click();
  const actual = await response;
  assert.equal(actual.status(), expectedStatus, await actual.text());
  assert.equal(actual.request().postDataJSON().expectedVersion, f.episode.version);
  return actual;
}

test('timed cues stay with their scene through draft switching and explicit versioned save, reload and history', async t => {
  const f = await fixture(t), { dialog, page, episode } = f;
  assert.equal(await cue(dialog, '자막 내용').inputValue(), 'Original');
  await setCue(dialog, 0, 0.25, 1.75, 'Edited actual timing');
  await dialog.getByRole('button', { name: '자막 삭제', exact: true }).nth(1).click();
  await dialog.getByRole('button', { name: '자막 추가', exact: true }).click();
  await setCue(dialog, 1, 4.125, 6.5, 'New precise cue');
  await selectScene(dialog, 1);
  await selectScene(dialog, 0);
  assert.equal(await cue(dialog, '자막 내용').inputValue(), 'Edited actual timing');
  assert.equal(await cue(dialog, '시작 (초)', 1).inputValue(), '4.125');
  assert.deepEqual(f.writes, [], 'editing and switching scenes never saves or triggers production');
  assert.deepEqual((await f.api('/api/state')).episodes.find(item => item.id === episode.id), episode);
  const saved = await (await save(f, 200)).json();
  const expected = [{ start: 0.25, end: 1.75, text: 'Edited actual timing' }, { start: 4.125, end: 6.5, text: 'New precise cue' }];
  assert.deepEqual(saved.scenes.find(scene => scene.id === episode.scenes[0].id).captions, expected);
  assert.equal(Object.hasOwn(saved.scenes.find(scene => scene.id === 'legacy-second-scene'), 'captions'), false, 'unmodified missing captions stay legacy');
  const history = await f.api(`/api/episodes/${episode.id}/history`);
  assert.deepEqual(history.find(entry => entry.version === saved.version).snapshot.scenes.find(scene => scene.id === episode.scenes[0].id).captions, expected);
  assert.deepEqual(f.writes, [{ method: 'PUT', path: `/api/episodes/${episode.id}` }]);
  await page.reload(); await page.locator('#workflow-canvas').waitFor();
  await page.locator('[data-action=open-scene-editor]').first().click();
  const reopened = page.locator('#project-scene-dialog[open]');
  await selectScene(reopened, 0);
  assert.equal(await cue(reopened, '자막 내용', 1).inputValue(), 'New precise cue');
  assert.equal(await cue(reopened, '시작 (초)', 1).inputValue(), '4.125');
  assert.equal(await cue(reopened, '종료 (초)', 1).inputValue(), '6.5');
});

test('stale caption save rejects the base version without losing the local cue draft', async t => {
  const f = await fixture(t), { dialog, episode } = f;
  await setCue(dialog, 0, 0.75, 1.25, 'Local conflict draft');
  const concurrent = await f.api(`/api/episodes/${episode.id}`, 'PUT', { ...episode, title: 'Concurrent title', expectedVersion: episode.version });
  await save(f, 409);
  assert.equal(await cue(dialog, '자막 내용').inputValue(), 'Local conflict draft');
  assert.equal(await cue(dialog, '시작 (초)').inputValue(), '0.75');
  assert.equal(await cue(dialog, '종료 (초)').inputValue(), '1.25');
  assert.deepEqual((await f.api('/api/state')).episodes.find(item => item.id === episode.id), concurrent);
});

test('invalid scene-relative interval blocks persistence until corrected', async t => {
  const f = await fixture(t), { dialog, episode } = f;
  await setCue(dialog, 0, 7.5, 8.5, 'Outside scene');
  await dialog.getByRole('button', { name: '변경 저장', exact: true }).click();
  assert.deepEqual(f.writes, [], 'out-of-bounds cue cannot be sent as a save');
  assert.deepEqual((await f.api('/api/state')).episodes.find(item => item.id === episode.id), episode);
  assert.equal(await cue(dialog, '자막 내용').inputValue(), 'Outside scene');
  await setCue(dialog, 0, 7, 8, 'Ends at boundary');
  const saved = await (await save(f, 200)).json();
  assert.deepEqual(saved.scenes[0].captions[0], { start: 7, end: 8, text: 'Ends at boundary' });
});

for (const width of [320, 390]) {
  test(`${width}px caption controls remain reachable and editable without saving`, async t => {
    const f = await fixture(t, width), { dialog, page } = f;
    await dialog.getByRole('button', { name: '자막 추가', exact: true }).click();
    for (const control of [cue(dialog, '시작 (초)', 2), cue(dialog, '종료 (초)', 2), cue(dialog, '자막 내용', 2), dialog.getByRole('button', { name: '자막 삭제', exact: true }).nth(2)]) {
      await control.scrollIntoViewIfNeeded();
      assert.equal(await control.evaluate(element => {
        const r = element.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }), true, 'caption control fits in the mobile viewport');
    }
    await setCue(dialog, 2, 3.25, 4.75, `Mobile ${width} cue`);
    assert.equal(await cue(dialog, '자막 내용', 2).inputValue(), `Mobile ${width} cue`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'page does not overflow horizontally');
    assert.deepEqual(f.writes, []);
  });
}
