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

// Deterministic 12-run, 6-edit seed exercising the compact history/diff contract (2.5), on a
// connected linear chain a(trend) -> b(research) -> c(research). All runs use the legacy
// selectedStages body (no `execution`) so this also proves summarizeRun's legacy-trigger
// derivation against real server output, not just hand-built fixtures.
//
// Worked out from server/workflows.mjs stageSelection's real reuse/invalidation rules:
//  R1  full[a,b,c]            -> a:ran b:ran c:ran                         전체 실행
//  R2  [c]                    -> a:kept(parent of b, not c) b:reused c:ran(same)   리서치 실행
//  R3  [a]                    -> a:ran(changed) b:blocked c:blocked         트렌드 수집 실행
//  R4  [b,c] (+1 ref)         -> a:reused b:ran(added) c:ran(added)         선택 노드 실행
//  R5  [a]                    -> a:ran(changed) b:blocked c:blocked         트렌드 수집 실행
//  R6  full[a,b,c]            -> a:ran(changed) b:ran(added) c:ran(added)   전체 실행
//  R7  [a] (fetchTrends call#5 fails) -> a:failed b:blocked c:blocked, run FAILED  트렌드 수집 실행
//  R8  [b,c] (+1 ref)         -> a:blocked(failed prior, unreusable) b:ran(added) c:ran(added)  선택 노드 실행
//  R9  [a]                    -> a:ran(added) b:blocked c:blocked           트렌드 수집 실행
//  R10 full[a,b,c]            -> a:ran(changed) b:ran(added) c:ran(added)   전체 실행
//  R11 [c] (+1 hostile-titled ref) -> a:kept(same) b:reused(same) c:ran(changed)  리서치 실행
//  R12 [a]                    -> a:ran(changed) b:blocked c:blocked         트렌드 수집 실행
//
// fetchTrends is only called by the 8 a-selecting runs (R1,R3,R5,R6,R7,R9,R10,R12); its 5th
// call (index 4, R7) returns no keywords to deterministically fail that one run.
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-history-compact-'));
  let trendCalls = 0;
  const fetchTrends = async () => {
    const index = trendCalls++;
    if (index === 4) return { trends: [], sources: [{ name: 'Fixture RSS', status: 'error' }] };
    return { trends: [{ keyword: `fixture-trend-${index}`, source: 'Fixture RSS', url: 'https://fixture.invalid/trend' }], sources: [{ name: 'Fixture RSS', status: 'ok' }] };
  };
  const forbidden = async () => { assert.fail('History compaction fixture must not invoke a paid or external operation'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}), runAgent: forbidden, fetchTrends },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
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
    assert.deepEqual(external, [], 'browser external traffic is blocked');
    assert.deepEqual(errors, [], 'the history/results rendering must not throw');
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };

  const channel = await api('/api/channels', 'POST', { name: 'History compaction channel', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'History compaction project', topic: 'Local fixture' });
  const nodes = [
    { id: 'a', type: 'trend', label: 'Trend', x: 40, y: 50, config: {} },
    { id: 'b', type: 'research', label: 'Research B', x: 340, y: 50, config: {} },
    { id: 'c', type: 'research', label: 'Research C', x: 640, y: 50, config: {} },
  ];
  const edges = [{ id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }];
  const template = await api('/api/workflows', 'POST', { name: 'History compaction fixture v1', nodes, edges });
  let workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });

  const waitRun = async id => {
    for (let turn = 0; turn < 200; turn++) {
      const run = await api(`/api/workflow-runs/${id}`);
      if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    }
    assert.fail(`Run ${id} did not reach a terminal state`);
  };
  const startRun = async (ids, resumeRunId) => {
    const response = await context.request.fetch(`${base}/api/workflows/${workflow.id}/run`, {
      method: 'POST', headers: { origin: base },
      data: { episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version, selectedStages: ids, ...(resumeRunId ? { resumeRunId } : {}) },
    });
    assert.equal(response.status(), 202, await response.text());
    return waitRun((await response.json()).id);
  };
  const addReference = title => api('/api/references', 'POST', { title, url: 'https://fixture.invalid/reference', category: 'fact-check' });

  const runs = [];
  runs.push(await startRun(['a', 'b', 'c']));                                  // R1
  runs.push(await startRun(['c'], runs.at(-1).id));                            // R2
  runs.push(await startRun(['a'], runs.at(-1).id));                            // R3
  await addReference('Reference one');
  runs.push(await startRun(['b', 'c'], runs.at(-1).id));                       // R4
  runs.push(await startRun(['a'], runs.at(-1).id));                            // R5
  runs.push(await startRun(['a', 'b', 'c'], runs.at(-1).id));                  // R6
  runs.push(await startRun(['a'], runs.at(-1).id));                            // R7 (fails)
  assert.equal(runs.at(-1).status, 'failed', 'R7 must fail deterministically on the mocked 5th trend call');
  await addReference('Reference two');
  runs.push(await startRun(['b', 'c'], runs.at(-1).id));                       // R8
  runs.push(await startRun(['a'], runs.at(-1).id));                            // R9
  runs.push(await startRun(['a', 'b', 'c'], runs.at(-1).id));                  // R10
  const hostileReferenceTitle = '<img src=x onerror="window.__wfHistoryXss=1">';
  await addReference(hostileReferenceTitle);
  runs.push(await startRun(['c'], runs.at(-1).id));                           // R11
  runs.push(await startRun(['a'], runs.at(-1).id));                            // R12
  assert.equal(runs.length, 12);
  assert.equal(trendCalls, 8, 'only the 8 a-selecting runs should call fetchTrends');

  for (let version = 2; version <= 7; version++) {
    workflow = await api(`/api/workflows/${workflow.id}`, 'PUT', { name: `History compaction fixture v${version}`, nodes, edges, expectedVersion: workflow.version });
  }

  const open = async () => {
    await page.goto(base);
    const button = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = button.locator('xpath=ancestor::details[1]');
    if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
    await button.click();
    await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
    await page.locator('#workflow-canvas').waitFor();
    assert.equal(await page.locator('#wf-select').inputValue(), workflow.id);
  };
  const openNodeResults = async (nodeId, runId) => {
    if (await page.locator('dialog.wf-overlay[open]').count()) await page.keyboard.press('Escape');
    await page.locator(`.wf-node-header[data-id="${nodeId}"]`).click();
    await page.locator('[data-wf-action=open-results]').first().click();
    const dialog = page.locator('#wf-results-dialog[open]');
    await dialog.waitFor();
    await dialog.locator('#wf-results-run').selectOption(runId);
    return dialog;
  };

  return { page, base, api, channel, episode, get workflow() { return workflow; }, runs, hostileReferenceTitle, open, openNodeResults };
}

