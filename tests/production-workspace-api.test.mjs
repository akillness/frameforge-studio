import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

// HTTP-contract coverage for the production-workspace seams Main owns in server/app.mjs
// (PW-01..PW-07, .mex/context/decisions.md). Every dependency is a fixture/local adapter;
// no real Commons/YouTube/provider network traffic is ever exercised here.

const integrations = {
  integrationStatus: async () => ({ studio: { available: true }, codex: { available: false } }),
  runAgent: async () => { throw Object.assign(new Error('no bridge'), { code: 'UNAVAILABLE' }); },
  fetchTrends: async () => ({ trends: [{ keyword: 'verified fixture', source: 'Test source', url: 'https://example.com/research' }], sources: [{ name: 'fixture', status: 'ok' }] }),
};

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-pw-api-'));
  const server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir,
    request: (path, method = 'GET', body, headers = {}) => fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    raw: (path, requestOptions) => fetch(base + path, requestOptions),
  };
}

async function createChannel(f, overrides = {}) {
  const response = await f.request('/api/channels', 'POST', { name: 'Fixture channel', category: 'information', platform: 'YouTube', ...overrides });
  assert.equal(response.status, 201, 'fixture channel setup must succeed via the real API');
  return response.json();
}

async function createEpisode(f, channelId, overrides = {}) {
  const response = await f.request('/api/episodes', 'POST', { channelId, title: 'Fixture episode', topic: 'Fixture topic', ...overrides });
  assert.equal(response.status, 201, 'fixture episode setup must succeed via the real API');
  return response.json();
}

