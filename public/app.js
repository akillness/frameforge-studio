import { createWorkflowEditor } from './workflow.js';
import {episodeChanges,changesHtml,historyReason} from './history.js';
import { createWorkspaceLayout, createOperationalWorkspace } from './workspace.js';
import { createProductionTools } from './production-tools.js';
import { createContextMenu, installInfoTooltips } from './context-menu.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clone = value => structuredClone(value);
const id = () => crypto.randomUUID();
const date = value => value ? new Date(value).toLocaleString('ko-KR', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
const categories = ['information','drama','reenactment'];
const categoryNames = {information:'정보 전달',drama:'드라마',reenactment:'재연'};
const statusNames = {draft:'제작 중',review:'검토 대기',ready:'제작 완료',archived:'보관됨',queued:'대기 중',running:'렌더링 중',completed:'완료',failed:'실패'};
const views = [['overview','☷','운영 개요'],['studio','▣','장면 편집'],['workflow','⤳','프로젝트 노드'],['source','↙','소스 · 이용 권리'],['delivery','↗','검토 · 공개'],['results','▤','결과 · 내보내기'],['trends','↗','트렌드 & 리서치'],['templates','▦','템플릿'],['history','◷','제작 히스토리'],['knowledge','⌘','지식 그래프'],['settings','⚙','연결 & 설정'],['archived','▢','보관된 프로젝트']];
let state = {channels:[],episodes:[],templates:[],trends:[],trendKeywords:[],popularTrendKeywords:[],trendCollectionRuns:[],trendCollector:null,references:[],jobs:[],events:[],integrations:{},graph:{nodes:[],edges:[]},platformSessions:[],platformUploads:[],serverExports:[]};
let view = 'workflow';
let channelId = null;
let episode = null;
let sceneIndex = 0;
let selectedSlotId = null;
let pendingSlotUploadId = null;
let activePlatformSessionId = null;
let dirty = false;
let editRevision = 0;
let baseVersion = null;
let savePending = false;
let history = [];
let historyVersion = null;
let playing = false;
let playTimer;
let previewCueTimer;
let previewSceneStartedAt = 0;
let previewMusicTimer;
let previewMusic;
let previewMusicContext;
let toastTimer;
let busy = false;
let authenticated = false;
let workbenchInitialization = 0;
const studioDrafts = new Map();
const channelEpisodes = new Map();
let sceneEditorOpen = false;
let activeTool = null;
let projectToolRequest = 0;
let overlayOpener = null;
const overlaySnapshots = new Map();
let musicUploads = [];
const musicGenerationStates = new Map();
const toolDescriptions = {overview:'채널과 전체 제작 현황을 확인합니다.',studio:'현재 프로젝트의 실제 장면·슬롯 초안을 편집합니다. 열기만으로 저장하지 않습니다.',workflow:'현재 프로젝트의 노드 캔버스로 돌아갑니다.',source:'소스 검색, 이용 권리와 출처를 확인합니다.',delivery:'완성 후보의 검토와 별도 공개 승인을 관리합니다. 열기만으로 공개하지 않습니다.',results:'렌더 결과와 서버 MP4, 플랫폼 브라우저를 확인합니다.',trends:'트렌드 수집 기록과 조사 도구를 엽니다.',templates:'기존 장면 템플릿을 확인합니다. 적용은 별도 명시적 동작입니다.',history:'원본 버전과 현재 초안을 비교합니다. 복원은 별도로 확인합니다.',knowledge:'채널·에피소드의 원본 관계와 지식을 확인합니다.',settings:'외부 연결과 작업 명령 기록을 확인합니다.',archived:'보관한 프로젝트를 확인하거나 원래 목록으로 복구합니다.'};
const canMutate = () => state.session?.authenticated === true;
const readActions = new Set(['view','channel','episode','project-section','scene','select-slot','select-platform-session','prev','next','play','reload','refresh-speech','refresh-commands','reload-history','history-version','refresh-knowledge','refresh-integrations','refresh-server-exports','trend-popular','ops-open','ops-history','project-tools','project-menu','episode-menu','channel-menu','tool-menu','sidebar-menu','open-scene-editor','close-scene-editor','close-project-tool','inspect-archived','graph-pan','graph-zoom-in','graph-zoom-out','graph-zoom-reset','graph-node-move','graph-node-reset']);
const readWorkflowActions = new Set(['select-node','minimap-select','inspector-tab','select-run','inspect-run-node','zoom-in','zoom-out','fit','reload','refresh-history','history-version','refresh-runs','refresh-generation','refresh-generation-job','open-tools','open-results','open-stage-overlay','close-overlay','select-stage','close-confirm','close-dialog','node-menu','canvas-menu','node-tools','scene-editor','node-results','node-history','connections','open-add-node','open-workflow-settings','confirm-delete-node','input','output','recent-runs-more','history-versions-more','history-page','refresh-run-history','refresh-run-detail','restore-workflow','estimate-ack']);
const mutationForms = new Set(['modal-form','chat-form','trend-form','trend-settings-form','command-form','wf-connect-form']);
function applySessionControls() {
  for (const control of document.querySelectorAll('[data-action],[data-wf-action],input,select,textarea,form button[type="submit"]')) {
    const mutation = control.dataset.action ? !readActions.has(control.dataset.action) : control.dataset.wfAction ? !readWorkflowActions.has(control.dataset.wfAction) :
      Boolean(control.matches('[data-scene],[data-caption],[data-music],[data-music-source],[data-slot-field],[data-slot-style],[data-episode],[data-wf-config],[data-wf-field],[data-wf-coordinate],[data-review-notes],#wf-name,#wf-add-type,#media-file,#audio-file') || mutationForms.has(control.closest('form')?.id));
    if (!mutation) continue;
    if (control.dataset.sessionRequired !== 'true') control.dataset.sessionRequired = 'true';
    if (!canMutate() && !control.disabled) { control.disabled = true; control.dataset.sessionDisabled = 'true'; }
    else if (canMutate() && control.dataset.sessionDisabled === 'true') { control.disabled = false; delete control.dataset.sessionDisabled; }
  }
}
// Workflow panels also replace their own controls between full page renders.
new MutationObserver(()=>{applySessionControls();applyProjectControls();}).observe(document.body,{childList:true,subtree:true});
for (const type of ['click','input','change','submit']) document.addEventListener(type,event=>{
  if (canMutate() || !event.target.closest('[data-session-required="true"]') && !(type === 'submit' && mutationForms.has(event.target.id))) return;
  event.preventDefault(); event.stopImmediatePropagation(); toast('변경하려면 로그인하세요.',true);
},true);
let modalHandler;
let commands = [];
let speech = {available:false,voices:[],detail:'음성 엔진을 확인하고 있습니다.'};
let speechLoaded = false;
let speechVoice = '';
let speechRate = 0;
let previewAudio;
let polling = false;
const completedNarrations = new Set();
const pendingNarrations = new Map();
const chatLogs = new Map();
const workflowEditor = createWorkflowEditor({
  api,
  toast,
  canMutate: () => canMutate() && state.episodes.find(item=>item.id === episode?.id)?.status !== 'archived',
  mutationBlockReason: () => !canMutate() ? '로그인이 필요합니다.' : state.episodes.find(item=>item.id === episode?.id)?.status === 'archived' ? '보관된 프로젝트 · 복구 후 편집하세요.' : '',
  onOpenSceneEditor: openSceneEditor,
  getEpisodes: activeEpisodes,
  getEpisode: liveEpisode,
  hasEpisodeChanges: targetId => episode?.id === targetId ? dirty : Boolean(studioDrafts.get(targetId)?.dirty),
  beforeRun: async targetId => {
    if (targetId && targetId !== episode?.id) throw new Error('현재 선택한 프로젝트에서 실행해 주세요.');
    stopPlayback(); await save(true);
    if (targetId && targetId !== episode?.id) throw new Error('프로젝트가 바뀌었습니다. 실행 대상을 다시 확인해 주세요.');
  },
  onRunUpdated: async () => {
    const targetId = episode?.id, revision = editRevision;
    await refresh();
    if (episode?.id === targetId && editRevision === revision && !dirty && !savePending) {
      const latest = state.episodes.find(item => item.id === targetId);
      if (latest) reconcileEpisode(latest);
    }
  },
});
const projectTools = new Map();
let mountedTools = null;
let canvasContextObserver = null;
let mountedContextKey = '';
const workspaceLayout = createWorkspaceLayout({toast});
const operations = createOperationalWorkspace({getData:()=>({...state,episodes:activeEpisodes()}), api, refresh, toast});
const appContextMenu = createContextMenu({onAction:(action, context) => { Promise.resolve(runProjectMenuAction(action, context)).catch(error=>toast(error.message,true)); }});
const infoTooltips = installInfoTooltips(document);

function activeEpisodes() { return state.episodes.filter(item => item.status !== 'archived'); }
function activeProjectWork(targetId) {
  const context = workflowEditor.getActivity();
  if (context?.episodeId === targetId && context.hasActiveRun) return true;
  const runs = [...(state.workflowRuns || []),...(state.jobs || []),...(state.narrationJobs || []),...(state.generationJobs || [])];
  if (context?.episodeId === targetId && context.run) runs.push(context.run);
  return runs.some(item => item.episodeId === targetId && ['queued','running','pending','submitting','polling','in_progress','downloading'].includes(item.status));
}
function projectEditReason(targetId = episode?.id) {
  if (!canMutate()) return '읽기 전용 · 로그인이 필요합니다.';
  if (state.episodes.find(item => item.id === targetId)?.status === 'archived') return '보관된 프로젝트 · 복구 후 편집하세요.';
  return activeProjectWork(targetId) ? '실행 중 · 완료 또는 취소 후 편집하세요.' : '';
}
function requireProjectEdit(targetId = episode?.id) {
  const reason = projectEditReason(targetId);
  if (reason) throw new Error(reason);
}
function applyProjectControls() {
  const reason = episode ? projectEditReason() : '';
  for (const control of document.querySelectorAll('#project-scene-dialog [data-action],#project-scene-dialog input,#project-scene-dialog select,#project-scene-dialog textarea,#project-scene-dialog button[type="submit"]')) {
    const action = control.dataset.action;
    const mutation = action ? !readActions.has(action) : control.matches('[data-scene],[data-caption],[data-music],[data-music-source],[data-slot-field],[data-slot-style],[data-episode]') || control.closest('#chat-form');
    if (!mutation) continue;
    if (reason && !control.disabled) { control.disabled = true; control.dataset.projectDisabled = 'true'; control.setAttribute('aria-description',reason); }
    else if (!reason && control.dataset.projectDisabled === 'true') { control.disabled = false; delete control.dataset.projectDisabled; }
  }
}
function decorateTooltips() {
  for (const control of document.querySelectorAll('#app button:not([data-tooltip]),#app [data-workspace-action]:not([data-tooltip])')) {
    const action = control.dataset.action;
    control.dataset.tooltip = action === 'view' ? toolDescriptions[control.dataset.view] || '프로젝트 도구를 엽니다.' : control.title || control.getAttribute('aria-label') || `${control.textContent.trim()} · 현재 프로젝트에서 선택한 작업을 수행합니다.`;
  }
  infoTooltips.refresh();
}
function overlayKey(kind) { return `${episode?.id || 'workspace'}:${kind}:${kind === 'scene' ? currentScene()?.id || '' : ''}`; }
function captureProjectOverlay() {
  for (const dialog of document.querySelectorAll('#project-scene-dialog[open],#project-tool-dialog[open]')) {
    const fields = [...dialog.querySelectorAll('input:not([type="file"]),textarea,select')];
    const focused = fields.indexOf(document.activeElement);
    const graphViewport = dialog.querySelector('#graph-viewport');
    overlaySnapshots.set(dialog.dataset.context, {fields:fields.map(field=>({value:field.value,checked:field.checked,preserve:!field.matches('[data-scene],[data-caption],[data-music],[data-music-source],[data-episode],[data-slot-field],[data-slot-style]')})),details:[...dialog.querySelectorAll('details')].map(item=>item.open),focused,start:focused < 0 ? null : fields[focused].selectionStart,end:focused < 0 ? null : fields[focused].selectionEnd,scrollTop:dialog.scrollTop,graphScrollLeft:graphViewport?.querySelector('.graph-node-dot') ? graphViewport.scrollLeft : null});
  }
}
function restoreProjectOverlay(dialog) {
  const snapshot = overlaySnapshots.get(dialog.dataset.context);
  if (!snapshot) return;
  const fields = [...dialog.querySelectorAll('input:not([type="file"]),textarea,select')];
  fields.forEach((field,index)=>{ const saved=snapshot.fields[index]; if (saved?.preserve && !field.disabled) { field.value=saved.value; field.checked=saved.checked; } });
  [...dialog.querySelectorAll('details')].forEach((item,index)=>{ if (index < snapshot.details.length) item.open=snapshot.details[index]; });
  const focused = fields[snapshot.focused];
  if (focused && !focused.disabled) { focused.focus({preventScroll:true}); if (snapshot.start !== null && typeof focused.setSelectionRange === 'function' && ['textarea','text','search','url','tel','password'].includes(focused.type)) focused.setSelectionRange(snapshot.start,snapshot.end); }
  dialog.scrollTop = snapshot.scrollTop;
}
function closeSceneEditor(restoreFocus = true) {
  projectToolRequest += 1;
  captureProjectOverlay(); stopPlayback(); sceneEditorOpen = false;
  const dialog = $('#project-scene-dialog');
  if (dialog?.open) dialog.close();
  if (dialog) dialog.innerHTML = '';
  stashActiveDraft();
  if (restoreFocus) (overlayOpener?.isConnected && overlayOpener.matches('button,a[href],input,select,textarea,[tabindex]') && !overlayOpener.matches(':disabled') ? overlayOpener : $('[data-action="open-scene-editor"]'))?.focus({preventScroll:true});
}
function closeProjectTool(restoreFocus = true) {
  finishGraphDrag(false);
  projectToolRequest += 1;
  captureProjectOverlay(); activeTool = null;
  const grid = $('#project-tool-body .production-tools-grid');
  if (grid) { $('#project-tool-reservoir')?.append(grid); grid.querySelectorAll('[data-production-tools]').forEach(panel=>{panel.hidden=false;}); }
  const dialog = $('#project-tool-dialog');
  if (dialog?.open) dialog.close();
  if ($('#project-tool-body')) $('#project-tool-body').innerHTML = '';
  if (restoreFocus) (overlayOpener?.isConnected && overlayOpener.matches('button,a[href],input,select,textarea,[tabindex]') && !overlayOpener.matches(':disabled') ? overlayOpener : $('#project-tools-menu'))?.focus({preventScroll:true});
}
function closeProjectOverlays() { closeSceneEditor(false); closeProjectTool(false); }
function bindProjectDialogs() {
  for (const [selector, close] of [['#project-scene-dialog',closeSceneEditor],['#project-tool-dialog',closeProjectTool]]) {
    const dialog = $(selector);
    dialog.addEventListener('cancel',event=>{ event.preventDefault(); close(); });
    dialog.addEventListener('close',()=>{ if (!dialog.open && $(selector) === dialog && (selector === '#project-scene-dialog' ? sceneEditorOpen : activeTool)) close(); });
  }
}
function mountSceneEditor() {
  const dialog = $('#project-scene-dialog');
  if (!dialog || !episode) return;
  const reason = projectEditReason();
  dialog.dataset.context = overlayKey('scene');
  dialog.innerHTML = `<div class="project-dialog-header"><div><h2 id="project-scene-title">장면 편집 · ${esc(episode.title)}</h2><p role="status">${esc(reason || '장면 초안은 이 창에서 저장합니다. 닫아도 저장 전 편집은 보존됩니다.')}</p></div><div class="row"><button type="button" id="save-button" class="primary" data-action="save" data-tooltip="장면과 슬롯 초안을 원래 버전으로 저장합니다. Ctrl 또는 Command+S">변경 저장</button><button type="button" data-action="open-generation" data-tooltip="생성 설정을 엽니다. 비용 확인과 실행 동의는 별도입니다.">Higgsfield 장면 생성</button><button type="button" data-action="render" data-tooltip="장면 초안을 저장한 후 MP4 렌더를 명시적으로 시작합니다.">영상 내보내기</button><button type="button" class="icon-btn quiet" data-action="close-scene-editor" aria-label="장면 편집 닫기" data-tooltip="편집 초안을 보존하고 노드 캔버스로 돌아갑니다.">×</button></div></div><div class="studio-layout project-scene-body">${studioView()}</div>`;
  updatePreview(); updateSaveStatus(); applySessionControls(); applyProjectControls(); decorateTooltips();
  dialog.showModal(); restoreProjectOverlay(dialog);
  mountMusicGeneration(dialog);
  loadMusicUploads(dialog);
}
function openSceneEditor(target = {}) {
  if (!episode || target.episodeId && target.episodeId !== episode.id) throw new Error('현재 프로젝트에 속한 장면만 열 수 있습니다.');
  const context = projectContext();
  if (target.workflowId && target.workflowId !== context.workflowId || target.nodeId && !context.workflow?.nodes.some(node=>node.id === target.nodeId)) throw new Error('선택한 노드가 현재 프로젝트에 없습니다.');
  let nextIndex = sceneIndex;
  if (target.sceneId) { nextIndex = episode.scenes.findIndex(scene=>scene.id === target.sceneId); if (nextIndex < 0) throw new Error('지정된 장면이 현재 초안에 없습니다.'); }
  if (target.slotId && !target.sceneId) { nextIndex = episode.scenes.findIndex(scene=>scene.slots?.some(slot=>slot.id === target.slotId)); if (nextIndex < 0) throw new Error('지정된 슬롯이 현재 초안에 없습니다.'); }
  const scene = episode.scenes[nextIndex];
  if (!scene || target.slotId && !scene.slots?.some(slot=>slot.id === target.slotId)) throw new Error('지정된 장면과 슬롯의 소유 관계가 맞지 않습니다.');
  const opener = document.activeElement;
  closeProjectOverlays(); overlayOpener = opener;
  sceneIndex = nextIndex; selectedSlotId = target.slotId || (scene.slots?.some(slot=>slot.id === selectedSlotId) ? selectedSlotId : scene.slots?.[0]?.id || null);
  sceneEditorOpen = true; mountSceneEditor(); stashActiveDraft();
}
function mountProjectTool() {
  const dialog = $('#project-tool-dialog');
  if (!dialog || !activeTool) return;
  dialog.dataset.context = overlayKey(activeTool);
  $('#project-tool-title').textContent = views.find(([key])=>key === activeTool)?.[2] || '제작 도구';
  const body = $('#project-tool-body');
  if (['source','delivery'].includes(activeTool)) {
    let grid = $('.production-tools-grid');
    if (!grid && episode) {
      mountedTools = toolsForProject();
      $('#project-tool-reservoir').innerHTML = productionToolsHtml();
      grid = $('.production-tools-grid');
      mountedTools.source.mount(); mountedTools.delivery.mount();
    }
    if (grid) { body.append(grid); grid.querySelectorAll('[data-production-tools]').forEach(panel=>{panel.hidden=panel.dataset.mode !== activeTool;}); }
    else body.innerHTML = '<p class="hint">프로젝트를 먼저 선택하세요.</p>';
  } else body.innerHTML = renderView(activeTool);
  if (activeTool === 'overview') operations.mount();
  applySessionControls(); decorateTooltips(); dialog.showModal(); restoreProjectOverlay(dialog);
  if (activeTool === 'knowledge') {
    const viewport = dialog.querySelector('#graph-viewport');
    const node = viewport?.querySelector('.graph-node.selected .graph-node-dot') || viewport?.querySelector('.graph-node-dot');
    const savedScroll = overlaySnapshots.get(dialog.dataset.context)?.graphScrollLeft;
    if (viewport && node && viewport.scrollWidth > viewport.clientWidth) {
      if (savedScroll != null) viewport.scrollLeft = savedScroll;
      else {
        const nodeBox = node.getBoundingClientRect(), viewportBox = viewport.getBoundingClientRect();
        viewport.scrollLeft += (nodeBox.left + nodeBox.right) / 2 - (viewportBox.left + viewportBox.right) / 2;
      }
    }
  }
}
async function openProjectTool(tool) {
  if (!views.some(([key])=>key === tool)) return;
  const request = ++projectToolRequest;
  if (tool === 'studio') { openSceneEditor(); return; }
  if (tool === 'workflow') { closeProjectOverlays(); $('#main')?.focus(); return; }
  const targetId = episode?.id;
  const opener = document.activeElement;
  if (tool === 'history') await loadHistory();
  if (tool === 'settings') await loadCommands();
  if (tool === 'trends') await loadTrendBrowser();
  if (request !== projectToolRequest || episode?.id !== targetId) return;
  closeProjectOverlays(); overlayOpener = opener; activeTool = tool; mountProjectTool();
}
function archivedProjectsHtml() {
  const archived = state.episodes.filter(item=>item.status === 'archived');
  return heading('보관된 프로젝트','목록에서만 숨긴 기록입니다. 원본, 미디어와 버전 이력은 유지됩니다.') + `<div class="cards">${archived.map(item=>`<article class="panel"><div class="panel-body"><h3>${esc(item.title)}</h3><p>${esc(state.channels.find(channel=>channel.id === item.channelId)?.name)} · v${item.version} · ${date(item.archivedAt)}</p><div class="row"><button type="button" data-action="inspect-archived" data-id="${esc(item.id)}" data-tooltip="보관된 프로젝트의 노드와 장면을 읽기 전용으로 엽니다.">프로젝트 확인</button><button type="button" data-action="ops-history" data-id="${esc(item.id)}" data-tooltip="보관한 프로젝트의 버전 이력을 확인합니다.">버전 기록</button><button type="button" data-action="unarchive-project" data-id="${esc(item.id)}" ${canMutate()?'':'disabled'} data-tooltip="확인 후 프로젝트를 활성 목록으로 복구합니다. 기록은 유지됩니다.">복구</button><button type="button" class="project-more icon-btn quiet" data-action="episode-menu" data-id="${esc(item.id)}" aria-label="${esc(item.title)} 보관 프로젝트 메뉴" aria-haspopup="menu">⋯</button></div></div></article>`).join('') || '<p class="hint">보관한 프로젝트가 없습니다.</p>'}</div>`;
}
function openProjectMenu(anchor, event) {
  projectToolRequest += 1;
  const action = anchor.dataset.action;
  const targetId = anchor.dataset.id || episode?.id;
  const target = state.episodes.find(item=>item.id === targetId);
  let title = '제작 도구';
  let items;
  const context = {targetId,channelId:anchor.dataset.id || channelId};
  if (action === 'channel-menu') {
    title = state.channels.find(item=>item.id === context.channelId)?.name || '채널';
    items = [{id:'rename-channel',label:'채널 이름 변경',description:canMutate()?'원본 채널의 현재 fingerprint로 충돌을 확인합니다.':'로그인이 필요합니다.',disabled:!canMutate()},{id:'tool:settings',label:'연결 & 설정',description:toolDescriptions.settings},{id:'new-project',label:'새 프로젝트',description:'이 채널에 에피소드를 만듭니다.',disabled:!canMutate()}];
  } else if (['project-menu','episode-menu'].includes(action)) {
    title = target?.title || '프로젝트';
    const reason = target ? projectEditReason(target.id) : '프로젝트를 선택하세요.';
    items = [{id:'open-project',label:'노드 캔버스 열기',description:'기록이나 초안을 저장하지 않고 프로젝트를 선택합니다.',disabled:!target},{id:'project-scenes',label:'장면 편집 열기',description:toolDescriptions.studio,disabled:!target},{id:'rename-project',label:'제목 변경',description:reason || '기존 원본 버전으로 제목만 저장합니다. 장면 초안은 유지됩니다.',disabled:!target || Boolean(reason)},{id:'project-history',label:'버전 기록',description:toolDescriptions.history,disabled:!target},{id:target?.status === 'archived'?'unarchive-project':'archive-project',label:target?.status === 'archived'?'프로젝트 복구':'프로젝트 보관',description:!canMutate()?'로그인이 필요합니다.':activeProjectWork(targetId)?'실행이 끝난 뒤 보관하세요.':'확인 후 목록에서만 숨깁니다. 미디어와 기록은 삭제하지 않습니다.',destructive:target?.status !== 'archived',disabled:!target || !canMutate() || activeProjectWork(targetId)}];
  } else {
    items = views.map(([key,icon,label])=>({id:`tool:${key}`,label,description:toolDescriptions[key],disabled:['studio','source','delivery','results','history'].includes(key) && !episode}));
    items.push({id:'workspace-settings',label:'작업 창 설정',description:'브라우저별 창 크기와 레이아웃 프로필을 관리합니다.'},{id:'new-channel',label:'새 채널',description:'새 채널 제작 공간을 등록합니다.',disabled:!canMutate()},{id:'new-project',label:'새 프로젝트',description:'현재 채널에 새 에피소드를 만듭니다.',disabled:!canMutate()});
  }
  appContextMenu.open({anchor,x:event?.clientX,y:event?.clientY,title,items,context});
}
async function runProjectMenuAction(action, context = {}) {
  if (action.startsWith('tool:')) { await openProjectTool(action.slice(5)); return; }
  if (action === 'workspace-settings') { closeProjectOverlays(); $('[data-workspace-action="settings"]')?.click(); return; }
  if (action === 'new-channel') { newChannel(); return; }
  if (action === 'new-project') { if (context.channelId && state.channels.some(item=>item.id === context.channelId) && context.channelId !== channelId) { closeProjectOverlays(); switchEpisode(null,context.channelId); render(); } newEpisode(); return; }
  if (action === 'rename-channel') { await renameChannel(context.channelId); return; }
  if (action === 'rename-project') { renameProject(context.targetId); return; }
  if (['archive-project','unarchive-project'].includes(action)) { archiveProject(context.targetId, action === 'unarchive-project'); return; }
  const target = state.episodes.find(item=>item.id === context.targetId);
  if (!target) throw new Error('현재 자료에서 프로젝트를 찾을 수 없습니다.');
  closeProjectOverlays(); stopPlayback(); switchEpisode(target); render();
  if (action === 'project-history') await openProjectTool('history');
  else if (action === 'project-scenes') openSceneEditor();
}
function renameProject(targetId) {
  requireProjectEdit(targetId);
  if (targetId === episode?.id ? dirty || savePending : studioDrafts.get(targetId)?.dirty) throw new Error('장면 초안의 원래 버전은 보존했습니다. 먼저 장면 초안을 저장한 뒤 제목을 변경하세요.');
  const target = liveEpisode(targetId);
  if (!target) throw new Error('프로젝트를 다시 선택하세요.');
  const draft = targetId === episode?.id ? {baseVersion:baseVersion ?? target.version,editRevision} : studioDrafts.get(targetId);
  const expectedVersion = draft?.baseVersion ?? target.version;
  openModal('프로젝트 제목 변경',`<label>제목<input name="title" required maxlength="200" value="${esc(target.title)}"></label><p class="hint">제목만 새 버전으로 저장합니다. 장면과 그래프 초안, 원본 미디어는 유지됩니다.</p>`,async data=>{
    requireProjectEdit(targetId);
    if (targetId === episode?.id ? dirty || savePending : studioDrafts.get(targetId)?.dirty) throw new Error('제목을 여는 동안 장면 초안이 바뀌었습니다. 초안을 먼저 저장하세요.');
    const updated = await api(`/api/episodes/${encodeURIComponent(targetId)}`,{method:'PUT',body:JSON.stringify({title:data.title,expectedVersion})});
    cacheEpisode(updated);
    const stashed = studioDrafts.get(targetId);
    const currentRevision = episode?.id === targetId ? editRevision : stashed?.editRevision;
    if (currentRevision === draft?.editRevision || !draft) {
      if (episode?.id === targetId) { episode.title=updated.title; episode.version=updated.version; baseVersion=updated.version; stashActiveDraft(); }
      else if (stashed) { stashed.episode.title=updated.title; stashed.episode.version=updated.version; stashed.baseVersion=updated.version; }
    }
    render(); toast('프로젝트 제목을 새 버전으로 저장했습니다.');
  },'제목 저장');
}
async function renameChannel(targetId) {
  if (!canMutate()) throw new Error('로그인이 필요합니다.');
  const result = await api('/api/knowledge');
  const graph = result.graph || result;
  const node = graph.nodes?.find(item=>item.id === targetId && item.type === 'channel');
  if (!node?.editable || !node.edit?.expectedRecord) throw new Error('채널 원본 정보를 새로고침하세요.');
  openModal('채널 이름 변경',`<label>채널 이름<input name="label" required maxlength="160" value="${esc(node.label)}"></label>`,async data=>{
    await api(`/api/knowledge/nodes/${encodeURIComponent(targetId)}`,{method:'PUT',body:JSON.stringify({label:data.label,expectedRecord:node.edit.expectedRecord})});
    await refresh(); render(); toast('채널 이름을 저장했습니다.');
  },'이름 저장');
}
function archiveProject(targetId, restore = false) {
  const target = state.episodes.find(item=>item.id === targetId);
  if (!target) throw new Error('프로젝트를 다시 선택하세요.');
  if (!canMutate()) throw new Error('로그인이 필요합니다.');
  if (activeProjectWork(targetId)) throw new Error('실행이 완료되거나 취소된 뒤 보관하세요.');
  if (targetId === episode?.id ? dirty || savePending || workflowEditor.hasChanges() : studioDrafts.get(targetId)?.dirty) throw new Error('저장 전 초안은 보존했습니다. 프로젝트를 열어 초안을 먼저 저장한 뒤 보관 또는 복구하세요.');
  if ((target.status === 'archived') !== restore) throw new Error('프로젝트의 보관 상태를 새로 확인하세요.');
  const expectedVersion = targetId === episode?.id ? baseVersion ?? target.version : studioDrafts.get(targetId)?.baseVersion ?? target.version;
  openModal(restore?'프로젝트 복구':'프로젝트 보관',`<p><strong>${esc(target.title)}</strong></p><p>${restore?'활성 프로젝트 목록으로 복구합니다.':'활성 목록에서만 숨깁니다. 보관 프로젝트 메뉴에서 언제든 확인하고 복구할 수 있습니다.'}</p><p class="hint">장면, 그래프, 버전 기록, 실행 이력과 원본 미디어는 삭제하지 않습니다.</p>`,async()=>{
    if (activeProjectWork(targetId)) throw new Error('프로젝트가 실행 중입니다. 완료 후 다시 시도하세요.');
    if (targetId === episode?.id ? dirty || savePending || workflowEditor.hasChanges() : studioDrafts.get(targetId)?.dirty) throw new Error('확인 중 초안이 바뀌었습니다. 초안을 먼저 저장하세요.');
    const updated = await post(`/api/episodes/${encodeURIComponent(targetId)}/${restore?'unarchive':'archive'}`,{expectedVersion});
    cacheEpisode(updated);
    if (episode?.id === targetId) { episode=clone(updated); baseVersion=updated.version; dirty=false; stashActiveDraft(); }
    else if (studioDrafts.has(targetId)) { const stashed=studioDrafts.get(targetId); stashed.episode=clone(updated); stashed.baseVersion=updated.version; }
    closeProjectOverlays();
    if (!restore && episode?.id === targetId) switchEpisode(activeEpisodes().find(item=>item.channelId === channelId) || null,channelId);
    render(); toast(restore?'프로젝트를 복구했습니다.':'프로젝트를 보관했습니다. 미디어와 기록은 유지됩니다.');
  },restore?'복구 확인':'보관 확인');
}

function bindWorkflowProject() {
  return workflowEditor.bindProject?.({episodeId: episode?.id ?? null, channelId});
}
function projectContext() {
  const context = workflowEditor.getContext?.();
  if (context?.episodeId === episode?.id && context?.channelId === channelId) return context;
  return {episodeId:episode?.id ?? null,channelId,workflowId:null,workflowVersion:null,selectedNodeId:null,runId:null,reviewNodeId:null,renderNodeId:null};
}
function toolsForProject() {
  if (!episode) return null;
  const targetId = episode.id, targetChannelId = channelId;
  if (!projectTools.has(targetId)) {
    const deps = {
      api,
      getEpisode: (requestedId = targetId) => requestedId === targetId && episode?.id === targetId ? episode : null,
      getWorkflowContext: () => episode?.id === targetId && channelId === targetChannelId ? projectContext() : {episodeId:targetId,channelId:targetChannelId,workflowId:null,workflowVersion:null,selectedNodeId:null,runId:null,reviewNodeId:null,renderNodeId:null},
      refresh,
      onEpisodeUpdated: onEpisodeUpdatedForTools,
      toast,
      canMutate: () => canMutate() && episode?.id === targetId && channelId === targetChannelId && !projectEditReason(targetId) && !dirty && !savePending,
    };
    projectTools.set(targetId,{source:createProductionTools(deps),delivery:createProductionTools(deps)});
  }
  return projectTools.get(targetId);
}
function productionToolsHtml() {
  const tools = mountedTools;
  return tools ? `<div class="production-tools-grid">${dirty ? '<p class="hint production-tools-draft" role="status">소스 변경과 공개 승인은 현재 초안을 저장한 뒤 진행하세요.</p>' : ''}${tools.source.html({mode:'source'})}${tools.delivery.html({mode:'delivery'})}</div>` : '';
}
function syncProjectToolsContext() {
  if (view !== 'workflow') return;
  const context = projectContext();
  const key = JSON.stringify([context.episodeId,context.channelId,context.workflowId,context.workflowVersion,context.selectedNodeId,context.runId,context.reviewNodeId,context.renderNodeId,context.run?.status,context.run?.reviews,context.hasActiveRun,activeProjectWork(episode?.id)]);
  if (key === mountedContextKey) return;
  const container = document.querySelector('.production-tools-grid');
  if ($('#project-navigation')?.contains(document.activeElement)) return;
  if (container?.contains(document.activeElement) || container?.querySelector('dialog[open]')) return;
  mountedContextKey = key;
  const navigation = $('#project-navigation');
  if (navigation) navigation.outerHTML = projectNavigationHtml();
  if (!container || !mountedTools) return;
  mountedTools.source.destroy(); mountedTools.delivery.destroy();
  container.outerHTML = productionToolsHtml();
  mountedTools.source.mount(); mountedTools.delivery.mount();
  if (['source','delivery'].includes(activeTool)) document.querySelectorAll('#project-tool-body [data-production-tools]').forEach(panel=>{panel.hidden=panel.dataset.mode !== activeTool;});
  applyProjectControls();
}

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = `visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = ''; }, error ? 9000 : 4500);
}

async function api(path, options = {}) {
  if (!['GET','HEAD'].includes((options.method || 'GET').toUpperCase()) && path !== '/api/login' && !canMutate()) throw new Error('변경하려면 로그인하세요.');
  const headers = options.body && typeof options.body === 'string' ? {'Content-Type':'application/json', ...options.headers} : options.headers;
  const response = await fetch(path, {...options, headers, credentials:'same-origin'});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      authenticated = false;
      state.session = null;
      if (!path.endsWith('/login')) showLogin();
    }
    const error = new Error(data.error || data.message || `요청 실패 (${response.status})`);
    error.status = response.status;
    if (data.code) error.code = data.code;
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
const SLOT_FONTS = ['system-ui', 'Arial', 'Georgia', 'ui-monospace'];
const safeFontFamily = value => SLOT_FONTS.includes(value) ? value : 'system-ui';
const safeTextColor = value => /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#ffffff';
const safeAlign = value => ['left', 'center', 'right'].includes(value) ? value : 'center';
function activeChannel() { return state.channels.find(channel => channel.id === channelId); }
function liveEpisode(targetId = episode?.id) { return episode?.id === targetId ? episode : studioDrafts.get(targetId)?.episode || state.episodes.find(item => item.id === targetId); }
function currentScene() { return episode?.scenes?.[sceneIndex]; }
function duration() { return episode?.scenes?.reduce((sum, scene) => sum + Number(scene.duration || 0), 0) || 0; }
function time(value) { return `${String(Math.floor(value / 60)).padStart(2,'0')}:${String(Math.floor(value % 60)).padStart(2,'0')}`; }

function trendItems() { return Array.isArray(state.trendKeywords) && state.trendKeywords.length ? state.trendKeywords : state.trends; }
function trendById(targetId) { return trendItems().find(item => item.id === targetId) || state.trends.find(item => item.id === targetId); }
function trendCollectorStatus() { return state.trendCollector || {}; }
function trendDays(value) { const days = Number(value) / (24 * 60 * 60 * 1000); return Number.isFinite(days) ? `${Math.round(days)}일` : '14일'; }
function trendInterval(value) { const hours = Number(value) / (60 * 60 * 1000); return Number.isFinite(hours) && hours >= 1 ? `${hours % 24 === 0 ? hours / 24 : Math.round(hours * 10) / 10}${hours % 24 === 0 ? '일' : '시간'}` : '24시간'; }
function trendMediaHtml(trend) {
  const raw = trend.relatedMedia ?? trend.related_media ?? trend.media;
  const media = Array.isArray(raw) ? raw : raw ? [raw] : trend.mediaUrl ? [{url:trend.mediaUrl,type:trend.mediaType,title:trend.mediaTitle}] : [];
  return media.slice(0, 4).map(item => {
    const url = typeof item === 'string' ? item : item?.url || item?.mediaUrl;
    const label = typeof item === 'string' ? '관련 미디어' : item?.title || item?.name || item?.type || '관련 미디어';
    return url ? `<a class="hint" href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : `<span class="hint">${esc(label)}</span>`;
  }).join(' · ');
}
async function loadTrendBrowser(params = {}) {
  const query = new URLSearchParams({limit:'100', ...params});
  const result = await api(`/api/trends?${query}`);
  state.trendKeywords = Array.isArray(result.keywords) ? result.keywords : [];
  state.popularTrendKeywords = Array.isArray(result.popular) ? result.popular : [];
  state.trendCollectionRuns = Array.isArray(result.runs) ? result.runs : [];
  state.trendCollector = result.collector || state.trendCollector;
  return result;
}

