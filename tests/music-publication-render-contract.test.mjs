import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { defaultWorkflow } from '../server/workflows.mjs';
import { renderEpisode } from '../server/render.mjs';
import { PublicationService } from '../server/publication.mjs';

// A real PCM input and FFmpeg output: neither the upload nor the MP4 is a fabricated artifact.
function tone() {
  const rate = 48000, samples = rate;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return wav;
}

async function fixture(t, { sceneMedia = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'music-publication-render-'));
  const store = new Store(dataDir);
  let providerCalls = 0;
  const service = new PublicationService({ store, fetchImpl: async () => { providerCalls++; throw new Error('Unexpected provider request'); } });
  t.after(async () => { service.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const bytes = tone(), id = randomUUID(), filename = `${id}.wav`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(dataDir, 'uploads', filename), bytes);
  const upload = store.save('uploads', { id, filename, name: 'Fixture tone', url: `/api/uploads/${filename}`, kind: 'audio', type: 'audio/wav', size: bytes.length, sha256 });
  const source = { origin: 'third-party', sha256, sourceUrl: 'https://example.invalid/fixture-tone', licenseId: 'CC-BY-4.0', attribution: 'Fixture Composer' };
  const rights = store.create('mediaRights', { uploadId: id, ...source, acknowledgedAt: '2026-01-01T00:00:00Z' });
  const music = { assetUrl: upload.url, start: 0, trimStart: 0, volume: 0.5, source };
  const channel = store.create('channels', { name: 'Fixture', category: 'information', platform: 'YouTube', sample: false, accountEmail: 'owner@fixture.invalid', externalId: `UC${'A'.repeat(22)}` });
  const scenes = [{ id: 'original-card', title: 'Original fixture', text: 'Fixture report', kind: 'title', layout: 'center', duration: 1, background: '#173940' }];
  const sceneUploads = [];
  const sceneRights = [];
  if (sceneMedia) {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    for (const [kind, payload, ext, type, attribution] of [['image', png, 'png', 'image/png', 'Fixture Photographer'], ['audio', tone(), 'wav', 'audio/wav', 'Fixture Narrator']]) {
      const mediaId = randomUUID(), mediaFilename = `${mediaId}.${ext}`;
      const mediaHash = createHash('sha256').update(payload).digest('hex');
      await writeFile(path.join(dataDir, 'uploads', mediaFilename), payload);
      const mediaUpload = store.save('uploads', { id: mediaId, filename: mediaFilename, name: attribution, url: `/api/uploads/${mediaFilename}`, kind, type, size: payload.length, sha256: mediaHash });
      const mediaSource = { origin: 'third-party', useAs: 'illustration', sha256: mediaHash, sourceUrl: `https://example.invalid/${kind}`, licenseId: 'CC-BY-4.0', attribution };
      sceneUploads.push(mediaUpload);
      sceneRights.push(store.create('mediaRights', { uploadId: mediaId, ...mediaSource, acknowledgedAt: '2026-01-01T00:00:00Z' }));
      if (kind === 'image') Object.assign(scenes[0], { kind: 'image', assetUrl: mediaUpload.url, source: mediaSource });
      else Object.assign(scenes[0], { audioUrl: mediaUpload.url, audioSource: mediaSource, audioVolume: 1 });
    }
  }
  const episode = store.create('episodes', { channelId: channel.id, title: 'Fixture report', topic: 'Fixture', category: 'information', status: 'draft', format: '1:1', version: 1, scenes, music, notes: '' });
  const musicIntegrity = { sha256, size: bytes.length };
  const sceneIntegrity = sceneUploads.map((upload, index) => ({ sceneId: 'original-card', use: index === 0 ? 'asset' : 'audio', assetUrl: upload.url, sha256: upload.sha256, size: upload.size }));
  const rendered = await renderEpisode(episode, { dataDir, musicIntegrity, sceneIntegrity });
  const exportBytes = await readFile(path.join(dataDir, 'exports', rendered.filename));
  assert.equal(createHash('sha256').update(exportBytes).digest('hex'), rendered.sha256);
  const job = store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'completed', progress: 100, ...rendered, sceneSnapshot: structuredClone(scenes), musicSnapshot: structuredClone(music), musicIntegrity, sceneIntegrity });
  const template = store.create('workflows', defaultWorkflow());
  const workflow = store.createWorkflowCopy({ templateId: template.id, channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  let run = store.create('workflowRuns', { workflowId: workflow.id, workflowVersion: workflow.version, workflowSnapshot: structuredClone(workflow), episodeId: episode.id, episodeVersion: episode.version, status: 'awaiting_review', nodeRuns: [
    { nodeId: 'render', type: 'render', status: 'completed', output: { jobId: job.id, ...rendered, renderNodeId: 'render', episodeVersion: episode.version, sceneSnapshot: structuredClone(scenes), musicSnapshot: structuredClone(music), generationNodeIds: [] } },
    { nodeId: 'review', type: 'review', status: 'awaiting_review', output: {} },
  ], reviews: {} });
  run = store.commitWorkflowReview(workflow.id, run.id, 'review', { decision: 'approved', notes: '', expectedEpisodeVersion: episode.version, jobId: job.id, outputUrl: rendered.outputUrl, sha256: rendered.sha256 });
  const body = { workflowId: workflow.id, runId: run.id, reviewNodeId: 'review', expectedEpisodeVersion: episode.version, title: 'Fixture report', description: 'Fixture description', categoryId: '25', tags: ['fixture'], selfDeclaredMadeForKids: false, containsSyntheticMedia: true, disclosureRationale: 'Fixture synthetic narration disclosure', rightsAcknowledged: true };
  return { store, service, body, episode, job, run, rights, music, bytes, rendered, dataDir, sceneUploads, sceneRights, providerCalls: () => providerCalls };
}

test('a real music render binds approval and credit to the reviewed bytes, and stale inputs cannot be published', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(f.rendered.verifiedMusicIntegrity, f.job.musicIntegrity, 'renderer must attest the exact consumed music bytes');
  const approval = await f.service.approve(f.body, { ownerId: 'fixture-owner' });
  assert.equal(approval.manifest.render.sha256, f.rendered.sha256);
  assert.equal(approval.manifest.render.jobId, f.job.id);
  assert.equal(approval.manifest.reviewNodeId, 'review');
  assert.equal(approval.manifest.containsSyntheticMedia, true);
  assert.equal(approval.manifest.disclosureRationale, f.body.disclosureRationale);
  for (const part of [f.music.source.attribution, f.music.source.licenseId, f.music.source.sourceUrl]) {
    assert.ok(approval.manifest.credits.includes(part), `music credit missing ${part}`);
    assert.ok(approval.manifest.description.includes(part), `description missing ${part}`);
  }
  assert.equal(f.providerCalls(), 0, 'final approval does not grant upload authority or contact a provider');

  const renderNode = f.run.nodeRuns.find(node => node.nodeId === 'render');
  const alteredRun = output => ({ ...f.run, nodeRuns: f.run.nodeRuns.map(node => node.nodeId === 'render' ? { ...node, output } : node) });
  const cases = [
    ['episode music changed', () => f.store.save('episodes', { ...f.episode, music: { ...f.music, volume: 0.25 } }), () => f.store.save('episodes', f.episode)],
    ['job music snapshot missing', () => { const job = { ...f.job }; delete job.musicSnapshot; f.store.save('jobs', job); }, () => f.store.save('jobs', f.job)],
    ['job music integrity missing', () => { const job = { ...f.job }; delete job.musicIntegrity; f.store.save('jobs', job); }, () => f.store.save('jobs', f.job)],
    ['job music integrity mismatched', () => f.store.save('jobs', { ...f.job, musicIntegrity: { ...f.job.musicIntegrity, sha256: 'f'.repeat(64) } }), () => f.store.save('jobs', f.job)],
    ['job renderer receipt missing', () => { const job = { ...f.job }; delete job.verifiedMusicIntegrity; f.store.save('jobs', job); }, () => f.store.save('jobs', f.job)],
    ['job renderer receipt mismatched', () => f.store.save('jobs', { ...f.job, verifiedMusicIntegrity: { ...f.job.musicIntegrity, size: f.job.musicIntegrity.size - 1 } }), () => f.store.save('jobs', f.job)],
    ['render music snapshot missing', () => { const output = { ...renderNode.output }; delete output.musicSnapshot; f.store.save('workflowRuns', alteredRun(output)); }, () => f.store.save('workflowRuns', f.run)],
    ['render music snapshot changed', () => f.store.save('workflowRuns', alteredRun({ ...renderNode.output, musicSnapshot: { ...f.music, trimStart: 0.2 } })), () => f.store.save('workflowRuns', f.run)],
    ['renderer music receipt missing', () => { const output = { ...renderNode.output }; delete output.verifiedMusicIntegrity; f.store.save('workflowRuns', alteredRun(output)); }, () => f.store.save('workflowRuns', f.run)],
    ['renderer music receipt mismatched', () => f.store.save('workflowRuns', alteredRun({ ...renderNode.output, verifiedMusicIntegrity: { ...f.job.musicIntegrity, sha256: 'e'.repeat(64) } })), () => f.store.save('workflowRuns', f.run)],
    ['music upload bytes tampered', () => writeFile(path.join(f.dataDir, 'uploads', path.basename(f.music.assetUrl)), Buffer.from('tampered')), () => writeFile(path.join(f.dataDir, 'uploads', path.basename(f.music.assetUrl)), f.bytes)],
    ['rights withdrawn', () => f.store.save('mediaRights', { ...f.rights, acknowledgedAt: '' }), () => f.store.save('mediaRights', f.rights)],
    ['rights attribution changed', () => f.store.save('mediaRights', { ...f.rights, attribution: 'Different composer' }), () => f.store.save('mediaRights', f.rights)],
    ['reviewed MP4 bytes changed', () => writeFile(path.join(f.dataDir, 'exports', f.rendered.filename), Buffer.from('tampered')), async () => {}],
  ];
  for (const [name, change, restore] of cases) {
    await t.test(name, async () => {
      await change();
      try {
        await assert.rejects(f.service.approve(f.body, { ownerId: 'fixture-owner' }), { status: 409 });
        await assert.rejects(f.service.publish(approval.id, { ownerId: 'fixture-owner' }), { status: 409 });
        assert.equal(f.providerCalls(), 0);
      } finally { await restore(); }
    });
  }
});