function classicWorkflowBody(name) {
  const types = ['trend', 'research', 'script', 'storyboard', 'render', 'review'];
  const nodes = types.map((type, index) => ({ id: type, type, x: 80 + index * 260, y: 180, config: type === 'script' ? { agent: 'studio', prompt: 'Fixture prompt' } : {} }));
  return { name, nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index + 1}`, source: nodes[index].id, target: node.id })) };
}

async function createTemplateWorkflow(f, name = '\uacf5\uc720 \uc81c\uc791 \ud15c\ud50c\ub9bf \u00b7 \ud14c\uc2a4\ud2b8 \uace0\uc815\uac12') {
  const response = await f.request('/api/workflows', 'POST', classicWorkflowBody(name));
  assert.equal(response.status, 201, 'fixture shared workflow template setup must succeed via the real API');
  return response.json();
}

// --- First executed behavioral RED: POST /api/workflows/:templateId/copies does not exist yet. ---
test('copying a shared workflow template creates a fresh project-owned workflow while the template is unchanged', async (t) => {
  const f = await fixture(t);
  const channel = await createChannel(f, { name: '\ud655\uc778\ud574\ubd10 \u00b7 Test channel A' });
  const episode = await createEpisode(f, channel.id, { title: 'AI \ub274\uc2a4 \u00b7 Episode A' });
  const template = await createTemplateWorkflow(f);

  const copyResponse = await f.request(`/api/workflows/${template.id}/copies`, 'POST', {
    channelId: channel.id,
    episodeId: episode.id,
    expectedTemplateVersion: template.version,
  });
  assert.equal(copyResponse.status, 201, 'POST /api/workflows/:templateId/copies must accept a valid template/channel/episode and return the fresh owned workflow');
  const copy = await copyResponse.json();

  assert.notEqual(copy.id, template.id, 'the copy must receive a fresh workflow identity, not reuse the template id');
  assert.equal(copy.version, 1, 'a fresh copy starts at version 1 regardless of the template version');
  assert.equal(copy.templateId, template.id, 'the copy must retain its source template identity');
  assert.equal(copy.templateVersion, template.version, 'the copy must retain the source template version it was copied from');
  assert.equal(copy.channelId, channel.id, 'the copy must be bound to the requesting channel');
  assert.equal(copy.episodeId, episode.id, 'the copy must be bound to the requesting episode');
  assert.deepEqual(copy.nodes.map((node) => node.id).sort(), template.nodes.map((node) => node.id).sort(), 'node identities are preserved within the new workflow identity');
  assert.equal(copy.edges.length, template.edges.length, 'the graph shape is copied from the template');

  const reread = await (await f.request('/api/workflows')).json();
  const originalAfter = reread.find((workflow) => workflow.id === template.id);
  assert.ok(originalAfter, 'the original template workflow must still exist after being copied');
  assert.equal(originalAfter.version, template.version, 'copying a template must not bump the template version');
  assert.equal(originalAfter.channelId, undefined, 'the shared template must never acquire project ownership fields');
  assert.equal(originalAfter.episodeId, undefined, 'the shared template must never acquire project ownership fields');
});

test('a conflicting templateId in the request body can never override the URL path template', async (t) => {
  const f = await fixture(t);
  const channel = await createChannel(f);
  const episode = await createEpisode(f, channel.id);
  const urlTemplate = await createTemplateWorkflow(f, 'URL-path source template · must win');
  const bodyTemplate = await createTemplateWorkflow(f, 'Body-claimed source template · must never win');
  assert.equal(urlTemplate.version, bodyTemplate.version, 'fixture sanity: both candidate templates start at the same version so a version check cannot mask identity drift');

  const response = await f.request(`/api/workflows/${urlTemplate.id}/copies`, 'POST', {
    templateId: bodyTemplate.id,
    channelId: channel.id,
    episodeId: episode.id,
    expectedTemplateVersion: urlTemplate.version,
  });

  if (response.status === 400) return; // explicit rejection of a conflicting body.templateId is an acceptable contract
  assert.equal(response.status, 201, 'a non-rejecting response to a conflicting body.templateId must still be the normal successful copy, not some other failure');
  const copy = await response.json();
  assert.equal(copy.templateId, urlTemplate.id, 'the URL path templateId must be the source of truth; a body.templateId must never override it');
  assert.notEqual(copy.templateId, bodyTemplate.id, 'the request body must never be able to redirect which template is actually copied');
  assert.equal(copy.name, urlTemplate.name, 'the copied graph content must trace to the URL template, not whatever templateId the body claims');
});

test('copy rejects a channel/episode ownership mismatch and does not create a workflow', async (t) => {
  const f = await fixture(t);
  const channelA = await createChannel(f, { name: 'Owner channel A' });
  const channelB = await createChannel(f, { name: 'Owner channel B' });
  const episodeOnA = await createEpisode(f, channelA.id, { title: 'Episode bound to A' });
  const template = await createTemplateWorkflow(f);
  const before = await (await f.request('/api/workflows')).json();

  const mismatched = await f.request(`/api/workflows/${template.id}/copies`, 'POST', {
    channelId: channelB.id,
    episodeId: episodeOnA.id,
    expectedTemplateVersion: template.version,
  });
  assert.equal(mismatched.status, 400, 'a channelId that does not own the supplied episodeId must be rejected');

  const after = await (await f.request('/api/workflows')).json();
  assert.equal(after.length, before.length, 'a rejected ownership mismatch must not create a workflow');
});

test('copy rejects a stale expectedTemplateVersion and does not create a workflow', async (t) => {
  const f = await fixture(t);
  const channel = await createChannel(f);
  const episode = await createEpisode(f, channel.id);
  const template = await createTemplateWorkflow(f);
  const before = await (await f.request('/api/workflows')).json();

  const stale = await f.request(`/api/workflows/${template.id}/copies`, 'POST', {
    channelId: channel.id,
    episodeId: episode.id,
    expectedTemplateVersion: template.version + 1,
  });
  assert.equal(stale.status, 409, 'a stale expectedTemplateVersion must be rejected as a version conflict');

  const after = await (await f.request('/api/workflows')).json();
  assert.equal(after.length, before.length, 'a rejected stale-version copy must not create a workflow');
});

test('copy rejects an unknown templateId without creating a workflow', async (t) => {
  const f = await fixture(t);
  const channel = await createChannel(f);
  const episode = await createEpisode(f, channel.id);
  const before = await (await f.request('/api/workflows')).json();

  const unknown = await f.request('/api/workflows/does-not-exist/copies', 'POST', {
    channelId: channel.id,
    episodeId: episode.id,
    expectedTemplateVersion: 1,
  });
  assert.equal(unknown.status, 404, 'copying from an unknown templateId must fail, not fabricate a workflow');

  const after = await (await f.request('/api/workflows')).json();
  assert.equal(after.length, before.length, 'an unknown-template copy attempt must not create a workflow');
});

test('GET on the copies collection performs no write and never creates a workflow', async (t) => {
  const f = await fixture(t);
  const channel = await createChannel(f);
  const episode = await createEpisode(f, channel.id);
  const template = await createTemplateWorkflow(f);
  const before = await (await f.request('/api/workflows')).json();

  const getResponse = await f.request(`/api/workflows/${template.id}/copies?channelId=${channel.id}&episodeId=${episode.id}`);
  assert.ok(!getResponse.ok, 'GET must never perform the mutating copy action');
  assert.notEqual(getResponse.status, 201, 'GET must never return the write-success status of the copy action');

  const after = await (await f.request('/api/workflows')).json();
  assert.equal(after.length, before.length, 'GET on the copies route must create no workflow as a side effect');
});

test('copy requires an authenticated admin session like every other workflow write', async (t) => {
  const f = await fixture(t, { loginToken: 'copies-route-auth-fixture-token' });
  const unauthenticated = await f.request('/api/workflows/anything/copies', 'POST', { channelId: 'x', episodeId: 'y', expectedTemplateVersion: 1 });
  assert.equal(unauthenticated.status, 401, 'copying a template without a session must be rejected before any route logic runs');
});

// --- Mandatory reviewNodeId on POST /api/workflows/:id/runs/:runId/review ---

function fastRenderer(filenamePrefix = 'pw-review-fixture') {
  let count = 0;
  return async (episode, { dataDir: runDir, sceneIntegrity }) => {
    count += 1;
    const filename = `${filenamePrefix}-${count}.mp4`;
    const bytes = Buffer.from('fixture render bytes, not a real MP4');
    await writeFile(join(runDir, 'exports', filename), bytes);
    return { filename, outputUrl: `/api/exports/${filename}`, sha256: createHash('sha256').update(bytes).digest('hex'), ...(sceneIntegrity !== undefined ? { verifiedSceneAssets: sceneIntegrity } : {}) };
  };
}

async function driveRunToReview(f) {
  const state = await (await f.request('/api/state')).json();
  const episode = await createEpisode(f, state.channels[0].id, { title: 'Review-bound episode' });
  const workflow = await ownedWorkflow(f, state.workflows[0], episode);
  const startResponse = await f.request(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id });
  assert.equal(startResponse.status, 202, await startResponse.clone().text());
  const started = await startResponse.json();
  let run;
  for (let attempt = 0; attempt < 100; attempt++) {
    const runs = await (await f.request(`/api/workflows/${workflow.id}/runs`)).json();
    run = runs.find((item) => item.id === started.id);
    if (['awaiting_review', 'failed', 'cancelled'].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(run.status, 'awaiting_review', 'fixture workflow must reach awaiting_review before testing the review route');
  const reviewNode = workflow.nodes.find((node) => node.type === 'review');
  return { workflowId: workflow.id, runId: run.id, episodeVersion: run.episodeVersion, reviewNodeId: reviewNode.id, channelId: episode.channelId };
}

test('review without a reviewNodeId is rejected and commits no decision', async (t) => {
  const f = await fixture(t, { renderer: fastRenderer() });
  const { workflowId, runId, episodeVersion } = await driveRunToReview(f);

  const missing = await f.request(`/api/workflows/${workflowId}/runs/${runId}/review`, 'POST', {
    decision: 'approved',
    notes: 'Fixture review without an explicit target node.',
    expectedEpisodeVersion: episodeVersion,
  });
  assert.equal(missing.status, 400, 'POST .../review must require an explicit reviewNodeId and reject its absence');

  const runsAfter = await (await f.request(`/api/workflows/${workflowId}/runs`)).json();
  const runAfter = runsAfter.find((item) => item.id === runId);
  assert.equal(runAfter.status, 'awaiting_review', 'a rejected review with no reviewNodeId must leave the run undecided');
});

test('review with the correct reviewNodeId commits that node decision; an unknown reviewNodeId on a still-pending run is rejected', async (t) => {
  const f = await fixture(t, { renderer: fastRenderer() });
  const { workflowId, runId, episodeVersion, reviewNodeId, channelId } = await driveRunToReview(f);
  const channel = (await (await f.request('/api/state')).json()).channels.find(c => c.id === channelId);
  const bound = await f.request(`/api/channels/${channelId}/youtube`, 'PUT', { externalId: FIXTURE_EXTERNAL_ID, expectedUpdatedAt: channel.updatedAt });
  assert.equal(bound.status, 200);

  const unknownNode = await f.request(`/api/workflows/${workflowId}/runs/${runId}/review`, 'POST', {
    reviewNodeId: 'not-a-real-node-id',
    decision: 'approved',
    notes: 'Fixture review bound to a nonexistent node.',
    expectedEpisodeVersion: episodeVersion,
  });
  assert.ok(!unknownNode.ok, 'a reviewNodeId that does not name a real node on this run must be rejected, not silently accepted');
  const stillPending = await (await f.request(`/api/workflows/${workflowId}/runs`)).json();
  assert.equal(stillPending.find((item) => item.id === runId).status, 'awaiting_review', 'an unknown reviewNodeId must not consume the pending review');

  const decided = await f.request(`/api/workflows/${workflowId}/runs/${runId}/review`, 'POST', {
    reviewNodeId,
    decision: 'approved',
    notes: 'Fixture review bound to its exact review node.',
    expectedEpisodeVersion: episodeVersion,
  });
  assert.equal(decided.status, 200, 'a review naming the correct reviewNodeId on an awaiting_review run must be accepted');
});

// --- Every new production-workspace route must sit behind the same session gate as existing routes. ---
// /oauth/youtube/callback is the documented exception (an unauthenticated external redirect target
// with its own correlation-cookie safety contract) and is covered separately below.

test('every new production-workspace route requires an authenticated session before any route-specific logic runs', async (t) => {
  const f = await fixture(t, { loginToken: 'pw-new-routes-auth-fixture-token' });
  const routes = [
    ['POST', '/api/workflows/fixture/copies'],
    ['POST', '/api/workflows/fixture/quote'],
    ['GET', '/api/sources/search?query=fixture&kind=video'],
    ['POST', '/api/sources/import'],
    ['POST', '/api/uploads/fixture/rights'],
    ['POST', '/api/episodes/fixture/source'],
    ['POST', '/api/episodes/fixture/card'],
    ['PUT', '/api/channels/fixture/youtube'],
    ['GET', '/api/channels/fixture/youtube'],
    ['POST', '/api/channels/fixture/youtube/authorize'],
    ['DELETE', '/api/channels/fixture/youtube'],
    ['POST', '/api/publication/approvals'],
    ['POST', '/api/publication/approvals/fixture/publish'],
    ['POST', '/api/publication/intents/fixture/resume'],
    ['GET', '/api/publication/approvals/fixture'],
    ['GET', '/api/episodes/fixture/publications'],
  ];
  for (const [method, path] of routes) {
    const response = await f.request(path, method, method === 'GET' || method === 'DELETE' ? undefined : {});
    assert.equal(response.status, 401, `${method} ${path} must require authentication even before the route exists`);
  }
});

// --- Unknown/unimplemented routes under these prefixes must never act like success. ---

test('unmatched paths under the new route prefixes return explicit failure, never a fabricated 2xx', async (t) => {
  const f = await fixture(t);
  const probes = [
    ['GET', '/api/workflows/fixture/copies'],
    ['DELETE', '/api/workflows/fixture/copies'],
    ['POST', '/api/workflows/fixture/copies/extra'],
    ['POST', '/api/sources/search'],
    ['PUT', '/api/sources/import'],
    ['GET', '/api/uploads/fixture/rights'],
    ['GET', '/api/episodes/fixture/source'],
    ['GET', '/api/episodes/fixture/card'],
    ['POST', '/api/channels/fixture/youtube'],
    ['PATCH', '/api/channels/fixture/youtube'],
    ['DELETE', '/api/publication/approvals/fixture'],
    ['POST', '/api/publication/approvals/fixture'],
  ];
  for (const [method, path] of probes) {
    const response = await f.request(path, method, method === 'GET' || method === 'DELETE' ? undefined : {});
    assert.ok(response.status >= 400, `${method} ${path} is not a defined route and must not report success`);
  }
});

// --- POST /api/episodes/:id/source (attach) and POST /api/episodes/:id/card -- exact body fields from plan.json media.methods. ---

async function uploadFixtureAsset(f, name = 'fixture-source.png', bytes = 'fixture-source-bytes') {
  const response = await f.raw(`/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from(bytes) });
  assert.equal(response.status, 201, 'fixture upload setup must succeed via the real API');
  return response.json();
}

