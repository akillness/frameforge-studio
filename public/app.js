import { createWorkflowEditor } from './workflow.js';
import {episodeChanges,changesHtml,historyReason} from './history.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clone = value => structuredClone(value);
const id = () => crypto.randomUUID();
const date = value => value ? new Date(value).toLocaleString('ko-KR', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
const categories = ['information','drama','reenactment'];
const categoryNames = {information:'정보 전달',drama:'드라마',reenactment:'재연'};
const statusNames = {draft:'제작 중',review:'검토 대기',ready:'제작 완료',queued:'대기 중',running:'렌더링 중',completed:'완료',failed:'실패'};
const views = [['studio','▣','스튜디오'],['workflow','⤳','워크플로우 빌더'],['trends','↗','트렌드 & 리서치'],['templates','▦','템플릿'],['history','◷','제작 히스토리'],['knowledge','⌘','지식 그래프'],['settings','⚙','연결 & 설정']];
let state = {channels:[],episodes:[],templates:[],trends:[],references:[],jobs:[],events:[],integrations:{},graph:{nodes:[],edges:[]}};
let view = 'studio';
let channelId = null;
let episode = null;
let sceneIndex = 0;
let dirty = false;
let editRevision = 0;
let savePending = false;
let history = [];
let historyVersion = null;
let playing = false;
let playTimer;
let toastTimer;
let busy = false;
let authenticated = false;
let modalHandler;
let commands = [];
let speech = {available:false,voices:[],detail:'음성 엔진을 확인하고 있습니다.'};
let speechLoaded = false;
let speechVoice = '';
let speechRate = 0;
let previewAudio;
let polling = false;
const narrationBaselines = new Map();
const completedNarrations = new Set();
const pendingNarrations = new Map();
const chatLogs = new Map();
const workflowEditor = createWorkflowEditor({
  api,
  toast,
  getEpisodes: () => state.episodes,
  hasEpisodeChanges: targetId => episode?.id === targetId && dirty,
  beforeRun: async () => { stopPlayback(); await save(true); },
  onRunUpdated: async () => {
    await refresh();
    if (episode && !dirty) {
      const latest = state.episodes.find(item => item.id === episode.id);
      if (latest) { episode = clone(latest); sceneIndex = Math.min(sceneIndex,episode.scenes.length - 1); }
    }
  },
});

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = ''; }, error ? 9000 : 4500);
}

