import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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
  const apiRaw = (path, method = 'GET', body) => context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
  const api = async (path, method = 'GET', body) => {
    const response = await apiRaw(path, method, body);
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const persistRun = run => {
    const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
    try { db.exec('PRAGMA busy_timeout=5000'); db.prepare('INSERT INTO entities(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run('workflowRuns', run.id, JSON.stringify(run)); }
    finally { db.close(); }
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
  return { api, apiRaw, base, context, page, channel, persistRun, get episode() { return episode; }, setEpisode(value) { episode = value; }, setup, run, results };
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
  assert.match(text, /실행하지 않고 보존|이전 실행 결과 보존/);
  assert.match(text, new RegExp(`출처 실행 ${first.id}`));
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
  assert.match(text, new RegExp(`출처 실행 ${first.id}`));
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


test('node results show persisted errors and logs beside safe local media previews', async t => {
  const f = await fixture(t);
  const workflow = await f.setup([{ id: 'evidence', type: 'script', label: 'Evidence node', x: 50, y: 50, config: { agent: 'existing' } }]);
  const completed = await f.run(workflow, 'evidence');
  const run = {
    ...completed,
    status: 'failed',
    error: 'Fixture run-level error',
    nodeRuns: completed.nodeRuns.map(node => node.nodeId === 'evidence' ? {
      ...node,
      status: 'failed',
      error: 'Fixture node failure',
      logs: [{ level: 'warn', message: 'Fixture execution log' }],
      output: { ...node.output, outputUrl: '/api/exports/fixture-preview.mp4', metadata: { sourceUrl: 'https://outside.invalid/not-a-preview.mp4' } },
    } : node),
  };
  f.persistRun(run);
  const inspector = await f.results(workflow, 'evidence', run.id);
  await inspector.locator('[data-testid="node-result-logs"] summary').click();
  const text = await inspector.innerText();
  assert.match(text, /Fixture node failure/);
  assert.match(text, /Fixture execution log/);
  const video = inspector.locator('video.node-result-media');
  assert.equal(await video.count(), 1);
  assert.equal(await video.getAttribute('src'), '/api/exports/fixture-preview.mp4');
  const missingMedia = inspector.locator('[data-media-error]');
  await missingMedia.waitFor({ state: 'visible' });
  assert.match(await missingMedia.innerText(), /찾지 못했습니다 \(HTTP 404\)/);
  assert.match(await missingMedia.innerText(), /fixture-preview\.mp4/);
  assert.equal(await inspector.locator('video[src^="https:"]').count(), 0);
  const raw = inspector.locator('[data-testid="node-result-raw"]');
  await raw.locator('summary').click();
  const rawText = await raw.innerText();
  assert.match(rawText, /Fixture node failure/);
  assert.match(rawText, /Fixture execution log/);
  await f.page.locator('#wf-results-dialog [data-wf-action="close-overlay"]').click();
  const history = f.page.locator('#wf-run-history');
  if (!await history.evaluate(element => element.open)) await history.locator('summary').click();
  const historyRecord = history.locator(`[data-run-id="${run.id}"]`);
  await historyRecord.waitFor();
  await historyRecord.locator('summary').click();
  const historyDetail = historyRecord.locator('[data-run-detail]');
  await historyDetail.getByText('Fixture run-level error').waitFor();
  assert.equal(await historyDetail.locator('video.node-result-media').count(), 1);
});

test('project run history remains available without a saved project graph', async t => {
  const f = await fixture(t);
  await f.page.goto(f.base);
  const channelButton = f.page.locator(`[data-action=channel][data-id="${f.channel.id}"]`);
  const group = channelButton.locator('xpath=ancestor::details[1]');
  if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click();
  await f.page.locator(`[data-action=episode][data-id="${f.episode.id}"]`).click();
  await f.page.locator('#wf-run-history').waitFor();
  assert.equal(await f.page.locator('#workflow-canvas').count(), 0);
  assert.equal(await f.page.locator('#wf-select').inputValue(), '');
  await f.page.locator('#wf-run-history summary').click();
  await f.page.getByText('실행 기록 0개').waitFor();
});

test('channel-scoped run history and detail reject another project’s records', async t => {
  const f = await fixture(t);
  const workflow = await f.setup([{ id: 'scope-node', type: 'script', label: 'Scoped node', x: 50, y: 50, config: { agent: 'existing' } }]);
  const run = await f.run(workflow, 'scope-node');
  const otherChannel = await f.api('/api/channels', 'POST', { name: 'Other scope channel', platform: 'youtube', category: 'information' });
  const otherEpisode = await f.api('/api/episodes', 'POST', { channelId: otherChannel.id, title: 'Other scope project', topic: 'Fixture only' });
  const otherRun = { ...run, id: 'other-channel-run', workflowId: 'other-channel-workflow', episodeId: otherEpisode.id, episodeSnapshot: otherEpisode };
  f.persistRun(otherRun);
  const scoped = await f.api(`/api/workflow-runs?channelId=${f.channel.id}&episodeId=${f.episode.id}`);
  assert.deepEqual(scoped.items.map(item => item.id), [run.id]);
  const mismatch = await f.apiRaw(`/api/workflow-runs/${otherRun.id}?channelId=${f.channel.id}&episodeId=${f.episode.id}`);
  assert.equal(mismatch.status(), 404);
});


test('legacy run snapshots without selected stages still expose their saved output', async t => {
  const f = await fixture(t);
  const workflow = await f.setup([{ id: 'legacy-node', type: 'script', label: 'Legacy result node', x: 50, y: 50, config: { agent: 'existing' } }]);
  const completed = await f.run(workflow, 'legacy-node');
  const legacy = { ...completed };
  delete legacy.selectedStages;
  f.persistRun(legacy);
  const summary = await f.api(`/api/workflow-runs?channelId=${f.channel.id}&episodeId=${f.episode.id}`);
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].nodeRuns[0].hasOutput, true);
  await f.page.goto(f.base);
  const channelButton = f.page.locator(`[data-action=channel][data-id="${f.channel.id}"]`);
  const group = channelButton.locator('xpath=ancestor::details[1]');
  if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click();
  await f.page.locator(`[data-action=episode][data-id="${f.episode.id}"]`).click();
  const history = f.page.locator('#wf-run-history');
  if (!await history.evaluate(element => element.open)) await history.locator('summary').click();
  const historyRecord = history.locator(`[data-run-id="${legacy.id}"]`);
  await historyRecord.waitFor();
  await historyRecord.locator('summary').click();
  await historyRecord.locator('[data-run-detail]').getByText('첫 장면 제목').waitFor();
  assert.match(await historyRecord.innerText(), /이번 실행에서 출력 생성/);
});