test('compact recent-runs history renders bounded diffs, counts and triggers without raw per-node grids', async t => {
  const f = await fixture(t);
  await f.open();
  t.afterEach(async () => { if (await f.page.locator('dialog.wf-overlay[open]').count()) await f.page.keyboard.press('Escape'); });

  await t.test('shows exactly 3 recent-run rows by default, newest first, with status/version/trigger/count-chip text', async () => {
    const section = f.page.locator('#wf-recent-runs');
    await section.waitFor();
    const rows = section.locator('[data-testid="wf-recent-run"]');
    assert.equal(await rows.count(), 3);
    const [r12, r11, r10] = await Promise.all([rows.nth(0).innerText(), rows.nth(1).innerText(), rows.nth(2).innerText()]);
    for (const text of [r12, r11, r10]) {
      assert.match(text, /완료/);
      assert.match(text, /v1/);
      assert.match(text, /실행 \d+ · 재사용 \d+ · 유지 \d+ · 건너뜀 \d+/);
    }
    assert.match(r12, /트렌드 수집 실행/);   // R12: only 'a' (trend) selected
    assert.match(r11, /리서치 실행/);        // R11: only 'c' (research) selected
    assert.match(r10, /전체 실행/);          // R10: all 3 nodes selected
  });

  await t.test('never shows the raw English "not selected" string anywhere on the page', async () => {
    assert.doesNotMatch(await f.page.locator('body').innerText(), /Node was not selected for this execution/);
  });

  await t.test('R11\'s diff list shows exactly the one changed node (c) and collapses the two untouched nodes (kept a, reused b) into one count', async () => {
    const row = f.page.locator('#wf-recent-runs [data-testid="wf-recent-run"]').nth(1); // R11
    const diff = row.locator('[data-testid="wf-run-diff"]');
    await diff.waitFor();
    assert.match(await diff.innerText(), /변경 없는 노드 2개/);
    const rowSelectors = diff.locator('.wf-run-diff-row');
    assert.equal(await rowSelectors.count(), 1, 'exactly one node (c) changed in R11');
  });

  await t.test('"이전 실행 더 보기" reveals up to 10 runs total and never shows run 1 or run 2', async () => {
    const section = f.page.locator('#wf-recent-runs');
    const more = section.locator('[data-wf-action="recent-runs-more"]');
    await more.waitFor();
    await more.click();
    const rows = section.locator('[data-testid="wf-recent-run"]');
    for (let i = 0; i < 40 && (await rows.count()) < 10; i++) await f.page.waitForTimeout(50);
    assert.equal(await rows.count(), 10);
    const text = await section.innerText();
    assert.doesNotMatch(text, new RegExp(f.runs[0].id));
    assert.doesNotMatch(text, new RegExp(f.runs[1].id));
  });

  await t.test('the expanded recent-runs section stays well under the old 2808px baseline even with 10 compact rows', async () => {
    const section = f.page.locator('#wf-recent-runs');
    const height = await section.evaluate(element => element.getBoundingClientRect().height);
    // Old layout: 10 runs x a full 9-node status grid per run (measured 2808px).
    // New layout: a 1-line row + <=6 diff rows + count chips, no per-node grid.
    // 2200px is a generous cap that still demonstrates a meaningful, justified reduction.
    assert.ok(height < 2200, `#wf-recent-runs is ${height}px tall, expected a bounded compact layout under 2200px`);
  });

  await t.test('workflow version history shows 5 version buttons by default plus a "더 보기" control revealing the rest', async () => {
    await f.page.locator('a[data-wf-section][href="#wf-workflow-history"]').click();
    const nav = f.page.locator('.history-versions');
    await nav.waitFor();
    assert.equal(await nav.locator('.history-version').count(), 5, 'default view shows 5 versions including the current one, newest first');
    assert.equal(await nav.locator('.history-version:has-text("v7 · 현재")').count(), 1, 'the current version v7 is one of the 5 default buttons');
    const more = f.page.locator('[data-wf-action="history-versions-more"]');
    await more.waitFor();
    await more.click();
    assert.equal(await nav.locator('.history-version').count(), 7, '"더 보기" reveals all 7 versions (v1..v7) including the current one');
  });

  await t.test('selecting an older workflow version compares only diff rows, not a repeated static explanation', async () => {
    const nav = f.page.locator('.history-versions');
    await nav.locator('.history-version').last().click();
    const comparison = f.page.locator('.history-comparison');
    await comparison.waitFor();
    assert.ok(await comparison.locator('.change-item').count() >= 1, 'every version edited the name field, so at least one change row is expected');
  });

  await t.test('node results panel for a changed node (R11, c) shows one summary line, a diff testid, <=5 key facts, and raw output only inside a closed details', async () => {
    const dialog = await f.openNodeResults('c', f.runs[10].id); // R11: c changed (ref count 2 -> 3).
    const inspector = dialog.locator('#wf-overlay-result-inspector');
    const diff = inspector.locator('[data-testid="node-result-diff"]');
    await diff.waitFor();
    assert.match(await diff.innerText(), /참고 자료 수|변경/);
    const raw = inspector.locator('[data-testid="node-result-raw"]');
    await raw.waitFor();
    assert.equal(await raw.evaluate(element => element.open), false, 'raw output details must start closed');
    const factCount = await inspector.locator('[data-testid="node-result-facts"] > *').count();
    assert.ok(factCount >= 1 && factCount <= 5, `expected 1-5 visible key facts, got ${factCount}`);
  });

  await t.test('node results panel shows the first-run state for a node with no prior comparable output (R1, a)', async () => {
    const dialog = await f.openNodeResults('a', f.runs[0].id);
    const diff = dialog.locator('#wf-overlay-result-inspector [data-testid="node-result-diff"]');
    await diff.waitFor();
    assert.match(await diff.innerText(), /첫 실행/);
  });

  await t.test('a cross-run kept node (R11, a) and a same-run reused node (R11, b) both render the same saved-reuse summary wording', async () => {
    let dialog = await f.openNodeResults('a', f.runs[10].id); // R11: a kept (unselected, retained, unchanged since R10).
    assert.match(await dialog.locator('#wf-overlay-result-inspector').innerText(), /저장 결과 재사용/);
    dialog = await f.openNodeResults('b', f.runs[10].id); // R11: b reused (direct parent of selected c).
    assert.match(await dialog.locator('#wf-overlay-result-inspector').innerText(), /저장 결과 재사용/);
  });

  await t.test('the full run history record lists only executed/failed/changed nodes, collapsing the rest into one count', async () => {
    await f.page.locator('a[data-wf-section][href="#wf-run-history"]').click();
    const details = f.page.locator('#wf-run-history');
    if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
    await f.page.locator('#wf-run-history-content').waitFor();
    const record = f.page.locator('.wf-history-record').first();
    await record.waitFor();
    if (!await record.evaluate(element => element.open)) await record.locator('summary').click();
    const body = record.locator('.wf-history-record-body');
    await body.waitFor();
    await body.locator('[data-run-detail] .wf-history-facts').waitFor();
    assert.match(await body.innerText(), /나머지 \d+개 노드는 이번 실행에서 변경 없음/);
  });

  await t.test('a hostile reference title inside a changed node\'s real output (R11, c) renders as plain escaped text inside the opened raw details, never as an injected element', async () => {
    const dialog = await f.openNodeResults('c', f.runs[10].id);
    const inspector = dialog.locator('#wf-overlay-result-inspector');
    const raw = inspector.locator('[data-testid="node-result-raw"]');
    await raw.locator('summary').click();
    const rawText = await inspector.innerText();
    assert.ok(rawText.includes('<img src=x onerror='), 'the hostile tag prefix must survive as plain text in the raw JSON dump');
    assert.ok(rawText.includes('window.__wfHistoryXss=1'), 'the hostile payload must survive as plain text in the raw JSON dump');
    assert.equal(await inspector.locator('img').count(), 0);
    assert.equal(await f.page.evaluate(() => window.__wfHistoryXss), undefined);
  });
});

