import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store, starterScene } from '../server/store.mjs';
import { SourceMediaService } from '../server/media-sources.mjs';
import { YouTubeOAuth } from '../server/youtube-oauth.mjs';
import { GenerationQueue } from '../server/generations.mjs';
import { createGenerationProvider } from '../server/generation-provider.mjs';
import { PrivateRuntime } from '../server/private-runtime.mjs';
import { Worker } from 'node:worker_threads';
import { renderEpisode } from '../server/render.mjs';
import { execute } from '../server/process.mjs';
import { PublicationService } from '../server/publication.mjs';
import { defaultWorkflow } from '../server/workflows.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-local-guards-')), store = new Store(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const channel = store.list('channels')[0];
  const episode = store.create('episodes', { channelId: channel.id, title: 'Original story', topic: 'Preserve topic', version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Original scene', 'Preserve caption')] });
  return { dataDir, store, channel, episode };
}

test('unconfigured optional adapters construct, block external work prefetch, and retain real local rights validation', async t => {
  const f = await fixture(t); let calls = 0;
  const fetchImpl = async () => { calls++; assert.fail('unconfigured adapter attempted external transport'); };
  const media = new SourceMediaService({ store: f.store, userAgent: '', fetchImpl });
  const oauth = new YouTubeOAuth({ store: f.store, clientId: '', clientSecret: '', redirectUri: '', fetchImpl });
  assert.equal((await oauth.status(f.channel.id)).status, 'not_configured');
  await assert.rejects(oauth.begin(f.channel.id, { sessionId: 'fixture-session', correlationToken: randomUUID() }));
  await assert.rejects(media.search({ query: 'fixture', kind: 'image', limit: 1 }), { status: 503 });
  await assert.rejects(media.importMedia({ pageId: 601, kind: 'image', rightsAcknowledged: true, useAs: 'illustration' }), { status: 503 });
  const id = randomUUID(), filename = `${id}.png`;
  await writeFile(join(f.dataDir, 'uploads', filename), PNG);
  const upload = f.store.save('uploads', { id, filename, url: `/api/uploads/${filename}`, name: 'Local', kind: 'image', type: 'image/png', size: PNG.length, sha256: hash(PNG) });
  await assert.rejects(media.clearRights(upload.id, { origin: 'third-party' }), { status: 400 });
  await media.clearRights(upload.id, { origin: 'own' });
  const attached = await media.attach(f.episode.id, { sceneId: f.episode.scenes[0].id, uploadId: id, expectedVersion: f.episode.version, useAs: 'illustration' });
  assert.equal(attached.scenes[0].source.origin, 'own');
  assert.equal(attached.scenes[0].source.sha256, hash(PNG));
  assert.equal(calls, 0);
});

async function generated(t) {
  const f = await fixture(t), calls = [];
  // Actual provider adapter, queue, local FFprobe, Store and history. Only HTTP/download bytes are fixtures.
  const provider = createGenerationProvider({ env: { AGENT_BRIDGE_URL: 'http://127.0.0.1:1', AGENT_BRIDGE_TOKEN: 'fixture-transport-token-000000000000' }, fetchImpl: async (raw, options = {}) => {
    const url = new URL(raw); assert.equal(url.origin, 'http://127.0.0.1:1'); calls.push(url.pathname);
    if (url.pathname === '/generation/models') return Response.json({ id: 'fixture', type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] });
    if (url.pathname === '/generation/create') return Response.json({ requestId: 'fixture-provider-1', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] });
    assert.fail(`unexpected external fixture path: ${url.pathname}`);
  } });
  const queue = new GenerationQueue({ store: f.store, provider, download: async (url, filename) => { assert.equal(url, 'https://images.higgs.ai/fixture.png'); await writeFile(filename, PNG, { flag: 'wx' }); return { bytes: PNG.length, contentType: 'image/png' }; } });
  t.after(() => queue.close());
  const job = await queue.start(f.episode.id, { requestId: 'fixture-client-1', expectedVersion: 1, sceneId: f.episode.scenes[0].id, model: 'fixture', prompt: 'Original illustration', params: {} });
  const done = await queue.wait(job.id, { timeoutMs: 10000 });
  assert.equal(done.status, 'completed');
  return { ...f, queue, job: done, upload: f.store.get('uploads', done.outputs[0].uploadId), calls };
}

