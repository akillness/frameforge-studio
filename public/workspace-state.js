export const WORKSPACE_PRESETS = Object.freeze([
  {id:'auto', name:'자동 맞춤', width:null, height:null, toolsMode:'docked'},
  {id:'compact', name:'컴팩트', width:1024, height:768, toolsMode:'overlay'},
  {id:'standard', name:'표준', width:1280, height:800, toolsMode:'docked'},
  {id:'wide', name:'와이드', width:1600, height:900, toolsMode:'docked'},
  {id:'focus', name:'집중', width:1280, height:800, toolsMode:'overlay'},
].map(Object.freeze));

const STORAGE_KEY = 'frameforge.workspace.v1';
const MAX_STORAGE_LENGTH = 32768;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const bounded = (value, min, max, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
const profileName = value => typeof value === 'string' ? value.trim() : '';
const nameKey = value => value.normalize('NFKC').toLocaleLowerCase();

export function normalizeLayout(value = {}) {
  const input = record(value) ? value : {};
  const preset = WORKSPACE_PRESETS.find(item => item.id === input.presetId) || WORKSPACE_PRESETS[0];
  const custom = preset.width !== null || input.presetId === 'custom' || (typeof input.width === 'number' && Number.isFinite(input.width)) || (typeof input.height === 'number' && Number.isFinite(input.height));
  const width = custom ? bounded(input.width, 320, 2560, preset.width || 1280) : null;
  const height = custom ? bounded(input.height, 320, 1800, preset.height || 800) : null;
  const toolsMode = ['docked','overlay'].includes(input.toolsMode) ? input.toolsMode : preset.toolsMode;
  const matches = WORKSPACE_PRESETS.find(item => item.width === width && item.height === height && item.toolsMode === toolsMode);
  return {
    presetId: matches?.id || (width === null ? 'auto' : 'custom'),
    width,
    height,
    inspectorWidth: bounded(input.inspectorWidth, 240, 480, 300),
    toolsMode,
  };
}

export function createWorkspaceStore(options = {}) {
  const storageKey = options.storageKey || STORAGE_KEY;
  let storage;
  let storageError = null;
  let layout = normalizeLayout();
  let profiles = [];
  let activeProfileId = null;
  const listeners = new Set();
  try {
    storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
    if (!storage) throw new Error('Storage unavailable');
    const raw = storage.getItem(storageKey);
    if (raw !== null) {
      if (typeof raw !== 'string' || raw.length > MAX_STORAGE_LENGTH) throw new Error('Invalid workspace data');
      const data = JSON.parse(raw);
      if (!record(data) || data.version !== 1 || !record(data.layout) || !Array.isArray(data.profiles) || data.profiles.length > 12) throw new Error('Invalid workspace schema');
      const names = new Set();
      const ids = new Set();
      const savedProfiles = data.profiles.map(item => {
        if (!record(item) || typeof item.id !== 'string' || !/^profile-[1-9]\d{0,5}$/.test(item.id) || !record(item.layout)) throw new Error('Invalid profile');
        const name = profileName(item.name);
        if (!name || name.length > 40 || names.has(nameKey(name)) || ids.has(item.id)) throw new Error('Invalid profile name');
        names.add(nameKey(name));
        ids.add(item.id);
        return {id:item.id, name, layout:normalizeLayout(item.layout)};
      });
      layout = normalizeLayout(data.layout);
      profiles = savedProfiles;
      const activeProfile = profiles.find(item => item.id === data.activeProfileId);
      activeProfileId = activeProfile && JSON.stringify(activeProfile.layout) === JSON.stringify(layout) ? activeProfile.id : null;
    }
  } catch {
    storageError = storage ? '저장된 작업 창 설정을 읽을 수 없어 기본값을 사용합니다. 현재 세션에서는 계속 변경할 수 있습니다.' : '이 브라우저에서 작업 창 설정을 저장할 수 없습니다. 변경은 현재 세션에만 적용됩니다.';
  }

  const getState = () => copy({layout, profiles, activeProfileId, storageError});
  function commit() {
    try {
      if (!storage) throw new Error('Storage unavailable');
      storage.setItem(storageKey, JSON.stringify({version:1, layout, profiles, activeProfileId}));
      storageError = null;
    } catch {
      storageError = '작업 창 설정을 브라우저에 저장하지 못했습니다. 변경은 현재 세션에 적용되지만 새로고침하면 사라질 수 있습니다.';
    }
    for (const listener of listeners) listener(getState());
    return getState();
  }
  return {
    getState,
    setLayout(patch) {
      if (!record(patch)) throw new Error('작업 창 설정을 확인하세요.');
      if (Object.hasOwn(patch, 'presetId') && patch.presetId !== 'custom' && !WORKSPACE_PRESETS.some(item => item.id === patch.presetId)) throw new Error('작업 창 프리셋을 확인하세요.');
      if (Object.hasOwn(patch, 'toolsMode') && !['docked','overlay'].includes(patch.toolsMode)) throw new Error('도구 표시 방식을 확인하세요.');
      for (const key of ['width','height','inspectorWidth']) {
        if (Object.hasOwn(patch, key) && (typeof patch[key] !== 'number' || !Number.isFinite(patch[key]))) throw new Error('작업 창 크기는 유효한 숫자로 입력하세요.');
      }
      layout = normalizeLayout({...layout, ...patch});
      activeProfileId = null;
      return commit();
    },
    selectPreset(presetId) {
      const preset = WORKSPACE_PRESETS.find(item => item.id === presetId);
      if (!preset) throw new Error('작업 창 프리셋을 확인하세요.');
      layout = normalizeLayout({...preset, presetId, inspectorWidth:layout.inspectorWidth});
      activeProfileId = null;
      return commit();
    },
    saveProfile(value) {
      const name = profileName(value);
      if (!name || name.length > 40) throw new Error('프로필 이름은 공백을 제외한 1~40자로 입력하세요.');
      if (profiles.some(item => nameKey(item.name) === nameKey(name))) throw new Error('같은 이름의 프로필이 이미 있습니다. 다른 이름을 입력하세요.');
      if (profiles.length >= 12) throw new Error('프로필은 이 브라우저에 최대 12개까지 저장할 수 있습니다.');
      let index = 1;
      while (profiles.some(item => item.id === `profile-${index}`)) index++;
      activeProfileId = `profile-${index}`;
      profiles.push({id:activeProfileId, name, layout:copy(layout)});
      return commit();
    },
    selectProfile(profileId) {
      const profile = profiles.find(item => item.id === profileId);
      if (!profile) throw new Error('저장된 작업 창 프로필을 확인하세요.');
      layout = copy(profile.layout);
      activeProfileId = profile.id;
      return commit();
    },
    reset() {
      layout = normalizeLayout();
      activeProfileId = null;
      return commit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