// --- H1/H2: independent UI review fixes to the EXPANDED run-history detail -----------------
// (loadRunHistoryDetail in public/workflow.js, section 2.5 "Expanded full history"). Separate
// fixtures from the compact-row suite above: H1 needs a skip/fail/cascade-fail mix the 12-run
// seed doesn't exercise, H2 needs >6 changed nodes in one run.

const HOSTILE_H1 = '<img src=x onerror="window.__wfH1Xss=1">';

async function fixtureH1(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-history-detail-h1-'));
  const fetchTrends = async () => ({ trends: [{ keyword: HOSTILE_H1, source: 'Fixture RSS', url: 'https://fixture.invalid/trend' }], sources: [{ name: 'Fixture RSS', status: 'ok' }] });
  const forbidden = async () => { assert.fail('H1 fixture must not invoke a paid or external operation'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}), runAgent: forbidden, fetchTrends },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
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
    assert.deepEqual(external, [], 'browser external traffic is blocked');
    assert.deepEqual(errors, [], 'the expanded run-history rendering must not throw');
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };

  const channel = await api('/api/channels', 'POST', { name: 'History detail H1 channel', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'History detail H1 project', topic: 'Local fixture' });
  // a: untouched-query trend (matches HOSTILE_H1 via empty-query no-filter path) -> completes.
  // b: untouched (never selected, no skip, no failure) -> collapses into "나머지".
  // c: user-skipped via /skips before the run -> skipReason:'user', shown, no error text.
  // d: query that filters out every returned trend -> fails with a real error message.
  // e: downstream of d, selected but cascade-skipped when d fails -> '선행 노드 실패로 중단됨'.
  const nodes = [
    { id: 'a', type: 'trend', label: 'A', x: 40, y: 40, config: {} },
    { id: 'b', type: 'trend', label: 'B', x: 240, y: 40, config: {} },
    { id: 'c', type: 'trend', label: 'C', x: 440, y: 40, config: {} },
    { id: 'd', type: 'trend', label: 'D', x: 640, y: 40, config: { query: 'this-string-matches-nothing-the-mock-returns' } },
    { id: 'e', type: 'trend', label: 'E', x: 840, y: 40, config: {} },
  ];
  const edges = [{ id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }, { id: 'cd', source: 'c', target: 'd' }, { id: 'de', source: 'd', target: 'e' }];
  const template = await api('/api/workflows', 'POST', { name: 'History detail H1 fixture', nodes, edges });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const skipped = await api(`/api/workflows/${workflow.id}/skips`, 'POST', { nodeId: 'c', skipped: true, expectedVersion: workflow.version });
  assert.deepEqual(skipped.skippedNodes, ['c']);

  const waitRun = async id => {
    for (let turn = 0; turn < 200; turn++) {
      const run = await api(`/api/workflow-runs/${id}`);
      if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    }
    assert.fail(`Run ${id} did not reach a terminal state`);
  };
  const response = await context.request.fetch(`${base}/api/workflows/${workflow.id}/run`, {
    method: 'POST', headers: { origin: base },
    data: { episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version, selectedStages: ['a', 'd', 'e'] },
  });
  assert.equal(response.status(), 202, await response.text());
  const run = await waitRun((await response.json()).id);
  assert.equal(run.status, 'failed');
  assert.equal(run.nodeRuns.find(item => item.nodeId === 'a').status, 'completed');
  assert.equal(run.nodeRuns.find(item => item.nodeId === 'b').status, 'skipped');
  assert.equal(run.nodeRuns.find(item => item.nodeId === 'b').skipReason, 'unselected');
  assert.equal(run.nodeRuns.find(item => item.nodeId === 'c').skipReason, 'user');
  assert.equal(run.nodeRuns.find(item => item.nodeId === 'd').status, 'failed');
  assert.equal(run.nodeRuns.find(item => item.nodeId === 'e').status, 'skipped');
  assert.equal(run.nodeRuns.find(item => item.nodeId === 'e').error, 'A connected upstream node failed');

  const openExpandedRecord = async () => {
    await page.goto(base);
    const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
    if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
    await channelButton.click();
    await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
    await page.locator('#workflow-canvas').waitFor();
    await page.locator('a[data-wf-section][href="#wf-run-history"]').click();
    const details = page.locator('#wf-run-history');
    if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
    await page.locator('#wf-run-history-content').waitFor();
    const record = page.locator(`.wf-history-record[data-run-id="${run.id}"]`);
    await record.waitFor();
    if (!await record.evaluate(element => element.open)) await record.locator('summary').click();
    const body = record.locator('.wf-history-record-body');
    await body.waitFor();
    await body.locator('[data-run-detail] .wf-history-facts').waitFor();
    return body;
  };

  return { page, run, openExpandedRecord };
}

