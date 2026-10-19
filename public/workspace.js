import {WORKSPACE_PRESETS, normalizeLayout, createWorkspaceStore, createOpsStore, OPS_COLUMNS, opsQueue, opsDeliverables, opsJobGroups} from './workspace-state.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const TOOLS = {inspector:'장면 편집', narration:'내레이션', assistant:'제작 어시스턴트'};
const NAVIGATION_ACTIONS = new Set(['view','channel','episode','scene','prev','next','add-scene','duplicate-scene','delete-scene','move-left','move-right','apply-template','load-narration-result','restore-episode','open-generation']);

export function createWorkspaceLayout({toast = () => {}} = {}) {
  const store = createWorkspaceStore();
  let root = null;
  let currentView = null;
  let bindings = null;
  let observer = null;
  let frame = 0;
  let activeTool = null;
  let settingsOpener = null;
  let pending = null;
  let navigated = false;
  let drag = null;
  let lastStorageError = null;

  const $ = selector => root?.querySelector(selector);
  const sourcePanel = tool => tool === 'assistant' ? $('#chat-form')?.closest('section.panel') : tool === 'narration' ? $('.narration-panel') : $('.right-column .inspector');
  const contextKey = tool => `${currentView}:${$('.episode-tab.selected')?.dataset.id || ''}:${tool === 'assistant' ? '' : $('.scene-card.selected')?.dataset.sceneId || ''}`;
  const fieldList = panel => [...panel.querySelectorAll('input:not([type="file"]), textarea, select')];

  function capturePanel(panel) {
    const fields = fieldList(panel);
    const focused = fields.indexOf(document.activeElement);
    return {
      fields:fields.map(field => ({value:field.value, checked:field.checked, preserve:panel.id === 'workspace-settings-dialog' || Boolean(field.closest('#chat-form'))})),
      details:[...panel.querySelectorAll('details')].map(item => item.open),
      focused,
      start:focused < 0 ? null : fields[focused].selectionStart,
      end:focused < 0 ? null : fields[focused].selectionEnd,
      direction:focused < 0 ? null : fields[focused].selectionDirection,
      scrollTop:panel.scrollTop,
    };
  }

  function restorePanel(panel, snapshot) {
    if (!snapshot) return;
    const fields = fieldList(panel);
    fields.forEach((field, index) => {
      const saved = snapshot.fields[index];
      if (!saved?.preserve) return;
      if (field.type === 'checkbox' || field.type === 'radio') field.checked = saved.checked;
      else if (field.tagName !== 'SELECT' || [...field.options].some(option => option.value === saved.value)) field.value = saved.value;
    });
    [...panel.querySelectorAll('details')].forEach((item, index) => { if (index < snapshot.details.length) item.open = snapshot.details[index]; });
    panel.scrollTop = snapshot.scrollTop;
    const focused = fields[snapshot.focused];
    if (focused) {
      focused.focus({preventScroll:true});
      if (snapshot.start !== null && typeof focused.setSelectionRange === 'function') focused.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction || 'none');
    }
  }

  function profilesHtml() {
    const state = store.getState();
    return `<option value="">저장된 프로필 선택</option>${state.profiles.map(profile => `<option value="${esc(profile.id)}" ${state.activeProfileId === profile.id ? 'selected' : ''}>${esc(profile.name)}</option>`).join('')}`;
  }

  function html(content, view) {
    currentView = view;
    const {layout} = store.getState();
    const dimension = (id, label, value, min, max) => `<label for="${id}">${label}<input id="${id}" type="number" min="${min}" max="${max}" step="1" required value="${value}"></label>`;
    return `<section class="personal-workspace" data-workspace-view="${esc(view)}" data-workspace-sizing="${layout.width === null ? 'auto' : 'custom'}" data-workspace-tool-mode="${layout.toolsMode}" aria-label="개인 작업 창">
      <div class="workspace-layout-bar"><label for="workspace-template">작업 창 <select id="workspace-template" aria-label="작업 창 프리셋">${WORKSPACE_PRESETS.map(preset => `<option value="${preset.id}" ${layout.presetId === preset.id ? 'selected' : ''}>${preset.name}</option>`).join('')}<option value="custom" ${layout.presetId === 'custom' ? 'selected' : ''}>사용자 지정</option></select></label><output class="workspace-dimension-status" id="workspace-dimension-status" aria-live="polite"></output><div class="row"><button type="button" class="small" data-workspace-action="settings" aria-haspopup="dialog" aria-controls="workspace-settings-dialog">작업 창 설정</button>${Object.entries(TOOLS).map(([tool, name]) => `<button type="button" class="small quiet" data-workspace-action="tool" data-workspace-tool="${tool}" aria-haspopup="dialog" aria-controls="workspace-tool-dialog" aria-expanded="false" ${view !== 'studio' ? 'hidden' : ''}>${name}</button>`).join('')}</div></div>
      <div class="workspace-window" id="workspace-window"><div class="workspace-window-content">${content}</div><button type="button" class="workspace-resize-handle" aria-label="작업 창 크기 조절" aria-describedby="workspace-resize-help workspace-dimension-status"><span id="workspace-resize-help">드래그 또는 방향키로 크기 조절 · Shift: 크게 조절</span></button></div>
      <dialog class="workspace-settings-dialog" id="workspace-settings-dialog" aria-labelledby="workspace-settings-title"><div class="workspace-dialog-header"><div><h2 id="workspace-settings-title">나의 작업 창</h2><p>이 브라우저에만 저장됩니다. 계정이나 서버에 동기화하지 않습니다.</p></div><button type="button" class="icon-btn quiet" data-workspace-action="close-settings" aria-label="작업 창 설정 닫기">×</button></div><div class="workspace-dialog-body"><form id="workspace-settings-form"><fieldset><legend>사용자 지정 크기</legend><div class="two-cols">${dimension('workspace-width','창 너비 (px)',layout.width || 1280,320,2560)}${dimension('workspace-height','창 높이 (px)',layout.height || 800,320,1800)}</div>${dimension('workspace-inspector-width','도구 열 너비 (px)',layout.inspectorWidth,240,480)}<label for="workspace-tools-mode">도구 표시<select id="workspace-tools-mode"><option value="docked" ${layout.toolsMode === 'docked' ? 'selected' : ''}>작업 창에 고정</option><option value="overlay" ${layout.toolsMode === 'overlay' ? 'selected' : ''}>필요할 때 대화상자로 열기</option></select></label><p class="hint">숫자를 변경하면 즉시 적용됩니다. 작은 화면에서는 실제 크기만 줄어들며 원하는 크기는 유지됩니다.</p></fieldset><button type="button" data-workspace-action="reset">자동 맞춤으로 초기화</button></form><form class="workspace-profile-form" id="workspace-profile-form"><label for="workspace-profile-select">저장된 브라우저 프로필<select id="workspace-profile-select">${profilesHtml()}</select></label><div class="row"><label for="workspace-profile-name">새 프로필 이름<input id="workspace-profile-name" maxlength="40" required placeholder="예: 집중 편집" autocomplete="off"></label><button type="submit" data-workspace-action="save-profile">프로필 저장</button></div><p class="hint">최대 12개 · 같은 이름은 중복 저장할 수 없습니다. 초기화해도 저장된 프로필은 유지됩니다.</p></form><p class="hint" id="workspace-storage-status" role="status" aria-live="polite"></p></div></dialog>
      <dialog class="workspace-tool-dialog" id="workspace-tool-dialog" aria-labelledby="workspace-tool-title"><div class="workspace-dialog-header"><div><h2 id="workspace-tool-title">작업 도구</h2><p>현재 에피소드의 실제 편집 도구입니다.</p></div><button type="button" class="icon-btn quiet" data-workspace-action="close-tool" aria-label="작업 도구 닫기">×</button></div><div class="workspace-dialog-body" id="workspace-tool-body"></div></dialog>
    </section>`;
  }

  function measure() {
    const windowNode = $('#workspace-window');
    if (!windowNode) return;
    const available = `${Math.max(1, window.innerHeight - windowNode.getBoundingClientRect().top - 24)}px`;
    if (windowNode.style.getPropertyValue('--workspace-available-height') !== available) windowNode.style.setProperty('--workspace-available-height', available);
    const rect = windowNode.getBoundingClientRect();
    const layout = drag?.layout || store.getState().layout;
    const status = $('#workspace-dimension-status');
    const text = layout.width === null ? `자동 맞춤 · 실제 ${Math.round(rect.width)} × ${Math.round(rect.height)} px` : `원하는 크기 ${layout.width} × ${layout.height} · 실제 ${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
    if (status && status.textContent !== text) status.textContent = text;
  }

  function scheduleMeasure() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  }

  function applyLayout(layout = store.getState().layout) {
    if (!root) return;
    root.dataset.workspaceSizing = layout.width === null ? 'auto' : 'custom';
    root.dataset.workspaceToolMode = layout.toolsMode;
    const windowNode = $('#workspace-window');
    windowNode.style.setProperty('--workspace-width', `${layout.width || 1280}px`);
    windowNode.style.setProperty('--workspace-height', `${layout.height || 800}px`);
    root.style.setProperty('--workspace-inspector-width', `${layout.inspectorWidth}px`);
    const values = {'workspace-template':layout.presetId,'workspace-width':layout.width || 1280,'workspace-height':layout.height || 800,'workspace-inspector-width':layout.inspectorWidth,'workspace-tools-mode':layout.toolsMode};
    for (const [id, value] of Object.entries(values)) {
      const input = $(`#${id}`);
      if (input && input !== document.activeElement) input.value = value;
    }
    measure();
  }

  function notifyStorage() {
    const {storageError} = store.getState();
    const status = $('#workspace-storage-status');
    if (status) status.textContent = storageError || '작업 창 설정과 프로필은 이 브라우저에 저장됩니다.';
    if (storageError && storageError !== lastStorageError) toast(storageError, true);
    lastStorageError = storageError;
  }

  function closeTool(restoreFocus = true) {
    if (!activeTool) return;
    const {panel, placeholder, opener, dialog} = activeTool;
    activeTool = null;
    placeholder.replaceWith(panel);
    if (dialog.open) dialog.close();
    for (const button of root?.querySelectorAll('[data-workspace-action="tool"]') || []) button.setAttribute('aria-expanded','false');
    if (restoreFocus && opener?.isConnected) opener.focus({preventScroll:true});
  }

  function openTool(tool, opener, snapshot) {
    const panel = sourcePanel(tool);
    if (!panel || !Object.hasOwn(TOOLS, tool)) return;
    navigated = false;
    closeTool(false);
    const dialog = $('#workspace-tool-dialog');
    const placeholder = document.createComment(`workspace-${tool}`);
    panel.before(placeholder);
    $('#workspace-tool-body').append(panel);
    $('#workspace-tool-title').textContent = TOOLS[tool];
    activeTool = {tool, panel, placeholder, opener, dialog};
    opener?.setAttribute('aria-expanded','true');
    dialog.showModal();
    restorePanel(panel, snapshot);
  }

  function closeSettings(restoreFocus = true) {
    const dialog = $('#workspace-settings-dialog');
    if (dialog?.open) dialog.close();
    if (restoreFocus && settingsOpener?.isConnected) settingsOpener.focus({preventScroll:true});
    settingsOpener = null;
  }

  function beforeRender(preserve = true) {
    const context = contextKey(activeTool?.tool);
    pending = preserve && activeTool && !navigated ? {kind:'tool',tool:activeTool.tool,view:currentView,context,snapshot:capturePanel(activeTool.panel)} : null;
    const settings = $('#workspace-settings-dialog');
    if (preserve && settings?.open && !navigated) pending = {kind:'settings',view:currentView,context,snapshot:capturePanel(settings)};
    closeTool(false);
    closeSettings(false);
    if (drag) { drag = null; }
    bindings?.abort();
    observer?.disconnect();
    cancelAnimationFrame(frame);
    root = null;
  }

  function finishDrag(event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const current = drag;
    drag = null;
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    if (!current.moved || event?.type === 'pointercancel') applyLayout();
    else store.setLayout(current.layout);
  }

  function startDrag(event) {
    if (event.button !== 0) return;
    const handle = event.target.closest('.workspace-resize-handle');
    if (!handle) return;
    event.preventDefault();
    const rect = $('#workspace-window').getBoundingClientRect();
    const layout = store.getState().layout;
    drag = {pointerId:event.pointerId,handle,x:event.clientX,y:event.clientY,width:rect.width,height:rect.height,preferredWidth:layout.width ?? rect.width,preferredHeight:layout.height ?? rect.height,layout,moved:false};
    handle.focus({preventScroll:true});
    handle.setPointerCapture(event.pointerId);
  }

  function onClick(event) {
    const button = event.target.closest('[data-workspace-action]');
    if (!button || !root.contains(button)) return;
    const action = button.dataset.workspaceAction;
    if (action === 'save-profile') return;
    event.preventDefault();
    if (action === 'settings') {
      navigated = false;
      closeTool(false);
      settingsOpener = button;
      $('#workspace-settings-dialog').showModal();
    } else if (action === 'close-settings') closeSettings();
    else if (action === 'tool') openTool(button.dataset.workspaceTool, button);
    else if (action === 'close-tool') closeTool();
    else if (action === 'reset') store.reset();
  }

  function onChange(event) {
    const input = event.target;
    try {
      if (input.id === 'workspace-template') {
        if (input.value === 'custom') {
          const rect = $('#workspace-window').getBoundingClientRect();
          store.setLayout({presetId:'custom', width:Math.round(rect.width), height:Math.round(rect.height)});
        } else store.selectPreset(input.value);
      } else if (input.id === 'workspace-tools-mode') store.setLayout({toolsMode:input.value});
      else if (input.id === 'workspace-profile-select' && input.value) store.selectProfile(input.value);
      else {
        const key = {'workspace-width':'width','workspace-height':'height','workspace-inspector-width':'inspectorWidth'}[input.id];
        if (!key) return;
        if (!input.checkValidity() || input.value === '') { input.reportValidity(); return; }
        store.setLayout({[key]:Number(input.value), ...(key === 'inspectorWidth' ? {} : {presetId:'custom'})});
      }
    } catch (error) { toast(error.message, true); }
  }

  function onSubmit(event) {
    if (!['workspace-settings-form','workspace-profile-form'].includes(event.target.id)) return;
    event.preventDefault();
    if (event.target.id !== 'workspace-profile-form') return;
    try {
      store.saveProfile($('#workspace-profile-name').value);
      $('#workspace-profile-name').value = '';
      if (!store.getState().storageError) toast('이 브라우저에 작업 창 프로필을 저장했습니다.');
    } catch (error) { toast(error.message, true); }
  }

  function onKeydown(event) {
    const handle = event.target.closest('.workspace-resize-handle');
    if ((handle || event.target.closest('.workspace-settings-dialog')) && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); }
    if (!handle || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const rect = $('#workspace-window').getBoundingClientRect();
    const layout = store.getState().layout;
    const step = event.shiftKey ? 64 : 16;
    store.setLayout({presetId:'custom',width:(layout.width || Math.round(rect.width)) + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),height:(layout.height || Math.round(rect.height)) + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)});
  }

  function noteNavigation(event) {
    if (event.target.closest('[data-workspace-action]')) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (NAVIGATION_ACTIONS.has(action)) { navigated = true; pending = null; closeTool(false); closeSettings(false); }
  }

  function mount() {
    root = document.querySelector('.personal-workspace');
    if (!root) { pending = null; return; }
    currentView = root.dataset.workspaceView;
    bindings = new AbortController();
    const {signal} = bindings;
    root.addEventListener('click', onClick, {signal});
    root.addEventListener('change', onChange, {signal});
    root.addEventListener('submit', onSubmit, {signal});
    root.addEventListener('keydown', onKeydown, {signal});
    root.addEventListener('pointerdown', startDrag, {signal});
    root.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (event.clientX === drag.x && event.clientY === drag.y && !drag.moved) return;
      drag.moved = true;
      drag.layout = normalizeLayout({...drag.layout,presetId:'custom',width:event.clientX === drag.x ? drag.preferredWidth : drag.width + event.clientX - drag.x,height:event.clientY === drag.y ? drag.preferredHeight : drag.height + event.clientY - drag.y});
      applyLayout(drag.layout);
    }, {signal});
    root.addEventListener('pointerup', finishDrag, {signal});
    root.addEventListener('pointercancel', finishDrag, {signal});
    root.addEventListener('lostpointercapture', event => { if (drag?.pointerId === event.pointerId) finishDrag(event); }, {signal});
    const toolDialog = $('#workspace-tool-dialog');
    toolDialog.addEventListener('cancel', event => { event.preventDefault(); closeTool(); }, {signal});
    toolDialog.addEventListener('close', () => { if (activeTool?.dialog === toolDialog && !toolDialog.open) closeTool(); }, {signal});
    $('#workspace-settings-dialog').addEventListener('cancel', event => { event.preventDefault(); closeSettings(); }, {signal});
    for (const button of root.querySelectorAll('[data-workspace-action="tool"]')) button.disabled = !sourcePanel(button.dataset.workspaceTool);
    applyLayout();
    notifyStorage();
    observer = new ResizeObserver(scheduleMeasure);
    observer.observe(root);
    observer.observe($('#workspace-window'));
    if (pending && !navigated && pending.view === currentView && pending.context === contextKey(pending.tool)) {
      if (pending.kind === 'tool') openTool(pending.tool, $(`[data-workspace-tool="${pending.tool}"]`), pending.snapshot);
      else {
        settingsOpener = $('[data-workspace-action="settings"]');
        $('#workspace-settings-dialog').showModal();
        restorePanel($('#workspace-settings-dialog'), pending.snapshot);
      }
    }
    pending = null;
    navigated = false;
  }

  const unsubscribe = store.subscribe(() => {
    applyLayout();
    const select = $('#workspace-profile-select');
    if (select) select.innerHTML = profilesHtml();
    notifyStorage();
  });
  document.addEventListener('click', noteNavigation, true);
  window.addEventListener('resize', scheduleMeasure);
  window.addEventListener('scroll', scheduleMeasure, true);
  return {
    html,
    beforeRender,
    mount,
    destroy() {
      beforeRender();
      pending = null;
      unsubscribe();
      document.removeEventListener('click', noteNavigation, true);
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('scroll', scheduleMeasure, true);
    },
  };
}

