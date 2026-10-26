import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { defaultWorkflow } from '../server/workflows.mjs';

// Active rows are seeded AFTER application startup: startup recovery deliberately fails or
// resumes interrupted jobs, which would otherwise hide the archive guard being exercised.
async function fixture(t, { loginToken = '', browserModule, generation = {} } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-project-archive-'));
  const store = new Store(dataDir);
  store.saveTrendCollectorSettings({ enabled: false });
  const effects = [];
  const forbidden = (name) => async () => {
    effects.push(name);
    throw new Error(`Unexpected external effect: ${name}`);
  };
  const server = createApp({
    dataDir, loginToken, publicOrigin: '',
    integrations: {
      integrationStatus: async () => ({ studio: { available: true } }),
      runAgent: forbidden('agent'), fetchTrends: forbidden('trends'),
    },
    renderer: forbidden('render'),
    speech: { listVoices: forbidden('voices'), synthesize: forbidden('speech') },
    generation: {
      transport: 'api', modelSchema: forbidden('schema'), estimate: forbidden('estimate'),
      create: forbidden('generation'), status: forbidden('generation-status'),
      ...generation,
    },
    generationOptions: { download: forbidden('download'), probe: forbidden('probe') },
    mediaOptions: { fetchImpl: forbidden('commons'), userAgent: 'FrameForge archive regression (offline fixture)' },
    youtubeOptions: { fetchImpl: forbidden('oauth'), clientId: '', clientSecret: '', redirectUri: '' },
    publicationOptions: { fetchImpl: forbidden('publication') },
    ...(browserModule ? { platformSessionOptions: { browserModule } } : {}),
  });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', body, headers = {}) => fetch(base + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { dataDir, store, effects, request, raw: (path, options) => fetch(base + path, options) };
}

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

async function project(f, headers = {}, title = 'Recoverable project') {
  const channel = await json(await f.request('/api/channels', 'POST', {
    name: `${title} channel`, category: 'information', platform: 'YouTube',
  }, headers), 201);
  const episode = await json(await f.request('/api/episodes', 'POST', {
    channelId: channel.id, title, topic: 'Archive lifecycle fixture',
  }, headers), 201);
  const template = await json(await f.request('/api/workflows', 'POST', defaultWorkflow(), headers), 201);
  const workflow = await json(await f.request(`/api/workflows/${template.id}/copies`, 'POST', {
    channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version,
  }, headers), 201);
  return { channel, episode, workflow, template, url: `/api/episodes/${episode.id}` };
}

function persisted(f) {
  const db = new DatabaseSync(join(f.dataDir, 'studio.sqlite'), { readOnly: true });
  try {
    return {
      entities: db.prepare('SELECT kind,id,data FROM entities ORDER BY kind,id').all(),
      history: db.prepare('SELECT episode_id,version,data FROM history ORDER BY episode_id,version').all(),
      workflowHistory: db.prepare('SELECT workflow_id,version,data FROM workflow_history ORDER BY workflow_id,version').all(),
      reviews: db.prepare('SELECT id,run_id,data FROM workflow_reviews ORDER BY id').all(),
      nodeReviews: db.prepare('SELECT id,run_id,review_node_id,data FROM workflow_node_reviews ORDER BY id').all(),
    };
  } finally { db.close(); }
}

async function archive(f, p, expectedVersion = p.episode.version) {
  return json(await f.request(`${p.url}/archive`, 'POST', { expectedVersion }), 200);
}

function workRecord(f, p, kind, status) {
  const common = { episodeId: p.episode.id, episodeVersion: p.episode.version, status };
  if (kind === 'workflowRuns') return f.store.create(kind, {
    ...common, workflowId: p.workflow.id, workflowVersion: p.workflow.version,
    workflowSnapshot: p.workflow,
    nodeRuns: p.workflow.nodes.map((node) => ({ nodeId: node.id, type: node.type, status: status === 'running' ? 'running' : 'queued' })),
  });
  if (kind === 'generationJobs') return f.store.create(kind, {
    ...common, sceneId: p.episode.scenes[0].id, requestId: `${p.episode.id}-${status}`,
    transport: 'api', model: 'fixture-image', prompt: 'Retain project media', params: {},
    providerRequestId: 'archive-fixture-request', outputs: [], applied: false,
  });
  if (kind === 'narrationJobs') return f.store.create(kind, {
    ...common, sceneIds: [p.episode.scenes[0].id], voice: 'Fixture voice',
    provider: 'fixture-speech', rate: 0, progress: 0,
  });
  if (kind === 'publicationIntents') return f.store.create(kind, {
    ...common, channelId: p.channel.id, workflowId: p.workflow.id,
    approvalId: 'fixture-approval', ownerId: 'admin', phase: status,
    videoId: null, privacyStatus: 'unknown',
  });
  return f.store.create(kind, { ...common, progress: 0, sceneSnapshot: p.episode.scenes });
}