test('H1: expanded run-history record never leaks raw English or ambiguous skip text, shows only touched nodes, and keeps raw output closed', async t => {
  const f = await fixtureH1(t);
  const body = await f.openExpandedRecord();

  await t.test('never shows the raw English "not selected" sentinel, anywhere, including inside role=alert elements', async () => {
    const text = await body.innerText();
    assert.doesNotMatch(text, /Node was not selected for this execution/);
    const alerts = body.locator('[role="alert"]');
    const alertCount = await alerts.count();
    for (let i = 0; i < alertCount; i++) assert.doesNotMatch(await alerts.nth(i).innerText(), /Node was not selected for this execution/);
  });

  await t.test('shows exactly 4 compact rows (a,c,d,e) classified by their actual rendered content: one completed-with-hostile-output, one user-skip, one failed, one cascade-skip', async () => {
    const stages = body.locator('.wf-history-stage');
    assert.equal(await stages.count(), 4, 'only the 4 touched nodes (a,c,d,e) get a row; unselected b is excluded');
    const rows = [];
    const count = await stages.count();
    for (let i = 0; i < count; i++) {
      const row = stages.nth(i);
      const text = await row.innerText();
      const alertCount = await row.locator('[role="alert"]').count();
      const alertText = alertCount ? await row.locator('[role="alert"]').innerText() : '';
      rows.push({ row, text, alertCount, alertText });
    }
    const completed = rows.filter(item => /완료/.test(item.text));
    const failed = rows.filter(item => /실패/.test(item.text) && item.alertCount > 0 && /Trend source returned no verified keywords/.test(item.alertText));
    const userSkip = rows.filter(item => /건너뜀/.test(item.text) && item.alertCount === 0);
    const cascadeSkip = rows.filter(item => /건너뜀/.test(item.text) && item.alertCount > 0 && /선행 노드 실패로 중단됨/.test(item.alertText));
    assert.equal(completed.length, 1, 'exactly one completed row (node a)');
    assert.equal(failed.length, 1, 'exactly one failed row with its real error message (node d)');
    assert.equal(userSkip.length, 1, 'exactly one skipped row with NO error/alert text (user-skipped node c)');
    assert.equal(cascadeSkip.length, 1, 'exactly one skipped row with the translated cascade message (node e)');
    assert.equal(completed.length + failed.length + userSkip.length + cascadeSkip.length, 4, 'every one of the 4 touched rows falls into exactly one of these 4 buckets, no overlap or unmatched row');

    const aText = completed[0].text;
    assert.ok(aText.includes('<img src=x onerror='), 'the completed node renders its hostile keyword as plain text');
    assert.ok(aText.includes('window.__wfH1Xss=1'));
    assert.equal(await completed[0].row.locator('img').count(), 0, 'the hostile keyword never becomes a real <img> element');
    assert.equal(await f.page.evaluate(() => window.__wfH1Xss), undefined, 'the hostile keyword never executes');
  });

  await t.test('the unchanged/unselected node (b) collapses into exactly one "나머지 1개 노드는 이번 실행에서 변경 없음" line, not an individual row', async () => {
    const text = await body.innerText();
    assert.match(text, /나머지 1개 노드는 이번 실행에서 변경 없음/);
    const stages = body.locator('.wf-history-stage');
    const names = await stages.locator('strong').allTextContents();
    assert.equal(names.includes('B'), false);
  });

  await t.test('raw output per node is only inside a CLOSED node-result-raw details, with <=5 key facts visible outside it', async () => {
    const stages = body.locator('.wf-history-stage');
    const count = await stages.count();
    for (let i = 0; i < count; i++) {
      const row = stages.nth(i);
      const raw = row.locator('[data-testid="node-result-raw"]');
      if (await raw.count()) assert.equal(await raw.evaluate(element => element.open), false, 'raw output details must start closed');
      const facts = row.locator('[data-testid="node-result-facts"] > *');
      const factCount = await facts.count();
      assert.ok(factCount <= 5, `expected <=5 visible key facts, got ${factCount}`);
    }
  });
});

