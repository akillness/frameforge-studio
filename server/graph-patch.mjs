// Pure workflow-graph editing helpers shared by the agent API. Nothing here reads or writes
// storage: callers pass a graph in and validate/persist the result through validateWorkflow().
import { HttpError } from './validation.mjs';
import { TYPES, NODE_CONFIG_FIELDS } from './workflows.mjs';

export const MAX_PATCH_OPS = 100;
const GRID = 10;
const COLUMN_GAP = 280;
const ROW_GAP = 140;
const snap = (value) => Math.round(value / GRID) * GRID;
const clone = (value) => structuredClone(value);
const ID = /^[a-zA-Z0-9_-]{1,80}$/;

const OP_FIELDS = {
  rename: ['op', 'name'],
  addNode: ['op', 'id', 'type', 'x', 'y', 'label', 'notes', 'config'],
  removeNode: ['op', 'id'],
  setConfig: ['op', 'id', 'config', 'unset'],
  setLabel: ['op', 'id', 'label', 'notes'],
  setPosition: ['op', 'id', 'x', 'y'],
  connect: ['op', 'id', 'source', 'target'],
  disconnect: ['op', 'id', 'source', 'target'],
  autoLayout: ['op'],
  replaceGraph: ['op', 'name', 'nodes', 'edges'],
};
export const PATCH_OP_NAMES = Object.freeze(Object.keys(OP_FIELDS));

function need(condition, message) { if (!condition) throw new HttpError(400, message); }
const nodeById = (graph, id, label = 'node') => {
  const node = graph.nodes.find((item) => item.id === id);
  need(node, `Unknown ${label} "${id}"`);
  return node;
};

