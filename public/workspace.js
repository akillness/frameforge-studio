import {WORKSPACE_PRESETS, normalizeLayout, createWorkspaceStore} from './workspace-state.js';

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
