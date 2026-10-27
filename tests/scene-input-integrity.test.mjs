import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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

async function visual(root, extension, color) {
  const output = path.join(root, `${color}.${extension}`);
  const args = ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=128x128:r=10:d=1`];
  if (extension === 'png') args.push('-frames:v', '1', '-threads', '1');
  else args.push('-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  await run(ffmpeg, [...args, '-y', output], { windowsHide: true });
  return readFile(output);
}

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-scene-integrity-'));
  const entered = deferred(), release = deferred(), rendered = deferred();
  let restore = () => {}, started = false;
  const server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations,
    renderer: async (episode, options) => {
      started = true;
      entered.resolve();
      try {
        await release.promise;
        return await renderEpisode(episode, { ...options, onProgress: progress => {
          // The first segment's FFmpeg process has exited before this callback.
          // Restore synchronously before the next segment and final export.
          if (progress === 45) restore();
          options.onProgress(progress);
        } });
      } finally { restore(); rendered.resolve(); }
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
  return { dataDir, entered, release, rendered, request,
    upload: async (name, bytes) => {
      const response = await fetch(`${base}/api/uploads?name=${name}`, { method: 'POST', body: bytes });
      assert.equal(response.status, 201);
      return response.json();
    },
    restoreWith: fn => { restore = fn; },
  };
}

async function submit(f, kind, original) {
  const extension = kind === 'audio' ? 'wav' : kind.endsWith('image') ? 'png' : 'mp4';
  const asset = await f.upload(`scene.${extension}`, original);
  assert.equal(asset.sha256, createHash('sha256').update(original).digest('hex'));
  const music = await f.upload('music.wav', tone(220));
  const state = await (await f.request('/api/state')).json();
  const created = await f.request('/api/episodes', 'POST', { channelId: state.channels[0].id, title: 'Scene integrity', topic: 'Fixture' });
  assert.equal(created.status, 201);
  const episode = await created.json();
  const first = { ...episode.scenes[0], id: 'integrity-scene', kind: 'title', title: 'Fixture scene', text: '', narration: '', duration: 0.5, background: '#000000', layout: 'center', slots: [] };
  if (kind === 'audio') {
    const rights = await f.request(`/api/uploads/${asset.id}/rights`, 'POST', { origin: 'own' });
    assert.equal(rights.status, 201, await rights.text());
    first.audioUrl = asset.url;
    first.audioSource = { origin: 'own', useAs: 'illustration', sha256: asset.sha256 };
  }
  else if (kind.startsWith('base-')) { first.kind = kind.endsWith('image') ? 'image' : 'video'; first.assetUrl = asset.url; }
  else first.slots = [{ id: 'integrity-slot', name: 'Fixture slot', role: 'video-bg', dataBinding: 'custom', x: 0, y: 0, w: 100, h: 100, zIndex: 1, assetUrl: asset.url, mediaKind: kind.endsWith('image') ? 'image' : 'video' }];
  const second = { ...first, id: 'second-scene', kind: 'title', assetUrl: '', audioUrl: '', audioSource: undefined, slots: [] };
  const saved = await f.request(`/api/episodes/${episode.id}`, 'PUT', {
    expectedVersion: episode.version, format: '1:1', scenes: [first, second],
    music: { assetUrl: music.url, start: 0, trimStart: 0, volume: 0.2, source: { origin: 'own' } },
  });
  assert.equal(saved.status, 200, await saved.text());
  const response = await f.request(`/api/episodes/${episode.id}/render`, 'POST', {});
  assert.equal(response.status, 202, await response.clone().text());
  const job = await response.json();
  await f.entered.promise;
  return { asset, job };
}

async function completedJob(f, id) {
  await f.rendered.promise;
  // Queue persistence follows settlement of the renderer promise, in the same event-loop turn.
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

async function assertOriginalOutput(f, result, kind, asset) {
  const expected = { sceneId: 'integrity-scene', ...(kind.startsWith('slot-') ? { slotId: 'integrity-slot' } : {}), use: kind === 'audio' ? 'audio' : 'asset', assetUrl: asset.url, sha256: asset.sha256, size: asset.size };
  assert.ok(Array.isArray(result.verifiedSceneAssets), 'successful render must attest consumed scene inputs');
  assert.deepEqual(result.verifiedSceneAssets.find(item => item.assetUrl === asset.url), expected);
  const file = path.join(f.dataDir, 'exports', result.filename);
  if (kind === 'audio') {
    const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    assert.ok(amplitude(stdout, 440) > 0.05, 'the registered narration is audible');
    assert.ok(amplitude(stdout, 880) < amplitude(stdout, 440) * 0.1, 'substituted narration is not audible');
  } else {
    const { stdout } = await run(ffmpeg, ['-v', 'error', '-ss', '0.2', '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', windowsHide: true });
    assert.equal(stdout.length, 3);
    assert.ok(stdout[0] > stdout[2] + 80, `registered red visual, not substituted blue, must be rendered: ${[...stdout]}`);
  }
}

for (const kind of ['base-image', 'base-video', 'slot-image', 'slot-video', 'audio']) {
  test(`queued unchanged ${kind} renders and attests its registered bytes with music`, { timeout: 180000 }, async t => {
    const f = await fixture(t);
    const extension = kind === 'audio' ? 'wav' : kind.endsWith('image') ? 'png' : 'mp4';
    const original = kind === 'audio' ? tone(440) : await visual(f.dataDir, extension, 'red');
    const { asset, job } = await submit(f, kind, original);
    f.release.resolve();
    const result = await completedJob(f, job.id);
    assert.equal(result.status, 'completed', result.error);
    await assertOriginalOutput(f, result, kind, asset);
  });
}

for (const kind of ['base-image', 'base-video', 'slot-image', 'slot-video', 'audio']) {
  test(`queued ${kind} is bound to consumed bytes even after a transient replacement is restored`, { timeout: 180000 }, async t => {
    const f = await fixture(t);
    const extension = kind === 'audio' ? 'wav' : kind.endsWith('image') ? 'png' : 'mp4';
    const original = kind === 'audio' ? tone(440) : await visual(f.dataDir, extension, 'red');
    const replacement = kind === 'audio' ? tone(880) : await visual(f.dataDir, extension, 'blue');
    const { asset, job } = await submit(f, kind, original);
    const source = path.join(f.dataDir, 'uploads', asset.filename);
    f.restoreWith(() => writeFileSync(source, original));
    await writeFile(source, replacement);
    f.release.resolve();
    const result = await completedJob(f, job.id);
    assert.deepEqual(await readFile(source), original, 'the upload is restored before the result is inspected');
    if (result.status === 'failed') {
      assert.equal(result.outputUrl, undefined, 'a rejected substitution cannot become a reviewable export');
    } else {
      assert.equal(result.status, 'completed', result.error);
      await assertOriginalOutput(f, result, kind, asset);
    }
  });
}
