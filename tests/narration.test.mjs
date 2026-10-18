import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, starterScene } from '../server/store.mjs';
import { NarrationQueue } from '../server/narration.mjs';

const capability = { available: true, provider: 'fixture-speech', voices: [{ id: 'Fixture Korean' }] };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function wav(duration = 1) {
  const bytes = Math.ceil(duration * 8000) * 2;
  const data = Buffer.alloc(44 + bytes);
  data.write('RIFF'); data.writeUInt32LE(36 + bytes, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(bytes, 40);
  return data;
}

async function settle(queue) {
  const end = Date.now() + 5000;
  while (queue.running || (!queue.closed && queue.queue.length)) {
    assert.ok(Date.now() < end, 'Narration queue did not settle');
    await delay(10);
  }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-narration-'));
  const store = new Store(root);
  const episode = store.create('episodes', { title: 'Voice test', topic: 'Test subject',
    channelId: store.list('channels')[0].id, format: '9:16', status: 'draft', version: 1,
    scenes: [{ ...starterScene('First', 'Fallback speech'), duration: 1, narration: 'Explicit narration', trimStart: 0, audioVolume: 1 },
      { ...starterScene('Second', 'Keep this scene'), duration: 5, trimStart: 0, audioVolume: 1 }] });
  const queue = new NarrationQueue({ store, listVoices: async () => capability,
    synthesize: async ({ outputPath }) => { await writeFile(outputPath, wav(3.25)); return { duration: 3.25 }; }, ...options });
  t.after(async () => { queue.close(); await settle(queue); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, episode, queue, request: { expectedVersion: 1, voice: 'Fixture Korean', sceneIds: [episode.scenes[0].id] } };
}

async function assertNoCandidates({ root, store }) {
  assert.deepEqual(store.list('uploads'), []);
  assert.deepEqual(await readdir(path.join(root, 'uploads')), []);
  assert.deepEqual(await readdir(path.join(root, 'narration-work')), []);
}

test('narration applies versioned audio atomically, extends duration and preserves unselected scenes', async t => {
  const calls = [];
  const f = await fixture(t, { synthesize: async args => { calls.push(args); await writeFile(args.outputPath, wav(3.25)); return { duration: 3.25 }; } });
  const job = await f.queue.start(f.episode.id, f.request);
  await settle(f.queue);
  const result = f.store.get('narrationJobs', job.id), updated = f.store.get('episodes', f.episode.id);
  assert.equal(result.status, 'completed'); assert.equal(result.progress, 100); assert.equal(result.resultVersion, 2);
  assert.equal(updated.version, 2); assert.equal(updated.scenes[0].duration, 3.5);
  assert.equal(calls[0].text, 'Explicit narration'); assert.equal(calls[0].voice, 'Fixture Korean');
  assert.deepEqual(updated.scenes[1], f.episode.scenes[1]);
  const [upload] = f.store.list('uploads');
  assert.equal(updated.scenes[0].audioUrl, upload.url); assert.equal(upload.generated, true);
  assert.equal((await readFile(path.join(f.root, 'uploads', upload.filename))).toString('ascii', 0, 4), 'RIFF');
  assert.deepEqual(f.store.history(f.episode.id).map(item => [item.version, item.reason]), [[2, 'narration'], [1, 'created']]);
  assert.equal(f.store.list('events').filter(item => item.type === 'episodes.narration').length, 1);
  assert.deepEqual(await readdir(path.join(f.root, 'narration-work')), []);
});

test('concurrent episode edit rejects stale audio and cleans all generated candidates', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { synthesize: async ({ outputPath }) => { await writeFile(outputPath, wav()); entered.resolve(); await release.promise; return { duration: 1 }; } });
  const job = await f.queue.start(f.episode.id, f.request); await entered.promise;
  const edited = f.store.updateEpisode(f.episode.id, { scenes: f.episode.scenes.map(scene => ({ ...scene, text: 'Newer user edit' })) }, 1);
  release.resolve(); await settle(f.queue);
  assert.equal(f.store.get('narrationJobs', job.id).status, 'failed');
  assert.match(f.store.get('narrationJobs', job.id).error, /Episode changed/);
  assert.deepEqual(f.store.get('episodes', f.episode.id), edited);
  assert.equal(f.store.history(f.episode.id).length, 2); await assertNoCandidates(f);
});

