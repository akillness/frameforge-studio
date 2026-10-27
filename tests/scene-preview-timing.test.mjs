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

// A real local PCM file lets Chromium exercise its media implementation without FFmpeg or a provider.
function wav(seconds = 20) {
  const rate = 8000, count = rate * seconds, bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + 2 * i);
  return bytes;
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-preview-'));
  const forbidden = async () => { assert.fail('Preview must not invoke an external provider'); };
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
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const writes = [], external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname });
    return route.continue();
  });
  // Observe native media elements, including detached Audio instances; never replace play or suppress rejection.
  await page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play;
    window.previewMedia = [];
    HTMLMediaElement.prototype.play = function (...args) {
      if (!window.previewMedia.includes(this)) window.previewMedia.push(this);
      return original.apply(this, args);
    };
  });
  t.after(async () => {
    await context.close(); await browser.close();
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.deepEqual(external, [], 'preview cannot contact external services');
    assert.deepEqual(errors, [], 'preview cannot throw in the browser');
    assert.deepEqual(writes, [], 'preview and draft editing cannot persist or start production');
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const upload = async name => {
    const response = await context.request.post(`${base}/api/uploads?name=${name}`, { headers: { origin: base, 'content-type': 'audio/wav' }, data: wav() });
    assert.equal(response.status(), 201, await response.text());
    return response.json();
  };
  const narration = await upload('narration.wav'), music = await upload('music.wav');
  const channel = await api('/api/channels', 'POST', { name: 'Preview fixture', platform: 'youtube', category: 'information' });
  let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Preview project', topic: 'Local timeline' });
  const scene = episode.scenes[0];
  const first = { ...scene, title: 'Timed scene', text: 'Legacy first text', duration: 8, audioUrl: narration.url, audioVolume: 0.7, captions: [{ start: 1, end: 2, text: 'First cue' }, { start: 3, end: 4, text: 'Second cue' }] };
  const empty = { ...scene, id: 'preview-empty', title: 'Empty scene', text: 'Empty must not become a caption', duration: 8, captions: [] };
  const legacy = { ...scene, id: 'preview-legacy', title: 'Legacy scene', text: 'Legacy caption text', duration: 8 };
  delete legacy.captions;
  episode = await api(`/api/episodes/${episode.id}`, 'PUT', { ...episode, scenes: [first, empty, legacy], expectedVersion: episode.version });
  const template = await api('/api/workflows', 'POST', { name: 'Preview graph', nodes: [{ id: 'a', type: 'trend', label: 'A', x: 40, y: 50, config: {} }], edges: [] });
  await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  await page.clock.install({ time: new Date('2024-01-01T00:00:00Z') });
  await page.goto(base); await page.locator('#app .shell').waitFor();
  const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click(); await page.locator('#workflow-canvas').waitFor();
  await page.locator('[data-action=open-scene-editor]').first().click();
  const dialog = page.locator('#project-scene-dialog[open]'); await dialog.waitFor();
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
  return { page, dialog, api, episode, music, narration, writes };
}

const scene = (dialog, index) => dialog.locator(`.project-bin [data-action=scene][data-index="${index}"]`);
const play = dialog => dialog.locator('[data-action=play]');
const preview = dialog => dialog.locator('#preview');
async function contains(dialog, text) { return preview(dialog).getByText(text, { exact: true }).isVisible(); }
async function activeMedia(page, url) {
  return page.evaluate(url => window.previewMedia.map((media, index) => ({ media, index })).filter(item => new URL(item.media.currentSrc || item.media.src, location.href).pathname === url).map(({ media, index }) => ({ index, paused: media.paused, time: media.currentTime, volume: media.volume, error: media.error?.code ?? null })), url);
}

test('scene-relative captions use draft intervals and distinguish empty from legacy text', { timeout: 30000 }, async t => {
  const { page, dialog, api, episode } = await fixture(t);
  await dialog.getByLabel('자막 내용', { exact: true }).first().fill('Draft first cue');
  await play(dialog).click();
  assert.equal(await contains(dialog, 'Draft first cue'), false, 'cue is absent before its start');
  assert.equal(await contains(dialog, 'Legacy first text'), false, 'timed cues replace legacy caption text');
  await page.clock.runFor(1100);
  assert.equal(await contains(dialog, 'Draft first cue'), true, 'unsaved cue appears within its interval');
  await page.clock.runFor(1000);
  assert.equal(await contains(dialog, 'Draft first cue'), false, 'cue disappears after its end');
  assert.equal(await contains(dialog, 'Second cue'), false, 'next cue is absent before its start');
  await page.clock.runFor(1000);
  assert.equal(await contains(dialog, 'Second cue'), true, 'second cue appears within its own interval');
  await page.clock.runFor(1000);
  assert.equal(await contains(dialog, 'Second cue'), false, 'second cue disappears after its end');
  await scene(dialog, 1).click();
  await play(dialog).click(); await page.clock.runFor(1100);
  assert.equal(await contains(dialog, 'Empty must not become a caption'), false, 'explicit empty captions do not fall back');
  await scene(dialog, 2).click();
  await play(dialog).click(); await page.clock.runFor(1100);
  assert.equal(await contains(dialog, 'Legacy caption text'), true, 'missing captions preserve the legacy scene text');
  assert.deepEqual((await api('/api/state')).episodes.find(item => item.id === episode.id), episode, 'preview leaves the saved episode unchanged');
});

test('draft music follows episode offset and trim alongside scene audio, then stops on navigation', { timeout: 30000 }, async t => {
  const { page, dialog, music, narration, api, episode } = await fixture(t);
  await dialog.getByLabel('음악 파일', { exact: true }).selectOption(music.url);
  await dialog.getByLabel('음악 시작 (초)', { exact: true }).fill('1.25');
  await dialog.getByLabel('음악 트림 시작 (초)', { exact: true }).fill('0.75');
  await dialog.getByLabel('음악 볼륨', { exact: true }).fill('0.35');
  await play(dialog).click();
  assert.equal((await activeMedia(page, music.url)).filter(item => !item.paused).length, 0, 'music is silent before its episode start');
  await page.clock.runFor(1400);
  const background = (await activeMedia(page, music.url)).filter(item => !item.paused);
  const foreground = (await activeMedia(page, narration.url)).filter(item => !item.paused);
  assert.equal(background.length, 1, 'draft music plays after its offset');
  assert.equal(foreground.length, 1, 'scene audio continues alongside music');
  assert.equal(background[0].error, null); assert.equal(foreground[0].error, null);
  assert.ok(Math.abs(background[0].volume - 0.35) < 0.001, 'music uses draft volume');
  assert.ok(background[0].time >= 0.7 && background[0].time < 1.5, 'music starts at its trim offset');
  await page.clock.runFor(6700);
  assert.equal(await scene(dialog, 1).getAttribute('aria-current'), 'true', 'playback advances to the next scene');
  const continued = (await activeMedia(page, music.url)).filter(item => !item.paused);
  assert.equal(continued.length, 1, 'one music stream continues across the scene boundary');
  await play(dialog).click();
  assert.equal((await activeMedia(page, music.url)).filter(item => !item.paused).length, 0, 'stop pauses music');
  await play(dialog).click();
  const resumed = (await activeMedia(page, music.url)).filter(item => !item.paused);
  assert.equal(resumed.length, 1, 'starting at the second scene plays music');
  assert.ok(resumed[0].time >= 7.3 && resumed[0].time < 8.5, 'music seeks to trim plus elapsed episode time');
  await scene(dialog, 2).click();
  assert.equal((await activeMedia(page, music.url)).filter(item => !item.paused).length, 0, 'manual navigation stops music');
  assert.equal((await activeMedia(page, narration.url)).filter(item => !item.paused).length, 0, 'manual navigation stops scene audio');
  assert.deepEqual((await api('/api/state')).episodes.find(item => item.id === episode.id), episode, 'unsaved music is not persisted');
});
