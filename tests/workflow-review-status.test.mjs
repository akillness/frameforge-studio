import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

// Investigates F2 (agent://FinalWorkflowReview): server/workflows.mjs's reviewStatus()
// correctly scopes which review nodeRuns gate a run's aggregate status to
// selectedStages + hardRequiredReviewIds (the exact review a selected publish node's
// HARD_DEPENDENCY resolves to) -- deliberately excluding a review pulled in only by the
// generic edge-parent reuse loop (workflows.mjs:356-358), since reusableNodeRun()
// (workflows.mjs:229-232) treats changes_requested/awaiting_review as reusable just like
// approved. Before the coordinated fix, server/store.mjs's commitWorkflowReview (the human
// decision commit path, called on every /review POST) recomputed run.status over EVERY
// non-skipped review nodeRun with no such scope, so an incidentally reused
// changes_requested/awaiting_review sibling review could flip a run's aggregate status
// even after its own real gating review was approved -- contradicting the scoped intent
// and disagreeing with /plan's publish check (which reads only node-level review
// approval, never run.status: workflows.mjs:393-395). This file asserts the TARGET
// (fixed, scoped) behavior per coordination with FinalReviewStoreFix, who scoped
// commitWorkflowReview via a local mirror of reviewStatus()/hardRequiredReviewIds() in
// store.mjs. No application source is modified by this file.
//
// This file makes NO real external/paid calls: generation/trend/agent/media/youtube/
// publication fetchImpl are all stubbed to throw, matching tests/workflow-plan.test.mjs's
// `forbidden` convention. The graphs below have no `generate` node, so no quote/consent
// flow or disclosure is required to run them.

const node = (id, type, config = {}) => ({ id, type, x: 0, y: 0, config });
const record = (run, id) => run.nodeRuns.find((item) => item.nodeId === id);
const nodeAction = (plan, id) => plan.nodes.find((item) => item.nodeId === id)?.action;

const RENDER_BYTES = Buffer.from('frameforge workflow-review-status fixture render');
const RENDER_SHA256 = createHash('sha256').update(RENDER_BYTES).digest('hex');

// Exact graph shape of the real app's "Sequential reviewed producers" journey, matching
// the PO regression at tests/workflow-plan.test.mjs:1451 (that test only covers an
// incidentally reused APPROVED sibling; this file covers reused changes_requested/
// awaiting_review, the actual F2 gap).
const DOUBLE_REVIEW_TYPES = ['script', 'storyboard', 'render-1', 'review-1', 'render-2', 'review-2', 'publish'];
function buildDoubleReviewGraph() {
  const nodes = DOUBLE_REVIEW_TYPES.map((id) => node(id, id.replace(/-\d$/, ''), id === 'script' ? { agent: 'existing' } : {}));
  const edges = DOUBLE_REVIEW_TYPES.slice(1).map((target, i) => ({ id: `e${i}`, source: DOUBLE_REVIEW_TYPES[i], target }));
  return { name: 'Sequential reviewed producers (F2 review-status fixture)', nodes, edges };
}

// Single render->review branch: the review is unambiguously both selected AND the only
// review in the run -- a baseline comparison proving a legitimately required review still
// gates run.status on its real decision after the scoping fix (no over-correction to
// always-approved).
const SINGLE_REVIEW_TYPES = ['script', 'storyboard', 'render', 'review'];
function buildSingleReviewGraph() {
  const nodes = SINGLE_REVIEW_TYPES.map((id) => node(id, id, id === 'script' ? { agent: 'existing' } : {}));
  const edges = SINGLE_REVIEW_TYPES.slice(1).map((target, i) => ({ id: `e${i}`, source: SINGLE_REVIEW_TYPES[i], target }));
  return { name: 'Single reviewed producer (F2 review-status comparison)', nodes, edges };
}

