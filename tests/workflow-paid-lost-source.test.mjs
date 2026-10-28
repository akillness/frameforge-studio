import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';

// Regression coverage for PaidRecoveryReview finding 1 (HIGH): an unsettled paid
// generation job becomes invisible, and therefore re-submittable as a SECOND billable
// provider call, whenever a generate node's resume `source` run is lost. Contract:
// local://workflow-plan-contract.md section "Paid generation safety (do not weaken)".
// Existing coverage: tests/workflow-plan.test.mjs test 'PK' (documents this exact gap
// at its old lines ~1293-1304 as unconstructible without a job-history lookup that
// works even when source is null) and test 'PK-hop' (proves the ORIGINAL single-lineage
// guard already works when source stays a valid, version-matched run).
//
// Two independent triggers sever `source` without settling the prior job:
//   Trigger A: any episode version bump. findResumeSource requires an EXACT
//     run.episodeVersion === episode.version match (workflows.mjs findResumeSource).
//   Trigger B: execution.refresh === true. planExecution drops source unconditionally:
//     `const source = refresh ? null : findResumeSource(...)` (reachable in one click
//     via the UI's run-all-refresh button, public/workflow.js).
// Once source is null, the single-lineage priorGenerationJob() lookup (keyed off
// `source?.resumedFrom || source?.id`) goes blind: a brand-new requestId is minted from
// the NEW run's own id, which cannot collide with the old job's requestId at the dedupe
// check in generations.start(), so a real second paid provider call fires.
//
// Every test below is RED against the server before the fix (a node-scoped,
// lineage-independent hasUnresolvedNodeJob() existence check across ALL runs for a
// node, not just the newest/version-compatible one) and GREEN after it. No real
// Higgsfield/YouTube/Naver/Aside provider is ever called; all generation/integration
// hooks are mocked and throw on any unexpected invocation.

const UNRESOLVED_MESSAGE = '이전 생성 요청이 아직 끝나지 않았거나 결과가 적용되지 않았습니다. 기존 요청을 복구하거나 적용한 뒤 다시 실행하세요.';
const SKIPPED_PREREQUISITE_MESSAGE = '건너뛴 선행 노드에 저장된 결과가 없어 실행할 수 없습니다.';
const GEN_BYTES = Buffer.from('frameforge lost-source fixture generated image');
const RENDER_BYTES = Buffer.from('frameforge lost-source fixture render, not a real MP4');
const disclosure = { containsSyntheticMedia: true, rationale: 'Fixture illustration only, reviewed before quoting' };

const node = (id, type, config = {}) => ({ id, type, x: 0, y: 0, config });
const record = (run, id) => run.nodeRuns.find((item) => item.nodeId === id);

// script(existing) -> board(storyboard) -> generate -> render. script.agent:'existing'
// so prepareCandidate's agent check never fires when script+board+generate are
// submitted together in one legacy run (matches tests/workflow-plan.test.mjs 'PK').
const CHAIN_GRAPH = {
  name: 'Lost-source chain fixture',
  nodes: [node('script', 'script', { agent: 'existing' }), node('board', 'storyboard'), node('generate', 'generate', { model: 'fixture_image', prompt: 'Fixture', sceneIndex: 0 }), node('render', 'render')],
  edges: [{ id: 'e1', source: 'script', target: 'board' }, { id: 'e2', source: 'board', target: 'generate' }, { id: 'e3', source: 'generate', target: 'render' }],
};

// script -> board -> {layout-a, layout-b} -> {generate-a, generate-b}. Two independent
// generate branches off one shared storyboard, for the node-scoped boundary test (LS4).
const DIVERGENT_GRAPH = {
  name: 'Lost-source divergent fixture',
  nodes: [
    node('script', 'script', { agent: 'existing' }), node('board', 'storyboard'),
    node('layout-a', 'layout', { preset: 'premiere-3tier' }), node('layout-b', 'layout', { preset: 'top-image-mid-video' }),
    node('generate-a', 'generate', { model: 'fixture_image', prompt: 'A', sceneIndex: 0 }), node('generate-b', 'generate', { model: 'fixture_image', prompt: 'B', sceneIndex: 0 }),
    node('render-a', 'render'), node('render-b', 'render'),
  ],
  edges: [
    { id: 'e1', source: 'script', target: 'board' }, { id: 'e2', source: 'board', target: 'layout-a' }, { id: 'e3', source: 'board', target: 'layout-b' },
    { id: 'e4', source: 'layout-a', target: 'generate-a' }, { id: 'e5', source: 'layout-b', target: 'generate-b' },
    { id: 'e6', source: 'generate-a', target: 'render-a' }, { id: 'e7', source: 'generate-b', target: 'render-b' },
  ],
};

