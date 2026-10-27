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
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-music-editor-'));
  const forbidden = async () => { assert.fail('Music editing cannot invoke an external provider'); };
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
    assert.deepEqual(external, [], 'browser external requests are blocked');
    assert.deepEqual(errors, [], 'scene editor cannot throw');
    assert.equal(writes.some(write => /\/(run|quote|generations|publication|render)(\/|$)/.test(write.path)), false, 'music editing cannot execute or publish');
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const response = await context.request.post(`${base}/api/uploads?name=existing-music.wav`, { headers: { origin: base, 'content-type': 'audio/wav' }, data: Buffer.from('local test audio bytes') });
  assert.equal(response.status(), 201, await response.text());
  const upload = await response.json();
  const source = { origin: 'third-party', sourceUrl: 'https://example.invalid/music', licenseId: 'CC-BY-4.0', attribution: 'Fixture composer' };
  await api(`/api/uploads/${upload.id}/rights`, 'POST', source);
  const channel = await api('/api/channels', 'POST', { name: 'Music fixture', platform: 'youtube', category: 'information' });
  let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Music project', topic: 'Local audio' });
  episode = await api(`/api/episodes/${episode.id}`, 'PUT', { ...episode, scenes: [{ ...episode.scenes[0], duration: 8, title: 'First music scene' }, { ...episode.scenes[0], id: 'music-second-scene', duration: 8, title: 'Second music scene' }], expectedVersion: episode.version });
  const template = await api('/api/workflows', 'POST', { name: 'Music graph', nodes: [{ id: 'a', type: 'trend', label: 'A', x: 40, y: 50, config: {} }], edges: [] });
  await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  await page.goto(base); await page.locator('#app .shell').waitFor();
  const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click(); await page.locator('#workflow-canvas').waitFor();
  await page.locator('[data-action=open-scene-editor]').first().click();
  const dialog = page.locator('#project-scene-dialog[open]'); await dialog.waitFor();
  return { page, dialog, base, api, writes, episode, upload, source };
}