test('generated apply records generated source/hash/job and immutable exact episode history without rights fabrication', async t => {
  const f = await generated(t), before = f.store.history(f.episode.id);
  const result = f.queue.apply(f.job.id, { expectedVersion: f.episode.version, sceneId: f.episode.scenes[0].id });
  const source = result.episode.scenes[0].source;
  assert.deepEqual(source, { origin: 'generated', sha256: hash(PNG), generationJobId: f.job.id, useAs: 'illustration' });
  assert.equal(result.episode.scenes[0].assetUrl, f.upload.url);
  assert.equal(result.episode.topic, f.episode.topic);
  assert.equal(result.episode.scenes[0].text, f.episode.scenes[0].text);
  const history = f.store.history(f.episode.id);
  assert.equal(history.length, before.length + 1);
  assert.deepEqual(history.find(h => h.version === 1), before.find(h => h.version === 1));
  assert.deepEqual(history[0].snapshot.scenes[0].source, source);
  assert.equal(f.store.list('mediaRights').length, 0, 'applying generated output never fabricates third-party clearance');
  const count = f.calls.length;
  assert.throws(() => f.queue.apply(f.job.id, { expectedVersion: result.episode.version, sceneId: f.episode.scenes[0].id }), { status: 409 });
  assert.equal(f.calls.length, count, 'repeat apply cannot resubmit generation');
});

test('same-length local generated-byte tampering rejects apply before episode, source, job-applied state or history changes', async t => {
  const f = await generated(t), before = f.store.history(f.episode.id);
  const filename = join(f.dataDir, 'uploads', f.upload.filename), bytes = await readFile(filename);
  const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
  assert.equal(changed.length, bytes.length); assert.notEqual(hash(changed), f.upload.sha256);
  await writeFile(filename, changed);
  assert.throws(() => f.queue.apply(f.job.id, { expectedVersion: f.episode.version, sceneId: f.episode.scenes[0].id }), { status: 409 });
  assert.equal(f.store.get('episodes', f.episode.id).version, f.episode.version);
  assert.deepEqual(f.store.history(f.episode.id), before);
  assert.ok(!f.store.get('generationJobs', f.job.id).applied);
  assert.equal(f.store.get('episodes', f.episode.id).scenes[0].source, undefined);
});

