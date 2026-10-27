import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

test('two recovery instances cannot overwrite a completed music import or register a second output', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'music-multi-recovery-'));
  const firstStore = new Store(root), secondStore = new Store(root), bytes = wav();
  const episode = firstStore.create('episodes', { title: 'Recovery race', topic: 'Music', channelId: firstStore.list('channels')[0].id, version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Scene', 'Text')] });
  const firstEntered = deferred(), secondEntered = deferred(), releaseFirst = deferred(), releaseSecond = deferred();
  let creates = 0, downloads = 0;
  const provider = {
    transport: 'api',
    modelSchema: async () => ({ id: 'music-fixture', type: 'audio', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    estimate: async () => ({ credits: 2.82 }),
    create: async () => { creates++; return { requestId: 'provider-race-1', transport: 'api', status: 'queued', outputs: [] }; },
    status: async () => ({ requestId: 'provider-race-1', transport: 'api', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/race.wav', type: 'audio' }] }),
  };
  const options = { provider, pollIntervalMs: 60000, probe: async () => ({ kind: 'audio', duration: 1, codecName: 'pcm_s16le' }), download: async (_url, file) => {
    const index = ++downloads;
    if (index === 1) { firstEntered.resolve(); await releaseFirst.promise; }
    else { secondEntered.resolve(); await releaseSecond.promise; }
    await writeFile(file, bytes, { flag: 'wx' });
    return { bytes: bytes.length, contentType: 'audio/wav' };
  } };
  const first = new GenerationQueue({ ...options, store: firstStore });
  const second = new GenerationQueue({ ...options, store: secondStore });
  t.after(async () => {
    releaseFirst.resolve(); releaseSecond.resolve();
    await Promise.all([first.close(), second.close()]);
    firstStore.close(); secondStore.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = { requestId: 'music-race-1', expectedVersion: episode.version, target: 'music', model: 'music-fixture', prompt: 'Fixture music', params: {} };
  const quote = await first.quoteMusic(episode.id, request);
  const job = await first.start(episode.id, { ...request, quoteId: quote.id, quoteFingerprint: quote.fingerprint, acceptedCredits: quote.credits });
  await first.process(job.id);
  assert.equal(creates, 1);

  const winningPoll = first.process(job.id);
  await firstEntered.promise;
  const competingPoll = second.process(job.id);
  await Promise.race([secondEntered.promise, competingPoll]);
  releaseFirst.resolve();
  await winningPoll;
  const winner = first.get(job.id);
  assert.equal(winner.status, 'completed');
  assert.equal(winner.outputs.length, 1);
  releaseSecond.resolve();
  await competingPoll;

  const final = second.get(job.id);
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.outputs, winner.outputs);
  assert.equal(secondStore.list('uploads').filter(upload => upload.generationJobId === job.id).length, 1);
  assert.equal(creates, 1, 'recovery never resubmits a paid generation');
  const output = final.outputs[0];
  firstStore.create('mediaRights', { uploadId: output.uploadId, sha256: output.sha256, origin: 'generated', generationJobId: job.id, acknowledgedAt: '2025-01-01T00:00:00.000Z' });
  const applied = second.apply(job.id, { expectedVersion: episode.version, outputUploadId: output.uploadId });
  assert.equal(applied.episode.music.assetUrl, output.url);
  assert.equal(applied.job.applied, true);
  assert.throws(() => first.apply(job.id, { expectedVersion: applied.episode.version, outputUploadId: output.uploadId }), { status: 409 });
  assert.equal(firstStore.get('episodes', episode.id).music.assetUrl, output.url);
});

for (const staleStatus of ['in_progress', 'failed']) test(`a stale ${staleStatus} poll cannot invalidate another instance importing a completed result`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'music-stale-poll-'));
  const firstStore = new Store(root), secondStore = new Store(root), bytes = wav();
  const episode = firstStore.create('episodes', { title: 'Stale poll', topic: 'Music', channelId: firstStore.list('channels')[0].id, version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Scene', 'Text')] });
  const staleEntered = deferred(), staleResponse = deferred(), downloadEntered = deferred(), releaseDownload = deferred();
  let polls = 0, creates = 0;
  const provider = {
    transport: 'api',
    create: async () => { creates++; throw new Error('recovery must not submit'); },
    status: async () => {
      if (++polls === 1) { staleEntered.resolve(); return staleResponse.promise; }
      return { requestId: 'provider-stale-1', transport: 'api', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/stale.wav', type: 'audio' }] };
    },
  };
  const options = { provider, pollIntervalMs: 60000, probe: async () => ({ kind: 'audio', duration: 1, codecName: 'pcm_s16le' }), download: async (_url, file) => {
    downloadEntered.resolve(); await releaseDownload.promise;
    await writeFile(file, bytes, { flag: 'wx' });
    return { bytes: bytes.length, contentType: 'audio/wav' };
  } };
  const first = new GenerationQueue({ ...options, store: firstStore });
  const second = new GenerationQueue({ ...options, store: secondStore });
  t.after(async () => {
    staleResponse.resolve({ requestId: 'provider-stale-1', transport: 'api', status: staleStatus, outputs: [] });
    releaseDownload.resolve();
    await Promise.all([first.close(), second.close()]);
    firstStore.close(); secondStore.close();
    await rm(root, { recursive: true, force: true });
  });
  const job = firstStore.create('generationJobs', { requestId: 'music-stale-1', episodeId: episode.id, episodeVersion: episode.version, target: 'music', model: 'music-fixture', prompt: 'Fixture music', params: {}, transport: 'api', mediaKind: 'audio', providerRequestId: 'provider-stale-1', status: 'pending', outputs: [], applied: false, pollStartedAt: new Date().toISOString() });
  const stale = first.process(job.id);
  await staleEntered.promise;
  const importing = second.process(job.id);
  await downloadEntered.promise;
  staleResponse.resolve({ requestId: 'provider-stale-1', transport: 'api', status: staleStatus, outputs: [] });
  await stale;
  releaseDownload.resolve();
  await importing;
  const completed = first.get(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outputs.length, 1);
  assert.equal(firstStore.list('uploads').filter(upload => upload.generationJobId === job.id).length, 1);
  assert.equal(creates, 0, 'polling a known provider request never resubmits');
});

test('expired import lease permits recovery without resubmission and rejects the former owner', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'music-lease-takeover-'));
  const firstStore = new Store(root), secondStore = new Store(root), bytes = wav();
  const episode = firstStore.create('episodes', { title: 'Lease recovery', topic: 'Music', channelId: firstStore.list('channels')[0].id, version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Scene', 'Text')] });
  const firstEntered = deferred(), releaseFirst = deferred();
  let time = Date.now(), creates = 0, polls = 0, downloads = 0;
  const provider = {
    transport: 'api',
    create: async () => { creates++; throw new Error('recovery must not submit'); },
    status: async id => { assert.equal(id, 'provider-lease-1'); polls++; return { requestId: id, transport: 'api', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/lease.wav', type: 'audio' }] }; },
  };
  const options = { provider, now: () => time, pollIntervalMs: 60000, probe: async () => ({ kind: 'audio', duration: 1, codecName: 'pcm_s16le' }), download: async (_url, file) => {
    if (++downloads === 1) { firstEntered.resolve(); await releaseFirst.promise; }
    await writeFile(file, bytes, { flag: 'wx' });
    return { bytes: bytes.length, contentType: 'audio/wav' };
  } };
  const first = new GenerationQueue({ ...options, store: firstStore });
  let restarted;
  t.after(async () => {
    releaseFirst.resolve();
    await Promise.all([first.close(), restarted?.close()]);
    firstStore.close(); secondStore.close();
    await rm(root, { recursive: true, force: true });
  });
  const job = firstStore.create('generationJobs', { requestId: 'music-lease-1', episodeId: episode.id, episodeVersion: episode.version, target: 'music', model: 'music-fixture', prompt: 'Fixture music', params: {}, transport: 'api', mediaKind: 'audio', providerRequestId: 'provider-lease-1', status: 'pending', outputs: [], applied: false, pollStartedAt: new Date(time).toISOString() });
  const oldOwner = first.process(job.id);
  await firstEntered.promise;
  restarted = new GenerationQueue({ ...options, store: secondStore });
  await restarted.process(job.id);
  assert.equal(downloads, 1, 'an unexpired lease prevents a competing import');
  time += 31 * 60 * 1000;
  await restarted.process(job.id);
  const winner = restarted.get(job.id);
  assert.equal(winner.status, 'completed');
  assert.equal(winner.outputs.length, 1);
  releaseFirst.resolve();
  await oldOwner;
  const final = first.get(job.id);
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.outputs, winner.outputs);
  assert.equal(firstStore.list('uploads').filter(upload => upload.generationJobId === job.id).length, 1);
  assert.deepEqual(await readdir(path.join(root, 'uploads')), [path.basename(winner.outputs[0].url)]);
  assert.equal(downloads, 2);
  assert.ok(polls >= 2, 'takeover rechecks the original provider request');
  assert.equal(creates, 0, 'lease takeover polls the original request rather than spending again');
});

test('a delayed in-progress poll cannot revert a terminal failed provider result', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'music-terminal-poll-'));
  const firstStore = new Store(root), secondStore = new Store(root);
  const episode = firstStore.create('episodes', { title: 'Terminal poll', topic: 'Music', channelId: firstStore.list('channels')[0].id, version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Scene', 'Text')] });
  const entered = deferred(), delayed = deferred();
  let polls = 0, creates = 0;
  const provider = {
    transport: 'api',
    create: async () => { creates++; throw new Error('recovery must not submit'); },
    status: async () => {
      if (++polls === 1) { entered.resolve(); return delayed.promise; }
      return { requestId: 'provider-terminal-1', transport: 'api', status: 'failed', outputs: [] };
    },
  };
  const first = new GenerationQueue({ store: firstStore, provider, pollIntervalMs: 60000 });
  const second = new GenerationQueue({ store: secondStore, provider, pollIntervalMs: 60000 });
  t.after(async () => {
    delayed.resolve({ requestId: 'provider-terminal-1', transport: 'api', status: 'in_progress', outputs: [] });
    await Promise.all([first.close(), second.close()]);
    firstStore.close(); secondStore.close();
    await rm(root, { recursive: true, force: true });
  });
  const job = firstStore.create('generationJobs', { requestId: 'music-terminal-1', episodeId: episode.id, episodeVersion: episode.version, target: 'music', model: 'music-fixture', prompt: 'Fixture music', params: {}, transport: 'api', mediaKind: 'audio', providerRequestId: 'provider-terminal-1', status: 'pending', outputs: [], applied: false, pollStartedAt: new Date().toISOString() });
  const stale = first.process(job.id);
  await entered.promise;
  await second.process(job.id);
  const failed = second.get(job.id);
  assert.equal(failed.status, 'failed');
  delayed.resolve({ requestId: 'provider-terminal-1', transport: 'api', status: 'in_progress', outputs: [] });
  await stale;
  const final = first.get(job.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.providerStatus, 'failed');
  assert.equal(final.error, failed.error);
  assert.deepEqual(final.outputs, []);
  assert.equal(creates, 0);
});

for (const expected of ['polling_failed', 'import_failed', 'manual_recovery']) test(`a delayed in-progress poll cannot erase ${expected}`, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'music-recovery-error-'));
  const firstStore = new Store(root), secondStore = new Store(root);
  const episode = firstStore.create('episodes', { title: 'Recovery error', topic: 'Music', channelId: firstStore.list('channels')[0].id, version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Scene', 'Text')] });
  const entered = deferred(), delayed = deferred();
  let polls = 0, creates = 0;
  const provider = {
    transport: 'api',
    create: async () => { creates++; throw new Error('recovery must not submit'); },
    status: async () => {
      if (++polls === 1) { entered.resolve(); return delayed.promise; }
      if (expected === 'polling_failed') throw new Error('fixture provider unavailable');
      return { requestId: 'provider-error-1', transport: 'api', status: expected === 'import_failed' ? 'completed' : 'unsupported', outputs: [{ url: 'https://images.higgs.ai/error.wav', type: 'audio' }] };
    },
  };
  const options = { provider, maxPollFailures: 1, pollIntervalMs: 60000, download: async () => { throw new Error('fixture import failure'); } };
  const first = new GenerationQueue({ ...options, store: firstStore });
  const second = new GenerationQueue({ ...options, store: secondStore });
  t.after(async () => {
    delayed.resolve({ requestId: 'provider-error-1', transport: 'api', status: 'in_progress', outputs: [] });
    await Promise.all([first.close(), second.close()]);
    firstStore.close(); secondStore.close();
    await rm(root, { recursive: true, force: true });
  });
  const job = firstStore.create('generationJobs', { requestId: 'music-error-1', episodeId: episode.id, episodeVersion: episode.version, target: 'music', model: 'music-fixture', prompt: 'Fixture music', params: {}, transport: 'api', mediaKind: 'audio', providerRequestId: 'provider-error-1', status: 'pending', outputs: [], applied: false, pollStartedAt: new Date().toISOString() });
  const stale = first.process(job.id);
  await entered.promise;
  await second.process(job.id);
  const stopped = second.get(job.id);
  assert.equal(stopped.status, expected);
  delayed.resolve({ requestId: 'provider-error-1', transport: 'api', status: 'in_progress', outputs: [] });
  await stale;
  const final = first.get(job.id);
  assert.equal(final.status, expected);
  assert.equal(final.error, stopped.error);
  assert.deepEqual(final.outputs, []);
  assert.equal(creates, 0);
});

test('explicit recovery is not corrupted by a failed response from the previous poll', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'music-recovery-epoch-'));
  const firstStore = new Store(root), secondStore = new Store(root), bytes = wav();
  const episode = firstStore.create('episodes', { title: 'Recovery epoch', topic: 'Music', channelId: firstStore.list('channels')[0].id, version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Scene', 'Text')] });
  const entered = deferred(), delayed = deferred();
  let polls = 0, creates = 0;
  const provider = {
    transport: 'api',
    create: async () => { creates++; throw new Error('recovery must not submit'); },
    status: async () => {
      if (++polls === 1) { entered.resolve(); return delayed.promise; }
      if (polls === 2) throw new Error('fixture polling failure');
      return { requestId: 'provider-epoch-1', transport: 'api', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/epoch.wav', type: 'audio' }] };
    },
  };
  const options = { provider, maxPollFailures: 1, pollIntervalMs: 60000, probe: async () => ({ kind: 'audio', duration: 1, codecName: 'pcm_s16le' }), download: async (_url, file) => { await writeFile(file, bytes, { flag: 'wx' }); return { bytes: bytes.length, contentType: 'audio/wav' }; } };
  const first = new GenerationQueue({ ...options, store: firstStore });
  const second = new GenerationQueue({ ...options, store: secondStore });
  t.after(async () => {
    delayed.resolve({ requestId: 'provider-epoch-1', transport: 'api', status: 'failed', outputs: [] });
    await Promise.all([first.close(), second.close()]);
    firstStore.close(); secondStore.close();
    await rm(root, { recursive: true, force: true });
  });
  const job = firstStore.create('generationJobs', { requestId: 'music-epoch-1', episodeId: episode.id, episodeVersion: episode.version, target: 'music', model: 'music-fixture', prompt: 'Fixture music', params: {}, transport: 'api', mediaKind: 'audio', providerRequestId: 'provider-epoch-1', status: 'pending', outputs: [], applied: false, pollStartedAt: new Date().toISOString() });
  const stale = first.process(job.id);
  await entered.promise;
  await second.process(job.id);
  assert.equal(second.get(job.id).status, 'polling_failed');
  assert.equal(second.recover(job.id).status, 'pending');
  delayed.resolve({ requestId: 'provider-epoch-1', transport: 'api', status: 'failed', outputs: [] });
  await stale;
  assert.equal(first.get(job.id).status, 'pending');
  await second.process(job.id);
  const completed = first.get(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outputs.length, 1);
  assert.equal(firstStore.list('uploads').filter(upload => upload.generationJobId === job.id).length, 1);
  assert.equal(creates, 0);
});

test('restart recovery ignores a failed response from a poll begun before restart', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'music-restart-epoch-'));
  const firstStore = new Store(root), secondStore = new Store(root), bytes = wav();
  const episode = firstStore.create('episodes', { title: 'Restart epoch', topic: 'Music', channelId: firstStore.list('channels')[0].id, version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Scene', 'Text')] });
  const entered = deferred(), delayed = deferred();
  let polls = 0, creates = 0;
  const provider = {
    transport: 'api',
    create: async () => { creates++; throw new Error('recovery must not submit'); },
    status: async () => {
      if (++polls === 1) { entered.resolve(); return delayed.promise; }
      if (polls === 2) throw new Error('fixture polling failure');
      return { requestId: 'provider-restart-1', transport: 'api', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/restart.wav', type: 'audio' }] };
    },
  };
  const options = { provider, maxPollFailures: 1, pollIntervalMs: 60000, probe: async () => ({ kind: 'audio', duration: 1, codecName: 'pcm_s16le' }), download: async (_url, file) => { await writeFile(file, bytes, { flag: 'wx' }); return { bytes: bytes.length, contentType: 'audio/wav' }; } };
  const first = new GenerationQueue({ ...options, store: firstStore });
  const second = new GenerationQueue({ ...options, store: secondStore });
  let restarted;
  t.after(async () => {
    delayed.resolve({ requestId: 'provider-restart-1', transport: 'api', status: 'failed', outputs: [] });
    await Promise.all([first.close(), second.close(), restarted?.close()]);
    firstStore.close(); secondStore.close();
    await rm(root, { recursive: true, force: true });
  });
  const job = firstStore.create('generationJobs', { requestId: 'music-restart-1', episodeId: episode.id, episodeVersion: episode.version, target: 'music', model: 'music-fixture', prompt: 'Fixture music', params: {}, transport: 'api', mediaKind: 'audio', providerRequestId: 'provider-restart-1', status: 'pending', outputs: [], applied: false, pollStartedAt: new Date().toISOString() });
  const stale = first.process(job.id);
  await entered.promise;
  await second.process(job.id);
  assert.equal(second.get(job.id).status, 'polling_failed');
  await second.close();
  restarted = new GenerationQueue({ ...options, store: secondStore });
  assert.equal(restarted.get(job.id).status, 'pending');
  delayed.resolve({ requestId: 'provider-restart-1', transport: 'api', status: 'failed', outputs: [] });
  await stale;
  assert.equal(first.get(job.id).status, 'pending');
  await restarted.process(job.id);
  const completed = first.get(job.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.outputs.length, 1);
  assert.equal(firstStore.list('uploads').filter(upload => upload.generationJobId === job.id).length, 1);
  assert.equal(creates, 0);
});
