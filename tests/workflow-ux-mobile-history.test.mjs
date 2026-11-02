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

async function fixture(t, width = 1440, { seedProject = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-workflow-ux-'));
  const forbidden = async () => { assert.fail('Unexpected external or paid operation'); };
  const app = createApp({ dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: true } }), fetchTrends: async query => ({ trends: [{ keyword: query || 'fixture-trend', source: 'Fixture', url: 'https://fixture.invalid/article' }], sources: [] }), runAgent: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden }, renderer: forbidden,
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const external = [], errors = [], globalHistoryRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/workflow-runs')) globalHistoryRequests.push(request.url()); });
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
  const channel = seedProject ? await api('/api/channels', 'POST', { name: 'UX fixture channel', platform: 'youtube', category: 'information' }) : null;
  const episode = channel ? await api('/api/episodes', 'POST', { channelId: channel.id, title: 'UX fixture episode', topic: 'Local test only' }) : null;
  const setup = async (nodes, edges = []) => {
    assert.ok(channel && episode,'this fixture requires a seeded project');
    const template = await api('/api/workflows', 'POST', { name: 'UX fixture workflow', nodes, edges });
    return api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  };
  const openProject = async workflow => {
    await page.goto(base);
    const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
    if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
    await channelButton.click(); await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
    if (workflow) await page.locator('#workflow-canvas').waitFor();
  };
  const persistRun = run => {
    const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
    try { db.exec('PRAGMA busy_timeout=5000'); db.prepare('INSERT INTO entities(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run('workflowRuns', run.id, JSON.stringify(run)); }
    finally { db.close(); }
  };
  return { api, apiRaw, base, context, page, channel, episode, setup, openProject, persistRun, globalHistoryRequests };
}

const linear = [
  { id: 'trend', type: 'trend', label: '주제 조사', x: 30, y: 30, config: { query: 'fixture' } },
  { id: 'script', type: 'script', label: '대본 작성', x: 300, y: 30, config: { agent: 'studio' } },
];

test('390px workflow shows explicit connected-stage links and direct routes to results and history', async t => {
  const f = await fixture(t, 390);
  const workflow = await f.setup(linear, [{ id: 'trend-script', source: 'trend', target: 'script' }]);
  await f.openProject(workflow);
  const canvas = f.page.locator('#workflow-canvas[data-layout="stacked"]');
  await canvas.waitFor();
  const script = f.page.locator('.wf-node[data-node-id="script"]');
  const incoming = script.locator('.wf-related-node');
  assert.equal(await incoming.count(), 1);
  assert.match(await incoming.first().innerText(), /주제 조사/);
  await incoming.first().focus();
  await f.page.keyboard.press('Enter');
  await f.page.locator('.wf-node[data-node-id="trend"].selected').waitFor();
  assert.ok(await f.page.locator('#wf-focused-node [data-wf-action="node-results"]').count());
  assert.ok(await f.page.locator('.wf-section-nav a[href="#wf-current-runs"]').count());
  assert.ok(await f.page.locator('.wf-section-nav a[href="#wf-focused-node"]').count());
  const dimensions = await f.page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth, layout: document.querySelector('#wf-nodes').getBoundingClientRect().width }));
  assert.ok(dimensions.page <= dimensions.viewport, JSON.stringify(dimensions));
  assert.ok(dimensions.layout <= dimensions.viewport, JSON.stringify(dimensions));
});