test('concurrent voice discovery and active synthesis reject duplicate starts', async t => {
  const voicesEntered = deferred(), voicesRelease = deferred(), synthesisEntered = deferred(), synthesisRelease = deferred();
  const f = await fixture(t, { listVoices: async () => { voicesEntered.resolve(); await voicesRelease.promise; return capability; },
    synthesize: async ({ outputPath }) => { synthesisEntered.resolve(); await synthesisRelease.promise; await writeFile(outputPath, wav()); return { duration: 1 }; } });
  const first = f.queue.start(f.episode.id, f.request); await voicesEntered.promise;
  await assert.rejects(f.queue.start(f.episode.id, f.request), error => error.status === 409);
  voicesRelease.resolve(); await first; await synthesisEntered.promise;
  await assert.rejects(f.queue.start(f.episode.id, f.request), error => error.status === 409);
  synthesisRelease.resolve(); await settle(f.queue);
  assert.equal(f.store.list('narrationJobs').length, 1); assert.equal(f.store.list('uploads').length, 1);
});

test('unsupported voices and unavailable capability never create jobs or invoke synthesis', async t => {
  let calls = 0;
  const f = await fixture(t, { synthesize: async () => { calls++; } });
  await assert.rejects(f.queue.start(f.episode.id, { ...f.request, voice: 'Missing voice' }), error => error.status === 400);
  f.queue.listVoices = async () => ({ available: false, voices: [] });
  await assert.rejects(f.queue.start(f.episode.id, f.request), error => error.status === 503);
  assert.equal(calls, 0); assert.equal(f.queue.pendingEpisodes.size, 0); assert.deepEqual(f.store.list('narrationJobs'), []);
});

test('shutdown prevents late synthesis from writing episode, uploads, history or job completion', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { synthesize: async ({ outputPath }) => { await writeFile(outputPath, wav()); entered.resolve(); await release.promise; return { duration: 1 }; } });
  const job = await f.queue.start(f.episode.id, f.request); await entered.promise;
  f.queue.close();
  const savedJob = f.store.get('narrationJobs', job.id), events = f.store.list('events');
  release.resolve(); await settle(f.queue);
  assert.deepEqual(f.store.get('narrationJobs', job.id), savedJob);
  assert.deepEqual(f.store.get('episodes', f.episode.id), f.episode);
  assert.equal(f.store.history(f.episode.id).length, 1); assert.deepEqual(f.store.list('events'), events);
  await assertNoCandidates(f);
  await assert.rejects(f.queue.start(f.episode.id, f.request), error => error.status === 503);
});

test('restart fails persisted queued/running narration jobs and preserves completed jobs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-narration-restart-'));
  let store = new Store(root);
  const jobs = ['queued', 'running', 'completed'].map(status => store.create('narrationJobs', { episodeId: 'fixture', status }));
  store.close(); store = new Store(root);
  const queue = new NarrationQueue({ store });
  t.after(async () => { queue.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  for (const job of jobs.slice(0, 2)) { assert.equal(store.get('narrationJobs', job.id).status, 'failed'); assert.match(store.get('narrationJobs', job.id).error, /Server restarted/); }
  assert.deepEqual(store.get('narrationJobs', jobs[2].id), jobs[2]);
});

test('provider failure after writing a WAV cleans partial files and leaves no partial upload transaction', async t => {
  let calls = 0;
  const f = await fixture(t, { synthesize: async ({ outputPath, workDir }) => {
    await writeFile(outputPath, wav()); await writeFile(path.join(workDir, 'temporary.json'), '{}');
    if (++calls === 2) throw new Error('fixture provider failure');
    return { duration: 1 };
  } });
  const job = await f.queue.start(f.episode.id, { ...f.request, sceneIds: f.episode.scenes.map(scene => scene.id) }); await settle(f.queue);
  assert.equal(calls, 2);
  assert.equal(f.store.get('narrationJobs', job.id).status, 'failed');
  assert.deepEqual(f.store.get('episodes', f.episode.id), f.episode);
  assert.equal(f.store.history(f.episode.id).length, 1); await assertNoCandidates(f);
});
