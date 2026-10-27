import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, starterScene } from '../server/store.mjs';
import { GenerationQueue } from '../server/generations.mjs';
import { execute } from '../server/process.mjs';
import { SourceMediaService } from '../server/media-sources.mjs';
import { defaultWorkflow } from '../server/workflows.mjs';
import { candidateManifest, verifyCandidateAssets } from '../server/candidates.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, { extension, contentType }) {
  const root = await mkdtemp(path.join(tmpdir(), 'music-generation-formats-'));
  const source = path.join(root, `fixture.${extension}`);
  await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', extension === 'mp3' ? 'libmp3lame' : 'aac', source], { timeout: 15000 });
  const bytes = await readFile(source), store = new Store(root);
  const episode = store.create('episodes', { title: 'Format fixture', topic: 'Music', channelId: store.list('channels')[0].id, version: 1, status: 'draft', format: '9:16', scenes: [starterScene('Scene', 'Text')] });
  let creates = 0;
  const provider = {
    transport: 'api', modelSchema: async () => ({ id: 'music-fixture', type: 'audio', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    estimate: async () => ({ credits: 2.82 }),
    create: async () => { creates++; return { requestId: 'provider-format-1', transport: 'api', status: 'completed', outputs: [{ url: `https://images.higgs.ai/track.${extension}`, type: 'audio' }] }; },
  };
  const queue = new GenerationQueue({ store, provider, download: async (_url, file) => { await writeFile(file, bytes, { flag: 'wx' }); return { bytes: bytes.length, contentType }; } });
  t.after(async () => { queue.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const request = { requestId: 'format-1', expectedVersion: 1, target: 'music', model: 'music-fixture', prompt: 'Fixture music', params: {} };
  const quote = await queue.quoteMusic(episode.id, request);
  const job = await queue.start(episode.id, { ...request, quoteId: quote.id, quoteFingerprint: quote.fingerprint, acceptedCredits: quote.credits });
  return { queue, store, root, bytes, job, creates: () => creates };
}

test('real MP3 audio is imported unchanged with its verified source hash', async t => {
  const f = await fixture(t, { extension: 'mp3', contentType: 'audio/mpeg' });
  const job = await f.queue.wait(f.job.id, { timeoutMs: 15000 });
  assert.equal(job.status, 'completed');
  const upload = f.store.get('uploads', job.outputs[0].uploadId);
  assert.equal(upload.kind, 'audio'); assert.equal(upload.type, 'audio/mpeg');
  assert.equal(upload.sha256, hash(f.bytes));
  assert.deepEqual(await readFile(path.join(f.root, 'uploads', upload.filename)), f.bytes);
  assert.equal(f.creates(), 1);
});

test('real AAC/MP4 output preserves the original and imports a separately hashed WAV for music', async t => {
  const f = await fixture(t, { extension: 'm4a', contentType: 'audio/mp4' });
  const job = await f.queue.wait(f.job.id, { timeoutMs: 15000 });
  assert.equal(job.status, 'completed');
  const selected = f.store.get('uploads', job.outputs[0].uploadId);
  assert.equal(selected.kind, 'audio'); assert.equal(selected.type, 'audio/wav');
  const original = f.store.get('uploads', job.outputs[0].original.uploadId);
  assert.equal(original.sha256, hash(f.bytes));
  assert.equal(job.outputs[0].original.sha256, original.sha256);
  assert.deepEqual(await readFile(path.join(f.root, 'uploads', original.filename)), f.bytes);
  const converted = await readFile(path.join(f.root, 'uploads', selected.filename));
  assert.equal(selected.sha256, hash(converted));
  assert.notEqual(selected.sha256, original.sha256);
  const rights = await new SourceMediaService({ store: f.store }).clearRights(selected.id, { origin: 'generated', generationJobId: job.id });
  assert.equal(rights.uploadId, selected.id);
  assert.equal(rights.sha256, selected.sha256);
  assert.equal(rights.generationJobId, job.id);
  assert.equal(f.creates(), 1);
});

test('MP3 bytes labeled as MP4 are rejected without registering an output', async t => {
  const f = await fixture(t, { extension: 'mp3', contentType: 'audio/mp4' });
  await assert.rejects(f.queue.wait(f.job.id, { timeoutMs: 15000 }), { status: 409 });
  assert.equal(f.queue.get(f.job.id).status, 'import_failed');
  assert.deepEqual(f.store.list('uploads'), []);
  assert.equal(f.creates(), 1);
});

test('converted generated music requires intact original bytes and matching provenance throughout candidate verification', { timeout: 180000 }, async t => {
  const f = await fixture(t, { extension: 'm4a', contentType: 'audio/mp4' });
  const completed = await f.queue.wait(f.job.id, { timeoutMs: 15000 });
  const selected = f.store.get('uploads', completed.outputs[0].uploadId);
  const original = f.store.get('uploads', completed.outputs[0].original.uploadId);
  await new SourceMediaService({ store: f.store }).clearRights(selected.id, { origin: 'generated', generationJobId: completed.id });
  const { episode } = f.queue.apply(completed.id, { expectedVersion: 1, outputUploadId: selected.id });
  const job = f.store.get('generationJobs', completed.id);
  const template = f.store.create('workflows', defaultWorkflow());
  const workflow = f.store.createWorkflowCopy({ templateId: template.id, channelId: episode.channelId, episodeId: episode.id, expectedTemplateVersion: template.version });
  const manifest = () => candidateManifest(f.store, episode, workflow, { selectedStages: ['render', 'review'] });
  const clean = manifest();
  const verified = await verifyCandidateAssets(f.store, clean);
  assert.equal(verified.assets.find(asset => asset.use === 'music').sha256, selected.sha256);
  const originalPath = path.join(f.root, 'uploads', original.filename);
  const cases = [
    ['original bytes replaced', () => writeFile(originalPath, Buffer.from('tampered')), () => writeFile(originalPath, f.bytes)],
    ['normalized provenance points to different original hash', () => f.store.save('uploads', { ...selected, provenance: { ...selected.provenance, original: { ...selected.provenance.original, sha256: 'f'.repeat(64) } } }), () => f.store.save('uploads', selected)],
    ['generation output points to different original hash', () => f.store.save('generationJobs', { ...job, outputs: job.outputs.map(output => ({ ...output, original: { ...output.original, sha256: 'e'.repeat(64) } })) }), () => f.store.save('generationJobs', job)],
    ['original registry hash changed', () => f.store.save('uploads', { ...original, sha256: 'd'.repeat(64) }), () => f.store.save('uploads', original)],
  ];
  for (const [name, change, restore] of cases) await t.test(name, async () => {
    await change();
    try {
      await assert.rejects(async () => verifyCandidateAssets(f.store, manifest()), { status: 409 });
      await assert.rejects(verifyCandidateAssets(f.store, clean), { status: 409 });
      assert.equal(f.creates(), 1, 'validation must not resubmit generation');
    } finally { await restore(); }
  });
});