async function retainedCandidate(f, p, { awaitingReview = false } = {}) {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0f8AAAAASUVORK5CYII=', 'base64');
  const uploaded = await json(await f.raw('/api/uploads?name=retained.png', {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes,
  }), 201);
  p.episode = await json(await f.request(p.url, 'PUT', {
    expectedVersion: p.episode.version, status: 'ready', notes: 'Keep editorial notes',
    scenes: [{ ...p.episode.scenes[0], kind: 'image', assetUrl: uploaded.url }],
  }), 200);
  const renderBytes = Buffer.from('Retained export bytes: lifecycle tests do not decode video.');
  const filename = 'archive-candidate.mp4';
  await writeFile(join(f.dataDir, 'exports', filename), renderBytes);
  const job = f.store.create('jobs', {
    episodeId: p.episode.id, episodeVersion: p.episode.version, status: 'completed', progress: 100,
    filename, outputUrl: `/api/exports/${filename}`,
    sha256: createHash('sha256').update(renderBytes).digest('hex'), sceneSnapshot: p.episode.scenes,
  });
  const reviewNode = p.workflow.nodes.find((node) => node.type === 'review');
  const run = f.store.create('workflowRuns', {
    episodeId: p.episode.id, episodeVersion: p.episode.version,
    workflowId: p.workflow.id, workflowVersion: p.workflow.version, workflowSnapshot: p.workflow,
    status: awaitingReview ? 'awaiting_review' : 'approved', nodeRuns: p.workflow.nodes.map((node) => ({
      nodeId: node.id, type: node.type, status: node.type === 'review' ? (awaitingReview ? 'awaiting_review' : 'approved') : 'completed',
      ...(node.type === 'render' ? { output: { jobId: job.id, outputUrl: job.outputUrl, sha256: job.sha256, episodeVersion: p.episode.version, sceneSnapshot: p.episode.scenes } } : {}),
    })),
  });
  const review = {
    id: 'retained-review', runId: run.id, workflowId: p.workflow.id,
    reviewNodeId: reviewNode.id, decision: 'approved', notes: 'Approved retained candidate',
    episodeVersion: p.episode.version, jobId: job.id, outputUrl: job.outputUrl, sha256: job.sha256,
  };
  if (!awaitingReview) {
    const db = new DatabaseSync(join(f.dataDir, 'studio.sqlite'));
    try {
      db.prepare('INSERT INTO workflow_reviews(id,run_id,data) VALUES (?,?,?)').run(review.id, run.id, JSON.stringify(review));
      db.prepare('INSERT INTO workflow_node_reviews(id,run_id,review_node_id,data) VALUES (?,?,?,?)').run(review.id, run.id, reviewNode.id, JSON.stringify(review));
    } finally { db.close(); }
  }
  const generation = workRecord(f, p, 'generationJobs', 'completed');
  f.store.save('generationJobs', { ...generation, outputs: [{ uploadId: uploaded.id, url: uploaded.url, kind: 'image', sha256: uploaded.sha256 }], applied: true, appliedVersion: p.episode.version });
  workRecord(f, p, 'narrationJobs', 'completed');
  return { uploaded, bytes, job, renderBytes, run };
}