test('private runtime creates its key lazily, encrypts durable atomic records, validates namespaces and fails closed on corruption', async t => {
  const f = await fixture(t), runtime = new PrivateRuntime({ dataDir: f.dataDir });
  const fallback = { missing: true };
  assert.deepEqual(runtime.read('publication', fallback), fallback);
  assert.ok(!(await readdir(f.dataDir)).includes('.private'), 'construction and absent reads cannot create a key');
  for (const name of ['', '../publication', '/publication', 'publication/escape', 'publication\\escape', 'publication\0escape', '..']) {
    assert.throws(() => runtime.read(name), { status: 400 });
    assert.throws(() => runtime.write(name, {}), { status: 400 });
    assert.throws(() => runtime.remove(name), { status: 400 });
  }
  const secret = { resumable: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture-opaque-private', refreshToken: 'fixture-private-refresh-unique' };
  runtime.write('publication', secret);
  const files = await readdir(join(f.dataDir, '.private'));
  assert.deepEqual(files.sort(), ['key.bin', 'publication.json'], 'completed writes leave no temporary or plaintext copies');
  for (const name of files) {
    const bytes = await readFile(join(f.dataDir, '.private', name));
    for (const value of Object.values(secret)) assert.ok(!bytes.includes(Buffer.from(value)), 'private bytes cannot appear in plaintext storage');
    if (process.platform !== 'win32') assert.equal((await stat(join(f.dataDir, '.private', name))).mode & 0o777, 0o600);
  }
  const restarted = new PrivateRuntime({ dataDir: f.dataDir });
  assert.deepEqual(restarted.read('publication'), secret);
  restarted.write('publication', { ...secret, phase: 'received' });
  assert.equal(new PrivateRuntime({ dataDir: f.dataDir }).read('publication').phase, 'received');
  const file = join(f.dataDir, '.private', 'publication.json');
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  envelope.tag = Buffer.alloc(16).toString('base64');
  await writeFile(file, JSON.stringify(envelope));
  assert.throws(() => new PrivateRuntime({ dataDir: f.dataDir }).read('publication', fallback), { status: 503 }, 'authentication failure is corruption, never missing state');
  assert.throws(() => restarted.write('publication', secret), { status: 503 }, 'a write must not silently replace corrupt storage');
  assert.equal(await readFile(file, 'utf8'), JSON.stringify(envelope), 'corruption remains available for explicit recovery');
  restarted.remove('publication'); assert.deepEqual(restarted.read('publication', fallback), fallback);
});

test('private runtime authenticates namespaces and never regenerates a missing or corrupt key over stored records', async t => {
  const f = await fixture(t), runtime = new PrivateRuntime({ dataDir: f.dataDir });
  runtime.write('oauth_once', { verifier: 'fixture-only-secret' });
  const root = join(f.dataDir, '.private'), original = await readFile(join(root, 'oauth_once.json'));
  await writeFile(join(root, 'publication.json'), original);
  assert.throws(() => runtime.read('publication', {}), { status: 503 }, 'copying ciphertext to another namespace cannot authenticate');
  await rm(join(root, 'key.bin'));
  for (const operation of [() => new PrivateRuntime({ dataDir: f.dataDir }).read('oauth_once', {}), () => new PrivateRuntime({ dataDir: f.dataDir }).write('new_record', {})]) assert.throws(operation, { status: 503 });
  assert.ok(!(await readdir(root)).includes('key.bin'), 'missing key plus ciphertext cannot initialize a replacement key');
  await writeFile(join(root, 'key.bin'), Buffer.alloc(31));
  assert.throws(() => new PrivateRuntime({ dataDir: f.dataDir }).read('oauth_once', {}), { status: 503 });
  assert.deepEqual(await readFile(join(root, 'oauth_once.json')), original);
});

function runtimeThreads(t, dataDir) {
  const workers = [];
  const launch = (mode, index) => {
    const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      import(workerData.module).then(({PrivateRuntime})=>{const runtime=new PrivateRuntime({dataDir:workerData.dataDir});
        parentPort.once('message',()=>{try{let result;if(workerData.mode==='write'){runtime.write('intent_'+workerData.index,{identity:'fixture-'+workerData.index});result=runtime.read('intent_'+workerData.index);}else result=runtime.consume('oauth_once');parentPort.postMessage({result});}catch(error){parentPort.postMessage({error:{message:workerData.mode+' thread '+workerData.index+': '+error.message,status:error.status}});}});parentPort.postMessage({ready:true});});`, { eval: true, workerData: { module: new URL('../server/private-runtime.mjs', import.meta.url).href, dataDir, mode, index } });
    workers.push(worker);
    let go; const ready = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', () => { go = () => worker.postMessage('go'); resolve(); }); });
    const result = ready.then(() => new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', value => value.error ? reject(Object.assign(new Error(value.error.message), value.error)) : resolve(value.result)); }));
    return { ready, result, go: () => go() };
  };
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  return launch;
}

test('private runtime concurrent threads initialize one usable key without dropping separate records', async t => {
  const f = await fixture(t), launch = runtimeThreads(t, f.dataDir);
  const writes = [launch('write', 0), launch('write', 1), launch('write', 2), launch('write', 3)];
  await Promise.all(writes.map(operation => operation.ready)); writes.forEach(operation => operation.go());
  assert.deepEqual(await Promise.all(writes.map(operation => operation.result)), [0, 1, 2, 3].map(i => ({ identity: `fixture-${i}` })));
  const runtime = new PrivateRuntime({ dataDir: f.dataDir });
  for (let i = 0; i < 4; i++) assert.deepEqual(runtime.read(`intent_${i}`), { identity: `fixture-${i}` });
});

test('private runtime concurrent one-use claims return the state to exactly one thread', async t => {
  const f = await fixture(t), launch = runtimeThreads(t, f.dataDir);
  const runtime = new PrivateRuntime({ dataDir: f.dataDir });
  runtime.write('oauth_once', { state: 'fixture-once', ownerId: 'owner-1' });
  const claims = [launch('consume', 0), launch('consume', 1), launch('consume', 2), launch('consume', 3)];
  await Promise.all(claims.map(operation => operation.ready)); claims.forEach(operation => operation.go());
  const attempts = await Promise.allSettled(claims.map(operation => operation.result));
  assert.deepEqual(attempts.filter(attempt => attempt.status === 'rejected').map(attempt => attempt.reason.message), [], 'a losing atomic claim returns null, never a storage-corruption error');
  const results = attempts.map(attempt => attempt.value);
  assert.deepEqual(results.filter(Boolean), [{ state: 'fixture-once', ownerId: 'owner-1' }]);
  assert.equal(results.filter(value => value === null).length, 3);
  assert.equal(runtime.consume('oauth_once'), null); assert.equal(runtime.read('oauth_once'), null);
  assert.ok((await readdir(join(f.dataDir, '.private'))).every(name => !/\.(tmp|claimed)$/.test(name)));
});

test('generated apply validates and actually renders a local illustration without auto rights, and publication still needs explicit rights acknowledgement', async t => {
  const f = await generated(t), media = new SourceMediaService({ store: f.store, userAgent: '', fetchImpl: async () => assert.fail('local illustration cannot contact provider') });
  const result = f.queue.apply(f.job.id, { expectedVersion: 1, sceneId: f.episode.scenes[0].id });
  assert.doesNotThrow(() => media.validateAssets(result.episode.scenes));
  const episode = f.store.updateEpisode(f.episode.id, { scenes: result.episode.scenes.map(scene => ({ ...scene, duration: 1 })) }, result.episode.version);
  const sceneSnapshot = structuredClone(episode.scenes);
  const uploads = f.store.list('uploads');
  const sceneIntegrity = episode.scenes.filter(s => s.assetUrl).map(s => {
    const u = uploads.find(item => item.url === s.assetUrl);
    return { sceneId: s.id, use: 'asset', assetUrl: s.assetUrl, sha256: u.sha256, size: u.size };
  });
  const rendered = await renderEpisode(episode, { dataDir: f.dataDir, sceneIntegrity });
  const probe = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', join(f.dataDir, 'exports', rendered.filename)]);
  const video = JSON.parse(probe.stdout).streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.width, 1080); assert.equal(video.height, 1920);
  assert.equal(hash(await readFile(join(f.dataDir, 'exports', rendered.filename))), rendered.sha256);
  assert.equal(f.store.list('mediaRights').length, 0, 'apply, local validation and render never fabricate human clearance');
  const channel = f.store.save('channels', { ...f.channel, externalId: `UC${'A'.repeat(22)}`, platform: 'YouTube' });
  const template = f.store.create('workflows', defaultWorkflow());
  const workflow = f.store.createWorkflowCopy({ templateId: template.id, channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const job = f.store.create('jobs', { ...rendered, episodeId: episode.id, episodeVersion: episode.version, status: 'completed', progress: 100, sceneSnapshot: structuredClone(sceneSnapshot), sceneIntegrity, verifiedSceneAssets: rendered.verifiedSceneAssets || sceneIntegrity });
  let run = f.store.create('workflowRuns', { workflowId: workflow.id, workflowVersion: workflow.version, episodeId: episode.id, episodeVersion: episode.version, status: 'approved', nodeRuns: [{ nodeId: 'render', type: 'render', status: 'completed', output: { jobId: job.id, outputUrl: job.outputUrl, sha256: job.sha256, episodeVersion: episode.version, sceneSnapshot: structuredClone(sceneSnapshot), generationNodeIds: [], verifiedSceneAssets: rendered.verifiedSceneAssets || sceneIntegrity } }, { nodeId: 'review', type: 'review', status: 'approved', output: {} }], reviews: {} });
  const review = { decision: 'approved', workflowId: workflow.id, workflowVersion: workflow.version, runId: run.id, episodeId: episode.id, episodeVersion: episode.version, jobId: job.id, outputUrl: job.outputUrl, sha256: job.sha256 };
  run = f.store.save('workflowRuns', { ...run, reviews: { review } });
  const service = new PublicationService({ store: f.store, oauth: new YouTubeOAuth({ store: f.store, clientId: '', clientSecret: '', redirectUri: '' }), fetchImpl: async () => assert.fail('approval preview cannot contact provider') }); t.after(() => service.close());
  const body = { workflowId: workflow.id, runId: run.id, reviewNodeId: 'review', expectedEpisodeVersion: episode.version, title: 'Generated illustration', description: 'Illustration, not evidence of the event', categoryId: '25', tags: [], selfDeclaredMadeForKids: false, containsSyntheticMedia: true, disclosureRationale: 'Generated illustration explicitly disclosed' };
  for (const rightsAcknowledged of [undefined, false, 'true']) await assert.rejects(service.approve({ ...body, rightsAcknowledged }, { ownerId: 'owner-1' }), { status: 400 });
  assert.equal(f.store.list('publicationApprovals').length, 0);
  const approval = await service.approve({ ...body, rightsAcknowledged: true }, { ownerId: 'owner-1' });
  assert.equal(approval.manifest.rightsAcknowledged, true); assert.equal(approval.manifest.containsSyntheticMedia, true);
  assert.equal(f.store.list('mediaRights').length, 0);
  assert.equal(f.store.list('publicationIntents').length, 0, 'preview never starts publication');
});

test('local generated provenance rejects missing, incomplete, unrelated and tampered output identities independently of human rights', async t => {
  const f = await generated(t), media = new SourceMediaService({ store: f.store, userAgent: '' });
  const result = f.queue.apply(f.job.id, { expectedVersion: 1, sceneId: f.episode.scenes[0].id });
  const scenes = result.episode.scenes;
  assert.doesNotThrow(() => media.validateAssets(scenes));
  const check = patch => { const input = structuredClone(scenes); Object.assign(input[0].source, patch); assert.throws(() => media.validateAssets(input), `reject spoofed provenance ${JSON.stringify(patch)}`); };
  check({ generationJobId: randomUUID() }); check({ sha256: 'f'.repeat(64) }); check({ origin: 'own' }); check({ useAs: 'evidence' });
  for (const patch of [{ status: 'failed' }, { status: 'running' }, { outputs: [] }, { outputs: [{ ...f.job.outputs[0], uploadId: randomUUID() }] }, { outputs: [{ ...f.job.outputs[0], sha256: 'a'.repeat(64) }] }, { outputs: [{ ...f.job.outputs[0], url: '/api/uploads/unrelated.png' }] }]) {
    f.store.save('generationJobs', { ...f.job, ...patch });
    assert.throws(() => media.validateAssets(scenes), { status: 409 }, `completed matching job is required: ${JSON.stringify(patch)}`);
    f.store.save('generationJobs', f.job);
  }
  f.store.save('uploads', { ...f.upload, generationJobId: randomUUID() });
  assert.throws(() => media.validateAssets(scenes), { status: 409 }); f.store.save('uploads', f.upload);
  const bytes = Buffer.from(PNG); bytes[bytes.length - 1] ^= 1; await writeFile(join(f.dataDir, 'uploads', f.upload.filename), bytes);
  assert.throws(() => media.validateAssets(scenes), { status: 409 }, 'matching recorded hash never overrides changed physical bytes');
  assert.equal(f.store.list('mediaRights').length, 0);
});