async function refresh() {
  state = {...state, ...await api('/api/state')};
  operations.noteSuccess();
  authenticated = true;
  if (!channelId && !episode) {
    try {
      const selected = activeEpisodes().find(item => item.id === sessionStorage.getItem('frameforge.selectedEpisode'));
      if (selected && state.channels.some(channel => channel.id === selected.channelId)) channelId = selected.channelId;
    } catch { /* Storage can be unavailable; use the normal selection. */ }
  }
  if (!channelId || !state.channels.some(channel => channel.id === channelId)) channelId = state.channels[0]?.id || null;
  if (!episode) {
    let selectedId;
    try { selectedId = sessionStorage.getItem('frameforge.selectedEpisode'); } catch { /* Use the normal selection. */ }
    switchEpisode(activeEpisodes().find(item => item.id === (channelEpisodes.get(channelId) || selectedId) && item.channelId === channelId) || activeEpisodes().find(item => item.channelId === channelId) || null, channelId);
  }
  bindWorkflowProject();
  if (!speechLoaded) await loadSpeechVoices();
  if (activeTool === 'trends') await loadTrendBrowser();
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
  const targetId = episode?.id;
  const selectedId = currentScene()?.id;
  const voice = speechVoice, rate = speechRate;
  stopPlayback();
  await save(true);
  if (episode?.id !== targetId) throw new Error('프로젝트가 바뀌었습니다. 음성 생성 대상을 다시 확인하세요.');
  const job = await post(`/api/episodes/${targetId}/narration`,{expectedVersion:episode.version,voice,rate,...(!allScenes ? {sceneIds:[selectedId]} : {})});
  state.narrationJobs ||= [];
  state.narrationJobs.unshift(job);
  render();
  toast('음성 파일 생성을 시작했습니다. 완료될 때까지 프로젝트 변경은 잠깐 잠깁니다.');
}

function applyNarrationResult(job, latest) {
  const savedEpisode = latest.episodes?.find(item => item.id === job.episodeId);
  if (!savedEpisode) return;
  cacheEpisode(savedEpisode);
  if (episode?.id !== job.episodeId || !reconcileEpisode(savedEpisode)) {
    pendingNarrations.set(job.episodeId,clone(savedEpisode));
    if (episode?.id !== job.episodeId) return;
    toast('음성 생성 완료. 현재 편집은 보존했습니다. 음성 패널에서 서버 결과를 불러올 수 있습니다.');
  }
  sceneIndex = Math.min(sceneIndex,episode.scenes.length - 1);
  // Do not replace focused fields or the whole editor during background polling.
  if (sceneEditorOpen) {
    const inspector = $('.inspector .panel-body');
    if (inspector && !inspector.contains(document.activeElement)) inspector.innerHTML = inspectorHtml(currentScene());
    const status = $('#save-status');
    if (status) status.textContent = dirty ? '저장되지 않은 변경 · 음성 결과 별도 보관' : `버전 ${episode.version} · 저장됨`;
    if ($('#scenes')) $('#scenes').innerHTML = sceneCards();
    if ($('#project-bin-list')) $('#project-bin-list').innerHTML = sceneBinItems();
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

function stopWorkbench() {
  closeProjectOverlays();
  workspaceLayout.beforeRender(false);
  canvasContextObserver?.disconnect(); canvasContextObserver = null;
  mountedTools?.source.destroy(); mountedTools?.delivery.destroy(); mountedTools = null;
  workflowEditor.destroy();
  stashActiveDraft();
}
function showWorkbenchLoadFailure(error) {
  stopWorkbench();
  $('#app').innerHTML = `<main class="panel login"><h1>스튜디오에 연결할 수 없습니다</h1><p role="alert">${esc(error.message)}</p><button data-action="reload">다시 연결</button></main>`;
}
async function initializeWorkbench(request = ++workbenchInitialization) {
  await refresh();
  if (request !== workbenchInitialization) return;
  await workflowEditor.load();
  if (request !== workbenchInitialization) return;
  bindWorkflowProject();
  render();
}
function showLogin() {
  workbenchInitialization += 1;
  stopWorkbench();
  $('#app').innerHTML = `<main class="panel login"><div class="brand"><span class="brandmark">F</span> FRAMEFORGE</div><h1>나의 제작실에 입장</h1><p>개인 스튜디오의 접근 토큰을 입력해 주세요. 인증 후 채널과 제작 기록에 접근할 수 있습니다.</p><form id="login-form"><label>접근 토큰<input name="token" type="password" autocomplete="current-password" required></label><button class="primary">스튜디오 열기 →</button><p class="hint" id="login-error" role="alert"></p></form></main>`;
  const form = $('#login-form');
  const button = $('button',form);
  const errorNode = $('#login-error',form);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    const request = ++workbenchInitialization;
    const token = new FormData(form).get('token');
    button.disabled = true;
    button.textContent = '프로젝트를 준비하는 중…';
    form.setAttribute('aria-busy','true');
    errorNode.textContent = '';
    try {
      await post('/api/login',{token});
      if (request !== workbenchInitialization || !form.isConnected) return;
      await initializeWorkbench(request);
    } catch (error) {
      if (request !== workbenchInitialization) return;
      if (form.isConnected) errorNode.textContent = error.message;
      else showWorkbenchLoadFailure(error);
    } finally {
      if (request === workbenchInitialization && form.isConnected) {
        button.disabled = false;
        button.textContent = '스튜디오 열기 →';
        form.removeAttribute('aria-busy');
      }
    }
  });
  $('input',form).focus();
}

const platformNames = {youtube:'YouTube',instagram:'Instagram',tiktok:'TikTok',other:'기타 플랫폼'};
function channelHierarchyHtml() {
  const groups = new Map();
  for (const channel of state.channels) {
    const key = (channel.platform || 'other').trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(channel);
  }
  return [...groups].map(([key,channels]) => {
    const label = platformNames[key] || channels[0].platform;
    return `<details class="platform-group" ${channels.some(item=>item.id===channelId)?'open':''}><summary data-tooltip="${esc(label)} 채널을 펼쳐 프로젝트를 선택합니다."><span class="platform-symbol" aria-hidden="true">${esc(label.slice(0,1))}</span><span class="platform-name">${esc(label)}</span><span class="platform-count">${channels.length}</span></summary><div class="platform-channels">${channels.map(item => `<div class="project-row"><button class="channel ${item.id===channelId?'active':''}" data-action="channel" data-id="${esc(item.id)}" ${item.id===channelId?'aria-current="true"':''} data-tooltip="${esc(item.name)}의 마지막 프로젝트 노드 캔버스를 엽니다."><span class="channel-avatar">${String(state.channels.indexOf(item)+1).padStart(2,'0')}</span><span class="channel-copy"><span class="channel-name">${esc(item.name)}</span><small>${esc(categoryNames[item.category] || item.category)}</small></span></button><button type="button" class="icon-btn quiet project-more" data-action="channel-menu" data-id="${esc(item.id)}" aria-label="${esc(item.name)} 채널 메뉴" aria-haspopup="menu" data-tooltip="채널 이름 변경과 연결 설정을 엽니다.">⋯</button></div>`).join('')}</div></details>`;
  }).join('');
}
function sceneBinItems() {
  return episode.scenes.map((scene,index) => `<button class="source-item ${index===sceneIndex?'selected':''}" data-action="scene" data-index="${index}" ${index===sceneIndex?'aria-current="true"':''}><span class="source-number">${String(index+1).padStart(2,'0')}</span><span class="source-copy"><strong>${esc(scene.title || '이름 없는 장면')}</strong><small>${scene.assetUrl?(scene.kind==='video'?'영상':'이미지'):'텍스트'} · ${Number(scene.duration)}초${scene.audioUrl?' · 오디오 첨부':''}</small></span></button>`).join('');
}

function render() {
  captureProjectOverlay();
  appContextMenu.close();
  workspaceLayout.beforeRender();
  canvasContextObserver?.disconnect(); canvasContextObserver = null;
  mountedContextKey = '';
  mountedTools?.source.destroy();
  mountedTools?.delivery.destroy();
  mountedTools = null;
  workflowEditor.destroy();
  stashActiveDraft();
  bindWorkflowProject();
  view = 'workflow';
  document.body.dataset.workbench = 'project';
  const channel = activeChannel();
  $('#app').innerHTML = `<div class="shell"><aside id="project-sidebar" class="sidebar" aria-label="워크스페이스 탐색">
    <div class="brand"><span class="brandmark" aria-hidden="true">F</span><div class="brand-copy">FRAME<small>PRODUCTION STUDIO</small></div></div>
    <div class="sidebar-sizing" role="group" aria-label="사이드바 크기"><button type="button" data-sidebar-size="decrease" aria-label="사이드바 좁게">−</button><button type="button" data-sidebar-size="increase" aria-label="사이드바 넓게">+</button></div><div class="sidebar-resize" role="separator" tabindex="0" aria-label="사이드바 너비 조절" aria-orientation="vertical" aria-valuemin="160" aria-valuemax="400" aria-valuenow="216" aria-controls="project-sidebar"></div>
    <div class="sidebar-label">제작 워크스페이스 <button type="button" class="icon-btn quiet project-more" data-action="sidebar-menu" aria-label="워크스페이스 메뉴" aria-haspopup="menu" data-tooltip="새 채널, 제작 현황, 보관 프로젝트와 설정 도구를 엽니다.">⋯</button></div>
    <section class="platform-browser" aria-label="플랫폼과 채널"><div class="sidebar-label">PLATFORMS <button class="icon-btn quiet" data-action="new-channel" aria-label="채널 추가" data-tooltip="새 채널 제작 공간을 등록합니다. 외부 계정 인증은 별도입니다.">+</button></div>${channelHierarchyHtml() || '<p class="hint platform-name">등록된 채널이 없습니다.</p>'}</section>
    <section class="project-list" aria-label="채널 프로젝트"><div class="sidebar-label">PROJECTS <button type="button" class="icon-btn quiet" data-action="new-episode" aria-label="새 프로젝트" data-tooltip="현재 채널에 새 에피소드를 만듭니다.">+</button></div>${activeEpisodes().filter(item=>item.channelId===channelId).map(item=>`<div class="project-row"><button type="button" class="channel ${item.id===episode?.id?'active':''}" data-action="episode" data-id="${esc(item.id)}" data-tooltip="${esc(item.title)}의 노드 캔버스를 엽니다."><span class="channel-copy">${esc(studioDrafts.get(item.id)?.episode.title || item.title)}</span></button><button type="button" class="icon-btn quiet project-more" data-action="episode-menu" data-id="${esc(item.id)}" aria-label="${esc(item.title)} 프로젝트 메뉴" aria-haspopup="menu" data-tooltip="제목 변경, 버전 기록, 안전한 보관 메뉴입니다.">⋯</button></div>`).join('') || '<p class="hint">새 프로젝트를 만들어 시작하세요.</p>'}</section>
    <a class="channel" href="/blog.html" target="_blank" rel="noopener" aria-label="블로그 운영실 새 탭에서 열기" data-testid="blog-workspace-link"><span class="nav-icon" aria-hidden="true">B</span><span class="channel-copy">블로그 운영실 ↗</span></a>
    <div class="sidebar-bottom"><button class="channel quiet" data-action="view" data-view="archived" data-tooltip="보관한 프로젝트와 기록을 확인하고 복구합니다."><span class="nav-icon" aria-hidden="true">▢</span><span class="channel-copy">보관된 프로젝트</span></button><button class="channel quiet" data-action="view" data-view="settings" data-tooltip="외부 플랫폼 연결과 설정을 확인합니다."><span class="nav-icon" aria-hidden="true">⚙</span><span class="channel-copy">연결 & 설정</span></button></div>
    </aside><div class="workspace"><header class="topbar"><div class="breadcrumb">${esc(platformNames[channel?.platform?.toLowerCase()] || channel?.platform || '워크스페이스')} <span aria-hidden="true"> / </span><strong>${esc(channel?.name || '채널 없음')}</strong><span aria-hidden="true"> / </span>프로젝트 노드</div><div class="row"><span class="badge" data-testid="session-capability">${canMutate()?'로그인됨':'로그인 확인 필요'}</span><button type="button" id="project-tools-menu" class="small" data-action="project-tools" aria-haspopup="menu" data-tooltip="장면 편집, 소스, 결과, 히스토리와 모든 제작 도구를 캔버스 위에서 엽니다.">제작 도구 ▾</button></div></header>
    <main class="main" id="main" tabindex="-1">${projectNavigationHtml()}${workspaceLayout.html(workflowEditor.html(), 'workflow')}<div id="project-tool-reservoir" hidden>${productionToolsHtml()}</div></main></div></div>
    <dialog id="project-scene-dialog" class="project-scene-dialog" aria-labelledby="project-scene-title"></dialog>
    <dialog id="project-tool-dialog" class="project-tool-dialog" aria-labelledby="project-tool-title"><div class="project-dialog-header"><h2 id="project-tool-title">제작 도구</h2><div class="row"><button type="button" class="icon-btn quiet project-more" data-action="tool-menu" aria-haspopup="menu" aria-label="다른 제작 도구" data-tooltip="현재 프로젝트의 다른 도구를 선택합니다.">⋯</button><button type="button" class="icon-btn quiet" data-action="close-project-tool" aria-label="제작 도구 닫기" data-tooltip="도구를 닫고 노드 캔버스로 돌아갑니다. 초안은 보존됩니다.">×</button></div></div><div id="project-tool-body" class="project-tool-body"></div></dialog>`;
  workspaceLayout.mount();
  syncProjectToolsContext();
  workflowEditor.mount();
  canvasContextObserver = new MutationObserver(syncProjectToolsContext);
  const host = $('#workflow-host');
  if (host) canvasContextObserver.observe(host,{childList:true,subtree:true});
  bindProjectDialogs();
  if (sceneEditorOpen && episode) mountSceneEditor();
  else if (activeTool) mountProjectTool();
  updateSaveStatus();
  applySessionControls();
  applyProjectControls();
  decorateTooltips();
}

