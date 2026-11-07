import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';

const modulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();

async function waitForSignal(signal, name) {
  let timer;
  try {
    await Promise.race([signal, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 10000); })]);
  } finally { clearTimeout(timer); }
}

function wav(frequency) {
  const rate = 8000, bytes = Buffer.alloc(44 + rate * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(rate * 2, 40);
  for (let i = 0; i < rate; i++) bytes.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  return bytes;
}

async function fixture(t, { transport = 'api' } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-music-generation-ui-'));
  const forbidden = async () => { assert.fail('External service is forbidden in this fixture'); };
  const outputs = [330, 660].map((frequency, i) => ({ url: `https://images.higgs.ai/fixture-${i}.wav`, type: 'audio', bytes: wav(frequency) }));
  let creates = 0, release, signalCreated;
  const gate = new Promise(resolve => { release = resolve; });
  const created = new Promise(resolve => { signalCreated = resolve; });
  const schema = { id: 'music-fixture', name: 'Fixture music', type: 'audio', parameters: [{ name: 'prompt', type: 'string', required: true }, { name: 'duration', type: 'integer', minimum: 1, maximum: 30 }] };
  const generation = {
    transport, capability: async () => ({ available: true, authenticated: true }),
    models: async () => [schema], modelSchema: async () => schema,
    estimate: async () => { if (transport === 'cli') throw new Error('unverified fixture quote'); return { credits: 2.82 }; },
    create: async () => { creates++; signalCreated(); return { requestId: 'provider-fixture', transport, status: 'queued', outputs: [] }; },
    status: async () => { await gate; return { requestId: 'provider-fixture', transport, status: 'completed', outputs: outputs.map(({ url, type }) => ({ url, type })) }; },
  };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '', generation,
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), runAgent: forbidden, fetchTrends: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
    generationOptions: { pollIntervalMs: 1, download: async (url, filename) => {
      const item = outputs.find(output => output.url === url); assert.ok(item, 'only fixture audio may be downloaded');
      await writeFile(filename, item.bytes, { flag: 'wx' }); return { bytes: item.bytes.length, contentType: 'audio/wav' };
    } },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const external = [], errors = [], writes = [], releases = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
    return route.continue();
  });
  t.after(async () => {
    for (const unblock of releases) unblock();
    release(); await context.close(); await browser.close();
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.deepEqual(external, [], 'browser cannot contact external providers'); assert.deepEqual(errors, [], 'editor has no uncaught errors');
  });
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`); return response.json();
  };
  const channel = await api('/api/channels', 'POST', { name: 'Generation fixture', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Generation project', topic: 'Fixture music' });
  const other = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Other generation project', topic: 'Separate music' });
  const template = await api('/api/workflows', 'POST', { name: 'Generation graph', nodes: [{ id: 'a', type: 'trend', label: 'A', x: 40, y: 50, config: {} }], edges: [] });
  await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: other.id, expectedTemplateVersion: template.version });
  await page.goto(base); await page.locator('#app .shell').waitFor();
  const channelButton = page.locator(`[data-action=channel][data-id="${channel.id}"]`), group = channelButton.locator('xpath=ancestor::details[1]');
  if (!await group.evaluate(element => element.open)) await group.locator('summary').click();
  await channelButton.click(); await page.locator(`[data-action=episode][data-id="${episode.id}"]`).click();
  await page.locator('[data-action=open-scene-editor]').first().click();
  const dialog = page.locator('#project-scene-dialog[open]'); await dialog.waitFor();
  return { page, context, dialog, api, base, dataDir, episode, other, writes, release, releases, created, creates: () => creates };
}

async function quote(f) {
  await f.dialog.getByRole('button', { name: '음악 생성 열기', exact: true }).click();
  const schemaLoaded = f.page.waitForResponse(r => r.url().includes('/api/generation/models') && r.url().includes('model='));
  await f.dialog.getByLabel('음악 생성 모델', { exact: true }).selectOption('music-fixture');
  await schemaLoaded;
  await f.dialog.getByLabel('음악 생성 프롬프트', { exact: true }).fill('Calm instrumental fixture');
  await f.dialog.getByLabel('duration', { exact: true }).fill('12');
  const pending = f.page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${f.episode.id}/generations/quote` && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '음악 생성 견적', exact: true }).click();
  const response = await pending; assert.equal(response.status(), 200, await response.text());
  const result = await response.json();
  assert.equal(result.credits, 2.82);
  assert.match(await f.dialog.innerText(), /2\.82/);
  assert.equal(f.creates(), 0, 'a quote alone cannot submit a paid job');
  return result;
}