async function api(path, options = {}) {
  const headers = options.body && typeof options.body === 'string' ? {'Content-Type':'application/json', ...options.headers} : options.headers;
  const response = await fetch(path, {...options, headers, credentials:'same-origin'});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      authenticated = false;
      if (!path.endsWith('/login')) showLogin();
    }
    const error = new Error(data.error || data.message || `요청 실패 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const post = (path, data = {}) => api(path, {method:'POST',body:JSON.stringify(data)});
function categoryOptions(selected = 'information') {
  return categories.map(value => `<option value="${value}" ${selected === value ? 'selected' : ''}>${categoryNames[value]}</option>`).join('');
}
function safeUrl(value) {
  try { const url = new URL(value, location.origin); return ['http:','https:'].includes(url.protocol) ? esc(url.href) : '#'; } catch { return '#'; }
}
function safeColor(value) { return /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#294434'; }
function activeChannel() { return state.channels.find(channel => channel.id === channelId); }
function currentScene() { return episode?.scenes?.[sceneIndex]; }
function duration() { return episode?.scenes?.reduce((sum, scene) => sum + Number(scene.duration || 0), 0) || 0; }
function time(value) { return `${String(Math.floor(value / 60)).padStart(2,'0')}:${String(Math.floor(value % 60)).padStart(2,'0')}`; }

async function refresh() {
  state = {...state, ...await api('/api/state')};
  authenticated = true;
  if (!channelId || !state.channels.some(channel => channel.id === channelId)) channelId = state.channels[0]?.id || null;
  if (!episode) episode = clone(state.episodes.find(item => item.channelId === channelId) || null);
  if (!speechLoaded) await loadSpeechVoices();
}

async function loadSpeechVoices() {
  try { speech = await api('/api/speech/voices'); }
  catch (error) { speech = {available:false,voices:[],detail:error.message}; }
  speechLoaded = true;
  speech.voices ||= [];
  if (!speech.voices.some(voice => voice.id === speechVoice)) speechVoice = (speech.voices.find(voice => /^ko(?:-|_)/i.test(voice.language)) || speech.voices[0])?.id || '';
}

function narrationJob() {
  // /api/state returns newest first, matching Store.list's descending row order.
  return (state.narrationJobs || []).find(job => job.episodeId === episode?.id);
}
function narrationStatusHtml() {
  const job = narrationJob();
  if (pendingNarrations.has(episode?.id)) return '<p class="unsaved">음성 생성 결과가 준비되었습니다. 현재 초안은 그대로 보존했습니다.</p><button class="small" data-action="load-narration-result">초안 파일 보관 후 생성 결과 불러오기</button>';
  if (!job) return '<p class="hint">원고가 비어 있으면 화면 텍스트를 읽습니다. 생성된 음성 길이에 맞춰 장면 길이가 늘어날 수 있습니다.</p>';
  const active = ['queued','running'].includes(job.status);
  return `<div class="row"><span class="badge ${job.status === 'completed' ? 'lime' : ''}">${esc(active ? '음성 생성 중' : statusNames[job.status] || job.status)}</span>${active ? `<progress value="${Math.max(0,Math.min(100,Number(job.progress)||0))}" max="100" aria-label="음성 생성 진행률"></progress>` : ''}${job.resultVersion ? `<span class="hint">저장 버전 ${Number(job.resultVersion)}</span>` : ''}</div>${job.error ? `<p class="danger">${esc(job.error)}</p>` : ''}`;
}
function narrationHtml() {
  const disabled = !speech.available || !speechVoice || ['queued','running'].includes(narrationJob()?.status);
  return `<section class="panel narration-panel"><div class="panel-header"><h3>내레이션 음성 만들기</h3><span class="badge">${speech.available ? 'WINDOWS SAPI' : '연결 확인'}</span></div><div class="panel-body"><div class="two-cols"><label>목소리<select id="speech-voice" ${!speech.available ? 'disabled' : ''}>${speech.voices.length ? speech.voices.map(voice => `<option value="${esc(voice.id)}" ${voice.id === speechVoice ? 'selected' : ''}>${esc(voice.name)} · ${esc(voice.language)}</option>`).join('') : '<option>사용 가능한 목소리 없음</option>'}</select></label><label>말하기 속도 (−10 ~ 10)<input id="speech-rate" type="number" min="-10" max="10" step="1" value="${speechRate}" ${!speech.available ? 'disabled' : ''}></label></div><div class="narration-actions"><button data-action="narrate-scene" data-testid="narrate-scene" ${disabled ? 'disabled' : ''}>선택 장면 음성 만들기</button><button class="primary" data-action="narrate-all" data-testid="narrate-all" ${disabled ? 'disabled' : ''}>전체 장면 음성 만들기</button></div>${!speech.available ? `<p class="hint">${esc(speech.detail || '음성 엔진에 연결되지 않았습니다. 연결 후 사용할 수 있습니다.')}</p><button class="small quiet" data-action="refresh-speech">음성 연결 다시 확인</button>` : '<p class="hint">실제 음성 파일을 생성해 장면에 첨부합니다. 저장되지 않은 변경은 먼저 저장합니다.</p>'}<div id="narration-status" role="status" aria-live="polite">${narrationStatusHtml()}</div></div></section>`;
}

async function startNarration(allScenes) {
  if (!speech.available || !speechVoice) throw new Error('사용 가능한 목소리를 먼저 연결하세요.');
  const selectedId = currentScene()?.id;
  stopPlayback();
  await save(true);
  const baseline = clone(episode);
  const job = await post(`/api/episodes/${episode.id}/narration`,{expectedVersion:episode.version,voice:speechVoice,rate:speechRate,...(!allScenes ? {sceneIds:[selectedId]} : {})});
  narrationBaselines.set(job.id,baseline);
  state.narrationJobs ||= [];
  state.narrationJobs.unshift(job);
  render();
  toast('음성 파일 생성을 시작했습니다. 진행 중에도 편집할 수 있습니다.');
}

function applyNarrationResult(job, latest) {
  const savedEpisode = latest.episodes?.find(item => item.id === job.episodeId);
  if (!savedEpisode) return;
  state.episodes = latest.episodes;
  if (episode?.id !== job.episodeId) return;
  const baseline = narrationBaselines.get(job.id);
  if (!dirty) episode = clone(savedEpisode);
  else if (baseline && episode.version === baseline.version && savedEpisode.version === job.resultVersion) {
    // Merge generated fields only. All user edits, order, and newly added scenes survive.
    for (const scene of episode.scenes) {
      const original = baseline.scenes.find(item => item.id === scene.id);
      const generated = savedEpisode.scenes.find(item => item.id === scene.id);
      if (!original || !generated) continue;
      const sameScript = (scene.narration || scene.text) === (original.narration || original.text);
      if (sameScript && scene.audioUrl === original.audioUrl) {
        scene.audioUrl = generated.audioUrl;
        scene.duration = Math.max(Number(scene.duration),Number(generated.duration));
      }
    }
    episode.version = savedEpisode.version;
    toast('생성된 음성을 반영했습니다. 생성 중 바꾼 원고와 편집은 보존했으며, 변경된 원고는 다시 음성을 생성하세요.');
  } else {
    pendingNarrations.set(episode.id,clone(savedEpisode));
    toast('음성 생성 완료. 현재 편집은 보존했습니다. 음성 패널에서 서버 결과를 불러올 수 있습니다.');
  }
  sceneIndex = Math.min(sceneIndex,episode.scenes.length - 1);
  // Do not replace focused fields or the whole editor during background polling.
  if (view === 'studio') {
    const inspector = $('.inspector .panel-body');
    if (inspector && !inspector.contains(document.activeElement)) inspector.innerHTML = inspectorHtml(currentScene());
    const status = $('#save-status');
    if (status) status.textContent = dirty ? '저장되지 않은 변경 · 음성 결과 반영됨' : `버전 ${episode.version} · 저장됨`;
    if ($('#scenes')) $('#scenes').innerHTML = sceneCards();
    if ($('#total-duration')) $('#total-duration').textContent = `총 ${duration()}초`;
  }
}

async function loadCommands() {
  const result = await api('/api/commands');
  commands = Array.isArray(result) ? result : result.commands || [];
}

function audioInspectorHtml(scene) {
  return `<div class="section-spacer"><div class="two-cols"><label>영상 시작점 (초)<input id="scene-trim-start" data-testid="scene-trim-start" type="number" data-scene="trimStart" min="0" max="36000" step="0.1" value="${Number(scene.trimStart) || 0}"></label><label>오디오 볼륨 (0–2)<input id="scene-audio-volume" data-testid="scene-audio-volume" type="number" data-scene="audioVolume" min="0" max="2" step="0.1" value="${scene.audioVolume ?? 1}"></label></div><p class="hint">영상 시작점부터 장면 길이만큼 사용합니다. 음성은 아래에서 생성하거나 파일로 첨부할 수 있습니다.</p><div class="row"><button class="small" data-action="upload-audio" data-testid="upload-audio">↑ 음성 / 음악</button>${scene.audioUrl ? '<button class="small quiet" data-action="remove-audio">오디오 제거</button>' : '<span class="hint">MP3 · WAV · OGG</span>'}</div>${scene.audioUrl ? `<audio id="scene-audio-preview" controls preload="metadata" src="${safeUrl(scene.audioUrl)}" aria-label="첨부한 장면 오디오 미리듣기" style="width:100%;height:32px;margin-top:12px"></audio>` : ''}</div>`;
}

function commandsHtml() {
  return `<section class="panel section-spacer" id="commands-panel"><div class="panel-header"><h2>작업 명령함</h2><button class="small" data-action="refresh-commands">↻ 명령 새로고침</button></div><form class="panel-body" id="command-form" data-testid="command-form"><label>워크스페이스 명령<textarea name="message" id="command-message" required maxlength="4000" placeholder="채널, 에피소드, 작업 목적을 적어 주세요"></textarea></label><button class="primary" type="submit">명령 기록</button><p class="hint" style="margin-top:12px">웹에서 접수한 명령을 지속 기록합니다. 접수 자체는 에이전트 실행을 뜻하지 않으며, 실제 실행 작업은 스튜디오의 제작 어시스턴트를 이용하세요.</p></form><div id="command-list">${commands.length ? commands.map(command => `<div class="data-row"><div><h3>${esc(command.message)}</h3><p>${esc(command.source || 'web')} · ${date(command.createdAt)}</p></div><span class="badge">${esc(command.status || '접수됨')}</span></div>`).join('') : '<div class="panel-body hint">접수된 명령이 없습니다.</div>'}</div></section>`;
}

function showLogin() {
  $('#app').innerHTML = `<main class="panel login"><div class="brand"><span class="brandmark">F</span> FRAMEFORGE</div><h1>나의 제작실에 입장</h1><p>개인 스튜디오의 접근 토큰을 입력해 주세요. 인증 후 채널과 제작 기록에 접근할 수 있습니다.</p><form id="login-form"><label>접근 토큰<input name="token" type="password" autocomplete="current-password" required></label><button class="primary">스튜디오 열기 →</button><p class="hint" id="login-error" role="alert"></p></form></main>`;
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('button', event.currentTarget);
    button.disabled = true;
    try { await post('/api/login', {token:new FormData(event.currentTarget).get('token')}); await refresh(); render(); }
    catch (error) { $('#login-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
}

function render() {
  const channel = activeChannel();
  $('#app').innerHTML = `<div class="shell"><aside class="sidebar" aria-label="워크스페이스 탐색">
    <div class="brand"><span class="brandmark" aria-hidden="true">F</span><div class="brand-copy">FrameForge<small>CREATOR WORKSPACE</small></div></div>
    <nav class="nav" aria-label="주요 메뉴">${views.map(([key,icon,label]) => `<button data-action="view" data-view="${key}" class="${view === key ? 'active' : ''}" ${view === key ? 'aria-current="page"' : ''} title="${label}"><span class="nav-icon" aria-hidden="true">${icon}</span><span class="nav-label">${label}</span></button>`).join('')}</nav>
    <section><div class="sidebar-label">MY CHANNELS <button class="icon-btn quiet" data-action="new-channel" aria-label="채널 추가">+</button></div>${state.channels.map((item,index) => `<button class="channel ${item.id === channelId ? 'active' : ''}" data-action="channel" data-id="${esc(item.id)}" title="${esc(item.name)}"><span class="channel-avatar">${String(index + 1).padStart(2,'0')}</span><span class="channel-copy"><span class="channel-name">${esc(item.name)}</span><small>${esc(categoryNames[item.category] || item.category || item.platform)}</small></span></button>`).join('')}<button class="channel quiet" data-action="new-channel" title="새 채널 추가"><span class="channel-avatar">+</span><span class="channel-copy muted">채널 추가</span></button></section>
    <div class="sidebar-bottom"><div class="row"><span class="account">B</span><div class="account-copy"><strong style="font-size:11px">나의 워크스페이스</strong><div class="hint">Private production hub</div></div></div></div>
  </aside><div class="workspace"><header class="topbar"><div class="breadcrumb">워크스페이스 <span aria-hidden="true"> / </span><strong>${esc(channel?.name || '새로운 시작')}</strong></div><div class="row"><span class="badge"><span class="dot"></span> <span class="connection-label">로컬 스튜디오 연결됨</span></span><button class="small quiet" data-action="view" data-view="settings">연결 관리 ↗</button></div></header>
    <main class="main" id="main">${renderView()}</main></div></div>`;
  if (view === 'studio') updatePreview();
  if (view === 'workflow') workflowEditor.mount();
  updateSaveStatus();
}

function heading(title, description, actions = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="row">${actions}</div></div>`;
}
function renderView() {
  if (view === 'studio') return studioView();
  if (view === 'workflow') return workflowEditor.html();
  if (view === 'trends') return trendsView();
  if (view === 'templates') return templatesView();
  if (view === 'history') return historyView();
  if (view === 'knowledge') return knowledgeView();
  return settingsView() + commandsHtml();
}

