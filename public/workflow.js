// A dependency-free executable workflow editor. Knowledge graph remains separate.
import {workflowChanges,nodeChanges,changesHtml,displayValue,historyReason,createDraftHistory} from './history.js';
const TYPES = {
  trend:{name:'트렌드 수집',icon:'↗',summary:'Google RSS · 관심 키워드',color:'#81cfa9'},
  research:{name:'리서치 정리',icon:'⌕',summary:'소재와 출처 · 제작 맥락',color:'#87bded'},
  script:{name:'대본 작성',icon:'✳',summary:'Studio / 외부 에이전트',color:'#c9f079'},
  storyboard:{name:'스토리보드',icon:'▦',summary:'대본을 편집 가능한 장면으로',color:'#dfc48f'},
  generate:{name:'Higgsfield 생성',icon:'✦',summary:'모델로 장면 영상 / 이미지 생성',color:'#ec9ed0'},
  render:{name:'영상 렌더',icon:'▶',summary:'FFmpeg · MP4 실제 생성',color:'#ffac96'},
  review:{name:'사람의 검토',icon:'✓',summary:'검토 대기 · 자동 게시 없음',color:'#c5b3ef'},
};
const TYPE_ORDER = Object.keys(TYPES);
const STATUS = {queued:'대기',pending:'대기',running:'실행 중',completed:'완료',succeeded:'완료',failed:'실패',cancelled:'취소됨',cancelling:'취소 요청됨',skipped:'건너뜀',awaiting_review:'사람의 검토 대기'};
STATUS.approved='승인됨';
STATUS.changes_requested='수정 요청';
const LIVE = new Set(['queued','pending','running','cancelling']);
const TERMINAL = new Set(['completed','succeeded','awaiting_review','approved','changes_requested','failed','cancelled']);
const WIDTH = 210;
const HEIGHT = 140;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const copy = value => structuredClone(value);
const newId = () => crypto.randomUUID();
const stamp = value => value ? new Date(value).toLocaleString('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';

function initialGraph() {
  const nodes = TYPE_ORDER.filter(type=>type!=='generate').map((type,index)=>({id:newId(),type,x:50 + index % 3 * 285,y:65 + Math.floor(index / 3) * 230,config:type === 'script' ? {agent:'studio',prompt:''} : {}}));
  return {name:'새 제작 워크플로우',nodes,edges:nodes.slice(1).map((node,index)=>({id:newId(),source:nodes[index].id,target:node.id}))};
}

export function workflowErrors(workflow) {
  if (!workflow) return ['워크플로우를 먼저 만드세요.'];
  const errors = [];
  if (!workflow.name?.trim()) errors.push('워크플로우 이름을 입력하세요.');
  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];
  if (!nodes.length) return [...errors,'노드를 추가하세요.'];
  const counts = Object.fromEntries(TYPE_ORDER.map(type => [type,nodes.filter(node => node.type === type).length]));
  for (const type of TYPE_ORDER) if (counts[type] > 1) errors.push(`${TYPES[type].name} 노드는 하나만 사용할 수 있습니다.`);
  const ids = new Set(nodes.map(node=>node.id));
  if (ids.size !== nodes.length) errors.push('노드 ID가 중복됩니다.');
  const adjacent = new Map(nodes.map(node=>[node.id,[]]));
  const undirected = new Map(nodes.map(node=>[node.id,[]]));
  const edgeKeys = new Set();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) { errors.push('존재하지 않는 노드 연결이 있습니다.'); continue; }
    const key = `${edge.source}:${edge.target}`;
    if (edgeKeys.has(key)) errors.push('중복 연결이 있습니다.');
    edgeKeys.add(key);
    adjacent.get(edge.source).push(edge.target);
    undirected.get(edge.source).push(edge.target);
    undirected.get(edge.target).push(edge.source);
  }
  const visits = new Map();
  const cycle = nodeId => {
    if (visits.get(nodeId) === 1) return true;
    if (visits.get(nodeId) === 2) return false;
    visits.set(nodeId,1);
    if ((adjacent.get(nodeId)||[]).some(cycle)) return true;
    visits.set(nodeId,2);
    return false;
  };
  if (nodes.some(node=>cycle(node.id))) errors.push('순환 연결은 실행할 수 없습니다.');
  const walk = (start,graph) => { const visited = new Set(); const queue = [start]; while (queue.length) { const key = queue.pop(); if (visited.has(key)) continue; visited.add(key); queue.push(...(graph.get(key)||[])); } return visited; };
  if (walk(nodes[0].id,undirected).size !== nodes.length) errors.push('모든 노드를 하나의 실행 흐름으로 연결하세요.');
  const required = ['script','storyboard','render','review'].map(type=>nodes.find(node=>node.type===type));
  for (let index=1;index<required.length;index++) if (required[index-1] && required[index] && !walk(required[index-1].id,adjacent).has(required[index].id)) errors.push(`${TYPES[required[index-1].type].name} → ${TYPES[required[index].type].name} 순서를 연결하세요.`);
  const generation=nodes.find(node=>node.type==='generate');
  if (generation && required[1] && required[2] && (!walk(required[1].id,adjacent).has(generation.id) || !walk(generation.id,adjacent).has(required[2].id))) errors.push('스토리보드 → Higgsfield 생성 → 렌더 순서로 연결하세요.');
  return [...new Set(errors)];
}