async function fixture(t, graph, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-lost-source-'));
  const forbidden = async () => { throw new Error('Unexpected external/paid operation in a lost-source fixture'); };
  let submits = 0;
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}), fetchTrends: forbidden, runAgent: forbidden },
    generation: {
      capability: async () => ({ available: true }), models: forbidden,
      modelSchema: async (model) => ({ id: model, type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
      estimate: async () => ({ cost: 1, currency: 'USD', quoted: true }),
      create: async (...args) => { submits++; return overrides.create ? overrides.create(...args) : { requestId: `fixture-${submits}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] }; },
      status: overrides.status || forbidden,
    },
    generationOptions: {
      download: async (_url, file) => { await writeFile(file, GEN_BYTES); return { bytes: GEN_BYTES.length, contentType: 'image/png' }; },
      probe: async () => ({ kind: 'image', width: 64, height: 64 }),
      ...(overrides.generationOptions || {}),
    },
    renderer: async (_episode, { dataDir: root }) => ({ filename: 'fixture.mp4', outputUrl: '/api/exports/fixture.mp4', sha256: 'fixture', ...(await writeFile(join(root, 'exports', 'fixture.mp4'), RENDER_BYTES), {}) }),
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = async (path, method = 'GET', body) => { const response = await request(path, method, body); const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value; };
  const channel = await api('/api/channels', 'POST', { name: 'Lost-source fixture owner', category: 'information', platform: 'YouTube' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Lost-source fixture project', topic: 'Fixture topic' });
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

// Submits script+board+generate together in one legacy run so generate starts with a
// real, node-linked prior job. Returns the run (expected 'failed' since every unresolved
// state used here fails fast: submission_unknown has no providerRequestId at all;
// manual_recovery/'weird_unsupported_state' hits the explicit-recovery-required throw;
// both avoid generations.wait()'s real polling, matching tests/workflow-plan.test.mjs).
async function setup(f) {
  const ep1 = await f.current();
  const quoteResponse = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'generate'], startStage: 'script', disclosure });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();
  const runResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'generate'], startStage: 'script', allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(runResponse.status, 202, await runResponse.clone().text());
  const run1 = await f.waitRun((await runResponse.json()).id);
  return run1;
}

// Shared assertion for every "must still be blocked" scenario: plan/quote/run (execution
// body) all 409 with the given {code, message}; zero new provider submissions; the named
// job record is completely untouched; total generationJobs for the episode stays pinned
// at expectedJobCount. The job-count pin is a continuous, literal proof that an older
// unresolved job and a newer job (settled or not) never coexist beyond expectedJobCount,
// checked fresh on every call -- not a one-shot check that a retry could slip past.
async function assertStillBlocked(f, { execution, code, message, jobId, jobBefore, expectedJobCount, label }) {
  const submitsBefore = f.submits();
  const ep = await f.current();
  const planResponse = await f.request(`/api/workflows/${f.workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version });
  assert.equal(planResponse.status, 200, `${label} plan: ${await planResponse.clone().text()}`);
  const plan = await planResponse.json();
  assert.equal(plan.blocked && plan.blocked.code, code, `${label}: expected blocked.code ${code}, got ${JSON.stringify(plan.blocked)}`);
  assert.equal(plan.blocked.message, message, label);

  const quoteResponse = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, execution, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version });
  assert.equal(quoteResponse.status, 409, `${label} quote: ${await quoteResponse.clone().text()}`);
  assert.equal((await quoteResponse.json()).code, code, label);

  const runResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, execution, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version });
  assert.equal(runResponse.status, 409, `${label} run: ${await runResponse.clone().text()}`);
  assert.equal((await runResponse.json()).code, code, label);

  assert.equal(f.submits(), submitsBefore, `${label}: zero new provider submissions`);
  if (jobId) assert.deepEqual(await f.api(`/api/generations/${jobId}`), jobBefore, `${label}: the unresolved job record must be completely untouched`);
  if (expectedJobCount !== undefined) {
    const state = await f.api('/api/state');
    assert.equal(state.generationJobs.filter((job) => job.episodeId === f.episode.id).length, expectedJobCount, `${label}: total generationJobs for this episode must stay pinned (no coexisting duplicate, settled or not)`);
  }
}

test('LS1 run-all-refresh discards the resume source unconditionally, but must still block a duplicate paid submission while the prior job is unresolved, across repeated attempts', async (t) => {
  const f = await fixture(t, CHAIN_GRAPH, { create: async () => { throw new Error('Fixture: no provider identifier returned'); } });
  const run1 = await setup(f);
  assert.equal(run1.status, 'failed', JSON.stringify(run1));
  const jobId = record(run1, 'generate').output.generationJobId;
  const jobBefore = await f.api(`/api/generations/${jobId}`);
  assert.equal(jobBefore.status, 'submission_unknown');

  // No episode edit at all -- Trigger B in isolation. public/workflow.js's run-all-refresh
  // button reaches this exact body: execution:{mode:'all', refresh:true}.
  const opts = { execution: { mode: 'all', refresh: true }, code: 'generation_unresolved', message: UNRESOLVED_MESSAGE, jobId, jobBefore, expectedJobCount: 1 };
  await assertStillBlocked(f, { ...opts, label: 'LS1 first refresh attempt' });
  // The guard must not be a one-shot check that a second click slips past.
  await assertStillBlocked(f, { ...opts, label: 'LS1 second refresh attempt' });
  await assertStillBlocked(f, { ...opts, label: 'LS1 third refresh attempt' });
});