test('archive and unarchive append monotonic history while retaining project identity, media, runs and approvals', async (t) => {
  const f = await fixture(t), p = await project(f);
  const media = await retainedCandidate(f, p);
  const episodeBefore = p.episode;
  const before = persisted(f);
  const historyBefore = await json(await f.request(`${p.url}/history`), 200);
  const runsBefore = await json(await f.request(`/api/workflows/${p.workflow.id}/runs`), 200);

  const archived = await archive(f, p);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.version, episodeBefore.version + 1);
  assert.equal(new Date(archived.archivedAt).toISOString(), archived.archivedAt);
  for (const key of ['id', 'channelId', 'createdAt', 'title', 'topic', 'notes', 'scenes']) {
    assert.deepEqual(archived[key], episodeBefore[key], `archiving must preserve ${key}`);
  }
  const historyArchived = await json(await f.request(`${p.url}/history`), 200);
  assert.deepEqual(historyArchived.slice(1), historyBefore, 'old snapshots must remain byte-for-byte equivalent');
  assert.equal(historyArchived[0].reason, 'archived');
  assert.equal(historyArchived[0].snapshot.status, 'archived');
  assert.equal(historyArchived[0].version, archived.version);
  const state = await json(await f.request('/api/state'), 200);
  assert.deepEqual(state.episodes.find((item) => item.id === p.episode.id), archived, 'removal must remain recoverable, not delete the project');
  assert.deepEqual(await json(await f.request(`/api/workflows/${p.workflow.id}/runs`), 200), runsBefore);
  assert.deepEqual(Buffer.from(await (await f.request(media.uploaded.url)).arrayBuffer()), media.bytes, 'archiving must not revoke access to retained media');
  assert.deepEqual(Buffer.from(await (await f.request(media.job.outputUrl)).arrayBuffer()), media.renderBytes, 'archiving must not remove the rendered candidate');

  const restored = await json(await f.request(`${p.url}/unarchive`, 'POST', { expectedVersion: archived.version }), 200);
  assert.equal(restored.status, 'draft', 'restoring must not re-approve a previously ready project');
  assert.equal(restored.version, archived.version + 1);
  assert.equal(Object.hasOwn(restored, 'archivedAt'), false);
  for (const key of ['id', 'channelId', 'createdAt', 'title', 'topic', 'notes', 'scenes']) assert.deepEqual(restored[key], episodeBefore[key]);
  const historyRestored = await json(await f.request(`${p.url}/history`), 200);
  assert.equal(historyRestored[0].reason, 'unarchived');
  assert.deepEqual(historyRestored.map((item) => item.version), [restored.version, archived.version, ...historyBefore.map((item) => item.version)]);
  assert.deepEqual(historyRestored.slice(1), historyArchived);
  assert.equal(Object.hasOwn(historyRestored[0].snapshot, 'archivedAt'), false);

  const after = persisted(f);
  assert.deepEqual(after.entities.filter((row) => !['episodes', 'events'].includes(row.kind)), before.entities.filter((row) => !['episodes', 'events'].includes(row.kind)));
  assert.deepEqual(after.workflowHistory, before.workflowHistory);
  assert.deepEqual(after.reviews, before.reviews);
  assert.deepEqual(after.nodeReviews, before.nodeReviews);
  assert.deepEqual(Buffer.from(await (await f.request(media.uploaded.url)).arrayBuffer()), media.bytes);
  assert.deepEqual(Buffer.from(await (await f.request(media.job.outputUrl)).arrayBuffer()), media.renderBytes);
  assert.deepEqual(await readFile(join(f.dataDir, 'uploads', media.uploaded.filename)), media.bytes);
  assert.deepEqual(f.effects, []);
});

