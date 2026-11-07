// Agent operation registry: the single source of truth for the agent-facing workflow API.
// REST (/api/agent/*), MCP tools (/mcp and scripts/frameforge-mcp.mjs), OpenAPI and the docs are
// all generated from OPERATIONS below, so they cannot drift. Every operation delegates to the
// existing Store / WorkflowEngine rules; nothing here relaxes version guards or consent gates.
import { HttpError, text, episodePatch, scenes as validateScenes } from './validation.mjs';
import { starterScene } from './store.mjs';
import { validateWorkflow, TYPES, NODE_CONFIG_FIELDS, STAGE_PREREQUISITES } from './workflows.mjs';
import { applyGraphOps, blueprintFor, storyboardFor, autoLayout, PATCH_OP_NAMES, MAX_PATCH_OPS, BLUEPRINT_STYLES, STORYBOARD_TONES } from './graph-patch.mjs';
import { validateSchema } from './schema.mjs';

export const OPERATIONS_VERSION = '1.0.0';
export const SCRIPT_AGENTS = Object.freeze(['studio', 'codex', 'jeo', 'jeopi', 'hermes']);
export const AGENT_INSTRUCTIONS = 'FrameForge Studio workflow API. Start with workflow_node_types, then workflow_list/episode_list. Every change needs the current version as expectedVersion. Error codes in tool results: stale_version = re-read and re-apply (error.currentVersion when present); stale_quote = call workflow_quote again; conflict = do not retry unchanged, inspect state or ask a human. Use workflow_patch with dryRun first. Paid generation needs workflow_quote and is disabled for agents unless the operator enabled it. Review approval and publication are human-only and are not available as tools.';