test('attaching a cleared upload to a scene performs a guarded versioned update', async (t) => {
  const f = await fixture(t);
  const channel = await createChannel(f);
  const episode = await createEpisode(f, channel.id, { title: 'Source-bound episode' });
  const upload = await uploadFixtureAsset(f);
  const sceneId = episode.scenes[0].id;
  const rights = await f.request(`/api/uploads/${upload.id}/rights`, 'POST', { origin: 'own' });
  assert.equal(rights.status, 201, await rights.clone().text());

  const stale = await f.request(`/api/episodes/${episode.id}/source`, 'POST', {
    sceneId, uploadId: upload.id, expectedVersion: episode.version + 1, useAs: 'illustration',
  });
  assert.equal(stale.status, 409, 'a stale expectedVersion must be rejected as a version conflict, like every other versioned episode edit');

  const attached = await f.request(`/api/episodes/${episode.id}/source`, 'POST', {
    sceneId, uploadId: upload.id, expectedVersion: episode.version, useAs: 'illustration',
  });
  assert.equal(attached.status, 200, 'POST /api/episodes/:id/source must accept a valid sceneId/uploadId/expectedVersion/useAs attach');
  const updated = await attached.json();
  assert.equal(updated.version, episode.version + 1, 'attaching a source must version the episode like every other scene edit');
  const scene = updated.scenes.find((item) => item.id === sceneId);
  assert.equal(scene.assetUrl, upload.url, 'the scene must now reference the attached uploaded asset');
});

