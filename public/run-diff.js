// Pure, bounded summarization of workflow node outputs: no DOM, no project imports.
// Keeps history/results rendering from repeating full fact tables for every run.
const MAX_KEYS = 8;
const MAX_STRING = 80;
const MAX_CHANGES = 6;

const LABELS = {
  trend: { keywordCount: '키워드 수', topKeywords: '주요 키워드' },
  news: { articleCount: '기사 수', topTitles: '주요 기사' },
  research: { referenceCount: '참고 자료 수' },
  script: { sceneCount: '장면 수', title: '첫 장면 제목', agent: '에이전트' },
  storyboard: { sceneCount: '장면 수' },
  layout: { preset: '레이아웃 프리셋', slotCount: '슬롯 수', sceneCount: '장면 수' },
  generate: { model: '생성 모델', outputCount: '결과 수', jobId: '작업 ID' },
  render: { sha256: '파일 해시', bytes: '파일 크기' },
  review: { decision: '검토 결정' },
  publish: { status: '게시 상태', hasUrl: '게시 URL' },
};

const TRIGGER_LABEL = { trend: '트렌드 수집', news: '뉴스 수집', research: '리서치', script: '대본 작성', storyboard: '스토리보드', layout: '레이아웃', generate: '생성', render: '렌더링', review: '검토', publish: '게시' };
const RUN_STATUS_LABEL = { queued: '대기', pending: '대기', running: '실행 중', completed: '완료', failed: '실패', cancelled: '취소됨', awaiting_review: '검토 대기', approved: '승인됨', changes_requested: '수정 요청' };

const labelFor = (type, key) => LABELS[type]?.[key] || key;
const isPrimitive = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const truncate = (value, max = MAX_STRING) => (typeof value === 'string' && value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value);

export function digestNodeOutput(type, output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return {};
  const digest = {};
  const set = (key, value, max = MAX_STRING) => { if (value !== undefined) digest[key] = truncate(value, max); };
  if (type === 'trend') {
    if (Array.isArray(output.trends)) {
      set('keywordCount', output.trends.length);
      set('topKeywords', output.trends.slice(0, 3).map((item) => item?.keyword).join(', '));
    }
  } else if (type === 'news') {
    if (Array.isArray(output.articles)) {
      set('articleCount', output.articles.length);
      set('topTitles', output.articles.slice(0, 3).map((item) => item?.headline).join(', '));
    }
  } else if (type === 'research') {
    if (Array.isArray(output.references)) set('referenceCount', output.references.length);
  } else if (type === 'script') {
    if (Array.isArray(output.scenes)) {
      set('sceneCount', output.scenes.length);
      set('title', output.scenes[0]?.title);
    }
    set('agent', output.agent);
  } else if (type === 'storyboard') {
    if (Array.isArray(output.scenes)) set('sceneCount', output.scenes.length);
  } else if (type === 'layout') {
    set('preset', output.preset);
    set('slotCount', output.slotCount);
    set('sceneCount', output.sceneCount);
  } else if (type === 'generate') {
    set('model', output.model);
    if (Array.isArray(output.outputs)) set('outputCount', output.outputs.length);
    set('jobId', output.generationJobId, 8);
  } else if (type === 'render') {
    set('sha256', output.sha256, 12);
    set('bytes', output.size ?? output.bytes);
  } else if (type === 'review') {
    set('decision', output.decision);
  } else if (type === 'publish') {
    set('status', output.status);
    set('hasUrl', Boolean(output.exportUrl || output.url));
  } else {
    for (const key of Object.keys(output)) {
      if (Object.keys(digest).length >= MAX_KEYS) break;
      const value = output[key];
      if (isPrimitive(value)) digest[key] = truncate(value);
    }
  }
  return digest;
}