function freshId(prefix, taken) {
  for (let index = 1; index < 10000; index++) {
    const candidate = `${prefix}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new HttpError(400, 'Could not allocate a unique id');
}

function wouldCycle(edges, source, target) {
  const forward = new Map();
  for (const edge of edges) forward.set(edge.source, [...(forward.get(edge.source) || []), edge.target]);
  const seen = new Set();
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    if (current === source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(forward.get(current) || []));
  }
  return false;
}

/** Longest-path layered layout. Deterministic; never changes ids or edges. O(V+E) per pass. */
export function autoLayout(nodes, edges) {
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!incoming.has(edge.target) || !outgoing.has(edge.source)) continue;
    incoming.get(edge.target).push(edge.source);
    outgoing.get(edge.source).push(edge.target);
  }
  const depth = new Map();
  const remaining = new Map(nodes.map((node) => [node.id, incoming.get(node.id).length]));
  const queue = nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);
  for (const id of queue) depth.set(id, 0);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    for (const next of outgoing.get(id)) {
      depth.set(next, Math.max(depth.get(next) ?? 0, depth.get(id) + 1));
      remaining.set(next, remaining.get(next) - 1);
      if (remaining.get(next) === 0) queue.push(next);
    }
  }
  // Defensive: validateWorkflow rejects cycles, but never loop or drop nodes if one slips in.
  for (const node of nodes) if (!depth.has(node.id)) depth.set(node.id, 0);
  const columns = new Map();
  for (const node of nodes) columns.set(depth.get(node.id), [...(columns.get(depth.get(node.id)) || []), node.id]);
  const row = new Map();
  for (const level of [...columns.keys()].sort((a, b) => a - b)) {
    const ids = columns.get(level);
    const score = (id) => {
      const parents = incoming.get(id).filter((parent) => row.has(parent));
      return parents.length ? parents.reduce((sum, parent) => sum + row.get(parent), 0) / parents.length : Number.POSITIVE_INFINITY;
    };
    ids.sort((a, b) => (score(a) - score(b)) || a.localeCompare(b));
    ids.forEach((id, index) => row.set(id, index));
  }
  return nodes.map((node) => ({ ...node, x: snap(60 + depth.get(node.id) * COLUMN_GAP), y: snap(60 + row.get(node.id) * ROW_GAP) }));
}

/**
 * Apply an ordered list of edit operations atomically to a copy of the graph. The result is
 * not validated here (intermediate states may be disconnected); the caller must run
 * validateWorkflow() on it before persisting.
 */
export function applyGraphOps(workflow, ops) {
  need(Array.isArray(ops) && ops.length >= 1 && ops.length <= MAX_PATCH_OPS, `ops must contain 1–${MAX_PATCH_OPS} operations`);
  const graph = { name: workflow.name, nodes: clone(workflow.nodes), edges: clone(workflow.edges) };
  const stats = { nodesAdded: 0, nodesRemoved: 0, edgesAdded: 0, edgesRemoved: 0, nodesChanged: 0 };
  ops.forEach((raw, index) => {
    need(raw && typeof raw === 'object' && !Array.isArray(raw), `ops[${index}] must be an object`);
    const allowed = OP_FIELDS[raw.op];
    need(allowed, `ops[${index}].op must be one of ${PATCH_OP_NAMES.join(', ')}`);
    const unknown = Object.keys(raw).find((key) => !allowed.includes(key));
    need(!unknown, `ops[${index}] has unknown field "${unknown}" for ${raw.op}`);
    const where = `ops[${index}] (${raw.op})`;
    switch (raw.op) {
      case 'rename':
        need(typeof raw.name === 'string' && raw.name.trim(), `${where}: name required`);
        graph.name = raw.name.trim();
        break;
      case 'addNode': {
        need(TYPES.includes(raw.type), `${where}: type must be one of ${TYPES.join(', ')}`);
        need(graph.nodes.length < 128, `${where}: workflow already has 128 nodes`);
        const taken = new Set(graph.nodes.map((node) => node.id));
        const id = raw.id === undefined ? freshId(raw.type, taken) : raw.id;
        need(typeof id === 'string' && ID.test(id), `${where}: id must use letters, digits, underscores or hyphens`);
        need(!taken.has(id), `${where}: node "${id}" already exists`);
        const column = Math.max(0, ...graph.nodes.map((node) => node.x)) + COLUMN_GAP;
        graph.nodes.push({
          id, type: raw.type,
          x: raw.x ?? snap(column), y: raw.y ?? snap(60),
          ...(raw.label !== undefined ? { label: raw.label } : {}),
          ...(raw.notes !== undefined ? { notes: raw.notes } : {}),
          config: clone(raw.config ?? {}),
        });
        stats.nodesAdded++;
        break;
      }
      case 'removeNode': {
        nodeById(graph, raw.id);
        need(graph.nodes.length > 1, `${where}: the final node cannot be removed`);
        graph.nodes = graph.nodes.filter((node) => node.id !== raw.id);
        const before = graph.edges.length;
        graph.edges = graph.edges.filter((edge) => edge.source !== raw.id && edge.target !== raw.id);
        stats.nodesRemoved++;
        stats.edgesRemoved += before - graph.edges.length;
        break;
      }
      case 'setConfig': {
        const node = nodeById(graph, raw.id);
        need(raw.config === undefined || (raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)), `${where}: config must be an object`);
        need(raw.unset === undefined || (Array.isArray(raw.unset) && raw.unset.every((key) => typeof key === 'string')), `${where}: unset must be an array of keys`);
        const allowedKeys = NODE_CONFIG_FIELDS[node.type] || [];
        for (const key of [...Object.keys(raw.config || {}), ...(raw.unset || [])]) need(allowedKeys.includes(key), `${where}: "${key}" is not a ${node.type} configuration field`);
        node.config = { ...node.config, ...clone(raw.config || {}) };
        for (const key of raw.unset || []) delete node.config[key];
        stats.nodesChanged++;
        break;
      }
      case 'setLabel': {
        const node = nodeById(graph, raw.id);
        need(raw.label !== undefined || raw.notes !== undefined, `${where}: label or notes required`);
        if (raw.label !== undefined) node.label = raw.label;
        if (raw.notes !== undefined) node.notes = raw.notes;
        stats.nodesChanged++;
        break;
      }
      case 'setPosition': {
        const node = nodeById(graph, raw.id);
        need(Number.isFinite(raw.x) && Number.isFinite(raw.y), `${where}: x and y must be finite numbers`);
        node.x = raw.x; node.y = raw.y;
        stats.nodesChanged++;
        break;
      }
      case 'connect': {
        nodeById(graph, raw.source, 'source node'); nodeById(graph, raw.target, 'target node');
        need(raw.source !== raw.target, `${where}: self edges are not allowed`);
        need(!graph.edges.some((edge) => edge.source === raw.source && edge.target === raw.target), `${where}: edge ${raw.source}→${raw.target} already exists`);
        need(!wouldCycle(graph.edges, raw.source, raw.target), `${where}: edge ${raw.source}→${raw.target} would create a cycle`);
        need(graph.edges.length < 256, `${where}: workflow already has 256 edges`);
        const taken = new Set(graph.edges.map((edge) => edge.id));
        const id = raw.id === undefined ? freshId('edge', taken) : raw.id;
        need(typeof id === 'string' && ID.test(id) && !taken.has(id), `${where}: edge id must be unique`);
        graph.edges.push({ id, source: raw.source, target: raw.target });
        stats.edgesAdded++;
        break;
      }
      case 'disconnect': {
        const match = raw.id !== undefined ? (edge) => edge.id === raw.id : (edge) => edge.source === raw.source && edge.target === raw.target;
        need(raw.id !== undefined || (raw.source !== undefined && raw.target !== undefined), `${where}: id or source+target required`);
        const before = graph.edges.length;
        graph.edges = graph.edges.filter((edge) => !match(edge));
        need(graph.edges.length < before, `${where}: no such edge`);
        stats.edgesRemoved += before - graph.edges.length;
        break;
      }
      case 'autoLayout':
        graph.nodes = autoLayout(graph.nodes, graph.edges);
        stats.nodesChanged += graph.nodes.length;
        break;
      case 'replaceGraph':
        need(Array.isArray(raw.nodes) && Array.isArray(raw.edges), `${where}: nodes and edges arrays required`);
        stats.nodesRemoved += graph.nodes.length; stats.edgesRemoved += graph.edges.length;
        graph.nodes = clone(raw.nodes); graph.edges = clone(raw.edges);
        stats.nodesAdded += graph.nodes.length; stats.edgesAdded += graph.edges.length;
        if (raw.name !== undefined) { need(typeof raw.name === 'string' && raw.name.trim(), `${where}: name must be text`); graph.name = raw.name.trim(); }
        break;
      default:
        throw new HttpError(400, `${where}: unsupported`);
    }
  });
  return { graph, stats };
}

const STYLE_PROMPTS = {
  news: '오늘의 뉴스 한 가지를 출처와 함께 3~4개 장면으로 정리하세요. 확인된 사실과 해석을 구분하고 마지막에 출처를 밝히세요.',
  explainer: '주제를 훅 → 핵심 설명 → 사례 → 마무리 흐름의 장면으로 쉽게 풀어 쓰세요. 한 장면에 한 메시지만 담으세요.',
  'short-hook': '첫 2초 안에 시선을 잡는 질문으로 시작하고, 짧은 문장 3~5개로 끝나는 쇼츠 대본을 쓰세요.',
};
export const BLUEPRINT_STYLES = Object.freeze(Object.keys(STYLE_PROMPTS));

/**
 * Rule-based starter graph. It is a proposal only: callers decide whether to apply it. A model id
 * cannot be known here, so a generate node is added ONLY when the caller supplies one; otherwise
 * it is omitted and a warning explains why (no placeholder id that could pass validation).
 */
export function blueprintFor({ topic, style = 'explainer', includeGeneration = false, includePublish = false, model } = {}) {
  need(typeof topic === 'string' && topic.trim() && topic.length <= 300, 'topic must be 1–300 characters');
  need(BLUEPRINT_STYLES.includes(style), `style must be one of ${BLUEPRINT_STYLES.join(', ')}`);
  const subject = topic.trim();
  const nodes = [];
  const edges = [];
  const rationale = [];
  const warnings = [];
  const add = (id, type, config = {}, label) => { nodes.push({ id, type, x: 0, y: 0, ...(label ? { label } : {}), config }); return id; };
  const link = (source, target) => edges.push({ id: `edge-${source}-${target}`, source, target });
  // validateWorkflow measures string length in UTF-16 units; never split a surrogate pair.
  let query = '';
  for (const character of subject) { if (query.length + character.length > 200) break; query += character; }
  if (query.length < subject.length) warnings.push('주제가 길어 수집 노드의 검색어는 앞 200자로 줄였습니다. 대본 프롬프트에는 전체 주제를 유지했습니다.');
  const first = style === 'news'
    ? add('news', 'news', { query, maxArticles: 5, source: 'all' }, '관련 뉴스')
    : add('trend', 'trend', { query }, '관심 키워드');
  rationale.push(style === 'news' ? '뉴스 소재를 먼저 수집해 출처 있는 대본을 만듭니다.' : '주제 관련 트렌드를 먼저 확인해 훅을 고릅니다.');
  const research = add('research', 'research', { limit: 10 }, '자료 정리');
  const script = add('script', 'script', { agent: 'studio', prompt: `주제: ${subject}\n${STYLE_PROMPTS[style]}` }, '대본');
  const storyboard = add('storyboard', 'storyboard', {}, '스토리보드');
  const layout = add('layout', 'layout', { preset: 'top-image-mid-video', enableSubtitles: true }, '레이아웃');
  link(first, research); link(research, script); link(script, storyboard); link(storyboard, layout);
  let beforeRender = layout;
  if (includeGeneration && model) {
    const generate = add('generate', 'generate', { model: String(model), prompt: subject, sceneIndex: 0, targetMode: 'scene' }, '장면 생성');
    link(storyboard, generate); link(generate, 'render');
    rationale.push('Higgsfield 생성 노드를 포함했습니다. 실행 전 견적과 사용자 승인이 필요합니다.');
  } else if (includeGeneration) {
    warnings.push('생성 노드는 모델을 선택해야 추가할 수 있어 이번 구성안에서 제외했습니다. 적용 후 노드 추가에서 생성 노드를 넣고 모델을 고르세요.');
  }
  const render = add('render', 'render', {}, '영상 렌더');
  link(beforeRender, render);
  const review = add('review', 'review', { instructions: '사실, 자막, 길이를 확인한 뒤 승인하세요.' }, '사람 검토');
  link(render, review);
  rationale.push('렌더 뒤에 사람의 검토 노드를 두어 자동 공개를 막습니다.');
  if (includePublish) {
    const publish = add('publish', 'publish', { platform: 'youtube', visibility: 'private', autoAttachExport: true }, '비공개 업로드');
    link(review, publish);
    rationale.push('게시 노드는 비공개로 시작하며 최종 공개는 별도 승인이 필요합니다.');
  }
  return { name: `${subject.slice(0, 60)} · ${style}`, nodes: autoLayout(nodes, edges), edges, rationale, warnings, engine: 'rule-based' };
}

const TONES = { neutral: { backgrounds: ['#282544', '#173940', '#382d46', '#2b3a2e'], pace: 5 }, energetic: { backgrounds: ['#3d1f2f', '#1f2f4d', '#4a2d12', '#1d3b34'], pace: 3.5 }, calm: { backgrounds: ['#243447', '#2b3a2e', '#34303f', '#2f3a3d'], pace: 6 } };
export const STORYBOARD_TONES = Object.freeze(Object.keys(TONES));

/** Rule-based scene outline from a brief. Proposal only; never saved by this function. */
export function storyboardFor({ title, topic, brief, sceneCount = 4, tone = 'neutral' }) {
  need(Number.isInteger(sceneCount) && sceneCount >= 3 && sceneCount <= 8, 'sceneCount must be an integer from 3 to 8');
  need(STORYBOARD_TONES.includes(tone), `tone must be one of ${STORYBOARD_TONES.join(', ')}`);
  const subject = String(topic || title || '주제').trim();
  const source = String(brief || '').replace(/\s+/g, ' ').trim();
  const sentences = source ? source.split(/(?<=[.!?。])\s+/u).filter(Boolean) : [];
  const { backgrounds, pace } = TONES[tone];
  const roles = ['훅 · 시선을 잡는 질문', ...Array.from({ length: sceneCount - 2 }, (_, index) => sceneCount === 3 ? '전개 · 핵심 내용' : `전개 ${index + 1} · 핵심 내용`), '마무리 · 요약과 다음 행동'];
  const scenes = roles.map((role, index) => {
    const excerpt = index === 0 ? '' : sentences[index - 1] || '';
    const text = index === 0 ? `${subject}, 왜 지금 중요할까요?` : index === roles.length - 1 ? `${subject}\n출처 확인 · 내용 검토 후 게시` : excerpt || `${subject}의 핵심 포인트 ${index}`;
    return { id: `scene-${index + 1}`, title: role, text: text.slice(0, 600), duration: index === 0 ? Math.min(pace, 4) : pace, background: backgrounds[index % backgrounds.length], kind: 'title', layout: 'center', narration: text.replace(/\n/g, ' ').slice(0, 600) };
  });
  const rationale = [
    `${sceneCount}개 장면: 훅 1, 전개 ${sceneCount - 2}, 마무리 1 구성입니다.`,
    source ? '입력한 설명의 문장을 장면 순서대로 배치했습니다.' : '설명이 없어 주제만으로 자리표시 문구를 채웠습니다. 내용을 직접 작성하세요.',
    '규칙 기반 초안입니다. 사실과 출처는 직접 검토하세요.',
  ];
  return { scenes, rationale };
}