function projectNavigationHtml() {
  const context = projectContext();
  const nodes = context.workflow?.nodes || [];
  const reason = episode ? projectEditReason(episode.id) : '';
  return `<section class="project-navigation" id="project-navigation" aria-label="프로젝트 작업대">
    <div class="project-context"><span class="eyebrow">${esc(activeChannel()?.name || '채널을 선택하세요')}</span><strong>${esc(episode?.title || '선택된 프로젝트 없음')}</strong><span class="hint">${episode ? `원본 v${baseVersion ?? episode.version}${dirty ? ' · 장면 초안 편집 중' : ''}${reason ? ` · ${esc(reason)}` : ''}` : '새 프로젝트를 만들어 시작하세요.'}</span></div>
    <label>현재 프로젝트<select id="project-episode" aria-label="현재 프로젝트" data-tooltip="프로젝트를 바꿔도 장면과 그래프의 저장 전 초안은 각각 보존됩니다."><option value="">프로젝트 선택</option>${activeEpisodes().filter(item => item.channelId === channelId).map(item => `<option value="${esc(item.id)}" ${item.id === episode?.id ? 'selected' : ''}>${esc(studioDrafts.get(item.id)?.episode.title || item.title)}</option>`).join('')}</select></label>
    ${nodes.length ? `<label>노드 단계<select id="project-stage" aria-label="프로젝트 노드 단계" data-tooltip="노드 ID로 정확한 단계를 선택합니다. 선택만으로 실행하지 않습니다."><option value="">단계 선택</option>${nodes.map(node => `<option value="${esc(node.id)}" ${context.selectedNodeId === node.id ? 'selected' : ''}>${esc(node.label || node.type)} · ${esc(node.id)}</option>`).join('')}</select></label>` : '<p class="hint">템플릿에서 프로젝트 워크플로우를 연결하세요.</p>'}
    <div class="project-tool-strip" role="group" aria-label="프로젝트 도구"><button type="button" data-action="open-scene-editor" aria-haspopup="dialog" data-tooltip="${esc(toolDescriptions.studio)}" ${episode?'':'disabled'}>장면 편집</button><button type="button" data-action="project-section" data-section="source" aria-haspopup="dialog" data-tooltip="${esc(toolDescriptions.source)}" ${episode?'':'disabled'}>소스</button><button type="button" data-action="project-section" data-section="delivery" aria-haspopup="dialog" data-tooltip="${esc(toolDescriptions.delivery)}" ${episode?'':'disabled'}>검토 · 공개</button><button type="button" class="icon-btn quiet project-more" data-action="project-menu" data-id="${esc(episode?.id)}" aria-label="프로젝트 메뉴" aria-haspopup="menu" data-tooltip="프로젝트 제목 변경, 버전 기록과 보관 메뉴입니다.">⋯</button></div>
  </section>`;
}