function studioView() {
  const episodes = state.episodes.filter(item => item.channelId === channelId);
  const actions = `${episode ? '<button data-action="save" id="save-button">변경 저장</button><button class="primary" data-action="render">영상 내보내기 ↗</button>' : ''}<button class="icon-btn" data-action="new-episode" aria-label="새 에피소드">+</button>`;
  let html = heading('이야기가 영상이 되는 곳', '소재에서 마지막 프레임까지, 채널의 다음 이야기를 만드세요.', actions);
  html += `<div class="episode-strip" aria-label="에피소드">${episodes.map((item,index) => `<button class="episode-tab ${episode?.id === item.id ? 'selected' : ''}" data-action="episode" data-id="${esc(item.id)}"><span>EP ${String(index + 1).padStart(2,'0')} · ${esc(statusNames[item.status] || item.status)}</span><strong>${esc(item.title)}</strong></button>`).join('')}<button class="episode-tab" data-action="new-episode"><span>CREATE SOMETHING NEW</span><strong>＋ 새 에피소드</strong></button></div>`;
  if (!episode) return html + `<div class="panel empty"><div class="empty-mark">✳</div><h2>첫 번째 이야기를 시작하세요</h2><p>채널을 선택하고 에피소드를 만들면<br>장면 편집, 에이전트 작업, MP4 내보내기를 시작할 수 있어요.</p><button class="primary" data-action="${channelId ? 'new-episode' : 'new-channel'}">${channelId ? '첫 에피소드 만들기' : '채널 만들기'} →</button></div>`;
  const scene = currentScene();
  html += `<div class="editor-grid"><div><section class="panel"><div class="panel-header"><div class="row"><span class="eyebrow">PREVIEW</span><span class="badge">${esc(episode.format)}</span></div><span id="save-status" class="${dirty ? 'unsaved' : 'hint'}">${dirty ? '저장되지 않은 변경' : `버전 ${episode.version} · 저장됨`}</span></div><div class="preview-stage"><span class="stage-tag">LIVE CANVAS / ${esc(episode.category?.toUpperCase() || 'STUDIO')}</span><div id="preview" class="preview" data-format="${esc(episode.format)}" aria-label="현재 장면 미리보기"></div></div><div class="transport"><span class="time" id="play-time">${time(episode.scenes.slice(0,sceneIndex).reduce((sum,s) => sum + s.duration,0))} / ${time(duration())}</span><div class="row"><button class="icon-btn quiet" data-action="prev" aria-label="이전 장면">‹</button><button class="icon-btn primary" data-action="play" aria-label="${playing ? '미리보기 정지' : '미리보기 재생'}">${playing ? 'Ⅱ' : '▶'}</button><button class="icon-btn quiet" data-action="next" aria-label="다음 장면">›</button></div><span class="hint">${sceneIndex + 1} / ${episode.scenes.length} 장면</span></div></section>
    <section class="panel timeline"><div class="panel-header"><h3>장면 타임라인</h3><span class="hint" id="total-duration">총 ${duration()}초</span></div><div class="timeline-body"><div class="ruler"><span>00:00</span><span>STORY → SCENE → FRAME</span><span>${time(duration())}</span></div><div class="scenes" id="scenes">${sceneCards()}</div><div class="row between timeline-actions"><button class="small quiet" data-action="add-scene">＋ 장면 추가</button><div class="row"><button class="small quiet" data-action="save-template">템플릿으로 저장</button><button class="small quiet" data-action="view" data-view="templates">템플릿 불러오기 ↗</button></div></div></div></section>
    <section class="panel section-spacer"><div class="panel-header"><h3>내보내기 작업</h3><span class="hint">FFmpeg · MP4</span></div><div id="jobs">${jobsHtml()}</div></section></div>
    <div class="right-column"><section class="panel inspector"><div class="panel-header"><h3>장면 편집</h3><span class="badge">SCENE ${String(sceneIndex + 1).padStart(2,'0')}</span></div><div class="panel-body">${scene ? inspectorHtml(scene) : '<p>장면을 추가해 주세요.</p>'}</div></section>${narrationHtml()}${chatHtml()}</div></div><p class="footnote">변경 사항은 버전별로 기록됩니다. 영상 업로드 전 채널 연결과 콘텐츠 권리를 확인하세요.</p>`;
  return html;
}

function inspectorHtml(scene) {
  return `<details><summary class="hint" style="cursor:pointer;margin-bottom:13px">에피소드 설정 · ${esc(episode.title)}</summary><label>에피소드 제목<input data-episode="title" value="${esc(episode.title)}" maxlength="200"></label><label>소재 / 주제<textarea data-episode="topic">${esc(episode.topic)}</textarea></label><div class="two-cols"><label>화면 비율<select data-episode="format">${['9:16','16:9','1:1'].map(format => `<option ${episode.format === format ? 'selected' : ''}>${format}</option>`).join('')}</select></label><label>제작 상태<select data-episode="status">${['draft','review','ready'].map(status => `<option value="${status}" ${episode.status === status ? 'selected' : ''}>${statusNames[status]}</option>`).join('')}</select></label></div><label>제작 메모<textarea data-episode="notes">${esc(episode.notes)}</textarea></label></details><label>장면 이름<input data-scene="title" value="${esc(scene.title)}" maxlength="120"></label><label>화면 텍스트<textarea data-scene="text" rows="3" placeholder="이 장면에 보여줄 문장을 입력하세요">${esc(scene.text)}</textarea></label><div class="two-cols"><label>길이 (초)<input type="number" data-scene="duration" min="0.5" max="120" step="0.5" value="${scene.duration}"></label><label>배경 색상<input type="color" class="color-input" data-scene="background" value="${safeColor(scene.background)}"></label></div><label>텍스트 레이아웃<select data-scene="layout"><option value="center" ${scene.layout === 'center' ? 'selected' : ''}>중앙 정렬</option><option value="lower-third" ${scene.layout === 'lower-third' ? 'selected' : ''}>하단 자막</option><option value="split" ${scene.layout === 'split' ? 'selected' : ''}>상하 분할</option></select></label><label>내레이션 원고<textarea data-scene="narration" rows="2" placeholder="장면별 음성 제작용 원고">${esc(scene.narration)}</textarea></label><p class="hint">원고를 입력한 다음 아래 내레이션 패널에서 실제 음성을 생성하세요. 생성하거나 첨부한 오디오가 MP4에 반영됩니다.</p><div class="row"><button class="small" data-action="upload">↑ 이미지 / 영상</button>${scene.assetUrl ? '<button class="small quiet" data-action="remove-media">소스 제거</button>' : '<span class="hint">로컬 파일</span>'}</div>${audioInspectorHtml(scene)}<div class="row between" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)"><div class="row"><button class="icon-btn quiet" data-action="move-left" aria-label="장면 앞으로 이동">←</button><button class="icon-btn quiet" data-action="move-right" aria-label="장면 뒤로 이동">→</button><button class="small quiet" data-action="duplicate-scene">복제</button></div><button class="small quiet danger" data-action="delete-scene">삭제</button></div>`;
}