export function createWorkflowEditor({api,toast,getEpisodes,getEpisode,hasEpisodeChanges,beforeRun,onRunUpdated}) {
  let workflows = [];
  let workflow = null;
  let saved = null;
  let selected = null;
  let episodeId = null;
  let runs = [];
  let selectedRunId = null;
  let loaded = false;
  let dirty = false;
  let revision = 0;
  let pending = false;
  let saving = false;
  let inspectorTab = 'settings';
  let versions = [];
  let compareVersion = null;
  let restoreVersion = null;
  let generationConsent = false;
  let generationConsentSnapshot = null;
  let generationEstimate = null;
  let generationEstimateKey = '';
  let generationEstimateError = '';
  let generationEstimateLoading = false;
  let generationEstimateAcknowledged = false;
  let generationTargetSceneId = null;
  let generationTargetEpisode = null;
  let models = [];
  const modelSchemas = new Map();
  let generationStatus = null;
  let generationError = '';
  let generationLoad = 0;
  let generationTimer = null;
  const generationJobs = new Map();
  const generationJobErrors = new Map();
  const drafts = createDraftHistory(40);
  const DEFAULT_GENERATION_MODEL = 'seedance_2_5';
  function generationConfig(sceneIndex = 0, model = '') {
    return {model: model || models[0]?.id || DEFAULT_GENERATION_MODEL, prompt:'', params:{}, sceneIndex:Math.max(0, Number(sceneIndex) || 0)};
  }
  let host = null;
  let mountController = null;
  let minimapRaf = 0;
  let generationStageRun = false;
  let generationResumeRunId = null;
  let overlayTrigger = null;
  let connecting = null;
  let drag = null;
  let scale = 1;
  let pan = {x:0,y:0};
  let needsFit = true;
  let timer = null;
  let pollEpoch = 0;
  const reviewNotes = new Map();
  let reviewSignature = '';
  const $ = selector => host?.querySelector(selector);
  const post = (path,data={}) => api(path,{method:'POST',body:JSON.stringify(data)});
  const activeRun = () => runs.find(run=>run.id===selectedRunId) || runs[0];
  const running = () => runs.some(run=>LIVE.has(run.status));
  const selectedNode = () => workflow?.nodes.find(node=>node.id===selected) || (inspectorTab==='results' ? activeRun()?.workflowSnapshot?.nodes.find(node=>node.id===selected) : null);
  const draftContent=()=>workflow?{name:workflow.name,nodes:workflow.nodes,edges:workflow.edges}:null;
  const nodeName=node=>node?.label || TYPES[node?.type]?.name || node?.type || '노드';
  const selectedVersion=()=>versions.find(item=>item.version===compareVersion) || versions[0];
  function changed(group=null) { drafts.record(draftContent(),group);dirty=JSON.stringify(draftContent())!==JSON.stringify(saved?{name:saved.name,nodes:saved.nodes,edges:saved.edges}:null);revision++;updateSummary(); }
  function resetDrafts() {drafts.reset(draftContent());}
  function undoDraft(redo=false) {if(saving || pending)return;const value=redo?drafts.redo():drafts.undo();if(!value)return;workflow={...workflow,...value};selected=workflow.nodes.some(node=>node.id===selected)?selected:workflow.nodes[0]?.id;dirty=JSON.stringify(draftContent())!==JSON.stringify(saved?{name:saved.name,nodes:saved.nodes,edges:saved.edges}:null);revision++;paint();}
  async function loadVersions() {
    if (!workflow?.id) {versions=[];compareVersion=null;return;}
    const target=workflow.id,result=await api(`/api/workflows/${target}/history`);
    if (workflow?.id!==target) return;
    versions=Array.isArray(result)?result:result.history || [];
    if (!versions.some(item=>item.version===compareVersion)) compareVersion=versions[0]?.version || null;
  }

  async function load(force=false) {
    if (loaded && !force) return;
    if (dirty && force) throw new Error('변경 사항을 저장하거나 되돌린 뒤 다시 불러오세요.');
    const result = await api('/api/workflows');
    workflows = Array.isArray(result) ? result : result.workflows || [];
    const next = workflows.find(item=>item.id===workflow?.id) || workflows[0] || null;
    workflow = copy(next);
    saved = copy(next);
    selected = workflow?.nodes[0]?.id || null;
    loaded = true;
    needsFit = true;
    resetDrafts();
    await Promise.all([loadRuns(),loadVersions()]);
  }

  async function loadRuns() {
    const epoch=pollEpoch;
    if (!workflow?.id) { runs=[]; return; }
    const targetId = workflow.id;
    const result = await api(`/api/workflows/${targetId}/runs`);
    if (epoch!==pollEpoch || (host && !host.isConnected) || workflow?.id !== targetId) return;
    const latest = Array.isArray(result) ? result : result.runs || [];
    const wasLive = running();
    runs = latest.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!selectedRunId || !runs.some(run=>run.id===selectedRunId)) selectedRunId = runs[0]?.id;
    if (wasLive && !running()) await onRunUpdated?.();
    const jobId=activeRun()?.nodeRuns?.find(node=>node.nodeId===selected)?.output?.generationJobId;
    if(jobId && inspectorTab==='results') await loadGenerationJob(jobId);
    schedulePoll(epoch);
  }

  function schedulePoll(epoch=pollEpoch) {
    clearTimeout(timer);
    if (epoch!==pollEpoch || (host && !host.isConnected) || !running()) return;
    timer=setTimeout(async()=>{
      if (epoch!==pollEpoch || (host && !host.isConnected)) return;
      try { await loadRuns(); updateExecution(); }
      catch (error) { if (epoch!==pollEpoch || (host && !host.isConnected)) return; toast(`워크플로우 상태 갱신 실패: ${error.message}`,true); schedulePoll(epoch); }
    },2200);
  }


  async function save() {
    if (!workflow) throw new Error('워크플로우를 먼저 만드세요.');
    if (!dirty && workflow.id) return workflow;
    if (saving) throw new Error('워크플로우를 저장 중입니다. 잠시 후 다시 시도해 주세요.');
    const errors = workflowErrors(workflow);
    if (errors.length) throw new Error(errors.join(' '));
    const startRevision = revision;
    saving=true;updateSummary();
    try {
    const body = {name:workflow.name.trim(),nodes:workflow.nodes,edges:workflow.edges,...(workflow.id ? {expectedVersion:workflow.version} : {})};
    const result = await api(workflow.id ? `/api/workflows/${workflow.id}` : '/api/workflows',{method:workflow.id ? 'PUT' : 'POST',body:JSON.stringify(body)});
    saved = copy(result);
    const index = workflows.findIndex(item=>item.id===result.id);
    if (index>=0) workflows[index]=copy(result); else workflows.unshift(copy(result));
    if (revision !== startRevision) { workflow.id=result.id; workflow.version=result.version; throw new Error('저장 중 추가한 편집을 보존했습니다. 다시 저장해 주세요.'); }
    workflow=copy(result);
    dirty=false;
    resetDrafts();
    await loadVersions();
    updateSummary();
    return result;
    } finally {saving=false;updateSummary();}
  }

  function options(selectedId,omitId) {
    return workflow.nodes.filter(node=>node.id!==omitId).map(node=>`<option value="${escapeHtml(node.id)}" ${selectedId===node.id?'selected':''}>${escapeHtml(nodeName(node))}</option>`).join('');
  }

  function shell() {
    const episodes = getEpisodes();
    if (!episodes.some(item=>item.id===episodeId)) episodeId=episodes[0]?.id || null;
    return `<div class="page-heading"><div><h1>워크플로우</h1><p>노드를 연결하고 선택한 에피소드에서 실행합니다.</p></div><div class="row"><button data-wf-action="new">＋ 새 워크플로우</button><button data-wf-action="save" ${!workflow?'disabled':''}>워크플로우 저장</button><button class="primary" data-wf-action="run" ${!workflow || !episodeId || running()?'disabled':''}>워크플로우 실행</button></div></div>
    <section class="panel wf-toolbar"><label>저장된 워크플로우<select id="wf-select" aria-label="워크플로우 선택"><option value="">${workflow&&!workflow.id?'저장되지 않은 새 워크플로우':'선택하세요'}</option>${workflows.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===workflow?.id?'selected':''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><label>실행 대상 에피소드<select id="wf-episode" aria-label="워크플로우 실행 에피소드"><option value="">에피소드를 선택하세요</option>${episodes.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===episodeId?'selected':''}>${escapeHtml(item.title)}</option>`).join('')}</select></label><div class="wf-save-state"><span id="wf-save-status" class="hint" role="status" aria-live="polite"></span><div class="row"><button class="small quiet" data-wf-action="undo" title="Ctrl/⌘ Z">↶ 실행 취소</button><button class="small quiet" data-wf-action="redo" title="Ctrl/⌘ Shift Z">↷ 다시 실행</button><button class="small quiet" data-wf-action="reload">새로고침</button><button class="small quiet" data-wf-action="discard">변경 되돌리기</button></div></div></section>
    ${!workflow ? '<div class="panel empty"><div class="empty-mark">⌘</div><h2>실행 가능한 제작 흐름을 만드세요</h2><p>새 워크플로우에서 노드를 연결하고<br>에피소드를 선택해 실제 작업을 실행하세요.</p></div>' : `<div class="wf-layout"><section class="panel wf-graph-panel"><div class="panel-header"><div class="row"><span class="eyebrow">WORKFLOW CANVAS</span><span class="badge">${workflow.nodes.length} NODES</span></div><div class="row"><select id="wf-add-type" aria-label="추가할 노드 종류">${TYPE_ORDER.map(type=>`<option value="${type}" ${workflow.nodes.some(node=>node.type===type)?'disabled':''}>${TYPES[type].name}</option>`).join('')}</select><button class="small" data-wf-action="add-node">＋ 노드</button></div></div><div id="workflow-canvas" class="wf-canvas" tabindex="0" aria-label="워크플로우 캔버스. 노드 제목을 드래그해 이동하고 출력과 입력을 순서대로 선택해 연결하세요."><div id="wf-world" class="wf-world"><svg id="wf-edges" class="wf-edges" aria-hidden="true"></svg><div id="wf-nodes">${nodesHtml()}</div></div><div class="wf-canvas-hint" id="wf-connect-hint">빈 공간 드래그 · 휠 확대/축소 · 출력 → 입력 연결</div><div class="wf-zoom"><button class="icon-btn" data-wf-action="zoom-out" aria-label="축소">−</button><span id="wf-zoom-value">100%</span><button class="icon-btn" data-wf-action="zoom-in" aria-label="확대">+</button><button class="small" data-wf-action="fit">전체 보기</button><button class="small" data-wf-action="layout">자동 배치</button></div></div><div id="wf-validation" class="wf-validation" role="status"></div></section><aside class="wf-side"><section class="panel wf-secondary"><details><summary class="panel-header"><h3>워크플로우 이름과 구성</h3><span aria-hidden="true">⌄</span></summary><div class="panel-body"><label>이름<input id="wf-name" value="${escapeHtml(workflow.name)}" maxlength="160"></label><p class="hint">대본 → 스토리보드 → 렌더 → 사람의 검토가 필수입니다. 트렌드와 리서치는 선택 단계입니다.</p></div></details></section><section class="panel wf-primary"><div class="panel-header"><h3>선택한 노드</h3><span class="badge" id="wf-node-type"></span></div><div class="wf-inspector-tabs" role="tablist" aria-label="노드 상세">${inspectorTabsHtml()}</div><div class="panel-body" id="wf-inspector" role="tabpanel" tabindex="0">${inspectorHtml()}</div></section><section class="panel wf-secondary"><details><summary class="panel-header"><h3>노드 연결 편집</h3><span aria-hidden="true">⌄</span></summary><form id="wf-connect-form" class="panel-body"><label>출력 노드<select name="source" aria-label="연결 출발 노드">${options(selected)}</select></label><label>입력 노드<select name="target" aria-label="연결 도착 노드">${options(null)}</select></label><button class="small" type="submit">연결 추가 →</button><div class="wf-connection-list">${connectionsHtml()}</div></form></details></section></aside></div><section class="panel section-spacer"><div class="panel-header"><h2>워크플로우 버전 기록</h2><button class="small" data-wf-action="refresh-history">↻ 기록 새로고침</button></div><div id="wf-history">${historyHtml()}</div></section><section class="panel section-spacer"><div class="panel-header"><h2>실행 기록</h2><button class="small" data-wf-action="refresh-runs">↻ 실행 상태 확인</button></div><div id="wf-runs">${runsHtml()}</div></section><div id="wf-review">${reviewHtml()}</div>${dialogsHtml()}`}`;
  }

  function nodesHtml() {
    return workflow.nodes.map(node=>{
      const type=TYPES[node.type] || {name:node.type,icon:'?',summary:'알 수 없는 단계',color:'#999999'};
      const record=activeRun()?.nodeRuns?.find(item=>item.nodeId===node.id);
      return `<article class="wf-node ${selected===node.id?'selected':''}" data-node-id="${escapeHtml(node.id)}" style="left:${Number(node.x)||0}px;top:${Number(node.y)||0}px;--node-color:${type.color}"><button class="wf-node-header" data-wf-action="select-node" data-id="${escapeHtml(node.id)}" title="드래그하여 이동. 선택 후 방향키로 이동할 수 있습니다."><span class="wf-node-icon">${type.icon}</span><span class="wf-node-label">${escapeHtml(nodeName(node))}</span><span class="wf-grip" aria-hidden="true">⠿</span></button><div class="wf-node-content"><p>${escapeHtml(node.type==='script' ? `${node.config?.agent || 'studio'} · ${node.config?.prompt ? '사용자 지시문' : '에피소드 소재 사용'}` : type.summary)}</p><span class="wf-node-status ${record?.status || 'idle'}" data-status-node="${escapeHtml(node.id)}">${STATUS[record?.status] || '실행 전'}</span></div><button class="wf-port input" data-wf-action="input" data-id="${escapeHtml(node.id)}" aria-label="${type.name} 입력 연결" title="입력 연결"><span></span>입력</button><button class="wf-port output" data-wf-action="output" data-id="${escapeHtml(node.id)}" aria-label="${type.name} 출력 연결" title="출력 연결">출력<span></span></button></article>`;
    }).join('');
  }
  function minimapHtml() {
    return workflow.nodes.map(node=>`<button type="button" class="wf-minimap-node ${selected===node.id?'selected':''}" data-wf-action="minimap-select" data-id="${escapeHtml(node.id)}" aria-label="미니맵에서 ${escapeHtml(nodeName(node))} 선택"><span></span></button>`).join('');
  }
  function drawMinimap() {
    if (minimapRaf || !host?.isConnected) return;
    minimapRaf=requestAnimationFrame(()=>{
      minimapRaf=0;
      const map=$('#wf-minimap'), viewport=$('#wf-minimap-viewport'), canvas=$('#workflow-canvas');
      if (!map || !viewport || !canvas || !workflow?.nodes.length) return;
      const left=Math.min(...workflow.nodes.map(node=>Number(node.x)||0)), top=Math.min(...workflow.nodes.map(node=>Number(node.y)||0));
      const right=Math.max(...workflow.nodes.map(node=>(Number(node.x)||0)+WIDTH)), bottom=Math.max(...workflow.nodes.map(node=>(Number(node.y)||0)+HEIGHT));
      const worldWidth=Math.max(1,right-left+80), worldHeight=Math.max(1,bottom-top+80);
      workflow.nodes.forEach(node=>{
        const element=map.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`); const mini=map.querySelector(`.wf-minimap-node[data-id="${CSS.escape(node.id)}"]`);
        if (mini) { mini.style.left=`${((node.x-left+40)/worldWidth)*100}%`; mini.style.top=`${((node.y-top+40)/worldHeight)*100}%`; mini.classList.toggle('selected',selected===node.id); }
      });
      const viewX=-pan.x/scale,viewY=-pan.y/scale,viewW=canvas.clientWidth/scale,viewH=canvas.clientHeight/scale;
      viewport.style.left=`${((viewX-left+40)/worldWidth)*100}%`; viewport.style.top=`${((viewY-top+40)/worldHeight)*100}%`;
      viewport.style.width=`${Math.max(3,(viewW/worldWidth)*100)}%`; viewport.style.height=`${Math.max(3,(viewH/worldHeight)*100)}%`;
    });
  }

  function nodeSummary(node) {
    if (node.type==='script') return `${node.config?.agent || 'studio'} · ${node.config?.prompt?'사용자 지시문':'에피소드 소재 사용'}`;
    if (node.type==='generate') return `${node.config?.model || '모델 선택'} · 장면 ${(node.config?.sceneIndex || 0)+1}`;
    if (node.type==='trend' && node.config?.query) return node.config.query;
    if (node.type==='research' && node.config?.limit) return `참고 자료 최대 ${node.config.limit}개`;
    return TYPES[node.type]?.summary || node.type;
  }
  function inspectorTabsHtml() {
    return [['settings','설정'],['results','실행 결과'],['history','변경 기록']].map(([key,label])=>`<button type="button" role="tab" aria-selected="${inspectorTab===key}" aria-controls="wf-inspector" data-wf-action="inspector-tab" data-tab="${key}" class="${inspectorTab===key?'selected':''}">${label}</button>`).join('');
  }
  function inspectorHtml() {
    const node=selectedNode();
    if (!node) return '<p class="hint">캔버스에서 노드를 선택하세요.</p>';
    if (inspectorTab==='results') return nodeResultsHtml(node);
    if (inspectorTab==='history') return nodeHistoryHtml(node);
    const config=node.config || {};
    let controls='';
    if (node.type==='script') controls=`<label>실행 에이전트<select id="wf-agent" data-wf-config="agent">${['existing','studio','codex','jeo','jeopi','hermes'].map(agent=>`<option value="${agent}" ${(config.agent || 'studio')===agent?'selected':''}>${agent==='existing'?'저장된 편집본 사용':agent==='studio'?'Studio · 규칙 기반':agent.toUpperCase()+' · 외부 연결'}</option>`).join('')}</select></label><label>제작 지시문<textarea id="wf-prompt" data-wf-config="prompt" maxlength="12000" rows="5" placeholder="대상 시청자, 톤, 장면 구성 지시">${escapeHtml(config.prompt || '')}</textarea></label><p class="hint">저장된 편집본 사용은 기존 장면과 음성을 유지합니다. 이 모드에서는 지시문을 사용하지 않습니다. 외부 에이전트는 실제 연결이 필요합니다.</p>`;
    if (node.type==='trend') controls=`<label>검색 키워드<input data-wf-config="query" value="${escapeHtml(config.query || '')}" maxlength="200" placeholder="비워두면 전체 수집 결과"></label><p class="hint">수집된 키워드 중 입력한 문구가 포함된 항목을 사용합니다. 결과가 없으면 실패로 기록됩니다.</p>`;
    if (node.type==='research') controls=`<label>참고 자료 수 (선택)<input type="number" data-wf-config="limit" value="${config.limit ?? ''}" min="1" max="50" step="1" placeholder="전체 자료"></label><p class="hint">채널에 연결된 참고 자료에서 최대 이 수만큼 사용합니다.</p>`;
    if (node.type==='review') controls=`<label>검토 지침<textarea data-wf-config="instructions" maxlength="2000" rows="5" placeholder="자막, 연출, 사실 확인 등 검토할 항목">${escapeHtml(config.instructions || '')}</textarea></label><p class="hint">결과와 함께 보존되는 검토 지침입니다. 승인하거나 게시하는 자동 규칙이 아닙니다.</p>`;
    if (node.type==='generate') controls=generationControlsHtml(node);
    return `<h3>${escapeHtml(nodeName(node))}</h3><p class="hint">${escapeHtml(TYPES[node.type]?.summary)}</p><label>노드 이름<input data-wf-field="label" maxlength="80" value="${escapeHtml(node.label || '')}" placeholder="${escapeHtml(TYPES[node.type]?.name)}"></label>${controls}<label>작업 메모<textarea data-wf-field="notes" rows="3" maxlength="2000" placeholder="이 단계의 의도와 수정할 점">${escapeHtml(node.notes || '')}</textarea></label><details class="history-advanced"><summary>캔버스 위치</summary><div class="two-cols"><label>X 위치<input type="number" id="wf-node-x" data-wf-coordinate="x" step="10" min="0" max="10000" value="${Math.round(node.x)}"></label><label>Y 위치<input type="number" id="wf-node-y" data-wf-coordinate="y" step="10" min="0" max="10000" value="${Math.round(node.y)}"></label></div></details><button class="small danger" data-wf-action="delete-node">노드 삭제</button><p class="hint">필수 단계를 삭제하면 다시 추가하고 연결해야 저장할 수 있습니다.</p>`;
  }
  function factsHtml(value) {
    if (!value || typeof value!=='object') return `<p class="result-copy">${escapeHtml(displayValue(value))}</p>`;
    const labels={message:'설명',agent:'에이전트',mode:'실행 방식',query:'검색 키워드',sceneCount:'장면 수',version:'결과 버전',episodeVersion:'에피소드 버전',model:'생성 모델',requestId:'요청 ID',providerRequestId:'제공자 요청 ID',generationJobId:'생성 작업 ID',type:'결과 형식',status:'상태',instructions:'검토 지침',sceneId:'대상 장면',outputUrl:'결과 파일'};
    let html=`<dl class="result-facts">${Object.entries(labels).filter(([key])=>value[key]!==undefined && typeof value[key]!=='object').map(([key,label])=>`<div><dt>${label}</dt><dd>${escapeHtml(displayValue(value[key]))}</dd></div>`).join('')}</dl>`;
    for (const [key,label] of [['trends','키워드'],['references','참고 자료'],['scenes','장면']]) if (Array.isArray(value[key])) html+=`<h4>${label} · ${value[key].length}</h4><ul class="result-list">${value[key].slice(0,12).map(item=>`<li><strong>${escapeHtml(item.title || item.keyword || item.name || item.id || label)}</strong>${item.text?`<p>${escapeHtml(item.text)}</p>`:''}${item.narration?`<p>음성 · ${escapeHtml(item.narration)}</p>`:''}${item.duration?`<small>${Number(item.duration)}초</small>`:''}</li>`).join('')}</ul>${value[key].length>12?'<p class="hint">전체 내용은 원본 기록에서 확인할 수 있습니다.</p>':''}`;
    const url=value.asset?.url || value.assetUrl || value.outputUrl || value.url;
    if (typeof url==='string' && /^\/api\/(uploads|exports)\/[a-zA-Z0-9_.-]+$/.test(url)) html+=/\.(mp4|webm)$/i.test(url)?`<video class="node-result-media" controls preload="metadata" src="${escapeHtml(url)}"></video>`:/\.(png|jpg|jpeg|webp)$/i.test(url)?`<img class="node-result-media" src="${escapeHtml(url)}" alt="생성 결과">`:'';
    if(Array.isArray(value.outputs)) html+=value.outputs.slice(0,8).map(output=>factsHtml(output)).join('');
    return html || '<p class="hint">아래 원본 기록에서 결과를 확인하세요.</p>';
  }
  function nodeResultsHtml(node) {
    const run=activeRun(),record=run?.nodeRuns?.find(item=>item.nodeId===node.id);
    const snapshotNode=run?.workflowSnapshot?.nodes.find(item=>item.id===node.id);
    const inputIds=run?.workflowSnapshot?.edges.filter(edge=>edge.target===node.id).map(edge=>edge.source) || [];
    const seconds=record?.startedAt && record?.completedAt ? Math.max(0,(new Date(record.completedAt)-new Date(record.startedAt))/1000).toFixed(1):null;
    return `<h3>${escapeHtml(nodeName(node))}</h3><label>실행 선택<select id="wf-inspector-run" aria-label="노드 실행 선택">${runs.length?runs.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===run?.id?'selected':''}>${stamp(item.createdAt)} · v${item.workflowVersion} · ${escapeHtml(STATUS[item.status] || item.status)}</option>`).join(''):'<option>실행 기록 없음</option>'}</select></label>${run?`<p class="hint">실행 당시 워크플로우 v${run.workflowVersion} · 에피소드 v${run.episodeVersion}<br>${stamp(record?.startedAt || run.createdAt)}${seconds?` · ${seconds}초`:''}</p>`:''}${!record?'<p class="history-empty">이 노드는 선택한 실행에 포함되지 않았습니다.</p>':`<span class="badge">${escapeHtml(STATUS[record.status] || record.status)}</span>${record.error?`<p class="wf-review-warning" role="alert">${escapeHtml(record.error)}</p>`:''}${record.output?.generationJobId?generationJobHtml(record.output.generationJobId):''}<h4>실행 입력</h4>${snapshotNode?factsHtml(snapshotNode.config):''}${inputIds.length?`<ul class="result-list">${inputIds.map(id=>{const source=run.workflowSnapshot.nodes.find(item=>item.id===id),result=run.nodeRuns.find(item=>item.nodeId===id);return `<li><strong>${escapeHtml(nodeName(source))}</strong><span class="hint"> · ${escapeHtml(STATUS[result?.status] || result?.status || '대기')}</span>${factsHtml(result?.output)}</li>`;}).join('')}</ul>`:'<p class="hint">연결된 선행 노드 없이 에피소드의 소재와 저장된 내용을 사용합니다.</p>'}<h4>실행 결과</h4>${record.output?factsHtml(record.output):'<p class="hint">아직 결과가 없습니다.</p>'}<details class="history-advanced"><summary>고급 · 입력 / 출력 원본</summary><pre class="history-snapshot">${escapeHtml(JSON.stringify({config:snapshotNode?.config,inputs:inputIds.map(id=>({nodeId:id,output:run.nodeRuns.find(item=>item.nodeId===id)?.output})),output:record.output},null,2))}</pre></details>`}`;
  }
  function nodeHistoryHtml(node) {
    const entry=selectedVersion(),previous=entry?.snapshot?.nodes.find(item=>item.id===node.id);
    return `<h3>${escapeHtml(nodeName(node))}</h3><label>비교할 저장 버전<select id="wf-node-history-version">${versions.map(item=>`<option value="${item.version}" ${item.version===entry?.version?'selected':''}>v${item.version} · ${stamp(item.createdAt)}</option>`).join('')}</select></label>${entry?`${changesHtml(nodeChanges(previous,node),escapeHtml,`선택 v${entry.version}`,dirty?'현재 초안':`현재 v${workflow.version}`)}${previous?`<button class="small" data-wf-action="restore-node" ${dirty || saving?'disabled':''}>이 버전의 노드 설정 불러오기</button><p class="hint">이름·메모·설정만 초안에 불러옵니다. 연결과 위치는 유지하며, 저장할 때 새 버전이 됩니다.${dirty?' 먼저 현재 초안을 저장해 주세요.':''}</p>`:'<p class="hint">선택한 버전에 이 노드가 없습니다.</p>'}`:'<p class="hint">워크플로우를 저장하면 노드별 변경 내용을 비교할 수 있습니다.</p>'}`;
  }
  function historyHtml() {
    const entry=selectedVersion();
    if (!entry) return '<div class="panel-body hint">처음 저장한 뒤 버전 비교와 복원을 사용할 수 있습니다.</div>';
    return `<div class="history-layout"><nav class="history-versions" aria-label="워크플로우 버전">${versions.map(item=>`<button class="history-version ${item.version===entry.version?'selected':''}" data-wf-action="history-version" data-version="${item.version}" aria-pressed="${item.version===entry.version}"><strong>v${item.version}${item.version===workflow.version?' · 현재':''}</strong><span>${escapeHtml(historyReason(item.reason))}</span><small>${stamp(item.createdAt)}</small></button>`).join('')}</nav><div class="history-comparison"><div class="row between history-compare-heading"><div><h3>v${entry.version} → ${dirty?'현재 초안':`현재 v${workflow.version}`}</h3><p class="hint">노드 설정, 위치와 연결 변경을 비교합니다.</p></div><button data-wf-action="restore-workflow" ${dirty || saving || entry.version===workflow.version?'disabled':''}>이 버전으로 복원</button></div>${dirty?'<p class="wf-review-warning">먼저 현재 초안을 저장해야 복원할 수 있습니다.</p>':''}${changesHtml(workflowChanges(entry.snapshot,workflow),escapeHtml,`선택 v${entry.version}`,dirty?'현재 초안':`현재 v${workflow.version}`)}<details class="history-advanced"><summary>고급 · 원본 기록 JSON</summary><pre class="history-snapshot">${escapeHtml(JSON.stringify(entry.snapshot,null,2))}</pre></details></div></div>`;
  }
  function generationInput() {
    const node=workflow?.nodes.find(item=>item.type==='generate');
    const target=liveEpisode(episodeId) || (generationTargetEpisode?.id===episodeId ? generationTargetEpisode : null);
    const configuredIndex=Math.max(0,Number(node?.config?.sceneIndex) || 0);
    const stableScene=generationTargetSceneId ? target?.scenes?.find(item=>item.id===generationTargetSceneId) : null;
    const stableTargetMissing=Boolean(generationTargetSceneId) && !stableScene;
    const index=stableScene ? target.scenes.findIndex(item=>item.id===stableScene.id) : (stableTargetMissing ? null : configuredIndex);
    const scene=stableScene || (stableTargetMissing ? null : target?.scenes?.[index]);
    const prompt=node?.config?.prompt || scene?.text || target?.topic || '';
    return {episodeId,sceneId:scene?.id || null,sceneIndex:index,sceneTitle:scene?.title || '',model:node?.config?.model || '',prompt,params:copy(node?.config?.params || {}),stableTargetMissing};
  }
  function generationInputKey(input=generationInput()) {
    return JSON.stringify([input.episodeId,input.sceneId,input.sceneIndex,input.model,input.prompt,input.params]);
  }
  function assertGenerationInput(input) {
    if (input.stableTargetMissing || !input.sceneId || !Number.isInteger(input.sceneIndex)) throw new Error('생성 대상 장면을 확인할 수 없습니다. 장면을 다시 선택해 주세요.');
    return input;
  }
  function invalidateGenerationEstimate() {
    generationEstimate=null; generationEstimateKey=''; generationEstimateError=''; generationEstimateAcknowledged=false;
    const dialog=$('#wf-confirm-dialog');
    if (dialog?.open) refreshDialogConfirmation();
  }
  function quoteLabel(estimate) {
    if (!estimate || (estimate.credits === undefined && estimate.usd === undefined)) return '';
    const parts=[];
    if (Number.isFinite(Number(estimate.credits))) parts.push(`${Number(estimate.credits)} 크레딧`);
    if (Number.isFinite(Number(estimate.usd))) parts.push(`USD ${Number(estimate.usd).toFixed(4)}`);
    return parts.join(' · ');
  }
  async function loadGenerationEstimate() {
    const input=assertGenerationInput(generationInput()),key=generationInputKey(input);
    generationEstimateLoading=true; generationEstimate=null; generationEstimateKey=''; generationEstimateError=''; generationEstimateAcknowledged=false;
    try {
      const result=await post('/api/generation/estimate',{model:input.model,prompt:input.prompt,params:input.params});
      if (key===generationInputKey()) {generationEstimate=result;generationEstimateKey=key;}
    } catch(error) { if (key===generationInputKey()) generationEstimateError=error.message; }
    finally { generationEstimateLoading=false; }
    return {input,key};
  }
  function refreshDialogConfirmation() {
    const dialog=$('#wf-confirm-dialog');
    if (!dialog || !generationConsent) return;
    const unavailable=!generationEstimate || generationEstimateKey!==generationConsentSnapshot?.key;
    const confirm=dialog.querySelector('[data-wf-action="confirm-generation-run"]');
    if (confirm) confirm.disabled=generationEstimateLoading || (unavailable && !generationEstimateAcknowledged);
    const acknowledgement=dialog.querySelector('#wf-estimate-ack');
    if (acknowledgement) acknowledgement.checked=generationEstimateAcknowledged;
  }
  function dialogsHtml() {
    const entry=versions.find(item=>item.version===restoreVersion);
    const snapshot=generationConsentSnapshot || generationInput();
    const quote=quoteLabel(generationEstimate);
    const unavailable=!quote || generationEstimateKey!==snapshot.key;
    const generationDialog=`<p>선택한 에피소드와 장면에 생성 결과를 자동 적용한 뒤 영상을 렌더합니다. 실행하면 제공자 크레딧 또는 비용이 발생할 수 있습니다.</p><dl class="wf-review-facts"><div><dt>에피소드</dt><dd>${escapeHtml(liveEpisode(snapshot.episodeId)?.title || snapshot.episodeId || '확인할 수 없음')}</dd></div><div><dt>장면</dt><dd>${Number.isInteger(snapshot.sceneIndex)?`${snapshot.sceneIndex+1}${snapshot.sceneTitle?` · ${escapeHtml(snapshot.sceneTitle)}`:''}`:'확인할 수 없음'}</dd></div><div><dt>모델</dt><dd>${escapeHtml(snapshot.model || '확인할 수 없음')}</dd></div></dl>${quote?`<p class="generation-quote"><strong>예상 비용</strong> ${escapeHtml(quote)}</p>`:`<p class="wf-review-warning">정확한 비용 견적을 확인하지 못했습니다.${generationEstimateError?` ${escapeHtml(generationEstimateError)}`:''}</p><label class="generation-checkbox"><input id="wf-estimate-ack" type="checkbox" data-wf-action="estimate-ack" ${generationEstimateAcknowledged?'checked':''}> 견적 없이 실행함을 확인합니다.</label>`}`;
    return `<dialog id="wf-confirm-dialog"><h2>${generationConsent?'Higgsfield 생성 실행':'이전 버전을 새 버전으로 복원'}</h2>${generationConsent?generationDialog:`<p>현재 v${workflow.version}은 기록에 보존됩니다. 선택한 v${entry?.version || ''}의 내용을 새 버전으로 저장합니다.</p>${entry?changesHtml(workflowChanges(workflow,entry.snapshot),escapeHtml,'현재 내용','복원할 내용'):''}`}<div class="dialog-actions"><button data-wf-action="close-dialog">취소</button><button class="primary" data-wf-action="${generationConsent?'confirm-generation-run':'confirm-restore'}" ${generationConsent && (generationEstimateLoading || (unavailable && !generationEstimateAcknowledged))?'disabled':''}>${generationConsent?'비용 확인 후 실행':'새 버전으로 복원'}</button></div></dialog>`;
  }
  function generationControlsHtml(node) {
    const config=node.config || {};
    const selectedEpisode=liveEpisode(episodeId) || (generationTargetEpisode?.id===episodeId ? generationTargetEpisode : null);
    const configuredIndex=Math.max(0,Number(config.sceneIndex) || 0);
    const selectedScene=generationTargetSceneId ? selectedEpisode?.scenes?.find(item=>item.id===generationTargetSceneId) : selectedEpisode?.scenes?.[configuredIndex];
    const selectedSceneIndex=selectedEpisode?.scenes?.findIndex(item=>item.id===selectedScene?.id);
    const displaySceneIndex=Number.isInteger(selectedSceneIndex) && selectedSceneIndex>=0 ? selectedSceneIndex : configuredIndex;
    const schema=models.some(model=>model.id===config.model)?modelSchemas.get(config.model):null;
    const availableModels=models.some(model=>model.id===config.model)?models:[{id:config.model || DEFAULT_GENERATION_MODEL,name:`${config.model || DEFAULT_GENERATION_MODEL} · 현재 목록에서 확인 필요`},...models];
    const status=generationStatus || {};
    const verified=status.available===true && (status.authenticated===true || status.authentication==='authenticated');
    const configured=status.configured===true || status.authentication==='configured' || status.authenticated==='configured';
    const provider=verified?{label:'사용 가능',tone:'lime',detail:'Higgsfield 연결과 인증을 확인했습니다.'}:configured?{label:'설정됨 · 확인 필요',tone:'',detail:'설정은 있지만 실제 사용 가능 여부를 확인하지 못했습니다.'}:status.available===true?{label:'가용성 확인 필요',tone:'',detail:'제공자 응답은 받았지만 인증 상태를 확인하지 못했습니다.'}:{label:'미설정 또는 사용 불가',tone:'coral',detail:'Higgsfield 연결을 확인하세요.'};
    const fields=(schema?.parameters || []).filter(field=>field.name!=='prompt' && !/array|object/.test(field.type));
    const requiredFields=fields.filter(field=>field.required);
    const optionalFields=fields.filter(field=>!field.required);
    const requiredParams=requiredFields.map(field=>generationParameterHtml(field,config.params || {})).join('');
    const optionalParams=optionalFields.map(field=>generationParameterHtml(field,config.params || {})).join('');
    const params=schema?`${requiredParams}${optionalParams?`<details class="generation-advanced"><summary>선택 설정</summary>${optionalParams}</details>`:''}`:'<p class="hint">모델 정보를 불러오면 설정 항목을 표시합니다.</p>';
    return `<p class="generation-flow" aria-label="생성 단계"><strong>1 프롬프트</strong><span aria-hidden="true">→</span><strong>2 설정</strong><span aria-hidden="true">→</span><strong>3 확인 후 실행</strong><span aria-hidden="true">→</span><strong>결과</strong></p><div class="generation-connection" role="status" aria-live="polite"><span class="badge ${provider.tone}">${provider.label}</span><p class="hint">${escapeHtml(generationError || status.detail || provider.detail)}</p><button class="small" data-wf-action="refresh-generation">연결·모델 확인</button></div><p class="generation-target"><strong>대상</strong> ${escapeHtml(selectedEpisode?.title || '에피소드 미선택')} · 장면 ${displaySceneIndex+1}${selectedScene?.title?` · ${escapeHtml(selectedScene.title)}`:''}</p><label>생성 모델<select data-wf-config="model" id="wf-generation-model">${availableModels.map(model=>`<option value="${escapeHtml(model.id)}" ${model.id===(config.model || DEFAULT_GENERATION_MODEL)?'selected':''}>${escapeHtml(model.name || model.id)}${model.type?` · ${escapeHtml(model.type)}`:''}</option>`).join('')}</select></label><label>대상 장면 번호<input type="number" min="1" max="60" step="1" data-wf-config="sceneIndex" value="${displaySceneIndex+1}"></label><label>생성 지시문<textarea id="wf-generation-prompt" aria-describedby="generation-safety" data-wf-config="prompt" maxlength="4000" rows="5" placeholder="비워두면 대상 장면의 화면 텍스트 또는 에피소드 주제를 사용합니다.">${escapeHtml(config.prompt || '')}</textarea></label>${schema?`<fieldset class="generation-parameters"><legend>필수 모델 설정</legend>${requiredParams || '<p class="hint">필수 추가 설정이 없습니다.</p>'}${optionalParams?`<details class="generation-advanced"><summary>선택 설정</summary>${optionalParams}</details>`:''}</fieldset>`:params}<p id="generation-safety" class="generation-safety wf-review-warning">이 화면을 여는 동안 생성 요청·저장·비용은 발생하지 않습니다. 실행 전 비용 견적과 별도 확인을 거칩니다. 실행하면 선택한 장면에 결과를 자동 적용하고 이어서 렌더합니다. 실패하거나 중단된 결과만 실행 결과에서 별도로 적용할 수 있습니다.</p>`;
  }
  function generationParameterHtml(field,params) {
    const value=params[field.name] ?? field.default ?? '',name=escapeHtml(field.name),required=field.required?'required':'';
    const caption=`${name}${field.required?' · 필수':''}`;
    const fieldType=field.type?.split('|').find(type=>type!=='null') || 'string';
    if (Array.isArray(field.enum)) return `<label>${caption}<select data-wf-param="${name}" data-param-type="${escapeHtml(field.type)}" ${required}><option value="">모델 기본값</option>${field.enum.map(item=>`<option value="${escapeHtml(item)}" ${String(item)===String(value)?'selected':''}>${escapeHtml(item)}</option>`).join('')}</select></label>`;
    if (fieldType==='boolean') return `<label class="generation-checkbox"><input type="checkbox" data-wf-param="${name}" data-param-type="boolean" ${value===true?'checked':''}>${caption}</label>`;
    if (['integer','number'].includes(fieldType)) return `<label>${caption}<input type="number" data-wf-param="${name}" data-param-type="${field.type}" value="${escapeHtml(value)}" ${Number.isFinite(field.minimum)?`min="${field.minimum}"`:''} ${Number.isFinite(field.maximum)?`max="${field.maximum}"`:''} step="${field.type==='integer'?'1':'any'}" ${required}></label>`;
    return `<label>${caption}<input data-wf-param="${name}" data-param-type="string" value="${escapeHtml(value)}" maxlength="4000" ${required}></label>`;
  }
  async function loadGeneration() {
    const target=selected,model=selectedNode()?.config?.model || 'seedance_2_5',sequence=++generationLoad;
    generationError='';
    const [status,catalog]=await Promise.allSettled([api('/api/generation/status'),api('/api/generation/models')]);
    if(sequence!==generationLoad)return;
    if(status.status==='fulfilled')generationStatus=status.value;else {generationStatus=null;generationError=status.reason.message;}
    if(catalog.status==='fulfilled')models=Array.isArray(catalog.value)?catalog.value:catalog.value.models || [];
    else {models=[];generationError=catalog.reason.message;}
    if(models.some(item=>item.id===model)) {
      try {const schema=await api(`/api/generation/models?model=${encodeURIComponent(model)}`);if(sequence!==generationLoad)return;modelSchemas.set(model,schema);}
      catch(error) {if(sequence!==generationLoad)return;modelSchemas.delete(model);generationError=error.message;}
    } else if(catalog.status==='fulfilled')generationError=`저장된 모델 ${model}은 현재 연결의 목록에 없습니다. 아래에서 사용할 모델을 직접 선택해 주세요.`;
    if(sequence===generationLoad && selected===target && selectedNode()?.config?.model===model && inspectorTab==='settings')refreshInspector();
  }
  function generationJobHtml(id) {
    const job=generationJobs.get(id),error=generationJobErrors.get(id);
    if(!job)return `<section class="generation-connection"><h4>생성 요청 기록</h4><p class="hint">${escapeHtml(error || '기존 생성 요청의 상태를 확인하고 있습니다.')}</p><button class="small" data-wf-action="refresh-generation-job" data-id="${escapeHtml(id)}">상태 다시 확인</button></section>`;
    const recoverable=['polling_failed','import_failed','manual_recovery'].includes(job.status);
    const canApply=job.status==='completed' && !job.applied;
    return `<section class="generation-connection" data-testid="generation-recovery"><h4>생성 요청 · ${escapeHtml(STATUS[job.status] || job.status)}</h4>${factsHtml({model:job.model,providerRequestId:job.providerRequestId,sceneId:job.sceneId,episodeVersion:job.episodeVersion,outputs:job.outputs})}${job.error || error?`<p class="wf-review-warning">${escapeHtml(error || job.error)}</p>`:''}<div class="row"><button class="small" data-wf-action="${recoverable?'recover-generation-job':'refresh-generation-job'}" data-id="${escapeHtml(id)}" ${pending?'disabled':''}>상태 다시 확인</button>${canApply?`<button class="small primary" data-wf-action="apply-generation-job" data-id="${escapeHtml(id)}" ${pending || hasEpisodeChanges?.(job.episodeId)?'disabled':''}>장면에 적용</button>`:''}</div><p class="hint">${job.applied?'생성 결과가 장면에 적용되었습니다.':canApply?'이미 생성한 파일을 적용합니다. 새 생성 요청은 보내지 않습니다.':'상태 확인은 기존 요청 ID만 조회하며 새로 생성하지 않습니다.'}</p>${hasEpisodeChanges?.(job.episodeId)?'<p class="wf-review-warning">이 에피소드의 편집을 먼저 저장해 주세요. 현재 초안은 유지됩니다.</p>':''}${!job.applied?'<p class="wf-review-warning">워크플로우 재실행은 새 생성 요청이며 추가 비용이 발생할 수 있습니다. 먼저 기존 결과를 확인해 주세요.</p>':''}</section>`;
  }
  async function loadGenerationJob(id) {
    clearTimeout(generationTimer);
    try {generationJobs.set(id,await api(`/api/generations/${encodeURIComponent(id)}`));generationJobErrors.delete(id);}
    catch(error) {generationJobErrors.set(id,error.message);}
    const isSelected=host?.isConnected && inspectorTab==='results' && activeRun()?.nodeRuns?.find(node=>node.nodeId===selected)?.output?.generationJobId===id;
    if(isSelected) {
      refreshInspector();
      if(['queued','submitting','pending','in_progress','downloading'].includes(generationJobs.get(id)?.status))generationTimer=setTimeout(()=>loadGenerationJob(id),2200);
    }
  }
  function refreshInspector() {
    const panels=[...host?.querySelectorAll('#wf-inspector,#wf-overlay-inspector') || []]; if (!panels.length) return;
    const focused=document.activeElement;
    const selector=focused?.dataset.wfConfig?`[data-wf-config="${focused.dataset.wfConfig}"]`:focused?.dataset.wfField?`[data-wf-field="${focused.dataset.wfField}"]`:null;
    panels.forEach(panel=>{const active=panel.contains(focused),start=active?focused.selectionStart:null,end=active?focused.selectionEnd:null,scroll=panel.scrollTop;panel.innerHTML=inspectorHtml();panel.scrollTop=scroll;if(active && selector){const replacement=panel.querySelector(selector);replacement?.focus({preventScroll:true});if(typeof start==='number' && replacement?.setSelectionRange && !['number','checkbox'].includes(replacement.type))replacement.setSelectionRange(start,end);}});
  }
  function stageInfo() {
    const node=selectedNode(),run=activeRun(),record=run?.nodeRuns?.find(item=>item.nodeId===node?.id);
    if (!node) return {node:null,state:'blocked',text:'노드를 선택하면 실행할 단계를 확인할 수 있습니다.',resumeRunId:null,canResume:false};
    const ancestors=[];
    const visit=id=>workflow.edges.filter(edge=>edge.target===id).forEach(edge=>{ const dep=workflow.nodes.find(item=>item.id===edge.source); if (dep && !ancestors.some(item=>item.id===dep.id)) { ancestors.push(dep); visit(dep.id); } });
    visit(node.id);
    const depReady=ancestors.every(dep=>['completed','succeeded','reused'].includes(run?.nodeRuns?.find(entry=>entry.nodeId===dep.id)?.status));
    const terminal=run && TERMINAL.has(run.status);
    const priorRunId=terminal ? run.id : null;
    const canResume=Boolean(run && ['failed','cancelled'].includes(run.status) && (!record || !['completed','succeeded','reused','awaiting_review'].includes(record.status)));
    if (LIVE.has(record?.status) || (run && LIVE.has(run.status) && !record)) return {node,state:'running',text:'선택한 단계가 실행 중입니다.',resumeRunId:null,canResume:false};
    if (!depReady) { const blocked=ancestors.filter(dep=>!['completed','succeeded','reused'].includes(run?.nodeRuns?.find(entry=>entry.nodeId===dep.id)?.status)); return {node,state:'blocked',text:`선행 단계가 필요합니다: ${blocked.map(dep=>nodeName(dep)).join(', ') || '연결된 출력'}`,resumeRunId:priorRunId,canResume:false}; }
    if (record?.status==='failed' || canResume) return {node,state:'blocked',text:'이전 실행이 실패했습니다. 완료된 출력은 재사용하고 이 단계부터 재개할 수 있습니다.',resumeRunId:priorRunId,canResume:Boolean(canResume && priorRunId)};
    if (['completed','succeeded','reused','awaiting_review'].includes(record?.status)) return {node,state:'completed',text:'선택한 단계가 완료되었습니다. 새 실행으로 다시 시작할 수 있습니다.',resumeRunId:priorRunId,canResume:false};
    return {node,state:'idle',text:'선택한 단계부터 실행할 준비가 되었습니다.',resumeRunId:priorRunId,canResume:false};
  }
  function stageDialogHtml() {
    const info=stageInfo();
    return `<div class="wf-overlay-header"><div><span class="eyebrow">STAGE CONTROL</span><h2 id="wf-stage-title">선택 단계 실행</h2></div><button type="button" data-wf-action="close-overlay" aria-label="단계 실행 닫기">닫기</button></div><p id="wf-stage-status" aria-live="polite" data-stage-state="${info.state}"><strong>${escapeHtml(info.node ? nodeName(info.node) : '선택된 노드 없음')}</strong><br>${escapeHtml(info.text)}</p><p class="hint">필수 선행 출력과 현재 에피소드·워크플로우 버전을 확인한 뒤 요청합니다. 생성 단계는 비용 확인 후 실행됩니다.</p><div class="dialog-actions"><button type="button" data-wf-action="stage-start" id="wf-stage-start" ${info.state==='blocked'||info.state==='running'||!info.node?'disabled':''}>선택 단계 시작</button>${info.canResume?`<button type="button" class="primary" data-wf-action="resume-stage">실패 실행에서 재개</button>`:''}</div>`;
  }
  function resultsDialogHtml() {
    const node=selectedNode();
    return `<div class="wf-overlay-header"><div><span class="eyebrow">RUN RESULTS</span><h2 id="wf-results-title">실행 결과와 기록</h2></div><button type="button" data-wf-action="close-overlay" aria-label="실행 결과 닫기">닫기</button></div><div id="wf-overlay-results-runs">${runsHtml()}</div><div id="wf-overlay-result-inspector">${node ? nodeResultsHtml(node) : '<p class="hint">캔버스에서 노드를 선택하세요.</p>'}</div>`;
  }
  function ensureAuxiliaryUi() {
    const canvas=$('#workflow-canvas');
    if (canvas && !$('#wf-minimap')) canvas.insertAdjacentHTML('beforeend',`<div id="wf-minimap" class="wf-minimap" tabindex="0" role="application" aria-label="워크플로우 미니맵. 화살표로 이동하고 노드를 선택하세요."><div id="wf-minimap-world">${minimapHtml()}</div><div id="wf-minimap-viewport" aria-hidden="true"></div></div>`);
    const header=host?.querySelector('.wf-graph-panel .panel-header .row:last-child');
    if (header && !header.querySelector('[data-wf-action="open-tools"]')) header.insertAdjacentHTML('beforeend','<button class="small" type="button" data-wf-action="open-tools">노드 도구</button><button class="small" type="button" data-wf-action="open-results">결과·기록</button><button class="small" type="button" data-wf-action="open-stage-overlay">단계 실행</button>');
    if (host && !$('#wf-tools-dialog')) host.insertAdjacentHTML('beforeend',`<dialog id="wf-tools-dialog" class="wf-overlay" aria-labelledby="wf-tools-title"><div class="wf-overlay-header"><div><span class="eyebrow">NODE TOOLS</span><h2 id="wf-tools-title">선택한 노드 도구</h2></div><button type="button" data-wf-action="close-overlay" aria-label="노드 도구 닫기">닫기</button></div><div class="wf-inspector-tabs" role="tablist" aria-label="노드 도구 탭">${inspectorTabsHtml()}</div><div class="wf-overlay-body" id="wf-overlay-inspector" role="tabpanel" tabindex="0">${inspectorHtml()}</div></dialog><dialog id="wf-results-dialog" class="wf-overlay" aria-labelledby="wf-results-title"><div class="wf-overlay-body">${resultsDialogHtml()}</div></dialog><dialog id="wf-stage-dialog" class="wf-overlay" aria-labelledby="wf-stage-title">${stageDialogHtml()}</dialog>`);
    drawMinimap();
  }
  function updateOverlayUi() {
    const stage=$('#wf-stage-dialog');
    if (stage) {
      const focused=document.activeElement, focusAction=focused?.dataset?.wfAction;
      const template=document.createElement('template'); template.innerHTML=stageDialogHtml();
      const nextStatus=template.content.querySelector('#wf-stage-status'),status=stage.querySelector('#wf-stage-status');
      if (status && nextStatus) { status.dataset.stageState=nextStatus.dataset.stageState; status.innerHTML=nextStatus.innerHTML; }
      const nextStart=template.content.querySelector('#wf-stage-start'),start=stage.querySelector('#wf-stage-start');
      if (start && nextStart) { start.disabled=nextStart.disabled; start.textContent=nextStart.textContent; }
      const actions=stage.querySelector('.dialog-actions'),nextResume=template.content.querySelector('[data-wf-action="resume-stage"]'),resume=stage.querySelector('[data-wf-action="resume-stage"]');
      if (actions && nextResume && !resume) actions.append(nextResume);
      if (resume && nextResume) { resume.disabled=nextResume.disabled; resume.textContent=nextResume.textContent; }
      if (resume && !nextResume) resume.remove();
      if (focused && !focused.isConnected) (stage.querySelector(`[data-wf-action="${focusAction || 'close-overlay'}"]`) || stage.querySelector('[data-wf-action="close-overlay"]'))?.focus({preventScroll:true});
    }
    const replacePanel=(panel,html)=>{
      if (!panel) return;
      const focused=panel.contains(document.activeElement) ? document.activeElement : null;
      const signature=focused ? {action:focused.dataset?.wfAction,id:focused.dataset?.id,run:focused.dataset?.run} : null;
      panel.innerHTML=html;
      if (focused?.isConnected || !signature?.action) return;
      const replacement=[...panel.querySelectorAll('[data-wf-action]')].find(element=>element.dataset.wfAction===signature.action && (!signature.id || element.dataset.id===signature.id) && (!signature.run || element.dataset.run===signature.run));
      replacement?.focus({preventScroll:true});
    };
    replacePanel($('#wf-overlay-results-runs'),runsHtml());
    replacePanel($('#wf-overlay-result-inspector'),selectedNode()?nodeResultsHtml(selectedNode()):'<p class="hint">캔버스에서 노드를 선택하세요.</p>');
  }

  function connectionsHtml() {
    return workflow.edges.map(edge=>`<div><span>${escapeHtml(nodeName(workflow.nodes.find(node=>node.id===edge.source)))} → ${escapeHtml(nodeName(workflow.nodes.find(node=>node.id===edge.target)))}</span><button class="icon-btn quiet danger" type="button" data-wf-action="delete-edge" data-id="${escapeHtml(edge.id)}" aria-label="연결 삭제">×</button></div>`).join('') || '<p class="hint">아직 연결이 없습니다.</p>';
  }

  function runsHtml() {
    if (!runs.length) return '<div class="panel-body hint">실행하면 각 노드의 상태와 결과가 이곳에 남습니다. 그래프의 기록용 연결이 아니라 실제 서버 작업을 실행합니다.</div>';
    return runs.slice(0,10).map(run=>`<article class="wf-run ${activeRun()?.id===run.id?'selected':''}"><div class="row between"><button class="quiet" data-wf-action="select-run" data-id="${escapeHtml(run.id)}"><span class="badge ${run.status==='awaiting_review'?'lime':''}">${escapeHtml(STATUS[run.status] || run.status)}</span> <span class="hint">${stamp(run.createdAt)} · 워크플로우 v${run.workflowVersion} · 에피소드 v${run.episodeVersion}</span></button>${LIVE.has(run.status)?`<button class="small danger" data-wf-action="cancel-run" data-id="${escapeHtml(run.id)}">실행 취소</button>`:''}</div><div class="wf-run-nodes">${(run.nodeRuns || []).map(node=>`<div class="wf-run-node"><button class="quiet" data-wf-action="inspect-run-node" data-id="${escapeHtml(node.nodeId)}" data-run="${escapeHtml(run.id)}"><span class="wf-status-dot ${escapeHtml(node.status)}"></span>${escapeHtml(nodeName(run.workflowSnapshot?.nodes.find(item=>item.id===node.nodeId) || node))}<span class="hint">${escapeHtml(STATUS[node.status] || node.status)} · 상세 보기 ↗</span></button>${node.error?`<p class="danger">${escapeHtml(node.error)}</p>`:''}</div>`).join('')}</div>${run.error?`<p class="danger">${escapeHtml(run.error)}</p>`:''}${outputLinks(run)}</article>`).join('');
  }

  function outputLinks(run) {
    const urls=[];
    for (const node of run.nodeRuns || []) { const output=node.output; if (output && typeof output==='object') { const url=output.outputUrl || output.job?.outputUrl; if (typeof url==='string' && /^\/api\/exports\/[a-zA-Z0-9_-]+\.mp4$/.test(url)) urls.push(url); } }
    return [...new Set(urls)].map(url=>`<a href="${escapeHtml(url)}" download>완성 MP4 다운로드 ↓</a>`).join('');
  }

  function renderedOutput(run) {
    const output=run?.nodeRuns?.find(node=>node.type==='render')?.output;
    const url=output?.outputUrl || output?.job?.outputUrl;
    return typeof url==='string' && /^\/api\/exports\/[a-zA-Z0-9_-]+\.mp4$/.test(url) ? {url,output} : null;
  }

  function reviewKey() {
    const run=activeRun();
    const current=getEpisodes().find(item=>item.id===run?.episodeId);
    return JSON.stringify([run?.id,run?.status,run?.review,current?.version,hasEpisodeChanges?.(run?.episodeId),pending]);
  }

  function reviewHtml() {
    const run=activeRun();
    const media=renderedOutput(run);
    if (!run || !media) return '';
    const current=getEpisodes().find(item=>item.id===run.episodeId);
    const version=run.episodeVersion ?? media.output.episodeVersion;
    const stale=!current || current.version!==version;
    const unsaved=hasEpisodeChanges?.(run.episodeId);
    const canReview=run.status==='awaiting_review' && !stale && !unsaved && !pending;
    const decision=run.review;
    return `<section class="panel section-spacer wf-review-panel" data-testid="render-review"><div class="panel-header"><div><span class="eyebrow">FINAL CUT · HUMAN REVIEW</span><h2>완성 영상 검토</h2></div><span class="badge ${run.status==='approved'?'lime':''}">${escapeHtml(STATUS[run.status] || run.status)}</span></div><div class="wf-review-grid"><div class="wf-review-screen"><video controls playsinline preload="metadata" src="${escapeHtml(media.url)}" aria-label="검토할 렌더 영상" data-testid="review-video"></video><a href="${escapeHtml(media.url)}" download>검토 영상 MP4 다운로드 ↓</a></div><div class="wf-review-details"><h3>${escapeHtml(current?.title || run.episodeId)}</h3><dl class="wf-review-facts"><div><dt>렌더 에피소드 버전</dt><dd>v${escapeHtml(version)}</dd></div><div><dt>현재 저장 버전</dt><dd>${current ? `v${Number(current.version)}` : '확인할 수 없음'}</dd></div><div><dt>워크플로우 버전</dt><dd>v${Number(run.workflowVersion)}</dd></div></dl>${stale ? '<p class="wf-review-warning" role="status">렌더 이후 에피소드가 변경되었습니다. 현재 편집본으로 워크플로우를 다시 실행한 뒤 검토하세요.</p>' : ''}${unsaved ? '<p class="wf-review-warning">이 에피소드에 저장하지 않은 편집이 있습니다. 먼저 편집을 저장하고 새 렌더를 검토하세요.</p>' : ''}${decision ? `<div class="wf-review-decision"><span class="eyebrow">RECORDED DECISION</span><h3>${escapeHtml(STATUS[decision.decision] || decision.decision)} · v${Number(decision.episodeVersion)}</h3><p>${escapeHtml(decision.notes || '검토 메모 없음')}</p><span class="hint">${stamp(decision.reviewedAt)}</span><details><summary>검토 파일 식별 정보</summary><p>작업 ${escapeHtml(decision.jobId)}</p><code>SHA-256 ${escapeHtml(decision.sha256)}</code></details></div>` : `<label for="wf-review-notes">검토 메모<textarea id="wf-review-notes" data-review-notes="${escapeHtml(run.id)}" maxlength="4000" rows="4" placeholder="자막, 음성, 장면 길이와 수정할 점을 기록하세요." ${run.status!=='awaiting_review'?'disabled':''}>${escapeHtml(reviewNotes.get(run.id) || '')}</textarea></label><div class="wf-review-actions"><button class="primary" data-wf-action="review-approve" data-testid="review-approve" ${!canReview?'disabled':''}>이 영상 승인</button><button data-wf-action="review-changes" data-testid="review-changes" ${!canReview?'disabled':''}>수정 요청</button></div>`}<p class="hint">승인 기록은 위 렌더 파일과 에피소드 버전에 연결됩니다. 승인해도 채널에 게시되지 않습니다.</p></div></div></section>`;
  }

  function refreshReview() {
    const target=$('#wf-review');
    const key=reviewKey();
    if (target && reviewSignature!==key) {
      target.innerHTML=reviewHtml();
      reviewSignature=key;
    }
  }

  async function recordReview(decision) {
    const run=activeRun();
    if (!run || run.status!=='awaiting_review') throw new Error('검토 대기 중인 실행 결과만 검토할 수 있습니다.');
    await onRunUpdated?.();
    const current=getEpisodes().find(item=>item.id===run.episodeId);
    if (!current || current.version!==run.episodeVersion || hasEpisodeChanges?.(run.episodeId)) throw new Error('에피소드가 변경되었습니다. 편집을 저장하고 현재 버전으로 다시 렌더링하세요.');
    try {
      const result=await post(`/api/workflows/${workflow.id}/runs/${run.id}/review`,{decision,notes:reviewNotes.get(run.id) || '',expectedEpisodeVersion:run.episodeVersion});
      runs=runs.map(item=>item.id===result.id?result:item);
      reviewNotes.delete(run.id);
      toast(decision==='approved'?'영상 승인을 기록했습니다. 채널에는 게시되지 않습니다.':'수정 요청을 기록했습니다. 스튜디오에서 편집한 뒤 다시 실행하세요.');
    } catch (error) {
      if (error.status===409) { await loadRuns(); await onRunUpdated?.(); throw new Error('검토 대상이 변경되어 기록하지 않았습니다. 최신 에피소드와 실행 결과를 확인하세요.'); }
      throw error;
    }
  }

  function paint() {
    if (!host?.isConnected) return;
    const openDialogs=[...host.querySelectorAll('dialog[open]')].map(dialog=>dialog.id);
    host.innerHTML=shell();
    ensureAuxiliaryUi();
    if (overlayTrigger && !overlayTrigger.isConnected) { const target=openDialogs.includes('wf-tools-dialog')?'open-tools':openDialogs.includes('wf-results-dialog')?'open-results':openDialogs.includes('wf-stage-dialog')?'open-stage-overlay':null; overlayTrigger=target?host.querySelector(`[data-wf-action="${target}"]`):null; }
    openDialogs.forEach(id=>{const dialog=$(`#${id}`);if(dialog && !dialog.open) try{dialog.showModal();}catch{} });
    reviewSignature=reviewKey();
    updateSummary();
    if (workflow) { if (needsFit) { fit(); needsFit=false; } else transform(); drawEdges(); drawMinimap(); }
  }

  function updateSummary() {
    const status=$('#wf-save-status');
    if (status) { status.textContent=saving?'저장 중…':dirty?'● 저장되지 않은 변경':workflow?.id?`✓ 버전 ${workflow.version} · 저장됨`:'워크플로우 없음'; status.className=dirty?'unsaved':'hint'; }
    if ($('[data-wf-action="undo"]')) $('[data-wf-action="undo"]').disabled=!drafts.canUndo || saving || pending;
    if ($('[data-wf-action="redo"]')) $('[data-wf-action="redo"]').disabled=!drafts.canRedo || saving || pending;
    if ($('[data-wf-action="save"]')) $('[data-wf-action="save"]').disabled=saving || !workflow || (!dirty && Boolean(workflow.id));
    const errors=workflowErrors(workflow);
    const validation=$('#wf-validation');
    if (validation) { validation.textContent=errors.length?errors.join(' '):'✓ 실행 가능한 연결입니다. 저장 후 선택한 에피소드에서 실행하세요.'; validation.className=`wf-validation ${errors.length?'invalid':'valid'}`; }
    const badge=$('#wf-node-type');
    if (badge) badge.textContent=selectedNode()?.type?.toUpperCase() || 'SELECT';
    if ($('#wf-history')) $('#wf-history').innerHTML=historyHtml();
  }

  function updateExecution() {
    if (!host?.isConnected) return;
    const run=activeRun();
    host.querySelectorAll('[data-status-node]').forEach(element=>{
      const record=run?.nodeRuns?.find(node=>node.nodeId===element.dataset.statusNode);
      element.textContent=STATUS[record?.status] || '실행 전';
      element.className=`wf-node-status ${record?.status || 'idle'}`;
    });
    if ($('#wf-runs')) $('#wf-runs').innerHTML=runsHtml();
    updateOverlayUi();
    if (inspectorTab==='results' && !$('#wf-inspector')?.contains(document.activeElement)) refreshInspector();
    refreshReview();
    const runButton=$('[data-wf-action="run"]');
    if (runButton) runButton.disabled=pending || running() || !episodeId;
    drawMinimap();
  }

  function drawEdges() {
    const svg=$('#wf-edges');
    if (!svg || !workflow) return;
    const paths=workflow.edges.map(edge=>{
      const source=workflow.nodes.find(node=>node.id===edge.source), target=workflow.nodes.find(node=>node.id===edge.target);
      if (!source || !target) return '';
      const x1=source.x+WIDTH,y1=source.y+HEIGHT-21,x2=target.x,y2=target.y+HEIGHT-21;
      const bend=Math.max(65,Math.abs(x2-x1)*0.45);
      // Route row-wrap connections through the gutter, inside the fit margin.
      const wrapsRow=x2<x1 && target.y>=source.y+HEIGHT+30;
      const laneY=(source.y+HEIGHT+target.y)/2;
      const path=wrapsRow
        ? `M ${x1} ${y1} C ${x1+24} ${y1}, ${x1+24} ${laneY}, ${x1+24} ${laneY} L ${x2-24} ${laneY} C ${x2-24} ${laneY}, ${x2-24} ${y2}, ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1+bend} ${y1}, ${x2-bend} ${y2}, ${x2} ${y2}`;
      return `<path d="${path}" class="${selected===source.id || selected===target.id?'selected':''}"/>`;
    }).join('');
    svg.innerHTML=paths;
  }
  function transform() {
    const world=$('#wf-world');
    if (world) world.style.transform=`translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
    const label=$('#wf-zoom-value');
    if (label) label.textContent=`${Math.round(scale*100)}%`;
    drawMinimap();
  }

  function fit() {
    const canvas=$('#workflow-canvas');
    if (!canvas || !workflow?.nodes.length) return;
    const left=Math.min(...workflow.nodes.map(node=>node.x)),top=Math.min(...workflow.nodes.map(node=>node.y));
    const right=Math.max(...workflow.nodes.map(node=>node.x+WIDTH)),bottom=Math.max(...workflow.nodes.map(node=>node.y+HEIGHT));
    scale=Math.max(0.25,Math.min(1.2,(canvas.clientWidth-80)/(right-left),(canvas.clientHeight-110)/(bottom-top)));
    pan={x:(canvas.clientWidth-(right-left)*scale)/2-left*scale,y:(canvas.clientHeight-50-(bottom-top)*scale)/2-top*scale};
    transform();
  }

  function zoom(factor,point) {
    const canvas=$('#workflow-canvas');
    if (!canvas) return;
    const anchor=point || {x:canvas.clientWidth/2,y:canvas.clientHeight/2};
    const previous=scale;
    scale=Math.max(0.25,Math.min(2,scale*factor));
    pan={x:anchor.x-(anchor.x-pan.x)*scale/previous,y:anchor.y-(anchor.y-pan.y)*scale/previous};
    transform();
  }

  function selectNode(nodeId) {
    drafts.closeGroup();
    selected=nodeId;
    host.querySelectorAll('.wf-node').forEach(element=>element.classList.toggle('selected',element.dataset.nodeId===nodeId));
    if ($('#wf-inspector')) $('#wf-inspector').innerHTML=inspectorHtml();
    updateSummary();
    drawEdges();
    if (selectedNode()?.type==='generate' && inspectorTab==='settings') loadGeneration();
    const jobId=activeRun()?.nodeRuns?.find(node=>node.nodeId===selected)?.output?.generationJobId;if(jobId && inspectorTab==='results')loadGenerationJob(jobId);
  }

  function connect(source,target) {
    if (source===target) throw new Error('노드를 자기 자신에 연결할 수 없습니다.');
    const first=workflow.nodes.find(node=>node.id===source),second=workflow.nodes.find(node=>node.id===target);
    if (!first || !second) throw new Error('연결할 두 노드를 선택하세요.');
    if (TYPE_ORDER.indexOf(first.type)>=TYPE_ORDER.indexOf(second.type)) throw new Error('트렌드 → 리서치 → 대본 → 스토리보드 → 생성(선택) → 렌더 → 검토 순서로 연결하세요.');
    if (workflow.edges.some(edge=>edge.source===source&&edge.target===target)) throw new Error('이미 연결된 노드입니다.');
    workflow.edges.push({id:newId(),source,target});
    connecting=null;
    changed();
    paint();
  }

  async function runSelectedStage(stageId,resumeRunId=null) {
    if (!episodeId) throw new Error('실행할 에피소드를 선택하세요.');
    await beforeRun?.(episodeId);
    await save();
    const expectedWorkflowVersion=Number(workflow?.version),expectedEpisodeVersion=Number(liveEpisode(episodeId)?.version);
    if (!Number.isInteger(expectedWorkflowVersion) || !Number.isInteger(expectedEpisodeVersion)) throw new Error('단계 실행 전에 에피소드와 워크플로우 버전을 확인할 수 없습니다.');
    const payload={episodeId,expectedWorkflowVersion,expectedEpisodeVersion,selectedStages:[stageId],startStage:stageId};
    const priorRunId=resumeRunId || (TERMINAL.has(activeRun()?.status) ? activeRun()?.id : null);
    if (priorRunId) payload.resumeRunId=priorRunId;
    const stage=workflow.nodes.find(node=>node.id===stageId);
    if (stage?.type==='generate') payload.allowGeneration=true;
    const result=await post(`/api/workflows/${workflow.id}/run`,payload);
    runs.unshift(result); selectedRunId=result.id; inspectorTab='results'; paint(); schedulePoll(); toast(priorRunId?'기존 실행 출력을 재사용해 선택 단계를 시작했습니다.':'선택한 단계를 시작했습니다.');
  }

  async function action(button) {
    const name=button.dataset.wfAction;
    if (name==='select-node' || name==='minimap-select') { selectNode(button.dataset.id); return; }
    if (name==='open-tools' || name==='open-results' || name==='open-stage-overlay') {
      const id=name==='open-tools'?'wf-tools-dialog':name==='open-results'?'wf-results-dialog':'wf-stage-dialog';
      const dialog=$(`#${id}`); if (!dialog) return; overlayTrigger=button; if (name==='open-results') inspectorTab='results'; updateOverlayUi(); if (!dialog.open) dialog.showModal(); return;
    }
    if (name==='close-overlay') { const dialog=button.closest('dialog'); dialog?.close(); const trigger=overlayTrigger; overlayTrigger=null; trigger?.focus({preventScroll:true}); return; }
    if (name==='inspector-tab') { inspectorTab=button.dataset.tab; drafts.closeGroup(); host.querySelectorAll('.wf-inspector-tabs').forEach(tab=>tab.innerHTML=inspectorTabsHtml()); refreshInspector(); if(inspectorTab==='settings' && selectedNode()?.type==='generate') loadGeneration(); return; }
    if (name==='undo' || name==='redo') { undoDraft(name==='redo'); return; }
    if (name==='history-version') {compareVersion=Number(button.dataset.version);if($('#wf-history'))$('#wf-history').innerHTML=historyHtml();if(inspectorTab==='history')refreshInspector();return;}
    if (name==='inspect-run-node') {selectedRunId=button.dataset.run;inspectorTab='results';selectNode(button.dataset.id);if($('.wf-inspector-tabs'))$('.wf-inspector-tabs').innerHTML=inspectorTabsHtml();updateExecution();$('#wf-inspector')?.scrollIntoView({block:'nearest'});return;}
    if (name==='close-dialog') {$('#wf-confirm-dialog')?.close();restoreVersion=null;generationConsent=false;generationStageRun=false;generationResumeRunId=null;generationConsentSnapshot=null;generationTargetEpisode=null;generationEstimate=null;generationEstimateKey='';generationEstimateError='';generationEstimateAcknowledged=false;return;}
    if (name==='estimate-ack') {generationEstimateAcknowledged=Boolean(button.checked);refreshDialogConfirmation();return;}
    if (name==='output') { connecting=button.dataset.id; selectNode(connecting); $('#wf-connect-hint').textContent=`${TYPES[selectedNode().type].name} 출력 선택됨 · 연결할 노드의 입력을 누르세요 · Esc 취소`; return; }
    if (name==='input') { if (!connecting) throw new Error('먼저 출발 노드의 출력을 누르세요.'); connect(connecting,button.dataset.id); return; }
    if (name==='zoom-in') { zoom(1.2); return; }
    if (name==='zoom-out') { zoom(1/1.2); return; }
    if (name==='fit') { fit(); return; }
    if (name==='select-run') { selectedRunId=button.dataset.id; updateExecution(); const jobId=activeRun()?.nodeRuns?.find(node=>node.nodeId===selected)?.output?.generationJobId;if(jobId && inspectorTab==='results')loadGenerationJob(jobId);return; }
    if (pending) return;
    pending=true;
    button.disabled=true;
    try {
      if (name==='stage-start' || name==='resume-stage') {
        const info=stageInfo(); if (!info.node || info.state==='running' || (info.state==='blocked' && !(name==='resume-stage' && info.resumeRunId))) throw new Error(info.text);
        const resumeId=info.resumeRunId;
        if (info.node.type==='generate') {
          const input=assertGenerationInput(generationInput()); generationConsent=true; generationStageRun=true; generationResumeRunId=resumeId; generationEstimate=null; generationEstimateKey=''; generationEstimateError=''; generationEstimateAcknowledged=false; generationConsentSnapshot={...input,key:generationInputKey(input)}; paint(); $('#wf-confirm-dialog')?.showModal(); await loadGenerationEstimate(); if (!generationConsent) return; paint(); $('#wf-confirm-dialog')?.showModal(); return;
        }
        await runSelectedStage(info.node.id,resumeId); return;
      }
      if (name==='save') { await save(); paint(); toast('워크플로우를 저장했습니다.'); }
      else if (name==='new') { if (dirty) await save(); workflow=initialGraph(); saved=null; selected=workflow.nodes[0].id; runs=[];versions=[];compareVersion=null; selectedRunId=null; connecting=null; needsFit=true;resetDrafts(); changed(); paint(); }
      else if (name==='reload') { await load(true); paint(); }
      else if (name==='discard') { workflow=copy(saved || workflows[0] || null); selected=workflow?.nodes[0]?.id || null; dirty=false; connecting=null; needsFit=true; revision++;resetDrafts(); await Promise.all([loadRuns(),loadVersions()]); paint(); }
      else if (name==='add-node') { const type=$('#wf-add-type').value; if (!TYPES[type] || workflow.nodes.some(node=>node.type===type)) throw new Error('각 종류의 노드는 하나만 추가할 수 있습니다.'); const node={id:newId(),type,x:Math.max(30,Math.round((100-pan.x)/scale)),y:Math.max(30,Math.round((120-pan.y)/scale)),config:type==='script'?{agent:'studio',prompt:''}:type==='generate'?generationConfig(0):{}}; workflow.nodes.push(node); selected=node.id;inspectorTab='settings'; changed(); paint();if(type==='generate')loadGeneration(); }
      else if (name==='delete-node') { workflow.nodes=workflow.nodes.filter(node=>node.id!==selected); workflow.edges=workflow.edges.filter(edge=>edge.source!==selected&&edge.target!==selected); selected=workflow.nodes[0]?.id || null; connecting=null; changed(); paint(); }
      else if (name==='delete-edge') { workflow.edges=workflow.edges.filter(edge=>edge.id!==button.dataset.id); changed(); paint(); }
      else if (name==='layout') { const ordered=[...workflow.nodes].sort((a,b)=>TYPE_ORDER.indexOf(a.type)-TYPE_ORDER.indexOf(b.type)); ordered.forEach((node,index)=>{node.x=50+index%3*285;node.y=65+Math.floor(index/3)*230;}); changed(); needsFit=true; paint(); }
      else if (name==='run' || name==='confirm-generation-run') {
        if (!episodeId) throw new Error('실행할 에피소드를 선택하세요.');
        if (name==='run' && workflow.nodes.some(node=>node.type==='generate')) {
          const input=assertGenerationInput(generationInput());
          generationConsent=true; restoreVersion=null; generationEstimate=null; generationEstimateKey=''; generationEstimateError=''; generationEstimateAcknowledged=false;
          generationConsentSnapshot={...input,key:generationInputKey(input)};
          paint(); $('#wf-confirm-dialog')?.showModal(); await loadGenerationEstimate(); if (!generationConsent) return; paint(); $('#wf-confirm-dialog')?.showModal(); return;
        }
        if (name==='confirm-generation-run') {
          const snapshot=generationConsentSnapshot;
          const current=assertGenerationInput(generationInput()),key=generationInputKey(current);
          if (!snapshot || key!==snapshot.key) throw new Error('생성 대상이나 설정이 바뀌었습니다. 비용을 다시 확인해 주세요.');
          if (!quoteLabel(generationEstimate) && !generationEstimateAcknowledged) throw new Error('비용 견적을 확인하거나 견적 없이 실행함을 확인해 주세요.');
          await beforeRun?.(episodeId);
          const prepared=assertGenerationInput(generationInput());
          if (generationInputKey(prepared)!==snapshot.key) throw new Error('저장 후 생성 대상이나 설정이 바뀌었습니다. 비용을 다시 확인해 주세요.');
          const generationNode=selectedNode()?.type==='generate' ? selectedNode() : workflow?.nodes.find(node=>node.type==='generate');
          if (generationNode && generationNode.config.sceneIndex!==prepared.sceneIndex) { generationNode.config.sceneIndex=prepared.sceneIndex; changed('generation:target'); }
          await save();
          const expectedWorkflowVersion=Number(workflow?.version);
          const expectedEpisodeVersion=Number(liveEpisode(episodeId)?.version);
          if (!Number.isInteger(expectedWorkflowVersion) || !Number.isInteger(expectedEpisodeVersion)) throw new Error('생성 전에 에피소드와 워크플로우 버전을 확인할 수 없습니다. 다시 시도해 주세요.');
          $('#wf-confirm-dialog')?.close(); generationConsent=false; generationConsentSnapshot=null;
          const generationPayload={episodeId,allowGeneration:true,expectedWorkflowVersion,expectedEpisodeVersion};
          if (generationStageRun) { const info=stageInfo(); generationPayload.selectedStages=[info.node.id]; generationPayload.startStage=info.node.id; if (generationResumeRunId) generationPayload.resumeRunId=generationResumeRunId; }
          $('#wf-confirm-dialog')?.close(); generationConsent=false; generationConsentSnapshot=null; generationStageRun=false; generationResumeRunId=null;
          const result=await post(`/api/workflows/${workflow.id}/run`,generationPayload);
          runs.unshift(result); selectedRunId=result.id; inspectorTab='results'; paint(); schedulePoll(); toast('제작을 시작했습니다. 결과를 확인하세요.');
          return;
        }
        $('#wf-confirm-dialog')?.close(); generationConsent=false; generationConsentSnapshot=null;
        await beforeRun?.(episodeId); await save(); const result=await post(`/api/workflows/${workflow.id}/run`,{episodeId}); runs.unshift(result); selectedRunId=result.id; inspectorTab='results'; paint(); schedulePoll(); toast('제작을 시작했습니다. 결과를 확인하세요.');
      }
      else if (name==='refresh-history') {await loadVersions();updateSummary();if(inspectorTab==='history')refreshInspector();}
      else if (name==='restore-workflow') {if(dirty || saving)throw new Error('현재 초안을 먼저 저장해 주세요.');restoreVersion=selectedVersion()?.version;generationConsent=false;paint();$('#wf-confirm-dialog')?.showModal();}
      else if (name==='confirm-restore') {
        if(dirty || saving || !restoreVersion)throw new Error('현재 초안을 저장하고 복원 버전을 다시 선택해 주세요.');
        const startRevision=revision,target=workflow.id,result=await post(`/api/workflows/${target}/restore`,{version:restoreVersion,expectedVersion:workflow.version});
        if(revision!==startRevision || workflow.id!==target)throw new Error('복원은 저장됐으며 로컬 편집은 보존했습니다. 최신 기록과 비교해 주세요.');
        workflow=copy(result);saved=copy(result);workflows=workflows.map(item=>item.id===result.id?copy(result):item);dirty=false;restoreVersion=null;selected=workflow.nodes.some(node=>node.id===selected)?selected:workflow.nodes[0]?.id;revision++;resetDrafts();await loadVersions();paint();toast(`새 버전 v${result.version}으로 복원했습니다. 이전 기록은 보존됩니다.`);
      }
      else if (name==='restore-node') {if(dirty || saving)throw new Error('현재 초안을 먼저 저장해 주세요.');const previous=selectedVersion()?.snapshot?.nodes.find(node=>node.id===selected);if(!previous)throw new Error('선택 버전에 이 노드가 없습니다.');const node=selectedNode();node.config=copy(previous.config);for(const key of ['label','notes']){if(previous[key]!==undefined)node[key]=previous[key];else delete node[key];}changed();inspectorTab='settings';paint();toast('선택한 노드의 설정을 초안에 불러왔습니다. 저장하면 새 버전이 됩니다.');}
      else if (name==='refresh-generation') {await loadGeneration();}
      else if (name==='refresh-generation-job') {await loadGenerationJob(button.dataset.id);}
      else if (name==='recover-generation-job') {await post(`/api/generations/${encodeURIComponent(button.dataset.id)}/recover`);await loadGenerationJob(button.dataset.id);toast('기존 생성 요청의 상태를 다시 확인합니다. 새 생성 요청은 보내지 않았습니다.');}
      else if (name==='apply-generation-job') {
        const job=generationJobs.get(button.dataset.id);
        if(!job || job.status!=='completed' || job.applied)throw new Error('적용 가능한 완료 결과를 먼저 확인해 주세요.');
        if(hasEpisodeChanges?.(job.episodeId))throw new Error('에피소드 편집을 먼저 저장해 주세요. 현재 초안은 보존됩니다.');
        await onRunUpdated?.();
        const current=getEpisodes().find(item=>item.id===job.episodeId);
        if(!current || hasEpisodeChanges?.(job.episodeId))throw new Error('에피소드가 변경되었습니다. 현재 편집을 저장하고 다시 확인해 주세요.');
        await post(`/api/generations/${encodeURIComponent(job.id)}/apply`,{expectedVersion:current.version,sceneId:job.sceneId});await onRunUpdated?.();await loadGenerationJob(job.id);toast('기존 생성 결과를 장면의 새 버전으로 적용했습니다. 새 생성 비용은 발생하지 않습니다.');
      }
      else if (name==='refresh-runs') { await loadRuns(); updateExecution(); }
      else if (name==='cancel-run') { await post(`/api/workflows/${workflow.id}/runs/${button.dataset.id}/cancel`); await loadRuns(); updateExecution(); toast('실행 취소를 요청했습니다.'); }
      else if (name==='review-approve' || name==='review-changes') { await recordReview(name==='review-approve'?'approved':'changes_requested'); }
    } finally { pending=false; button.disabled=false; updateSummary();updateExecution(); }
  }

  function generationDraft(targetEpisode, sceneIndex, model = '') {
    const script = {id:newId(),type:'script',x:50,y:120,config:{agent:'existing',prompt:''}};
    const storyboard = {id:newId(),type:'storyboard',x:335,y:120,config:{}};
    const generate = {id:newId(),type:'generate',x:620,y:120,config:generationConfig(sceneIndex,model)};
    const render = {id:newId(),type:'render',x:905,y:120,config:{}};
    const review = {id:newId(),type:'review',x:1190,y:120,config:{}};
    const nodes = [script,storyboard,generate,render,review];
    return {name:`${targetEpisode?.title || '에피소드'} 생성 초안`,nodes,edges:nodes.slice(1).map((node,index)=>({id:newId(),source:nodes[index].id,target:node.id}))};
  }
  async function loadGenerationCatalog() {
    const [status,catalog] = await Promise.allSettled([api('/api/generation/status'),api('/api/generation/models')]);
    if (status.status === 'fulfilled') generationStatus = status.value;
    if (catalog.status === 'fulfilled') models = Array.isArray(catalog.value) ? catalog.value : catalog.value.models || [];
    return {status:generationStatus || {},models};
  }

  function activeCatalogModel(status, catalog) {
    const transport = status?.transport;
    return catalog.find(item => !transport || !item.transport || item.transport === transport)?.id || catalog[0]?.id || '';
  }

  function liveEpisode(targetId) {
    return getEpisode?.(targetId) || getEpisodes().find(item => item.id === targetId);
  }

  async function openGeneration({episode:targetEpisodeSnapshot,episodeId:targetEpisodeId,sceneIndex:targetSceneIndex,sceneId:targetSceneId} = {}) {
    await load();
    if (dirty) throw new Error('현재 워크플로우 변경을 먼저 저장하거나 되돌려 주세요.');
    const targetId = targetEpisodeId || episodeId;
    const targetEpisode = targetEpisodeSnapshot?.id===targetId ? targetEpisodeSnapshot : (liveEpisode(targetId) || getEpisodes()[0]);
    if (!targetEpisode) throw new Error('먼저 에피소드를 선택하세요.');
    const scenes = targetEpisode.scenes || [];
    const requestedIndex = Math.max(0, Number(targetSceneIndex ?? 0) || 0);
    const scene = targetSceneId ? scenes.find(item => item.id === targetSceneId) : scenes[Math.min(requestedIndex, Math.max(0, scenes.length - 1))];
    if (!scene) throw new Error('선택한 장면을 찾을 수 없습니다. 장면 목록을 확인한 뒤 다시 시도하세요.');
    const index = scenes.findIndex(item => item.id === scene.id);
    episodeId = targetEpisode.id;
    generationTargetEpisode = targetEpisode;
    generationTargetSceneId = scene.id;
    const existingScript=workflow?.nodes.find(item=>item.type==='script');
    let node = existingScript?.config?.agent==='existing' ? workflow.nodes.find(item=>item.type==='generate') : null;
    if (!node) {
      const catalog = await loadGenerationCatalog();
      saved = copy(workflow);
      workflow = generationDraft(targetEpisode,index,activeCatalogModel(catalog.status,catalog.models));
      runs=[]; versions=[]; compareVersion=null; selectedRunId=null; connecting=null; needsFit=true;
      node = workflow.nodes.find(item => item.type === 'generate');
      selected = node.id;
      inspectorTab = 'settings';
      resetDrafts();
      changed('generation:draft');
    } else {
      const config = node.config ||= generationConfig(index);
      let changedNode = false;
      if (!config.model) { config.model = models[0]?.id || DEFAULT_GENERATION_MODEL; changedNode = true; }
      if (config.sceneIndex !== index) { config.sceneIndex = index; changedNode = true; }
      if (changedNode) changed('generation:target');
      selected = node.id;
      inspectorTab = 'settings';
    }
    generationEstimate = null; generationEstimateKey=''; generationEstimateError=''; generationEstimateAcknowledged=false;
    paint();
    if (node && selectedNode()?.type === 'generate') await loadGeneration();
    return workflow;
  }

  function mount() {
    host=document.querySelector('#workflow-host');
    if (!host || host.dataset.wfMounted==='true') return;
    host.dataset.wfMounted='true';
    mountController=new AbortController();
    paint();
    if (selectedNode()?.type==='generate' && inspectorTab==='settings') loadGeneration();
    host.addEventListener('click',event=>{const button=event.target.closest('[data-wf-action]');if(button) action(button).catch(error=>toast(error.status===409?'워크플로우가 다른 작업에서 변경됐습니다. 현재 편집을 보존했습니다. 새 이름으로 복사하거나 변경을 되돌린 뒤 새로고침하세요.':error.message,true));});
    host.addEventListener('close',event=>{if(!event.target.matches('dialog.wf-overlay'))return;const trigger=overlayTrigger;overlayTrigger=null;trigger?.focus({preventScroll:true});});
    host.addEventListener('input',event=>{
      const target=event.target;
      if (target.dataset.reviewNotes) { reviewNotes.set(target.dataset.reviewNotes,target.value); return; }
      if (target.id==='wf-name') {workflow.name=target.value;changed('name');}
      else if (target.dataset.wfField && selectedNode()) {const key=target.dataset.wfField;if(target.value)selectedNode()[key]=target.value;else delete selectedNode()[key];changed(`${selected}:${key}`);const label=host.querySelector(`[data-node-id="${selected}"] .wf-node-label`);if(label)label.textContent=nodeName(selectedNode());}
      else if (target.dataset.wfConfig && selectedNode()) {
        const key=target.dataset.wfConfig,node=selectedNode();node.config ||= {};
        if (target.type==='number' && target.value!=='' && !target.checkValidity()) return;
        if (key==='limit' && target.value==='') delete node.config.limit;
        else if (key==='sceneIndex') {if(target.value==='')return;node.config.sceneIndex=Number(target.value)-1;const targetEpisode=liveEpisode(episodeId) || generationTargetEpisode;generationTargetSceneId=targetEpisode?.scenes?.[node.config.sceneIndex]?.id || null;}
        else node.config[key]=target.type==='number'?Number(target.value):target.value;
        if(key==='model')node.config.params={};
        if (node.type==='generate' && ['model','sceneIndex','prompt'].includes(key)) invalidateGenerationEstimate();
        changed(`${selected}:config:${key}`);const content=host.querySelector(`[data-node-id="${selected}"] .wf-node-content p`);if(content)content.textContent=nodeSummary(node);
      }
      else if (target.dataset.wfParam && selectedNode()) {
        if (!target.checkValidity()) return;
        const params=selectedNode().config.params ||= {},key=target.dataset.wfParam,type=target.dataset.paramType;
        if(target.value==='' && target.type!=='checkbox') delete params[key];
        else params[key]=type==='boolean'?target.checked:['integer','number'].includes(type)?Number(target.value):target.value;
        changed(`${selected}:param:${key}`);
        if (selectedNode().type==='generate') invalidateGenerationEstimate();
      }
      else if (target.dataset.wfCoordinate && selectedNode() && target.checkValidity() && target.value!=='') {selectedNode()[target.dataset.wfCoordinate]=Number(target.value);updateNodePosition(selectedNode());changed(`${selected}:coordinate:${target.dataset.wfCoordinate}`);}
    });
    host.addEventListener('focusout',()=>drafts.closeGroup());
    host.addEventListener('change',async event=>{
      if (event.target.id==='wf-episode') {episodeId=event.target.value || null;generationTargetEpisode=null;generationTargetSceneId=null;generationConsent=false;generationConsentSnapshot=null;invalidateGenerationEstimate();}
      if (event.target.id==='wf-select') {const choice=event.target.value;if(!choice)return;try{if(dirty)await save();workflow=copy(workflows.find(item=>item.id===choice));saved=copy(workflow);dirty=false;selected=workflow.nodes[0]?.id;connecting=null;needsFit=true;compareVersion=null;generationTargetEpisode=null;generationTargetSceneId=null;generationConsent=false;generationConsentSnapshot=null;invalidateGenerationEstimate();resetDrafts();await Promise.all([loadRuns(),loadVersions()]);paint();}catch(error){event.target.value=workflow?.id || '';toast(error.message,true);}}
      if (event.target.id==='wf-inspector-run') {selectedRunId=event.target.value;refreshInspector();const jobId=activeRun()?.nodeRuns?.find(node=>node.nodeId===selected)?.output?.generationJobId;if(jobId)loadGenerationJob(jobId);}
      if (event.target.id==='wf-node-history-version') {compareVersion=Number(event.target.value);refreshInspector();if($('#wf-history'))$('#wf-history').innerHTML=historyHtml();}
      if (event.target.dataset.wfConfig==='model') await loadGeneration();
      updateExecution();
    });
    host.addEventListener('submit',event=>{
      if (event.target.id!=='wf-connect-form') return;
      event.preventDefault();
      const form=new FormData(event.target);
      try { connect(String(form.get('source') || ''),String(form.get('target') || '')); }
      catch(error) { toast(error.message,true); }
    });
    host.addEventListener('wheel',event=>{const canvas=event.target.closest('#workflow-canvas');if(!canvas)return;event.preventDefault();const rect=canvas.getBoundingClientRect();zoom(Math.exp(-event.deltaY*0.0015),{x:event.clientX-rect.left,y:event.clientY-rect.top});},{passive:false});
    host.addEventListener('pointerdown',event=>{
      const canvas=event.target.closest('#workflow-canvas');
      if (!canvas || event.button!==0 || event.target.closest('.wf-port,.wf-zoom,select,input')) return;
      const header=event.target.closest('.wf-node-header');
      if (header) {selectNode(header.dataset.id);const node=selectedNode();drag={type:'node',id:node.id,x:event.clientX,y:event.clientY,nodeX:node.x,nodeY:node.y,moved:false};}
      else if (!event.target.closest('.wf-node')) drag={type:'pan',x:event.clientX,y:event.clientY,panX:pan.x,panY:pan.y};
      else return;
      host.setPointerCapture(event.pointerId);
      canvas.classList.add('dragging');
    });
    host.addEventListener('pointermove',event=>{
      if (!drag) return;
      if (drag.type==='pan') {pan={x:drag.panX+event.clientX-drag.x,y:drag.panY+event.clientY-drag.y};transform();}
      else {const node=workflow.nodes.find(item=>item.id===drag.id);node.x=Math.max(0,Math.min(10000,drag.nodeX+(event.clientX-drag.x)/scale));node.y=Math.max(0,Math.min(10000,drag.nodeY+(event.clientY-drag.y)/scale));drag.moved=true;updateNodePosition(node);}
    });
    const finishDrag=()=>{if(drag?.type==='node'&&drag.moved){const node=workflow.nodes.find(item=>item.id===drag.id);node.x=Math.round(node.x/10)*10;node.y=Math.round(node.y/10)*10;updateNodePosition(node);changed();}drag=null;$('#workflow-canvas')?.classList.remove('dragging');};
    host.addEventListener('pointerup',finishDrag);
    host.addEventListener('pointercancel',finishDrag);
    host.addEventListener('keydown',event=>{
      const minimap=event.target.closest('#wf-minimap');
      if (minimap && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) { event.preventDefault(); const delta=event.key==='ArrowLeft'?50:event.key==='ArrowRight'?-50:0; const vertical=event.key==='ArrowUp'?50:event.key==='ArrowDown'?-50:0; pan={x:pan.x+delta,y:pan.y+vertical}; transform(); return; }
      if (minimap && ['Enter',' '].includes(event.key)) { event.preventDefault(); const current=minimap.querySelector('.wf-minimap-node.selected') || minimap.querySelector('.wf-minimap-node'); if (current) selectNode(current.dataset.id); return; }
      if ((event.ctrlKey || event.metaKey) && !event.target.closest('input,textarea,select,[contenteditable="true"]') && ['z','y'].includes(event.key.toLowerCase())) {event.preventDefault();undoDraft(event.shiftKey || event.key.toLowerCase()==='y');return;}
      if (event.key==='Escape') {connecting=null;if($('#wf-connect-hint'))$('#wf-connect-hint').textContent='연결 선택 취소됨 · 출력 → 입력으로 다시 연결하세요.';}
      const header=event.target.closest('.wf-node-header');
      if (header && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {event.preventDefault();const node=workflow.nodes.find(item=>item.id===header.dataset.id);node.x=Math.max(0,Math.min(10000,node.x+(event.key==='ArrowLeft'?-10:event.key==='ArrowRight'?10:0)));node.y=Math.max(0,Math.min(10000,node.y+(event.key==='ArrowUp'?-10:event.key==='ArrowDown'?10:0)));updateNodePosition(node);changed();}
    });
  }

  function updateNodePosition(node) {
    const element=host?.querySelector(`[data-node-id="${node.id}"]`);
    if (element) {element.style.left=`${node.x}px`;element.style.top=`${node.y}px`;}
    if (selected===node.id) {if($('#wf-node-x'))$('#wf-node-x').value=Math.round(node.x);if($('#wf-node-y'))$('#wf-node-y').value=Math.round(node.y);}
    drawEdges();
  }

  function destroy() {
    pollEpoch++;
    clearTimeout(timer); timer=null;
    clearTimeout(generationTimer); generationTimer=null;
    if (minimapRaf) cancelAnimationFrame(minimapRaf); minimapRaf=0;
    mountController?.abort(); mountController=null;
    if (host) { host.dataset.wfMounted=''; host.innerHTML=''; }
    host=null; overlayTrigger=null;
  }
  return {load,mount,destroy,save,openGeneration,hasChanges:()=>dirty,html:()=>'<div id="workflow-host"></div>'};
}