test('LS2a an episode version change alone (no refresh) permanently disqualifies the old run as a resume source, but must still block a duplicate paid submission while the prior job is unresolved', async (t) => {
  const f = await fixture(t, CHAIN_GRAPH, { create: async () => ({ requestId: 'fixture-manual-1', status: 'weird_unsupported_state', outputs: [] }) });
  const run1 = await setup(f);
  assert.equal(run1.status, 'failed', JSON.stringify(run1));
  const jobId = record(run1, 'generate').output.generationJobId;
  const jobBefore = await f.api(`/api/generations/${jobId}`);
  assert.equal(jobBefore.status, 'manual_recovery');

  // Trigger A in isolation: a trivial title-only edit, no refresh, no scene change.
  // findResumeSource requires run.episodeVersion === episode.version EXACTLY, so this
  // permanently strands run1 as a resume source for any future plan on this episode.
  const epBeforeBump = await f.current();
  await f.api(`/api/episodes/${f.episode.id}`, 'PUT', { ...epBeforeBump, title: 'Edited after the unresolved job (LS2a)', expectedVersion: epBeforeBump.version });

  await assertStillBlocked(f, { execution: { mode: 'all', refresh: false }, code: 'generation_unresolved', message: UNRESOLVED_MESSAGE, jobId, jobBefore, expectedJobCount: 1, label: 'LS2a version-bump attempt' });
});