function updatePreview() {
  const preview = $('#preview');
  const scene = currentScene();
  if (!preview || !scene) return;
  preview.style.backgroundColor = safeColor(scene.background);
  preview.dataset.format = episode.format;
  preview.dataset.layout = scene.layout;
  let media = '';
  if (scene.assetUrl) media = scene.kind === 'video' ? `<video src="${safeUrl(scene.assetUrl)}" muted playsinline ${playing ? 'autoplay' : ''} loop></video>` : `<img src="${safeUrl(scene.assetUrl)}" alt="장면에 업로드한 이미지">`;
  preview.innerHTML = `${media}<div class="preview-copy ${['center','lower-third','split'].includes(scene.layout) ? scene.layout : 'center'}"><span class="scene-overline">${esc(scene.title || 'YOUR NEXT STORY')}</span><div class="scene-text">${esc(scene.text || '여기에 이야기를 담아보세요')}</div></div><div class="preview-footer"><span>FRAMEFORGE</span><span>${String(sceneIndex + 1).padStart(2,'0')}</span></div>`;
  const video = $('video',preview);
  if (video && Number(scene.trimStart) > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(Number(scene.trimStart), Math.max(0,video.duration - 0.01)); }, {once:true});
}
function sceneCards() {
  return episode.scenes.map((scene,index) => `<button class="scene-card ${index === sceneIndex ? 'selected' : ''}" data-action="scene" data-index="${index}" aria-label="장면 ${index + 1}: ${esc(scene.title)}"><div class="scene-thumb" style="background:${safeColor(scene.background)}">${esc(scene.text?.slice(0,45) || scene.title)}</div><div class="scene-meta"><span>${String(index + 1).padStart(2,'0')} · ${esc(scene.title?.slice(0,12))}</span><span>${scene.duration}s</span></div></button>`).join('');
}
function jobsHtml() {
  const jobs = state.jobs.filter(job => job.episodeId === episode?.id).slice().reverse();
  if (!jobs.length) return '<div class="panel-body hint">영상을 내보내면 이곳에서 진행 상황과 다운로드를 확인할 수 있습니다.</div>';
  return jobs.slice(0,6).map(job => `<div class="job-item"><span class="badge ${job.status === 'completed' ? 'lime' : ''}">${esc(statusNames[job.status] || job.status)}</span><span class="muted">${date(job.createdAt)}</span>${['queued','running'].includes(job.status) ? `<progress value="${Number(job.progress) || 0}" max="100" aria-label="렌더링 진행률"></progress>` : ''}${job.outputUrl ? `<a href="${safeUrl(job.outputUrl)}" download>MP4 다운로드 ↓</a>` : ''}${job.error ? `<span class="danger">${esc(job.error)}</span>` : ''}</div>`).join('');
}
function chatHtml() {
  const messages = chatLogs.get(episode.id) || [];
  return `<section class="panel"><div class="panel-header"><div class="row"><span style="color:var(--lime)">✳</span><h3>제작 어시스턴트</h3></div><span class="badge">AGENT</span></div><div class="panel-body"><div class="chat-log" id="chat-log">${messages.length ? messages.map(message => `<div class="chat-message ${message.role === 'user' ? 'user' : ''}"><span class="chat-name">${esc(message.role === 'user' ? 'YOU' : message.agent)}</span>${esc(message.text)}</div>`).join('') : '<div class="chat-message"><span class="chat-name">STUDIO ASSISTANT</span>소재를 장면으로 구성해 보세요. 스튜디오 어시스턴트는 규칙 기반으로 장면을 만들고, 외부 에이전트는 실제 연결 상태에 따라 실행됩니다.</div>'}</div><form id="chat-form" class="chat-form"><label style="margin:0">실행 에이전트<select name="agent"><option value="studio">Studio · 규칙 기반</option value="codex">Codex · 외부 에이전트</option><option value="jeo">JEO · 외부 에이전트</option><option value="jeopi">JEOPI · 외부 에이전트</option><option value="hermes">Hermes · 외부 에이전트</option></select></label><textarea name="message" aria-label="에이전트에게 요청" placeholder="이 소재로 3장면 스토리보드를 만들어줘" required maxlength="4000"></textarea><button class="primary" type="submit">작업 실행 ↗</button></form></div></section>`;
}

