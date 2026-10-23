import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { scenes, createPresetSlots, episodePatch } from '../server/validation.mjs';
import { applyCompositionDrag } from '../public/composition.js';

const scene = { id: 'scene', title: '제목', text: '본문', duration: 1, background: '#123456', kind: 'title', layout: 'center' };
const center = { media: { x: 0, y: 0, width: 1, height: 1 }, title: { x: .08, y: .32, width: .84, height: .16 }, body: { x: .08, y: .50, width: .84, height: .26 } };

const authoredCopy = '\n  A\r\n\r B \n\n';
const authoredEpisode = {
  title: authoredCopy, topic: authoredCopy, notes: authoredCopy,
  scenes: [{ ...scene, title: authoredCopy, text: authoredCopy, narration: authoredCopy,
    slots: [{ id: 'authored-slot', role: 'html-overlay', text: authoredCopy,
      html: '\n  <p>A</p>\r\n\r<p> B </p> \n\n', prompt: authoredCopy }] }],
};
const authoredFields = ['title', 'topic', 'notes', 'scenes.0.title', 'scenes.0.text', 'scenes.0.narration',
  'scenes.0.slots.0.text', 'scenes.0.slots.0.html', 'scenes.0.slots.0.prompt'];
const authoredValues = episode => Object.fromEntries(authoredFields.map(field =>
  [field, field.split('.').reduce((value, key) => value[key], episode)]));

test('P2 validation preserves every authored paragraph and rejects all-whitespace copy', () => {
  for (const field of authoredFields) {
    const invalid = structuredClone(authoredEpisode), keys = field.split('.');
    const parent = keys.slice(0, -1).reduce((value, key) => value[key], invalid);
    parent[keys.at(-1)] = ' \r\n\t ';
    assert.throws(() => episodePatch(invalid), { status: 400 }, `${field} must reject all-whitespace input`);
  }
  assert.deepEqual(authoredValues(episodePatch(authoredEpisode)), authoredValues(authoredEpisode),
    'validation must retain authored boundary spaces, CR/LF and blank paragraphs in every copy field');
});