test('node results show full saved evidence, same-origin media preview, and project history never requests unscoped channel data', async t => {
  const f = await fixture(t);
  const workflow = await f.setup([{ id: 'evidence', type: 'trend', label: 'Evidence', x: 30, y: 30, config: { query: 'fixture-result' } }]);
  const result = await f.api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: f.episode.version, selectedStages: ['evidence'], startStage: 'evidence' });
  let run;
  for (let attempt = 0; attempt < 100; attempt++) {
    run = await f.api(`/api/workflow-runs/${result.id}`);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) break;
  }
  assert.equal(run.status, 'completed', JSON.stringify(run));
  const record = run.nodeRuns.find(item => item.nodeId === 'evidence');
  const fullLog = `begin-${'full-log-'.repeat(1500)}-end`;
  const enriched = { ...run, nodeRuns: run.nodeRuns.map(item => item.nodeId === 'evidence' ? { ...item, logs: fullLog, output: { ...item.output, outputUrl: '/api/exports/fixture-preview.mp4', externalUrl: 'https://outside.invalid/never-preview.mp4' } } : item) };
  f.persistRun(enriched);
  await f.page.route('**/api/exports/fixture-preview.mp4', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'fixture media intentionally absent' }));
  await f.openProject(workflow);
  await f.page.setViewportSize({ width: 390, height: 844 });
  await f.page.locator('.wf-node-header[data-id="evidence"]').click();
  await f.page.locator('#wf-focused-node [data-wf-action="node-results"]').click();
  const inspector = f.page.locator('#wf-results-dialog[open] #wf-overlay-result-inspector');
  await inspector.locator('[data-testid="node-result-logs"] summary').click();
  assert.match(await inspector.innerText(), /fixture-result/);
  assert.equal(await inspector.locator('video.node-result-media').count(), 1);
  assert.equal(await inspector.locator('video.node-result-media').getAttribute('src'), '/api/exports/fixture-preview.mp4');
  await inspector.locator('figure[data-media-preview][data-media-state="error"]').waitFor();
  assert.match(await inspector.locator('[data-media-error]').innerText(), /HTTP 404/);
  assert.equal(await inspector.locator('video[src^="https:"]').count(), 0);
  assert.ok((await inspector.locator('[data-testid="node-result-logs"]').innerText()).includes('-end'));
  const raw = inspector.locator('[data-testid="node-result-raw"]');
  await raw.locator('summary').click();
  assert.ok((await raw.innerText()).includes('-end'), 'raw result must retain the unabridged original log');
  await f.page.locator('#wf-results-dialog [data-wf-action="close-overlay"]').click();
  const otherChannel=await f.api('/api/channels','POST',{name:'Other UX fixture channel',platform:'youtube',category:'information'});
  const otherEpisode=await f.api('/api/episodes','POST',{channelId:otherChannel.id,title:'Foreign fixture episode',topic:'Local test only'});
  f.persistRun({...enriched,id:'foreign-channel-run',workflowId:'foreign-workflow',episodeId:otherEpisode.id,episodeSnapshot:otherEpisode});
  const history = f.page.locator('#wf-run-history');
  await history.locator('summary').click();
  await history.locator(`[data-run-id="${run.id}"]`).waitFor();
  assert.equal(await history.locator('[data-run-id="foreign-channel-run"]').count(),0,'another channel run must not enter this project list');
  await history.locator(`[data-run-id="${run.id}"] summary`).click();
  await history.locator(`[data-run-detail]`).getByText('fixture-result').first().waitFor();
  const listUrl=f.globalHistoryRequests.find(url=>new URL(url).pathname==='/api/workflow-runs');
  const detailUrl=f.globalHistoryRequests.find(url=>new URL(url).pathname===`/api/workflow-runs/${run.id}`);
  for(const url of [listUrl,detailUrl]){assert.ok(url,'both project list and detail requests should be issued');const parsed=new URL(url);assert.equal(parsed.searchParams.get('episodeId'),f.episode.id);assert.equal(parsed.searchParams.get('channelId'),f.channel.id);}
  assert.equal(record.output.trends[0].keyword, 'fixture-result');
});

test('review and publish stage dialogs explain human review, publication visibility, and remain keyboard dismissible', async t => {
  const f = await fixture(t);
  const nodes = [
    { id: 'trend', type: 'trend', label: 'Trend', x: 30, y: 30, config: { query: 'fixture' } },
    { id: 'research', type: 'research', label: 'Research', x: 260, y: 30, config: { limit: 1 } },
    { id: 'script', type: 'script', label: 'Script', x: 490, y: 30, config: { agent: 'studio' } },
    { id: 'storyboard', type: 'storyboard', label: 'Storyboard', x: 720, y: 30, config: {} },
    { id: 'render', type: 'render', label: 'Render', x: 950, y: 30, config: {} },
    { id: 'review', type: 'review', label: 'Human review', x: 1180, y: 30, config: { instructions: '' } },
    { id: 'publish', type: 'publish', label: 'Publish', x: 1410, y: 30, config: { platform: 'youtube', visibility: 'private' } },
  ];
  const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, source: nodes[index].id, target: node.id }));
  const workflow = await f.setup(nodes, edges);
  await f.openProject(workflow);
  await f.page.locator('.wf-node-header[data-id="review"]').click();
  await f.page.locator('.wf-graph-panel [data-wf-action="open-stage-overlay"]').click();
  const stage = f.page.locator('#wf-stage-dialog[open]');
  await stage.getByText('검토 단계는 사람이 결과를 확인하고 판단을 기록하는 단계입니다.', { exact: false }).waitFor();
  await f.page.keyboard.press('Escape');
  await f.page.locator('.wf-node-header[data-id="publish"]').click();
  await f.page.locator('.wf-graph-panel [data-wf-action="open-stage-overlay"]').click();
  await f.page.locator('#wf-stage-dialog[open]').getByText('전체 공개·일부 공개는 외부에 노출될 수 있습니다.', { exact: false }).waitFor();
  await f.page.keyboard.press('Escape');
  assert.equal(await f.page.locator('#wf-stage-dialog[open]').count(), 0);
});