function trendsView() {
  return heading('다음 이야기는, 지금의 관심에서', '검색 트렌드를 살펴보고 채널에 어울리는 소재와 연출 레퍼런스를 모으세요.', '<button class="primary" data-action="refresh-trends">↻ Google 트렌드 수집</button>') + `<div class="source-note">Google Trends의 실제 RSS를 수집합니다. 네이버 자료는 원문 링크와 함께 직접 기록할 수 있습니다. 아래 목록은 수집 기록이며 실시간 순위가 아닙니다.</div><div class="research-grid"><section class="panel"><div class="panel-header"><h2>소재 보관함</h2><span class="badge">${state.trends.length} KEYWORDS</span></div><div class="data-list">${state.trends.length ? state.trends.slice().reverse().map(trend => `<div class="data-row"><div><h3>${esc(trend.keyword)}</h3><p>${esc(trend.source)} · ${date(trend.capturedAt || trend.createdAt)}</p>${trend.url ? `<a class="hint" href="${safeUrl(trend.url)}" target="_blank" rel="noopener noreferrer">원문 확인 ↗</a>` : ''}</div><button class="small" data-action="trend-episode" data-id="${esc(trend.id)}">에피소드로 만들기</button></div>`).join('') : '<div class="empty">아직 수집한 소재가 없습니다.<br>트렌드를 수집하거나 관심 키워드를 직접 기록하세요.</div>'}</div></section><section class="panel"><div class="panel-header"><h3>키워드 직접 기록</h3></div><form class="panel-body" id="trend-form"><label>키워드<input name="keyword" required placeholder="지금 사람들이 궁금해하는 것"></label><label>출처<select name="source"><option>Naver</option><option>Google</option><option>YouTube</option><option>직접 조사</option></select></label><label>원문 링크<input name="url" type="url" required placeholder="https://..."></label><button class="primary" type="submit">소재 저장</button><p class="hint" style="margin-top:14px">관심도와 사실 여부는 원문을 확인해 판단하세요.</p></form></section></div><section class="panel section-spacer"><div class="panel-header"><h2>연출 레퍼런스</h2><button class="small" data-action="new-reference">＋ 레퍼런스 추가</button></div>${state.references.length ? state.references.map(reference => `<div class="data-row"><div><h3>${esc(reference.title)}</h3><p>${esc(categoryNames[reference.category] || reference.category)} · ${esc(reference.notes)}</p></div><a href="${safeUrl(reference.url)}" target="_blank" rel="noopener noreferrer">원본 보기 ↗</a></div>`).join('') : '<div class="empty">같은 카테고리 크리에이터의 구도, 템포, 자막 스타일을 기록하세요.</div>'}</section>`;
}
function templatesView() {
  return heading('좋은 형식은, 다음 이야기에도', '드라마, 재연, 정보 전달. 장면 구조를 불러와 나만의 연출로 바꾸세요.', episode ? '<button data-action="save-template">현재 장면을 템플릿으로 저장</button>' : '') + `<div class="cards">${state.templates.map(template => `<article class="panel"><div class="template-art" style="background:${safeColor(template.scenes?.[0]?.background)}">${esc(template.scenes?.[0]?.text || template.name)}</div><div class="template-info"><div class="row between"><h2>${esc(template.name)}</h2><span class="badge">${esc(template.format)}</span></div><p>${esc(categoryNames[template.category] || template.category)} · ${template.scenes?.length || 0} 장면</p><button class="primary small" data-action="apply-template" data-id="${esc(template.id)}">${episode ? '현재 에피소드에 적용' : '에피소드를 먼저 선택하세요'}</button></div></article>`).join('')}</div><p class="footnote">템플릿을 적용하면 현재 장면이 변경됩니다. 적용 전 버전은 제작 히스토리에 남습니다.</p>`;
}
function historyView() {
  const selected=history.find(item=>item.version===historyVersion) || history[0];
  const changes=selected && episode ? episodeChanges(selected.snapshot,episode) : [];
  return heading('무엇이 바뀌었는지, 한눈에', '이전 버전과 현재 편집본을 비교하고, 필요한 버전을 새 기록으로 복원하세요.', '<button data-action="reload-history">↻ 기록 새로고침</button>') +
    `<section class="panel history-panel"><div class="panel-header history-header"><div><span class="eyebrow">EPISODE HISTORY</span><h2>${esc(episode?.title || '선택된 에피소드 없음')}</h2></div><span class="badge">${history.length} VERSIONS</span></div><div class="panel-body"><label>기록을 볼 에피소드<select id="history-episode" aria-label="기록을 볼 에피소드">${state.episodes.map(item=>`<option value="${esc(item.id)}" ${item.id===episode?.id?'selected':''}>${esc(state.channels.find(channel=>channel.id===item.channelId)?.name || '')} · ${esc(item.title)}</option>`).join('')}</select></label></div>${selected ? `<div class="history-layout"><nav class="history-versions" aria-label="에피소드 버전">${history.map(item=>`<button data-action="history-version" data-version="${Number(item.version)}" class="history-version ${item.version===selected.version?'selected':''}" aria-pressed="${item.version===selected.version}"><strong>v${Number(item.version)} ${item.version===episode.version?'<span class="badge">현재</span>':''}</strong><span>${esc(historyReason(item.reason))}</span><small>${date(item.createdAt)}</small></button>`).join('')}</nav><div class="history-comparison" data-testid="episode-history-comparison"><div class="row between history-compare-heading"><div><h3>v${selected.version} → ${dirty?'편집 중 초안':`현재 v${episode.version}`}</h3><p class="hint">${changes.length}개 변경 · 장면은 고유 ID로 비교합니다.</p></div><button data-action="restore-episode" data-version="${selected.version}" ${dirty || savePending || selected.version===episode.version?'disabled':''}>이 버전으로 복원</button></div>${dirty?'<p class="wf-review-warning">저장되지 않은 편집을 먼저 저장해야 복원할 수 있습니다. 현재 초안은 유지됩니다.</p><button data-action="save-history-draft">초안 저장 후 비교</button>':''}${changesHtml(changes,esc,`선택 v${selected.version}`,dirty?'현재 초안':`현재 v${episode.version}`)}<details class="history-advanced"><summary>고급 · 원본 기록 JSON</summary><pre class="history-snapshot">${esc(JSON.stringify(selected.snapshot,null,2))}</pre></details><p class="hint">복원은 새 버전을 만듭니다. 이전 기록과 렌더 파일은 그대로 보존됩니다.</p></div></div>`:'<div class="empty">에피소드를 만들면 버전별 변경 기록이 표시됩니다.</div>'}</section><section class="panel section-spacer"><details><summary class="panel-header history-activity-heading"><h2>최근 워크스페이스 활동</h2><span aria-hidden="true">⌄</span></summary>${state.events.slice().reverse().slice(0,15).map(event=>`<div class="data-row"><div><h3>${esc(event.type || '작업 기록')}</h3><p>${esc(event.message || event.entityId || '')}</p></div><span class="hint">${date(event.createdAt)}</span></div>`).join('') || '<div class="empty">아직 기록된 활동이 없습니다.</div>'}</details></section>`;
}

