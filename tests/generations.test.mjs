import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { Store, starterScene } from '../server/store.mjs';
import { GenerationQueue, probeGenerationAsset } from '../server/generations.mjs';
import { execute } from '../server/process.mjs';

const bytes = Buffer.from('fixture image bytes');
const output = { requestId: 'provider-1', transport: 'api', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/test.png?signature=private', type: 'image' }] };
const schema = { id: 'fixture', type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }, { name: 'width', type: 'integer', minimum: 16, maximum: 1024 }] };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function settled(queue) {
  const end = Date.now() + 3000;
  while (queue.busy.size) { assert.ok(Date.now() < end); await delay(5); }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-generation-'));
  const store = new Store(root);
  const episode = store.create('episodes', { title: 'Generation test', topic: 'Fixture', channelId: store.list('channels')[0].id, version: 1, status: 'draft', format: '9:16', scenes: [starterScene('First', 'Preserve caption'), starterScene('Second', 'Do not change')] });
  const calls = { create: 0, status: 0 };
  const provider = { transport: 'api', modelSchema: async () => schema, create: async () => { calls.create++; return { ...output, status: 'queued', outputs: [] }; }, status: async () => { calls.status++; return output; }, ...options.provider };
  const base = { store, provider, pollIntervalMs: 5, download: async (_url, filename) => { await writeFile(filename, bytes, { flag: 'wx' }); return { bytes: bytes.length, contentType: 'image/png' }; }, probe: async () => ({ kind: 'image', width: 320, height: 240 }), ...options };
  base.provider = provider;
  const queues = [];
  const makeQueue = (patch = {}) => { const queue = new GenerationQueue({ ...base, ...patch }); queues.push(queue); return queue; };
  const queue = makeQueue();
  t.after(async () => { for (const q of queues) q.close(); for (const q of queues) await settled(q); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, episode, provider, queue, calls, makeQueue, request: { requestId: 'client-fixture-1', expectedVersion: 1, sceneId: episode.scenes[0].id, model: 'fixture', prompt: 'An original scene', params: { width: 320 } } };
}

test('generation persists intent, imports hashed local output and applies one explicit versioned scene edit', async (t) => {
  const f = await fixture(t);
  const initial = await f.queue.start(f.episode.id, f.request);
  assert.equal(initial.status, 'queued');
  assert.equal(f.calls.create, 0);
  const complete = await f.queue.wait(initial.id, { timeoutMs: 3000 });
  assert.equal(f.calls.create, 1);
  assert.equal(f.calls.status, 1);
  assert.equal(complete.status, 'completed');
  assert.equal(f.store.get('episodes', f.episode.id).version, 1);
  const upload = f.store.get('uploads', complete.outputs[0].uploadId);
  assert.equal(upload.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(upload.provenance.source, 'https://images.higgs.ai/test.png');
  assert.deepEqual(await readFile(path.join(f.root, 'uploads', upload.filename)), bytes);
  const applied = f.queue.apply(initial.id, { expectedVersion: 1, sceneId: f.request.sceneId });
  assert.equal(applied.episode.version, 2);
  assert.equal(applied.episode.scenes[0].assetUrl, upload.url);
  assert.equal(applied.episode.scenes[0].text, f.episode.scenes[0].text);
  assert.equal(applied.episode.scenes[1].id, f.episode.scenes[1].id);
  assert.equal(applied.job.appliedVersion, 2);
  assert.equal(f.store.history(f.episode.id)[0].reason, `generation:${initial.id}`);
  const knowledge = f.store.knowledge();
  assert.equal(knowledge.nodes.find(node => node.id === initial.id).type, 'generation');
  assert.equal(knowledge.nodes.find(node => node.id === upload.id).type, 'asset');
  assert.ok(knowledge.edges.some(edge => edge.source === upload.id && edge.target === initial.id));
  assert.ok(knowledge.edges.some(edge => edge.source === initial.id && edge.target === f.episode.id));
  const atom = await readFile(path.join(f.root, 'knowledge', 'atoms', `${initial.id}.md`), 'utf8');
  assert.match(atom, /applied v2/);
  assert.ok(!atom.includes('signature=private'));
  assert.throws(() => f.queue.apply(initial.id, { expectedVersion: 2, sceneId: f.request.sceneId }), { status: 409 });
});

test('idempotent requests share one submission, reject changed payloads and survive later episode edits', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { provider: { modelSchema: async () => { await gate.promise; return schema; } } });
  const first = f.queue.start(f.episode.id, f.request);
  const second = f.queue.start(f.episode.id, { ...f.request, params: { width: 320 } });
  await assert.rejects(f.queue.start(f.episode.id, { ...f.request, prompt: 'different' }), { status: 409 });
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id);
  await f.queue.wait(a.id, { timeoutMs: 3000 });
  f.store.updateEpisode(f.episode.id, { title: 'Later edit' }, 1);
  assert.equal((await f.queue.start(f.episode.id, f.request)).id, a.id);
  assert.equal(f.calls.create, 1);
  assert.equal(f.store.list('generationJobs').length, 1);
});

