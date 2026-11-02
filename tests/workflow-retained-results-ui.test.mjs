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
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-retained-ui-'));
  const forbidden = async () => { assert.fail('Unexpected external or paid operation'); };
  const app = createApp({ dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: true } }), fetchTrends: async query => ({ trends: [{ keyword: query, source: 'Fixture', url: 'https://fixture.invalid/article' }], sources: [] }), runAgent: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden }, renderer: forbidden,
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden },
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
  const channel = await api('/api/channels', 'POST', { name: 'Results safety channel', platform: 'youtube', category: 'information' });
  let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Results safety project', topic: 'Local fixture' });
  const setup = async (nodes, edges = []) => {
    const template = await api('/api/workflows', 'POST', { name: 'Results safety', nodes, edges });
    return api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  };
  const run = async (workflow, id, resumeRunId) => {
    const started = await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version, selectedStages: [id], startStage: id, ...(resumeRunId ? { resumeRunId } : {}) });
    for (let turn = 0; turn < 200; turn++) {
      const result = await api(`/api/workflow-runs/${started.id}`);
      if (['completed', 'failed', 'cancelled'].includes(result.status)) { assert.equal(result.status, 'completed', JSON.stringify(result)); return result; }
    }
    assert.fail('Run did not reach a terminal state');
  };
  const results = async (workflow, nodeId, runId) => {
    await page.goto(base);
    const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
    if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
    await channelButton.click(); await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
    await page.locator('#workflow-canvas').waitFor();
    assert.equal(await page.locator('#wf-select').inputValue(), workflow.id);
    await page.locator(`.wf-node-header[data-id="${nodeId}"]`).click();
    await page.locator('[data-wf-action=open-results]').first().click();
    const dialog = page.locator('#wf-results-dialog[open]'); await dialog.waitFor();
    await dialog.locator('#wf-results-run').selectOption(runId);
    return dialog.locator('#wf-overlay-result-inspector');
  };
  return { api, channel, get episode() { return episode; }, setEpisode(value) { episode = value; }, setup, run, results };
}

test('a skipped node displays retained evidence as historical, not as output produced in the selected run', async t => {
  const f = await fixture(t);
  const workflow = await f.setup([
    { id: 'root', type: 'trend', label: 'Shared root', x: 50, y: 250, config: { query: 'root-keyword' } },
    { id: 'a', type: 'trend', label: 'First trend', x: 50, y: 50, config: { query: 'retained-keyword' } },
    { id: 'b', type: 'trend', label: 'Second trend', x: 350, y: 50, config: { query: 'second-keyword' } },
  ], [{ id: 'root-a', source: 'root', target: 'a' }, { id: 'root-b', source: 'root', target: 'b' }]);
  const first = await f.run(workflow, 'a');
  const second = await f.run(workflow, 'b', first.id);
  const record = second.nodeRuns.find(node => node.nodeId === 'a');
  assert.equal(record.status, 'skipped');
  assert.equal(record.retainedOutput.trends[0].keyword, 'retained-keyword');
  const inspector = await f.results(workflow, 'a', second.id);
  const text = await inspector.innerText();
  assert.match(text, /retained-keyword/);
  assert.match(text, /저장 결과 보존 · 이번 실행에서 사용하지 않음/);
  assert.doesNotMatch(text, /저장 결과 재사용/);
});

test('a reused connected output is labeled as saved reuse rather than newly executed', async t => {
  const f = await fixture(t);
  const workflow = await f.setup([
    { id: 'trend', type: 'trend', label: 'Connected trend', x: 50, y: 50, config: { query: 'reused-keyword' } },
    { id: 'script', type: 'script', label: 'Script', x: 350, y: 50, config: { agent: 'existing' } },
  ], [{ id: 'trend-script', source: 'trend', target: 'script' }]);
  const first = await f.run(workflow, 'trend');
  const second = await f.run(workflow, 'script', first.id);
  const record = second.nodeRuns.find(node => node.nodeId === 'trend');
  assert.equal(record.status, 'completed');
  assert.equal(record.reused, true);
  assert.equal(record.reusedFrom, first.id);
  assert.equal(record.output.trends[0].keyword, 'reused-keyword');
  const inspector = await f.results(workflow, 'trend', second.id);
  const text = await inspector.innerText();
  assert.match(text, /reused-keyword/);
  assert.match(text, /저장 결과 재사용/);
});

test('slot names in persisted results render as text rather than executable markup', async t => {
  const f = await fixture(t);
  const hostile = '<img src=x onerror="window.slotAttack=1">';
  const scene = { ...f.episode.scenes[0], slots: [{ id: 'hostile', role: 'html-overlay', name: hostile }] };
  f.setEpisode(await f.api(`/api/episodes/${f.episode.id}`, 'PUT', { expectedVersion: f.episode.version, scenes: [scene] }));
  const workflow = await f.setup([{ id: 'script', type: 'script', label: 'Saved script', x: 50, y: 50, config: { agent: 'existing' } }]);
  const result = await f.run(workflow, 'script');
  assert.equal(result.nodeRuns.find(node => node.nodeId === 'script').output.scenes[0].slots[0].name, hostile);
  const inspector = await f.results(workflow, 'script', result.id);
  const raw = inspector.locator('[data-testid="node-result-raw"]');
  await raw.locator('summary').click();
  const rawText = await inspector.innerText();
  assert.ok(rawText.includes('<img src=x onerror='), 'the hostile tag prefix must survive as plain text in the raw JSON dump');
  assert.ok(rawText.includes('window.slotAttack=1'), 'the hostile payload must survive as plain text in the raw JSON dump');
  assert.equal(await inspector.locator('img').count(), 0);
  assert.equal(await inspector.page().evaluate(() => window.slotAttack), undefined);
});