function restoreEpisode(version) {
  if (!episode || dirty || savePending) throw new Error('먼저 현재 초안을 저장해 주세요. 저장되지 않은 편집은 보존됩니다.');
  const entry=history.find(item=>item.version===version);
  if (!entry) throw new Error('복원할 버전을 다시 선택해 주세요.');
  const targetId=episode.id,expectedVersion=episode.version,revision=editRevision;
  openModal(`v${version}을 새 버전으로 복원`, `<p class="hint">현재 v${expectedVersion}의 내용이 아래 선택 버전으로 바뀝니다. 기존 모든 버전은 보존되며, 복원 결과는 새 버전으로 저장됩니다.</p>${changesHtml(episodeChanges(episode,entry.snapshot),esc,`현재 v${expectedVersion}`,`복원할 v${version}`)}`,async()=>{
    if (episode?.id!==targetId || editRevision!==revision || dirty || episode.version!==expectedVersion) throw new Error('비교 이후 편집본이 변경되었습니다. 복원 내용을 다시 확인해 주세요.');
    const restored=await post(`/api/episodes/${targetId}/restore`,{version,expectedVersion});
    if (episode?.id!==targetId || editRevision!==revision || dirty) {await refresh();throw new Error('복원 기록은 저장됐으며, 진행 중인 로컬 편집은 보존했습니다. 최신 기록과 비교해 주세요.');}
    episode=restored;sceneIndex=0;historyVersion=restored.version;await refresh();await loadHistory();render();toast(`v${version}의 내용을 새 버전 v${restored.version}으로 복원했습니다.`);
  },'새 버전으로 복원');
}
function knowledgeView() {
  const graph = state.graph || {nodes:[],edges:[]};
  const nodes = graph.nodes || [];
  const visible = nodes.slice(0,36);
  const positions = new Map(visible.map((node,index) => [node.id, {x:350 + Math.cos(index * Math.PI * 2 / visible.length) * (index % 2 ? 245 : 155), y:195 + Math.sin(index * Math.PI * 2 / visible.length) * (index % 2 ? 140 : 85)}]));
  const lines = (graph.edges || []).map(edge => { const from = positions.get(edge.source || edge.from); const to = positions.get(edge.target || edge.to); return from && to ? `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/>` : ''; }).join('');
  const circles = visible.map(node => { const pos = positions.get(node.id); return `<g><circle class="${(node.type || node.kind) === 'episode' ? 'episode-node' : ''}" cx="${pos.x}" cy="${pos.y}" r="${(node.type || node.kind) === 'channel' ? 20 : 12}"/><text x="${pos.x}" y="${pos.y + 31}" text-anchor="middle">${esc((node.label || node.title || node.name || node.id).slice(0,16))}</text><title>${esc(node.label || node.title || node.id)}</title></g>`; }).join('');
  return heading('기억이 쌓일수록, 제작은 선명하게', '채널과 에피소드, 소재를 영구 지식 그래프로 연결합니다.', '<button data-action="refresh-knowledge">↻ 그래프 새로고침</button>') + `<div class="row" style="margin-bottom:17px"><span class="badge lime">${nodes.length} NODES</span><span class="badge">${graph.edges?.length || 0} RELATIONS</span><span class="badge">OKF KNOWLEDGE</span></div><section class="panel">${nodes.length ? `<svg class="graph" viewBox="0 0 700 390" role="img" aria-label="채널, 에피소드 및 소재의 관계 그래프">${lines}${circles}</svg>` : '<div class="empty">채널과 에피소드를 만들면 연결된 지식이 여기에 나타납니다.</div>'}</section><div class="cards section-spacer">${nodes.slice(0,30).map(node => `<article class="panel panel-body"><span class="eyebrow">${esc(node.type || node.kind || 'KNOWLEDGE')}</span><h3 style="margin:10px 0">${esc(node.label || node.title || node.name || node.id)}</h3><span class="hint">${esc(node.id)}</span></article>`).join('')}</div>`;
}
function settingsView() {
  const entries = Array.isArray(state.integrations) ? state.integrations.map((item,index) => [item.name || item.id || index,item]) : Object.entries(state.integrations || {});
  return heading('제작 도구를 하나의 공간으로', '실제 연결 상태를 확인하고, 외부 에이전트와 제작 환경을 관리하세요.') + `<div class="source-note">Studio는 로컬 규칙 기반 어시스턴트입니다. Codex · JEO · JEOPI · Hermes는 호스트 브리지가 연결되어야 실행됩니다. 채널 등록은 플랫폼 계정 인증이나 자동 업로드 연결을 의미하지 않습니다.</div><div class="status-grid">${entries.map(([name,raw]) => { const value = typeof raw === 'object' && raw !== null ? raw : {status:String(raw)}; const ready = value.available === true || value.connected === true || ['ready','connected','available','configured'].includes(value.status); return `<article class="panel integration"><div class="row between"><h3>${esc(name)}</h3><span class="badge ${ready ? 'lime' : 'coral'}">${ready ? '사용 가능' : esc(value.status || '연결 확인 필요')}</span></div><p>${esc(value.detail || value.message || value.reason || value.description || (ready ? '서버에서 연결 상태를 확인했습니다.' : '서버 환경 설정 또는 인증이 필요합니다.'))}</p>${value.url ? `<a href="${safeUrl(value.url)}" target="_blank" rel="noopener noreferrer">연결 열기 ↗</a>` : ''}</article>`; }).join('')}</div><section class="panel section-spacer"><div class="panel-header"><h2>등록된 채널</h2><button class="small" data-action="new-channel">＋ 채널 추가</button></div>${state.channels.map(channel => `<div class="data-row"><div><h3>${esc(channel.name)}</h3><p>${esc(channel.platform)} · ${esc(channel.accountEmail || '계정 미연결')}<br>${channel.externalId ? `채널 ID: ${esc(channel.externalId)}` : '플랫폼 채널 ID 미등록'}</p></div><span class="badge">${esc(categoryNames[channel.category] || channel.category)}</span></div>`).join('')}</section><div class="row section-spacer"><button data-action="refresh-integrations">↻ 연결 상태 확인</button><a href="/api/health" target="_blank" rel="noopener noreferrer">서비스 상태 보기 ↗</a></div>`;
}

function markDirty() {
  editRevision += 1;
  dirty = true;
  const status = $('#save-status');
  if (status) { status.textContent = '저장되지 않은 변경'; status.className = 'unsaved'; }
  updatePreview();
  if ($('#scenes')) $('#scenes').innerHTML = sceneCards();
  if ($('#total-duration')) $('#total-duration').textContent = `총 ${duration()}초`;
  updateSaveStatus();
}
async function save(quiet = false) {
  if (!episode || !dirty) return;
  if (savePending) throw new Error('저장 중입니다. 잠시 후 다시 시도해 주세요.');
  const revision = editRevision;
  const targetId = episode.id;
  savePending = true;
  updateSaveStatus();
  try {
    const updated = await api(`/api/episodes/${targetId}`, {method:'PUT',body:JSON.stringify({title:episode.title,topic:episode.topic,status:episode.status,format:episode.format,scenes:episode.scenes,notes:episode.notes,expectedVersion:episode.version})});
    const index = state.episodes.findIndex(item => item.id === updated.id);
    if (index >= 0) state.episodes[index] = clone(updated);
    if (episode?.id !== targetId) return;
    if (editRevision !== revision) {
      episode.version = updated.version;
      throw new Error('저장 중에 추가한 변경 사항을 보존했습니다. 변경 저장을 한 번 더 눌러 주세요.');
    }
    episode = updated;
    dirty = false;
    if (!quiet) toast('새 버전으로 저장했습니다.');
  } finally { savePending = false; updateSaveStatus(); }
}
function updateSaveStatus() {
  const status=$('#save-status');
  if (status) {status.textContent=savePending?'저장 중…':dirty?'저장되지 않은 변경':`버전 ${episode?.version} · 저장됨`;status.className=dirty?'unsaved':'hint';status.setAttribute('role','status');}
  if ($('#save-button')) $('#save-button').disabled=savePending || !dirty;
}
function stopPlayback() { playing = false; clearTimeout(playTimer); if (previewAudio) { previewAudio.pause(); previewAudio=null; } }
function playNext() {
  if (!playing) return;
  if (previewAudio) previewAudio.pause();
  const scene=currentScene();
  if (scene?.audioUrl) {
    previewAudio=new Audio(scene.audioUrl);
    previewAudio.volume=Math.min(1,Math.max(0,Number(scene.audioVolume ?? 1)));
    previewAudio.play().catch(()=>toast('오디오 재생을 시작할 수 없습니다. 장면 오디오 컨트롤을 사용하세요.',true));
  }
  playTimer = setTimeout(() => {
    if (sceneIndex >= episode.scenes.length - 1) { stopPlayback(); render(); return; }
    sceneIndex += 1;
    render();
    playNext();
  }, Number(currentScene()?.duration || 3) * 1000);
}