async function fixtureH2(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-history-detail-h2-'));
  let trendCalls = 0;
  const fetchTrends = async () => ({ trends: [{ keyword: `h2-keyword-${trendCalls++}`, source: 'Fixture RSS', url: 'https://fixture.invalid/trend' }], sources: [{ name: 'Fixture RSS', status: 'ok' }] });
  const forbidden = async () => { assert.fail('H2 fixture must not invoke a paid or external operation'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}), runAgent: forbidden, fetchTrends },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
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
    assert.deepEqual(external, [], 'browser external traffic is blocked');
    assert.deepEqual(errors, [], 'the overflow-row rendering must not throw');
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };

  const channel = await api('/api/channels', 'POST', { name: 'History overflow H2 channel', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'History overflow H2 project', topic: 'Local fixture' });
  // 9 independent trend nodes chained into one weakly-connected star so the graph passes the
  // "every node must be connected" check, with no edge creating a hard dependency between them.
  const nodes = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, type: 'trend', label: `N${i}`, x: 40 + i * 160, y: 40, config: {} }));
  const edges = nodes.slice(1).map((node, i) => ({ id: `e${i}`, source: nodes[i].id, target: node.id }));
  const template = await api('/api/workflows', 'POST', { name: 'History overflow H2 fixture', nodes, edges });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });

  const waitRun = async id => {
    for (let turn = 0; turn < 200; turn++) {
      const run = await api(`/api/workflow-runs/${id}`);
      if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    }
    assert.fail(`Run ${id} did not reach a terminal state`);
  };
  const response = await context.request.fetch(`${base}/api/workflows/${workflow.id}/run`, {
    method: 'POST', headers: { origin: base },
    data: { episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version, selectedStages: nodes.map(node => node.id) },
  });
  assert.equal(response.status(), 202, await response.text());
  const run = await waitRun((await response.json()).id);
  assert.equal(run.status, 'completed');
  assert.equal(run.nodeRuns.length, 9);
  assert.equal(run.nodeRuns.every(item => item.status === 'completed'), true, 'a first-ever run has no previous run to resume from, so every selected node runs fresh');

  const open = async () => {
    await page.goto(base);
    const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
    if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
    await channelButton.click();
    await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
    await page.locator('#workflow-canvas').waitFor();
  };

  return { page, run, open };
}