test('both lifecycle actions require a positive safe expectedVersion and reject unknown payload fields without writes', async (t) => {
  const f = await fixture(t), p = await project(f);
  const invalid = [
    ['missing version', {}], ['null', { expectedVersion: null }], ['string', { expectedVersion: '1' }],
    ['zero', { expectedVersion: 0 }], ['negative', { expectedVersion: -1 }], ['fractional', { expectedVersion: 1.5 }],
    ['boolean', { expectedVersion: true }], ['unsafe integer', { expectedVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['array', []], ['null body', null],
  ];
  for (const action of ['archive', 'unarchive']) {
    const current = action === 'archive' ? p.episode : await archive(f, p);
    for (const [name, body] of [...invalid, ['injected lifecycle fields', { expectedVersion: current.version, status: 'ready', archivedAt: 'forged' }]]) {
      const before = persisted(f);
      const response = await f.request(`${p.url}/${action}`, 'POST', body);
      assert.equal(response.status, 400, `${action}: ${name}: ${await response.text()}`);
      assert.deepEqual(persisted(f), before, `${action}: ${name} must not alter any persisted record`);
    }
    const before = persisted(f);
    const malformed = await f.raw(`${p.url}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"expectedVersion":' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(persisted(f), before, `${action}: malformed JSON must be a no-write failure`);
  }
});

test('stale, duplicate, missing-project and read-only lifecycle requests cannot consume versions or audit history', async (t) => {
  const f = await fixture(t), p = await project(f);
  const archived = await archive(f, p);
  for (const [path, method, body, status] of [
    [`${p.url}/archive`, 'POST', { expectedVersion: p.episode.version }, 409],
    [`${p.url}/archive`, 'POST', { expectedVersion: archived.version }, 409],
    [`${p.url}/unarchive`, 'POST', { expectedVersion: p.episode.version }, 409],
    ['/api/episodes/missing-project/archive', 'POST', { expectedVersion: 1 }, 404],
    ['/api/episodes/missing-project/unarchive', 'POST', { expectedVersion: 1 }, 404],
    [`${p.url}/archive`, 'GET', undefined, 404],
    [`${p.url}/unarchive`, 'GET', undefined, 404],
  ]) {
    const before = persisted(f);
    assert.equal((await f.request(path, method, body)).status, status, `${method} ${path}`);
    assert.deepEqual(persisted(f), before, `${method} ${path} must leave persisted state unchanged`);
  }
  const restored = await json(await f.request(`${p.url}/unarchive`, 'POST', { expectedVersion: archived.version }), 200);
  const before = persisted(f);
  assert.equal((await f.request(`${p.url}/unarchive`, 'POST', { expectedVersion: restored.version })).status, 409);
  assert.deepEqual(persisted(f), before, 'duplicate restore must not append another draft version');
});

test('archive and unarchive require a real authenticated admin session and same-origin writes, not client role claims', async (t) => {
  const loginToken = 'archive-regression-admin-secret';
  const f = await fixture(t, { loginToken });
  const session = await f.request('/api/login', 'POST', { token: loginToken });
  await json(session.clone(), 200);
  const headers = { Cookie: session.headers.get('set-cookie').split(';')[0] };
  const p = await project(f, headers);
  for (const action of ['archive', 'unarchive']) {
    const expectedVersion = f.store.get('episodes', p.episode.id).version;
    const before = persisted(f);
    for (const claimedHeaders of [{}, { 'X-Role': 'admin' }, { Cookie: `frameforge_session=${'0'.repeat(64)}` }]) {
      assert.equal((await f.request(`${p.url}/${action}`, 'POST', { expectedVersion, role: 'admin', authenticated: true }, claimedHeaders)).status, 401);
      assert.deepEqual(persisted(f), before, 'unauthenticated lifecycle requests must never mutate state');
    }
    for (const crossSite of [{ Origin: 'https://foreign.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await f.request(`${p.url}/${action}`, 'POST', { expectedVersion }, { ...headers, ...crossSite })).status, 403);
      assert.deepEqual(persisted(f), before, 'cross-site requests must never consume the authenticated version');
    }
    await json(await f.request(`${p.url}/${action}`, 'POST', { expectedVersion }, headers), 200);
  }
  await json(await f.request('/api/logout', 'POST', {}, headers), 200);
  const before = persisted(f);
  assert.equal((await f.request(`${p.url}/archive`, 'POST', { expectedVersion: f.store.get('episodes', p.episode.id).version }, headers)).status, 401);
  assert.deepEqual(persisted(f), before, 'revoked sessions cannot remove a project');
});

test('persisted active work blocks archive atomically for every executing lifecycle status', async (t) => {
  const statuses = {
    jobs: ['queued', 'running'], narrationJobs: ['queued', 'running'], workflowRuns: ['queued', 'running'],
    generationJobs: ['queued', 'submitting', 'pending', 'in_progress', 'downloading'],
    publicationIntents: ['queued', 'running', 'processing'],
  };
  const f = await fixture(t);
  for (const [kind, values] of Object.entries(statuses)) {
    for (const status of values) await t.test(`${kind}: ${status}`, async () => {
      const p = await project(f, {}, `${kind} ${status}`);
      const active = workRecord(f, p, kind, status);
      const before = persisted(f);
      const response = await f.request(`${p.url}/archive`, 'POST', { expectedVersion: p.episode.version });
      assert.equal(response.status, 409, `${kind}/${status}: ${await response.text()}`);
      assert.deepEqual(persisted(f), before, 'rejection must neither archive nor cancel/fail the active work');
      f.store.save(kind, { ...active, status: 'completed' });
      assert.equal((await archive(f, p)).status, 'archived', 'the same project becomes removable after its work completes');
    });
  }
  assert.deepEqual(f.effects, []);
});

test('archived projects reject editing and effect entrypoints before queue records, providers or publication can change', async (t) => {
  const f = await fixture(t), p = await project(f);
  const media = await retainedCandidate(f, p, { awaitingReview: true });
  const recoverable = workRecord(f, p, 'generationJobs', 'manual_recovery');
  const completed = workRecord(f, p, 'generationJobs', 'completed');
  const approval = f.store.create('publicationApprovals', {
    ownerId: 'admin', episodeId: p.episode.id, channelId: p.channel.id,
    workflowId: p.workflow.id, runId: media.run.id, status: 'approved',
  });
  const intent = f.store.create('publicationIntents', {
    ownerId: 'admin', episodeId: p.episode.id, channelId: p.channel.id,
    approvalId: approval.id, status: 'blocked', phase: 'private_readback', videoId: 'fixture-video',
  });
  const archived = await archive(f, p);
  const sceneId = p.episode.scenes[0].id;
  const template = f.store.list('templates')[0];
  const graphBody = { name: p.workflow.name, nodes: p.workflow.nodes, edges: p.workflow.edges, expectedVersion: p.workflow.version };
  const routes = [
    ['PUT', p.url, { title: 'Must not overwrite', status: 'draft', expectedVersion: archived.version }],
    ['POST', `${p.url}/template`, { templateId: template.id }],
    ['POST', `${p.url}/chat`, { agent: 'codex', message: 'Do not invoke the bridge' }],
    ['POST', `${p.url}/render`, {}],
    ['POST', `${p.url}/narration`, { expectedVersion: archived.version, voice: 'Fixture voice', rate: 0, sceneIds: [sceneId] }],
    ['POST', `${p.url}/generations`, { requestId: 'archived-create', expectedVersion: archived.version, sceneId, model: 'fixture-image', prompt: 'Do not spend', params: {} }],
    ['POST', `${p.url}/restore`, { version: p.episode.version, expectedVersion: archived.version }],
    ['PUT', `/api/workflows/${p.workflow.id}`, graphBody],
    ['POST', `/api/workflows/${p.workflow.id}/restore`, { version: 1, expectedVersion: p.workflow.version }],
    ['POST', `/api/workflows/${p.template.id}/copies`, { episodeId: p.episode.id, channelId: p.channel.id, expectedTemplateVersion: p.template.version }],
    ['POST', `/api/workflows/${p.workflow.id}/quote`, { episodeId: p.episode.id, expectedEpisodeVersion: archived.version, expectedWorkflowVersion: p.workflow.version }],
    ['POST', `/api/workflows/${p.workflow.id}/run`, { episodeId: p.episode.id, expectedEpisodeVersion: archived.version, expectedWorkflowVersion: p.workflow.version }],
    ['POST', `/api/workflows/${p.workflow.id}/runs/${media.run.id}/review`, { decision: 'approved', reviewNodeId: p.workflow.nodes.find((node) => node.type === 'review').id, notes: 'Do not reapprove', expectedEpisodeVersion: archived.version }],
    ['POST', `/api/generations/${completed.id}/apply`, { expectedVersion: archived.version, sceneId }],
    ['POST', `/api/generations/${completed.id}/normalize`, {}],
    ['POST', `/api/generations/${recoverable.id}/recover`, {}],
    ['POST', '/api/publication/approvals', {
      workflowId: p.workflow.id, runId: media.run.id, reviewNodeId: 'review', expectedEpisodeVersion: archived.version,
      title: 'Do not publish', description: 'Archive regression fixture', categoryId: '22', tags: [],
      selfDeclaredMadeForKids: false, containsSyntheticMedia: false,
      disclosureRationale: 'Fixture has no synthetic generation', rightsAcknowledged: true, visibility: 'public',
    }],
    ['POST', `/api/publication/approvals/${approval.id}/publish`, {}],
    ['POST', `/api/publication/intents/${intent.id}/resume`, {}],
  ];
  for (const [method, path, body] of routes) {
    const before = persisted(f);
    const response = await f.request(path, method, body);
    const error = await json(response, 409);
    assert.match(error.error, /archiv/i, `${method} ${path} must reject the archived project, not merely fail later validation`);
    assert.deepEqual(persisted(f), before, `${method} ${path} must not write jobs, history, approvals or audit records`);
    assert.deepEqual(f.effects, [], `${method} ${path} must reject before consulting any provider`);
  }
  const restored = await json(await f.request(`${p.url}/unarchive`, 'POST', { expectedVersion: archived.version }), 200);
  const before = persisted(f);
  const staleReview = await f.request(`/api/workflows/${p.workflow.id}/runs/${media.run.id}/review`, 'POST', {
    decision: 'approved', reviewNodeId: 'review', notes: 'Old render remains stale after restore',
    expectedEpisodeVersion: restored.version,
  });
  const error = await json(staleReview, 409);
  assert.match(error.error, /changed|version|render/i);
  assert.deepEqual(persisted(f), before, 'restoring must not make an old render approvable again');
});

test('ordinary status edits cannot bypass recoverable removal and archived history cannot resurrect archive markers', async (t) => {
  const f = await fixture(t), p = await project(f);
  p.episode = await json(await f.request(p.url, 'PUT', {
    expectedVersion: p.episode.version,
    scenes: p.episode.scenes.map((scene) => ({ ...scene, trimStart: 0, audioVolume: 1 })),
  }), 200);
  let before = persisted(f);
  assert.equal((await f.request(p.url, 'PUT', { status: 'archived', expectedVersion: p.episode.version })).status, 400);
  assert.deepEqual(persisted(f), before, 'ordinary editing must not bypass archive preconditions');
  const archived = await archive(f, p);
  before = persisted(f);
  assert.equal((await f.request(p.url, 'PUT', { status: 'draft', expectedVersion: archived.version })).status, 409);
  assert.deepEqual(persisted(f), before, 'ordinary editing must not bypass unarchive preconditions');
  const restored = await json(await f.request(`${p.url}/unarchive`, 'POST', { expectedVersion: archived.version }), 200);
  const historical = await json(await f.request(`${p.url}/restore`, 'POST', { version: archived.version, expectedVersion: restored.version }), 200);
  assert.equal(historical.version, restored.version + 1);
  assert.equal(historical.status, 'draft');
  assert.equal(Object.hasOwn(historical, 'archivedAt'), false, 'restoring an archived snapshot must not mark a live draft as removed');
  assert.equal(historical.id, p.episode.id);
  assert.deepEqual(historical.scenes, p.episode.scenes);
});

test('archive is scoped to one project: other active jobs do not block removal and a new project stays independently editable', async (t) => {
  const f = await fixture(t), removed = await project(f, {}, 'Removed project');
  const running = await project(f, {}, 'Unrelated running project');
  const active = workRecord(f, running, 'workflowRuns', 'running');
  const runningBefore = f.store.get('episodes', running.episode.id);
  const archived = await archive(f, removed);
  const fresh = await project(f, {}, 'Fresh project after removal');
  const freshBefore = f.store.get('episodes', fresh.episode.id);
  const freshHistory = await json(await f.request(`${fresh.url}/history`), 200);
  assert.notEqual(fresh.episode.id, removed.episode.id);
  assert.notEqual(fresh.workflow.id, removed.workflow.id);
  const edited = await json(await f.request(fresh.url, 'PUT', { title: 'Independent new title', expectedVersion: fresh.episode.version }), 200);
  assert.equal(edited.title, 'Independent new title');
  assert.equal(edited.version, freshBefore.version + 1);
  assert.equal(edited.status, 'draft');
  assert.equal(Object.hasOwn(edited, 'archivedAt'), false);
  assert.deepEqual((await json(await f.request(`${fresh.url}/history`), 200)).slice(1), freshHistory);
  assert.deepEqual(f.store.get('episodes', removed.episode.id), archived);
  assert.deepEqual(f.store.get('episodes', running.episode.id), runningBefore);
  assert.deepEqual(f.store.get('workflowRuns', active.id), active);
  await json(await f.request(`${removed.url}/unarchive`, 'POST', { expectedVersion: archived.version }), 200);
  assert.deepEqual(f.store.get('episodes', fresh.episode.id), edited, 'restoring the removed project must not roll back the new project');
  assert.deepEqual(f.effects, []);
});

test('background Store writers cannot bypass the archive transition or mutate an archived project behind HTTP guards', async (t) => {
  const f = await fixture(t), p = await project(f);
  for (const patch of [{ status: 'archived' }, { archivedAt: '2026-01-01T00:00:00.000Z' }]) {
    const before = persisted(f);
    assert.throws(() => f.store.updateEpisode(p.episode.id, patch, p.episode.version), { status: 400 });
    assert.deepEqual(persisted(f), before, 'Store episode patches must not inject removal state');
  }
  const archived = f.store.setEpisodeArchived(p.episode.id, true, p.episode.version);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.version, p.episode.version + 1);
  for (const patch of [{ title: 'Background overwrite' }, { status: 'draft' }, { scenes: p.episode.scenes }]) {
    const before = persisted(f);
    assert.throws(() => f.store.updateEpisode(p.episode.id, patch, archived.version), { status: 409 });
    assert.deepEqual(persisted(f), before, 'a background writer cannot silently unarchive or edit the project');
  }
  const restored = f.store.setEpisodeArchived(p.episode.id, false, archived.version);
  const edited = f.store.updateEpisode(p.episode.id, { title: 'Background edit after explicit restoration' }, restored.version);
  assert.equal(edited.title, 'Background edit after explicit restoration');
  assert.equal(edited.version, restored.version + 1);
  assert.equal(edited.status, 'draft');
  assert.equal(Object.hasOwn(edited, 'archivedAt'), false);
  assert.deepEqual((await json(await f.request(`${p.url}/history`), 200)).map((entry) => entry.version), [edited.version, restored.version, archived.version, p.episode.version]);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// This substitutes only the external browser transport; HTTP routing, session ownership,
// verified-export lookup, busy-work tracking and SQLite persistence remain real.
function offlineBrowser({ click = async () => {}, launch = async () => {}, screenshot } = {}) {
  const attachments = [];
  let currentUrl;
  const input = {
    first() { return this; },
    count: async () => 1,
    setInputFiles: async (filename) => { attachments.push(await readFile(filename)); },
    click,
  };
  const page = {
    goto: async (url) => { currentUrl = url; },
    url: () => currentUrl,
    locator: () => input,
    ...(screenshot ? { screenshot } : {}),
  };
  const context = { pages: () => [page], close: async () => {} };
  return {
    attachments,
    browserModule: { chromium: { launchPersistentContext: async () => { await launch(); return context; } } },
  };
}

test('an unbound non-YouTube browser session cannot attach a removed project through its verified export', async (t) => {
  const browser = offlineBrowser();
  const f = await fixture(t, { browserModule: browser.browserModule }), p = await project(f);
  const media = await retainedCandidate(f, p);
  const session = await json(await f.request('/api/platform-sessions', 'POST', {
    platform: 'other', url: 'http://127.0.0.1:1/offline-fixture',
  }), 201);
  await archive(f, p);
  const before = persisted(f);
  const response = await f.request(`/api/platform-sessions/${session.id}/interact`, 'POST', {
    action: 'attach-export', exportUrl: media.job.outputUrl, selector: '#upload',
  });
  const error = await json(response, 409);
  assert.match(error.error, /archiv/i, 'export-derived ownership must reject the archived episode, not rely on a pre-bound session');
  assert.deepEqual(browser.attachments, [], 'removed project bytes must never reach the browser file input');
  assert.deepEqual(persisted(f), before, 'rejected attachment must not bind the session, create publication records or change project history');
  assert.deepEqual(f.effects, []);
});

test('a click on an export-bound browser session blocks removal until the external action settles', async (t) => {
  const entered = deferred(), release = deferred();
  const browser = offlineBrowser({ click: async () => { entered.resolve(); await release.promise; } });
  const f = await fixture(t, { browserModule: browser.browserModule }), p = await project(f);
  const media = await retainedCandidate(f, p);
  const session = await json(await f.request('/api/platform-sessions', 'POST', {
    platform: 'other', url: 'http://127.0.0.1:1/offline-fixture',
  }), 201);
  await json(await f.request(`/api/platform-sessions/${session.id}/interact`, 'POST', {
    action: 'attach-export', exportUrl: media.job.outputUrl, selector: '#upload',
  }), 200);
  assert.deepEqual(browser.attachments, [media.renderBytes], 'the browser must receive the exact verified candidate before testing its bound action');
  const pending = f.request(`/api/platform-sessions/${session.id}/interact`, 'POST', {
    action: 'click', selector: '#submit',
  });
  try {
    await Promise.race([
      entered.promise,
      pending.then(async (response) => { throw new Error(`Click completed before reaching the controlled browser boundary: ${response.status} ${await response.clone().text()}`); }),
    ]);
    const before = persisted(f);
    const blocked = await f.request(`${p.url}/archive`, 'POST', { expectedVersion: p.episode.version });
    assert.equal(blocked.status, 409, 'an in-flight click inherited from export ownership must keep the project active');
    assert.deepEqual(persisted(f), before, 'removal must not archive the project or alter the pending session');
  } finally {
    release.resolve();
    await json(await pending, 200);
  }
  const archived = await archive(f, p);
  assert.equal(archived.version, p.episode.version + 1, 'busy rejection must not consume the version needed after the click settles');
  assert.equal(archived.status, 'archived');
  assert.deepEqual(f.effects, []);
});

test('lazy screenshot startup blocks archive while a cached browser remains inspectable after removal', async (t) => {
  const entered = deferred(), release = deferred();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0f8AAAAASUVORK5CYII=', 'base64');
  let launches = 0;
  const browser = offlineBrowser({
    launch: async () => { launches++; entered.resolve(); await release.promise; },
    screenshot: async () => png,
  });
  const f = await fixture(t, { browserModule: browser.browserModule }), p = await project(f);
  // Persisted sessions survive restart, while browser handles do not. Seeding the public
  // record reproduces the first inspection that must lazily acquire browser authority.
  const sessionFields = {
    episodeId: p.episode.id, channelId: p.channel.id, platform: 'other',
    url: 'http://127.0.0.1:1/offline-fixture', status: 'active', mode: 'persistent-chromium',
    browser: { available: false }, metadata: { title: p.episode.title, description: p.episode.topic, visibility: 'private' },
    attachedExport: null, attachmentStatus: 'none', publicationStatus: 'not_attempted', logs: [],
  };
  const session = f.store.create('platformSessions', sessionFields);
  const uncached = f.store.create('platformSessions', sessionFields);
  const screenshotUrl = `/api/platform-sessions/${session.id}/screenshot`;
  const pending = f.request(screenshotUrl);
  let first;
  try {
    await Promise.race([
      entered.promise,
      pending.then(async (response) => { throw new Error(`Screenshot completed before controlled browser launch: ${response.status} ${await response.clone().text()}`); }),
    ]);
    const before = persisted(f);
    assert.equal((await f.request(`${p.url}/archive`, 'POST', { expectedVersion: p.episode.version })).status, 409);
    assert.deepEqual(persisted(f), before, 'pending screenshot startup must block removal without changing project or saved sessions');
  } finally {
    release.resolve();
    first = await pending;
  }
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), png);
  const archived = await archive(f, p);
  assert.equal(archived.version, p.episode.version + 1, 'blocked removal must not consume a version');
  const beforeInspection = persisted(f);
  const cached = await f.request(screenshotUrl);
  assert.equal(cached.status, 200, 'an already live page is archived-safe read-only inspection');
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), png);
  assert.deepEqual(persisted(f), beforeInspection, 'cached inspection must not modify archived project state');
  const rejected = await json(await f.request(`/api/platform-sessions/${uncached.id}/screenshot`), 409);
  assert.match(rejected.error, /archiv/i);
  assert.equal(launches, 1, 'archived inspection must neither relaunch a cached browser nor start an uncached browser');
  assert.deepEqual(persisted(f), beforeInspection, 'uncached inspection must reject before writes or browser startup');
  assert.deepEqual(f.effects, []);
});

test('quote preflight blocks removal across schema and estimate awaits and never commits a stale plan', async (t) => {
  for (const boundary of ['modelSchema', 'estimate']) {
    for (const outcome of ['unchanged', 'edited']) await t.test(`${boundary}: ${outcome}`, async (t) => {
      const entered = deferred(), release = deferred();
      const gate = async (name) => {
        if (name === boundary) { entered.resolve(); await release.promise; }
      };
      const f = await fixture(t, { generation: {
        modelSchema: async () => {
          await gate('modelSchema');
          return { id: 'archive-quote-image', type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] };
        },
        estimate: async () => { await gate('estimate'); return { cost: 2.75, currency: 'USD' }; },
      } });
      const p = await project(f);
      const types = ['script', 'storyboard', 'generate', 'render', 'review'];
      const nodes = types.map((type, index) => ({
        id: type, type, x: index * 200, y: 0,
        config: type === 'script' ? { agent: 'existing' }
          : type === 'generate' ? { model: 'archive-quote-image', prompt: 'Quoted archived-project candidate', sceneId: p.episode.scenes[0].id }
            : {},
      }));
      p.workflow = await json(await f.request(`/api/workflows/${p.workflow.id}`, 'PUT', {
        name: 'Archive quote preflight', expectedVersion: p.workflow.version, nodes,
        edges: nodes.slice(1).map((node, index) => ({ id: `quote-edge-${index}`, source: nodes[index].id, target: node.id })),
      }), 200);
      const pending = f.request(`/api/workflows/${p.workflow.id}/quote`, 'POST', {
        episodeId: p.episode.id, expectedEpisodeVersion: p.episode.version, expectedWorkflowVersion: p.workflow.version,
        disclosure: { containsSyntheticMedia: true, rationale: 'Explicit synthetic fixture candidate disclosure' },
      });
      let result, beforeSettlement, current = p.episode;
      try {
        await Promise.race([
          entered.promise,
          pending.then(async (response) => { throw new Error(`Quote completed before controlled ${boundary}: ${response.status} ${await response.clone().text()}`); }),
        ]);
        const before = persisted(f);
        assert.equal((await f.request(`${p.url}/archive`, 'POST', { expectedVersion: p.episode.version })).status, 409);
        assert.deepEqual(persisted(f), before, `pending ${boundary} must block removal without consuming a version or creating a plan`);
        if (outcome === 'edited') {
          current = await json(await f.request(p.url, 'PUT', {
            expectedVersion: p.episode.version, notes: 'Editorial change made while quotation is pending',
          }), 200);
        }
        beforeSettlement = persisted(f);
      } finally {
        release.resolve();
        result = await pending;
      }
      if (outcome === 'edited') {
        const error = await json(result, 409);
        assert.match(error.error, /changed|version/i);
        assert.deepEqual(persisted(f), beforeSettlement, 'a quote for the old version must not persist a plan or audit event after the edit');
      } else {
        const plan = await json(result, 200);
        assert.equal(plan.episodeId, p.episode.id);
        assert.equal(plan.episodeVersion, current.version);
        assert.deepEqual(plan.aggregate, { quoted: true, totalCost: 2.75, currency: 'USD' });
        assert.deepEqual(f.store.get('generationPlans', plan.id), plan, 'successful quotation must persist the exact current-version plan');
      }
      const archived = await archive(f, p, current.version);
      assert.equal(archived.version, current.version + 1, 'success and rejection must both release the preflight blocker');
      assert.equal(archived.status, 'archived');
      assert.deepEqual(f.store.list('generationJobs'), [], 'quotation must never submit a paid generation');
      assert.deepEqual(f.store.list('workflowRuns'), [], 'quotation must never start workflow execution');
      assert.deepEqual(f.effects, []);
    });
  }
});
