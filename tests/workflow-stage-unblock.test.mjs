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

async function fixture(t, graph) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-stage-unblock-'));
  const forbidden = async () => { assert.fail('Stage fixture must not invoke a paid or external provider'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: {
      integrationStatus: async () => ({ studio: { available: false } }),
      fetchTrends: async query => ({ trends: [{ keyword: query, source: 'Fixture RSS', url: 'https://fixture.invalid/article' }], sources: [{ name: 'Fixture RSS', status: 'ok' }] }),
      runAgent: forbidden,
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
  const external = [], errors = [], writes = [];
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
    assert.equal(writes.some(path => /\/(quote|generations|publication)(\/|$)/.test(path)), false);
  });
  const request = (path, method = 'GET', body) => context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
  const api = async (path, method = 'GET', body) => {
    const response = await request(path, method, body);
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const channel = await api('/api/channels', 'POST', { name: 'Stage fixture channel', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Stage fixture project', topic: 'Local only' });
  const ids = ['a', 'b', 'c'];
  const template = await api('/api/workflows', 'POST', graph || {
    name: 'Stage fixture', nodes: ids.map((id, i) => ({ id, type: 'trend', label: `Trend ${id}`, x: 50 + i * 300, y: 50, config: { query: `fixture-${id}` } })),
    edges: [{ id: 'ab', source: 'a', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }],
  });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const waitRun = async id => {
    for (let turn = 0; turn < 200; turn++) {
      const run = await api(`/api/workflow-runs/${id}`);
      if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    }
    assert.fail(`Run ${id} did not reach a terminal state`);
  };
  const start = async (id, resumeRunId) => {
    const response = await request(`/api/workflows/${workflow.id}/run`, 'POST', {
      episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version,
      selectedStages: [id], startStage: id, ...(resumeRunId ? { resumeRunId } : {}),
    });
    assert.equal(response.status(), 202, await response.text());
    return waitRun((await response.json()).id);
  };
  const open = async () => {
    await page.goto(base);
    const button = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = button.locator('xpath=ancestor::details[1]');
    if (await group.count() && !await group.evaluate(element => element.open)) await group.locator('summary').click();
    await button.click();
    await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
    await page.locator('#workflow-canvas').waitFor();
    assert.equal(await page.locator('#wf-select').inputValue(), workflow.id);
  };
  const stage = async id => {
    await page.locator(`.wf-node-header[data-id="${id}"]`).click();
    await page.locator('[data-wf-action=open-stage-overlay]').first().click();
    const dialog = page.locator('#wf-stage-dialog[open]'); await dialog.waitFor();
    return dialog;
  };
  return { page, base, request, api, episode, workflow, waitRun, start, open, stage };
}

test('saving a workflow edit starts a fresh selected stage instead of resuming stale version evidence', async t => {
  const f = await fixture(t);
  const prior = await f.start('a');
  assert.equal(prior.status, 'completed', JSON.stringify(prior));
  assert.equal(prior.workflowVersion, f.workflow.version);
  await f.open();
  await f.page.locator('[data-wf-action=open-workflow-settings]').click();
  await f.page.locator('#wf-workflow-name').fill('Stage fixture edited');
  await f.page.keyboard.press('Escape');
  const saved = f.page.waitForResponse(r => r.url() === `${f.base}/api/workflows/${f.workflow.id}` && r.request().method() === 'PUT');
  await f.page.locator('[data-wf-action=save]').click();
  const saveResponse = await saved;
  assert.equal(saveResponse.status(), 200, await saveResponse.text());
  const updated = await saveResponse.json();
  assert.equal(updated.version, prior.workflowVersion + 1);
  const dialog = await f.stage('a');
  assert.equal(await dialog.locator('#wf-stage-start').isEnabled(), true);
  const pending = f.page.waitForResponse(r => r.url() === `${f.base}/api/workflows/${f.workflow.id}/run` && r.request().method() === 'POST');
  await dialog.locator('#wf-stage-start').click();
  const response = await pending;
  const options = response.request().postDataJSON();
  assert.equal(options.expectedWorkflowVersion, updated.version);
  // Contract 2.3: run-node/stage overlay posts a server-planned execution intent, never a
  // client-built selectedStages/resumeRunId (old ad hoc selection logic removed).
  assert.deepEqual(options.execution, { mode: 'node', targetNodeId: 'a' }, 'the stage overlay posts exactly a node-targeted execution intent, not a client-built selection');
  assert.equal(options.selectedStages, undefined, 'the UI must never build selectedStages itself');
  assert.equal(options.resumeRunId, undefined, 'the UI must never build resumeRunId itself (old-version evidence must not be client-sent)');
  assert.equal(response.status(), 202, await response.text());
  const result = await f.waitRun((await response.json()).id);
  assert.equal(result.resumedFrom, undefined, 'the server-derived plan must not resume stale version evidence from the pre-edit run');
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.workflowVersion, updated.version);
  assert.deepEqual(result.nodeRuns.find(node => node.nodeId === 'a').output.trends.map(item => item.keyword), ['fixture-a']);
});

test('a selected trend can run when a connected optional ancestor has no output, matching the server boundary', async t => {
  const f = await fixture(t);
  const first = await f.start('a');
  assert.equal(first.status, 'completed', JSON.stringify(first));
  assert.equal(first.nodeRuns.find(node => node.nodeId === 'b').status, 'skipped');
  const accepted = await f.start('c', first.id);
  assert.equal(accepted.status, 'completed', JSON.stringify(accepted));
  assert.deepEqual(accepted.nodeRuns.find(node => node.nodeId === 'c').output.trends.map(item => item.keyword), ['fixture-c']);
  assert.equal(accepted.nodeRuns.find(node => node.nodeId === 'b').status, 'skipped');
  await f.open();
  const dialog = await f.stage('c');
  assert.equal(await dialog.locator('#wf-stage-start').isEnabled(), true, 'the UI must not require every transitive ancestor when the server accepts this stage');
  const pending = f.page.waitForResponse(r => r.url() === `${f.base}/api/workflows/${f.workflow.id}/run` && r.request().method() === 'POST');
  await dialog.locator('#wf-stage-start').click();
  const response = await pending;
  assert.equal(response.status(), 202, await response.text());
  const runPayload = response.request().postDataJSON();
  assert.deepEqual(runPayload.execution, { mode: 'node', targetNodeId: 'c' }, 'the UI must not require every transitive ancestor when the server accepts this stage: it posts only the target node');
  assert.equal(runPayload.selectedStages, undefined, 'the UI must never build selectedStages itself');
  const result = await f.waitRun((await response.json()).id);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(result.nodeRuns.find(node => node.nodeId === 'c').output.trends.map(item => item.keyword), ['fixture-c']);
});

test('a storyboard without its connected script output stays strict for explicit API selectedStages but auto-includes the prerequisite in the UI', async t => {
  const f = await fixture(t, {
    name: 'Required script boundary',
    nodes: [
      { id: 'script', type: 'script', x: 50, y: 50, config: { agent: 'existing' } },
      { id: 'storyboard', type: 'storyboard', x: 350, y: 50, config: {} },
    ],
    edges: [{ id: 'script-storyboard', source: 'script', target: 'storyboard' }],
  });
  const response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', {
    episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: f.episode.version,
    selectedStages: ['storyboard'], startStage: 'storyboard',
  });
  assert.equal(response.status(), 409);
  assert.match((await response.json()).error, /script|prerequisite/i);
  await f.open();
  const dialog = await f.stage('storyboard');
  assert.equal(await dialog.locator('#wf-stage-start').isEnabled(), true, 'the UI auto-includes the missing script prerequisite rather than blocking the storyboard stage');
  assert.equal(await dialog.locator('#wf-stage-status').getAttribute('data-stage-state'), 'idle', 'the stage dialog no longer reports a blocked state for a missing-but-runnable prerequisite');
  const planPending = f.page.waitForResponse(r => r.url() === `${f.base}/api/workflows/${f.workflow.id}/plan` && r.request().method() === 'POST');
  const runPending = f.page.waitForResponse(r => r.url() === `${f.base}/api/workflows/${f.workflow.id}/run` && r.request().method() === 'POST');
  await dialog.locator('#wf-stage-start').click();
  const plan = await (await planPending).json();
  assert.equal(plan.blocked, false, 'the planner resolves the missing script prerequisite instead of blocking');
  assert.deepEqual(plan.selectedStages, ['script', 'storyboard'], 'the plan automatically includes the missing script prerequisite ahead of the requested storyboard target');
  const runResponse = await runPending;
  const runPayload = runResponse.request().postDataJSON();
  assert.deepEqual(runPayload.execution, { mode: 'node', targetNodeId: 'storyboard' }, 'the UI posts the target node only; the server plans the missing prerequisite, never a client-built selectedStages');
  assert.equal(runPayload.selectedStages, undefined, 'the UI must never post a client-built selectedStages array');
  assert.equal(runResponse.status(), 202, await runResponse.text());
  const result = await f.waitRun((await runResponse.json()).id);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(result.selectedStages, ['script', 'storyboard'], 'the completed run confirms the planner-added prerequisite actually ran, not just the requested target');
});