test('H2: a run with 9 changed nodes caps the compact diff list at 6 rows, shows an overflow count, and shown+overflow+untouched equals nodeRuns.length', async t => {
  const f = await fixtureH2(t);
  await f.open();
  const row = f.page.locator('#wf-recent-runs [data-testid="wf-recent-run"]').first();
  await row.waitFor();
  const diff = row.locator('[data-testid="wf-run-diff"]');
  await diff.waitFor();
  const changeRowCount = await diff.locator('.wf-run-diff-row').count();
  assert.equal(changeRowCount, 6, 'the diff list caps at 6 change rows even with 9 changed nodes');
  const diffText = await diff.innerText();
  assert.match(diffText, /외 3개 노드 변경/);
  const overflowMatch = /외 (\d+)개 노드 변경/.exec(diffText);
  const overflowCount = overflowMatch ? Number(overflowMatch[1]) : 0;
  const untouchedMatch = /변경 없는 노드 (\d+)개/.exec(diffText);
  const untouchedCount = untouchedMatch ? Number(untouchedMatch[1]) : 0;
  assert.equal(changeRowCount + overflowCount + untouchedCount, f.run.nodeRuns.length, 'shown + overflow + untouched must equal every node run, nothing silently dropped');
  assert.equal(overflowCount, 3);
  assert.equal(untouchedCount, 0);
});

