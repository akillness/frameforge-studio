import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, requireAdmin } from '../server/app.mjs';
import { Store, starterScene } from '../server/store.mjs';
import { scenes } from '../server/validation.mjs';

const exportProjection = graph => ({
  nodes: graph.nodes.map(({ editable, edit, readOnlyReason, ...node }) => node),
  edges: graph.edges.map(({ editable, edit, readOnlyReason, ...edge }) => edge),
  atoms: graph.atoms,
});

const integrations = {
  integrationStatus: async () => ({ studio: { available: true }, codex: { available: false } }),
  runAgent: async () => { throw Object.assign(new Error('no bridge'), { code: 'UNAVAILABLE' }); },
  fetchTrends: async () => ({ trends: [{ keyword: 'verified fixture', source: 'Test source', url: 'https://example.com/research' }], sources: [{ name: 'fixture', status: 'ok' }] }),
};

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-api-'));
  let server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations, ...options });
  const start = async () => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
  let base = await start();
  const close = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir,
    request: (path, method = 'GET', body, headers = {}) => fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    raw: (path, options) => fetch(base + path, options),
    rawHttp: (path, headers) => new Promise((resolve, reject) => {
      const request = http.get(base + path, { headers }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    }),
    restart: async () => { await close(); server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations, ...options }); base = await start(); },
  };
}

async function episode(f) {
  const state = await (await f.request('/api/state')).json();
  return (await f.request('/api/episodes', 'POST', { channelId: state.channels[0].id, title: '검증 에피소드', topic: '정보의 출처' })).json();
}

test('persistent CRUD snapshots, version conflicts, topic graph and valid OKF atoms', async (t) => {
  const f = await fixture(t);
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.channels.length, 1);
  assert.equal(state.channels[0].sample, true);
  assert.equal(state.templates.length, 3);
  const created = await episode(f);
  const saved = await f.request(`/api/episodes/${created.id}`, 'PUT', { title: '수정한 제목', expectedVersion: 1 });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).version, 2);
  assert.equal((await f.request(`/api/episodes/${created.id}`, 'PUT', { title: 'stale', expectedVersion: 1 })).status, 409);
  const history = await (await f.request(`/api/episodes/${created.id}/history`)).json();
  assert.equal(history.length, 2);
  assert.equal(history[1].snapshot.title, '검증 에피소드');
  await f.restart();
  const resumed = await (await f.request('/api/state')).json();
  assert.equal(resumed.episodes[0].title, '수정한 제목');
  assert.equal(resumed.episodes[0].version, 2);
  const knowledge = await (await f.request('/api/knowledge')).json();
  assert.ok(knowledge.edges.some((edge) => edge.source === created.id && edge.target === created.channelId));
  assert.ok(knowledge.nodes.some((node) => node.type === 'topic'));
  const atom = await readFile(join(f.dataDir, 'knowledge', 'atoms', `${created.id}.md`), 'utf8');
  assert.match(atom, /^---\ntype: "episode"\ntitle:/);
  assert.match(atom, /\ndescription: /);
});

test('validation rejects unknown channels, unsafe URLs and malformed scene structures without history changes', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/episodes', 'POST', { channelId: 'missing', title: 'a', topic: 'b' })).status, 404);
  assert.equal((await f.request('/api/channels', 'POST', { name: 'a', category: 'b', platform: 'YouTube', accountEmail: 'invalid' })).status, 400);
  assert.equal((await f.request('/api/references', 'POST', { title: 'a', category: 'b', url: 'javascript:alert(1)' })).status, 400);
  const created = await episode(f);
  for (const patch of [
    { scenes: [] },
    { scenes: [{ ...created.scenes[0], duration: -1 }] },
    { scenes: [{ ...created.scenes[0], background: 'red' }] },
    { scenes: [{ ...created.scenes[0], assetUrl: 'http://127.0.0.1/secrets' }] },
    { scenes: [{ ...created.scenes[0], kind: 'image' }] },
    { scenes: [created.scenes[0], created.scenes[0]] },
    { expectedVersion: '1', title: 'x' },
    { status: 'published' },
  ]) assert.equal((await f.request(`/api/episodes/${created.id}`, 'PUT', patch)).status, 400);
  assert.equal((await (await f.request(`/api/episodes/${created.id}/history`)).json()).length, 1);
  assert.equal((await f.raw('/api/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' })).status, 400);
  assert.equal((await f.raw('/api/channels', { method: 'POST', body: '{}' })).status, 415);
});

