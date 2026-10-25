// RED-first contract tests for the PW-05 publication seam (.mex/context/decisions.md
// "Publication implementation contract" + "Repeated-node implementation contract", and
// artifacts/production-workspace-implementation/plan.json "publication"/"engineAPI.publication").
// Exercises the frozen YouTubeOAuth and PublicationService surfaces from
// server/youtube-oauth.mjs and server/publication.mjs against an injectable fake Google HTTP
// transport (artifacts/production-workspace-implementation/protocols.json
// "VerifiedYouTubeProtocol"), plus the youtube-automation restriction on
// server/platform-session.mjs. No real network, credentials, or provider traffic; no live
// Google account/consent; no production HTTP routes (server/app.mjs is HttpContractTests'
// seam, not this file's). The exact status enums and method shapes below were confirmed by
// DeliveryImplementation (owner of all three files) before this suite was expanded past its
// smallest RED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { defaultWorkflow } from '../server/workflows.mjs';
import { PlatformSessionManager } from '../server/platform-session.mjs';
import { YouTubeOAuth } from '../server/youtube-oauth.mjs';
import { PublicationService } from '../server/publication.mjs';
import { candidateFingerprint } from '../server/graph.mjs';
import { requiredMediaCredits } from '../server/media-credits.mjs';
import { createHook } from 'node:async_hooks';
import { readFile, readdir } from 'node:fs/promises';

const FORCE_SSL_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const FIXTURE_OAUTH = { clientId: 'fixture-client-id.apps.googleusercontent.com', clientSecret: 'fixture-client-secret', redirectUri: 'https://workspace.fixture.invalid/oauth/youtube/callback' };

// ---------------------------------------------------------------------------------------
// Fixtures and helpers. The only mock boundary is the injected fetchImpl (fake Google HTTP
// transport) and the fake Playwright browserModule; everything else exercises real Store/
// YouTubeOAuth/PublicationService/PlatformSessionManager code against a temp SQLite store.
// ---------------------------------------------------------------------------------------

async function tempStore(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-publication-'));
  const store = new Store(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return store;
}

function boundChannel(store, overrides = {}) {
  return store.create('channels', { name: '확인해봄', category: 'information', platform: 'YouTube', sample: false, accountEmail: 'owner@fixture.invalid', externalId: `UC${'A'.repeat(22)}`, ...overrides });
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function jsonBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return JSON.parse(body);
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'));
  return body;
}

const codeChallenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');

/** Pushes every call to `calls`, replies with the next queued response (or a function that
 * receives the call and returns one), and throws loudly on any call past the configured
 * sequence so an unexpected real network attempt fails the test immediately. */
function sequentialFetch(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);
    if (index >= responses.length) throw new Error(`Unexpected outbound call #${calls.length}: ${options.method || 'GET'} ${url}`);
    const next = responses[index++];
    return typeof next === 'function' ? next(call) : next;
  };
  return { fetchImpl, calls };
}

function tokenResponseBody({ accessToken = 'fixture-access-token', refreshToken = 'fixture-refresh-token', expiresIn = 3600, scope = FORCE_SSL_SCOPE, refreshExpiresIn } = {}) {
  return { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, scope, ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}), ...(refreshExpiresIn !== undefined ? { refresh_token_expires_in: refreshExpiresIn } : {}) };
}

function channelsListBody(externalIds) {
  return { kind: 'youtube#channelListResponse', items: externalIds.map((id) => ({ id, snippet: { title: `Fixture channel ${id}` } })) };
}

/** Runs a full begin()->complete() cycle for a bound channel against a disposable fake
 * transport and returns a connected YouTubeOAuth sharing the given store. */