// --- H4: node LABEL must win over TYPE NAME (independent UI review follow-up) --------------
// Two surfaces, one fixture:
// (a) loadRunHistoryDetail's per-row name must prefer the node's own label over the shared
//     type name (bug found while writing H1: same-type nodes were indistinguishable because
//     the old code checked TYPES[type].name BEFORE snapshot?.label, backwards from nodeName()'s
//     own node.label-first priority used everywhere else in the file).
// (b) runsHtml's compact diff rows must keep using THIS RUN's workflowSnapshot label for a node
//     that is later renamed or removed from the live workflow — never the current live name.

const HOSTILE_H4_LABEL = '<img src=x onerror="window.__wfH4Xss=1">';

async function fixtureH4(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-history-label-h4-'));
  const fetchTrends = async () => ({ trends: [{ keyword: 'h4-keyword', source: 'Fixture RSS', url: 'https://fixture.invalid/trend' }], sources: [{ name: 'Fixture RSS', status: 'ok' }] });
  const forbidden = async () => { assert.fail('H4 fixture must not invoke a paid or external operation'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}), runAgent: forbidden, fetchTrends },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
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
    assert.deepEqual(external, [], 'browser external traffic is blocked');
    assert.deepEqual(errors, [], 'the label-priority rendering must not throw');
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };

  const channel = await api('/api/channels', 'POST', { name: 'History label H4 channel', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'History label H4 project', topic: 'Local fixture' });
  // a, b, c, x: all type 'trend' (same TYPES[type].name "트렌드 수집"), distinguishable only by label.
  // a: normal label. b: hostile label (XSS escaping check). c: NO label -> must fall back to the
  // type name. x: normal label at run time, renamed then removed from the live workflow afterward.
  const nodesV1 = [
    { id: 'a', type: 'trend', label: 'A 키워드', x: 40, y: 40, config: {} },
    { id: 'b', type: 'trend', label: HOSTILE_H4_LABEL, x: 240, y: 40, config: {} },
    { id: 'c', type: 'trend', x: 440, y: 40, config: {} },
    { id: 'x', type: 'trend', label: 'Old Label X', x: 640, y: 40, config: {} },
  ];
  const edges = [{ id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }, { id: 'cx', source: 'c', target: 'x' }];
  const template = await api('/api/workflows', 'POST', { name: 'History label H4 fixture', nodes: nodesV1, edges });
  let workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });

  const waitRun = async id => {
    for (let turn = 0; turn < 200; turn++) {
      const run = await api(`/api/workflow-runs/${id}`);
      if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    }
    assert.fail(`Run ${id} did not reach a terminal state`);
  };
  const response = await context.request.fetch(`${base}/api/workflows/${workflow.id}/run`, {
    method: 'POST', headers: { origin: base },
    data: { episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version, selectedStages: ['a', 'b', 'c', 'x'] },
  });
  assert.equal(response.status(), 202, await response.text());
  const run = await waitRun((await response.json()).id);
  assert.equal(run.status, 'completed');
  assert.equal(run.workflowSnapshot.nodes.find(node => node.id === 'x').label, 'Old Label X');

  // Rename x (v2), then remove x entirely (v3). Either way, run's own workflowSnapshot keeps
  // the original 'Old Label X' — the live workflow object must never be consulted for this run.
  workflow = await api(`/api/workflows/${workflow.id}`, 'PUT', { name: workflow.name, nodes: nodesV1.map(node => node.id === 'x' ? { ...node, label: 'Renamed X' } : node), edges, expectedVersion: workflow.version });
  const nodesV3 = nodesV1.filter(node => node.id !== 'x');
  const edgesV3 = edges.filter(edge => edge.target !== 'x' && edge.source !== 'x');
  workflow = await api(`/api/workflows/${workflow.id}`, 'PUT', { name: workflow.name, nodes: nodesV3, edges: edgesV3, expectedVersion: workflow.version });
  assert.equal(workflow.nodes.some(node => node.id === 'x'), false, 'node x no longer exists in the live workflow');

  const open = async () => {
    await page.goto(base);
    const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
    if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
    await channelButton.click();
    await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
    await page.locator('#workflow-canvas').waitFor();
  };
  const openExpandedRecord = async () => {
    await page.locator('a[data-wf-section][href="#wf-run-history"]').click();
    const details = page.locator('#wf-run-history');
    if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
    await page.locator('#wf-run-history-content').waitFor();
    const record = page.locator(`.wf-history-record[data-run-id="${run.id}"]`);
    await record.waitFor();
    if (!await record.evaluate(element => element.open)) await record.locator('summary').click();
    const body = record.locator('.wf-history-record-body');
    await body.waitFor();
    await body.locator('[data-run-detail] .wf-history-facts').waitFor();
    return body;
  };

  return { page, run, open, openExpandedRecord };
}

