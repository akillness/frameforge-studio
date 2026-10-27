import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

function wav(frequency) {
  const rate = 8000, data = Buffer.alloc(44 + rate * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(rate * 2, 40);
  for (let i = 0; i < rate; i++) data.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  return data;
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'music-generation-api-'));
  const tracks = [wav(330), wav(660)];
  let now = Date.parse('2026-01-01T00:00:00Z'), creates = 0, polls = 0, credits = 2.82, failPoll = false;
  const results = tracks.map((_, i) => ({ url: `https://images.higgs.ai/track-${i}.wav?token=private`, type: 'audio' }));
  const generation = {
    transport: 'api', capability: async () => ({ available: true }), models: async () => [],
    modelSchema: async () => ({ id: 'music-fixture', type: 'audio', parameters: [{ name: 'prompt', type: 'string', required: true }, { name: 'duration', type: 'integer', minimum: 1, maximum: 30 }] }),
    estimate: async () => ({ credits }),
    create: async () => { creates++; return { requestId: 'provider-music-1', transport: 'api', status: 'queued', outputs: [] }; },
    status: async () => { polls++; if (failPoll) throw new Error('fixture polling failure'); return { requestId: 'provider-music-1', transport: 'api', status: 'completed', outputs: results }; },
  };
  let server, base;
  async function open() {
    server = createApp({ dataDir, loginToken: '', publicOrigin: '', generation, integrations: { integrationStatus: async () => ({}) }, generationOptions: {
      now: () => now, pollIntervalMs: 1, maxPollFailures: 1,
      download: async (url, filename) => { const index = results.findIndex(item => item.url === url); assert.notEqual(index, -1); const content = options.content ?? tracks[index]; await writeFile(filename, content, { flag: 'wx' }); return { bytes: content.length, contentType: options.contentType ?? 'audio/wav' }; },
    } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() { if (!server) return; const previous = server; server = undefined; await new Promise(resolve => { previous.close(resolve); previous.closeAllConnections(); }); }
  await open();
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  async function call(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const value = await response.json();
    return { status: response.status, value };
  }
  const state = (await call('/api/state')).value;
  const created = await call('/api/episodes', { channelId: state.channels[0].id, title: 'Music fixture', topic: 'Paid boundary' });
  assert.equal(created.status, 201);
  const episode = created.value;
  const request = { requestId: 'music-request-1', expectedVersion: episode.version, target: 'music', model: 'music-fixture', prompt: 'An instrumental fixture', params: { duration: 12 } };
  const root = `/api/episodes/${episode.id}/generations`;
  async function quote(input = request) { const response = await call(`${root}/quote`, input); assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value; }
  async function terminal(id) {
    for (let i = 0; i < 500; i++) {
      const result = await call(`/api/generations/${id}`);
      if (['completed', 'polling_failed', 'import_failed', 'submission_unknown', 'manual_recovery', 'failed'].includes(result.value.status)) return result.value;
    }
    assert.fail('generation did not reach a terminal state');
  }
  return { call, quote, terminal, request, root, episode, tracks, dataDir, close, open, setNow: value => { now = value; }, setCredits: value => { credits = value; }, setFailPoll: value => { failPoll = value; }, counts: () => ({ creates, polls }) };
}

function approved(request, quote) { return { ...request, quoteId: quote.id, quoteFingerprint: quote.fingerprint, acceptedCredits: quote.credits }; }

test('music quote binds approval to input and price; invalid or expired approval never submits', async t => {
  const f = await fixture(t), q = await f.quote();
  assert.equal(q.credits, 2.82);
  assert.ok(Number.isFinite(Date.parse(q.expiresAt)));
  const consent = approved(f.request, q);
  for (const [name, patch] of [
    ['no quote', { quoteId: undefined }], ['no fingerprint', { quoteFingerprint: undefined }],
    ['tampered fingerprint', { quoteFingerprint: 'forged' }], ['missing consent', { acceptedCredits: undefined }],
    ['changed credits', { acceptedCredits: 2.83 }], ['changed prompt', { prompt: 'A different request' }],
    ['changed model', { model: 'another-model' }], ['changed params', { params: { duration: 13 } }],
    ['scene instead of episode', { sceneId: f.episode.scenes[0].id }],
  ]) await t.test(name, async () => {
    const result = await f.call(f.root, { ...consent, ...patch });
    assert.ok(result.status >= 400, JSON.stringify(result));
    assert.equal(f.counts().creates, 0);
  });
  f.setCredits(3.5);
  assert.ok((await f.call(f.root, consent)).status >= 400, 'price changes invalidate consent');
  assert.equal(f.counts().creates, 0);
  f.setCredits(2.82);
  f.setNow(Date.parse(q.expiresAt) + 1);
  assert.ok((await f.call(f.root, consent)).status >= 400, 'expired quote cannot authorize spending');
  assert.equal(f.counts().creates, 0);
});

test('approved music is submitted once, imported as real WAV, and only an explicitly selected output with rights is applied', async t => {
  const f = await fixture(t), q = await f.quote(), consent = approved(f.request, q);
  const [first, duplicate] = await Promise.all([f.call(f.root, consent), f.call(f.root, consent)]);
  assert.equal(first.status, 202, JSON.stringify(first.value)); assert.equal(duplicate.status, 202);
  assert.equal(first.value.id, duplicate.value.id);
  const conflict = await f.call(f.root, { ...consent, prompt: 'Different music' });
  assert.equal(conflict.status, 409);
  const job = await f.terminal(first.value.id);
  assert.equal(job.status, 'completed', JSON.stringify(job));
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().polls, 1);
  assert.equal(job.outputs.length, 2);
  const uploads = (await f.call('/api/uploads')).value;
  for (let i = 0; i < 2; i++) {
    const upload = uploads.find(item => item.id === job.outputs[i].uploadId);
    assert.equal(upload.kind, 'audio'); assert.equal(upload.type, 'audio/wav'); assert.equal(upload.duration, 1);
    assert.equal(upload.sha256, createHash('sha256').update(f.tracks[i]).digest('hex'));
    assert.deepEqual(await readFile(path.join(f.dataDir, 'uploads', path.basename(upload.url))), f.tracks[i]);
  }
  const before = (await f.call('/api/state')).value.episodes.find(item => item.id === f.episode.id);
  assert.equal(before.version, f.episode.version); assert.deepEqual(before.scenes, f.episode.scenes);
  const selected = job.outputs[1];
  const apply = `/api/generations/${job.id}/apply`;
  assert.ok((await f.call(apply, { expectedVersion: before.version, outputUploadId: selected.uploadId })).status >= 400, 'generation is not rights clearance');
  const rights = await f.call(`/api/uploads/${selected.uploadId}/rights`, { origin: 'generated', generationJobId: job.id });
  assert.equal(rights.status, 201, JSON.stringify(rights.value));
  assert.equal(rights.value.sha256, createHash('sha256').update(f.tracks[1]).digest('hex'));
  assert.equal((await f.call(apply, { expectedVersion: before.version + 1, outputUploadId: selected.uploadId })).status, 409);
  const applied = await f.call(apply, { expectedVersion: before.version, outputUploadId: selected.uploadId });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal(applied.value.episode.version, before.version + 1);
  assert.equal(applied.value.episode.music.assetUrl, selected.url);
  assert.deepEqual(applied.value.episode.scenes, before.scenes);
  const history = (await f.call(`/api/episodes/${f.episode.id}/history`)).value;
  assert.deepEqual(history[0].snapshot.music, applied.value.episode.music);
  assert.equal((await f.call(apply, { expectedVersion: before.version + 1, outputUploadId: selected.uploadId })).status, 409);
});

test('poll failure survives restart and explicit recovery polls the original paid request without a second submission', async t => {
  const f = await fixture(t); f.setFailPoll(true);
  const q = await f.quote(), consent = approved(f.request, q);
  const started = await f.call(f.root, consent); assert.equal(started.status, 202, JSON.stringify(started.value));
  const failed = await f.terminal(started.value.id);
  assert.equal(failed.status, 'polling_failed'); assert.equal(failed.providerRequestId, 'provider-music-1');
  await f.close(); f.setFailPoll(false); await f.open();
  const same = await f.call(f.root, consent); assert.equal(same.value.id, started.value.id);
  const recovered = await f.call(`/api/generations/${started.value.id}/recover`, {});
  assert.equal(recovered.status, 202, JSON.stringify(recovered.value));
  const completed = await f.terminal(started.value.id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.providerRequestId, 'provider-music-1');
  assert.equal(f.counts().creates, 1);
});

test('audio import rejects wrong MIME and disguised playlists without leaving registered media', async t => {
  for (const [name, options] of [
    ['wrong MIME', { contentType: 'image/png' }],
    ['playlist disguised as WAV', { content: Buffer.from('#EXTM3U\nhttp://127.0.0.1/private\n') }],
  ]) await t.test(name, async t => {
    const f = await fixture(t, options), q = await f.quote();
    const started = await f.call(f.root, approved(f.request, q));
    assert.equal(started.status, 202, JSON.stringify(started.value));
    const failed = await f.terminal(started.value.id);
    assert.equal(failed.status, 'import_failed');
    assert.equal(failed.providerRequestId, 'provider-music-1');
    assert.deepEqual((await f.call('/api/uploads')).value, []);
    assert.equal(f.counts().creates, 1);
  });
});