async function connectChannel(store, channel, { testing = false, tokenOverrides = {} } = {}) {
  const { fetchImpl } = sequentialFetch([() => Response.json(tokenResponseBody(tokenOverrides)), () => Response.json(channelsListBody([channel.externalId]))]);
  const oauth = new YouTubeOAuth({ store, fetchImpl, testing, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  const result = await oauth.complete({ state, code: 'fixture-auth-code', correlationToken }, { isSessionActive: async () => true });
  assert.equal(result.status, 'connected');
  assert.equal(result.connected, true);
  return { oauth, sessionId, correlationToken };
}

/** Builds a completed render + approved review candidate directly in the store (bypassing the
 * in-flight engine/store rewrite other agents own) so PublicationService can be exercised as a
 * standalone unit against the documented run.reviews[reviewNodeId] contract. */
async function renderCandidate(store, channel, scenes = [{ id: 'publication-fixture-card', title: 'Original fixture card', text: 'Fixture factual text', kind: 'title', layout: 'center', duration: 1, background: '#173940' }]) {
  const episode = store.create('episodes', { channelId: channel.id, title: 'AI 뉴스 속보 3건 요약 쇼츠', topic: '공개된 보도자료 세 건을 검증해 요약', category: 'information', status: 'draft', format: '9:16', version: 1, scenes, notes: '' });
  const bytes = Buffer.from(`Publication fixture render bytes ${randomUUID()}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const filename = `${randomUUID()}.mp4`;
  await writeFile(path.join(store.dataDir, 'exports', filename), bytes);
  const outputUrl = `/api/exports/${filename}`;
  const job = store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'completed', progress: 100, filename, outputUrl, sha256, sceneSnapshot: structuredClone(scenes) });
  const template = store.create('workflows', defaultWorkflow());
  const workflow = store.createWorkflowCopy({ templateId: template.id, channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const reviewNodeId = 'review';
  let run = store.create('workflowRuns', {
    workflowId: workflow.id, workflowVersion: workflow.version, episodeId: episode.id, episodeVersion: episode.version, status: 'awaiting_review',
    nodeRuns: [
      { nodeId: 'render', type: 'render', status: 'completed', output: { jobId: job.id, outputUrl, sha256, episodeVersion: episode.version, sceneSnapshot: structuredClone(scenes), generationNodeIds: [] } },
      { nodeId: reviewNodeId, type: 'review', status: 'awaiting_review', output: {} },
    ],
    reviews: {},
  });
  const review = { decision: 'approved', notes: '', reviewedAt: new Date().toISOString(), workflowId: workflow.id, workflowVersion: workflow.version, runId: run.id, episodeId: episode.id, episodeVersion: episode.version, jobId: job.id, outputUrl, sha256 };
  run = store.save('workflowRuns', { ...run, status: 'approved', reviews: { [reviewNodeId]: review }, nodeRuns: run.nodeRuns.map((node) => node.nodeId === reviewNodeId ? { ...node, status: 'approved', output: { review } } : node) });
  return { channel, episode, job, workflow, run, reviewNodeId, bytes, sha256, outputUrl };
}

function approveBody(candidate, overrides = {}) {
  return {
    workflowId: candidate.workflow.id, runId: candidate.run.id, reviewNodeId: candidate.reviewNodeId, expectedEpisodeVersion: candidate.episode.version,
    title: 'AI 뉴스 속보 3건 요약 쇼츠', description: '공개된 보도자료 세 건을 요약한 45초 쇼츠입니다. 원본 출처를 설명에 명시합니다.', categoryId: '25', tags: ['뉴스', 'AI'],
    selfDeclaredMadeForKids: false, containsSyntheticMedia: true, disclosureRationale: 'AI 음성 내레이션과 생성 자막을 사용했습니다.', rightsAcknowledged: true,
    ...overrides,
  };
}

async function waitForCondition(check, { attempts = 400, intervalMs = 10 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Condition not met in time');
}

function fakeBrowserModule() {
  const launches = [];
  const page = { url: () => 'https://studio.fixture.invalid/', goto: async () => {}, reload: async () => {}, viewportSize: () => ({ width: 1280, height: 800 }), locator: () => ({ first: () => ({ click: async () => {}, fill: async () => {}, count: async () => 1, setInputFiles: async () => {} }) }), keyboard: { press: async () => {} }, mouse: { wheel: async () => {} }, setDefaultTimeout: () => {} };
  const context = { pages: () => [page], newPage: async () => page, close: async () => {}, setDefaultTimeout: () => {} };
  const chromium = { launchPersistentContext: async (...args) => { launches.push(args); return context; } };
  return { module: { chromium }, launches };
}

function fixtureSession(store, channel, platform = 'youtube') {
  return store.create('platformSessions', { channelId: channel.id, channelName: channel.name, channelExternalId: channel.externalId, accountEmail: channel.accountEmail, episodeId: null, platform, url: platform === 'youtube' ? 'https://studio.youtube.com/channel/upload' : 'https://www.tiktok.com/tiktokstudio/upload', status: 'active', mode: 'persistent-chromium', browser: { available: false, headless: true, viewport: { width: 1280, height: 800 } }, screenshotUrl: '/api/platform-sessions/fixture/screenshot', attachmentStatus: 'none', uploadStatus: 'idle', uploadProgress: 0, attachedExport: null, publicationStatus: 'not_attempted', review: { required: false, approved: null, decision: null }, metadata: { title: 'Fixture', description: '', visibility: 'private' }, logs: [] });
}

// Observe real asynchronous filesystem work without replacing Store, validation, hashing,
// or service methods. The edit occurs after the final manifest snapshot, while its actual
// export check is suspended. Two export starts after private readback distinguish the
// pre-update check from the last beforeSend check.
for (const changed of ['episode', 'rights', 'channel']) test(`final async validation rejects an intervening ${changed} edit before PUBLIC transport`, async t => {
  const store = await tempStore(t), channel = boundChannel(store);
  const candidate = await creditedCandidate(store, channel), { oauth } = await connectChannel(store, channel);
  let armed = false, exportStarts = 0, edited = false;
  const transport = publishFlowFixture(candidate, channel, 'fixture-access-token');
  const hook = createHook({ init(_id, type) {
    if (!armed || type !== 'FSREQPROMISE') return;
    const stack = new Error().stack;
    if (!stack.includes('PublicationService._export') || !stack.includes('lstat')) return;
    if (++exportStarts !== 2) return;
    armed = false;
    queueMicrotask(() => {
      if (changed === 'episode') store.updateEpisode(candidate.episode.id, { title: 'Edited while checking final bytes' }, candidate.episode.version);
      if (changed === 'rights') {
        const rights = store.list('mediaRights')[0];
        store.save('mediaRights', { ...rights, attribution: 'Different rights during final validation' });
      }
      if (changed === 'channel') store.save('channels', { ...channel, externalId: `UC${'B'.repeat(22)}` });
      edited = true;
    });
  } });
  t.after(() => hook.disable());
  const service = new PublicationService({ store, oauth, fetchImpl: async (...args) => {
    const response = await transport.fetchImpl(...args);
    if (transport.calls.length === 3) { armed = true; hook.enable(); }
    return response;
  } });
  t.after(() => service.close());
  const approval = await service.approve(approveBody(candidate), { ownerId: 'owner-1' });
  await service.publish(approval.id, { ownerId: 'owner-1' });
  await waitForCondition(() => service.jobs.size === 0);
  hook.disable();
  assert.equal(edited, true, 'the edit must land inside the last real asynchronous export validation');
  assert.equal(exportStarts, 2, 'exercise the final beforeSend validation');
  const publicWrites = transport.calls.filter(c => c.url.pathname === '/youtube/v3/videos' && c.method === 'PUT');
  assert.equal(publicWrites.length, 0, 'an intervening approval-bound edit must prevent the public update');
  assert.notEqual(service.state(approval.id).status, 'completed');
});

for (const observed of ['private', 'public']) test(`known uncertain video reconciles ${observed} READONLY after an edit without false current completion`, async t => {
  const store = await tempStore(t), channel = boundChannel(store), candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel), calls = [];
  const videoId = 'fixture-known-uncertain', sessionUrl = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fixture-readonly';
  let updateAttempted = false, resumeOnly = false;
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(raw), method = options.method || 'GET'; calls.push({ url, method });
    if (resumeOnly) {
      assert.equal(method, 'GET', 'stale approval permits only readback, never insert, transfer or visibility update');
      assert.equal(url.pathname, '/youtube/v3/videos'); assert.equal(url.searchParams.get('id'), videoId);
    }
    if (method === 'POST') return new Response(null, { status: 200, headers: { location: sessionUrl } });
    if (url.href === sessionUrl) return Response.json({ id: videoId }, { status: 201 });
    if (method === 'PUT') { updateAttempted = true; throw new Error('fixture uncertain public update'); }
    if (updateAttempted && !resumeOnly) return new Response(null, { status: 503 });
    return Response.json({ items: [{ id: videoId, snippet: readbackSnippet(candidate), status: { privacyStatus: resumeOnly ? observed : 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: true }, processingDetails: { processingStatus: 'succeeded' } }] });
  };
  const first = new PublicationService({ store, oauth, fetchImpl }); t.after(() => first.close());
  const approval = await first.approve(approveBody(candidate), { ownerId: 'owner-1' });
  const intent = await first.publish(approval.id, { ownerId: 'owner-1' });
  await waitForCondition(() => first.jobs.size === 0);
  assert.equal(updateAttempted, true); assert.equal(first.state(approval.id).videoId, videoId);
  await first.close();
  store.updateEpisode(candidate.episode.id, { title: 'Current edited project' }, candidate.episode.version);
  resumeOnly = true; const before = calls.length;
  const restarted = new PublicationService({ store, oauth, fetchImpl }); t.after(() => restarted.close());
  await restarted.resume(intent.id, { ownerId: 'owner-1' });
  await waitForCondition(() => restarted.jobs.size === 0);
  assert.ok(calls.length > before, 'persisted remote identity must remain readable after local edits');
  assert.ok(calls.slice(before).every(c => c.method === 'GET'));
  const state = restarted.state(approval.id);
  assert.equal(state.videoId, videoId); assert.equal(state.privacyStatus, observed);
  assert.notEqual(state.status, 'completed', 'public evidence for the old manifest cannot complete the edited project');
  assert.match(JSON.stringify(state), /stale|changed|new.*approval|approval.*current/i, 'reconciliation must expose stale approval');
  assert.equal(store.get('episodes', candidate.episode.id).title, 'Current edited project');
});

test('two service instances retain both encrypted resumable identities before bytes and recover each without reinsertion', async t => {
  const store = await tempStore(t), channel = boundChannel(store), { oauth } = await connectChannel(store, channel);
  const candidates = await Promise.all([renderCandidate(store, channel), renderCandidate(store, channel)]);
  let release; const gate = new Promise(done => { release = done; });
  let arrivals = 0;
  const transfers = [], services = candidates.map((candidate, index) => new PublicationService({ store, oauth, fetchImpl: async (raw, options = {}) => {
    const url = new URL(raw);
    if (options.method === 'POST') {
      if (++arrivals === 2) release(); await gate;
      return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fixture-concurrent-${index}` } });
    }
    assert.equal(url.searchParams.get('upload_id'), `fixture-concurrent-${index}`);
    assert.equal(Buffer.compare(Buffer.from(options.body), candidate.bytes), 0);
    transfers.push(index); throw new Error('fixture interrupted after persisted identity');
  } }));
  t.after(() => Promise.all(services.map(service => service.close())));
  const approvals = await Promise.all(services.map((service, i) => service.approve(approveBody(candidates[i]), { ownerId: 'owner-1' })));
  const intents = await Promise.all(services.map((service, i) => service.publish(approvals[i].id, { ownerId: 'owner-1' })));
  await waitForCondition(() => services.every(service => service.jobs.size === 0));
  assert.deepEqual(transfers.sort(), [0, 1]); await Promise.all(services.map(service => service.close()));
  for (const file of await readdir(path.join(store.dataDir, '.private'))) {
    const bytes = await readFile(path.join(store.dataDir, '.private', file));
    assert.ok(!bytes.includes(Buffer.from('fixture-concurrent-')), 'opaque upload identity must remain encrypted');
  }
  const queries = [], restarts = candidates.map((candidate, index) => new PublicationService({ store, oauth, fetchImpl: async (raw, options = {}) => {
    const url = new URL(raw), method = options.method || 'GET';
    assert.notEqual(method, 'POST', 'lost identity must never trigger another insert');
    if (url.pathname === '/upload/youtube/v3/videos') {
      assert.equal(url.searchParams.get('upload_id'), `fixture-concurrent-${index}`);
      assert.equal(headerValue(options.headers, 'Content-Range'), `bytes */${candidate.bytes.length}`);
      assert.equal(Number(headerValue(options.headers, 'Content-Length')), 0);
      assert.equal(options.body, undefined); queries.push(index);
      return Response.json({ id: `fixture-concurrent-video-${index}` }, { status: 201 });
    }
    assert.equal(method, 'GET', 'completed public readback needs no mutation');
    return Response.json({ items: [{ id: `fixture-concurrent-video-${index}`, snippet: readbackSnippet(candidate), status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true }, processingDetails: { processingStatus: 'succeeded' } }] });
  } }));
  t.after(() => Promise.all(restarts.map(service => service.close())));
  await Promise.all(restarts.map((service, i) => service.resume(intents[i].id, { ownerId: 'owner-1' })));
  await waitForCondition(() => restarts.every(service => service.jobs.size === 0));
  assert.deepEqual(queries.sort(), [0, 1], 'both original session identities survive simultaneous service writes');
  for (const [i, service] of restarts.entries()) assert.equal(service.state(approvals[i].id).status, 'completed');
});

