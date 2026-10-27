import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function wav() {
  const rate = 8000, bytes = Buffer.alloc(44 + rate * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(rate * 2, 40); return bytes;
}

async function fixture(t, { create } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'music-cross-client-'));
  const bytes = wav();
  let creates = 0;
  const generation = {
    transport: 'api', capability: async () => ({ available: true }), models: async () => [],
    modelSchema: async () => ({ id: 'music-fixture', type: 'audio', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    estimate: async () => ({ credits: 2.82 }),
    create: async () => { creates++; return create ? create(creates) : { requestId: `provider-${creates}`, transport: 'api', status: 'queued', outputs: [] }; },
    status: async requestId => ({ requestId, transport: 'api', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/music.wav', type: 'audio' }] }),
  };
  const server = createApp({ dataDir, loginToken: '', publicOrigin: '', generation, integrations: { integrationStatus: async () => ({}) }, generationOptions: {
    pollIntervalMs: 1,
    probe: async () => ({ kind: 'audio', duration: 1, codecName: 'pcm_s16le' }),
    download: async (_url, filename) => { await writeFile(filename, bytes, { flag: 'wx' }); return { bytes: bytes.length, contentType: 'audio/wav' }; },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  }
  async function episode(title) {
    const state = await call('/api/state');
    const result = await call('/api/episodes', { channelId: state.value.channels[0].id, title, topic: 'Paid generation' });
    assert.equal(result.status, 201, JSON.stringify(result.value));
    return result.value;
  }
  function request(episode, requestId) { return { requestId, expectedVersion: episode.version, target: 'music', model: 'music-fixture', prompt: 'Instrumental music', params: {} }; }
  async function quote(episode, input) {
    const result = await call(`/api/episodes/${episode.id}/generations/quote`, input);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return { ...input, quoteId: result.value.id, quoteFingerprint: result.value.fingerprint, acceptedCredits: result.value.credits };
  }
  async function terminal(id) {
    for (let i = 0; i < 500; i++) {
      const result = await call(`/api/generations/${id}`);
      assert.equal(result.status, 200);
      if (['completed', 'submission_unknown', 'failed', 'polling_failed', 'import_failed', 'manual_recovery'].includes(result.value.status)) return result.value;
    }
    assert.fail('generation did not reach a terminal state');
  }
  return { call, episode, request, quote, terminal, creates: () => creates };
}

test('a completed music candidate cannot be applied to a later episode version', async t => {
  const f = await fixture(t), episode = await f.episode('Version binding');
  const input = await f.quote(episode, f.request(episode, 'version-binding'));
  const started = await f.call(`/api/episodes/${episode.id}/generations`, input);
  assert.equal(started.status, 202, JSON.stringify(started.value));
  const job = await f.terminal(started.value.id);
  assert.equal(job.status, 'completed', JSON.stringify(job));
  const output = job.outputs[0];
  const rights = await f.call(`/api/uploads/${output.uploadId}/rights`, { origin: 'generated', generationJobId: job.id });
  assert.equal(rights.status, 201, JSON.stringify(rights.value));
  const changed = await f.call(`/api/episodes/${episode.id}`, { expectedVersion: episode.version, notes: 'Edited after generation' }, 'PUT');
  assert.equal(changed.status, 200, JSON.stringify(changed.value));
  assert.equal(changed.value.version, episode.version + 1);
  const applied = await f.call(`/api/generations/${job.id}/apply`, { expectedVersion: changed.value.version, outputUploadId: output.uploadId });
  assert.equal(applied.status, 409, JSON.stringify(applied.value));
  const state = await f.call('/api/state');
  const current = state.value.episodes.find(item => item.id === episode.id);
  assert.equal(current.version, changed.value.version);
  assert.equal(current.notes, 'Edited after generation');
  assert.deepEqual(current.music, changed.value.music);
  assert.equal((await f.call(`/api/generations/${job.id}`)).value.applied, false);
});

test('an unknown submission blocks a different client quote and its previously approved purchase, but not another episode', async t => {
  const f = await fixture(t, { create: async count => { if (count === 1) throw new Error('connection lost after submission'); return { requestId: 'provider-independent', transport: 'api', status: 'queued', outputs: [] }; } });
  const episode = await f.episode('Unknown outcome'), root = `/api/episodes/${episode.id}/generations`;
  const first = await f.quote(episode, f.request(episode, 'client-a'));
  const secondRequest = f.request(episode, 'client-b');
  const secondApproval = await f.quote(episode, secondRequest);
  const started = await f.call(root, first);
  assert.equal(started.status, 202, JSON.stringify(started.value));
  const unknown = await f.terminal(started.value.id);
  assert.equal(unknown.status, 'submission_unknown', JSON.stringify(unknown));
  assert.equal(f.creates(), 1);
  assert.equal((await f.call(`${root}/quote`, secondRequest)).status, 409);
  assert.equal((await f.call(root, secondApproval)).status, 409);
  const duplicate = await f.call(root, first);
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.value.id, started.value.id);
  assert.equal(f.creates(), 1);
  const independent = await f.episode('Independent episode');
  const independentInput = await f.quote(independent, f.request(independent, 'client-other-episode'));
  const independentJob = await f.call(`/api/episodes/${independent.id}/generations`, independentInput);
  assert.equal(independentJob.status, 202, JSON.stringify(independentJob.value));
  const completed = await f.terminal(independentJob.value.id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(f.creates(), 2);
});

test('overlapping approved requests for one target never both reach the provider when the first outcome is unknown', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, { create: async () => { entered.resolve(); await release.promise; throw new Error('submission result lost'); } });
  const episode = await f.episode('Concurrent clients'), root = `/api/episodes/${episode.id}/generations`;
  const first = await f.quote(episode, f.request(episode, 'race-client-a'));
  const second = await f.quote(episode, f.request(episode, 'race-client-b'));
  const started = await f.call(root, first);
  assert.equal(started.status, 202, JSON.stringify(started.value));
  await entered.promise;
  const competing = await f.call(root, second);
  assert.ok([202, 409].includes(competing.status), JSON.stringify(competing.value));
  release.resolve();
  const unknown = await f.terminal(started.value.id);
  assert.equal(unknown.status, 'submission_unknown', JSON.stringify(unknown));
  if (competing.status === 202) {
    const other = await f.terminal(competing.value.id);
    assert.notEqual(other.status, 'completed');
  }
  assert.equal(f.creates(), 1, 'a queued or concurrent request must not create a second paid submission');
});
