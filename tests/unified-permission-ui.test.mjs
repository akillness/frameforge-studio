import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { defaultWorkflow } from '../server/workflows.mjs';

const modulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-unified-permission-'));
  const store = new Store(dataDir);
  store.saveTrendCollectorSettings({ enabled: false });
  const forbidden = async () => { assert.fail('This UI test must not contact an external provider or perform production'); };
  const loginToken = 'isolated-unified-permission-token';
  const app = createApp({
    dataDir, loginToken, publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), runAgent: forbidden, fetchTrends: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
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
  const external = [], writes = [], errors = [];
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
    store.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.deepEqual(external, [], 'browser must not reach external origins');
    assert.deepEqual(errors, [], 'workbench must not throw');
    assert.equal(writes.some(write => /\/(run|quote|generations|publication)(\/|$)/.test(write.path)), false, 'editing does not approve production or publication');
  });
  const seed = await browser.newContext();
  try {
    const login = await seed.request.post(`${base}/api/login`, { headers: { origin: base }, data: { token: loginToken } });
    assert.equal(login.status(), 200);
    const api = async (path, method = 'GET', body) => {
      const response = await seed.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
      assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
      return response.json();
    };
    const channel = await api('/api/channels', 'POST', { name: 'Permission fixture channel', platform: 'youtube', category: 'information' });
    const active = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Editable project', topic: 'Local fixture' });
    const archived = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Archived project', topic: 'Preserved fixture' });
    const template = await api('/api/workflows', 'POST', defaultWorkflow());
    const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: active.id, expectedTemplateVersion: template.version });
    const archivedWorkflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: archived.id, expectedTemplateVersion: template.version });
    const archivedVersion = await api(`/api/episodes/${archived.id}/archive`, 'POST', { expectedVersion: archived.version });
    return { base, page, context, loginToken, channel, active, archived: archivedVersion, workflow, archivedWorkflow, writes };
  } finally { await seed.close(); }
}

async function login(f) {
  await f.page.goto(f.base);
  await f.page.locator('#login-form [name=token]').fill(f.loginToken);
  const response = f.page.waitForResponse(r => r.url() === `${f.base}/api/login` && r.request().method() === 'POST');
  await f.page.getByRole('button', { name: '스튜디오 열기 →', exact: true }).click();
  assert.equal((await response).status(), 200);
  await f.page.locator('#app .shell').waitFor();
}

async function selectActive(f) {
  const channel = f.page.locator(`[data-action=channel][data-id="${f.channel.id}"]`);
  const group = channel.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channel.click();
  await f.page.locator(`[data-action=episode][data-id="${f.active.id}"]`).click();
  await f.page.locator('#workflow-canvas').waitFor();
  assert.equal(await f.page.locator('#wf-select').inputValue(), f.workflow.id);
}

test('native login grants editing without administrator-mode labels while unauthenticated requests remain blocked', async t => {
  const f = await fixture(t), { page } = f;
  const denied = await f.context.request.post(`${f.base}/api/episodes/${f.active.id}/archive`, {
    headers: { origin: f.base, 'X-Role': 'admin' }, data: { expectedVersion: f.active.version, role: 'admin' },
  });
  assert.equal(denied.status(), 401, 'client role claims do not replace an authenticated session');
  await login(f);
  await selectActive(f);
  const badge = page.getByTestId('session-capability');
  assert.doesNotMatch(await badge.innerText(), /관리자|admin|읽기 전용/i);
  await page.locator('[data-action=open-scene-editor]').click();
  const dialog = page.locator('#project-scene-dialog[open]');
  const title = dialog.locator('[data-scene=title]');
  assert.equal(await title.isEnabled(), true);
  assert.doesNotMatch((await title.getAttribute('title')) || '', /관리자|admin/i);
  assert.doesNotMatch((await title.getAttribute('aria-description')) || '', /관리자|admin/i);
  await title.fill('Edited by authenticated user');
  const save = dialog.locator('#save-button');
  assert.equal(await save.isEnabled(), true);
  const saved = page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${f.active.id}` && r.request().method() === 'PUT');
  await save.click();
  const response = await saved;
  assert.equal(response.status(), 200, await response.text());
  assert.equal(response.request().postDataJSON().expectedVersion, f.active.version);
  const result = await response.json();
  assert.equal(result.scenes[0].title, 'Edited by authenticated user');
  assert.equal(result.version, f.active.version + 1);
});

test('archived project is inspectable but explains its archive lock rather than a missing administrator permission', async t => {
  const f = await fixture(t), { page } = f;
  await login(f);
  await selectActive(f);
  await page.locator('[data-action=project-tools]').click();
  await page.locator('.ff-context-menu[role=menu]').getByRole('menuitem', { name: '보관된 프로젝트', exact: true }).click();
  await page.locator('#project-tool-dialog[open]').waitFor();
  await page.locator(`[data-action=inspect-archived][data-id="${f.archived.id}"]`).click();
  await page.locator('#project-navigation').getByText('Archived project', { exact: true }).waitFor();
  const context = await page.locator('#project-navigation').innerText();
  assert.match(context, /보관/);
  assert.doesNotMatch(context, /관리자|admin/i);
  await page.locator('[data-action=open-scene-editor]').click();
  const dialog = page.locator('#project-scene-dialog[open]');
  const reason = await dialog.getByRole('status').first().innerText();
  assert.match(reason, /보관/);
  assert.match(reason, /복구/);
  assert.doesNotMatch(reason, /관리자|admin/i);
  assert.equal(await dialog.locator('[data-scene=title]').isDisabled(), true);
  assert.equal(await dialog.locator('#save-button').isDisabled(), true);
  const stateResponse = await f.context.request.get(`${f.base}/api/state`);
  assert.equal(stateResponse.status(), 200);
  const current = (await stateResponse.json()).episodes.find(episode => episode.id === f.archived.id);
  assert.deepEqual(current, f.archived, 'inspection does not alter archived data or version');
  assert.equal(f.writes.some(write => write.path.includes(`/api/episodes/${f.archived.id}`)), false);
});