test('concurrent OAuth callbacks on separate instances consume one state before exactly one token exchange', async t => {
  const store = await tempStore(t), channel = boundChannel(store);
  let release, entered; const gate = new Promise(done => { release = done; }), exchangeEntered = new Promise(done => { entered = done; });
  const calls = [];
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(raw); calls.push({ path: url.pathname, method: options.method || 'GET' });
    if (url.origin === 'https://oauth2.googleapis.com') { entered(); await gate; return Response.json(tokenResponseBody()); }
    assert.equal(url.pathname, '/youtube/v3/channels'); return Response.json(channelsListBody([channel.externalId]));
  };
  const first = new YouTubeOAuth({ store, fetchImpl, ...FIXTURE_OAUTH }), second = new YouTubeOAuth({ store, fetchImpl, ...FIXTURE_OAUTH });
  const correlationToken = randomUUID(), sessionId = randomUUID();
  const { authUrl } = await first.begin(channel.id, { sessionId, correlationToken });
  const body = { state: new URL(authUrl).searchParams.get('state'), code: 'fixture-one-use-code', correlationToken };
  const winner = first.complete(body, { isSessionActive: async id => id === sessionId });
  await exchangeEntered;
  const loser = await second.complete(body, { isSessionActive: async id => id === sessionId });
  assert.equal(loser.status, 'invalid_state'); assert.equal(loser.connected, false);
  assert.equal(calls.filter(call => call.path === '/token').length, 1);
  release(); assert.equal((await winner).status, 'connected');
  assert.equal((await second.status(channel.id)).connected, true);
  assert.deepEqual(calls.map(call => call.path), ['/token', '/youtube/v3/channels']);
});

// =========================================================================================
// Group A — YouTubeOAuth.begin(): known-channel precondition and authUrl shape
// =========================================================================================

test('authorize rejects a channel with no known externalId before any outbound call', async (t) => {
  const store = await tempStore(t);
  const channel = store.list('channels')[0]; // seeded sample channel, externalId: ''
  const oauth = new YouTubeOAuth({ store, fetchImpl: async (url) => { throw new Error(`Unexpected outbound call: ${url}`); }, ...FIXTURE_OAUTH });
  await assert.rejects(oauth.begin(channel.id, { sessionId: randomUUID(), correlationToken: randomUUID() }), { status: 400 });
});

test('authorize rejects a malformed (non-UC-format) channel externalId before any outbound call', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store, { externalId: 'not-a-real-channel-id' });
  const oauth = new YouTubeOAuth({ store, fetchImpl: async (url) => { throw new Error(`Unexpected outbound call: ${url}`); }, ...FIXTURE_OAUTH });
  await assert.rejects(oauth.begin(channel.id, { sessionId: randomUUID(), correlationToken: randomUUID() }), { status: 400 });
});

test('begin() builds a Google authorization URL carrying the force-ssl scope, PKCE S256 challenge, offline access, and the exact registered redirect_uri', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const oauth = new YouTubeOAuth({ store, fetchImpl: async (url) => { throw new Error(`Unexpected outbound call: ${url}`); }, ...FIXTURE_OAUTH });
  const { authUrl } = await oauth.begin(channel.id, { sessionId: randomUUID(), correlationToken: randomUUID() });
  const parsed = new URL(authUrl);
  assert.equal(parsed.origin + parsed.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(parsed.searchParams.get('client_id'), FIXTURE_OAUTH.clientId);
  assert.equal(parsed.searchParams.get('redirect_uri'), FIXTURE_OAUTH.redirectUri);
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('scope'), FORCE_SSL_SCOPE);
  assert.equal(parsed.searchParams.get('access_type'), 'offline');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(parsed.searchParams.get('code_challenge'));
  assert.ok((parsed.searchParams.get('state') || '').length >= 16);
});

test('successive begin() calls produce unpredictable, distinct state values', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const oauth = new YouTubeOAuth({ store, fetchImpl: async () => { throw new Error('unexpected call'); }, ...FIXTURE_OAUTH });
  const first = await oauth.begin(channel.id, { sessionId: randomUUID(), correlationToken: randomUUID() });
  const second = await oauth.begin(channel.id, { sessionId: randomUUID(), correlationToken: randomUUID() });
  const stateA = new URL(first.authUrl).searchParams.get('state');
  const stateB = new URL(second.authUrl).searchParams.get('state');
  assert.notEqual(stateA, stateB);
});

// =========================================================================================
// Group B — YouTubeOAuth.complete(): exchange order, exact bodies, strict channel binding
// =========================================================================================

test('complete() exchanges the authorization code for tokens with the exact PKCE verifier, then verifies channel binding via channels.list — in that exact order', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  let capturedChallenge;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      assert.equal(String(url), 'https://oauth2.googleapis.com/token');
      assert.equal(options.method, 'POST');
      assert.match(headerValue(options.headers, 'Content-Type') || '', /application\/x-www-form-urlencoded/);
      const form = new URLSearchParams(options.body.toString());
      assert.equal(form.get('client_id'), FIXTURE_OAUTH.clientId);
      assert.equal(form.get('client_secret'), FIXTURE_OAUTH.clientSecret);
      assert.equal(form.get('code'), 'fixture-auth-code');
      assert.equal(form.get('redirect_uri'), FIXTURE_OAUTH.redirectUri);
      assert.equal(form.get('grant_type'), 'authorization_code');
      const verifier = form.get('code_verifier');
      assert.ok(verifier);
      assert.equal(codeChallenge(verifier), capturedChallenge);
      return Response.json(tokenResponseBody({}));
    }
    assert.equal(calls.length, 2);
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://www.googleapis.com/youtube/v3/channels');
    assert.equal(parsed.searchParams.get('mine'), 'true');
    assert.equal(headerValue(options.headers, 'Authorization'), 'Bearer fixture-access-token');
    return Response.json(channelsListBody([channel.externalId]));
  };
  const oauth = new YouTubeOAuth({ store, fetchImpl, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  capturedChallenge = new URL(authUrl).searchParams.get('code_challenge');
  const state = new URL(authUrl).searchParams.get('state');
  const result = await oauth.complete({ state, code: 'fixture-auth-code', correlationToken }, { isSessionActive: async () => true });
  assert.equal(result.status, 'connected');
  assert.equal(result.connected, true);
  assert.equal(calls.length, 2);
});

