import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, starterScene } from '../server/store.mjs';
import { GenerationQueue } from '../server/generations.mjs';
import { createHiggsfieldCli } from '../server/higgsfield-cli.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function wav() {
  const rate = 8000, bytes = Buffer.alloc(44 + rate * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(rate * 2, 40); return bytes;
}
async function fixture(t, { blockSchemaCall, blockEstimateCall, changedSchemaCall } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'music-authorization-race-'));
  const store = new Store(dataDir), entered = deferred(), release = deferred(), bytes = wav();
  let now = Date.parse('2026-01-01T00:00:00Z'), schemaCalls = 0, estimateCalls = 0, creates = 0;
  const schema = { job_type: 'music_fixture', type: 'audio', params: [{ name: 'prompt', type: 'string', required: true }] };
  const provider = createHiggsfieldCli({ now: () => now, execute: async args => {
    if (args[0] === 'model' && args[1] === 'list') return { stdout: JSON.stringify([{ job_type: 'music_fixture', type: 'audio' }]) };
    if (args[0] === 'model' && args[1] === 'get') { schemaCalls++; if (schemaCalls === blockSchemaCall) { entered.resolve(); await release.promise; } return { stdout: JSON.stringify(schemaCalls === changedSchemaCall ? { ...schema, rules: [{ type: 'fixture-changed' }] } : schema) }; }
    if (args[0] === 'generate' && args[1] === 'cost') { estimateCalls++; if (estimateCalls === blockEstimateCall) { entered.resolve(); await release.promise; } return { stdout: JSON.stringify({ credits: 2.82 }) }; }
    if (args[0] === 'generate' && args[1] === 'create') { creates++; return { stdout: JSON.stringify(['cli-provider-1']) }; }
    if (args[0] === 'generate' && args[1] === 'get') return { stdout: JSON.stringify({ id: 'cli-provider-1', status: 'completed', result_url: 'https://images.higgs.ai/music.wav' }) };
    throw new Error(`Unexpected fixture command ${args.join(' ')}`);
  } });
  const episode = store.create('episodes', { title: 'Authorization race', topic: 'Fixture', channelId: store.list('channels')[0].id, version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Scene', 'Text')] });
  const queues = [];
  const makeQueue = () => { const queue = new GenerationQueue({ store, provider, now: () => now, pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, bytes, { flag: 'wx' }); return { bytes: bytes.length, contentType: 'audio/wav' }; } }); queues.push(queue); return queue; };
  t.after(async () => { release.resolve(); for (const queue of queues) queue.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const queue = makeQueue(), request = { requestId: 'music-race-1', expectedVersion: 1, target: 'music', transport: 'cli', model: 'music_fixture', prompt: 'Original instrumental', params: {} };
  const quote = await queue.quoteMusic(episode.id, request);
  const job = await queue.start(episode.id, { ...request, quoteId: quote.id, quoteFingerprint: quote.fingerprint, acceptedCredits: quote.credits });
  return { queue, makeQueue, quote, job, entered, release, setNow: value => { now = value; }, creates: () => creates };
}

test('CLI schema discovery cannot submit after the approved quote expires', async t => {
  // Each quote and revalidation performs one queue schema lookup plus one CLI estimate schema lookup.
  const f = await fixture(t, { blockSchemaCall: 7 });
  const processing = f.queue.process(f.job.id);
  await f.entered.promise;
  f.setNow(Date.parse(f.quote.expiresAt) + 1);
  f.release.resolve(); await processing;
  assert.equal(f.creates(), 0);
  assert.notEqual(f.queue.get(f.job.id).status, 'completed');
});

test('shutdown during pre-submission quote revalidation resumes the same approved intent without an unknown submission', async t => {
  const f = await fixture(t, { blockEstimateCall: 3 });
  const processing = f.queue.process(f.job.id);
  await f.entered.promise;
  f.queue.close(); f.release.resolve(); await processing;
  assert.equal(f.creates(), 0);
  const restarted = f.makeQueue();
  const completed = await restarted.wait(f.job.id, { timeoutMs: 3000 });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.providerRequestId, 'cli-provider-1');
  assert.equal(f.creates(), 1);
});

test('CLI schema change after queue revalidation rejects the approved request before submission', async t => {
  const f = await fixture(t, { changedSchemaCall: 7 });
  await f.queue.process(f.job.id);
  assert.equal(f.creates(), 0);
  assert.notEqual(f.queue.get(f.job.id).status, 'completed');
});