export function fail(status, message, code, extra) {
  const error = new HttpError(status, message);
  if (code) error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

/**
 * Machine-readable conflict classification so agents can branch without parsing prose:
 *  - stale_version: an expected version was old. Re-read, re-apply your change, retry. When the
 *    store reports it, error.currentVersion is the version to re-read.
 *  - stale_quote: the exact-input generation quote no longer matches or expired. Call
 *    workflow_quote again (and obtain the human decision again) before retrying.
 *  - conflict: any other 409 (archived episode, active work, missing prerequisite, identity
 *    mismatch). NOT retryable unchanged: inspect state, fix the cause, or ask a human.
 */
const STALE_VERSION = /^(?:Episode|Workflow|Template) changed: current version is (\d+)\./;
const STALE_PROJECT = /^Project changed since approval\./;
const STALE_QUOTE = /fresh quote|quote expired|quoted input|differs from the quoted/i;
function classify(error) {
  if (!(error instanceof HttpError) || error.status !== 409 || error.code) return error;
  const stale = STALE_VERSION.exec(error.message);
  if (stale) { error.code = 'stale_version'; error.currentVersion = Number(stale[1]); }
  else if (STALE_PROJECT.test(error.message)) error.code = 'stale_version';
  else error.code = STALE_QUOTE.test(error.message) ? 'stale_quote' : 'conflict';
  return error;
}

// ── schema building blocks ────────────────────────────────────────────────────────────────
const ID = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' };
const VERSION = { type: 'integer', minimum: 1 };
const obj = (properties = {}, required = [], extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const loose = (properties = {}, required = []) => obj(properties, required, { additionalProperties: true });
const str = (max = 200, extra = {}) => ({ type: 'string', minLength: 1, maxLength: max, ...extra });
const idOf = (description) => ({ ...ID, description });
const arrayOf = (items, extra = {}) => ({ type: 'array', items, ...extra });
const EXECUTION = obj({
  mode: { type: 'string', enum: ['node', 'all'], description: '"node" runs the target node and its needed ancestors; "all" runs the whole graph.' },
  targetNodeId: idOf('Required for mode "node"; forbidden for "all".'),
  refresh: { type: 'boolean', description: 'Mode "all" only: rerun nodes that already completed.' },
}, ['mode']);
const DISCLOSURE = obj({
  containsSyntheticMedia: { type: 'boolean' },
  rationale: str(2000, { description: 'Human-reviewed reason for the disclosure decision.' }),
}, ['containsSyntheticMedia', 'rationale']);
const GRAPH_NODE = loose({ id: ID, type: { type: 'string', enum: TYPES }, x: { type: 'number' }, y: { type: 'number' }, config: { type: 'object' } }, ['id', 'type', 'x', 'y', 'config']);
const GRAPH_EDGE = obj({ id: ID, source: ID, target: ID }, ['id', 'source', 'target']);
const WORKFLOW_SUMMARY = loose({
  id: ID, name: { type: 'string' }, version: VERSION, nodeCount: { type: 'integer' }, edgeCount: { type: 'integer' },
  isTemplate: { type: 'boolean' }, episodeId: ID, channelId: ID, templateId: ID, templateVersion: VERSION, updatedAt: { type: 'string' },
}, ['id', 'name', 'version', 'nodeCount', 'edgeCount', 'isTemplate']);
const WORKFLOW_FULL = loose({ ...WORKFLOW_SUMMARY.properties, nodes: arrayOf(GRAPH_NODE), edges: arrayOf(GRAPH_EDGE), skippedNodes: arrayOf(ID) }, [...WORKFLOW_SUMMARY.required, 'nodes', 'edges', 'skippedNodes']);
const RUN_SUMMARY = loose({
  id: ID, workflowId: ID, workflowVersion: VERSION, episodeId: ID, episodeVersion: VERSION,
  status: { type: 'string', description: 'queued | running | completed | failed | cancelled | awaiting_review | approved | changes_requested' },
  terminal: { type: 'boolean' }, awaitingReview: { type: 'boolean' },
  selectedStages: arrayOf(ID),
  nodeRuns: arrayOf(loose({ nodeId: ID, type: { type: 'string' }, status: { type: 'string' }, reused: { type: 'boolean' }, error: { type: 'string' }, exportUrl: { type: 'string' } }, ['nodeId', 'type', 'status'])),
  exportUrl: { type: 'string', description: 'Present when a render node completed: /api/exports/<file>.mp4 (authenticated download).' },
}, ['id', 'workflowId', 'episodeId', 'status', 'terminal', 'awaitingReview', 'selectedStages', 'nodeRuns']);
const EPISODE_SUMMARY = loose({
  id: ID, channelId: ID, title: { type: 'string' }, topic: { type: 'string' }, status: { type: 'string' }, format: { type: 'string' },
  version: VERSION, archived: { type: 'boolean' }, sceneCount: { type: 'integer' }, totalDuration: { type: 'number' }, hasMusic: { type: 'boolean' },
}, ['id', 'channelId', 'title', 'status', 'format', 'version', 'archived', 'sceneCount', 'totalDuration']);
const SCENE = loose({ id: ID, title: { type: 'string' }, text: { type: 'string' }, duration: { type: 'number', minimum: 0.5, maximum: 120 }, background: { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' }, kind: { type: 'string' }, layout: { type: 'string' }, narration: { type: 'string' } }, ['id', 'title', 'duration', 'background']);
const JOB_SUMMARY = loose({ id: ID, episodeId: ID, episodeVersion: VERSION, status: { type: 'string', description: 'queued | running | completed | failed' }, progress: { type: 'number' }, outputUrl: { type: 'string' }, error: { type: 'string' } }, ['id', 'episodeId', 'status', 'progress']);
const VALIDATION = loose({ valid: { type: 'boolean' }, error: { type: 'string' } }, ['valid']);

// ── projections ───────────────────────────────────────────────────────────────────────────
const round = (value) => Math.round(value * 100) / 100;
const workflowSummary = (workflow) => ({
  id: workflow.id, name: workflow.name, version: workflow.version, nodeCount: workflow.nodes.length, edgeCount: workflow.edges.length,
  isTemplate: !workflow.episodeId,
  ...(workflow.episodeId ? { episodeId: workflow.episodeId } : {}), ...(workflow.channelId ? { channelId: workflow.channelId } : {}),
  ...(workflow.templateId ? { templateId: workflow.templateId } : {}), ...(Number.isInteger(workflow.templateVersion) ? { templateVersion: workflow.templateVersion } : {}),
  ...(workflow.updatedAt ? { updatedAt: workflow.updatedAt } : {}),
});
const workflowFull = (workflow) => ({ ...workflowSummary(workflow), nodes: workflow.nodes, edges: workflow.edges, skippedNodes: workflow.skippedNodes || [] });
const TERMINAL_RUN = ['completed', 'failed', 'cancelled', 'awaiting_review', 'approved', 'changes_requested'];
function runSummary(run) {
  const render = (run.nodeRuns || []).map((node) => node.output?.exportUrl || node.output?.outputUrl).filter(Boolean).at(-1);
  return {
    id: run.id, workflowId: run.workflowId, workflowVersion: run.workflowVersion, episodeId: run.episodeId, episodeVersion: run.episodeVersion,
    status: run.status, terminal: TERMINAL_RUN.includes(run.status), awaitingReview: run.status === 'awaiting_review',
    selectedStages: run.selectedStages || [],
    nodeRuns: (run.nodeRuns || []).map((node) => ({ nodeId: node.nodeId, type: node.type, status: node.status, ...(node.reused ? { reused: true } : {}), ...(typeof node.error === 'string' ? { error: node.error } : {}), ...(typeof node.output?.exportUrl === 'string' ? { exportUrl: node.output.exportUrl } : {}) })),
    ...(render ? { exportUrl: render } : {}),
    ...(run.generationPlanId ? { generationPlanId: run.generationPlanId } : {}),
    ...(run.createdAt ? { createdAt: run.createdAt } : {}), ...(run.updatedAt ? { updatedAt: run.updatedAt } : {}),
  };
}
const episodeSummary = (episode) => ({
  id: episode.id, channelId: episode.channelId, title: episode.title, topic: episode.topic || '', status: episode.status, format: episode.format, version: episode.version,
  archived: Boolean(episode.archivedAt) || episode.status === 'archived', sceneCount: episode.scenes.length,
  totalDuration: round(episode.scenes.reduce((sum, scene) => sum + scene.duration, 0)), hasMusic: Boolean(episode.music),
});
const jobSummary = (job) => ({
  id: job.id, episodeId: job.episodeId, episodeVersion: job.episodeVersion, status: job.status, progress: job.progress ?? 0,
  ...(typeof job.outputUrl === 'string' ? { outputUrl: job.outputUrl } : {}), ...(typeof job.error === 'string' ? { error: job.error } : {}),
});

const NODE_DESCRIPTIONS = {
  trend: 'Collect trending keywords.', news: 'Collect news articles for a query.', research: 'Organise sources and context.',
  script: 'Write the script via the studio template or a host agent.', storyboard: 'Turn the script into editable scenes.',
  layout: 'Arrange image/video/subtitle slots per scene.', generate: 'PAID: generate scene or slot media with a Higgsfield model. Needs quote, disclosure and explicit consent.',
  render: 'Render the MP4 with FFmpeg.', review: 'HUMAN GATE: a person approves or requests changes in the Studio UI. Agents cannot approve.',
  publish: 'HUMAN GATE: stage a candidate for owner-approved publication. Agents cannot publish.',
};

/**
 * @param deps { store, workflows, enqueueRender, validateAssets, runAgent?, allowPaidGeneration? }
 *   `deps` may be empty when only the static catalog is needed (docs, tests).
 */
export function createAgentOperations(deps = {}) {
  const { store, workflows } = deps;
  const hints = (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) => ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });
  const READ = hints(true, false, true, false);

  const definitions = [
    {
      name: 'workflow_node_types', title: 'List workflow node types',
      description: 'Returns every node type with its allowed config fields, its required upstream stage, graph limits and the patch operations accepted by workflow_patch. Call this first.',
      inputSchema: obj(), annotations: READ,
      outputSchema: loose({ types: arrayOf(loose({ type: { type: 'string' }, requires: { type: ['string', 'null'] }, configFields: arrayOf({ type: 'string' }), description: { type: 'string' }, paid: { type: 'boolean' }, humanGate: { type: 'boolean' } }, ['type', 'requires', 'configFields', 'description', 'paid', 'humanGate'])), limits: loose({ maxNodes: { type: 'integer' }, maxEdges: { type: 'integer' }, maxPatchOps: { type: 'integer' } }, ['maxNodes', 'maxEdges', 'maxPatchOps']), patchOps: arrayOf({ type: 'string' }) }, ['types', 'limits', 'patchOps']),
      run: () => ({
        types: TYPES.map((type) => ({ type, requires: STAGE_PREREQUISITES[type] || null, configFields: [...NODE_CONFIG_FIELDS[type]], description: NODE_DESCRIPTIONS[type], paid: type === 'generate', humanGate: type === 'review' || type === 'publish' })),
        limits: { maxNodes: 128, maxEdges: 256, maxPatchOps: MAX_PATCH_OPS }, patchOps: [...PATCH_OP_NAMES],
      }),
    },
    {
      name: 'workflow_list', title: 'List workflows',
      description: 'Lists workflow summaries. Project workflows belong to one episode; templates (isTemplate) have no episode and are copied per project.',
      inputSchema: obj({ episodeId: idOf('Only workflows owned by this episode.'), templatesOnly: { type: 'boolean' } }), annotations: READ,
      outputSchema: loose({ workflows: arrayOf(WORKFLOW_SUMMARY) }, ['workflows']),
      run: ({ episodeId, templatesOnly }) => ({ workflows: store.list('workflows').filter((workflow) => (episodeId ? workflow.episodeId === episodeId : true) && (templatesOnly ? !workflow.episodeId : true)).map(workflowSummary) }),
    },
    {
      name: 'workflow_get', title: 'Get a workflow',
      description: 'Returns one workflow with nodes, edges, version and skipped nodes. Use its version as expectedVersion for edits.',
      inputSchema: obj({ workflowId: ID }, ['workflowId']), annotations: READ,
      outputSchema: loose({ workflow: WORKFLOW_FULL }, ['workflow']),
      run: ({ workflowId }) => ({ workflow: workflowFull(store.get('workflows', workflowId)) }),
    },
    {
      name: 'workflow_validate', title: 'Validate a workflow graph (dry run)',
      description: 'Checks a stored workflow, or a candidate graph {name,nodes,edges}, against the same rules used on save. Never writes. Provide exactly one of workflowId or graph.',
      inputSchema: obj({ workflowId: ID, graph: loose({ name: { type: 'string' }, nodes: arrayOf({ type: 'object' }), edges: arrayOf({ type: 'object' }) }, ['name', 'nodes', 'edges']) }), annotations: READ,
      outputSchema: loose({ valid: { type: 'boolean' }, error: { type: 'string' }, nodeCount: { type: 'integer' }, edgeCount: { type: 'integer' } }, ['valid']),
      run: ({ workflowId, graph }) => {
        if ((workflowId === undefined) === (graph === undefined)) throw fail(400, 'Provide exactly one of workflowId or graph', 'invalid_arguments');
        try {
          const checked = validateWorkflow(workflowId ? store.get('workflows', workflowId) : graph);
          return { valid: true, nodeCount: checked.nodes.length, edgeCount: checked.edges.length };
        } catch (error) {
          if (error instanceof HttpError && error.status === 400) return { valid: false, error: error.message };
          throw error;
        }
      },
    },
    {
      name: 'workflow_plan', title: 'Plan an execution (free)',
      description: 'Dry-run plan for running part or all of a project workflow: which nodes would run, be reused, be stale or blocked, and whether paid generation would be required. Never writes and never calls a provider.',
      inputSchema: obj({ workflowId: ID, episodeId: ID, execution: EXECUTION, expectedWorkflowVersion: VERSION, expectedEpisodeVersion: VERSION }, ['workflowId', 'episodeId', 'execution']), annotations: READ,
      outputSchema: loose({ selectedStages: arrayOf(ID), requiresGeneration: { type: 'boolean' }, nothingToRun: { type: 'boolean' }, nodes: arrayOf({ type: 'object' }) }, ['selectedStages', 'requiresGeneration', 'nodes']),
      run: ({ workflowId, episodeId, execution, expectedWorkflowVersion, expectedEpisodeVersion }) => workflows.plan(workflowId, episodeId, { execution, expectedWorkflowVersion, expectedEpisodeVersion }),
    },
    {
      name: 'workflow_run_get', title: 'Get a workflow run',
      description: 'Authoritative run state with per-node status. Poll this until terminal is true. A run whose status is awaiting_review needs a human decision in the Studio UI.',
      inputSchema: obj({ runId: ID }, ['runId']), annotations: hints(true, false, true, false),
      outputSchema: loose({ run: RUN_SUMMARY }, ['run']),
      run: ({ runId }) => ({ run: runSummary(store.get('workflowRuns', runId)) }),
    },
    {
      name: 'workflow_run_list', title: 'List runs of a workflow',
      description: 'Most recent runs first.',
      inputSchema: obj({ workflowId: ID, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['workflowId']), annotations: READ,
      outputSchema: loose({ runs: arrayOf(RUN_SUMMARY) }, ['runs']),
      run: ({ workflowId, limit = 10 }) => ({ runs: workflows.listRuns(workflowId).slice(0, limit).map(runSummary) }),
    },
    {
      name: 'episode_list', title: 'List episodes',
      description: 'Episode summaries (projects). Archived episodes are excluded unless includeArchived is true.',
      inputSchema: obj({ channelId: ID, includeArchived: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }), annotations: READ,
      outputSchema: loose({ episodes: arrayOf(EPISODE_SUMMARY) }, ['episodes']),
      run: ({ channelId, includeArchived = false, limit = 50 }) => ({ episodes: store.list('episodes').filter((episode) => (!channelId || episode.channelId === channelId) && (includeArchived || (!episode.archivedAt && episode.status !== 'archived'))).slice(0, limit).map(episodeSummary) }),
    },
    {
      name: 'episode_get', title: 'Get an episode with scenes',
      description: 'Returns the episode summary and its scenes. version is the optimistic-concurrency token for episode_update and episode_render.',
      inputSchema: obj({ episodeId: ID }, ['episodeId']), annotations: READ,
      outputSchema: loose({ episode: EPISODE_SUMMARY, scenes: arrayOf(SCENE), notes: { type: 'string' } }, ['episode', 'scenes']),
      run: ({ episodeId }) => { const episode = store.get('episodes', episodeId); return { episode: episodeSummary(episode), scenes: episode.scenes, notes: episode.notes || '' }; },
    },
    {
      name: 'render_job_get', title: 'Get a render job',
      description: 'Progress of an MP4 render started by episode_render. Poll until status is completed or failed; completed jobs carry outputUrl.',
      inputSchema: obj({ jobId: ID }, ['jobId']), annotations: READ,
      outputSchema: loose({ job: JOB_SUMMARY }, ['job']),
      run: ({ jobId }) => ({ job: jobSummary(store.get('jobs', jobId)) }),
    },
    {
      name: 'workflow_propose_blueprint', title: 'Propose a starter workflow graph',
      description: 'Builds a RULE-BASED starter graph (trend/news → research → script → storyboard → layout → render → human review [→ private upload]) for a topic. Persists nothing; apply it with workflow_patch using a replaceGraph op. For model-written graphs, compose workflow_patch ops yourself.',
      inputSchema: obj({ topic: str(300), style: { type: 'string', enum: BLUEPRINT_STYLES }, includeGeneration: { type: 'boolean' }, includePublish: { type: 'boolean' }, model: str(160, { description: 'Higgsfield model id. A generate node is added only when this is supplied.' }) }, ['topic']), annotations: READ,
      outputSchema: loose({ name: { type: 'string' }, nodes: arrayOf(GRAPH_NODE), edges: arrayOf(GRAPH_EDGE), rationale: arrayOf({ type: 'string' }), warnings: arrayOf({ type: 'string' }), engine: { type: 'string', const: 'rule-based' } }, ['name', 'nodes', 'edges', 'rationale', 'warnings', 'engine']),
      run: (args) => { const blueprint = blueprintFor(args); validateWorkflow(blueprint); return blueprint; },
    },
    {
      name: 'episode_propose_storyboard', title: 'Propose scenes for an episode',
      description: 'Drafts scenes for an episode from a brief. engine "rule-based" (agent "studio", default) is an offline template; any other agent sends the episode text to that host agent and returns its scenes. Persists nothing: apply with episode_update using baseVersion as expectedVersion.',
      inputSchema: obj({ episodeId: ID, brief: str(2000), sceneCount: { type: 'integer', minimum: 3, maximum: 8 }, tone: { type: 'string', enum: STORYBOARD_TONES }, agent: { type: 'string', enum: SCRIPT_AGENTS } }, ['episodeId']),
      annotations: hints(false, false, false, true),
      outputSchema: loose({ episodeId: ID, baseVersion: VERSION, scenes: arrayOf(SCENE), rationale: arrayOf({ type: 'string' }), engine: { type: 'string' } }, ['episodeId', 'baseVersion', 'scenes', 'rationale', 'engine']),
      run: async ({ episodeId, brief, sceneCount = 4, tone = 'neutral', agent = 'studio' }) => {
        const episode = store.assertEpisodeActive(episodeId);
        if (agent === 'studio') {
          const proposal = storyboardFor({ title: episode.title, topic: episode.topic, brief, sceneCount, tone });
          deps.validateAssets?.(proposal.scenes);
          return { episodeId, baseVersion: episode.version, ...proposal, engine: 'rule-based' };
        }
        if (!deps.runAgent) throw fail(503, `${agent} unavailable: host bridge is not configured`, 'agent_unavailable');
        const message = `${brief || episode.topic || episode.title}\n\n요청: ${sceneCount}개 장면, 어조 ${tone}. 응답에 scenes 배열을 포함하세요.`;
        store.record('agent.proposal.requested', { entityId: episodeId, agent });
        let result;
        try { result = await deps.runAgent(agent, message, episode); }
        catch (error) {
          if (error instanceof HttpError) throw error;
          throw fail(503, `${agent} unavailable: ${error.code === 'UNAVAILABLE' ? 'host bridge is not configured' : 'host bridge could not complete the request'}`, 'agent_unavailable');
        }
        if (!Array.isArray(result?.scenes) || !result.scenes.length) throw fail(502, `${agent} returned no scenes`, 'agent_no_scenes');
        const checked = validateScenes(result.scenes);
        deps.validateAssets?.(checked);
        store.assertEpisodeActive(episodeId);
        return { episodeId, baseVersion: episode.version, scenes: checked, rationale: [typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1000) : `${agent} 에이전트가 제안한 장면입니다.`, '에이전트 초안입니다. 사실과 출처는 직접 검토하세요.'], engine: `agent:${agent}` };
      },
    },
    {
      name: 'workflow_copy_from_template', title: 'Create a project workflow from a template',
      description: 'Copies a template workflow into an independent, versioned workflow owned by one episode and channel. Required before running anything for that episode.',
      inputSchema: obj({ templateId: ID, channelId: ID, episodeId: ID, expectedTemplateVersion: VERSION }, ['templateId', 'channelId', 'episodeId', 'expectedTemplateVersion']),
      annotations: hints(false, false, false, false),
      outputSchema: loose({ workflow: WORKFLOW_FULL }, ['workflow']),
      run: ({ templateId, channelId, episodeId, expectedTemplateVersion }) => ({ workflow: workflowFull(workflows.copy(templateId, { channelId, episodeId, expectedTemplateVersion })) }),
    },
    {
      name: 'workflow_patch', title: 'Edit a workflow graph atomically',
      description: `Applies 1-${MAX_PATCH_OPS} ordered ops (${PATCH_OP_NAMES.join(', ')}) to a copy of the graph, validates the whole result with the same rules as save, then writes one new version. Any invalid op or an invalid final graph rejects everything. Stale expectedVersion returns 409. Use dryRun to preview without writing.`,
      inputSchema: obj({
        workflowId: ID, expectedVersion: VERSION, dryRun: { type: 'boolean' },
        ops: arrayOf(loose({ op: { type: 'string', enum: PATCH_OP_NAMES } }, ['op']), { minItems: 1, maxItems: MAX_PATCH_OPS }),
      }, ['workflowId', 'expectedVersion', 'ops']),
      annotations: hints(false, true, false, false),
      outputSchema: loose({ applied: { type: 'boolean' }, dryRun: { type: 'boolean' }, version: VERSION, stats: loose({ nodesAdded: { type: 'integer' }, nodesRemoved: { type: 'integer' }, edgesAdded: { type: 'integer' }, edgesRemoved: { type: 'integer' }, nodesChanged: { type: 'integer' } }), validation: VALIDATION, workflow: WORKFLOW_FULL, preview: loose({ name: { type: 'string' }, nodes: arrayOf({ type: 'object' }), edges: arrayOf({ type: 'object' }) }) }, ['applied', 'dryRun', 'version', 'stats', 'validation']),
      run: ({ workflowId, expectedVersion, ops, dryRun = false }) => {
        const current = store.get('workflows', workflowId);
        if (current.version !== expectedVersion) throw fail(409, `Workflow changed: current version is ${current.version}. Reload before editing.`, 'stale_version', { currentVersion: current.version });
        const { graph, stats } = applyGraphOps(current, ops);
        let normalized, validation = { valid: true };
        try { normalized = validateWorkflow(graph); }
        catch (error) { if (!(error instanceof HttpError) || error.status !== 400) throw error; validation = { valid: false, error: error.message }; }
        if (dryRun) return { applied: false, dryRun: true, version: current.version, stats, validation, preview: normalized || graph };
        if (!validation.valid) throw fail(400, validation.error, 'invalid_graph');
        const saved = store.updateWorkflow(workflowId, normalized, expectedVersion, 'agent-api');
        return { applied: true, dryRun: false, version: saved.version, stats, validation, workflow: workflowFull(saved) };
      },
    },
    {
      name: 'workflow_auto_layout', title: 'Tidy node positions',
      description: 'Convenience wrapper over workflow_patch [{op:"autoLayout"}]: deterministic left-to-right layered layout. Changes coordinates only.',
      inputSchema: obj({ workflowId: ID, expectedVersion: VERSION }, ['workflowId', 'expectedVersion']),
      annotations: hints(false, false, true, false),
      outputSchema: loose({ version: VERSION, workflow: WORKFLOW_FULL }, ['version', 'workflow']),
      run: ({ workflowId, expectedVersion }) => {
        const current = store.get('workflows', workflowId);
        if (current.version !== expectedVersion) throw fail(409, `Workflow changed: current version is ${current.version}. Reload before editing.`, 'stale_version', { currentVersion: current.version });
        const normalized = validateWorkflow({ name: current.name, nodes: autoLayout(current.nodes, current.edges), edges: current.edges });
        const saved = store.updateWorkflow(workflowId, normalized, expectedVersion, 'agent-api:autoLayout');
        return { version: saved.version, workflow: workflowFull(saved) };
      },
    },
    {
      name: 'workflow_set_skip', title: 'Skip or unskip a node',
      description: 'Marks a node as skipped (or not) on a project workflow. Skipped nodes are not executed.',
      inputSchema: obj({ workflowId: ID, nodeId: ID, skipped: { type: 'boolean' }, expectedVersion: VERSION }, ['workflowId', 'nodeId', 'skipped', 'expectedVersion']),
      annotations: hints(false, false, true, false),
      outputSchema: loose({ workflow: WORKFLOW_FULL }, ['workflow']),
      run: ({ workflowId, nodeId, skipped, expectedVersion }) => ({ workflow: workflowFull(store.setWorkflowSkip(workflowId, nodeId, skipped, expectedVersion)) }),
    },
    {
      name: 'workflow_quote', title: 'Quote paid generation (no spend)',
      description: 'Prices the generate nodes selected by execution and stores an exact-input quote valid for 5 minutes. Contacts the provider for estimates only; nothing is generated or charged. Required before a paid run; pass the returned id and fingerprint to workflow_run_start. Needs a human-reviewed disclosure when generate nodes are selected.',
      inputSchema: obj({ workflowId: ID, episodeId: ID, execution: EXECUTION, disclosure: DISCLOSURE, expectedWorkflowVersion: VERSION, expectedEpisodeVersion: VERSION }, ['workflowId', 'episodeId', 'execution']),
      annotations: hints(false, false, false, true),
      outputSchema: loose({ generationPlanId: ID, fingerprint: { type: 'string' }, expiresAt: { type: 'string' }, selectedStages: arrayOf(ID), aggregate: loose({ quoted: { type: 'boolean' } }, ['quoted']), nodes: arrayOf(loose({ nodeId: ID, model: { type: 'string' }, quoted: { type: 'boolean' } }, ['nodeId', 'quoted'])), workflowVersion: VERSION, episodeVersion: VERSION }, ['generationPlanId', 'fingerprint', 'expiresAt', 'selectedStages', 'aggregate', 'nodes', 'workflowVersion', 'episodeVersion']),
      run: async ({ workflowId, episodeId, ...options }) => {
        const quote = await workflows.quote(workflowId, episodeId, options);
        return {
          generationPlanId: quote.id, fingerprint: quote.fingerprint, expiresAt: quote.expiresAt, selectedStages: quote.selectedStages, aggregate: quote.aggregate,
          nodes: quote.nodes.map((node) => ({ nodeId: node.nodeId, ...(node.sceneId ? { sceneId: node.sceneId } : {}), ...(node.slotId ? { slotId: node.slotId } : {}), model: node.model, quoted: node.quoted, cost: node.cost ?? null, currency: node.currency ?? null, ...(node.estimateStatus ? { estimateStatus: node.estimateStatus } : {}) })),
          workflowVersion: quote.workflowVersion, episodeVersion: quote.episodeVersion,
        };
      },
    },
    {
      name: 'workflow_run_start', title: 'Start a workflow run',
      description: 'Starts execution of the selected nodes. Free stages (trend, news, research, script, storyboard, layout, render) run directly and the run stops at review nodes awaiting a human. Runs containing generate nodes spend money: they are refused unless the server operator enabled AGENT_API_ALLOW_PAID_GENERATION, and then still require allowGeneration:true, disclosure, generationPlanId and generationFingerprint from a fresh workflow_quote.',
      inputSchema: obj({
        workflowId: ID, episodeId: ID, execution: EXECUTION, expectedWorkflowVersion: VERSION, expectedEpisodeVersion: VERSION,
        allowGeneration: { type: 'boolean' }, disclosure: DISCLOSURE, generationPlanId: ID, generationFingerprint: { type: 'string', minLength: 1, maxLength: 200 }, acceptUnquotedEstimate: { type: 'boolean' },
      }, ['workflowId', 'episodeId', 'execution']),
      annotations: hints(false, false, false, true),
      outputSchema: loose({ run: RUN_SUMMARY }, ['run']),
      run: ({ workflowId, episodeId, ...options }) => {
        const wantsPaid = options.allowGeneration === true || options.generationPlanId !== undefined || options.generationFingerprint !== undefined || options.acceptUnquotedEstimate === true;
        if (wantsPaid && !deps.allowPaidGeneration) throw fail(403, 'Paid generation through the agent API is disabled. The operator must set AGENT_API_ALLOW_PAID_GENERATION=true; otherwise run generation from the Studio UI.', 'agent_paid_generation_disabled');
        return { run: runSummary(workflows.start(workflowId, episodeId, options)) };
      },
    },
    {
      name: 'workflow_run_cancel', title: 'Cancel a workflow run',
      description: 'Stops subsequent stages. A provider request or renderer already in flight may still finish.',
      inputSchema: obj({ workflowId: ID, runId: ID }, ['workflowId', 'runId']),
      annotations: hints(false, true, false, false),
      outputSchema: loose({ run: RUN_SUMMARY }, ['run']),
      run: ({ workflowId, runId }) => ({ run: runSummary(workflows.cancel(workflowId, runId)) }),
    },
    {
      name: 'episode_create', title: 'Create an episode',
      description: 'Creates a draft 9:16 episode with one starter scene under an existing channel.',
      inputSchema: obj({ channelId: ID, title: str(200), topic: str(500), category: str(100) }, ['channelId', 'title']),
      annotations: hints(false, false, false, false),
      outputSchema: loose({ episode: EPISODE_SUMMARY }, ['episode']),
      run: ({ channelId, title, topic, category }) => {
        const channel = store.get('channels', channelId);
        const created = store.create('episodes', { channelId: channel.id, title: text(title, 'title', 200), topic: text(topic, 'topic', 500, title), category: text(category, 'category', 100, channel.category), status: 'draft', format: '9:16', version: 1, scenes: [starterScene('오프닝', title)], notes: '' });
        return { episode: episodeSummary(created) };
      },
    },
    {
      name: 'episode_update', title: 'Update episode fields or scenes',
      description: 'Updates title, topic, notes, status, format or the full scenes array under optimistic concurrency. Scenes replace the existing list and may reference only registered uploads. Stale expectedVersion returns 409. Music is not editable through this operation.',
      inputSchema: obj({ episodeId: ID, expectedVersion: VERSION, title: str(200), topic: str(500), notes: { type: 'string', maxLength: 20000 }, status: { type: 'string', enum: ['draft', 'review', 'ready'] }, format: { type: 'string', enum: ['9:16', '16:9', '1:1'] }, scenes: arrayOf(loose({}), { minItems: 1, maxItems: 60 }) }, ['episodeId', 'expectedVersion']),
      annotations: hints(false, true, false, false),
      outputSchema: loose({ episode: EPISODE_SUMMARY }, ['episode']),
      run: ({ episodeId, expectedVersion, ...fields }) => {
        const patch = episodePatch(fields);
        if (patch.scenes) deps.validateAssets?.(patch.scenes);
        return { episode: episodeSummary(store.updateEpisode(episodeId, patch, expectedVersion, 'agent-api')) };
      },
    },
    {
      name: 'episode_render', title: 'Render an episode to MP4',
      description: 'Queues an FFmpeg render of the exact episode version. Returns a job to poll with render_job_get. Rendering is local and free; it does not publish.',
      inputSchema: obj({ episodeId: ID, expectedVersion: VERSION }, ['episodeId', 'expectedVersion']),
      annotations: hints(false, false, false, false),
      outputSchema: loose({ job: JOB_SUMMARY }, ['job']),
      run: ({ episodeId, expectedVersion }) => {
        const episode = store.assertEpisodeActive(episodeId);
        if (episode.version !== expectedVersion) throw fail(409, `Episode changed: current version is ${episode.version}. Refresh before rendering.`, 'stale_version', { currentVersion: episode.version });
        return { job: jobSummary(deps.enqueueRender(episode, false, 'manual')) };
      },
    },
  ].sort((a, b) => a.name.localeCompare(b.name));

  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const describe = ({ run, ...rest }) => ({ ...rest, mutating: !rest.annotations.readOnlyHint });

  return {
    version: OPERATIONS_VERSION,
    catalog: () => definitions.map(describe),
    has: (name) => byName.has(name),
    async invoke(name, rawArguments) {
      const definition = byName.get(name);
      if (!definition) throw fail(404, `Unknown operation: ${name}`, 'unknown_operation');
      const args = rawArguments === undefined ? {} : rawArguments;
      const problems = validateSchema(definition.inputSchema, args);
      if (problems.length) throw fail(400, `Invalid arguments: ${problems.slice(0, 5).join('; ')}`, 'invalid_arguments');
      let result;
      try { result = await definition.run(args); } catch (error) { throw classify(error); }
      const defects = validateSchema(definition.outputSchema, result);
      if (defects.length) {
        console.error(`Agent operation ${name} violated its output schema: ${defects.slice(0, 3).join('; ')}`);
        throw fail(500, `Operation ${name} produced a result that does not match its output schema`, 'invalid_result');
      }
      return result;
    },
  };
}
