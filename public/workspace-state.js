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

// Operational views are presentation preferences, separate from editor layout and API state.
export const OPS_STORAGE_KEY = 'frameforge.ops.v1';
export const OPS_COLUMNS = Object.freeze({channel:'채널',status:'상태',version:'버전',updatedAt:'수정 시각'});
export function normalizeOpsView(value) {
  const input = record(value) ? value : {};
  return {
    query:typeof input.query === 'string' ? input.query.slice(0,200) : '',
    channel:typeof input.channel === 'string' ? input.channel.slice(0,100) : '',
    status:typeof input.status === 'string' ? input.status.slice(0,60) : '',
    sort:['updatedAt','title','version','status'].includes(input.sort) ? input.sort : 'updatedAt',
    direction:input.direction === 'asc' ? 'asc' : 'desc',
    columns:Array.isArray(input.columns) ? Object.keys(OPS_COLUMNS).filter(key => input.columns.includes(key)) : Object.keys(OPS_COLUMNS),
  };
}

export function createOpsStore(options = {}) {
  let storage, error = null, current = normalizeOpsView(), saved = [];
  try {
    storage = Object.hasOwn(options,'storage') ? options.storage : globalThis.localStorage;
    if (!storage) throw new Error('Unavailable storage');
    const raw = storage.getItem(OPS_STORAGE_KEY);
    if (raw !== null) {
      if (typeof raw !== 'string' || raw.length > 32768) throw new Error('Invalid storage');
      const data = JSON.parse(raw);
      if (!record(data) || data.version !== 1 || !record(data.current) || !Array.isArray(data.saved) || data.saved.length > 12) throw new Error('Invalid preferences');
      current = normalizeOpsView(data.current);
      const names = new Set();
      saved = data.saved.map(item => {
        if (!record(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 40 || !record(item.view) || names.has(nameKey(item.name.trim()))) throw new Error('Invalid saved view');
        names.add(nameKey(item.name.trim()));
        return {name:item.name.trim(),view:normalizeOpsView(item.view)};
      });
    }
  } catch { current=normalizeOpsView(); saved=[]; error='저장된 보기를 읽을 수 없어 기본 보기를 사용합니다. 설정은 이 브라우저에만 적용됩니다.'; }
  const getState = () => copy({current,saved,error});
  function persist() {
    try { storage.setItem(OPS_STORAGE_KEY,JSON.stringify({version:1,current,saved})); error=null; }
    catch { error='보기를 저장할 수 없습니다. 현재 탭에서만 적용됩니다.'; }
    return getState();
  }
  return {
    getState,
    update(patch) { current=normalizeOpsView({...current,...patch}); return persist(); },
    save(name) {
      const clean=typeof name === 'string' ? name.trim() : '';
      if (!clean || clean.length>40) throw new Error('보기 이름을 1–40자로 입력하세요.');
      const existing=saved.find(item=>nameKey(item.name)===nameKey(clean));
      if (!existing && saved.length>=12) throw new Error('저장한 보기는 최대 12개입니다. 먼저 보기를 삭제하세요.');
      if (existing) { existing.name=clean; existing.view=copy(current); }
      else saved.push({name:clean,view:copy(current)});
      return persist();
    },
    select(name) { const item=saved.find(item=>item.name===name); if (item) current=copy(item.view); return persist(); },
    remove(name) { saved=saved.filter(item=>item.name!==name); return persist(); },
    reset() { current=normalizeOpsView(); saved=[]; return persist(); },
  };
}

const list = value => Array.isArray(value) ? value : [];
export function opsQueue(data, preferences = {}) {
  if (!Array.isArray(data?.episodes)) return null;
  const prefs=normalizeOpsView(preferences), channels=new Map(list(data.channels).map(item=>[item.id,item.name]));
  const query=prefs.query.normalize('NFKC').toLocaleLowerCase();
  return data.episodes.filter(item => (!prefs.channel || item.channelId===prefs.channel) && (!prefs.status || item.status===prefs.status))
    .map(item=>({...item,channelName:channels.get(item.channelId) || item.channelId || '확인 불가'}))
    .filter(item=>!query || [item.title,item.id,item.channelName].some(value=>String(value ?? '').normalize('NFKC').toLocaleLowerCase().includes(query)))
    .sort((a,b)=>{
      const key=prefs.sort;
      const result=key==='updatedAt' ? (Date.parse(a[key])||0)-(Date.parse(b[key])||0) : key==='version' ? (Number(a[key])||0)-(Number(b[key])||0) : String(a[key]??'').localeCompare(String(b[key]??''),'ko');
      return (prefs.direction==='asc' ? result : -result) || String(a.id).localeCompare(String(b.id));
    });
}

export function localMediaUrl(value) {
  return typeof value==='string' && /^\/api\/(?:uploads|exports)\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(value) ? value : null;
}

export function opsDeliverables(data) {
  const outputs=new Map();
  const episodes=new Map(list(data?.episodes).map(item=>[item.id,item]));
  function add(value) {
    const url=localMediaUrl(value.url);
    if (!url) return;
    const previous=outputs.get(url);
    // Prefer job provenance to current attachment metadata for the same artifact.
    outputs.set(url,{...previous,...value,url});
  }
  for (const episode of episodes.values()) for (const scene of list(episode.scenes)) {
    for (const [key,label] of [['assetUrl','장면 미디어'],['audioUrl','장면 오디오']]) if (scene[key]) add({url:scene[key],episodeId:episode.id,title:episode.title,source:label,sceneId:scene.id,sceneTitle:scene.title,attachedVersion:episode.version,format:episode.format,updatedAt:episode.updatedAt});
  }
  for (const job of list(data?.generationJobs)) for (const output of list(job.outputs)) add({url:output.url,episodeId:job.episodeId,title:episodes.get(job.episodeId)?.title,source:'생성 결과',jobId:job.id,episodeVersion:job.episodeVersion,type:output.type,sha256:output.sha256,width:output.width,height:output.height,updatedAt:job.completedAt || job.updatedAt});
  for (const job of list(data?.jobs)) if (job.status==='completed') add({url:job.outputUrl,episodeId:job.episodeId,title:episodes.get(job.episodeId)?.title,source:'렌더 결과',jobId:job.id,episodeVersion:job.episodeVersion,sha256:job.sha256,updatedAt:job.updatedAt});
  return [...outputs.values()].sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0) || a.url.localeCompare(b.url));
}

export function opsJobGroups(data) {
  return [['jobs','렌더'],['generationJobs','생성'],['narrationJobs','내레이션'],['workflowRuns','워크플로우']].map(([key,label])=>({key,label,available:Array.isArray(data?.[key]),jobs:list(data?.[key])}));
}

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
