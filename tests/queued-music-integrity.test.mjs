import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { renderEpisode } from '../server/render.mjs';

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const rate = 48000;
const integrations = { integrationStatus: async () => ({ studio: { available: true } }) };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function tone(frequency, samples = rate) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  return bytes;
}

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-queued-music-'));
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    release.resolve();
    if (started) await rendered.promise;
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (url, method = 'GET', body) => fetch(base + url, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { dataDir, entered, release, rendered, request, raw: (url, options) => fetch(base + url, options) };
}

async function prepare(f, bytes) {
  const response = await f.raw('/api/uploads?name=music.wav', { method: 'POST', body: bytes });
  assert.equal(response.status, 201);
  const upload = await response.json();
  assert.equal(upload.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(upload.size, bytes.length);
  const state = await (await f.request('/api/state')).json();
  const createdResponse = await f.request('/api/episodes', 'POST', { channelId: state.channels[0].id, title: 'Music integrity', topic: 'Fixture' });
  assert.equal(createdResponse.status, 201);
  const episode = await createdResponse.json();
  const music = { assetUrl: upload.url, start: 0, trimStart: 0, volume: 1, source: { origin: 'own' } };
  const saved = await f.request(`/api/episodes/${episode.id}`, 'PUT', {
    expectedVersion: episode.version, format: '1:1',
    scenes: [{ ...episode.scenes[0], kind: 'title', title: 'Fixture', text: '', duration: 0.5, background: '#123456', layout: 'center' }], music,
  });
  assert.equal(saved.status, 200);
  const current = await saved.json();
  const submitted = await f.request(`/api/episodes/${episode.id}/render`, 'POST', { expectedVersion: current.version });
  assert.equal(submitted.status, 202);
  const job = await submitted.json();
  await f.entered.promise;
  return { upload, music, job };
}

async function completedJob(f, id) {
  await f.rendered.promise;
  // The queue persists its terminal state after the renderer's promise settles.
  await new Promise((resolve) => setImmediate(resolve));
  const response = await f.request('/api/state');
  assert.equal(response.status, 200);
  const job = (await response.json()).jobs.find((item) => item.id === id);
  assert.ok(job, 'submitted render remains observable');
  return job;
}

function amplitude(pcm, frequency) {
  const count = Math.floor(rate * 0.2), first = Math.floor(rate * 0.1);
  assert.ok(pcm.length >= (first + count) * 4, 'rendered audio contains the measurement window');
  let sin = 0, cos = 0;
  for (let i = 0; i < count; i++) {
    const value = pcm.readFloatLE((first + i) * 4), phase = 2 * Math.PI * frequency * i / rate;
    sin += value * Math.sin(phase); cos += value * Math.cos(phase);
  }
  return 2 * Math.hypot(sin, cos) / count;
}

for (const [name, replacement] of [
  ['same-size different audio', tone(880)],
  ['different-size audio', tone(880, rate / 2)],
]) {
  test(`queued music rejects ${name} substituted before rendering`, { timeout: 180000 }, async (t) => {
    try { await run(ffmpeg, ['-version']); }
    catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg is required to distinguish integrity rejection from renderer failure'); return; } throw error; }
    const f = await fixture(t);
    const { upload, music, job } = await prepare(f, tone(440));
    assert.deepEqual(job.musicSnapshot, music);
    assert.deepEqual(job.musicIntegrity, { sha256: upload.sha256, size: upload.size });
    await writeFile(path.join(f.dataDir, 'uploads', upload.filename), replacement);
    f.release.resolve();
    const result = await completedJob(f, job.id);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /music.*(?:integrity|changed|mismatch)|(?:integrity|changed|mismatch).*music/i);
    assert.equal(result.outputUrl, undefined, 'substitution must not publish a successful output');
  });
}

test('queued music removed before rendering fails with an integrity error', { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const { upload, job } = await prepare(f, tone(440));
  await rm(path.join(f.dataDir, 'uploads', upload.filename));
  f.release.resolve();
  const result = await completedJob(f, job.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /music.*(?:integrity|changed|mismatch)|(?:integrity|changed|mismatch).*music/i);
  assert.equal(result.outputUrl, undefined);
});

test('queued music redirected outside uploads fails with an integrity error', { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const original = tone(440);
  const { upload, job } = await prepare(f, original);
  const outside = path.join(f.dataDir, 'outside.wav');
  const source = path.join(f.dataDir, 'uploads', upload.filename);
  await writeFile(outside, original);
  await rm(source);
  try { await symlink(outside, source, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) { t.skip('File symlinks are unavailable on this platform'); return; }
    throw error;
  }
  f.release.resolve();
  const result = await completedJob(f, job.id);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /music.*(?:integrity|changed|mismatch)|(?:integrity|changed|mismatch).*music/i);
  assert.equal(result.outputUrl, undefined);
});

test('queued unchanged music renders the registered audio', { timeout: 180000 }, async (t) => {
  try { await run(ffmpeg, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg is required for real audio rendering'); return; } throw error; }
  const f = await fixture(t);
  const { upload, music, job } = await prepare(f, tone(440));
  assert.deepEqual(job.musicSnapshot, music);
  assert.deepEqual(job.musicIntegrity, { sha256: upload.sha256, size: upload.size });
  f.release.resolve();
  const result = await completedJob(f, job.id);
  assert.equal(result.status, 'completed', result.error);
  const output = await f.request(result.outputUrl);
  assert.equal(output.status, 200);
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', path.join(f.dataDir, 'exports', result.filename),
    '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'],
  { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  assert.ok(amplitude(stdout, 440) > 0.05, 'the uploaded tone is audible in the completed render');
  assert.ok(amplitude(stdout, 880) < amplitude(stdout, 440) * 0.1, 'the completed render does not contain the replacement tone');
});
