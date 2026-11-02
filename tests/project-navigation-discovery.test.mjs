/** Project identity and direct result/history discovery stay distinct from review/publication. */
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

const forbidden = name => async () => { throw new Error(`Forbidden in isolated UI test: ${name}`); };

test('selected project is identifiable and results/history have direct keyboard-safe routes', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-project-nav-'));
  const app = createApp({
    dataDir,
    loginToken: '',
    publicOrigin: '',
    integrations: {
      integrationStatus: async () => ({ studio: { available: false, status: 'unavailable', detail: 'isolated test' } }),
      runAgent: forbidden('agent'),
      fetchTrends: forbidden('trends'),
    },
    speech: { listVoices: async () => ({ available: false, voices: [], detail: 'isolated test' }), synthesize: forbidden('speech') },
    generation: { capability: async () => ({ available: false, status: 'unavailable' }), models: async () => [], modelSchema: forbidden('schema'), submit: forbidden('generation'), status: forbidden('generation-status') },
    renderer: forbidden('render'),
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await browserModule.chromium.launch({ headless: true, executablePath: chromiumExecutable });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const writes = [];
  const externalRequests = [];
  page.on('pageerror', error => assert.fail(`unexpected page error: ${error.message}`));
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) { externalRequests.push(request.url()); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method()) && url.pathname !== '/api/login') writes.push(`${request.method()} ${url.pathname}`);
    return route.continue();
  });
  t.after(async () => {
    await context.close();
    await browser.close();
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  await page.goto(base);
  await page.locator('#app .shell').waitFor();
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body ? { data: body } : {}) });
    assert.ok(response.ok(), `${method} ${path} returned ${response.status()}: ${await response.text()}`);
    return response.json();
  };
  const channel = await api('/api/channels', 'POST', { name: '탐색 검증 채널', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: '겹칠 수 있는 프로젝트 제목', topic: '결과 경로 검증' });
  const otherEpisode = await api('/api/episodes', 'POST', { channelId: channel.id, title: '두 번째 프로젝트', topic: '초안 보존 검증' });
  await page.reload();
  await page.locator(`#project-navigation`).waitFor();
  const projectButton = page.locator(`[data-action=episode][data-id="${episode.id}"]`);
  await projectButton.waitFor();
  await projectButton.click();
  await page.locator('#project-navigation .project-context strong').getByText(episode.title, { exact: true }).waitFor();

  assert.equal(await page.locator('#project-identity-code').textContent(), episode.id, 'stable project identity is visible');
  assert.equal(await page.locator(`[data-action=episode][data-id="${episode.id}"]`).getAttribute('aria-current'), 'page', 'selected project is announced as current');
  const results = page.locator('[data-action=project-section][data-section=results]');
  const history = page.locator('[data-action=project-section][data-section=history]');
  const review = page.locator('[data-action=project-section][data-section=delivery]');
  await results.waitFor();
  await history.waitFor();
  await review.waitFor();

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await results.isVisible(), `results shortcut is visible at ${width}px`);
    assert.ok(await history.isVisible(), `history shortcut is visible at ${width}px`);
    assert.ok(await review.isVisible(), `review/publication remains a separate destination at ${width}px`);
    const dimensions = await page.locator('#project-navigation').evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(dimensions.scroll <= dimensions.client + 1, `project navigation does not overflow at ${width}px: ${JSON.stringify(dimensions)}`);
  }

  await results.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('#project-tool-dialog[open]');
  await dialog.waitFor();
  assert.equal(await dialog.locator('#project-tool-title').textContent(), '결과 · 내보내기');
  assert.equal(await dialog.locator('[data-testid=result-project-context] code').textContent(), episode.id, 'the result panel identifies its project');
  assert.equal(await dialog.locator('#jobs').count(), 1, 'opens the actual episode-scoped export results panel');
  await page.keyboard.press('Escape');
  await page.locator('#project-tool-dialog').waitFor({ state: 'hidden' });
  assert.equal(await results.evaluate(element => element === document.activeElement), true, 'Escape restores focus to the results shortcut');

  await history.focus();
  await page.keyboard.press('Enter');
  await page.locator('#project-tool-dialog[open]').waitFor();
  assert.equal(await page.locator('#project-tool-title').textContent(), '제작 히스토리');
  assert.equal(await page.locator('#history-episode').inputValue(), episode.id, 'project history defaults to the selected project');
  await page.keyboard.press('Escape');
  await page.locator('#project-tool-dialog').waitFor({ state: 'hidden' });

  await review.focus();
  await page.keyboard.press('Enter');
  await page.locator('#project-tool-dialog[open] [data-production-tools][data-mode="delivery"]').waitFor();
  assert.equal(await page.locator('#project-tool-title').textContent(), '검토 · 공개');
  assert.equal(await page.locator('#project-tool-dialog #jobs').count(), 0, 'review/publication opens its own surface, not the results panel');
  await page.keyboard.press('Escape');
  await page.locator('#project-tool-dialog').waitFor({ state: 'hidden' });

  await page.locator('[data-action=open-scene-editor]').focus();
  await page.keyboard.press('Enter');
  await page.locator('#project-scene-dialog[open] #preview').waitFor();
  const episodeSettings = page.locator('.inspector details').first();
  if (!(await episodeSettings.evaluate(element => element.open))) await episodeSettings.locator('summary').click();
  const titleInput = page.locator('[data-episode=title]');
  await titleInput.fill('저장 전에도 남아 있는 사용자 초안');
  await page.keyboard.press('Escape');
  await page.locator('#project-scene-dialog').waitFor({ state: 'hidden' });
  await page.locator(`[data-action=episode][data-id="${otherEpisode.id}"]`).click();
  await page.locator('#project-identity-code').waitFor();
  assert.equal(await page.locator('#project-identity-code').textContent(), otherEpisode.id, 'switching projects updates the stable project identity');
  await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
  await page.locator('[data-action=open-scene-editor]').focus();
  await page.keyboard.press('Enter');
  await page.locator('#project-scene-dialog[open] #preview').waitFor();
  const reopenedSettings = page.locator('.inspector details').first();
  if (!(await reopenedSettings.evaluate(element => element.open))) await reopenedSettings.locator('summary').click();
  assert.equal(await page.locator('[data-episode=title]').inputValue(), '저장 전에도 남아 있는 사용자 초안', 'switching away and back preserves the unsaved title draft');
  assert.match(await page.locator('#save-status').getAttribute('class'), /unsaved/, 'the draft remains visibly unsaved');

  assert.deepEqual(writes, [], 'navigation and opening read-only surfaces issue no writes');
  assert.deepEqual(externalRequests, [], 'external/provider traffic remains blocked');
});