function openModal(title, body, handler, submit = '만들기') {
  $('#modal-content').innerHTML = `<h2>${title}</h2>${body}`;
  $('#modal-form button[type="submit"]').textContent = submit;
  modalHandler = handler;
  $('#modal').showModal();
}
function newChannel() {
  openModal('새로운 채널', `<label>채널 이름<input name="name" required maxlength="100" placeholder="나의 채널 이름"></label><div class="two-cols"><label>콘텐츠 유형<select name="category">${categoryOptions()}</select></label><label>플랫폼<select name="platform"><option value="youtube">YouTube</option><option value="instagram">Instagram</option><option value="tiktok">TikTok</option><option value="other">기타</option></select></label></div><label>계정 이메일 (선택)<input name="accountEmail" type="email" placeholder="연결할 계정"></label><label>플랫폼 채널 ID (선택)<input name="externalId" placeholder="실제 채널 ID"></label><p class="hint">이 등록은 제작 공간을 만듭니다. 외부 계정 인증과 게시 연결은 별도입니다.</p>`, async data => {
    await save(true);
    const channel = await post('/api/channels',data);
    channelId = channel.id;
    episode = null;
    await refresh();
    render();
    toast('채널 제작 공간을 만들었습니다.');
  });
}
function newEpisode(topic = '') {
  if (!channelId) { newChannel(); return; }
  openModal('새 에피소드 만들기', `<label>에피소드 제목<input name="title" required maxlength="200" value="${esc(topic)}" placeholder="이번 이야기의 제목"></label><label>소재 / 주제<textarea name="topic" required placeholder="어떤 이야기를 전달할까요?">${esc(topic)}</textarea></label><label>콘텐츠 유형<select name="category">${categoryOptions(activeChannel()?.category)}</select></label>`, async data => {
    await save(true);
    episode = await post('/api/episodes',{...data,channelId});
    sceneIndex = 0;
    dirty = false;
    view = 'studio';
    await refresh();
    render();
    toast('새 에피소드를 만들었습니다.');
  });
}
async function loadHistory() {
  history = episode ? await api(`/api/episodes/${episode.id}/history`) : [];
  if (!Array.isArray(history)) history = history.history || [];
  if (!history.some(item=>item.version===historyVersion)) historyVersion=history[0]?.version || null;
}

async function handleAction(button) {
  const action = button.dataset.action;
  if (action === 'narrate-scene' || action === 'narrate-all') { await startNarration(action === 'narrate-all'); return; }
  if (action === 'refresh-speech') { await loadSpeechVoices(); render(); return; }
  if (action === 'load-narration-result') {
    const result = pendingNarrations.get(episode?.id);
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(episode,null,2)],{type:'application/json'}));
    const link = document.createElement('a'); link.href=url; link.download=`frameforge-draft-${episode.id}.json`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    episode=clone(result); dirty=false; pendingNarrations.delete(episode.id); sceneIndex=Math.min(sceneIndex,episode.scenes.length-1); render(); toast('현재 초안을 JSON 파일로 보관하고 생성 결과를 불러왔습니다.'); return;
  }
  if (action === 'reload') { location.reload(); }
  else if (action === 'history-version') {historyVersion=Number(button.dataset.version);render();}
  else if (action === 'restore-episode') restoreEpisode(Number(button.dataset.version));
  else if (action === 'save-history-draft') {await save(true);await loadHistory();render();}
  else if (action === 'view') { stopPlayback(); if (view==='workflow' && workflowEditor.hasChanges()) await workflowEditor.save(); await save(true); view = button.dataset.view; if (view === 'history') await loadHistory(); if (view === 'settings') await loadCommands(); if (view === 'workflow') await workflowEditor.load(); render(); }
  else if (action === 'new-channel') newChannel();
  else if (action === 'new-episode') newEpisode();
  else if (action === 'channel') { stopPlayback(); if (workflowEditor.hasChanges()) await workflowEditor.save(); await save(true); channelId = button.dataset.id; episode = clone(state.episodes.find(item => item.channelId === channelId) || null); sceneIndex = 0; view = 'studio'; render(); }
  else if (action === 'episode') { stopPlayback(); await save(true); episode = clone(state.episodes.find(item => item.id === button.dataset.id)); sceneIndex = 0; render(); }
  else if (action === 'scene') { stopPlayback(); sceneIndex = Number(button.dataset.index); render(); }
  else if (action === 'save') { await save(); render(); }
  else if (action === 'prev' || action === 'next') { stopPlayback(); sceneIndex = Math.max(0,Math.min(episode.scenes.length - 1, sceneIndex + (action === 'prev' ? -1 : 1))); render(); }
  else if (action === 'play') { if (playing) stopPlayback(); else { playing = true; playNext(); } render(); }
  else if (action === 'add-scene') { stopPlayback(); episode.scenes.push({id:id(),title:`장면 ${episode.scenes.length + 1}`,text:'새로운 이야기를 담아보세요',duration:5,background:'#294434',kind:'title',layout:'center'}); sceneIndex = episode.scenes.length - 1; markDirty(); render(); }
  else if (action === 'duplicate-scene') { stopPlayback(); episode.scenes.splice(sceneIndex + 1,0,{...clone(currentScene()),id:id()}); sceneIndex++; markDirty(); render(); }
  else if (action === 'delete-scene') { if (episode.scenes.length === 1) { toast('최소 한 개의 장면이 필요합니다.',true); return; } stopPlayback(); episode.scenes.splice(sceneIndex,1); sceneIndex = Math.min(sceneIndex,episode.scenes.length - 1); markDirty(); render(); }
  else if (action === 'move-left' || action === 'move-right') { const next = sceneIndex + (action === 'move-left' ? -1 : 1); if (next < 0 || next >= episode.scenes.length) return; stopPlayback(); [episode.scenes[sceneIndex],episode.scenes[next]] = [episode.scenes[next],episode.scenes[sceneIndex]]; sceneIndex = next; markDirty(); render(); }
  else if (action === 'upload-audio') $('#audio-file').click();
  else if (action === 'remove-audio') { delete currentScene().audioUrl; markDirty(); render(); }
  else if (action === 'refresh-commands') { await loadCommands(); render(); }
  else if (action === 'upload') $('#media-file').click();
  else if (action === 'remove-media') { delete currentScene().assetUrl; currentScene().kind = 'title'; markDirty(); render(); }
  else if (action === 'render') { await save(true); const job = await post(`/api/episodes/${episode.id}/render`); state.jobs.push(job); render(); toast('MP4 렌더링을 시작했습니다. 아래에서 진행 상황을 확인하세요.'); }
  else if (action === 'save-template') { if (!episode) return; openModal('내 템플릿 저장', `<label>템플릿 이름<input name="name" required value="${esc(episode.title)} 템플릿"></label><label>콘텐츠 유형<select name="category">${categoryOptions(episode.category)}</select></label>`, async data => { await post('/api/templates',{...data,format:episode.format,scenes:episode.scenes}); await refresh(); render(); toast('템플릿을 저장했습니다.'); },'저장'); }
  else if (action === 'apply-template') { if (!episode) { toast('스튜디오에서 에피소드를 먼저 만들어 주세요.',true); return; } await save(true); episode = await post(`/api/episodes/${episode.id}/template`,{templateId:button.dataset.id}); sceneIndex = 0; dirty = false; view = 'studio'; await refresh(); render(); toast('템플릿을 적용했습니다.'); }
  else if (action === 'refresh-trends') { const result = await post('/api/trends/refresh'); await refresh(); render(); const sources = Array.isArray(result.sources) ? result.sources : Object.values(result.sources || {}); const errors = sources.filter(source => source.error || source.ok === false || source.status === 'error'); toast(errors.length ? `수집 결과를 확인하세요: ${errors.map(source => source.error || source.message || '일부 출처 연결 실패').join(' · ')}` : `${result.trends?.length || 0}개의 트렌드를 수집했습니다.`,errors.length > 0); }
  else if (action === 'trend-episode') { newEpisode(state.trends.find(trend => trend.id === button.dataset.id)?.keyword || ''); }
  else if (action === 'new-reference') { openModal('연출 레퍼런스 추가', `<label>레퍼런스 제목<input name="title" required placeholder="좋은 도입부, 자막, 장면 전환"></label><label>원본 링크<input name="url" type="url" required placeholder="https://..."></label><label>콘텐츠 유형<select name="category">${categoryOptions(activeChannel()?.category)}</select></label><label>참고할 연출 요소<textarea name="notes" placeholder="구도, 템포, 색감 등 참고할 점"></textarea></label>`, async data => { await post('/api/references',{...data,channelId}); await refresh(); render(); toast('레퍼런스를 기록했습니다.'); },'기록'); }
  else if (action === 'reload-history') { await refresh(); if (episode && !dirty) episode=clone(state.episodes.find(item=>item.id===episode.id) || episode); await loadHistory(); render(); }
  else if (action === 'refresh-knowledge') { const knowledge = await api('/api/knowledge'); state.graph = knowledge.graph || knowledge; render(); toast('최신 지식을 불러왔습니다.'); }
  else if (action === 'refresh-integrations') { state.integrations = await api('/api/integrations'); render(); toast('연결 상태를 확인했습니다.'); }
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || busy) return;
  busy = true;
  button.disabled = true;
  try { await handleAction(button); }
  catch (error) { toast(error.status === 409 ? '다른 작업에서 이 에피소드가 수정되었습니다. 현재 편집은 보존했습니다. 페이지를 다시 열기 전에 편집 내용을 복사해 주세요.' : error.message,true); }
  finally { busy = false; button.disabled = false; }
});