test('complete() rejects channel_mismatch and persists no connected state when channels.list never returns the known externalId (no first-item fallback)', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  let calls = 0;
  const fetchImpl = async () => { calls++; return calls === 1 ? Response.json(tokenResponseBody({})) : Response.json(channelsListBody([`UC${'Z'.repeat(22)}`])); };
  const oauth = new YouTubeOAuth({ store, fetchImpl, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  const result = await oauth.complete({ state, code: 'fixture-code', correlationToken }, { isSessionActive: async () => true });
  assert.equal(result.status, 'channel_mismatch');
  assert.equal(result.connected, false);
  assert.equal((await oauth.status(channel.id)).connected, false);
});

test('complete() matches the authorized channel by exact ID even when it is not the first item returned', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  let calls = 0;
  const fetchImpl = async () => { calls++; return calls === 1 ? Response.json(tokenResponseBody({})) : Response.json(channelsListBody([`UC${'Z'.repeat(22)}`, `UC${'Y'.repeat(22)}`, channel.externalId])); };
  const oauth = new YouTubeOAuth({ store, fetchImpl, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  const result = await oauth.complete({ state, code: 'fixture-code', correlationToken }, { isSessionActive: async () => true });
  assert.equal(result.status, 'connected');
});

test('complete() rejects insufficient_scope and persists no connected state when the granted scope omits youtube.force-ssl', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  let calls = 0;
  const fetchImpl = async () => { calls++; return calls === 1 ? Response.json(tokenResponseBody({ scope: 'https://www.googleapis.com/auth/youtube.readonly' })) : Response.json(channelsListBody([channel.externalId])); };
  const oauth = new YouTubeOAuth({ store, fetchImpl, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  const result = await oauth.complete({ state, code: 'fixture-code', correlationToken }, { isSessionActive: async () => true });
  assert.equal(result.status, 'insufficient_scope');
  assert.equal(result.connected, false);
  assert.equal((await oauth.status(channel.id)).connected, false);
});

// =========================================================================================
// Group C — state+PKCE+Lax correlation: initiating-session/TTL/denial/replay
// =========================================================================================

test('complete() returns a sanitized denied status for an explicit Google denial and never exchanges a code', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const oauth = new YouTubeOAuth({ store, fetchImpl: async (url) => { throw new Error(`Unexpected outbound call: ${url}`); }, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  const result = await oauth.complete({ state, error: 'access_denied', correlationToken }, { isSessionActive: async () => true });
  assert.equal(result.status, 'denied');
});

test('complete() rejects a correlation-cookie mismatch, an unknown state, and an inactive initiating session without ever exchanging a code', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const makeOauth = () => new YouTubeOAuth({ store, fetchImpl: async (url) => { throw new Error(`Unexpected outbound call: ${url}`); }, ...FIXTURE_OAUTH });
  {
    const oauth = makeOauth();
    const { authUrl } = await oauth.begin(channel.id, { sessionId: randomUUID(), correlationToken: 'correct-token' });
    const state = new URL(authUrl).searchParams.get('state');
    const result = await oauth.complete({ state, code: 'fixture-code', correlationToken: 'wrong-token' }, { isSessionActive: async () => true });
    assert.notEqual(result.status, 'connected');
  }
  {
    const oauth = makeOauth();
    const result = await oauth.complete({ state: 'never-issued-state-value', code: 'fixture-code', correlationToken: 'any-token' }, { isSessionActive: async () => true });
    assert.notEqual(result.status, 'connected');
  }
  {
    const oauth = makeOauth();
    const correlationToken = randomUUID();
    const { authUrl } = await oauth.begin(channel.id, { sessionId: randomUUID(), correlationToken });
    const state = new URL(authUrl).searchParams.get('state');
    const result = await oauth.complete({ state, code: 'fixture-code', correlationToken }, { isSessionActive: async () => false });
    assert.notEqual(result.status, 'connected');
  }
  assert.equal((await makeOauth().status(channel.id)).connected, false);
});

test('a state that has already been consumed (even by a denial) cannot be replayed on a second complete() call', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const oauth = new YouTubeOAuth({ store, fetchImpl: async (url) => { throw new Error(`Unexpected outbound call: ${url}`); }, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  const first = await oauth.complete({ state, error: 'access_denied', correlationToken }, { isSessionActive: async () => true });
  assert.equal(first.status, 'denied');
  const replay = await oauth.complete({ state, error: 'access_denied', correlationToken }, { isSessionActive: async () => true });
  assert.equal(replay.status, 'invalid_state');
});

test('an expired one-time state is rejected without any outbound call', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const oauth = new YouTubeOAuth({ store, fetchImpl: async (url) => { throw new Error(`Unexpected outbound call: ${url}`); }, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(601_000); // past the documented one-time state TTL (600s)
  const result = await oauth.complete({ state, code: 'fixture-code', correlationToken }, { isSessionActive: async () => true });
  assert.ok(['session_expired', 'invalid_state'].includes(result.status));
});

test('complete() throws (structurally malformed call, not a real Google outcome) when both state and error are entirely absent, and never calls out', async (t) => {
  const store = await tempStore(t);
  const oauth = new YouTubeOAuth({ store, fetchImpl: async (url) => { throw new Error(`Unexpected outbound call: ${url}`); }, ...FIXTURE_OAUTH });
  await assert.rejects(oauth.complete({ correlationToken: randomUUID() }, { isSessionActive: async () => true }), { status: 400 });
});

// =========================================================================================
// Group D — refresh omission/expiry/reconsent/Testing 7-day bound
// =========================================================================================

test('accessToken() transparently refreshes an expired token, returns the refreshed value, and a provider response omitting refresh_token retains and reuses the previously stored one', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body });
    if (calls.length === 1) return Response.json(tokenResponseBody({ accessToken: 'original-token', expiresIn: 3600 }));
    if (calls.length === 2) return Response.json(channelsListBody([channel.externalId]));
    return Response.json(tokenResponseBody({ accessToken: `refreshed-token-${calls.length}`, refreshToken: undefined, expiresIn: 3600 }));
  };
  const oauth = new YouTubeOAuth({ store, fetchImpl, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  await oauth.complete({ state, code: 'fixture-code', correlationToken }, { isSessionActive: async () => true });
  assert.equal(await oauth.accessToken(channel.id), 'original-token');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(3601_000);
  assert.equal(await oauth.accessToken(channel.id), 'refreshed-token-3');
  const firstRefreshBody = new URLSearchParams(calls[2].body.toString());
  const originalRefreshToken = firstRefreshBody.get('refresh_token');
  assert.equal(originalRefreshToken, 'fixture-refresh-token');
  t.mock.timers.tick(3601_000);
  await oauth.accessToken(channel.id);
  const secondRefreshBody = new URLSearchParams(calls[3].body.toString());
  assert.equal(secondRefreshBody.get('refresh_token'), originalRefreshToken, 'the originally issued refresh token must be retained across a response that omits it');
});

test('accessToken() rejects with status 409 when the refresh token has been revoked (invalid_grant), signalling reconsent is required', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return Response.json(tokenResponseBody({ expiresIn: 3600 }));
    if (calls === 2) return Response.json(channelsListBody([channel.externalId]));
    return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been revoked' }), { status: 400 });
  };
  const oauth = new YouTubeOAuth({ store, fetchImpl, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  await oauth.complete({ state, code: 'fixture-code', correlationToken }, { isSessionActive: async () => true });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(3601_000);
  await assert.rejects(oauth.accessToken(channel.id), { status: 409 });
  assert.equal((await oauth.status(channel.id)).connected, false);
});

test('Testing-mode caps effective refresh-token validity at seven days even when the provider omits refresh_token_expires_in, and blocks refresh locally once expired', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return Response.json(tokenResponseBody({ expiresIn: 3600 })); // omits refresh_token_expires_in
    if (calls === 2) return Response.json(channelsListBody([channel.externalId]));
    throw new Error('refresh must be blocked locally before any provider call once the Testing seven-day cap has passed');
  };
  const oauth = new YouTubeOAuth({ store, fetchImpl, testing: true, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  await oauth.complete({ state, code: 'fixture-code', correlationToken }, { isSessionActive: async () => true });
  const status = await oauth.status(channel.id);
  assert.equal(status.testingMode, true);
  assert.ok(status.refreshTokenExpiresAt);
  assert.ok(new Date(status.refreshTokenExpiresAt).getTime() - Date.now() <= 7 * 24 * 60 * 60 * 1000 + 1000);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(8 * 24 * 60 * 60 * 1000);
  await assert.rejects(oauth.accessToken(channel.id), { status: 409 });
});

// =========================================================================================
// Group E — tokens/codes/verifiers/sessionURLs never land in entity/event/state/export data
// =========================================================================================

test('no raw access token, refresh token, authorization code, or one-time state ever lands in entities (or the events recorded through them) after a full OAuth connect cycle', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const secretAccessToken = 'fixture-secret-access-token-xyz789';
  const secretRefreshToken = 'fixture-secret-refresh-token-abc123';
  const secretCode = 'fixture-secret-auth-code-qwe456';
  let calls = 0;
  const fetchImpl = async () => { calls++; return calls === 1 ? Response.json(tokenResponseBody({ accessToken: secretAccessToken, refreshToken: secretRefreshToken })) : Response.json(channelsListBody([channel.externalId])); };
  const oauth = new YouTubeOAuth({ store, fetchImpl, ...FIXTURE_OAUTH });
  const sessionId = randomUUID();
  const correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  await oauth.complete({ state, code: secretCode, correlationToken }, { isSessionActive: async () => true });
  const haystack = store.db.prepare('SELECT data FROM entities').all().map((row) => row.data).join('\n');
  for (const secret of [secretAccessToken, secretRefreshToken, secretCode, state]) assert.ok(!haystack.includes(secret), `secret leaked into entity/event rows: ${secret.slice(0, 8)}\u2026`);
  const status = await oauth.status(channel.id);
  assert.equal(status.connected, true);
  assert.ok(!JSON.stringify(status).includes(secretAccessToken));
  assert.ok(!JSON.stringify(status).includes(secretRefreshToken));
});

test('disconnect() clears locally stored tokens; a subsequent accessToken() rejects and status reports not connected', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const { oauth } = await connectChannel(store, channel);
  assert.equal((await oauth.status(channel.id)).connected, true);
  await oauth.disconnect(channel.id);
  assert.equal((await oauth.status(channel.id)).connected, false);
  await assert.rejects(oauth.accessToken(channel.id));
});

// =========================================================================================
// Group F — PublicationService.approve(): explicit final full manifest / rights / audience /
// disclosure binding to the exact connected review and render candidate
// =========================================================================================

test('approve() rejects an incomplete manifest for each missing required field and performs no network calls or persisted side effects', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls } = sequentialFetch([]);
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  for (const field of ['title', 'description', 'categoryId', 'selfDeclaredMadeForKids', 'containsSyntheticMedia', 'disclosureRationale', 'rightsAcknowledged']) {
    const body = approveBody(candidate);
    delete body[field];
    await assert.rejects(service.approve(body, { ownerId: 'owner-1' }), { status: 400 }, `missing ${field} must be rejected`);
  }
  await assert.rejects(service.approve({ ...approveBody(candidate), rightsAcknowledged: false }, { ownerId: 'owner-1' }), { status: 400 });
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.list(candidate.episode.id), []);
});

