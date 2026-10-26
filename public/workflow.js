// A dependency-free executable workflow editor. Knowledge graph remains separate.
import {workflowChanges,nodeChanges,changesHtml,displayValue,historyReason,createDraftHistory} from './history.js';
import {createContextMenu,installInfoTooltips} from './context-menu.js';
const TYPES = {
  trend:{name:'트렌드 수집',icon:'↗',summary:'Google RSS · 관심 키워드',color:'#81cfa9'},
  news:{name:'뉴스 검색',icon:'📰',summary:'키워드 · 뉴스 시나리오 소재',color:'#70d6ff'},
  research:{name:'리서치 정리',icon:'⌕',summary:'소재와 출처 · 제작 맥락',color:'#87bded'},
  script:{name:'대본 작성',icon:'✳',summary:'Studio / 외부 에이전트',color:'#c9f079'},
  storyboard:{name:'스토리보드',icon:'▦',summary:'대본을 편집 가능한 장면으로',color:'#dfc48f'},
  layout:{name:'레이아웃 연출',icon:'⊞',summary:'상단 이미지·중단 영상·HTML 오버레이 배치',color:'#ffd166'},
  generate:{name:'Higgsfield 생성',icon:'✦',summary:'모델로 장면·슬롯 영상 / 이미지 생성',color:'#ec9ed0'},
  render:{name:'영상 렌더',icon:'▶',summary:'FFmpeg 다중 레이어 · MP4 생성',color:'#ffac96'},
  review:{name:'사람의 검토',icon:'✓',summary:'검토 대기 · 자동 게시 없음',color:'#c5b3ef'},
  publish:{name:'플랫폼 공개',icon:'☁',summary:'승인된 후보 · 채널 OAuth · 공개 확인',color:'#a8e6cf'},
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

function defaultNodeConfig(type, defaultModel = 'seedance_2_5') {
  if (type === 'script') return {agent:'studio',prompt:''};
  if (type === 'news') return {query:'',keywords:'',maxArticles:5,source:'all'};
  if (type === 'layout') return {preset:'top-image-mid-video',topSlotRole:'image-gen',midSlotRole:'video-bg',enableSubtitles:true,enableHtmlOverlay:true,autoPrompts:true};
  if (type === 'generate') return {model:defaultModel,prompt:'',params:{},sceneIndex:0};
  if (type === 'publish') return {platform:'youtube',visibility:'public',autoAttachExport:false,titleTemplate:''};
  return {};
}

function initialGraph() {
  const baseTypes = ['trend','research','script','storyboard','render','review'];
  const nodes = baseTypes.map((type,index)=>({id:newId(),type,x:50 + index % 3 * 285,y:65 + Math.floor(index / 3) * 230,config:defaultNodeConfig(type)}));
  return {name:'새 제작 워크플로우',nodes,edges:nodes.slice(1).map((node,index)=>({id:newId(),source:nodes[index].id,target:node.id}))};
}

export function fullPipelineGraph(defaultModel = 'seedance_2_5') {
  const nodes = TYPE_ORDER.map((type,index)=>({id:newId(),type,x:50 + index % 4 * 270,y:60 + Math.floor(index / 4) * 210,config:defaultNodeConfig(type, defaultModel)}));
  return {name:'엔드투엔드 제작·업로드 파이프라인',nodes,edges:nodes.slice(1).map((node,index)=>({id:newId(),source:nodes[index].id,target:node.id}))};
}

// Match graph.mjs: stop EACH incoming path at its nearest producer of the requested role.
function upstreamBoundary(nodes, edges, nodeId, type) {
  const byId=new Map(nodes.map(node=>[node.id,node])),found=new Set(),seen=new Set([nodeId]),stack=[nodeId];
  while(stack.length) {
    const current=stack.pop();
    for(const edge of edges) {
      if(edge.target!==current || seen.has(edge.source)) continue;
      seen.add(edge.source);
      if(byId.get(edge.source)?.type===type) found.add(edge.source);
      else stack.push(edge.source);
    }
  }
  return [...found].map(id=>byId.get(id));
}

function graphOrder(nodes, edges) {
  const degree=new Map(nodes.map(node=>[node.id,0])),out=new Map(nodes.map(node=>[node.id,[]]));
  for(const edge of edges) if(degree.has(edge.source) && degree.has(edge.target)) {degree.set(edge.target,degree.get(edge.target)+1);out.get(edge.source).push(edge.target);}
  const ready=[...degree.keys()].filter(id=>degree.get(id)===0).sort(),order=[];
  while(ready.length) {const id=ready.shift();order.push(id);for(const target of out.get(id)) {degree.set(target,degree.get(target)-1);if(degree.get(target)===0){ready.push(target);ready.sort();}}}
  return order;
}

export function workflowErrors(workflow) {
  if (!workflow) return ['워크플로우를 먼저 만드세요.'];
  const errors=[],nodes=Array.isArray(workflow.nodes)?workflow.nodes:[],edges=Array.isArray(workflow.edges)?workflow.edges:[];
  if (!workflow.name?.trim()) errors.push('워크플로우 이름을 입력하세요.');
  if (!nodes.length || nodes.length>128) errors.push('노드는 1–128개여야 합니다.');
  if (edges.length>256) errors.push('연결은 256개까지 사용할 수 있습니다.');
  const validId=id=>typeof id==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
  const ids=new Set(nodes.map(node=>node.id)),edgeIds=new Set(),pairs=new Set(),undirected=new Map(nodes.map(node=>[node.id,[]]));
  if(ids.size!==nodes.length) errors.push('노드 ID가 중복됩니다.');
  for(const node of nodes) {
    if(!validId(node.id)) errors.push('유효한 노드 ID를 사용하세요.');
    if(TYPE_ORDER.includes(node.id)&&node.id!==node.type)errors.push('노드 ID가 다른 역할 이름을 가릴 수 없습니다.');
    if(!TYPES[node.type]) errors.push('지원하지 않는 노드 종류입니다.');
    if(!Number.isFinite(node.x)||!Number.isFinite(node.y)||Math.abs(node.x)>100000||Math.abs(node.y)>100000) errors.push('노드 좌표는 ±100000 이내의 유한한 수여야 합니다.');
  }
  for(const edge of edges) {
    if(!validId(edge.id)||edgeIds.has(edge.id)) errors.push('연결 ID가 유효하지 않거나 중복됩니다.');
    edgeIds.add(edge.id);
    if(!ids.has(edge.source)||!ids.has(edge.target)) {errors.push('존재하지 않는 노드 연결이 있습니다.');continue;}
    if(edge.source===edge.target) errors.push('노드를 자기 자신에 연결할 수 없습니다.');
    const pair=JSON.stringify([edge.source,edge.target]);
    if(pairs.has(pair)) errors.push('중복 연결이 있습니다.');
    pairs.add(pair);undirected.get(edge.source).push(edge.target);undirected.get(edge.target).push(edge.source);
  }
  if(graphOrder(nodes,edges).length!==nodes.length) errors.push('순환 연결은 실행할 수 없습니다.');
  if(nodes.length) {const seen=new Set(),stack=[nodes[0].id];while(stack.length){const id=stack.pop();if(seen.has(id))continue;seen.add(id);stack.push(...(undirected.get(id)||[]));}if(seen.size!==nodes.length)errors.push('모든 노드를 하나의 실행 흐름으로 연결하세요.');}
  const requireBoundary=(node,type)=>{const matches=upstreamBoundary(nodes,edges,node.id,type);if(matches.length!==1)errors.push(`${node.label||node.id}: ${TYPES[type].name} 선행 경계가 ${matches.length?'모호합니다':'없습니다'}.`);return matches.length===1?matches[0]:null;};
  for(const node of nodes) {
    if(node.type==='storyboard') requireBoundary(node,'script');
    if(['layout','generate'].includes(node.type)) {
      requireBoundary(node,'storyboard');
      const seen=new Set(),stack=[node.id];while(stack.length){const id=stack.pop();if(seen.has(id))continue;seen.add(id);for(const edge of edges)if(edge.source===id)stack.push(edge.target);}
      if(!nodes.some(item=>item.type==='render'&&seen.has(item.id)))errors.push(`${node.id}: 영상 렌더로 연결하세요.`);
    }
    if(node.type==='review') requireBoundary(node,'render');
    if(node.type==='publish') {const review=requireBoundary(node,'review'),render=requireBoundary(node,'render');if(review&&render){const reviewed=upstreamBoundary(nodes,edges,review.id,'render');if(reviewed.length!==1||reviewed[0].id!==render.id)errors.push(`${node.id}: 검토와 렌더 후보가 다릅니다.`);}}
    if(['research','script'].includes(node.type)) for(const type of ['news','trend']) if(upstreamBoundary(nodes,edges,node.id,type).length>1)errors.push(`${node.id}: ${TYPES[type].name} 선행 경계가 모호합니다.`);
  }
  return [...new Set(errors)];
}

export function addWorkflowNode(workflow, type, { id = newId(), x = 30, y = 30, label = '', config = {}, afterNodeId = null } = {}) {
  if(!workflow||!TYPES[type])throw new Error('지원하지 않는 노드 종류입니다.');
  if(workflow.nodes.length>=128)throw new Error('노드는 128개까지 사용할 수 있습니다.');
  if(workflow.nodes.some(node=>node.id===id))throw new Error('노드 ID가 중복됩니다.');
  const nodes=[...workflow.nodes],stageIndex=TYPE_ORDER.indexOf(type);
  let anchor=afterNodeId?nodes.find(node=>node.id===afterNodeId):null;
  if(afterNodeId&&!anchor)throw new Error('선택한 노드 또는 대상을 찾을 수 없습니다.');
  // For an unselected insertion, infer an anchor only when that role is unique.
  if(!anchor) {const candidates=nodes.filter(node=>TYPE_ORDER.indexOf(node.type)<=stageIndex);const rank=Math.max(-1,...candidates.map(node=>TYPE_ORDER.indexOf(node.type)));const nearest=candidates.filter(node=>TYPE_ORDER.indexOf(node.type)===rank);if(nearest.length===1)anchor=nearest[0];}
  let edges=[...(workflow.edges||[])];
  let successor=null;
  if(!anchor && nodes.length && nodes.every(node=>TYPE_ORDER.indexOf(node.type)>stageIndex)) {
    const rank=Math.min(...nodes.map(node=>TYPE_ORDER.indexOf(node.type)));
    const nearest=nodes.filter(node=>TYPE_ORDER.indexOf(node.type)===rank);
    if(nearest.length===1 && !edges.some(edge=>edge.target===nearest[0].id))successor=nearest[0];
  }
  const node={id,type,x:Math.max(0,Number(x)||0),y:Math.max(0,Number(y)||0),...(label.trim()?{label:label.trim()}:{}),config:copy(config)};
  if(anchor) {
    const outgoing=edges.filter(edge=>edge.source===anchor.id);
    edges=edges.filter(edge=>edge.source!==anchor.id);
    edges.push({id:newId(),source:anchor.id,target:id},...outgoing.map(edge=>({...edge,source:id})));
  } else if(successor) edges.push({id:newId(),source:id,target:successor.id});
  if(edges.length>256)throw new Error('연결은 256개까지 사용할 수 있습니다.');
  nodes.splice(anchor?nodes.indexOf(anchor)+1:successor?nodes.indexOf(successor):nodes.length,0,node);
  return {...workflow,nodes,edges};
}

export function fitWorkflowCanvas(nodes, width, height) {
  const positioned=Array.isArray(nodes)?nodes.filter(node=>Number.isFinite(node.x)&&Number.isFinite(node.y)):[];
  if (!positioned.length || !Number.isFinite(width) || !Number.isFinite(height) || width<=0 || height<=0) return null;
  if (width<900) return { scale: 1, pan: {x:0,y:0}, layout:'stacked' };
  const left = Math.min(...positioned.map(node => node.x));
  const top = Math.min(...positioned.map(node => node.y));
  const right = Math.max(...positioned.map(node => node.x + WIDTH));
  const bottom = Math.max(...positioned.map(node => node.y + HEIGHT));
  const graphWidth = Math.max(1, right - left), graphHeight = Math.max(1, bottom - top);
  const scale = Math.max(0.0001, Math.min(1.2, (width - 80) / graphWidth, (height - 110) / graphHeight));
  return { scale, pan: { x: (width - graphWidth * scale) / 2 - left * scale, y: (height - 50 - graphHeight * scale) / 2 - top * scale }, layout:'canvas' };
}

export function workflowCanvasHintText(layout) {
  return layout==='stacked' ? '세로 목록을 스크롤 · 더보기(⋯)로 설정·결과 · 입력/출력 버튼으로 연결' : '빈 공간 드래그 · 휠 확대/축소 · 출력 → 입력 연결';
}

export function workflowRunHistoryHtml(result = {}, query = '', { loading = false, error = '' } = {}) {
  const items = Array.isArray(result.items) ? result.items : [];
  const page = Number.isSafeInteger(result.page) && result.page > 0 ? result.page : 1;
  const pageCount = Number.isSafeInteger(result.pageCount) && result.pageCount > 0 ? result.pageCount : 0;
  const total = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : items.length;
  const firstPage = Math.max(1, Math.min(page - 2, pageCount - 4));
  const pageButtons = Array.from({ length: Math.max(0, Math.min(5, pageCount - firstPage + 1)) }, (_, index) => firstPage + index)
    .map(value => `<button type="button" class="small ${value === page ? 'primary' : ''}" data-wf-action="history-page" data-page="${value}" ${value === page ? 'aria-current="page"' : ''}>${value}</button>`).join('');
  const records = items.map(run => {
    const nodes = (Array.isArray(run.nodeRuns) ? run.nodeRuns : []).map(node => `<li><span class="wf-status-dot ${escapeHtml(node.status || 'idle')}"></span>${escapeHtml(TYPES[node.type]?.name || node.type || node.nodeId)} · ${escapeHtml(STATUS[node.status] || node.status || '미기록')}</li>`).join('');
    const title = run.episodeTitle || run.episodeId || '에피소드 미상';
    return `<details class="wf-history-record" data-run-id="${escapeHtml(run.id)}"><summary><span class="badge ${run.status === 'awaiting_review' ? 'lime' : ''}">${escapeHtml(STATUS[run.status] || run.status || '미기록')}</span><strong>${escapeHtml(title)}</strong><span class="hint">${escapeHtml(run.workflowName || run.workflowId || '워크플로우 미상')} · ${stamp(run.createdAt)}</span></summary><div class="wf-history-record-body"><dl class="wf-history-facts"><div><dt>실행 ID</dt><dd><code>${escapeHtml(run.id)}</code></dd></div><div><dt>워크플로우</dt><dd>${escapeHtml(run.workflowName || '이름 미상')} · ${escapeHtml(run.workflowId || 'ID 미상')} · v${escapeHtml(run.workflowVersion ?? '—')}</dd></div><div><dt>에피소드</dt><dd>${escapeHtml(title)} · ${escapeHtml(run.episodeId || 'ID 미상')} · v${escapeHtml(run.episodeVersion ?? '—')}</dd></div></dl><ul class="wf-history-node-status">${nodes || '<li class="hint">기록된 노드 상태가 없습니다.</li>'}</ul><div class="wf-history-detail" data-run-detail="${escapeHtml(run.id)}"><span class="hint">기록을 열면 저장된 실행 스냅샷을 불러옵니다.</span></div></div></details>`;
  }).join('');
  return `<div class="wf-run-history-content"><form class="wf-run-history-search" data-run-history-search><label>실행 기록 검색<input type="search" name="q" maxlength="200" value="${escapeHtml(query)}" placeholder="실행 ID, 워크플로우, 에피소드, 상태"></label><button class="small" type="submit" ${loading ? 'disabled' : ''}>검색</button><button class="small quiet" type="button" data-wf-action="refresh-run-history" ${loading ? 'disabled' : ''}>초기화·새로고침</button></form>${error ? `<p class="wf-review-warning" role="alert">${escapeHtml(error)}</p>` : ''}<p class="hint" role="status" aria-live="polite">${loading ? '실행 기록을 불러오는 중…' : query ? `검색 결과 ${total}개` : `실행 기록 ${total}개`}${!loading && pageCount ? ` · ${page}/${pageCount} 페이지` : ''}</p><div class="wf-history-records">${records || (!loading ? `<p class="hint">${query ? '검색 결과가 없습니다.' : '실행 기록이 없습니다.'}</p>` : '')}</div><nav class="wf-history-pagination" aria-label="실행 기록 페이지 이동"><button type="button" class="small" data-wf-action="history-page" data-page="${Math.max(1, page - 1)}" ${loading || page <= 1 ? 'disabled' : ''}>이전</button>${pageButtons}<button type="button" class="small" data-wf-action="history-page" data-page="${Math.min(pageCount || 1, page + 1)}" ${loading || pageCount === 0 || page >= pageCount ? 'disabled' : ''}>다음</button></nav></div>`;
}

export function createWorkflowEditor({api,toast=()=>{},getEpisodes=()=>[],getEpisode,hasEpisodeChanges,beforeRun,onRunUpdated,onOpenSceneEditor,canMutate=()=>true}) {
  let workflows = [];
  let workflow = null;
  let saved = null;
  let selected = null;
  let episodeId = null;
  let runs = [];
  let runHistory = { items: [], total: 0, page: 1, pageSize: 20, pageCount: 0 };
  let runHistoryQuery = '';
  let runHistoryLoaded = false;
  let runHistoryLoading = false;
  let runHistoryError = '';
  let runHistoryRequest = 0;
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
  let drafts = createDraftHistory(40);
  const graphStashes=new Map(),projectSelections=new Map();
  let project=null,contextEpoch=0,loadRequest=0,localDraftId=null;
  let disclosure={containsSyntheticMedia:null,rationale:''};
  const projectKey=()=>project?JSON.stringify([project.episodeId,project.channelId]):'unbound';
  const owns=item=>Boolean(project?.episodeId && project?.channelId && item?.episodeId===project.episodeId && item?.channelId===project.channelId);
  const editable=()=>!project || owns(workflow);
  const stashKey=()=>workflow?.id || localDraftId;
  const mutationReason=()=>!canMutate()?'모든 변경은 관리자 전용입니다.':!editable()?'공용 템플릿은 미리보기입니다. 프로젝트용 복사본을 먼저 만드세요.':running()?'프로젝트 실행이 진행 중입니다. 완료하거나 취소한 뒤 그래프를 수정·저장하세요.':'';
  const mutatingActions=new Set(['new','preset-full-pipeline','discard','save','add-node','delete-node','delete-edge','layout','undo','redo','run','stage-start','resume-stage','quote-generation','prepare-generation-source','confirm-generation-run','confirm-restore','restore-node','review-approve','review-changes','apply-generation-job','recover-generation-job']);
  function stashGraph() {
    const key=stashKey();if(!workflow||!key)return;
    graphStashes.set(key,{workflow:copy(workflow),saved:copy(saved),selected,dirty,revision,drafts,selectedRunId,runs:copy(runs),versions:copy(versions),compareVersion,inspectorTab,scale,pan:copy(pan),autoFit,needsFit,disclosure:copy(disclosure),generationTargetSceneId});
    projectSelections.set(projectKey(),key);
  }
  function selectGraph(next,key=next?.id) {
    contextMenu?.close();
    contextEpoch++;pollEpoch++;clearTimeout(timer);generationLoad++;connecting=null;drag=null;
    generationConsent=false;generationConsentSnapshot=null;generationStageRun=false;generationResumeRunId=null;
    generationTargetEpisode=null;generationTargetSceneId=null;invalidateGenerationEstimate();
    const stashed=key?graphStashes.get(key):null;
    localDraftId=next&&!next.id?(key || `draft-${newId()}`):null;
    if(stashed) {
      workflow=copy(stashed.workflow);saved=copy(stashed.saved);selected=stashed.selected;dirty=stashed.dirty;revision=stashed.revision;drafts=stashed.drafts;
      selectedRunId=stashed.selectedRunId;runs=copy(stashed.runs);versions=copy(stashed.versions);compareVersion=stashed.compareVersion;inspectorTab=stashed.inspectorTab;
      scale=stashed.scale;pan=copy(stashed.pan);autoFit=stashed.autoFit;needsFit=stashed.needsFit;disclosure=copy(stashed.disclosure);generationTargetSceneId=stashed.generationTargetSceneId;
    } else {
      workflow=copy(next);saved=copy(next?.id?next:null);selected=next?.nodes?.[0]?.id || null;dirty=Boolean(next&&!next.id);revision=0;drafts=createDraftHistory(40);resetDrafts();
      runs=[];versions=[];compareVersion=null;selectedRunId=null;inspectorTab='settings';needsFit=true;autoFit=true;scale=1;pan={x:0,y:0};disclosure={containsSyntheticMedia:null,rationale:''};
    }
    reviewSignature='';
  }
  function chooseProjectGraph() {
    const remembered=projectSelections.get(projectKey()),stashed=graphStashes.get(remembered);
    if(stashed && (!project || owns(stashed.workflow) || !stashed.workflow.episodeId)) {selectGraph(stashed.workflow,remembered);return;}
    const rememberedSaved=workflows.find(item=>item.id===remembered&&(!project||owns(item)||(!item.episodeId&&!item.channelId)));
    if(rememberedSaved){selectGraph(rememberedSaved);return;}
    const owned=workflows.filter(owns);
    if(owned.length===1)selectGraph(owned[0]);
    else if(!project)selectGraph(workflows[0] || null);
    else {const templates=workflows.filter(item=>!item.episodeId&&!item.channelId);selectGraph(owned.length===0?templates[0] || null:null);}
  }
  function bindProject({episodeId:nextEpisodeId=null,channelId:nextChannelId=null}={}) {
    if(project?.episodeId===nextEpisodeId&&project?.channelId===nextChannelId)return getContext();
    stashGraph();project={episodeId:nextEpisodeId,channelId:nextChannelId};episodeId=nextEpisodeId;chooseProjectGraph();
    if(loaded) {
      const epoch=pollEpoch,context=contextEpoch,targetId=workflow?.id,targetEpisodeId=episodeId;
      const current=()=>epoch===pollEpoch && context===contextEpoch && workflow?.id===targetId && episodeId===targetEpisodeId && host?.isConnected;
      Promise.all([loadRuns(),loadVersions()]).then(()=>{if(current())paint();}).catch(error=>{if(current())toast(error.message,true);});
      paint();
    }
    return getContext();
  }
  function reviewContext(run=activeRun()) {
    if(!run || (project && (!owns(workflow)||run.episodeId!==episodeId)))return {reviewNodeId:null,renderNodeId:null};
    const graph=run.workflowSnapshot || workflow,nodes=graph?.nodes || [],edges=graph?.edges || [];
    let reviews=[];
    const node=nodes.find(item=>item.id===selected);
    if(node?.type==='review')reviews=[node];
    else if(node?.type==='publish')reviews=upstreamBoundary(nodes,edges,node.id,'review');
    else if(node?.type==='render')reviews=nodes.filter(item=>item.type==='review'&&upstreamBoundary(nodes,edges,item.id,'render').length===1&&upstreamBoundary(nodes,edges,item.id,'render')[0].id===node.id);
    else reviews=nodes.filter(item=>item.type==='review');
    if(reviews.length!==1)return {reviewNodeId:null,renderNodeId:null};
    const renders=upstreamBoundary(nodes,edges,reviews[0].id,'render');
    return {reviewNodeId:reviews[0].id,renderNodeId:renders.length===1?renders[0].id:null};
  }
  function contextRun(owned) {
    const run=owned?activeRun():null;
    return run?.episodeId===episodeId&&run?.workflowId===workflow?.id?run:null;
  }
  function getContext() {
    const owned=owns(workflow),validRun=contextRun(owned);
    return {workflowId:owned?workflow.id || null:null,workflowVersion:owned?workflow.version || null:null,episodeId:project?.episodeId || episodeId || null,channelId:project?.channelId || null,selectedNodeId:owned?selected:null,hasActiveRun:owned&&running(),runId:validRun?.id || null,...reviewContext(validRun),...(owned?{workflow:copy(workflow)}:{}),...(validRun?{run:copy(validRun)}:{})};
  }
  function getActivity() {
    const owned=owns(workflow),validRun=contextRun(owned);
    return {episodeId:project?.episodeId || episodeId || null,hasActiveRun:owned&&running(),run:validRun?{episodeId:validRun.episodeId,status:validRun.status}:null};
  }
  const DEFAULT_GENERATION_MODEL = 'seedance_2_5';
  function generationConfig(sceneIndex = 0, model = '') {
    return {model: model || models[0]?.id || DEFAULT_GENERATION_MODEL, prompt:'', params:{}, sceneIndex:Math.max(0, Number(sceneIndex) || 0)};
  }
  let host = null;
  let mountController = null;
  let contextMenu = null;
  let infoTooltips = null;
  let overlayNodeId = null;
  let connectionNodeId = null;
  let deleteNodeId = null;
  let minimapRaf = 0;
  let generationStageRun = false;
  let generationResumeRunId = null;
  let overlayTrigger = null;
  let connecting = null;
  let drag = null;
  let scale = 1;
  let pan = {x:0,y:0};
  let needsFit = true;
  let autoFit = true;
  let canvasObserver = null;
  let observedCanvas = null;
  let resizeRaf = 0;
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
  function changed(group=null) { drafts.record(draftContent(),group);dirty=JSON.stringify(draftContent())!==JSON.stringify(saved?{name:saved.name,nodes:saved.nodes,edges:saved.edges}:null);revision++;invalidateGenerationEstimate();updateSummary();refreshReview(); }
  function resetDrafts() {drafts.reset(draftContent());}
  function undoDraft(redo=false) {if(mutationReason() || saving || pending)return;const value=redo?drafts.redo():drafts.undo();if(!value)return;workflow={...workflow,...value};selected=workflow.nodes.some(node=>node.id===selected)?selected:workflow.nodes[0]?.id;dirty=JSON.stringify(draftContent())!==JSON.stringify(saved?{name:saved.name,nodes:saved.nodes,edges:saved.edges}:null);revision++;invalidateGenerationEstimate();paint();focusNode(selected);}
  async function loadVersions() {
    if (!workflow?.id) {versions=[];compareVersion=null;return;}
    const target=workflow.id,epoch=contextEpoch,result=await api(`/api/workflows/${target}/history`);
    if (workflow?.id!==target || epoch!==contextEpoch) return;
    versions=Array.isArray(result)?result:result.history || [];
    if (!versions.some(item=>item.version===compareVersion)) compareVersion=versions[0]?.version || null;
  }

  async function load(force=false) {
    if (loaded && !force) return;
    stashGraph();
    const request=++loadRequest;
    const result = await api('/api/workflows');
    if(request!==loadRequest)return;
    workflows = Array.isArray(result) ? result : result.workflows || [];
    loaded = true;
    stashGraph();
    if(force)for(const [key,value] of graphStashes)if(!value.dirty&&value.workflow.id)graphStashes.delete(key);
    chooseProjectGraph();
    await Promise.all([loadRuns(),loadVersions()]);
  }

  async function loadRuns() {
    const epoch=pollEpoch;
    if (!workflow?.id) { runs=[]; return; }
    const targetId = workflow.id;
    const result = await api(`/api/workflows/${targetId}/runs`);
    if (epoch!==pollEpoch || (host && !host.isConnected) || workflow?.id !== targetId) return;
    const latest = (Array.isArray(result) ? result : result.runs || []).filter(run=>run.workflowId===targetId && (!project || (owns(workflow)&&run.episodeId===episodeId)));
    const wasLive = running();
    runs = latest.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!selectedRunId || !runs.some(run=>run.id===selectedRunId)) selectedRunId = runs[0]?.id;
    if (wasLive && !running()) await onRunUpdated?.();
    if (epoch!==pollEpoch || (host && !host.isConnected) || workflow?.id !== targetId) return;
    const jobId=activeRun()?.nodeRuns?.find(node=>node.nodeId===selected)?.output?.generationJobId;
    if(jobId && inspectorTab==='results') await loadGenerationJob(jobId);
    schedulePoll(epoch);
  }

  function renderRunHistory() {
    const container = $('#wf-run-history-content');
    if (!container) return;
    container.innerHTML = runHistoryLoaded || runHistoryLoading || runHistoryError
      ? workflowRunHistoryHtml(runHistory, runHistoryQuery, { loading: runHistoryLoading, error: runHistoryError })
      : '<p class="hint">열면 저장된 실행 기록을 불러옵니다.</p>';
  }

  async function loadRunHistory({ page = 1, query = runHistoryQuery } = {}) {
    const requestId = ++runHistoryRequest;
    runHistoryLoading = true;
    runHistoryError = '';
    runHistoryQuery = query;
    renderRunHistory();
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (query) params.set('q', query);
      const result = await api(`/api/workflow-runs?${params}`);
      if (requestId !== runHistoryRequest || (host && !host.isConnected)) return;
      runHistory = result;
      runHistoryQuery = query;
      runHistoryLoaded = true;
    } catch (error) {
      if (requestId !== runHistoryRequest || (host && !host.isConnected)) return;
      runHistoryError = error.message;
    } finally {
      if (requestId === runHistoryRequest) {
        runHistoryLoading = false;
        renderRunHistory();
      }
    }
  }

  async function loadRunHistoryDetail(record) {
    if (!record || record.dataset.detailLoaded === 'true' || record.dataset.detailLoading === 'true') return;
    const id = record.dataset.runId, panel = record.querySelector('[data-run-detail]');
    if (!id || !panel) return;
    record.dataset.detailLoading = 'true';
    panel.innerHTML = '<span class="hint">저장된 실행 스냅샷을 불러오는 중…</span>';
    try {
      const run = await api(`/api/workflow-runs/${encodeURIComponent(id)}`);
      if (!record.isConnected) return;
      const snapshotNodes = run.workflowSnapshot?.nodes || [];
      const nodeDetails = (Array.isArray(run.nodeRuns) ? run.nodeRuns : []).map(item => {
        const snapshot = snapshotNodes.find(node => node.id === item.nodeId);
        return `<details class="wf-history-stage"><summary><span class="badge">${escapeHtml(TYPES[item.type]?.name || snapshot?.label || item.type || item.nodeId)}</span> · ${escapeHtml(STATUS[item.status] || item.status || '미기록')}</summary><p class="hint">${escapeHtml(stamp(item.startedAt))}${item.completedAt ? ` → ${escapeHtml(stamp(item.completedAt))}` : ''}</p>${item.error ? `<p class="wf-review-warning" role="alert">${escapeHtml(item.error)}</p>` : ''}${item.output ? factsHtml(item.output) : '<p class="hint">저장된 출력이 없습니다.</p>'}</details>`;
      }).join('');
      panel.innerHTML = `<dl class="wf-history-facts"><div><dt>시작</dt><dd>${escapeHtml(stamp(run.createdAt))}</dd></div><div><dt>마지막 갱신</dt><dd>${escapeHtml(stamp(run.updatedAt))}</dd></div><div><dt>실행 상태</dt><dd>${escapeHtml(STATUS[run.status] || run.status || '미기록')}</dd></div></dl>${run.error ? `<p class="wf-review-warning" role="alert">${escapeHtml(run.error)}</p>` : ''}<h4>노드별 실행 기록</h4>${nodeDetails || '<p class="hint">노드 실행 기록이 없습니다.</p>'}<details class="history-advanced"><summary>실행 당시 워크플로우·에피소드 스냅샷</summary><p>${escapeHtml(run.workflowSnapshot?.name || '워크플로우 이름 없음')} · ${escapeHtml(run.episodeSnapshot?.title || '에피소드 제목 없음')}</p><p class="hint">워크플로우 v${escapeHtml(run.workflowVersion ?? '—')} · 에피소드 v${escapeHtml(run.episodeVersion ?? '—')}</p></details>`;
      record.dataset.detailLoaded = 'true';
    } catch (error) {
      if (!record.isConnected) return;
      panel.innerHTML = `<p class="wf-review-warning" role="alert">기록 상세를 불러오지 못했습니다: ${escapeHtml(error.message)}</p><button type="button" class="small" data-wf-action="refresh-run-detail" data-id="${escapeHtml(id)}">다시 시도</button>`;
    } finally {
      if (record.isConnected) delete record.dataset.detailLoading;
    }
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
    if(mutationReason())throw new Error(mutationReason());
    if (!dirty && workflow.id) return workflow;
    if (saving) throw new Error('워크플로우를 저장 중입니다. 잠시 후 다시 시도해 주세요.');
    const errors = workflowErrors(workflow);
    if (errors.length) throw new Error(errors.join(' '));
    const startRevision = revision,epoch=contextEpoch,targetId=workflow.id,targetKey=stashKey();
    const snapshot=copy(workflow);
    saving=true;updateSummary();
    try {
    const body = {name:snapshot.name.trim(),nodes:snapshot.nodes,edges:snapshot.edges,...(snapshot.id ? {expectedVersion:snapshot.version} : project?{episodeId:project.episodeId,channelId:project.channelId}:{})};
    const result = await api(targetId ? `/api/workflows/${targetId}` : '/api/workflows',{method:targetId ? 'PUT' : 'POST',body:JSON.stringify(body)});
    const index = workflows.findIndex(item=>item.id===result.id);
    if (index>=0) workflows[index]=copy(result); else workflows.unshift(copy(result));
    if(epoch!==contextEpoch || stashKey()!==targetKey) {
      const stashed=graphStashes.get(targetKey);
      if(stashed && stashed.revision===startRevision){stashed.workflow=copy(result);stashed.saved=copy(result);stashed.dirty=false;stashed.drafts.reset({name:result.name,nodes:result.nodes,edges:result.edges});}
      return result;
    }
    saved = copy(result);
    if (revision !== startRevision) { workflow.id=result.id; workflow.version=result.version; throw new Error('저장 중 추가한 편집을 보존했습니다. 다시 저장해 주세요.'); }
    workflow=copy(result);
    dirty=false;
    resetDrafts();
    if(targetKey!==result.id)graphStashes.delete(targetKey);
    stashGraph();
    await loadVersions();
    updateSummary();
    return result;
    } finally {saving=false;updateSummary();}
  }


  function shell() {
    const episodes = getEpisodes().filter(item=>!project || item.channelId===project.channelId);
    const choices=workflows.filter(item=>!project || owns(item) || (!item.episodeId&&!item.channelId));
    const preview=Boolean(project&&!owns(workflow));
    return `<div class="page-heading"><div><span class="eyebrow">FLOW EDITOR / 제작 설계</span><h1>콘텐츠를 만드는, 나만의 순서.</h1><p>단계를 연결하고 선택한 에피소드의 제작 흐름을 설계하세요.</p></div><div class="row"><button data-wf-action="new">＋ 새 워크플로우</button><button data-wf-action="preset-full-pipeline" title="뉴스 검색·레이아웃 연출·Higgsfield 생성·플랫폼 업로드까지 포함한 전체 파이프라인 초안">＋ 전체 파이프라인 구성</button><button data-wf-action="create-project-copy" ${!project?.episodeId || !project?.channelId || !workflow?.id || workflow?.episodeId || workflow?.channelId?'disabled':''}>프로젝트용 복사본 만들기</button><button data-wf-action="save" ${!workflow || preview?'disabled':''}>워크플로우 저장</button><button class="primary" data-wf-action="run" ${!workflow || preview || !episodeId || running()?'disabled':''}>워크플로우 실행</button></div></div>
    ${workflow ? `<nav class="wf-section-nav" aria-label="워크플로우 작업 탐색"><a href="#workflow-canvas" data-wf-section>설계 <span>${workflow.nodes.length} 단계</span></a><a href="#wf-run-history" data-wf-section>실행 히스토리</a><a href="#wf-workflow-history" data-wf-section>버전 기록</a><a href="#wf-review" data-wf-section>결과 검토</a><span class="wf-design-note">저장 후 다음 실행부터 적용 · 자동 게시 없음</span></nav>` : ''}
    <section class="panel wf-toolbar"><label>저장된 워크플로우<select id="wf-select" aria-label="워크플로우 선택"><option value="">${workflow&&!workflow.id?'저장되지 않은 새 워크플로우':'선택하세요'}</option>${choices.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===workflow?.id?'selected':''}>${escapeHtml(item.name)}${item.episodeId?' · 프로젝트':' · 템플릿 미리보기'}</option>`).join('')}</select></label><label>실행 대상 에피소드<select id="wf-episode" aria-label="워크플로우 실행 에피소드" ${project?'disabled':''}><option value="">에피소드를 선택하세요</option>${episodes.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===episodeId?'selected':''}>${escapeHtml(item.title)}</option>`).join('')}</select></label><div class="wf-save-state"><span id="wf-save-status" class="hint" role="status" aria-live="polite"></span><div class="row"><button class="small quiet" data-wf-action="undo" title="Ctrl/⌘ Z">↶ 실행 취소</button><button class="small quiet" data-wf-action="redo" title="Ctrl/⌘ Shift Z">↷ 다시 실행</button><button class="small quiet" data-wf-action="reload">새로고침</button><button class="small quiet" data-wf-action="discard">변경 되돌리기</button></div></div></section>
    ${!workflow ? '<div class="panel empty"><div class="empty-mark">⌘</div><h2>실행 가능한 제작 흐름을 만드세요</h2><p>새 워크플로우에서 노드를 연결하고<br>에피소드를 선택해 실제 작업을 실행하세요.</p></div>' : `<div class="wf-layout"><section class="panel wf-graph-panel"><div class="panel-header"><div class="row"><span class="eyebrow">WORKFLOW CANVAS</span><span class="badge">${workflow.nodes.length} NODES</span></div><div class="row"><button class="small" data-wf-action="open-add-node">＋ 노드 추가</button><button class="small" data-wf-action="open-workflow-settings">워크플로 설정</button></div></div><div id="workflow-canvas" class="wf-canvas" tabindex="0" aria-label="워크플로우 캔버스. 노드 제목을 드래그해 이동하고 출력과 입력을 순서대로 선택해 연결하세요."><div id="wf-world" class="wf-world"><svg id="wf-edges" class="wf-edges" aria-hidden="true"></svg><div id="wf-nodes">${nodesHtml()}</div></div><div class="wf-canvas-hint" id="wf-connect-hint">빈 공간 드래그 · 휠 확대/축소 · 출력 → 입력 연결</div><div class="wf-zoom"><button class="icon-btn" data-wf-action="zoom-out" aria-label="축소">−</button><span id="wf-zoom-value">100%</span><button class="icon-btn" data-wf-action="zoom-in" aria-label="확대">+</button><button class="small" data-wf-action="fit">전체 보기</button><button class="small" data-wf-action="layout">자동 배치</button></div></div><div id="wf-validation" class="wf-validation" role="status"></div></section></div><details id="wf-workflow-history" class="panel section-spacer wf-collapsible"><summary class="wf-collapsible-summary"><h2>워크플로우 버전 기록</h2></summary><div class="panel-body"><button class="small" data-wf-action="refresh-history">↻ 기록 새로고침</button><div id="wf-history">${historyHtml()}</div></div></details><details id="wf-current-runs" class="panel section-spacer wf-collapsible"><summary class="wf-collapsible-summary"><h2>현재 워크플로우 최근 실행</h2><span class="hint">최신 상태·최대 10건</span></summary><div class="panel-body"><button class="small" data-wf-action="refresh-runs">↻ 실행 상태 확인</button><div id="wf-runs">${runsHtml()}</div></div></details><details id="wf-run-history" class="panel section-spacer wf-collapsible"><summary class="wf-collapsible-summary"><h2>전체 실행 이력</h2><span class="hint">검색 · 페이지 이동 · 실행 추적</span></summary><div class="panel-body" id="wf-run-history-content">${runHistoryLoaded ? workflowRunHistoryHtml(runHistory, runHistoryQuery, { loading: runHistoryLoading, error: runHistoryError }) : '<p class="hint">열면 저장된 실행 기록을 불러옵니다.</p>'}</div></details><div id="wf-review" tabindex="-1">${reviewHtml() || '<p class="source-note">검토할 렌더 결과가 아직 없습니다. 실행 결과를 확인한 뒤 사람이 검토하며, 외부 채널에는 자동 게시하지 않습니다.</p>'}</div>${dialogsHtml()}`}`;
  }

  function nodeControl(nodeId,actionName='node-menu') {
    return host?.querySelector(`.wf-node [data-wf-action="${actionName}"][data-id="${CSS.escape(nodeId || '')}"]`);
  }
  function focusNode(nodeId=selected) {
    (nodeControl(nodeId,'select-node') || $('#workflow-canvas'))?.focus({preventScroll:true});
  }
  function rememberOverlay(trigger,nodeId=trigger?.dataset?.id) {
    overlayTrigger=trigger;overlayNodeId=workflow?.nodes.some(node=>node.id===nodeId)?nodeId:null;
  }
  function restoreOverlayFocus(dialog) {
    const trigger=overlayTrigger,nodeId=overlayNodeId,focused=document.activeElement;
    // Native close is queued: a newer menu, modal, or user-selected control owns
    // its focus already and must not be displaced by this older dialog.
    if(focused?.isConnected && focused!==document.body && focused!==trigger && !dialog.contains(focused)) {
      if(!host?.querySelector('dialog.wf-overlay[open]')){overlayTrigger=null;overlayNodeId=null;}
      return;
    }
    overlayTrigger=null;overlayNodeId=null;
    if(trigger?.isConnected)trigger.focus({preventScroll:true});else focusNode(nodeId || selected);
  }
  function syncMutationControls() {
    const reason=mutationReason();
    host?.querySelectorAll('#wf-name,[data-workflow-name],[data-wf-field],[data-wf-config],[data-wf-param],[data-wf-coordinate],#wf-connect-form button[type="submit"],#wf-connect-dialog-form button[type="submit"],[data-wf-action]').forEach(control=>{
      if(control.dataset.wfAction && !mutatingActions.has(control.dataset.wfAction))return;
      if(reason && !control.disabled){control.disabled=true;control.dataset.wfMutationDisabled='true';}
      else if(!reason && control.dataset.wfMutationDisabled==='true'){control.disabled=false;delete control.dataset.wfMutationDisabled;}
    });
    const target=workflow?.nodes.find(node=>node.id===deleteNodeId),label=$('#wf-delete-node-name'),confirm=$('#wf-delete-node-dialog [data-wf-action="delete-node"]');
    if(label && deleteNodeId)label.textContent=target?nodeName(target):'더 이상 존재하지 않는 노드';
    if(confirm)confirm.disabled=Boolean(reason) || !target || workflow.nodes.length<=1;
  }
  function openContextMenu({nodeId=null,anchor,x,y}={}) {
    if(!contextMenu || !workflow)return;
    const node=nodeId?workflow.nodes.find(item=>item.id===nodeId):null;
    if(nodeId&&!node)return;
    if(node)selectNode(node.id);
    const reason=mutationReason() || (saving || pending?'현재 작업이 끝난 뒤 다시 시도하세요.':''),locked=Boolean(reason);
    const item=(id,label,description,disabled=false,destructive=false)=>({id,label,description,disabled,destructive});
    const saveItem=item('save','그래프 저장',reason || '전체 연결을 검증하고 현재 버전으로 저장합니다. 장면 편집본 저장·실행·게시와는 별개입니다.',locked || (!dirty&&Boolean(workflow.id)));
    const items=node?[
      item('node-tools',locked?'노드 설정 보기':'노드 설정 편집',`${TYPES[node.type]?.summary || node.type} · ${reason || '이름·입력 설정·메모를 초안에서 편집합니다. 저장 전에는 실행에 반영되지 않습니다.'}`),
      item('scene-editor','장면 편집기 열기',node.config?.sceneId?`설정된 장면 ${node.config.sceneId}${node.config.slotId?` · 슬롯 ${node.config.slotId}`:''}을 엽니다. 저장·실행하지 않습니다.`:'이 프로젝트의 장면 편집기를 엽니다. 노드 역할·순서로 장면을 추측하지 않습니다.',!onOpenSceneEditor || !owns(workflow)),
      item('node-results','실행 결과·입력 보기','이 노드 ID의 실행 상태, 저장된 출력과 실행 당시 입력을 확인합니다. 새 실행은 시작하지 않습니다.'),
      item('connections','입력·출력 연결 보기','이 노드로 들어오고 나가는 정확한 연결을 확인합니다. 연결 제거는 초안에만 적용됩니다.'),
      item('input','입력 연결 선택',reason || '다른 노드의 출력을 이 노드의 입력에 연결합니다. 확인 전에는 변경하지 않습니다.',locked),
      item('output','출력 연결 선택',reason || '이 노드의 출력을 받을 도착 노드를 선택합니다. 확인 전에는 변경하지 않습니다.',locked),
      item('node-history','노드 변경 기록','저장 버전과 현재 초안의 차이를 확인합니다. 버전은 자동 복원하지 않습니다.'),
      saveItem,
      item('confirm-delete-node','노드 제거…',reason || (workflow.nodes.length<=1?'마지막 노드는 제거할 수 없습니다. 최소 1개가 필요합니다.':'확인 후 이 노드와 닿는 연결만 초안에서 제거합니다. 자동 재연결·미디어 삭제·자동 저장은 하지 않습니다. 단절된 초안은 다시 연결해야 저장됩니다.'),locked || workflow.nodes.length<=1,true),
    ]:[
      item('open-add-node','노드 추가…',reason || '선택한 노드 뒤에 새 단계를 추가하는 기존 대화상자를 엽니다. 그래프는 128개 노드까지 지원합니다.',locked || workflow.nodes.length>=128),
      item('open-workflow-settings',locked?'워크플로 설정 보기':'워크플로 설정 편집',reason || '프로젝트 그래프 이름을 초안에서 편집합니다. 명시적인 그래프 저장이 필요합니다.'),
      item('fit','전체 보기','모든 노드를 화면에 맞춥니다. 노드 좌표나 초안은 바꾸지 않습니다.'),
      item('canvas-history','실행 히스토리 보기','저장된 실행 기록을 엽니다. 실행·생성·게시 요청은 하지 않습니다.'),
      item('undo','실행 취소',reason || '현재 그래프 초안의 마지막 편집을 되돌립니다. 서버 버전·미디어·실행 기록은 변경하지 않습니다.',locked || !drafts.canUndo),
      item('redo','다시 실행',reason || '되돌린 그래프 초안 편집을 다시 적용합니다. 제작 실행을 시작하는 버튼이 아닙니다.',locked || !drafts.canRedo),
      saveItem,
    ];
    contextMenu.open({anchor:anchor || (node?nodeControl(node.id):$('#workflow-canvas')),x,y,title:node?`${nodeName(node)} · ${nodeSummary(node)}`:'프로젝트 캔버스',items,context:{nodeId:node?.id || null,key:stashKey(),epoch:contextEpoch}});
  }
  async function contextAction(id,context) {
    if(!host?.isConnected || context.epoch!==contextEpoch || context.key!==stashKey())return;
    if(context.nodeId && !workflow.nodes.some(node=>node.id===context.nodeId))throw new Error('선택한 노드를 찾을 수 없습니다.');
    if(context.nodeId)selectNode(context.nodeId);
    await action(context.nodeId?nodeControl(context.nodeId):$('#workflow-canvas'),id);
  }

  function nodesHtml() {
    return workflow.nodes.map((node,index)=>{
      const type=TYPES[node.type] || {name:node.type,icon:'?',summary:'알 수 없는 단계',color:'#999999'};
      const record=activeRun()?.nodeRuns?.find(item=>item.nodeId===node.id);
      const incoming=workflow.edges.filter(edge=>edge.target===node.id).map(edge=>nodeName(workflow.nodes.find(item=>item.id===edge.source))).filter(Boolean);
      const outgoing=workflow.edges.filter(edge=>edge.source===node.id).map(edge=>nodeName(workflow.nodes.find(item=>item.id===edge.target))).filter(Boolean);
      const mobileLinks=`입력: ${incoming.join(', ') || '없음'} · 출력: ${outgoing.join(', ') || '없음'}`;
      const description=`${type.summary} · ${nodeSummary(node)} · ${mobileLinks}`;
      return `<article class="wf-node ${selected===node.id?'selected':''}" data-node-id="${escapeHtml(node.id)}" data-tooltip="${escapeHtml(description)}" style="left:${Number(node.x)||0}px;top:${Number(node.y)||0}px;--node-color:${type.color}"><button type="button" class="wf-node-menu" data-wf-action="node-menu" data-id="${escapeHtml(node.id)}" data-tooltip="${escapeHtml(description)} · 설정·결과·연결·제거 메뉴" aria-haspopup="menu" aria-label="${escapeHtml(nodeName(node))} 더보기">⋯</button><button type="button" class="wf-node-header" data-wf-action="select-node" data-id="${escapeHtml(node.id)}" data-tooltip="${escapeHtml(description)} · 우클릭 또는 Shift+F10으로 메뉴 · 드래그·방향키로 위치 이동"><span class="wf-stage-index">${String(index+1).padStart(2,'0')}</span><span class="wf-node-icon" aria-hidden="true">${type.icon}</span><span class="wf-node-label">${escapeHtml(nodeName(node))}</span><span class="wf-grip" aria-hidden="true">⠿</span></button><div class="wf-node-content"><p>${escapeHtml(nodeSummary(node))}</p><span class="wf-node-status ${record?.status || 'idle'}" data-status-node="${escapeHtml(node.id)}">${STATUS[record?.status] || '실행 전'}</span><small class="wf-mobile-links">${escapeHtml(mobileLinks)}</small></div><button type="button" class="wf-port input" data-wf-action="input" data-id="${escapeHtml(node.id)}" aria-label="${escapeHtml(nodeName(node))} 입력 연결" data-tooltip="이 노드로 들어올 출발 노드를 선택합니다. ${escapeHtml(mobileLinks)}"><span></span>입력</button><button type="button" class="wf-port output" data-wf-action="output" data-id="${escapeHtml(node.id)}" aria-label="${escapeHtml(nodeName(node))} 출력 연결" data-tooltip="이 노드의 출력을 받을 노드를 선택합니다. ${escapeHtml(mobileLinks)}">출력<span></span></button></article>`;
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
      const canvasWidth=canvas.clientWidth,canvasHeight=canvas.clientHeight;
      const left=Math.min(...workflow.nodes.map(node=>Number(node.x)||0)), top=Math.min(...workflow.nodes.map(node=>Number(node.y)||0));
      const right=Math.max(...workflow.nodes.map(node=>(Number(node.x)||0)+WIDTH)), bottom=Math.max(...workflow.nodes.map(node=>(Number(node.y)||0)+HEIGHT));
      const worldWidth=Math.max(1,right-left+80), worldHeight=Math.max(1,bottom-top+80);
      workflow.nodes.forEach(node=>{
        const element=map.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`); const mini=map.querySelector(`.wf-minimap-node[data-id="${CSS.escape(node.id)}"]`);
        if (mini) { mini.style.left=`${((node.x-left+40)/worldWidth)*100}%`; mini.style.top=`${((node.y-top+40)/worldHeight)*100}%`; mini.classList.toggle('selected',selected===node.id); }
      });
      const viewX=-pan.x/scale,viewY=-pan.y/scale,viewW=canvasWidth/scale,viewH=canvasHeight/scale;
      viewport.style.left=`${((viewX-left+40)/worldWidth)*100}%`; viewport.style.top=`${((viewY-top+40)/worldHeight)*100}%`;
      viewport.style.width=`${Math.max(3,(viewW/worldWidth)*100)}%`; viewport.style.height=`${Math.max(3,(viewH/worldHeight)*100)}%`;
    });
  }

  function nodeSummary(node) {
    if (node.type==='script') return `${node.config?.agent || 'studio'} · ${node.config?.prompt?'사용자 지시문':'에피소드 소재 사용'}`;
    if (node.type==='news') return `${node.config?.query || node.config?.keywords || '트렌드·주제 뉴스 검색'} · 최대 ${node.config?.maxArticles || 5}건`;
    if (node.type==='layout') return `${node.config?.preset === 'premiere-3tier' ? '프리미어 3단 뉴스·오버레이' : '상단 이미지 + 중단 영상·자막'}`;
    if (node.type==='generate') return `${node.config?.model || '모델 선택'} · 장면 ${(node.config?.sceneIndex || 0)+1}${node.config?.slotId ? ` (${node.config.slotId})` : ''}`;
    if (node.type==='publish') return `${(node.config?.platform || 'youtube').toUpperCase()} · ${node.config?.visibility || 'private'} · 서버 세션`;
    if (node.type==='trend' && node.config?.query) return node.config.query;
    if (node.type==='research' && node.config?.limit) return `참고 자료 최대 ${node.config.limit}개`;
    return TYPES[node.type]?.summary || node.type;
  }
  function inspectorTabsHtml() {
    return [['settings','설정'],['results','실행 결과'],['history','변경 기록']].map(([key,label])=>`<button type="button" role="tab" aria-selected="${inspectorTab===key}" aria-controls="wf-overlay-inspector" data-wf-action="inspector-tab" data-tab="${key}" class="${inspectorTab===key?'selected':''}">${label}</button>`).join('');
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
    if (node.type==='news') controls=`<label>뉴스 검색어<input data-wf-config="query" value="${escapeHtml(config.query || '')}" maxlength="200" placeholder="예: AI 반도체, 금리 인하 (비워두면 에피소드 소재·트렌드 사용)"></label><label>보조 키워드 (쉼표 구분)<input data-wf-config="keywords" value="${escapeHtml(config.keywords || '')}" maxlength="400" placeholder="핵심 키워드1, 키워드2"></label><div class="two-cols"><label>최대 기사 수<input type="number" data-wf-config="maxArticles" min="1" max="20" step="1" value="${config.maxArticles ?? 5}"></label><label>뉴스 출처<select data-wf-config="source"><option value="all" ${(config.source || 'all')==='all'?'selected':''}>통합 뉴스 + 트렌드</option><option value="google_news" ${config.source==='google_news'?'selected':''}>Google News KR</option><option value="trend_news" ${config.source==='trend_news'?'selected':''}>트렌드 연동 뉴스</option></select></label></div><p class="hint">키워드 및 뉴스 검색 결과로부터 시나리오 도입부(훅)와 장면별 구성을 대본 노드에 전달합니다.</p>`;
    if (node.type==='research') controls=`<label>참고 자료 수 (선택)<input type="number" data-wf-config="limit" value="${config.limit ?? ''}" min="1" max="50" step="1" placeholder="전체 자료"></label><p class="hint">채널에 연결된 참고 자료에서 최대 이 수만큼 사용합니다.</p>`;
    if (node.type==='layout') controls=`<label>장면 레이아웃 템플릿<select data-wf-config="preset"><option value="top-image-mid-video" ${(config.preset || 'top-image-mid-video')==='top-image-mid-video'?'selected':''}>상단 이미지·텍스트 + 중단 배경영상·자막 (Premiere 2단)</option><option value="premiere-3tier" ${config.preset==='premiere-3tier'?'selected':''}>상단 HTML 뉴스 배너 + 상단 이미지 + 중단 배경영상·자막 (Premiere 3단)</option><option value="split" ${config.preset==='split'?'selected':''}>상하 분할 기본</option><option value="custom" ${config.preset==='custom'?'selected':''}>사용자 지정 슬롯 유지</option></select></label><div class="two-cols"><label>상단 레이아웃 모듈<select data-wf-config="topSlotRole"><option value="image-gen" ${(config.topSlotRole || 'image-gen')==='image-gen'?'selected':''}>이미지 생성 + 텍스트</option><option value="text-overlay" ${config.topSlotRole==='text-overlay'?'selected':''}>텍스트 전용 레이아웃</option><option value="html-overlay" ${config.topSlotRole==='html-overlay'?'selected':''}>Pencil HTML 오버레이</option></select></label><label>중단 레이아웃 모듈<select data-wf-config="midSlotRole"><option value="video-bg" ${(config.midSlotRole || 'video-bg')==='video-bg'?'selected':''}>Higgsfield 배경 영상</option><option value="image-gen" ${config.midSlotRole==='image-gen'?'selected':''}>배경 이미지</option></select></label></div><label class="generation-checkbox"><input type="checkbox" data-wf-config="enableSubtitles" ${config.enableSubtitles!==false?'checked':''}> 중단 배경 영상 위 자막 레이어 자동 배치</label><label class="generation-checkbox"><input type="checkbox" data-wf-config="enableHtmlOverlay" ${config.enableHtmlOverlay!==false?'checked':''}> Pencil 스타일 HTML 오버레이 슬롯 활성화</label><label class="generation-checkbox"><input type="checkbox" data-wf-config="autoPrompts" ${config.autoPrompts!==false?'checked':''}> 시나리오에서 슬롯별 이미지·Higgsfield 영상 연출 프롬프트 초안 자동 작성</label><p class="hint">연출 초안을 각 장면의 레이아웃 슬롯에 바인딩하며, 스튜디오 편집기에서 위치·크기·용도를 자유롭게 미세 조정할 수 있습니다.</p>`;
    if (node.type==='review') controls=`<label>검토 지침<textarea data-wf-config="instructions" maxlength="2000" rows="5" placeholder="자막, 연출, 사실 확인 등 검토할 항목">${escapeHtml(config.instructions || '')}</textarea></label><p class="hint">결과와 함께 보존되는 검토 지침입니다. 승인하거나 게시하는 자동 규칙이 아닙니다.</p>`;
    if (node.type==='publish') controls=`<div class="two-cols"><label>대상 플랫폼<select data-wf-config="platform"><option value="youtube" ${(config.platform || 'youtube')==='youtube'?'selected':''}>YouTube Studio</option><option value="tiktok" ${config.platform==='tiktok'?'selected':''}>TikTok Studio</option><option value="instagram" ${config.platform==='instagram'?'selected':''}>Instagram</option><option value="other" ${config.platform==='other'?'selected':''}>기타 플랫폼</option></select></label><label>공개 설정<select data-wf-config="visibility"><option value="private" ${(config.visibility || 'private')==='private'?'selected':''}>비공개 (검토용)</option><option value="unlisted" ${config.visibility==='unlisted'?'selected':''}>일부 공개</option><option value="public" ${config.visibility==='public'?'selected':''}>전체 공개</option></select></label></div><label>업로드 제목 템플릿 (선택)<input data-wf-config="titleTemplate" maxlength="200" value="${escapeHtml(config.titleTemplate || '')}" placeholder="{title} · 비워두면 에피소드 제목 사용"></label><label class="generation-checkbox"><input type="checkbox" data-wf-config="autoAttachExport" ${config.autoAttachExport!==false?'checked':''}> 렌더링된 서버 저장소(data/exports) MP4를 비동기 브라우저 세션에 즉시 마운트</label><p class="hint">실행 시 서버 측 비동기 브라우저 세션을 열고 서버 저장소의 MP4 파일을 지정된 채널 업로드 창에 연결합니다.</p>`;
    if (node.type==='generate') controls=generationControlsHtml(node);
    return `<h3>${escapeHtml(nodeName(node))}</h3><p class="hint">${escapeHtml(TYPES[node.type]?.summary)}</p><label>노드 이름<input data-wf-field="label" maxlength="80" value="${escapeHtml(node.label || '')}" placeholder="${escapeHtml(TYPES[node.type]?.name)}"></label>${controls}<label>작업 메모<textarea data-wf-field="notes" rows="3" maxlength="2000" placeholder="이 단계의 의도와 수정할 점">${escapeHtml(node.notes || '')}</textarea></label><details class="history-advanced"><summary>캔버스 위치</summary><div class="two-cols"><label>X 위치<input type="number" id="wf-node-x" data-wf-coordinate="x" step="10" min="0" max="10000" value="${Math.round(node.x)}"></label><label>Y 위치<input type="number" id="wf-node-y" data-wf-coordinate="y" step="10" min="0" max="10000" value="${Math.round(node.y)}"></label></div></details><button class="small danger" data-wf-action="confirm-delete-node">노드 삭제</button><p class="hint">필수 단계를 삭제하면 다시 추가하고 연결해야 저장할 수 있습니다.</p>`;
  }
  function factsHtml(value) {
    if (!value || typeof value!=='object') return `<p class="result-copy">${escapeHtml(displayValue(value))}</p>`;
    const labels={message:'설명',agent:'에이전트',mode:'실행 방식',query:'검색 키워드',preset:'레이아웃 프리셋',slotCount:'총 슬롯 수',sceneCount:'장면 수',version:'결과 버전',episodeVersion:'에피소드 버전',model:'생성 모델',slotId:'대상 슬롯',requestId:'요청 ID',providerRequestId:'제공자 요청 ID',generationJobId:'생성 작업 ID',sessionId:'플랫폼 세션 ID',channelName:'대상 채널',platform:'플랫폼',exportUrl:'서버 저장소 MP4',type:'결과 형식',status:'상태',instructions:'검토 지침',sceneId:'대상 장면',outputUrl:'결과 파일'};
    let html=`<dl class="result-facts">${Object.entries(labels).filter(([key])=>value[key]!==undefined && typeof value[key]!=='object').map(([key,label])=>`<div><dt>${label}</dt><dd>${escapeHtml(displayValue(value[key]))}</dd></div>`).join('')}</dl>`;
    for (const [key,label] of [['trends','키워드'],['articles','뉴스 기사'],['references','참고 자료'],['scenes','장면']]) if (Array.isArray(value[key])) html+=`<h4>${label} · ${value[key].length}</h4><ul class="result-list">${value[key].slice(0,12).map(item=>`<li><strong>${escapeHtml(item.headline || item.title || item.keyword || item.name || item.id || label)}</strong>${item.summary || item.text?`<p>${escapeHtml(item.summary || item.text)}</p>`:''}${item.narration?`<p>음성 · ${escapeHtml(item.narration)}</p>`:''}${Array.isArray(item.slots)&&item.slots.length?`<small>레이아웃 슬롯 ${item.slots.length}개 (${item.slots.map(s=>s.name||s.role).join(', ')})</small>`:''}${item.duration?`<small>${Number(item.duration)}초</small>`:''}</li>`).join('')}</ul>${value[key].length>12?'<p class="hint">전체 내용은 원본 기록에서 확인할 수 있습니다.</p>':''}`;
    const url=value.asset?.url || value.assetUrl || value.outputUrl || value.url;
    if (typeof url==='string' && /^\/api\/(uploads|exports)\/[a-zA-Z0-9_.-]+$/.test(url)) html+=/\.(mp4|webm)$/i.test(url)?`<video class="node-result-media" controls preload="metadata" src="${escapeHtml(url)}"></video>`:/\.(png|jpg|jpeg|webp)$/i.test(url)?`<img class="node-result-media" src="${escapeHtml(url)}" alt="생성 결과">`:'';
    if(Array.isArray(value.outputs)) html+=value.outputs.slice(0,8).map(output=>factsHtml(output)).join('');
    return html || '<p class="hint">아래 원본 기록에서 결과를 확인하세요.</p>';
  }
  function nodeResultsHtml(node,runControlId='wf-inspector-run') {
    const run=activeRun(),record=run?.nodeRuns?.find(item=>item.nodeId===node.id);
    const snapshotNode=run?.workflowSnapshot?.nodes.find(item=>item.id===node.id);
    const inputIds=run?.workflowSnapshot?.edges.filter(edge=>edge.target===node.id).map(edge=>edge.source) || [];
    const seconds=record?.startedAt && record?.completedAt ? Math.max(0,(new Date(record.completedAt)-new Date(record.startedAt))/1000).toFixed(1):null;
    return `<h3>${escapeHtml(nodeName(node))}</h3><label>실행 선택<select id="${escapeHtml(runControlId)}" aria-label="노드 실행 선택">${runs.length?runs.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===run?.id?'selected':''}>${stamp(item.createdAt)} · v${item.workflowVersion} · ${escapeHtml(STATUS[item.status] || item.status)}</option>`).join(''):'<option>실행 기록 없음</option>'}</select></label>${run?`<p class="hint">실행 당시 워크플로우 v${run.workflowVersion} · 에피소드 v${run.episodeVersion}<br>${stamp(record?.startedAt || run.createdAt)}${seconds?` · ${seconds}초`:''}</p>`:''}${!record?'<p class="history-empty">이 노드는 선택한 실행에 포함되지 않았습니다.</p>':`<span class="badge">${escapeHtml(STATUS[record.status] || record.status)}</span>${record.error?`<p class="wf-review-warning" role="alert">${escapeHtml(record.error)}</p>`:''}${record.output?.generationJobId?generationJobHtml(record.output.generationJobId):''}<h4>실행 입력</h4>${snapshotNode?factsHtml(snapshotNode.config):''}${inputIds.length?`<ul class="result-list">${inputIds.map(id=>{const source=run.workflowSnapshot.nodes.find(item=>item.id===id),result=run.nodeRuns.find(item=>item.nodeId===id);return `<li><strong>${escapeHtml(nodeName(source))}</strong><span class="hint"> · ${escapeHtml(STATUS[result?.status] || result?.status || '대기')}</span>${factsHtml(result?.output)}</li>`;}).join('')}</ul>`:'<p class="hint">연결된 선행 노드 없이 에피소드의 소재와 저장된 내용을 사용합니다.</p>'}<h4>실행 결과</h4>${record.output?factsHtml(record.output):'<p class="hint">아직 결과가 없습니다.</p>'}<details class="history-advanced"><summary>고급 · 입력 / 출력 원본</summary><pre class="history-snapshot">${escapeHtml(JSON.stringify({config:snapshotNode?.config,inputs:inputIds.map(id=>({nodeId:id,output:run.nodeRuns.find(item=>item.nodeId===id)?.output})),output:record.output},null,2))}</pre></details>`}`;
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
  function generationInput(node=selectedNode()) {
    const target=liveEpisode(episodeId) || (generationTargetEpisode?.id===episodeId?generationTargetEpisode:null);
    if(node?.type!=='generate')return {episodeId,sceneId:null,sceneIndex:null,model:'',prompt:'',params:{},stableTargetMissing:true};
    const sceneId=node.config?.sceneId;
    const index=sceneId?target?.scenes?.findIndex(scene=>scene.id===sceneId):Number(node.config?.sceneIndex ?? 0);
    const scene=Number.isInteger(index)&&index>=0?target?.scenes?.[index]:null;
    const slotId=node.config?.slotId || null,slot=slotId?scene?.slots?.find(item=>item.id===slotId):null;
    return {nodeId:node.id,episodeId,sceneId:scene?.id || null,sceneIndex:index,sceneTitle:scene?.title || '',slotId,model:node.config?.model || '',prompt:node.config?.prompt || slot?.prompt || scene?.text || target?.topic || '',params:copy(node.config?.params || {}),stableTargetMissing:!scene || Boolean(slotId&&!slot)};
  }
  function generationSelection() {
    if(generationStageRun)return selectedNode()?.type==='generate'?[selected]:[];
    const prior=runs.find(run=>run.id===generationResumeRunId);
    if(prior && prior.workflowVersion===workflow?.version && TERMINAL.has(prior.status))return workflow.nodes.filter(node=>node.type!=='publish' && (['generate','render','review'].includes(node.type)||!['completed','succeeded','reused'].includes(prior.nodeRuns?.find(item=>item.nodeId===node.id)?.status))).map(node=>node.id);
    return workflow?.nodes.filter(node=>node.type!=='publish').map(node=>node.id) || [];
  }
  function generationOptions() {
    const selectedStages=generationSelection(),options={selectedStages,disclosure:copy(disclosure),expectedWorkflowVersion:workflow?.version,expectedEpisodeVersion:liveEpisode(episodeId)?.version};
    if(generationStageRun)options.startStage=selectedStages[0];
    if(generationResumeRunId)options.resumeRunId=generationResumeRunId;
    return options;
  }
  function generationInputKey() {
    return JSON.stringify({workflow,episode:liveEpisode(episodeId),options:generationOptions()});
  }
  function assertGenerationInput(input) {
    if(input.stableTargetMissing || !input.sceneId || !Number.isInteger(input.sceneIndex))throw new Error('생성 대상 장면 또는 슬롯을 확인할 수 없습니다. 대상을 다시 선택하세요.');
    return input;
  }
  function invalidateGenerationEstimate() {
    generationEstimate=null;generationEstimateKey='';generationEstimateError='';generationEstimateAcknowledged=false;
    const dialog=$('#wf-confirm-dialog');if(dialog?.open)refreshDialogConfirmation();
  }
  function quoteLabel(plan) {
    return plan?.aggregate?.quoted===true?`${JSON.stringify(plan.aggregate.totalCost ?? plan.aggregate)} ${plan.aggregate.currency || ''}`.trim():'';
  }
  function sourcePreparation() {
    const ids=new Set(generationSelection()),run=activeRun();
    const sourceNodes=workflow?.nodes.filter(node=>ids.has(node.id)&&!['generate','render','review','publish'].includes(node.type)) || [];
    return sourceNodes.filter(node=>!run || run.workflowVersion!==workflow.version || !['completed','succeeded','reused'].includes(run.nodeRuns?.find(item=>item.nodeId===node.id)?.status));
  }
  async function loadGenerationEstimate() {
    if(typeof disclosure.containsSyntheticMedia!=='boolean'||!disclosure.rationale.trim())throw new Error('AI 사용 공개 여부와 판단 근거를 먼저 선택하세요.');
    if(sourcePreparation().length)throw new Error('소스·대본·스토리보드를 먼저 준비하고 새 견적을 요청하세요.');
    const epoch=contextEpoch,targetId=workflow?.id,targetEpisodeId=episodeId;
    await beforeRun?.(targetEpisodeId);
    if(epoch!==contextEpoch)throw new Error('프로젝트 또는 워크플로우가 변경되었습니다.');
    await save();
    if(epoch!==contextEpoch || workflow?.id!==targetId)throw new Error('프로젝트 또는 워크플로우가 변경되었습니다.');
    for(const node of workflow.nodes.filter(node=>generationSelection().includes(node.id)&&node.type==='generate'))assertGenerationInput(generationInput(node));
    const key=generationInputKey(),options=generationOptions();
    generationEstimateLoading=true;invalidateGenerationEstimate();
    try {
      const plan=await post(`/api/workflows/${targetId}/quote`,{episodeId:targetEpisodeId,...options});
      if(epoch!==contextEpoch || key!==generationInputKey())return;
      if(!plan?.id || !plan.fingerprint || !plan.candidate || !Array.isArray(plan.nodes))throw new Error('서버의 전체 후보 견적을 확인할 수 없습니다.');
      generationEstimate=plan;generationEstimateKey=key;generationConsentSnapshot={workflowId:targetId,episodeId:targetEpisodeId,key,options};
    } catch(error) {if(epoch===contextEpoch)generationEstimateError=error.message;}
    finally {if(epoch===contextEpoch){generationEstimateLoading=false;paint();$('#wf-confirm-dialog')?.showModal();}}
  }
  function refreshDialogConfirmation() {
    const dialog=$('#wf-confirm-dialog');if(!dialog||!generationConsent)return;
    const valid=generationEstimate?.id&&generationEstimateKey===generationInputKey()&&Date.parse(generationEstimate.expiresAt)>Date.now();
    if(!valid) {
      dialog.querySelector('[data-generation-quote]')?.remove();
      for(const cost of dialog.querySelectorAll('[data-generation-cost]'))cost.textContent='새 견적 필요';
    }
    const confirm=dialog.querySelector('[data-wf-action="confirm-generation-run"]');
    if(confirm)confirm.disabled=generationEstimateLoading||!valid||(!generationEstimate.aggregate?.quoted&&!generationEstimateAcknowledged);
    const acknowledgement=dialog.querySelector('#wf-estimate-ack');if(acknowledgement)acknowledgement.checked=generationEstimateAcknowledged;
  }
  function dialogsHtml() {
    const entry=versions.find(item=>item.version===restoreVersion),plan=generationEstimate,valid=Boolean(plan?.id&&generationEstimateKey===generationInputKey()&&Date.parse(plan.expiresAt)>Date.now());
    const targets=workflow?.nodes.filter(node=>generationSelection().includes(node.id)&&node.type==='generate').map(node=>generationInput(node)) || [];
    const quotedNodes=plan?.nodes?.map(node=>({...plan.candidate.nodes?.find(input=>input.nodeId===node.nodeId),...node})) || targets;
    const rows=quotedNodes.map(node=>`<li data-generation-node="${escapeHtml(node.nodeId)}"><strong>${escapeHtml(node.nodeId)}</strong><dl class="wf-review-facts"><div><dt>장면 / 슬롯</dt><dd>${escapeHtml(node.sceneId)} / ${escapeHtml(node.slotId || '장면 전체')}</dd></div><div><dt>모델</dt><dd>${escapeHtml(node.model)}</dd></div><div><dt>입력 / 매개변수</dt><dd><pre class="history-snapshot">${escapeHtml(JSON.stringify(node.input || {prompt:node.prompt,params:node.params},null,2))}</pre></dd></div><div><dt>비용</dt><dd data-generation-cost>${node.quoted===true?escapeHtml(JSON.stringify(node.cost)):'견적 미확인'}</dd></div></dl></li>`).join('');
    const generationDialog=`<p>선택한 모든 생성 노드와 대상의 정확한 입력·비용을 확인하세요. 견적과 실행은 명시적으로 요청할 때만 진행합니다.</p><p>에피소드: ${escapeHtml(episodeId)} · 선택 노드: ${escapeHtml(generationSelection().join(', '))}</p><label>플랫폼 AI 사용 공개 결정<select id="wf-disclosure"><option value="" ${disclosure.containsSyntheticMedia===null?'selected':''}>아직 답하지 않음</option><option value="true" ${disclosure.containsSyntheticMedia===true?'selected':''}>공개 필요</option><option value="false" ${disclosure.containsSyntheticMedia===false?'selected':''}>공개 불필요</option></select></label><label>판단 근거<textarea id="wf-disclosure-rationale" maxlength="2000">${escapeHtml(disclosure.rationale)}</textarea></label><ul class="result-list">${rows}</ul>${sourcePreparation().length?'<p class="wf-review-warning">소스·대본·스토리보드를 먼저 준비하고 결과를 확인하세요. 새 결과가 바뀌면 이전 견적은 사용할 수 없습니다.</p><button data-wf-action="prepare-generation-source">소스·대본 먼저 준비</button>':''}<button data-wf-action="quote-generation" ${generationEstimateLoading?'disabled':''}>전체 후보 견적 확인</button>${generationEstimateError?`<p class="wf-review-warning" role="alert">${escapeHtml(generationEstimateError)}</p>`:''}${plan?`<div data-generation-quote><p class="generation-quote">전체 비용: ${escapeHtml(quoteLabel(plan) || '견적 미확인')}</p><p>후보 fingerprint: <code data-testid="generation-fingerprint">${escapeHtml(plan.fingerprint)}</code></p><p>견적 만료: ${escapeHtml(plan.expiresAt)}</p><details><summary>서버의 정확한 전체 후보</summary><pre class="history-snapshot">${escapeHtml(JSON.stringify(plan.candidate,null,2))}</pre></details>${!plan.aggregate?.quoted?`<label class="generation-checkbox"><input id="wf-estimate-ack" type="checkbox" data-wf-action="estimate-ack" ${generationEstimateAcknowledged?'checked':''}> 모든 미확인 견적에 대해 비용을 모르는 상태로 실행함을 확인합니다.</label>`:''}</div>`:''}`;
    return `<dialog id="wf-confirm-dialog"><h2>${generationConsent?'전체 후보 생성 승인':'이전 버전을 새 버전으로 복원'}</h2>${generationConsent?generationDialog:`<p>현재 v${workflow?.version}은 기록에 보존됩니다. 선택한 v${entry?.version || ''}의 내용을 새 버전으로 저장합니다.</p>${entry?changesHtml(workflowChanges(workflow,entry.snapshot),escapeHtml,'현재 내용','복원할 내용'):''}`}<div class="dialog-actions"><button data-wf-action="close-dialog">취소</button><button class="primary" data-wf-action="${generationConsent?'confirm-generation-run':'confirm-restore'}" ${generationConsent&&(!valid||generationEstimateLoading||(!plan?.aggregate?.quoted&&!generationEstimateAcknowledged))?'disabled':''}>${generationConsent?'전체 비용 확인 후 생성 실행':'새 버전으로 복원'}</button></div></dialog>`;
  }
  function generationControlsHtml(node) {
    const config=node.config || {};
    const selectedEpisode=liveEpisode(episodeId) || (generationTargetEpisode?.id===episodeId ? generationTargetEpisode : null);
    const configuredIndex=Math.max(0,Number(config.sceneIndex) || 0);
    const selectedScene=config.sceneId ? selectedEpisode?.scenes?.find(item=>item.id===config.sceneId) : selectedEpisode?.scenes?.[configuredIndex];
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
    const sceneSlots = Array.isArray(selectedScene?.slots) ? selectedScene.slots.filter(s => s.role === 'video-bg' || s.role === 'image-gen') : [];
    const slotSelector = sceneSlots.length ? `<label>대상 레이아웃 슬롯 (선택)<select data-wf-config="slotId"><option value="">장면 전체 (기본)</option>${sceneSlots.map(s => `<option value="${escapeHtml(s.id)}" ${config.slotId === s.id ? 'selected' : ''}>${escapeHtml(s.name)} (${escapeHtml(s.role)})</option>`).join('')}</select></label>` : '';
    return `<p class="generation-flow" aria-label="생성 단계"><strong>1 프롬프트</strong><span aria-hidden="true">→</span><strong>2 설정</strong><span aria-hidden="true">→</span><strong>3 확인 후 실행</strong><span aria-hidden="true">→</span><strong>결과</strong></p><div class="generation-connection" role="status" aria-live="polite"><span class="badge ${provider.tone}">${provider.label}</span><p class="hint">${escapeHtml(generationError || status.detail || provider.detail)}</p><button class="small" data-wf-action="refresh-generation">연결·모델 확인</button></div><p class="generation-target"><strong>대상</strong> ${escapeHtml(selectedEpisode?.title || '에피소드 미선택')} · 장면 ${displaySceneIndex+1}${selectedScene?.title?` · ${escapeHtml(selectedScene.title)}`:''}${config.slotId?` · 슬롯 ${escapeHtml(config.slotId)}`:''}</p><label>생성 모델<select data-wf-config="model" id="wf-generation-model">${availableModels.map(model=>`<option value="${escapeHtml(model.id)}" ${model.id===(config.model || DEFAULT_GENERATION_MODEL)?'selected':''}>${escapeHtml(model.name || model.id)}${model.type?` · ${escapeHtml(model.type)}`:''}</option>`).join('')}</select></label><label>대상 장면 번호<input type="number" min="1" max="60" step="1" data-wf-config="sceneIndex" value="${displaySceneIndex+1}"></label>${slotSelector}<label>생성 지시문<textarea id="wf-generation-prompt" aria-describedby="generation-safety" data-wf-config="prompt" maxlength="4000" rows="5" placeholder="비워두면 대상 슬롯·장면의 연출 프롬프트 또는 에피소드 주제를 사용합니다.">${escapeHtml(config.prompt || '')}</textarea></label>${schema?`<fieldset class="generation-parameters"><legend>필수 모델 설정</legend>${requiredParams || '<p class="hint">필수 추가 설정이 없습니다.</p>'}${optionalParams?`<details class="generation-advanced"><summary>선택 설정</summary>${optionalParams}</details>`:''}</fieldset>`:params}<p id="generation-safety" class="generation-safety wf-review-warning">이 화면을 여는 동안 생성 요청·저장·비용은 발생하지 않습니다. 실행 전 비용 견적과 별도 확인을 거칩니다. 실행하면 선택한 장면·레이아웃 슬롯에 결과를 자동 적용하고 이어서 렌더합니다. 실패하거나 중단된 결과만 실행 결과에서 별도로 적용할 수 있습니다.</p>`;
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
    const panels=[...host?.querySelectorAll('#wf-overlay-inspector') || []]; if (!panels.length) return;
    const focused=document.activeElement;
    const selector=focused?.dataset.wfConfig?`[data-wf-config="${focused.dataset.wfConfig}"]`:focused?.dataset.wfField?`[data-wf-field="${focused.dataset.wfField}"]`:null;
    panels.forEach(panel=>{const active=panel.contains(focused),start=active?focused.selectionStart:null,end=active?focused.selectionEnd:null,scroll=panel.scrollTop;panel.innerHTML=inspectorHtml();panel.scrollTop=scroll;if(active && selector){const replacement=panel.querySelector(selector);replacement?.focus({preventScroll:true});if(typeof start==='number' && replacement?.setSelectionRange && !['number','checkbox'].includes(replacement.type))replacement.setSelectionRange(start,end);}});
    syncMutationControls();
  }
  function stageInfo() {
    const node=selectedNode(),run=activeRun(),record=run?.nodeRuns?.find(item=>item.nodeId===node?.id);
    if (!node) return {node:null,state:'blocked',text:'노드를 선택하면 실행할 단계를 확인할 수 있습니다.',resumeRunId:null,canResume:false};
    if(mutationReason())return {node,state:'blocked',text:mutationReason(),resumeRunId:null,canResume:false};
    const ancestors=[];
    const visit=id=>workflow.edges.filter(edge=>edge.target===id).forEach(edge=>{ const dep=workflow.nodes.find(item=>item.id===edge.source); if (dep && !ancestors.some(item=>item.id===dep.id)) { ancestors.push(dep); visit(dep.id); } });
    visit(node.id);
    const nodeState=entry=>entry?.status==='skipped'?entry.retainedStatus:entry?.status;
    const reusable=entry=>['completed','succeeded','reused','awaiting_review','approved','changes_requested'].includes(nodeState(entry));
    const blocked=ancestors.filter(dep=>!reusable(run?.nodeRuns?.find(entry=>entry.nodeId===dep.id)));
    const depReady=!blocked.length;
    const terminal=run && TERMINAL.has(run.status);
    const priorRunId=terminal ? run.id : null;
    const canResume=Boolean(run && ['failed','cancelled'].includes(run.status) && !reusable(record));
    if (LIVE.has(record?.status) || (run && LIVE.has(run.status) && !record)) return {node,state:'running',text:'선택한 단계가 실행 중입니다.',resumeRunId:null,canResume:false};
    if (!depReady) return {node,state:'blocked',text:`선행 단계가 필요합니다: ${blocked.map(dep=>nodeName(dep)).join(', ') || '연결된 출력'}`,resumeRunId:priorRunId,canResume:false};
    if(node.type==='publish') {
      const reviews=upstreamBoundary(workflow.nodes,workflow.edges,node.id,'review');
      if(reviews.length!==1 || nodeState(run?.nodeRuns?.find(entry=>entry.nodeId===reviews[0].id))!=='approved')return {node,state:'blocked',text:'연결된 후보의 명시적인 검토 승인이 필요합니다.',resumeRunId:priorRunId,canResume:false};
    }
    if (record?.status==='failed' || canResume) return {node,state:'blocked',text:'이전 실행이 실패했습니다. 완료된 출력은 재사용하고 이 단계부터 재개할 수 있습니다.',resumeRunId:priorRunId,canResume:Boolean(canResume && priorRunId)};
    if (reusable(record)) return {node,state:'completed',text:'선택한 단계가 완료되었습니다. 새 실행으로 다시 시작할 수 있습니다.',resumeRunId:priorRunId,canResume:false};
    return {node,state:'idle',text:'선택한 단계부터 실행할 준비가 되었습니다.',resumeRunId:priorRunId,canResume:false};
  }
  function stageDialogHtml() {
    const info=stageInfo();
    return `<div class="wf-overlay-header"><div><span class="eyebrow">STAGE CONTROL</span><h2 id="wf-stage-title">선택 단계 실행</h2></div><button type="button" data-wf-action="close-overlay" aria-label="단계 실행 닫기">닫기</button></div><p id="wf-stage-status" aria-live="polite" data-stage-state="${info.state}"><strong>${escapeHtml(info.node ? nodeName(info.node) : '선택된 노드 없음')}</strong><br>${escapeHtml(info.text)}</p><p class="hint">필수 선행 출력과 현재 에피소드·워크플로우 버전을 확인한 뒤 요청합니다. 생성 단계는 비용 확인 후 실행됩니다.</p><div class="dialog-actions"><button type="button" data-wf-action="stage-start" id="wf-stage-start" ${info.state==='blocked'||info.state==='running'||!info.node?'disabled':''}>선택 단계 시작</button>${info.canResume?`<button type="button" class="primary" data-wf-action="resume-stage">실패 실행에서 재개</button>`:''}</div>`;
  }
  function resultsDialogHtml() {
    const node=selectedNode();
    return `<div class="wf-overlay-header"><div><span class="eyebrow">RUN RESULTS</span><h2 id="wf-results-title">실행 결과와 기록</h2></div><button type="button" data-wf-action="close-overlay" aria-label="실행 결과 닫기">닫기</button></div><div id="wf-overlay-body" class="wf-overlay-body"><div id="wf-overlay-results-runs">${runsHtml()}</div><div id="wf-overlay-result-inspector">${node ? nodeResultsHtml(node,'wf-results-run') : '<p class="hint">캔버스에서 노드를 선택하세요.</p>'}</div></div>`;
  }
  function addNodeDialogHtml() {
    const available = (workflow?.nodes.length || 0)<128 ? TYPE_ORDER : [];
    return `<div class="wf-overlay-header"><div><span class="eyebrow">ADD NODE</span><h2 id="wf-add-node-title">실행 흐름에 노드 추가</h2></div><button type="button" data-wf-action="close-overlay" aria-label="노드 추가 닫기">닫기</button></div><div class="wf-overlay-body"><label>노드 종류<select id="wf-add-type" ${available.length ? '' : 'disabled'}>${available.map(type => `<option value="${type}">${escapeHtml(TYPES[type].name)}</option>`).join('')}</select></label><label>노드 이름 (선택)<input id="wf-add-label" maxlength="80" placeholder="기본 이름 사용"></label><p id="wf-add-node-preview" class="hint" role="status">${available.length ? '선택한 노드 뒤에 새 ID의 노드를 삽입합니다. 같은 역할을 여러 번 사용할 수 있습니다.' : '추가할 수 있는 노드 종류가 없습니다.'}</p><div class="dialog-actions"><button type="button" data-wf-action="close-overlay">취소</button><button type="button" class="primary" data-wf-action="add-node" ${available.length ? '' : 'disabled'}>노드 추가·연결</button></div></div>`;
  }
  function connectDialogHtml() {
    const nodes = workflow?.nodes || [];
    const optionsFor = selectedId => nodes.map(node => `<option value="${escapeHtml(node.id)}" ${selectedId === node.id ? 'selected' : ''}>${escapeHtml(nodeName(node))} · ${escapeHtml(node.id)}</option>`).join('');
    const target=nodes.find(node=>node.id===connectionNodeId);
    return `<div class="wf-overlay-header"><div><span class="eyebrow">NODE CONNECTION</span><h2 id="wf-connect-title">${target?`${escapeHtml(nodeName(target))} · 입력·출력 연결`:'노드 연결 편집'}</h2></div><button type="button" data-wf-action="close-overlay" aria-label="노드 연결 닫기">닫기</button></div><div class="wf-overlay-body"><form id="wf-connect-dialog-form"><label>출발 노드<select id="wf-connect-source" name="source" required><option value="">출력 노드를 선택하세요</option>${optionsFor(connecting)}</select></label><label>도착 노드<select id="wf-connect-target" name="target" required><option value="">입력 노드를 선택하세요</option>${optionsFor(null)}</select></label><p class="hint">연결 추가·제거는 초안만 바꾸며 자동 저장하지 않습니다. 순환·자기 연결·중복 연결은 허용되지 않습니다. 단절되거나 필수 역할 경계가 없는 초안은 다시 연결해야 그래프 저장이 가능합니다.</p><div class="dialog-actions"><button type="button" data-wf-action="close-overlay">닫기</button><button type="submit" class="primary" data-tooltip="초안에 연결을 추가합니다. 서버에 반영하려면 별도로 그래프를 저장하세요.">초안에 연결 추가</button></div></form><h3>${target?'이 노드의 입력·출력':'기존 연결'}</h3><div class="wf-connection-list">${connectionsHtml(target?.id)}</div><p class="hint">${escapeHtml(mutationReason() || '제거한 연결은 실행 취소로 복원할 수 있습니다. 미디어·실행 기록은 삭제하지 않습니다.')}</p></div>`;
  }
  function ensureAuxiliaryUi() {
    if(!workflow) {
      if(project) {
        const title=$('.empty h2'),message=$('.empty p');
        if(title)title.textContent='프로젝트 워크플로우를 선택하세요';
        if(message)message.textContent='저장된 프로젝트 그래프를 선택하거나, 공용 템플릿을 선택한 뒤 프로젝트용 복사본 만들기를 눌러 시작하세요. 목록이 비어 있으면 새로고침하세요. 공용 템플릿도 없다면 먼저 템플릿을 명시적으로 등록해야 합니다. 복사본을 만들기 전에는 새 구성·편집·저장을 할 수 없으며, 이 화면을 여는 것만으로 저장·생성·실행하지 않습니다.';
      }
      return;
    }
    const canvas=$('#workflow-canvas');
    if (canvas && !$('#wf-minimap')) canvas.insertAdjacentHTML('beforeend',`<div id="wf-minimap" class="wf-minimap" tabindex="0" role="application" aria-label="워크플로우 미니맵. 화살표로 이동하고 노드를 선택하세요."><div id="wf-minimap-world">${minimapHtml()}</div><div id="wf-minimap-viewport" aria-hidden="true"></div></div>`);
    const header=host?.querySelector('.wf-graph-panel .panel-header .row:last-child');
    if (header && !header.querySelector('[data-wf-action="open-tools"]')) header.insertAdjacentHTML('beforeend','<button class="small" type="button" data-wf-action="open-tools">노드 도구</button><button class="small" type="button" data-wf-action="open-results">결과·기록</button><button class="small" type="button" data-wf-action="open-stage-overlay">단계 실행</button>');
    if (host && !$('#wf-tools-dialog')) host.insertAdjacentHTML('beforeend',`<dialog id="wf-tools-dialog" class="wf-overlay" aria-labelledby="wf-tools-title"><div class="wf-overlay-header"><div><span class="eyebrow">NODE TOOLS</span><h2 id="wf-tools-title">선택한 노드 도구</h2></div><button type="button" data-wf-action="close-overlay" aria-label="노드 도구 닫기">닫기</button></div><div class="wf-inspector-tabs" role="tablist" aria-label="노드 도구 탭">${inspectorTabsHtml()}</div><div class="wf-overlay-body" id="wf-overlay-inspector" role="tabpanel" tabindex="0">${inspectorHtml()}</div></dialog><dialog id="wf-results-dialog" class="wf-overlay" aria-labelledby="wf-results-title"><div class="wf-overlay-body">${resultsDialogHtml()}</div></dialog><dialog id="wf-stage-dialog" class="wf-overlay" aria-labelledby="wf-stage-title">${stageDialogHtml()}</dialog>`);
    if (host && !$('#wf-add-node-dialog')) host.insertAdjacentHTML('beforeend', `<dialog id="wf-add-node-dialog" class="wf-overlay" aria-labelledby="wf-add-node-title">${addNodeDialogHtml()}</dialog><dialog id="wf-connect-dialog" class="wf-overlay" aria-labelledby="wf-connect-title">${connectDialogHtml()}</dialog><dialog id="wf-workflow-dialog" class="wf-overlay" aria-labelledby="wf-workflow-title"><div class="wf-overlay-header"><div><span class="eyebrow">WORKFLOW SETTINGS</span><h2 id="wf-workflow-title">워크플로 설정</h2></div><button type="button" data-wf-action="close-overlay" aria-label="워크플로 설정 닫기">닫기</button></div><div class="wf-overlay-body"><label>워크플로 이름<input id="wf-workflow-name" data-workflow-name maxlength="160" value="${escapeHtml(workflow?.name || '')}"></label><p class="hint">대본 → 스토리보드 → 렌더 → 사람의 검토가 필수입니다. 트렌드와 리서치는 선택 단계입니다.</p></div></dialog><dialog id="wf-delete-node-dialog" class="wf-overlay" aria-labelledby="wf-delete-node-title"><div class="wf-overlay-header"><div><span class="eyebrow">REMOVE NODE</span><h2 id="wf-delete-node-title">노드 삭제 확인</h2></div><button type="button" data-wf-action="close-overlay" aria-label="노드 삭제 취소">닫기</button></div><div class="wf-overlay-body"><p><strong id="wf-delete-node-name">${escapeHtml(nodeName(selectedNode()))}</strong> 노드를 삭제할까요?</p><p class="hint">연결된 선도 함께 삭제됩니다. 초안을 저장하기 전까지 변경을 되돌릴 수 있습니다.</p><div class="dialog-actions"><button type="button" data-wf-action="close-overlay">취소</button><button type="button" class="danger" data-wf-action="delete-node">노드 삭제</button></div></div></dialog>`);
    const descriptions={save:'이 그래프 초안의 모든 연결을 검증해 새 버전으로 저장합니다. 장면 저장·실행·게시와는 별개입니다.',undo:'마지막 그래프 초안 편집을 되돌립니다. 서버 기록은 변경하지 않습니다.',redo:'되돌린 그래프 초안 편집을 다시 적용합니다. 제작 실행을 시작하지 않습니다.',fit:'노드 좌표를 바꾸지 않고 전체 그래프가 보이도록 확대·이동합니다.',layout:'현재 연결 순서에 맞춰 노드 위치를 초안에서 정렬합니다. 저장 전 실행에는 반영되지 않습니다.','open-add-node':'같은 역할의 노드도 새 ID로 추가할 수 있습니다. 최대 128개 노드까지 지원합니다.','open-workflow-settings':'프로젝트 그래프 이름과 저장 전 설정을 확인합니다.','open-tools':'선택한 노드의 설정·실행 결과·변경 기록을 확인합니다.','open-results':'선택한 노드의 실행 당시 입력과 실제 출력을 확인합니다. 새 실행을 요청하지 않습니다.','open-stage-overlay':'정확한 선택 노드의 선행 조건을 확인합니다. 실행은 별도 시작 버튼과 생성 비용 승인 후에만 요청합니다.','confirm-delete-node':'확인 후 선택 노드와 해당 연결을 초안에서 제거합니다. 마지막 노드 제거·자동 재연결·자동 저장은 하지 않습니다.'};
    host?.querySelectorAll('[data-wf-action]').forEach(control=>{if(!control.dataset.tooltip && descriptions[control.dataset.wfAction])control.dataset.tooltip=descriptions[control.dataset.wfAction];});
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
    replacePanel($('#wf-overlay-result-inspector'),selectedNode()?nodeResultsHtml(selectedNode(),'wf-results-run'):'<p class="hint">캔버스에서 노드를 선택하세요.</p>');
  }

  function connectionsHtml(nodeId=null) {
    return workflow.edges.filter(edge=>!nodeId || edge.source===nodeId || edge.target===nodeId).map(edge=>{
      const source=workflow.nodes.find(node=>node.id===edge.source),target=workflow.nodes.find(node=>node.id===edge.target),label=`${nodeName(source)} [${edge.source}] → ${nodeName(target)} [${edge.target}]`;
      return `<div data-edge-id="${escapeHtml(edge.id)}"><span>${nodeId?(edge.target===nodeId?'입력 · ':'출력 · '):''}${escapeHtml(label)}</span><button class="icon-btn quiet danger" type="button" data-wf-action="delete-edge" data-id="${escapeHtml(edge.id)}" aria-label="${escapeHtml(label)} 연결 제거" data-tooltip="정확한 연결 ${escapeHtml(edge.id)}만 초안에서 제거합니다. 자동 재연결·저장하지 않으며 단절된 초안은 저장할 수 없습니다.">×</button></div>`;
    }).join('') || '<p class="hint">연결이 없습니다.</p>';
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
    const {renderNodeId}=reviewContext(run);
    const output=renderNodeId?run?.nodeRuns?.find(node=>node.nodeId===renderNodeId)?.output:null;
    const url=output?.outputUrl || output?.job?.outputUrl;
    return typeof url==='string' && /^\/api\/exports\/[a-zA-Z0-9_-]+\.mp4$/.test(url) ? {url,output} : null;
  }

  function reviewKey() {
    const run=activeRun();
    const current=getEpisodes().find(item=>item.id===run?.episodeId);
    return JSON.stringify([run?.id,run?.status,run?.reviews,reviewContext(run),current?.version,hasEpisodeChanges?.(run?.episodeId),dirty,pending]);
  }

  function reviewHtml() {
    const run=activeRun();
    const media=renderedOutput(run);
    if (!run || !media) return '';
    const current=getEpisodes().find(item=>item.id===run.episodeId);
    const version=run.episodeVersion ?? media.output.episodeVersion;
    const stale=!current || current.version!==version;
    const unsaved=hasEpisodeChanges?.(run.episodeId);
    const canReview=Boolean(reviewContext(run).reviewNodeId) && run.status==='awaiting_review' && !stale && !unsaved && !dirty && !pending;
    const {reviewNodeId}=reviewContext(run);
    const decision=reviewNodeId?run.reviews?.[reviewNodeId]:null;
    const notesKey=`${run.id}:${reviewNodeId}`;
    return `<section class="panel section-spacer wf-review-panel" data-testid="render-review"><div class="panel-header"><div><span class="eyebrow">FINAL CUT · HUMAN REVIEW</span><h2>완성 영상 검토</h2></div><span class="badge ${run.status==='approved'?'lime':''}">${escapeHtml(STATUS[run.status] || run.status)}</span></div><div class="wf-review-grid"><div class="wf-review-screen"><video controls playsinline preload="metadata" src="${escapeHtml(media.url)}" aria-label="검토할 렌더 영상" data-testid="review-video"></video><a href="${escapeHtml(media.url)}" download>검토 영상 MP4 다운로드 ↓</a></div><div class="wf-review-details"><h3>${escapeHtml(current?.title || run.episodeId)}</h3><dl class="wf-review-facts"><div><dt>렌더 에피소드 버전</dt><dd>v${escapeHtml(version)}</dd></div><div><dt>현재 저장 버전</dt><dd>${current ? `v${Number(current.version)}` : '확인할 수 없음'}</dd></div><div><dt>워크플로우 버전</dt><dd>v${Number(run.workflowVersion)}</dd></div></dl>${stale ? '<p class="wf-review-warning" role="status">렌더 이후 에피소드가 변경되었습니다. 현재 편집본으로 워크플로우를 다시 실행한 뒤 검토하세요.</p>' : ''}${unsaved ? '<p class="wf-review-warning">이 에피소드에 저장하지 않은 편집이 있습니다. 먼저 편집을 저장하고 새 렌더를 검토하세요.</p>' : ''}${decision ? `<div class="wf-review-decision"><span class="eyebrow">RECORDED DECISION</span><h3>${escapeHtml(STATUS[decision.decision] || decision.decision)} · v${Number(decision.episodeVersion)}</h3><p>${escapeHtml(decision.notes || '검토 메모 없음')}</p><span class="hint">${stamp(decision.reviewedAt)}</span><details><summary>검토 파일 식별 정보</summary><p>작업 ${escapeHtml(decision.jobId)}</p><code>SHA-256 ${escapeHtml(decision.sha256)}</code></details></div>` : `<label for="wf-review-notes">검토 메모<textarea id="wf-review-notes" data-review-notes="${escapeHtml(notesKey)}" maxlength="4000" rows="4" placeholder="자막, 음성, 장면 길이와 수정할 점을 기록하세요." ${run.status!=='awaiting_review'?'disabled':''}>${escapeHtml(reviewNotes.get(notesKey) || '')}</textarea></label><div class="wf-review-actions"><button class="primary" data-wf-action="review-approve" data-testid="review-approve" ${!canReview?'disabled':''}>이 영상 승인</button><button data-wf-action="review-changes" data-testid="review-changes" ${!canReview?'disabled':''}>수정 요청</button></div>`}<p class="hint">승인 기록은 위 렌더 파일과 에피소드 버전에 연결됩니다. 승인해도 채널에 게시되지 않습니다.</p></div></div></section>`;
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
    const run=activeRun(),{reviewNodeId,renderNodeId}=reviewContext(run),epoch=contextEpoch,targetId=workflow?.id,targetEpisodeId=episodeId;
    if(!run||!reviewNodeId||!renderNodeId||dirty||run.status!=='awaiting_review')throw new Error('초안을 저장하고 검토할 정확한 노드와 렌더 후보를 선택하세요.');
    const runId=run.id,version=run.episodeVersion,notesKey=`${runId}:${reviewNodeId}`,notes=reviewNotes.get(notesKey) || '';
    await onRunUpdated?.();
    if(epoch!==contextEpoch)throw new Error('프로젝트가 변경되었습니다.');
    const current=liveEpisode(targetEpisodeId);
    if(!current||current.version!==version||hasEpisodeChanges?.(targetEpisodeId))throw new Error('현재 버전으로 다시 렌더링하세요. 기존 초안은 보존됩니다.');
    try {
      const result=await post(`/api/workflows/${targetId}/runs/${runId}/review`,{reviewNodeId,decision,notes,expectedEpisodeVersion:version});
      if(epoch!==contextEpoch)return;
      runs=runs.map(item=>item.id===result.id?result:item);reviewNotes.delete(notesKey);toast('선택한 렌더 후보에 검토 결정을 기록했습니다.');
    }catch(error){if(epoch===contextEpoch&&error.status===409){await loadRuns();throw new Error('검토 대상이 변경되었습니다. 현재 버전과 노드를 확인하세요.');}throw error;}
  }

  function paint() {
    if (!host?.isConnected) return;
    contextMenu?.close();
    const focused=document.activeElement,focusedNodeId=focused?.closest?.('.wf-node')?.dataset.nodeId,focusedAction=focused?.dataset?.wfAction,canvasFocused=focused?.id==='workflow-canvas';
    const openDialogs=[...host.querySelectorAll('dialog[open]')].map(dialog=>dialog.id);
    const openDisclosures=[...host.querySelectorAll('details[open]')].map(details=>details.id).filter(Boolean);
    host.innerHTML=shell();
    ensureAuxiliaryUi();
    syncMutationControls();
    observeCanvas();
    openDisclosures.forEach(id=>{const details=$(`#${id}`);if(details)details.open=true;});
    if (overlayTrigger && !overlayTrigger.isConnected) { const target=openDialogs.includes('wf-tools-dialog')?'open-tools':openDialogs.includes('wf-results-dialog')?'open-results':openDialogs.includes('wf-stage-dialog')?'open-stage-overlay':null; overlayTrigger=(overlayNodeId?nodeControl(overlayNodeId):null) || (target?host.querySelector(`[data-wf-action="${target}"]`):null); }
    openDialogs.forEach(id=>{const dialog=$(`#${id}`);if(dialog && !dialog.open) try{dialog.showModal();}catch{} });
    reviewSignature=reviewKey();
    updateSummary();
    if (workflow) {
      const canvas=$('#workflow-canvas'),layout=fitWorkflowCanvas(workflow.nodes,canvas?.clientWidth || 0,canvas?.clientHeight || 0);
      if (layout) {
        const nextLayout=layout.layout || 'canvas';if(canvas.dataset.layout!==nextLayout)canvas.dataset.layout=nextLayout;
        const hint=$('#wf-connect-hint');if(hint){const nextHint=workflowCanvasHintText(layout.layout);if(hint.textContent!==nextHint)hint.textContent=nextHint;}
      }
      if (needsFit) { fit(); needsFit=false; } else transform();
      drawEdges();drawMinimap();
    }
    infoTooltips?.refresh();
    if(!openDialogs.length && !focused?.isConnected){if(focusedNodeId)(nodeControl(focusedNodeId,focusedAction) || nodeControl(selected,'select-node'))?.focus({preventScroll:true});else if(canvasFocused)$('#workflow-canvas')?.focus({preventScroll:true});}
  }

  function updateSummary() {
    const status=$('#wf-save-status');
    if (status) { status.textContent=saving?'저장 중…':dirty?'● 저장되지 않은 변경':workflow?.id?`✓ 버전 ${workflow.version} · 저장됨`:'워크플로우 없음'; status.className=dirty?'unsaved':'hint'; }
    if ($('[data-wf-action="undo"]')) $('[data-wf-action="undo"]').disabled=Boolean(mutationReason()) || !drafts.canUndo || saving || pending;
    if ($('[data-wf-action="redo"]')) $('[data-wf-action="redo"]').disabled=Boolean(mutationReason()) || !drafts.canRedo || saving || pending;
    if ($('[data-wf-action="save"]')) $('[data-wf-action="save"]').disabled=Boolean(mutationReason()) || saving || !workflow || (!dirty && Boolean(workflow.id));
    const errors=workflowErrors(workflow);
    const validation=$('#wf-validation');
    if (validation) { validation.textContent=errors.length?errors.join(' '):'✓ 실행 가능한 연결입니다. 저장 후 선택한 에피소드에서 실행하세요.'; validation.className=`wf-validation ${errors.length?'invalid':'valid'}`; }
    const badge=$('#wf-node-type');
    if (badge) badge.textContent=selectedNode()?.type?.toUpperCase() || 'SELECT';
    if ($('#wf-history')) $('#wf-history').innerHTML=historyHtml();
    syncMutationControls();
  }

  function updateExecution() {
    if (!host?.isConnected) return;
    const run=activeRun();
    host.querySelectorAll('[data-status-node]').forEach(element=>{
      const record=run?.nodeRuns?.find(node=>node.nodeId===element.dataset.statusNode);
      const nextText=STATUS[record?.status] || '실행 전';if(element.textContent!==nextText)element.textContent=nextText;
      const nextClassName=`wf-node-status ${record?.status || 'idle'}`;if(element.className!==nextClassName)element.className=nextClassName;
    });
    if ($('#wf-runs')) $('#wf-runs').innerHTML=runsHtml();
    updateOverlayUi();
    if (inspectorTab==='results' && !$('#wf-overlay-inspector')?.contains(document.activeElement)) refreshInspector();
    refreshReview();
    const runButton=$('[data-wf-action="run"]');
    if (runButton) runButton.disabled=Boolean(mutationReason()) || !workflow || pending || running() || !episodeId;
    refreshDialogConfirmation();
    drawMinimap();
    syncMutationControls();
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

  function observeCanvas() {
    if (typeof ResizeObserver!=='function') return;
    canvasObserver ||= new ResizeObserver(()=>{
      if (!autoFit || resizeRaf || !workflow?.nodes.length) return;
      resizeRaf=requestAnimationFrame(()=>{resizeRaf=0;if(autoFit)fit();});
    });
    const canvas=$('#workflow-canvas');
    if (canvas && canvas!==observedCanvas) {
      if (observedCanvas) canvasObserver.unobserve(observedCanvas);
      observedCanvas=canvas;
      canvasObserver.observe(canvas);
    }
  }

  function fit() {
    const canvas=$('#workflow-canvas');
    if (!canvas || !workflow?.nodes.length) return;
    const fitted=fitWorkflowCanvas(workflow.nodes,canvas.clientWidth,canvas.clientHeight);
    if (!fitted) return;
    const nextLayout=fitted.layout || 'canvas';if(canvas.dataset.layout!==nextLayout)canvas.dataset.layout=nextLayout;
    const hint=$('#wf-connect-hint');if(hint){const nextHint=workflowCanvasHintText(fitted.layout);if(hint.textContent!==nextHint)hint.textContent=nextHint;}
    scale=fitted.scale;
    pan=fitted.pan;
    autoFit=true;
    transform();
  }

  function zoom(factor,point) {
    const canvas=$('#workflow-canvas');
    if (!canvas) return;
    const anchor=point || {x:canvas.clientWidth/2,y:canvas.clientHeight/2};
    const previous=scale;
    scale=Math.max(0.0001,Math.min(2,scale*factor));
    pan={x:anchor.x-(anchor.x-pan.x)*scale/previous,y:anchor.y-(anchor.y-pan.y)*scale/previous};
    autoFit=false;
    transform();
  }

  function selectNode(nodeId) {
    drafts.closeGroup();
    selected=nodeId;
    host.querySelectorAll('.wf-node').forEach(element=>element.classList.toggle('selected',element.dataset.nodeId===nodeId));
    refreshInspector();
    updateSummary();
    refreshReview();
    updateOverlayUi();
    drawEdges();
    
    const jobId=activeRun()?.nodeRuns?.find(node=>node.nodeId===selected)?.output?.generationJobId;if(jobId && inspectorTab==='results')loadGenerationJob(jobId);
  }

  function connect(source,target) {
    if(mutationReason())throw new Error(mutationReason());
    if (source===target) throw new Error('노드를 자기 자신에 연결할 수 없습니다.');
    const first=workflow.nodes.find(node=>node.id===source),second=workflow.nodes.find(node=>node.id===target);
    if (!first || !second) throw new Error('연결할 두 노드를 선택하세요.');
    if(workflow.edges.length>=256)throw new Error('연결은 256개까지 사용할 수 있습니다.');
    if(graphOrder(workflow.nodes,[...workflow.edges,{source,target}]).length!==workflow.nodes.length)throw new Error('순환 연결은 실행할 수 없습니다.');
    if (workflow.edges.some(edge=>edge.source===source&&edge.target===target)) throw new Error('이미 연결된 노드입니다.');
    workflow.edges.push({id:newId(),source,target});
    connecting=null;
    changed();
    paint();
  }

  async function runSelectedStage(stageId,resumeRunId=null) {
    if (!episodeId) throw new Error('실행할 에피소드를 선택하세요.');
    const epoch=contextEpoch,targetEpisodeId=episodeId;
    await beforeRun?.(targetEpisodeId);
    if(epoch!==contextEpoch)throw new Error('프로젝트가 변경되었습니다.');
    await save();
    if(epoch!==contextEpoch)throw new Error('프로젝트가 변경되었습니다.');
    const targetId=workflow.id,expectedWorkflowVersion=Number(workflow?.version),expectedEpisodeVersion=Number(liveEpisode(targetEpisodeId)?.version);
    if (!Number.isInteger(expectedWorkflowVersion) || !Number.isInteger(expectedEpisodeVersion)) throw new Error('단계 실행 전에 에피소드와 워크플로우 버전을 확인할 수 없습니다.');
    const payload={episodeId:targetEpisodeId,expectedWorkflowVersion,expectedEpisodeVersion,selectedStages:[stageId],startStage:stageId};
    const priorRunId=resumeRunId || (TERMINAL.has(activeRun()?.status) ? activeRun()?.id : null);
    if (priorRunId) payload.resumeRunId=priorRunId;
    const stage=workflow.nodes.find(node=>node.id===stageId);
    if (!stage || stage.type==='generate') throw new Error('생성은 전체 후보 승인 대화상자에서 시작하세요.');
    const result=await post(`/api/workflows/${targetId}/run`,payload);
    if(epoch!==contextEpoch)return;
    runs.unshift(result); selectedRunId=result.id; inspectorTab='results'; paint(); schedulePoll(); toast(priorRunId?'기존 실행 출력을 재사용해 선택 단계를 시작했습니다.':'선택한 단계를 시작했습니다.');
  }

  async function action(button,name=button?.dataset.wfAction) {
    if(!button)return;
    if(mutatingActions.has(name) && mutationReason())throw new Error(mutationReason());
    if(name==='create-project-copy' && (!canMutate() || running()))throw new Error('관리자 권한이 있고 프로젝트 실행이 종료된 뒤 복사하세요.');
    if (name==='select-node' || name==='minimap-select') { selectNode(button.dataset.id); return; }
    if(name==='node-menu') {openContextMenu({nodeId:button.dataset.id,anchor:button});return;}
    if(name==='scene-editor') {
      const node=workflow?.nodes.find(item=>item.id===button.dataset.id);
      if(!node || !owns(workflow) || !onOpenSceneEditor)throw new Error('프로젝트의 정확한 노드를 선택하세요.');
      selectNode(node.id);
      const config=node.config || {};
      contextMenu?.close();host.querySelectorAll('dialog.wf-overlay[open]').forEach(dialog=>dialog.close());
      await onOpenSceneEditor({episodeId:project.episodeId,workflowId:workflow.id,nodeId:node.id,...(typeof config.sceneId==='string'&&config.sceneId?{sceneId:config.sceneId}:{}),...(typeof config.slotId==='string'&&config.slotId?{slotId:config.slotId}:{})});
      return;
    }
    if(name==='node-results' || name==='node-history') {
      if(!workflow.nodes.some(node=>node.id===button.dataset.id))return;
      selectNode(button.dataset.id);inspectorTab=name==='node-history'?'history':'results';
      host.querySelectorAll('.wf-inspector-tabs').forEach(tab=>tab.innerHTML=inspectorTabsHtml());
      refreshInspector();updateOverlayUi();rememberOverlay(button);
      const dialog=$(name==='node-history'?'#wf-tools-dialog':'#wf-results-dialog');if(dialog&&!dialog.open)dialog.showModal();return;
    }
    if(name==='canvas-history') {const section=$('#wf-run-history');if(section){section.open=true;section.scrollIntoView({block:'start'});section.querySelector('summary')?.focus({preventScroll:true});}return;}
    if (name==='node-tools') { selectNode(button.dataset.id); inspectorTab='settings';host.querySelectorAll('.wf-inspector-tabs').forEach(tab=>tab.innerHTML=inspectorTabsHtml());refreshInspector(); const dialog=$('#wf-tools-dialog'); rememberOverlay(button); if(dialog && !dialog.open)dialog.showModal(); return; }
    if (name==='open-add-node') { const dialog=$('#wf-add-node-dialog'); if(!dialog)return; rememberOverlay(button); if(!dialog.open)dialog.showModal(); return; }
    if (name==='open-workflow-settings') { const dialog=$('#wf-workflow-dialog'); if(!dialog)return; const input=dialog.querySelector('#wf-workflow-name'); if(input)input.value=workflow?.name || ''; rememberOverlay(button); if(!dialog.open)dialog.showModal(); return; }
    if (name==='confirm-delete-node') { if(mutationReason())throw new Error(mutationReason());if(workflow.nodes.length<=1)throw new Error('마지막 노드는 제거할 수 없습니다. 최소 1개가 필요합니다.');const target=button.dataset.id || selected;if(!workflow.nodes.some(node=>node.id===target))return;selectNode(target);deleteNodeId=target;const dialog=$('#wf-delete-node-dialog');if(!dialog)return;syncMutationControls();rememberOverlay(button,target);if(!dialog.open)dialog.showModal();return; }
    if (name==='history-page') { const page=Number(button.dataset.page); if(Number.isSafeInteger(page) && page>0)await loadRunHistory({page}); return; }
    if (name==='refresh-run-history') { runHistoryQuery=''; const input=$('[data-run-history-search] input[name="q"]'); if(input)input.value=''; await loadRunHistory({page:1,query:''}); return; }
    if (name==='refresh-run-detail') { const record=[...host.querySelectorAll('.wf-history-record')].find(item=>item.dataset.runId===button.dataset.id); if(record){delete record.dataset.detailLoaded;await loadRunHistoryDetail(record);} return; }
    if (name==='open-tools' || name==='open-results' || name==='open-stage-overlay') {
      const id=name==='open-tools'?'wf-tools-dialog':name==='open-results'?'wf-results-dialog':'wf-stage-dialog';
      const dialog=$(`#${id}`); if (!dialog) return; rememberOverlay(button); if (name==='open-results') inspectorTab='results'; refreshInspector(); updateOverlayUi(); if (!dialog.open) dialog.showModal(); return;
    }
    if (name==='close-overlay') { button.closest('dialog')?.close(); return; }
    if (name==='inspector-tab') { inspectorTab=button.dataset.tab; drafts.closeGroup(); host.querySelectorAll('.wf-inspector-tabs').forEach(tab=>tab.innerHTML=inspectorTabsHtml()); refreshInspector();  return; }
    if (name==='undo' || name==='redo') { undoDraft(name==='redo'); return; }
    if (name==='history-version') {compareVersion=Number(button.dataset.version);if($('#wf-history'))$('#wf-history').innerHTML=historyHtml();if(inspectorTab==='history')refreshInspector();return;}
    if (name==='inspect-run-node') {selectedRunId=button.dataset.run;inspectorTab='results';selectNode(button.dataset.id);if($('.wf-inspector-tabs'))$('.wf-inspector-tabs').innerHTML=inspectorTabsHtml();updateExecution();rememberOverlay(button);const dialog=$('#wf-results-dialog');if(dialog&&!dialog.open)dialog.showModal();return;}
    if (name==='close-dialog') {$('#wf-confirm-dialog')?.close();restoreVersion=null;generationConsent=false;generationStageRun=false;generationResumeRunId=null;generationConsentSnapshot=null;generationTargetEpisode=null;generationEstimate=null;generationEstimateKey='';generationEstimateError='';generationEstimateAcknowledged=false;return;}
    if (name==='estimate-ack') {generationEstimateAcknowledged=Boolean(button.checked);refreshDialogConfirmation();return;}
    if (name==='output' || name==='input' || name==='connections') {
      const nodeId=button.dataset.id || selected;
      if(!workflow.nodes.some(node=>node.id===nodeId))return;
      selectNode(nodeId);connectionNodeId=nodeId;connecting=name==='output'?nodeId:null;
      const dialog=$('#wf-connect-dialog');if(!dialog)return;
      dialog.innerHTML=connectDialogHtml();
      const source=$('#wf-connect-source'),target=$('#wf-connect-target');
      if(source)source.value=name==='output'?nodeId:'';
      if(target)target.value=name==='input'?nodeId:'';
      rememberOverlay(button,nodeId);syncMutationControls();if(!dialog.open)dialog.showModal();return;
    }
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
        if(info.node.type==='generate') {
          assertGenerationInput(generationInput(info.node));generationConsent=true;generationStageRun=true;generationResumeRunId=resumeId;invalidateGenerationEstimate();generationConsentSnapshot=null;paint();$('#wf-confirm-dialog')?.showModal();return;
        }
        await runSelectedStage(info.node.id,resumeId); return;
      }
      if(name==='create-project-copy') {
        if(!project?.episodeId||!project?.channelId||!workflow?.id||workflow.episodeId||workflow.channelId)throw new Error('공용 템플릿과 프로젝트를 선택하세요.');
        const epoch=contextEpoch,templateId=workflow.id,body={...project,expectedTemplateVersion:workflow.version};
        const result=await post(`/api/workflows/${templateId}/copies`,body);
        workflows.unshift(copy(result));
        if(epoch!==contextEpoch)return;
        stashGraph();selectGraph(result);projectSelections.set(projectKey(),result.id);await Promise.all([loadRuns(),loadVersions()]);paint();toast('독립된 프로젝트용 워크플로우 복사본을 만들었습니다.');
      }
      else if (name==='save') { await save(); paint(); toast('워크플로우를 저장했습니다.'); }
      else if(name==='new'||name==='preset-full-pipeline') {
        const graph=name==='new'?initialGraph():fullPipelineGraph(models[0]?.id || DEFAULT_GENERATION_MODEL);
        if(project) {
          if(!owns(workflow))throw new Error('프로젝트용 복사본을 먼저 만드세요.');
          workflow={...workflow,...graph};
        } else {stashGraph();selectGraph(graph);}
        selected=workflow.nodes[0].id;connecting=null;needsFit=true;changed('recipe');paint();
      }
      else if (name==='reload') { await load(true); paint(); }
      else if (name==='discard') { workflow=copy(saved || null);graphStashes.delete(stashKey()); selected=workflow?.nodes[0]?.id || null; dirty=false; connecting=null; needsFit=true; revision++;resetDrafts(); await Promise.all([loadRuns(),loadVersions()]); paint(); }
      else if (name==='add-node') { const type=$('#wf-add-type')?.value,label=$('#wf-add-label')?.value || '',config=type==='generate'?generationConfig(0):defaultNodeConfig(type, models[0]?.id || DEFAULT_GENERATION_MODEL);$('#wf-add-node-dialog')?.close();const id=newId();workflow=addWorkflowNode(workflow,type,{id,x:Math.max(30,Math.round((100-pan.x)/scale)),y:Math.max(30,Math.round((120-pan.y)/scale)),label,config,afterNodeId:selected});selected=id;inspectorTab='settings';changed();paint();const dialog=$('#wf-tools-dialog'),trigger=host.querySelector('[data-wf-action="open-tools"]');if(dialog){overlayTrigger=trigger;if(!dialog.open)dialog.showModal();} }
      else if (name==='delete-node') {
        const target=deleteNodeId;
        if(!target || !workflow.nodes.some(node=>node.id===target))throw new Error('제거할 노드를 다시 선택하세요.');
        if(workflow.nodes.length<=1)throw new Error('마지막 노드는 제거할 수 없습니다. 최소 1개가 필요합니다.');
        $('#wf-delete-node-dialog')?.close();
        const index=workflow.nodes.findIndex(node=>node.id===target);
        workflow.nodes=workflow.nodes.filter(node=>node.id!==target);workflow.edges=workflow.edges.filter(edge=>edge.source!==target&&edge.target!==target);
        selected=workflow.nodes[Math.min(index,workflow.nodes.length-1)].id;deleteNodeId=null;connecting=null;overlayNodeId=selected;changed();paint();
        const dialog=$('dialog[open]');if(dialog)(dialog.querySelector('input,button') || dialog).focus({preventScroll:true});else focusNode(selected);
        toast('노드와 해당 연결을 초안에서 제거했습니다. 자동 재연결·저장하지 않았습니다. 연결 검증 후 그래프를 저장하세요.');
      }
      else if (name==='delete-edge') {
        if(!workflow.edges.some(edge=>edge.id===button.dataset.id))throw new Error('제거할 연결을 찾을 수 없습니다.');
        workflow.edges=workflow.edges.filter(edge=>edge.id!==button.dataset.id);changed();paint();
        const dialog=$('#wf-connect-dialog[open]');if(dialog)(dialog.querySelector('[data-wf-action="delete-edge"]') || dialog.querySelector('[data-wf-action="close-overlay"]'))?.focus({preventScroll:true});else focusNode(selected);
        toast('선택한 연결만 초안에서 제거했습니다. 단절된 흐름은 다시 연결해야 저장할 수 있습니다.');
      }
      else if (name==='layout') { const ids=graphOrder(workflow.nodes,workflow.edges),ordered=ids.map(id=>workflow.nodes.find(node=>node.id===id)); ordered.forEach((node,index)=>{node.x=50+index%3*285;node.y=65+Math.floor(index/3)*230;}); changed(); needsFit=true; paint(); }
      else if(name==='quote-generation') {await loadGenerationEstimate();}
      else if(name==='prepare-generation-source') {
        const epoch=contextEpoch,targetEpisodeId=episodeId;
        await beforeRun?.(targetEpisodeId);if(epoch!==contextEpoch)throw new Error('프로젝트 또는 워크플로우가 변경되었습니다.');
        await save();if(epoch!==contextEpoch)throw new Error('프로젝트 또는 워크플로우가 변경되었습니다.');
        const targetId=workflow.id,selectedStages=workflow.nodes.filter(node=>generationSelection().includes(node.id)&&!['generate','render','review','publish'].includes(node.type)).map(node=>node.id);
        if(!selectedStages.length)throw new Error('준비할 소스 노드가 없습니다.');
        const result=await post(`/api/workflows/${targetId}/run`,{episodeId:targetEpisodeId,selectedStages,expectedWorkflowVersion:workflow.version,expectedEpisodeVersion:liveEpisode(targetEpisodeId)?.version});
        if(epoch!==contextEpoch)return;
        runs.unshift(result);selectedRunId=result.id;generationResumeRunId=result.id;invalidateGenerationEstimate();generationConsent=false;generationConsentSnapshot=null;inspectorTab='results';paint();schedulePoll();toast('소스와 대본 준비를 시작했습니다. 완료 결과를 확인하고 새 견적을 요청하세요.');
      }
      else if(name==='run'||name==='confirm-generation-run') {
        if(!episodeId)throw new Error('실행할 에피소드를 선택하세요.');
        if(name==='run'&&workflow.nodes.some(node=>node.type==='generate')) {
          generationConsent=true;generationStageRun=false;restoreVersion=null;generationConsentSnapshot=null;invalidateGenerationEstimate();
          const prior=activeRun();generationResumeRunId=prior?.workflowVersion===workflow.version&&TERMINAL.has(prior.status)?prior.id:null;
          paint();$('#wf-confirm-dialog')?.showModal();return;
        }
        if(name==='confirm-generation-run') {
          const snapshot=generationConsentSnapshot,plan=generationEstimate;
          if(!snapshot||!plan?.id||snapshot.key!==generationInputKey()||generationEstimateKey!==snapshot.key||Date.parse(plan.expiresAt)<=Date.now())throw new Error('후보·입력·버전·공개 결정이 바뀌었거나 견적이 만료되었습니다. 새 견적을 확인하세요.');
          if(!plan.aggregate?.quoted&&!generationEstimateAcknowledged)throw new Error('모든 미확인 견적에 대한 비용 동의가 필요합니다.');
          if(dirty||hasEpisodeChanges?.(snapshot.episodeId))throw new Error('견적 후 편집이 바뀌었습니다. 저장하고 새 견적을 확인하세요.');
          const epoch=contextEpoch,targetId=snapshot.workflowId,targetEpisodeId=snapshot.episodeId;
          const payload={episodeId:targetEpisodeId,...copy(snapshot.options),allowGeneration:true,generationPlanId:plan.id,generationFingerprint:plan.fingerprint,acceptUnquotedEstimate:generationEstimateAcknowledged};
          $('#wf-confirm-dialog')?.close();generationConsent=false;generationConsentSnapshot=null;generationStageRun=false;generationResumeRunId=null;invalidateGenerationEstimate();
          const result=await post(`/api/workflows/${targetId}/run`,payload);
          if(epoch!==contextEpoch)return;
          runs.unshift(result);selectedRunId=result.id;inspectorTab='results';paint();schedulePoll();toast('승인한 전체 후보의 생성을 시작했습니다.');return;
        }
        const epoch=contextEpoch,targetEpisodeId=episodeId;
        await beforeRun?.(targetEpisodeId);if(epoch!==contextEpoch)throw new Error('프로젝트 또는 워크플로우가 변경되었습니다.');
        await save();if(epoch!==contextEpoch)throw new Error('프로젝트 또는 워크플로우가 변경되었습니다.');
        const targetId=workflow.id,result=await post(`/api/workflows/${targetId}/run`,{episodeId:targetEpisodeId,selectedStages:workflow.nodes.filter(node=>node.type!=='publish').map(node=>node.id),expectedWorkflowVersion:workflow.version,expectedEpisodeVersion:liveEpisode(targetEpisodeId)?.version});
        if(epoch!==contextEpoch)return;
        runs.unshift(result);selectedRunId=result.id;inspectorTab='results';paint();schedulePoll();toast('제작을 시작했습니다. 결과를 확인하세요.');
      }
      else if (name==='refresh-history') {await loadVersions();updateSummary();if(inspectorTab==='history')refreshInspector();}
      else if (name==='restore-workflow') {if(dirty || saving)throw new Error('현재 초안을 먼저 저장해 주세요.');restoreVersion=selectedVersion()?.version;generationConsent=false;paint();$('#wf-confirm-dialog')?.showModal();}
      else if (name==='confirm-restore') {
        if(dirty || saving || !restoreVersion)throw new Error('현재 초안을 저장하고 복원 버전을 다시 선택해 주세요.');
        const epoch=contextEpoch,startRevision=revision,target=workflow.id,result=await post(`/api/workflows/${target}/restore`,{version:restoreVersion,expectedVersion:workflow.version});
        if(epoch!==contextEpoch || revision!==startRevision || workflow?.id!==target)throw new Error('복원은 저장됐으며 로컬 편집은 보존했습니다. 최신 기록과 비교해 주세요.');
        workflow=copy(result);saved=copy(result);workflows=workflows.map(item=>item.id===result.id?copy(result):item);dirty=false;restoreVersion=null;selected=workflow.nodes.some(node=>node.id===selected)?selected:workflow.nodes[0]?.id;revision++;resetDrafts();await loadVersions();paint();toast(`새 버전 v${result.version}으로 복원했습니다. 이전 기록은 보존됩니다.`);
      }
      else if (name==='restore-node') {if(dirty || saving)throw new Error('현재 초안을 먼저 저장해 주세요.');const previous=selectedVersion()?.snapshot?.nodes.find(node=>node.id===selected);if(!previous)throw new Error('선택 버전에 이 노드가 없습니다.');const node=selectedNode();node.config=copy(previous.config);for(const key of ['label','notes']){if(previous[key]!==undefined)node[key]=previous[key];else delete node[key];}changed();inspectorTab='settings';paint();toast('선택한 노드의 설정을 초안에 불러왔습니다. 저장하면 새 버전이 됩니다.');}
      else if (name==='refresh-generation') {await loadGeneration();}
      else if (name==='refresh-generation-job') {await loadGenerationJob(button.dataset.id);}
      else if (name==='recover-generation-job') {await post(`/api/generations/${encodeURIComponent(button.dataset.id)}/recover`);await loadGenerationJob(button.dataset.id);toast('기존 생성 요청의 상태를 다시 확인합니다. 새 생성 요청은 보내지 않았습니다.');}
      else if (name==='apply-generation-job') {
        const epoch=contextEpoch,job=copy(generationJobs.get(button.dataset.id));
        if(!job || job.status!=='completed' || job.applied)throw new Error('적용 가능한 완료 결과를 먼저 확인해 주세요.');
        if(hasEpisodeChanges?.(job.episodeId))throw new Error('에피소드 편집을 먼저 저장해 주세요. 현재 초안은 보존됩니다.');
        await onRunUpdated?.();
        if(epoch!==contextEpoch)throw new Error('프로젝트가 변경되었습니다. 선택한 프로젝트에서 다시 적용하세요.');
        const current=getEpisodes().find(item=>item.id===job.episodeId);
        if(!current || hasEpisodeChanges?.(job.episodeId))throw new Error('에피소드가 변경되었습니다. 현재 편집을 저장하고 다시 확인해 주세요.');
        await post(`/api/generations/${encodeURIComponent(job.id)}/apply`,{expectedVersion:current.version,sceneId:job.sceneId});if(epoch!==contextEpoch)return;await onRunUpdated?.();if(epoch!==contextEpoch)return;await loadGenerationJob(job.id);toast('기존 생성 결과를 장면의 새 버전으로 적용했습니다. 새 생성 비용은 발생하지 않습니다.');
      }
      else if (name==='refresh-runs') { await loadRuns(); updateExecution(); }
      else if (name==='cancel-run') { await post(`/api/workflows/${workflow.id}/runs/${button.dataset.id}/cancel`); await loadRuns(); updateExecution(); toast('실행 취소를 요청했습니다.'); }
      else if (name==='review-approve' || name==='review-changes') { await recordReview(name==='review-approve'?'approved':'changes_requested'); }
    } finally { pending=false; button.disabled=false; updateSummary();updateExecution(); }
  }

  function liveEpisode(targetId) {
    return getEpisode?.(targetId) || getEpisodes().find(item => item.id === targetId);
  }

  async function openGeneration({episode:targetEpisodeSnapshot,episodeId:targetEpisodeId,sceneIndex:targetSceneIndex,sceneId:targetSceneId,slotId:targetSlotId,prompt:targetPrompt}={}) {
    const targetId=targetEpisodeId || targetEpisodeSnapshot?.id || episodeId;
    const targetEpisode=targetEpisodeSnapshot?.id===targetId?targetEpisodeSnapshot:liveEpisode(targetId);
    if(!targetEpisode)throw new Error('먼저 에피소드를 선택하세요.');
    bindProject({episodeId:targetEpisode.id,channelId:targetEpisode.channelId});
    await load();
    if(episodeId!==targetId)throw new Error('프로젝트 또는 워크플로우가 변경되었습니다.');
    if(!owns(workflow))throw new Error('프로젝트용 워크플로우 복사본을 먼저 만드세요.');
    if(mutationReason())throw new Error(mutationReason());
    const scenes=targetEpisode.scenes || [],scene=targetSceneId?scenes.find(item=>item.id===targetSceneId):scenes[Number(targetSceneIndex ?? 0)];
    if(!scene)throw new Error('선택한 노드 또는 대상을 찾을 수 없습니다.');
    if(targetSlotId&&!scene.slots?.some(slot=>slot.id===targetSlotId))throw new Error('선택한 노드 또는 대상을 찾을 수 없습니다.');
    const index=scenes.indexOf(scene),matches=workflow.nodes.filter(node=>node.type==='generate'&&(node.config?.sceneId?node.config.sceneId===scene.id:Number(node.config?.sceneIndex ?? 0)===index)&&(node.config?.slotId || null)===(targetSlotId || null));
    let node=selectedNode()?.type==='generate'&&matches.some(item=>item.id===selected)?selectedNode():matches.length===1?matches[0]:null;
    if(matches.length>1&&!node)throw new Error('이 장면에 생성 노드가 여러 개입니다. 캔버스에서 정확한 노드를 선택하세요.');
    if(!node) {
      const storyboards=workflow.nodes.filter(item=>item.type==='storyboard');
      const anchor=selectedNode()?.type==='storyboard'?selectedNode():storyboards.length===1?storyboards[0]:null;
      if(!anchor)throw new Error('생성 입력의 스토리보드 노드를 정확히 선택하세요.');
      const id=newId();workflow=addWorkflowNode(workflow,'generate',{id,afterNodeId:anchor.id,x:anchor.x+270,y:anchor.y,config:{...generationConfig(index),sceneId:scene.id,...(targetSlotId?{slotId:targetSlotId,targetMode:'slot'}:{})}});
      node=workflow.nodes.find(item=>item.id===id);
    }
    node.config.sceneId=scene.id;node.config.sceneIndex=index;
    if(targetPrompt!==undefined)node.config.prompt=targetPrompt;
    selected=node.id;inspectorTab='settings';generationTargetEpisode=targetEpisode;generationTargetSceneId=scene.id;
    changed('generation:target');paint();return copy(workflow);
  }

  function mount() {
    host=document.querySelector('#workflow-host');
    if (!host || host.dataset.wfMounted==='true') return;
    host.dataset.wfMounted='true';
    mountController=new AbortController();
    const listen=(type,listener,options={})=>host.addEventListener(type,listener,{...(typeof options==='boolean'?{capture:options}:options),signal:mountController.signal});
    paint();
    contextMenu=createContextMenu({onAction:(id,context)=>contextAction(id,context).catch(error=>toast(error.status===409?'워크플로우가 다른 작업에서 변경됐습니다. 현재 초안을 보존했습니다.':error.message,true))});
    infoTooltips=document.body.dataset.workbench==='project'?null:installInfoTooltips(host);
    
    listen('contextmenu',event=>{
      const canvas=event.target.closest('#workflow-canvas');if(!canvas || event.target.closest('input,textarea,select,[contenteditable="true"]'))return;
      const node=event.target.closest('.wf-node');event.preventDefault();
      openContextMenu({nodeId:node?.dataset.nodeId || null,anchor:node?nodeControl(node.dataset.nodeId):canvas,x:event.clientX,y:event.clientY});
    });
    listen('click',event=>{const link=event.target.closest('[data-wf-section]');if(link){event.preventDefault();const section=$(link.getAttribute('href'));if(section){if(section.tagName==='DETAILS')section.open=true;section.scrollIntoView({block:'start'});(section.tagName==='DETAILS'?section.querySelector('summary'):section)?.focus({preventScroll:true});}return;}const button=event.target.closest('[data-wf-action]');if(button) action(button).catch(error=>toast(error.status===409?'워크플로우가 다른 작업에서 변경됐습니다. 현재 편집을 보존했습니다. 새 이름으로 복사하거나 변경을 되돌린 뒤 새로고침하세요.':error.message,true));});
    listen('close',event=>{if(!event.target.matches('dialog.wf-overlay') || event.target.open)return;if(event.target.id==='wf-delete-node-dialog')deleteNodeId=null;restoreOverlayFocus(event.target);},true);
    listen('toggle',event=>{const target=event.target;if(target?.id==='wf-run-history' && target.open && !runHistoryLoaded && !runHistoryLoading)loadRunHistory();else if(target?.matches?.('.wf-history-record') && target.open)loadRunHistoryDetail(target);},true);
    listen('input',event=>{
      const target=event.target;
      if(target.id==='wf-disclosure-rationale'){disclosure.rationale=target.value;invalidateGenerationEstimate();return;}
      if(target.id==='wf-disclosure')return;
      if(mutationReason())return;
      if (target.dataset.reviewNotes) { reviewNotes.set(target.dataset.reviewNotes,target.value); return; }
      if (target.id==='wf-name') {workflow.name=target.value;changed('name');}
      else if (target.hasAttribute('data-workflow-name') && workflow) {workflow.name=target.value;changed('name');}
      else if (target.dataset.wfField && selectedNode()) {const key=target.dataset.wfField;if(target.value)selectedNode()[key]=target.value;else delete selectedNode()[key];changed(`${selected}:${key}`);const label=host.querySelector(`[data-node-id="${selected}"] .wf-node-label`);if(label)label.textContent=nodeName(selectedNode());}
      else if (target.dataset.wfConfig && selectedNode()) {
        const key=target.dataset.wfConfig,node=selectedNode();node.config ||= {};
        if (target.type==='number' && target.value!=='' && !target.checkValidity()) return;
        if (target.type==='checkbox') node.config[key]=target.checked;
        else if ((key==='limit' || key==='slotId') && target.value==='') delete node.config[key];
        else if (key==='sceneIndex') {if(target.value==='')return;node.config.sceneIndex=Number(target.value)-1;const targetEpisode=liveEpisode(episodeId) || generationTargetEpisode;node.config.sceneId=targetEpisode?.scenes?.[node.config.sceneIndex]?.id || '';generationTargetSceneId=node.config.sceneId || null;}
        else node.config[key]=target.type==='number'?Number(target.value):target.value;
        if(key==='model')node.config.params={};
        if (node.type==='generate' && ['model','sceneIndex','slotId','prompt'].includes(key)) invalidateGenerationEstimate();
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
    listen('focusout',()=>drafts.closeGroup());
    listen('change',async event=>{
      if(event.target.id==='wf-disclosure') {
        disclosure.containsSyntheticMedia=event.target.value===''?null:event.target.value==='true';invalidateGenerationEstimate();return;
      }
      if(event.target.id==='wf-episode'&&!project) {episodeId=event.target.value || null;generationTargetEpisode=null;generationTargetSceneId=null;generationConsent=false;generationConsentSnapshot=null;invalidateGenerationEstimate();}
      if(event.target.id==='wf-select') {
        const choice=event.target.value;if(!choice)return;
        try {
          const next=workflows.find(item=>item.id===choice);
          if(!next||(project&&next.episodeId&&!owns(next)))throw new Error('다른 프로젝트의 그래프는 선택할 수 없습니다.');
          stashGraph();selectGraph(next);projectSelections.set(projectKey(),next.id);
          await Promise.all([loadRuns(),loadVersions()]);paint();
        }catch(error){toast(error.message,true);}
      }
      if (['wf-inspector-run','wf-results-run'].includes(event.target.id)) {selectedRunId=event.target.value;refreshInspector();const jobId=activeRun()?.nodeRuns?.find(node=>node.nodeId===selected)?.output?.generationJobId;if(jobId)loadGenerationJob(jobId);}
      if (event.target.id==='wf-node-history-version') {compareVersion=Number(event.target.value);refreshInspector();if($('#wf-history'))$('#wf-history').innerHTML=historyHtml();}
      
      updateExecution();
    });
    listen('submit',event=>{
      if (event.target.matches('[data-run-history-search]')) {
        event.preventDefault();
        const query=String(new FormData(event.target).get('q') || '').trim();
        loadRunHistory({page:1,query});
        return;
      }
      if (!['wf-connect-form','wf-connect-dialog-form'].includes(event.target.id)) return;
      event.preventDefault();
      const form=new FormData(event.target);
      try { connect(String(form.get('source') || ''),String(form.get('target') || ''));$('#wf-connect-dialog')?.close(); }
      catch(error) { toast(error.message,true); }
    });
    listen('wheel',event=>{const canvas=event.target.closest('#workflow-canvas');if(!canvas||canvas.dataset.layout==='stacked')return;event.preventDefault();const rect=canvas.getBoundingClientRect();zoom(Math.exp(-event.deltaY*0.0015),{x:event.clientX-rect.left,y:event.clientY-rect.top});},{passive:false});
    listen('pointerdown',event=>{
      const canvas=event.target.closest('#workflow-canvas');
      if (!canvas || event.button!==0 || event.target.closest('.wf-port,.wf-node-menu,.wf-zoom,select,input')) return;
      const header=event.target.closest('.wf-node-header');
      if(header&&(mutationReason() || saving || pending)){selectNode(header.dataset.id);return;}
      if (header && canvas.dataset.layout==='stacked') return;
      if (header) {selectNode(header.dataset.id);const node=selectedNode();drag={type:'node',id:node.id,x:event.clientX,y:event.clientY,nodeX:node.x,nodeY:node.y,moved:false};}
      else if (!event.target.closest('.wf-node')) drag={type:'pan',x:event.clientX,y:event.clientY,panX:pan.x,panY:pan.y};
      else return;
      host.setPointerCapture(event.pointerId);
      canvas.classList.add('dragging');
    });
    listen('pointermove',event=>{
      if (!drag) return;
      if (drag.type==='pan') {autoFit=false;pan={x:drag.panX+event.clientX-drag.x,y:drag.panY+event.clientY-drag.y};transform();}
      else {if(mutationReason() || saving || pending)return;const node=workflow.nodes.find(item=>item.id===drag.id);if(!node)return;node.x=Math.max(0,Math.min(10000,drag.nodeX+(event.clientX-drag.x)/scale));node.y=Math.max(0,Math.min(10000,drag.nodeY+(event.clientY-drag.y)/scale));drag.moved=true;updateNodePosition(node);}
    });
    const finishDrag=()=>{if(drag?.type==='node'&&drag.moved){const node=workflow.nodes.find(item=>item.id===drag.id);if(node){if(mutationReason() || saving || pending){node.x=drag.nodeX;node.y=drag.nodeY;updateNodePosition(node);}else{node.x=Math.round(node.x/10)*10;node.y=Math.round(node.y/10)*10;updateNodePosition(node);changed();}}}drag=null;$('#workflow-canvas')?.classList.remove('dragging');};
    listen('pointerup',finishDrag);
    listen('pointercancel',finishDrag);
    listen('keydown',event=>{
      if(event.key==='ContextMenu' || (event.shiftKey&&event.key==='F10')) {
        const node=event.target.closest('.wf-node'),canvas=event.target.closest('#workflow-canvas');
        if(canvas){event.preventDefault();openContextMenu({nodeId:node?.dataset.nodeId || null,anchor:node?nodeControl(node.dataset.nodeId):canvas});return;}
      }
      const minimap=event.target.closest('#wf-minimap');
      if (minimap && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) { event.preventDefault(); const delta=event.key==='ArrowLeft'?50:event.key==='ArrowRight'?-50:0; const vertical=event.key==='ArrowUp'?50:event.key==='ArrowDown'?-50:0; autoFit=false;pan={x:pan.x+delta,y:pan.y+vertical}; transform(); return; }
      if (minimap && ['Enter',' '].includes(event.key)) { event.preventDefault(); const current=minimap.querySelector('.wf-minimap-node.selected') || minimap.querySelector('.wf-minimap-node'); if (current) selectNode(current.dataset.id); return; }
      if (!mutationReason() && (event.ctrlKey || event.metaKey) && !event.target.closest('input,textarea,select,[contenteditable="true"]') && ['z','y'].includes(event.key.toLowerCase())) {event.preventDefault();undoDraft(event.shiftKey || event.key.toLowerCase()==='y');return;}
      if (event.key==='Escape') {connecting=null;if($('#wf-connect-hint'))$('#wf-connect-hint').textContent='연결 선택 취소됨 · 출력 → 입력으로 다시 연결하세요.';}
      const header=event.target.closest('.wf-node-header');
      if (!mutationReason() && !saving && !pending && header && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {event.preventDefault();const node=workflow.nodes.find(item=>item.id===header.dataset.id);node.x=Math.max(0,Math.min(10000,node.x+(event.key==='ArrowLeft'?-10:event.key==='ArrowRight'?10:0)));node.y=Math.max(0,Math.min(10000,node.y+(event.key==='ArrowUp'?-10:event.key==='ArrowDown'?10:0)));updateNodePosition(node);changed();}
    });
    if(workflow?.id && (!project || owns(workflow))) {
      const mountedHost=host,epoch=pollEpoch,context=contextEpoch,targetId=workflow.id,targetEpisodeId=episodeId;
      const current=()=>host===mountedHost && mountedHost.isConnected && epoch===pollEpoch && context===contextEpoch && workflow?.id===targetId && episodeId===targetEpisodeId;
      loadRuns().then(()=>{if(current()){updateExecution();updateSummary();}}).catch(error=>{if(current())toast(`실행 기록을 불러오지 못했습니다: ${error.message}`,true);});
    }
  }

  function updateNodePosition(node) {
    const element=host?.querySelector(`[data-node-id="${node.id}"]`);
    if (element) {element.style.left=`${node.x}px`;element.style.top=`${node.y}px`;}
    if (selected===node.id) {if($('#wf-node-x'))$('#wf-node-x').value=Math.round(node.x);if($('#wf-node-y'))$('#wf-node-y').value=Math.round(node.y);}
    drawEdges();
  }

  function destroy() {
    stashGraph();generationLoad++;
    pollEpoch++;
    clearTimeout(timer); timer=null;
    clearTimeout(generationTimer); generationTimer=null;
    if (minimapRaf) cancelAnimationFrame(minimapRaf); minimapRaf=0;
    if (resizeRaf) cancelAnimationFrame(resizeRaf); resizeRaf=0;
    canvasObserver?.disconnect();canvasObserver=null;observedCanvas=null;
    contextMenu?.destroy();contextMenu=null;infoTooltips?.destroy();infoTooltips=null;
    mountController?.abort(); mountController=null;
    if (host) { host.dataset.wfMounted=''; host.innerHTML=''; }
    host=null;overlayTrigger=null;overlayNodeId=null;connectionNodeId=null;deleteNodeId=null;drag=null;
  }
  return {load,mount,destroy,save,openGeneration,bindProject,getContext,getActivity,hasChanges:()=>dirty,hasAnyChanges:()=>dirty || [...graphStashes.entries()].some(([key,value])=>key!==stashKey()&&value.dirty),html:()=>'<div id="workflow-host"></div>'};
}
