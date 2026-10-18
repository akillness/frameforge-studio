// A dependency-free executable workflow editor. Knowledge graph remains separate.
const TYPES = {
  trend:{name:'트렌드 수집',icon:'↗',summary:'Google RSS · 관심 키워드',color:'#81cfa9'},
  research:{name:'리서치 정리',icon:'⌕',summary:'소재와 출처 · 제작 맥락',color:'#87bded'},
  script:{name:'대본 작성',icon:'✳',summary:'Studio / 외부 에이전트',color:'#c9f079'},
  storyboard:{name:'스토리보드',icon:'▦',summary:'대본을 편집 가능한 장면으로',color:'#dfc48f'},
  render:{name:'영상 렌더',icon:'▶',summary:'FFmpeg · MP4 실제 생성',color:'#ffac96'},
  review:{name:'사람의 검토',icon:'✓',summary:'검토 대기 · 자동 게시 없음',color:'#c5b3ef'},
};
const TYPE_ORDER = Object.keys(TYPES);
const STATUS = {queued:'대기',pending:'대기',running:'실행 중',completed:'완료',succeeded:'완료',failed:'실패',cancelled:'취소됨',cancelling:'취소 요청됨',skipped:'건너뜀',awaiting_review:'사람의 검토 대기'};
STATUS.approved='승인됨';
STATUS.changes_requested='수정 요청';
const LIVE = new Set(['queued','pending','running','cancelling']);
const WIDTH = 210;
const HEIGHT = 140;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const copy = value => structuredClone(value);
const newId = () => crypto.randomUUID();
const stamp = value => value ? new Date(value).toLocaleString('ko-KR',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';

function initialGraph() {
  const nodes = TYPE_ORDER.map((type,index)=>({id:newId(),type,x:50 + index % 3 * 285,y:65 + Math.floor(index / 3) * 230,config:type === 'script' ? {agent:'studio',prompt:''} : {}}));
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
  for (const type of ['script','storyboard','render','review']) if (counts[type] !== 1) errors.push(`${TYPES[type].name} 노드는 하나가 필요합니다.`);
  for (const type of ['trend','research']) if (counts[type] > 1) errors.push(`${TYPES[type].name} 노드는 하나만 사용할 수 있습니다.`);
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
  return [...new Set(errors)];
}

export function createWorkflowEditor({api,toast,getEpisodes,hasEpisodeChanges,beforeRun,onRunUpdated}) {
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
  let host = null;
  let connecting = null;
  let drag = null;
  let scale = 1;
  let pan = {x:0,y:0};
  let needsFit = true;
  let timer = null;
  const reviewNotes = new Map();
  let reviewSignature = '';
  const $ = selector => host?.querySelector(selector);
  const post = (path,data={}) => api(path,{method:'POST',body:JSON.stringify(data)});
  const activeRun = () => runs.find(run=>run.id===selectedRunId) || runs[0];
  const running = () => runs.some(run=>LIVE.has(run.status));
  const selectedNode = () => workflow?.nodes.find(node=>node.id===selected);
  function changed() { dirty=true; revision++; updateSummary(); }

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
    await loadRuns();
  }

  async function loadRuns() {
    if (!workflow?.id) { runs=[]; return; }
    const targetId = workflow.id;
    const result = await api(`/api/workflows/${targetId}/runs`);
    if (workflow?.id !== targetId) return;
    const latest = Array.isArray(result) ? result : result.runs || [];
    const wasLive = running();
    runs = latest.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!selectedRunId || !runs.some(run=>run.id===selectedRunId)) selectedRunId = runs[0]?.id;
    if (wasLive && !running()) await onRunUpdated?.();
    schedulePoll();
  }

  function schedulePoll() {
    clearTimeout(timer);
    if (!running()) return;
    timer=setTimeout(async()=>{
      try { await loadRuns(); updateExecution(); }
      catch (error) { toast(`워크플로우 상태 갱신 실패: ${error.message}`,true); schedulePoll(); }
    },2200);
  }

  async function save() {
    if (!workflow) throw new Error('워크플로우를 먼저 만드세요.');
    if (!dirty && workflow.id) return workflow;
    const errors = workflowErrors(workflow);
    if (errors.length) throw new Error(errors.join(' '));
    const startRevision = revision;
    const body = {name:workflow.name.trim(),nodes:workflow.nodes,edges:workflow.edges,...(workflow.id ? {expectedVersion:workflow.version} : {})};
    const result = await api(workflow.id ? `/api/workflows/${workflow.id}` : '/api/workflows',{method:workflow.id ? 'PUT' : 'POST',body:JSON.stringify(body)});
    saved = copy(result);
    const index = workflows.findIndex(item=>item.id===result.id);
    if (index>=0) workflows[index]=copy(result); else workflows.unshift(copy(result));
    if (revision !== startRevision) { workflow.id=result.id; workflow.version=result.version; throw new Error('저장 중 추가한 편집을 보존했습니다. 다시 저장해 주세요.'); }
    workflow=copy(result);
    dirty=false;
    updateSummary();
    return result;
  }

  function options(selectedId,omitId) {
    return workflow.nodes.filter(node=>node.id!==omitId).map(node=>`<option value="${escapeHtml(node.id)}" ${selectedId===node.id?'selected':''}>${TYPES[node.type]?.name || escapeHtml(node.type)}</option>`).join('');
  }

  function shell() {
    const episodes = getEpisodes();
    if (!episodes.some(item=>item.id===episodeId)) episodeId=episodes[0]?.id || null;
    return `<div class="page-heading"><div><h1>제작을 연결하고, 실행하세요</h1><p>소재 조사부터 영상 렌더와 검토까지, 노드로 만드는 제작 워크플로우.</p></div><div class="row"><button data-wf-action="new">＋ 새 워크플로우</button><button data-wf-action="save" ${!workflow?'disabled':''}>워크플로우 저장</button><button class="primary" data-wf-action="run" ${!workflow || !episodeId || running()?'disabled':''}>▶ 워크플로우 실행</button></div></div>
    <section class="panel wf-toolbar"><label>저장된 워크플로우<select id="wf-select" aria-label="워크플로우 선택"><option value="">${workflow&&!workflow.id?'저장되지 않은 새 워크플로우':'선택하세요'}</option>${workflows.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===workflow?.id?'selected':''}>${escapeHtml(item.name)}</option>`).join('')}</select></label><label>실행 대상 에피소드<select id="wf-episode" aria-label="워크플로우 실행 에피소드"><option value="">에피소드를 선택하세요</option>${episodes.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===episodeId?'selected':''}>${escapeHtml(item.title)}</option>`).join('')}</select></label><div class="wf-save-state"><span id="wf-save-status" class="hint"></span><div class="row"><button class="small quiet" data-wf-action="reload">새로고침</button><button class="small quiet" data-wf-action="discard">변경 되돌리기</button></div></div></section>
    ${!workflow ? '<div class="panel empty"><div class="empty-mark">⌘</div><h2>실행 가능한 제작 흐름을 만드세요</h2><p>새 워크플로우에서 노드를 연결하고<br>에피소드를 선택해 실제 작업을 실행하세요.</p></div>' : `<div class="wf-layout"><section class="panel wf-graph-panel"><div class="panel-header"><div class="row"><span class="eyebrow">WORKFLOW CANVAS</span><span class="badge">${workflow.nodes.length} NODES</span></div><div class="row"><select id="wf-add-type" aria-label="추가할 노드 종류">${TYPE_ORDER.map(type=>`<option value="${type}" ${workflow.nodes.some(node=>node.type===type)?'disabled':''}>${TYPES[type].name}</option>`).join('')}</select><button class="small" data-wf-action="add-node">＋ 노드</button></div></div><div id="workflow-canvas" class="wf-canvas" tabindex="0" aria-label="워크플로우 캔버스. 노드 제목을 드래그해 이동하고 출력과 입력을 순서대로 선택해 연결하세요."><div id="wf-world" class="wf-world"><svg id="wf-edges" class="wf-edges" aria-hidden="true"></svg><div id="wf-nodes">${nodesHtml()}</div></div><div class="wf-canvas-hint" id="wf-connect-hint">빈 공간 드래그 · 휠 확대/축소 · 출력 → 입력 연결</div><div class="wf-zoom"><button class="icon-btn" data-wf-action="zoom-out" aria-label="축소">−</button><span id="wf-zoom-value">100%</span><button class="icon-btn" data-wf-action="zoom-in" aria-label="확대">+</button><button class="small" data-wf-action="fit">전체 보기</button><button class="small" data-wf-action="layout">자동 배치</button></div></div><div id="wf-validation" class="wf-validation" role="status"></div></section><aside class="wf-side"><section class="panel"><div class="panel-header"><h3>워크플로우 설정</h3><span class="badge">DAG</span></div><div class="panel-body"><label>이름<input id="wf-name" value="${escapeHtml(workflow.name)}" maxlength="160"></label><p class="hint">대본 → 스토리보드 → 렌더 → 사람의 검토가 필수입니다. 트렌드와 리서치는 선택 단계입니다.</p></div></section><section class="panel"><div class="panel-header"><h3>노드 설정</h3><span class="badge" id="wf-node-type"></span></div><div class="panel-body" id="wf-inspector">${inspectorHtml()}</div></section><section class="panel"><div class="panel-header"><h3>노드 연결</h3></div><form id="wf-connect-form" class="panel-body"><label>출력 노드<select name="source" aria-label="연결 출발 노드">${options(selected)}</select></label><label>입력 노드<select name="target" aria-label="연결 도착 노드">${options(null)}</select></label><button class="small" type="submit">연결 추가 →</button><div class="wf-connection-list">${connectionsHtml()}</div></form></section></aside></div><section class="panel section-spacer"><div class="panel-header"><h2>실행 기록</h2><button class="small" data-wf-action="refresh-runs">↻ 실행 상태 확인</button></div><div id="wf-runs">${runsHtml()}</div></section><div id="wf-review">${reviewHtml()}</div>`}`;
  }

  function nodesHtml() {
    return workflow.nodes.map(node=>{
      const type=TYPES[node.type] || {name:node.type,icon:'?',summary:'알 수 없는 단계',color:'#999999'};
      const record=activeRun()?.nodeRuns?.find(item=>item.nodeId===node.id);
      return `<article class="wf-node ${selected===node.id?'selected':''}" data-node-id="${escapeHtml(node.id)}" style="left:${Number(node.x)||0}px;top:${Number(node.y)||0}px;--node-color:${type.color}"><button class="wf-node-header" data-wf-action="select-node" data-id="${escapeHtml(node.id)}" title="드래그하여 이동. 선택 후 방향키로 이동할 수 있습니다."><span class="wf-node-icon">${type.icon}</span><span>${type.name}</span><span class="wf-grip" aria-hidden="true">⠿</span></button><div class="wf-node-content"><p>${escapeHtml(node.type==='script' ? `${node.config?.agent || 'studio'} · ${node.config?.prompt ? '사용자 지시문' : '에피소드 소재 사용'}` : type.summary)}</p><span class="wf-node-status ${record?.status || 'idle'}" data-status-node="${escapeHtml(node.id)}">${STATUS[record?.status] || '실행 전'}</span></div><button class="wf-port input" data-wf-action="input" data-id="${escapeHtml(node.id)}" aria-label="${type.name} 입력 연결" title="입력 연결"><span></span>입력</button><button class="wf-port output" data-wf-action="output" data-id="${escapeHtml(node.id)}" aria-label="${type.name} 출력 연결" title="출력 연결">출력<span></span></button></article>`;
    }).join('');
  }

  function inspectorHtml() {
    const node=selectedNode();
    if (!node) return '<p class="hint">캔버스에서 노드를 선택하세요.</p>';
    return `<h3>${TYPES[node.type]?.name || escapeHtml(node.type)}</h3>${node.type==='script'?`<label>실행 에이전트<select id="wf-agent" data-wf-config="agent">${['existing','studio','codex','jeo','jeopi','hermes'].map(agent=>`<option value="${agent}" ${(node.config?.agent || 'studio')===agent?'selected':''}>${agent==='existing'?'저장된 편집본 사용':agent==='studio'?'Studio · 규칙 기반':agent.toUpperCase()+' · 외부 연결'}</option>`).join('')}</select></label><label>제작 지시문<textarea id="wf-prompt" data-wf-config="prompt" maxlength="4000" rows="5" placeholder="대상 시청자, 톤, 장면 구성 지시">${escapeHtml(node.config?.prompt || '')}</textarea></label><p class="hint">저장된 편집본 사용는 기존 장면과 생성된 음성을 유지해 렌더링합니다. 이 모드에서 지시문은 사용되지 않습니다. Studio는 규칙 기반입니다. 외부 에이전트는 실제 호스트 연결이 필요하며, 연결 실패는 실행 기록에 남습니다.</p>`:`<p class="hint">${escapeHtml(TYPES[node.type]?.summary)}${node.type==='review'?' · 결과는 검토 대기 상태로 종료됩니다.':''}</p>`}<div class="two-cols"><label>X 위치<input type="number" id="wf-node-x" data-wf-coordinate="x" step="10" min="0" max="10000" value="${Math.round(node.x)}"></label><label>Y 위치<input type="number" id="wf-node-y" data-wf-coordinate="y" step="10" min="0" max="10000" value="${Math.round(node.y)}"></label></div><button class="small danger" data-wf-action="delete-node">노드 삭제</button><p class="hint" style="margin-top:10px">삭제한 필수 단계는 다시 추가한 뒤 연결해야 저장할 수 있습니다.</p>`;
  }

  function connectionsHtml() {
    return workflow.edges.map(edge=>`<div><span>${escapeHtml(TYPES[workflow.nodes.find(node=>node.id===edge.source)?.type]?.name || '알 수 없음')} → ${escapeHtml(TYPES[workflow.nodes.find(node=>node.id===edge.target)?.type]?.name || '알 수 없음')}</span><button class="icon-btn quiet danger" type="button" data-wf-action="delete-edge" data-id="${escapeHtml(edge.id)}" aria-label="연결 삭제">×</button></div>`).join('') || '<p class="hint">아직 연결이 없습니다.</p>';
  }

  function runsHtml() {
    if (!runs.length) return '<div class="panel-body hint">실행하면 각 노드의 상태와 결과가 이곳에 남습니다. 그래프의 기록용 연결이 아니라 실제 서버 작업을 실행합니다.</div>';
    return runs.slice(0,10).map(run=>`<article class="wf-run ${activeRun()?.id===run.id?'selected':''}"><div class="row between"><button class="quiet" data-wf-action="select-run" data-id="${escapeHtml(run.id)}"><span class="badge ${run.status==='awaiting_review'?'lime':''}">${escapeHtml(STATUS[run.status] || run.status)}</span> <span class="hint">${stamp(run.createdAt)} · v${run.workflowVersion}</span></button>${LIVE.has(run.status)?`<button class="small danger" data-wf-action="cancel-run" data-id="${escapeHtml(run.id)}">실행 취소</button>`:''}</div><div class="wf-run-nodes">${(run.nodeRuns || []).map(node=>`<details><summary><span class="wf-status-dot ${escapeHtml(node.status)}"></span>${escapeHtml(TYPES[node.type]?.name || node.type)} <span class="hint">${escapeHtml(STATUS[node.status] || node.status)}</span></summary>${node.error?`<p class="danger">${escapeHtml(node.error)}</p>`:''}${node.output?`<pre>${escapeHtml(JSON.stringify(node.output,null,2))}</pre>`:'<p class="hint">아직 출력이 없습니다.</p>'}</details>`).join('')}</div>${run.error?`<p class="danger">${escapeHtml(run.error)}</p>`:''}${outputLinks(run)}</article>`).join('');
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
    host.innerHTML=shell();
    reviewSignature=reviewKey();
    updateSummary();
    if (workflow) { if (needsFit) { fit(); needsFit=false; } else transform(); drawEdges(); }
  }

  function updateSummary() {
    const status=$('#wf-save-status');
    if (status) { status.textContent=dirty?'저장되지 않은 변경':workflow?.id?`버전 ${workflow.version} · 저장됨`:'워크플로우 없음'; status.className=dirty?'unsaved':'hint'; }
    const errors=workflowErrors(workflow);
    const validation=$('#wf-validation');
    if (validation) { validation.textContent=errors.length?errors.join(' '):'✓ 실행 가능한 연결입니다. 저장 후 선택한 에피소드에서 실행하세요.'; validation.className=`wf-validation ${errors.length?'invalid':'valid'}`; }
    const badge=$('#wf-node-type');
    if (badge) badge.textContent=selectedNode()?.type?.toUpperCase() || 'SELECT';
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
    refreshReview();
    const runButton=$('[data-wf-action="run"]');
    if (runButton) runButton.disabled=pending || running() || !episodeId;
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
    selected=nodeId;
    host.querySelectorAll('.wf-node').forEach(element=>element.classList.toggle('selected',element.dataset.nodeId===nodeId));
    if ($('#wf-inspector')) $('#wf-inspector').innerHTML=inspectorHtml();
    updateSummary();
    drawEdges();
  }

  function connect(source,target) {
    if (source===target) throw new Error('노드를 자기 자신에 연결할 수 없습니다.');
    const first=workflow.nodes.find(node=>node.id===source),second=workflow.nodes.find(node=>node.id===target);
    if (!first || !second) throw new Error('연결할 두 노드를 선택하세요.');
    if (TYPE_ORDER.indexOf(first.type)>=TYPE_ORDER.indexOf(second.type)) throw new Error('트렌드 → 리서치 → 대본 → 스토리보드 → 렌더 → 검토 순서로 연결하세요.');
    if (workflow.edges.some(edge=>edge.source===source&&edge.target===target)) throw new Error('이미 연결된 노드입니다.');
    workflow.edges.push({id:newId(),source,target});
    connecting=null;
    changed();
    paint();
  }

  async function action(button) {
    const name=button.dataset.wfAction;
    if (name==='select-node') { selectNode(button.dataset.id); return; }
    if (name==='output') { connecting=button.dataset.id; selectNode(connecting); $('#wf-connect-hint').textContent=`${TYPES[selectedNode().type].name} 출력 선택됨 · 연결할 노드의 입력을 누르세요 · Esc 취소`; return; }
    if (name==='input') { if (!connecting) throw new Error('먼저 출발 노드의 출력을 누르세요.'); connect(connecting,button.dataset.id); return; }
    if (name==='zoom-in') { zoom(1.2); return; }
    if (name==='zoom-out') { zoom(1/1.2); return; }
    if (name==='fit') { fit(); return; }
    if (name==='select-run') { selectedRunId=button.dataset.id; updateExecution(); return; }
    if (pending) return;
    pending=true;
    button.disabled=true;
    try {
      if (name==='save') { await save(); paint(); toast('워크플로우를 저장했습니다.'); }
      else if (name==='new') { if (dirty) await save(); workflow=initialGraph(); saved=null; selected=workflow.nodes[0].id; runs=[]; selectedRunId=null; connecting=null; needsFit=true; changed(); paint(); }
      else if (name==='reload') { await load(true); paint(); }
      else if (name==='discard') { workflow=copy(saved || workflows[0] || null); selected=workflow?.nodes[0]?.id || null; dirty=false; connecting=null; needsFit=true; revision++; await loadRuns(); paint(); }
      else if (name==='add-node') { const type=$('#wf-add-type').value; if (!TYPES[type] || workflow.nodes.some(node=>node.type===type)) throw new Error('각 종류의 노드는 하나만 추가할 수 있습니다.'); const node={id:newId(),type,x:Math.max(30,Math.round((100-pan.x)/scale)),y:Math.max(30,Math.round((120-pan.y)/scale)),config:type==='script'?{agent:'studio',prompt:''}:{}}; workflow.nodes.push(node); selected=node.id; changed(); paint(); }
      else if (name==='delete-node') { workflow.nodes=workflow.nodes.filter(node=>node.id!==selected); workflow.edges=workflow.edges.filter(edge=>edge.source!==selected&&edge.target!==selected); selected=workflow.nodes[0]?.id || null; connecting=null; changed(); paint(); }
      else if (name==='delete-edge') { workflow.edges=workflow.edges.filter(edge=>edge.id!==button.dataset.id); changed(); paint(); }
      else if (name==='layout') { const ordered=[...workflow.nodes].sort((a,b)=>TYPE_ORDER.indexOf(a.type)-TYPE_ORDER.indexOf(b.type)); ordered.forEach((node,index)=>{node.x=50+index%3*285;node.y=65+Math.floor(index/3)*230;}); changed(); needsFit=true; paint(); }
      else if (name==='run') { if (!episodeId) throw new Error('실행할 에피소드를 선택하세요.'); await beforeRun?.(episodeId); await save(); const result=await post(`/api/workflows/${workflow.id}/run`,{episodeId}); runs.unshift(result); selectedRunId=result.id; paint(); schedulePoll(); toast('실제 제작 워크플로우를 시작했습니다. 노드별 진행 상태를 확인하세요.'); }
      else if (name==='refresh-runs') { await loadRuns(); updateExecution(); }
      else if (name==='cancel-run') { await post(`/api/workflows/${workflow.id}/runs/${button.dataset.id}/cancel`); await loadRuns(); updateExecution(); toast('실행 취소를 요청했습니다.'); }
      else if (name==='review-approve' || name==='review-changes') { await recordReview(name==='review-approve'?'approved':'changes_requested'); }
    } finally { pending=false; button.disabled=false; updateExecution(); }
  }

  function mount() {
    host=document.querySelector('#workflow-host');
    if (!host) return;
    paint();
    host.addEventListener('click',event=>{const button=event.target.closest('[data-wf-action]');if(button) action(button).catch(error=>toast(error.status===409?'워크플로우가 다른 작업에서 변경됐습니다. 현재 편집을 보존했습니다. 새 이름으로 복사하거나 변경을 되돌린 뒤 새로고침하세요.':error.message,true));});
    host.addEventListener('submit',event=>{if(event.target.id==='wf-connect-form'){event.preventDefault();const data=new FormData(event.target);try{connect(data.get('source'),data.get('target'));}catch(error){toast(error.message,true);}}});
    host.addEventListener('input',event=>{
      const target=event.target;
      if (target.dataset.reviewNotes) { reviewNotes.set(target.dataset.reviewNotes,target.value); return; }
      if (target.id==='wf-name') {workflow.name=target.value;changed();}
      else if (target.dataset.wfConfig && selectedNode()) {selectedNode().config ||= {};selectedNode().config[target.dataset.wfConfig]=target.value;changed();const content=host.querySelector(`[data-node-id="${selected}"] .wf-node-content p`);if(content)content.textContent=`${selectedNode().config.agent || 'studio'} · ${selectedNode().config.prompt?'사용자 지시문':'에피소드 소재 사용'}`;}
      else if (target.dataset.wfCoordinate && selectedNode() && target.checkValidity() && target.value!=='') {selectedNode()[target.dataset.wfCoordinate]=Number(target.value);updateNodePosition(selectedNode());changed();}
    });
    host.addEventListener('change',async event=>{
      if (event.target.id==='wf-episode') episodeId=event.target.value || null;
      if (event.target.id==='wf-select') {const choice=event.target.value;if(!choice)return;try{if(dirty)await save();workflow=copy(workflows.find(item=>item.id===choice));saved=copy(workflow);dirty=false;selected=workflow.nodes[0]?.id;connecting=null;needsFit=true;await loadRuns();paint();}catch(error){event.target.value=workflow?.id || '';toast(error.message,true);}}
      updateExecution();
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

  return {load,mount,save,hasChanges:()=>dirty,html:()=>'<div id="workflow-host"></div>'};
}