test('approve() requires a non-empty ownerId and never persists an approval without one', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls } = sequentialFetch([]);
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  await assert.rejects(service.approve(approveBody(candidate), {}), { status: 400 });
  await assert.rejects(service.approve(approveBody(candidate), { ownerId: '' }), { status: 400 });
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.list(candidate.episode.id), []);
});

test('approve() rejects an unknown workflowId, an unknown runId, a run that belongs to a different workflow, and an unknown reviewNodeId — all before any network call or persisted approval', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const otherWorkflow = store.create('workflows', defaultWorkflow());
  const { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls } = sequentialFetch([]);
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  await assert.rejects(service.approve(approveBody(candidate, { workflowId: randomUUID() }), { ownerId: 'owner-1' }), { status: 404 });
  await assert.rejects(service.approve(approveBody(candidate, { runId: randomUUID() }), { ownerId: 'owner-1' }), { status: 404 });
  await assert.rejects(service.approve(approveBody(candidate, { workflowId: otherWorkflow.id }), { ownerId: 'owner-1' }), { status: 404 });
  await assert.rejects(service.approve(approveBody(candidate, { reviewNodeId: 'no-such-review-node' }), { ownerId: 'owner-1' }), { status: 409 });
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.list(candidate.episode.id), []);
});

test('approve() rejects when the episode changed since this run was reviewed, when the bound review was not approved, or when the render artifact diverged from the approved review — all before any network call or persisted approval', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls } = sequentialFetch([]);
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  const stale = await renderCandidate(store, channel);
  store.updateEpisode(stale.episode.id, { title: 'Changed after review' }, stale.episode.version);
  await assert.rejects(service.approve(approveBody(stale), { ownerId: 'owner-1' }), { status: 409 });
  const unapproved = await renderCandidate(store, channel);
  const unapprovedRun = store.get('workflowRuns', unapproved.run.id);
  store.save('workflowRuns', { ...unapprovedRun, reviews: { ...unapprovedRun.reviews, [unapproved.reviewNodeId]: { ...unapprovedRun.reviews[unapproved.reviewNodeId], decision: 'changes_requested' } } });
  await assert.rejects(service.approve(approveBody(unapproved), { ownerId: 'owner-1' }), { status: 409 });
  const diverged = await renderCandidate(store, channel);
  const job = store.get('jobs', diverged.job.id);
  store.save('jobs', { ...job, sha256: 'f'.repeat(64) });
  await assert.rejects(service.approve(approveBody(diverged), { ownerId: 'owner-1' }), { status: 409 });
  assert.equal(calls.length, 0);
  for (const candidate of [stale, unapproved, diverged]) assert.deepEqual(await service.list(candidate.episode.id), []);
});