function heading(title, description, actions = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="row">${actions}</div></div>`;
}
function renderView(tool = activeTool) {
  if (tool === 'overview') return operations.html();
  if (tool === 'trends') return trendsView();
  if (tool === 'templates') return templatesView();
  if (tool === 'history') return historyView();
  if (tool === 'knowledge') return knowledgeView();
  if (tool === 'archived') return archivedProjectsHtml();
  if (tool === 'results') return `<section class="panel"><div class="panel-header"><h2>내보내기 결과</h2></div><div id="jobs">${jobsHtml()}</div></section>${platformBrowserHtml()}`;
  return settingsView() + commandsHtml();
}

function buildDefaultSlots(preset, scene = {}) {
  const title = scene.title || '핵심 장면';
  const bodyText = scene.text || '자막 및 핵심 메시지';
  const narration = scene.narration || bodyText;
  if (preset === 'premiere-3tier') {
    return [
      { id: 'slot-top-banner', name: '상단 HTML 뉴스 배너 오버레이', role: 'html-overlay', dataBinding: 'news.headline', x: 4, y: 3, w: 92, h: 12, zIndex: 8, text: title, html: `<div class="pencil-card"><span class="pencil-badge">BREAKING</span><strong>${esc(title)}</strong></div>`, style: { backgroundColor: '#173ea8', textColor: '#ffffff', fontSize: 34, opacity: 0.92, borderRadius: 10, align: 'left', badge: 'NEWS' } },
      { id: 'slot-top-image', name: '상단 AI 이미지 & 텍스트 슬롯', role: 'image-gen', dataBinding: 'scene.imagePrompt', x: 4, y: 17, w: 92, h: 31, zIndex: 2, text: title, prompt: `${title} · 고해상도 인포그래픽 및 상황 일러스트`, style: { backgroundColor: '#242c35', textColor: '#ffffff', fontSize: 32, opacity: 0.85, borderRadius: 8, align: 'center' } },
      { id: 'slot-mid-video', name: '중단 Higgsfield 배경 영상 레이어', role: 'video-bg', dataBinding: 'scene.videoPrompt', x: 0, y: 50, w: 100, h: 50, zIndex: 1, prompt: `${bodyText} · 시네마틱 카메라 워크 배경 영상`, ...(scene.assetUrl && scene.kind === 'video' ? { assetUrl: scene.assetUrl, mediaKind: 'video' } : {}), style: { backgroundColor: '#121820', textColor: '#ffffff', fontSize: 28, opacity: 1, align: 'center' } },
      { id: 'slot-mid-subtitle', name: '중단/하단 자막 오버레이 레이어', role: 'subtitle-layer', dataBinding: 'scene.narration', x: 6, y: 76, w: 88, h: 16, zIndex: 10, text: narration, style: { backgroundColor: '#0f1419', textColor: '#ffffff', fontSize: 42, opacity: 0.82, borderRadius: 8, align: 'center', badge: 'SUBTITLE' } },
    ];
  }
  return [
    { id: 'slot-top-image', name: '상단 이미지 생성 모듈', role: 'image-gen', dataBinding: 'scene.imagePrompt', x: 4, y: 4, w: 92, h: 34, zIndex: 2, text: title, prompt: `${title} · 핵심 시각 자료 이미지 생성`, ...(scene.assetUrl && scene.kind === 'image' ? { assetUrl: scene.assetUrl, mediaKind: 'image' } : {}), style: { backgroundColor: '#1e293b', textColor: '#ffffff', fontSize: 34, opacity: 0.9, borderRadius: 8, align: 'center' } },
    { id: 'slot-top-text', name: '상단 텍스트 레이아웃 오버레이', role: 'text-overlay', dataBinding: 'scene.title', x: 8, y: 7, w: 84, h: 12, zIndex: 6, text: title, style: { backgroundColor: '#2851c8', textColor: '#ffffff', fontSize: 38, opacity: 0.88, borderRadius: 6, align: 'center', badge: 'HEADLINE' } },
    { id: 'slot-mid-video', name: '중단 배경 영상 레이어 (Higgsfield)', role: 'video-bg', dataBinding: 'scene.videoPrompt', x: 0, y: 40, w: 100, h: 60, zIndex: 1, prompt: `${bodyText} · 역동적인 배경 영상 연출`, ...(scene.assetUrl && scene.kind === 'video' ? { assetUrl: scene.assetUrl, mediaKind: 'video' } : {}), style: { backgroundColor: '#0f172a', textColor: '#ffffff', fontSize: 30, opacity: 1, align: 'center' } },
    { id: 'slot-mid-subtitle', name: '중단 영상 위 자막 레이어', role: 'subtitle-layer', dataBinding: 'scene.text', x: 6, y: 74, w: 88, h: 18, zIndex: 10, text: bodyText, html: `<div class="pencil-subtitle">${esc(bodyText)}</div>`, style: { backgroundColor: '#111827', textColor: '#ffffff', fontSize: 44, opacity: 0.84, borderRadius: 8, align: 'center', badge: 'CC' } },
  ];
}

function currentSlot() {
  const scene = currentScene();
  if (!scene?.slots?.length) return null;
  return scene.slots.find(item => item.id === selectedSlotId) || scene.slots[0];
}

function activePlatformSession() {
  const sessions = (state.platformSessions || []).filter(item => item.channelId === channelId && (!item.episodeId || item.episodeId === episode?.id) && item.platform?.toLowerCase() !== 'youtube');
  return sessions.find(item => item.id === activePlatformSessionId && item.status !== 'closed') || sessions.find(item => item.status !== 'closed') || null;
}

async function refreshPlatformSessions() {
  const [sessions, exportsList] = await Promise.allSettled([api('/api/platform-sessions'), api('/api/server-exports')]);
  if (sessions.status === 'fulfilled' && Array.isArray(sessions.value)) state.platformSessions = sessions.value;
  if (exportsList.status === 'fulfilled' && Array.isArray(exportsList.value)) state.serverExports = exportsList.value;
}

function slotBuilderHtml(scene) {
  const slots = Array.isArray(scene.slots) ? scene.slots : [];
  const active = currentSlot();
  const roleNames = { 'image-gen': '상단 이미지 생성', 'video-bg': '중단 배경 영상(Higgsfield)', 'text-overlay': '텍스트 레이아웃', 'subtitle-layer': '자막 레이어', 'html-overlay': 'Pencil HTML 오버레이' };
  const bindingNames = { 'scene.imagePrompt': '장면 이미지 생성 프롬프트', 'scene.videoPrompt': '장면 Higgsfield 영상 프롬프트', 'scene.title': '장면 제목', 'scene.text': '장면 본문 텍스트', 'scene.narration': '내레이션 자막', 'trend.keyword': '트렌드 키워드', 'news.headline': '뉴스 헤드라인', 'custom': '직접 지정 데이터' };
  return `<section class="slot-builder-box section-spacer" aria-label="레이아웃 템플릿 및 Pencil 오버레이 설정">
    <div class="row between"><span class="eyebrow">PREMIERE SCENE LAYOUT &amp; PENCIL OVERLAY</span><span class="badge">${slots.length} SLOTS</span></div>
    <p class="hint">상단 이미지·텍스트, 중단 배경영상·자막 등 모듈별 저장 데이터와 위치·크기를 설정합니다. 모니터 캔버스에서 드래그로 이동·크기 조절이 가능합니다.</p>
    <div class="row" style="flex-wrap:wrap;gap:6px;margin:8px 0">
      <button type="button" class="small" data-action="apply-layout-preset" data-preset="top-image-mid-video">상단 이미지 + 중단 영상·자막</button>
      <button type="button" class="small" data-action="apply-layout-preset" data-preset="premiere-3tier">프리미어 3단 + HTML 배너</button>
      <button type="button" class="small quiet" data-action="apply-layout-preset" data-preset="top-image-mid-video" data-scope="all">전체 씬 일괄 적용</button>
      ${slots.length ? '<button type="button" class="small quiet" data-action="apply-layout-preset" data-preset="clear">단일 레이아웃 초기화</button>' : ''}
    </div>
    <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">
      <button type="button" class="small quiet" data-action="add-slot" data-role="image-gen">＋ 이미지 모듈</button>
      <button type="button" class="small quiet" data-action="add-slot" data-role="text-overlay">＋ 텍스트 모듈</button>
      <button type="button" class="small quiet" data-action="add-slot" data-role="video-bg">＋ 배경영상 레이어</button>
      <button type="button" class="small quiet" data-action="add-slot" data-role="subtitle-layer">＋ 자막 레이어</button>
      <button type="button" class="small quiet" data-action="add-slot" data-role="html-overlay">＋ Pencil HTML 오버레이</button>
    </div>
    ${slots.length ? `<div class="slot-pill-list" role="tablist" aria-label="장면 레이아웃 슬롯 목록">${slots.map(slot => `<button type="button" class="small ${active?.id === slot.id ? 'primary' : 'quiet'}" data-action="select-slot" data-slot-id="${esc(slot.id)}">${esc(slot.name)} · Z${slot.zIndex}</button>`).join('')}</div>` : '<p class="hint">위 템플릿 버튼을 눌러 상단 이미지·중단 배경영상·자막 슬롯을 구성하세요.</p>'}
    ${active ? `<div class="slot-inspector-card">
      <div class="row between"><strong>${esc(active.name)}</strong><button type="button" class="small quiet danger" data-action="delete-slot" data-slot-id="${esc(active.id)}">슬롯 삭제</button></div>
      <label>모듈 이름<input data-slot-field="name" maxlength="120" value="${esc(active.name)}"></label>
      <div class="two-cols">
        <label>모듈 용도 (Role)<select data-slot-field="role">${Object.entries(roleNames).map(([k, v]) => `<option value="${k}" ${active.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>저장 정보 바인딩<select data-slot-field="dataBinding">${Object.entries(bindingNames).map(([k, v]) => `<option value="${k}" ${active.dataBinding === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <div class="four-cols">
        <label>X (%)<input type="number" data-slot-field="x" min="0" max="95" step="1" value="${active.x}"></label>
        <label>Y (%)<input type="number" data-slot-field="y" min="0" max="95" step="1" value="${active.y}"></label>
        <label>폭 W (%)<input type="number" data-slot-field="w" min="5" max="100" step="1" value="${active.w}"></label>
        <label>높이 H (%)<input type="number" data-slot-field="h" min="5" max="100" step="1" value="${active.h}"></label>
      </div>
      <div class="two-cols">
        <label>레이어 순서 (Z-Index)<input type="number" data-slot-field="zIndex" min="0" max="100" step="1" value="${active.zIndex}"></label>
        <label>배지 태그<input data-slot-style="badge" maxlength="40" value="${esc(active.style?.badge || '')}" placeholder="예: NEWS, CC, AI"></label>
      </div>
      <label>슬롯 표시 텍스트 / 자막<textarea data-slot-field="text" rows="2" maxlength="2000" placeholder="이 레이아웃 모듈에 표시할 텍스트 또는 자막">${esc(active.text || '')}</textarea></label>
      ${active.role === 'html-overlay' || active.html ? `<label>Pencil HTML 오버레이 마크업<textarea data-slot-field="html" rows="2" maxlength="4000" placeholder="<div class='pencil-card'>...</div>">${esc(active.html || '')}</textarea></label>` : ''}
      ${active.role === 'image-gen' || active.role === 'video-bg' ? `<label>연출·생성 프롬프트 (Higgsfield 연동)<textarea data-slot-field="prompt" rows="2" maxlength="4000" placeholder="시나리오 기반 이미지·영상 연출 프롬프트">${esc(active.prompt || '')}</textarea></label>` : ''}
      <div class="two-cols">
        <label>배경색<input type="color" class="color-input" data-slot-style="backgroundColor" value="${safeColor(active.style?.backgroundColor || '#1e293b')}"></label>
        <label>글자색<input type="color" class="color-input" data-slot-style="textColor" value="${safeTextColor(active.style?.textColor || '#ffffff')}"></label>
      </div>
      <div class="two-cols">
        <label>글자 크기 (px)<input type="number" data-slot-style="fontSize" min="10" max="140" step="1" value="${active.style?.fontSize || 36}"></label>
        <label>불투명도<input type="number" data-slot-style="opacity" min="0" max="1" step="0.05" value="${active.style?.opacity ?? 0.85}"></label>
      </div>
      <div class="two-cols">
        <label>텍스트 정렬<select data-slot-style="align">${['left','center','right'].map(value => `<option value="${value}" ${safeAlign(active.style?.align) === value ? 'selected' : ''}>${value === 'left' ? '왼쪽' : value === 'right' ? '오른쪽' : '가운데'}</option>`).join('')}</select></label>
        <label>모서리 반경 (px)<input type="number" data-slot-style="borderRadius" min="0" max="80" step="1" value="${Math.max(0, Math.min(80, Number(active.style?.borderRadius ?? 8)))}"></label>
      </div>
      <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:8px">
        <button type="button" class="small" data-action="upload-slot-media" data-slot-id="${esc(active.id)}">↑ 슬롯 미디어 첨부</button>
        ${active.assetUrl ? `<button type="button" class="small quiet" data-action="remove-slot-media" data-slot-id="${esc(active.id)}">슬롯 미디어 제거</button>` : ''}
        ${active.role === 'image-gen' || active.role === 'video-bg' ? `<button type="button" class="small primary" data-action="open-slot-generation" data-slot-id="${esc(active.id)}">✦ 이 슬롯으로 Higgsfield 생성</button>` : ''}
      </div>
    </div>` : ''}
  </section>`;
}

function platformBrowserHtml() {
  if (activeChannel()?.platform?.toLowerCase() === 'youtube') return `<section class="panel section-spacer" id="platform-browser-panel" aria-label="YouTube 수동 확인"><div class="panel-header"><h3>YouTube Studio에서 직접 확인</h3></div><div class="panel-body"><p class="hint">공개 게시 승인은 아래 배포 도구에서 진행합니다. Studio는 별도 탭에서 직접 확인할 수 있습니다.</p><a href="https://studio.youtube.com" target="_blank" rel="noopener noreferrer">YouTube Studio 열기 ↗</a></div></section>`;
  const session = activePlatformSession();
  const completedJobs = state.jobs.filter(j => j.status === 'completed' && j.outputUrl);
  const exportsList = (state.serverExports && state.serverExports.length)
    ? state.serverExports
    : completedJobs.map(j => ({ filename: j.outputUrl.split('/').pop(), exportUrl: j.outputUrl, episodeId: j.episodeId, episodeTitle: state.episodes.find(e => e.id === j.episodeId)?.title || j.episodeId, sha256: j.sha256 }));
  const available = session?.browser?.available === true;
  const statusLabel = !available ? '브라우저 사용 불가' : session.attachmentStatus === 'attached' ? '서버 MP4 연결됨' : session.publicationStatus === 'unknown' ? '게시 상태 확인 필요' : '브라우저 세션 활성';
  const screenshotUrl = session?.screenshotUrl ? safeUrl(session.screenshotUrl) : '';
  const sessionOptions = (state.platformSessions || []).map(item => `<option value="${esc(item.id)}" ${item.id === session?.id ? 'selected' : ''}>${esc(item.platform?.toUpperCase() || '플랫폼')} · ${esc(item.channelName || item.channelId || item.id)}</option>`).join('');
  return `<section class="panel section-spacer" id="platform-browser-panel" aria-label="플랫폼 서버 브라우저 및 서버 저장소 첨부">
    <div class="panel-header">
      <div><span class="eyebrow">REAL SERVER BROWSER</span><h3>플랫폼 스튜디오 브라우저 · 서버 MP4 첨부</h3></div>
      <div class="row">
        <button type="button" class="small quiet" data-action="refresh-server-exports">서버 MP4 목록 갱신</button>
        <button type="button" class="small primary" data-action="open-platform-session">서버 브라우저 열기</button>
      </div>
    </div>
    <div class="panel-body">
      <p class="hint">Chromium 세션의 실제 화면을 서버에서 캡처합니다. 서버 저장소 MP4는 검증된 파일 입력으로만 연결하며, 게시 상태는 플랫폼 화면에서 직접 확인합니다.</p>
      <div class="three-cols" style="margin-top:10px">
        <label>지정 채널<select id="platform-session-channel">${state.channels.filter(ch => ch.platform?.toLowerCase() !== 'youtube').map(ch => `<option value="${esc(ch.id)}" ${(session?.channelId || channelId) === ch.id ? 'selected' : ''}>${esc(ch.name)} (${esc(ch.platform)})</option>`).join('')}</select></label>
        <label>플랫폼 스튜디오<select id="platform-session-platform">${['tiktok','instagram','other'].map(p => `<option value="${p}" ${(session?.platform || activeChannel()?.platform?.toLowerCase() || 'other') === p ? 'selected' : ''}>${esc(platformNames[p] || p)}</option>`).join('')}</select></label>
        <label>서버 MP4<select id="platform-session-export"><option value="">렌더링된 MP4 선택</option>${exportsList.map(item => `<option value="${esc(item.exportUrl)}" ${session?.attachedExport?.exportUrl === item.exportUrl ? 'selected' : ''}>${esc(item.episodeTitle || item.filename)} · ${esc(item.filename)}</option>`).join('')}</select></label>
      </div>
      <div class="three-cols">
        <label>제목<input id="platform-session-title" maxlength="200" value="${esc(session?.metadata?.title || episode?.title || '')}"></label>
        <label>설명<input id="platform-session-description" maxlength="2000" value="${esc(session?.metadata?.description || episode?.topic || '')}"></label>
        <label>공개 범위<select id="platform-session-visibility">${[['private','비공개'],['unlisted','일부 공개'],['public','전체 공개']].map(([k,v]) => `<option value="${k}" ${(session?.metadata?.visibility || 'private') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      ${session ? `<div class="platform-session-viewport-wrap">
        <div class="row between platform-session-bar">
          <div class="row" style="flex:1;gap:8px;min-width:240px">
            <span class="badge ${available ? '' : 'danger'}">${esc(statusLabel)}</span>
            <input id="platform-session-url" value="${esc(session.url || '')}" style="flex:1;margin:0" aria-label="플랫폼 세션 URL">
            <button type="button" class="small quiet" data-action="platform-session-interact" data-interact="navigate" ${available ? '' : 'disabled'}>이동</button>
          </div>
          <div class="row" style="gap:6px">
            <button type="button" class="small quiet" data-action="platform-session-interact" data-interact="refresh" ${available ? '' : 'disabled'}>새로고침</button>
            <button type="button" class="small quiet danger" data-action="platform-session-interact" data-interact="close">세션 닫기</button>
          </div>
        </div>
        <div class="platform-browser-controls" aria-label="브라우저 컨트롤">
          <label>CSS 선택자<input id="platform-session-selector" maxlength="300" value=""></label>
          <label>입력값<input id="platform-session-input-value" maxlength="4000" value=""></label>
          <button type="button" class="small" data-action="platform-session-interact" data-interact="input" ${available ? '' : 'disabled'}>입력</button>
          <button type="button" class="small" data-action="platform-session-interact" data-interact="click" ${available ? '' : 'disabled'}>클릭</button>
          <label>키<input id="platform-session-key" maxlength="40" value="Enter"></label>
          <button type="button" class="small" data-action="platform-session-interact" data-interact="key" ${available ? '' : 'disabled'}>키 전송</button>
          <label>가로 스크롤<input id="platform-session-scroll-x" type="number" step="100" value="0"></label>
          <label>세로 스크롤<input id="platform-session-scroll-y" type="number" step="100" value="600"></label>
          <button type="button" class="small" data-action="platform-session-interact" data-interact="scroll" ${available ? '' : 'disabled'}>스크롤</button>
        </div>
        <div class="row platform-session-actions">
          <button type="button" class="small primary" data-action="platform-session-interact" data-interact="attach-export" ${available ? '' : 'disabled'}>선택한 MP4를 파일 입력에 첨부</button>
          <button type="button" class="small" data-action="platform-session-interact" data-interact="update-metadata" ${available ? '' : 'disabled'}>메타데이터 입력</button>
          <span class="hint">첨부 후 게시 버튼은 실제 플랫폼 화면에서 확인하세요.</span>
        </div>
        <div class="platform-session-screen">
          ${screenshotUrl && available ? `<img src="${screenshotUrl}" alt="${esc(session.platform || '플랫폼')} 실제 서버 브라우저 화면" class="platform-viewport-img">` : `<p class="platform-session-unavailable" role="status">${esc(available ? '서버 브라우저 화면을 아직 캡처하지 못했습니다.' : '브라우저 세션을 사용할 수 없습니다. 서버에서 Chromium과 인증 상태를 확인하세요.')}</p>`}
        </div>
      </div>` : '<div class="empty" style="padding:18px">서버 브라우저 열기를 누르면 인증된 플랫폼 화면이 이곳에 표시됩니다.</div>'}
      ${state.platformSessions?.length > 1 ? `<label class="platform-session-picker">열린 브라우저 세션<select id="platform-session-picker"><option value="">선택하세요</option>${sessionOptions}</select></label>` : ''}
    </div>
  </section>`;
}

function studioView() {
  if (!episode) return '';
  let html = '';
  const scene = currentScene();
  html += `<div class="editor-grid"><div><div class="monitor-deck"><aside class="panel project-bin" aria-label="프로젝트 장면 목록"><div class="panel-header"><h3>프로젝트</h3><span class="badge">${episode.scenes.length}</span></div><div class="source-heading"><span class="eyebrow">PROJECT BIN</span><strong>${esc(episode.title)}</strong></div><div class="project-bin-list" id="project-bin-list">${sceneBinItems()}</div><p class="source-note">장면 선택은 미리보기와 편집 패널에 함께 반영됩니다.</p></aside><section class="panel program-monitor"><div class="panel-header"><div class="row"><span class="eyebrow">PROGRAM MONITOR</span><span class="badge">${esc(episode.format)}</span></div><span id="save-status" class="${dirty ? 'unsaved' : 'hint'}">${dirty ? '저장되지 않은 변경' : `버전 ${episode.version} · 저장됨`}</span></div><div class="preview-stage"><span class="stage-tag">LIVE CANVAS / ${esc(episode.category?.toUpperCase() || 'STUDIO')}</span><div id="preview" class="preview" data-format="${esc(episode.format)}" aria-label="현재 장면 미리보기"></div></div><div class="transport"><span class="time" id="play-time">${time(episode.scenes.slice(0,sceneIndex).reduce((sum,s) => sum + s.duration,0))} / ${time(duration())}</span><div class="row"><button class="icon-btn quiet" data-action="prev" aria-label="이전 장면">‹</button><button class="icon-btn primary" data-action="play" aria-label="${playing ? '미리보기 정지' : '미리보기 재생'}">${playing ? 'Ⅱ' : '▶'}</button><button class="icon-btn quiet" data-action="next" aria-label="다음 장면">›</button></div><span class="hint">${sceneIndex + 1} / ${episode.scenes.length} 장면</span></div></section></div>
    <section class="panel timeline"><div class="panel-header"><div><span class="eyebrow">SEQUENCE</span><h3>장면 타임라인</h3></div><span class="hint" id="total-duration">총 ${duration()}초</span></div><div class="timeline-body"><div class="ruler"><span>00:00</span><span>V1 · 장면 순서 / A · 첨부 오디오</span><span>${time(duration())}</span></div><div class="scenes" id="scenes">${sceneCards()}</div><div class="row between timeline-actions"><button class="small quiet" data-action="add-scene">＋ 장면 추가</button><div class="row"><button class="small quiet" data-action="save-template">템플릿으로 저장</button><button class="small quiet" data-action="view" data-view="templates">템플릿 불러오기 ↗</button></div></div></div></section>
    <section class="panel section-spacer"><div class="panel-header"><h3>내보내기 작업</h3><span class="hint">FFmpeg · MP4</span></div><div id="jobs">${jobsHtml()}</div></section>
    </div>
    <div class="right-column"><section class="panel inspector"><div class="panel-header"><h3>장면 편집</h3><span class="badge">SCENE ${String(sceneIndex + 1).padStart(2,'0')}</span></div><div class="panel-body">${scene ? inspectorHtml(scene) : '<p>장면을 추가해 주세요.</p>'}</div></section>${narrationHtml()}${chatHtml()}</div></div><p class="footnote">변경 사항은 버전별로 기록됩니다. 영상 업로드 전 채널 연결과 콘텐츠 권리를 확인하세요.</p>`;
  return html;
}

function inspectorBaseHtml(scene) {
  return `<details><summary class="hint" style="cursor:pointer;margin-bottom:13px">에피소드 설정 · ${esc(episode.title)}</summary><label>에피소드 제목<input data-episode="title" value="${esc(episode.title)}" maxlength="200"></label><label>소재 / 주제<textarea data-episode="topic">${esc(episode.topic)}</textarea></label><div class="two-cols"><label>화면 비율<select data-episode="format">${['9:16','16:9','1:1'].map(format => `<option ${episode.format === format ? 'selected' : ''}>${format}</option>`).join('')}</select></label><label>제작 상태<select data-episode="status">${['draft','review','ready'].map(status => `<option value="${status}" ${episode.status === status ? 'selected' : ''}>${statusNames[status]}</option>`).join('')}</select></label></div><label>제작 메모<textarea data-episode="notes">${esc(episode.notes)}</textarea></label></details><label>장면 이름<input data-scene="title" value="${esc(scene.title)}" maxlength="120"></label><label>화면 텍스트<textarea data-scene="text" rows="3" placeholder="이 장면에 보여줄 문장을 입력하세요">${esc(scene.text)}</textarea></label><div class="two-cols"><label>길이 (초)<input type="number" data-scene="duration" min="0.5" max="120" step="0.5" value="${scene.duration}"></label><label>배경 색상<input type="color" class="color-input" data-scene="background" value="${safeColor(scene.background)}"></label></div><label>텍스트·장면 레이아웃<select data-scene="layout"><option value="center" ${scene.layout === 'center' ? 'selected' : ''}>중앙 정렬</option><option value="lower-third" ${scene.layout === 'lower-third' ? 'selected' : ''}>하단 자막</option><option value="split" ${scene.layout === 'split' ? 'selected' : ''}>상하 분할</option><option value="top-image-mid-video" ${scene.layout === 'top-image-mid-video' ? 'selected' : ''}>상단 이미지·텍스트 + 중단 배경영상·자막</option><option value="premiere-3tier" ${scene.layout === 'premiere-3tier' ? 'selected' : ''}>프리미어 3단 (뉴스 배너 + 이미지 + 영상·자막)</option><option value="custom" ${scene.layout === 'custom' ? 'selected' : ''}>사용자 지정 다중 슬롯</option></select></label>${slotBuilderHtml(scene)}<label>내레이션 원고<textarea data-scene="narration" rows="2" placeholder="장면별 음성 제작용 원고">${esc(scene.narration)}</textarea></label><p class="hint">원고를 입력한 다음 아래 내레이션 패널에서 실제 음성을 생성하세요. 생성하거나 첨부한 오디오가 MP4에 반영됩니다.</p><div class="row"><button class="small" data-action="upload">↑ 이미지 / 영상</button>${scene.assetUrl ? '<button class="small quiet" data-action="remove-media">소스 제거</button>' : '<span class="hint">로컬 파일</span>'}</div>${audioInspectorHtml(scene)}<div class="row between" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)"><div class="row"><button class="icon-btn quiet" data-action="move-left" aria-label="장면 앞으로 이동">←</button><button class="icon-btn quiet" data-action="move-right" aria-label="장면 뒤로 이동">→</button><button class="small quiet" data-action="duplicate-scene">복제</button></div><button class="small quiet danger" data-action="delete-scene">삭제</button></div>`;
}

function sceneWithCaptionsHtml(scene) {
  const cues = Array.isArray(scene.captions) ? scene.captions : [];
  return `${inspectorBaseHtml(scene)}<section class="section-spacer" aria-label="장면별 시간 자막"><h4>장면별 시간 자막</h4><p class="hint">시간은 이 장면의 시작을 기준으로 합니다. ${scene.captions === undefined ? '자막을 추가하지 않으면 기존 장면 텍스트가 유지됩니다.' : '빈 자막 목록은 시간 자막을 표시하지 않습니다.'}</p>${cues.map((cue,index)=>`<fieldset class="caption-cue" aria-label="자막 ${index+1}"><legend>자막 ${index+1}</legend><div class="two-cols"><label for="caption-start-${index}">시작 (초)</label><input id="caption-start-${index}" aria-label="시작 (초)" type="number" step="any" min="0" data-caption="start" data-caption-index="${index}" value="${esc(cue.start)}"><label for="caption-end-${index}">종료 (초)</label><input id="caption-end-${index}" aria-label="종료 (초)" type="number" step="any" min="0" data-caption="end" data-caption-index="${index}" value="${esc(cue.end)}"></div><label for="caption-text-${index}">자막 내용</label><textarea id="caption-text-${index}" aria-label="자막 내용" data-caption="text" data-caption-index="${index}" maxlength="2000" rows="2">${esc(cue.text)}</textarea><button type="button" class="small quiet danger" data-action="delete-caption" data-index="${index}">자막 삭제</button></fieldset>`).join('')}<button type="button" class="small" data-action="add-caption" ${cues.length>=200?'disabled':''}>자막 추가</button></section>`;
}

function musicOptionsHtml(selected = '') {
  const uploads=musicUploads.filter(item=>typeof item.url==='string' && /^\/api\/uploads\/[a-zA-Z0-9_-]+\.(mp3|wav|ogg)$/i.test(item.url) && typeof item.type==='string' && item.type.startsWith('audio/'));
  return `<option value="">음악 없음</option>${selected && !uploads.some(item=>item.url===selected) ? `<option value="${esc(selected)}" selected>저장된 음악 · 목록에서 확인 불가</option>` : ''}${uploads.map(item=>`<option value="${esc(item.url)}" ${item.url===selected?'selected':''}>${esc(item.name || item.filename || item.id)}</option>`).join('')}`;
}
async function loadMusicUploads(dialog) {
  const owner=episode?.id;
  try {
    const result=await api('/api/uploads');
    if (!dialog.isConnected || !dialog.open || episode?.id!==owner || !Array.isArray(result)) return;
    musicUploads=result;
    const select=dialog.querySelector('[data-music="assetUrl"]');
    if (select) select.innerHTML=musicOptionsHtml(episode.music?.assetUrl || '');
  } catch (error) { if (dialog.isConnected && dialog.open && episode?.id===owner) toast(`음악 파일 목록을 불러오지 못했습니다: ${error.message}`,true); }
}
function mountMusicGeneration(dialog) {
  const owner = episode?.id, section = dialog.querySelector('[aria-label="배경 음악"]');
  if (!owner || !section) return;
  let model = musicGenerationStates.get(owner);
  if (!model) {
    model = {open:false,transport:'api',models:[],model:'',prompt:'',params:{},schema:null,quote:null,job:null,selected:'',rights:false,error:'',loading:false,submitting:false};
    musicGenerationStates.set(owner,model);
  }
  const host = document.createElement('div');
  section.append(host);
  const live = () => host.isConnected && dialog.open && episode?.id === owner;
  const storageKey = `frameforge.musicSubmission.${owner}`;
  const savedSubmission = () => { try { return JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { return null; } };
  const saveSubmission = value => { if (value) { sessionStorage.setItem(storageKey,JSON.stringify(value)); if (!savedSubmission()) throw new Error('제출 복구 정보를 저장할 수 없어 생성을 시작하지 않았습니다.'); } else { try { sessionStorage.removeItem(storageKey); } catch { /* A stale marker remains fail-closed. */ } } };
  const currentInput = () => ({requestId:model.requestId,expectedVersion:baseVersion,target:'music',transport:model.transport,model:model.model,prompt:model.prompt,params:clone(model.params)});
  const quoteValid = () => Boolean(model.quote && model.quoteKey === JSON.stringify(currentInput()) && Date.parse(model.quote.expiresAt)>Date.now());
  const blocked = () => Boolean(model.uncertain || model.verifying || savedSubmission() || model.job?.status === 'submission_unknown');
  const validJobStatus = status => ['queued','submitting','pending','in_progress','downloading','completed','failed','submission_unknown','manual_recovery','polling_failed','import_failed','nsfw','canceled'].includes(status);
  const fieldHtml = field => {
    const name=esc(field.name), value=model.params[field.name] ?? field.default ?? '', type=(field.type || 'string').split('|').find(item=>item!=='null');
    const required=field.required?'required':'';
    if (Array.isArray(field.enum)) return `<label>${name}<select data-music-param="${name}" data-type="${esc(type)}" ${required}><option value="">선택</option>${field.enum.map(item=>`<option value="${esc(item)}" ${String(item)===String(value)?'selected':''}>${esc(item)}</option>`).join('')}</select></label>`;
    if (type==='boolean') return `<label><input type="checkbox" data-music-param="${name}" data-type="boolean" ${value===true?'checked':''}>${name}</label>`;
    return `<label>${name}<input data-music-param="${name}" data-type="${esc(type)}" type="${['number','integer'].includes(type)?'number':'text'}" value="${esc(value)}" ${Number.isFinite(field.minimum)?`min="${field.minimum}"`:''} ${Number.isFinite(field.maximum)?`max="${field.maximum}"`:''} step="${type==='integer'?'1':'any'}" ${required}></label>`;
  };
  const renderPanel = () => {
    if (!live()) return;
    const job=model.job, outputs=Array.isArray(job?.outputs)?job.outputs:[];
    const unknown=blocked();
    const jobHtml=job ? `<div role="status" aria-live="polite">음악 작업 ${esc(job.id)} · ${esc(job.status)}${job.error?` · ${esc(job.error)}`:''}${job.status==='submission_unknown'?' · 제출 여부를 확인할 수 없습니다. 제공자 기록을 확인하기 전 다시 생성하지 마세요.':''}</div>${outputs.length ? `<fieldset><legend>생성 결과 선택</legend>${outputs.map((output,index)=>`<label><input type="radio" name="music-generation-output" aria-label="생성 결과 ${index+1}" value="${esc(output.uploadId)}" ${model.selected===output.uploadId?'checked':''}>생성 결과 ${index+1}</label>${/^\/api\/uploads\/[a-zA-Z0-9_-]+\.(mp3|wav|ogg)$/i.test(output.url || '')?`<audio controls preload="none" src="${esc(output.url)}" aria-label="생성 결과 ${index+1} 듣기"></audio>`:''}`).join('')}</fieldset><label><input type="checkbox" data-music-rights ${model.rights?'checked':''}>생성 음악 이용 권리 확인</label><p class="hint">권리 확인은 사용자의 확인 기록이며 공개 허가가 아닙니다. 음악 포함 프로젝트의 게시는 차단됩니다.</p><button type="button" data-music-action="apply" ${!model.selected || !model.rights || model.loading?'disabled':''}>선택한 음악 적용</button>`:''}${job.providerRequestId && ['manual_recovery','polling_failed','import_failed'].includes(job.status)?'<button type="button" data-music-action="recover">기존 작업 복구</button>':''}` : '';
    const form=model.open ? `<div><label>음악 생성 연결<select aria-label="음악 생성 연결" data-music-transport><option value="api" ${model.transport==='api'?'selected':''}>API</option><option value="cli" ${model.transport==='cli'?'selected':''}>CLI</option></select></label><label>음악 생성 모델<select aria-label="음악 생성 모델" data-music-model><option value="">모델 선택</option>${model.models.map(item=>`<option value="${esc(item.id)}" ${item.id===model.model?'selected':''}>${esc(item.name || item.id)}</option>`).join('')}</select></label><label>음악 생성 프롬프트<textarea aria-label="음악 생성 프롬프트" data-music-prompt maxlength="10000">${esc(model.prompt)}</textarea></label>${model.schema ? (model.schema.parameters || []).filter(field=>field.name!=='prompt' && !/array|object/.test(field.type || '')).map(fieldHtml).join('') : '<p class="hint">음악 모델의 실제 설정을 불러오세요.</p>'}<button type="button" data-music-action="quote" ${model.loading || unknown?'disabled':''}>음악 생성 견적</button>${quoteValid()?`<div role="status">견적: ${esc(model.quote.credits)} 크레딧 · 유효 기간 ${esc(model.quote.expiresAt)}<p>제공자 견적이며 실제 청구액은 다를 수 있습니다. 승인하면 비용이 발생할 수 있습니다.</p><pre>${esc(JSON.stringify(model.quote.input,null,2))}</pre></div><button type="button" data-music-action="submit" ${model.loading || unknown?'disabled':''}>견적 승인 및 생성</button>`:''}${model.submitting?'<button type="button" disabled>제출 중 · 취소할 수 없음</button>':'<button type="button" data-music-action="cancel">생성 취소</button>'}</div>` : '<button type="button" data-music-action="open">음악 생성 열기</button>';
    host.innerHTML=`<section class="section-spacer" aria-label="음악 생성"><h4>Higgsfield 음악 생성</h4><p class="hint">견적과 승인 없이 생성하지 않습니다. 실제 제공자 가용성과 가격은 요청 시 확인합니다.</p>${unknown?'<p role="alert">이전 제출 결과를 확인할 수 없습니다. 중복 과금을 피하려면 제공자 기록을 먼저 확인하세요.</p>':''}${model.error?`<p role="alert">${esc(model.error)}</p>`:''}${form}${jobHtml}</section>`;
    updateButtons();
  };
  model.renderCurrent=renderPanel;
  const updateButtons = () => {
    const submit=host.querySelector('[data-music-action="submit"]'); if (submit) submit.disabled=!quoteValid() || model.loading || blocked();
    const apply=host.querySelector('[data-music-action="apply"]'); if (apply) { const reason=projectEditReason(owner); apply.disabled=!model.selected || !model.rights || model.loading || Boolean(reason); apply.title=reason; }
  };
  const acceptApplication = (result, revision, version, jobId, uploadId) => {
    if (result.job?.id!==jobId || result.job?.episodeId!==owner || result.job?.target!=='music' || result.job?.applied!==true || result.job?.appliedOutputUploadId!==uploadId || result.job?.appliedVersion!==version+1 || result.episode?.id!==owner || !Number.isSafeInteger(result.episode.version) || result.episode.version<result.job.appliedVersion) throw new Error('음악 적용 결과를 확인하지 못했습니다. 작업 상태와 버전 기록을 확인하세요.');
    model.job=result.job;
    const cached=state.episodes.find(item=>item.id===owner);
    const latest=cached && cached.version>result.episode.version ? cached : result.episode;
    cacheEpisode(latest);
    if (episode?.id===owner) {
      if (editRevision!==revision || dirty || baseVersion!==version) { toast('서버에 적용됐지만 이후의 로컬 초안은 보존했습니다. 버전 기록을 확인하세요.',true); return; }
      episode=clone(latest); baseVersion=episode.version; stashActiveDraft(); render(); toast('선택한 음악을 적용했습니다. 공개 권한은 별도로 확인해야 합니다.');
    } else {
      const draft=studioDrafts.get(owner);
      if (draft && !draft.dirty && draft.editRevision===revision && draft.baseVersion===version) { draft.episode=clone(latest); draft.baseVersion=latest.version; }
    }
  };
  const loadSchema = async () => {
    const requested=model.model, transport=model.transport;
    model.schema=null; model.params={}; model.quote=null;
    if (!requested) { renderPanel(); return; }
    try {
      const schema=await api(`/api/generation/models?transport=${encodeURIComponent(transport)}&model=${encodeURIComponent(requested)}`);
      if (!live() || model.model!==requested || model.transport!==transport) return;
      if (schema.id!==requested || schema.type!=='audio' || schema.transport && schema.transport!==transport) throw new Error('선택한 모델은 확인된 음악 모델이 아닙니다.');
      model.schema=schema;
      for (const field of schema.parameters || []) if (field.name!=='prompt' && field.default!==undefined && field.default!==null) model.params[field.name]=field.default;
      model.error='';
    } catch (error) { if (live() && model.model===requested && model.transport===transport) model.error=`모델 설정을 확인하지 못했습니다: ${error.message}`; }
    renderPanel();
  };
  const loadModels = async () => {
    const transport=model.transport;
    try {
      const result=await api(`/api/generation/models?transport=${encodeURIComponent(transport)}`);
      if (!live() || model.transport!==transport) return;
      model.models=(Array.isArray(result)?result:result.models || []).filter(item=>item.type==='audio');
      if (!model.models.length) model.error='사용 가능한 음악 모델을 확인하지 못했습니다.';
    } catch (error) { if (live() && model.transport===transport) model.error=`음악 모델을 불러오지 못했습니다: ${error.message}`; }
    renderPanel();
  };
  const pollJob = async () => {
    if (!live()) return;
    const epoch=model.generationEpoch || 0;
    const saved=savedSubmission(), jobs=(state.generationJobs || []).filter(job=>job.episodeId===owner && job.target==='music');
    const previousJobId=model.job?.id;
    if (saved) model.job=jobs.find(job=>job.requestId===saved.requestId) || null;
    else if (!model.job) model.job=jobs.at(-1) || null;
    if (model.job?.id && model.authoritativeJobId!==model.job.id) model.verifying=true;
    if (previousJobId!==model.job?.id || model.verifying) renderPanel();
    if (model.job?.id) {
      const jobId=model.job.id;
      try {
        const job=await api(`/api/generations/${encodeURIComponent(jobId)}`);
        if (!live() || (model.generationEpoch || 0)!==epoch || model.job?.id!==jobId) return;
        if (job.id!==jobId || job.episodeId!==owner || job.target!=='music' || !validJobStatus(job.status)) throw new Error('작업 식별자 또는 상태를 확인하지 못했습니다.');
        if (saved && (job.requestId!==saved.requestId || job.quoteId!==saved.quoteId || job.quoteFingerprint!==saved.quoteFingerprint || job.acceptedCredits!==saved.acceptedCredits || job.episodeVersion!==saved.expectedVersion || job.model!==saved.model || job.transport!==saved.transport)) throw new Error('승인한 견적과 작업이 일치하지 않습니다. 제공자 기록을 확인하세요.');
        const wasVerifying=model.verifying; model.authoritativeJobId=job.id; model.verifying=false;
        const changed=JSON.stringify(job)!==JSON.stringify(model.job); model.job=job;
        state.generationJobs=[...(state.generationJobs || []).filter(item=>item.id!==job.id),job];
        if (saved && savedSubmission()?.requestId===saved.requestId) { saveSubmission(null); model.uncertain=false; model.error=''; }
        if (changed || saved || wasVerifying) renderPanel();
      } catch (error) { if (live() && (model.generationEpoch || 0)===epoch && model.job?.id===jobId) { model.error=`작업 상태를 확인하지 못했습니다: ${error.message}`; renderPanel(); } }
    } else if (saved) {
      try { const latest=await api('/api/state'); if (!live() || (model.generationEpoch || 0)!==epoch || savedSubmission()?.requestId!==saved.requestId) return; state.generationJobs=latest.generationJobs || []; const found=state.generationJobs.find(job=>job.episodeId===owner && job.target==='music' && job.requestId===saved.requestId); if (found) {model.job=found;renderPanel();setTimeout(pollJob,0);return;} }
      catch (error) { if (live() && (model.generationEpoch || 0)===epoch && savedSubmission()?.requestId===saved.requestId) {model.error=`제출 상태를 확인하지 못했습니다: ${error.message}`;renderPanel();} }
    }
    if (live() && (savedSubmission() || model.verifying || model.job && ['queued','running','pending','submitting','polling','in_progress','downloading'].includes(model.job.status))) setTimeout(pollJob,1000);
  };
  host.addEventListener('input', event => {
    const target=event.target;
    if (target.matches('[data-music-prompt]')) { model.prompt=target.value; model.quote=null; updateButtons(); }
    else if (target.dataset.musicParam) {
      const key=target.dataset.musicParam, type=target.dataset.type;
      if (type==='boolean') model.params[key]=target.checked;
      else if (target.value==='') delete model.params[key];
      else model.params[key]=['number','integer'].includes(type)?Number(target.value):target.value;
      model.quote=null; updateButtons();
    } else if (target.name==='music-generation-output') { model.selected=target.value; model.rights=false; const check=host.querySelector('[data-music-rights]'); if (check) check.checked=false; updateButtons(); }
    else if (target.matches('[data-music-rights]')) { model.rights=target.checked; updateButtons(); }
  });
  host.addEventListener('change', event => {
    if (event.target.matches('[data-music-transport]')) { model.transport=event.target.value; model.models=[]; model.model=''; model.schema=null; model.params={}; model.quote=null; model.requestId=null; model.error=''; renderPanel(); loadModels(); }
    else if (event.target.matches('[data-music-model]')) { model.model=event.target.value; model.requestId=null; loadSchema(); }
  });
  host.addEventListener('click', async event => {
    const action=event.target.closest('[data-music-action]')?.dataset.musicAction;
    if (!action || model.loading && (action!=='cancel' || model.submitting)) return;
    const operation=model.operationEpoch=(model.operationEpoch || 0)+1;
    try {
      if (action==='open') { model.open=true; model.error=''; renderPanel(); await loadModels(); return; }
      if (action==='cancel') { model.open=false; model.loading=false; model.quote=null; model.requestId=null; renderPanel(); return; }
      if (!canMutate()) throw new Error('변경하려면 로그인하세요.');
      if (action==='quote') {
        if (blocked()) throw new Error('이전 제출 결과를 먼저 확인하세요.');
        if (!model.schema || model.schema.id!==model.model || !model.prompt.trim() || [...host.querySelectorAll('[data-music-param]')].some(input=>!input.checkValidity())) throw new Error('모델, 프롬프트와 필수 설정을 확인하세요.');
        model.requestId=id(); model.quote=null; const input=currentInput(), key=JSON.stringify(input); model.loading=true; model.error=''; renderPanel();
        const quote=await post(`/api/episodes/${encodeURIComponent(owner)}/generations/quote`,input);
        if (!live() || model.operationEpoch!==operation) return;
        if (JSON.stringify(currentInput())!==key) throw new Error('설정이 변경되어 견적을 사용할 수 없습니다.');
        if (!quote.id || !quote.fingerprint || typeof quote.credits!=='number' || !Number.isFinite(quote.credits) || quote.credits<0 || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt)<=Date.now()) throw new Error('유효한 제공자 견적을 확인하지 못했습니다.');
        model.quote=quote; model.quoteKey=key;
      } else if (action==='submit') {
        if (!quoteValid() || blocked()) throw new Error('유효한 견적과 제출 상태를 다시 확인하세요.');
        const input=currentInput(), quote=model.quote;
        saveSubmission({requestId:input.requestId,expectedVersion:input.expectedVersion,model:input.model,transport:input.transport,quoteId:quote.id,quoteFingerprint:quote.fingerprint,acceptedCredits:quote.credits}); model.generationEpoch=(model.generationEpoch || 0)+1; model.loading=true; model.submitting=true; model.uncertain=true; renderPanel();
        const job=await post(`/api/episodes/${encodeURIComponent(owner)}/generations`,{...input,quoteId:quote.id,quoteFingerprint:quote.fingerprint,acceptedCredits:quote.credits});
        if (!job || typeof job.id!=='string' || !job.id || job.requestId!==input.requestId || job.episodeId!==owner || job.target!=='music' || job.episodeVersion!==input.expectedVersion || job.model!==input.model || job.transport!==input.transport || job.quoteId!==quote.id || job.quoteFingerprint!==quote.fingerprint || job.acceptedCredits!==quote.credits || !validJobStatus(job.status)) throw new Error('제출 결과를 확인하지 못했습니다. 중복 제출 전에 작업 상태를 확인하세요.');
        model.authoritativeJobId=job.id; model.verifying=false;
        model.job=job; model.selected=''; model.rights=false; model.quote=null; model.open=false; model.uncertain=false; saveSubmission(null);
        state.generationJobs=[...(state.generationJobs || []).filter(item=>item.id!==job.id),job];
        setTimeout(pollJob,0);
      } else if (action==='recover') {
        if (!model.job?.providerRequestId) throw new Error('제공자 작업 식별자가 없어 복구할 수 없습니다.');
        model.loading=true; model.job=await post(`/api/generations/${encodeURIComponent(model.job.id)}/recover`); if (live()) setTimeout(pollJob,0);
      } else if (action==='apply') {
        if (!live()) throw new Error('프로젝트가 바뀌었습니다. 적용 대상을 다시 확인하세요.');
        requireProjectEdit(owner);
        if (!model.selected || !model.rights || !model.job?.outputs?.some(output=>output.uploadId===model.selected)) throw new Error('결과와 이용 권리를 직접 확인하세요.');
        if (dirty || savePending) throw new Error('현재 초안을 먼저 저장하세요. 저장 전 편집은 보존됩니다.');
        const revision=editRevision, version=baseVersion, jobId=model.job.id, uploadId=model.selected;
        model.loading=true; renderPanel();
        await post(`/api/uploads/${encodeURIComponent(uploadId)}/rights`,{origin:'generated',generationJobId:jobId});
        if (!live() || editRevision!==revision || dirty || baseVersion!==version) throw new Error('초안이 변경되어 적용하지 않았습니다. 현재 편집은 보존됩니다.');
        requireProjectEdit(owner);
        let result;
        try {
          result=await post(`/api/generations/${encodeURIComponent(jobId)}/apply`,{expectedVersion:version,outputUploadId:uploadId});
          acceptApplication(result,revision,version,jobId,uploadId);
        } catch (error) {
          if (error.status===409) throw error;
          try {
            const [job,latest]=await Promise.all([api(`/api/generations/${encodeURIComponent(jobId)}`),api('/api/state')]);
            const updated=latest.episodes?.find(item=>item.id===owner);
            acceptApplication({job,episode:updated},revision,version,jobId,uploadId);
          } catch { throw error; }
        }
        return;
      }
    } catch (error) {
      if (action==='submit' && model.uncertain && error.status===409 && !/requestId/i.test(error.message)) { saveSubmission(null); model.uncertain=false; model.quote=null; }
      if (live()) { model.error=error.status===409?'다른 작업에서 에피소드가 수정되었습니다. 현재 초안은 보존했습니다.':error.message; if (action==='submit' && model.uncertain) setTimeout(pollJob,0); }
    }
    finally { if (model.operationEpoch===operation) { model.loading=false; model.submitting=false; model.renderCurrent?.(); } }
  });
  renderPanel();
  pollJob();
}
function inspectorHtml(scene) {
  const music=episode.music || {},source=music.source || {};
  return `${sceneWithCaptionsHtml(scene)}<section class="section-spacer" aria-label="배경 음악"><h4>배경 음악</h4><p role="status">배경 음악이 포함된 프로젝트의 게시는 현재 차단됩니다. 출처 입력은 권리 확인이나 생성 사실의 증명이 아닙니다.</p><label for="music-file">음악 파일</label><select id="music-file" aria-label="음악 파일" data-music="assetUrl">${musicOptionsHtml(music.assetUrl || '')}</select><label for="music-start">음악 시작 (초)</label><input id="music-start" aria-label="음악 시작 (초)" type="number" min="0" max="1800" step="any" data-music="start" value="${esc(music.start ?? 0)}"><label for="music-trim">음악 트림 시작 (초)</label><input id="music-trim" aria-label="음악 트림 시작 (초)" type="number" min="0" max="36000" step="any" data-music="trimStart" value="${esc(music.trimStart ?? 0)}"><label for="music-volume">음악 볼륨</label><input id="music-volume" aria-label="음악 볼륨" type="number" min="0" max="2" step="any" data-music="volume" value="${esc(music.volume ?? 1)}"><label for="music-origin">음악 출처</label><select id="music-origin" aria-label="음악 출처" data-music-source="origin"><option value="">직접 선택하세요</option>${[['own','직접 소유'],['third-party','제3자'],['generated','생성 주장 · 미검증']].map(([value,label])=>`<option value="${value}" ${source.origin===value?'selected':''}>${label}</option>`).join('')}</select><label for="music-url">음악 출처 URL</label><input id="music-url" aria-label="음악 출처 URL" type="url" maxlength="2000" data-music-source="sourceUrl" value="${esc(source.sourceUrl || '')}"><label for="music-license">음악 라이선스</label><input id="music-license" aria-label="음악 라이선스" maxlength="160" data-music-source="licenseId" value="${esc(source.licenseId || '')}"><label for="music-credit">음악 출처 표기</label><textarea id="music-credit" aria-label="음악 출처 표기" maxlength="4000" rows="2" data-music-source="attribution">${esc(source.attribution || '')}</textarea><button type="button" class="small quiet" data-action="remove-music">배경 음악 제거</button></section>`;
}

function updatePreview() {
  const preview = $('#preview');
  const scene = currentScene();
  if (!preview || !scene) return;
  preview.style.backgroundColor = safeColor(scene.background);
  preview.dataset.format = episode.format;
  preview.dataset.layout = scene.layout;
  const exportWidth = episode.format === '16:9' ? 1920 : 1080;
  let media = '';
  if (scene.assetUrl) media = scene.kind === 'video' ? `<video src="${safeUrl(scene.assetUrl)}" muted playsinline ${playing ? 'autoplay' : ''} loop></video>` : `<img src="${safeUrl(scene.assetUrl)}" alt="장면에 업로드한 이미지">`;
  const slots = Array.isArray(scene.slots) ? [...scene.slots].sort((a, b) => (Number(a.zIndex) || 0) - (Number(b.zIndex) || 0)) : [];
  if (slots.length) {
    const activeId = currentSlot()?.id;
    const slotsHtml = slots.map(slot => {
      const bg = safeColor(slot.style?.backgroundColor || '#1e293b');
      const opacity = Math.max(0, Math.min(1, Number(slot.style?.opacity ?? 0.85)));
      const radius = Math.max(0, Math.min(80, Number(slot.style?.borderRadius ?? 8)));
      const fontSize = Math.max(16, Math.min(120, Math.round(Number(slot.style?.fontSize) || (slot.role === 'subtitle-layer' ? 44 : 36))));
      const textColor = safeTextColor(slot.style?.textColor || '#ffffff');
      const align = safeAlign(slot.style?.align);
      const slotMedia = slot.assetUrl
        ? (slot.mediaKind === 'video' || /\.(?:mp4|webm|mov)$/i.test(slot.assetUrl)
          ? `<video src="${safeUrl(slot.assetUrl)}" muted playsinline ${playing ? 'autoplay' : ''} loop class="slot-media"></video>`
          : `<img src="${safeUrl(slot.assetUrl)}" alt="${esc(slot.name)}" class="slot-media">`)
        : '';
      const badge = slot.style?.badge ? `<span class="slot-badge">${esc(slot.style.badge)}</span>` : `<span class="slot-role-tag">${esc(slot.role)}</span>`;
      const timedSlot = Array.isArray(scene.captions) && slots.findIndex(item => item.role === 'subtitle-layer') === slots.indexOf(slot);
      const copyText = timedSlot ? '' : slot.text || (slot.dataBinding === 'scene.title' ? scene.title : slot.dataBinding === 'scene.narration' ? (scene.narration || scene.text) : slot.dataBinding === 'scene.text' ? scene.text : slot.prompt || '');
      return `<div class="preview-slot ${activeId === slot.id ? 'selected' : ''} role-${esc(slot.role)}" data-slot-id="${esc(slot.id)}" style="left:${Number(slot.x)||0}%;top:${Number(slot.y)||0}%;width:${Number(slot.w)||50}%;height:${Number(slot.h)||25}%;z-index:${Number(slot.zIndex)||1};background:${bg};opacity:${opacity};border-radius:${radius}px;color:${textColor};text-align:${align}">
        ${slotMedia}
        <div class="slot-overlay-content">
          <div class="slot-header-meta">${badge}<small>${esc(slot.dataBinding)}</small></div>
          <div class="slot-copy" ${timedSlot ? 'data-preview-caption' : ''} style="font-size:${fontSize * 100 / exportWidth}cqw;color:${textColor};text-align:${align}">${esc(copyText)}</div>
        </div>
        <span class="slot-resize-handle" title="크기 조절">◢</span>
      </div>`;
    }).join('');
    preview.innerHTML = `${media}<div class="preview-slots-layer">${slotsHtml}</div>${Array.isArray(scene.captions) && !slots.some(slot => slot.role === 'subtitle-layer') ? '<div class="preview-copy center"><div class="scene-text" data-preview-caption></div></div>' : ''}<div class="preview-footer"><span>FRAMEFORGE · MULTI-SLOT</span><span>${String(sceneIndex + 1).padStart(2,'0')}</span></div>`;
  } else {
    preview.innerHTML = `${media}<div class="preview-copy ${['center','lower-third','split'].includes(scene.layout) ? scene.layout : 'center'}"><span class="scene-overline">${esc(scene.title || 'YOUR NEXT STORY')}</span><div class="scene-text" ${Array.isArray(scene.captions) ? 'data-preview-caption' : ''}>${Array.isArray(scene.captions) ? '' : esc(scene.text || '여기에 이야기를 담아보세요')}</div></div><div class="preview-footer"><span>FRAMEFORGE</span><span>${String(sceneIndex + 1).padStart(2,'0')}</span></div>`;
  }
  const video = $('video',preview);
  if (video && Number(scene.trimStart) > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(Number(scene.trimStart), Math.max(0,video.duration - 0.01)); }, {once:true});
  updatePreviewCaptions();
}
function sceneCards() {
  let elapsed = 0;
  return episode.scenes.map((scene,index) => {
    const start = time(elapsed);
    elapsed += Number(scene.duration) || 0;
    const slotBadge = Array.isArray(scene.slots) && scene.slots.length ? ` · ${scene.slots.length}슬롯` : '';
    return `<button class="scene-card ${index===sceneIndex?'selected':''}" data-action="scene" data-index="${index}" data-scene-id="${esc(scene.id)}" aria-pressed="${index===sceneIndex}" aria-label="장면 ${index+1}: ${esc(scene.title)} · ${start} 시작 · ${Number(scene.duration)}초"><div class="scene-clip-header"><span>V1 · ${String(index+1).padStart(2,'0')}${esc(slotBadge)}</span><time>${start}</time></div><div class="scene-thumb" style="background:${safeColor(scene.background)}">${esc(scene.text?.slice(0,45) || scene.title)}</div><div class="scene-meta"><span>${esc(scene.title?.slice(0,18))}</span><span>${Number(scene.duration)}s</span></div><span class="scene-media-state">${scene.audioUrl?'A · 첨부 오디오':'A · 오디오 없음'}</span></button>`;
  }).join('');
}
function jobsHtml() {
  const jobs = state.jobs.filter(job => job.episodeId === episode?.id).slice().reverse();
  if (!jobs.length) return '<div class="panel-body hint">영상을 내보내면 이곳에서 진행 상황과 다운로드를 확인할 수 있습니다.</div>';
  return jobs.slice(0,6).map(job => `<div class="job-item"><span class="badge ${job.status === 'completed' ? 'lime' : ''}">${esc(statusNames[job.status] || job.status)}</span><span class="muted">${date(job.createdAt)}</span>${['queued','running'].includes(job.status) ? `<progress value="${Number(job.progress) || 0}" max="100" aria-label="렌더링 진행률"></progress>` : ''}${job.outputUrl ? `<a href="${safeUrl(job.outputUrl)}" download>MP4 다운로드 ↓</a><button type="button" class="small quiet" data-action="platform-session-interact" data-interact="attach-export" data-export-url="${esc(job.outputUrl)}">플랫폼 세션에 마운트 ↗</button>` : ''}${job.error ? `<span class="danger">${esc(job.error)}</span>` : ''}</div>`).join('');
}
function chatHtml() {
  const messages = chatLogs.get(episode.id) || [];
  return `<section class="panel"><div class="panel-header"><div class="row"><span style="color:var(--lime)">✳</span><h3>제작 어시스턴트</h3></div><span class="badge">AGENT</span></div><div class="panel-body"><div class="chat-log" id="chat-log">${messages.length ? messages.map(message => `<div class="chat-message ${message.role === 'user' ? 'user' : ''}"><span class="chat-name">${esc(message.role === 'user' ? 'YOU' : message.agent)}</span>${esc(message.text)}</div>`).join('') : '<div class="chat-message"><span class="chat-name">STUDIO ASSISTANT</span>소재를 장면으로 구성해 보세요. 스튜디오 어시스턴트는 규칙 기반으로 장면을 만들고, 외부 에이전트는 실제 연결 상태에 따라 실행됩니다.</div>'}</div><form id="chat-form" class="chat-form"><label style="margin:0">실행 에이전트<select name="agent"><option value="studio">Studio · 규칙 기반</option value="codex">Codex · 외부 에이전트</option><option value="jeo">JEO · 외부 에이전트</option><option value="jeopi">JEOPI · 외부 에이전트</option><option value="hermes">Hermes · 외부 에이전트</option></select></label><textarea name="message" aria-label="에이전트에게 요청" placeholder="이 소재로 3장면 스토리보드를 만들어줘" required maxlength="4000"></textarea><button class="primary" type="submit">작업 실행 ↗</button></form></div></section>`;
}

function trendsView() {
  const collector = trendCollectorStatus();
  const settings = collector.settings || {};
  const lastRun = collector.lastRun;
  const records = trendItems().slice().reverse();
  const popular = (state.popularTrendKeywords || []).slice(0, 12);
  const runs = (state.trendCollectionRuns || []).slice(0, 5);
  const enabled = settings.enabled === true;
  const intervalHours = Math.max(1, Math.round(Number(settings.intervalMs || 24 * 60 * 60 * 1000) / (60 * 60 * 1000)));
  const activeRunId = typeof collector.activeRunId === 'string' ? collector.activeRunId : '';
  const status = activeRunId ? `수집 중 · ${activeRunId.slice(0, 8)}` : enabled ? '자동 수집 켜짐' : '자동 수집 꺼짐';
  const statusTone = activeRunId || enabled ? 'lime' : '';
  const sourceNote = collector.lastError ? `최근 수집 실패: ${collector.lastError}` : 'Google Trends RSS와 수동 기록을 함께 관리합니다. 자동 수집 실패는 숨기지 않고 최근 상태에 표시합니다.';
  return heading('트렌드 수집', '검색 소재를 수집하고 출처와 보존 상태를 확인합니다.', '<button class="primary" data-action="refresh-trends">지금 수집</button>') +
    `<div class="source-note">${esc(sourceNote)}</div><div class="research-grid"><section class="panel"><div class="panel-header"><div><span class="eyebrow">COLLECTOR STATUS</span><h2>수집 상태</h2></div><span class="badge ${statusTone}">${esc(status)}</span></div><div class="panel-body"><div class="two-cols"><div><p class="hint">마지막 수집</p><strong>${lastRun?.completedAt ? date(lastRun.completedAt) : '아직 없음'}</strong></div><div><p class="hint">다음 수집</p><strong>${collector.nextDueAt ? date(collector.nextDueAt) : enabled ? '예약 대기' : '자동 수집 꺼짐'}</strong></div><div><p class="hint">수집 주기</p><strong>${esc(trendInterval(settings.intervalMs))}</strong></div><div><p class="hint">보존 기간</p><strong>${esc(trendDays(settings.retentionMs))}</strong><span class="hint"> · 오래된 트렌드 스냅샷만 정리</span></div></div>${lastRun?.error ? `<p class="danger" role="alert">${esc(lastRun.error)}</p>` : ''}<form id="trend-settings-form" class="section-spacer"><div class="two-cols"><label>자동 수집<input name="enabled" type="checkbox" ${enabled ? 'checked' : ''}></label><label>수집 주기 (시간)<input name="intervalHours" type="number" min="1" max="168" step="1" value="${intervalHours}"></label></div><button class="small" type="submit">설정 저장</button><p class="hint" style="margin-top:12px">자동 수집은 기본 꺼짐이며, 켜면 서버 재시작 후에도 설정을 유지합니다.</p></form></div></section><section class="panel"><div class="panel-header"><h2>인기 키워드</h2><span class="badge">최근 14일</span></div><div class="panel-body">${popular.length ? `<div class="row" style="flex-wrap:wrap">${popular.map(item => `<button class="small quiet" data-action="trend-popular" data-query="${esc(item.keyword)}">${esc(item.keyword)} · ${Number(item.count) || 0}</button>`).join('')}</div>` : '<p class="empty">최근 14일 동안 수집된 인기 키워드가 없습니다.</p>'}</div></section></div><section class="panel section-spacer"><div class="panel-header"><div><h2>소재 보관함</h2><p class="hint">${records.length}개 표시 · 검색 결과는 서버에서 제한됩니다.</p></div><form id="trend-search-form" class="row"><label class="sr-only" for="trend-query">키워드 검색</label><input id="trend-query" name="query" maxlength="300" placeholder="키워드 검색"><button class="small" type="submit">검색</button></form></div><div class="data-list">${records.length ? records.map(trend => `<div class="data-row"><div><h3>${esc(trend.keyword)}</h3><p>${esc(trend.source || '수동 기록')} · ${date(trend.capturedAt || trend.lastCapturedAt || trend.createdAt)} ${trend.selected ? ' · 선택됨' : ''}</p>${trend.url ? `<a class="hint" href="${safeUrl(trend.url)}" target="_blank" rel="noopener noreferrer">원문 확인 ↗</a>` : ''}${trendMediaHtml(trend) ? `<p>${trendMediaHtml(trend)}</p>` : ''}</div><div class="row"><button class="small quiet" data-action="trend-select" data-keyword="${esc(trend.keyword)}" data-selected="${trend.selected ? 'false' : 'true'}">${trend.selected ? '선택 해제' : '선택'}</button><button class="small" data-action="trend-episode" data-keyword="${esc(trend.keyword)}">에피소드로 만들기</button></div></div>`).join('') : '<div class="empty">아직 수집한 소재가 없습니다.<br>지금 수집하거나 관심 키워드를 직접 기록하세요.</div>'}</div></section><section class="panel section-spacer"><div class="panel-header"><h2>최근 수집 기록</h2><span class="badge">${runs.length}건</span></div>${runs.length ? runs.map(run => `<div class="data-row"><div><h3>${esc(run.status === 'completed' ? '수집 완료' : '수집 실패')}</h3><p>${date(run.completedAt || run.startedAt)} · ${Number(run.inserted) || 0}개 추가 · ${Number(run.pruned) || 0}개 정리</p></div><span class="badge ${run.status === 'completed' ? 'lime' : 'coral'}">${esc(run.status)}</span></div>`).join('') : '<div class="empty">아직 수집 실행 기록이 없습니다.</div>'}</section><section class="panel section-spacer"><div class="panel-header"><h2>키워드 직접 기록</h2></div><form class="panel-body" id="trend-form"><label>키워드<input name="keyword" required maxlength="300" placeholder="지금 사람들이 궁금해하는 것"></label><label>출처<select name="source"><option>Naver</option><option>Google</option><option>YouTube</option><option>직접 조사</option></select></label><label>원문 링크<input name="url" type="url" required placeholder="https://..."></label><button class="primary" type="submit">소재 저장</button><p class="hint" style="margin-top:14px">관심도와 사실 여부는 원문을 확인해 판단하세요.</p></form></section><section class="panel section-spacer"><div class="panel-header"><h2>연출 레퍼런스</h2><button class="small" data-action="new-reference">＋ 레퍼런스 추가</button></div>${state.references.length ? state.references.map(reference => `<div class="data-row"><div><h3>${esc(reference.title)}</h3><p>${esc(categoryNames[reference.category] || reference.category)} · ${esc(reference.notes)}</p></div><a href="${safeUrl(reference.url)}" target="_blank" rel="noopener noreferrer">원본 보기 ↗</a></div>`).join('') : '<div class="empty">같은 카테고리 크리에이터의 구도, 템포, 자막 스타일을 기록하세요.</div>'}</section>`;
}
function templatesView() {
  return heading('템플릿', '장면 구조를 불러와 현재 에피소드에 적용합니다.', episode ? '<button data-action="save-template">현재 장면을 템플릿으로 저장</button>' : '') + `<div class="cards">${state.templates.map(template => `<article class="panel"><div class="template-art" style="background:${safeColor(template.scenes?.[0]?.background)}">${esc(template.scenes?.[0]?.text || template.name)}</div><div class="template-info"><div class="row between"><h2>${esc(template.name)}</h2><span class="badge">${esc(template.format)}</span></div><p>${esc(categoryNames[template.category] || template.category)} · ${template.scenes?.length || 0} 장면</p><button class="primary small" data-action="apply-template" data-id="${esc(template.id)}">${episode ? '현재 에피소드에 적용' : '에피소드를 먼저 선택하세요'}</button></div></article>`).join('')}</div><p class="footnote">템플릿을 적용하면 현재 장면이 변경됩니다. 적용 전 버전은 제작 히스토리에 남습니다.</p>`;
}
function historyView() {
  const selected=history.find(item=>item.version===historyVersion) || history[0];
  const changes=selected && episode ? episodeChanges(selected.snapshot,episode) : [];
  return heading('제작 기록', '버전별 변경 내용을 비교하고 복원합니다.', '<button data-action="reload-history">기록 새로고침</button>') +
    `<section class="panel history-panel"><div class="panel-header history-header"><div><span class="eyebrow">EPISODE HISTORY</span><h2>${esc(episode?.title || '선택된 에피소드 없음')}</h2></div><span class="badge">${history.length} VERSIONS</span></div><div class="panel-body"><label>기록을 볼 에피소드<select id="history-episode" aria-label="기록을 볼 에피소드">${state.episodes.map(item=>`<option value="${esc(item.id)}" ${item.id===episode?.id?'selected':''}>${esc(state.channels.find(channel=>channel.id===item.channelId)?.name || '')} · ${esc(item.title)}</option>`).join('')}</select></label></div>${selected ? `<div class="history-layout"><nav class="history-versions" aria-label="에피소드 버전">${history.map(item=>`<button data-action="history-version" data-version="${Number(item.version)}" class="history-version ${item.version===selected.version?'selected':''}" aria-pressed="${item.version===selected.version}"><strong>v${Number(item.version)} ${item.version===episode.version?'<span class="badge">현재</span>':''}</strong><span>${esc(historyReason(item.reason))}</span><small>${date(item.createdAt)}</small></button>`).join('')}</nav><div class="history-comparison" data-testid="episode-history-comparison"><div class="row between history-compare-heading"><div><h3>v${selected.version} → ${dirty?'편집 중 초안':`현재 v${episode.version}`}</h3><p class="hint">${changes.length}개 변경 · 장면은 고유 ID로 비교합니다.</p></div><button data-action="restore-episode" data-version="${selected.version}" ${dirty || savePending || selected.version===episode.version?'disabled':''}>이 버전으로 복원</button></div>${dirty?'<p class="wf-review-warning">저장되지 않은 편집을 먼저 저장해야 복원할 수 있습니다. 현재 초안은 유지됩니다.</p><button data-action="save-history-draft">초안 저장 후 비교</button>':''}${changesHtml(changes,esc,`선택 v${selected.version}`,dirty?'현재 초안':`현재 v${episode.version}`)}<details class="history-advanced"><summary>고급 · 원본 기록 JSON</summary><pre class="history-snapshot">${esc(JSON.stringify(selected.snapshot,null,2))}</pre></details><p class="hint">복원은 새 버전을 만듭니다. 이전 기록과 렌더 파일은 그대로 보존됩니다.</p></div></div>`:'<div class="empty">에피소드를 만들면 버전별 변경 기록이 표시됩니다.</div>'}</section><section class="panel section-spacer"><details><summary class="panel-header history-activity-heading"><h2>최근 워크스페이스 활동</h2><span aria-hidden="true">⌄</span></summary>${state.events.slice().reverse().slice(0,15).map(event=>`<div class="data-row"><div><h3>${esc(event.type || '작업 기록')}</h3><p>${esc(event.message || event.entityId || '')}</p></div><span class="hint">${date(event.createdAt)}</span></div>`).join('') || '<div class="empty">아직 기록된 활동이 없습니다.</div>'}</details></section>`;
}

function restoreEpisode(version) {
  if (!episode || dirty || savePending) throw new Error('먼저 현재 초안을 저장해 주세요. 저장되지 않은 편집은 보존됩니다.');
  const entry=history.find(item=>item.version===version);
  if (!entry) throw new Error('복원할 버전을 다시 선택해 주세요.');
  const targetId=episode.id,expectedVersion=episode.version,revision=editRevision;
  openModal(`v${version}을 새 버전으로 복원`, `<p class="hint">현재 v${expectedVersion}의 내용이 아래 선택 버전으로 바뀝니다. 기존 모든 버전은 보존되며, 복원 결과는 새 버전으로 저장됩니다.</p>${changesHtml(episodeChanges(episode,entry.snapshot),esc,`현재 v${expectedVersion}`,`복원할 v${version}`)}`,async()=>{
    if (episode?.id!==targetId || editRevision!==revision || dirty || episode.version!==expectedVersion) throw new Error('비교 이후 편집본이 변경되었습니다. 복원 내용을 다시 확인해 주세요.');
    requireProjectEdit(targetId);
    const restored=await post(`/api/episodes/${targetId}/restore`,{version,expectedVersion});
    cacheEpisode(restored);
    if (episode?.id!==targetId || editRevision!==revision || dirty) {await refresh();throw new Error('복원 기록은 저장됐으며, 진행 중인 로컬 편집은 보존했습니다. 최신 기록과 비교해 주세요.');}
    reconcileEpisode(restored);sceneIndex=0;historyVersion=restored.version;await refresh();await loadHistory();render();toast(`v${version}의 내용을 새 버전 v${restored.version}으로 복원했습니다.`);
  },'새 버전으로 복원');
}

// --- Knowledge graph: pan/zoom + node placement (session-only UI state; never persisted, never mutates graph data/index) ---
const GRAPH_VIEWBOX = {w:700,h:390};
const GRAPH_BOUNDS = {minX:70,maxX:630,minY:24,maxY:352};
const GRAPH_MIN_GAP = 14;
const GRAPH_ZOOM_MIN = 0.5, GRAPH_ZOOM_MAX = 2.5, GRAPH_ZOOM_STEP = 1.25;
const GRAPH_PAN_STEP = 40, GRAPH_NODE_STEP = 10;
const graphNodePositions = new Map();
const graphLayoutPositions = new Map();
let graphPan = {x:0,y:0};
let graphZoom = 1;
let graphSelectedNodeId = null;
let graphLastMovedId = null;
let graphLiveMessage = '';
let graphDrag = null;
let graphDragRaf = 0;
function graphVisibleNodes() { return (state.graph?.nodes || []).slice(0,36); }
function graphNodeRadius(node) { return (node.type || node.kind) === 'channel' ? 20 : 12; }
function graphNodeLabel(node) { return node.label || node.title || node.name || node.id; }
function graphNodeLabelById(nodeId) {
  const node = graphVisibleNodes().find(item => item.id === nodeId) || (state.graph?.nodes || []).find(item => item.id === nodeId);
  return node ? graphNodeLabel(node) : '';
}
function graphClampXY(point) {
  point.x = Math.min(GRAPH_BOUNDS.maxX, Math.max(GRAPH_BOUNDS.minX, point.x));
  point.y = Math.min(GRAPH_BOUNDS.maxY, Math.max(GRAPH_BOUNDS.minY, point.y));
  return point;
}
function graphBaseLayout(visible) {
  const positions = new Map();
  visible.forEach((node,index) => positions.set(node.id, {x:350 + Math.cos(index * Math.PI * 2 / visible.length) * (index % 2 ? 245 : 155), y:195 + Math.sin(index * Math.PI * 2 / visible.length) * (index % 2 ? 140 : 85)}));
  return positions;
}
function graphResolveOverlaps(positions, visible) {
  for (let pass = 0; pass < 48; pass++) {
    for (let i = 0; i < visible.length; i++) {
      for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i], b = visible[j];
        const pa = positions.get(a.id), pb = positions.get(b.id);
        if (!pa || !pb) continue;
        const minDist = graphNodeRadius(a) + graphNodeRadius(b) + GRAPH_MIN_GAP;
        let dx = pb.x - pa.x, dy = pb.y - pa.y;
        let dist = Math.hypot(dx,dy);
        if (dist < 0.01) { dx = 1; dy = 0; dist = 1; }
        if (dist >= minDist) continue;
        const deficit = minDist - dist;
        const ux = dx / dist, uy = dy / dist;
        const bAnchored = graphLastMovedId === b.id && graphLastMovedId !== a.id;
        const aAnchored = graphLastMovedId === a.id && graphLastMovedId !== b.id;
        const moving = aAnchored ? pb : bAnchored ? pa : null;
        const origin = moving && {x:moving.x, y:moving.y};
        if (bAnchored) { pa.x -= ux * deficit; pa.y -= uy * deficit; }
        else if (aAnchored) { pb.x += ux * deficit; pb.y += uy * deficit; }
        else { pa.x -= ux * deficit / 2; pa.y -= uy * deficit / 2; pb.x += ux * deficit / 2; pb.y += uy * deficit / 2; }
        graphClampXY(pa); graphClampXY(pb);
        if (moving) {
          const anchor = aAnchored ? pa : pb;
          if (Math.hypot(moving.x - anchor.x, moving.y - anchor.y) < minDist - 1e-7) {
            const candidates = [
              {x:anchor.x - minDist, y:anchor.y}, {x:anchor.x + minDist, y:anchor.y},
              {x:anchor.x, y:anchor.y - minDist}, {x:anchor.x, y:anchor.y + minDist}
            ].filter(point => point.x >= GRAPH_BOUNDS.minX && point.x <= GRAPH_BOUNDS.maxX && point.y >= GRAPH_BOUNDS.minY && point.y <= GRAPH_BOUNDS.maxY);
            const nearest = candidates.reduce((best, point) => !best || Math.hypot(point.x - origin.x, point.y - origin.y) < Math.hypot(best.x - origin.x, best.y - origin.y) ? point : best, null);
            if (nearest) { moving.x = nearest.x; moving.y = nearest.y; }
          }
        }
      }
    }
  }
}
function currentGraphPositions(visible) {
  const positions = graphBaseLayout(visible);
  for (const node of visible) {
    const position = graphLayoutPositions.get(node.id) || graphNodePositions.get(node.id);
    if (position) positions.set(node.id, {x:position.x,y:position.y});
  }
  for (const point of positions.values()) graphClampXY(point);
  graphResolveOverlaps(positions, visible);
  return positions;
}
function graphPruneOverrides(nodes) {
  const ids = new Set(nodes.map(node => node.id));
  for (const key of graphNodePositions.keys()) if (!ids.has(key)) graphNodePositions.delete(key);
  for (const key of graphLayoutPositions.keys()) if (!ids.has(key)) graphLayoutPositions.delete(key);
  if (graphSelectedNodeId && !ids.has(graphSelectedNodeId)) graphSelectedNodeId = null;
  if (graphLastMovedId && !ids.has(graphLastMovedId)) graphLastMovedId = null;
}
function graphSvgEl() { return document.getElementById('knowledge-graph-svg'); }
function graphWorldEl() { return document.getElementById('graph-world'); }
function graphDeltaToLocal(el, dxScreen, dyScreen) {
  const ctm = el?.getScreenCTM?.();
  const scale = ctm ? (Math.hypot(ctm.a, ctm.b) || 1) : 1;
  return {dx: dxScreen / scale, dy: dyScreen / scale};
}
function graphLabelLayout(visible, positions) {
  const labels = new Map(), occupied = [];
  const context = document.createElement('canvas').getContext('2d');
  if (context) context.font = `11px ${getComputedStyle(document.body).fontFamily}`;
  const ordered = [...visible].sort((a,b) => Number(b.id === graphSelectedNodeId) - Number(a.id === graphSelectedNodeId));
  for (const node of ordered) {
    const point = positions.get(node.id), chars = Array.from(String(graphNodeLabel(node)));
    const radius = graphNodeRadius(node);
    for (let limit = Math.min(chars.length,16); limit >= Math.min(chars.length,4); limit--) {
      const text = chars.length > limit ? `${chars.slice(0,limit-1).join('')}…` : chars.join('');
      const width = Math.min(GRAPH_VIEWBOX.w - 8, (context?.measureText(text).width ?? limit * 12) + 8);
      const x = Math.max(width / 2 + 4, Math.min(GRAPH_VIEWBOX.w - width / 2 - 4, point.x));
      for (const y of [point.y + radius + 16, point.y - radius - 6]) {
        const box = {left:x-width/2, right:x+width/2, top:y-12, bottom:y+3};
        if (box.top < 2 || box.bottom > GRAPH_VIEWBOX.h - 2) continue;
        if (occupied.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
        if (visible.some(other => {
          const center = positions.get(other.id), r = graphNodeRadius(other) + 2;
          const dx = center.x - Math.max(box.left, Math.min(center.x, box.right));
          const dy = center.y - Math.max(box.top, Math.min(center.y, box.bottom));
          return dx * dx + dy * dy < r * r;
        })) continue;
        occupied.push(box); labels.set(node.id,{x,y,text}); break;
      }
      if (labels.has(node.id)) break;
    }
  }
  return labels;
}
function graphSectionMarkup() {
  const visible = graphVisibleNodes();
  const total = (state.graph?.nodes || []).length;
  if (!visible.length) return '<div class="empty">채널과 에피소드를 만들면 연결된 지식이 여기에 나타납니다.</div>';
  graphPruneOverrides(state.graph.nodes || []);
  const positions = currentGraphPositions(visible);
  for (const [id, position] of positions) graphLayoutPositions.set(id, {...position});
  const labels = graphLabelLayout(visible, positions);
  const edges = state.graph.edges || [];
  const lineEls = edges.map((edge,index) => {
    const from = positions.get(edge.source || edge.from), to = positions.get(edge.target || edge.to);
    return from && to ? `<line data-edge-index="${index}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"/>` : '';
  }).join('');
  const nodeEls = visible.map(node => {
    const pos = positions.get(node.id);
    const selected = graphSelectedNodeId === node.id;
    const label = graphNodeLabel(node);
    const radius = graphNodeRadius(node);
    const placed = labels.get(node.id);
    return `<g class="graph-node${selected ? ' selected' : ''}" data-node-id="${esc(node.id)}" data-x="${pos.x.toFixed(2)}" data-y="${pos.y.toFixed(2)}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="${esc(label)} · 화살표 키로 이동, Enter로 선택, Home으로 위치 초기화"><circle class="graph-node-hit" cx="${pos.x}" cy="${pos.y}" r="${radius + 6}"/><circle class="graph-node-dot${(node.type || node.kind) === 'episode' ? ' episode-node' : ''}" cx="${pos.x}" cy="${pos.y}" r="${radius}"/><text x="${placed?.x ?? pos.x}" y="${placed?.y ?? pos.y}" text-anchor="middle" visibility="${placed ? 'visible' : 'hidden'}">${esc(placed?.text || '')}</text><title>${esc(label)}</title></g>`;
  }).join('');
  const selectedNode = graphSelectedNodeId ? visible.find(node => node.id === graphSelectedNodeId) : null;
  return `<div class="graph-toolbar" role="group" aria-label="그래프 보기 조정"><div class="graph-toolbar-group" role="group" aria-label="화면 이동"><button type="button" id="graph-pan-up" class="small icon-btn" data-action="graph-pan" data-dir="up" aria-label="위로 이동">↑</button><button type="button" id="graph-pan-left" class="small icon-btn" data-action="graph-pan" data-dir="left" aria-label="왼쪽으로 이동">←</button><button type="button" id="graph-pan-down" class="small icon-btn" data-action="graph-pan" data-dir="down" aria-label="아래로 이동">↓</button><button type="button" id="graph-pan-right" class="small icon-btn" data-action="graph-pan" data-dir="right" aria-label="오른쪽으로 이동">→</button></div><div class="graph-toolbar-group" role="group" aria-label="확대 축소"><button type="button" id="graph-zoom-out" class="small" data-action="graph-zoom-out" aria-label="축소">−</button><span id="graph-zoom-value" class="hint">${Math.round(graphZoom*100)}%</span><button type="button" id="graph-zoom-in" class="small" data-action="graph-zoom-in" aria-label="확대">+</button><button type="button" id="graph-zoom-reset" class="small quiet" data-action="graph-zoom-reset">보기 초기화</button></div>${selectedNode ? `<div class="graph-toolbar-group graph-node-toolbar" role="group" aria-label="${esc(graphNodeLabel(selectedNode))} 위치 이동"><span class="hint graph-selected-label">${esc(graphNodeLabel(selectedNode))}</span><button type="button" id="graph-node-move-up" class="small icon-btn" data-action="graph-node-move" data-dir="up" aria-label="선택한 노드 위로 이동">↑</button><button type="button" id="graph-node-move-left" class="small icon-btn" data-action="graph-node-move" data-dir="left" aria-label="선택한 노드 왼쪽으로 이동">←</button><button type="button" id="graph-node-move-down" class="small icon-btn" data-action="graph-node-move" data-dir="down" aria-label="선택한 노드 아래로 이동">↓</button><button type="button" id="graph-node-move-right" class="small icon-btn" data-action="graph-node-move" data-dir="right" aria-label="선택한 노드 오른쪽으로 이동">→</button><button type="button" id="graph-node-reset" class="small quiet" data-action="graph-node-reset">위치 초기화</button></div>` : ''}</div><p class="hint graph-usage-hint" id="graph-usage-hint">그래프는 드래그하거나 화살표 키로 이동합니다. 노드를 클릭하거나 Enter로 선택하면 이동 버튼이 나타납니다.${total > visible.length ? ` 전체 ${total}개 중 ${visible.length}개만 표시됩니다 · 아래 목록에서 전체를 확인하세요.` : ''}</p><svg id="knowledge-graph-svg" class="graph" viewBox="0 0 ${GRAPH_VIEWBOX.w} ${GRAPH_VIEWBOX.h}" role="graphics-document" aria-roledescription="지식 그래프" aria-label="채널, 에피소드 및 소재의 관계 그래프" aria-describedby="graph-usage-hint" tabindex="0" data-testid="knowledge-graph-svg"><g id="graph-world" data-testid="graph-world" transform="translate(${graphPan.x} ${graphPan.y}) scale(${graphZoom})">${lineEls}${nodeEls}</g></svg><p class="sr-only" id="graph-live-region" role="status" aria-live="polite">${esc(graphLiveMessage)}</p>`;
}
function renderGraphOnly(focusSelector) {
  const viewport = document.getElementById('graph-viewport');
  if (!viewport) return;
  const scrollLeft = viewport.scrollLeft;
  viewport.innerHTML = graphSectionMarkup();
  viewport.scrollLeft = scrollLeft;
  if (focusSelector) viewport.querySelector(focusSelector)?.focus?.({preventScroll:true});
}
function graphPatchTransform() {
  const world = graphWorldEl();
  if (world) world.setAttribute('transform', `translate(${graphPan.x} ${graphPan.y}) scale(${graphZoom})`);
  const label = document.getElementById('graph-zoom-value');
  if (label) label.textContent = `${Math.round(graphZoom * 100)}%`;
  const live = document.getElementById('graph-live-region');
  if (live && graphLiveMessage) live.textContent = graphLiveMessage;
}
function graphPatchNodePositions() {
  const world = graphWorldEl();
  if (!world) return;
  const visible = graphVisibleNodes();
  const positions = currentGraphPositions(visible);
  for (const [id, position] of positions) graphLayoutPositions.set(id, {...position});
  const labels = graphLabelLayout(visible, positions);
  for (const node of visible) {
    const pos = positions.get(node.id);
    const g = world.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
    if (!pos || !g) continue;
    g.setAttribute('data-x', pos.x.toFixed(2));
    g.setAttribute('data-y', pos.y.toFixed(2));
    for (const circle of g.querySelectorAll('circle')) { circle.setAttribute('cx', pos.x); circle.setAttribute('cy', pos.y); }
    const text = g.querySelector('text');
    if (text) { const placed = labels.get(node.id); text.setAttribute('x', placed?.x ?? pos.x); text.setAttribute('y', placed?.y ?? pos.y); text.setAttribute('visibility', placed ? 'visible' : 'hidden'); text.textContent = placed?.text || ''; }
  }
  (state.graph?.edges || []).forEach((edge,index) => {
    const line = world.querySelector(`[data-edge-index="${index}"]`);
    const from = positions.get(edge.source || edge.from), to = positions.get(edge.target || edge.to);
    if (!line || !from || !to) return;
    line.setAttribute('x1', from.x); line.setAttribute('y1', from.y);
    line.setAttribute('x2', to.x); line.setAttribute('y2', to.y);
  });
  const live = document.getElementById('graph-live-region');
  if (live && graphLiveMessage) live.textContent = graphLiveMessage;
}
function graphPanBy(dx, dy) {
  graphPan = {x: graphPan.x + dx, y: graphPan.y + dy};
  graphLiveMessage = '보기를 이동했습니다.';
  graphPatchTransform();
}
function graphApplyZoom(nextZoomRaw, anchor) {
  anchor ||= {x:GRAPH_VIEWBOX.w/2, y:GRAPH_VIEWBOX.h/2};
  const nextZoom = Math.min(GRAPH_ZOOM_MAX, Math.max(GRAPH_ZOOM_MIN, nextZoomRaw));
  if (nextZoom === graphZoom) return;
  graphPan = {x: anchor.x - (nextZoom / graphZoom) * (anchor.x - graphPan.x), y: anchor.y - (nextZoom / graphZoom) * (anchor.y - graphPan.y)};
  graphZoom = nextZoom;
  graphLiveMessage = `확대 ${Math.round(graphZoom * 100)}%`;
  graphPatchTransform();
}
function graphResetView() {
  graphPan = {x:0,y:0};
  graphZoom = 1;
  graphLiveMessage = '보기를 초기화했습니다.';
  graphPatchTransform();
}
function graphMoveNode(nodeId, dx, dy) {
  const positions = currentGraphPositions(graphVisibleNodes());
  const current = positions.get(nodeId);
  if (!current) return;
  graphNodePositions.set(nodeId, graphClampXY({x: current.x + dx, y: current.y + dy}));
  graphLayoutPositions.set(nodeId, {...graphNodePositions.get(nodeId)});
  graphLastMovedId = nodeId;
  graphLiveMessage = `${graphNodeLabelById(nodeId)} 위치를 이동했습니다.`;
  graphPatchNodePositions();
}
function graphResetNode(nodeId) {
  if (!graphNodePositions.has(nodeId)) return;
  graphNodePositions.delete(nodeId);
  graphLayoutPositions.delete(nodeId);
  if (graphLastMovedId === nodeId) graphLastMovedId = null;
  graphLiveMessage = `${graphNodeLabelById(nodeId)} 위치를 기본값으로 되돌렸습니다.`;
  graphPatchNodePositions();
}
function graphToggleNodeSelection(nodeId) {
  graphSelectedNodeId = graphSelectedNodeId === nodeId ? null : nodeId;
  graphLiveMessage = graphSelectedNodeId ? `${graphNodeLabelById(nodeId)} 선택됨. 이동 버튼이나 화살표 키로 위치를 조정하세요.` : '선택을 해제했습니다.';
  renderGraphOnly(graphSelectedNodeId ? `[data-node-id="${CSS.escape(nodeId)}"]` : '#knowledge-graph-svg');
}
function graphDeselectNode() {
  if (!graphSelectedNodeId) return;
  graphSelectedNodeId = null;
  graphLiveMessage = '선택을 해제했습니다.';
  renderGraphOnly('#knowledge-graph-svg');
}

function knowledgeView() {
  const graph = state.graph || {nodes:[],edges:[]};
  const nodes = graph.nodes || [];
  const byId = new Map(nodes.map(node=>[node.id,node]));
  const access = item => item.editable ? '<span class="badge">원본 편집 가능</span>' : `<p class="hint graph-readonly" data-testid="graph-readonly">읽기 전용 · ${esc(item.readOnlyReason || '편집 가능한 원본이 없습니다.')}</p>`;
  return heading('지식 그래프', '원본 기록을 편집하면 그래프와 내보내기가 갱신됩니다.', '<button data-action="refresh-knowledge">그래프 새로고침</button>') + `<p class="source-note">채널 이름과 에피소드 제목·주제·소속 채널을 편집할 수 있습니다. 주제 노드는 에피소드에서 파생됩니다. 나머지 노드와 연결은 읽기 전용입니다.</p><div class="row" style="margin-bottom:17px"><span class="badge lime">${nodes.length}개 노드</span><span class="badge">${graph.edges?.length || 0}개 연결</span></div><section class="panel graph-panel">${nodes.length ? `<div class="graph-viewport" id="graph-viewport">${graphSectionMarkup()}</div>` : '<div class="empty">채널과 에피소드를 만들면 연결된 지식이 여기에 나타납니다.</div>'}</section><div class="cards section-spacer graph-records">${nodes.map(node => `<article class="panel panel-body" data-graph-node="${esc(node.id)}"><span class="eyebrow">${esc(node.type || node.kind || '지식')}</span><h3>${esc(node.label || node.title || node.name || node.id)}</h3><p class="hint graph-record-id">${esc(node.id)}</p>${access(node)}${node.editable ? `<button class="small" data-action="edit-graph-node" data-id="${esc(node.id)}" ${!canMutate()?'disabled':''}>원본 편집</button>`:''}</article>`).join('')}</div><section class="panel section-spacer graph-relations"><div class="panel-header"><h2>연결</h2></div>${(graph.edges || []).map((edge,index)=>`<article class="data-row" data-graph-edge="${index}"><div><h3>${esc(byId.get(edge.source)?.label || edge.source)} → ${esc(byId.get(edge.target)?.label || edge.target)}</h3><p class="hint">${esc(edge.relation)}</p>${access(edge)}</div>${edge.editable?`<button class="small" data-action="edit-graph-edge" data-index="${index}" ${!canMutate()?'disabled':''}>연결 원본 편집</button>`:''}</article>`).join('') || '<p class="panel-body hint">연결이 없습니다.</p>'}</section>`;
}
function guardGraphEdit() {
  if (!canMutate()) throw new Error('변경하려면 로그인하세요.');
  if (dirty || savePending || workflowEditor.hasChanges()) throw new Error('현재 초안을 먼저 저장해 주세요. 그래프 편집 중에도 기존 초안은 보존됩니다.');
}
async function refreshAfterGraphEdit() {
  const targetId = episode?.id, revision = editRevision;
  await refresh();
  if (episode?.id === targetId && editRevision === revision) {
    const latest = state.episodes.find(item=>item.id===targetId);
    if (latest) reconcileEpisode(latest);
  }
  render(); toast('원본 기록과 지식 그래프를 갱신했습니다.');
}
function editGraphNode(targetId) {
  guardGraphEdit();
  const node=state.graph.nodes.find(item=>item.id===targetId);
  if (!node?.editable || !node.edit) throw new Error(node?.readOnlyReason || '읽기 전용 노드입니다.');
  const fields=node.edit.fields || [];
  const body=`<p class="hint">원본 ${esc(node.type)} 기록을 수정합니다. 충돌이 발생하면 입력은 유지됩니다.</p>${fields.includes('label')?`<label>이름 / 제목<input name="label" required maxlength="${node.type==='channel'?160:200}" value="${esc(node.label)}"></label>`:''}${fields.includes('topic')?`<label>소재 / 주제<textarea name="topic" required>${esc(node.edit.topic)}</textarea></label>`:''}${fields.includes('channelId')?`<label>소속 채널<select name="channelId" required>${state.channels.map(channel=>`<option value="${esc(channel.id)}" ${channel.id===node.edit.channelId?'selected':''}>${esc(channel.name)}</option>`).join('')}</select></label>`:''}`;
  openModal('지식 원본 편집',body,async data=>{
    guardGraphEdit();
    const payload=Object.fromEntries(fields.filter(field=>field in data).map(field=>[field,data[field]]));
    if (node.type==='episode') payload.expectedVersion=node.edit.expectedVersion;
    else payload.expectedRecord=node.edit.expectedRecord;
    await api(`/api/knowledge/nodes/${encodeURIComponent(node.id)}`,{method:'PUT',body:JSON.stringify(payload)});
    await refreshAfterGraphEdit();
  },'원본에 저장');
}
function editGraphEdge(index) {
  guardGraphEdit();
  const edge=state.graph.edges[index];
  if (!edge?.editable || !edge.edit) throw new Error(edge?.readOnlyReason || '읽기 전용 연결입니다.');
  const targetType=edge.edit.field==='channelId'?'channel':'topic';
  const targets=state.graph.nodes.filter(node=>node.type===targetType);
  openModal('연결 원본 편집',`<p class="hint">에피소드의 ${targetType==='channel'?'소속 채널':'주제'}를 수정합니다. 새 주제는 에피소드 원본 편집에서 입력하세요.</p><label>연결 대상<select name="newTarget" required>${targets.map(node=>`<option value="${esc(node.id)}" ${node.id===edge.target?'selected':''}>${esc(node.label)}</option>`).join('')}</select></label>`,async data=>{
    guardGraphEdit();
    await api('/api/knowledge/edges',{method:'PUT',body:JSON.stringify({source:edge.source,target:edge.target,relation:edge.relation,newTarget:data.newTarget,expectedVersion:edge.edit.expectedVersion})});
    await refreshAfterGraphEdit();
  },'원본에 저장');
}
function settingsView() {
  const entries = Array.isArray(state.integrations) ? state.integrations.map((item,index) => [item.name || item.id || index,item]) : Object.entries(state.integrations || {});
  return heading('연결 상태', '외부 도구의 설정과 인증 상태를 확인합니다.') + `<div class="source-note">Studio는 로컬 규칙 기반 어시스턴트입니다. Codex · JEO · JEOPI · Hermes는 호스트 브리지가 연결되어야 실행됩니다. 채널 등록은 플랫폼 계정 인증이나 자동 업로드 연결을 의미하지 않습니다.</div><div class="status-grid">${entries.map(([name,raw]) => { const value = typeof raw === 'object' && raw !== null ? raw : {status:String(raw)}; const verified = value.available === true && value.authenticated !== false && ![value.status, value.authentication, value.authenticated].includes('configured'); const configured = value.configured === true || value.authentication === 'configured' || value.authenticated === 'configured' || value.status === 'configured'; const label = verified ? '사용 가능' : configured ? '설정됨 · 확인 필요' : esc(value.status || '연결 확인 필요'); const tone = verified ? 'lime' : configured ? '' : 'coral'; const detail = value.detail || value.message || value.reason || value.description || (verified ? '서버에서 사용 가능 상태를 확인했습니다.' : configured ? '설정은 있지만 실제 사용 가능 여부를 확인하지 못했습니다.' : '서버 환경 설정 또는 인증이 필요합니다.'); return `<article class="panel integration"><div class="row between"><h3>${esc(name)}</h3><span class="badge ${tone}">${label}</span></div><p>${esc(detail)}</p>${value.url ? `<a href="${safeUrl(value.url)}" target="_blank" rel="noopener noreferrer">연결 열기 ↗</a>` : ''}</article>`; }).join('')}</div><section class="panel section-spacer"><div class="panel-header"><h2>등록된 채널</h2><button class="small" data-action="new-channel">＋ 채널 추가</button></div>${state.channels.map(channel => `<div class="data-row"><div><h3>${esc(channel.name)}</h3><p>${esc(channel.platform)} · ${esc(channel.accountEmail || '계정 미연결')}<br>${channel.externalId ? `채널 ID: ${esc(channel.externalId)}` : '플랫폼 채널 ID 미등록'}</p></div><span class="badge">${esc(categoryNames[channel.category] || channel.category)}</span></div>`).join('')}</section><div class="row section-spacer"><button data-action="refresh-integrations">연결 상태 확인</button><a href="/api/health" target="_blank" rel="noopener noreferrer">서비스 상태 보기 ↗</a></div>`;
}

function stashActiveDraft() {
  if (!episode) return;
  baseVersion ??= episode.version;
  studioDrafts.set(episode.id, {episode: clone(episode), baseVersion, dirty, editRevision, sceneIndex, selectedSlotId, history:clone(history), historyVersion});
  channelEpisodes.set(episode.channelId,episode.id);
}
function switchEpisode(target, targetChannelId = target?.channelId ?? channelId) {
  projectToolRequest += 1;
  if (episode?.id === target?.id && channelId === targetChannelId) { bindWorkflowProject(); return; }
  stashActiveDraft();
  channelId = targetChannelId;
  if (!target) { episode = null; baseVersion = null; dirty = false; editRevision = 0; sceneIndex = 0; selectedSlotId = null; history = []; historyVersion = null; }
  else {
    const stashed = studioDrafts.get(target.id);
    if (stashed) { episode = clone(stashed.episode); baseVersion = stashed.baseVersion; dirty = stashed.dirty; editRevision = stashed.editRevision; sceneIndex = stashed.sceneIndex; selectedSlotId = stashed.selectedSlotId; history = clone(stashed.history); historyVersion = stashed.historyVersion; }
    else { episode = clone(target); baseVersion = target.version; dirty = false; editRevision = 0; sceneIndex = 0; selectedSlotId = null; history = []; historyVersion = null; }
    channelEpisodes.set(channelId,target.id);
  }
  try { if (target) sessionStorage.setItem('frameforge.selectedEpisode',target.id); else sessionStorage.removeItem('frameforge.selectedEpisode'); } catch { /* Selection remains available for this session in memory. */ }
  bindWorkflowProject();
}
function anyStudioDraftDirty() {
  return dirty || [...studioDrafts.values()].some(draft => draft.dirty);
}
function cacheEpisode(result) {
  if (!result?.id) return;
  const index = state.episodes.findIndex(item => item.id === result.id);
  if (index >= 0) state.episodes[index] = clone(result); else state.episodes.push(clone(result));
}
function reconcileEpisode(result) {
  if (episode?.id !== result?.id || dirty || savePending || studioDrafts.get(result.id)?.dirty) return false;
  episode = clone(result);
  baseVersion = result.version;
  sceneIndex = Math.min(sceneIndex, Math.max(0, episode.scenes.length - 1));
  stashActiveDraft();
  return true;
}
function onEpisodeUpdatedForTools(result) {
  if (!result?.id) return;
  cacheEpisode(result);
  if (episode?.id !== result.id) return;
  if (!reconcileEpisode(result)) { toast('이 항목에 새로운 서버 변경 사항이 있습니다. 현재 초안과 원본 버전은 보존했습니다. 버전 기록에서 비교하세요.'); return; }
  render();
}
function markDirty() {
  editRevision += 1;
  dirty = true;
  const status = $('#save-status');
  if (status) { status.textContent = '저장되지 않은 변경'; status.className = 'unsaved'; }
  updatePreview();
  if ($('#scenes')) $('#scenes').innerHTML = sceneCards();
  if ($('#project-bin-list')) $('#project-bin-list').innerHTML = sceneBinItems();
  if ($('.source-heading strong')) $('.source-heading strong').textContent = episode.title;
  if ($('#total-duration')) $('#total-duration').textContent = `총 ${duration()}초`;
  updateSaveStatus();
}
async function save(quiet = false) {
  if (!episode || !dirty) return;
  requireProjectEdit();
  if (savePending) throw new Error('저장 중입니다. 잠시 후 다시 시도해 주세요.');
  for (const scene of episode.scenes) if (scene.captions !== undefined && (!Array.isArray(scene.captions) || scene.captions.length > 200 || scene.captions.some(cue => !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.end > Number(scene.duration) || typeof cue.text !== 'string' || !cue.text.trim() || cue.text.length > 2000))) throw new Error(`장면 '${scene.title || scene.id}'의 자막 시간과 내용을 확인하세요. 시작은 0 이상, 종료는 시작보다 크고 장면 길이 이하여야 합니다.`);
  if (episode.music) { const music=episode.music,source=music.source || {}; if (!/^\/api\/uploads\/[a-zA-Z0-9_-]+\.(mp3|wav|ogg)$/i.test(music.assetUrl || '') || !['own','third-party','generated'].includes(source.origin) || [['start',1800],['trimStart',36000],['volume',2]].some(([key,max])=>!Number.isFinite(music[key]) || music[key]<0 || music[key]>max) || music.start>=duration() || source.origin==='third-party' && (!source.sourceUrl?.trim() || !source.licenseId?.trim() || !source.attribution?.trim())) throw new Error('음악 파일, 출처와 시작·트림·볼륨을 확인하세요. 제3자 음악은 출처 URL, 라이선스와 출처 표기가 필요합니다.'); }
  const revision = editRevision;
  const targetId = episode.id;
  const snapshot = clone(episode);
  const expectedVersion = baseVersion ?? snapshot.version;
  const saved = state.episodes.find(item => item.id === targetId && item.version === expectedVersion);
  const scenesChanged = !saved || JSON.stringify(saved.scenes) !== JSON.stringify(snapshot.scenes);
  savePending = true;
  updateSaveStatus();
  try {
    const updated = await api(`/api/episodes/${targetId}`, {method:'PUT',body:JSON.stringify({title:snapshot.title,topic:snapshot.topic,status:snapshot.status,format:snapshot.format,...(scenesChanged ? {scenes:snapshot.scenes} : {}),notes:snapshot.notes,...(Object.hasOwn(snapshot,'music')?{music:snapshot.music}:{}),expectedVersion})});
    cacheEpisode(updated);
    if (episode?.id !== targetId || editRevision !== revision) {
      throw new Error('요청한 버전은 저장됐습니다. 그 뒤의 로컬 초안과 원본 버전은 보존했습니다. 버전 기록에서 비교해 주세요.');
    }
    episode = updated;
    baseVersion = updated.version;
    dirty = false;
    stashActiveDraft();
    if (!quiet) toast('새 버전으로 저장했습니다.');
  } finally { savePending = false; updateSaveStatus(); }
}
function updateSaveStatus() {
  const status=$('#save-status');
  if (status) {status.textContent=savePending?'저장 중…':dirty?'저장되지 않은 변경':`버전 ${episode?.version} · 저장됨`;status.className=dirty?'unsaved':'hint';status.setAttribute('role','status');}
  if ($('#save-button')) $('#save-button').disabled=savePending || !dirty || Boolean(projectEditReason());
}
function updatePreviewCaptions() {
  clearTimeout(previewCueTimer);
  const scene = currentScene(), target = $('[data-preview-caption]', $('#preview') || document);
  if (!target || !Array.isArray(scene?.captions)) return;
  const elapsed = playing ? Math.max(0, (performance.now() - previewSceneStartedAt) / 1000) : 0;
  const cues = scene.captions.filter(cue => typeof cue.text === 'string' && Number.isFinite(cue.start) && Number.isFinite(cue.end)).map(cue => ({text:cue.text,start:Math.round(cue.start * 100) / 100,end:Math.round(cue.end * 100) / 100}));
  target.innerHTML = cues.filter(cue => elapsed >= cue.start && elapsed < cue.end).map(cue => `<div>${esc(cue.text)}</div>`).join('');
  if (playing) {
    const next = cues.flatMap(cue => [cue.start,cue.end]).filter(time => time > elapsed).reduce((nearest,time) => Math.min(nearest,time),Infinity);
    if (Number.isFinite(next)) previewCueTimer = setTimeout(updatePreviewCaptions,Math.max(1,Math.ceil((next - elapsed) * 1000)));
  }
}
function clearPreviewMusic() {
  clearTimeout(previewMusicTimer);
  if (previewMusic) { previewMusic.pause(); previewMusic = null; }
  if (previewMusicContext) { previewMusicContext.close().catch(() => {}); previewMusicContext = null; }
}
function startPreviewMusic() {
  clearPreviewMusic();
  const music = episode?.music;
  if (!music || !/^\/api\/uploads\/[a-zA-Z0-9_-]+\.(mp3|wav|ogg)$/i.test(music.assetUrl || '') || ![music.start,music.trimStart,music.volume].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) || music.volume > 2) return;
  const position = episode.scenes.slice(0,sceneIndex).reduce((sum,scene) => sum + Number(scene.duration || 0),0) + Math.max(0,(performance.now() - previewSceneStartedAt) / 1000);
  const audio = new Audio(music.assetUrl);
  previewMusic = audio;
  if (music.volume <= 1) audio.volume = music.volume;
  else {
    try {
      const context = new AudioContext(), source = context.createMediaElementSource(audio), gain = context.createGain();
      gain.gain.value = music.volume; source.connect(gain).connect(context.destination); previewMusicContext = context;
      context.resume().catch(() => {});
    } catch (error) { clearPreviewMusic(); toast(`음악 볼륨을 재생할 수 없습니다: ${error.message}`,true); return; }
  }
  const begin = () => {
    if (!playing || previewMusic !== audio) return;
    const offset = music.trimStart + Math.max(0,position - music.start);
    try { audio.currentTime = offset; } catch { audio.addEventListener('loadedmetadata',() => { if (previewMusic === audio) audio.currentTime = offset; },{once:true}); }
    audio.play().catch(() => { if (previewMusic === audio && playing) toast('배경 음악 재생을 시작할 수 없습니다.',true); });
  };
  if (position >= music.start) begin(); else previewMusicTimer = setTimeout(begin,(music.start - position) * 1000);
}
function stopPlayback() {
  playing = false; clearTimeout(playTimer); clearTimeout(previewCueTimer); clearPreviewMusic();
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  updatePreviewCaptions();
}
function playNext() {
  if (!playing) return;
  if (previewAudio) previewAudio.pause();
  previewSceneStartedAt = performance.now();
  const scene=currentScene();
  if (scene?.audioUrl) {
    previewAudio=new Audio(scene.audioUrl);
    previewAudio.volume=Math.min(1,Math.max(0,Number(scene.audioVolume ?? 1)));
    previewAudio.play().catch(()=>toast('오디오 재생을 시작할 수 없습니다. 장면 오디오 컨트롤을 사용하세요.',true));
  }
  updatePreviewCaptions();
  playTimer = setTimeout(() => {
    if (sceneIndex >= episode.scenes.length - 1) { stopPlayback(); render(); return; }
    sceneIndex += 1;
    playNext();
    render();
  }, Number(currentScene()?.duration || 3) * 1000);
}

function openModal(title, body, handler, submit = '만들기') {
  $('#modal-content').innerHTML = `<h2>${title}</h2>${body}`;
  projectToolRequest += 1;
  $('#modal-form button[type="submit"]').textContent = submit;
  modalHandler = handler;
  $('#modal').showModal();
}
function newChannel() {
  openModal('새로운 채널', `<label>채널 이름<input name="name" required maxlength="100" placeholder="나의 채널 이름"></label><div class="two-cols"><label>콘텐츠 유형<select name="category">${categoryOptions()}</select></label><label>플랫폼<select name="platform"><option value="youtube">YouTube</option><option value="instagram">Instagram</option><option value="tiktok">TikTok</option><option value="other">기타</option></select></label></div><label>계정 이메일 (선택)<input name="accountEmail" type="email" placeholder="연결할 계정"></label><label>플랫폼 채널 ID (선택)<input name="externalId" placeholder="실제 채널 ID"></label><p class="hint">이 등록은 제작 공간을 만듭니다. 외부 계정 인증과 게시 연결은 별도입니다.</p>`, async data => {
    const channel = await post('/api/channels',data);
    switchEpisode(null,channel.id);
    await refresh();
    render();
    toast('채널 제작 공간을 만들었습니다.');
  });
}
function newEpisode(topic = '') {
  if (!channelId) { newChannel(); return; }
  const targetChannelId = channelId;
  openModal('새 에피소드 만들기', `<label>에피소드 제목<input name="title" required maxlength="200" value="${esc(topic)}" placeholder="이번 이야기의 제목"></label><label>소재 / 주제<textarea name="topic" required placeholder="어떤 이야기를 전달할까요?">${esc(topic)}</textarea></label><label>콘텐츠 유형<select name="category">${categoryOptions(activeChannel()?.category)}</select></label>`, async data => {
    const created = await post('/api/episodes',{...data,channelId:targetChannelId});
    cacheEpisode(created);
    switchEpisode(created);
    closeProjectOverlays();
    view = 'workflow';
    await refresh();
    render();
    toast('새 에피소드를 만들었습니다.');
  });
}
async function loadHistory() {
  const targetId = episode?.id;
  const result = targetId ? await api(`/api/episodes/${targetId}/history`) : [];
  if (episode?.id !== targetId) return;
  history = Array.isArray(result) ? result : result.history || [];
  if (!history.some(item=>item.version===historyVersion)) historyVersion=history[0]?.version || null;
}

async function handleAction(button) {
  const action = button.dataset.action;
  if (['project-tools','project-menu','episode-menu','channel-menu','tool-menu','sidebar-menu'].includes(action)) { openProjectMenu(button); return; }
  if (action === 'open-scene-editor') { openSceneEditor(); return; }
  if (action === 'close-scene-editor') { closeSceneEditor(); return; }
  if (action === 'close-project-tool') { closeProjectTool(); return; }
  if (action === 'unarchive-project') { archiveProject(button.dataset.id,true); return; }
  if (action === 'inspect-archived') { await runProjectMenuAction('open-project',{targetId:button.dataset.id}); return; }
  if (episode && ['save','render','restore-episode','save-history-draft','narrate-scene','narrate-all','load-narration-result','apply-layout-preset','add-slot','delete-slot','upload-slot-media','remove-slot-media','add-scene','duplicate-scene','delete-scene','move-left','move-right','add-caption','delete-caption','upload-audio','remove-audio','upload','remove-media','apply-template'].includes(action)) requireProjectEdit();
  if (action === 'edit-graph-node') { editGraphNode(button.dataset.id); return; }
  if (action === 'edit-graph-edge') { editGraphEdge(Number(button.dataset.index)); return; }
  if (action === 'graph-pan') { const dir=button.dataset.dir; const delta={left:[GRAPH_PAN_STEP,0],right:[-GRAPH_PAN_STEP,0],up:[0,GRAPH_PAN_STEP],down:[0,-GRAPH_PAN_STEP]}[dir] || [0,0]; graphPanBy(delta[0],delta[1]); return; }
  if (action === 'graph-zoom-in') { graphApplyZoom(graphZoom * GRAPH_ZOOM_STEP); return; }
  if (action === 'graph-zoom-out') { graphApplyZoom(graphZoom / GRAPH_ZOOM_STEP); return; }
  if (action === 'graph-zoom-reset') { graphResetView(); return; }
  if (action === 'graph-node-move') { if (!graphSelectedNodeId) return; const dir=button.dataset.dir; const delta={left:[-GRAPH_NODE_STEP,0],right:[GRAPH_NODE_STEP,0],up:[0,-GRAPH_NODE_STEP],down:[0,GRAPH_NODE_STEP]}[dir] || [0,0]; graphMoveNode(graphSelectedNodeId,delta[0],delta[1]); return; }
  if (action === 'graph-node-reset') { if (!graphSelectedNodeId) return; graphResetNode(graphSelectedNodeId); return; }
  if (action === 'ops-open' || action === 'ops-history') {
    const target=state.episodes.find(item=>item.id===button.dataset.id);
    if (!target) throw new Error('에피소드가 현재 자료에 없습니다. 자료를 새로고침하세요.');
    stopPlayback();
    closeProjectOverlays();
    switchEpisode(target);
    view='workflow';
    render();
    if (action === 'ops-history') await openProjectTool('history');
    else $('#main')?.focus();
    return;
  }
  if (action === 'narrate-scene' || action === 'narrate-all') { await startNarration(action === 'narrate-all'); return; }
  if (action === 'refresh-speech') { await loadSpeechVoices(); render(); return; }
  if (action === 'load-narration-result') {
    const result = pendingNarrations.get(episode?.id);
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(episode,null,2)],{type:'application/json'}));
    const link = document.createElement('a'); link.href=url; link.download=`frameforge-draft-${episode.id}.json`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    episode=clone(result); baseVersion=result.version; dirty=false; editRevision+=1; pendingNarrations.delete(episode.id); sceneIndex=Math.min(sceneIndex,episode.scenes.length-1); stashActiveDraft(); render(); toast('현재 초안을 JSON 파일로 보관하고 생성 결과를 불러왔습니다.'); return;
  }
  if (action === 'reload') { location.reload(); }
  else if (action === 'history-version') {historyVersion=Number(button.dataset.version);render();}
  else if (action === 'restore-episode') restoreEpisode(Number(button.dataset.version));
  else if (action === 'save-history-draft') {await save(true);await loadHistory();render();}
  else if (action === 'view') { await openProjectTool(button.dataset.view); }
  else if (action === 'project-section') { await openProjectTool(button.dataset.section === 'delivery' ? 'delivery' : 'source'); }
  else if (action === 'new-channel') newChannel();
  else if (action === 'new-episode') newEpisode();
  else if (action === 'channel') { stopPlayback(); closeProjectOverlays(); const targetChannelId = button.dataset.id; switchEpisode(activeEpisodes().find(item => item.id === channelEpisodes.get(targetChannelId) && item.channelId === targetChannelId) || activeEpisodes().find(item => item.channelId === targetChannelId) || null, targetChannelId); view = 'workflow'; render(); $('#main')?.focus(); }
  else if (action === 'episode') { stopPlayback(); closeProjectOverlays(); switchEpisode(activeEpisodes().find(item => item.id === button.dataset.id) || null); render(); }
  else if (action === 'add-caption') { const scene=currentScene(); if (!scene) return; if (!Array.isArray(scene.captions)) scene.captions=[]; if (scene.captions.length>=200) throw new Error('장면 자막은 최대 200개입니다.'); scene.captions.push({start:0,end:Math.min(1,Number(scene.duration)),text:''}); markDirty(); render(); }
  else if (action === 'delete-caption') { const scene=currentScene(),index=Number(button.dataset.index); if (!Array.isArray(scene?.captions) || !Number.isInteger(index) || index<0 || index>=scene.captions.length) return; scene.captions.splice(index,1); markDirty(); render(); }
  else if (action === 'remove-music') { if (!episode) return; requireProjectEdit(); episode.music=null; clearPreviewMusic(); markDirty(); render(); }
  else if (action === 'open-generation') { stopPlayback(); if (!episode) return; bindWorkflowProject(); const targetId = episode.id; await workflowEditor.openGeneration({episode:clone(episode),episodeId:targetId,sceneIndex,sceneId:currentScene()?.id}); if (episode?.id !== targetId) return; closeProjectOverlays(); view = 'workflow'; render(); toast('Higgsfield 생성 설정을 열었습니다. 실행 전 비용을 확인합니다.'); }
  else if (action === 'open-slot-generation') {
    stopPlayback();
    if (!episode || !currentScene()) return;
    bindWorkflowProject();
    const targetId = episode.id;
    const slot = currentScene().slots?.find(item => item.id === button.dataset.slotId) || currentSlot();
    await workflowEditor.openGeneration({episode:clone(episode),episodeId:targetId,sceneIndex,sceneId:currentScene().id,slotId:slot?.id,prompt:slot?.prompt || slot?.text || currentScene().text});
    if (episode?.id !== targetId) return;
    closeProjectOverlays();
    view = 'workflow';
    render();
    toast(`'${slot?.name || '레이아웃 슬롯'}'의 Higgsfield 생성 설정을 열었습니다.`);
  }
  else if (action === 'apply-layout-preset') {
    const scene = currentScene();
    if (!scene) return;
    const preset = button.dataset.preset;
    const applyAll = button.dataset.scope === 'all';
    const targets = applyAll ? episode.scenes : [scene];
    for (const target of targets) {
      if (preset === 'clear') {
        delete target.slots;
        target.layout = 'center';
      } else {
        target.layout = preset === 'premiere-3tier' ? 'premiere-3tier' : 'top-image-mid-video';
        target.slots = buildDefaultSlots(preset, target);
      }
    }
    selectedSlotId = scene.slots?.[0]?.id || null;
    markDirty();
    render();
    toast(preset === 'clear' ? '단일 레이아웃으로 초기화했습니다.' : `${applyAll ? '모든 장면에 ' : ''}레이아웃 템플릿 슬롯을 구성했습니다.`);
  }
  else if (action === 'add-slot') {
    const scene = currentScene();
    if (!scene) return;
    scene.slots ||= [];
    if (scene.slots.length >= 16) { toast('장면당 최대 16개의 레이아웃 슬롯만 추가할 수 있습니다.', true); return; }
    const role = button.dataset.role || 'html-overlay';
    const nextIdx = scene.slots.length + 1;
    const newSlot = {
      id: `slot-${id().slice(0, 8)}`,
      name: role === 'image-gen' ? `상단 이미지 슬롯 ${nextIdx}` : role === 'video-bg' ? `중단 배경 영상 ${nextIdx}` : role === 'subtitle-layer' ? `자막 레이어 ${nextIdx}` : role === 'text-overlay' ? `텍스트 레이아웃 ${nextIdx}` : `Pencil HTML 오버레이 ${nextIdx}`,
      role,
      dataBinding: role === 'image-gen' ? 'scene.imagePrompt' : role === 'video-bg' ? 'scene.videoPrompt' : role === 'subtitle-layer' ? 'scene.narration' : role === 'text-overlay' ? 'scene.title' : 'news.headline',
      x: role === 'video-bg' ? 0 : 6,
      y: role === 'image-gen' ? 5 : role === 'video-bg' ? 40 : role === 'subtitle-layer' ? 74 : 12,
      w: role === 'video-bg' ? 100 : 88,
      h: role === 'image-gen' ? 32 : role === 'video-bg' ? 60 : 18,
      zIndex: role === 'video-bg' ? 1 : role === 'image-gen' ? 2 : role === 'subtitle-layer' ? 10 : 6,
      text: role === 'subtitle-layer' ? (scene.narration || scene.text) : scene.title,
      ...(role === 'html-overlay' ? { html: `<div class="pencil-card"><span class="pencil-badge">OVERLAY</span><strong>${esc(scene.title)}</strong></div>` } : {}),
      ...(role === 'image-gen' || role === 'video-bg' ? { prompt: `${scene.title} · ${scene.text || episode.topic}` } : {}),
      style: { backgroundColor: role === 'html-overlay' ? '#173ea8' : '#111827', textColor: '#ffffff', fontSize: role === 'subtitle-layer' ? 42 : 34, opacity: 0.85, borderRadius: 8, align: 'center', badge: role === 'html-overlay' ? 'HTML' : role === 'subtitle-layer' ? 'CC' : '' },
    };
    scene.slots.push(newSlot);
    if (!['top-image-mid-video','premiere-3tier','custom'].includes(scene.layout)) scene.layout = 'custom';
    selectedSlotId = newSlot.id;
    markDirty();
    render();
  }
  else if (action === 'select-slot') {
    selectedSlotId = button.dataset.slotId;
    render();
  }
  else if (action === 'delete-slot') {
    const scene = currentScene();
    if (!scene?.slots?.length) return;
    scene.slots = scene.slots.filter(item => item.id !== button.dataset.slotId);
    if (!scene.slots.length) { delete scene.slots; scene.layout = 'center'; }
    selectedSlotId = scene.slots?.[0]?.id || null;
    markDirty();
    render();
  }
  else if (action === 'upload-slot-media') {
    pendingSlotUploadId = button.dataset.slotId || currentSlot()?.id || null;
    $('#media-file').click();
  }
  else if (action === 'remove-slot-media') {
    const slot = currentScene()?.slots?.find(item => item.id === (button.dataset.slotId || currentSlot()?.id));
    if (!slot) return;
    delete slot.assetUrl;
    slot.mediaKind = 'none';
    markDirty();
    render();
  }
  else if (action === 'open-platform-session') {
    const targetChannelId = $('#platform-session-channel')?.value || channelId;
    const targetPlatform = $('#platform-session-platform')?.value || activeChannel()?.platform?.toLowerCase();
    if (!targetChannelId || !targetPlatform || targetPlatform === 'youtube') throw new Error('YouTube는 배포 도구의 채널 연결과 최종 공개 승인을 이용하세요.');
    const targetExportUrl = $('#platform-session-export')?.value || '';
    const session = await post('/api/platform-sessions', {
      channelId: targetChannelId,
      episodeId: episode?.id,
      platform: targetPlatform,
      visibility: $('#platform-session-visibility')?.value || 'private',
      title: $('#platform-session-title')?.value || episode?.title || '',
      description: $('#platform-session-description')?.value || episode?.topic || '',
      ...(targetExportUrl ? { exportUrl: targetExportUrl } : {}),
    });
    activePlatformSessionId = session.id;
    await refreshPlatformSessions();
    render();
    toast(`${session.platform.toUpperCase()} 서버 측 비동기 브라우저 세션을 열었습니다.`);
  }
  else if (action === 'select-platform-session') {
    activePlatformSessionId = button.dataset.id;
    render();
  }
  else if (action === 'platform-session-interact') {
    const session = activePlatformSession();
    if (!session) { toast('먼저 사용 가능한 서버 브라우저 세션을 열어 주세요.', true); return; }
    const interactAction = button.dataset.interact;
    const payload = { action: interactAction };
    if (interactAction === 'navigate') payload.url = $('#platform-session-url')?.value || session.url;
    if (interactAction === 'input' || interactAction === 'click') {
      payload.selector = $('#platform-session-selector')?.value?.trim();
      if (!payload.selector) throw new Error('CSS 선택자를 입력하세요.');
      if (interactAction === 'input') payload.value = $('#platform-session-input-value')?.value || '';
    }
    if (interactAction === 'key') payload.key = $('#platform-session-key')?.value?.trim() || 'Enter';
    if (interactAction === 'scroll') {
      payload.x = Number($('#platform-session-scroll-x')?.value || 0);
      payload.y = Number($('#platform-session-scroll-y')?.value || 0);
      if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y)) throw new Error('스크롤 값은 숫자여야 합니다.');
    }
    if (interactAction === 'attach-export') {
      payload.exportUrl = button.dataset.exportUrl || $('#platform-session-export')?.value;
      payload.selector = $('#platform-session-selector')?.value?.trim() || undefined;
      if (!payload.exportUrl) throw new Error('먼저 서버 MP4를 선택하세요.');
    }
    if (interactAction === 'update-metadata') {
      payload.title = $('#platform-session-title')?.value || session.metadata?.title || episode?.title || '';
      payload.description = $('#platform-session-description')?.value || session.metadata?.description || episode?.topic || '';
      payload.visibility = $('#platform-session-visibility')?.value || session.metadata?.visibility || 'private';
      payload.channelId = $('#platform-session-channel')?.value || session.channelId || channelId || undefined;
    }
    const updated = await post(`/api/platform-sessions/${encodeURIComponent(session.id)}/interact`, payload);
    if (interactAction === 'close') activePlatformSessionId = null;
    else activePlatformSessionId = updated.id;
    await refreshPlatformSessions();
    render();
    const messages = {
      navigate: '플랫폼 페이지를 이동했습니다.', input: '서버 브라우저에 입력했습니다.', click: '서버 브라우저에서 클릭했습니다.', key: '키 입력을 전송했습니다.', scroll: '서버 브라우저를 스크롤했습니다.',
      'attach-export': '검증된 서버 MP4를 플랫폼 파일 입력에 첨부했습니다.', 'update-metadata': '플랫폼 화면에 메타데이터를 입력했습니다.', refresh: '플랫폼 브라우저 화면을 새로 고쳤습니다.', close: '플랫폼 브라우저 세션을 닫았습니다.',
    };
    toast(messages[interactAction] || '플랫폼 브라우저 세션을 갱신했습니다.');
  }
  else if (action === 'refresh-server-exports') {
    await refreshPlatformSessions();
    render();
    toast('서버 저장소(data/exports) MP4 목록을 새로고침했습니다.');
  }
  else if (action === 'scene') { const fromBin=Boolean(button.closest('.project-bin')); stopPlayback(); sceneIndex = Number(button.dataset.index); selectedSlotId = currentScene()?.slots?.[0]?.id || null; render(); $(fromBin?'.project-bin [aria-current="true"]':'.scene-card.selected')?.focus({preventScroll:true}); }
  else if (action === 'save') { await save(); render(); }
  else if (action === 'prev' || action === 'next') { stopPlayback(); sceneIndex = Math.max(0,Math.min(episode.scenes.length - 1, sceneIndex + (action === 'prev' ? -1 : 1))); render(); }
  else if (action === 'play') { if (playing) stopPlayback(); else { playing = true; playNext(); startPreviewMusic(); } render(); }
  else if (action === 'add-scene') { stopPlayback(); episode.scenes.push({id:id(),title:`장면 ${episode.scenes.length + 1}`,text:'새로운 이야기를 담아보세요',duration:5,background:'#294434',kind:'title',layout:'center'}); sceneIndex = episode.scenes.length - 1; markDirty(); render(); }
  else if (action === 'duplicate-scene') { stopPlayback(); episode.scenes.splice(sceneIndex + 1,0,{...clone(currentScene()),id:id()}); sceneIndex++; markDirty(); render(); }
  else if (action === 'delete-scene') { if (episode.scenes.length === 1) { toast('최소 한 개의 장면이 필요합니다.',true); return; } stopPlayback(); episode.scenes.splice(sceneIndex,1); sceneIndex = Math.min(sceneIndex,episode.scenes.length - 1); markDirty(); render(); }
  else if (action === 'move-left' || action === 'move-right') { const next = sceneIndex + (action === 'move-left' ? -1 : 1); if (next < 0 || next >= episode.scenes.length) return; stopPlayback(); [episode.scenes[sceneIndex],episode.scenes[next]] = [episode.scenes[next],episode.scenes[sceneIndex]]; sceneIndex = next; markDirty(); render(); }
  else if (action === 'upload-audio') $('#audio-file').click();
  else if (action === 'remove-audio') { delete currentScene().audioUrl; markDirty(); render(); }
  else if (action === 'refresh-commands') { await loadCommands(); render(); }
  else if (action === 'upload') { pendingSlotUploadId = null; $('#media-file').click(); }
  else if (action === 'remove-media') { delete currentScene().assetUrl; currentScene().kind = 'title'; markDirty(); render(); }
  else if (action === 'render') { const targetId=episode?.id; await save(true); if (!targetId || episode?.id !== targetId) throw new Error('프로젝트가 바뀌었습니다. 내보내기 대상을 다시 확인하세요.'); const job = await post(`/api/episodes/${targetId}/render`); state.jobs.push(job); render(); toast('MP4 렌더링을 시작했습니다. 아래에서 진행 상황을 확인하세요.'); }
  else if (action === 'save-template') { if (!episode) return; openModal('내 템플릿 저장', `<label>템플릿 이름<input name="name" required value="${esc(episode.title)} 템플릿"></label><label>콘텐츠 유형<select name="category">${categoryOptions(episode.category)}</select></label>`, async data => { await post('/api/templates',{...data,format:episode.format,scenes:episode.scenes}); await refresh(); render(); toast('템플릿을 저장했습니다.'); },'저장'); }
  else if (action === 'apply-template') { if (!episode) { toast('프로젝트를 먼저 만들어 주세요.',true); return; } const targetId=episode.id,templateId=button.dataset.id; await save(true); if (episode?.id !== targetId) throw new Error('프로젝트가 바뀌었습니다. 적용 대상을 다시 확인하세요.'); const result=await post(`/api/episodes/${targetId}/template`,{templateId}); cacheEpisode(result); if (reconcileEpisode(result)) { sceneIndex = 0; view = 'workflow'; } closeProjectOverlays(); await refresh(); render(); toast('템플릿 적용 기록을 저장했습니다.'); }
  else if (action === 'refresh-trends') { const result = await post('/api/trends/refresh'); await refresh(); render(); const sources = Array.isArray(result.sources) ? result.sources : Object.values(result.sources || {}); const errors = sources.filter(source => source.error || source.ok === false || source.status === 'error'); toast(errors.length ? `수집 결과를 확인하세요: ${errors.map(source => source.error || source.message || '일부 출처 연결 실패').join(' · ')}` : `${result.trends?.length || 0}개의 트렌드를 수집했습니다.`,errors.length > 0); }
  else if (action === 'trend-episode') { newEpisode(button.dataset.keyword || ''); }
  else if (action === 'trend-select') { await post('/api/trends/select',{keyword:button.dataset.keyword,selected:button.dataset.selected === 'true'}); await refresh(); render(); }
  else if (action === 'trend-popular') { await loadTrendBrowser({query:button.dataset.query}); render(); const query = $('#trend-query'); query?.focus(); }
  else if (action === 'new-reference') { openModal('연출 레퍼런스 추가', `<label>레퍼런스 제목<input name="title" required placeholder="좋은 도입부, 자막, 장면 전환"></label><label>원본 링크<input name="url" type="url" required placeholder="https://..."></label><label>콘텐츠 유형<select name="category">${categoryOptions(activeChannel()?.category)}</select></label><label>참고할 연출 요소<textarea name="notes" placeholder="구도, 템포, 색감 등 참고할 점"></textarea></label>`, async data => { await post('/api/references',{...data,channelId}); await refresh(); render(); toast('레퍼런스를 기록했습니다.'); },'기록'); }
  else if (action === 'reload-history') { const targetId=episode?.id,revision=editRevision; await refresh(); if (episode?.id===targetId && editRevision===revision) {const latest=state.episodes.find(item=>item.id===targetId);if(latest)reconcileEpisode(latest);} await loadHistory(); render(); }
  else if (action === 'refresh-knowledge') { const knowledge = await api('/api/knowledge'); state.graph = knowledge.graph || knowledge; render(); toast('최신 지식을 불러왔습니다.'); }
  else if (action === 'refresh-integrations') { state.integrations = await api('/api/integrations'); render(); toast('연결 상태를 확인했습니다.'); }
}