test('P2 API save and restart reload preserve every authored paragraph', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-authored-copy-'));
  let server;
  const start = async () => {
    server = createApp({ dataDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  };
  const close = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  await start();
  const request = (url, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const initial = await (await request('/api/state')).json();
  const createdTitle = '  Authored copy  ';
  const createdTopic = '  Topic with boundary spaces  ';
  const createResponse = await request('/api/episodes', 'POST', {
    channelId: initial.channels[0].id, title: createdTitle, topic: createdTopic,
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.title, createdTitle, 'episode creation must preserve authored title boundary spaces');
  assert.equal(created.topic, createdTopic, 'episode creation must preserve authored topic paragraphs');
  const savedResponse = await request(`/api/episodes/${created.id}`, 'PUT', { ...authoredEpisode, expectedVersion: 1 });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.version, 2);
  await close();
  await start();
  const reloaded = (await (await request('/api/state')).json()).episodes.find(item => item.id === created.id);
  assert.equal(reloaded.version, 2);
  const history = await (await request(`/api/episodes/${created.id}/history`)).json();
  assert.equal(history[0].version, 2);
  assert.deepEqual({ saved: authoredValues(saved), reloaded: authoredValues(reloaded), history: authoredValues(history[0].snapshot) },
    { saved: authoredValues(authoredEpisode), reloaded: authoredValues(authoredEpisode), history: authoredValues(authoredEpisode) },
    'API save, restart reload and saved history must retain exact authored strings');
});

test('scene copy validation preserves authored whitespace and still rejects invalid content', () => {
  for (const value of ['\n  A  \n\n', '\n  A  \n\n  B  \n']) {
    const validated = scenes([{ ...scene, title: value, text: value }])[0];
    assert.equal(validated.title, value);
    assert.equal(validated.text, value);
  }
  for (const key of ['title', 'text']) {
    for (const value of [' \n\t ', 'A\u0000B', 'A\u000bB', 'A'.repeat(key === 'title' ? 161 : 2001)]) {
      assert.throws(() => scenes([{ ...scene, [key]: value }]), { status: 400 });
    }
  }
});

test('legacy scenes receive independent normalized preset geometry and valid edits round trip', () => {
  assert.deepEqual(scenes([scene])[0].composition, center);
  const edited = structuredClone(center);
  edited.media = { x: .25, y: .1, width: .5, height: .6 };
  assert.deepEqual(scenes([{ ...scene, composition: edited }])[0].composition, edited);
  const result = scenes([scene, { ...scene, id: 'second' }]);
  result[0].composition.title.x = .2;
  assert.equal(result[1].composition.title.x, .08);
  assert.deepEqual(scenes([{ ...scene, layout: 'split' }])[0].composition.media, { x: 0, y: 0, width: 1, height: .5 });
  assert.deepEqual(scenes([{ ...scene, layout: 'lower-third' }])[0].composition.body, { x: .08, y: .76, width: .84, height: .16 });
});

test('scene validation rejects malformed, unknown, oversized and non-finite composition fields', () => {
  const invalid = [null, [], {}, { ...center, extra: {} }, { ...center, title: null },
    ...[NaN, Infinity, -Infinity, '0.1', null, -.1, 1.1].map(x => ({ ...center, title: { ...center.title, x } })),
    ...[0, .019, 2, NaN].map(width => ({ ...center, body: { ...center.body, width } })),
    { ...center, title: { x: .5, y: 0, width: .5 + 1e-10, height: .1 } },
    { ...center, title: { x: 0, y: .9, width: .5, height: .2 } },
    { ...center, media: { x: 0, y: 0, width: 1 } },
    { ...center, media: { ...center.media, rotation: 90 } },
  ];
  for (const composition of invalid) assert.throws(() => scenes([{ ...scene, composition }]), { status: 400 }, JSON.stringify(composition));
  assert.doesNotThrow(() => scenes([{ ...scene, composition: { ...center, title: { x: .98, y: .98, width: .02, height: .02 } } }]));
});

test('drag-produced media bounds remain valid after six-decimal rounding',()=>{
  const current={...scene,composition:structuredClone(center)};
  const drag={sceneId:'scene',key:'media',handle:'w',start:{...current.composition.media},moved:false};
  applyCompositionDrag(current,drag,4/512,0);
  assert.doesNotThrow(()=>scenes([current]));
});


test('API save, reload and versioned restore preserve composition and independent scene slots', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-composition-api-'));
  let server;
  const start = async () => {
    server = createApp({ dataDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  };
  const close = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  await start();
  const request = (url, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const initialState = await (await request('/api/state')).json();
  const created = await (await request('/api/episodes', 'POST', { channelId: initialState.channels[0].id, title: 'Composition persistence', topic: 'Geometry and slots' })).json();
  const url = `/api/episodes/${created.id}`;
  const geometry = structuredClone(center);
  geometry.media = { x: .25, y: .1, width: .5, height: .6 };
  const slots = createPresetSlots('premiere-3tier', scene);
  const copy = '\n  A  \n\n  B  \n\n';
  const firstScenes = [{ ...scenes([scene])[0], title: '\n  A  \n\n', text: copy, layout: 'premiere-3tier', composition: geometry, slots }];
  const savedResponse = await request(url, 'PUT', { scenes: firstScenes, expectedVersion: 1 });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.deepEqual(saved.scenes, firstScenes);
  assert.equal(saved.version, 2);
  await close();
  await start();
  const reloadedState = await (await request('/api/state')).json();
  assert.deepEqual(reloadedState.episodes.find(item => item.id === created.id).scenes, firstScenes);
  const editedScenes = structuredClone(firstScenes);
  editedScenes[0].composition.title.x = .12;
  editedScenes[0].slots[0].text = 'Updated slot independently';
  const editedResponse = await request(url, 'PUT', { scenes: editedScenes, expectedVersion: 2 });
  assert.equal(editedResponse.status, 200);
  const historyBefore = await (await request(`${url}/history`)).json();
  assert.equal((await request(url, 'PUT', { scenes: firstScenes, expectedVersion: 2 })).status, 409);
  assert.equal((await request(`${url}/restore`, 'POST', { version: 2, expectedVersion: 2 })).status, 409);
  assert.deepEqual(await (await request(`${url}/history`)).json(), historyBefore);
  const restoredResponse = await request(`${url}/restore`, 'POST', { version: 2, expectedVersion: 3 });
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json();
  assert.equal(restored.id, created.id);
  assert.equal(restored.version, 4);
  assert.deepEqual(restored.scenes, firstScenes);
  const historyAfter = await (await request(`${url}/history`)).json();
  assert.deepEqual(historyAfter.slice(1), historyBefore);
  assert.equal(historyAfter[0].reason, 'restore:v2');
  const migratedResponse = await request(`${url}/restore`, 'POST', { version: 1, expectedVersion: 4 });
  assert.equal(migratedResponse.status, 200);
  const migrated = await migratedResponse.json();
  assert.equal(migrated.scenes[0].id, created.scenes[0].id);
  assert.deepEqual(migrated.scenes[0].composition, center);
});
