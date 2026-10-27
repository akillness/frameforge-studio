import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../server/app.mjs';
import { renderEpisode } from '../server/render.mjs';

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const rate = 48000;
const integrations = { integrationStatus: async () => ({ studio: { available: true } }) };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function tone(frequency) {
  const bytes = Buffer.alloc(44 + rate * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(rate * 2, 40);
  for (let i = 0; i < rate; i++) bytes.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  return bytes;
}

async function video(root, color) {
  const file = path.join(root, `${color}.mp4`);
  await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=128x128:r=10:d=1`, '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file], { windowsHide: true });
  return readFile(file);
}

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-no-music-integrity-'));
  const entered = deferred(), release = deferred(), rendered = deferred();
  let started = false;
  const server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations,
    renderer: async (episode, options) => {
      started = true;
      entered.resolve();
      try { await release.promise; return await renderEpisode(episode, options); }
      finally { rendered.resolve(); }
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, method = 'GET', body) => fetch(base + url, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  t.after(async () => {
    release.resolve();
    if (started) await rendered.promise;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, entered, release, rendered, request, upload: async (name, bytes) => {
    const response = await fetch(`${base}/api/uploads?name=${name}`, { method: 'POST', body: bytes });
    assert.equal(response.status, 201);
    return response.json();
  } };
}

async function submit(f, kind, bytes) {
  const asset = await f.upload(`scene.${kind === 'audio' ? 'wav' : 'mp4'}`, bytes);
  assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(asset.size, bytes.length);
  const state = await (await f.request('/api/state')).json();
  const created = await f.request('/api/episodes', 'POST', { channelId: state.channels[0].id, title: 'No music integrity', topic: 'Fixture' });
  assert.equal(created.status, 201);
  const episode = await created.json();
  const scene = { ...episode.scenes[0], id: 'integrity-scene', kind: 'title', title: 'Fixture', text: '', narration: '', duration: 0.5, background: '#000000', layout: 'center', slots: [] };
  if (kind === 'audio') scene.audioUrl = asset.url;
  else if (kind === 'base-video') { scene.kind = 'video'; scene.assetUrl = asset.url; }
  else scene.slots = [{ id: 'integrity-slot', name: 'Fixture slot', role: 'video-bg', dataBinding: 'custom', x: 0, y: 0, w: 100, h: 100, zIndex: 1, assetUrl: asset.url, mediaKind: 'video' }];
  const saved = await f.request(`/api/episodes/${episode.id}`, 'PUT', { expectedVersion: episode.version, format: '1:1', scenes: [scene], music: null });
  assert.equal(saved.status, 200, await saved.text());
  const response = await f.request(`/api/episodes/${episode.id}/render`, 'POST', {});
  assert.equal(response.status, 202, await response.clone().text());
  const job = await response.json();
  await f.entered.promise;
  return { asset, job };
}

async function completedJob(f, id) {
  await f.rendered.promise;
  await new Promise(resolve => setImmediate(resolve));
  const response = await f.request('/api/state');
  assert.equal(response.status, 200);
  const job = (await response.json()).jobs.find(item => item.id === id);
  assert.ok(job, 'queued job remains observable');
  return job;
}

function amplitude(pcm, frequency) {
  const start = rate / 10, count = rate / 5;
  assert.ok(pcm.length >= (start + count) * 4);
  let sin = 0, cos = 0;
  for (let i = 0; i < count; i++) {
    const sample = pcm.readFloatLE((start + i) * 4), phase = 2 * Math.PI * frequency * i / rate;
    sin += sample * Math.sin(phase); cos += sample * Math.cos(phase);
  }
  return 2 * Math.hypot(sin, cos) / count;
}

for (const kind of ['base-video', 'slot-video', 'audio']) {
  test(`no-music ${kind} renders and attests the registered input bytes`, { timeout: 180000 }, async t => {
    const f = await fixture(t);
    const original = kind === 'audio' ? tone(440) : await video(f.dataDir, 'red');
    const { asset, job } = await submit(f, kind, original);
    f.release.resolve();
    const result = await completedJob(f, job.id);
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(result.verifiedSceneAssets.find(item => item.assetUrl === asset.url), {
      sceneId: 'integrity-scene', ...(kind === 'slot-video' ? { slotId: 'integrity-slot' } : {}),
      use: kind === 'audio' ? 'audio' : 'asset', assetUrl: asset.url, sha256: asset.sha256, size: asset.size,
    });
    const output = path.join(f.dataDir, 'exports', result.filename);
    if (kind === 'audio') {
      const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', output, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      assert.ok(amplitude(stdout, 440) > 0.05, 'registered narration is audible');
      assert.ok(amplitude(stdout, 880) < amplitude(stdout, 440) * 0.1, 'replacement narration is not audible');
    } else {
      const { stdout } = await run(ffmpeg, ['-v', 'error', '-ss', '0.2', '-i', output, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', windowsHide: true });
      assert.equal(stdout.length, 3);
      assert.ok(stdout[0] > stdout[2] + 80, `registered red video is rendered: ${[...stdout]}`);
    }
  });

  test(`no-music queued ${kind} rejects substituted input before export`, { timeout: 180000 }, async t => {
    const f = await fixture(t);
    const original = kind === 'audio' ? tone(440) : await video(f.dataDir, 'red');
    const replacement = kind === 'audio' ? tone(880) : await video(f.dataDir, 'blue');
    const { asset, job } = await submit(f, kind, original);
    await writeFile(path.join(f.dataDir, 'uploads', asset.filename), replacement);
    f.release.resolve();
    const result = await completedJob(f, job.id);
    assert.equal(result.status, 'failed', 'changed input must not be accepted as the queued render');
    assert.equal(result.outputUrl, undefined, 'rejected input cannot produce a reviewable output');
  });
}

test('no-music render rejects a malformed video instead of exporting it', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const { job } = await submit(f, 'base-video', Buffer.from('not a video'));
  f.release.resolve();
  const result = await completedJob(f, job.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.outputUrl, undefined, 'invalid media cannot produce a reviewable output');
});

test('no-music truncated narration cannot be attested as the untruncated source', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const complete = tone(440);
  const truncated = complete.subarray(0, 44 + rate);
  const { asset, job } = await submit(f, 'audio', truncated);
  f.release.resolve();
  const result = await completedJob(f, job.id);
  if (result.status === 'failed') {
    assert.equal(result.outputUrl, undefined);
  } else {
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(result.verifiedSceneAssets.find(item => item.assetUrl === asset.url), {
      sceneId: 'integrity-scene', use: 'audio', assetUrl: asset.url,
      sha256: createHash('sha256').update(truncated).digest('hex'), size: truncated.length,
    });
    assert.notEqual(asset.sha256, createHash('sha256').update(complete).digest('hex'));
  }
});
