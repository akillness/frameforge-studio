import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { renderEpisode } from '../server/render.mjs';

const exec = promisify(execFile);
const rate = 48000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function tone(frequency) {
  const wav = Buffer.alloc(44 + rate * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(rate * 2, 40);
  for (let i = 0; i < rate; i++) wav.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + 2 * i);
  return wav;
}

function amplitude(pcm, frequency) {
  let real = 0, imaginary = 0;
  const start = Math.floor(rate * 0.1), end = Math.floor(rate * 0.4);
  for (let i = start; i < end; i++) {
    const sample = pcm.readInt16LE(i * 2);
    real += sample * Math.cos(2 * Math.PI * frequency * i / rate);
    imaginary += sample * Math.sin(2 * Math.PI * frequency * i / rate);
  }
  return Math.hypot(real, imaginary) / (end - start);
}

test('generated scene narration keeps its byte identity and explicit credit through API save, mixed render and review', { timeout: 180000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'narration-music-rights-'));
  const narration = tone(440), music = tone(880), external = [];
  let resolveRendered;
  const rendered = new Promise(resolve => { resolveRendered = resolve; });
  const unexpected = async url => { external.push(String(url)); throw new Error('Unexpected provider request'); };
  const app = createApp({ dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}) },
    speech: { listVoices: async () => ({ available: true, provider: 'fixture-speech', voices: [{ id: 'Fixture voice' }] }),
      synthesize: async ({ outputPath }) => { await writeFile(outputPath, narration); return { duration: 1 }; } },
    renderer: async (episode, options) => { try { return await renderEpisode(episode, options); } finally { resolveRendered(); } },
    mediaOptions: { fetchImpl: unexpected }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: unexpected }, publicationOptions: { fetchImpl: unexpected },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  async function request(url, method = 'GET', body) {
    const response = await fetch(base + url, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  }
  async function api(url, method = 'GET', body) {
    const result = await request(url, method, body);
    assert.ok(result.status >= 200 && result.status < 300, `${method} ${url}: ${result.status} ${JSON.stringify(result.value)}`);
    return result.value;
  }
  async function until(load, done) {
    for (let turn = 0; turn < 2000; turn++) {
      const value = await load();
      if (done(value)) return value;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Expected state transition did not occur');
  }
  const uploadResponse = await fetch(`${base}/api/uploads?name=music.wav`, { method: 'POST', headers: { origin: base }, body: music });
  assert.equal(uploadResponse.status, 201);
  const musicUpload = await uploadResponse.json();
  const musicSource = { origin: 'third-party', sha256: hash(music), sourceUrl: 'https://example.invalid/music', licenseId: 'CC-BY-4.0', attribution: 'Fixture Composer' };
  await api(`/api/uploads/${musicUpload.id}/rights`, 'POST', musicSource);
  let channel = await api('/api/channels', 'POST', { name: 'Fixture', category: 'information', platform: 'YouTube' });
  channel = await api(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: `UC${'A'.repeat(22)}`, expectedUpdatedAt: channel.updatedAt });
  let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Narration rights', topic: 'Fixture' });
  episode = await api(`/api/episodes/${episode.id}`, 'PUT', { expectedVersion: episode.version, format: '1:1', scenes: [{ ...episode.scenes[0], kind: 'title', title: 'Fixture', text: 'Fixture narration', narration: 'Fixture narration', duration: 1, background: '#173940', layout: 'center' }], music: { assetUrl: musicUpload.url, start: 0, trimStart: 0, volume: 0.5, source: musicSource } });
  const job = await api(`/api/episodes/${episode.id}/narration`, 'POST', { expectedVersion: episode.version, voice: 'Fixture voice', sceneIds: [episode.scenes[0].id] });
  const state = await until(() => api('/api/state'), value => ['completed', 'failed'].includes(value.narrationJobs.find(item => item.id === job.id)?.status));
  assert.equal(state.narrationJobs.find(item => item.id === job.id).status, 'completed');
  episode = state.episodes.find(item => item.id === episode.id);
  const scene = episode.scenes[0];
  const voiceUpload = (await api('/api/uploads')).find(item => item.url === scene.audioUrl);
  assert.ok(voiceUpload, 'generated narration must be registered as an upload');
  assert.equal(voiceUpload.sha256, hash(narration), 'registration binds original bytes before any rights operation');
  assert.deepEqual(await api(`/api/uploads/${voiceUpload.id}/rights`), []);
  const denied = await request(`/api/episodes/${episode.id}/render`, 'POST', {});
  assert.equal(denied.status, 409, 'a narration without explicit rights cannot be rendered with music');
  const source = { origin: 'third-party', useAs: 'illustration', sha256: hash(narration), sourceUrl: 'https://example.invalid/narration', licenseId: 'CC-BY-4.0', attribution: 'Fixture Narrator' };
  const clearance = await api(`/api/uploads/${voiceUpload.id}/rights`, 'POST', source);
  assert.equal(clearance.sha256, hash(narration));
  const forged = await request(`/api/episodes/${episode.id}`, 'PUT', { expectedVersion: episode.version, scenes: [{ ...scene, audioSource: { ...source, attribution: 'Forged Narrator' } }] });
  assert.equal(forged.status, 409, 'a source with altered attribution must not be authorized');
  episode = await api(`/api/episodes/${episode.id}`, 'PUT', { expectedVersion: episode.version, scenes: [{ ...scene, audioSource: source }] });
  assert.deepEqual(episode.scenes[0].audioSource, source, 'scene source survives the public API normalization');
  const roundtrip = (await api('/api/state')).episodes.find(item => item.id === episode.id);
  assert.deepEqual(roundtrip.scenes[0].audioSource, source);
  const types = ['script', 'storyboard', 'render', 'review'];
  const template = await api('/api/workflows', 'POST', { name: 'Narration workflow', nodes: types.map((type, i) => ({ id: type, type, x: i * 200, y: 0, config: type === 'script' ? { agent: 'existing' } : {} })), edges: types.slice(1).map((target, i) => ({ id: `e${i}`, source: types[i], target })) });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const started = await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, expectedEpisodeVersion: episode.version, expectedWorkflowVersion: workflow.version, selectedStages: types });
  await rendered;
  const run = await until(() => api(`/api/workflow-runs/${started.id}`), value => ['awaiting_review', 'failed', 'cancelled'].includes(value.status));
  assert.equal(run.status, 'awaiting_review', JSON.stringify(run));
  const output = run.nodeRuns.find(node => node.nodeId === 'render').output;
  assert.deepEqual(output.verifiedSceneAssets.find(item => item.sceneId === scene.id && item.use === 'audio'), { sceneId: scene.id, use: 'audio', assetUrl: voiceUpload.url, sha256: hash(narration), size: narration.length });
  assert.deepEqual(output.verifiedMusicIntegrity, { sha256: hash(music), size: music.length });
  const renderJob = (await api('/api/state')).jobs.find(item => item.id === output.jobId);
  const mp4 = await readFile(path.join(dataDir, 'exports', renderJob.filename));
  assert.equal(hash(mp4), output.sha256);
  const pcmPath = path.join(dataDir, 'mixed.pcm');
  await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', path.join(dataDir, 'exports', renderJob.filename), '-ac', '1', '-ar', String(rate), '-f', 's16le', pcmPath]);
  const pcm = await readFile(pcmPath);
  assert.ok(amplitude(pcm, 440) > 100, 'the final MP4 contains the narration tone');
  assert.ok(amplitude(pcm, 880) > 100, 'the final MP4 contains the music tone');
  const voicePath = path.join(dataDir, 'uploads', path.basename(voiceUpload.url));
  await writeFile(voicePath, tone(660));
  try {
    const rejected = await request(`/api/workflows/${workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId: 'review', decision: 'approved', notes: '', expectedEpisodeVersion: run.episodeVersion });
    assert.equal(rejected.status, 409, 'review must reject changed narration bytes');
  } finally { await writeFile(voicePath, narration); }
  const reviewed = await api(`/api/workflows/${workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId: 'review', decision: 'approved', notes: 'Reviewed fixture', expectedEpisodeVersion: run.episodeVersion });
  assert.equal(reviewed.reviews.review.sha256, output.sha256);
  const approvalBody = { workflowId: workflow.id, runId: run.id, reviewNodeId: 'review', expectedEpisodeVersion: run.episodeVersion, title: 'Narration rights', description: 'Fixture description', categoryId: '25', tags: ['fixture'], selfDeclaredMadeForKids: false, containsSyntheticMedia: true, disclosureRationale: 'Fixture synthesized narration', rightsAcknowledged: true };
  // The public API has no withdrawal endpoint; mutate only its existing clearance.
  const db = new DatabaseSync(path.join(dataDir, 'studio.sqlite'));
  try {
    db.prepare('UPDATE entities SET data = ? WHERE kind = ? AND id = ?').run(JSON.stringify({ ...clearance, acknowledgedAt: '' }), 'mediaRights', clearance.id);
    const withdrawn = await request('/api/publication/approvals', 'POST', approvalBody);
    assert.equal(withdrawn.status, 409, 'withdrawn narration rights must block publication approval');
  } finally {
    db.prepare('UPDATE entities SET data = ? WHERE kind = ? AND id = ?').run(JSON.stringify(clearance), 'mediaRights', clearance.id);
    db.close();
  }
  const approval = await api('/api/publication/approvals', 'POST', approvalBody);
  assert.equal(approval.manifest.render.sha256, output.sha256);
  for (const item of [source, musicSource]) for (const value of [item.attribution, item.licenseId, item.sourceUrl]) {
    assert.ok(approval.manifest.credits.includes(value), `missing credit ${value}`);
    assert.ok(approval.manifest.description.includes(value), `missing description credit ${value}`);
  }
  assert.deepEqual(external, []);
});