test('submission validates version, scene and live schema and bounds pending validation before spending', async (t) => {
  const f = await fixture(t);
  for (const patch of [{ expectedVersion: undefined }, { expectedVersion: 0 }, { sceneId: 'missing' }, { requestId: undefined }, { params: { width: 5000 } }, { params: { unlisted: true } }, { params: { prompt: 'override' } }]) {
    await assert.rejects(f.queue.start(f.episode.id, { ...f.request, ...patch }), { status: 400 });
  }
  await assert.rejects(f.queue.start(f.episode.id, { ...f.request, expectedVersion: 99 }), { status: 409 });
  assert.equal(f.calls.create, 0);
  assert.equal(f.store.list('generationJobs').length, 0);
  const gate = deferred();
  const q = f.makeQueue({ maxActive: 1, provider: { ...f.provider, modelSchema: async () => { await gate.promise; return schema; } } });
  const waiting = q.start(f.episode.id, f.request);
  await assert.rejects(q.start(f.episode.id, { ...f.request, requestId: 'another' }), { status: 429 });
  f.store.updateEpisode(f.episode.id, { title: 'Changed during schema discovery' }, 1);
  gate.resolve();
  await assert.rejects(waiting, { status: 409 });
  assert.equal(f.calls.create, 0);
});

test('stale apply retains paid output and explicit reconciliation can apply to the original surviving scene', async (t) => {
  const f = await fixture(t);
  const job = await f.queue.start(f.episode.id, f.request);
  const complete = await f.queue.wait(job.id, { timeoutMs: 3000 });
  f.store.updateEpisode(f.episode.id, { title: 'Concurrent edit' }, 1);
  assert.throws(() => f.queue.apply(job.id, { expectedVersion: 1, sceneId: f.request.sceneId }), { status: 409 });
  assert.throws(() => f.queue.apply(job.id, { expectedVersion: 2, sceneId: f.episode.scenes[1].id }), { status: 400 });
  assert.equal(f.queue.get(job.id).applied, false);
  assert.equal(f.store.list('uploads').length, 1);
  assert.equal((await readdir(path.join(f.root, 'uploads'))).length, 1);
  assert.deepEqual(f.queue.get(job.id).outputs, complete.outputs);
  const applied = f.queue.apply(job.id, { expectedVersion: 2, sceneId: f.request.sceneId });
  assert.equal(applied.episode.version, 3);
  assert.equal(applied.episode.title, 'Concurrent edit');
});

test('CLI preflight rejects local-file syntax and unsupported reference flags before persisting or spending', async (t) => {
  const f = await fixture(t, { provider: { transport: 'cli', modelSchema: async () => ({ ...schema, parameters: [...schema.parameters, { name: 'image_url', type: 'string' }] }) } });
  await assert.rejects(f.queue.start(f.episode.id, { ...f.request, prompt: '@local-private-file' }), { status: 400 });
  await assert.rejects(f.queue.start(f.episode.id, { ...f.request, params: { image_url: 'https://example.com/image.png' } }), { status: 422 });
  assert.equal(f.calls.create, 0);
  assert.deepEqual(f.store.list('generationJobs'), []);
});