test('LS2b an episode version change alone does not block a genuinely terminal prior job, and a legitimate retry still submits exactly one new job', async (t) => {
  let creates = 0;
  const f = await fixture(t, CHAIN_GRAPH, { create: async () => { creates++; return creates === 1 ? { requestId: 'fixture-failed-1', status: 'failed', outputs: [] } : { requestId: `fixture-retry-${creates}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture-retry.png', type: 'image' }] }; } });
  const run1 = await setup(f);
  assert.equal(run1.status, 'failed', JSON.stringify(run1));
  const job1Id = record(run1, 'generate').output.generationJobId;
  assert.equal((await f.api(`/api/generations/${job1Id}`)).status, 'failed');

  const epBeforeBump = await f.current();
  await f.api(`/api/episodes/${f.episode.id}`, 'PUT', { ...epBeforeBump, title: 'Edited after a terminal job (LS2b)', expectedVersion: epBeforeBump.version });

  const ep = await f.current();
  const planResponse = await f.request(`/api/workflows/${f.workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution: { mode: 'all', refresh: false }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.notEqual(plan.blocked && plan.blocked.code, 'generation_unresolved', JSON.stringify(plan));
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.ok(plan.selectedStages.includes('generate'));

  const quoteResponse = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version, execution: { mode: 'all', refresh: false }, disclosure });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();
  const runResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version, execution: { mode: 'all', refresh: false }, allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(runResponse.status, 202, await runResponse.clone().text());
  const run2 = await f.waitRun((await runResponse.json()).id);
  assert.equal(run2.status, 'completed', JSON.stringify(run2));
  assert.equal(record(run2, 'generate').status, 'completed');
  assert.notEqual(record(run2, 'generate').output.generationJobId, job1Id, 'a genuinely new job for the retried generation');
  assert.equal(f.submits(), 2, 'exactly one legitimate retry submission on top of the original failed one');
});

test('LS3 recovering and applying the unresolved job for real unblocks refresh, which then submits exactly one new job, never zero and never two', async (t) => {
  // manual_recovery: the only constructible unresolved state with a real settle path
  // (recover() requires a providerRequestId, which submission_unknown never has).
  let settleStatus = async () => { throw new Error('Fixture: status should not be polled before recovery'); };
  let creates = 0;
  const f = await fixture(t, CHAIN_GRAPH, {
    create: async () => { creates++; return creates === 1 ? { requestId: 'fixture-manual-1', status: 'weird_unsupported_state', outputs: [] } : { requestId: `fixture-settled-${creates}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture-new.png', type: 'image' }] }; },
    status: async (...args) => settleStatus(...args),
  });
  const run1 = await setup(f);
  assert.equal(run1.status, 'failed', JSON.stringify(run1));
  const jobId = record(run1, 'generate').output.generationJobId;
  const jobBefore = await f.api(`/api/generations/${jobId}`);
  assert.equal(jobBefore.status, 'manual_recovery');

  // Before recovery: refresh must still be blocked (same mechanism as LS1).
  await assertStillBlocked(f, { execution: { mode: 'all', refresh: true }, code: 'generation_unresolved', message: UNRESOLVED_MESSAGE, jobId, jobBefore, expectedJobCount: 1, label: 'LS3 pre-recovery refresh' });

  // Settle job1 for real through the actual recovery surface.
  settleStatus = async () => ({ requestId: 'fixture-manual-1', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture-settled.png', type: 'image' }] });
  const recoverResponse = await f.request(`/api/generations/${jobId}/recover`, 'POST', {});
  assert.equal(recoverResponse.status, 202, await recoverResponse.clone().text());
  let settledJob;
  for (let turn = 0; turn < 2000; turn++) {
    settledJob = await f.api(`/api/generations/${jobId}`);
    if (settledJob.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(settledJob.status, 'completed', JSON.stringify(settledJob));
  const epForApply = await f.current();
  const applyResponse = await f.request(`/api/generations/${jobId}/apply`, 'POST', { expectedVersion: epForApply.version, sceneId: epForApply.scenes[0].id });
  assert.equal(applyResponse.status, 200, await applyResponse.clone().text());
  assert.equal((await applyResponse.json()).job.applied, true);

  // After genuine recovery: refresh must now succeed, and must submit EXACTLY one new
  // job -- never 0 (refresh always re-quotes per contract 1.3, never inherits), and
  // never 2 (job1 is now genuinely settled everywhere in its history; the node-scoped
  // existence check must find that, not just assume settlement from a newest-only read).
  const submitsBeforeFinal = f.submits();
  const epFinal = await f.current();
  const finalPlanResponse = await f.request(`/api/workflows/${f.workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution: { mode: 'all', refresh: true }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: epFinal.version });
  assert.equal(finalPlanResponse.status, 200, await finalPlanResponse.clone().text());
  const finalPlan = await finalPlanResponse.json();
  assert.notEqual(finalPlan.blocked && finalPlan.blocked.code, 'generation_unresolved', JSON.stringify(finalPlan));
  assert.equal(finalPlan.blocked, false, JSON.stringify(finalPlan));
  assert.equal(finalPlan.resumeRunId, null, 'refresh never reports a resume source');

  const finalQuoteResponse = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: epFinal.version, execution: { mode: 'all', refresh: true }, disclosure });
  assert.equal(finalQuoteResponse.status, 200, await finalQuoteResponse.clone().text());
  const finalQuoted = await finalQuoteResponse.json();
  const finalRunResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: epFinal.version, execution: { mode: 'all', refresh: true }, allowGeneration: true, disclosure, generationPlanId: finalQuoted.id, generationFingerprint: finalQuoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(finalRunResponse.status, 202, await finalRunResponse.clone().text());
  const run3 = await f.waitRun((await finalRunResponse.json()).id);
  assert.equal(run3.status, 'completed', JSON.stringify(run3));
  assert.equal(record(run3, 'generate').status, 'completed');
  assert.notEqual(record(run3, 'generate').output.generationJobId, jobId, 'refresh mints a fresh job, it does not resurrect the recovered one');
  assert.equal(f.submits(), submitsBeforeFinal + 1, 'exactly one new submission once the old job is genuinely settled, not zero and not two');
});

test('LS4 an unresolved job on one generate branch does not block a direct retarget of an independent sibling generate branch (node-scoped, not episode-scoped)', async (t) => {
  // Non-regression pin: this specific path never hits the source=null blind spot (run1
  // stays a valid, version-matched resume source for run2 since nothing else edits the
  // episode version between them), so it is true both before and after the fix. It pins
  // the boundary the fix must respect: hasUnresolvedNodeJob is strictly nodeId-keyed.
  let creates = 0;
  const f = await fixture(t, DIVERGENT_GRAPH, { create: async () => { creates++; if (creates === 1) throw new Error('Fixture: no provider identifier returned'); return { requestId: `fixture-${creates}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture-b.png', type: 'image' }] }; } });
  const ep1 = await f.current();
  const quoteResponse = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'layout-a', 'generate-a'], startStage: 'script', disclosure });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();
  const runResponse = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'layout-a', 'generate-a'], startStage: 'script', allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(runResponse.status, 202, await runResponse.clone().text());
  const run1 = await f.waitRun((await runResponse.json()).id);
  assert.equal(run1.status, 'failed', JSON.stringify(run1));
  const jobAId = record(run1, 'generate-a').output.generationJobId;
  const jobABefore = await f.api(`/api/generations/${jobAId}`);
  assert.equal(jobABefore.status, 'submission_unknown');

  const submitsBefore = f.submits();
  const ep2 = await f.current();
  const planResponse = await f.request(`/api/workflows/${f.workflow.id}/plan`, 'POST', { episodeId: f.episode.id, execution: { mode: 'node', targetNodeId: 'generate-b' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep2.version });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.blocked, false, `generate-b must be unaffected by generate-a's unresolved job: ${JSON.stringify(plan.blocked)}`);

  const quote2Response = await f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep2.version, execution: { mode: 'node', targetNodeId: 'generate-b' }, disclosure });
  assert.equal(quote2Response.status, 200, await quote2Response.clone().text());
  const quoted2 = await quote2Response.json();
  const run2Response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep2.version, execution: { mode: 'node', targetNodeId: 'generate-b' }, allowGeneration: true, disclosure, generationPlanId: quoted2.id, generationFingerprint: quoted2.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(run2Response.status, 202, await run2Response.clone().text());
  const run2 = await f.waitRun((await run2Response.json()).id);
  assert.equal(run2.status, 'completed', JSON.stringify(run2));
  assert.equal(record(run2, 'generate-b').status, 'completed');
  assert.equal(f.submits(), submitsBefore + 1, 'generate-b submits its own independent job');
  assert.deepEqual(await f.api(`/api/generations/${jobAId}`), jobABefore, 'generate-a\u2019s unresolved job record must be completely unaffected by the unrelated sibling run');
});

test('LS5 a direct mode:node retarget of the unresolved generate node itself, after a version bump nulls the resume source, must still block (distinct from the proven HEAD-semantics bypass where source stays valid)', async (t) => {
  // Contrast with tests/workflow-plan.test.mjs 'PK': there, a direct retarget of
  // 'generate' is proven UNBLOCKED when source still resolves to the originating run
  // (intended HEAD semantics: resume the same job). Here source is fully NULL (version
  // bump), so findResumeSource finds nothing, script/board become dirty too, and
  // 'generate' gets invalidated via its OWN rerunning ancestors -- not as a bare
  // self-targeted node. That is a materially different code path and must still block.
  const f = await fixture(t, CHAIN_GRAPH, { create: async () => { throw new Error('Fixture: no provider identifier returned'); } });
  const run1 = await setup(f);
  assert.equal(run1.status, 'failed', JSON.stringify(run1));
  const jobId = record(run1, 'generate').output.generationJobId;
  const jobBefore = await f.api(`/api/generations/${jobId}`);
  assert.equal(jobBefore.status, 'submission_unknown');

  const epBeforeBump = await f.current();
  await f.api(`/api/episodes/${f.episode.id}`, 'PUT', { ...epBeforeBump, title: 'Edited before direct retarget (LS5)', expectedVersion: epBeforeBump.version });

  // mode:'node' forbids refresh entirely (400 if provided) -- version-bump is the only
  // way to reach source=null for this mode, confirming the two triggers are independent.
  await assertStillBlocked(f, { execution: { mode: 'node', targetNodeId: 'generate' }, code: 'generation_unresolved', message: UNRESOLVED_MESSAGE, jobId, jobBefore, expectedJobCount: 1, label: 'LS5 direct retarget after version bump' });
});

test('LS6 a completed-but-never-applied job left behind by a mid-flight version bump now correctly blocks a later attempt (closes the gap tests/workflow-plan.test.mjs documented as unconstructible-to-verify)', async (t) => {
  // Same mid-flight-edit-during-download technique as the existing PK test's
  // 'completed-but-not-applied' block, but followed through to a subsequent attempt
  // instead of stopping at the precondition (that test's own comment: 'there is no way
  // to construct "job1 unresolved AND still the detectable prior job of a later
  // invalidating plan" for this specific state without a job-history lookup that works
  // even when source is null' -- that lookup is exactly hasUnresolvedNodeJob).
  let bump = () => {};
  const f = await fixture(t, CHAIN_GRAPH, { generationOptions: { download: async (_url, file) => { await bump(); await writeFile(file, GEN_BYTES); return { bytes: GEN_BYTES.length, contentType: 'image/png' }; } } });
  bump = async () => { const ep = await f.current(); await f.api(`/api/episodes/${f.episode.id}`, 'PUT', { ...ep, title: 'Edited mid-flight (LS6)', expectedVersion: ep.version }); };
  const run1 = await setup(f);
  assert.equal(run1.status, 'failed', JSON.stringify(run1));
  const jobId = record(run1, 'generate').output.generationJobId;
  const jobBefore = await f.api(`/api/generations/${jobId}`);
  assert.equal(jobBefore.status, 'completed');
  assert.equal(jobBefore.applied, false, 'precondition: completed but never applied, the exact leaking state from finding 1');

  // The bump itself already burned run1's lineage (its recorded episodeVersion can never
  // again match the live one), so this is the next real attempt with no further edit.
  await assertStillBlocked(f, { execution: { mode: 'all', refresh: false }, code: 'generation_unresolved', message: UNRESOLVED_MESSAGE, jobId, jobBefore, expectedJobCount: 1, label: 'LS6 attempt after mid-flight bump' });
});

test('LS7 an unresolved job on a generate node is never even reached when all of its hard-dependency ancestors are skipped and unreusable under a lost source: a distinct, pre-existing skipped_prerequisite guard fires first', async (t) => {
  // Not a regression test for finding 1 -- traced by hand against server/workflows.mjs
  // and confirmed with Main: a generate node structurally cannot have an absent
  // storyboard ancestor (validateWorkflow rejects that graph at creation, 400), and with
  // script+board skipped plus source=null, stageSelection's generic required-but-
  // unselected check throws skipped_prerequisite on 'script' (first in topological
  // order) BEFORE the nodeRuns loop ever reaches 'generate'\u2019s own unsettled-job check.
  // Kept as an explicit boundary pin so this interaction cannot silently regress.
  const f = await fixture(t, CHAIN_GRAPH, { create: async () => { throw new Error('Fixture: no provider identifier returned'); } });
  const run1 = await setup(f);
  assert.equal(run1.status, 'failed', JSON.stringify(run1));
  const jobId = record(run1, 'generate').output.generationJobId;
  const jobBefore = await f.api(`/api/generations/${jobId}`);
  assert.equal(jobBefore.status, 'submission_unknown');

  await f.toggleSkip('script', true);
  await f.toggleSkip('board', true);
  const epBeforeBump = await f.current();
  await f.api(`/api/episodes/${f.episode.id}`, 'PUT', { ...epBeforeBump, title: 'Edited after skipping ancestors (LS7)', expectedVersion: epBeforeBump.version });

  await assertStillBlocked(f, { execution: { mode: 'node', targetNodeId: 'generate' }, code: 'skipped_prerequisite', message: `${SKIPPED_PREREQUISITE_MESSAGE} (script)`, jobId, jobBefore, expectedJobCount: 1, label: 'LS7 all-ancestors-skipped attempt' });
});

test('LS8 an older unresolved job is never obscured by a newer settled job on the SAME node, seeded directly as pre-fix/legacy store data, not reachable through any live request path', async (t) => {
  // Proved by source trace (confirmed with PaidSafetyFix) that under the fix, this exact
  // coexistence can never arise through any in-scope live request: a direct retarget
  // never mints a second job, it resumes-and-409s on the first job's non-resumable
  // status. So the only honest way to exercise the "scan ALL history, not just the
  // newest run" property is to seed it directly via the Store, as legacy data that could
  // already exist from before this fix shipped. No HTTP app route is used to create
  // these two rows -- this is the one test in this file that reaches below the HTTP
  // layer, and only to construct a precondition, never to assert on internals.
  const f = await fixture(t, CHAIN_GRAPH);
  const ep = await f.current();

  const seedStore = new Store(f.dataDir);
  const olderJob = seedStore.create('generationJobs', { requestId: 'legacy-older-unresolved', inputHash: 'fixture', episodeId: f.episode.id, episodeVersion: ep.version, sceneId: ep.scenes[0].id, model: 'fixture_image', prompt: 'Fixture', params: {}, transport: 'api', mediaKind: 'image', status: 'submission_unknown', outputs: [], applied: false });
  // Deliberately NO workflowSnapshot/episodeSnapshot on either seeded run: compatibleProvenance
  // then always fails, so neither row can ever be selected as `source` by findResumeSource --
  // this isolates the test to purely exercise hasUnresolvedNodeJob's lineage-independent scan.
  const olderRun = seedStore.create('workflowRuns', { workflowId: f.workflow.id, episodeId: f.episode.id, workflowVersion: f.workflow.version, episodeVersion: ep.version, status: 'failed', nodeRuns: [{ nodeId: 'generate', type: 'generate', status: 'failed', error: 'Fixture: legacy unresolved job', output: { generationJobId: olderJob.id } }] });
  const newerJob = seedStore.create('generationJobs', { requestId: 'legacy-newer-settled', inputHash: 'fixture', episodeId: f.episode.id, episodeVersion: ep.version, sceneId: ep.scenes[0].id, model: 'fixture_image', prompt: 'Fixture', params: {}, transport: 'api', mediaKind: 'image', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture-legacy.png', type: 'image' }], applied: true });
  // store.list() returns newest-inserted-first (rowid DESC): inserting the newer/settled
  // run AFTER the older/unresolved one means hasUnresolvedNodeJob's scan visits the
  // SETTLED job first. It must not stop there (isJobSettled -> add to `seen`, continue)
  // and must still find the older run's job unsettled on its second iteration -- this is
  // the adversarial ordering a "check only the newest job" implementation would fail.
  const newerRun = seedStore.create('workflowRuns', { workflowId: f.workflow.id, episodeId: f.episode.id, workflowVersion: f.workflow.version, episodeVersion: ep.version, status: 'completed', nodeRuns: [{ nodeId: 'generate', type: 'generate', status: 'completed', output: { generationJobId: newerJob.id } }] });
  // Closed explicitly and immediately (not via t.after) so this second SQLite connection
  // is guaranteed released well before the fixture's own app-close + rm(dataDir, ...)
  // teardown runs -- two live handles on the same WAL-mode file racing cleanup caused an
  // intermittent EBUSY on the -shm sidecar file otherwise.
  seedStore.close();
  assert.ok(olderRun.id && newerRun.id);

  await assertStillBlocked(f, { execution: { mode: 'all', refresh: false }, code: 'generation_unresolved', message: UNRESOLVED_MESSAGE, jobId: olderJob.id, jobBefore: olderJob, expectedJobCount: 2, label: 'LS8 legacy older-unresolved-plus-newer-settled seed' });
});

test('LS9 even when a VALID, compatible resume source exists and itself legitimately carries a newer settled job for this node, the existence-check must still dig past it and find an older, disconnected unresolved job for the SAME node', async (t) => {
  // Distinct from LS8 (where neither seeded run could ever BE `source` -- this proves
  // the opposite extreme: a fully valid, version-matched, provenance-compatible source
  // exists, and its OWN nodeRuns legitimately carry a real settled job for 'generate'.
  // The fix must not stop at "source resolved generate to something settled, done" --
  // it must keep scanning the node's full history regardless of what `source` says.
  //
  // Ordering is load-bearing: the legacy unresolved job is seeded AFTER both live runs
  // below settle cleanly, never before. Seeding it first would (correctly) block run1live
  // itself at creation time too, since hasUnresolvedNodeJob is unconditional on `source`
  // or `selected` origin -- it would catch ANY generate submission for this node while
  // ANY run anywhere carries an unresolved job for it. This models the realistic case: a
  // pre-fix-era legacy mess that simply did not exist yet while this live session's own
  // runs were made, only surfacing once this (now-fixed) code looks at full history.
  const f = await fixture(t, CHAIN_GRAPH);

  // Step 1: a clean, ordinary run settles 'generate' for real -- no unresolved data
  // exists anywhere yet, so this is not blocked. This run becomes the compatible source.
  const run1live = await setup(f);
  assert.equal(run1live.status, 'completed', JSON.stringify(run1live));
  const liveJobId = record(run1live, 'generate').output.generationJobId;
  const liveJob = await f.api(`/api/generations/${liveJobId}`);
  assert.equal(liveJob.status, 'completed');
  assert.equal(liveJob.applied, true);

  // Step 2: direct retarget of 'script' ALONE (mode:'node'). Proven R6 HEAD semantics
  // (tests/workflow-plan.test.mjs 'PK-hop'): 'generate' becomes invalidated but is NOT
  // selected, so the unresolved-job check never fires for it here; it is recorded
  // 'skipped'/unselected in this new run, which becomes the newest compatible source.
  const ep1 = await f.current();
  const run2Response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, execution: { mode: 'node', targetNodeId: 'script' }, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version });
  assert.equal(run2Response.status, 202, await run2Response.clone().text());
  const run2live = await f.waitRun((await run2Response.json()).id);
  assert.equal(run2live.status, 'completed', JSON.stringify(run2live));
  assert.equal(record(run2live, 'generate').status, 'skipped');

  // Step 3: NOW seed a disconnected, older, unresolved job for the SAME node, via the
  // Store directly (below the HTTP layer) -- a plausible legacy artifact that predates
  // this fix, deliberately NOT given workflowSnapshot/episodeSnapshot so it can never
  // itself become `source` (compatibleProvenance always fails for it). This run is
  // inserted chronologically before the two live runs above in `rowid` terms only in the
  // trivial sense of appearing after them here -- the SCAN must find it regardless of
  // insertion order (LS8 already proves the adversarial reverse ordering).
  const epForSeed = await f.current();
  const seedStore = new Store(f.dataDir);
  const legacyJob = seedStore.create('generationJobs', { requestId: 'legacy-ancient-unresolved', inputHash: 'fixture', episodeId: f.episode.id, episodeVersion: epForSeed.version, sceneId: epForSeed.scenes[0].id, model: 'fixture_image', prompt: 'Fixture', params: {}, transport: 'api', mediaKind: 'image', status: 'submission_unknown', outputs: [], applied: false });
  const legacyRun = seedStore.create('workflowRuns', { workflowId: f.workflow.id, episodeId: f.episode.id, workflowVersion: f.workflow.version, episodeVersion: epForSeed.version, status: 'failed', nodeRuns: [{ nodeId: 'generate', type: 'generate', status: 'failed', error: 'Fixture: ancient legacy unresolved job, disconnected from the live lineage above', output: { generationJobId: legacyJob.id } }] });
  seedStore.close();
  assert.ok(legacyRun.id);

  // Step 4: mode:'all' from run2live's lineage. `source` resolves to run2live -- fully
  // valid, version-matched, provenance-compatible, and its own sourceById correctly
  // carries the real settled liveJob for 'generate' via resumedFrom-chaining back to
  // run1live. 'board' is non-reusable (unselected in run2live) and reruns, which
  // invalidates 'generate' again; 'generate' is now selected+invalidated, triggering the
  // check. It must still find legacyJob (a run `source` itself never references) and
  // block -- a valid source's own settled job must never be mistaken for "nothing
  // unresolved exists for this node".
  await assertStillBlocked(f, { execution: { mode: 'all', refresh: false }, code: 'generation_unresolved', message: UNRESOLVED_MESSAGE, jobId: legacyJob.id, jobBefore: legacyJob, expectedJobCount: 2, label: 'LS9 valid-source-masks-older-unresolved attempt' });
});

test('LS10 direct mode:node retarget of generate itself (never invalidated by its own plan) must still explicitly detect and block when a separate, disconnected unresolved job exists for the same node, even though its own valid source directly references a SETTLED job', async (t) => {
  // Contract-level black-box test per Main's explicit steering: the required invariant is
  // NOT "does this exact attempt happen to avoid a double charge" (hand-traced separately:
  // it does, via the paidReuse branch firing on the source's own settled reference, zero
  // new provider calls) -- the invariant is that the system must EXPLICITLY SURFACE and
  // BLOCK whenever any unresolved job exists for this node, not silently succeed via an
  // unrelated reuse path as if nothing were wrong. Originally authored against the
  // CONTRACT while PaidSafetyFix's redesign was still in flight; re-verified line-by-line
  // against the final landed diff (server/workflows.mjs ~410-412, ~1269-1272) and
  // independently cross-confirmed with PaidSafetyFix over IRC before this run.
  //
  // This is a THIRD, structurally distinct gap from finding 1's "source is lost" chain:
  // here `source` is NOT lost, it is fully valid, and it DOES carry a real settled
  // reference for this exact node. descendants() never includes its own starting node, so
  // invalidatedBySelection(workflow, ['generate']) can never contain 'generate' when
  // 'generate' is the direct mode:'node' target -- `invalidated.has('generate')` is
  // STRUCTURALLY, categorically false on this path, for any implementation (this is a
  // fact about descendants(), not about any one diff). The pre-fix code and
  // PaidSafetyFix's FIRST landed diff both gated the throw on `invalidated.has(node.id)`,
  // so neither could ever catch this case regardless of what their scan itself found. The
  // FINAL landed diff fixes this specifically by removing that gate from the throw
  // condition (server/workflows.mjs line ~412 has no `invalidated` term at all now) while
  // still correctly excluding the one job legitimately being resumed via `resumingJob`.
  const f = await fixture(t, CHAIN_GRAPH);

  // A clean run settles 'generate' for real -- source will directly, legitimately
  // reference this exact completed+applied job for this exact node (not inherited or
  // chained through resumedFrom -- the node's OWN immediate prior job).
  const run1live = await setup(f);
  assert.equal(run1live.status, 'completed', JSON.stringify(run1live));
  const liveJobId = record(run1live, 'generate').output.generationJobId;
  const liveJob = await f.api(`/api/generations/${liveJobId}`);
  assert.equal(liveJob.status, 'completed');
  assert.equal(liveJob.applied, true);

  // Seed a disconnected, older, unresolved job for the SAME node AFTER run1live settles
  // (seeding first would also block run1live's own creation, since 'generate' IS
  // invalidated during that combined script+board+generate submission -- same ordering
  // lesson as LS9). No workflowSnapshot/episodeSnapshot: never a valid source candidate.
  const epForSeed = await f.current();
  const seedStore = new Store(f.dataDir);
  const legacyJob = seedStore.create('generationJobs', { requestId: 'legacy-direct-retarget-unresolved', inputHash: 'fixture', episodeId: f.episode.id, episodeVersion: epForSeed.version, sceneId: epForSeed.scenes[0].id, model: 'fixture_image', prompt: 'Fixture', params: {}, transport: 'api', mediaKind: 'image', status: 'submission_unknown', outputs: [], applied: false });
  const legacyRun = seedStore.create('workflowRuns', { workflowId: f.workflow.id, episodeId: f.episode.id, workflowVersion: f.workflow.version, episodeVersion: epForSeed.version, status: 'failed', nodeRuns: [{ nodeId: 'generate', type: 'generate', status: 'failed', error: 'Fixture: disconnected unresolved job, unrelated to the valid source below', output: { generationJobId: legacyJob.id } }] });
  seedStore.close();
  assert.ok(legacyRun.id);

  // Direct mode:'node' retarget of 'generate' itself. `source` resolves to run1live --
  // fully valid, and its own sourceById.get('generate') directly carries liveJob
  // (completed, applied) with no chaining needed. 'generate' is selected (always dirty
  // when it is the literal mode:'node' target) but NEVER invalidated by this plan.
  await assertStillBlocked(f, { execution: { mode: 'node', targetNodeId: 'generate' }, code: 'generation_unresolved', message: UNRESOLVED_MESSAGE, jobId: legacyJob.id, jobBefore: legacyJob, expectedJobCount: 2, label: 'LS10 direct self-target with settled reference plus disconnected unresolved' });
});