const field = (dialog, label) => dialog.getByLabel(label, { exact: true });
async function chooseMusic(f) {
  await field(f.dialog, '음악 파일').selectOption(f.upload.url);
  await field(f.dialog, '음악 출처').selectOption('third-party');
  await field(f.dialog, '음악 출처 URL').fill(f.source.sourceUrl);
  await field(f.dialog, '음악 라이선스').fill(f.source.licenseId);
  await field(f.dialog, '음악 출처 표기').fill(f.source.attribution);
  await field(f.dialog, '음악 시작 (초)').fill('1.25');
  await field(f.dialog, '음악 트림 시작 (초)').fill('0.75');
  await field(f.dialog, '음악 볼륨').fill('0.35');
}
async function save(f, status) {
  const pending = f.page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${f.episode.id}` && r.request().method() === 'PUT');
  await f.dialog.getByRole('button', { name: '변경 저장', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), status, await response.text());
  assert.equal(response.request().postDataJSON().expectedVersion, f.episode.version);
  return response;
}

test('explicitly sourced music preserves independent placement and trim through draft switching, save, history and reload', async t => {
  const f = await fixture(t), { dialog, episode, page } = f;
  await field(dialog, '음악 파일').selectOption(f.upload.url);
  assert.equal(await field(dialog, '음악 출처').inputValue(), '', 'selecting a file cannot silently claim rights');
  await dialog.getByRole('button', { name: '변경 저장', exact: true }).click();
  assert.deepEqual(f.writes, [], 'missing explicit origin blocks save');
  await chooseMusic(f);
  await dialog.locator('.project-bin [data-action=scene][data-index="1"]').click();
  await dialog.locator('[data-scene=title]').fill('Second scene local draft');
  await dialog.locator('.project-bin [data-action=scene][data-index="0"]').click();
  assert.equal(await field(dialog, '음악 시작 (초)').inputValue(), '1.25');
  assert.equal(await field(dialog, '음악 트림 시작 (초)').inputValue(), '0.75');
  assert.equal(await field(dialog, '음악 볼륨').inputValue(), '0.35');
  assert.deepEqual(f.writes, [], 'selection, provenance and scene switching are draft-only');
  assert.deepEqual((await f.api('/api/state')).episodes.find(item => item.id === episode.id), episode);
  const saved = await (await save(f, 200)).json();
  assert.equal(saved.music.assetUrl, f.upload.url);
  assert.equal(saved.music.start, 1.25);
  assert.equal(saved.music.trimStart, 0.75);
  assert.equal(saved.music.volume, 0.35);
  for (const [key, value] of Object.entries(f.source)) assert.equal(saved.music.source[key], value);
  assert.equal(saved.scenes.find(scene => scene.id === 'music-second-scene').title, 'Second scene local draft');
  const history = await f.api(`/api/episodes/${episode.id}/history`);
  assert.deepEqual(history.find(entry => entry.version === saved.version).snapshot.music, saved.music);
  assert.deepEqual(f.writes, [{ method: 'PUT', path: `/api/episodes/${episode.id}` }]);
  await page.reload(); await page.locator('#workflow-canvas').waitFor();
  await page.locator('[data-action=open-scene-editor]').first().click();
  const reopened = page.locator('#project-scene-dialog[open]');
  assert.equal(await field(reopened, '음악 파일').inputValue(), f.upload.url);
  assert.equal(await field(reopened, '음악 시작 (초)').inputValue(), '1.25');
  assert.equal(await field(reopened, '음악 트림 시작 (초)').inputValue(), '0.75');
  assert.equal(await field(reopened, '음악 볼륨').inputValue(), '0.35');
  assert.equal(await field(reopened, '음악 출처 표기').inputValue(), f.source.attribution);
  await reopened.getByRole('status').filter({ hasText: /배경 음악.*게시.*(보류|차단)/ }).waitFor();
  assert.equal(f.writes.length, 1, 'warning and reload do not attempt publication');
});

test('invalid music values cannot save, and a stale save retains the music draft', async t => {
  const f = await fixture(t), { dialog, episode } = f;
  await chooseMusic(f);
  await field(dialog, '음악 볼륨').fill('2.5');
  await dialog.getByRole('button', { name: '변경 저장', exact: true }).click();
  assert.deepEqual(f.writes, [], 'volume outside the supported range blocks save');
  await field(dialog, '음악 볼륨').fill('0.35');
  const concurrent = await f.api(`/api/episodes/${episode.id}`, 'PUT', { ...episode, title: 'Concurrent music project', expectedVersion: episode.version });
  await save(f, 409);
  assert.equal(await field(dialog, '음악 파일').inputValue(), f.upload.url);
  assert.equal(await field(dialog, '음악 시작 (초)').inputValue(), '1.25');
  assert.equal(await field(dialog, '음악 트림 시작 (초)').inputValue(), '0.75');
  assert.equal(await field(dialog, '음악 출처 표기').inputValue(), f.source.attribution);
  assert.deepEqual((await f.api('/api/state')).episodes.find(item => item.id === episode.id), concurrent);
});

for (const width of [320, 390]) {
  test(`${width}px music controls remain accessible and editable without persistence`, async t => {
    const f = await fixture(t, width), { dialog, page } = f;
    await chooseMusic(f);
    for (const label of ['음악 파일', '음악 출처', '음악 시작 (초)', '음악 트림 시작 (초)', '음악 볼륨', '음악 출처 URL', '음악 라이선스', '음악 출처 표기']) {
      const control = field(dialog, label);
      await control.scrollIntoViewIfNeeded();
      assert.equal(await control.evaluate(element => {
        const r = element.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      }), true, `${label} fits the mobile viewport`);
    }
    assert.equal(await field(dialog, '음악 트림 시작 (초)').inputValue(), '0.75');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.deepEqual(f.writes, []);
  });
}