test('converting a scene to a text-only card preserves story content and fabricates no image or license', async (t) => {
  const f = await fixture(t);
  const channel = await createChannel(f);
  const episode = await createEpisode(f, channel.id, { title: 'Card-fallback episode' });
  const sceneId = episode.scenes[0].id;
  const withText = await (await f.request(`/api/episodes/${episode.id}`, 'PUT', {
    scenes: [{ ...episode.scenes[0], text: 'Verified fixture story text to preserve.', narration: 'Verified fixture narration to preserve.' }],
    expectedVersion: episode.version,
  })).json();

  const stale = await f.request(`/api/episodes/${episode.id}/card`, 'POST', { sceneId, expectedVersion: withText.version + 1 });
  assert.equal(stale.status, 409, 'a stale expectedVersion on card conversion must be rejected as a version conflict, like every other versioned episode edit');

  const carded = await f.request(`/api/episodes/${episode.id}/card`, 'POST', { sceneId, expectedVersion: withText.version });
  assert.equal(carded.status, 200, 'POST /api/episodes/:id/card must accept a valid sceneId/expectedVersion on a no-footage fallback');
  const updated = await carded.json();
  const scene = updated.scenes.find((item) => item.id === sceneId);
  assert.equal(scene.kind, 'title', 'the card fallback must be an original text-only title card, never an image/video kind');
  assert.equal(scene.assetUrl, undefined, 'a text-only card must carry no uploaded image or video asset');
  assert.equal(scene.text, 'Verified fixture story text to preserve.', 'the selected story text must be preserved, not replaced or fabricated');
  assert.equal(scene.narration, 'Verified fixture narration to preserve.', 'narration must be preserved through the card fallback');
});

