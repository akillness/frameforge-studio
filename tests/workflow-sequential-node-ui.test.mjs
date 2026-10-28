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

test('separate node runs carry the connected output into the next input and restore that evidence after reload', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-sequential-ui-'));
  const forbidden = async () => { assert.fail('Unexpected external or paid operation'); };
  const prompts = [];
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: {
      integrationStatus: async () => ({ studio: { available: true } }),
      fetchTrends: async query => ({ trends: [{ keyword: query, source: 'Fixture RSS', url: 'https://fixture.invalid/article' }], sources: [{ name: 'Fixture RSS', status: 'ok' }] }),
      runAgent: async (_agent, prompt, episode) => { prompts.push(prompt); return { message: 'Local script result', scenes: episode.scenes }; },
    },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    renderer: forbidden, mediaOptions: { fetchImpl: forbidden },
    youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
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
  const channel = await api('/api/channels', 'POST', { name: 'Sequential channel', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Sequential project', topic: 'Local fixture' });
  const template = await api('/api/workflows', 'POST', {
    name: 'Sequential evidence',
    nodes: [
      { id: 'trend-a', type: 'trend', label: 'Connected trend', x: 50, y: 50, config: { query: 'unique-connected-keyword' } },
      { id: 'script-b', type: 'script', label: 'Script consumer', x: 350, y: 50, config: { agent: 'codex' } },
    ],
    edges: [{ id: 'a-b', source: 'trend-a', target: 'script-b' }],
  });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const open = async () => {
    await page.goto(base);
    const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`);
    const group = channelButton.locator('xpath=ancestor::details[1]');
    if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
    await channelButton.click();
    await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
    await page.locator('#workflow-canvas').waitFor();
    assert.equal(await page.locator('#wf-select').inputValue(), workflow.id);
  };
  const select = async id => { await page.locator(`.wf-node-header[data-id="${id}"]`).click(); };
  const start = async id => {
    await select(id);
    await page.locator('[data-wf-action=open-stage-overlay]').first().click();
    const dialog = page.locator('#wf-stage-dialog[open]'); await dialog.waitFor();
    const pending = page.waitForResponse(r => r.url() === `${base}/api/workflows/${workflow.id}/run` && r.request().method() === 'POST');
    await dialog.locator('#wf-stage-start').click();
    const response = await pending;
    assert.equal(response.status(), 202, await response.text());
    const payload = response.request().postDataJSON(), run = await response.json();
    // Contract 2.3: every run entry point posts a server-planned execution intent, never a
    // client-built selectedStages/startStage/resumeRunId (old ad hoc selection logic removed).
    assert.deepEqual(payload.execution, { mode: 'node', targetNodeId: id }, 'the UI posts exactly a node-targeted execution intent, not a client-built selection');
    assert.equal(payload.selectedStages, undefined, 'the UI must never build selectedStages itself');
    assert.equal(payload.startStage, undefined, 'the UI must never build startStage itself');
    assert.equal(payload.expectedWorkflowVersion, workflow.version);
    assert.equal(payload.expectedEpisodeVersion, episode.version);
    await page.waitForFunction(() => document.querySelector('#wf-stage-status')?.dataset.stageState === 'completed');
    await dialog.locator('[data-wf-action=close-overlay]').click();
    return { payload, run: await api(`/api/workflow-runs/${run.id}`) };
  };
  await open();
  const first = await start('trend-a');
  assert.equal(first.run.status, 'completed');
  assert.deepEqual(first.run.nodeRuns.find(node => node.nodeId === 'trend-a').output.trends.map(item => item.keyword), ['unique-connected-keyword']);
  const second = await start('script-b');
  assert.equal(second.run.resumedFrom, first.run.id, 'the server-derived plan resumes script-b from trend-a\'s completed run, matching the old client-sent resumeRunId behavior');
  assert.equal(second.run.status, 'completed');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /unique-connected-keyword/);
  assert.equal(second.run.nodeRuns.find(node => node.nodeId === 'script-b').output.message, 'Local script result');
  const inspect = async () => {
    await select('script-b');
    await page.locator('[data-wf-action=open-results]').first().click();
    const dialog = page.locator('#wf-results-dialog[open]'); await dialog.waitFor();
    await dialog.locator('#wf-results-run').selectOption(second.run.id);
    const inspector = dialog.locator('#wf-overlay-result-inspector');
    const raw = inspector.locator('[data-testid="node-result-raw"]');
    await raw.locator('summary').click();
    const rawText = await inspector.innerText();
    assert.match(rawText, /Connected trend/);
    assert.match(rawText, /unique-connected-keyword/);
    assert.match(rawText, /Local script result/);
    await dialog.locator('[data-wf-action=close-overlay]').click();
  };
  await inspect();
  await open();
  await inspect();
  assert.equal((await api(`/api/workflow-runs/${second.run.id}`)).workflowVersion, workflow.version);
});