// Read-only operational composition. Existing production actions stay in app.js.
export function createOperationalWorkspace({getData, api, refresh, toast = () => {}}) {
  const store=createOpsStore();
  let pane='queue', bindings, opener, loading=false, failure='', observedAt=null, pendingRender=false;
  const names={draft:'제작 중',review:'검토 대기',ready:'제작 완료',queued:'대기 중',running:'실행 중',completed:'완료',failed:'실패',awaiting_review:'검토 대기',approved:'승인됨',changes_requested:'수정 요청',cancelled:'취소됨'};
  const stamp=value=>value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR') : '시각 확인 불가';
  const badge=value=>`<span class="ops-badge ${['failed','changes_requested'].includes(value)?'attention':['completed','ready','approved'].includes(value)?'complete':''}"><span aria-hidden="true">${['failed','changes_requested'].includes(value)?'!':'•'}</span> ${esc(names[value] || value || '확인 불가')}</span>`;
  const blank=message=>`<p class="ops-empty">${esc(message)}</p>`;
  const tab=(key,label)=>`<button data-ops-action="pane" data-pane="${key}" aria-pressed="${pane===key}">${label}</button>`;
  function freshness() {
    return failure ? `갱신 실패 · 이전 자료 표시 · ${failure}` : loading ? '자료를 불러오는 중…' : observedAt ? `${pendingRender?'새 자료 수신 · 입력을 마친 뒤 반영 · ':Date.now()-Date.parse(observedAt)>60000?'오래된 자료 · ':''}마지막 조회 ${stamp(observedAt)} · 30초마다 갱신 (입력 중에는 보류)` : '자료 확인 중…';
  }
  function noteSuccess() { observedAt=new Date().toISOString(); failure=''; }
  function queueHtml() {
    const data=getData(), {current:p}=store.getState(), rows=opsQueue(data,p), columns=Object.keys(OPS_COLUMNS).filter(key=>p.columns.includes(key));
    const title={title:'에피소드',...OPS_COLUMNS};
    const header=key=>`<th scope="col" ${p.sort===key ? `aria-sort="${p.direction==='asc'?'ascending':'descending'}"` : ''}>${['title','status','version','updatedAt'].includes(key)?`<button data-ops-action="sort" data-sort="${key}">${title[key]} ${p.sort===key?(p.direction==='asc'?'↑':'↓'):'↕'}</button>`:title[key]}</th>`;
    const cell=(item,key)=>key==='status'?badge(item.status):esc(key==='channel'?item.channelName:key==='version'?(item.version?`v${item.version}`:'확인 불가'):key==='updatedAt'?stamp(item.updatedAt):item[key]);
    return `<div class="ops-table-region" role="region" aria-label="제작 대기열" tabindex="0"><table class="ops-table"><caption class="sr-only">실제 에피소드 제작 대기열. 열 제목으로 정렬할 수 있습니다.</caption><thead><tr>${header('title')}${columns.map(header).join('')}<th scope="col">열기</th></tr></thead><tbody>${(rows||[]).map(item=>`<tr data-episode-id="${esc(item.id)}"><th scope="row"><strong>${esc(item.title)}</strong><small>${esc(item.id)}</small></th>${columns.map(key=>`<td data-label="${OPS_COLUMNS[key]}">${cell(item,key)}</td>`).join('')}<td><button class="small" data-action="ops-open" data-id="${esc(item.id)}" aria-label="${esc(item.title)} 스튜디오에서 열기">편집 ↗</button></td></tr>`).join('')}</tbody></table>${rows===null?blank('에피소드 자료를 확인할 수 없습니다.'):!rows.length?blank('조건에 맞는 에피소드가 없습니다. 검색어나 필터를 변경하세요.'):''}</div><div class="ops-panel-foot"><span role="status">${rows===null?'확인 불가':`${data.episodes.length}개 중 ${rows.length}개 표시`}</span><button class="quiet small" data-ops-action="clear">필터 초기화</button></div>`;
  }
  function deliverablesHtml(limit) {
    const data=getData();
    if (!Array.isArray(data.episodes) || !Array.isArray(data.jobs) || !Array.isArray(data.generationJobs)) return blank('결과물 자료를 확인할 수 없습니다.');
    const items=opsDeliverables(data);
    return items.length?`<ul class="ops-records">${items.slice(0,limit).map(item=>`<li><span class="ops-file" aria-hidden="true">↗</span><div><a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.title || item.episodeId)} · ${esc(item.source)}</a><p>${esc(item.type || item.format || '로컬 미디어')}${item.episodeVersion?` · 원본 v${esc(item.episodeVersion)}`:item.attachedVersion?` · 현재 참조 v${esc(item.attachedVersion)}`:''}${item.width&&item.height?` · ${Number(item.width)} × ${Number(item.height)}`:''}</p>${!limit?`<small>${esc(item.jobId || item.sceneId || '')}</small>${item.sha256?`<details><summary>SHA-256</summary><code>${esc(item.sha256)}</code></details>`:''}`:''}</div></li>`).join('')}</ul>`:blank('현재 자료에서 로컬 결과물을 찾지 못했습니다.');
  }
  function historyHtml(limit) {
    const data=getData(), episodes=new Map((data.episodes||[]).map(item=>[item.id,item]));
    if (!Array.isArray(data.events)) return blank('변경 이력을 확인할 수 없습니다.');
    const items=[...data.events].sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
    const events=items.length?`<ol class="ops-records ops-timeline">${items.slice(0,limit).map(item=>`<li><div><strong>${esc(item.type)}</strong><p>${esc(episodes.get(item.entityId)?.title || item.entityId || item.id)}</p><small>${stamp(item.createdAt)}</small>${episodes.has(item.entityId)?`<button class="quiet small" data-action="ops-history" data-id="${esc(item.entityId)}">버전 이력 ↗</button>`:''}</div></li>`).join('')}</ol>`:blank('기록된 변경 이력이 없습니다.');
    if (limit) return events;
    return `<h3 class="ops-subheading">워크플로우 버전</h3>${Array.isArray(data.workflows)?data.workflows.map(item=>`<div class="ops-workflow-record"><div><strong>${esc(item.name)}</strong><p>${esc(item.id)} · v${esc(item.version)}</p></div><button data-ops-action="workflow-history" data-id="${esc(item.id)}">버전 기록 ↗</button></div>`).join('') || blank('저장된 워크플로우가 없습니다.'):blank('워크플로우 자료를 확인할 수 없습니다.')}<h3 class="ops-subheading">워크스페이스 활동</h3>${events}`;
  }
  function operationsHtml(compact=false) {
    const data=getData(), groups=opsJobGroups(data);
    const jobs=groups.map(group=>`<div class="ops-operation"><strong>${group.label}</strong><span>${!group.available?'확인 불가':`${group.jobs.filter(job=>job.status==='queued').length} 대기 · ${group.jobs.filter(job=>job.status==='running').length} 실행 · ${group.jobs.filter(job=>job.status==='completed').length} 완료 · ${group.jobs.filter(job=>job.status==='failed').length} 실패`}</span></div>`).join('');
    const collector=data.trendCollector;
    return `<div class="ops-operations">${jobs}<div class="ops-operation"><strong>트렌드 수집</strong><span>${typeof collector?.settings?.enabled!=='boolean'?'확인 불가':collector.settings.enabled?'자동 수집 켜짐':'자동 수집 꺼짐'}</span></div>${collector?.lastError?`<p class="danger">${esc(collector.lastError)}</p>`:''}</div>${compact?'':`<p class="ops-note">연결 설정과 사용 가능 여부는 실제 실행 성공을 뜻하지 않습니다. 아래 상태는 마지막 API 응답입니다.</p><div class="ops-integrations">${data.integrations&&Object.keys(data.integrations).length?Object.entries(data.integrations).map(([key,item])=>`<article><h3>${esc(key)}</h3>${badge(item.status || (item.available===true?'available':item.available===false?'unavailable':null))}<p>${esc(item.detail || '추가 상태 정보 없음')}</p></article>`).join(''):blank('연결 상태 자료가 없습니다.')}</div><h3 class="ops-subheading">작업 기록</h3>${groups.map(group=>`<details class="ops-job-group"><summary>${group.label} · ${group.available?group.jobs.length:'확인 불가'}</summary>${group.jobs.length?group.jobs.map(job=>`<div class="ops-job"><div><strong>${esc(job.id)}</strong><p>${esc(job.episodeId || '')}${job.episodeVersion?` · v${esc(job.episodeVersion)}`:''}</p>${job.error?`<p class="danger">${esc(job.error)}</p>`:''}${Array.isArray(job.nodeRuns)?job.nodeRuns.map(node=>`<p>${esc(node.nodeId)} · ${esc(names[node.status] || node.status)}</p>`).join(''):''}</div>${badge(job.status)}</div>`).join(''):blank('기록된 작업이 없습니다.')}</details>`).join('')}`}`;
  }
  function contentHtml() {
    return pane==='deliverables'?deliverablesHtml():pane==='history'?historyHtml():pane==='operations'?operationsHtml():queueHtml();
  }
  function html() {
    pendingRender=false;
    const data=getData(), {current:p,saved,error}=store.getState();
    const episodes=Array.isArray(data.episodes)?data.episodes:null;
    const options=(items,value)=>items.map(([key,label])=>`<option value="${esc(key)}" ${value===key?'selected':''}>${esc(label)}</option>`).join('');
    return `<section id="ops-workspace" aria-label="운영 개요"><div class="page-heading"><div><p class="eyebrow">PRODUCTION OVERVIEW</p><h1>제작의 흐름을 한눈에</h1><p>에피소드에서 결과물까지, 실제 제작 기록을 이어 봅니다.</p></div><button data-ops-action="refresh">↻ 자료 새로고침</button></div><p id="ops-freshness" class="ops-freshness" role="status">${esc(freshness())}</p><p id="ops-preference-error" class="ops-note" role="status" ${error?'':'hidden'}>${esc(error||'')}</p>
    <div class="ops-summary" aria-label="제작 현황"><button data-ops-action="metric" data-status=""><span>전체 에피소드</span><strong>${episodes?episodes.length:'—'}</strong><small>제작 대기열 ↗</small></button><button data-ops-action="metric" data-status="review"><span>검토 대기</span><strong>${episodes?episodes.filter(item=>item.status==='review').length:'—'}</strong><small>에피소드 상태 기준</small></button><button data-ops-action="metric" data-status="ready"><span>제작 완료</span><strong>${episodes?episodes.filter(item=>item.status==='ready').length:'—'}</strong><small>게시 여부와 별도</small></button></div>
    <div class="ops-columns"><div class="ops-primary"><section class="panel ops-queue" id="ops-queue" aria-labelledby="ops-queue-title"><div class="panel-header"><div><p class="eyebrow">01 / PRODUCTION</p><h2 id="ops-queue-title">제작 대기열</h2></div><button data-ops-action="config" aria-haspopup="dialog" aria-controls="ops-config">보기 구성</button></div><div class="ops-tabs" role="group" aria-label="운영 자료 보기">${tab('queue','에피소드')}${tab('deliverables','결과물')}${tab('history','변경 이력')}${tab('operations','운영 상태')}</div>
    <div id="ops-filters" class="ops-filters" ${pane!=='queue'?'hidden':''}><label>검색<input type="search" id="ops-query" maxlength="200" value="${esc(p.query)}" placeholder="에피소드, 채널, ID"></label><label>채널<select id="ops-channel">${options([['','전체 채널'],...(data.channels||[]).map(item=>[item.id,item.name])],p.channel)}</select></label><label>상태<select id="ops-status">${options([['','전체 상태'],...[...new Set((episodes||[]).map(item=>item.status).filter(Boolean))].map(key=>[key,names[key]||key])],p.status)}</select></label><label>정렬<select id="ops-sort">${options([['updatedAt','수정 시각'],['title','에피소드명'],['version','버전'],['status','상태']],p.sort)}</select></label></div><div id="ops-content">${contentHtml()}</div></section><div class="ops-handoff"><div><h3>다음 단계는 워크플로우에서</h3><p>저장된 그래프, 실행 기록과 정확한 버전의 검토 결과를 확인하세요.</p></div><button data-action="view" data-view="workflow">워크플로우 열기 ↗</button></div></div>
    <aside class="ops-rail" aria-label="제작 근거와 운영 상태"><section class="panel"><div class="panel-header"><h2>02 <span>결과물</span></h2><button class="quiet small" data-ops-action="pane" data-pane="deliverables">전체 보기 ↗</button></div>${deliverablesHtml(3)}</section><section class="panel"><div class="panel-header"><h2>03 <span>최근 변경</span></h2><button class="quiet small" data-ops-action="pane" data-pane="history">전체 보기 ↗</button></div>${historyHtml(3)}</section><section class="panel"><div class="panel-header"><h2>04 <span>운영 상태</span></h2><button class="quiet small" data-ops-action="pane" data-pane="operations">상세 ↗</button></div>${operationsHtml(true)}<p class="ops-note">${esc(stamp(observedAt))} 기준 · 설정과 실행 결과는 별도입니다.</p></section></aside></div>
    <dialog id="ops-config" aria-labelledby="ops-config-title"><form id="ops-config-form"><div class="ops-dialog-head"><h2 id="ops-config-title">제작 대기열 보기 구성</h2><button type="button" data-ops-action="close-config" aria-label="보기 구성 닫기">닫기</button></div><p>이 브라우저에만 저장됩니다. 제작 데이터나 연결 설정을 변경하지 않습니다.</p><fieldset><legend>표시할 열 · 에피소드명은 항상 표시</legend>${Object.entries(OPS_COLUMNS).map(([key,label])=>`<label class="ops-checkbox"><input type="checkbox" name="column" value="${key}" ${p.columns.includes(key)?'checked':''}>${label}</label>`).join('')}</fieldset><label>정렬 방향<select name="direction"><option value="desc" ${p.direction==='desc'?'selected':''}>내림차순</option><option value="asc" ${p.direction==='asc'?'selected':''}>오름차순</option></select></label><div class="ops-dialog-actions"><button type="submit" class="primary">보기에 적용</button></div></form><hr><label>저장할 보기 이름<input id="ops-view-name" maxlength="40" placeholder="예: 검토할 에피소드"></label><button data-ops-action="save-view">현재 필터와 열 저장</button><label>저장한 보기<select id="ops-saved-view"><option value="">보기 선택</option>${saved.map(item=>`<option value="${esc(item.name)}">${esc(item.name)}</option>`).join('')}</select></label><button data-ops-action="delete-view">선택한 보기 삭제</button><button data-ops-action="reset">모든 보기 초기화</button><p id="ops-config-message" role="status">${esc(error||'최대 12개 · 같은 이름으로 저장하면 현재 보기로 갱신됩니다.')}</p></dialog></section>`;
  }
  function updateContent() {
    const root=document.querySelector('#ops-workspace');
    if (!root) return;
    root.querySelector('#ops-content').innerHTML=contentHtml();
    root.querySelector('#ops-filters').hidden=pane!=='queue';
    for (const button of root.querySelectorAll('.ops-tabs button')) button.setAttribute('aria-pressed',String(button.dataset.pane===pane));
    const title=root.querySelector('#ops-queue-title');
    title.textContent={queue:'제작 대기열',deliverables:'결과물',history:'변경 이력',operations:'운영 상태'}[pane];
    root.querySelector('#ops-freshness').textContent=freshness();
    const preferenceError=root.querySelector('#ops-preference-error');
    preferenceError.textContent=store.getState().error||''; preferenceError.hidden=!store.getState().error;
  }
  function syncFilters() {
    const p=store.getState().current;
    for (const [id,key] of [['query','query'],['channel','channel'],['status','status'],['sort','sort']]) { const field=document.querySelector(`#ops-${id}`); if(field) field.value=p[key]; }
    updateContent();
  }
  function syncSaved() {
    const field=document.querySelector('#ops-saved-view');
    if (field) field.innerHTML='<option value="">보기 선택</option>'+store.getState().saved.map(item=>`<option value="${esc(item.name)}">${esc(item.name)}</option>`).join('');
  }
  async function reload(background=false) {
    const freshnessNode=document.querySelector('#ops-freshness');
    if (freshnessNode) freshnessNode.textContent=freshness();
    const active=document.activeElement;
    const editing=active?.matches('input,textarea,select,[contenteditable=true]');
    if (loading || !document.querySelector('#ops-workspace') || (background && (document.querySelector('#ops-workspace dialog[open]') || editing))) return;
    const originalRoot=document.querySelector('#ops-workspace');
    loading=true; if (freshnessNode) freshnessNode.textContent=freshness();
    try { await refresh(); noteSuccess(); }
    catch(error) { failure=error.message; }
    finally { loading=false; }
    // Authentication failures replace the shell with login. Never paint over it.
    const root=document.querySelector('#ops-workspace');
    if (!root || root!==originalRoot) return;
    // A user can start typing or open a dialog while the read is in flight.
    // Keep that live DOM intact, including unapplied dialog fields.
    const focused=document.activeElement;
    if (root.querySelector('dialog[open]') || (root.contains(focused) && focused?.matches('input,textarea,select,[contenteditable=true]'))) {
      pendingRender=true; root.querySelector('#ops-freshness').textContent=freshness(); return;
    }
    const focusedAction=root.contains(focused) ? {
      attributes:[...focused.attributes].filter(item=>item.name.startsWith('data-') || item.name==='href').map(item=>[item.name,item.value]),
      tag:focused.tagName,
      tab:Boolean(focused.closest('.ops-tabs')),
    } : null;
    pendingRender=false;
    const replacement=document.createElement('div'); replacement.innerHTML=html(); root.replaceWith(replacement.firstElementChild); mount();
    if (!background && focused===active) document.querySelector('[data-ops-action=refresh]')?.focus();
    else if (focusedAction?.attributes.length) {
      const next=[...document.querySelectorAll('#ops-workspace button,#ops-workspace a')].find(item=>item.tagName===focusedAction.tag && Boolean(item.closest('.ops-tabs'))===focusedAction.tab && focusedAction.attributes.every(([key,value])=>item.getAttribute(key)===value));
      next?.focus({preventScroll:true});
    }
  }
  function mount() {
    bindings?.abort(); bindings=new AbortController();
    const root=document.querySelector('#ops-workspace'); if(!root) return;
    const options={signal:bindings.signal};
    const dialog=root.querySelector('#ops-config');
    root.addEventListener('keydown',event=>{
      const modal=event.target.closest('dialog[open]');
      if (!modal || event.key!=='Tab') return;
      const controls=[...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(item=>item.getClientRects().length);
      const target=event.shiftKey ? controls.at(-1) : controls[0];
      if ((event.shiftKey && document.activeElement===controls[0]) || (!event.shiftKey && document.activeElement===controls.at(-1))) {event.preventDefault();target?.focus();}
    },options);
    dialog.addEventListener('close',()=>opener?.isConnected&&opener.focus(),options);
    root.addEventListener('input',event=>{if(event.target.id==='ops-query'){store.update({query:event.target.value});updateContent();}},options);
    root.addEventListener('change',event=>{
      const keys={'ops-channel':'channel','ops-status':'status','ops-sort':'sort'};
      if(keys[event.target.id]) {store.update({[keys[event.target.id]]:event.target.value});updateContent();}
      if(event.target.id==='ops-saved-view' && event.target.value) {store.select(event.target.value);syncFilters();for(const field of dialog.querySelectorAll('[name=column]'))field.checked=store.getState().current.columns.includes(field.value);dialog.querySelector('[name=direction]').value=store.getState().current.direction;}
    },options);
    root.querySelector('#ops-config-form').addEventListener('submit',event=>{event.preventDefault();const form=new FormData(event.target);store.update({columns:form.getAll('column'),direction:form.get('direction')});updateContent();dialog.close();},options);
    root.addEventListener('click',async event=>{
      const button=event.target.closest('[data-ops-action]'); if(!button)return;
      const action=button.dataset.opsAction;
      try {
        if(action==='config'){opener=button;dialog.showModal();}
        if(action==='close-config')dialog.close();
        if(action==='pane'){pane=button.dataset.pane;updateContent(); if(!button.closest('.ops-tabs'))root.querySelector('#ops-queue-title').scrollIntoView({block:'start'});}
        if(action==='sort'){const p=store.getState().current;store.update({sort:button.dataset.sort,direction:p.sort===button.dataset.sort&&p.direction==='asc'?'desc':'asc'});updateContent();root.querySelector(`[data-sort="${button.dataset.sort}"]`)?.focus();}
        if(action==='clear'||action==='metric'){store.update({query:'',channel:'',status:button.dataset.status||''});pane='queue';syncFilters();}
        if(action==='save-view'){const form=new FormData(root.querySelector('#ops-config-form'));store.update({columns:form.getAll('column'),direction:form.get('direction')});store.save(root.querySelector('#ops-view-name').value);syncSaved();updateContent();}
        if(action==='delete-view'){store.remove(root.querySelector('#ops-saved-view').value);syncSaved();}
        if(action==='reset'){store.reset();syncSaved();syncFilters();for(const field of dialog.querySelectorAll('[name=column]'))field.checked=true;dialog.querySelector('[name=direction]').value='desc';}
        if(action==='workflow-history') {
          opener=button;
          const provenance=document.createElement('dialog');
          provenance.id='ops-provenance'; provenance.setAttribute('aria-labelledby','ops-provenance-title');
          provenance.innerHTML='<h2 id="ops-provenance-title">워크플로우 버전 기록</h2><div class="ops-provenance-content" role="status">기록을 불러오는 중…</div><form method="dialog"><button>닫기</button></form>';
          root.append(provenance);provenance.addEventListener('close',()=>{provenance.remove();opener?.isConnected&&opener.focus();},{once:true});provenance.showModal();
          try {
            const entries=await api(`/api/workflows/${encodeURIComponent(button.dataset.id)}/history`);
            const rows=Array.isArray(entries)?entries:entries.history;
            if(!Array.isArray(rows))throw new Error('기록 자료를 확인할 수 없습니다.');
            provenance.querySelector('.ops-provenance-content').innerHTML=rows.length?`<ol class="ops-records">${rows.map(item=>`<li><div><strong>v${esc(item.version)} · ${esc(item.snapshot?.name)}</strong><p>${esc(item.reason)} · ${stamp(item.createdAt)}</p><small>${esc(item.workflowId)} · ${esc(item.id)}</small></div></li>`).join('')}</ol><p class="ops-note">복원과 변경 비교는 워크플로우 빌더에서 진행합니다. 복원은 새 버전을 만듭니다.</p>`:blank('버전 기록이 없습니다.');
          }catch(error){provenance.querySelector('.ops-provenance-content').textContent=`기록을 불러오지 못했습니다. ${error.message}`;}
        }
        if(action==='refresh')await reload();
        if(['save-view','delete-view','reset'].includes(action))root.querySelector('#ops-config-message').textContent=store.getState().error||'이 브라우저의 보기에 적용했습니다.';
      }catch(error){root.querySelector('#ops-config-message').textContent=error.message;toast(error.message,true);}
    },options);
  }
  return {html,mount,noteSuccess,reload};
}
