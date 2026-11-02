import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '../server/process.mjs';
import { buildSceneCompositionPlan, renderEpisode } from '../server/render.mjs';
import { createApp } from '../server/app.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const scene = { id: 'caption', title: 'Caption', text: 'VISIBLE CAPTION', duration: 1.5, background: '#123456', kind: 'video', assetUrl: '/api/uploads/fixture.mp4', layout: 'center' };

async function fixture(t) {
  try { await execute(ffmpeg, ['-version']); await execute(ffprobe, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg and FFprobe are required for rendering checks'); return; } throw error; }
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-captions-'));
  await mkdir(path.join(root, 'uploads'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x123456:s=64x64:r=30:d=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', path.join(root, 'uploads', 'fixture.mp4')]);
  return root;
}

async function render(root, patch) {
  const result = await renderEpisode({ format: '1:1', scenes: [{ ...scene, ...patch }] }, { dataDir: root });
  return path.join(root, 'exports', result.filename);
}

async function frame(root, video, time, label) {
  const output = path.join(root, `${label}.gray`);
  await execute(ffmpeg, ['-v', 'error', '-y', '-ss', String(time), '-i', video, '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', output]);
  return readFile(output);
}

function changedPixels(a, b) {
  assert.equal(a.length, b.length);
  let count = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 12) count++;
  return count;
}

test('ASS subtitle wrapping keeps fitting words intact for timed, legacy and slot captions', () => {
  const phrase = 'Subtitles clip overlongcaptions';
  const timed = buildSceneCompositionPlan({ duration: 1, text: phrase, captions: [{ start: 0, end: 1, text: phrase }] }, 1080, 1920);
  assert.match(timed.globalAss, /Subtitles clip\\Noverlongcaptions/);
  assert.doesNotMatch(timed.globalAss, /overlongc\\\\Naptions/);
  const legacy = buildSceneCompositionPlan({ duration: 1, text: phrase }, 1080, 1920);
  assert.match(legacy.globalAss, /Subtitles clip\\Noverlongcaptions/);
  const slot = buildSceneCompositionPlan({ duration: 1, captions: [{ start: 0, end: 1, text: phrase }], slots: [{ id: 'caption', role: 'subtitle-layer', x: 5, y: 70, w: 90, h: 20, zIndex: 1, style: { fontSize: 44 } }] }, 1080, 1920);
  assert.match(slot.slotAss[0], /Subtitles clip\\Noverlongcaptions/);
});

test('timed captions are visible only inside the cue and an empty array suppresses legacy text', async t => {
  const root = await fixture(t); if (!root) return;
  const blank = await render(root, { captions: [] });
  const timed = await render(root, { captions: [{ start: 0.5, end: 1, text: 'VISIBLE CAPTION' }] });
  const legacy = await render(root, {});
  const baseline = await frame(root, blank, 0.7, 'blank');
  const before = await frame(root, timed, 0.2, 'before');
  const during = await frame(root, timed, 0.7, 'during');
  const after = await frame(root, timed, 1.25, 'after');
  const legacyFrame = await frame(root, legacy, 0.2, 'legacy');
  assert.ok(changedPixels(baseline, during) > 100, 'cue must visibly render inside its interval');
  assert.ok(changedPixels(baseline, before) < 100, 'no subtitle before cue');
  assert.ok(changedPixels(baseline, after) < 100, 'no subtitle after cue');
  assert.ok(changedPixels(baseline, legacyFrame) > 100, 'omitting captions retains the legacy static subtitle');
});

test('renderer rejects malformed or out-of-scene caption intervals', async t => {
  const root = await fixture(t); if (!root) return;
  for (const cue of [
    { start: -0.1, end: 0.5, text: 'negative' },
    { start: 0.5, end: 0.5, text: 'empty' },
    { start: 1, end: 0.5, text: 'reversed' },
    { start: 1, end: 1.6, text: 'outside scene' },
  ]) {
    await assert.rejects(renderEpisode({ format: '1:1', scenes: [{ ...scene, captions: [cue] }] }, { dataDir: root }), /invalid|caption|timing/i, JSON.stringify(cue));
  }
});

test('timed and empty captions preserve an independent second subtitle-layer overlay', async t => {
  const root = await fixture(t); if (!root) return;
  const slots = [
    { id: 'caption-slot', role: 'subtitle-layer', dataBinding: 'scene.text', x: 5, y: 8, w: 90, h: 20, zIndex: 1, text: 'FIRST LAYER' },
    { id: 'independent-slot', role: 'subtitle-layer', dataBinding: 'custom', x: 5, y: 68, w: 90, h: 20, zIndex: 2, text: 'SECOND LAYER', style: { fontSize: 60 } },
  ];
  const withoutSecond = slots.map((slot, index) => index === 1 ? { ...slot, text: '' } : slot);
  const reference = await render(root, { slots: withoutSecond, captions: [] });
  const empty = await render(root, { slots, captions: [] });
  const timed = await render(root, { slots, captions: [{ start: 0.5, end: 1, text: 'TIMED CUE' }] });
  const bottom = buffer => buffer.subarray(600 * 1080);
  const baseline = bottom(await frame(root, reference, 0.7, 'slot-baseline'));
  for (const [video, time, label] of [[empty, 0.7, 'slot-empty'], [timed, 0.2, 'slot-before'], [timed, 0.7, 'slot-during'], [timed, 1.25, 'slot-after']]) {
    const actual = bottom(await frame(root, video, time, label));
    assert.ok(changedPixels(baseline, actual) > 100, `${label}: independent lower subtitle layer must remain visible`);
  }
});

test('renderer rejects a cue that collapses to zero ASS centiseconds even though it contains a video frame', async t => {
  const root = await fixture(t); if (!root) return;
  const cue = { start: 0.031, end: 0.034, text: 'ONE FRAME' };
  await assert.rejects(renderEpisode({ format: '1:1', scenes: [{ ...scene, captions: [cue] }] }, { dataDir: root }), /invalid|caption|timing/i);
});

test('episode update rejects a cue that collapses to zero ASS centiseconds without changing the saved version', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-caption-api-'));
  const server = createApp({ dataDir, loginToken: '' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (url, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const state = await (await request('/api/state')).json();
  const created = await (await request('/api/episodes', 'POST', { channelId: state.channels[0].id, title: 'Caption precision', topic: 'Caption precision fixture' })).json();
  const response = await request(`/api/episodes/${created.id}`, 'PUT', { expectedVersion: created.version, scenes: [{ ...created.scenes[0], captions: [{ start: 0.031, end: 0.034, text: 'ONE FRAME' }] }] });
  assert.equal(response.status, 400);
  const after = await (await request('/api/state')).json();
  assert.equal(after.episodes.find(episode => episode.id === created.id).version, created.version);
});