for (const damage of ['missing-job-snapshot', 'missing-run-snapshot', 'mismatched-snapshot']) {
  test(`approval rejects ${damage} instead of substituting the current saved episode`, async t => {
    const store = await tempStore(t), channel = boundChannel(store), candidate = await renderCandidate(store, channel);
    const { oauth } = await connectChannel(store, channel), { fetchImpl, calls } = sequentialFetch([]);
    const service = new PublicationService({ store, oauth, fetchImpl }); t.after(() => service.close());
    if (damage === 'missing-job-snapshot') { const job = { ...candidate.job }; delete job.sceneSnapshot; store.save('jobs', job); }
    else store.save('workflowRuns', { ...candidate.run, nodeRuns: candidate.run.nodeRuns.map(n => {
      if (n.nodeId !== 'render') return n;
      const output = structuredClone(n.output);
      if (damage === 'missing-run-snapshot') delete output.sceneSnapshot;
      else output.sceneSnapshot[0].text = 'Different unrendered scene';
      return { ...n, output };
    }) });
    await assert.rejects(service.approve(approveBody(candidate), { ownerId: 'owner-1' }), { status: 409 });
    assert.deepEqual(await service.list(candidate.episode.id), []);
    assert.deepEqual(calls, [], 'invalid provenance fails before transport');
  });
}

test('approve() succeeds with a complete manifest and the approval is retrievable for its episode with no network calls', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls } = sequentialFetch([]);
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  const approval = await service.approve(approveBody(candidate), { ownerId: 'owner-1' });
  assert.ok(approval.id);
  assert.equal(calls.length, 0);
  const listed = await service.list(candidate.episode.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, approval.id);
});

test('publish() and resume() reject a mismatched or missing ownerId with 403 and mutate no state; the rightful owner can still proceed afterward', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls, videoId } = publishFlowFixture(candidate, channel, 'fixture-access-token');
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  const approval = await service.approve(approveBody(candidate), { ownerId: 'admin' });
  await assert.rejects(service.publish(approval.id, { ownerId: 'someone-else' }), { status: 403 });
  await assert.rejects(service.publish(approval.id, {}), { status: 403 });
  assert.equal(calls.length, 0, 'a rejected cross-owner publish() must not touch the network');
  const intent = await service.publish(approval.id, { ownerId: 'admin' });
  await waitForCondition(async () => { const state = await service.state(approval.id); return state.status === 'completed' ? state : null; });
  await assert.rejects(service.resume(intent.id, { ownerId: 'someone-else' }), { status: 403 });
  const finalState = await service.state(approval.id);
  assert.equal(finalState.videoId, videoId);
  assert.equal(finalState.status, 'completed');
});

// =========================================================================================
// Group G — publish(): private resumable insert -> readback -> public update (preserving
// status) -> final readback, exact call order/bodies, no publishAt, no duplicate approval
// =========================================================================================


function readbackSnippet(candidate) {
  const body = approveBody(candidate);
  const credits = requiredMediaCredits(candidate.episode.scenes);
  return { channelId: candidate.channel.externalId, title: body.title, description: credits ? `${body.description}\n\n${credits}` : body.description, categoryId: body.categoryId, tags: body.tags };
}

async function creditedCandidate(store, channel) {
  const id = randomUUID(), filename = `${id}.png`;
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(store.dataDir, 'uploads', filename), bytes);
  const upload = store.save('uploads', { id, filename, name: 'Credit fixture', url: `/api/uploads/${filename}`, kind: 'image', type: 'image/png', size: bytes.length, width: 1, height: 1, sha256 });
  const source = { origin: 'third-party', sha256, attribution: 'Scene Photographer', licenseId: 'CC-BY-4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Scene.png', useAs: 'evidence', retrievedAt: '2026-01-01T00:00:00Z' };
  store.create('mediaRights', { uploadId: upload.id, ...source, acknowledgedAt: new Date().toISOString() });
  // Distinct scene and slot media ensure credits cannot accidentally read only scene.source.
  const slotId = randomUUID(), slotFilename = `${slotId}.png`;
  await writeFile(path.join(store.dataDir, 'uploads', slotFilename), bytes);
  const slotUpload = store.save('uploads', { ...upload, id: slotId, filename: slotFilename, url: `/api/uploads/${slotFilename}` });
  const slotSource = { ...source, attribution: 'Slot Illustrator', licenseId: 'CC-BY-SA-4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Slot.png', useAs: 'illustration' };
  store.create('mediaRights', { uploadId: slotUpload.id, ...slotSource, acknowledgedAt: new Date().toISOString() });
  return renderCandidate(store, channel, [{ id: 'scene-credit', title: 'Credited scene', text: 'Original news', kind: 'image', assetUrl: upload.url, source, duration: 1, layout: 'center', background: '#101010', trimStart: 0, audioVolume: 1, slots: [{ id: 'slot-credit', role: 'image-gen', x: 0, y: 0, w: 50, h: 50, zIndex: 1, assetUrl: slotUpload.url, source: slotSource }] }]);
}

test('final fingerprint and outbound snippet contain ALL scene and slot server credits', async t => {
  const store = await tempStore(t), channel = boundChannel(store);
  const candidate = await creditedCandidate(store, channel), { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls } = publishFlowFixture(candidate, channel, 'fixture-access-token');
  const service = new PublicationService({ store, oauth, fetchImpl }); t.after(() => service.close());
  const approval = await service.approve(approveBody(candidate), { ownerId: 'owner-1' });
  assert.ok(approval.manifest, 'preview returns complete server manifest');
  assert.equal(approval.fingerprint, candidateFingerprint(approval.manifest));
  const expected = requiredMediaCredits(candidate.episode.scenes);
  assert.equal(approval.manifest.credits, expected);
  const required = ['Scene Photographer', 'Slot Illustrator', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'https://commons.wikimedia.org/wiki/File:Scene.png', 'https://commons.wikimedia.org/wiki/File:Slot.png'];
  for (const value of required) assert.ok(approval.manifest.description.includes(value), `server manifest omitted ${value}`);
  const tampered = structuredClone(approval.manifest); tampered.description = tampered.description.replace('Slot Illustrator', 'Other Illustrator');
  assert.notEqual(candidateFingerprint(tampered), approval.fingerprint, 'fingerprint must bind appended credits');
  assert.equal(calls.length, 0, 'preview cannot contact Google');
  await service.publish(approval.id, { ownerId: 'owner-1' });
  await waitForCondition(async () => (await service.state(approval.id)).status === 'completed');
  const sent = jsonBody(calls[0].body).snippet.description;
  assert.equal(sent, approval.manifest.description, 'publish uses the exact server-previewed description');
  for (const value of required) assert.ok(sent.includes(value), `outbound snippet omitted ${value}`);
});

test('description that fits before credit append but exceeds the final provider limit is rejected prefetch', async t => {
  const store = await tempStore(t), channel = boundChannel(store);
  const candidate = await creditedCandidate(store, channel), { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls } = sequentialFetch([]);
  const service = new PublicationService({ store, oauth, fetchImpl }); t.after(() => service.close());
  const description = 'a'.repeat(4990);
  assert.ok(description.length < 5000 && description.length + requiredMediaCredits(candidate.episode.scenes).length > 5000);
  await assert.rejects(service.approve(approveBody(candidate, { description }), { ownerId: 'owner-1' }), { status: 400 });
  assert.equal(calls.length, 0); assert.deepEqual(await service.list(candidate.episode.id), []);
});

