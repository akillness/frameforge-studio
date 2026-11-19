import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';
import { describeNodeActor, summarizeNodeHandoffs } from '../server/workflows.mjs';

const modulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();

test('describeNodeActor and summarizeNodeHandoffs derive accurate agent flow metadata', () => {
  const scriptStudio = describeNodeActor({ id: 's1', type: 'script', config: { agent: 'studio' } });
  assert.equal(scriptStudio.role, 'studio');
  assert.equal(scriptStudio.mode, 'deterministic');

  const scriptCodex = describeNodeActor({ id: 's2', type: 'script', config: { agent: 'codex' } });
  assert.equal(scriptCodex.role, 'codex');
  assert.equal(scriptCodex.mode, 'provider');

  const reviewGate = describeNodeActor({ id: 'r1', type: 'review', config: {} });
  assert.equal(reviewGate.role, 'human-reviewer');
  assert.equal(reviewGate.mode, 'gate');

  const workflow = {
    nodes: [
      { id: 'n1', type: 'news' },
      { id: 'n2', type: 'script' },
      { id: 'n3', type: 'review' },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  };
  const handoffs = summarizeNodeHandoffs(workflow, {
    nodeRuns: [
      { nodeId: 'n1', status: 'completed', reused: false },
      { nodeId: 'n2', status: 'pending' },
      { nodeId: 'n3', status: 'running' },
    ],
  });
  assert.equal(handoffs.length, 2);
  assert.equal(handoffs[0].status, 'transferred');
  assert.equal(handoffs[1].status, 'running');
});

test('workflow run execution records node actor metadata, durations, handoffs, and /events API', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-agent-flow-api-'));
  const app = createApp({
    dataDir,
    loginToken: '',
    publicOrigin: '',
    integrations: {
      integrationStatus: async () => ({ studio: { available: true } }),
      fetchNews: async query => ({
        query,
        fetchedAt: new Date().toISOString(),
        articles: [{ title: 'AI Agent Flow', url: 'https://example.com/a', source: 'Test', snippet: 'snippet' }],
      }),
      runAgent: async () => { throw new Error('unexpected external agent call'); },
      fetchTrends: async () => ({ trends: [], sources: [] }),
    },
    generation: { capability: async () => ({ available: false }) },
    speech: { listVoices: async () => ({ available: false, voices: [] }) },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => {
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const chRes = await fetch(`${base}/api/channels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Flow Channel', platform: 'youtube', category: 'information' }),
  });
  assert.equal(chRes.status, 201);
  const channel = await chRes.json();

  const epRes = await fetch(`${base}/api/episodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Flow Ep', topic: 'AI Agent Flow', channelId: channel.id }),
  });
  assert.equal(epRes.status, 201);
  const ep = await epRes.json();

  const tplRes = await fetch(`${base}/api/workflows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Agent Telemetry Flow',
      nodes: [
        { id: 'news-1', type: 'news', label: '뉴스 수집', x: 60, y: 80, config: { query: 'AI', maxArticles: 2 } },
        { id: 'script-1', type: 'script', label: '대본 생성', x: 340, y: 80, config: { agent: 'studio', prompt: '짧은 훅으로 작성' } },
      ],
      edges: [{ id: 'e-1', source: 'news-1', target: 'script-1' }],
    }),
  });
  assert.equal(tplRes.status, 201);
  const template = await tplRes.json();

  const wfRes = await fetch(`${base}/api/workflows/${template.id}/copies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channelId: channel.id, episodeId: ep.id, expectedTemplateVersion: template.version }),
  });
  assert.equal(wfRes.status, 201);
  const wf = await wfRes.json();

  const runRes = await fetch(`${base}/api/workflows/${wf.id}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episodeId: ep.id, expectedWorkflowVersion: wf.version, expectedEpisodeVersion: ep.version }),
  });
  assert.equal(runRes.status, 202);
  const started = await runRes.json();

  let run = started;
  for (let i = 0; i < 60 && !['completed', 'failed', 'cancelled', 'awaiting_review'].includes(run.status); i++) {
    await new Promise(r => setTimeout(r, 80));
    run = await (await fetch(`${base}/api/workflow-runs/${started.id}`)).json();
  }
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.equal(typeof run.durationMs, 'number');
  assert.equal(run.handoffs[0].status, 'transferred');
  assert.equal(run.nodeRuns[0].executionMeta.role, 'news-collector');
  assert.equal(run.nodeRuns[1].executionMeta.role, 'studio');
  assert.equal(typeof run.nodeRuns[1].durationMs, 'number');
  assert.equal(run.nodeRuns[1].upstreamInputs[0].sourceNodeId, 'news-1');

  const evRes = await fetch(`${base}/api/workflow-runs/${started.id}/events`);
  assert.equal(evRes.status, 200);
  const evBody = await evRes.json();
  const types = evBody.events.map(e => e.type);
  assert.ok(types.includes('workflow.node_started'));
  assert.ok(types.includes('workflow.node_completed'));
});

test('Agent Execution Flow UI switches modes, supports inline edits/undo/save, and stays responsive without horizontal overflow', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-agent-flow-ui-'));
  const app = createApp({
    dataDir,
    loginToken: '',
    publicOrigin: '',
    integrations: {
      integrationStatus: async () => ({ studio: { available: false } }),
      runAgent: async () => { throw new Error('unexpected external call'); },
      fetchTrends: async query => ({ trends: [{ keyword: query, source: 'Fixture', url: 'https://example.com/t' }], sources: [] }),
    },
    generation: { capability: async () => ({ available: false }) },
    speech: { listVoices: async () => ({ available: false, voices: [] }) },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  t.after(async () => {
    await context.close();
    await browser.close();
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.deepEqual(pageErrors, []);
  });

  // Seed channel, episode, workflow copy, and one completed trend run
  const ch = await (await fetch(`${base}/api/channels`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'UI Flow Channel', platform: 'youtube', category: 'information' }),
  })).json();
  const ep = await (await fetch(`${base}/api/episodes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channelId: ch.id, title: 'UI Flow Project', topic: 'Agent Flow UI' }),
  })).json();
  const tpl = await (await fetch(`${base}/api/workflows`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Flow UI Graph',
      nodes: [
        { id: 't1', type: 'trend', label: '트렌드 탐색', x: 50, y: 60, config: { query: 'AI' } },
        { id: 'n1', type: 'news', label: '뉴스 수집', x: 320, y: 60, config: { query: 'AI', maxArticles: 2 } },
        { id: 's1', type: 'script', label: '대본 에이전트', x: 590, y: 60, config: { agent: 'studio', prompt: '간결하게 작성' } },
      ],
      edges: [
        { id: 'e1', source: 't1', target: 'n1' },
        { id: 'e2', source: 'n1', target: 's1' },
      ],
    }),
  })).json();

  const wf = await (await fetch(`${base}/api/workflows/${tpl.id}/copies`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channelId: ch.id, episodeId: ep.id, expectedTemplateVersion: tpl.version }),
  })).json();
  const started = await (await fetch(`${base}/api/workflows/${wf.id}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episodeId: ep.id, selectedStages: ['t1'], startStage: 't1', expectedWorkflowVersion: wf.version, expectedEpisodeVersion: ep.version }),
  })).json();
  for (let i = 0; i < 40; i++) {
    const r = await (await fetch(`${base}/api/workflow-runs/${started.id}`)).json();
    if (['completed', 'failed', 'cancelled'].includes(r.status)) break;
    await new Promise(res => setTimeout(res, 60));
  }

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('.wf-view-switch [data-view-mode="flow"]').waitFor();

  // Single-canvas invariant remains intact
  assert.equal(await page.locator('.project-modes, .task-nav [data-view="studio"], .task-nav [data-view="workflow"]').count(), 0);

  // Switch to Agent Execution Flow view
  await page.locator('.wf-view-switch [data-view-mode="flow"]').click();
  await page.locator('#wf-agent-flow:not([hidden])').waitFor();
  assert.equal(await page.locator('.wf-flow-step').count(), 3);

  // Trace disclosure loads /events for active run
  const traceDetails = page.locator('[data-testid="wf-agent-trace"]');
  await traceDetails.locator('summary').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="wf-agent-trace"] .wf-trace-item').length >= 1);

  // Inline edit script label + agent in Flow mode -> updates draft -> undo -> save
  const scriptStep = page.locator('.wf-flow-step[data-flow-node-id="s1"]').first();
  const labelInput = scriptStep.locator('[data-wf-flow-field="label"]');
  await labelInput.fill('에이전트 대본 스텝');
  const agentSelect = scriptStep.locator('[data-wf-flow-config="agent"]');
  await agentSelect.selectOption('codex');
  assert.match(await scriptStep.locator('.wf-flow-actor-badge').textContent(), /CODEX/);
  assert.match(await page.locator('#wf-save-status').textContent(), /저장되지 않은 변경/);

  await page.locator('[data-wf-action="undo"]').click();
  assert.equal(await agentSelect.inputValue(), 'studio');

  await agentSelect.selectOption('codex');
  await page.locator('[data-wf-action="save"]').click();
  await page.waitForFunction(() => document.querySelector('#wf-save-status')?.textContent?.includes('저장됨'));

  await scriptStep.locator('[data-wf-action="splice-after"]').click();
  await page.locator('#wf-add-node-dialog[open]').waitFor();
  await page.locator('#wf-add-node-dialog [data-wf-action="close-overlay"]').first().click();


  // Responsive overflow check across 1440px, 768px, 375px in flow mode
  for (const vp of [{ width: 1440, height: 900 }, { width: 768, height: 900 }, { width: 375, height: 844 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(140);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `flow mode horizontal overflow at ${vp.width}px: ${overflow}`);
  }

  // Switch back to canvas mode at 375px -> stacked, resize up -> canvas, zoom in (autoFit=false), resize down -> stacked
  await page.locator('.wf-view-switch [data-view-mode="canvas"]').click();
  await page.locator('#workflow-canvas:not([hidden])').waitFor();
  assert.equal(await page.locator('#workflow-canvas').getAttribute('data-layout'), 'stacked');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(180);
  assert.equal(await page.locator('#workflow-canvas').getAttribute('data-layout'), 'canvas');
  await page.locator('[data-wf-action="zoom-in"]').click();
  await page.setViewportSize({ width: 375, height: 844 });
  await page.waitForTimeout(180);
  assert.equal(await page.locator('#workflow-canvas').getAttribute('data-layout'), 'stacked');
});