test('apply rolls back episode, history and job together if audit persistence fails', async (t) => {
  const f = await fixture(t);
  const job = await f.queue.start(f.episode.id, f.request);
  await f.queue.wait(job.id, { timeoutMs: 3000 });
  const originalRecord = f.store.record.bind(f.store);
  f.store.record = (type, details) => { if (type === 'generation.applied') throw new Error('Injected failure'); return originalRecord(type, details); };
  assert.throws(() => f.queue.apply(job.id, { expectedVersion: 1, sceneId: f.request.sceneId }), /Injected failure/);
  f.store.record = originalRecord;
  assert.equal(f.store.get('episodes', f.episode.id).version, 1);
  assert.equal(f.store.history(f.episode.id).length, 1);
  assert.equal(f.queue.get(job.id).applied, false);
  assert.equal(f.store.list('uploads').length, 1);
});

test('ambiguous submissions and restart without a provider ID never spend again', async (t) => {
  const f = await fixture(t, { provider: { create: async () => { throw Object.assign(new Error('private failure'), { code: 'AMBIGUOUS_SUBMISSION' }); } } });
  const job = await f.queue.start(f.episode.id, f.request);
  await assert.rejects(f.queue.wait(job.id, { timeoutMs: 3000 }), /unknown/);
  assert.equal(f.queue.get(job.id).status, 'submission_unknown');
  f.queue.close();
  await settled(f.queue);
  f.store.save('generationJobs', { ...f.queue.get(job.id), status: 'submitting' });
  let resubmissions = 0;
  const resumed = f.makeQueue({ provider: { ...f.provider, create: async () => { resubmissions++; return output; } } });
  assert.equal(resumed.get(job.id).status, 'submission_unknown');
  assert.equal((await resumed.start(f.episode.id, f.request)).id, job.id);
  await delay(20);
  assert.equal(resubmissions, 0);
});

test('restart resumes only status polling and refuses a changed provider transport', async (t) => {
  const f = await fixture(t, { provider: { status: async () => ({ ...output, status: 'in_progress', outputs: [] }) } });
  const job = await f.queue.start(f.episode.id, f.request);
  for (let i = 0; i < 100 && !f.queue.get(job.id).providerRequestId; i++) await delay(5);
  assert.equal(f.queue.get(job.id).providerRequestId, 'provider-1');
  f.queue.close(); await settled(f.queue);
  let createCalls = 0, pollCalls = 0;
  const resumed = f.makeQueue({ provider: { ...f.provider, create: async () => { createCalls++; return output; }, status: async () => { pollCalls++; return output; } } });
  await resumed.wait(job.id, { timeoutMs: 3000 });
  assert.equal(createCalls, 0);
  assert.equal(pollCalls, 1);
  resumed.close(); await settled(resumed);
  f.store.save('generationJobs', { ...resumed.get(job.id), status: 'pending' });
  const changed = f.makeQueue({ provider: { ...f.provider, transport: 'cli', status: async () => { throw new Error('Must not poll'); } } });
  assert.equal(changed.get(job.id).status, 'manual_recovery');
  assert.equal(changed.get(job.id).providerRequestId, 'provider-1');
});

test('failed downloads or unsupported media leave no uploads and retain provider recovery identity', async (t) => {
  const f = await fixture(t, { probe: async () => { throw new Error('Not actual media'); } });
  const job = await f.queue.start(f.episode.id, f.request);
  await assert.rejects(f.queue.wait(job.id, { timeoutMs: 3000 }), /imported safely/);
  await settled(f.queue);
  assert.equal(f.queue.get(job.id).status, 'import_failed');
  assert.equal(f.queue.get(job.id).providerRequestId, 'provider-1');
  assert.deepEqual(f.store.list('uploads'), []);
  assert.deepEqual(await readdir(path.join(f.root, 'uploads')), []);
  assert.equal(f.store.get('episodes', f.episode.id).version, 1);
});