function publishFlowFixture(candidate, channel, accessToken) {
  const videoId = `fixture-video-${randomUUID().slice(0, 8)}`;
  const sessionUrl = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fixture-session-id';
  const calls = [];
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    calls.push({ url, method: options.method || 'GET', headers: options.headers, body: options.body });
    const step = calls.length;
    if (step === 1) {
      assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/upload/youtube/v3/videos');
      assert.equal(url.searchParams.get('uploadType'), 'resumable');
      assert.equal(url.searchParams.get('part'), 'snippet,status');
      assert.equal(options.method, 'POST');
      assert.equal(headerValue(options.headers, 'Authorization'), `Bearer ${accessToken}`);
      assert.equal(headerValue(options.headers, 'X-Upload-Content-Type'), 'video/mp4');
      assert.equal(Number(headerValue(options.headers, 'X-Upload-Content-Length')), candidate.bytes.length);
      const body = jsonBody(options.body);
      assert.equal(body.snippet.title, 'AI 뉴스 속보 3건 요약 쇼츠');
      assert.equal(body.snippet.categoryId, '25');
      assert.equal(body.status.privacyStatus, 'private');
      assert.equal(body.status.selfDeclaredMadeForKids, false);
      assert.equal(body.status.containsSyntheticMedia, true);
      assert.equal('publishAt' in body.status, false);
      return new Response(null, { status: 200, headers: { Location: sessionUrl } });
    }
    if (step === 2) {
      assert.equal(url.href, sessionUrl);
      assert.equal(options.method, 'PUT');
      assert.equal(Buffer.compare(Buffer.from(options.body), candidate.bytes), 0);
      return Response.json({ id: videoId, status: { privacyStatus: 'private', uploadStatus: 'uploaded' } }, { status: 201 });
    }
    if (step === 3) {
      assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/videos');
      assert.equal(url.searchParams.get('id'), videoId);
      assert.ok((options.method || 'GET') === 'GET');
      return Response.json({ items: [{ id: videoId, snippet: readbackSnippet(candidate), status: { privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: true, uploadStatus: 'processed' }, processingDetails: { processingStatus: 'succeeded' } }] });
    }
    if (step === 4) {
      assert.equal(options.method, 'PUT');
      assert.equal(url.searchParams.get('part'), 'status');
      const body = jsonBody(options.body);
      assert.equal(body.id, videoId);
      assert.equal(body.status.privacyStatus, 'public');
      assert.equal(body.status.selfDeclaredMadeForKids, false);
      assert.equal(body.status.containsSyntheticMedia, true);
      return Response.json({ id: videoId, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true } });
    }
    if (step === 5) {
      assert.equal(url.searchParams.get('id'), videoId);
      return Response.json({ items: [{ id: videoId, snippet: readbackSnippet(candidate), status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true }, processingDetails: { processingStatus: 'succeeded' } }] });
    }
    throw new Error(`Unexpected call #${step}: ${options.method || 'GET'} ${url.href}`);
  };
  return { fetchImpl, calls, videoId };
}

test('publish() drives private insert (no publishAt) -> byte transfer -> owner readback -> public update preserving status -> final public readback, in exact order', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls, videoId } = publishFlowFixture(candidate, channel, 'fixture-access-token');
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  const approval = await service.approve(approveBody(candidate), { ownerId: 'owner-1' });
  const intent = await service.publish(approval.id, { ownerId: 'owner-1' });
  assert.ok(intent.id);
  const finalState = await waitForCondition(async () => { const state = await service.state(approval.id); return state.status === 'completed' ? state : null; });
  assert.equal(calls.length, 5);
  assert.equal(finalState.videoId, videoId);
});

test('a second publish() call for an approval with an existing intent is rejected (409, use resume) and performs no additional network calls', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls } = publishFlowFixture(candidate, channel, 'fixture-access-token');
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  const approval = await service.approve(approveBody(candidate), { ownerId: 'owner-1' });
  await service.publish(approval.id, { ownerId: 'owner-1' });
  await waitForCondition(async () => { const state = await service.state(approval.id); return state.status === 'completed' ? state : null; });
  const callsAfterFirst = calls.length;
  await assert.rejects(service.publish(approval.id, { ownerId: 'owner-1' }), { status: 409 });
  assert.equal(calls.length, callsAfterFirst);
});

// =========================================================================================
// Group H — mismatch/stale/changed-source manifest fails before any side effects
// =========================================================================================

test('publish() rejects a stale manifest after the episode changed since approval, before any network call', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls } = sequentialFetch([]);
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  const approval = await service.approve(approveBody(candidate), { ownerId: 'owner-1' });
  store.updateEpisode(candidate.episode.id, { title: 'Changed after approval' }, candidate.episode.version);
  await assert.rejects(service.publish(approval.id, { ownerId: 'owner-1' }), { status: 409 });
  assert.equal(calls.length, 0);
});

test('publish() rejects when the approved render artifact hash changed since approval, before any network call', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls } = sequentialFetch([]);
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  const approval = await service.approve(approveBody(candidate), { ownerId: 'owner-1' });
  const job = store.get('jobs', candidate.job.id);
  store.save('jobs', { ...job, sha256: 'f'.repeat(64) });
  await assert.rejects(service.publish(approval.id, { ownerId: 'owner-1' }), { status: 409 });
  assert.equal(calls.length, 0);
});

// =========================================================================================
// Group I — provider private/audit restriction is explicit, never false published; uncertain
// transfer/public result reads back before reporting state; restart recovery never
// double-inserts
// =========================================================================================

test('a provider rejection on the private insert surfaces as an explicit blocked/restricted state, never completed or public, with exactly one insert attempt', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const calls = [];
  const fetchImpl = async (rawUrl, options = {}) => { calls.push({ url: String(rawUrl), method: options.method }); return new Response(JSON.stringify({ error: { code: 403, message: 'Unaudited API project' } }), { status: 403 }); };
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  const approval = await service.approve(approveBody(candidate), { ownerId: 'owner-1' });
  await service.publish(approval.id, { ownerId: 'owner-1' });
  const state = await waitForCondition(async () => { const s = await service.state(approval.id); return ['private_restricted', 'blocked', 'failed'].includes(s.status) ? s : null; });
  assert.notEqual(state.status, 'completed');
  assert.equal(calls.filter((call) => call.url.includes('uploadType=resumable')).length, 1);
});

test('an uncertain public-update transport failure reads back the video before reporting state, and a still-private readback reports a recoverable blocked state rather than false-public', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const videoId = 'fixture-video-uncertain';
  const sessionUrl = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fixture-uncertain-session';
  let updateAttempted = false;
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    if (url.pathname === '/upload/youtube/v3/videos' && options.method === 'POST') return new Response(null, { status: 200, headers: { Location: sessionUrl } });
    if (url.href === sessionUrl && options.method === 'PUT') return Response.json({ id: videoId, status: { privacyStatus: 'private' } }, { status: 201 });
    if (url.pathname === '/youtube/v3/videos' && (options.method || 'GET') === 'GET') return Response.json({ items: [{ id: videoId, snippet: readbackSnippet(candidate), status: { privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: true }, processingDetails: { processingStatus: 'succeeded' } }] });
    if (url.pathname === '/youtube/v3/videos' && options.method === 'PUT') { updateAttempted = true; throw new Error('simulated network reset during the public update'); }
    throw new Error(`Unexpected call: ${options.method || 'GET'} ${url.href}`);
  };
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());
  const approval = await service.approve(approveBody(candidate), { ownerId: 'owner-1' });
  await service.publish(approval.id, { ownerId: 'owner-1' });
  const state = await waitForCondition(async () => { const s = await service.state(approval.id); return ['blocked', 'private_restricted', 'unknown'].includes(s.status) ? s : null; });
  assert.ok(updateAttempted);
  assert.notEqual(state.status, 'completed');
  assert.ok(['blocked', 'private_restricted'].includes(state.status), 'a confirmed still-private readback must report a recoverable blocked state, not unknown');
});

