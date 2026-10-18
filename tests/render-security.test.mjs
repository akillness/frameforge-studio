import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '../server/process.mjs';
import { renderEpisode, localMediaInputOptions } from '../server/render.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const baseScene = { id: 'fixture', title: 'Fixture', text: '', duration: .5, background: '#123456', kind: 'title', layout: 'center' };

async function fixture(t) {
  try { await execute(ffmpeg, ['-version']); await execute(ffprobe, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg and FFprobe are required for executable media security checks'); return; } throw error; }
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-media-security-'));
  await mkdir(path.join(root, 'uploads'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function dash() {
  return '<?xml version="1.0" encoding="utf-8"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT1S" minBufferTime="PT1S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period duration="PT1S"><AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1000" codecs="avc1.42c01e" width="64" height="64"><SegmentList timescale="1" duration="1"><SegmentURL media="../outside.mp4" /></SegmentList></Representation></AdaptationSet></Period></MPD>';
}

test('uploaded inputs allow only standalone media demuxers and local file protocol', () => {
  for (const extension of ['mp4', 'mov', 'webm', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'ogg']) {
    const options = localMediaInputOptions(`asset.${extension}`);
    assert.deepEqual(options.slice(0, 3), ['-protocol_whitelist', 'file', '-format_whitelist']);
    assert.doesNotMatch(options[3], /dash|hls|concat|image2|svg/);
  }
  assert.throws(() => localMediaInputOptions('asset.m3u8'), /Unsupported/);
});

test('DASH disguised as uploaded media cannot escape through probe, visual encode or audio encode', async t => {
  const root = await fixture(t); if (!root) return;
  const outside = path.join(root, 'outside.mp4');
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=2:d=1', '-t', '1', '-c:v', 'libx264', '-movflags', 'frag_keyframe+empty_moov', outside]);
  const original = await readFile(outside);
  const malicious = path.join(root, 'uploads', 'disguised.mp4');
  await writeFile(malicious, dash());
  // The fixture demonstrably exercises a nested reference, not merely an invalid MP4.
  const unguarded = await execute(ffprobe, ['-v', 'error', '-show_entries', 'stream=width', '-of', 'json', malicious]);
  assert.equal(JSON.parse(unguarded.stdout).streams[0].width, 64);
  await assert.rejects(execute(ffprobe, ['-v', 'error', ...localMediaInputOptions(malicious), malicious]), /not on whitelist/);
  await writeFile(path.join(root, 'uploads', 'disguised.png'), dash());
  await writeFile(path.join(root, 'uploads', 'disguised.wav'), dash());
  for (const patch of [
    { kind: 'video', assetUrl: '/api/uploads/disguised.mp4' },
    { kind: 'image', assetUrl: '/api/uploads/disguised.png' },
    { audioUrl: '/api/uploads/disguised.wav' },
  ]) {
    await assert.rejects(renderEpisode({ format: '9:16', scenes: [{ ...baseScene, ...patch }] }, { dataDir: root }), /not on whitelist/);
    assert.deepEqual(await readdir(path.join(root, 'render-work')), []);
    assert.deepEqual(await readdir(path.join(root, 'exports')), []);
  }
  assert.deepEqual(await readFile(outside), original);
});

test('allowlisted standalone formats decode and real image/video/narration rendering still succeeds', async t => {
  const root = await fixture(t); if (!root) return;
  const uploads = path.join(root, 'uploads');
  const color = ['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=2:d=1'];
  const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1'];
  for (const extension of ['mp4', 'mov', 'webm', 'png', 'jpg', 'webp', 'gif', 'mp3', 'wav', 'ogg']) {
    const audio = ['mp3', 'wav', 'ogg'].includes(extension);
    const image = ['png', 'jpg', 'webp', 'gif'].includes(extension);
    const args = ['-v', 'error', ...(audio ? tone : color), ...(image ? ['-frames:v', '1'] : ['-t', '1']), ...(extension === 'webm' ? ['-c:v', 'libvpx-vp9'] : []), '-threads', '1', path.join(uploads, `valid.${extension}`)];
    await execute(ffmpeg, args, { timeout: 15000 });
  }
  await copyFile(path.join(uploads, 'valid.jpg'), path.join(uploads, 'valid.jpeg'));
  for (const extension of ['mp4', 'mov', 'webm', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'ogg']) {
    const filename = path.join(uploads, `valid.${extension}`);
    const probe = await execute(ffprobe, ['-v', 'error', ...localMediaInputOptions(filename), '-show_entries', 'stream=codec_type', '-of', 'json', filename]);
    assert.ok(JSON.parse(probe.stdout).streams.length > 0, extension);
    await execute(ffmpeg, ['-v', 'error', ...localMediaInputOptions(filename), '-i', filename, '-t', '0.1', '-f', 'null', '-']);
  }
  const episode = { format: '9:16', scenes: [
    { ...baseScene, kind: 'video', assetUrl: '/api/uploads/valid.mp4', audioUrl: '/api/uploads/valid.wav' },
    { ...baseScene, id: 'image', kind: 'image', assetUrl: '/api/uploads/valid.png' },
    { ...baseScene, id: 'gif', kind: 'image', assetUrl: '/api/uploads/valid.gif' },
  ] };
  const result = await renderEpisode(episode, { dataDir: root });
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  const output = await execute(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', path.join(root, 'exports', result.filename)]);
  const streams = JSON.parse(output.stdout).streams;
  assert.equal(streams.find(stream => stream.codec_type === 'video').width, 1080);
  assert.equal(streams.find(stream => stream.codec_type === 'video').height, 1920);
  assert.ok(streams.some(stream => stream.codec_type === 'audio'));
  assert.deepEqual(await readdir(path.join(root, 'render-work')), []);
});