test('a delayed project history response is discarded after switching to another project', async t => {
  const f = await fixture(t);
  const workflow = await f.setup([{ id: 'scope-node', type: 'trend', label: 'Scoped node', x: 30, y: 30, config: { query: 'scope-a' } }]);
  const run = { id: 'slow-project-a-run', workflowId: workflow.id, episodeId: f.episode.id, workflowName: workflow.name, workflowVersion: workflow.version, episodeVersion: f.episode.version, status: 'completed', createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', selectedStages: ['scope-node'], workflowSnapshot: workflow, episodeSnapshot: f.episode, nodeRuns: [{ nodeId: 'scope-node', type: 'trend', status: 'completed', output: { trends: [{ keyword: 'scope-a-private-result' }] } }] };
  f.persistRun(run);
  const channelB = await f.api('/api/channels', 'POST', { name: 'Switch target channel', platform: 'youtube', category: 'information' });
  const episodeB = await f.api('/api/episodes', 'POST', { channelId: channelB.id, title: 'Switch target episode', topic: 'Local test only' });
  await f.openProject(workflow);
  let releaseA;
  let markStarted;
  const startedA = new Promise(resolve => { markStarted = resolve; });
  const delayedA = new Promise(resolve => { releaseA = resolve; });
  await f.page.route('**/api/workflow-runs?*', async route => {
    const parsed = new URL(route.request().url());
    if (parsed.searchParams.get('episodeId') === f.episode.id) { markStarted(); await delayedA; }
    await route.continue();
  });
  const history = f.page.locator('#wf-run-history');
  await history.locator('summary').click();
  await startedA;
  const channelButton = f.page.locator(`[data-action=channel][data-id="${channelB.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click();
  await f.page.locator(`[data-action=episode][data-id="${episodeB.id}"]`).click();
  const switchedHistory = f.page.locator('#wf-run-history');
  await switchedHistory.waitFor();
  await switchedHistory.locator('summary').click();
  await switchedHistory.getByText('실행 기록 0개', { exact: false }).waitFor();
  releaseA();
  await f.page.waitForTimeout(150);
  assert.equal(await switchedHistory.locator('[data-run-id="slow-project-a-run"]').count(), 0, 'late response from the previous project must not repaint the current scope');
  const scopedUrls = f.globalHistoryRequests.map(url => new URL(url));
  assert.ok(scopedUrls.some(url => url.searchParams.get('episodeId') === f.episode.id && url.searchParams.get('channelId') === f.channel.id));
  assert.ok(scopedUrls.some(url => url.searchParams.get('episodeId') === episodeB.id && url.searchParams.get('channelId') === channelB.id));
});

test('an invalid draft announces validation errors and keeps workflow controls keyboard reachable', async t => {
  const f = await fixture(t);
  const draft = await f.setup([
    { id: 'isolated-a', type: 'trend', label: 'A', x: 30, y: 30, config: { query: 'a' } },
    { id: 'isolated-b', type: 'script', label: 'B', x: 300, y: 30, config: { agent: 'studio' } },
  ], [{ id: 'edge-a-b', source: 'isolated-a', target: 'isolated-b' }]);
  await f.openProject(draft);
  const validation = f.page.locator('#wf-validation');
  await f.page.locator('.wf-node-header[data-id="isolated-b"]').click();
  await f.page.locator('#wf-focused-node [data-wf-action="connections"]').click();
  const removeEdge = f.page.locator('#wf-connect-dialog[open] [data-wf-action="delete-edge"][data-id="edge-a-b"]');
  await removeEdge.focus();
  assert.match(await f.page.evaluate(() => document.activeElement?.getAttribute('aria-label') || ''), /연결 제거/);
  await f.page.keyboard.press('Enter');
  await validation.getByText('모든 노드를 하나의 실행 흐름으로 연결하세요.').waitFor();
  assert.equal(await validation.getAttribute('role'), 'alert');
  assert.equal(await validation.getAttribute('aria-live'), 'assertive');
  const dialog = f.page.locator('#wf-connect-dialog[open]');
  await dialog.waitFor();
  assert.equal(await f.page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '노드 연결 닫기', 'keyboard deletion must leave focus inside the modal');
  await f.page.keyboard.press('Escape');
  await f.page.locator('#wf-connect-dialog[open]').waitFor({ state: 'detached' });
  const outputPort = f.page.locator('.wf-node[data-node-id="isolated-a"] .wf-port.output');
  await outputPort.focus();
  assert.equal(await f.page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'A 출력 연결');
  await f.page.keyboard.press('Enter');
  await f.page.locator('#wf-connect-dialog[open]').waitFor();
  assert.equal(await f.page.locator('#wf-connect-source').count(), 1);
});


test('an unselected project never loads global workflow history', async t => {
  const f = await fixture(t,1440,{seedProject:false});
  await f.page.goto(f.base);
  const history = f.page.locator('#wf-run-history');
  await history.waitFor();
  await history.locator('summary').click();
  await history.getByText('프로젝트를 선택하지 않은 상태에서는 전역 기록을 불러오지 않습니다.', { exact: false }).waitFor();
  assert.equal(await history.locator('.wf-history-record').count(),0,'no history records may be rendered without a project');
  assert.deepEqual(f.globalHistoryRequests, [], 'no project scope means no global history list or detail request');
});