test('poll failures preserve the paid provider ID and shutdown rejects waiters and ignores late completion', async (t) => {
  const f = await fixture(t, { maxPollFailures: 2, provider: { status: async () => { throw new Error('Unavailable'); } } });
  const job = await f.queue.start(f.episode.id, f.request);
  await assert.rejects(f.queue.wait(job.id, { timeoutMs: 3000 }), /status could not/);
  assert.equal(f.queue.get(job.id).status, 'polling_failed');
  assert.equal(f.queue.get(job.id).providerRequestId, 'provider-1');
  f.queue.close(); await settled(f.queue);
  const gate = deferred(), entered = deferred();
  const resumed = f.makeQueue({ provider: { ...f.provider, status: async () => { entered.resolve(); return gate.promise; } } });
  const waiting = assert.rejects(resumed.wait(job.id, { timeoutMs: 3000 }), { status: 503 });
  await entered.promise;
  resumed.close();
  await waiting;
  gate.resolve(output);
  await settled(resumed);
  assert.deepEqual(f.store.list('uploads'), []);
  assert.equal(f.store.get('episodes', f.episode.id).version, 1);
});

test('explicit recovery retries polling or importing the same request without submitting again', async (t) => {
  for (const failure of ['poll', 'import']) await t.test(failure, async (t) => {
    let healthy = false;
    const f = await fixture(t, {
      maxPollFailures: 1,
      provider: { status: async () => { if (!healthy && failure === 'poll') throw new Error('Transient status failure'); return output; } },
      probe: async () => { if (!healthy && failure === 'import') throw new Error('Transient import failure'); return { kind: 'image', width: 320, height: 240 }; },
    });
    const initial = await f.queue.start(f.episode.id, f.request);
    await assert.rejects(f.queue.wait(initial.id, { timeoutMs: 3000 }), { status: 409 });
    await settled(f.queue);
    assert.equal(f.queue.get(initial.id).status, failure === 'poll' ? 'polling_failed' : 'import_failed');
    assert.equal(f.calls.create, 1);
    healthy = true;
    const recovered = f.queue.recover(initial.id);
    assert.equal(recovered.id, initial.id);
    assert.equal(recovered.providerRequestId, 'provider-1');
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.error, undefined);
    assert.equal(f.queue.recover(initial.id).status, 'pending');
    const complete = await f.queue.wait(initial.id, { timeoutMs: 3000 });
    assert.equal(complete.status, 'completed');
    assert.equal(f.queue.recover(initial.id).status, 'completed');
    assert.equal(f.calls.create, 1);
    assert.equal(f.store.list('uploads').length, 1);
    assert.equal(f.store.list('generationJobs').length, 1);
  });
});

test('recovery rejects unknown outcomes, terminal refusals, missing IDs, changed transport and full capacity', async (t) => {
  const f = await fixture(t, { maxActive: 1 });
  const job = f.store.create('generationJobs', { episodeId: f.episode.id, transport: 'api', status: 'submission_unknown', providerRequestId: 'provider-1' });
  for (const status of ['submission_unknown', 'failed', 'nsfw', 'canceled', 'cancelled']) {
    f.store.save('generationJobs', { ...job, status });
    assert.throws(() => f.queue.recover(job.id), { status: 409 });
  }
  f.store.save('generationJobs', { ...job, status: 'polling_failed', providerRequestId: undefined });
  assert.throws(() => f.queue.recover(job.id), { status: 409 });
  f.store.save('generationJobs', { ...job, status: 'manual_recovery', transport: 'cli' });
  assert.throws(() => f.queue.recover(job.id), { status: 409 });
  f.store.save('generationJobs', { ...job, status: 'import_failed' });
  f.store.create('generationJobs', { status: 'in_progress', transport: 'api', providerRequestId: 'provider-2' });
  assert.throws(() => f.queue.recover(job.id), { status: 429 });
  assert.equal(f.calls.create, 0);
  assert.equal(f.calls.status, 0);
});

test('in-progress polling pauses at its age limit and explicit recovery resets the window without spending', async (t) => {
  let done = false;
  const f = await fixture(t, { maxPollDurationMs: 1000, provider: { status: async () => done ? output : { ...output, status: 'in_progress', outputs: [] } } });
  const job = await f.queue.start(f.episode.id, f.request);
  for (let i = 0; i < 100 && !f.queue.get(job.id).providerRequestId; i++) await delay(5);
  assert.equal(f.queue.get(job.id).providerRequestId, 'provider-1');
  f.store.save('generationJobs', { ...f.queue.get(job.id), pollStartedAt: new Date(Date.now() - 2000).toISOString() });
  await assert.rejects(f.queue.wait(job.id, { timeoutMs: 3000 }), /time limit/);
  assert.equal(f.queue.get(job.id).status, 'polling_failed');
  await settled(f.queue);
  done = true;
  f.queue.recover(job.id);
  assert.equal((await f.queue.wait(job.id, { timeoutMs: 3000 })).status, 'completed');
  assert.equal(f.calls.create, 1);
});