test('H4: node LABEL wins over the shared TYPE NAME, both in the expanded detail and in compact diff rows that outlive a rename/removal', async t => {
  const f = await fixtureH4(t);
  await f.open();

  await t.test('expanded run-history rows show each node\'s own label (escaped, including a hostile one), and fall back to the type name only when unlabeled', async () => {
    const bodyEl = await f.openExpandedRecord();
    const stages = bodyEl.locator('.wf-history-stage');
    assert.equal(await stages.count(), 4, 'all 4 nodes were selected/executed so all 4 get a row');
    const rowTexts = [];
    const count = await stages.count();
    for (let i = 0; i < count; i++) rowTexts.push(await stages.nth(i).innerText());
    const aRow = rowTexts.find(text => text.includes('A 키워드'));
    assert.ok(aRow, 'node a shows its own label "A 키워드", not the shared type name');
    const bRow = rowTexts.find(text => text.includes('<img src=x onerror=') && text.includes('window.__wfH4Xss=1'));
    assert.ok(bRow, 'node b shows its hostile label as plain escaped text');
    const xRow = rowTexts.find(text => text.includes('Old Label X'));
    assert.ok(xRow, 'node x shows its own label "Old Label X", not the type name, not its later rename');
    const cRow = rowTexts.find(text => !text.includes('A 키워드') && !text.includes('window.__wfH4Xss') && !text.includes('Old Label X'));
    assert.ok(cRow, 'the unlabeled node c has its own row');
    assert.match(cRow, /트렌드 수집/, 'the unlabeled node c falls back to the type name "트렌드 수집"');
    assert.equal(await bodyEl.locator('img').count(), 0, 'the hostile label never becomes a real <img> element anywhere in the expanded record');
    assert.equal(await f.page.evaluate(() => window.__wfH4Xss), undefined, 'the hostile label never executes');
  });

  await t.test('the compact recent-runs diff row for node x still shows "Old Label X" from this run\'s own snapshot, after x was renamed then removed from the live workflow', async () => {
    const diffRow = f.page.locator('#wf-recent-runs [data-testid="wf-run-diff"] .wf-run-diff-row', { hasText: /Old Label X/ });
    await diffRow.waitFor();
    assert.equal(await diffRow.count(), 1, 'exactly one diff row carries the snapshot-era label for node x');
    const liveRowText = await f.page.locator('#wf-recent-runs [data-testid="wf-run-diff"] .wf-run-diff-row', { hasText: /Renamed X/ }).count();
    assert.equal(liveRowText, 0, 'the diff row never shows the live-workflow rename, since it reads the run\'s own frozen snapshot');
  });
});
