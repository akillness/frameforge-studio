import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '../server/process.mjs';
import { renderEpisode } from '../server/render.mjs';

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const rate = 48000;
const videoName = '11111111-1111-4111-8111-111111111111.mp4';
const narrationName = '22222222-2222-4222-8222-222222222222.wav';
const musicName = '33333333-3333-4333-8333-333333333333.wav';
const url = (name) => `/api/uploads/${name}`;
const music = { assetUrl: url(musicName), start: 0.25, trimStart: 0.4, volume: 0.4, source: { origin: 'own' } };

async function rootFor(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-music-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'uploads'));
  return root;
}

function episode() {
  const scene = {
    kind: 'video', title: 'Fixture', text: '', duration: 1,
    background: '#123456', layout: 'center', assetUrl: url(videoName),
    audioUrl: url(narrationName), audioVolume: 1,
  };
  return { format: '1:1', scenes: [{ ...scene, id: 'first' }, { ...scene, id: 'second' }] };
}

async function decode(root, result) {
  const { stdout } = await run(ffmpeg, [
    '-v', 'error', '-i', path.join(root, 'exports', result.filename),
    '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  return stdout;
}

// A windowed single-frequency projection measures decoded audio, not encoder arguments.
// The windows contain whole cycles for all fixture frequencies and avoid segment edges.
function amplitude(pcm, frequency, start, duration = 0.1) {
  const first = Math.round(start * rate), count = Math.round(duration * rate);
  assert.ok(pcm.length >= (first + count) * 4, `decoded audio must reach ${start + duration}s`);
  let sin = 0, cos = 0;
  for (let i = 0; i < count; i++) {
    const sample = pcm.readFloatLE((first + i) * 4);
    const phase = 2 * Math.PI * frequency * i / rate;
    sin += sample * Math.sin(phase);
    cos += sample * Math.cos(phase);
  }
  return 2 * Math.hypot(sin, cos) / count;
}

test('background music mixes with narration, follows its episode offset across scenes and stops without looping', { timeout: 180000 }, async (t) => {
  try { await execute(ffmpeg, ['-version']); await execute(ffprobe, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg and FFprobe are required for real audio rendering'); return; } throw error; }
  const root = await rootFor(t);
  const uploads = path.join(root, 'uploads');
  // The video's 330 Hz audio must be replaced by the explicitly attached 440 Hz narration.
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=30:d=1',
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=${rate}:duration=1`,
    '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', '-threads', '1', path.join(uploads, videoName)]);
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=1`, path.join(uploads, narrationName)]);
  // The change from 660 Hz to 880 Hz makes an accidental scene-2 restart observable.
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=660:sample_rate=${rate}:duration=0.95`,
    '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=${rate}:duration=0.85`,
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]', '-map', '[a]', path.join(uploads, musicName)]);

  const legacy = await decode(root, await renderEpisode(episode(), { dataDir: root }));
  const mixed = await decode(root, await renderEpisode({ ...episode(), music }, { dataDir: root }));
  for (const start of [0.5, 1.2]) {
    const primary = amplitude(legacy, 440, start);
    assert.ok(primary > 0.02, 'legacy output contains the narration in each scene');
    assert.ok(amplitude(legacy, 330, start) < primary * 0.1, 'attached narration replaces source video audio');
    assert.ok(amplitude(legacy, 660, start) < primary * 0.1 && amplitude(legacy, 880, start) < primary * 0.1, 'omitting music adds no music tones');
    assert.ok(amplitude(mixed, 440, start) > primary * 0.3, 'mix retains audible narration');
  }
  const primary = amplitude(legacy, 440, 0.5);
  assert.ok(amplitude(mixed, 660, 0.5) > primary * 0.05, 'first scene contains the music before its frequency change');
  assert.ok(amplitude(mixed, 880, 1.2) > primary * 0.05, 'second scene continues at the later music offset');
  assert.ok(amplitude(mixed, 660, 1.2) < amplitude(mixed, 880, 1.2) * 0.2, 'second scene did not restart music');
  for (const start of [0.05, 1.8]) {
    assert.ok(amplitude(mixed, 660, start) < primary * 0.05 && amplitude(mixed, 880, start) < primary * 0.05,
      'music is absent before its placement and after its source ends');
    assert.ok(amplitude(mixed, 440, start) > primary * 0.3, 'narration continues outside the music window');
  }
});

test('correlated loud narration and music mix without audible clipping', { timeout: 180000 }, async (t) => {
  try { await execute(ffmpeg, ['-version']); await execute(ffprobe, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg and FFprobe are required for real audio rendering'); return; } throw error; }
  const root = await rootFor(t);
  const uploads = path.join(root, 'uploads');
  // Closely spaced loud tones periodically reinforce, while remaining independently measurable.
  for (const [name, frequency] of [[narrationName, 440], [musicName, 450]]) {
    await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${rate}:duration=1`,
      '-af', 'volume=7', path.join(uploads, name)]);
  }
  const timeline = { format: '1:1', scenes: [{ id: 'loud', kind: 'title', title: 'Fixture', text: '',
    duration: 1, background: '#123456', layout: 'center', audioUrl: url(narrationName), audioVolume: 1 }] };
  const legacy = await decode(root, await renderEpisode(timeline, { dataDir: root }));
  const mixed = await decode(root, await renderEpisode({ ...timeline,
    music: { ...music, start: 0, trimStart: 0, volume: 1 } }, { dataDir: root }));
  const reference = amplitude(legacy, 440, 0.3);
  const fundamental = amplitude(mixed, 440, 0.3);
  const referenceDistortion = amplitude(legacy, 1320, 0.3) / reference;
  const distortion = amplitude(mixed, 1320, 0.3) / fundamental;
  assert.ok(reference > 0.5, 'fixture exercises genuinely loud narration');
  assert.ok(fundamental > reference * 0.3, 'mix does not avoid clipping by silencing the output');
  assert.ok(amplitude(mixed, 450, 0.3) > reference * 0.2, 'the loud music is actually present');
  assert.ok(distortion < referenceDistortion + 0.08,
    'mixed tone must not gain the strong third harmonic produced by clipped waveforms');
});

test('renderer rejects missing or nonlocal music and invalid music timing or volume', { timeout: 180000 }, async (t) => {
  try { await execute(ffmpeg, ['-version']); await execute(ffprobe, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg and FFprobe are required to distinguish rejection from a renderer failure'); return; } throw error; }
  const root = await rootFor(t);
  // A valid existing music file prevents missing-file errors from masking numeric validation.
  const wav = Buffer.alloc(44 + 4800 * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(path.join(root, 'uploads', musicName), wav);
  const timeline = { format: '1:1', scenes: [{ id: 'fixture', kind: 'title', title: 'Fixture', text: '', duration: 0.25, background: '#123456', layout: 'center' }] };
  for (const [name, patch] of [
    ['missing upload', { assetUrl: url('44444444-4444-4444-8444-444444444444.wav') }],
    ['file URL', { assetUrl: 'file:///nonlocal.wav' }],
    ['traversal', { assetUrl: '/api/uploads/../outside.wav' }],
    ['negative placement', { start: -1 }],
    ['nonfinite placement', { start: Infinity }],
    ['placement at timeline end', { start: 0.25 }],
    ['placement far beyond timeline', { start: 1800 }],
    ['negative trim', { trimStart: -1 }],
    ['nonfinite trim', { trimStart: NaN }],
    ['negative volume', { volume: -1 }],
    ['nonfinite volume', { volume: Infinity }],
  ]) {
    await assert.rejects(renderEpisode({ ...timeline, music: { ...music, ...patch } }, { dataDir: root }),
      name === 'missing upload' ? /enoent|no such file|not found/i : /invalid|only uploaded|escapes|unsupported/i, name);
  }
});
