import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

// Regression coverage for agent://FinalWorkflowReview findings F1, F3 and F6. No real
// provider calls: every generation/render/integration hook below is mocked or forbidden
// (throws on any unexpected invocation). Contract: local://workflow-plan-contract.md
// "Plan/quote/run agree" and "Paid generation safety (do not weaken)".
//
// Each assertion below was mechanically traced against the CURRENT, unmodified HEAD of
// server/workflows.mjs by hand-substituting concrete run ids through stageSelection() and
// execute() line by line (not merely restated from the reviewer's inference):
//
// F1 (server/workflows.mjs:429,439,253-258,1322-1356): once a generate node is invalidated
// by a rerun of its nearest scene producer AND that prior job is already settled, its
// generationIntent/output.generationJobId are correctly dropped (line 429) -- but the
// requestId-pattern fallback in priorGenerationJob() (lines 253-258), reached independently
// from stageSelection's resolvedJob (line 434) and from execute()'s own rawPrior/resumingJob
// (lines 1322-1335), can still re-resolve the OLD settled job through the severed lineage's
// resumedFrom chain. stageSelection and execute() anchor that pattern on DIFFERENT runs
// (source.resumedFrom vs run.resumedFrom, one hop apart), so stageSelection silently stamps
// the old job's id onto the new queued nodeRun while execute() independently computes a
// requestId that does not match that job's real requestId -- throwing 'The original
// generation job differs from the approved node input' (line 1356) only AFTER the user
// already consented to a quote. Since nodeOutput(prior) is genuinely absent at every step
// (reusableNodeRun(prior) is false throughout, by construction), the paid-reuse early-return
// (line 452) can never fire here regardless of a fix -- the only coherent corrected outcome
// is a genuinely fresh paid submission, verified below as an exact provider-call-count.
//
// F6 (server/workflows.mjs:434,447,451): the raw-legacy strict-reject guard
// ('Cannot rerun script, storyboard or layout while reusing a paid generation job') resolves
// its own job reference (guardJob) via the SAME single-hop requestId-pattern fallback. When
// the run that actually paid the job is itself non-root (resumed from an earlier prep run),
// a legacy rerun exactly ONE further hop downstream of an intermediate run fails to resolve
// the pattern (it only reaches one level of indirection), so guardJob resolves to undefined
// and the documented "legacy explicit bodies keep their strict behaviour" (docs/harness.md:93)
// silently does not hold -- verified below as a direct 1-hop-vs-2-hop behavioural contrast
// from an otherwise identical request.
//
// F3 (server/workflows.mjs:372-379,1157-1162 vs :1111): a user-skipped, output-less
// optional producer (layout or storyboard) with no reusable output is correctly, silently
// omitted by stageSelection's reuse() (line 339) -- /plan reports blocked:false. But both
// stageSelection's render branch (line 377) and WorkflowEngine.renderCandidate (line 1160)
// pick the scene producer PURELY structurally (by graph ancestry), unlike generate's already
// availability-aware pick (line 1111, `layout && outputs.has(layout.id) && ...`). So a run
// /plan reported as runnable can deterministically fail inside execute()'s render step with
// 'Render requires completed scene evidence from its connected producer', even after an
// upstream generate node has already spent and applied real money. Verified below as a
// direct violation of the "plan and the actual run outcome agree" contract: /plan's
// blocked:false is pinned to current, code-certain behaviour; the run reaching a genuine
// 'completed' terminal status is the corrected expectation (fix direction: availability-aware
// render pick, mirroring line 1111 -- the review's OTHER offered direction, blocking at plan
// time with a skipped_prerequisite code, would instead flip plan.blocked to true and is an
// intentional, visible break point for this test, not something silently tolerated here).

const GEN_BYTES = Buffer.from('frameforge workflow-final-edge fixture generated image');
const RENDER_BYTES = Buffer.from('frameforge workflow-final-edge fixture render, not a real MP4');
const disclosure = { containsSyntheticMedia: true, rationale: 'Fixture illustration only, reviewed before quoting' };
const LEGACY_GUARD_MESSAGE = 'Cannot rerun script, storyboard or layout while reusing a paid generation job';

