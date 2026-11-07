import { HttpError, object, text, optionalText, choice, scenes, createPresetSlots } from './validation.mjs';
import { starterScene } from './store.mjs';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { topologicalOrder, ancestors, descendants, resolvePrerequisite, resolveOptional, canonicalJson, candidateFingerprint, hardRequiredIds, HARD_DEPENDENCY } from './graph.mjs';
import { validateGenerationInput } from './higgsfield.mjs';

import * as candidates from './candidates.mjs';

export const TYPES = ['trend', 'news', 'research', 'script', 'storyboard', 'layout', 'generate', 'render', 'review', 'publish'];
const AGENTS = ['existing', 'studio', 'codex', 'jeo', 'jeopi', 'hermes'];
const TERMINAL = ['completed', 'failed', 'cancelled', 'awaiting_review', 'approved', 'changes_requested'];
const MAX_ACTIVE_RUNS = 4;
const timestamp = () => new Date().toISOString();
const safeHttpUrl = (value) => {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch { return null; }
};
const decodeXml = (value = '') => String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
function parseNewsRss(xml, maxArticles) {
  return [...String(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, maxArticles).map(([, body]) => {
    const field = (name) => decodeXml(body.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '');
    const headline = field('title'), url = safeHttpUrl(field('link')), source = field('source'), summary = field('description'), publishedAt = field('pubDate');
    if (!headline || !url || !source) return null;
    return { id: `news-${createHash('sha256').update(`${url}:${headline}`).digest('hex').slice(0, 16)}`, headline, source, url, ...(summary ? { summary } : {}), capturedAt: Number.isFinite(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : timestamp(), evidence: { source, url, ...(publishedAt ? { publishedAt } : {}) } };
  }).filter(Boolean);
}
export async function fetchGoogleNews(query, maxArticles, fetchImpl) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`News source HTTP ${response.status}`);
  const xml = await response.text();
  const articles = parseNewsRss(xml, maxArticles);
  if (!articles.length) throw new Error('News source returned no verified articles');
  return { query, source: 'google_news', sourceUrl: url, articles };
}

function identifier(value, name) {
  const id = text(value, name, 80);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400, `${name} must use letters, digits, underscores or hyphens`);
  return id;
}

/** Single source for the node catalog: the validator, the agent API and its docs all read these. */
export const NODE_CONFIG_FIELDS = Object.freeze({
  trend: ['query'],
  news: ['query', 'keywords', 'maxArticles', 'source'],
  research: ['limit'],
  script: ['agent', 'prompt'],
  storyboard: [],
  layout: ['preset', 'topSlotRole', 'midSlotRole', 'enableSubtitles', 'enableHtmlOverlay', 'autoPrompts'],
  generate: ['model', 'prompt', 'params', 'sceneId', 'sceneIndex', 'slotId', 'targetMode'],
  render: [],
  review: ['instructions'],
  publish: ['channelId', 'platform', 'visibility', 'autoAttachExport', 'titleTemplate'],
});
export const STAGE_PREREQUISITES = Object.freeze({ storyboard: 'script', layout: 'storyboard', generate: 'storyboard', review: 'render', publish: 'review' });