async function setup(t, graph) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-review-status-'));
  const forbidden = async () => { throw new Error('Unexpected external/paid operation in a review-status fixture'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}), fetchTrends: forbidden, runAgent: forbidden },
    generation: { capability: async () => ({ available: true }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, status: forbidden },
    generationOptions: { download: forbidden, probe: forbidden },
    // Mirrors tests/workflow-plan.test.mjs's renderer exactly: echoes the `sceneIntegrity`
    // it is given back as `verifiedSceneAssets`, so PublicationService._snapshot's
    // verifySceneReceipts (triggered unconditionally because app.mjs's enqueueRender
    // always stamps job.sceneIntegrity, even for an asset-less default scene) sees
    // job.verifiedSceneAssets === output.verifiedSceneAssets === [] and passes cleanly.
    renderer: async (episode, { dataDir: root, sceneIntegrity }) => {
      const filename = `${randomUUID()}.mp4`;
      await writeFile(join(root, 'exports', filename), RENDER_BYTES);
      return { filename, outputUrl: `/api/exports/${filename}`, sha256: RENDER_SHA256, ...(sceneIntegrity ? { verifiedSceneAssets: sceneIntegrity } : {}) };
    },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = async (path, method = 'GET', body) => { const response = await request(path, method, body); const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value; };
  const waitRun = async (id) => {
    for (let turn = 0; turn < 5000; turn++) {
      const run = await api(`/api/workflow-runs/${id}`);
      if (['completed', 'failed', 'cancelled', 'awaiting_review', 'approved', 'changes_requested'].includes(run.status)) return run;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`Run ${id} did not reach a terminal state`);
  };

  const channel = await api('/api/channels', 'POST', { name: 'Review-status fixture owner', category: 'information', platform: 'YouTube' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Review-status fixture project', topic: 'Fixture topic' });
  const template = await api('/api/workflows', 'POST', graph);
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const current = async () => (await api('/api/state')).episodes.find((item) => item.id === episode.id);

  // Raw body (selectedStages+startStage[+resumeRunId]), no `execution` field: this is the
  // legacy-shaped client path (deriveSelection sets legacy:true internally -- never from
  // this body, per workflows.mjs:830-833's documented invariant). Harmless here: `legacy`
  // only affects the generate-node guardJob strict-reject path (F1/F6), and neither graph
  // in this file has a `generate` node. Used for deterministic control over exactly which
  // nodes co-occur as nodeRuns in one run, matching PO's run1 pattern.
  const runStages = async (selectedStages, startStage, extra = {}) => {
    const ep = await current();
    const response = await request(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: ep.version, selectedStages, startStage, ...extra });
    assert.equal(response.status, 202, await response.clone().text());
    return waitRun((await response.json()).id);
  };

  const decideRaw = async (run, reviewNodeId, decision) => request(`/api/workflows/${workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId, decision, notes: `Fixture ${decision} for ${reviewNodeId}`, expectedEpisodeVersion: run.episodeVersion });
  const decide = async (run, reviewNodeId, decision) => {
    const response = await decideRaw(run, reviewNodeId, decision);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };

  const planPublish = async () => {
    const ep = await current();
    const response = await request(`/api/workflows/${workflow.id}/plan`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'publish' }, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: ep.version });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };

  const bindYoutube = async () => {
    const fresh = (await api('/api/state')).channels.find((item) => item.id === channel.id);
    return api(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: `UC${'A'.repeat(22)}`, expectedUpdatedAt: fresh.updatedAt });
  };

  const approve = (run, reviewNodeId) => request('/api/publication/approvals', 'POST', {
    workflowId: workflow.id, runId: run.id, reviewNodeId, expectedEpisodeVersion: run.episodeVersion,
    title: 'Fixture title', description: 'Fixture description', categoryId: '22', tags: ['fixture'],
    selfDeclaredMadeForKids: false, containsSyntheticMedia: false, disclosureRationale: 'Fixture disclosure', rightsAcknowledged: true,
  });

  return { api, request, channel, episode, workflow, current, waitRun, runStages, decide, decideRaw, planPublish, bindYoutube, approve };
}

test('RS1 an incidentally reused changes_requested sibling review must not contaminate the aggregate once this run\'s own gating review is approved, and the real publish gate must agree with /plan', async (t) => {
  const f = await setup(t, buildDoubleReviewGraph());

  // run1: script through review-1. review-1 is a REAL human decision for render-1's branch.
  const run1 = await f.runStages(['script', 'storyboard', 'render-1', 'review-1'], 'script');
  assert.equal(run1.status, 'awaiting_review', JSON.stringify(run1));
  const decided1 = await f.decide(run1, 'review-1', 'changes_requested');
  assert.equal(decided1.status, 'changes_requested', JSON.stringify(decided1));

  // run2: targets render-2+review-2 together (both dirty/unselected in run1), resuming
  // from run1. review-1 sits on render-2's direct edge-parent path and is genuinely
  // reusable evidence for this lineage (reusableNodeRun allows changes_requested), so the
  // generic edge-parent loop (workflows.mjs:356-358) carries it forward -- correctly, as
  // real lineage data, untouched -- while review-2 runs fresh.
  const run2 = await f.runStages(['render-2', 'review-2'], 'render-2', { resumeRunId: run1.id });
  assert.equal(run2.resumedFrom, run1.id);
  const review1InRun2 = record(run2, 'review-1');
  assert.equal(review1InRun2.reused, true, 'review-1 must be genuinely reused (real lineage), not dropped');
  assert.equal(review1InRun2.status, 'changes_requested', 'reused review-1 must keep carrying its real decided status');
  const review2InRun2 = record(run2, 'review-2');
  assert.equal(review2InRun2.reused, undefined, 'review-2 is freshly run in this run, not reused');
  assert.equal(review2InRun2.status, 'awaiting_review');
  // Execute-end status: scoped correctly already (workflows.mjs reviewStatus, the part of
  // F2 NOT in dispute) to selectedStages={render-2,review-2} -- review-1 is irrelevant here.
  assert.equal(run2.status, 'awaiting_review', JSON.stringify(run2), 'execute-end status must be scoped to this run\'s own render-2/review-2, excluding incidentally reused review-1');

  // Sanity/non-regression: review-1 already carries a real decision (from run1) and must
  // stay non-re-decidable even though it is reused into run2's nodeRuns -- this guard
  // (store.mjs reviewCandidate: "already has a decision") is independent of the
  // commitWorkflowReview aggregate-scope fix and must still hold.
  const redecideRejected = await f.decideRaw(run2, 'review-1', 'approved');
  assert.equal(redecideRejected.status, 409, await redecideRejected.clone().text());
  const redecideBody = await redecideRejected.json();
  assert.match(redecideBody.error, /already has a decision|not ready for review/);

  // THE FIX UNDER TEST: deciding review-2 (the only review this run actually needed) must
  // flip run2.status to 'approved', not get dragged back to 'changes_requested' by
  // review-1's unrelated sibling-branch decision incidentally present in nodeRuns.
  const decided2 = await f.decide(run2, 'review-2', 'approved');
  assert.equal(decided2.status, 'approved', JSON.stringify(decided2), 'F2: commitWorkflowReview must scope its aggregate recompute like reviewStatus() does, excluding incidentally reused review-1');
  assert.equal(decided2.reviews['review-2'].decision, 'approved');
  assert.equal(decided2.reviews['review-1'], undefined, 'review-1 was never decided IN this run; its decision belongs to run1');

  // Persisted, not just the POST response.
  const persisted = await f.api(`/api/workflow-runs/${run2.id}`);
  assert.equal(persisted.status, 'approved', JSON.stringify(persisted));

  // /plan's publish check was already correct (node-level only, workflows.mjs:393-395) --
  // confirm it still agrees post-fix, not just pre-fix (where it would have "agreed" by
  // accident while the real gate disagreed).
  const plan = await f.planPublish();
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.equal(nodeAction(plan, 'publish'), 'run');

  // THE REAL PUBLICATION BOUNDARY: PublicationService.approve() independently checks both
  // node-level review approval (publication.mjs:154, already correct) AND run.status not
  // in [failed,cancelled,changes_requested] (publication.mjs:155, fed by the now-fixed
  // aggregate). Before the fix this would 409 ("The selected run is not an approved
  // candidate") despite review-2 being genuinely approved -- exactly the planner/gate
  // disagreement F2 describes. No real external call: fetchImpl stubs stay unused because
  // approve() only stages/validates (POST /api/publication/approvals), it does not publish.
  await f.bindYoutube();
  const run2Current = await f.api(`/api/workflow-runs/${run2.id}`);
  const approval = await f.approve(run2Current, 'review-2');
  assert.equal(approval.status, 201, await approval.clone().text());
  const approvalBody = await approval.json();
  assert.ok(approvalBody.manifest, JSON.stringify(approvalBody));
  assert.equal(approvalBody.manifest.render.sha256, RENDER_SHA256);
});

test('RS2 an incidentally reused awaiting_review sibling (never decided) must not keep the run stuck awaiting_review once this run\'s own gating review is approved; the resulting terminal run must reject further review decisions', async (t) => {
  const f = await setup(t, buildDoubleReviewGraph());

  // run1 stops at review-1 awaiting_review -- deliberately never decided (the worse variant
  // F2's recommendation calls out: an undecided sibling, not just a rejected one).
  const run1 = await f.runStages(['script', 'storyboard', 'render-1', 'review-1'], 'script');
  assert.equal(run1.status, 'awaiting_review', JSON.stringify(run1));

  const run2 = await f.runStages(['render-2', 'review-2'], 'render-2', { resumeRunId: run1.id });
  const review1InRun2 = record(run2, 'review-1');
  assert.equal(review1InRun2.reused, true);
  assert.equal(review1InRun2.status, 'awaiting_review', 'reused review-1 must keep carrying its real (never decided) status');
  assert.equal(run2.status, 'awaiting_review', JSON.stringify(run2));

  // THE FIX UNDER TEST: approving review-2 must reach a genuine terminal 'approved', not
  // stay 'awaiting_review' because reused review-1 is unscoped-aggregated in.
  // (publication.mjs:155's run.status denylist does not include 'awaiting_review', so this
  // specific variant's real-world symptom is NOT a blocked approve() call -- it is a run
  // that incorrectly never reaches a terminal state, which the server/workflows.mjs review()
  // controller gate below demonstrates directly.)
  const decided2 = await f.decide(run2, 'review-2', 'approved');
  assert.equal(decided2.status, 'approved', JSON.stringify(decided2), 'F2: must not stay awaiting_review due to incidentally reused, still-undecided review-1');

  const persisted = await f.api(`/api/workflow-runs/${run2.id}`);
  assert.equal(persisted.status, 'approved', JSON.stringify(persisted));

  // Consequence of a correctly terminal run2: the controller-level gate (workflows.mjs:976,
  // "Review requires a finished execution awaiting human review") must now reject any
  // further review POST against run2 -- including one incidentally targeting the reused
  // review-1, which a contaminated, still-'awaiting_review' run2 would otherwise have
  // accepted (letting a sibling-branch review be "decided" through the wrong run).
  const furtherDecision = await f.decideRaw(persisted, 'review-1', 'approved');
  assert.equal(furtherDecision.status, 409, await furtherDecision.clone().text());
});

test('RS3 comparison: a legitimately required review (the run\'s only review, directly selected) must still gate run.status on its real decision, and the real publish gate must still refuse it -- the fix must not over-correct to always-approved', async (t) => {
  const f = await setup(t, buildSingleReviewGraph());
  const run = await f.runStages(['script', 'storyboard', 'render', 'review'], 'script');
  assert.equal(run.status, 'awaiting_review', JSON.stringify(run));
  const decided = await f.decide(run, 'review', 'changes_requested');
  assert.equal(decided.status, 'changes_requested', JSON.stringify(decided), 'the run\'s own, directly-selected review must still gate status -- no incidental-reuse scoping applies when the review genuinely belongs to this run');
  const persisted = await f.api(`/api/workflow-runs/${run.id}`);
  assert.equal(persisted.status, 'changes_requested', JSON.stringify(persisted));

  await f.bindYoutube();
  const rejected = await f.approve(persisted, 'review');
  assert.equal(rejected.status, 409, await rejected.clone().text());
  const rejectedBody = await rejected.json();
  // Node-level gate (publication.mjs:154) fires first regardless of run.status -- proves
  // node-level approval remains the exact publication authority, independent of the
  // run.status aggregate fix.
  assert.equal(rejectedBody.error, 'The selected review node is not approved', JSON.stringify(rejectedBody));
});

test('RS4 non-regression: a reused APPROVED sibling review plus this run\'s own fresh APPROVED review must still yield an approved aggregate (the PO workflow-plan.test.mjs:1451 shape, now exercised through commitWorkflowReview\'s fixed scoping)', async (t) => {
  const f = await setup(t, buildDoubleReviewGraph());
  const run1 = await f.runStages(['script', 'storyboard', 'render-1', 'review-1'], 'script');
  const decided1 = await f.decide(run1, 'review-1', 'approved');
  assert.equal(decided1.status, 'approved', JSON.stringify(decided1));

  const run2 = await f.runStages(['render-2', 'review-2'], 'render-2', { resumeRunId: run1.id });
  assert.equal(record(run2, 'review-1').status, 'approved');
  assert.equal(run2.status, 'awaiting_review', JSON.stringify(run2));
  const decided2 = await f.decide(run2, 'review-2', 'approved');
  assert.equal(decided2.status, 'approved', JSON.stringify(decided2), 'approved reused sibling + approved own review must stay approved under both scoped and unscoped aggregation -- this case alone cannot distinguish the bug, hence RS1/RS2 above');

  await f.bindYoutube();
  const run2Current = await f.api(`/api/workflow-runs/${run2.id}`);
  const approval = await f.approve(run2Current, 'review-2');
  assert.equal(approval.status, 201, await approval.clone().text());
});
