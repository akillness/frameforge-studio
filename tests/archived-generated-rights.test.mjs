import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';

function wav() {
  const rate = 8000, bytes = Buffer.alloc(44 + rate * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(rate * 2, 40);
  return bytes;
}

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'archived-generated-rights-'));
  const server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations: { integrationStatus: async () => ({}) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(route, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  }
  async function episode(title) {
    const state = await call('/api/state');
    const result = await call('/api/episodes', { channelId: state.value.channels[0].id, title, topic: 'Generated audio rights' });
    assert.equal(result.status, 201, JSON.stringify(result.value));
    return result.value;
  }
  async function completedGeneration(episode, count = 1) {
    const store = new Store(dataDir);
    try {
      let job = store.create('generationJobs', { episodeId: episode.id, episodeVersion: episode.version, target: 'music', mediaKind: 'audio', status: 'completed', applied: false, outputs: [], requestId: randomUUID(), transport: 'api', model: 'music-fixture', prompt: 'fixture', params: {}, providerRequestId: randomUUID() });
      const outputs = [];
      for (let i = 0; i < count; i++) {
        const id = randomUUID(), filename = `${id}.wav`, bytes = wav();
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        await writeFile(path.join(dataDir, 'uploads', filename), bytes);
        const upload = { id, filename, url: `/api/uploads/${filename}`, name: 'fixture.wav', type: 'audio/wav', kind: 'audio', size: bytes.length, sha256, generationJobId: job.id, createdAt: new Date().toISOString() };
        store.save('uploads', upload);
        outputs.push({ uploadId: id, url: upload.url, type: upload.type, kind: upload.kind, size: upload.size, sha256 });
      }
      job = store.save('generationJobs', { ...job, outputs });
      return job;
    } finally { store.close(); }
  }
  return { call, episode, completedGeneration };
}

test('a stale active tab cannot create generated rights after another tab archives the episode', async t => {
  const f = await fixture(t), episode = await f.episode('Archive race');
  const job = await f.completedGeneration(episode, 2);
  const [cleared, uncleared] = job.outputs;
  const body = { origin: 'generated', generationJobId: job.id };
  const initial = await f.call(`/api/uploads/${cleared.uploadId}/rights`, body);
  assert.equal(initial.status, 201, JSON.stringify(initial.value));
  const beforeCleared = (await f.call(`/api/uploads/${cleared.uploadId}/rights`)).value;
  const beforeUncleared = (await f.call(`/api/uploads/${uncleared.uploadId}/rights`)).value;
  assert.deepEqual(beforeCleared, [initial.value]);
  assert.deepEqual(beforeUncleared, []);

  // Tab A retains the active snapshot; tab B archives before A submits either rights request.
  const staleVersion = episode.version;
  const archived = await f.call(`/api/episodes/${episode.id}/archive`, { expectedVersion: staleVersion });
  assert.equal(archived.status, 200, JSON.stringify(archived.value));
  assert.equal(archived.value.status, 'archived');
  assert.equal(archived.value.version, staleVersion + 1);
  for (const output of [cleared, uncleared]) {
    const denied = await f.call(`/api/uploads/${output.uploadId}/rights`, body);
    assert.equal(denied.status, 409, JSON.stringify(denied.value));
    assert.match(denied.value.error, /archiv/i);
  }
  assert.deepEqual((await f.call(`/api/uploads/${cleared.uploadId}/rights`)).value, beforeCleared);
  assert.deepEqual((await f.call(`/api/uploads/${uncleared.uploadId}/rights`)).value, beforeUncleared);
  assert.deepEqual((await f.call('/api/state')).value.episodes.find(item => item.id === episode.id), archived.value);
  const apply = await f.call(`/api/generations/${job.id}/apply`, { expectedVersion: staleVersion, outputUploadId: cleared.uploadId });
  assert.equal(apply.status, 409, JSON.stringify(apply.value));
  assert.equal((await f.call(`/api/generations/${job.id}`)).value.applied, false);
});

test('active generated audio saves rights and can be applied only to its own unchanged episode version', async t => {
  const f = await fixture(t), episode = await f.episode('Active generation');
  const job = await f.completedGeneration(episode), output = job.outputs[0];
  const rights = await f.call(`/api/uploads/${output.uploadId}/rights`, { origin: 'generated', generationJobId: job.id });
  assert.equal(rights.status, 201, JSON.stringify(rights.value));
  assert.equal(rights.value.uploadId, output.uploadId);
  assert.equal(rights.value.sha256, output.sha256);
  assert.equal(rights.value.generationJobId, job.id);
  assert.equal(rights.value.origin, 'generated');
  assert.deepEqual((await f.call(`/api/uploads/${output.uploadId}/rights`)).value, [rights.value]);

  const applied = await f.call(`/api/generations/${job.id}/apply`, { expectedVersion: episode.version, outputUploadId: output.uploadId });
  assert.equal(applied.status, 200, JSON.stringify(applied.value));
  assert.equal(applied.value.episode.version, episode.version + 1);
  assert.equal(applied.value.episode.music.assetUrl, output.url);
  assert.equal(applied.value.episode.music.source.generationJobId, job.id);
  const replay = await f.call(`/api/generations/${job.id}/apply`, { expectedVersion: applied.value.episode.version, outputUploadId: output.uploadId });
  assert.equal(replay.status, 409, JSON.stringify(replay.value));

  const other = await f.episode('Independent generation');
  const otherJob = await f.completedGeneration(other), otherOutput = otherJob.outputs[0];
  const otherRights = await f.call(`/api/uploads/${otherOutput.uploadId}/rights`, { origin: 'generated', generationJobId: otherJob.id });
  assert.equal(otherRights.status, 201, JSON.stringify(otherRights.value));
  const edit = await f.call(`/api/episodes/${other.id}`, { expectedVersion: other.version, notes: 'Edited after generation' }, 'PUT');
  assert.equal(edit.status, 200, JSON.stringify(edit.value));
  const stale = await f.call(`/api/generations/${otherJob.id}/apply`, { expectedVersion: edit.value.version, outputUploadId: otherOutput.uploadId });
  assert.equal(stale.status, 409, JSON.stringify(stale.value));
  const current = (await f.call('/api/state')).value.episodes.find(item => item.id === other.id);
  assert.deepEqual(current, edit.value);
  assert.equal((await f.call(`/api/generations/${otherJob.id}`)).value.applied, false);
});