document.addEventListener('change',async event=>{
  if (event.target.id!=='history-episode') return;
  const targetId=event.target.value;
  try {await save(true);episode=clone(state.episodes.find(item=>item.id===targetId));channelId=episode.channelId;sceneIndex=0;historyVersion=null;await loadHistory();render();}
  catch(error) {event.target.value=episode?.id || '';toast(error.message,true);}
});

document.addEventListener('input', event => {
  const target = event.target;
  if (target.id === 'speech-voice') { speechVoice=target.value; return; }
  if (target.id === 'speech-rate') { if (target.checkValidity() && target.value !== '') speechRate=Number(target.value); return; }
  if (target.dataset.scene && currentScene()) {
    if (['duration','trimStart','audioVolume'].includes(target.dataset.scene)) { if (!target.checkValidity() || target.value === '') return; currentScene()[target.dataset.scene] = Number(target.value); }
    else currentScene()[target.dataset.scene] = target.value;
    markDirty();
  } else if (target.dataset.episode && episode) { episode[target.dataset.episode] = target.value; markDirty(); }
});

document.addEventListener('submit', async event => {
  if (!['chat-form','trend-form','command-form'].includes(event.target.id)) return;
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const button = $('button[type="submit"]',form);
  button.disabled = true;
  try {
    if (form.id === 'command-form') { await post('/api/commands',{message:data.message,source:'web'}); await loadCommands(); render(); }
    else if (form.id === 'trend-form') { await post('/api/trends',data); await refresh(); render(); toast('키워드를 기록했습니다.'); }
    else {
      await save(true);
      const requestId = episode.id;
      const revision = editRevision;
      const messages = chatLogs.get(requestId) || [];
      messages.push({role:'user',text:data.message});
      chatLogs.set(requestId,messages);
      const result = await post(`/api/episodes/${requestId}/chat`,data);
      messages.push({role:'assistant',agent:data.agent.toUpperCase(),text:result.message});
      if (result.episode && episode?.id === requestId) {
        if (editRevision === revision) { episode = result.episode; sceneIndex = 0; dirty = false; }
        else { episode.version = result.episode.version; toast('에이전트 작업 중 직접 편집한 내용을 보존했습니다. 에이전트 결과는 제작 히스토리에서 확인하세요.'); }
      }
      await refresh();
      render();
      const log = $('#chat-log');
      if (log) log.scrollTop = log.scrollHeight;
    }
  } catch (error) { toast(error.message,true); }
  finally { button.disabled = false; }
});

$('#modal-cancel').addEventListener('click', () => $('#modal').close());
$('#modal-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('button[type="submit"]',event.currentTarget);
  button.disabled = true;
  try { await modalHandler(Object.fromEntries(new FormData(event.currentTarget))); $('#modal').close(); }
  catch (error) { toast(error.message,true); }
  finally { button.disabled = false; }
});

$('#media-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  const selectedEpisode = episode?.id;
  const selectedScene = currentScene()?.id;
  if (!file || !selectedScene) return;
  try {
    toast('미디어를 업로드하는 중입니다…');
    const asset = await api(`/api/uploads?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':file.type || 'application/octet-stream'},body:file});
    if (episode?.id !== selectedEpisode) { toast('업로드했습니다. 선택한 에피소드가 바뀌어 장면에는 적용하지 않았습니다.',true); return; }
    const scene = episode.scenes.find(item => item.id === selectedScene);
    if (!scene) return;
    scene.assetUrl = asset.url;
    scene.kind = file.type.startsWith('video/') ? 'video' : 'image';
    markDirty();
    render();
    toast('미디어를 장면에 추가했습니다. 변경 저장을 눌러 보관하세요.');
  } catch (error) { toast(error.message,true); }
  finally { event.target.value = ''; }
});

$('#audio-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  const selectedEpisode = episode?.id;
  const selectedScene = currentScene()?.id;
  if (!file || !selectedScene) return;
  try {
    toast('오디오를 업로드하는 중입니다…');
    const asset = await api(`/api/uploads?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':file.type || 'application/octet-stream'},body:file});
    if (episode?.id !== selectedEpisode) { toast('오디오 업로드는 완료했지만 선택한 에피소드가 바뀌어 적용하지 않았습니다.',true); return; }
    const scene = episode.scenes.find(item => item.id === selectedScene);
    if (!scene) return;
    scene.audioUrl = asset.url;
    scene.audioVolume ??= 1;
    markDirty();
    render();
    toast('장면에 오디오를 첨부했습니다. 저장 후 MP4에 반영됩니다.');
  } catch (error) { toast(error.message,true); }
  finally { event.target.value = ''; }
});

window.addEventListener('beforeunload', event => { if (dirty || workflowEditor.hasChanges()) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', async event => { if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); try { if (view === 'workflow') await workflowEditor.save(); else await save(); render(); } catch (error) { toast(error.message,true); } } });

setInterval(async () => {
  if (!authenticated || polling || !(state.jobs.some(job => ['running','queued'].includes(job.status)) || (state.narrationJobs || []).some(job => ['running','queued'].includes(job.status)))) return;
  polling=true;
  try {
    const activeNarrations = new Set((state.narrationJobs || []).filter(job => ['queued','running'].includes(job.status)).map(job => job.id));
    const latest = await api('/api/state');
    state.jobs = latest.jobs || [];
    state.narrationJobs = latest.narrationJobs || [];
    for (const job of state.narrationJobs) {
      if (activeNarrations.has(job.id) && job.status === 'completed' && !completedNarrations.has(job.id)) { completedNarrations.add(job.id); applyNarrationResult(job,latest); }
    }
    if ($('#jobs')) $('#jobs').innerHTML = jobsHtml();
    if ($('#narration-status')) $('#narration-status').innerHTML = narrationStatusHtml();
    for (const button of document.querySelectorAll('[data-action="narrate-scene"],[data-action="narrate-all"]')) button.disabled = !speech.available || !speechVoice || ['queued','running'].includes(narrationJob()?.status);
  } catch { /* Foreground actions report errors; job polling preserves the current draft. */ }
  finally { polling=false; }
},2500);

try { await refresh(); render(); }
catch (error) { if (error.status !== 401) { $('#app').innerHTML = `<main class="panel login"><h1>스튜디오에 연결할 수 없습니다</h1><p>${esc(error.message)}</p><button data-action="reload">다시 연결</button></main>`; } }