for (const outcome of ['incomplete-308', 'completed-201', 'expired-404']) {
  test(`stale approval with SESSION-only identity performs read-only ${outcome} recovery and never inserts or sends remaining media`, async t => {
    const store = await tempStore(t), channel = boundChannel(store), candidate = await renderCandidate(store, channel);
    const { oauth } = await connectChannel(store, channel);
    const sessionUrl = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fixture-stale-session-only';
    const calls = []; let stale = false;
    const fetchImpl = async (raw, options = {}) => {
      const url = new URL(raw), method = options.method || 'GET'; calls.push({ url: url.href, method, body: options.body, headers: options.headers, stale });
      if (!stale) {
        if (method === 'POST' && url.pathname === '/upload/youtube/v3/videos') return new Response(null, { status: 200, headers: { location: sessionUrl } });
        if (method === 'PUT' && url.href === sessionUrl) throw new Error('Fixture connection lost before a video ID was returned');
        assert.fail(`Unexpected initial transport ${method} ${url.pathname}`);
      }
      if (url.href === sessionUrl) {
        assert.equal(method, 'PUT'); assert.equal(headerValue(options.headers, 'Content-Length'), '0');
        assert.equal(headerValue(options.headers, 'Content-Range'), `bytes */${candidate.bytes.length}`);
        assert.ok(options.body === undefined || options.body === null || options.body.byteLength === 0, 'status query carries no video bytes');
        if (outcome === 'incomplete-308') return new Response(null, { status: 308, headers: { range: 'bytes=0-3' } });
        if (outcome === 'expired-404') return new Response(null, { status: 404 });
        return Response.json({ id: 'fixture-completed-stale-session' }, { status: 201 });
      }
      assert.equal(method, 'GET', 'stale approval cannot insert, transfer media or change privacy');
      assert.equal(url.pathname, '/youtube/v3/videos'); assert.equal(url.searchParams.get('id'), 'fixture-completed-stale-session');
      return Response.json({ items: [{ id: 'fixture-completed-stale-session', snippet: readbackSnippet(candidate), status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true }, processingDetails: { processingStatus: 'succeeded' } }] });
    };
    const first = new PublicationService({ store, oauth, fetchImpl });
    const approval = await first.approve(approveBody(candidate), { ownerId: 'owner-1' });
    const intent = await first.publish(approval.id, { ownerId: 'owner-1' });
    await waitForCondition(async () => (await first.state(approval.id)).status === 'unknown');
    await first.close();
    assert.ok(!store.get('publicationIntents', intent.id).videoId, 'recovery starts with only a durable session identity');
    store.updateEpisode(candidate.episode.id, { title: 'Changed after the interrupted transfer' }, candidate.episode.version);
    stale = true;
    const restarted = new PublicationService({ store, oauth, fetchImpl }); t.after(() => restarted.close());
    await restarted.resume(intent.id, { ownerId: 'owner-1' });
    const final = await waitForCondition(async () => { const value = await restarted.state(approval.id); return value.approvalStatus === 'stale' && (outcome === 'completed-201' ? value.observedAt : value.providerStatus === (outcome === 'incomplete-308' ? 308 : 404)) ? value : null; });
    assert.equal(final.approvalStatus, 'stale'); assert.notEqual(final.status, 'completed');
    assert.equal(calls.filter(c => c.method === 'POST').length, 1, 'restart never creates another insert');
    const recovery = calls.filter(c => c.stale); assert.equal(recovery.filter(c => c.url === sessionUrl).length, 1);
    assert.equal(recovery.filter(c => c.method === 'GET').length, outcome === 'completed-201' ? 1 : 0);
    assert.equal(final.privacyStatus, outcome === 'completed-201' ? 'public' : 'unknown');
    assert.ok(!JSON.stringify(final).includes('fixture-stale-session-only'), 'opaque session URL stays private');
    assert.notEqual(store.get('episodes', candidate.episode.id).status, 'completed');
  });
}

test('resume() after a restart reconciles the saved resumable session with a fresh PublicationService instance, never re-inserting', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const candidate = await renderCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const videoId = 'fixture-video-restart';
  const sessionUrl = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fixture-restart-session';
  const calls = [];
  let transferFailedOnce = false;
  let madePublic = false;
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    calls.push({ url, method: options.method || 'GET' });
    if (url.pathname === '/upload/youtube/v3/videos' && options.method === 'POST') {
      const inserts = calls.filter((call) => call.method === 'POST' && call.url.pathname === '/upload/youtube/v3/videos').length;
      assert.equal(inserts, 1, 'resumable insert must never be repeated across a restart');
      return new Response(null, { status: 200, headers: { Location: sessionUrl } });
    }
    if (url.href === sessionUrl && options.method === 'PUT') {
      if (!transferFailedOnce) { transferFailedOnce = true; throw new Error('simulated crash mid-transfer'); }
      return Response.json({ id: videoId, status: { privacyStatus: 'private' } }, { status: 201 });
    }
    if (url.pathname === '/youtube/v3/videos' && (options.method || 'GET') === 'GET') return Response.json({ items: [{ id: videoId, snippet: readbackSnippet(candidate), status: { privacyStatus: madePublic ? 'public' : 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: true }, processingDetails: { processingStatus: 'succeeded' } }] });
    if (url.pathname === '/youtube/v3/videos' && options.method === 'PUT') { madePublic = true; return Response.json({ id: videoId, status: { privacyStatus: 'public' } }); }
    throw new Error(`Unexpected call: ${options.method || 'GET'} ${url.href}`);
  };
  const firstInstance = new PublicationService({ store, oauth, fetchImpl });
  const approval = await firstInstance.approve(approveBody(candidate), { ownerId: 'owner-1' });
  const intent = await firstInstance.publish(approval.id, { ownerId: 'owner-1' });
  await waitForCondition(async () => calls.some((call) => call.method === 'PUT' && call.url.href === sessionUrl) || null, { attempts: 100 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await firstInstance.close();
  const restarted = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => restarted.close());
  await restarted.resume(intent.id, { ownerId: 'owner-1' });
  const finalState = await waitForCondition(async () => { const state = await restarted.state(approval.id); return state.status === 'completed' ? state : null; });
  assert.equal(finalState.videoId, videoId);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.pathname === '/upload/youtube/v3/videos').length, 1);
});

// =========================================================================================
// Group J — YouTube automated platform-session actions disabled, manual link available,
// other platforms unaffected
// =========================================================================================

test('every automated interact() action on a YouTube platform session is rejected and never launches a browser', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const session = fixtureSession(store, channel, 'youtube');
  const { module, launches } = fakeBrowserModule();
  const manager = new PlatformSessionManager({ store, browserModule: module });
  t.after(() => manager.close());
  for (const action of ['navigate', 'input', 'click', 'key', 'scroll', 'attach-export', 'upload']) {
    await assert.rejects(manager.interact(session.id, { action, url: 'https://studio.youtube.com/', selector: 'input[type=file]', value: 'x', key: 'a' }), { status: 409 }, `action "${action}" must be rejected for YouTube`);
  }
  assert.equal(launches.length, 0);
});

test('opening a YouTube platform session still succeeds and exposes the manual external Studio upload link', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store);
  const { module } = fakeBrowserModule();
  const manager = new PlatformSessionManager({ store, browserModule: module });
  t.after(() => manager.close());
  const session = await manager.openSession({ channelId: channel.id, platform: 'youtube' });
  assert.equal(session.platform, 'youtube');
  assert.match(session.url, /^https:\/\/studio\.youtube\.com\//);
});

test('the YouTube automation restriction does not affect interact() actions on other platforms', async (t) => {
  const store = await tempStore(t);
  const channel = boundChannel(store, { platform: 'TikTok' });
  const session = fixtureSession(store, channel, 'tiktok');
  const { module, launches } = fakeBrowserModule();
  const manager = new PlatformSessionManager({ store, browserModule: module });
  t.after(() => manager.close());
  const result = await manager.interact(session.id, { action: 'navigate', url: 'https://www.tiktok.com/tiktokstudio/upload' });
  assert.equal(result.status, 'active');
  assert.ok(launches.length >= 1);
});