test('real FFprobe accepts generated PNG bytes and rejects a disguised playlist', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-generation-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = path.join(root, 'one.png');
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNc8AAAAASUVORK5CYII=', 'base64'));
  const imageProbe = await probeGenerationAsset(image, 'image/png');
  assert.equal(imageProbe.kind, 'image');
  assert.equal(imageProbe.width, 1);
  assert.equal(imageProbe.height, 1);
  assert.equal(imageProbe.codecName, 'png');
  const playlist = path.join(root, 'fake.mp4');
  await writeFile(playlist, '#EXTM3U\nhttp://127.0.0.1/private\n');
  await assert.rejects(probeGenerationAsset(playlist, 'video/mp4'));
});

test('actual video output is probed, imported and applied with its real duration and media kind', async (t) => {
  let video;
  const videoResult = { ...output, outputs: [{ url: 'https://d8j0ntlcm91z4.cloudfront.net/result.mp4', type: 'video' }] };
  const f = await fixture(t, {
    provider: { modelSchema: async () => ({ ...schema, type: 'video' }), create: async () => videoResult },
    probe: probeGenerationAsset,
    download: async (_url, destination) => { await writeFile(destination, video, { flag: 'wx' }); return { bytes: video.length, contentType: 'video/mp4' }; },
  });
  const source = path.join(f.root, 'source.mp4');
  await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x96:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { timeout: 15000 });
  video = await readFile(source);
  const job = await f.queue.start(f.episode.id, f.request);
  const completed = await f.queue.wait(job.id, { timeoutMs: 3000 });
  assert.equal(completed.outputs[0].kind, 'video');
  assert.equal(completed.outputs[0].type, 'video/mp4');
  assert.equal(completed.outputs[0].width, 64);
  assert.equal(completed.outputs[0].duration, 1);
  const applied = f.queue.apply(job.id, { expectedVersion: 1, sceneId: f.request.sceneId });
  assert.equal(applied.episode.scenes[0].duration, 1);
  assert.equal(applied.episode.scenes[0].kind, 'video');
  assert.equal(applied.episode.scenes[0].trimStart, 0);
});

async function hevcFixture(filename) {
  await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-f', 'lavfi', '-i', 'testsrc2=s=64x96:r=10:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:v', 'libx265', '-x265-params', 'pools=1:frame-threads=1:log-level=error', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', '-threads', '1', '-shortest', filename], { timeout: 15000 });
  return readFile(filename);
}

test('HEVC 10-bit import produces an H264 browser candidate and preserves the hashed original atomically', async (t) => {
  let video;
  const f = await fixture(t, {
    provider: { modelSchema: async () => ({ ...schema, type: 'video' }), create: async () => ({ ...output, outputs: [{ url: 'https://images.higgs.ai/original.mp4', type: 'video' }] }) },
    probe: probeGenerationAsset,
    download: async (_url, destination) => { await writeFile(destination, video, { flag: 'wx' }); return { bytes: video.length, contentType: 'video/mp4' }; },
  });
  video = await hevcFixture(path.join(f.root, 'source.mp4'));
  const originalHash = createHash('sha256').update(video).digest('hex');
  const job = await f.queue.start(f.episode.id, f.request);
  const complete = await f.queue.wait(job.id, { timeoutMs: 5000 });
  assert.equal(complete.outputs.length, 1);
  const candidate = complete.outputs[0];
  assert.equal(candidate.normalized, true);
  assert.equal(candidate.codecName, 'h264');
  assert.equal(candidate.pixelFormat, 'yuv420p');
  assert.equal(candidate.audioCodec, 'aac');
  assert.equal(candidate.original.codecName, 'hevc');
  assert.equal(candidate.original.pixelFormat, 'yuv420p10le');
  assert.equal(candidate.original.sha256, originalHash);
  const original = f.store.get('uploads', candidate.original.uploadId);
  assert.equal(original.variant, 'original');
  assert.equal(createHash('sha256').update(await readFile(path.join(f.root, 'uploads', original.filename))).digest('hex'), originalHash);
  assert.equal(f.store.list('uploads').length, 2);
  assert.equal(f.store.get('episodes', f.episode.id).version, 1);
  const graph = f.store.knowledge();
  assert.ok(graph.atoms.find((atom) => atom.id === candidate.uploadId).related.includes(original.id));
});

