import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { buildSceneCompositionPlan } from '../server/render.mjs';
import { scenes } from '../server/validation.mjs';

const captionText = '뉴스👩‍💻속보입니다';
const slot = {
  id: 'caption-slot', role: 'subtitle-layer', dataBinding: 'scene.narration',
  x: 6, y: 74, w: 88, h: 20, zIndex: 10,
  style: { backgroundColor: '#111a22', textColor: '#ffffff', fontSize: 60, opacity: 0.86, borderRadius: 0, align: 'center' },
};
const scene = (patch = {}) => ({
  id: 'news-scene', title: 'AI 뉴스', text: '뉴스 배경', duration: 8, background: '#14212d', kind: 'title',
  layout: 'custom', slots: [slot], captions: [{ start: 1, end: 6, text: captionText }], ...patch,
});

const integrations = {
  integrationStatus: async () => ({ studio: { available: true }, codex: { available: false } }),
  runAgent: async () => { throw Object.assign(new Error('not configured for test'), { code: 'UNAVAILABLE' }); },
};

async function apiFixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-caption-effect-'));
  let server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations });
  const start = async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let base = await start();
  const close = () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (url, method = 'GET', body) => fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    dataDir, request,
    restart: async () => { await close(); server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations }); base = await start(); },
  };
}

test('caption effect stays absent for legacy scenes and only accepts explicit supported values', () => {
  const legacy = scenes([scene()])[0];
  assert.equal(Object.hasOwn(legacy, 'captionEffect'), false);
  assert.equal(scenes([scene({ captionEffect: 'instant' })])[0].captionEffect, 'instant');
  assert.equal(scenes([scene({ captionEffect: 'typewriter' })])[0].captionEffect, 'typewriter');
  assert.throws(() => scenes([scene({ captionEffect: 'blink' })]), /caption effect/);
});

test('caption render plan is instant by default and emits progressive grapheme-safe typewriter events only when selected', () => {
  const legacyScene = scenes([scene()])[0];
  const instant = buildSceneCompositionPlan(legacyScene, 1080, 1920);
  const instantAss = instant.slotAss[0];
  const instantLines = instantAss.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(instantLines.length, 1);
  assert.ok(instantAss.includes(captionText));
  assert.equal(instant.slotBoxes[0].enable, 'between(t,1,6)');

  const typed = buildSceneCompositionPlan(scenes([scene({ captionEffect: 'typewriter' })])[0], 1080, 1920);
  const typedAss = typed.slotAss[0];
  const typedLines = typedAss.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.ok(typedLines.length > 1);
  assert.ok(typedLines.at(-1).includes(captionText));
  for (const line of typedLines) {
    const partial = line.split(',,').at(-1);
    assert.ok(!partial.includes('👩') || partial.includes('👩‍💻'), `split a grapheme in ${partial}`);
  }
  assert.equal(typed.slotBoxes[0].enable, 'between(t,1,6)');
});

test('selected caption effect survives episode save, restart, and state readback', async (t) => {
  const f = await apiFixture(t);
  const state = await (await f.request('/api/state')).json();
  const createdResponse = await f.request('/api/episodes', 'POST', {
    channelId: state.channels[0].id, title: '캡션 효과 fixture', topic: '저장 검증',
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const saved = await f.request(`/api/episodes/${created.id}`, 'PUT', {
    expectedVersion: created.version,
    scenes: [scene({ id: created.scenes[0].id, captionEffect: 'typewriter' })],
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).scenes[0].captionEffect, 'typewriter');
  await f.restart();
  const afterRestart = await (await f.request('/api/state')).json();
  assert.equal(afterRestart.episodes.find((item) => item.id === created.id).scenes[0].captionEffect, 'typewriter');
});