const node = (id, type, config = {}) => ({ id, type, x: 0, y: 0, config });
const record = (run, id) => run.nodeRuns.find((item) => item.nodeId === id);

// script(existing) -> board(storyboard) -> generate -> render. No layout, no review/publish:
// keeps F1/F6's lineage chains minimal and matches the proven shape of
// tests/workflow-paid-lost-source.test.mjs's CHAIN_GRAPH and tests/workflow-plan.test.mjs's
// PK-hop fixture. 'render' is deliberately never selected by any step below (the fixture's
// renderer is a forbidden stub): F1/F6 only ever target ancestors of 'generate'.
const CHAIN_GRAPH = {
  name: 'Final-edge chain fixture',
  nodes: [node('script', 'script', { agent: 'existing' }), node('board', 'storyboard'), node('generate', 'generate', { model: 'fixture_image', prompt: 'Fixture', sceneIndex: 0 }), node('render', 'render')],
  edges: [{ id: 'e1', source: 'script', target: 'board' }, { id: 'e2', source: 'board', target: 'generate' }, { id: 'e3', source: 'generate', target: 'render' }],
};

// script -> board -> layout -> generate -> render (layout sits structurally between
// storyboard and generate, as in the full preset the review's F3 scenario describes).
const LAYOUT_CHAIN_GRAPH = {
  name: 'Final-edge layout-generate fixture',
  nodes: [node('script', 'script', { agent: 'existing' }), node('board', 'storyboard'), node('layout', 'layout'), node('generate', 'generate', { model: 'fixture_image', prompt: 'Fixture', sceneIndex: 0 }), node('render', 'render')],
  edges: [{ id: 'e1', source: 'script', target: 'board' }, { id: 'e2', source: 'board', target: 'layout' }, { id: 'e3', source: 'layout', target: 'generate' }, { id: 'e4', source: 'generate', target: 'render' }],
};

// script -> board -> layout -> render. No generate node: isolates F3's render-side bug from
// any payment, proving it is not generate-specific.
const LAYOUT_NO_GENERATE_GRAPH = {
  name: 'Final-edge layout-only fixture',
  nodes: [node('script', 'script', { agent: 'existing' }), node('board', 'storyboard'), node('layout', 'layout'), node('render', 'render')],
  edges: [{ id: 'e1', source: 'script', target: 'board' }, { id: 'e2', source: 'board', target: 'layout' }, { id: 'e3', source: 'layout', target: 'render' }],
};

// script -> board -> render. No layout, no generate: the simplest form of "a skipped
// storyboard feeds render", per F1's recommendation ("and the same for a skipped
// storyboard").
const STORYBOARD_ONLY_GRAPH = {
  name: 'Final-edge storyboard-only fixture',
  nodes: [node('script', 'script', { agent: 'existing' }), node('board', 'storyboard'), node('render', 'render')],
  edges: [{ id: 'e1', source: 'script', target: 'board' }, { id: 'e2', source: 'board', target: 'render' }],
};

