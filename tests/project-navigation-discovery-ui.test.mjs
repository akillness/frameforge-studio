// Repro plan (read-only product behavior; all records live in a disposable createApp DB):
// 1. Create projects with the same title; include two in the same channel with identical
//    status and version. The UI currently shows no real-ID discriminator for this collision.
// 2. Check whether direct results navigation is discoverable beside scene/source/review.
// 3. Repeat the task at desktop and mobile widths using keyboard only; assert navigation
//    opens existing views without any write, generation, render, upload, or publication.
// Expected red before implementation: colliding same-title/status/version projects cannot
//    be distinguished by the real project ID in visible labels or accessible names.
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
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-project-navigation-'));
  const forbidden = async () => { assert.fail('project navigation must never call a provider or external operation'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), runAgent: forbidden, fetchTrends: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const writes = [], external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
    if (!['GET','HEAD'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname });
    return route.continue();
  });
  t.after(async () => {
    await context.close(); await browser.close();
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.deepEqual(external, [], 'external network is blocked');
    assert.deepEqual(errors, [], 'the workbench must not throw');
    assert.deepEqual(writes, [], 'navigation must not save, run, render, upload, or publish');
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const channel = await api('/api/channels', 'POST', { name: 'Fixture channel', platform: 'youtube', category: 'information' });
  const first = await api('/api/episodes', 'POST', { channelId: channel.id, title: '같은 제목 프로젝트', topic: 'fixture A' });
  const second = await api('/api/episodes', 'POST', { channelId: channel.id, title: '같은 제목 프로젝트', topic: 'fixture B' });
  const third = await api('/api/episodes', 'POST', { channelId: channel.id, title: '같은 제목 프로젝트', topic: 'fixture C, same status/version as A' });
  const versionedSecond = await api(`/api/episodes/${second.id}`, 'PUT', { title: second.title, expectedVersion: second.version });
  const secondChannel = await api('/api/channels', 'POST', { name: 'Second fixture channel', platform: 'instagram', category: 'information' });
  const secondChannelEpisode = await api('/api/episodes', 'POST', { channelId: secondChannel.id, title: '다른 채널 프로젝트', topic: 'fixture C' });
  const template = await api('/api/workflows', 'POST', { name: 'Fixture graph', nodes: [{ id: 'node-a', type: 'trend', label: 'Source', x: 40, y: 40, config: {} }], edges: [] });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: first.id, expectedTemplateVersion: template.version });
  await page.goto(base);
  await page.locator('#app .shell').waitFor();
  const channelButton = page.locator(`[data-action="channel"][data-id="${channel.id}"]`);
  const group = channelButton.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click();
  await page.locator('#project-navigation').waitFor();
  return { page, base, api, channel, secondChannel, secondChannelEpisode, first, second: versionedSecond, third, workflow, writes };
}

