import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';
import { renderEpisode } from '../server/render.mjs';
import { Store } from '../server/store.mjs';

const modulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();

function tone() {
  const rate = 48000, samples = rate, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return wav;
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'music-publication-ui-'));
  const providerCalls = [];
  const forbidden = async url => { providerCalls.push(String(url)); throw new Error('Unexpected provider request'); };
  let resolveRendered;
  const rendered = new Promise(resolve => { resolveRendered = resolve; });
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}), runAgent: forbidden, fetchTrends: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, submit: forbidden, status: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden },
    renderer: async (episode, options) => { try { return await renderEpisode(episode, options); } finally { resolveRendered(); } },
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
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.deepEqual(providerCalls, [], 'local preparation never contacts an external provider');
    assert.deepEqual(external, [], 'browser never contacts an external origin');
    assert.deepEqual(errors, [], 'no uncaught browser errors');
    assert.equal(writes.some(item => /\/publish$|\/resume$/.test(item.path)), false, 'preview never publishes or resumes');
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const bytes = tone(), uploadResponse = await context.request.post(`${base}/api/uploads?name=fixture.wav`, { headers: { origin: base }, data: bytes });
  assert.equal(uploadResponse.status(), 201);
  const upload = await uploadResponse.json(), sha256 = createHash('sha256').update(bytes).digest('hex');
  const source = { origin: 'third-party', sha256, sourceUrl: 'https://example.invalid/music', licenseId: 'CC-BY-4.0', attribution: 'Fixture Composer' };
  await api(`/api/uploads/${upload.id}/rights`, 'POST', source);
  let channel = await api('/api/channels', 'POST', { name: 'Music fixture', category: 'information', platform: 'YouTube' });
  channel = await api(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: `UC${'A'.repeat(22)}`, expectedUpdatedAt: channel.updatedAt });
  let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Music publication fixture', topic: 'Local test' });
  episode = await api(`/api/episodes/${episode.id}`, 'PUT', { expectedVersion: episode.version, format: '1:1', scenes: [{ ...episode.scenes[0], kind: 'title', title: 'Fixture', text: 'Original card', duration: 1, background: '#173940', layout: 'center' }], music: { assetUrl: upload.url, start: 0, trimStart: 0, volume: 0.5, source } });
  const types = ['script', 'storyboard', 'render', 'review'];
  const template = await api('/api/workflows', 'POST', { name: 'Music fixture', nodes: types.map((type, i) => ({ id: type, type, x: i * 200, y: 0, config: type === 'script' ? { agent: 'existing' } : {} })), edges: types.slice(1).map((target, i) => ({ id: `e${i}`, source: types[i], target })) });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const started = await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, expectedEpisodeVersion: episode.version, expectedWorkflowVersion: workflow.version, selectedStages: types });
  await rendered;
  let run;
  for (let turn = 0; turn < 2000; turn++) {
    run = await api(`/api/workflow-runs/${started.id}`);
    if (['awaiting_review', 'failed', 'cancelled'].includes(run.status)) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(run.status, 'awaiting_review', JSON.stringify(run));
  const output = run.nodeRuns.find(node => node.nodeId === 'render').output;
  assert.deepEqual(output.verifiedMusicIntegrity, { sha256, size: bytes.length });
  await api(`/api/workflows/${workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId: 'review', decision: 'approved', notes: 'Reviewed exact local render', expectedEpisodeVersion: run.episodeVersion });
  await page.goto(base); await page.locator('#app .shell').waitFor();
  const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click();
  await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
  await page.locator('#workflow-canvas').waitFor();
  await page.locator('.wf-node-header[data-id=review]').click();
  await page.locator('[data-action=project-tools]').click();
  await page.getByRole('menuitem', { name: '검토 · 공개', exact: true }).click();
  const delivery = page.locator('#project-tool-dialog[open] [data-production-tools][data-mode=delivery]');
  await delivery.waitFor();
  return { dataDir, page, base, api, delivery, channel, episode, workflow, run, output, upload, source, writes };
}

async function prepareForm(f) {
  const form = f.delivery.locator('#pt-approval-form');
  const submit = form.getByRole('button', { name: '게시 준비 · 미리보기', exact: true });
  assert.equal(await submit.isEnabled(), true, 'music with an exact reviewed candidate must not be blanket-disabled');
  await form.locator('[name=title]').fill('Fixture approved title');
  await form.locator('[name=description]').fill('Fixture final description');
  await form.locator('[name=categoryId]').selectOption('25');
  await form.locator('[name=selfDeclaredMadeForKids][value=false]').check();
  await form.locator('[name=containsSyntheticMedia][value=false]').check();
  await form.getByLabel('공개 범위 결정 근거', { exact: false }).fill('Fixture music and visuals are not synthetically generated');
  await form.locator('[name=rightsAcknowledged]').check();
  return submit;
}

async function submitPreview(f, submit) {
  const pending = f.page.waitForResponse(response => response.url() === `${f.base}/api/publication/approvals` && response.request().method() === 'POST');
  await submit.click();
  const response = await pending;
  const request = response.request().postDataJSON();
  assert.equal(request.workflowId, f.workflow.id);
  assert.equal(request.runId, f.run.id);
  assert.equal(request.reviewNodeId, 'review');
  assert.equal(request.expectedEpisodeVersion, f.run.episodeVersion);
  return response;
}

test('reviewed music candidate reaches server preview without approving or publishing', { timeout: 180000 }, async t => {
  const f = await fixture(t), submit = await prepareForm(f);
  const response = await submitPreview(f, submit);
  assert.equal(response.status(), 201, await response.text());
  const approval = await response.json();
  assert.equal(approval.manifest.render.jobId, f.output.jobId);
  assert.equal(approval.manifest.render.sha256, f.output.sha256);
  assert.equal(approval.manifest.reviewNodeId, 'review');
  for (const part of [f.source.attribution, f.source.licenseId, f.source.sourceUrl]) assert.ok(approval.manifest.credits.includes(part));
  const preview = f.delivery.getByRole('region', { name: '서버 게시 미리보기' });
  await preview.waitFor();
  assert.ok((await preview.innerText()).includes(approval.fingerprint));
  assert.ok((await preview.innerText()).includes(f.source.attribution));
  assert.equal(await preview.getByRole('button', { name: '최종 승인하고 공개', exact: true }).isEnabled(), true, 'owner approval remains a separate explicit action');
});

for (const scenario of ['changed music bytes', 'withdrawn rights', 'missing renderer receipt']) {
  test(`server rejects ${scenario} and the UI exposes the rejection without provider calls`, { timeout: 180000 }, async t => {
    const f = await fixture(t), submit = await prepareForm(f);
    if (scenario === 'changed music bytes') {
      await writeFile(join(f.dataDir, 'uploads', basename(f.upload.url)), Buffer.from('changed after review'));
    } else {
      // Modify only this disposable fixture after the UI has loaded, simulating stale server-side evidence.
      const store = new Store(f.dataDir);
      try {
        if (scenario === 'withdrawn rights') {
          const right = store.list('mediaRights').find(item => item.uploadId === f.upload.id);
          assert.ok(right);
          store.save('mediaRights', { ...right, acknowledgedAt: '' });
        } else {
          const job = store.get('jobs', f.output.jobId);
          delete job.verifiedMusicIntegrity;
          store.save('jobs', job);
        }
      } finally { store.close(); }
    }
    const response = await submitPreview(f, submit);
    assert.equal(response.status(), 409, await response.text());
    const body = await response.json();
    assert.ok(body.error, 'server supplies an actionable rejection');
    const error = f.page.getByRole('alert').filter({ hasText: body.error });
    await error.waitFor();
    assert.equal(await f.delivery.getByRole('region', { name: '서버 게시 미리보기' }).count(), 0);
    assert.equal(await f.delivery.getByRole('button', { name: '최종 승인하고 공개', exact: true }).count(), 0);
  });
}