test('publication binds actual image and narration receipts to the registered assets and rights alongside music', { timeout: 180000 }, async t => {
  const f = await fixture(t, { sceneMedia: true });
  const receipts = f.rendered.verifiedSceneAssets;
  assert.ok(Array.isArray(receipts), 'the renderer must report actual consumed scene bytes');
  for (const [index, use] of ['asset', 'audio'].entries()) {
    const upload = f.sceneUploads[index];
    assert.deepEqual(receipts.find(item => item.sceneId === 'original-card' && item.use === use), {
      sceneId: 'original-card', use, assetUrl: upload.url, sha256: upload.sha256, size: upload.size,
    });
  }
  const approval = await f.service.approve(f.body, { ownerId: 'fixture-owner' });
  assert.equal(approval.manifest.render.sha256, f.rendered.sha256);
  assert.equal(f.providerCalls(), 0);
  const render = f.run.nodeRuns.find(node => node.nodeId === 'render');
  const changeOutput = output => f.store.save('workflowRuns', { ...f.run, nodeRuns: f.run.nodeRuns.map(node => node.nodeId === 'render' ? { ...node, output } : node) });
  const falsified = receipts.map((item, index) => index ? item : { ...item, sha256: 'f'.repeat(64) });
  const cases = [
    ['queued scene integrity missing', () => { const job = { ...f.job }; delete job.sceneIntegrity; f.store.save('jobs', job); }, () => f.store.save('jobs', f.job)],
    ['queued scene integrity mismatched', () => f.store.save('jobs', { ...f.job, sceneIntegrity: falsified }), () => f.store.save('jobs', f.job)],
    ['job receipt missing', () => { const job = { ...f.job }; delete job.verifiedSceneAssets; f.store.save('jobs', job); }, () => f.store.save('jobs', f.job)],
    ['render receipt missing', () => { const output = { ...render.output }; delete output.verifiedSceneAssets; changeOutput(output); }, () => f.store.save('workflowRuns', f.run)],
    ['render receipt differs from job', () => changeOutput({ ...render.output, verifiedSceneAssets: falsified }), () => f.store.save('workflowRuns', f.run)],
    ['matching forged receipts differ from registered bytes', () => { f.store.save('jobs', { ...f.job, verifiedSceneAssets: falsified }); changeOutput({ ...render.output, verifiedSceneAssets: falsified }); }, () => { f.store.save('jobs', f.job); f.store.save('workflowRuns', f.run); }],
    ['narration rights withdrawn', () => f.store.save('mediaRights', { ...f.sceneRights[1], acknowledgedAt: '' }), () => f.store.save('mediaRights', f.sceneRights[1])],
  ];
  for (const [name, change, restore] of cases) await t.test(name, async () => {
    await change();
    try {
      await assert.rejects(f.service.approve(f.body, { ownerId: 'fixture-owner' }), { status: 409 });
      await assert.rejects(f.service.publish(approval.id, { ownerId: 'fixture-owner' }), { status: 409 });
      assert.equal(f.providerCalls(), 0);
    } finally { await restore(); }
  });
});
