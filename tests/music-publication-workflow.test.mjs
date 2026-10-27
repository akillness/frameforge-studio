import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { renderEpisode } from '../server/render.mjs';

function tone() {
  const rate = 48000, samples = rate, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return wav;
}

test('real workflow queue binds a rights-cleared music render to its exact review and publication manifest without provider calls', { timeout: 180000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'music-workflow-publication-'));
  let resolveRendered;
  const rendered = new Promise(resolve => { resolveRendered = resolve; });
  const external = [];
  const unexpected = async url => { external.push(String(url)); throw new Error('Unexpected external request'); };
  const app = createApp({ dataDir, loginToken: '', publicOrigin: '',
    renderer: async (episode, options) => { try { return await renderEpisode(episode, options); } finally { resolveRendered(); } },
    integrations: { integrationStatus: async () => ({}) },
    mediaOptions: { fetchImpl: unexpected }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: unexpected }, publicationOptions: { fetchImpl: unexpected },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  async function api(url, method = 'GET', body) {
    const response = await fetch(base + url, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.ok(response.ok, `${method} ${url}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  const wav = tone();
  const uploadResponse = await fetch(`${base}/api/uploads?name=fixture.wav`, { method: 'POST', headers: { origin: base }, body: wav });
  assert.equal(uploadResponse.status, 201);
  const upload = await uploadResponse.json();
  const sha256 = createHash('sha256').update(wav).digest('hex');
  assert.equal(upload.sha256, sha256);
  const source = { origin: 'third-party', sha256, sourceUrl: 'https://example.invalid/music', licenseId: 'CC-BY-4.0', attribution: 'Workflow Composer' };
  await api(`/api/uploads/${upload.id}/rights`, 'POST', source);
  let channel = await api('/api/channels', 'POST', { name: 'Fixture', category: 'information', platform: 'YouTube' });
  channel = await api(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: `UC${'A'.repeat(22)}`, expectedUpdatedAt: channel.updatedAt });
  let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Music workflow', topic: 'Original fixture' });
  episode = await api(`/api/episodes/${episode.id}`, 'PUT', { expectedVersion: episode.version, format: '1:1', scenes: [{ ...episode.scenes[0], kind: 'title', title: 'Fixture', text: 'Original card', duration: 1, background: '#173940', layout: 'center' }], music: { assetUrl: upload.url, start: 0, trimStart: 0, volume: 0.5, source } });
  const types = ['script', 'storyboard', 'render', 'review'];
  const template = await api('/api/workflows', 'POST', { name: 'Music workflow', nodes: types.map((type, i) => ({ id: type, type, x: i * 200, y: 0, config: type === 'script' ? { agent: 'existing' } : {} })), edges: types.slice(1).map((target, i) => ({ id: `e${i}`, source: types[i], target })) });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const started = await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, expectedEpisodeVersion: episode.version, expectedWorkflowVersion: workflow.version, selectedStages: types });
  await rendered;
  let run;
  for (let turn = 0; turn < 2000; turn++) {
    run = await api(`/api/workflow-runs/${started.id}`);
    if (['awaiting_review', 'failed', 'cancelled'].includes(run.status)) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(run.status, 'awaiting_review', JSON.stringify(run));
  const output = run.nodeRuns.find(node => node.nodeId === 'render').output;
  const state = await api('/api/state');
  const job = state.jobs.find(item => item.id === output.jobId);
  assert.deepEqual(job.musicSnapshot, episode.music);
  assert.deepEqual(output.musicSnapshot, episode.music);
  assert.deepEqual(output.verifiedMusicIntegrity, { sha256, size: wav.length });
  assert.deepEqual(job.verifiedMusicIntegrity, output.verifiedMusicIntegrity);
  const mp4 = await readFile(path.join(dataDir, 'exports', job.filename));
  assert.equal(createHash('sha256').update(mp4).digest('hex'), output.sha256);
  const reviewed = await api(`/api/workflows/${workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId: 'review', decision: 'approved', notes: 'Reviewed exact fixture render', expectedEpisodeVersion: run.episodeVersion });
  assert.equal(reviewed.reviews.review.jobId, job.id);
  assert.equal(reviewed.reviews.review.sha256, output.sha256);
  const approval = await api('/api/publication/approvals', 'POST', { workflowId: workflow.id, runId: run.id, reviewNodeId: 'review', expectedEpisodeVersion: run.episodeVersion, title: 'Music workflow', description: 'Fixture description', categoryId: '25', tags: ['fixture'], selfDeclaredMadeForKids: false, containsSyntheticMedia: false, disclosureRationale: 'Original fixture', rightsAcknowledged: true });
  assert.equal(approval.manifest.render.sha256, output.sha256);
  for (const value of [source.attribution, source.licenseId, source.sourceUrl]) {
    assert.ok(approval.manifest.credits.includes(value));
    assert.ok(approval.manifest.description.includes(value));
  }
  assert.deepEqual(external, [], 'review and final approval do not contact any provider');
});