function contextMenuAnchor(target) {
  if (target.closest('#workflow-host')) return null;
  return target.closest('[data-action="project-menu"],[data-action="episode-menu"],[data-action="channel-menu"],[data-action="tool-menu"],[data-action="project-tools"],[data-action="sidebar-menu"]') || target.closest('.project-row')?.querySelector('.project-more') || target.closest('#project-navigation')?.querySelector('[data-action="project-menu"]') || target.closest('#project-tool-dialog')?.querySelector('[data-action="tool-menu"]') || target.closest('.sidebar')?.querySelector('[data-action="sidebar-menu"]');
}
document.addEventListener('contextmenu',event=>{
  const anchor = contextMenuAnchor(event.target);
  if (!anchor) return;
  event.preventDefault(); openProjectMenu(anchor,event);
});
document.addEventListener('keydown',event=>{
  if (!(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return;
  const anchor = contextMenuAnchor(event.target);
  if (!anchor) return;
  event.preventDefault(); openProjectMenu(anchor);
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || busy) return;
  busy = true;
  if (!readActions.has(button.dataset.action)) button.disabled = true;
  try { await handleAction(button); }
  catch (error) { toast(error.status === 409 ? '다른 작업에서 이 에피소드가 수정되었습니다. 현재 편집은 보존했습니다. 페이지를 다시 열기 전에 편집 내용을 복사해 주세요.' : error.message,true); }
  finally { busy = false; if (button.isConnected && !readActions.has(button.dataset.action)) { button.disabled = false; applySessionControls(); applyProjectControls(); updateSaveStatus(); } }
});

document.addEventListener('change',async event=>{
  if (event.target.id === 'platform-session-picker') { activePlatformSessionId = event.target.value || null; render(); return; }
  if (event.target.id === 'project-stage') {
    const nodeId = event.target.value;
    if (!projectContext().workflow?.nodes.some(node => node.id === nodeId)) return;
    workflowEditor.selectNode(nodeId);
    return;
  }
  if (event.target.id === 'project-episode' || event.target.id === 'wf-episode') {
    const targetId = event.target.value;
    if (targetId === episode?.id) return;
    const target = state.episodes.find(item => item.id === targetId);
    stopPlayback();
    closeProjectOverlays();
    switchEpisode(target || null);
    if (view === 'workflow') { await workflowEditor.load(); bindWorkflowProject(); }
    render(); $('#main')?.focus(); return;
  }
  if (event.target.id!=='history-episode') return;
  const targetId=event.target.value;
  try {stopPlayback();switchEpisode(state.episodes.find(item=>item.id===targetId) || null);await loadHistory();render();}
  catch(error) {event.target.value=episode?.id || '';toast(error.message,true);}
});

document.addEventListener('focusout', () => queueMicrotask(syncProjectToolsContext));

document.addEventListener('input', event => {
  const target = event.target;
  if (target.matches('[data-scene],[data-caption],[data-music],[data-music-source],[data-episode],[data-slot-field],[data-slot-style]') && projectEditReason()) return;
  if (target.id === 'speech-voice') { speechVoice=target.value; return; }
  if (target.id === 'speech-rate') { if (target.checkValidity() && target.value !== '') speechRate=Number(target.value); return; }
  if (target.dataset.music && episode) {
    const key=target.dataset.music;
    if (key==='assetUrl') {
      const value=target.value;
      if (!value) episode.music=null;
      else if (episode.music?.assetUrl!==value) episode.music={assetUrl:value,start:0,trimStart:0,volume:1,source:{origin:''}};
      for (const input of document.querySelectorAll('[data-music]:not([data-music="assetUrl"]),[data-music-source]')) {
        const field=input.dataset.music,sourceKey=input.dataset.musicSource;
        input.value=field ? String(episode.music?.[field] ?? (field==='volume'?1:0)) : String(episode.music?.source?.[sourceKey] || '');
      }
    } else if (episode.music && ['start','trimStart','volume'].includes(key)) episode.music[key]=target.value==='' ? '' : Number(target.value);
    else return;
    markDirty(); if (playing) startPreviewMusic(); return;
  }
  if (target.dataset.musicSource && episode?.music) { episode.music.source ||= {}; episode.music.source[target.dataset.musicSource]=target.value; markDirty(); return; }
  if (target.dataset.caption && currentScene()) {
    const index=Number(target.dataset.captionIndex),cue=currentScene().captions?.[index],key=target.dataset.caption;
    if (!cue || !['start','end','text'].includes(key)) return;
    cue[key]=key==='text' ? target.value : target.value==='' ? '' : Number(target.value);
    markDirty(); return;
  }
  if (target.dataset.slotField && currentSlot()) {
    const slot = currentSlot();
    const key = target.dataset.slotField;
    if (['x','y','w','h','zIndex'].includes(key)) {
      if (!target.checkValidity() || target.value === '') return;
      slot[key] = Number(target.value);
    } else {
      slot[key] = target.value;
    }
    markDirty();
    return;
  }
  if (target.dataset.slotStyle && currentSlot()) {
    const slot = currentSlot();
    slot.style ||= {};
    const key = target.dataset.slotStyle;
    if (['fontSize','opacity','borderRadius'].includes(key)) {
      if (!target.checkValidity() || target.value === '') return;
      slot.style[key] = Number(target.value);
    } else {
      slot.style[key] = target.value;
    }
    markDirty();
    return;
  }
  if (target.dataset.scene && currentScene()) {
    if (['duration','trimStart','audioVolume'].includes(target.dataset.scene)) { if (!target.checkValidity() || target.value === '') return; currentScene()[target.dataset.scene] = Number(target.value); }
    else currentScene()[target.dataset.scene] = target.value;
    markDirty();
  } else if (target.dataset.episode && episode) { episode[target.dataset.episode] = target.value; markDirty(); }
});

document.addEventListener('submit', async event => {
  if (!['chat-form','trend-form','trend-settings-form','trend-search-form','command-form'].includes(event.target.id)) return;
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const button = $('button[type="submit"]',form);
  button.disabled = true;
  try {
    if (form.id === 'chat-form') requireProjectEdit();
    if (form.id === 'command-form') { await post('/api/commands',{message:data.message,source:'web'}); await loadCommands(); render(); }
    else if (form.id === 'trend-form') { await post('/api/trends',data); await refresh(); render(); toast('키워드를 기록했습니다.'); }
    else if (form.id === 'trend-settings-form') {
      const intervalHours = Number(data.intervalHours);
      if (!Number.isSafeInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) throw new Error('수집 주기는 1~168시간이어야 합니다.');
      await api('/api/trends/settings',{method:'PUT',body:JSON.stringify({enabled:data.enabled === 'on',intervalMs:intervalHours * 60 * 60 * 1000})});
      await refresh(); render(); toast('트렌드 수집 설정을 저장했습니다.');
    }
    else if (form.id === 'trend-search-form') { await loadTrendBrowser({query:data.query || ''}); render(); }
    else {
      const requestId = episode?.id;
      await save(true);
      if (!requestId || episode?.id !== requestId) throw new Error('프로젝트가 바뀌었습니다. 어시스턴트 대상을 다시 확인하세요.');
      const revision = editRevision;
      const messages = chatLogs.get(requestId) || [];
      messages.push({role:'user',text:data.message});
      chatLogs.set(requestId,messages);
      const result = await post(`/api/episodes/${requestId}/chat`,data);
      messages.push({role:'assistant',agent:data.agent.toUpperCase(),text:result.message});
      if (result.episode) {
        cacheEpisode(result.episode);
        if (episode?.id === requestId && editRevision === revision && reconcileEpisode(result.episode)) sceneIndex = 0;
        else if (episode?.id === requestId) toast('에이전트 작업 중 직접 편집한 내용과 원본 버전을 보존했습니다. 에이전트 결과는 제작 히스토리에서 확인하세요.');
      }
      if (episode?.id === requestId) {
        const message = $('#chat-form [name="message"]');
        if (message?.value === data.message) message.value = '';
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
  const targetSlotId = pendingSlotUploadId;
  pendingSlotUploadId = null;
  if (!file || !selectedScene) return;
  try {
    requireProjectEdit(selectedEpisode);
    if (targetSlotId && !currentScene()?.slots?.some(slot=>slot.id === targetSlotId)) throw new Error('업로드 대상 슬롯이 없어졌습니다. 현재 장면에서 슬롯을 다시 선택하세요.');
    toast('미디어를 업로드하는 중입니다…');
    const asset = await api(`/api/uploads?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':file.type || 'application/octet-stream'},body:file});
    if (episode?.id !== selectedEpisode) { toast('업로드했습니다. 선택한 에피소드가 바뀌어 장면에는 적용하지 않았습니다.',true); return; }
    requireProjectEdit(selectedEpisode);
    const scene = episode.scenes.find(item => item.id === selectedScene);
    if (!scene) throw new Error('업로드는 완료했지만 대상 장면이 없어 연결하지 않았습니다. 소스 도구에서 업로드 파일을 확인하세요.');
    const mediaKind = file.type.startsWith('video/') ? 'video' : 'image';
    if (targetSlotId) {
      const slot = scene.slots?.find(item => item.id === targetSlotId);
      if (!slot) throw new Error('업로드는 완료했지만 대상 슬롯이 없어 연결하지 않았습니다. 소스 도구에서 업로드 파일을 확인하세요.');
      slot.assetUrl = asset.url;
      slot.mediaKind = mediaKind;
      selectedSlotId = slot.id;
      markDirty();
      render();
      toast(`미디어를 '${slot.name}' 레이아웃 슬롯에 연결했습니다. 변경 저장을 눌러 보관하세요.`);
      return;
    }
    scene.assetUrl = asset.url;
    scene.kind = mediaKind;
    markDirty();
    render();
    toast('미디어를 장면에 추가했습니다. 변경 저장을 눌러 보관하세요.');
  } catch (error) { toast(error.message,true); }
  finally { event.target.value = ''; }
});

let slotDrag = null;
document.addEventListener('pointerdown', event => {
  const slotEl = event.target.closest('.preview-slot[data-slot-id]');
  const preview = $('#preview');
  if (!slotEl || !preview || event.button !== 0 || projectEditReason()) return;
  const scene = currentScene();
  const slot = scene?.slots?.find(item => item.id === slotEl.dataset.slotId);
  if (!slot) return;
  event.preventDefault();
  const resizeHandle = event.target.closest('.slot-resize-handle');
  selectedSlotId = slot.id;
  const rect = preview.getBoundingClientRect();
  slotDrag = {
    pointerId: event.pointerId,
    mode: resizeHandle ? 'resize' : 'move',
    slotId: slot.id,
    startX: event.clientX,
    startY: event.clientY,
    rectW: Math.max(1, rect.width),
    rectH: Math.max(1, rect.height),
    origX: Number(slot.x) || 0,
    origY: Number(slot.y) || 0,
    origW: Number(slot.w) || 50,
    origH: Number(slot.h) || 25,
    moved: false,
  };
  slotEl.setPointerCapture?.(event.pointerId);
});
document.addEventListener('pointermove', event => {
  if (!slotDrag || event.pointerId !== slotDrag.pointerId) return;
  const scene = currentScene();
  const slot = scene?.slots?.find(item => item.id === slotDrag.slotId);
  if (!slot) return;
  const dxPct = ((event.clientX - slotDrag.startX) / slotDrag.rectW) * 100;
  const dyPct = ((event.clientY - slotDrag.startY) / slotDrag.rectH) * 100;
  if (Math.abs(dxPct) < 0.2 && Math.abs(dyPct) < 0.2 && !slotDrag.moved) return;
  slotDrag.moved = true;
  if (slotDrag.mode === 'resize') {
    slot.w = Math.round(Math.max(5, Math.min(100 - slot.x, slotDrag.origW + dxPct)));
    slot.h = Math.round(Math.max(5, Math.min(100 - slot.y, slotDrag.origH + dyPct)));
  } else {
    slot.x = Math.round(Math.max(0, Math.min(100 - slot.w, slotDrag.origX + dxPct)));
    slot.y = Math.round(Math.max(0, Math.min(100 - slot.h, slotDrag.origY + dyPct)));
  }
  markDirty();
});
document.addEventListener('pointerup', event => {
  if (!slotDrag || event.pointerId !== slotDrag.pointerId) return;
  const wasMoved = slotDrag.moved;
  slotDrag = null;
  if (wasMoved || sceneEditorOpen) render();
});

// --- Knowledge graph: pointer pan/drag and keyboard pan/move. Session-only view state; never touches graph data. ---
document.addEventListener('pointerdown', event => {
  const svg = event.target.closest('#knowledge-graph-svg');
  if (!svg || event.button !== 0 || graphDrag || !event.isPrimary) return;
  const nodeEl = event.target.closest('.graph-node');
  if (nodeEl) {
    const nodeId = nodeEl.dataset.nodeId;
    const positions = currentGraphPositions(graphVisibleNodes());
    const origin = positions.get(nodeId);
    if (!origin) return;
    const hadOverride = graphNodePositions.has(nodeId);
    graphDrag = {type:'node', pointerId:event.pointerId, nodeId, startX:event.clientX, startY:event.clientY, originX:origin.x, originY:origin.y, hadOverride, origOverride: hadOverride ? {...graphNodePositions.get(nodeId)} : null, origLayout:new Map([...graphLayoutPositions].map(([id,position]) => [id,{...position}])), origLastMovedId:graphLastMovedId, moved:false, scaleEl:graphWorldEl()};
  } else {
    graphDrag = {type:'pan', pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, originPan:{...graphPan}, moved:false, scaleEl:svg};
  }
  try { svg.setPointerCapture?.(event.pointerId); } catch { /* Pointer already released (e.g. synthetic test dispatch); drag state above still applies. */ }
});
document.addEventListener('pointermove', event => {
  if (!graphDrag || event.pointerId !== graphDrag.pointerId) return;
  const dxScreen = event.clientX - graphDrag.startX, dyScreen = event.clientY - graphDrag.startY;
  if (!graphDrag.moved && Math.hypot(dxScreen,dyScreen) < 4) return;
  graphDrag.moved = true;
  event.preventDefault();
  if (graphDrag.type === 'node') {
    document.querySelector(`[data-node-id="${CSS.escape(graphDrag.nodeId)}"]`)?.classList.add('dragging');
    const {dx,dy} = graphDeltaToLocal(graphDrag.scaleEl, dxScreen, dyScreen);
    graphNodePositions.set(graphDrag.nodeId, graphClampXY({x: graphDrag.originX + dx, y: graphDrag.originY + dy}));
    graphLayoutPositions.set(graphDrag.nodeId, {...graphNodePositions.get(graphDrag.nodeId)});
    graphLastMovedId = graphDrag.nodeId;
    if (graphDragRaf) return;
    graphDragRaf = requestAnimationFrame(() => { graphDragRaf = 0; graphPatchNodePositions(); });
  } else {
    const {dx,dy} = graphDeltaToLocal(graphDrag.scaleEl, dxScreen, dyScreen);
    graphPan = {x: graphDrag.originPan.x + dx, y: graphDrag.originPan.y + dy};
    if (graphDragRaf) return;
    graphDragRaf = requestAnimationFrame(() => { graphDragRaf = 0; graphPatchTransform(); });
  }
});
function finishGraphDrag(commit) {
  if (!graphDrag) return;
  if (graphDragRaf) { cancelAnimationFrame(graphDragRaf); graphDragRaf = 0; }
  document.querySelector('.graph-node.dragging')?.classList.remove('dragging');
  if (graphDrag.type === 'node') {
    if (!commit) { if (graphDrag.hadOverride) graphNodePositions.set(graphDrag.nodeId, graphDrag.origOverride); else graphNodePositions.delete(graphDrag.nodeId); graphLayoutPositions.clear(); for (const [id,position] of graphDrag.origLayout) graphLayoutPositions.set(id,position); graphLastMovedId = graphDrag.origLastMovedId; graphPatchNodePositions(); }
    else if (graphDrag.moved) { graphLiveMessage = `${graphNodeLabelById(graphDrag.nodeId)} 위치를 이동했습니다.`; graphPatchNodePositions(); }
    else { graphToggleNodeSelection(graphDrag.nodeId); }
  } else {
    if (!commit) { graphPan = graphDrag.originPan; graphPatchTransform(); }
    else if (graphDrag.moved) { graphPatchTransform(); }
    else { graphDeselectNode(); }
  }
  graphDrag = null;
}
document.addEventListener('pointerup', event => { if (graphDrag && event.pointerId === graphDrag.pointerId) finishGraphDrag(true); });
document.addEventListener('pointercancel', event => { if (graphDrag && event.pointerId === graphDrag.pointerId) finishGraphDrag(false); });
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const nodeEl = event.target.closest?.('.graph-node');
  if (nodeEl) {
    const nodeId = nodeEl.dataset.nodeId;
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) { event.preventDefault(); const delta={ArrowLeft:[-GRAPH_NODE_STEP,0],ArrowRight:[GRAPH_NODE_STEP,0],ArrowUp:[0,-GRAPH_NODE_STEP],ArrowDown:[0,GRAPH_NODE_STEP]}[event.key]; graphMoveNode(nodeId,delta[0],delta[1]); return; }
    if (event.key === 'Home') { event.preventDefault(); graphResetNode(nodeId); return; }
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); graphToggleNodeSelection(nodeId); return; }
    if (event.key === 'Escape') { event.preventDefault(); graphDeselectNode(); graphSvgEl()?.focus(); return; }
    return;
  }
  if (event.target === graphSvgEl()) {
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) { event.preventDefault(); const delta={ArrowLeft:[GRAPH_PAN_STEP,0],ArrowRight:[-GRAPH_PAN_STEP,0],ArrowUp:[0,GRAPH_PAN_STEP],ArrowDown:[0,-GRAPH_PAN_STEP]}[event.key]; graphPanBy(delta[0],delta[1]); return; }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); graphApplyZoom(graphZoom * GRAPH_ZOOM_STEP); return; }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); graphApplyZoom(graphZoom / GRAPH_ZOOM_STEP); return; }
    if (event.key === '0') { event.preventDefault(); graphResetView(); return; }
  }
});

$('#audio-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  const selectedEpisode = episode?.id;
  const selectedScene = currentScene()?.id;
  if (!file || !selectedScene) return;
  try {
    requireProjectEdit(selectedEpisode);
    toast('오디오를 업로드하는 중입니다…');
    const asset = await api(`/api/uploads?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':file.type || 'application/octet-stream'},body:file});
    if (episode?.id !== selectedEpisode) { toast('오디오 업로드는 완료했지만 선택한 에피소드가 바뀌어 적용하지 않았습니다.',true); return; }
    requireProjectEdit(selectedEpisode);
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

window.addEventListener('beforeunload', event => { if (anyStudioDraftDirty() || workflowEditor.hasAnyChanges?.() || workflowEditor.hasChanges()) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', async event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); try { if (sceneEditorOpen && $('#project-scene-dialog')?.open) await save(); else await workflowEditor.save(); render(); } catch (error) { toast(error.message,true); } } });

setInterval(async () => {
  if (!authenticated || polling || ![...(state.jobs || []),...(state.narrationJobs || []),...(state.workflowRuns || []),...(state.generationJobs || [])].some(job => ['running','queued','pending','submitting','polling','in_progress','downloading'].includes(job.status))) return;
  polling=true;
  try {
    const activeNarrations = new Set((state.narrationJobs || []).filter(job => ['queued','running'].includes(job.status)).map(job => job.id));
    const latest = await api('/api/state');
    state.jobs = latest.jobs || [];
    state.narrationJobs = latest.narrationJobs || [];
    state.workflowRuns = latest.workflowRuns || [];
    state.generationJobs = latest.generationJobs || [];
    for (const job of state.narrationJobs) {
      if (activeNarrations.has(job.id) && job.status === 'completed' && !completedNarrations.has(job.id)) { completedNarrations.add(job.id); applyNarrationResult(job,latest); }
    }
    if ($('#jobs')) $('#jobs').innerHTML = jobsHtml();
    if ($('#narration-status')) $('#narration-status').innerHTML = narrationStatusHtml();
    for (const button of document.querySelectorAll('[data-action="narrate-scene"],[data-action="narrate-all"]')) button.disabled = !speech.available || !speechVoice || ['queued','running'].includes(narrationJob()?.status);
    applyProjectControls(); syncProjectToolsContext();
  } catch { /* Foreground actions report errors; job polling preserves the current draft. */ }
  finally { polling=false; }
},2500);

try { await initializeWorkbench(); }
catch (error) { if (error.status !== 401) showWorkbenchLoadFailure(error); }

setInterval(() => { if (authenticated && activeTool==='overview' && !busy) operations.reload(true); },30000);
