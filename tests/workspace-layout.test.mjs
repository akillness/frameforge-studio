import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLayout, createWorkspaceStore } from '../public/workspace-state.js';

const KEY = 'frameforge.workspace.v1';
const custom = { presetId: 'custom', width: 1173, height: 673, inspectorWidth: 347, sidebarWidth: 216, toolsMode: 'overlay' };
function memory(raw = null) {
  const values = new Map(raw === null ? [] : [[KEY, raw]]);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const envelope = (overrides = {}) => ({ version: 1, layout: custom, profiles: [], activeProfileId: null, ...overrides });
const profile = (overrides = {}) => ({ id: 'profile-1', name: 'Editing', layout: custom, ...overrides });

// These are explicit user choices, not tests pinning implicit configuration defaults.
for (const [id, width, height, toolsMode] of [
  ['auto', null, null, 'docked'], ['compact', 1024, 768, 'overlay'],
  ['standard', 1280, 800, 'docked'], ['wide', 1600, 900, 'docked'], ['focus', 1280, 800, 'overlay'],
]) {
  test(`selecting ${id} replaces previous dimensions with its advertised working area`, () => {
    const store = createWorkspaceStore({ storage: memory() });
    store.setLayout(custom);
    const { layout } = store.selectPreset(id);
    assert.deepEqual(layout, { presetId: id, width, height, toolsMode, inspectorWidth: custom.inspectorWidth, sidebarWidth: custom.sidebarWidth });
  });
}

for (const [field, min, max] of [['width', 320, 2560], ['height', 320, 1800], ['inspectorWidth', 240, 480]]) {
  for (const [name, input, expected] of [
    ['below minimum', min - 1, min], ['minimum', min, min], ['above minimum', min + 1, min + 1],
    ['maximum', max, max], ['above maximum', max + 1, max], ['round down', min + 0.49, min], ['round up', min + 0.5, min + 1],
  ]) {
    test(`${field} ${name} is normalized to a usable integer`, () => {
      assert.equal(normalizeLayout({ ...custom, [field]: input })[field], expected);
    });
  }
}

for (const value of [NaN, Infinity, -Infinity, '800', null, undefined, {}, []]) {
  test(`nonfinite/non-number dimension ${String(value)} cannot enter a committed layout`, () => {
    const store = createWorkspaceStore({ storage: memory() });
    store.setLayout(custom);
    const before = store.getState();
    for (const field of ['width', 'height', 'inspectorWidth']) {
      assert.throws(() => store.setLayout({ [field]: value }), /숫자/);
      assert.deepEqual(store.getState(), before);
      const normalized = normalizeLayout({ ...custom, [field]: value });
      assert.ok(Number.isFinite(normalized[field]) && Number.isInteger(normalized[field]));
    }
  });
}

test('normalization is idempotent, bounded and allowlisted across deterministic hostile numeric inputs', () => {
  let seed = 0x5eed;
  for (let i = 0; i < 250; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const input = { ...custom, width: (seed % 12000) - 6000, height: (seed % 8000) - 4000, inspectorWidth: (seed % 2000) - 1000, secret: 'never persist' };
    const layout = normalizeLayout(input);
    assert.deepEqual(normalizeLayout(layout), layout, `seed=0x5eed iteration=${i}`);
    assert.ok(layout.width >= 320 && layout.width <= 2560 && layout.height >= 320 && layout.height <= 1800 && layout.inspectorWidth >= 240 && layout.inspectorWidth <= 480);
    assert.deepEqual(Object.keys(layout).sort(), Object.keys(custom).sort());
  }
});

test('invalid enums and malformed mutations throw without losing current edits', () => {
  const store = createWorkspaceStore({ storage: memory() });
  store.setLayout(custom);
  const before = store.getState();
  for (const action of [() => store.selectPreset('unknown'), () => store.selectProfile('missing'),
    () => store.setLayout({ presetId: 'constructor' }), () => store.setLayout({ toolsMode: 'floating' }),
    ...[null, [], 'wide', 42].map(value => () => store.setLayout(value))]) {
    assert.throws(action);
    assert.deepEqual(store.getState(), before);
  }
  const sanitized = normalizeLayout({ ...custom, toolsMode: '<script>', presetId: '__proto__' });
  assert.ok(['docked', 'overlay'].includes(sanitized.toolsMode));
  assert.equal(sanitized.presetId, 'custom');
});

test('allowlisted serialization drops unknown/prototype fields at every storage boundary', () => {
  const poison = JSON.parse('{"__proto__":{"polluted":true},"token":"secret"}');
  const storage = memory(JSON.stringify(envelope({ ...poison, layout: { ...custom, ...poison }, profiles: [profile({ ...poison, layout: { ...custom, ...poison } })] })));
  const store = createWorkspaceStore({ storage });
  assert.deepEqual(store.getState().profiles, [profile()]);
  store.setLayout({ ...poison, width: 1191 });
  const persisted = JSON.parse(storage.getItem(KEY));
  assert.deepEqual(Object.keys(persisted).sort(), ['activeProfileId', 'layout', 'profiles', 'version']);
  assert.deepEqual(Object.keys(persisted.layout).sort(), Object.keys(custom).sort());
  assert.deepEqual(Object.keys(persisted.profiles[0]).sort(), ['id', 'layout', 'name']);
  assert.equal({}.polluted, undefined);
  assert.equal(JSON.stringify(persisted).includes('secret'), false);
});

const corrupt = [
  ['invalid JSON', '{'], ['null root', 'null'], ['array root', '[]'],
  ['old version', JSON.stringify(envelope({ version: 0 }))], ['future version', JSON.stringify(envelope({ version: 2 }))],
  ['string version', JSON.stringify(envelope({ version: '1' }))],
  ['missing layout', JSON.stringify(envelope({ layout: null }))], ['invalid profiles', JSON.stringify(envelope({ profiles: {} }))],
  ['oversized input', ' '.repeat(32769)], ['non-string storage value', 17],
  ['invalid profile id', JSON.stringify(envelope({ profiles: [profile({ id: '<script>' })] }))],
  ['invalid profile layout', JSON.stringify(envelope({ profiles: [profile({ layout: [] })] }))],
  ['empty profile name', JSON.stringify(envelope({ profiles: [profile({ name: '  ' })] }))],
  ['long profile name', JSON.stringify(envelope({ profiles: [profile({ name: 'x'.repeat(41) })] }))],
  ['duplicate ids', JSON.stringify(envelope({ profiles: [profile(), profile({ name: 'Other' })] }))],
  ['duplicate folded names', JSON.stringify(envelope({ profiles: [profile(), profile({ id: 'profile-2', name: 'ｅｄｉｔｉｎｇ' })] }))],
  ['too many profiles', JSON.stringify(envelope({ profiles: Array.from({ length: 13 }, (_, i) => profile({ id: `profile-${i + 1}`, name: `Name ${i}` })) }))],
];
for (const [name, raw] of corrupt) {
  test(`${name} reports a storage error and permits a fresh session edit`, () => {
    const storage = memory(raw);
    const store = createWorkspaceStore({ storage });
    assert.match(store.getState().storageError, /읽을 수 없어|저장할 수 없/);
    assert.deepEqual(store.getState().profiles, []);
    const changed = store.setLayout(custom);
    assert.deepEqual(changed.layout, custom);
    assert.equal(changed.storageError, null);
    assert.deepEqual(createWorkspaceStore({ storage }).getState().layout, custom);
  });
}

test('the 32KB input boundary accepts a valid padded document and rejects one byte more', () => {
  const raw = JSON.stringify(envelope());
  const accepted = createWorkspaceStore({ storage: memory(raw.padEnd(32768, ' ')) });
  assert.equal(accepted.getState().storageError, null);
  assert.deepEqual(accepted.getState().layout, custom);
  assert.match(createWorkspaceStore({ storage: memory(raw.padEnd(32769, ' ')) }).getState().storageError, /읽을 수 없어/);
});

for (const name of ['QuotaExceededError', 'SecurityError']) {
  test(`${name} leaves mutations usable, reports failure and recovers after storage returns`, () => {
    const persisted = memory();
    let unavailable = false;
    const storage = {
      getItem: key => persisted.getItem(key),
      setItem(key, value) { if (unavailable) throw new DOMException('denied', name); persisted.setItem(key, value); },
    };
    const store = createWorkspaceStore({ storage });
    store.setLayout(custom);
    const before = persisted.getItem(KEY);
    unavailable = true;
    const failed = store.setLayout({ width: 1431 });
    assert.equal(failed.layout.width, 1431);
    assert.match(failed.storageError, /현재 세션/);
    assert.equal(persisted.getItem(KEY), before);
    const saved = store.saveProfile('Offline editing');
    assert.equal(saved.profiles[0].layout.width, 1431);
    assert.equal(store.selectProfile(saved.activeProfileId).layout.width, 1431);
    unavailable = false;
    const recovered = store.setLayout({ height: 711 });
    assert.equal(recovered.storageError, null);
    assert.deepEqual(createWorkspaceStore({ storage }).getState(), recovered);
  });
}

test('unavailable and read-denied storage never prevent session profile switching or reset', () => {
  for (const storage of [null, { getItem() { throw new DOMException('denied', 'SecurityError'); }, setItem() { throw new DOMException('denied', 'SecurityError'); } }]) {
    const store = createWorkspaceStore({ storage });
    assert.match(store.getState().storageError, /현재 세션/);
    store.setLayout(custom);
    const saved = store.saveProfile('Session only');
    store.selectPreset('wide');
    assert.deepEqual(store.selectProfile(saved.activeProfileId).layout, custom);
    assert.equal(store.reset().profiles[0].name, 'Session only');
  }
});

test('profiles are isolated snapshots across editing, selection, reload and reset', () => {
  const storage = memory();
  const store = createWorkspaceStore({ storage });
  store.setLayout(custom);
  const a = store.saveProfile('  Editorial A  ').activeProfileId;
  const second = { ...custom, width: 1555, height: 933, inspectorWidth: 411, toolsMode: 'docked' };
  store.setLayout(second);
  const b = store.saveProfile('B').activeProfileId;
  assert.notEqual(a, b);
  store.setLayout({ width: 1701 });
  assert.equal(store.getState().activeProfileId, null);
  assert.deepEqual(store.selectProfile(a).layout, custom);
  assert.deepEqual(store.selectProfile(b).layout, second);
  const reloaded = createWorkspaceStore({ storage });
  assert.deepEqual(reloaded.getState(), store.getState());
  const savedProfiles = reloaded.getState().profiles;
  const reset = reloaded.reset();
  assert.deepEqual(reset.profiles, savedProfiles);
  assert.equal(reset.activeProfileId, null);
  assert.deepEqual(reloaded.selectProfile(a).layout, custom);
  assert.equal(reloaded.getState().profiles[0].name, 'Editorial A');
  assert.deepEqual(createWorkspaceStore({ storage }).selectProfile(b).layout, second);
});

test('profile names enforce trim, case-folded uniqueness and 1..40 characters without discarding XSS text', () => {
  const store = createWorkspaceStore({ storage: memory() });
  store.setLayout(custom);
  store.saveProfile('  Editing  ');
  for (const name of ['', '   ', null, 3, 'x'.repeat(41), 'editing', ' EDITING ', 'Ｅｄｉｔｉｎｇ']) {
    const before = store.getState();
    assert.throws(() => store.saveProfile(name));
    assert.deepEqual(store.getState(), before);
  }
  for (const name of ['x', 'y'.repeat(40), '<img src=x onerror=alert(1)>']) {
    const state = store.saveProfile(name);
    assert.equal(state.profiles.at(-1).name, name);
    assert.deepEqual(store.selectProfile(state.activeProfileId).layout, custom);
  }
});

test('twelve saved profiles survive reload and a rejected thirteenth leaves them intact', () => {
  const storage = memory();
  const store = createWorkspaceStore({ storage });
  for (let i = 0; i < 12; i++) {
    store.setLayout({ width: 701 + i, height: 601 + i });
    store.saveProfile(`Layout ${i}`);
  }
  const before = store.getState();
  assert.throws(() => store.saveProfile('Thirteenth'), /12/);
  assert.deepEqual(store.getState(), before);
  const restored = createWorkspaceStore({ storage });
  for (let i = 0; i < 12; i++) assert.equal(restored.selectProfile(before.profiles[i].id).layout.width, 701 + i);
});

test('unknown active profile is discarded while valid saved profiles remain selectable', () => {
  const store = createWorkspaceStore({ storage: memory(JSON.stringify(envelope({ profiles: [profile()], activeProfileId: 'missing' }))) });
  assert.equal(store.getState().activeProfileId, null);
  assert.deepEqual(store.selectProfile('profile-1').layout, custom);
});

for (const [field, value] of [['width', 1451], ['height', 811], ['inspectorWidth', 401], ['toolsMode', 'docked']]) {
  test(`hydration discards active profile when current ${field} differs from its saved snapshot`, () => {
    const edited = { ...custom, [field]: value };
    const storage = memory(JSON.stringify(envelope({ layout: edited, profiles: [profile()], activeProfileId: 'profile-1' })));
    const store = createWorkspaceStore({ storage });
    assert.equal(store.getState().activeProfileId, null);
    assert.deepEqual(store.getState().layout, edited);
    assert.deepEqual(store.selectProfile('profile-1').layout, custom);
    assert.equal(createWorkspaceStore({ storage }).getState().activeProfileId, 'profile-1');
  });
}

test('snapshots and subscriber payloads cannot mutate saved state, and unsubscribe stops delivery', () => {
  const store = createWorkspaceStore({ storage: memory() });
  const delivered = [];
  const stop = store.subscribe(snapshot => { delivered.push(structuredClone(snapshot)); snapshot.layout.width = -1; snapshot.profiles.length = 0; });
  store.setLayout(custom);
  const saved = store.saveProfile('Protected');
  assert.deepEqual(delivered.map(item => item.layout), [custom, custom]);
  saved.layout.width = -1;
  saved.profiles[0].layout.height = -1;
  const read = store.getState();
  read.profiles[0].name = 'tampered';
  assert.deepEqual(store.selectProfile(saved.activeProfileId).layout, custom);
  assert.equal(store.getState().profiles[0].name, 'Protected');
  stop();
  store.setLayout({ width: 1301 });
  assert.equal(delivered.length, 3);
});

test('separate storage keys isolate two consumers sharing the same browser storage', () => {
  const storage = memory();
  const a = createWorkspaceStore({ storage, storageKey: 'workspace-a' });
  const b = createWorkspaceStore({ storage, storageKey: 'workspace-b' });
  a.setLayout(custom);
  a.saveProfile('A');
  b.setLayout({ ...custom, width: 1777 });
  b.saveProfile('B');
  assert.equal(createWorkspaceStore({ storage, storageKey: 'workspace-a' }).getState().layout.width, 1173);
  assert.equal(createWorkspaceStore({ storage, storageKey: 'workspace-b' }).getState().layout.width, 1777);
  assert.deepEqual(a.getState().profiles.map(item => item.name), ['A']);
  assert.deepEqual(b.getState().profiles.map(item => item.name), ['B']);
});
