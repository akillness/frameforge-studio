import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, starterScene } from '../server/store.mjs';
import { GenerationQueue } from '../server/generations.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function wav() {
  const rate = 8000, bytes = Buffer.alloc(44 + rate * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(rate * 2, 40); return bytes;
}
async function fixture(t, { create, contentType = 'audio/wav' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'music-generation-recovery-'));
  const store = new Store(root), bytes = wav();
  const episode = store.create('episodes', { title: 'Recovery', topic: 'Music', channelId: store.list('channels')[0].id, version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Scene', 'Text')] });
  let creates = 0, polls = 0;
  const output = { requestId: 'provider-music-1', transport: 'api', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/music.wav', type: 'audio' }] };
  const provider = {
    transport: 'api', modelSchema: async () => ({ id: 'music-fixture', type: 'audio', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    estimate: async () => ({ credits: 2.82 }),
    create: async () => { creates++; return create ? create() : { ...output, status: 'queued', outputs: [] }; },
    status: async () => { polls++; return output; },
  };
  const queues = [];
  const makeQueue = () => { const queue = new GenerationQueue({ store, provider, pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, bytes, { flag: 'wx' }); return { bytes: bytes.length, contentType }; } }); queues.push(queue); return queue; };
  t.after(async () => { for (const queue of queues) queue.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const request = { requestId: 'music-recovery-1', expectedVersion: 1, target: 'music', model: 'music-fixture', prompt: 'Fixture music', params: {} };
  const queue = makeQueue(), quote = await queue.quoteMusic(episode.id, request);
  const input = { ...request, quoteId: quote.id, quoteFingerprint: quote.fingerprint, acceptedCredits: quote.credits };
  return { queue, makeQueue, episode, input, counts: () => ({ creates, polls }) };
}

test('an approved queued intent interrupted before submission resumes exactly once', async t => {
  const f = await fixture(t);
  const job = await f.queue.start(f.episode.id, f.input);
  f.queue.close();
  assert.equal(f.counts().creates, 0);
  const restarted = f.makeQueue();
  const completed = await restarted.wait(job.id, { timeoutMs: 3000 });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.providerRequestId, 'provider-music-1');
  assert.equal(f.counts().creates, 1);
});

test('a provider identifier received during shutdown remains recoverable without a second submission', async t => {
  const entered = deferred(), response = deferred();
  const f = await fixture(t, { create: () => { entered.resolve(); return response.promise; } });
  const job = await f.queue.start(f.episode.id, f.input);
  const processing = f.queue.process(job.id);
  await entered.promise;
  f.queue.close();
  response.resolve({ requestId: 'provider-music-1', transport: 'api', status: 'queued', outputs: [] });
  await processing;
  const restarted = f.makeQueue();
  const completed = await restarted.wait(job.id, { timeoutMs: 3000 });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.providerRequestId, 'provider-music-1');
  assert.equal(f.counts().creates, 1);
  assert.equal(f.counts().polls, 1);
});

test('audio/x-wav provider output imports as real WAV instead of failing after the paid submission', async t => {
  const f = await fixture(t, { contentType: 'audio/x-wav' });
  const job = await f.queue.start(f.episode.id, f.input);
  const completed = await f.queue.wait(job.id, { timeoutMs: 3000 });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outputs[0].kind, 'audio');
  assert.equal(completed.outputs[0].duration, 1);
  assert.equal(f.counts().creates, 1);
});
