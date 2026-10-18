import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderEpisode, dimensions } from '../server/render.mjs';

const scene = { id: 'scene-1', title: 'Scene', text: '한국어 자막', duration: 1, background: '#123456', kind: 'title', layout: 'center' };

async function renderRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-render-boundary-'));
  await mkdir(path.join(root, 'uploads'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function assertCleaned(root) {
  assert.deepEqual(await readdir(path.join(root, 'render-work')), []);
  assert.deepEqual(await readdir(path.join(root, 'exports')), []);
}

test('renderer rejects invalid timeline without creating work artifacts', async (t) => {
  const root = await renderRoot(t);
  assert.deepEqual(dimensions['9:16'], [1080, 1920]);
  for (const episode of [{ format: 'bad', scenes: [scene] }, { format: '9:16', scenes: [] }, { format: '9:16', scenes: Array(61).fill(scene) }]) {
    await assert.rejects(renderEpisode(episode, { dataDir: root }), /Invalid render timeline/);
  }
  assert.deepEqual(await readdir(root), ['uploads']);
});

test('renderer validates scene duration/color/trim/audio before spawning and cleans temporary jobs', async (t) => {
  const root = await renderRoot(t);
  for (const patch of [{ duration: 0 }, { duration: 121 }, { background: 'red' }, { trimStart: -1 }, { trimStart: 36001 }, { audioVolume: -1 }, { audioVolume: 3 }]) {
    await assert.rejects(renderEpisode({ format: '9:16', scenes: [{ ...scene, ...patch }] }, { dataDir: root }), /Invalid/);
    await assertCleaned(root);
  }
});

test('renderer rejects external/traversal asset and audio paths before executable invocation', async (t) => {
  const root = await renderRoot(t);
  for (const patch of [
    { assetUrl: 'https://example.com/video.mp4' },
    { assetUrl: '/api/uploads/../studio.sqlite' },
    { assetUrl: '/api/uploads/C:secret.mp4' },
    { audioUrl: 'file:///etc/passwd' },
    { audioUrl: '/api/uploads/../secret.wav' },
    { audioUrl: '/api/uploads/clip.mp4' },
  ]) {
    await assert.rejects(renderEpisode({ format: '9:16', scenes: [{ ...scene, ...patch }] }, { dataDir: root }), /uploaded local media|Invalid audio upload/);
    await assertCleaned(root);
  }
});

test('renderer resolves media paths and rejects junction/symlink escapes', async (t) => {
  const root = await renderRoot(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'frameforge-outside-boundary-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const assetLink = path.join(root, 'uploads', 'escape.mp4');
  try { await symlink(outside, assetLink, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Platform cannot create test junction/symlink'); throw error; }
  await assert.rejects(renderEpisode({ format: '9:16', scenes: [{ ...scene, assetUrl: '/api/uploads/escape.mp4' }] }, { dataDir: root }), /Media path escapes uploads/);
  const audioLink = path.join(root, 'uploads', 'escape.wav');
  await symlink(outside, audioLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(renderEpisode({ format: '9:16', scenes: [{ ...scene, audioUrl: '/api/uploads/escape.wav' }] }, { dataDir: root }), /Audio path escapes uploads/);
  await assertCleaned(root);
  assert.deepEqual(await readdir(outside), []);
});
