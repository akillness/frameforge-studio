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
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-music-upload-ui-'));
  const forbidden = async () => { assert.fail('Music upload must not contact a provider'); };
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
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
    assert.deepEqual(external, [], 'no external browser traffic');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.equal(writes.some(write => /\/(run|quote|generations|publication|render)(\/|$)/.test(write.path)), false);
  });
  // Project setup is local and disposable; upload and rights are deliberately NOT seeded via API.
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const channel = await api('/api/channels', 'POST', { name: 'Audio upload fixture', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Audio upload project', topic: 'Local test audio' });
  const other = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Other audio project', topic: 'Separate project' });
  const template = await api('/api/workflows', 'POST', { name: 'Audio upload graph', nodes: [{ id: 'a', type: 'trend', label: 'A', x: 40, y: 50, config: {} }], edges: [] });
  await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  await page.goto(base); await page.locator('#app .shell').waitFor();
  const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click();
  await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
  await page.locator('#workflow-canvas').waitFor();
  return { page, base, api, writes, episode, other };
}

async function openSource(page) {
  await page.locator('[data-action=project-tools]').click();
  await page.getByRole('menuitem', { name: '소스 · 이용 권리', exact: true }).click();
  const source = page.locator('#project-tool-dialog[open] [data-production-tools][data-mode=source]');
  await source.waitFor();
  return source;
}

async function uploadThroughChooser(f, source, format) {
  const chooserPromise = f.page.waitForEvent('filechooser');
  await source.locator('[data-pt-action=upload]').click();
  const chooser = await chooserPromise;
  const accept = await chooser.element().getAttribute('accept');
  const tokens = (accept || '').toLowerCase().split(',').map(token => token.trim());
  assert.ok(tokens.includes('audio/*') || tokens.includes(format.mime) || tokens.includes(`.${format.ext}`), `${format.ext} must be selectable in the native file picker`);
  const responsePromise = f.page.waitForResponse(response => response.url().includes('/api/uploads?') && response.request().method() === 'POST');
  await chooser.setFiles({ name: `fixture-track.${format.ext}`, mimeType: format.mime, buffer: Buffer.from('local synthetic audio fixture') });
  const response = await responsePromise;
  assert.equal(response.status(), 201, await response.text());
  const upload = await response.json();
  const row = source.locator('#pt-uploads li').filter({ hasText: `fixture-track.${format.ext}` });
  await row.waitFor();
  return { upload, row };
}

for (const format of [{ ext: 'wav', mime: 'audio/wav' }, { ext: 'mp3', mime: 'audio/mpeg' }, { ext: 'ogg', mime: 'audio/ogg' }]) {
  test(`UI upload of ${format.ext} requires explicit rights and can be saved as episode music, never a visual scene`, async t => {
    const f = await fixture(t), source = await openSource(f.page);
    const { upload, row } = await uploadThroughChooser(f, source, format);
    await row.getByText('권리 미확인', { exact: true }).waitFor();
    assert.equal(await row.getByRole('button', { name: '장면에 연결' }).count(), 0, 'audio must not offer visual scene attachment');
    await row.getByRole('button', { name: '권리 정리' }).click();
    let rights = source.locator('#pt-rights-dialog[open]');
    await rights.locator('#pt-rights-form').waitFor();
    assert.equal(await rights.locator('[name=origin]:checked').count(), 0, 'unknown rights cannot be pre-approved');
    const before = f.writes.length;
    await rights.locator('button[type=submit]').click();
    assert.equal(f.writes.length, before, 'unanswered rights cannot be submitted');
    await rights.locator('[data-pt-action=close-rights]').click();
    assert.equal(f.writes.length, before, 'cancel cannot clear rights');
    await row.getByRole('button', { name: '권리 정리' }).click();
    rights = source.locator('#pt-rights-dialog[open]');
    await rights.locator('[name=origin][value=third-party]').check();
    await rights.locator('[name=sourceUrl]').fill('https://example.invalid/fixture-track');
    await rights.locator('[name=licenseId]').fill('CC-BY-4.0');
    await rights.locator('[name=attribution]').fill('Fixture composer');
    const cleared = f.page.waitForResponse(response => response.url().endsWith(`/api/uploads/${upload.id}/rights`) && response.request().method() === 'POST');
    await rights.locator('button[type=submit]').click();
    const response = await cleared; assert.equal(response.status(), 201, await response.text());
    await row.getByText('권리 정리됨', { exact: true }).waitFor();
    assert.equal(await row.getByRole('button', { name: '장면에 연결' }).count(), 0, 'cleared audio is still not a visual asset');
    await f.page.locator('#project-tool-dialog [data-action=close-project-tool]').click();
    await f.page.locator('[data-action=open-scene-editor]').first().click();
    const editor = f.page.locator('#project-scene-dialog[open]');
    const music = editor.getByLabel('음악 파일', { exact: true });
    await music.locator(`option[value="${upload.url}"]`).waitFor({ state: 'attached' });
    await music.selectOption(upload.url);
    assert.equal(await editor.getByLabel('음악 출처', { exact: true }).inputValue(), '', 'file selection alone cannot assert provenance');
    await editor.getByLabel('음악 출처', { exact: true }).selectOption('third-party');
    await editor.getByLabel('음악 출처 URL', { exact: true }).fill('https://example.invalid/fixture-track');
    await editor.getByLabel('음악 라이선스', { exact: true }).fill('CC-BY-4.0');
    await editor.getByLabel('음악 출처 표기', { exact: true }).fill('Fixture composer');
    const savedPromise = f.page.waitForResponse(response => response.url() === `${f.base}/api/episodes/${f.episode.id}` && response.request().method() === 'PUT');
    await editor.getByRole('button', { name: '변경 저장', exact: true }).click();
    const savedResponse = await savedPromise;
    assert.equal(savedResponse.status(), 200, await savedResponse.text());
    assert.equal(savedResponse.request().postDataJSON().expectedVersion, f.episode.version);
    const saved = await savedResponse.json();
    assert.equal(saved.version, f.episode.version + 1);
    assert.equal(saved.music.assetUrl, upload.url);
    for (const [key, value] of Object.entries({ origin: 'third-party', sourceUrl: 'https://example.invalid/fixture-track', licenseId: 'CC-BY-4.0', attribution: 'Fixture composer' })) assert.equal(saved.music.source[key], value);
    assert.deepEqual(saved.scenes, f.episode.scenes, 'music selection must not modify visual scenes');
    await f.page.reload(); await f.page.locator('#workflow-canvas').waitFor();
    await f.page.locator('[data-action=open-scene-editor]').first().click();
    const reopened = f.page.locator('#project-scene-dialog[open]');
    assert.equal(await reopened.getByLabel('음악 파일', { exact: true }).inputValue(), upload.url);
    assert.equal(await reopened.getByLabel('음악 출처 표기', { exact: true }).inputValue(), 'Fixture composer');
  });
}

test('canceling a rights draft and changing projects do not save the draft or change either episode', async t => {
  const f = await fixture(t), source = await openSource(f.page);
  const { row } = await uploadThroughChooser(f, source, { ext: 'wav', mime: 'audio/wav' });
  await row.getByRole('button', { name: '권리 정리' }).click();
  const rights = source.locator('#pt-rights-dialog[open]');
  await rights.locator('[name=origin][value=third-party]').check();
  await rights.locator('[name=sourceUrl]').fill('https://example.invalid/canceled');
  const before = f.writes.length;
  await rights.locator('[data-pt-action=close-rights]').click();
  await f.page.locator('#project-tool-dialog [data-action=close-project-tool]').click();
  await f.page.locator(`[data-action=episode][data-id="${f.other.id}"]`).click();
  await f.page.locator('#workflow-canvas').waitFor();
  await f.page.waitForFunction(id => document.querySelector('#wf-episode')?.value === id, f.other.id);
  assert.equal(f.writes.length, before, 'cancel and project navigation cannot mutate the server');
  const state = await f.api('/api/state');
  assert.deepEqual(state.episodes.find(item => item.id === f.episode.id), f.episode);
  assert.deepEqual(state.episodes.find(item => item.id === f.other.id), f.other);
  await f.page.locator(`[data-action=episode][data-id="${f.episode.id}"]`).click();
  await f.page.waitForFunction(id => document.querySelector('#wf-episode')?.value === id, f.episode.id);
  const reopened = await openSource(f.page);
  const retained = reopened.locator('#pt-uploads li').filter({ hasText: 'fixture-track.wav' });
  await retained.getByText('권리 미확인', { exact: true }).waitFor();
  assert.equal(f.writes.length, before, 'returning to the project cannot approve the canceled rights');
});
