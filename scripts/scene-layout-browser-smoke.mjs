/**
 * Real-browser acceptance gate for the bounded scene layout editor.
 * Uses an isolated loopback app and disposable fixtures; no production data,
 * provider execution, rendering, publication, or external HTTP egress.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';

const artifactDir = resolve('artifacts');
const screenshotDir = join(artifactDir, 'scene-layout-browser-smoke');
const receiptPath = join(artifactDir, 'scene-layout-browser-smoke.json');
await mkdir(screenshotDir, { recursive: true });
await rm(join(screenshotDir, 'failure.png'), { force: true });

const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-scene-layout-fixture-'));
const token = randomUUID();
const receipt = {
  scope: 'Isolated loopback app with disposable fixtures; scene-layout editor only',
  startedAt: new Date().toISOString(),
  checks: [],
  pageErrors: [],
  consoleErrors: [],
  expectedAuthConsoleErrors: [],
  unexpectedConsoleErrors: [],
  externalRequests: [],
  unauthorizedResponses: [],
  expectedAuthResponses: [],
  providerCalls: [],
  browserWrites: [],
  fixtureRequests: [],
  screenshots: [],
};
const check = (name, condition, detail) => {
  assert.ok(condition, JSON.stringify({ name, detail }));
  receipt.checks.push(name);
  console.log(name);
};
const forbidden = name => async () => {
  receipt.providerCalls.push(name);
  throw new Error(`Forbidden in scene layout browser test: ${name}`);
};

let app;
let browser;
let context;
let page;
let base = '';
let phase = 'login';
let allowedEpisodePath = '';
let originalFetch;
const relativeShot = name => `artifacts/scene-layout-browser-smoke/${name}`;

try {
  app = createApp({
    dataDir,
    loginToken: token,
    publicOrigin: '',
    integrations: {
      integrationStatus: async () => ({ studio: { available: false, status: 'unavailable', detail: 'Isolated browser test' } }),
      runAgent: forbidden('agent'),
      fetchTrends: forbidden('trends'),
    },
    speech: {
      listVoices: async () => ({ available: false, voices: [], detail: 'Isolated browser test' }),
      synthesize: forbidden('speech'),
    },
    generation: {
      capability: async () => ({ available: false, status: 'unavailable' }),
      models: async () => [],
      modelSchema: forbidden('generation-schema'),
      submit: forbidden('generation-submit'),
      status: forbidden('generation-status'),
    },
    renderer: forbidden('render'),
  });
  await new Promise(resolveListen => app.listen(0, '127.0.0.1', resolveListen));
  const port = app.address().port;
  assert.ok(port > 1024 && port !== 4310);
  base = `http://127.0.0.1:${port}`;

  originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (!base || new URL(url).origin !== base) {
      receipt.externalRequests.push(String(url));
      throw new Error('External fetch blocked');
    }
    return originalFetch(url, options);
  };

  const installed = process.env.OPS_PLAYWRIGHT_MODULE || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const { chromium } = await import(pathToFileURL(installed));
  const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.OPS_CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  ].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => receipt.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    receipt.consoleErrors.push(text);
    if (phase === 'login' && text.includes('401')) receipt.expectedAuthConsoleErrors.push(text);
    else receipt.unexpectedConsoleErrors.push(text);
  });
  page.on('response', response => {
    if (response.status() !== 401) return;
    if (phase === 'login' && new URL(response.url()).pathname === '/api/state') receipt.expectedAuthResponses.push(response.url());
    else receipt.unauthorizedResponses.push(response.url());
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      receipt.externalRequests.push(request.url());
      return route.abort();
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      const write = { phase, method: request.method(), path: url.pathname };
      receipt.browserWrites.push(write);
      const loginWrite = phase === 'login' && request.method() === 'POST' && url.pathname === '/api/login';
      const uploadWrite = phase === 'edit' && request.method() === 'POST' && url.pathname === '/api/uploads';
      const episodeWrite = phase === 'save' && request.method() === 'PUT' && url.pathname === allowedEpisodePath;
      if (!loginWrite && !uploadWrite && !episodeWrite) return route.fulfill({ status: 409, json: { error: 'Unexpected mutation blocked' } });
    }
    return route.continue();
  });

  await page.goto(base);
  await page.locator('#login-form').waitFor();
  check('authentication gate is shown before the scene editor', await page.locator('#ops-workspace').count() === 0);
  await page.locator('#login-form input').fill(token);
  await page.locator('#login-form button').click();
  await page.locator('#ops-workspace').waitFor();
  phase = 'fixture';

  const request = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body ? { data: body } : {}) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    if (method !== 'GET') receipt.fixtureRequests.push({ method, path, status: response.status() });
    return response.json();
  };
  const channel = await request('/api/channels', 'POST', { name: '씬 레이아웃 격리 채널', platform: 'youtube', category: 'information' });
  const episode = await request('/api/episodes', 'POST', { channelId: channel.id, title: '씬 슬롯 편집 브라우저 검증', topic: '로컬 브라우저 픽스처' });
  allowedEpisodePath = `/api/episodes/${episode.id}`;

  await page.reload();
  await page.locator('#ops-workspace').waitFor();
  const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`);
  await channelButton.click();
  await page.locator('#preview').waitFor();
  await page.locator('.slot-builder-box').waitFor();
  check('channel navigation opens the scene layout editor', await page.locator('.slot-builder-box').isVisible() && await page.locator('#preview').isVisible());
  check('editor starts with the fixture scene and no unsupported slot state', await page.locator('.scene-card').count() === 1 && await page.locator('.preview-slot').count() === 0);

  await page.locator('[data-action=apply-layout-preset][data-preset=premiere-3tier]').click();
  check('premiere preset switches to the supported four-slot layout', await page.locator('.preview-slot').count() === 4 && await page.locator('.preview-slot.role-html-overlay').count() === 1 && await page.locator('.preview-slot.role-image-gen').count() === 1 && await page.locator('.preview-slot.role-video-bg').count() === 1 && await page.locator('.preview-slot.role-subtitle-layer').count() === 1);
  await page.locator('[data-action=apply-layout-preset][data-preset=top-image-mid-video]:not([data-scope=all])').click();
  check('top-image preset switches back to the supported image-text-video-subtitle layout', await page.locator('.preview-slot').count() === 4 && await page.locator('.preview-slot.role-text-overlay').count() === 1 && await page.locator('.preview-slot.role-html-overlay').count() === 0);
  await page.locator('[data-action=apply-layout-preset][data-preset=clear]').click();
  check('clear preset removes the prior scene slots before custom additions', await page.locator('.preview-slot').count() === 0 && await page.locator('[data-slot-field]').count() === 0);

  phase = 'edit';
  const addSlot = async role => {
    const before = await page.locator(`.preview-slot.role-${role}`).count();
    await page.locator(`[data-action=add-slot][data-role=${role}]`).click();
    await page.locator(`.preview-slot.role-${role}`).nth(before).waitFor();
    check(`${role} slot can be added from the scene editor`, await page.locator(`.preview-slot.role-${role}`).count() === before + 1 && await page.locator('[data-slot-field=role]').inputValue() === role);
    return page.locator('.slot-pill-list button.primary');
  };

  const imagePill = await addSlot('image-gen');
  const imageId = await imagePill.getAttribute('data-slot-id');
  assert.ok(imageId);
  await page.locator('[data-slot-field=name]').fill('주요 이미지 카드');
  await page.locator('[data-slot-field=prompt]').fill('격리 테스트 이미지 연출');
  await page.locator('[data-slot-field=x]').fill('12');
  await page.locator('[data-slot-field=y]').fill('8');
  await page.locator('[data-slot-field=w]').fill('70');
  await page.locator('[data-slot-field=h]').fill('32');
  await page.locator('[data-slot-field=zIndex]').fill('4');
  await page.locator('[data-slot-style=fontSize]').fill('36');
  await page.locator('[data-slot-style=opacity]').fill('0.8');
  check('image slot edits update the inspector contract', await page.locator('[data-slot-field=name]').inputValue() === '주요 이미지 카드' && await page.locator('[data-slot-field=prompt]').inputValue() === '격리 테스트 이미지 연출' && await page.locator('[data-slot-field=x]').inputValue() === '12' && await page.locator('[data-slot-field=y]').inputValue() === '8' && await page.locator('[data-slot-field=w]').inputValue() === '70' && await page.locator('[data-slot-field=h]').inputValue() === '32' && await page.locator('[data-slot-field=zIndex]').inputValue() === '4');

  const imageUploadResponse = page.waitForResponse(response => response.url().startsWith(`${base}/api/uploads?name=scene-image.png`) && response.request().method() === 'POST');
  await page.locator(`[data-action=upload-slot-media][data-slot-id="${imageId}"]`).click();
  await page.locator('#media-file').setInputFiles({ name: 'scene-image.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
  const imageUpload = await imageUploadResponse;
  assert.ok(imageUpload.ok(), `image upload: ${imageUpload.status()}`);
  await page.locator(`.preview-slot.role-image-gen[data-slot-id="${imageId}"] img.slot-media`).waitFor();
  const imageSrc = await page.locator(`.preview-slot.role-image-gen[data-slot-id="${imageId}"] img.slot-media`).getAttribute('src');
  check('image slot accepts a local image attachment without provider execution', await page.locator(`.preview-slot.role-image-gen[data-slot-id="${imageId}"] img.slot-media`).count() === 1 && new URL(imageSrc, base).pathname.startsWith('/api/uploads/'), { imageSrc });

  const textPill = await addSlot('text-overlay');
  const textId = await textPill.getAttribute('data-slot-id');
  assert.ok(textId);
  await page.locator('[data-slot-field=name]').fill('텍스트 오버레이 카드');
  await page.locator('[data-slot-field=text]').fill('화면 제목 텍스트');
  await page.locator('[data-slot-field=x]').fill('10');
  await page.locator('[data-slot-field=y]').fill('45');
  await page.locator('[data-slot-field=w]').fill('80');
  await page.locator('[data-slot-field=h]').fill('14');
  await page.locator('[data-slot-field=zIndex]').fill('6');
  await page.locator('[data-slot-style=fontSize]').fill('40');
  await page.locator('[data-slot-style=align]').selectOption('left');
  await page.locator('[data-slot-style=badge]').fill('HEADLINE');
  check('text slot edits preserve copy, geometry, z-order and supported styling', await page.locator('[data-slot-field=text]').inputValue() === '화면 제목 텍스트' && await page.locator('[data-slot-field=zIndex]').inputValue() === '6' && await page.locator('[data-slot-style=fontSize]').inputValue() === '40' && await page.locator('[data-slot-style=align]').inputValue() === 'left' && await page.locator('[data-slot-style=badge]').inputValue() === 'HEADLINE');

  const videoPill = await addSlot('video-bg');
  const videoId = await videoPill.getAttribute('data-slot-id');
  assert.ok(videoId);
  await page.locator('[data-slot-field=name]').fill('Higgsfield 배경 영상');
  await page.locator('[data-slot-field=prompt]').fill('장면 전환용 배경 영상 연출');
  await page.locator('[data-slot-field=x]').fill('0');
  await page.locator('[data-slot-field=y]').fill('20');
  await page.locator('[data-slot-field=w]').fill('100');
  await page.locator('[data-slot-field=h]').fill('65');
  await page.locator('[data-slot-field=zIndex]').fill('1');
  check('video slot edits preserve prompt and bounded geometry controls', await page.locator('[data-slot-field=prompt]').inputValue() === '장면 전환용 배경 영상 연출' && await page.locator('[data-slot-field=x]').inputValue() === '0' && await page.locator('[data-slot-field=w]').inputValue() === '100' && await page.locator('[data-slot-field=h]').inputValue() === '65' && await page.locator('[data-slot-field=zIndex]').inputValue() === '1');

  const subtitlePill = await addSlot('subtitle-layer');
  const subtitleId = await subtitlePill.getAttribute('data-slot-id');
  assert.ok(subtitleId);
  await page.locator('[data-slot-field=name]').fill('자막 스타일 레이어');
  await page.locator('[data-slot-field=text]').fill('검증용 자막 문장');
  await page.locator('[data-slot-field=x]').fill('6');
  await page.locator('[data-slot-field=y]').fill('72');
  await page.locator('[data-slot-field=w]').fill('88');
  await page.locator('[data-slot-field=h]').fill('20');
  await page.locator('[data-slot-field=zIndex]').fill('10');
  await page.locator('[data-slot-style=fontSize]').fill('48');
  await page.locator('[data-slot-style=opacity]').fill('0.75');
  await page.locator('[data-slot-style=align]').selectOption('center');
  await page.locator('[data-slot-style=badge]').fill('CC');
  const subtitleVisual = await page.locator(`.preview-slot.role-subtitle-layer[data-slot-id="${subtitleId}"] .slot-copy`).evaluate(element => ({ text: element.textContent, fontSize: element.style.fontSize, align: element.style.textAlign }));
  check('subtitle styling reaches the rendered preview', subtitleVisual.text === '검증용 자막 문장' && subtitleVisual.fontSize === '48px' && subtitleVisual.align === 'center');

  const zOrder = await page.locator('.preview-slot').evaluateAll(elements => elements.map(element => element.dataset.slotId));
  check('preview renders slots in the configured z-index order', JSON.stringify(zOrder) === JSON.stringify([videoId, imageId, textId, subtitleId]), zOrder);
  await page.screenshot({ path: join(screenshotDir, 'before-save.png'), fullPage: true });
  receipt.screenshots.push(relativeShot('before-save.png'));

  phase = 'save';
  const saveResponse = page.waitForResponse(response => response.url() === `${base}${allowedEpisodePath}` && response.request().method() === 'PUT');
  await page.locator('[data-action=save]').click();
  const savedResponse = await saveResponse;
  assert.ok(savedResponse.ok(), `episode save: ${savedResponse.status()}`);
  const savedState = await request('/api/state');
  const savedEpisode = savedState.episodes.find(item => item.id === episode.id);
  check('save persists custom slot roles and edited values', savedEpisode.version === episode.version + 1 && savedEpisode.scenes[0].slots.length === 4 && savedEpisode.scenes[0].slots.find(slot => slot.id === imageId)?.assetUrl?.startsWith('/api/uploads/') && savedEpisode.scenes[0].slots.find(slot => slot.id === textId)?.text === '화면 제목 텍스트' && savedEpisode.scenes[0].slots.find(slot => slot.id === videoId)?.prompt === '장면 전환용 배경 영상 연출' && savedEpisode.scenes[0].slots.find(slot => slot.id === subtitleId)?.style?.fontSize === 48);

  await page.reload();
  await page.locator('#ops-workspace').waitFor();
  await page.locator(`[data-action=channel][data-id="${channel.id}"]`).click();
  await page.locator('.slot-builder-box').waitFor();
  check('reload returns to the saved scene layout editor', await page.locator('.preview-slot').count() === 4 && await page.locator('.preview-slot.role-image-gen img.slot-media').count() === 1);
  await page.locator(`[data-action=select-slot][data-slot-id="${imageId}"]`).click();
  check('reload preserves image slot geometry and prompt', await page.locator('[data-slot-field=name]').inputValue() === '주요 이미지 카드' && await page.locator('[data-slot-field=prompt]').inputValue() === '격리 테스트 이미지 연출' && await page.locator('[data-slot-field=x]').inputValue() === '12' && await page.locator('[data-slot-field=y]').inputValue() === '8' && await page.locator('[data-slot-field=zIndex]').inputValue() === '4');
  await page.locator(`[data-action=select-slot][data-slot-id="${textId}"]`).click();
  check('reload preserves text slot copy and styling', await page.locator('[data-slot-field=text]').inputValue() === '화면 제목 텍스트' && await page.locator('[data-slot-style=fontSize]').inputValue() === '40' && await page.locator('[data-slot-style=align]').inputValue() === 'left' && await page.locator('[data-slot-style=badge]').inputValue() === 'HEADLINE');
  await page.locator(`[data-action=select-slot][data-slot-id="${videoId}"]`).click();
  check('reload preserves video slot prompt and geometry', await page.locator('[data-slot-field=prompt]').inputValue() === '장면 전환용 배경 영상 연출' && await page.locator('[data-slot-field=y]').inputValue() === '20' && await page.locator('[data-slot-field=h]').inputValue() === '65' && await page.locator('[data-slot-field=zIndex]').inputValue() === '1');
  await page.locator(`[data-action=select-slot][data-slot-id="${subtitleId}"]`).click();
  check('reload preserves subtitle copy and styling', await page.locator('[data-slot-field=text]').inputValue() === '검증용 자막 문장' && await page.locator('[data-slot-style=fontSize]').inputValue() === '48' && await page.locator('[data-slot-style=opacity]').inputValue() === '0.75' && await page.locator('[data-slot-style=badge]').inputValue() === 'CC');
  await page.screenshot({ path: join(screenshotDir, 'after-reload.png'), fullPage: true });
  receipt.screenshots.push(relativeShot('after-reload.png'));

  check('browser did not call providers or external origins', receipt.providerCalls.length === 0 && receipt.externalRequests.length === 0 && receipt.pageErrors.length === 0 && receipt.unexpectedConsoleErrors.length === 0 && receipt.unauthorizedResponses.length === 0, receipt);
  const expectedWrites = receipt.browserWrites.filter(item => item.path !== '/api/login');
  check('browser mutations are limited to local uploads and one episode save', expectedWrites.length === 2 && expectedWrites.some(item => item.path === '/api/uploads') && expectedWrites.some(item => item.path === allowedEpisodePath) && expectedWrites.every(item => (item.method === 'POST' && item.path === '/api/uploads') || (item.method === 'PUT' && item.path === allowedEpisodePath)), expectedWrites);
  receipt.result = 'PASS';
} catch (error) {
  receipt.result = 'FAIL';
  receipt.failure = error.stack;
  process.exitCode = 1;
  console.error(error.stack);
  if (page) {
    try {
      await page.screenshot({ path: join(screenshotDir, 'failure.png'), fullPage: true });
      receipt.screenshots.push(relativeShot('failure.png'));
    } catch (screenshotError) {
      receipt.failureScreenshotError = screenshotError.message;
    }
  }
} finally {
  receipt.finishedAt = new Date().toISOString();
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await context?.close();
  await browser?.close();
  if (app) {
    await new Promise(resolveClose => app.close(resolveClose));
    app.closeAllConnections?.();
  }
  await rm(dataDir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  console.log(`Receipt: ${receiptPath}`);
  console.log(`Screenshots: ${screenshotDir}`);
}