test('project choice is distinguishable and results remain reachable by keyboard on desktop and mobile', async t => {
  const f = await fixture(t), { page } = f;
  const firstRow = page.locator(`.project-list [data-action="episode"][data-id="${f.first.id}"]`);
  const secondRow = page.locator(`.project-list [data-action="episode"][data-id="${f.second.id}"]`);
  const thirdRow = page.locator(`.project-list [data-action="episode"][data-id="${f.third.id}"]`);
  await firstRow.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(id => document.querySelector('#project-episode')?.value === id, f.first.id);
  assert.equal(await page.locator('#main').evaluate(element => element === document.activeElement), true, 'keyboard project navigation moves focus to the new main workspace');
  assert.equal(await firstRow.getAttribute('aria-current'), 'page', 'the active project row exposes current state to assistive technology');
  assert.equal(await secondRow.getAttribute('aria-current'), null, 'only one project is current');
  await secondRow.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(id => document.querySelector('#project-episode')?.value === id, f.second.id);
  assert.equal(await page.locator('#main').evaluate(element => element === document.activeElement), true, 'switching project by keyboard moves focus predictably');
  assert.equal(await secondRow.getAttribute('aria-current'), 'page', 'current state follows project selection');
  const secondChannelButton = page.locator(`[data-action="channel"][data-id="${f.secondChannel.id}"]`);
  const secondChannelGroup = secondChannelButton.locator('xpath=ancestor::details[1]');
  if (!await secondChannelGroup.evaluate(element => element.open)) {
    await secondChannelGroup.locator('summary').focus(); await page.keyboard.press('Enter');
  }
  await secondChannelButton.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(id => document.querySelector('#project-episode')?.value === id, f.secondChannelEpisode.id);
  assert.equal(await page.locator('#main').evaluate(element => element === document.activeElement), true, 'keyboard channel navigation moves focus to the new main workspace');
  const channelA = page.locator(`[data-action="channel"][data-id="${f.channel.id}"]`);
  const channelAGroup = channelA.locator('xpath=ancestor::details[1]');
  if (!await channelAGroup.evaluate(element => element.open)) {
    await channelAGroup.locator('summary').focus(); await page.keyboard.press('Enter');
  }
  await channelA.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(id => document.querySelector('#project-episode')?.value === id, f.second.id);
  assert.equal(await page.locator(`.project-list [data-action="episode"][data-id="${f.second.id}"]`).getAttribute('aria-current'), 'page', 'the remembered project remains current after switching channels away and back');
  assert.match(await firstRow.innerText(), /v1/, 'sidebar exposes actual version as a visible discriminator');
  assert.match(await secondRow.innerText(), /v2/, 'sidebar exposes the other actual version as a visible discriminator');
  assert.equal(f.first.title, f.third.title, 'the collision fixture has matching project titles');
  assert.equal(f.first.version, f.third.version, 'the collision fixture has matching project versions');
  assert.equal(f.first.status, f.third.status, 'the collision fixture has matching project statuses');
  const visibleProjectId = async row => {
    const text = await row.innerText();
    const match = text.match(/\bID\s+([^\s]+)/i);
    assert.ok(match, `sidebar visibly exposes a real project ID: ${text}`);
    return match[1];
  };
  const firstVisibleId = await visibleProjectId(firstRow);
  const thirdVisibleId = await visibleProjectId(thirdRow);
  assert.ok(f.first.id.startsWith(firstVisibleId), 'first visible discriminator is a prefix of the persisted project ID');
  assert.ok(f.third.id.startsWith(thirdVisibleId), 'third visible discriminator is a prefix of the persisted project ID');
  assert.notEqual(firstVisibleId, thirdVisibleId, 'same-title/status/version projects show different real-ID prefixes');
  const firstAccessibleName = await firstRow.getAttribute('aria-label');
  const thirdAccessibleName = await thirdRow.getAttribute('aria-label');
  assert.ok(firstAccessibleName?.includes(f.first.id), 'first accessible project name contains the full persisted ID');
  assert.ok(thirdAccessibleName?.includes(f.third.id), 'third accessible project name contains the full persisted ID');
  assert.equal(await page.getByRole('button', { name: firstAccessibleName, exact: true }).count(), 1, 'the full first project name resolves to exactly its project button');
  assert.equal(await page.getByRole('button', { name: thirdAccessibleName, exact: true }).count(), 1, 'the full third project name resolves to exactly its project button');
  const firstOption = await page.locator('#project-episode option').evaluateAll((options, id) => options.find(option => option.value === id)?.textContent, f.first.id);
  const thirdOption = await page.locator('#project-episode option').evaluateAll((options, id) => options.find(option => option.value === id)?.textContent, f.third.id);
  assert.match(firstOption ?? '', new RegExp(`ID\\s+${firstVisibleId}`), 'picker exposes the first real project ID in its option name');
  assert.match(thirdOption ?? '', new RegExp(`ID\\s+${thirdVisibleId}`), 'picker exposes the third real project ID in its option name');
  assert.notEqual(firstOption, thirdOption, 'same-title/status/version picker options are distinguishable');
  await thirdRow.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(id => document.querySelector('#project-episode')?.value === id, f.third.id);
  assert.equal(await page.locator('#main').evaluate(element => element === document.activeElement), true, 'keyboard selection reaches the exact same-version project and moves focus');
  assert.equal(await thirdRow.getAttribute('aria-current'), 'page', 'the exact same-version project becomes current');
  await secondRow.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(id => document.querySelector('#project-episode')?.value === id, f.second.id);
  assert.equal(await secondRow.getAttribute('aria-current'), 'page', 'keyboard selection can return to the different-version project');
  const resultsLink = page.locator('#project-navigation [data-action="project-section"][data-section="results"]');
  const reviewLink = page.locator('#project-navigation [data-action="project-section"][data-section="delivery"]');
  assert.equal(await resultsLink.innerText(), '결과', 'results has a direct, compact project-level entry');

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await thirdRow.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(id => document.querySelector('#project-episode')?.value === id, f.third.id);
    assert.equal(await thirdRow.getAttribute('aria-current'), 'page', `${width}px: keyboard activates the exact same-title/status/version project`);
    assert.equal(await page.locator('#main').evaluate(element => element === document.activeElement), true, `${width}px: exact ID selection moves focus to main`);
    if (width === 390) {
      const box = await thirdRow.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `mobile keyboard focus scrolls the ID-labeled project into view: ${JSON.stringify(box)}`);
    }
    await secondRow.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(id => document.querySelector('#project-episode')?.value === id, f.second.id);
    assert.equal(await secondRow.getAttribute('aria-current'), 'page', `${width}px: keyboard can return to the differently-versioned project`);
    await reviewLink.focus();
    assert.equal(await reviewLink.evaluate(element => element === document.activeElement), true, `${width}px: review navigation can receive keyboard focus`);
    await page.keyboard.press('Enter');
    await page.locator('#project-tool-dialog[open]').waitFor();
    assert.equal(await page.locator('#project-tool-title').innerText(), '검토 · 공개', `${width}px: review action opens the existing review view`);
    await page.keyboard.press('Escape');
    await page.locator('#project-tool-dialog[open]').waitFor({ state: 'hidden' });
    assert.equal(await reviewLink.evaluate(element => element === document.activeElement), true, `${width}px: closing review restores focus to its opener`);

    await resultsLink.focus();
    assert.equal(await resultsLink.evaluate(element => element === document.activeElement), true, `${width}px: result navigation can receive keyboard focus`);
    if (width === 390) {
      const box = await resultsLink.boundingBox();
      assert.ok(box && box.height >= 44, `mobile result action keeps a 44px target: ${JSON.stringify(box)}`);
    }
    await page.keyboard.press('Enter');
    await page.locator('#project-tool-dialog[open] #jobs').waitFor();
    assert.equal(await page.locator('#project-tool-title').innerText(), '결과 · 내보내기', `${width}px: direct result action opens the existing result view`);
    await page.keyboard.press('Escape');
    await page.locator('#project-tool-dialog[open]').waitFor({ state: 'hidden' });
    assert.equal(await resultsLink.evaluate(element => element === document.activeElement), true, `${width}px: closing results restores focus to its opener`);

    const sceneOpener = page.locator('#project-navigation [data-action="open-scene-editor"]');
    await sceneOpener.focus(); await page.keyboard.press('Enter');
    const sceneDialog = page.locator('#project-scene-dialog[open]');
    await sceneDialog.waitFor();
    const titleField = sceneDialog.locator('[data-scene="title"]');
    const sceneDraft = '보존 확인용 미저장 장면 제목';
    await titleField.fill(sceneDraft);
    await page.keyboard.press('Escape');
    await page.locator('#project-scene-dialog[open]').waitFor({ state: 'hidden' });
    assert.equal(await sceneOpener.evaluate(element => element === document.activeElement), true, `${width}px: closing scene editor restores focus`);
    await page.keyboard.press('Enter'); await sceneDialog.waitFor();
    assert.equal(await titleField.inputValue(), sceneDraft, `${width}px: unsaved scene draft survives close and reopen`);
    await page.keyboard.press('Escape');
    await page.locator('#project-scene-dialog[open]').waitFor({ state: 'hidden' });
  }
  const after = await f.api('/api/state');
  assert.equal(after.episodes.find(item => item.id === f.second.id).version, f.second.version, 'navigation and draft inspection preserve project version');
  assert.deepEqual((await f.api('/api/workflows')).find(item => item.id === f.workflow.id), f.workflow, 'navigation never changes workflow data or history');
  await page.keyboard.press('Escape');
  if (process.env.FRAMEFORGE_UX_SCREENSHOT) await page.screenshot({ path: process.env.FRAMEFORGE_UX_SCREENSHOT, fullPage: true });
});