// --- GET /api/sources/search and POST /api/sources/import -- exact field names confirmed by MediaImplementation. ---
// Deep Commons-protocol success-path assertions belong to MediaContractTests; these cover the HTTP
// guard/status-mapping boundary only, via injected mediaOptions.fetchImpl (never a real Commons call).

test('source search maps upstream 429/403 to explicit provider status with Retry-After, never fabricating no-results', async (t) => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } });
    return new Response('forbidden', { status: 403 });
  };
  const f = await fixture(t, { mediaOptions: { fetchImpl, userAgent: 'frameforge-test-fixture/1.0 (+test)' } });

  const rateLimited = await f.request('/api/sources/search?query=fixture&kind=video');
  assert.equal(rateLimited.status, 200, 'an upstream 429 must not become an HTTP error; it is reported in the body');
  const rateLimitedBody = await rateLimited.json();
  assert.equal(rateLimitedBody.status, 'provider_rate_limited', 'a 429 from Commons must map to the explicit provider_rate_limited status, not no-results');
  assert.equal(rateLimitedBody.retryAfter, 30, 'the Retry-After header value must be surfaced as retryAfter');
  assert.deepEqual(rateLimitedBody.items, [], 'a blocked/rate-limited search must never fabricate items');

  const blocked = await f.request('/api/sources/search?query=fixture&kind=image');
  assert.equal(blocked.status, 200, 'an upstream 403 must not become an HTTP error; it is reported in the body');
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.status, 'provider_blocked', 'a 403 from Commons must map to the explicit provider_blocked status, not no-results');
});

test('source import requires explicit rightsAcknowledged before any network call and never imports an arbitrary caller URL', async (t) => {
  const calls = [];
  const fetchImpl = async (input, init) => { calls.push(String(input)); return new Response('{}', { status: 200 }); };
  const f = await fixture(t, { mediaOptions: { fetchImpl, userAgent: 'frameforge-test-fixture/1.0 (+test)' } });

  const unacknowledged = await f.request('/api/sources/import', 'POST', { pageId: 'File:Fixture.png', kind: 'image', useAs: 'illustration', rightsAcknowledged: false });
  assert.equal(unacknowledged.status, 400, 'import without explicit rightsAcknowledged:true must be rejected');
  assert.equal(calls.length, 0, 'no network call may happen before rights acknowledgement is verified -- no automatic clearance');

  await f.request('/api/sources/import', 'POST', {
    pageId: 'File:Fixture.png', kind: 'image', useAs: 'illustration', rightsAcknowledged: true,
    sourceUrl: 'https://malicious.example/arbitrary-payload.png',
  });
  assert.ok(!calls.some((url) => url.includes('malicious.example')), 'a caller-supplied sourceUrl must never be fetched; only the server re-derived Commons URL for the given pageId is used');
});

// --- Channel YouTube binding + OAuth boundary. Cookie/path literals confirmed by DeliveryImplementation. ---

const YOUTUBE_OAUTH_COOKIE_NAME = 'frameforge_youtube_oauth';
const YOUTUBE_OAUTH_CALLBACK_PATH = '/oauth/youtube/callback';
const FIXTURE_EXTERNAL_ID = 'UC1234567890abcdefghijkl';
const SECRET_FIELD_NAMES = ['accessToken', 'refreshToken', 'clientSecret', 'code', 'verifier', 'codeVerifier', 'tokenKey', 'resumableUrl'];

function assertNoSecretBytes(payload, fixtureSecretValue, context) {
  const serialized = JSON.stringify(payload);
  for (const key of SECRET_FIELD_NAMES) assert.ok(!serialized.includes(`"${key}"`), `${context} must not expose a "${key}" field`);
  if (fixtureSecretValue) assert.ok(!serialized.includes(fixtureSecretValue), `${context} must not leak the literal fixture secret value`);
}