async function submit(f, result) {
  const pending = f.page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${f.episode.id}/generations` && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '견적 승인 및 생성', exact: true }).click();
  const response = await pending; assert.equal(response.status(), 202, await response.text());
  const body = response.request().postDataJSON();
  assert.equal(body.target, 'music'); assert.equal(body.expectedVersion, f.episode.version);
  assert.equal(body.model, 'music-fixture'); assert.equal(body.prompt, 'Calm instrumental fixture'); assert.equal(body.params.duration, 12);
  assert.equal(body.quoteId, result.id); assert.equal(body.quoteFingerprint, result.fingerprint); assert.equal(body.acceptedCredits, result.credits);
  await waitForSignal(f.created, 'provider creation');
  return response.json();
}

test('canceling a quoted request never submits a paid generation', async t => {
  const f = await fixture(t);
  await quote(f);
  await f.dialog.getByRole('button', { name: '생성 취소', exact: true }).click();
  assert.equal(f.creates(), 0);
  assert.equal(f.writes.some(write => write.path === `/api/episodes/${f.episode.id}/generations`), false);
  assert.deepEqual((await f.api('/api/state')).episodes.find(item => item.id === f.episode.id), f.episode);
});

test('editing the prompt after a quote invalidates spending approval', async t => {
  const f = await fixture(t);
  await quote(f);
  await f.dialog.getByLabel('음악 생성 프롬프트', { exact: true }).fill('Different instrumental');
  const approval = f.dialog.getByRole('button', { name: '견적 승인 및 생성', exact: true });
  assert.ok(await approval.count() === 0 || await approval.isDisabled(), 'changed input requires a fresh quote');
  assert.equal(f.creates(), 0);
  assert.equal(f.writes.some(write => write.path === `/api/episodes/${f.episode.id}/generations`), false);
});

test('approved music survives reload and applies only the selected, rights-cleared result', async t => {
  const f = await fixture(t), estimate = await quote(f), job = await submit(f, estimate);
  assert.equal(f.creates(), 1);
  await f.page.reload(); await f.page.locator('[data-action=open-scene-editor]').first().click();
  await f.dialog.waitFor();
  assert.equal(f.creates(), 1, 'reconnecting cannot buy a second generation');
  const completed = f.page.waitForResponse(async r => r.url() === `${f.base}/api/generations/${job.id}` && r.request().method() === 'GET' && (await r.json()).status === 'completed');
  f.release();
  await completed;
  const persisted = await f.api(`/api/generations/${job.id}`);
  assert.equal(persisted.outputs.length, 2);
  const selected = persisted.outputs[1];
  await f.dialog.getByLabel('생성 결과 2', { exact: true }).check();
  assert.equal(await f.dialog.getByRole('button', { name: '선택한 음악 적용', exact: true }).isDisabled(), true);
  assert.equal(f.writes.some(write => write.path === `/api/generations/${job.id}/apply`), false, 'selection is not rights approval');
  await f.dialog.getByLabel('생성 음악 이용 권리 확인', { exact: true }).check();
  const applied = f.page.waitForResponse(r => r.url() === `${f.base}/api/generations/${job.id}/apply` && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '선택한 음악 적용', exact: true }).click();
  const response = await applied; assert.equal(response.status(), 200, await response.text());
  assert.equal(response.request().postDataJSON().outputUploadId, selected.uploadId);
  const updated = (await response.json()).episode;
  assert.equal(updated.music.assetUrl, selected.url); assert.deepEqual(updated.scenes, f.episode.scenes);
  assert.equal(f.creates(), 1);
});

test('a concurrent episode edit cannot be overwritten when generated music is applied', async t => {
  const f = await fixture(t), estimate = await quote(f), job = await submit(f, estimate);
  const completed = f.page.waitForResponse(async r => r.url() === `${f.base}/api/generations/${job.id}` && r.request().method() === 'GET' && (await r.json()).status === 'completed');
  f.release(); await completed;
  const persisted = await f.api(`/api/generations/${job.id}`), selected = persisted.outputs[1];
  await f.dialog.getByLabel('생성 결과 2', { exact: true }).check();
  await f.dialog.getByLabel('생성 음악 이용 권리 확인', { exact: true }).check();
  const concurrent = await f.api(`/api/episodes/${f.episode.id}`, 'PUT', { ...f.episode, title: 'Concurrent edit', expectedVersion: f.episode.version });
  const rightsBefore = await f.api(`/api/uploads/${selected.uploadId}/rights`);
  const pending = f.page.waitForResponse(r => r.url() === `${f.base}/api/uploads/${selected.uploadId}/rights` && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '선택한 음악 적용', exact: true }).click();
  const response = await pending;
  assert.equal(response.status(), 409, await response.text());
  assert.deepEqual(response.request().postDataJSON(), { origin: 'generated', generationJobId: job.id });
  assert.match((await response.json()).error, /Episode changed since music generation/);
  assert.deepEqual(await f.api(`/api/uploads/${selected.uploadId}/rights`), rightsBefore, 'stale music cannot create rights clearance');
  assert.equal(f.writes.some(write => write.path === `/api/generations/${job.id}/apply`), false, 'the rejected rights decision must not reach application');
  assert.deepEqual((await f.api('/api/state')).episodes.find(item => item.id === f.episode.id), concurrent);
  assert.equal(f.creates(), 1);
});

test('a definite pre-claim conflict permits a fresh quote without paying for the rejected request', async t => {
  const f = await fixture(t), estimate = await quote(f);
  const endpoint = `${f.base}/api/episodes/${f.episode.id}/generations`;
  await f.page.route(endpoint, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Quote rejected before submission' }) }), { times: 1 });
  const rejected = f.page.waitForResponse(r => r.url() === endpoint && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '견적 승인 및 생성', exact: true }).click();
  assert.equal((await rejected).status(), 409);
  await f.dialog.locator('[aria-label="음악 생성"]').getByRole('alert').filter({ hasText: '다른 작업에서 에피소드가 수정되었습니다' }).waitFor();
  assert.equal(f.creates(), 0);
  const pending = f.page.waitForResponse(r => r.url() === `${endpoint}/quote` && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '음악 생성 견적', exact: true }).click();
  const fresh = await pending; assert.equal(fresh.status(), 200, await fresh.text());
  const next = await fresh.json(); assert.notEqual(next.id, estimate.id);
  await submit(f, next);
  assert.equal(f.creates(), 1);
});

test('a submission in flight cannot be presented as canceled or submitted twice', async t => {
  const f = await fixture(t); await quote(f);
  const endpoint = `${f.base}/api/episodes/${f.episode.id}/generations`;
  let arrived, releasePost;
  const received = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { releasePost = resolve; });
  f.releases.push(releasePost);
  await f.page.route(endpoint, async route => { arrived(); await gate; await route.continue(); }, { times: 1 });
  const response = f.page.waitForResponse(r => r.url() === endpoint && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '견적 승인 및 생성', exact: true }).click();
  await waitForSignal(received, 'submission request');
  const cancel = f.dialog.getByRole('button', { name: '생성 취소', exact: true });
  assert.ok(await cancel.count() === 0 || await cancel.isDisabled(), 'in-flight submission cannot be canceled as if no charge occurred');
  const approval = f.dialog.getByRole('button', { name: '견적 승인 및 생성', exact: true });
  assert.ok(await approval.count() === 0 || await approval.isDisabled(), 'submission cannot be repeated while the receipt is pending');
  releasePost(); assert.equal((await response).status(), 202);
  await waitForSignal(f.created, 'provider creation'); assert.equal(f.creates(), 1);
});

test('an apply receipt arriving after the editor closes is reflected on reopening', async t => {
  const f = await fixture(t), estimate = await quote(f), job = await submit(f, estimate);
  const completed = f.page.waitForResponse(async r => r.url() === `${f.base}/api/generations/${job.id}` && r.request().method() === 'GET' && (await r.json()).status === 'completed');
  f.release(); await completed;
  const selected = (await f.api(`/api/generations/${job.id}`)).outputs[1];
  await f.dialog.getByLabel('생성 결과 2', { exact: true }).check();
  await f.dialog.getByLabel('생성 음악 이용 권리 확인', { exact: true }).check();
  let arrived, releaseReceipt;
  const committed = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { releaseReceipt = resolve; });
  f.releases.push(releaseReceipt);
  const endpoint = `${f.base}/api/generations/${job.id}/apply`;
  await f.page.route(endpoint, async route => {
    const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response });
  }, { times: 1 });
  const pending = f.page.waitForResponse(r => r.url() === endpoint && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '선택한 음악 적용', exact: true }).click();
  await waitForSignal(committed, 'apply commit');
  await f.dialog.locator('[data-action=close-scene-editor]').click();
  releaseReceipt(); assert.equal((await pending).status(), 200);
  await f.page.locator('[data-action=open-scene-editor]').first().click();
  await f.dialog.waitFor();
  assert.equal(await f.dialog.getByLabel('음악 파일', { exact: true }).inputValue(), selected.url);
  assert.equal((await f.api('/api/state')).episodes.find(item => item.id === f.episode.id).music.assetUrl, selected.url);
  assert.equal(f.creates(), 1);
});

test('a cached job does not clear uncertain submission before authoritative status is known', async t => {
  const f = await fixture(t); await quote(f);
  const endpoint = `${f.base}/api/episodes/${f.episode.id}/generations`;
  await f.page.route(endpoint, async route => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
  await f.dialog.getByRole('button', { name: '견적 승인 및 생성', exact: true }).click();
  await waitForSignal(f.created, 'provider creation');
  const state = await f.api('/api/state');
  const job = state.generationJobs.find(item => item.episodeId === f.episode.id && item.target === 'music');
  assert.ok(job, 'server received the submission despite the lost response');
  let arrived, releaseStatus;
  const requested = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { releaseStatus = resolve; });
  f.releases.push(releaseStatus);
  await f.page.route(`${f.base}/api/generations/${job.id}`, async route => {
    arrived(); await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...job, status: 'submission_unknown', providerRequestId: undefined }) });
  });
  await f.page.reload(); await f.page.locator('[data-action=open-scene-editor]').first().click();
  await f.dialog.waitFor(); await waitForSignal(requested, 'authoritative job status');
  const open = f.dialog.getByRole('button', { name: '음악 생성 열기', exact: true });
  if (await open.count()) await open.click();
  const quoteButton = f.dialog.getByRole('button', { name: '음악 생성 견적', exact: true });
  assert.equal(await quoteButton.isDisabled(), true, 'cached job is not an authoritative receipt');
  releaseStatus();
  await f.dialog.getByRole('status').filter({ hasText: 'submission_unknown' }).waitFor();
  assert.equal(await quoteButton.isDisabled(), true, 'unknown submission cannot be bought again');
  assert.equal(f.creates(), 1);
});

test('a delayed status response for an older job cannot replace the newer job', async t => {
  const f = await fixture(t), estimate = await quote(f);
  let arrived, releaseOld;
  const requested = new Promise(resolve => { arrived = resolve; });
  const gate = new Promise(resolve => { releaseOld = resolve; });
  f.releases.push(releaseOld);
  let polls = 0;
  await f.page.route(/\/api\/generations\/[^/]+$/, async route => {
    polls++;
    if (polls === 1) return route.continue();
    const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response });
  }, { times: 2 });
  const first = await submit(f, estimate); await waitForSignal(requested, 'delayed older job status');
  await f.dialog.getByRole('button', { name: '음악 생성 열기', exact: true }).click();
  const quoteResponse = f.page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${f.episode.id}/generations/quote` && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '음악 생성 견적', exact: true }).click();
  const nextQuote = await quoteResponse; assert.equal(nextQuote.status(), 200, await nextQuote.text());
  const second = await submit(f, await nextQuote.json());
  assert.notEqual(second.id, first.id);
  await f.dialog.getByRole('status').filter({ hasText: second.id }).waitFor();
  const oldResponse = f.page.waitForResponse(r => r.url() === `${f.base}/api/generations/${first.id}` && r.request().method() === 'GET');
  releaseOld(); await oldResponse;
  await f.dialog.getByRole('status').filter({ hasText: second.id }).waitFor();
  assert.equal(await f.dialog.getByRole('status').filter({ hasText: first.id }).count(), 0);
  assert.equal(f.creates(), 2);
});

