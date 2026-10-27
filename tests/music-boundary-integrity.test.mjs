import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { renderEpisode } from '../server/render.mjs';

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const rate = 48000;
const name = '33333333-3333-4333-8333-333333333333.wav';
const episode = {
  format: '1:1',
  scenes: [{ id: 'first', kind: 'title', title: 'Fixture', text: '', duration: 0.5, background: '#123456', layout: 'center' }],
  music: { assetUrl: `/api/uploads/${name}`, start: 0, trimStart: 0, volume: 1, source: { origin: 'own' } },
};

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

function amplitude(pcm, frequency) {
  const first = Math.round(rate * 0.1), count = Math.round(rate * 0.2);
  assert.ok(pcm.length >= (first + count) * 4, 'decoded output contains the measurement window');
  let sin = 0, cos = 0;
  for (let i = 0; i < count; i++) {
    const value = pcm.readFloatLE((first + i) * 4), phase = 2 * Math.PI * frequency * i / rate;
    sin += value * Math.sin(phase); cos += value * Math.cos(phase);
  }
  return 2 * Math.hypot(sin, cos) / count;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-music-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'actual');
  await mkdir(path.join(dataDir, 'uploads'), { recursive: true });
  const bytes = tone(440);
  await writeFile(path.join(dataDir, 'uploads', name), bytes);
  return { root, dataDir, integrity: { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } };
}

test('music rejects a redirected ancestor of the upload root', { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'redirected');
  try {
    // Windows junctions normally avoid the developer-mode/admin privilege needed for symlinks.
    await symlink(f.dataDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Windows cannot create the directory junction: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(renderEpisode(episode, { dataDir: alias, musicIntegrity: f.integrity }),
    (error) => error.code === 'MUSIC_INTEGRITY');
});

test('rendered music retains verified bytes when files are replaced after snapshot', { timeout: 180000 }, async (t) => {
  try { await run(ffmpeg, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg is required to measure the rendered audio'); return; } throw error; }
  const f = await fixture(t);
  const replacement = tone(880);
  let replaced = false;
  const result = await renderEpisode(episode, {
    dataDir: f.dataDir,
    musicIntegrity: f.integrity,
    onProgress(progress) {
      if (replaced || progress >= 100) return;
      replaced = true;
      writeFileSync(path.join(f.dataDir, 'uploads', name), replacement);
      // An attacker able to write the render workspace may also replace an intermediate snapshot.
      for (const entry of readdirSync(path.join(f.dataDir, 'render-work'), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const snapshot = path.join(f.dataDir, 'render-work', entry.name, 'music.wav');
        if (existsSync(snapshot)) writeFileSync(snapshot, replacement);
      }
    },
  });
  assert.equal(replaced, true, 'mutation occurred after snapshot and before final mix');
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', path.join(f.dataDir, 'exports', result.filename),
    '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'],
  { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  const original = amplitude(stdout, 440), substituted = amplitude(stdout, 880);
  assert.ok(original > 0.05, 'the verified 440 Hz music is audible');
  assert.ok(substituted < original * 0.1, 'the substituted 880 Hz music is not audible');
});