test('setting a channel\'s known YouTube externalId is guarded by optimistic concurrency', async (t) => {
  const f = await fixture(t);
  const channel = await createChannel(f);

  const stale = await f.request(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: FIXTURE_EXTERNAL_ID, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
  assert.equal(stale.status, 409, 'a stale expectedUpdatedAt must be rejected as a version conflict, like every other optimistic-concurrency guard in this codebase');

  const bound = await f.request(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: FIXTURE_EXTERNAL_ID, expectedUpdatedAt: channel.updatedAt });
  assert.equal(bound.status, 200, 'PUT /api/channels/:id/youtube must accept a valid externalId/expectedUpdatedAt pair');
});

test('channel YouTube status is sanitized -- scopes/expiry/channel/status only, never raw OAuth secret bytes', async (t) => {
  const f = await fixture(t, { youtubeOptions: { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret-do-not-leak-12345' } });
  const channel = await createChannel(f);
  const status = await f.request(`/api/channels/${channel.id}/youtube`);
  assert.equal(status.status, 200, 'GET /api/channels/:id/youtube must return a sanitized status for a known channel');
  const body = await status.json();
  assertNoSecretBytes(body, 'fixture-client-secret-do-not-leak-12345', 'GET /api/channels/:id/youtube');
});

test('authorize is rejected until the channel has a known YouTube externalId; never falls back to the first channel', async (t) => {
  const f = await fixture(t);
  const channel = await createChannel(f); // freshly created, externalId is empty/unknown
  const response = await f.request(`/api/channels/${channel.id}/youtube/authorize`, 'POST', {});
  assert.notEqual(response.status, 200, 'authorize must require a known UC externalId before beginning the OAuth flow');
});

test('authorize on a channel with a known externalId returns authUrl and a Lax correlation cookie distinct from the Strict session cookie', async (t) => {
  const f = await fixture(t, { loginToken: 'pw-youtube-cookie-fixture-token-12345', youtubeOptions: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only-secret', redirectUri: 'http://127.0.0.1/oauth/youtube/callback', fetchImpl: async () => { throw new Error('No external transport during authorize'); } } });
  const login = await f.request('/api/login', 'POST', { token: 'pw-youtube-cookie-fixture-token-12345' });
  const sessionCookie = login.headers.get('set-cookie');
  assert.match(sessionCookie, /HttpOnly; SameSite=Strict/, 'sanity: the existing session cookie stays Strict');
  const headers = { Cookie: sessionCookie.split(';')[0] };

  const channelResponse = await f.request('/api/channels', 'POST', { name: 'Fixture channel', category: 'information', platform: 'YouTube' }, headers);
  const channel = await channelResponse.json();
  await f.request(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: FIXTURE_EXTERNAL_ID, expectedUpdatedAt: channel.updatedAt }, headers);

  const authorize = await f.request(`/api/channels/${channel.id}/youtube/authorize`, 'POST', {}, headers);
  assert.equal(authorize.status, 200, 'authorize on a channel with a known externalId must begin the OAuth flow');
  const body = await authorize.json();
  assert.match(body.authUrl, /^https:\/\//, 'authorize must return a real Google authUrl, not a fabricated/internal placeholder');
  const setCookies = authorize.headers.getSetCookie();
  const correlationCookie = setCookies.find((entry) => entry.startsWith(`${YOUTUBE_OAUTH_COOKIE_NAME}=`));
  assert.ok(correlationCookie, `authorize must set the ${YOUTUBE_OAUTH_COOKIE_NAME} correlation cookie`);
  assert.match(correlationCookie, /HttpOnly/);
  assert.match(correlationCookie, /SameSite=Lax/);
  assert.ok(!correlationCookie.includes('SameSite=Strict'), 'the correlation cookie must be Lax, not Strict like the main session cookie');
  assert.match(correlationCookie, new RegExp(`Path=${YOUTUBE_OAUTH_CALLBACK_PATH.replace(/\//g, '\\/')}`), 'the correlation cookie must be scoped to the callback path, not the whole site');
});

test('the OAuth callback rejects a request with no correlation cookie and never marks the channel connected', async (t) => {
  const f = await fixture(t);
  const channel = await createChannel(f);
  await f.request(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: FIXTURE_EXTERNAL_ID, expectedUpdatedAt: channel.updatedAt });

  const callback = await f.raw(`${YOUTUBE_OAUTH_CALLBACK_PATH}?state=fixture-state&code=fixture-code`, { redirect: 'manual' });
  assert.ok(!(callback.status >= 200 && callback.status < 300 && callback.headers.get('content-type')?.includes('json')), 'a callback with no correlation cookie must not report a JSON success');

  const status = await (await f.request(`/api/channels/${channel.id}/youtube`)).json();
  assert.notEqual(status.connected, true, 'a callback that cannot verify its correlation cookie must never leave the channel connected');
});

test('disconnecting a channel\'s YouTube binding clears connected status', async (t) => {
  const f = await fixture(t);
  const channel = await createChannel(f);
  await f.request(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: FIXTURE_EXTERNAL_ID, expectedUpdatedAt: channel.updatedAt });
  const disconnect = await f.request(`/api/channels/${channel.id}/youtube`, 'DELETE');
  assert.equal(disconnect.status, 200, 'DELETE /api/channels/:id/youtube must disconnect a known channel');
  const status = await (await f.request(`/api/channels/${channel.id}/youtube`)).json();
  assert.notEqual(status.connected, true, 'after disconnect, status must no longer report connected');
});

// --- Publication approve/publish/resume request identity. Body fields from plan.json publication.body. ---

async function driveApprovedCandidate(f) {
  const { workflowId, runId, episodeVersion, reviewNodeId, channelId } = await driveRunToReview(f);
  const channel = (await (await f.request('/api/state')).json()).channels.find(c => c.id === channelId);
  const bound = await f.request(`/api/channels/${channelId}/youtube`, 'PUT', { externalId: FIXTURE_EXTERNAL_ID, expectedUpdatedAt: channel.updatedAt });
  assert.equal(bound.status, 200);
  const reviewed = await f.request(`/api/workflows/${workflowId}/runs/${runId}/review`, 'POST', {
    reviewNodeId, decision: 'approved', notes: 'Fixture approval before publication approval.', expectedEpisodeVersion: episodeVersion,
  });
  assert.ok(reviewed.ok, 'fixture setup: the candidate review must be approved before testing publication approval');
  return { workflowId, runId, episodeVersion, reviewNodeId };
}

function approvalBody(context, overrides = {}) {
  return {
    workflowId: context.workflowId, runId: context.runId, reviewNodeId: context.reviewNodeId, expectedEpisodeVersion: context.episodeVersion,
    title: 'Fixture publication title', description: 'Fixture publication description.', categoryId: '25', tags: ['fixture'],
    selfDeclaredMadeForKids: false, containsSyntheticMedia: false, disclosureRationale: 'Fixture rationale for synthetic-media disclosure decision.',
    rightsAcknowledged: true,
    ...overrides,
  };
}

test('publication approval requires explicit rightsAcknowledged and audience/disclosure booleans', async (t) => {
  const f = await fixture(t, { renderer: fastRenderer() });
  const context = await driveApprovedCandidate(f);

  const noRights = await f.request('/api/publication/approvals', 'POST', approvalBody(context, { rightsAcknowledged: false }));
  assert.equal(noRights.status, 400, 'publication approval without explicit rightsAcknowledged:true must be rejected');

  const noAudience = await f.request('/api/publication/approvals', 'POST', approvalBody(context, { selfDeclaredMadeForKids: undefined }));
  assert.equal(noAudience.status, 400, 'publication approval requires an explicit made-for-kids audience decision, not an implicit default');
});

test('publication approve -> publish -> state -> episode list preserves exact request identity', async (t) => {
  const f = await fixture(t, { renderer: fastRenderer() });
  const context = await driveApprovedCandidate(f);

  const approved = await f.request('/api/publication/approvals', 'POST', approvalBody(context));
  assert.equal(approved.status, 201, `a fully-formed publication approval request must be accepted: ${await approved.clone().text()}`);
  const approval = await approved.json();
  assert.equal(approval.workflowId, context.workflowId, 'the approval must preserve the exact workflowId it was requested with');
  assert.equal(approval.runId, context.runId, 'the approval must preserve the exact runId it was requested with');
  assert.equal(approval.reviewNodeId, context.reviewNodeId, 'the approval must preserve the exact reviewNodeId it was requested with');
  assert.equal(approval.title, 'Fixture publication title', 'the approval must preserve the exact submitted title');

  const published = await f.request(`/api/publication/approvals/${approval.id}/publish`, 'POST', {});
  assert.equal(published.status, 202, 'publish must queue a persisted intent, not synchronously claim completion');
  const intent = await published.json();
  assert.ok(intent.id, 'publish must return a persistent intent identity for later resume/state lookups');

  const state = await f.request(`/api/publication/approvals/${approval.id}`);
  assert.equal(state.status, 200, 'GET /api/publication/approvals/:id must return the approval state');
  const stateBody = await state.json();
  assert.equal(stateBody.approvalId, approval.id, 'state lookup must return exactly the requested approval, not a different one');

  const episodeId = (await (await f.request(`/api/workflows/${context.workflowId}/runs`)).json()).find((run) => run.id === context.runId).episodeId;
  const list = await f.request(`/api/episodes/${episodeId}/publications`);
  assert.equal(list.status, 200, 'GET /api/episodes/:id/publications must list this episode\'s publication approvals');
  const listBody = await list.json();
  assert.ok(listBody.some((item) => item.id === approval.id), 'the episode publication list must include the approval created for it');
});

test('resuming an unknown publication intent fails explicitly rather than fabricating progress', async (t) => {
  const f = await fixture(t);
  const resume = await f.request('/api/publication/intents/does-not-exist/resume', 'POST', {});
  assert.equal(resume.status, 404, 'resuming an unknown intent id must fail, not silently report success');
});

// --- POST /api/workflows/:id/quote and the new consent fields on POST /api/workflows/:id/run. ---
// This stays at the HTTP forwarding boundary; deep quote/consent state-machine semantics belong
// to EngineContractTests so coverage is not duplicated.

test('quote on a real workflow/episode returns a persisted plan shape, not a route-missing failure', async (t) => {
  const f = await fixture(t);
  const state = await (await f.request('/api/state')).json();
  const episode = await createEpisode(f, state.channels[0].id, { title: 'Quote fixture episode' });
  const body = classicWorkflowBody('Saved source quote fixture');
  body.nodes = body.nodes.map(node => node.type === 'script' ? { ...node, config: { agent: 'existing' } } : node);
  const template = await (await f.request('/api/workflows', 'POST', body)).json();
  const workflow = await ownedWorkflow(f, template, episode);

  const quote = await f.request(`/api/workflows/${workflow.id}/quote`, 'POST', { episodeId: episode.id, selectedStages: workflow.nodes.map((node) => node.id), disclosure: { containsSyntheticMedia: false, rationale: 'Source-only fixture candidate' } });
  assert.ok([200, 201].includes(quote.status), 'POST /api/workflows/:id/quote must accept a valid workflowId/episodeId and persist a generation plan');
  const plan = await quote.json();
  assert.ok('fingerprint' in plan, 'the persisted plan must expose its fingerprint per plan.json engineAPI.quote');
  assert.ok('candidate' in plan, 'the persisted plan must expose the full candidate per plan.json engineAPI.quote');
  assert.ok('aggregate' in plan, 'the persisted plan must expose an aggregate per plan.json engineAPI.quote');
  assert.ok('expiresAt' in plan && Number.isFinite(Date.parse(plan.expiresAt)), 'the persisted plan must expose an expiry per plan.json engineAPI.quote');
});

function generationWorkflowBody(name) {
  const nodes = [
    { id: 'trend', type: 'trend', x: 0, y: 0, config: {} },
    { id: 'research', type: 'research', x: 200, y: 0, config: {} },
    { id: 'script', type: 'script', x: 400, y: 0, config: { agent: 'studio', prompt: 'Fixture prompt' } },
    { id: 'storyboard', type: 'storyboard', x: 600, y: 0, config: {} },
    { id: 'generate', type: 'generate', x: 800, y: 0, config: { model: 'fixture', prompt: 'Fixture generation prompt', params: {} } },
    { id: 'render', type: 'render', x: 1000, y: 0, config: {} },
    { id: 'review', type: 'review', x: 1200, y: 0, config: {} },
  ];
  const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${index + 1}`, source: nodes[index].id, target: node.id }));
  return { name, nodes, edges };
}

test('starting a run that includes paid generation without a prior quote/consent is rejected, not silently allowed', async (t) => {
  const f = await fixture(t);
  const channel = (await (await f.request('/api/state')).json()).channels[0];
  const episode = await createEpisode(f, channel.id, { title: 'Unquoted generation fixture episode' });
  const template = await (await f.request('/api/workflows', 'POST', generationWorkflowBody('Unquoted generation fixture'))).json();
  const workflow = await (await f.request(`/api/workflows/${template.id}/copies`, 'POST', { episodeId: episode.id, channelId: channel.id, expectedTemplateVersion: template.version })).json();

  const started = await f.request(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, allowGeneration: true });
  assert.equal(started.status, 400, 'starting a generation-including run with allowGeneration:true but no generationPlanId/generationFingerprint and acceptUnquotedEstimate not true must be rejected as unconsented paid spend');
});

// --- Secret bytes must never surface in /api/state or /api/knowledge, regardless of which feature wrote them. ---

test('secret OAuth and publication identifiers never appear in /api/state or /api/knowledge', async (t) => {
  const f = await fixture(t, { youtubeOptions: { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret-must-not-leak-98765' } });
  const channel = await createChannel(f);
  await f.request(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: FIXTURE_EXTERNAL_ID, expectedUpdatedAt: channel.updatedAt });
  await f.request(`/api/channels/${channel.id}/youtube/authorize`, 'POST', {});

  const state = await (await f.request('/api/state')).json();
  assertNoSecretBytes(state, 'fixture-client-secret-must-not-leak-98765', 'GET /api/state');
  const knowledge = await (await f.request('/api/knowledge')).json();
  assertNoSecretBytes(knowledge, 'fixture-client-secret-must-not-leak-98765', 'GET /api/knowledge');
});

async function ownedWorkflow(f, template, episode) {
  const response = await f.request(`/api/workflows/${template.id}/copies`, 'POST', { episodeId: episode.id, channelId: episode.channelId, expectedTemplateVersion: template.version });
  assert.equal(response.status, 201, await response.clone().text()); return response.json();
}