test('templates and deterministic studio edits are durable; unavailable agents return explicit failure', async (t) => {
  const f = await fixture(t);
  const created = await episode(f);
  const state = await (await f.request('/api/state')).json();
  const applied = await (await f.request(`/api/episodes/${created.id}/template`, 'POST', { templateId: state.templates[0].id })).json();
  assert.equal(applied.scenes.length, 3);
  assert.equal(applied.version, 2);
  const chat = await (await f.request(`/api/episodes/${created.id}/chat`, 'POST', { agent: 'studio', message: '신뢰할 수 있는 출처를 소개하는 정보 영상' })).json();
  assert.equal(chat.episode.scenes.length, 3);
  assert.equal(chat.episode.version, 3);
  assert.match(chat.message, /규칙 기반/);
  assert.equal((await f.request(`/api/episodes/${created.id}/chat`, 'POST', { agent: 'codex', message: 'help' })).status, 503);
  const command = await (await f.request('/api/commands', 'POST', { message: '보고서를 갱신하세요', source: 'aside', sessionId: '9XBgVHBJYEGclLhz' })).json();
  await f.restart();
  const commands = await (await f.request('/api/commands')).json();
  assert.equal(commands[0].id, command.id);
  assert.equal(commands[0].status, 'received');
});

test('authentication protects API/media, enforces same-origin writes, and invalidates logout sessions', async (t) => {
  const f = await fixture(t, { loginToken: 'test-secret-is-long-enough' });
  assert.equal((await f.request('/api/health')).status, 200);
  assert.equal((await f.request('/api/state')).status, 401);
  assert.equal((await f.request('/api/uploads/unknown.mp4')).status, 401);
  assert.equal((await f.request('/api/login', 'POST', { token: 'bad' })).status, 401);
  assert.equal((await f.request('/api/login', 'POST', { token: 'test-secret-is-long-enough' }, { Origin: 'https://evil.example' })).status, 403);
  const login = await f.request('/api/login', 'POST', { token: 'test-secret-is-long-enough' });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await f.request('/api/state', 'GET', undefined, { Cookie: cookie })).status, 200);
  assert.equal((await f.request('/api/commands', 'POST', { message: 'bad' }, { Cookie: cookie, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/logout', 'POST', {}, { Cookie: cookie })).status, 200);
  assert.equal((await f.request('/api/state', 'GET', undefined, { Cookie: cookie })).status, 401);
});

test('admin policy rejects unauthenticated and non-admin principals without issuing privileged sessions', () => {
  for (const session of [undefined, {}, { authenticated: false, role: 'admin' }]) assert.throws(() => requireAdmin(session), { status: 401 });
  for (const role of [undefined, null, 'viewer', 'owner', 'ADMIN']) assert.throws(() => requireAdmin({ authenticated: true, role, canMutate: true }), { status: 403 });
  assert.doesNotThrow(() => requireAdmin({ authenticated: true, role: 'admin' }));
});

test('every dashboard mutation is authenticated before dispatch and client role claims grant no access', async (t) => {
  const f = await fixture(t, { loginToken: 'isolated-admin-fixture-token' });
  assert.deepEqual(await (await f.request('/api/session')).json(), { authenticated: false, role: null, canMutate: false });
  const routes = [
    ['POST', '/api/logout'], ['POST', '/api/uploads?name=fixture.png'], ['POST', '/api/trends/refresh'],
    ['POST', '/api/channels'], ['POST', '/api/episodes'], ['PUT', '/api/episodes/fixture'],
    ['POST', '/api/templates'], ['POST', '/api/references'], ['POST', '/api/trends'], ['POST', '/api/commands'],
    ['POST', '/api/episodes/fixture/template'], ['POST', '/api/episodes/fixture/chat'],
    ['POST', '/api/episodes/fixture/render'], ['POST', '/api/episodes/fixture/narration'], ['POST', '/api/episodes/fixture/restore'],
    ['POST', '/api/workflows'], ['PUT', '/api/workflows/fixture'], ['POST', '/api/workflows/fixture/run'],
    ['POST', '/api/workflows/fixture/restore'], ['POST', '/api/workflows/fixture/runs/run/cancel'], ['POST', '/api/workflows/fixture/runs/run/review'],
    ['POST', '/api/workflows/fixture/copies'],
    ['POST', '/api/generation/estimate'], ['POST', '/api/episodes/fixture/generations'],
    ['POST', '/api/generations/fixture/apply'], ['POST', '/api/generations/fixture/recover'], ['POST', '/api/generations/fixture/normalize'],
    ['POST', '/api/trends/settings'], ['PUT', '/api/trends/settings'], ['POST', '/api/trends/select'],
    ['PUT', '/api/knowledge/nodes/fixture'], ['PUT', '/api/knowledge/edges'], ['DELETE', '/api/knowledge/nodes/fixture'],
  ];
  for (const [method, path] of routes) {
    const response = await f.request(path, method, { role: 'admin', authenticated: true, canMutate: true }, { 'X-Role': 'admin' });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  assert.equal((await f.request('/api/login', 'POST', { role: 'admin', authenticated: true })).status, 401);
  const login = await f.request('/api/login', 'POST', { token: 'isolated-admin-fixture-token', role: 'viewer' });
  assert.deepEqual(await login.json(), { authenticated: true, role: 'admin', canMutate: true });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.deepEqual(await (await f.request('/api/session', 'GET', undefined, headers)).json(), { authenticated: true, role: 'admin', canMutate: true });
  assert.deepEqual((await (await f.request('/api/state', 'GET', undefined, headers)).json()).session, { authenticated: true, role: 'admin', canMutate: true });
  for (const path of ['/api/knowledge/nodes/fixture', '/api/knowledge/edges']) {
    assert.equal((await f.request(path, 'PUT', {}, { ...headers, Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await f.request(path, 'PUT', {}, { ...headers, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  }
});

test('admin graph node edits persist canonical records, audit, history, media and regenerated exports across restart', async (t) => {
  const f = await fixture(t, { loginToken: 'isolated-graph-admin-token' });
  const login = async () => {
    const response = await f.request('/api/login', 'POST', { token: 'isolated-graph-admin-token' });
    assert.equal(response.status, 200);
    return { Cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  let headers = await login();
  const request = (path, method = 'GET', body) => f.request(path, method, body, headers);
  const before = await (await request('/api/state')).json();
  const channel = before.channels[0];
  const unrelated = await (await request('/api/episodes', 'POST', { channelId: channel.id, title: 'Unrelated episode', topic: 'Keep this subject' })).json();
  const created = await (await request('/api/episodes', 'POST', { channelId: channel.id, title: 'Original graph episode', topic: 'Orphan subject after edit' })).json();
  const uploadResponse = await f.raw('/api/uploads?name=fixture.png', { method: 'POST', headers, body: Buffer.from('preserved graph media') });
  assert.equal(uploadResponse.status, 201);
  const upload = await uploadResponse.json();
  const withMedia = await (await request(`/api/episodes/${created.id}`, 'PUT', { expectedVersion: 1, scenes: [{ ...created.scenes[0], kind: 'image', assetUrl: upload.url }] })).json();
  const graph = await (await request('/api/knowledge')).json();
  const oldTopic = graph.nodes.find((node) => node.type === 'topic' && node.label === created.topic);
  const channelNode = graph.nodes.find((node) => node.id === channel.id);
  const channelResponse = await request(`/api/knowledge/nodes/${channel.id}`, 'PUT', { label: 'Renamed canonical channel', expectedRecord: channelNode.edit.expectedRecord });
  assert.equal(channelResponse.status, 200);
  const channelEdit = await channelResponse.json();
  assert.equal(channelEdit.record.name, 'Renamed canonical channel');
  assert.equal(channelEdit.record.category, channel.category);
  assert.equal(channelEdit.graph.nodes.find((node) => node.id === channel.id).label, channelEdit.record.name);
  assert.equal((await request(`/api/knowledge/nodes/${channel.id}`, 'PUT', { label: 'Stale channel write', expectedRecord: channelNode.edit.expectedRecord })).status, 409);
  const episodeResponse = await request(`/api/knowledge/nodes/${created.id}`, 'PUT', { label: 'Canonical graph title', topic: 'New canonical subject', expectedVersion: withMedia.version });
  assert.equal(episodeResponse.status, 200);
  const edited = await episodeResponse.json();
  assert.equal(edited.record.title, 'Canonical graph title');
  assert.equal(edited.record.topic, 'New canonical subject');
  assert.equal(edited.record.version, withMedia.version + 1);
  assert.deepEqual(edited.record.scenes, withMedia.scenes);
  assert.equal(edited.graph.nodes.some((node) => node.id === oldTopic.id), false);
  assert.equal((await request(`/api/knowledge/nodes/${created.id}`, 'PUT', { label: 'Stale episode write', expectedVersion: withMedia.version })).status, 409);
  const state = await (await request('/api/state')).json();
  assert.deepEqual(state.episodes.find((item) => item.id === unrelated.id), unrelated);
  assert.deepEqual(state.templates, before.templates);
  assert.ok(state.events.some((event) => event.type === 'channels.updated' && event.entityId === channel.id && event.actorRole === 'admin' && event.reason === 'knowledge edited'));
  assert.ok(state.events.some((event) => event.type === 'episodes.updated' && event.entityId === created.id && event.actorRole === 'admin' && event.version === edited.record.version && event.reason === 'knowledge edited'));
  const history = await (await request(`/api/episodes/${created.id}/history`)).json();
  assert.equal(history.length, 3);
  assert.equal(history[0].reason, 'knowledge edited');
  assert.deepEqual(history[0].snapshot, edited.record);
  assert.equal(history.at(-1).snapshot.title, created.title);
  const db = new DatabaseSync(join(f.dataDir, 'studio.sqlite'), { readOnly: true });
  try {
    const source = (kind, id) => JSON.parse(db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind, id).data);
    assert.deepEqual(source('episodes', created.id), edited.record);
    assert.deepEqual(source('channels', channel.id), channelEdit.record);
  } finally { db.close(); }
  const exported = JSON.parse(await readFile(join(f.dataDir, 'knowledge', 'graph.json'), 'utf8'));
  assert.deepEqual(exported, exportProjection(edited.graph));
  assert.ok(exported.nodes.every(node => !('editable' in node) && !('edit' in node) && !('readOnlyReason' in node)));
  assert.ok(exported.edges.every(edge => !('editable' in edge) && !('edit' in edge) && !('readOnlyReason' in edge)));
  assert.match(await readFile(join(f.dataDir, 'knowledge', 'atoms', `${created.id}.md`), 'utf8'), /Canonical graph title[\s\S]*New canonical subject/);
  assert.match(await readFile(join(f.dataDir, 'knowledge', 'atoms', `${channel.id}.md`), 'utf8'), /Renamed canonical channel/);
  assert.equal((await readdir(join(f.dataDir, 'knowledge', 'atoms'))).includes(`${oldTopic.id}.md`), false);
  assert.equal(await (await request(upload.url)).text(), 'preserved graph media');
  await f.restart();
  headers = await login();
  const resumed = await (await request('/api/state')).json();
  assert.deepEqual(resumed.episodes.find((item) => item.id === created.id), edited.record);
  assert.deepEqual(resumed.channels.find((item) => item.id === channel.id), channelEdit.record);
  assert.equal((await (await request(`/api/episodes/${created.id}/history`)).json()).length, 3);
  assert.equal(await (await request(upload.url)).text(), 'preserved graph media');
});

test('graph relationship edits update only canonical episode channel and topic with version conflicts', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request('/api/session')).json(), { authenticated: true, role: 'admin', canMutate: true });
  const original = await episode(f);
  const channel = await (await f.request('/api/channels', 'POST', { name: 'Relation target', category: 'information', platform: 'YouTube' })).json();
  const other = await (await f.request('/api/episodes', 'POST', { channelId: channel.id, title: 'Other subject source', topic: 'Existing target topic' })).json();
  const graph = await (await f.request('/api/knowledge')).json();
  const sourceTopic = graph.nodes.find((node) => node.type === 'topic' && node.label === original.topic);
  const targetTopic = graph.nodes.find((node) => node.type === 'topic' && node.label === other.topic);
  const channelEdge = { source: original.id, target: original.channelId, relation: 'belongs_to', newTarget: channel.id, expectedVersion: 1 };
  const response = await f.request('/api/knowledge/edges', 'PUT', channelEdge);
  assert.equal(response.status, 200);
  const channelEdit = await response.json();
  assert.equal(channelEdit.record.channelId, channel.id);
  assert.equal(channelEdit.record.version, 2);
  assert.equal(channelEdit.graph.edges.some((edge) => edge.source === original.id && edge.target === original.channelId), false);
  assert.ok(channelEdit.graph.edges.some((edge) => edge.source === original.id && edge.target === channel.id && edge.editable));
  assert.equal((await f.request('/api/knowledge/edges', 'PUT', { ...channelEdge, target: channel.id, newTarget: original.channelId })).status, 409);
  const topicResponse = await f.request('/api/knowledge/edges', 'PUT', { source: original.id, target: sourceTopic.id, relation: 'belongs_to', newTarget: targetTopic.id, expectedVersion: 2 });
  assert.equal(topicResponse.status, 200);
  const topicEdit = await topicResponse.json();
  assert.equal(topicEdit.record.topic, other.topic);
  assert.equal(topicEdit.record.version, 3);
  assert.equal(topicEdit.graph.nodes.some((node) => node.id === sourceTopic.id), false);
  const state = await (await f.request('/api/state')).json();
  assert.deepEqual(state.episodes.find((item) => item.id === other.id), other);
  assert.deepEqual(state.episodes.find((item) => item.id === original.id), topicEdit.record);
  assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'knowledge', 'graph.json'), 'utf8')), exportProjection(topicEdit.graph));
  assert.equal((await readdir(join(f.dataDir, 'knowledge', 'atoms'))).includes(`${sourceTopic.id}.md`), false);
  assert.equal((await (await f.request(`/api/episodes/${original.id}/history`)).json()).length, 3);
});

test('invalid and read-only graph node or relation edits reject without source, history or export mutation', async (t) => {
  const f = await fixture(t);
  const created = await episode(f);
  await f.request('/api/references', 'POST', { channelId: created.channelId, title: 'Read-only reference', category: 'information', url: 'https://example.com/reference' });
  await f.request('/api/trends', 'POST', { keyword: 'Read-only trend', source: 'fixture', url: 'https://example.com/trend' });
  const graph = await (await f.request('/api/knowledge')).json();
  const before = await (await f.request('/api/state')).json();
  const exportBefore = await readFile(join(f.dataDir, 'knowledge', 'graph.json'), 'utf8');
  for (const node of graph.nodes.filter((node) => !node.editable)) {
    assert.match(node.readOnlyReason, /.+/);
    assert.equal((await f.request(`/api/knowledge/nodes/${node.id}`, 'PUT', { label: 'Forbidden', expectedVersion: 1 })).status, 400, node.type);
  }
  const nodePath = `/api/knowledge/nodes/${created.id}`;
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await f.request(nodePath, method, {})).status, 400, method);
  assert.equal((await f.request('/api/knowledge/nodes/invalid%20id', 'PUT', { label: 'Invalid', expectedVersion: 1 })).status, 400);
  for (const body of [
    {}, { label: 'Missing version' }, { label: 'Wrong version type', expectedVersion: '1' }, { label: 'Zero version', expectedVersion: 0 },
    { expectedVersion: 1 }, { topic: '', expectedVersion: 1 }, { label: 'x'.repeat(201), expectedVersion: 1 },
    { channelId: 'unknown', expectedVersion: 1 }, { label: 'No role override', expectedVersion: 1, role: 'admin' },
    { title: 'Wrong field', expectedVersion: 1 }, { scenes: created.scenes, expectedVersion: 1 },
  ]) assert.equal((await f.request(nodePath, 'PUT', body)).status, 400, JSON.stringify(body));
  assert.equal((await f.request('/api/knowledge/nodes/unknown', 'PUT', { label: 'Unknown', expectedVersion: 1 })).status, 400);
  for (const body of [{ label: 'Missing token' }, { label: 'Bad token', expectedRecord: 'abc' }, { label: '', expectedRecord: graph.nodes.find((node) => node.id === created.channelId).edit.expectedRecord }]) {
    assert.equal((await f.request(`/api/knowledge/nodes/${created.channelId}`, 'PUT', body)).status, 400);
  }
  const edge = graph.edges.find((item) => item.source === created.id && item.target === created.channelId);
  for (const body of [
    {}, { ...edge, newTarget: created.channelId, expectedVersion: 1 },
    { source: created.id, target: created.channelId, relation: 'unknown', newTarget: created.channelId, expectedVersion: 1 },
    { source: created.id, target: created.channelId, relation: 'belongs_to', newTarget: created.id, expectedVersion: 1 },
    { source: created.id, target: created.channelId, relation: 'belongs_to', newTarget: 'missing', expectedVersion: 1 },
    { source: created.id, target: created.channelId, relation: 'belongs_to', newTarget: created.channelId },
  ]) assert.equal((await f.request('/api/knowledge/edges', 'PUT', body)).status, 400);
  const readOnlyEdge = graph.edges.find((item) => !item.editable);
  assert.ok(readOnlyEdge?.readOnlyReason);
  assert.equal((await f.request('/api/knowledge/edges', 'PUT', { source: readOnlyEdge.source, target: readOnlyEdge.target, relation: readOnlyEdge.relation, newTarget: created.channelId, expectedVersion: 1 })).status, 400);
  assert.deepEqual(await (await f.request('/api/state')).json(), before);
  assert.equal((await (await f.request(`/api/episodes/${created.id}/history`)).json()).length, 1);
  assert.equal(await readFile(join(f.dataDir, 'knowledge', 'graph.json'), 'utf8'), exportBefore);
});

test('graph edits roll back canonical records and history when audit fails; channel fingerprints detect same-timestamp changes', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-graph-atomic-'));
  const store = new Store(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const channel = store.list('channels')[0];
  const created = store.create('episodes', { channelId: channel.id, title: 'Atomic original', topic: 'Atomic topic', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [starterScene('Original scene', 'Original text')], notes: '' });
  const generation = store.create('generationJobs', { episodeId: created.id, episodeVersion: 1, model: 'fixture', transport: 'fixture', status: 'completed', outputs: [{ uploadId: 'fixture-asset', kind: 'image', sha256: 'a'.repeat(64), url: '/api/uploads/fixture.png' }] });
  const graph = store.knowledge();
  for (const node of graph.nodes.filter((node) => ['generation', 'asset'].includes(node.type))) {
    assert.equal(node.editable, false);
    assert.match(node.readOnlyReason, /.+/);
    assert.throws(() => store.editKnowledgeNode(node.id, { label: 'Forbidden', expectedVersion: 1 }), { status: 400 });
  }
  for (const edge of graph.edges.filter((item) => item.source === generation.id || item.source === 'fixture-asset')) {
    assert.equal(edge.editable, false);
    assert.throws(() => store.editKnowledgeEdge({ source: edge.source, target: edge.target, relation: edge.relation, newTarget: channel.id, expectedVersion: 1 }), { status: 400 });
  }
  const graphBefore = await readFile(join(dataDir, 'knowledge', 'graph.json'), 'utf8');
  const eventsBefore = store.list('events');
  const historyBefore = store.history(created.id);
  const token = graph.nodes.find((node) => node.id === channel.id).edit.expectedRecord;
  const record = store.record;
  store.record = () => { throw new Error('Injected isolated audit failure'); };
  try {
    assert.throws(() => store.editKnowledgeNode(created.id, { label: 'Must roll back', topic: 'Must also roll back', expectedVersion: 1 }), /Injected isolated audit failure/);
    assert.throws(() => store.editKnowledgeNode(channel.id, { label: 'Must roll back', expectedRecord: token }), /Injected isolated audit failure/);
  } finally { store.record = record; }
  assert.deepEqual(store.get('episodes', created.id), created);
  assert.deepEqual(store.get('channels', channel.id), channel);
  assert.deepEqual(store.history(created.id), historyBefore);
  assert.deepEqual(store.list('events'), eventsBefore);
  assert.equal(await readFile(join(dataDir, 'knowledge', 'graph.json'), 'utf8'), graphBefore);
  store.save('channels', { ...channel, name: 'Concurrent same-time rename' });
  assert.equal(store.get('channels', channel.id).updatedAt, channel.updatedAt);
  assert.throws(() => store.editKnowledgeNode(channel.id, { label: 'Lost update attempt', expectedRecord: token }), { status: 409 });
  assert.equal(store.get('channels', channel.id).name, 'Concurrent same-time rename');
  const freshToken = store.knowledge().nodes.find((node) => node.id === channel.id).edit.expectedRecord;
  assert.notEqual(freshToken, token);
  assert.equal(store.editKnowledgeNode(channel.id, { label: 'Reconciled name', expectedRecord: freshToken }).name, 'Reconciled name');
});

test('uploads use safe generated names and media supports byte ranges while rejecting unsafe paths', async (t) => {
  const f = await fixture(t);
  const response = await f.raw('/api/uploads?name=sample.png', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('sample-media-fixture') });
  assert.equal(response.status, 201);
  const upload = await response.json();
  assert.match(upload.url, /^\/api\/uploads\/[0-9a-f-]+\.png$/);
  assert.equal(await (await f.request(upload.url)).text(), 'sample-media-fixture');
  const range = await f.request(upload.url, 'GET', undefined, { Range: 'bytes=0-5' });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'sample');
  assert.equal((await f.request(upload.url, 'GET', undefined, { Range: 'bytes=999-1000' })).status, 416);
  for (const name of ['../secret.png', 'secret.html', 'nul.png', 'C:secret.png']) {
    const rejected = await f.raw(`/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', body: 'bad' });
    assert.ok([400, 415].includes(rejected.status), name);
  }
  assert.equal((await f.request('/api/uploads/%2e%2e%5cstudio.sqlite')).status, 400);
  const created = await episode(f);
  assert.equal((await f.request(`/api/episodes/${created.id}`, 'PUT', { scenes: [{ ...created.scenes[0], kind: 'image', assetUrl: upload.url }] })).status, 200);
  assert.equal((await f.request(`/api/episodes/${created.id}`, 'PUT', { scenes: [{ ...created.scenes[0], kind: 'video', assetUrl: upload.url }] })).status, 400);
});

test('async render queue records version and completion; failures stay failed', async (t) => {
  let count = 0;
  const f = await fixture(t, { renderer: async (episode, { dataDir, onProgress }) => {
    count += 1;
    if (count > 1) throw new Error('intentional test failure');
    onProgress(50);
    const filename = 'test-render.mp4';
    await writeFile(join(dataDir, 'exports', filename), 'fake-render-test-fixture');
    return { filename, outputUrl: `/api/exports/${filename}` };
  } });
  const created = await episode(f);
  const start = await f.request(`/api/episodes/${created.id}/render`, 'POST', {});
  assert.equal(start.status, 202);
  const job = await start.json();
  const poll = async (id) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const state = await (await f.request('/api/state')).json();
      const current = state.jobs.find((item) => item.id === id);
      if (['completed', 'failed'].includes(current.status)) return current;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Job did not finish');
  };
  const completed = await poll(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.episodeVersion, 1);
  assert.equal((await f.request(completed.outputUrl)).status, 200);
  const failed = await (await f.request(`/api/episodes/${created.id}/render`, 'POST', {})).json();
  assert.equal((await poll(failed.id)).status, 'failed');
});

test('research refresh deduplicates source keyword and returns explicit source status', async (t) => {
  const f = await fixture(t);
  const first = await (await f.request('/api/trends/refresh', 'POST')).json();
  assert.equal(first.sources[0].status, 'ok');
  await f.request('/api/trends/refresh', 'POST');
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.trends.length, 1);
  assert.equal(state.trends[0].keyword, 'verified fixture');
});

test('development host guard rejects DNS rebinding and JSON limits reject oversized requests', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.rawHttp('/api/state', { Host: 'untrusted.example' }), 403);
  const oversized = await f.request('/api/commands', 'POST', { message: 'x'.repeat(1024 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal((await (await f.request('/api/commands')).json()).length, 0);
});

test('late agent responses cannot overwrite concurrent edits and invalid bridge output is rejected', async (t) => {
  let release, announce;
  const started = new Promise((resolve) => { announce = resolve; });
  const response = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { integrations: { ...integrations, runAgent: async () => { announce(); return response; } } });
  const created = await episode(f);
  const pending = f.request(`/api/episodes/${created.id}/chat`, 'POST', { agent: 'codex', message: 'edit the scene' });
  await started;
  await f.request(`/api/episodes/${created.id}`, 'PUT', { title: 'Concurrent editor wins', expectedVersion: 1 });
  release({ message: 'Updated', scenes: created.scenes });
  assert.equal((await pending).status, 409);
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.episodes[0].title, 'Concurrent editor wins');
  assert.equal(state.episodes[0].version, 2);
  const invalid = await fixture(t, { integrations: { ...integrations, runAgent: async () => ({ message: 'Unsafe output', scenes: [{ ...created.scenes[0], assetUrl: 'file:///etc/passwd' }] }) } });
  const target = await episode(invalid);
  assert.equal((await invalid.request(`/api/episodes/${target.id}/chat`, 'POST', { agent: 'codex', message: 'edit' })).status, 400);
  assert.equal((await (await invalid.request(`/api/episodes/${target.id}/history`)).json()).length, 1);
});

test('restart marks unfinished render jobs as failed instead of claiming completion', async (t) => {
  let finish;
  const wait = new Promise((resolve) => { finish = resolve; });
  const f = await fixture(t, { renderer: async () => { await wait; return { filename: 'delayed.mp4', outputUrl: '/api/exports/delayed.mp4' }; } });
  const created = await episode(f);
  const job = await (await f.request(`/api/episodes/${created.id}/render`, 'POST', {})).json();
  await f.restart();
  const state = await (await f.request('/api/state')).json();
  assert.equal(state.jobs.find((item) => item.id === job.id).status, 'failed');
  finish();
});

test('scene trimming and audio controls validate bounds and preserve legacy defaults', () => {
  const base = { title: 'Scene', text: 'Text', duration: 2, background: '#123456', kind: 'title', layout: 'center' };
  const legacy = scenes([base])[0];
  assert.equal(legacy.trimStart, 0);
  assert.equal(legacy.audioVolume, 1);
  assert.equal(legacy.audioUrl, undefined);
  const upper = scenes([{ ...base, trimStart: 36000, audioVolume: 2 }])[0];
  assert.equal(upper.trimStart, 36000);
  assert.equal(upper.audioVolume, 2);
  assert.equal(scenes([{ ...base, audioVolume: 0 }])[0].audioVolume, 0);
  for (const patch of [
    { trimStart: -0.1 }, { trimStart: 36000.1 }, { trimStart: '2' }, { trimStart: null }, { trimStart: Infinity }, { trimStart: NaN },
    { audioVolume: -0.1 }, { audioVolume: 2.1 }, { audioVolume: '1' }, { audioVolume: null }, { audioVolume: Infinity },
    { audioUrl: 'https://example.com/audio.mp3' }, { audioUrl: '/api/uploads/../../secret.wav' },
    { audioUrl: '/api/uploads/11111111-1111-1111-1111-111111111111.mp4' },
  ]) assert.throws(() => scenes([{ ...base, ...patch }]), { status: 400 });
});

test('uploaded scene audio and trim persist through episode edits and templates; unknown audio is rejected', async (t) => {
  const f = await fixture(t);
  const video = await (await f.raw('/api/uploads?name=clip.mp4', { method: 'POST', body: 'video-api-fixture' })).json();
  const audio = await (await f.raw('/api/uploads?name=voice.wav', { method: 'POST', body: 'audio-api-fixture' })).json();
  const created = await episode(f);
  const scene = { ...created.scenes[0], kind: 'video', assetUrl: video.url, trimStart: 2.5, audioUrl: audio.url, audioVolume: 0.65 };
  const saved = await (await f.request(`/api/episodes/${created.id}`, 'PUT', { scenes: [scene], expectedVersion: 1 })).json();
  assert.equal(saved.scenes[0].trimStart, 2.5);
  assert.equal(saved.scenes[0].audioUrl, audio.url);
  assert.equal(saved.scenes[0].audioVolume, 0.65);
  const templateResponse = await f.request('/api/templates', 'POST', { name: 'Voice template', category: 'information', format: '9:16', scenes: [scene] });
  assert.equal(templateResponse.status, 201);
  const template = await templateResponse.json();
  assert.equal(template.scenes[0].audioUrl, audio.url);
  for (const patch of [
    { audioUrl: '/api/uploads/11111111-1111-1111-1111-111111111111.wav' },
    { audioUrl: video.url }, { trimStart: -2 }, { audioVolume: 20 },
  ]) assert.equal((await f.request(`/api/episodes/${created.id}`, 'PUT', { scenes: [{ ...scene, ...patch }] })).status, 400);
  assert.equal((await (await f.request(`/api/episodes/${created.id}/history`)).json()).length, 2);
  await f.restart();
  const restored = await (await f.request('/api/state')).json();
  assert.equal(restored.episodes[0].scenes[0].trimStart, 2.5);
  assert.equal(restored.episodes[0].scenes[0].audioVolume, 0.65);
  const applied = await (await f.request(`/api/episodes/${created.id}/template`, 'POST', { templateId: template.id })).json();
  assert.equal(applied.scenes[0].audioUrl, audio.url);
});
