import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '../server/process.mjs';
import { renderEpisode } from '../server/render.mjs';

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const rate = 48000;
const narrationName = '22222222-2222-4222-8222-222222222222.wav';
const musicId = '33333333-3333-4333-8333-333333333333';
const url = (name) => `/api/uploads/${name}`;

async function decode(root, result) {
  const { stdout } = await run(ffmpeg, [
    '-v', 'error', '-i', path.join(root, 'exports', result.filename),
    '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  return stdout;
}

// Frequency projections distinguish music, discarded prefix, and narration in the decoded mix.
function amplitude(pcm, frequency, start) {
  const first = Math.round(start * rate), count = Math.round(0.1 * rate);
  assert.ok(pcm.length >= (first + count) * 4, `decoded audio must reach ${start + 0.1}s`);
  let sin = 0, cos = 0;
  for (let i = 0; i < count; i++) {
    const sample = pcm.readFloatLE((first + i) * 4);
    const phase = 2 * Math.PI * frequency * i / rate;
    sin += sample * Math.sin(phase);
    cos += sample * Math.cos(phase);
  }
  return 2 * Math.hypot(sin, cos) / count;
}

for (const { extension, encoder } of [
  { extension: 'wav', encoder: 'pcm_s16le' },
  { extension: 'mp3', encoder: 'libmp3lame' },
  { extension: 'ogg', encoder: 'libvorbis' },
]) {
  test(`${extension} music preserves trim, placement, gain and narration in decoded output`, { timeout: 180000 }, async (t) => {
    try { await execute(ffmpeg, ['-version']); await execute(ffprobe, ['-version']); }
    catch (error) {
      if (error.code === 'ENOENT') { t.skip('FFmpeg and FFprobe are required for real audio rendering'); return; }
      throw error;
    }
    const root = await mkdtemp(path.join(tmpdir(), 'frameforge-music-codec-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const uploads = path.join(root, 'uploads');
    await mkdir(uploads);
    const musicName = `${musicId}.${extension}`;
    await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=400:sample_rate=${rate}:duration=2`,
      '-c:a', 'pcm_s16le', path.join(uploads, narrationName)]);
    // The 600 Hz prefix must be removed; 800 then 1000 Hz identify the retained positions.
    await execute(ffmpeg, ['-v', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=600:sample_rate=${rate}:duration=0.6`,
      '-f', 'lavfi', '-i', `sine=frequency=800:sample_rate=${rate}:duration=0.7`,
      '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=${rate}:duration=0.4`,
      '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]', '-map', '[a]',
      '-c:a', encoder, path.join(uploads, musicName)]);
    const episode = { format: '1:1', scenes: [{ id: 'scene', kind: 'title', title: 'Fixture', text: '',
      duration: 2, background: '#123456', layout: 'center', audioUrl: url(narrationName), audioVolume: 1 }] };
    const render = async (start, volume) => decode(root, await renderEpisode({ ...episode,
      music: { assetUrl: url(musicName), start, trimStart: 0.6, volume, source: { origin: 'own' } },
    }, { dataDir: root }));
    const quiet = await render(0.2, 0.25);
    const loud = await render(0.65, 1);
    const quietTone = amplitude(quiet, 800, 0.45);
    const loudTone = amplitude(loud, 800, 0.9);
    assert.ok(quietTone > 0.005, 'trimmed music is audible at the early placement');
    assert.ok(loudTone > quietTone * 2.8 && loudTone < quietTone * 5.2,
      `music gain must affect decoded amplitude: quiet=${quietTone}, loud=${loudTone}`);
    for (const [pcm, active, later, before, after] of [
      [quiet, 0.45, 1.0, 0.05, 1.55],
      [loud, 0.9, 1.45, 0.3, 1.85],
    ]) {
      const narration = amplitude(pcm, 400, active);
      const retained = amplitude(pcm, 800, active);
      assert.ok(narration > 0.02, 'existing narration remains audible during the music');
      assert.ok(amplitude(pcm, 600, active) < retained * 0.2, 'the pre-trim tone is not played');
      assert.ok(amplitude(pcm, 1000, later) > retained * 0.4, 'music continues to the later source position');
      assert.ok(amplitude(pcm, 800, later) < retained * 0.2, 'the earlier source segment does not restart');
      for (const position of [before, after]) {
        assert.ok(amplitude(pcm, 800, position) < retained * 0.2 && amplitude(pcm, 1000, position) < retained * 0.2,
          'music is absent before its placement and after its trimmed source ends');
        assert.ok(amplitude(pcm, 400, position) > 0.02, 'narration continues outside the music window');
      }
    }
  });
}
