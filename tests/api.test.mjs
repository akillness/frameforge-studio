import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { scenes } from '../server/validation.mjs';

const integrations = {
  integrationStatus: async () => ({ studio: { available: true }, codex: { available: false } }),
  runAgent: async () => { throw Object.assign(new Error('no bridge'), { code: 'UNAVAILABLE' }); },
  fetchTrends: async () => ({ trends: [{ keyword: 'verified fixture', source: 'Test source', url: 'https://example.com/research' }], sources: [{ name: 'fixture', status: 'ok' }] }),
};

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-api-'));
  let server = createApp({ dataDir, integrations, ...options });
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
    restart: async () => { await close(); server = createApp({ dataDir, integrations, ...options }); base = await start(); },
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