test('legacy completed HEVC normalization preserves applied history, requires explicit reapply and is idempotent', async (t) => {
  let video, providerCalls = 0;
  const f = await fixture(t, {
    maxActive: 1,
    provider: { modelSchema: async () => ({ ...schema, type: 'video' }), create: async () => { providerCalls++; return { ...output, outputs: [{ url: 'https://images.higgs.ai/original.mp4', type: 'video' }] }; }, status: async () => { throw new Error('No status call permitted'); } },
    probe: async () => ({ kind: 'video', width: 64, height: 96, duration: 1 }),
    download: async (_url, destination) => { await writeFile(destination, video, { flag: 'wx' }); return { bytes: video.length, contentType: 'video/mp4' }; },
  });
  video = await hevcFixture(path.join(f.root, 'source.mp4'));
  const job = await f.queue.start(f.episode.id, f.request);
  const before = await f.queue.wait(job.id, { timeoutMs: 5000 });
  await settled(f.queue);
  f.queue.apply(job.id, { expectedVersion: 1, sceneId: f.request.sceneId });
  const history = f.store.history(f.episode.id);
  const originalRecord = f.store.record.bind(f.store);
  f.store.record = (type, details) => { if (type === 'generation.normalized') throw new Error('Injected normalization rollback'); return originalRecord(type, details); };
  await assert.rejects(f.queue.normalize(job.id), /rollback/);
  f.store.record = originalRecord;
  assert.deepEqual(f.queue.get(job.id).outputs, before.outputs);
  assert.equal(f.queue.get(job.id).applied, true);
  assert.equal((await readdir(path.join(f.root, 'uploads'))).length, 1);
  const entered = deferred(), proceed = deferred();
  const convert = f.queue.browserVideo.bind(f.queue);
  f.queue.browserVideo = async (...args) => { entered.resolve(); await proceed.promise; return convert(...args); };
  const normalizing = f.queue.normalize(job.id);
  await entered.promise;
  assert.throws(() => f.queue.apply(job.id, { expectedVersion: 2, sceneId: f.request.sceneId }), /being normalized/);
  const capacityProbe = f.store.create('generationJobs', { status: 'completed', outputs: [] });
  await assert.rejects(f.queue.normalize(capacityProbe.id), { status: 429 });
  proceed.resolve();
  const normalized = await normalizing;
  f.queue.browserVideo = convert;
  assert.equal(providerCalls, 1);
  assert.equal(normalized.outputs[0].codecName, 'h264');
  assert.equal(normalized.outputs[0].original.sha256, before.outputs[0].sha256);
  assert.equal(normalized.applied, false);
  assert.equal(normalized.priorApplications[0].version, 2);
  assert.deepEqual(normalized.priorApplications[0].outputs, before.outputs);
  assert.deepEqual(f.store.history(f.episode.id), history);
  assert.equal(f.store.get('episodes', f.episode.id).scenes[0].assetUrl, before.outputs[0].url);
  assert.deepEqual((await f.queue.normalize(job.id)).outputs, normalized.outputs);
  assert.equal(f.store.list('uploads').length, 2);
  const applied = f.queue.apply(job.id, { expectedVersion: 2, sceneId: f.request.sceneId });
  assert.equal(applied.episode.version, 3);
  assert.equal(applied.episode.scenes[0].assetUrl, normalized.outputs[0].url);
  assert.equal(f.store.history(f.episode.id)[1].snapshot.scenes[0].assetUrl, before.outputs[0].url);
});