test('CLI transport with an unverified price cannot authorize a paid generation', async t => {
  const f = await fixture(t, { transport: 'cli' });
  await f.dialog.getByRole('button', { name: '음악 생성 열기', exact: true }).click();
  await f.dialog.getByLabel('음악 생성 연결', { exact: true }).selectOption('cli');
  await f.dialog.getByLabel('음악 생성 모델', { exact: true }).selectOption('music-fixture');
  await f.dialog.getByLabel('음악 생성 프롬프트', { exact: true }).fill('Calm instrumental fixture');
  await f.dialog.getByLabel('duration', { exact: true }).fill('12');
  const pending = f.page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${f.episode.id}/generations/quote` && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '음악 생성 견적', exact: true }).click();
  const response = await pending;
  assert.equal(response.request().postDataJSON().transport, 'cli');
  assert.ok(response.status() >= 400, 'a failed CLI estimate must not produce an approvable quote');
  assert.equal(await f.dialog.getByRole('button', { name: '견적 승인 및 생성', exact: true }).count(), 0);
  assert.equal(f.creates(), 0);
});

test('a malformed successful submission receipt stays blocked until authoritative reconciliation', async t => {
  const f = await fixture(t); await quote(f);
  const endpoint = `${f.base}/api/episodes/${f.episode.id}/generations`;
  await f.page.route(endpoint, async route => { await route.fetch(); await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }, { times: 1 });
  let releaseStatus;
  const gate = new Promise(resolve => { releaseStatus = resolve; }); f.releases.push(releaseStatus);
  await f.page.route(/\/api\/generations\/[^/]+$/, async route => { await gate; await route.continue(); });
  const receipt = f.page.waitForResponse(r => r.url() === endpoint && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '견적 승인 및 생성', exact: true }).click();
  assert.equal((await receipt).status(), 200);
  await waitForSignal(f.created, 'provider creation');
  await f.dialog.getByRole('alert').filter({ hasText: '제출 결과를 확인하지 못했습니다. 중복 제출 전에 작업 상태를 확인하세요.' }).waitFor();
  const open = f.dialog.getByRole('button', { name: '음악 생성 열기', exact: true });
  if (await open.count()) await open.click();
  assert.equal(await f.dialog.getByRole('button', { name: '음악 생성 견적', exact: true }).isDisabled(), true);
  assert.equal(f.creates(), 1, 'a malformed receipt cannot authorize a second purchase');
  releaseStatus();
});

test('an active job created in another tab blocks buying while its status is unresolved', async t => {
  const f = await fixture(t);
  const root = `/api/episodes/${f.episode.id}/generations`;
  const input = { requestId: 'other-tab-request', expectedVersion: f.episode.version, target: 'music', model: 'music-fixture', prompt: 'Other tab', params: { duration: 12 } };
  const q = await f.api(`${root}/quote`, 'POST', input);
  const job = await f.api(root, 'POST', { ...input, quoteId: q.id, quoteFingerprint: q.fingerprint, acceptedCredits: q.credits });
  await waitForSignal(f.created, 'provider creation');
  let arrive, releaseStatus;
  const requested = new Promise(resolve => { arrive = resolve; });
  const gate = new Promise(resolve => { releaseStatus = resolve; }); f.releases.push(releaseStatus);
  await f.page.route(`${f.base}/api/generations/${job.id}`, async route => { arrive(); await gate; await route.continue(); });
  await f.page.reload(); await f.page.locator('[data-action=open-scene-editor]').first().click();
  await f.dialog.waitFor(); await waitForSignal(requested, 'other tab job status');
  await f.dialog.getByRole('button', { name: '음악 생성 열기', exact: true }).click();
  assert.equal(await f.dialog.getByRole('button', { name: '음악 생성 견적', exact: true }).isDisabled(), true);
  assert.equal(f.creates(), 1);
  releaseStatus();
});

test('a quote that completes after closing and reopening the editor cannot be approved', async t => {
  const f = await fixture(t);
  await f.dialog.getByRole('button', { name: '음악 생성 열기', exact: true }).click();
  await f.dialog.getByLabel('음악 생성 모델', { exact: true }).selectOption('music-fixture');
  await f.dialog.getByLabel('음악 생성 프롬프트', { exact: true }).fill('Calm instrumental fixture');
  await f.dialog.getByLabel('duration', { exact: true }).fill('12');
  const endpoint = `${f.base}/api/episodes/${f.episode.id}/generations/quote`;
  let arrive, releaseQuote;
  const requested = new Promise(resolve => { arrive = resolve; });
  const gate = new Promise(resolve => { releaseQuote = resolve; }); f.releases.push(releaseQuote);
  await f.page.route(endpoint, async route => { const response = await route.fetch(); arrive(); await gate; await route.fulfill({ response }); }, { times: 1 });
  const response = f.page.waitForResponse(r => r.url() === endpoint && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '음악 생성 견적', exact: true }).click(); await waitForSignal(requested, 'quote request');
  await f.dialog.locator('[data-action=close-scene-editor]').click();
  await f.page.locator('[data-action=open-scene-editor]').first().click(); await f.dialog.waitFor();
  releaseQuote(); assert.equal((await response).status(), 200);
  assert.equal(await f.dialog.getByRole('button', { name: '견적 승인 및 생성', exact: true }).count(), 0);
  assert.equal(f.creates(), 0);
});

test('an applied result is reconciled for its original episode after changing projects', async t => {
  const f = await fixture(t), estimate = await quote(f), job = await submit(f, estimate);
  const completed = f.page.waitForResponse(async r => r.url() === `${f.base}/api/generations/${job.id}` && r.request().method() === 'GET' && (await r.json()).status === 'completed');
  f.release(); await completed;
  const selected = (await f.api(`/api/generations/${job.id}`)).outputs[1];
  await f.dialog.getByLabel('생성 결과 2', { exact: true }).check();
  await f.dialog.getByLabel('생성 음악 이용 권리 확인', { exact: true }).check();
  const endpoint = `${f.base}/api/generations/${job.id}/apply`;
  let arrive, releaseReceipt;
  const committed = new Promise(resolve => { arrive = resolve; });
  const gate = new Promise(resolve => { releaseReceipt = resolve; }); f.releases.push(releaseReceipt);
  await f.page.route(endpoint, async route => { const response = await route.fetch(); arrive(); await gate; await route.fulfill({ response }); }, { times: 1 });
  const response = f.page.waitForResponse(r => r.url() === endpoint && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '선택한 음악 적용', exact: true }).click(); await waitForSignal(committed, 'apply commit');
  await f.dialog.locator('[data-action=close-scene-editor]').click();
  await f.page.locator(`[data-action=episode][data-id="${f.other.id}"]`).click();
  releaseReceipt(); assert.equal((await response).status(), 200);
  await f.page.locator(`[data-action=episode][data-id="${f.episode.id}"]`).click();
  await f.page.locator('[data-action=open-scene-editor]').first().click(); await f.dialog.waitFor();
  assert.equal(await f.dialog.getByLabel('음악 파일', { exact: true }).inputValue(), selected.url);
  assert.deepEqual((await f.api('/api/state')).episodes.find(item => item.id === f.other.id), f.other);
});

test('a lost apply response reconciles the committed music without reapplying it', async t => {
  const f = await fixture(t), estimate = await quote(f), job = await submit(f, estimate);
  const completed = f.page.waitForResponse(async r => r.url() === `${f.base}/api/generations/${job.id}` && r.request().method() === 'GET' && (await r.json()).status === 'completed');
  f.release(); await completed;
  const selected = (await f.api(`/api/generations/${job.id}`)).outputs[1];
  await f.dialog.getByLabel('생성 결과 2', { exact: true }).check();
  await f.dialog.getByLabel('생성 음악 이용 권리 확인', { exact: true }).check();
  const endpoint = `${f.base}/api/generations/${job.id}/apply`;
  let arrive; const committed = new Promise(resolve => { arrive = resolve; });
  await f.page.route(endpoint, async route => { await route.fetch(); await route.abort('failed'); arrive(); }, { times: 1 });
  await f.dialog.getByRole('button', { name: '선택한 음악 적용', exact: true }).click(); await waitForSignal(committed, 'apply commit');
  await f.dialog.getByLabel('음악 파일', { exact: true }).waitFor();
  await f.page.waitForFunction(expected => document.querySelector('#project-scene-dialog [aria-label="음악 파일"]')?.value === expected, selected.url);
  const saved = (await f.api('/api/state')).episodes.find(item => item.id === f.episode.id);
  assert.equal(saved.music.assetUrl, selected.url); assert.equal(saved.version, f.episode.version + 1);
  assert.equal(f.creates(), 1);
});

test('canceling an in-flight quote cannot surface its late approval', async t => {
  const f = await fixture(t);
  await f.dialog.getByRole('button', { name: '음악 생성 열기', exact: true }).click();
  await f.dialog.getByLabel('음악 생성 모델', { exact: true }).selectOption('music-fixture');
  await f.dialog.getByLabel('음악 생성 프롬프트', { exact: true }).fill('Calm instrumental fixture');
  await f.dialog.getByLabel('duration', { exact: true }).fill('12');
  const endpoint = `${f.base}/api/episodes/${f.episode.id}/generations/quote`;
  let arrive, releaseQuote;
  const requested = new Promise(resolve => { arrive = resolve; });
  const gate = new Promise(resolve => { releaseQuote = resolve; }); f.releases.push(releaseQuote);
  await f.page.route(endpoint, async route => { const response = await route.fetch(); arrive(); await gate; await route.fulfill({ response }); }, { times: 1 });
  const response = f.page.waitForResponse(r => r.url() === endpoint && r.request().method() === 'POST');
  await f.dialog.getByRole('button', { name: '음악 생성 견적', exact: true }).click(); await waitForSignal(requested, 'quote request');
  await f.dialog.getByRole('button', { name: '생성 취소', exact: true }).click();
  releaseQuote(); assert.equal((await response).status(), 200);
  assert.equal(await f.dialog.getByRole('button', { name: '견적 승인 및 생성', exact: true }).count(), 0);
  assert.equal(f.creates(), 0);
});

test('archived generated music cannot create rights clearance or apply to the project', async t => {
  const f = await fixture(t), store = new Store(f.dataDir);
  let job, upload;
  try {
    job = store.create('generationJobs', { episodeId: f.episode.id, episodeVersion: f.episode.version, target: 'music', mediaKind: 'audio', status: 'completed', applied: false, outputs: [], requestId: 'archived-music-fixture', transport: 'api', model: 'music-fixture', prompt: 'fixture', params: {}, providerRequestId: 'fixture-provider' });
    const id = randomUUID(), filename = `${id}.wav`, bytes = wav(330);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(f.dataDir, 'uploads', filename), bytes);
    upload = { id, filename, url: `/api/uploads/${filename}`, name: 'fixture.wav', type: 'audio/wav', kind: 'audio', size: bytes.length, sha256, generationJobId: job.id, createdAt: new Date().toISOString() };
    store.save('uploads', upload);
    job = store.save('generationJobs', { ...job, outputs: [{ uploadId: id, url: upload.url, type: upload.type, kind: upload.kind, size: upload.size, sha256 }] });
  } finally { store.close(); }
  const archived = await f.api(`/api/episodes/${f.episode.id}/archive`, 'POST', { expectedVersion: f.episode.version });
  assert.equal(archived.status, 'archived');
  await f.page.reload(); await f.page.locator('#app .shell').waitFor();
  await f.page.locator('[data-action=project-tools]').click();
  await f.page.locator('.ff-context-menu[role=menu]').getByRole('menuitem', { name: '보관된 프로젝트', exact: true }).click();
  await f.page.locator('#project-tool-dialog[open]').waitFor();
  await f.page.locator(`[data-action=inspect-archived][data-id="${f.episode.id}"]`).click();
  await f.page.locator('#project-navigation').getByText(f.episode.title, { exact: true }).waitFor();
  const loaded = f.page.waitForResponse(r => r.url() === `${f.base}/api/generations/${job.id}` && r.request().method() === 'GET');
  await f.page.locator('[data-action=open-scene-editor]').first().click();
  assert.equal((await loaded).status(), 200);
  const output = f.dialog.getByLabel('생성 결과 1', { exact: true });
  const consent = f.dialog.getByLabel('생성 음악 이용 권리 확인', { exact: true });
  await output.waitFor();
  const before = await f.api(`/api/uploads/${upload.id}/rights`);
  assert.deepEqual(before, [], 'fixture starts without rights clearance');
  if (await output.isEnabled() && await consent.isEnabled()) {
    await output.check(); await consent.check();
    const apply = f.dialog.getByRole('button', { name: '선택한 음악 적용', exact: true });
    if (await apply.isEnabled()) {
      await apply.click();
      await f.dialog.getByRole('alert').filter({ hasText: /보관/ }).waitFor();
    }
  }
  assert.deepEqual(await f.api(`/api/uploads/${upload.id}/rights`), before, 'archive must prevent rights clearance');
  assert.equal(f.writes.some(write => write.path === `/api/uploads/${upload.id}/rights`), false);
  assert.equal(f.writes.some(write => write.path === `/api/generations/${job.id}/apply`), false);
  assert.deepEqual((await f.api('/api/state')).episodes.find(episode => episode.id === f.episode.id), archived);
  assert.equal(f.creates(), 0, 'fixture never calls the generation provider');
});
