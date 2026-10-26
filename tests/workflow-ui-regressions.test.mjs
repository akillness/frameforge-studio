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

async function editorFixture(t, viewport = { width: 1440, height: 1080 }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-workflow-navigation-'));
  const forbidden = async () => { assert.fail('Navigation cannot call an external producer'); };
  const app = createApp({ dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), runAgent: forbidden, fetchTrends: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden }, renderer: forbidden,
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const writes = [], external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(url.pathname);
    return route.continue();
  });
  t.after(async () => {
    await context.close(); await browser.close();
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const channel = await api('/api/channels', 'POST', { name: 'Navigation channel', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Navigation project', topic: 'No execution' });
  const template = await api('/api/workflows', 'POST', { name: 'Original name', nodes: ['one', 'two'].map((id, i) => ({ id, type: 'trend', x: 50 + i * 300, y: 50, config: {} })), edges: [{ id: 'one-two', source: 'one', target: 'two' }] });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  await page.goto(base); await page.locator('#workflow-canvas').waitFor();
  return { page, api, base, workflow, writes };
}

async function unchanged(f) {
  assert.deepEqual(f.writes, [], 'navigation never writes');
  assert.deepEqual((await f.api('/api/workflows')).find(w => w.id === f.workflow.id), f.workflow, 'navigation never changes persisted graph');
  assert.notEqual(await f.page.locator('#wf-save-status').getAttribute('class'), 'unsaved', 'navigation never creates a draft');
}

test('workflow name inputs with an empty data attribute produce a persistable named draft', async t => {
  const f = await editorFixture(t), { page } = f;
  await page.locator('[data-wf-action=open-workflow-settings]').click();
  assert.equal(await page.locator('#wf-workflow-name').getAttribute('data-workflow-name'), '');
  await page.locator('#wf-workflow-name').fill('Renamed through the real dialog');
  assert.equal(await page.locator('#wf-save-status').getAttribute('class'), 'unsaved');
  await page.keyboard.press('Escape'); assert.deepEqual(f.writes, []);
  const saved = page.waitForResponse(r => r.url() === `${f.base}/api/workflows/${f.workflow.id}` && r.request().method() === 'PUT');
  await page.locator('[data-wf-action=save]').click(); const response = await saved;
  assert.equal(response.status(), 200, await response.text());
  assert.equal(response.request().postDataJSON().expectedVersion, f.workflow.version);
  const current = (await f.api('/api/workflows')).find(w => w.id === f.workflow.id);
  assert.equal(current.name, 'Renamed through the real dialog');
  assert.equal(current.version, f.workflow.version + 1);
});

test('stacked workflow wheel events retain native page scrolling without changing graph coordinates', async t => {
  const f = await editorFixture(t, { width: 375, height: 640 }), { page } = f;
  const canvas = page.locator('#workflow-canvas');
  assert.equal(await canvas.getAttribute('data-layout'), 'stacked');
  await canvas.scrollIntoViewIfNeeded();
  const scrollContainer = await canvas.evaluateHandle(e => {
    for (let parent = e.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
    }
    return document.scrollingElement;
  });
  const before = await scrollContainer.evaluate(e => e.scrollTop), graphTransform = await page.locator('#wf-world').getAttribute('style');
  await canvas.hover(); await page.mouse.wheel(0, 240);
  await page.waitForFunction(({ element, before }) => element.scrollTop > before, { element: scrollContainer, before });
  await scrollContainer.dispose();
  assert.equal(await page.locator('#wf-world').getAttribute('style'), graphTransform, 'native wheel cannot zoom or pan stacked nodes');
  await unchanged(f);
});

test('workflow history navigation opens the disclosure and transfers keyboard focus without editing', async t => {
  const f = await editorFixture(t), { page } = f;
  const link = page.locator('[data-wf-section][href="#wf-run-history"]');
  await link.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#wf-run-history').evaluate(e => e.open), true);
  assert.equal(await page.locator('#wf-run-history > summary').evaluate(e => e === document.activeElement), true);
  await unchanged(f);
});

test('workflow design navigation focuses the canvas rather than searching for a disclosure summary', async t => {
  const f = await editorFixture(t), { page } = f;
  await page.locator('[data-wf-section][href="#wf-run-history"]').click();
  await page.locator('[data-wf-section][href="#workflow-canvas"]').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#workflow-canvas').evaluate(e => e === document.activeElement), true);
  await unchanged(f);
});

test('a navigation target removed during rerender leaves focus usable and never changes the graph', async t => {
  const f = await editorFixture(t), { page } = f;
  await page.locator('#wf-review').evaluate(e => e.remove());
  const link = page.locator('[data-wf-section][href="#wf-review"]');
  await link.focus(); await page.keyboard.press('Enter');
  assert.equal(await link.evaluate(e => e === document.activeElement), true, 'a missing target cannot strand keyboard focus');
  await page.locator('[data-wf-section][href="#workflow-canvas"]').click();
  assert.equal(await page.locator('#workflow-canvas').evaluate(e => e === document.activeElement), true, 'navigation remains usable after the missing target');
  await unchanged(f);
});