async function fixture(t, graph, { withGeneration = true, create, renderSucceeds = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-final-edge-'));
  const forbidden = async () => { throw new Error('Unexpected external/paid operation in a final-edge fixture'); };
  let submits = 0;
  const defaultCreate = async () => ({ requestId: `fixture-final-edge-${submits}`, status: 'completed', outputs: [{ url: `https://images.higgs.ai/fixture-${submits}.png`, type: 'image' }] });
  const generation = withGeneration ? {
    capability: async () => ({ available: true }), models: forbidden,
    modelSchema: async (model) => ({ id: model, type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    estimate: async () => ({ cost: 1, currency: 'USD', quoted: true }),
    create: async (...args) => { submits++; return (create || defaultCreate)(...args); },
    status: forbidden,
  } : { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, status: forbidden };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}), fetchTrends: forbidden, runAgent: forbidden },
    generation,
    generationOptions: withGeneration ? {
      download: async (_url, file) => { await writeFile(file, GEN_BYTES); return { bytes: GEN_BYTES.length, contentType: 'image/png' }; },
      probe: async () => ({ kind: 'image', width: 64, height: 64 }),
    } : undefined,
    // F1/F6 never select 'render' (always a descendant of their targets): forbidden proves
    // that, loudly. F3a/b/c DO select and expect render to reach 'completed' once
    // renderCandidate's availability-aware fix stops throwing before this.render() is ever
    // called -- those need a real, succeeding stub (same shape as
    // tests/workflow-paid-lost-source.test.mjs's renderer), not a forbidden one.
    renderer: renderSucceeds
      ? async (_episode, { dataDir: root }) => { await writeFile(join(root, 'exports', 'final-edge-fixture.mp4'), RENDER_BYTES); return { filename: 'final-edge-fixture.mp4', outputUrl: '/api/exports/final-edge-fixture.mp4', sha256: 'final-edge-fixture' }; }
      : forbidden,
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = async (path, method = 'GET', body) => { const response = await request(path, method, body); const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value; };
  const channel = await api('/api/channels', 'POST', { name: 'Final-edge fixture owner', category: 'information', platform: 'YouTube' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Final-edge fixture project', topic: 'Fixture topic' });
  const template = await api('/api/workflows', 'POST', graph);
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const current = async () => (await api('/api/state')).episodes.find((item) => item.id === episode.id);
  const waitRun = async (id) => {
    for (let turn = 0; turn < 5000; turn++) {
      const run = await api(`/api/workflow-runs/${id}`);
      if (['completed', 'failed', 'cancelled', 'awaiting_review', 'approved', 'changes_requested'].includes(run.status)) return run;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`Run ${id} did not reach a terminal state`);
  };
  const toggleSkip = async (nodeId, skipped = true) => {
    const wf = (await api('/api/state')).workflows.find((item) => item.id === workflow.id);
    return api(`/api/workflows/${workflow.id}/skips`, 'POST', { nodeId, skipped, expectedVersion: wf.version });
  };
  return { api, request, channel, episode, workflow, current, waitRun, toggleSkip, dataDir, submits: () => submits };
}

test('F1: a root paid run, a node-run on the nearest scene producer alone, then a node-run on generate alone must reach genuine success with an exact fresh provider call -- never the post-consent mismatched-job 409 from a severed lineage resurrected through the requestId-pattern fallback', async (t) => {
  const f = await fixture(t, CHAIN_GRAPH);

  // S1: root paid run (no resumedFrom). mode:'node' targetNodeId:'generate' selects exactly
  // generate's ancestors (script, board) plus generate itself -- never 'render' (a
  // descendant), so the forbidden renderer stub is never reached.
  const ep0 = await f.current();
  const plan1Response = await f.request(`/api/workflows/${f.workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution: { mode: 'node', targetNodeId: 'generate' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep0.version });
  assert.equal(plan1Response.status, 200, await plan1Response.clone().text());
  const plan1 = await plan1Response.json();
  assert.equal(plan1.blocked, false, JSON.stringify(plan1));
  assert.deepEqual(plan1.selectedStages, ['script', 'board', 'generate']);
  assert.equal(plan1.resumeRunId, null, 'upstream flow: a first run has no resume source');

  const quote1Response = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, execution: { mode: 'node', targetNodeId: 'generate' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep0.version, disclosure });
  assert.equal(quote1Response.status, 200, await quote1Response.clone().text());
  const quoted1 = await quote1Response.json();
  assert.deepEqual(quoted1.selectedStages, plan1.selectedStages, 'approved quote must agree with /plan');

  const run1Response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, execution: { mode: 'node', targetNodeId: 'generate' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep0.version, allowGeneration: true, disclosure, generationPlanId: quoted1.id, generationFingerprint: quoted1.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(run1Response.status, 202, await run1Response.clone().text(), 'run creation must agree with the approved quote');
  const s1 = await f.waitRun((await run1Response.json()).id);
  assert.equal(s1.status, 'completed', JSON.stringify(s1));
  assert.equal(f.submits(), 1);
  const job1Id = record(s1, 'generate').output.generationJobId;
  const job1Before = await f.api(`/api/generations/${job1Id}`);
  assert.equal(job1Before.status, 'completed');
  assert.equal(job1Before.applied, true);

  // S2: node-run on the nearest scene producer ('board', the storyboard) alone, resumed
  // from S1 via the real user-click auto-resolve path (mode:'node' targetNodeId:'board').
  // This invalidates 'generate' (a descendant) without reselecting it: stageSelection must
  // drop its stale generationIntent/output.generationJobId per addendum A (workflows.mjs:429),
  // leaving only a staleFrom pointer -- not a resurrectable job reference.
  const ep1 = await f.current();
  const plan2Response = await f.request(`/api/workflows/${f.workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution: { mode: 'node', targetNodeId: 'board' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version });
  assert.equal(plan2Response.status, 200, await plan2Response.clone().text());
  const plan2 = await plan2Response.json();
  assert.equal(plan2.blocked, false, JSON.stringify(plan2));
  assert.deepEqual(plan2.selectedStages, ['board']);
  assert.equal(plan2.resumeRunId, s1.id, 'upstream flow: S2 must resume from S1');

  const run2Response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, execution: { mode: 'node', targetNodeId: 'board' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version });
  assert.equal(run2Response.status, 202, await run2Response.clone().text());
  const s2 = await f.waitRun((await run2Response.json()).id);
  assert.equal(s2.status, 'completed', JSON.stringify(s2));
  const s2Generate = record(s2, 'generate');
  assert.equal(s2Generate.status, 'skipped');
  assert.equal(s2Generate.skipReason, 'unselected');
  assert.equal(s2Generate.output, undefined, 'the invalidated, settled generate node must carry no output pointer forward');
  assert.equal(s2Generate.generationIntent, undefined, 'the invalidated, settled generate node must carry no intent forward');
  assert.equal(s2Generate.staleFrom, s1.id);
  assert.equal(record(s2, 'script').reused, true);
  assert.equal(record(s2, 'script').reusedFrom, s1.id);
  assert.equal(record(s2, 'board').reused, undefined, 'board itself actually ran in S2, it was not reused');
  assert.equal(record(s2, 'board').status, 'completed');

  // S3: node-run targeting 'generate' alone (the real user action: click the generate node
  // again). Auto-resolves resumeRunId to S2 -- two hops from the run that actually paid
  // job1.
  const ep2 = await f.current();
  const plan3Response = await f.request(`/api/workflows/${f.workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution: { mode: 'node', targetNodeId: 'generate' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep2.version });
  assert.equal(plan3Response.status, 200, await plan3Response.clone().text());
  const plan3 = await plan3Response.json();
  assert.equal(plan3.blocked, false, JSON.stringify(plan3));
  assert.deepEqual(plan3.selectedStages, ['generate']);
  assert.equal(plan3.resumeRunId, s2.id, 'upstream flow: S3 must resume from S2, not resurrect S1 directly');

  const quote3Response = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, execution: { mode: 'node', targetNodeId: 'generate' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep2.version, disclosure });
  assert.equal(quote3Response.status, 200, await quote3Response.clone().text());
  const quoted3 = await quote3Response.json();
  assert.deepEqual(quoted3.selectedStages, plan3.selectedStages, 'approved quote must agree with /plan');
  assert.equal(quoted3.resumeRunId, s2.id);

  const run3Response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, execution: { mode: 'node', targetNodeId: 'generate' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep2.version, allowGeneration: true, disclosure, generationPlanId: quoted3.id, generationFingerprint: quoted3.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(run3Response.status, 202, await run3Response.clone().text(), 'run creation must agree with the approved quote');
  const s3 = await f.waitRun((await run3Response.json()).id);

  // The core invariant: a severed (staleFrom-only, pointer-less) prior must never be
  // resurrected via the requestId-pattern fallback as this lineage's governing job. Since
  // S2's generate nodeRun genuinely has no output (reusableNodeRun(prior) is false by
  // construction, independent of any fix), the paid-reuse path can never legitimately fire
  // here -- the only coherent corrected outcome is a GENUINELY FRESH paid submission, never
  // a resurrected job1 and never the post-consent mismatched-job 409.
  assert.equal(s3.status, 'completed', `S3 must reach a genuine terminal success, not fail post-consent: ${JSON.stringify(s3)}`);
  assert.equal(s3.error, undefined);
  const s3Generate = record(s3, 'generate');
  assert.equal(s3Generate.status, 'completed');
  assert.equal(s3Generate.reused, undefined, 'generate must not silently reuse job1: its own prior nodeRun carries no output to reuse from');
  assert.ok(s3Generate.output?.generationJobId, 'generate must end with a real job pointer, never a dangling stale reference');

  // Exact provider call count: exactly one fresh submission on top of job1's original call
  // -- never zero (never a silent, incorrect reuse of a job severed from this lineage) and
  // never more than one (never a repeated/duplicate submission).
  assert.equal(f.submits(), 2, 'S3 must submit exactly one fresh paid generation, distinct from job1');
  const freshJobId = s3Generate.output.generationJobId;
  assert.notEqual(freshJobId, job1Id, 'the fresh job must be a genuinely new submission, not a resurrected reference to job1');

  const job1After = await f.api(`/api/generations/${job1Id}`);
  assert.deepEqual(job1After, job1Before, 'the original settled job1 must be completely untouched by the later, severed lineage');

  // No silent data loss: the scene must carry a real, applied asset tied to the fresh job
  // -- never left blank because the stale job1 pointer was silently dropped without a
  // replacement.
  const freshJob = await f.api(`/api/generations/${freshJobId}`);
  assert.equal(freshJob.status, 'completed');
  assert.equal(freshJob.applied, true);
  const finalEpisode = await f.current();
  const scene = finalEpisode.scenes.find((item) => item.id === freshJob.sceneId);
  assert.ok(scene, 'the generated scene must still exist');
  assert.ok(scene.assetUrl, 'the scene must carry a real applied asset, never silently blank');
  assert.equal(scene.source?.generationJobId, freshJobId);
});

test('F6: the raw-legacy strict-reject guard for rerunning storyboard while reusing a paid generation job must block identically regardless of lineage depth, not only when the paying run is directly resumed from', async (t) => {
  let creates = 0;
  const f = await fixture(t, CHAIN_GRAPH, { create: async () => { creates++; if (creates > 1) throw new Error('Fixture: no second paid submission expected in F6 -- the guard must block before any provider call'); return { requestId: 'fixture-f6-only-submission', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture-f6.png', type: 'image' }] }; } });

  // R0: root prep run, script+board only, no generate -- never pays.
  const ep0 = await f.current();
  const r0Response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep0.version, selectedStages: ['script', 'board'], startStage: 'script' });
  assert.equal(r0Response.status, 202, await r0Response.clone().text());
  const r0 = await f.waitRun((await r0Response.json()).id);
  assert.equal(r0.status, 'completed', JSON.stringify(r0));

  // R1: resumed from R0 (so R1 is itself NON-root), pays job via legacy body targeting
  // 'generate' alone. job's requestId is built from `${R1.resumedFrom||R1.id}:generate` =
  // `${R0.id}:generate` -- the critical lineage fact that exposes the 2-hop gap below.
  const ep1 = await f.current();
  const r1QuoteResponse = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['generate'], startStage: 'generate', resumeRunId: r0.id, disclosure });
  assert.equal(r1QuoteResponse.status, 200, await r1QuoteResponse.clone().text());
  const r1Quoted = await r1QuoteResponse.json();
  const r1Response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['generate'], startStage: 'generate', resumeRunId: r0.id, allowGeneration: true, disclosure, generationPlanId: r1Quoted.id, generationFingerprint: r1Quoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(r1Response.status, 202, await r1Response.clone().text());
  const r1 = await f.waitRun((await r1Response.json()).id);
  assert.equal(r1.status, 'completed', JSON.stringify(r1));
  assert.equal(f.submits(), 1);
  assert.equal(record(r1, 'generate').output.generationJobId !== undefined, true);

  // Control (1-hop): a direct legacy rerun of board+generate+render resumed straight off
  // R1 -- the run that actually paid -- must be strictly blocked. This is the already-known-
  // good shape (matching tests/workflow-plan.test.mjs's and tests/workflows.test.mjs's
  // existing 1-hop coverage); proving it here first confirms this fixture's lineage is sound
  // before the 2-hop case below is exercised.
  const epControl = await f.current();
  const controlResponse = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: epControl.version, selectedStages: ['board', 'generate', 'render'], startStage: 'board', resumeRunId: r1.id, disclosure });
  assert.equal(controlResponse.status, 409, await controlResponse.clone().text());
  assert.equal((await controlResponse.json()).error, LEGACY_GUARD_MESSAGE, '1-hop control: directly off the paying run, the guard must fire');
  assert.equal(f.submits(), 1, 'the blocked control quote must never reach the provider');

  // R2: legacy rerun of 'script' alone, resumed from R1. Invalidates board/generate/render
  // without reselecting them: generate's nodeRun ends up with only a staleFrom pointer to
  // R1 (no output, no generationIntent) -- identical shape to F1's S2.
  const ep2 = await f.current();
  const r2Response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep2.version, selectedStages: ['script'], startStage: 'script', resumeRunId: r1.id });
  assert.equal(r2Response.status, 202, await r2Response.clone().text());
  const r2 = await f.waitRun((await r2Response.json()).id);
  assert.equal(r2.status, 'completed', JSON.stringify(r2));
  const r2Generate = record(r2, 'generate');
  assert.equal(r2Generate.output, undefined);
  assert.equal(r2Generate.generationIntent, undefined);
  assert.equal(r2Generate.staleFrom, r1.id);

  // Actual (2-hop): the IDENTICAL semantic request -- reselect board+generate+render while
  // a paid, unresolved-from-this-lineage job still exists -- but resumed from R2, two hops
  // from R1 (the run that actually paid). docs/harness.md:93 states legacy explicit bodies
  // "keep their strict behaviour" without qualifying that to 1-hop lineage depth only: the
  // same request that correctly 409s one hop closer to the payer must not silently diverge
  // just because an unrelated ancestor (script) happened to rerun in between.
  const ep3 = await f.current();
  const actualResponse = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep3.version, selectedStages: ['board', 'generate', 'render'], startStage: 'board', resumeRunId: r2.id, disclosure });
  assert.equal(actualResponse.status, 409, await actualResponse.clone().text(), '2-hop: the identical rerun-while-paid-job-exists request must block exactly like the 1-hop control, not silently diverge by lineage depth');
  assert.equal((await actualResponse.json()).error, LEGACY_GUARD_MESSAGE);
  assert.equal(f.submits(), 1, 'the blocked 2-hop quote must never reach the provider -- no duplicate paid submission');
});

test('F3a: a user-skipped, output-less layout silently omitted from planning must not later cause a consented, already-paid run to fail at render -- plan and the actual run outcome must agree', async (t) => {
  const f = await fixture(t, LAYOUT_CHAIN_GRAPH, { renderSucceeds: true });
  await f.toggleSkip('layout', true);

  const ep = await f.current();
  const planResponse = await f.request(`/api/workflows/${f.workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution: { mode: 'all' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.deepEqual(plan.selectedStages, ['script', 'board', 'generate', 'render'], 'layout must be silently omitted, never block the plan (docs/harness.md:96)');
  const layoutEntry = plan.nodes.find((item) => item.nodeId === 'layout');
  assert.equal(layoutEntry.action, 'skip');

  const quoteResponse = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, execution: { mode: 'all' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version, disclosure });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();
  assert.deepEqual(quoted.selectedStages, plan.selectedStages, 'approved quote must agree with /plan');
  assert.ok(quoted.candidate.nodes.some((item) => item.nodeId === 'generate'), 'generate must fall back to the available storyboard producer, matching prepareCandidate (workflows.mjs:1111)');

  const runResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, execution: { mode: 'all' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version, allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(runResponse.status, 202, await runResponse.clone().text(), 'run creation must agree with the approved quote');
  const run = await f.waitRun((await runResponse.json()).id);

  // Unambiguous regardless of fix direction: generate's own availability-aware pick
  // (workflows.mjs:1111, unchanged by any render-side fix) already succeeds and pays exactly
  // once -- this part of the trace is already correct today.
  const layoutNodeRun = record(run, 'layout');
  assert.equal(layoutNodeRun.status, 'skipped');
  assert.equal(layoutNodeRun.skipReason, 'user');
  const generateNodeRun = record(run, 'generate');
  assert.equal(generateNodeRun.status, 'completed', `generate must succeed and pay via its existing availability-aware fallback: ${JSON.stringify(run)}`);
  assert.equal(f.submits(), 1, 'exactly one paid submission -- the structural render bug below must not cause a retry or duplicate');
  const jobId = generateNodeRun.output.generationJobId;
  const job = await f.api(`/api/generations/${jobId}`);
  assert.equal(job.status, 'completed');
  assert.equal(job.applied, true);

  // The actual invariant under test: /plan promised this run was runnable (blocked:false,
  // render included in selectedStages) -- the run must not then deterministically fail at
  // render for a reason entirely knowable from the static graph+skip state at plan time.
  assert.equal(run.status, 'completed', `plan said runnable (blocked:false, render selected) but the run ended '${run.status}' with error '${run.error}' -- plan and the actual outcome must agree: ${JSON.stringify(run)}`);

  // No silent data loss regardless: the paid, applied asset must still be on the scene even
  // while this is being investigated.
  const finalEpisode = await f.current();
  const paidScene = finalEpisode.scenes.find((item) => item.id === job.sceneId);
  assert.ok(paidScene?.assetUrl, 'the paid, applied generation must never be silently lost from the episode');
});

test('F3b: the same structural render failure reproduces with no generate node and no payment at risk -- proving it is a producer-pick bug, not something specific to the generate path', async (t) => {
  const f = await fixture(t, LAYOUT_NO_GENERATE_GRAPH, { withGeneration: false, renderSucceeds: true });
  await f.toggleSkip('layout', true);

  const ep = await f.current();
  const planResponse = await f.request(`/api/workflows/${f.workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution: { mode: 'all' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.deepEqual(plan.selectedStages, ['script', 'board', 'render']);

  const runResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, execution: { mode: 'all' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version });
  assert.equal(runResponse.status, 202, await runResponse.clone().text());
  const run = await f.waitRun((await runResponse.json()).id);

  assert.equal(record(run, 'layout').status, 'skipped');
  assert.equal(record(run, 'board').status, 'completed', 'the storyboard itself must run and produce real output');
  assert.equal(f.submits(), 0, 'no generation node exists: zero provider calls in either outcome');
  assert.equal(run.status, 'completed', `plan said runnable but the run ended '${run.status}' with error '${run.error}' with no payment ever at risk: ${JSON.stringify(run)}`);
});

test('F3c: a user-skipped, output-less storyboard with no layout node reproduces the identical structural render failure', async (t) => {
  const f = await fixture(t, STORYBOARD_ONLY_GRAPH, { withGeneration: false, renderSucceeds: true });
  await f.toggleSkip('board', true);

  const ep = await f.current();
  const planResponse = await f.request(`/api/workflows/${f.workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution: { mode: 'all' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.deepEqual(plan.selectedStages, ['script', 'render'], 'storyboard must be silently omitted, never block the plan');

  const runResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, execution: { mode: 'all' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version });
  assert.equal(runResponse.status, 202, await runResponse.clone().text());
  const run = await f.waitRun((await runResponse.json()).id);

  assert.equal(record(run, 'board').status, 'skipped');
  assert.equal(record(run, 'board').skipReason, 'user');
  assert.equal(f.submits(), 0);
  assert.equal(run.status, 'completed', `plan said runnable but the run ended '${run.status}' with error '${run.error}': ${JSON.stringify(run)}`);
});