/** A bounded connected DAG. Roles may repeat; dependencies are resolved by node identity. */
export function validateWorkflow(raw) {
  const body = object(raw);
  const name = text(body.name, 'workflow name', 160);
  if (!Array.isArray(body.nodes) || body.nodes.length < 1 || body.nodes.length > 128) throw new HttpError(400, 'Workflow requires 1–128 nodes');
  if (!Array.isArray(body.edges) || body.edges.length > 256) throw new HttpError(400, 'Workflow requires 0–256 edges');
  const nodeIds = new Set();
  const nodes = body.nodes.map((rawNode) => {
    const node = object(rawNode);
    const id = identifier(node.id, 'node id');
    const type = choice(node.type, TYPES, 'node type');
    if (nodeIds.has(id) || (TYPES.includes(id) && id !== type)) throw new HttpError(400, 'Node IDs must be unique and must not shadow a different stage type');
    nodeIds.add(id);
    for (const key of ['x', 'y']) if (typeof node[key] !== 'number' || !Number.isFinite(node[key]) || Math.abs(node[key]) > 100000) throw new HttpError(400, 'Node coordinates must be finite and within ±100000');
    const config = object(node.config ?? {});
    const allowed = NODE_CONFIG_FIELDS[type] || [];
    if (Object.keys(config).some((key) => !allowed.includes(key))) throw new HttpError(400, `Unknown ${type} configuration field`);
    const normalized = type === 'script' ? { agent: choice(config.agent, AGENTS, 'script agent'), prompt: optionalText(config.prompt, 'script prompt', 12000) } : {};
    if (type === 'trend' && config.query !== undefined) normalized.query = optionalText(config.query, 'trend query', 200);
    if (type === 'news') {
      if (config.query !== undefined) normalized.query = optionalText(config.query, 'news query', 200);
      if (config.keywords !== undefined) normalized.keywords = optionalText(config.keywords, 'news keywords', 400);
      if (config.maxArticles !== undefined) {
        if (!Number.isInteger(config.maxArticles) || config.maxArticles < 1 || config.maxArticles > 20) throw new HttpError(400, 'News maxArticles must be an integer from 1 to 20');
        normalized.maxArticles = config.maxArticles;
      }
      if (config.source !== undefined) normalized.source = choice(config.source, ['google_news', 'trend_news', 'all'], 'news source', 'all');
    }
    if (type === 'research' && config.limit !== undefined) {
      if (!Number.isInteger(config.limit) || config.limit < 1 || config.limit > 50) throw new HttpError(400, 'Research limit must be an integer from 1 to 50');
      normalized.limit = config.limit;
    }
    if (type === 'layout') {
      normalized.preset = choice(config.preset, ['top-image-mid-video', 'premiere-3tier', 'split', 'custom'], 'layout preset', 'top-image-mid-video');
      if (config.topSlotRole !== undefined) normalized.topSlotRole = choice(config.topSlotRole, ['image-gen', 'text-overlay', 'html-overlay'], 'topSlotRole', 'image-gen');
      if (config.midSlotRole !== undefined) normalized.midSlotRole = choice(config.midSlotRole, ['video-bg', 'image-gen'], 'midSlotRole', 'video-bg');
      if (config.enableSubtitles !== undefined) {
        if (typeof config.enableSubtitles !== 'boolean') throw new HttpError(400, 'layout enableSubtitles must be boolean');
        normalized.enableSubtitles = config.enableSubtitles;
      }
      if (config.enableHtmlOverlay !== undefined) {
        if (typeof config.enableHtmlOverlay !== 'boolean') throw new HttpError(400, 'layout enableHtmlOverlay must be boolean');
        normalized.enableHtmlOverlay = config.enableHtmlOverlay;
      }
      if (config.autoPrompts !== undefined) {
        if (typeof config.autoPrompts !== 'boolean') throw new HttpError(400, 'layout autoPrompts must be boolean');
        normalized.autoPrompts = config.autoPrompts;
      }
    }
    if (type === 'review' && config.instructions !== undefined) normalized.instructions = optionalText(config.instructions, 'review instructions', 2000);
    if (type === 'generate') {
      normalized.model = text(config.model, 'generation model', 160);
      normalized.prompt = optionalText(config.prompt, 'generation prompt', 4000);
      normalized.sceneIndex = config.sceneIndex ?? 0;
      if (config.sceneId !== undefined) normalized.sceneId = identifier(config.sceneId, 'generation sceneId');
      if (!Number.isInteger(normalized.sceneIndex) || normalized.sceneIndex < 0 || normalized.sceneIndex > 59) throw new HttpError(400, 'Generation scene index must be 0–59');
      if (config.slotId !== undefined && config.slotId !== '') normalized.slotId = identifier(config.slotId, 'generation slotId');
      if (config.targetMode !== undefined) normalized.targetMode = choice(config.targetMode, ['scene', 'slot', 'all-slots'], 'generation targetMode', 'scene');
      if (normalized.targetMode === 'slot' && !normalized.slotId) throw new HttpError(400, 'Slot-targeted generation requires slotId');
      if (normalized.targetMode === 'all-slots' && normalized.slotId) throw new HttpError(400, 'All-slots generation must not specify slotId');
      normalized.params = object(config.params ?? {});
      if ('prompt' in normalized.params) throw new HttpError(400, 'Generation parameters must not override prompt');
      if (Object.keys(normalized.params).length > 30 || Object.entries(normalized.params).some(([key, value]) => !/^[a-z][a-z0-9_]{0,63}$/.test(key) || !['string','number','boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && (value.length > 4000 || value.includes('\0')))) || JSON.stringify(normalized.params).length > 16000) throw new HttpError(400, 'Generation parameters must be bounded primitive values');
    }
    if (type === 'publish') {
      if (config.channelId !== undefined && config.channelId !== '') normalized.channelId = identifier(config.channelId, 'publish channelId');
      if (config.platform !== undefined) normalized.platform = choice(config.platform, ['youtube', 'tiktok', 'instagram', 'other'], 'publish platform', 'youtube');
      if (config.visibility !== undefined) normalized.visibility = choice(config.visibility, ['private', 'unlisted', 'public'], 'publish visibility', 'private');
      if (config.autoAttachExport !== undefined) {
        if (typeof config.autoAttachExport !== 'boolean') throw new HttpError(400, 'publish autoAttachExport must be boolean');
        normalized.autoAttachExport = config.autoAttachExport;
      }
      if (config.titleTemplate !== undefined) normalized.titleTemplate = optionalText(config.titleTemplate, 'publish titleTemplate', 200);
    }
    return { id, type, x: node.x, y: node.y, ...(node.label !== undefined ? { label: optionalText(node.label, 'node label', 80) } : {}), ...(node.notes !== undefined ? { notes: optionalText(node.notes, 'node notes', 2000) } : {}), config: normalized };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edgeIds = new Set(), pairs = new Set();
  const edges = body.edges.map((rawEdge) => {
    const edge = object(rawEdge);
    const id = identifier(edge.id, 'edge id');
    const source = identifier(edge.source, 'edge source'), target = identifier(edge.target, 'edge target');
    if (!byId.has(source) || !byId.has(target)) throw new HttpError(400, 'Edge refers to an unknown node');
    if (edgeIds.has(id) || pairs.has(`${source}:${target}`)) throw new HttpError(400, 'Edges must be unique');
    if (source === target) throw new HttpError(400, 'Self edges are not allowed');
    if (edge.sourcePort !== undefined && edge.sourcePort !== 'output') throw new HttpError(400, 'Invalid source port');
    if (edge.targetPort !== undefined && edge.targetPort !== 'input') throw new HttpError(400, 'Invalid target port');
    edgeIds.add(id); pairs.add(`${source}:${target}`);
    return { id, source, target };
  });
  if (nodes.length > 1) {
    const connected = new Set([nodes[0].id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) if (connected.has(edge.source) || connected.has(edge.target)) {
        if (!connected.has(edge.source)) { connected.add(edge.source); changed = true; }
        if (!connected.has(edge.target)) { connected.add(edge.target); changed = true; }
      }
    }
    if (connected.size !== nodes.length) throw new HttpError(400, 'Every node must be connected to the workflow graph');
  }
  topologicalOrder(nodes, edges);
  // Structural validation requires connectivity; runtime resolution additionally rejects
  // multiple nearest producers with 409 rather than inventing a branch selection.
  const requires = STAGE_PREREQUISITES;
  for (const node of nodes) {
    const upstream = ancestors(edges, node.id);
    const required = requires[node.type];
    if (required && (nodes.some((producer) => producer.type === required) || ['generate', 'publish'].includes(node.type))) {
      try { resolvePrerequisite(nodes, edges, node.id, required); }
      catch (error) { if (!error.message.includes('ambiguous')) throw new HttpError(400, error.message); }
    }
    if (node.type === 'publish' && !nodes.some((producer) => producer.type === 'render' && upstream.has(producer.id))) throw new HttpError(400, `${node.id} requires a connected render prerequisite`);
    if (['layout', 'generate'].includes(node.type) && !nodes.some((consumer) => consumer.type === 'render' && descendants(edges, node.id).has(consumer.id))) throw new HttpError(400, `${node.id} must feed a render node`);
  }
  if (body.expectedVersion !== undefined && (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1)) throw new HttpError(400, 'expectedVersion must be a positive integer');
  return { name, nodes, edges };
}

function portableRollup(workflow, episode, channel) {
  const graph = validateWorkflow(workflow);
  for (const node of graph.nodes) {
    if (node.type === 'generate') {
      const config = node.config;
      if (config.sceneId || config.slotId || config.sceneIndex !== 0 || config.targetMode === 'slot') throw new HttpError(400, `Generation node ${node.id} has a project-specific scene or slot target`);
      const safeParams = {
        duration: (value) => Number.isInteger(value) && value >= 4 && value <= 30,
        resolution: (value) => ['480p', '720p', '1080p'].includes(value),
        aspect_ratio: (value) => ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'].includes(value),
        output_format: (value) => ['mp4', 'mov'].includes(value),
        generate_audio: (value) => typeof value === 'boolean',
      };
      for (const [key, value] of Object.entries(config.params)) {
        if (!Object.hasOwn(safeParams, key) || !safeParams[key](value)) throw new HttpError(400, `Generation node ${node.id} has a non-portable parameter: ${key}`);
      }
    }
    if (node.type === 'publish' && node.config.channelId) {
      if (node.config.channelId !== channel.id) throw new HttpError(400, `Publish node ${node.id} belongs to a different channel`);
      delete node.config.channelId;
    }
  }
  const media = [episode.music, ...(episode.scenes || []).flatMap((scene) => [scene, ...(scene.slots || [])])].filter(Boolean);
  const projectIds = [workflow.id, episode.id, channel.id, channel.externalId, channel.accountEmail, ...(episode.scenes || []).flatMap((scene) => [scene.id, ...(scene.slots || []).map((slot) => slot.id)]), ...media.flatMap((item) => [item.assetUrl, item.audioUrl, item.source?.sourceUrl, item.source?.generationJobId, ...[item.assetUrl, item.audioUrl].map((url) => typeof url === 'string' ? /^\/api\/uploads\/([^/.]+)\./.exec(url)?.[1] : undefined)])].filter((value) => typeof value === 'string' && value.length > 0);
  const containsIdentity = (value) => {
    if (typeof value === 'string') return value.includes('/api/uploads/') || projectIds.some((id) => value === id || (id.length >= 4 && value.includes(id)));
    if (Array.isArray(value)) return value.some(containsIdentity);
    return value && typeof value === 'object' && Object.values(value).some(containsIdentity);
  };
  if (containsIdentity(graph)) throw new HttpError(400, 'Workflow contains project-specific identity; remove it before rollup');
  return validateWorkflow(graph);
}

export function defaultWorkflow() {
  const classicTypes = ['trend', 'research', 'script', 'storyboard', 'render', 'review'];
  const nodes = classicTypes.map((type, index) => ({ id: type, type, x: 80 + index * 260, y: 180, config: type === 'script' ? { agent: 'studio', prompt: '출처가 확인된 내용으로 한국어 영상 스토리보드를 구성하세요.' } : {} }));
  return { name: '기본 제작 DAG · 트렌드에서 검토까지', nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index + 1}`, source: nodes[index].id, target: node.id })), version: 1, sample: true };
}

function resolveStage(workflow, value, name = 'stage') {
  const ref = identifier(value, name);
  const node = workflow.nodes.find((item) => item.id === ref);
  if (!node) throw new HttpError(400, `Unknown ${name}: ${ref}`);
  return node;
}

const nodeOutput = (nodeRun) => nodeRun?.output || nodeRun?.retainedOutput;
const nodeStatus = (nodeRun) => nodeRun?.status === 'skipped' ? nodeRun.retainedStatus : nodeRun?.status;

function reusableNodeRun(nodeRun) {
  const status = nodeStatus(nodeRun);
  return Boolean(nodeOutput(nodeRun)) && ['completed', 'reused', 'awaiting_review', 'approved', 'changes_requested'].includes(status);
}

const orderedNodes = (workflow) => {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  return topologicalOrder(workflow.nodes, workflow.edges).map((id) => byId.get(id));
};
const prerequisite = (workflow, node, type) => resolvePrerequisite(workflow.nodes, workflow.edges, node.id, type);
const optional = (workflow, node, type) => resolveOptional(workflow.nodes, workflow.edges, node.id, type);

const BLOCK_MESSAGES = {
  active_run: '이 에피소드에 실행 중인 워크플로우가 있습니다. 끝난 뒤 다시 시도하세요.',
  skipped_target: '건너뛰기가 설정된 노드입니다. 건너뛰기를 해제한 뒤 실행하세요.',
  skipped_prerequisite: '건너뛴 선행 노드에 저장된 결과가 없어 실행할 수 없습니다.',
  publish_requires_review: '게시는 같은 결과에 대한 승인된 검토가 있어야 실행할 수 있습니다.',
};
const NOTHING_TO_RUN_MESSAGE = '실행할 노드가 없습니다. 완료된 결과를 유지합니다.';
const PREPARE_FIRST_NOTICE = '비용이 드는 생성은 준비 단계가 끝난 뒤 다시 실행해 비용을 확인합니다.';
const PREPARE_FIRST_EMPTY_MESSAGE = '먼저 실행할 수 있는 준비 단계가 없습니다.';
const GENERATION_UNRESOLVED_MESSAGE = '이전 생성 요청이 아직 끝나지 않았거나 결과가 적용되지 않았습니다. 기존 요청을 복구하거나 적용한 뒤 다시 실행하세요.';
const SETTLED_JOB_STATUSES = ['failed', 'nsfw', 'canceled'];
function priorGenerationJob(jobs, priorNodeRun, resumeId, nodeId) {
  const intent = priorNodeRun?.generationIntent;
  const jobId = nodeOutput(priorNodeRun)?.generationJobId || intent?.generationJobId;
  if (!jobId && !intent?.requestId && !resumeId) return null;
  return jobs.find((job) => jobId ? job.id === jobId : job.requestId === (intent?.requestId || `${resumeId}:${nodeId}`)) || null;
}
// Legacy-guard-only ancestor walk: resolves the job a RAW legacy body's strict-reject guard
// (guardJob below) must still catch regardless of how many intermediate runs separate the
// paying run from the node currently being reselected. A node invalidated-and-settled by an
// intermediate run persists only {staleFrom: <that run's id>} -- no jobId, no intent -- so a
// single-hop `source.resumedFrom || source.id` guess only happens to work when the paying run
// is exactly one hop back or is itself the root (finding F6). This walks the real staleFrom
// pointer chain instead of guessing a pattern, so the guard stays reachable at any lineage
// depth, matching docs/harness.md's "legacy explicit bodies keep their strict behaviour" at
// every hop, not just depth 1. Bounded purely as defense: staleFrom always points to a
// strictly earlier, already-terminal run, so a real cycle cannot occur.
function legacyAncestorJob(runs, jobs, runId, nodeId, depth = 0) {
  if (!runId || depth > 64) return null;
  const run = runs.find((item) => item.id === runId);
  const nodeRun = run?.nodeRuns?.find((item) => item.nodeId === nodeId);
  if (!nodeRun) return null;
  const jobId = nodeOutput(nodeRun)?.generationJobId || nodeRun.generationIntent?.generationJobId;
  if (jobId) return jobs.find((job) => job.id === jobId) || null;
  if (nodeRun.generationIntent?.requestId) return jobs.find((job) => job.requestId === nodeRun.generationIntent.requestId) || null;
  return legacyAncestorJob(runs, jobs, nodeRun.staleFrom, nodeId, depth + 1);
}
const isJobSettled = (job) => !job || (job.status === 'completed' && job.applied === true) || SETTLED_JOB_STATUSES.includes(job.status);
// Lineage-independent paid-job guard (mirrors store.hasUnresolvedMusicSubmission's intent but
// node-scoped, not episode-scoped): an episode/workflow version bump, an explicit refresh, or
// an intermediate run that reruns a node's ancestors without reselecting the node itself can
// each sever the single-lineage priorGenerationJob() lookup from an older, still-unresolved
// job for the SAME node. This scans every run for this workflow+episode (not only the newest/
// version-compatible one) and resolves each run's own prior job for nodeId the same way
// priorGenerationJob always has, so a job that settles in a later run -- or a job merely
// referenced by the current lineage's own prior entry -- can never mask a DIFFERENT job that
// is still unresolved elsewhere in this node's history. `excludeJobId` is NOT "any job this
// lineage happens to reference"; it is the ONE specific job a caller is itself about to
// legitimately resume (HEAD semantics) -- every other job for this node, settled-looking
// lineage or not, is still checked.
function hasUnresolvedNodeJob(runs, jobs, workflowId, episodeId, nodeId, excludeRunId, excludeJobId) {
  const seen = new Set();
  for (const run of runs) {
    if (run.id === excludeRunId || run.workflowId !== workflowId || run.episodeId !== episodeId) continue;
    const nodeRun = (run.nodeRuns || []).find((item) => item.nodeId === nodeId);
    if (!nodeRun) continue;
    const job = priorGenerationJob(jobs, nodeRun, run.resumedFrom || run.id, nodeId);
    if (!job || job.id === excludeJobId || seen.has(job.id)) continue;
    if (!isJobSettled(job)) return true;
    seen.add(job.id);
  }
  return false;
}
const skippedSet = (workflow) => new Set((workflow.skippedNodes || []).filter((id) => workflow.nodes.some((node) => node.id === id)));
const NO_RESUME = Symbol('no-resume');
function invalidatedBySelection(workflow, selectedIds) {
  const invalidated = new Set();
  for (const id of selectedIds) for (const descendantId of descendants(workflow.edges, id)) invalidated.add(descendantId);
  return invalidated;
}

function stageSelection(workflow, options, episode, store) {
  const skipped = skippedSet(workflow);
  const legacy = options.legacy === true;
  const selectedValues = options.selectedStages;
  if (selectedValues !== undefined && (!Array.isArray(selectedValues) || !selectedValues.length || selectedValues.length > workflow.nodes.length)) throw new HttpError(400, 'selectedStages must contain exact node IDs');
  const selected = new Set();
  for (const value of selectedValues ?? workflow.nodes.filter((node) => !skipped.has(node.id)).map((node) => node.id)) {
    const node = resolveStage(workflow, value, 'selected stage');
    if (selected.has(node.id)) throw new HttpError(400, 'selectedStages must not contain duplicates');
    if (selectedValues !== undefined && skipped.has(node.id)) throw new HttpError(409, BLOCK_MESSAGES.skipped_target);
    selected.add(node.id);
  }
  if (!selected.size) throw new HttpError(400, 'selectedStages must contain exact node IDs');
  const ordered = orderedNodes(workflow);
  const orderedSelected = ordered.filter((node) => selected.has(node.id));
  const start = options.startStage === undefined ? orderedSelected[0] : resolveStage(workflow, options.startStage, 'startStage');
  if (!selected.has(start.id)) throw new HttpError(400, 'startStage must be included in selectedStages');
  const reachable = descendants(workflow.edges, start.id);
  if (options.startStage !== undefined && orderedSelected.some((node) => node.id !== start.id && !reachable.has(node.id))) throw new HttpError(400, 'Every selected node must be downstream of startStage');

  let source;
  if (options.resumeRunId === NO_RESUME) { /* explicit "no resume" (internal planner signal only): never fall back to the implicit single-stage lookup. A client-supplied literal null still falls through below and throws 400. */ }
  else if (options.resumeRunId !== undefined) {
    source = store.get('workflowRuns', identifier(options.resumeRunId, 'resumeRunId'));
    if (source.workflowId !== workflow.id || source.episodeId !== episode.id) throw new HttpError(409, 'Resume evidence belongs to a different project workflow');
    if (!TERMINAL.includes(source.status)) throw new HttpError(409, 'Resume requires a terminal workflow run');
    if (source.workflowVersion !== workflow.version) throw new HttpError(409, 'Resume evidence is stale after a workflow edit');
    if (source.episodeVersion !== episode.version) throw new HttpError(409, 'Resume evidence is stale for this episode version');
  }
  else if (options.selectedStages?.length === 1 && start.id === options.selectedStages[0]) {
    source = store.list('workflowRuns').find((run) => run.workflowId === workflow.id && run.episodeId === episode.id
      && run.workflowVersion === workflow.version && run.episodeVersion === episode.version && TERMINAL.includes(run.status));
  }
  if (source && (!source.workflowSnapshot || source.workflowSnapshot.id !== workflow.id
    || source.workflowSnapshot.version !== workflow.version || source.workflowSnapshot.episodeId !== episode.id
    || source.workflowSnapshot.channelId !== episode.channelId || source.episodeSnapshot?.id !== episode.id
    || source.episodeSnapshot?.channelId !== episode.channelId || !Array.isArray(source.nodeRuns)
    || canonicalJson(source.workflowSnapshot.nodes) !== canonicalJson(workflow.nodes)
    || canonicalJson(source.workflowSnapshot.edges) !== canonicalJson(workflow.edges)
    || new Set(source.nodeRuns.map((item) => item.nodeId)).size !== source.nodeRuns.length
    || source.nodeRuns.some((item) => !workflow.nodes.some((node) => node.id === item.nodeId && node.type === item.type)))) throw new HttpError(409, 'Resume evidence lacks project workflow provenance');
  const invalidated = invalidatedBySelection(workflow, orderedSelected.map((node) => node.id));
  const sourceById = new Map((source?.nodeRuns || []).map((nodeRun) => [nodeRun.nodeId, nodeRun]));
  const requiredReuse = new Set();
  const reuse = (dependency, { hard = false } = {}) => {
    if (!dependency || selected.has(dependency.id) || requiredReuse.has(dependency.id)) return;
    if (!hard && skipped.has(dependency.id) && (invalidated.has(dependency.id) || !reusableNodeRun(sourceById.get(dependency.id)))) return;
    if (invalidated.has(dependency.id)) throw new HttpError(409, skipped.has(dependency.id) ? `${BLOCK_MESSAGES.skipped_prerequisite} (${dependency.id})` : `${dependency.id} requires fresh evidence after an upstream stage is rerun`);
    requiredReuse.add(dependency.id);
    inspect(dependency);
  };
  const inspect = (node) => {
    const type = HARD_DEPENDENCY[node.type];
    if (!type) return;
    reuse(prerequisite(workflow, node, type), { hard: true });
  };
  for (const node of orderedSelected) {
    inspect(node);
    // Optional context is reused only when an exact connected producer has completed.
    if (['news', 'script', 'layout'].includes(node.type)) {
      const context = optional(workflow, node, node.type === 'news' ? 'trend' : 'news');
      if (context && reusableNodeRun(sourceById.get(context.id))) reuse(context);
    }
    for (const edge of workflow.edges) if (edge.target === node.id) {
      const parent = workflow.nodes.find((item) => item.id === edge.source);
      if (reusableNodeRun(sourceById.get(parent.id))) reuse(parent);
    }
    if (node.type === 'generate') {
      const layout = optional(workflow, node, 'layout');
      if (layout && reusableNodeRun(sourceById.get(layout.id))) reuse(layout);
      const storyboard = prerequisite(workflow, node, 'storyboard');
      const sceneProducer = layout && (selected.has(layout.id) || reusableNodeRun(sourceById.get(layout.id))) && !ancestors(workflow.edges, storyboard.id).has(layout.id) ? layout : storyboard;
      const superseded = ancestors(workflow.edges, sceneProducer.id);
      for (const id of ancestors(workflow.edges, node.id)) {
        const producer = workflow.nodes.find((item) => item.id === id);
        const prior = sourceById.get(id);
        if (producer.type === 'generate' && !superseded.has(id) && (reusableNodeRun(prior) || prior?.generationIntent)) reuse(producer);
      }
    }
    if (node.type === 'render') {
      const storyboard = optional(workflow, node, 'storyboard');
      const layout = optional(workflow, node, 'layout');
      reuse(storyboard);
      reuse(layout);
      // Availability-aware, mirroring the generate branch above and prepareCandidate's generate
      // branch (execute()-side): a structurally later producer that is SKIPPED with no valid
      // saved output (or simply never ran) is omitted per docs/harness.md's "skipped optional
      // producers without output are omitted", never structurally preferred just because the
      // node exists in the graph. Neither producer is a HARD_DEPENDENCY of render, so nothing
      // earlier blocks this; the prior unconditional pick could select an unusable node and
      // only fail later, at execute() time inside renderCandidate (finding F3).
      const layoutUsable = layout && (selected.has(layout.id) || reusableNodeRun(sourceById.get(layout.id)));
      const storyboardUsable = storyboard && (selected.has(storyboard.id) || reusableNodeRun(sourceById.get(storyboard.id)));
      const sceneProducer = storyboardUsable && layoutUsable && ancestors(workflow.edges, storyboard.id).has(layout.id) ? storyboard : layoutUsable ? layout : storyboardUsable ? storyboard : null;
      const superseded = sceneProducer ? ancestors(workflow.edges, sceneProducer.id) : new Set();
      // Only generated inputs after the scene producer participate in this render.
      for (const id of ancestors(workflow.edges, node.id)) {
        const producer = workflow.nodes.find((item) => item.id === id);
        // A resumed render must retain its connected paid outputs, including failures
        // that need explicit recovery, rather than render the mutable saved episode.
        if (producer.type === 'generate' && !superseded.has(id) && (source || reusableNodeRun(sourceById.get(id)))) reuse(producer);
      }
    }
    if (node.type === 'publish') {
      const render = prerequisite(workflow, node, 'render');
      const review = prerequisite(workflow, node, 'review');
      const reviewRender = prerequisite(workflow, review, 'render');
      if (render.id !== reviewRender.id) throw new HttpError(409, 'Publish review belongs to a different render branch');
      if (orderedSelected.some((item) => ['storyboard', 'layout', 'generate', 'render', 'review'].includes(item.type))) throw new HttpError(409, 'Publish requires a separately approved existing candidate');
      const approved = nodeOutput(sourceById.get(review.id))?.review;
      const rendered = nodeOutput(sourceById.get(render.id));
      if (!source || nodeStatus(sourceById.get(review.id)) !== 'approved' || approved?.decision !== 'approved' || !rendered?.sha256 || approved.jobId !== rendered.jobId || approved.outputUrl !== rendered.outputUrl || approved.sha256 !== rendered.sha256) throw new HttpError(409, 'Publish requires the matching approved human review from a terminal run');
      requiredReuse.add(render.id);
    }
  }
  const outputs = new Map(), reusedOutputs = [];
  // Fetched once for the whole selection (not per node, not per lookup): resumingJob,
  // hasUnresolvedNodeJob's internal scan and inheritedJob below all resolve against these SAME
  // snapshots instead of each independently re-querying+re-parsing the full table. workflowRuns
  // rows are the fattest entity in the store (embedded workflowSnapshot/episodeSnapshot/
  // nodeRuns outputs/generationPlan candidate) so this hoist matters more than generationJobs'.
  const hasGenerateNode = workflow.nodes.some((item) => item.type === 'generate');
  const jobs = hasGenerateNode ? store.list('generationJobs') : null;
  const runs = hasGenerateNode ? store.list('workflowRuns') : null;
  const nodeRuns = ordered.map((node) => {
    const prior = sourceById.get(node.id);
    const reusable = !invalidated.has(node.id) && reusableNodeRun(prior);
    // Safe HEAD-semantics resume (never block) applies to exactly ONE job: the specific job
    // this call would itself inherit/resume when the node is NOT invalidated -- the identical
    // resolution `inheritedJob` below performs. A boolean "prior references some job" is NOT
    // sufficient grounds to skip the scan: prior can legitimately reference an already-SETTLED
    // job K while a different, OLDER job J for this same node sits unresolved in disconnected
    // run history (an earlier attempt whose own lineage was severed before K's run existed).
    // The scan must run unconditionally and must exempt ONLY that one literal resumed job --
    // never skip scanning merely because some reference exists.
    // No resumeId pattern-guess is passed here: `prior` must carry DIRECT evidence (its own
    // jobId or persisted intent.requestId) to be excluded from the unresolved-job scan below.
    // A stale, pointer-less placeholder (staleFrom only, left by an intermediate run that
    // invalidated-and-settled this node without itself submitting a job) must never borrow a
    // pattern guessed from ITS OWN resumedFrom/id -- that guess can coincidentally match an
    // unrelated job. Omitting it only ever WIDENS the scan below, never narrows it: it feeds
    // the exact same exclusion parameter the old guess fed, so this can only catch a job the
    // old guess would have missed, never hide one it would have caught (finding F1).
    const resumingJob = !invalidated.has(node.id) && node.type === 'generate' ? priorGenerationJob(jobs, prior, undefined, node.id) : null;
    const unsettled = node.type === 'generate' && hasUnresolvedNodeJob(runs, jobs, workflow.id, episode.id, node.id, undefined, resumingJob?.id);
    if (selected.has(node.id) && node.type === 'generate' && unsettled) { const error = new HttpError(409, GENERATION_UNRESOLVED_MESSAGE); error.code = 'generation_unresolved'; error.nodeId = node.id; throw error; }
    // Legacy raw selectedStages+resumeRunId bodies (no execution intent, contract 1.3) keep the
    // explicit "cannot rerun script/storyboard/layout while reusing a paid generation job"
    // guard reachable via a SEPARATE `guardJob` lookup below -- but generationIntent/output
    // persisted onto THIS node's own lineage are gated by `invalidated` UNCONDITIONALLY, for
    // every call shape, legacy or not. A node's own intent/output must never resurrect through
    // an intermediate run it wasn't selected in (addendum A); only the guard's reachability
    // for a node that IS selected this call is legacy-aware, never what gets persisted.
    const intent = (!invalidated.has(node.id) || unsettled) ? prior?.generationIntent : undefined;
    const jobId = nodeOutput(prior)?.generationJobId || intent?.generationJobId;
    // `directJob`: the ONLY resolution `inheritedJob` may use. Matches strictly by `prior`'s
    // OWN direct evidence -- its stamped jobId, or (the narrow crash-recovery window between
    // persisting intent and linking its job) its own persisted intent.requestId. NEVER guesses
    // a requestId pattern from a resume point: that guess is sound only for the separate legacy
    // strict-REJECT guard below (a false-positive guess there only blocks, forcing a fresh
    // quote), never for silently stamping a job reference onto output execute() will actually
    // try to resume -- the exact stale-stamp/fallback-mismatch that produced finding F1.
    const directJob = node.type !== 'generate' ? null : (jobId ? jobs.find((job) => job.id === jobId) || null : (intent?.requestId ? jobs.find((job) => job.requestId === intent.requestId) || null : null));
    // `inheritedJob`: what actually gets REUSED (paidReuse) and PERSISTED onto this node's
    // lineage.output -- gated by invalidated ONLY, unconditionally, matching addendum A: a
    // selected generate node invalidated by a co-selected ancestor is a fresh paid generation,
    // never a stale reuse, regardless of legacy. Sourced from `directJob` only -- see its
    // comment above for why the wider pattern-guessing `resolvedJob` below must never feed this.
    const inheritedJob = !invalidated.has(node.id) ? directJob : null;
    // `resolvedJob`: the wide, pattern-guessing lookup -- used ONLY as a last-resort fallback
    // inside `guardJob` below, for genuinely pre-intent legacy data (predates generationIntent
    // entirely: no jobId, no staleFrom chain for legacyAncestorJob to walk). Never feeds
    // paidReuse, lineage.output or lineage.generationIntent.
    const resolvedJob = source && node.type === 'generate' ? jobs.find((job) => jobId ? job.id === jobId : job.requestId === (intent?.requestId || `${source.resumedFrom || source.id}:${node.id}`)) : null;
    // `guardJob`: used ONLY to decide reachability of the explicit "cannot rerun
    // script/storyboard/layout" guard below, for a node that IS selected this call, on a
    // genuine raw legacy body. Deliberately separate from `inheritedJob` -- NEVER feeds
    // paidReuse, lineage.output or lineage.generationIntent, so it cannot leak a prior job
    // reference onto an unselected/invalidated/skipped/deferred node. Execution-intent-derived
    // calls (including this function's own internal dry-run validation) never set `legacy`,
    // so the guard can never fire for them -- those get a fresh paid generation instead.
    // Resolved by walking the REAL staleFrom pointer chain from `source` (legacyAncestorJob),
    // not a single-hop resumeId guess: an intermediate run that invalidates-and-settles this
    // node without itself touching it carries only {staleFrom}, so a guess computed from that
    // ONE run's own resumedFrom/id only coincidentally matches when the paying run sits exactly
    // one hop back or is the root (finding F6). `resolvedJob` remains the final fallback for
    // legacy data old enough to predate staleFrom itself.
    const guardJob = legacy && selected.has(node.id) && node.type === 'generate' && source ? (legacyAncestorJob(runs, jobs, source.id, node.id) || resolvedJob) : null;
    if (requiredReuse.has(node.id) && !selected.has(node.id) && ['storyboard', 'layout'].includes(node.type) && (!Array.isArray(nodeOutput(prior)?.scenes) || !nodeOutput(prior).scenes.length)) throw new HttpError(409, skipped.has(node.id) ? `${BLOCK_MESSAGES.skipped_prerequisite} (${node.id})` : `${node.id} requires completed scene evidence from its own branch`);
    if ((selected.has(node.id) || requiredReuse.has(node.id)) && node.type === 'generate' && reusable && (!nodeOutput(prior)?.generationJobId || !inheritedJob)) throw new HttpError(409, 'Completed generation is missing its original job identity; recover it before retrying');
    const paidReuse = selected.has(node.id) && node.type === 'generate' && reusable && inheritedJob?.applied && inheritedJob.status === 'completed';
    if (selected.has(node.id) && node.type === 'generate' && guardJob && orderedSelected.some((item) => ['script', 'storyboard', 'layout'].includes(item.type))) throw new HttpError(409, 'Cannot rerun script, storyboard or layout while reusing a paid generation job');
    if (paidReuse || (!selected.has(node.id) && requiredReuse.has(node.id) && reusable)) {
      outputs.set(node.id, nodeOutput(prior));
      reusedOutputs.push(node.id);
      return { ...prior, output: nodeOutput(prior), status: node.type === 'review' ? nodeStatus(prior) : 'completed', reused: true, reusedFrom: source.id, skipReason: undefined, error: undefined, retainedOutput: undefined, retainedStatus: undefined, retainedFrom: undefined, staleFrom: undefined };
    }
    if (requiredReuse.has(node.id) && !selected.has(node.id)) throw new HttpError(409, skipped.has(node.id) ? `${BLOCK_MESSAGES.skipped_prerequisite} (${node.id})` : `${node.id} requires completed prerequisite evidence from its own branch`);
    const lineage = {
      ...(!selected.has(node.id) && !invalidated.has(node.id) && nodeOutput(prior) ? { retainedOutput: nodeOutput(prior), retainedStatus: nodeStatus(prior), retainedFrom: source.id } : {}),
      ...(!selected.has(node.id) && invalidated.has(node.id) && reusableNodeRun(prior) ? { staleFrom: source.id } : !selected.has(node.id) && !reusableNodeRun(prior) && prior?.staleFrom ? { staleFrom: prior.staleFrom } : {}),
      ...(intent ? { generationIntent: intent } : {}),
      ...(inheritedJob ? { output: { ...nodeOutput(prior), generationJobId: inheritedJob.id } } : {}),
    };
    return { nodeId: node.id, type: node.type, status: selected.has(node.id) ? 'queued' : 'skipped', ...(selected.has(node.id) ? {} : skipped.has(node.id) ? { skipReason: 'user' } : { error: 'Node was not selected for this execution', skipReason: 'unselected' }), ...lineage };
  });
  return { selectedStages: orderedSelected.map((node) => node.id), startStage: start.id, source, nodeRuns, outputs, reusedOutputs };
}

function compatibleProvenance(workflow, episode, source) {
  return Boolean(source.workflowSnapshot) && source.workflowSnapshot.id === workflow.id
    && source.workflowSnapshot.version === workflow.version && source.workflowSnapshot.episodeId === episode.id
    && source.workflowSnapshot.channelId === episode.channelId && source.episodeSnapshot?.id === episode.id
    && source.episodeSnapshot?.channelId === episode.channelId && Array.isArray(source.nodeRuns)
    && canonicalJson(source.workflowSnapshot.nodes) === canonicalJson(workflow.nodes)
    && canonicalJson(source.workflowSnapshot.edges) === canonicalJson(workflow.edges)
    && new Set(source.nodeRuns.map((item) => item.nodeId)).size === source.nodeRuns.length
    && source.nodeRuns.every((item) => workflow.nodes.some((node) => node.id === item.nodeId && node.type === item.type));
}

function findResumeSource(store, workflow, episode) {
  return store.list('workflowRuns').find((run) => run.workflowId === workflow.id && run.episodeId === episode.id
    && run.workflowVersion === workflow.version && run.episodeVersion === episode.version && TERMINAL.includes(run.status)
    && compatibleProvenance(workflow, episode, run));
}

function validateExecution(raw) {
  const value = object(raw);
  const allowed = ['mode', 'targetNodeId', 'refresh'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new HttpError(400, 'Unknown execution field');
  const mode = choice(value.mode, ['node', 'all'], 'execution mode');
  if (mode === 'node') {
    if (value.refresh !== undefined) throw new HttpError(400, 'execution.refresh is not valid for mode "node"');
    return { mode, targetNodeId: identifier(value.targetNodeId, 'execution.targetNodeId'), refresh: false };
  }
  if (value.targetNodeId !== undefined) throw new HttpError(400, 'execution.targetNodeId is not valid for mode "all"');
  if (value.refresh !== undefined && typeof value.refresh !== 'boolean') throw new HttpError(400, 'execution.refresh must be boolean');
  return { mode, targetNodeId: null, refresh: value.refresh === true };
}

/** Pure, store-reading only: never writes entities, records events or calls providers. The
 * selectedStages/resumeRunId it derives are dry-run validated through the exact same
 * stageSelection() that start()/_quote() use, so a plan can never diverge from what they accept. */
export function planExecution(store, workflow, episode, rawExecution) {
  const { mode, targetNodeId, refresh } = validateExecution(rawExecution);
  const skipped = skippedSet(workflow);
  const skippedNodeIds = [...skipped];
  const base = { mode, targetNodeId, refresh };
  const blockedResult = (blocked, completedNodeIds = [], nodes = []) => ({ ...base, blocked, selectedStages: [], resumeRunId: null, requiresGeneration: false, needsDecision: false, nothingToRun: false, completedNodeIds, staleNodeIds: [], skippedNodeIds, nodes });

  const activeRuns = store.list('workflowRuns').filter((run) => ['queued', 'running'].includes(run.status));
  if (activeRuns.some((run) => run.episodeId === episode.id) || activeRuns.length >= MAX_ACTIVE_RUNS) {
    return blockedResult({ code: 'active_run', message: BLOCK_MESSAGES.active_run });
  }

  let target = null;
  if (mode === 'node') {
    try { target = resolveStage(workflow, targetNodeId, 'target node'); }
    catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return blockedResult({ code: 'unknown_node', message: error.message });
    }
  }

  const source = refresh ? null : findResumeSource(store, workflow, episode);
  const sourceById = new Map((source?.nodeRuns || []).map((nodeRun) => [nodeRun.nodeId, nodeRun]));
  const ordered = orderedNodes(workflow);
  const completedNodeIds = ordered.filter((node) => !skipped.has(node.id) && reusableNodeRun(sourceById.get(node.id))).map((node) => node.id);

  const dirty = new Map();
  for (const node of ordered) {
    const parentIds = workflow.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source);
    const parentDirty = parentIds.some((parentId) => dirty.get(parentId));
    dirty.set(node.id, skipped.has(node.id) ? parentDirty : (mode === 'node' && node.id === target.id) || !reusableNodeRun(sourceById.get(node.id)) || parentDirty);
  }

  const isPublishTarget = mode === 'node' && target.type === 'publish';
  const neededSet = isPublishTarget ? new Set([target.id])
    : mode === 'node' ? new Set([...ancestors(workflow.edges, target.id), target.id])
    : new Set(ordered.filter((node) => node.type !== 'publish').map((node) => node.id));

  // selectedIds drives action 'run'; blockedId (when given) always wins, overriding even 'skip'.
  // Used both for the real attempted selection and, on any block, with selectedIds forced to []
  // (nothing actually ran) so the response's nodes[] agrees with its forced-empty selectedStages.
  const buildNodes = (selectedIds, blockedId) => {
    const selectedSet = new Set(selectedIds);
    const invalidated = invalidatedBySelection(workflow, selectedIds);
    return ordered.map((node) => {
      if (node.id === blockedId) return { nodeId: node.id, type: node.type, action: 'blocked', reason: '실행할 수 없습니다' };
      if (skipped.has(node.id)) return { nodeId: node.id, type: node.type, action: 'skip', reason: '건너뛰기 설정됨' };
      if (selectedSet.has(node.id)) return { nodeId: node.id, type: node.type, action: 'run', reason: '이번 실행에서 실행됩니다' };
      const reusable = reusableNodeRun(sourceById.get(node.id));
      if (neededSet.has(node.id)) return (reusable && !invalidated.has(node.id)) ? { nodeId: node.id, type: node.type, action: 'reuse', reason: '이전 실행 결과를 재사용합니다' } : { nodeId: node.id, type: node.type, action: 'idle', reason: '아직 실행되지 않았습니다' };
      if (reusable && invalidated.has(node.id)) return { nodeId: node.id, type: node.type, action: 'stale', reason: '상위 노드가 다시 실행되어 갱신이 필요합니다' };
      if (reusable) return { nodeId: node.id, type: node.type, action: 'keep', reason: '이번 실행과 무관하게 유지됩니다' };
      return { nodeId: node.id, type: node.type, action: 'idle', reason: '아직 실행되지 않았습니다' };
    });
  };

  if (mode === 'node' && skipped.has(target.id)) {
    return blockedResult({ code: 'skipped_target', message: BLOCK_MESSAGES.skipped_target }, completedNodeIds, buildNodes([], target.id));
  }

  const selectedStages = isPublishTarget ? [target.id]
    : ordered.filter((node) => neededSet.has(node.id) && !skipped.has(node.id) && node.type !== 'publish' && dirty.get(node.id)).map((node) => node.id);

  const nodes = buildNodes(selectedStages, null);
  const selectionInvalidated = invalidatedBySelection(workflow, selectedStages);
  const staleNodeIds = ordered.filter((node) => !selectedStages.includes(node.id) && selectionInvalidated.has(node.id) && reusableNodeRun(sourceById.get(node.id))).map((node) => node.id);
  const needsDecision = mode === 'all' && !refresh && completedNodeIds.length > 0;

  if (!selectedStages.length) {
    return { ...base, blocked: false, selectedStages: [], resumeRunId: source ? source.id : null, requiresGeneration: false, needsDecision, nothingToRun: true, completedNodeIds, staleNodeIds: [], skippedNodeIds, nodes };
  }

  try {
    stageSelection(workflow, { selectedStages, resumeRunId: source ? source.id : NO_RESUME }, episode, store);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (isPublishTarget) return blockedResult({ code: 'publish_requires_review', message: BLOCK_MESSAGES.publish_requires_review }, completedNodeIds, buildNodes([], target.id));
    if (error.code === 'generation_unresolved') return blockedResult({ code: 'generation_unresolved', message: error.message }, completedNodeIds, buildNodes([], error.nodeId));
    const isSkippedPrerequisite = error.message.startsWith(BLOCK_MESSAGES.skipped_prerequisite);
    const blockedId = isSkippedPrerequisite ? (/\(([^()]+)\)$/.exec(error.message)?.[1] ?? null) : (mode === 'node' ? target.id : null);
    return blockedResult({ code: isSkippedPrerequisite ? 'skipped_prerequisite' : 'invalid_selection', message: error.message }, completedNodeIds, buildNodes([], blockedId));
  }

  return {
    ...base, blocked: false, selectedStages, resumeRunId: source ? source.id : null,
    requiresGeneration: selectedStages.some((id) => workflow.nodes.find((node) => node.id === id)?.type === 'generate'),
    needsDecision, nothingToRun: false, completedNodeIds, staleNodeIds, skippedNodeIds, nodes,
  };
}


function assertVersions(workflow, episode, options) {
  for (const [name, current] of [['expectedWorkflowVersion', workflow.version], ['expectedEpisodeVersion', episode.version]]) {
    if (options[name] === undefined) continue;
    if (!Number.isInteger(options[name]) || options[name] < 1) throw new HttpError(400, `${name} must be a positive integer`);
    if (options[name] !== current) throw new HttpError(409, 'Project changed since approval. Refresh and quote the current version.');
  }
}

function assertOwnership(store, workflow, episode) {
  store.assertEpisodeActive(episode.id);
  if (workflow.episodeId !== episode.id || workflow.channelId !== episode.channelId || !workflow.templateId || !Number.isInteger(workflow.templateVersion)) throw new HttpError(409, 'Execution requires a project-owned workflow copy for this exact episode and channel');
  store.get('channels', episode.channelId);
  for (const node of workflow.nodes) if (node.type === 'publish' && node.config.channelId && node.config.channelId !== episode.channelId) throw new HttpError(409, 'Publish destination differs from the project channel');
}

function checkDisclosure(disclosure) {
  if (!disclosure || typeof disclosure.containsSyntheticMedia !== 'boolean' || typeof disclosure.rationale !== 'string' || !disclosure.rationale.trim() || disclosure.rationale.length > 2000) throw new HttpError(400, 'Generation requires an explicit human-reviewed disclosure decision and rationale');
}

function normalizeCandidate(candidate, quotedNodes) {
  for (const node of candidate.nodes) {
    const schema = quotedNodes?.find((item) => item.nodeId === node.nodeId)?.schema;
    if (!schema) continue;
    let checked;
    try { checked = validateGenerationInput(schema, { ...(node.params || {}), prompt: node.prompt }); }
    catch { throw new HttpError(409, 'Generation input changed. Obtain a fresh quote.'); }
    const { prompt, ...params } = checked;
    node.prompt = prompt;
    node.params = params;
  }
  if (quotedNodes) candidate.estimates = estimateSnapshot(quotedNodes);
  return candidate;
}

function normalizedSceneInput(scene) {
  const { sceneId, slots, trimEnd, source, assetUrl, audioUrl, ...rawScene } = scene;
  return scenes([{
    ...rawScene,
    ...(assetUrl ? { assetUrl } : {}), ...(audioUrl ? { audioUrl } : {}),
    ...(source ? { source } : {}), ...(trimEnd !== null && trimEnd !== undefined ? { trimEnd } : {}),
    ...(slots?.length ? { slots: slots.map(({ slotId, source: slotSource, trimEnd: slotTrimEnd, assetUrl: slotAssetUrl, ...slot }) => ({
      ...slot, ...(slotAssetUrl ? { assetUrl: slotAssetUrl } : {}), ...(slotSource ? { source: slotSource } : {}),
      ...(slotTrimEnd !== null && slotTrimEnd !== undefined ? { trimEnd: slotTrimEnd } : {}),
    })) } : {}),
  }])[0];
}

function nodeInput(candidate, nodeId) {
  const node = candidate.nodes.find((item) => item.nodeId === nodeId);
  if (!node) throw new HttpError(409, 'Selected node is absent from the approved generation plan');
  const scene = candidate.scenes.find((item) => item.sceneId === node.sceneId);
  if (!scene) throw new HttpError(409, 'Approved target scene is unavailable');
  const targetScene = normalizedSceneInput(scene);
  if (node.slotId) {
    const slot = targetScene.slots?.find((item) => item.id === node.slotId);
    if (!slot) throw new HttpError(409, 'Approved target slot is unavailable');
    // Job identity binds the exact target plus every shared scene field. Sibling
    // slots have separate approved jobs and must not invalidate this job on apply.
    // The whole candidate still binds ALL slots, sources and assets at quote/start;
    // version checks and full-plan asset verification remain active before spending.
    targetScene.slots = [slot];
  }
  return { nodeId, sceneId: node.sceneId, ...(node.slotId ? { slotId: node.slotId } : {}), model: node.model, prompt: node.prompt, params: node.params || {}, scene: targetScene, assets: (candidate.assets || []).filter((asset) => asset.sceneId === node.sceneId && (!node.slotId || !asset.slotId || asset.slotId === node.slotId)) };
}

function storedNewsArticles(store, config) {
  const storedTrends = store.list('trends').filter((item) => item.keyword && item.source && item.source !== 'unknown' && safeHttpUrl(item.url));
  return config.source === 'google_news'
    ? []
    : storedTrends.slice(0, (config.maxArticles ?? 5)).map((item) => ({
      id: `trend-${item.id || createHash('sha256').update(`${item.url}:${item.keyword}`).digest('hex').slice(0, 16)}`,
      keyword: item.keyword,
      headline: item.title || item.keyword,
      source: item.source,
      url: safeHttpUrl(item.url),
      ...(item.summary ? { summary: item.summary } : {}),
      capturedAt: item.capturedAt || timestamp(),
      evidence: { source: item.source, url: safeHttpUrl(item.url) },
    }));
}

function layoutScenes(episode, config, newsOutput) {
  const preset = config.preset || 'top-image-mid-video';
  return episode.scenes.map((scene, index) => {
    const headline = newsOutput?.articles?.[index]?.headline || newsOutput?.articles?.[0]?.headline || scene.title || episode.title;
    let slots = Array.isArray(scene.slots) && scene.slots.length ? structuredClone(scene.slots) : createPresetSlots(preset === 'premiere-3tier' ? 'premiere-3tier' : 'top-image-mid-video', { ...scene, title: headline });
    slots = slots.map((slot) => slot.assetUrl && slot.assetUrl === scene.assetUrl && !slot.source && scene.source ? { ...slot, source: scene.source } : slot);
    if (config.enableSubtitles === false) slots = slots.filter((slot) => slot.role !== 'subtitle-layer');
    if (config.enableHtmlOverlay === false) slots = slots.filter((slot) => slot.role !== 'html-overlay');
    if (config.autoPrompts !== false) {
      slots = slots.map((slot) => {
        if (slot.role === 'image-gen') return { ...slot, prompt: slot.prompt || `${headline} · ${episode.topic} 상단 인포그래픽 이미지` };
        if (slot.role === 'video-bg') return { ...slot, prompt: slot.prompt || `${scene.text || episode.topic} · 시네마틱 배경 영상 연출 (Higgsfield)` };
        return slot;
      });
    }
    return {
      ...scene,
      layout: preset === 'premiere-3tier' ? 'premiere-3tier' : 'top-image-mid-video',
      slots,
    };
  });
}

function estimateSnapshot(nodes) {
  return nodes.map(({ nodeId, quoted, cost, currency }) => ({ nodeId, quoted, cost, currency }));
}

/** Review nodes that genuinely gate THIS run's aggregate status: directly selected, or the
 * exact review a selected publish node's HARD_DEPENDENCY prerequisite resolves to (publish is
 * the only node type that hard-depends on review -- HARD_DEPENDENCY.publish === 'review', so
 * this generalizes to any future type with the same mapping, not just 'publish' by name).
 * Deliberately excludes a review pulled in only by the generic edge-parent reuse loop (e.g. a
 * render node whose direct graph parent happens to be a review in a review->render revision
 * chain) -- that reuse is real data lineage (preserved, untouched by this function), not
 * evidence this run required or produced a human decision. Pure: derived on demand from the
 * immutable workflowSnapshot + this run's own already-persisted selectedStages, so it needs no
 * new stored field, no migration and is safe to re-derive for any run at any later time -- old
 * runs compute identically to new ones. A selected publish node's hard-dependency chain was
 * already proven resolvable once by stageSelection at run-creation time, so resolving it again
 * here against the same unchanged snapshot cannot throw. */
function hardRequiredReviewIds(workflow, selectedStages) {
  return hardRequiredIds(workflow?.nodes || [], workflow?.edges || [], selectedStages, HARD_DEPENDENCY, 'review');
}

function reviewStatus(nodeRuns, workflow, selectedStages) {
  const relevant = new Set([...(selectedStages || []), ...hardRequiredReviewIds(workflow, selectedStages)]);
  const reviews = nodeRuns.filter((node) => node.type === 'review' && node.status !== 'skipped' && relevant.has(node.nodeId));
  if (!reviews.length) return 'completed';
  if (reviews.some((node) => !['approved', 'changes_requested'].includes(node.status))) return 'awaiting_review';
  return reviews.some((node) => node.status === 'changes_requested') ? 'changes_requested' : 'approved';
}

export class WorkflowEngine {
  constructor({ store, fetchTrends, runAgent, render, validateAssets, generations, platformSessions, publication, fetchImpl = fetch }) {
    this.store = store;
    this.fetchTrends = fetchTrends;
    this.fetchImpl = fetchImpl;
    this.runAgent = runAgent;
    this.render = render;
    this.validateAssets = validateAssets;
    this.generations = generations;
    this.publication = publication;
    this.closed = false;
    this.activeExecutions = new Map();
    this.activeQuoteEpisodes = new Map();
    if (!store.list('workflows').length) store.create('workflows', defaultWorkflow());
    for (const run of store.list('workflowRuns')) if (['queued', 'running'].includes(run.status)) {
      store.save('workflowRuns', { ...run, status: 'failed', error: 'Server restarted before workflow completed', updatedAt: timestamp(), nodeRuns: run.nodeRuns.map((node) => ['running', 'queued'].includes(node.status) ? { ...node, status: 'failed', error: 'Execution interrupted by server restart' } : node) });
    }
  }

  create(body) {
    if (['episodeId', 'channelId', 'templateId', 'templateVersion'].some((field) => field in object(body))) throw new HttpError(400, 'Create project-owned workflows through the template copy API');
    return this.store.create('workflows', { ...validateWorkflow(body), version: 1, sample: false });
  }
  update(id, body) {
    const previous = this.store.get('workflows', id);
    for (const field of ['episodeId', 'channelId', 'templateId', 'templateVersion']) if (field in object(body) && body[field] !== previous[field]) throw new HttpError(400, `${field} is immutable on a project workflow`);
    return this.store.updateWorkflow(id, validateWorkflow(body), body.expectedVersion);
  }
  listRuns(id) { this.store.get('workflows', id); return this.store.list('workflowRuns').filter((run) => run.workflowId === id); }

  copy(templateId, body) { return this.store.createWorkflowCopy({ ...object(body), templateId }); }

  rollup(id, body) {
    const options = object(body);
    if (Object.keys(options).some((key) => !['expectedWorkflowVersion', 'expectedTemplateVersion'].includes(key))) throw new HttpError(400, 'Rollup accepts only the expected workflow and template versions');
    return this.store.rollupWorkflow(id, options, portableRollup);
  }

  plan(id, episodeId, body = {}) {
    const workflow = this.store.get('workflows', id);
    validateWorkflow(workflow);
    const episode = this.store.get('episodes', text(episodeId, 'episodeId', 80));
    assertOwnership(this.store, workflow, episode);
    assertVersions(workflow, episode, body);
    return this.resolveExecution(workflow, episode, body.execution);
  }

  /** Pure over store reads; never writes entities, records events or calls providers. Base plan
   * from planExecution(); if it requires generation and the REAL prepareCandidate (same function
   * _quote()/start() use, never duplicated) would reject the full selection, derive the free
   * preparatory prefix (selected minus any generate node and minus any selected descendant of a
   * selected generate node) and defer the rest -- so plan()/_quote()/start() always agree. */
  resolveExecution(workflow, episode, rawExecution) {
    const plan = planExecution(this.store, workflow, episode, rawExecution);
    if (plan.blocked || plan.nothingToRun || !plan.requiresGeneration) return { ...plan, deferredStages: [], notice: '' };
    let selection;
    try {
      selection = stageSelection(workflow, { selectedStages: plan.selectedStages, resumeRunId: plan.resumeRunId ?? NO_RESUME }, episode, this.store);
      this.prepareCandidate(workflow, episode, { selectedStages: plan.selectedStages }, selection);
      return { ...plan, deferredStages: [], notice: '' };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.code !== 'prepare_required') {
        const blockedNodeId = plan.mode === 'node' ? plan.targetNodeId : null;
        return {
          ...plan, blocked: { code: 'invalid_selection', message: error.message },
          selectedStages: [], resumeRunId: null, requiresGeneration: false, needsDecision: false, nothingToRun: false, staleNodeIds: [], deferredStages: [], notice: '',
          nodes: plan.nodes.map((entry) => entry.nodeId === blockedNodeId ? { ...entry, action: 'blocked', reason: '실행할 수 없습니다' } : entry.action === 'run' ? { ...entry, action: 'idle', reason: '아직 실행되지 않았습니다' } : entry),
        };
      }
    }
    const deferred = new Set();
    for (const id of plan.selectedStages) {
      const node = workflow.nodes.find((item) => item.id === id);
      if (node.type === 'generate' || [...ancestors(workflow.edges, id)].some((ancestorId) => deferred.has(ancestorId))) deferred.add(id);
    }
    const prefix = plan.selectedStages.filter((id) => !deferred.has(id));
    const deferredStages = plan.selectedStages.filter((id) => deferred.has(id));
    const emptyPrefixBlocked = { ...plan, blocked: { code: 'invalid_selection', message: PREPARE_FIRST_EMPTY_MESSAGE }, selectedStages: [], resumeRunId: null, requiresGeneration: false, needsDecision: false, nothingToRun: false, staleNodeIds: [], nodes: [], deferredStages: [], notice: '' };
    if (!prefix.length) return emptyPrefixBlocked;
    let prefixSelection;
    try {
      prefixSelection = stageSelection(workflow, { selectedStages: prefix, resumeRunId: plan.resumeRunId ?? NO_RESUME }, episode, this.store);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return { ...plan, blocked: { code: 'invalid_selection', message: error.message }, selectedStages: [], resumeRunId: null, requiresGeneration: false, needsDecision: false, nothingToRun: false, staleNodeIds: [], nodes: [], deferredStages: [], notice: '' };
    }
    const prefixStaleIds = new Set(prefixSelection.nodeRuns.filter((nodeRun) => nodeRun.staleFrom).map((nodeRun) => nodeRun.nodeId));
    return {
      ...plan, selectedStages: prefix, requiresGeneration: false, deferredStages, notice: PREPARE_FIRST_NOTICE,
      staleNodeIds: [...prefixStaleIds],
      nodes: plan.nodes.map((entry) => deferred.has(entry.nodeId)
        ? (prefixStaleIds.has(entry.nodeId) ? { ...entry, action: 'stale', reason: '상위 노드가 다시 실행되어 갱신이 필요합니다' } : { ...entry, action: 'idle', reason: '준비 단계 이후 다시 실행됩니다' })
        : entry),
    };
  }

  deriveSelection(workflow, episode, options) {
    // `legacy:true` is set HERE only (never spread from `options`/client body -- app.mjs's
    // route allow-lists plus this literal return mean a client-supplied `legacy` field can
    // never survive into stageSelection). Keep it a fresh literal; do not "simplify" this into
    // `{ ...options, legacy: true }`, which would let a client request override it.
    if (options.execution === undefined) return { selectedStages: options.selectedStages, startStage: options.startStage, resumeRunId: options.resumeRunId, execution: undefined, legacy: true, deferredStages: [], notice: '' };
    if (['selectedStages', 'startStage', 'resumeRunId'].some((key) => options[key] !== undefined)) throw new HttpError(400, 'execution cannot be combined with selectedStages, startStage or resumeRunId');
    const plan = this.resolveExecution(workflow, episode, options.execution);
    if (plan.blocked) { const error = new HttpError(409, plan.blocked.message); error.code = plan.blocked.code; throw error; }
    if (plan.nothingToRun) { const error = new HttpError(409, NOTHING_TO_RUN_MESSAGE); error.code = 'nothing_to_run'; throw error; }
    return { selectedStages: plan.selectedStages, startStage: undefined, resumeRunId: plan.resumeRunId ?? NO_RESUME, execution: { mode: plan.mode, targetNodeId: plan.targetNodeId, refresh: plan.refresh }, deferredStages: plan.deferredStages, notice: plan.notice };
  }

  async quote(id, episodeId, options = {}) {
    const targetId = text(episodeId, 'episodeId', 80);
    this.activeQuoteEpisodes.set(targetId, (this.activeQuoteEpisodes.get(targetId) || 0) + 1);
    try { return await this._quote(id, targetId, options); }
    finally {
      const remaining = this.activeQuoteEpisodes.get(targetId) - 1;
      if (remaining) this.activeQuoteEpisodes.set(targetId, remaining);
      else this.activeQuoteEpisodes.delete(targetId);
    }
  }

  async _quote(id, episodeId, options = {}) {
    const workflow = this.store.get('workflows', id);
    validateWorkflow(workflow);
    const episode = this.store.get('episodes', text(episodeId, 'episodeId', 80));
    assertOwnership(this.store, workflow, episode);
    assertVersions(workflow, episode, options);
    const derivedQuote = this.deriveSelection(workflow, episode, options);
    const selection = stageSelection(workflow, derivedQuote, episode, this.store);
    const hasGeneration = selection.selectedStages.some((nodeId) => workflow.nodes.find((node) => node.id === nodeId).type === 'generate');
    if (hasGeneration) checkDisclosure(options.disclosure);
    const { verifyCandidateAssets } = candidates;
    const { candidate, preparedStages } = this.prepareCandidate(workflow, episode, { ...options, selectedStages: selection.selectedStages }, selection);
    await verifyCandidateAssets(this.store, candidate);
    const nodes = [];
    const provider = this.generations?.provider;
    for (const node of candidate.nodes) {
      assertOwnership(this.store, workflow, episode);
      let input = { model: node.model, prompt: node.prompt, params: node.params || {} };
      // Validate against the same schema used by the submission queue. Missing schema
      // availability cannot be silently replaced by invented defaults.
      let schema;
      if (provider?.modelSchema) {
        try { schema = await provider.modelSchema(node.model); }
        catch { throw new HttpError(503, 'Generation model schema is unavailable'); }
        if (!['image', 'video'].includes(schema?.type)) throw new HttpError(422, 'Only image and video models can be attached to a candidate');
        const slot = node.slotId ? candidate.scenes.find((scene) => scene.sceneId === node.sceneId)?.slots?.find((item) => item.id === node.slotId) : null;
        if (slot && slot.role !== (schema.type === 'image' ? 'image-gen' : 'video-bg')) throw new HttpError(422, 'Generation model media type differs from the selected slot role');
        let normalized;
        try { normalized = validateGenerationInput(schema, { ...input.params, prompt: input.prompt }); }
        catch { throw new HttpError(422, 'Generation input does not match the model schema'); }
        const { prompt, ...params } = normalized;
        node.prompt = prompt;
        node.params = params;
        input = { model: node.model, prompt, params };
      }
      let estimate = null;
      assertOwnership(this.store, workflow, episode);
      try { if (provider?.estimate) estimate = await provider.estimate(input); } catch { /* explicit unquoted estimate below */ }
      const cost = estimate?.cost ?? estimate?.usd;
      const currency = typeof estimate?.currency === 'string' && estimate.currency.trim() ? estimate.currency : (estimate?.cost === undefined && estimate?.usd !== undefined ? 'USD' : null);
      const quoted = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && currency !== null;
      nodes.push({ ...node, ...(schema ? { schema } : {}), quoted, cost: quoted ? cost : null, currency: quoted ? currency : null, estimate: quoted ? estimate : null, ...(!quoted ? { estimateStatus: 'unavailable' } : {}) });
    }
    candidate.estimates = estimateSnapshot(nodes);
    const currencies = new Set(nodes.filter((node) => node.quoted).map((node) => node.currency));
    const totalCost = nodes.reduce((sum, node) => sum + (node.quoted ? node.cost : 0), 0);
    const quoted = nodes.every((node) => node.quoted) && currencies.size <= 1 && Number.isFinite(totalCost);
    const aggregate = { quoted, totalCost: quoted ? totalCost : null, currency: quoted && currencies.size ? [...currencies][0] : null, ...(!quoted ? { reason: currencies.size > 1 ? 'mixed_currencies' : 'estimate_unavailable' } : {}) };
    // Provider/schema awaits may race an edit. Persist no apparently current stale quote.
    assertVersions(this.store.get('workflows', id), this.store.get('episodes', episode.id), { expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version });
    return this.store.create('generationPlans', {
      workflowId: id, episodeId: episode.id, channelId: episode.channelId,
      workflowVersion: workflow.version, episodeVersion: episode.version,
      selectedStages: selection.selectedStages, startStage: selection.startStage,
      ...(selection.source ? { resumeRunId: selection.source.id } : {}),
      candidate, preparedStages, fingerprint: candidateFingerprint(candidate), nodes, aggregate,
      disclosure: options.disclosure, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      deferredStages: derivedQuote.deferredStages, notice: derivedQuote.notice,
    });
  }

  start(id, episodeId, options = {}) {
    const { allowGeneration = false } = options;
    if (this.closed) throw new HttpError(503, 'Workflow service is stopping');
    const workflow = this.store.get('workflows', id);
    validateWorkflow(workflow);
    const episode = this.store.get('episodes', text(episodeId, 'episodeId', 80));
    assertOwnership(this.store, workflow, episode);
    assertVersions(workflow, episode, options);
    const derived = this.deriveSelection(workflow, episode, options);
    const plan = stageSelection(workflow, derived, episode, this.store);
    let generationPlan;
    if (plan.selectedStages.some((nodeId) => workflow.nodes.find((node) => node.id === nodeId)?.type === 'generate')) {
      if (allowGeneration !== true) throw new HttpError(400, 'Paid generation requires explicit allowGeneration');
      checkDisclosure(options.disclosure);
      if (!this.generations) throw new HttpError(503, 'Higgsfield generation is unavailable');
      if (!options.generationPlanId) throw new HttpError(400, 'Generation requires a persisted exact-input quote');
      generationPlan = this.store.get('generationPlans', identifier(options.generationPlanId, 'generationPlanId'));
      const { candidate: currentCandidate } = this.prepareCandidate(workflow, episode, { ...options, selectedStages: plan.selectedStages }, plan);
      const candidate = normalizeCandidate(currentCandidate, generationPlan.nodes);
      if (generationPlan.workflowId !== id || generationPlan.episodeId !== episode.id || generationPlan.channelId !== episode.channelId || generationPlan.workflowVersion !== workflow.version || generationPlan.episodeVersion !== episode.version || generationPlan.resumeRunId !== plan.source?.id || canonicalJson(generationPlan.selectedStages) !== canonicalJson(plan.selectedStages) || generationPlan.startStage !== plan.startStage || !Number.isFinite(Date.parse(generationPlan.expiresAt)) || Date.parse(generationPlan.expiresAt) <= Date.now() || generationPlan.fingerprint !== options.generationFingerprint || generationPlan.fingerprint !== candidateFingerprint(generationPlan.candidate) || generationPlan.fingerprint !== candidateFingerprint(candidate) || canonicalJson(generationPlan.disclosure) !== canonicalJson(options.disclosure)) throw new HttpError(409, 'Generation approval is stale or differs from the selected candidate. Obtain a fresh quote.');
      if (!generationPlan.aggregate?.quoted && options.acceptUnquotedEstimate !== true) throw new HttpError(400, 'Unknown generation cost requires explicit acceptUnquotedEstimate');
      for (const nodeRun of plan.nodeRuns) if (nodeRun.generationIntent && plan.selectedStages.includes(nodeRun.nodeId)) {
        const accepted = nodeRun.reused ? nodeRun.generationIntent.resultFingerprint : nodeRun.generationIntent.inputFingerprint;
        if (accepted !== candidateFingerprint(nodeInput(candidate, nodeRun.nodeId))) throw new HttpError(409, 'The original paid node input changed. Recover its existing output without resubmitting.');
      }
      if (generationPlan.nodes.length !== candidate.nodes.length || generationPlan.nodes.some((node) => !candidate.nodes.some((item) => item.nodeId === node.nodeId))) throw new HttpError(409, 'The quote must approve every selected generation node');
    }
    const active = this.store.list('workflowRuns').filter((run) => ['queued', 'running'].includes(run.status));
    if (active.some((run) => run.episodeId === episode.id)) throw new HttpError(409, 'This episode already has an active workflow');
    if (active.length >= MAX_ACTIVE_RUNS) throw new HttpError(429, 'Workflow execution limit reached');
    const run = this.store.create('workflowRuns', {
      workflowId: id, workflowVersion: workflow.version, workflowSnapshot: workflow,
      episodeId: episode.id, episodeVersion: episode.version, episodeSnapshot: episode, status: 'queued',
      selectedStages: plan.selectedStages, startStage: plan.startStage,
      ...(plan.source ? { resumedFrom: plan.source.id } : {}), reusedOutputs: plan.reusedOutputs, ...(derived.execution ? { execution: derived.execution } : {}),
      ...(generationPlan ? { generationPlanId: generationPlan.id, generationFingerprint: generationPlan.fingerprint, generationPlan } : {}),
      nodeRuns: plan.nodeRuns,
    });
    setImmediate(() => this.execute(run.id));
    return run;
  }

  cancel(workflowId, id) {
    const run = this.store.get('workflowRuns', id);
    if (run.workflowId !== workflowId) throw new HttpError(404, 'Workflow run not found');
    if (TERMINAL.includes(run.status)) throw new HttpError(409, 'Workflow run is already terminal');
    const next = { ...run, status: 'cancelled', updatedAt: timestamp(), cancellation: 'Stops subsequent stages; an already running provider request or renderer may finish.', nodeRuns: run.nodeRuns.map((node) => ['queued', 'running'].includes(node.status) ? { ...node, status: 'cancelled' } : node) };
    this.store.save('workflowRuns', next);
    this.store.record('workflow.cancelled', { entityId: workflowId, runId: id });
    return next;
  }

  async review(workflowId, runId, body) {
    object(body);
    const reviewNodeId = identifier(body.reviewNodeId, 'reviewNodeId');
    const decision = choice(body.decision, ['approved', 'changes_requested'], 'review decision');
    if (typeof body.notes !== 'string') throw new HttpError(400, 'Review notes must be text');
    const notes = optionalText(body.notes, 'review notes', 10000);
    const expectedEpisodeVersion = body.expectedEpisodeVersion;
    if (!Number.isInteger(expectedEpisodeVersion) || expectedEpisodeVersion < 1) throw new HttpError(400, 'Review requires a positive expectedEpisodeVersion');
    const run = this.store.get('workflowRuns', runId);
    if (run.workflowId !== workflowId) throw new HttpError(404, 'Workflow run not found');
    if (run.status !== 'awaiting_review') throw new HttpError(409, 'Review requires a finished execution awaiting human review');
    const { job, render } = this.store.reviewCandidate(workflowId, runId, reviewNodeId, expectedEpisodeVersion);
    if (!/^\/api\/exports\/[a-zA-Z0-9_-]+\.mp4$/.test(job.outputUrl)) throw new HttpError(409, 'Render candidate has an invalid artifact path');
    let file;
    let sha256;
    try {
      const exportRoot = await realpath(path.join(this.store.dataDir, 'exports'));
      const requested = path.join(exportRoot, job.outputUrl.split('/').pop());
      const metadata = await lstat(requested);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new HttpError(409, 'Rendered artifact is not a regular file');
      const filename = await realpath(requested);
      if (path.dirname(filename) !== exportRoot) throw new HttpError(409, 'Rendered artifact is outside the export directory');
      file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const before = await file.stat();
      if (!before.isFile() || !before.size) throw new HttpError(409, 'Rendered artifact is empty or unavailable');
      const digest = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
      const after = await file.stat();
      const current = await lstat(requested);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.size !== current.size || before.mtimeMs !== current.mtimeMs || current.isSymbolicLink()) throw new HttpError(409, 'Rendered artifact changed while it was being verified');
      sha256 = digest.digest('hex');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, 'Rendered artifact is unavailable for review');
    } finally { await file?.close(); }
    if ((job.sha256 && job.sha256 !== sha256) || (render.output.sha256 && render.output.sha256 !== sha256)) throw new HttpError(409, 'Rendered artifact hash does not match the completed candidate');
    const episode = this.store.assertEpisodeActive(run.episodeId);
    if (episode.music || job.musicSnapshot || render.output.musicSnapshot || job.musicIntegrity || job.verifiedMusicIntegrity || render.output.verifiedMusicIntegrity) {
      if (!episode.music || !job.musicSnapshot || !render.output.musicSnapshot
        || canonicalJson(episode.music) !== canonicalJson(job.musicSnapshot) || canonicalJson(episode.music) !== canonicalJson(render.output.musicSnapshot)
        || !job.musicIntegrity || !job.verifiedMusicIntegrity || !render.output.verifiedMusicIntegrity
        || canonicalJson(job.musicIntegrity) !== canonicalJson(job.verifiedMusicIntegrity) || canonicalJson(job.musicIntegrity) !== canonicalJson(render.output.verifiedMusicIntegrity)
        || !/^[a-f0-9]{64}$/.test(job.musicIntegrity.sha256 || '') || !Number.isSafeInteger(job.musicIntegrity.size) || job.musicIntegrity.size < 1 || job.musicIntegrity.size > 100 * 1024 * 1024
        || render.output.renderNodeId !== render.nodeId || render.output.episodeVersion !== episode.version
        || !Array.isArray(job.sceneSnapshot) || canonicalJson(job.sceneSnapshot) !== canonicalJson(render.output.sceneSnapshot ?? null)) throw new HttpError(409, 'Music render lineage is incomplete; a fresh render is required');
      const makeCandidate = () => candidates.candidateManifest(this.store, { ...this.store.assertEpisodeActive(run.episodeId), scenes: job.sceneSnapshot }, run.workflowSnapshot, { selectedStages: [render.nodeId] });
      const candidate = makeCandidate();
      candidates.verifySceneReceipts(job, render.output, candidate);
      const music = candidate.assets.filter((asset) => asset.use === 'music');
      const asset = music[0], source = episode.music.source;
      if (music.length !== 1 || asset.sha256 !== job.musicIntegrity.sha256 || asset.upload?.sha256 !== job.musicIntegrity.sha256
        || asset.upload?.size !== job.musicIntegrity.size || !asset.rights.some((right) => right.uploadId === asset.uploadId
          && right.sha256 === asset.sha256 && right.origin === source.origin && Number.isFinite(Date.parse(right.acknowledgedAt || ''))
          && Date.parse(right.acknowledgedAt) <= Date.now()
          && ['sourceUrl', 'licenseId', 'attribution'].every((key) => source[key] === undefined || source[key] === right[key])
          && (source.origin !== 'generated' || right.generationJobId === asset.upload.generationJobId))) throw new HttpError(409, 'Music requires matching registered bytes and explicit rights before review');
      await candidates.verifyCandidateAssets(this.store, candidate);
      const current = this.store.reviewCandidate(workflowId, runId, reviewNodeId, expectedEpisodeVersion);
      if (canonicalJson(current.job) !== canonicalJson(job) || canonicalJson(current.render) !== canonicalJson(render)
        || canonicalJson(makeCandidate()) !== canonicalJson(candidate)) throw new HttpError(409, 'Render evidence changed while preparing review');
    }
    const hasMedia = (scenes) => Array.isArray(scenes) && scenes.some((scene) => scene.assetUrl || scene.audioUrl || (scene.slots || []).some((slot) => slot.assetUrl));
    if (!episode.music && (hasMedia(episode.scenes) || hasMedia(job.sceneSnapshot) || hasMedia(render.output.sceneSnapshot)
      || job.sceneIntegrity !== undefined || job.verifiedSceneAssets !== undefined || render.output.verifiedSceneAssets !== undefined)) {
      if (!run.workflowSnapshot || !Array.isArray(job.sceneSnapshot) || canonicalJson(job.sceneSnapshot) !== canonicalJson(render.output.sceneSnapshot ?? null)) throw new HttpError(409, 'Scene render lineage is incomplete; a fresh render is required');
      const makeCandidate = () => candidates.candidateManifest(this.store, { ...this.store.assertEpisodeActive(run.episodeId), scenes: job.sceneSnapshot }, run.workflowSnapshot, { selectedStages: [render.nodeId] });
      const candidate = makeCandidate();
      candidates.verifySceneReceipts(job, render.output, candidate);
      await candidates.verifyCandidateAssets(this.store, candidate);
      const current = this.store.reviewCandidate(workflowId, runId, reviewNodeId, expectedEpisodeVersion);
      if (canonicalJson(current.job) !== canonicalJson(job) || canonicalJson(current.render) !== canonicalJson(render)
        || canonicalJson(makeCandidate()) !== canonicalJson(candidate)) throw new HttpError(409, 'Render evidence changed while preparing review');
    }
    return this.store.commitWorkflowReview(workflowId, runId, reviewNodeId, { decision, notes, expectedEpisodeVersion, jobId: job.id, outputUrl: job.outputUrl, sha256 });
  }

  current(id) {
    if (this.closed) return undefined;
    const run = this.store.get('workflowRuns', id);
    return run.status === 'cancelled' ? undefined : run;
  }

  nodeUpdate(id, nodeId, patch, runPatch = {}) {
    const run = this.current(id);
    if (!run) return;
    this.store.save('workflowRuns', { ...run, ...runPatch, updatedAt: timestamp(), nodeRuns: run.nodeRuns.map((node) => node.nodeId === nodeId ? { ...node, ...patch } : node) });
  }
  persistNode(id, nodeId, patch) {
    try {
      const run = this.store.get('workflowRuns', id);
      this.store.save('workflowRuns', { ...run, updatedAt: timestamp(), nodeRuns: run.nodeRuns.map((node) => node.nodeId === nodeId ? { ...node, ...patch } : node) });
      return true;
    } catch {
      // The store may already be closed during shutdown; provider recovery remains external.
      return false;
    }
  }

  candidate(workflow, episode, options) {
    const candidate = candidates.candidateManifest(this.store, episode, workflow, options);
    for (const input of candidate.nodes) {
      const node = workflow.nodes.find((item) => item.id === input.nodeId);
      const scene = episode.scenes.find((item) => item.id === input.sceneId);
      // Preserve the existing scene-targeted prompt convention, now frozen in the plan.
      // Explicit slot targets remain bound by their own stable slot ID.
      const promptSlot = input.slotId ? scene.slots?.find((slot) => slot.id === input.slotId) : scene.slots?.find((slot) => ['video-bg', 'image-gen'].includes(slot.role));
      input.prompt = node.config.prompt || promptSlot?.prompt || scene.text || episode.topic;
    }
    return candidate;
  }

  prepareCandidate(workflow, originalEpisode, options, selection) {
    let episode = originalEpisode;
    const outputs = new Map(selection.outputs);
    const selected = new Set(selection.selectedStages);
    const hasGeneration = [...selected].some((id) => workflow.nodes.find((node) => node.id === id)?.type === 'generate');
    const preparedStages = {};
    for (const node of orderedNodes(workflow)) {
      if (!selected.has(node.id)) continue;
      if (node.type === 'news' && node.config.source === 'trend_news') {
        outputs.set(node.id, { articles: storedNewsArticles(this.store, node.config) });
      } else if (node.type === 'script') {
        if (hasGeneration && node.config.agent !== 'existing') { const error = new HttpError(409, 'Prepare and save new script output before quoting paid generation'); error.code = 'prepare_required'; throw error; }
        outputs.set(node.id, { scenes: this.validateAssets(scenes(episode.scenes)) });
      } else if (node.type === 'storyboard' || node.type === 'layout') {
        if ([...ancestors(workflow.edges, node.id)].some((id) => selected.has(id) && workflow.nodes.find((item) => item.id === id).type === 'generate')) { const error = new HttpError(409, 'Prepare downstream scene edits separately before quoting generation'); error.code = 'prepare_required'; throw error; }
        let staged;
        if (node.type === 'storyboard') {
          staged = outputs.get(prerequisite(workflow, node, 'script').id)?.scenes;
          if (!staged) throw new HttpError(409, 'Prepare the connected script before quoting generation');
        } else {
          const storyboard = outputs.get(prerequisite(workflow, node, 'storyboard').id);
          if (!storyboard?.scenes) throw new HttpError(409, 'Prepare the connected storyboard before quoting its layout');
          const news = optional(workflow, node, 'news');
          const newsOutput = news ? outputs.get(news.id) : null;
          if (news && selected.has(news.id) && !newsOutput) throw new HttpError(409, 'Collect and save source news before quoting its derived layout');
          staged = layoutScenes({ ...episode, scenes: storyboard.scenes }, node.config, newsOutput);
        }
        const normalized = this.validateAssets(scenes(staged));
        episode = { ...episode, scenes: normalized };
        preparedStages[node.id] = normalized;
        outputs.set(node.id, { scenes: normalized });
      } else if (node.type === 'generate' && selection.selectedStages.includes(node.id)) {
        const storyboard = prerequisite(workflow, node, 'storyboard');
        const layout = optional(workflow, node, 'layout');
        const producer = layout && outputs.has(layout.id) && !ancestors(workflow.edges, storyboard.id).has(layout.id) ? layout : storyboard;
        let connectedScenes = outputs.get(producer.id)?.scenes;
        const upstream = ancestors(workflow.edges, node.id);
        const superseded = ancestors(workflow.edges, producer.id);
        const priorGenerations = selection.nodeRuns.filter((item) => item.type === 'generate' && item.reused && !superseded.has(item.nodeId) && (item.nodeId === node.id || upstream.has(item.nodeId)));
        for (const prior of priorGenerations) {
          if (!Array.isArray(connectedScenes)) throw new HttpError(409, 'Applied generation requires connected scene evidence');
          const output = prior.output;
          const job = this.generations.get(output?.generationJobId);
          const applied = output?.scene;
          const target = job.slotId ? applied?.slots?.find((slot) => slot.id === job.slotId) : applied;
          const receipt = job.outputs?.[0];
          if (!job.applied || job.status !== 'completed' || job.episodeId !== episode.id
            || job.sceneId !== output?.sceneId || job.appliedSceneId !== job.sceneId
            || (job.slotId || null) !== (output.slotId || null) || (job.appliedSlotId || null) !== (job.slotId || null)
            || !prior.generationIntent?.requestId || job.requestId !== prior.generationIntent.requestId
            || canonicalJson(output.outputs) !== canonicalJson(job.outputs) || applied?.id !== job.sceneId
            || !receipt || target?.assetUrl !== receipt.url || target?.source?.generationJobId !== job.id
            || target?.source?.sha256 !== receipt.sha256 || !connectedScenes.some((scene) => scene.id === job.sceneId)) {
            throw new HttpError(409, 'Applied generation has no matching node receipt');
          }
          connectedScenes = connectedScenes.map((scene) => {
            if (scene.id !== job.sceneId) return scene;
            if (job.slotId) {
              if (!scene.slots?.some((slot) => slot.id === job.slotId)) throw new HttpError(409, 'Applied generation slot no longer exists');
              return { ...scene, slots: scene.slots.map((slot) => slot.id === job.slotId ? { ...slot, assetUrl: target.assetUrl, mediaKind: target.mediaKind, source: target.source, trimStart: target.trimStart, trimEnd: target.trimEnd } : slot) };
            }
            return { ...scene, kind: applied.kind, assetUrl: applied.assetUrl, source: applied.source, trimStart: applied.trimStart, trimEnd: applied.trimEnd, ...(applied.kind === 'video' ? { duration: applied.duration } : {}) };
          });
        }
        const targetSceneId = node.config.sceneId || (node.config.sceneIndex !== undefined ? episode.scenes[node.config.sceneIndex]?.id : null);
        const targetSceneConnected = targetSceneId ? connectedScenes.find((s) => s.id === targetSceneId) : null;
        const targetSceneEpisode = targetSceneId ? episode.scenes.find((s) => s.id === targetSceneId) : null;
        const targetSceneDiffers = targetSceneConnected && targetSceneEpisode && canonicalJson(targetSceneConnected) !== canonicalJson(targetSceneEpisode);
        const wholeDiffers = !Array.isArray(connectedScenes) || canonicalJson(this.validateAssets(scenes(connectedScenes))) !== canonicalJson(this.validateAssets(scenes(episode.scenes)));
        if (targetSceneDiffers || (wholeDiffers && !targetSceneId)) {
          throw new HttpError(409, 'Save the connected scene branch before quoting generation');
        }
      }
    }
    const candidate = this.candidate(workflow, episode, options);
    // Bind both the saved starting point and every deterministic prepared scene snapshot.
    candidate.preparation = { episode: originalEpisode, stages: preparedStages };
    return { candidate, preparedStages };
  }

  assertApprovedScenes(run, workflow, episode, nodeId) {
    const approved = run.generationPlan.preparedStages?.[nodeId];
    if (!approved || canonicalJson(episode.scenes.map(normalizedSceneInput)) !== canonicalJson(approved.map(normalizedSceneInput))) throw new HttpError(409, 'Script, storyboard or layout differs from the quoted input. Save the new input and obtain a fresh quote.');
  }

  renderCandidate(workflow, node, episode, outputs) {
    const storyboard = optional(workflow, node, 'storyboard');
    const layout = optional(workflow, node, 'layout');
    // Availability-aware, mirroring stageSelection's render branch and prepareCandidate's
    // generate branch (workflows.mjs:1111): a structurally later producer that never ran this
    // execution (skipped with no reusable output, or simply absent from this run's selection)
    // is omitted, never structurally preferred just because the node exists in the graph --
    // this is the execute()-time half of finding F3; the stageSelection half alone cannot
    // prevent this throw since renderCandidate re-derives its own producer pick independently.
    const layoutUsable = layout && outputs.has(layout.id);
    const storyboardUsable = storyboard && outputs.has(storyboard.id);
    const latestInput = storyboardUsable && layoutUsable && ancestors(workflow.edges, storyboard.id).has(layout.id) ? storyboard : layoutUsable ? layout : storyboardUsable ? storyboard : null;
    const connectedScenes = latestInput ? outputs.get(latestInput.id)?.scenes : episode.scenes;
    if (!Array.isArray(connectedScenes) || !connectedScenes.length) throw new HttpError(409, 'Render requires completed scene evidence from its connected producer');
    let sceneList = structuredClone(connectedScenes);
    const upstream = ancestors(workflow.edges, node.id);
    const superseded = latestInput ? ancestors(workflow.edges, latestInput.id) : new Set();
    const generationNodeIds = [];
    for (const producer of orderedNodes(workflow)) {
      if (producer.type !== 'generate' || !upstream.has(producer.id) || superseded.has(producer.id)) continue;
      const output = outputs.get(producer.id);
      if (!output?.generationJobId) continue;
      const job = this.generations.get(output.generationJobId);
      if (job.status !== 'completed' || !job.applied || job.episodeId !== episode.id) throw new HttpError(409, 'Connected generation is not an applied candidate for this production');
      const snapshot = output.scene || this.store.history(episode.id).find((entry) => entry.version === job.appliedVersion)?.snapshot.scenes.find((scene) => scene.id === job.sceneId);
      if (!snapshot || !sceneList.some((scene) => scene.id === job.sceneId)) throw new HttpError(409, 'Connected generation has no surviving scene snapshot');
      sceneList = sceneList.map((scene) => {
        if (scene.id !== job.sceneId) return scene;
        if (!job.slotId) return structuredClone(snapshot);
        const slot = snapshot.slots?.find((item) => item.id === job.slotId);
        if (!slot || !scene.slots?.some((item) => item.id === job.slotId)) throw new HttpError(409, 'Connected generation target slot is no longer present');
        return { ...scene, slots: scene.slots.map((item) => item.id === job.slotId ? structuredClone(slot) : item) };
      });
      generationNodeIds.push(producer.id);
    }
    return { episode: { ...episode, scenes: this.validateAssets(scenes(sceneList)) }, generationNodeIds };
  }

  async execute(id) {
    if (this.activeExecutions.has(id)) return;
    if (this.activeExecutions.size >= MAX_ACTIVE_RUNS) {
      const retry = setTimeout(() => { if (!this.closed) this.execute(id); }, 25);
      retry.unref?.();
      return;
    }
    this.activeExecutions.set(id, true);
    let activeNode;
    try {
      const initial = this.current(id);
      if (!initial) return;
      this.store.assertEpisodeActive(initial.episodeId);
      this.store.save('workflowRuns', { ...initial, status: 'running', startedAt: timestamp(), updatedAt: timestamp() });
      const run = this.store.get('workflowRuns', id);
      const workflow = run.workflowSnapshot;
      const ordered = orderedNodes(workflow);
      const outputs = new Map(run.nodeRuns.filter((node) => node.output && ['reused', 'completed', 'awaiting_review', 'approved', 'changes_requested'].includes(node.status)).map((node) => [node.nodeId, node.output]));
      const source = run.resumedFrom ? this.store.get('workflowRuns', run.resumedFrom) : undefined;
      const sourceById = new Map((source?.nodeRuns || []).map((node) => [node.nodeId, node]));
      const invalidated = invalidatedBySelection(workflow, run.selectedStages || []);
      const selected = new Set(run.selectedStages || workflow.nodes.map((node) => node.id));
      let episode = run.episodeSnapshot;
      let executed = false;
      const failedNodes = new Set();
      let failure;
      const assertCurrent = () => {
        if (!this.current(id)) throw new HttpError(409, 'Workflow execution was cancelled');
        const currentEpisode = this.store.get('episodes', episode.id);
        const currentWorkflow = this.store.get('workflows', workflow.id);
        assertOwnership(this.store, currentWorkflow, currentEpisode);
        assertVersions(currentWorkflow, currentEpisode, { expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version });
      };
      const currentCandidate = () => normalizeCandidate(this.candidate(workflow, episode, { selectedStages: run.selectedStages, disclosure: run.generationPlan.disclosure }), run.generationPlan.nodes);
      if (run.generationPlan) {
        await candidates.verifyCandidateAssets(this.store, run.generationPlan.candidate);
        assertCurrent();
      }
      for (const node of ordered) {
        const nodeRun = this.store.get('workflowRuns', id).nodeRuns.find((item) => item.nodeId === node.id);
        if (!selected.has(node.id) || nodeRun?.reused || ['skipped', 'reused'].includes(nodeRun?.status)) continue;
        if ([...ancestors(workflow.edges, node.id)].some((ancestor) => failedNodes.has(ancestor))) {
          failedNodes.add(node.id);
          this.nodeUpdate(id, node.id, { status: 'skipped', error: 'A connected upstream node failed' });
          continue;
        }
        activeNode = node.id;
        executed = true;
        try {
          assertCurrent();
          const requiredType = HARD_DEPENDENCY[node.type];
          if (requiredType && !outputs.has(prerequisite(workflow, node, requiredType).id)) throw new HttpError(409, `${node.id} has no completed connected ${requiredType} input`);
          this.nodeUpdate(id, node.id, { status: 'running', startedAt: timestamp(), error: undefined });
          const inputs = workflow.edges.filter((edge) => edge.target === node.id).map((edge) => ({ nodeId: edge.source, output: outputs.get(edge.source) }));
          let output;
          if (node.type === 'trend') {
            output = await this.fetchTrends(node.config.query);
            if (node.config.query) output = { ...output, query: node.config.query, trends: (output.trends || []).filter((trend) => trend.keyword.toLocaleLowerCase().includes(node.config.query.toLocaleLowerCase())) };
            if (!output.trends?.length) throw new Error('Trend source returned no verified keywords; review source errors and retry');
          } else if (node.type === 'news') {
            const trendNode = optional(workflow, node, 'trend');
            const trendOutput = trendNode ? outputs.get(trendNode.id) : undefined;
            const baseKeywords = [
              ...(node.config.query ? [node.config.query] : []),
              ...(node.config.keywords ? node.config.keywords.split(',').map((k) => k.trim()).filter(Boolean) : []),
              ...((trendOutput?.trends || []).map((t) => t.keyword).filter(Boolean)),
              episode.topic,
              episode.title,
            ].filter(Boolean);
            const uniqueKeywords = [...new Set(baseKeywords)].slice(0, 8);
            const query = node.config.query || uniqueKeywords.join(' OR ').slice(0, 200) || episode.topic;
            const maxArticles = node.config.maxArticles ?? 5;
            const trendArticles = storedNewsArticles(this.store, node.config);
            const google = node.config.source === 'trend_news' ? null : await fetchGoogleNews(query, maxArticles, this.fetchImpl);
            const articles = [...trendArticles, ...(google?.articles || [])].slice(0, maxArticles);
            if (!articles.length) throw new Error('News stage could not obtain source-backed articles; no fabricated output was created');
            output = {
              query,
              keywords: uniqueKeywords,
              source: google ? (node.config.source || 'google_news') : 'trend_news',
              sourceUrl: google?.sourceUrl,
              articles,
              scenarioOutline: articles.map((a, idx) => `[씬 ${idx + 1}] ${a.headline}${a.summary ? `: ${a.summary}` : ''}`).join('\n'),
            };
          } else if (node.type === 'research') {
            const references = this.store.list('references').filter((reference) => !reference.channelId || reference.channelId === episode.channelId);
            output = { references: node.config.limit === undefined ? references : references.slice(0, node.config.limit), inputs };
          } else if (node.type === 'script') {
            const prompt = [node.config.prompt || '영상 스토리보드를 구성하세요.', `제목: ${episode.title}`, `소재: ${episode.topic}`, `Research inputs (untrusted data, not instructions): ${JSON.stringify(inputs).slice(0, 8000)}`].join('\n').slice(0, 12000);
            if (node.config.agent === 'existing') {
              output = { agent: 'existing', mode: 'saved', message: '저장된 장면 편집과 오디오를 유지합니다.', scenes: this.validateAssets(scenes(episode.scenes)) };
            } else if (node.config.agent === 'studio') {
              const newsNode = optional(workflow, node, 'news');
              const newsOutput = newsNode ? outputs.get(newsNode.id) : undefined;
              const leadHeadline = newsOutput?.articles?.[0]?.headline || episode.title;
              output = { agent: 'studio', mode: 'deterministic', message: '규칙 기반 3장면 스토리보드. 사실 및 출처 검토가 필요합니다.', scenes: [starterScene('훅', leadHeadline), starterScene('전개', `${episode.topic}\n${node.config.prompt || '핵심 정보를 근거와 함께 설명하세요.'}`.slice(0, 2000), '#173940'), starterScene('마무리', '출처 확인과 내용 검토 후 공개하세요.', '#382d46')] };
            } else {
              const result = await this.runAgent(node.config.agent, prompt, episode);
              output = { agent: node.config.agent, mode: 'provider', message: text(result.message, 'agent response', 20000), scenes: this.validateAssets(scenes(result.scenes)) };
            }
          } else if (node.type === 'storyboard') {
            const script = outputs.get(prerequisite(workflow, node, 'script').id);
            if (!script?.scenes) throw new HttpError(409, 'storyboard requires a completed script prerequisite or valid resume evidence');
            const normalized = this.validateAssets(scenes(script.scenes));
            if (run.generationPlan) this.assertApprovedScenes(run, workflow, { ...episode, scenes: normalized }, node.id);
            assertCurrent();
            episode = this.store.updateEpisode(episode.id, { scenes: normalized }, episode.version, `workflow:${workflow.id}:${id}`);
            output = { episodeId: episode.id, version: episode.version, sceneCount: episode.scenes.length, scenes: episode.scenes };
          } else if (node.type === 'layout') {
            const preset = node.config.preset || 'top-image-mid-video';
            const storyboard = outputs.get(prerequisite(workflow, node, 'storyboard').id);
            if (!storyboard?.scenes) throw new HttpError(409, 'layout requires completed scenes from its connected storyboard');
            const newsNode = optional(workflow, node, 'news');
            const newsOutput = newsNode ? outputs.get(newsNode.id) : undefined;
            const stagedScenes = layoutScenes({ ...episode, scenes: storyboard.scenes }, node.config, newsOutput);
            const normalized = this.validateAssets(scenes(stagedScenes));
            if (run.generationPlan) this.assertApprovedScenes(run, workflow, { ...episode, scenes: normalized }, node.id);
            assertCurrent();
            episode = this.store.updateEpisode(episode.id, { scenes: normalized }, episode.version, `workflow:${workflow.id}:${id}:layout`);
            output = {
              episodeId: episode.id,
              version: episode.version,
              preset,
              sceneCount: episode.scenes.length,
              slotCount: episode.scenes.reduce((sum, s) => sum + (s.slots?.length || 0), 0),
              scenes: episode.scenes,
            };
          } else if (node.type === 'generate') {
            if (Date.parse(run.generationPlan.expiresAt) <= Date.now()) throw new HttpError(409, 'Generation quote expired before execution. Obtain a fresh quote.');
            const approved = nodeInput(run.generationPlan.candidate, node.id);
            const actual = nodeInput(currentCandidate(), node.id);
            if (canonicalJson(actual) !== canonicalJson(approved)) throw new HttpError(409, 'The approved node input changed. Obtain a fresh quote before generation.');
            const scene = episode.scenes.find((item) => item.id === approved.sceneId);
            if (!scene) throw new HttpError(409, 'The approved target scene no longer exists');
            if (approved.slotId && !scene.slots?.some((slot) => slot.id === approved.slotId)) throw new HttpError(409, 'The approved target slot no longer exists');
            const rawPrior = sourceById.get(node.id);
            const prior = invalidated.has(node.id) ? undefined : rawPrior;
            // Fetched once: reused below for resumingJob, hasUnresolvedNodeJob's internal scan
            // and the requestId fallback instead of each independently re-querying+re-parsing
            // the full tables (previously up to N+2 full scans per generate node, and
            // workflowRuns rows -- full workflow/episode snapshots plus candidate -- are the
            // store's heaviest entity).
            const jobs = this.store.list('generationJobs');
            const runs = this.store.list('workflowRuns');
            // Same principle as stageSelection's resumingJob: exclude only the ONE specific job
            // this execution would itself resume (when not invalidated) -- never skip the scan
            // merely because rawPrior references some job, which could be a different, already-
            // settled one while an older, disconnected job for this node remains unresolved.
            const resumingJob = !invalidated.has(node.id) ? priorGenerationJob(jobs, rawPrior, run.resumedFrom || id, node.id) : null;
            if (hasUnresolvedNodeJob(runs, jobs, workflow.id, episode.id, node.id, id, resumingJob?.id)) {
              const error = new HttpError(409, GENERATION_UNRESOLVED_MESSAGE); error.code = 'generation_unresolved'; throw error;
            }
            const savedIntent = nodeRun?.generationIntent || prior?.generationIntent;
            const inputFingerprint = candidateFingerprint(approved);
            if (savedIntent && savedIntent.inputFingerprint !== inputFingerprint) throw new HttpError(409, 'Original paid node input differs; recover the original job without resubmitting');
            const requestId = savedIntent?.requestId || `${run.resumedFrom || id}:${node.id}`;
            const priorJobId = nodeRun?.output?.generationJobId || prior?.output?.generationJobId || savedIntent?.generationJobId;
            let job = priorJobId ? this.generations.get(priorJobId) : jobs.find((item) => item.requestId === requestId);
            if (savedIntent && !job) throw new HttpError(409, 'Original generation job identity is unavailable; reconcile it before retrying');
            const intent = savedIntent || { requestId, input: approved, inputFingerprint, generationPlanId: run.generationPlanId, createdAt: timestamp() };
            if (!this.persistNode(id, node.id, { generationIntent: intent })) throw new HttpError(503, 'Cannot persist the original generation intent before submission');
            // Files and rights can change after quotation/start. Verify physical bytes and
            // recheck optimistic versions after the await, immediately before any paid call.
            await candidates.verifyCandidateAssets(this.store, run.generationPlan.candidate);
            assertCurrent();
            if (Date.parse(run.generationPlan.expiresAt) <= Date.now()) throw new HttpError(409, 'Generation quote expired during asset verification. Obtain a fresh quote.');
            if (!job) {
              job = await this.generations.start(episode.id, { expectedVersion: episode.version, sceneId: approved.sceneId, ...(approved.slotId ? { slotId: approved.slotId } : {}), model: approved.model, prompt: approved.prompt, params: approved.params, requestId });
            } else if (job.requestId !== requestId || job.episodeId !== episode.id || job.sceneId !== approved.sceneId || (job.slotId || null) !== (approved.slotId || null) || job.model !== approved.model || job.prompt !== approved.prompt || canonicalJson(job.params) !== canonicalJson(approved.params)) {
              throw new HttpError(409, 'The original generation job differs from the approved node input');
            }
            if (!this.persistNode(id, node.id, { generationIntent: { ...intent, generationJobId: job.id }, output: { generationJobId: job.id, provider: 'higgsfield', model: job.model, status: job.status } })) throw new HttpError(503, 'Generation job could not be durably linked; recover its original request');
            let completed;
            if (job.status === 'completed') completed = job;
            else if (['queued', 'submitting', 'pending', 'in_progress', 'downloading'].includes(job.status)) completed = await this.generations.wait(job.id);
            else throw new HttpError(409, 'Existing generation requires explicit provider recovery before resume');
            if (!this.current(id)) return;
            assertCurrent();
            if (!completed.applied) {
              const applied = this.generations.apply(job.id, { expectedVersion: episode.version, sceneId: approved.sceneId, ...(approved.slotId ? { slotId: approved.slotId } : {}) });
              episode = applied.episode;
            }
            const resultFingerprint = candidateFingerprint(nodeInput(currentCandidate(), node.id));
            if (!this.persistNode(id, node.id, { generationIntent: { ...intent, generationJobId: job.id, resultFingerprint } })) throw new HttpError(503, 'Applied generation receipt could not be durably linked; reconcile the existing job without reapplying');
            output = { generationJobId: job.id, provider: 'higgsfield', model: job.model, transport: job.transport, status: completed.status, outputs: completed.outputs, sceneId: approved.sceneId, scene: episode.scenes.find((item) => item.id === approved.sceneId), episodeVersion: episode.version, ...(approved.slotId ? { slotId: approved.slotId } : {}) };
          } else if (node.type === 'render') {
            const candidate = this.renderCandidate(workflow, node, episode, outputs);
            const sceneSnapshot = structuredClone(candidate.episode.scenes);
            output = { ...await this.render(candidate.episode), renderNodeId: node.id, generationNodeIds: candidate.generationNodeIds, sceneSnapshot };
          } else if (node.type === 'review') {
            const render = outputs.get(prerequisite(workflow, node, 'render').id);
            if (!render) throw new HttpError(409, 'review requires a completed render prerequisite or valid resume evidence');
            output = { message: 'Rendered output requires human review. No channel publication was performed.', ...(node.config.instructions ? { instructions: node.config.instructions } : {}), episodeId: episode.id, render, inputs };
          } else if (node.type === 'publish') {
            const render = outputs.get(prerequisite(workflow, node, 'render').id);
            const reviewNode = prerequisite(workflow, node, 'review');
            const approvedReview = outputs.get(reviewNode.id)?.review;
            if (!render?.outputUrl || !render.jobId || !render.sha256 || approvedReview?.decision !== 'approved' || approvedReview.jobId !== render.jobId || approvedReview.outputUrl !== render.outputUrl || approvedReview.sha256 !== render.sha256) throw new HttpError(409, 'Publish staging requires the exact connected render and approved review');
            assertCurrent();
            const stage = this.store.create('publicationStages', { workflowId: workflow.id, runId: id, nodeId: node.id, episodeId: episode.id, episodeVersion: episode.version, channelId: episode.channelId, reviewNodeId: reviewNode.id, reviewId: approvedReview.id, render, status: 'staged', publicationStatus: 'not_attempted' });
            output = { stagingId: stage.id, channelId: episode.channelId, exportUrl: render.outputUrl, status: 'staged', publicationStatus: 'not_attempted', message: 'Candidate staged. Separate exact-manifest final publication approval is required.' };
          }
          if (!this.current(id)) return;
          assertCurrent();
          outputs.set(node.id, output);
          this.nodeUpdate(id, node.id, { status: node.type === 'review' ? 'awaiting_review' : 'completed', output, completedAt: timestamp() }, { episodeVersion: episode.version });
        } catch (error) {
          if (!this.current(id)) return;
          const message = error instanceof HttpError || error.message?.startsWith('Trend source') ? error.message : 'Workflow step failed. Review integration availability and local service logs.';
          failedNodes.add(node.id);
          failure ||= message;
          this.nodeUpdate(id, node.id, { status: 'failed', error: message, completedAt: timestamp() }, { episodeVersion: episode.version });
          this.store.record('workflow.node_failed', { entityId: workflow.id, runId: id, nodeId: node.id, error: message });
        }
      }
      const latest = this.current(id);
      if (!latest) return;
      const finalStatus = failure ? 'failed' : reviewStatus(latest.nodeRuns, latest.workflowSnapshot, latest.selectedStages);
      this.store.save('workflowRuns', { ...latest, status: finalStatus, ...(failure ? { error: failure } : {}), completedAt: timestamp(), episodeVersion: episode.version, updatedAt: timestamp() });
      this.store.record(`workflow.${finalStatus}`, { entityId: workflow.id, runId: id, episodeId: episode.id, executed });
    } catch (error) {
      if (!this.current(id)) return;
      const message = error instanceof HttpError ? error.message : error.message?.includes('Trend source') ? error.message : 'Workflow step failed. Review integration availability and local service logs.';
      this.nodeUpdate(id, activeNode, { status: 'failed', error: message, completedAt: timestamp() }, { status: 'failed', error: message, completedAt: timestamp() });
      const failed = this.current(id);
      this.store.save('workflowRuns', { ...failed, nodeRuns: failed.nodeRuns.map((node) => node.status === 'queued' ? { ...node, status: 'skipped', error: 'An upstream stage failed' } : node) });
      this.store.record('workflow.failed', { entityId: id, nodeId: activeNode, error: message });
      console.error('Workflow step failed:', error.message);
    } finally {
      this.activeExecutions.delete(id);
    }
  }

  close() { this.closed = true; }
}