export function diffNodeOutputs(type, before, after) {
  const beforeMissing = before === null || before === undefined;
  const afterMissing = after === null || after === undefined;
  if (beforeMissing && afterMissing) return { state: 'same', changes: [] };
  if (beforeMissing) {
    const digest = digestNodeOutput(type, after);
    return { state: 'added', changes: Object.entries(digest).slice(0, MAX_CHANGES).map(([key, value]) => ({ label: labelFor(type, key), before: undefined, after: value })) };
  }
  if (afterMissing) {
    const digest = digestNodeOutput(type, before);
    return { state: 'removed', changes: Object.entries(digest).slice(0, MAX_CHANGES).map(([key, value]) => ({ label: labelFor(type, key), before: value, after: undefined })) };
  }
  const digestBefore = digestNodeOutput(type, before);
  const digestAfter = digestNodeOutput(type, after);
  const keys = [...Object.keys(digestBefore), ...Object.keys(digestAfter).filter((key) => !(key in digestBefore))];
  const changes = [];
  for (const key of keys) {
    if (changes.length >= MAX_CHANGES) break;
    const beforeValue = digestBefore[key], afterValue = digestAfter[key];
    if (beforeValue !== afterValue) changes.push({ label: labelFor(type, key), before: beforeValue, after: afterValue });
  }
  return { state: changes.length ? 'changed' : 'same', changes };
}

export function effectiveOutput(run, nodeRun) {
  if (!nodeRun) return undefined;
  let output = nodeRun.output !== undefined ? nodeRun.output : nodeRun.retainedOutput;
  if (nodeRun.type === 'review') {
    const decision = run?.reviews?.[nodeRun.nodeId]?.decision;
    if (decision !== undefined) output = { ...(output || {}), decision };
  }
  return output;
}

function deriveTrigger(run) {
  const nodeRuns = Array.isArray(run.nodeRuns) ? run.nodeRuns : [];
  const execution = run.execution;
  if (execution?.mode === 'node') {
    const type = nodeRuns.find((item) => item.nodeId === execution.targetNodeId)?.type;
    return `${TRIGGER_LABEL[type] || type || '노드'} 실행`;
  }
  if (execution?.mode === 'all') return execution.refresh ? '전체 새로고침 실행' : '전체 실행';
  const selectedStages = Array.isArray(run.selectedStages) ? run.selectedStages : [];
  if (!selectedStages.length) return RUN_STATUS_LABEL[run.status] || '실행 기록';
  if (selectedStages.length === nodeRuns.length) return '전체 실행';
  if (selectedStages.length === 1) {
    const type = nodeRuns.find((item) => item.nodeId === selectedStages[0])?.type;
    return `${TRIGGER_LABEL[type] || type || '노드'} 실행`;
  }
  return '선택 노드 실행';
}

export function summarizeRun(run, previousRun) {
  const nodeRuns = Array.isArray(run?.nodeRuns) ? run.nodeRuns : [];
  const previousById = new Map((Array.isArray(previousRun?.nodeRuns) ? previousRun.nodeRuns : []).map((item) => [item.nodeId, item]));
  const counts = { ran: 0, reused: 0, kept: 0, skipped: 0, failed: 0, blocked: 0 };
  const changed = [];
  for (const nodeRun of nodeRuns) {
    let bucket;
    if (nodeRun.reused === true) bucket = 'reused';
    else if (nodeRun.status === 'failed') bucket = 'failed';
    else if (nodeRun.status === 'skipped') {
      if (nodeRun.skipReason === 'user') bucket = 'skipped';
      else if (nodeRun.retainedOutput !== null && nodeRun.retainedOutput !== undefined) bucket = 'kept';
      else bucket = 'blocked';
    } else bucket = 'ran';
    counts[bucket]++;
    const diff = diffNodeOutputs(nodeRun.type, effectiveOutput(previousRun, previousById.get(nodeRun.nodeId)), effectiveOutput(run, nodeRun));
    if (diff.state !== 'same') changed.push({ nodeId: nodeRun.nodeId, type: nodeRun.type, state: diff.state, changes: diff.changes });
  }
  return { counts, trigger: deriveTrigger(run), changed, untouched: nodeRuns.length - changed.length };
}
