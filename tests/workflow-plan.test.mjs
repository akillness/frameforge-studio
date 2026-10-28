import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

// Contract: local://workflow-plan-contract.md sections 1.1-1.4 and 1.6.
// This file is RED by design: POST /api/workflows/:id/plan does not exist yet and
// `execution` is not threaded through /quote or /run. Most assertions below encode the
// FUTURE contract, not current behavior, and are expected to fail until ServerImpl lands.

const node = (id, type, config = {}) => ({ id, type, x: 0, y: 0, config });
const record = (run, id) => run.nodeRuns.find((item) => item.nodeId === id);
const nodeAction = (plan, id) => plan.nodes.find((item) => item.nodeId === id)?.action;
const scene = (text) => ({ id: 'fixture-scene', title: 'Fixture', text, kind: 'title', layout: 'center', duration: 1, background: '#173940' });

// The user's real "확인해봄" channel shape (contract section 0): one linear chain.
const CHAIN = ['trend', 'research', 'script', 'storyboard', 'layout', 'generate', 'render', 'review', 'publish'];
const NON_PUBLISH = CHAIN.slice(0, 8);

const RENDER_BYTES = Buffer.from('frameforge workflow-plan fixture render, not a real MP4');
const RENDER_SHA256 = createHash('sha256').update(RENDER_BYTES).digest('hex');
const GEN_BYTES = Buffer.from('frameforge workflow-plan fixture generated image');
const disclosure = { containsSyntheticMedia: true, rationale: 'Fixture illustration only, reviewed before quoting' };

function buildGraph(scriptAgent, query) {
  const nodes = [
    node('trend', 'trend', query === undefined ? {} : { query }),
    node('research', 'research'),
    node('script', 'script', scriptAgent === 'existing' ? { agent: 'existing' } : { agent: 'codex', prompt: 'Write a fixture script' }),
    node('storyboard', 'storyboard'),
    node('layout', 'layout'),
    node('generate', 'generate', { model: 'fixture_image', prompt: 'Illustrate fixture', sceneIndex: 0 }),
    node('render', 'render'),
    node('review', 'review'),
    node('publish', 'publish'),
  ];
  const edges = CHAIN.slice(1).map((target, i) => ({ id: `e${i + 1}`, source: CHAIN[i], target }));
  return { name: 'Plan fixture graph', nodes, edges };
}

async function fixture(t, { scriptAgent = 'codex', query = 'ALPHA', stallTrend = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-plan-'));
  let submits = 0, schemaCalls = 0, estimateCalls = 0, renderCalls = 0;
  const prompts = [], trendQueries = [];
  let releaseGate = () => {};
  const gate = stallTrend ? new Promise((resolve) => { releaseGate = resolve; }) : null;
  const forbidden = async () => { throw new Error('Unexpected external/paid operation in a plan fixture'); };

  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: {
      integrationStatus: async () => ({ codex: { available: true } }),
      fetchTrends: async (q) => {
        trendQueries.push(q);
        if (gate) await gate;
        return { trends: [{ keyword: `${q}-RESULT`, source: 'Fixture', url: 'https://fixture.invalid/trend' }], sources: [] };
      },
      runAgent: async (_agent, prompt) => {
        prompts.push(prompt);
        if (prompt.includes('FAIL_SCRIPT')) throw new Error('Fixture script failure');
        return { message: 'Fixture script output', scenes: [scene(prompt)] };
      },
    },
    generation: {
      capability: async () => ({ available: true }),
      models: forbidden,
      modelSchema: async (model) => { schemaCalls++; return { id: model, type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }; },
      estimate: async () => { estimateCalls++; return { cost: 1, currency: 'USD', quoted: true }; },
      create: async () => { submits++; return { requestId: `fixture-provider-${submits}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] }; },
      status: forbidden,
    },
    generationOptions: {
      download: async (_url, file) => { await writeFile(file, GEN_BYTES); return { bytes: GEN_BYTES.length, contentType: 'image/png' }; },
      probe: async () => ({ kind: 'image', width: 64, height: 64 }),
    },
    renderer: async (episode, { dataDir: root, sceneIntegrity }) => {
      renderCalls++;
      const filename = `${randomUUID()}.mp4`;
      await writeFile(join(root, 'exports', filename), RENDER_BYTES);
      return { filename, outputUrl: `/api/exports/${filename}`, sha256: RENDER_SHA256, ...(sceneIntegrity ? { verifiedSceneAssets: sceneIntegrity } : {}) };
    },
    mediaOptions: { fetchImpl: forbidden },
    youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => { await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });

  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = async (path, method = 'GET', body) => { const response = await request(path, method, body); const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value; };

  const channel = await api('/api/channels', 'POST', { name: 'Plan fixture owner', category: 'information', platform: 'YouTube' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Plan fixture project', topic: 'Fixture topic' });
  const template = await api('/api/workflows', 'POST', buildGraph(scriptAgent, query));
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

  const legacyRun = async (ids, extra = {}) => {
    const ep = await current();
    const body = { episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: ep.version, selectedStages: ids, startStage: ids[0], ...extra };
    const response = await request(`/api/workflows/${workflow.id}/run`, 'POST', body);
    assert.equal(response.status, 202, await response.clone().text());
    const started = await response.json();
    return waitRun(started.id);
  };

  // Quote+run across the 8 non-publish stages in one lineage; requires scriptAgent:'existing'
  // because /quote's prepareCandidate rejects a non-'existing' script agent when quoting
  // downstream generation in the same selection (server/workflows.mjs prepareCandidate).
  const fullRun = async (extra = {}, project = { episode, workflow }) => {
    const ep = (await api('/api/state')).episodes.find((item) => item.id === project.episode.id);
    const body = { episodeId: project.episode.id, expectedEpisodeVersion: ep.version, expectedWorkflowVersion: project.workflow.version, selectedStages: NON_PUBLISH, startStage: NON_PUBLISH[0], disclosure, ...extra };
    const quoteResponse = await request(`/api/workflows/${project.workflow.id}/quote`, 'POST', body);
    assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
    const generationPlan = await quoteResponse.json();
    const runResponse = await request(`/api/workflows/${project.workflow.id}/run`, 'POST', { ...body, allowGeneration: true, generationPlanId: generationPlan.id, generationFingerprint: generationPlan.fingerprint, acceptUnquotedEstimate: true });
    assert.equal(runResponse.status, 202, await runResponse.clone().text());
    const started = await runResponse.json();
    return waitRun(started.id);
  };

  const freshProject = async (agent = 'existing') => {
    const newEpisode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Plan fixture project 2', topic: 'Fixture topic 2' });
    const newTemplate = await api('/api/workflows', 'POST', buildGraph(agent, query));
    const newWorkflow = await api(`/api/workflows/${newTemplate.id}/copies`, 'POST', { channelId: channel.id, episodeId: newEpisode.id, expectedTemplateVersion: newTemplate.version });
    return { episode: newEpisode, workflow: newWorkflow };
  };

  const decideReview = async (run, decision = 'approved') => {
    const reviewNodeId = run.nodeRuns.find((item) => item.type === 'review').nodeId;
    return api(`/api/workflows/${workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId, decision, notes: 'Fixture review notes', expectedEpisodeVersion: run.episodeVersion });
  };

  const planCall = async (execution, extra = {}) => {
    const ep = await current();
    return request(`/api/workflows/${workflow.id}/plan`, 'POST', { episodeId: episode.id, execution, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: ep.version, ...extra });
  };
  const plan = async (execution, extra = {}) => {
    const response = await planCall(execution, extra);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };

  const quote = (body) => request(`/api/workflows/${workflow.id}/quote`, 'POST', body);
  const run = (body) => request(`/api/workflows/${workflow.id}/run`, 'POST', body);

  return {
    api, request, channel, episode, workflow, current, waitRun, legacyRun, fullRun, freshProject, decideReview,
    planCall, plan, quote, run,
    prompts, trendQueries, submits: () => submits, schemaCalls: () => schemaCalls, estimateCalls: () => estimateCalls, renderCalls: () => renderCalls,
    releaseGate: () => releaseGate(),
    currentWorkflow: async () => (await api('/api/state')).workflows.find((item) => item.id === workflow.id),
    toggleSkip: async (nodeId, skipped = true) => {
      const wf = (await api('/api/state')).workflows.find((item) => item.id === workflow.id);
      return api(`/api/workflows/${workflow.id}/skips`, 'POST', { nodeId, skipped, expectedVersion: wf.version });
    },
  };
}

test('P1 node target with no prior run selects every ancestor fresh, in order, with no resume', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan({ mode: 'node', targetNodeId: 'script' });
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.selectedStages, ['trend', 'research', 'script']);
  assert.equal(plan.resumeRunId, null);
  assert.deepEqual(plan.completedNodeIds, []);
  assert.deepEqual(plan.staleNodeIds, []);
  assert.equal(plan.needsDecision, false);
  assert.equal(plan.nothingToRun, false);
  for (const id of ['trend', 'research', 'script']) assert.equal(nodeAction(plan, id), 'run', `${id} must run from scratch`);
});

test('P2 a dirty/missing ancestor forces its completed descendant to rerun too, not silently reuse', async (t) => {
  const f = await fixture(t);
  // Reproduces the root-cause bug (contract section 0): research ran standalone, trend never ran.
  const runR = await f.legacyRun(['research']);
  assert.equal(runR.status, 'completed', JSON.stringify(runR));
  assert.equal(record(runR, 'trend').status, 'skipped', 'trend was never selected for this run');
  assert.equal(record(runR, 'research').status, 'completed');

  const plan = await f.plan({ mode: 'node', targetNodeId: 'script' });
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.completedNodeIds, ['research'], 'trend never completed in the source run');
  // trend has no reusable output -> must run; research is reusable on its own but its
  // ancestor (trend) within the needed set is being rerun, so dirty propagation forces
  // research to rerun too instead of being silently reused with stale/no trend context.
  assert.deepEqual(plan.selectedStages, ['trend', 'research', 'script']);
  assert.equal(nodeAction(plan, 'trend'), 'run');
  assert.equal(nodeAction(plan, 'research'), 'run', 'research must not be silently reused when its ancestor reruns');
  assert.equal(nodeAction(plan, 'script'), 'run');
  // A compatible source run exists and is used as planning context even though nothing
  // from it is actually reused (contract 1.3 step 5: resumeRunId = source.id unless refresh).
  assert.equal(plan.resumeRunId, runR.id);
});

test('P3 node target reuses already-completed ancestors and runs only the target', async (t) => {
  const f = await fixture(t);
  const runA = await f.legacyRun(['trend', 'research', 'script']);
  assert.equal(runA.status, 'completed', JSON.stringify(runA));

  const plan = await f.plan({ mode: 'node', targetNodeId: 'script' });
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.selectedStages, ['script']);
  assert.equal(plan.resumeRunId, runA.id);
  assert.deepEqual(plan.completedNodeIds, ['trend', 'research', 'script']);
  assert.deepEqual(plan.staleNodeIds, []);
  assert.equal(nodeAction(plan, 'trend'), 'reuse');
  assert.equal(nodeAction(plan, 'research'), 'reuse');
  assert.equal(nodeAction(plan, 'script'), 'run');
});

test('P4 rerunning an ancestor marks its dependents stale and the stale nodeRun carries staleFrom', async (t) => {
  const f = await fixture(t);
  const runA = await f.legacyRun(['trend', 'research', 'script']);
  assert.equal(runA.status, 'completed', JSON.stringify(runA));

  // Plan a trend-only rerun while runA is still the only (and therefore source) run.
  const trendPlan = await f.plan({ mode: 'node', targetNodeId: 'trend' });
  assert.equal(trendPlan.blocked, false);
  assert.deepEqual(trendPlan.selectedStages, ['trend']);
  assert.equal(trendPlan.resumeRunId, runA.id);
  assert.equal(nodeAction(trendPlan, 'trend'), 'run', 'the target always runs, even though it was already reusable');
  assert.deepEqual(trendPlan.staleNodeIds.sort(), ['research', 'script']);
  assert.equal(nodeAction(trendPlan, 'research'), 'stale');
  assert.equal(nodeAction(trendPlan, 'script'), 'stale');

  // Execute that exact selection (legacy body; single-stage auto-resume picks runA).
  const runB = await f.legacyRun(['trend']);
  assert.equal(runB.status, 'completed', JSON.stringify(runB));
  assert.equal(record(runB, 'trend').status, 'completed');
  assert.equal(record(runB, 'research').status, 'skipped');
  assert.equal(record(runB, 'research').staleFrom, runA.id, 'dropped reusable output must be marked stale against its source run');
  assert.equal(record(runB, 'script').status, 'skipped');
  assert.equal(record(runB, 'script').staleFrom, runA.id);

  // Planning the next target now reuses trend from runB (the newer compatible source)
  // and reruns research/script since runB never produced reusable output for them.
  const scriptPlan = await f.plan({ mode: 'node', targetNodeId: 'script' });
  assert.equal(scriptPlan.blocked, false);
  assert.equal(scriptPlan.resumeRunId, runB.id);
  assert.deepEqual(scriptPlan.selectedStages, ['research', 'script']);
  assert.equal(nodeAction(scriptPlan, 'trend'), 'reuse');
  assert.deepEqual(scriptPlan.completedNodeIds, ['trend']);
});

test('P5 mode all with completed nodes needs a decision; keep runs only the remainder, refresh reruns everyone but publish', async (t) => {
  const f = await fixture(t, { scriptAgent: 'existing' });
  const source = await f.legacyRun(['trend', 'research', 'script']);
  assert.equal(source.status, 'completed', JSON.stringify(source));

  const keepPlan = await f.plan({ mode: 'all', refresh: false });
  assert.equal(keepPlan.blocked, false);
  assert.equal(keepPlan.needsDecision, true);
  assert.deepEqual(keepPlan.completedNodeIds, ['trend', 'research', 'script']);
  assert.deepEqual(keepPlan.selectedStages, ['storyboard', 'layout', 'generate', 'render', 'review']);
  assert.equal(keepPlan.resumeRunId, source.id);
  assert.ok(!keepPlan.selectedStages.includes('publish'));

  const refreshPlan = await f.plan({ mode: 'all', refresh: true });
  assert.equal(refreshPlan.blocked, false);
  assert.equal(refreshPlan.needsDecision, false, 'refresh is itself the decision; it must not ask again');
  assert.deepEqual(refreshPlan.selectedStages, NON_PUBLISH);
  assert.equal(refreshPlan.resumeRunId, null, 'refresh drops the source so paid generation is re-quoted, never inherited');
  assert.ok(!refreshPlan.selectedStages.includes('publish'));
});

test('P6 mode all with no compatible source never asks for a decision', async (t) => {
  const f = await fixture(t, { scriptAgent: 'existing' });
  const plan = await f.plan({ mode: 'all', refresh: false });
  assert.equal(plan.blocked, false);
  assert.equal(plan.needsDecision, false);
  assert.deepEqual(plan.completedNodeIds, []);
  assert.deepEqual(plan.selectedStages, NON_PUBLISH);
  assert.equal(plan.resumeRunId, null);
});

test('P7 everything completed: mode all keep has nothing to run; /run with that execution is 409 nothing_to_run', async (t) => {
  const f = await fixture(t, { scriptAgent: 'existing' });
  const source = await f.fullRun();
  assert.equal(source.status, 'awaiting_review', JSON.stringify(source));

  const plan = await f.plan({ mode: 'all', refresh: false });
  assert.equal(plan.blocked, false);
  assert.equal(plan.nothingToRun, true);
  assert.equal(plan.needsDecision, true);
  assert.deepEqual(plan.selectedStages, []);

  const ep = await f.current();
  const response = await f.run({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version, execution: { mode: 'all', refresh: false } });
  assert.equal(response.status, 409, await response.clone().text());
  const body = await response.json();
  assert.equal(body.code, 'nothing_to_run');
  assert.equal(body.error, '실행할 노드가 없습니다. 완료된 결과를 유지합니다.');
});

test('P8 an active run on the episode blocks both /plan and /quote with active_run', async (t) => {
  const f = await fixture(t, { stallTrend: true });
  const ep = await f.current();
  const startResponse = await f.run({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version, selectedStages: ['trend'], startStage: 'trend' });
  assert.equal(startResponse.status, 202, await startResponse.clone().text());
  const started = await startResponse.json();

  const planResponse = await f.planCall({ mode: 'node', targetNodeId: 'research' });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const planBody = await planResponse.json();
  assert.deepEqual(planBody.blocked, { code: 'active_run', message: '이 에피소드에 실행 중인 워크플로우가 있습니다. 끝난 뒤 다시 시도하세요.' });
  assert.deepEqual(planBody.selectedStages, []);

  const quoteEp = await f.current();
  const quoteResponse = await f.quote({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: quoteEp.version, execution: { mode: 'node', targetNodeId: 'research' } });
  assert.equal(quoteResponse.status, 409, await quoteResponse.clone().text());
  const quoteBody = await quoteResponse.json();
  assert.equal(quoteBody.code, 'active_run');
  assert.equal(quoteBody.error, '이 에피소드에 실행 중인 워크플로우가 있습니다. 끝난 뒤 다시 시도하세요.');

  f.releaseGate();
  const finished = await f.waitRun(started.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
});

test('P9 /plan never writes entities, records events, or calls providers, and rejects malformed input / stale versions', async (t) => {
  const f = await fixture(t, { scriptAgent: 'existing' });
  const before = { runs: (await f.api(`/api/workflows/${f.workflow.id}/runs`)).length, events: (await f.api('/api/state')).events.length };

  const malformed = [
    {},
    { mode: 'node' },
    { mode: 'all', targetNodeId: 'trend' },
    { mode: 'node', targetNodeId: 'trend', refresh: true },
    { mode: 'node', targetNodeId: 'trend', bogus: 1 },
    { mode: 'bogus' },
    'not-an-object',
    null,
  ];
  for (const execution of malformed) {
    const response = await f.planCall(execution);
    assert.equal(response.status, 400, `execution=${JSON.stringify(execution)} => ${response.status} ${await response.clone().text()}`);
  }

  const staleWorkflow = await f.planCall({ mode: 'node', targetNodeId: 'script' }, { expectedWorkflowVersion: f.workflow.version + 1 });
  assert.equal(staleWorkflow.status, 409, await staleWorkflow.clone().text());
  const staleEpisode = await f.planCall({ mode: 'node', targetNodeId: 'script' }, { expectedEpisodeVersion: 999 });
  assert.equal(staleEpisode.status, 409, await staleEpisode.clone().text());

  // Valid read-only calls, including one that would require a paid generation if executed.
  const valid1 = await f.plan({ mode: 'node', targetNodeId: 'script' });
  assert.equal(valid1.blocked, false);
  const valid2 = await f.plan({ mode: 'node', targetNodeId: 'generate' });
  assert.equal(valid2.requiresGeneration, true);
  const valid3 = await f.plan({ mode: 'all', refresh: true });
  assert.equal(valid3.blocked, false);

  const after = { runs: (await f.api(`/api/workflows/${f.workflow.id}/runs`)).length, events: (await f.api('/api/state')).events.length };
  assert.deepEqual(after, before, 'plan must never create workflow runs or record events');
  assert.equal(f.submits(), 0);
  assert.equal(f.schemaCalls(), 0);
  assert.equal(f.estimateCalls(), 0);
  assert.equal(f.renderCalls(), 0);
  assert.deepEqual(f.prompts, [], 'no agent was ever invoked by a read-only plan');
  assert.deepEqual(f.trendQueries, [], 'no trend provider call was ever made by a read-only plan');
});

test('P10 /quote and /run derive the same selection as /plan from execution; mixing execution with legacy fields is 400; legacy-only bodies keep working', async (t) => {
  const f = await fixture(t);
  const plan = await f.plan({ mode: 'node', targetNodeId: 'research' });
  assert.deepEqual(plan.selectedStages, ['trend', 'research']);

  const ep1 = await f.current();
  const quoteResponse = await f.quote({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version, execution: { mode: 'node', targetNodeId: 'research' } });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();
  assert.deepEqual(quoted.selectedStages, plan.selectedStages);

  const ep2 = await f.current();
  const runResponse = await f.run({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep2.version, execution: { mode: 'node', targetNodeId: 'research' } });
  assert.equal(runResponse.status, 202, await runResponse.clone().text());
  const started = await runResponse.json();
  const finished = await f.waitRun(started.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.deepEqual(finished.selectedStages, plan.selectedStages);
  assert.deepEqual(finished.execution, { mode: 'node', targetNodeId: 'research', refresh: false });

  // execution + legacy fields together is rejected on both endpoints.
  const ep3 = await f.current();
  const mixedQuote = await f.quote({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep3.version, execution: { mode: 'node', targetNodeId: 'trend' }, selectedStages: ['trend'] });
  assert.equal(mixedQuote.status, 400, await mixedQuote.clone().text());
  const mixedRun = await f.run({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep3.version, execution: { mode: 'node', targetNodeId: 'trend' }, startStage: 'trend' });
  assert.equal(mixedRun.status, 400, await mixedRun.clone().text());

  // Legacy-only body (no execution) must keep behaving exactly as it does today.
  const ep4 = await f.current();
  const legacyResponse = await f.run({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep4.version, selectedStages: ['trend'], startStage: 'trend', resumeRunId: finished.id });
  assert.equal(legacyResponse.status, 202, await legacyResponse.clone().text());
  const legacyStarted = await legacyResponse.json();
  const legacyFinished = await f.waitRun(legacyStarted.id);
  assert.equal(legacyFinished.status, 'completed', JSON.stringify(legacyFinished));
  assert.equal(legacyFinished.execution, undefined, 'a legacy body must not fabricate an execution label');
});

test('P11 targeting generate requires it in selectedStages, requires the existing paid guard, and /quote derives the exact subset', async (t) => {
  const f = await fixture(t, { scriptAgent: 'existing' });
  const plan = await f.plan({ mode: 'node', targetNodeId: 'generate' });
  assert.equal(plan.blocked, false);
  assert.equal(plan.requiresGeneration, true);
  assert.deepEqual(plan.selectedStages, ['trend', 'research', 'script', 'storyboard', 'layout', 'generate']);
  assert.ok(!plan.selectedStages.includes('render'), 'render/review/publish are not ancestors of generate and must not be pulled in');

  const ep1 = await f.current();
  const runResponse = await f.run({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version, execution: { mode: 'node', targetNodeId: 'generate' } });
  assert.equal(runResponse.status, 400, await runResponse.clone().text());
  assert.equal(f.submits(), 0);
  assert.equal(f.schemaCalls(), 0);
  assert.equal(f.estimateCalls(), 0);

  const ep2 = await f.current();
  const quoteResponse = await f.quote({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep2.version, execution: { mode: 'node', targetNodeId: 'generate' }, disclosure });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();
  assert.deepEqual(quoted.selectedStages, plan.selectedStages);
});

test('P12 paid safety: dirty propagation never reuses a paid job across a rerunning scene producer, but an unrelated node target still reuses it for free', async (t) => {
  const f = await fixture(t, { scriptAgent: 'existing' });
  const run1 = await f.fullRun();
  assert.equal(run1.status, 'awaiting_review', JSON.stringify(run1));
  const generated1 = record(run1, 'generate');
  assert.equal(generated1.status, 'completed');
  assert.equal(f.submits(), 1);
  const jobId = generated1.output.generationJobId;

  // Rerun just 'script' (single-stage auto-resume picks run1); this invalidates
  // storyboard/layout/generate/render/review without producing new output for them.
  const run2 = await f.legacyRun(['script']);
  assert.equal(run2.status, 'completed', JSON.stringify(run2));
  assert.equal(record(run2, 'script').status, 'completed');
  assert.equal(record(run2, 'storyboard').status, 'skipped');

  const ep = await f.current();

  // Re-planning/re-quoting the rest of the chain from run2 via execution-intent must select
  // a FRESH generate node (dirty propagation), not silently reuse job 1's completed,
  // now-invalidated job. mode:'all', refresh:false re-derives exactly the original
  // ['storyboard','layout','generate','render','review'] selection (trend/research/script
  // stay reusable from run2; the rest are dirty) with resumeRunId auto-resolved to run2.id --
  // this is the server-planner-derived path the contract (addendum A) blesses as a fresh
  // paid generation, distinct from the raw legacy selectedStages shape asserted 409 below.
  const execPlan = await f.plan({ mode: 'all', refresh: false });
  assert.equal(execPlan.blocked, false, JSON.stringify(execPlan));
  assert.equal(execPlan.resumeRunId, run2.id);
  assert.deepEqual(execPlan.selectedStages, ['storyboard', 'layout', 'generate', 'render', 'review']);
  const quoteResponse = await f.quote({
    episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version,
    execution: { mode: 'all', refresh: false }, disclosure,
  });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text(), 'rerunning an upstream scene producer via execution-intent must not trip the paid-reuse guard for the now-dirty generate node');
  const quoted = await quoteResponse.json();
  assert.ok(quoted.candidate.nodes.some((item) => item.nodeId === 'generate'), 'generate must be a fresh candidate node, not silently dropped');
  assert.equal(f.submits(), 1, 'quoting never submits');

  // The raw legacy selectedStages+resumeRunId shape for this exact same scenario (reselecting
  // an upstream scene producer alongside the already-paid generate node) stays strictly
  // blocked: that guard is never bypassed just because the request happens to describe the
  // same dirty-propagation outcome the execution-intent path above legitimately allows.
  const legacyRerun = await f.quote({
    episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version,
    selectedStages: ['storyboard', 'layout', 'generate', 'render', 'review'], startStage: 'storyboard', resumeRunId: run2.id, disclosure,
  });
  assert.equal(legacyRerun.status, 409, await legacyRerun.clone().text());
  assert.equal((await legacyRerun.json()).error, 'Cannot rerun script, storyboard or layout while reusing a paid generation job');
  assert.equal(f.submits(), 1, 'a rejected legacy rerun must never reach the provider');

  // A completely separate, untouched project proves the opposite side of the safety
  // rule still holds: targeting the completed generate node alone reuses the paid job
  // with zero new submissions.
  const project2 = await f.freshProject('existing');
  const source = await f.fullRun({}, project2);
  assert.equal(source.status, 'awaiting_review', JSON.stringify(source));
  assert.equal(f.submits(), 2, 'the second project made exactly one new submission');
  const ep2 = (await f.api('/api/state')).episodes.find((item) => item.id === project2.episode.id);
  const reuseQuote = await f.request(`/api/workflows/${project2.workflow.id}/quote`, 'POST', {
    episodeId: project2.episode.id, expectedWorkflowVersion: project2.workflow.version, expectedEpisodeVersion: ep2.version,
    selectedStages: ['generate'], startStage: 'generate', resumeRunId: source.id, disclosure,
  });
  assert.equal(reuseQuote.status, 200, await reuseQuote.clone().text());
  const reusePlan = await reuseQuote.json();
  const reuseResponse = await f.request(`/api/workflows/${project2.workflow.id}/run`, 'POST', {
    episodeId: project2.episode.id, expectedWorkflowVersion: project2.workflow.version, expectedEpisodeVersion: ep2.version,
    selectedStages: ['generate'], startStage: 'generate', resumeRunId: source.id, allowGeneration: true, disclosure,
    generationPlanId: reusePlan.id, generationFingerprint: reusePlan.fingerprint, acceptUnquotedEstimate: true,
  });
  assert.equal(reuseResponse.status, 202, await reuseResponse.clone().text());
  const reuseStarted = await reuseResponse.json();
  const reuseFinished = await f.waitRun(reuseStarted.id);
  assert.equal(reuseFinished.status, 'completed', JSON.stringify(reuseFinished));
  assert.equal(record(reuseFinished, 'generate').reused, true);
  assert.equal(record(reuseFinished, 'generate').output.generationJobId, record(source, 'generate').output.generationJobId);
  assert.equal(f.submits(), 2, 'reusing the completed paid job must not submit a new generation');
});

test('P13 publish stays blocked with publish_requires_review until the matching approved review exists', async (t) => {
  const f = await fixture(t, { scriptAgent: 'existing' });
  const source = await f.fullRun();
  assert.equal(source.status, 'awaiting_review', JSON.stringify(source));

  const blockedPlan = await f.plan({ mode: 'node', targetNodeId: 'publish' });
  assert.deepEqual(blockedPlan.blocked, { code: 'publish_requires_review', message: '게시는 같은 결과에 대한 승인된 검토가 있어야 실행할 수 있습니다.' });
  assert.deepEqual(blockedPlan.selectedStages, []);
  assert.equal(nodeAction(blockedPlan, 'publish'), 'blocked');

  const approved = await f.decideReview(source, 'approved');
  assert.equal(approved.status, 'approved', JSON.stringify(approved));

  const allowedPlan = await f.plan({ mode: 'node', targetNodeId: 'publish' });
  assert.equal(allowedPlan.blocked, false, JSON.stringify(allowedPlan));
  assert.deepEqual(allowedPlan.selectedStages, ['publish']);
  assert.equal(allowedPlan.resumeRunId, approved.id);
  assert.equal(nodeAction(allowedPlan, 'publish'), 'run');
});

test('P14 connectivity regression: /run for a mid-chain target actually runs its missing ancestors first and feeds their real output downstream', async (t) => {
  const f = await fixture(t, { query: 'REGRESSION' });
  // Exactly the observed bug precondition (contract section 0): research ran once on
  // its own; trend never ran at all for this episode.
  const runR = await f.legacyRun(['research']);
  assert.equal(runR.status, 'completed', JSON.stringify(runR));
  assert.equal(f.trendQueries.length, 0, 'trend must not have run yet in this lineage');

  const ep = await f.current();
  const execution = { mode: 'node', targetNodeId: 'script' };
  const response = await f.run({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version, execution });
  assert.equal(response.status, 202, await response.clone().text());
  const started = await response.json();
  const run = await f.waitRun(started.id);
  assert.equal(run.status, 'completed', JSON.stringify(run));

  // The node graph was actually followed: trend ran, then research re-ran against
  // trend's fresh output, then script ran against that same lineage's research output.
  assert.equal(record(run, 'trend').status, 'completed');
  assert.equal(record(run, 'research').status, 'completed');
  assert.equal(record(run, 'script').status, 'completed');
  assert.equal(f.trendQueries.length, 1, 'trend ran exactly once to satisfy the missing ancestor');
  assert.equal(record(run, 'trend').output.trends[0].keyword, 'REGRESSION-RESULT');

  const researchOutput = record(run, 'research').output;
  assert.ok(researchOutput.inputs.some((input) => input.nodeId === 'trend' && input.output?.trends?.[0]?.keyword === 'REGRESSION-RESULT'), 'research must have actually received this run\'s fresh trend output, not an empty/undefined ancestor');

  const scriptPrompt = f.prompts.at(-1);
  assert.ok(scriptPrompt.includes(JSON.stringify(researchOutput)) || scriptPrompt.includes('REGRESSION-RESULT'), `script prompt must carry the same lineage's research/trend output, got: ${scriptPrompt}`);
});

// --- Section 5 addendum (BINDING, 2026-10-27) ---------------------------------------------

test('PA(i) intent carry-over: a generate node invalidated by a rerunning ancestor is a fresh paid generation, old job untouched', async (t) => {
  const f = await fixture(t, { scriptAgent: 'existing' });
  const run1 = await f.fullRun();
  assert.equal(run1.status, 'awaiting_review', JSON.stringify(run1));
  const job1Id = record(run1, 'generate').output.generationJobId;
  const job1Before = await f.api(`/api/generations/${job1Id}`);
  assert.equal(f.submits(), 1);

  // Rerun just 'script' (single-stage auto-resume picks run1); invalidates storyboard
  // through review, including generate, without producing new output for them.
  const run2 = await f.legacyRun(['script']);
  assert.equal(run2.status, 'completed', JSON.stringify(run2));

  const plan = await f.plan({ mode: 'node', targetNodeId: 'generate' });
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.equal(plan.resumeRunId, run2.id);
  assert.deepEqual(plan.selectedStages, ['storyboard', 'layout', 'generate']);
  assert.equal(plan.requiresGeneration, true);

  const epA = await f.current();
  const quoteResponse = await f.quote({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: epA.version, execution: { mode: 'node', targetNodeId: 'generate' }, disclosure });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();

  const epB = await f.current();
  const runResponse = await f.run({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: epB.version, execution: { mode: 'node', targetNodeId: 'generate' }, allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(runResponse.status, 202, await runResponse.clone().text(), 'must never be the legacy 409 "original paid node input changed"');
  const started = await runResponse.json();
  const run3 = await f.waitRun(started.id);
  assert.equal(run3.status, 'completed', JSON.stringify(run3), 'review was not selected in this narrower run, so reviewStatus settles on completed');

  assert.equal(f.submits(), 2, 'exactly one new submission for the fresh generate node');
  const generated3 = record(run3, 'generate');
  assert.equal(generated3.reused, undefined, 'must not be marked reused from the invalidated prior job');
  const job2Id = generated3.output.generationJobId;
  assert.notEqual(job2Id, job1Id, 'a genuinely new job, not the stale invalidated one');

  const job1After = await f.api(`/api/generations/${job1Id}`);
  assert.deepEqual(job1After, job1Before, 'the old paid job/history must be completely untouched');
});

test('PA(ii) mode all keep after an upstream rerun also produces a fresh paid generation with exactly one new submission', async (t) => {
  const f = await fixture(t, { scriptAgent: 'existing' });
  const run1 = await f.fullRun();
  assert.equal(run1.status, 'awaiting_review', JSON.stringify(run1));
  const job1Id = record(run1, 'generate').output.generationJobId;
  assert.equal(f.submits(), 1);

  const run2 = await f.legacyRun(['script']);
  assert.equal(run2.status, 'completed', JSON.stringify(run2));

  const plan = await f.plan({ mode: 'all', refresh: false });
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.equal(plan.resumeRunId, run2.id);
  assert.deepEqual(plan.selectedStages, ['storyboard', 'layout', 'generate', 'render', 'review']);

  const ep1 = await f.current();
  const quoteResponse = await f.quote({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep1.version, execution: { mode: 'all', refresh: false }, disclosure });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();

  const ep2 = await f.current();
  const runResponse = await f.run({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep2.version, execution: { mode: 'all', refresh: false }, allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(runResponse.status, 202, await runResponse.clone().text());
  const started = await runResponse.json();
  const run3 = await f.waitRun(started.id);
  assert.equal(run3.status, 'awaiting_review', JSON.stringify(run3));
  assert.equal(f.submits(), 2);
  assert.notEqual(record(run3, 'generate').output.generationJobId, job1Id);
});

test('PC prepare-first: when the real prepareCandidate would reject bundling a scene producer with generate, /plan defers the generate chain behind a free prefix', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-plan-prepfirst-'));
  const forbidden = async () => { throw new Error('Unexpected external/paid operation'); };
  let submits = 0;
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}), fetchTrends: forbidden, runAgent: forbidden },
    generation: {
      capability: async () => ({ available: true }), models: forbidden,
      modelSchema: async (model) => ({ id: model, type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
      estimate: async () => ({ cost: 1, currency: 'USD', quoted: true }),
      create: async () => { submits++; return { requestId: `fixture-${submits}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] }; },
      status: forbidden,
    },
    generationOptions: { download: forbidden, probe: forbidden },
    renderer: forbidden,
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = async (path, method = 'GET', body) => { const response = await request(path, method, body); const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value; };

  // script(existing) -> board -> generate1 -> after-layout -> generate2 -> render.
  // Targeting generate2 with nothing reusable selects generate1+after-layout too; the real
  // prepareCandidate rejects a selected storyboard/layout node whose ancestors include a
  // selected generate node ("Prepare downstream scene edits separately before quoting
  // generation"), so the plan must defer generate1/after-layout/generate2 behind a free prefix.
  const nodes = [
    node('script', 'script', { agent: 'existing' }), node('board', 'storyboard'),
    node('generate1', 'generate', { model: 'fixture_image', prompt: 'First pass', sceneIndex: 0 }),
    node('after-layout', 'layout'),
    node('generate2', 'generate', { model: 'fixture_image', prompt: 'Second pass', sceneIndex: 0 }),
    node('render', 'render'),
  ];
  const edges = [
    { id: 'e1', source: 'script', target: 'board' }, { id: 'e2', source: 'board', target: 'generate1' },
    { id: 'e3', source: 'generate1', target: 'after-layout' }, { id: 'e4', source: 'after-layout', target: 'generate2' },
    { id: 'e5', source: 'generate2', target: 'render' },
  ];
  const channel = await api('/api/channels', 'POST', { name: 'Prepare-first owner', category: 'information', platform: 'YouTube' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Prepare-first project', topic: 'Fixture topic' });
  const template = await api('/api/workflows', 'POST', { name: 'Prepare-first graph', nodes, edges });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });

  const planResponse = await request(`/api/workflows/${workflow.id}/plan`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'generate2' }, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.deepEqual(plan.selectedStages, ['script', 'board'], 'generate1/after-layout/generate2 must be deferred, not silently bundled into a selection /quote would reject');
  assert.equal(plan.requiresGeneration, false);
  assert.deepEqual(plan.deferredStages, ['generate1', 'after-layout', 'generate2']);
  assert.equal(plan.notice, '비용이 드는 생성은 준비 단계가 끝난 뒤 다시 실행해 비용을 확인합니다.');

  // Every plan response carries deferredStages/notice, defaulting to [] / ''.
  const plainPlanResponse = await request(`/api/workflows/${workflow.id}/plan`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'script' }, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version });
  const plainPlan = await plainPlanResponse.json();
  assert.deepEqual(plainPlan.deferredStages, []);
  assert.equal(plainPlan.notice, '');

  // /quote and /run with the same execution agree with the plan's selectedStages.
  const quoteResponse = await request(`/api/workflows/${workflow.id}/quote`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'generate2' }, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text(), 'quoting the deferred-aware prefix must not hit prepareCandidate\'s scene-producer-ancestor-of-selected-generate rejection');
  const quoted = await quoteResponse.json();
  assert.deepEqual(quoted.selectedStages, plan.selectedStages);

  const runResponse = await request(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'generate2' }, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version });
  assert.equal(runResponse.status, 202, await runResponse.clone().text());
  const started = await runResponse.json();
  let run;
  for (let turn = 0; turn < 5000; turn++) {
    run = await api(`/api/workflow-runs/${started.id}`);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.deepEqual(run.selectedStages, ['script', 'board']);
  assert.equal(submits, 0, 'the deferred generation nodes must never call the provider for a prepare-only run');
});

test('PD a skipped non-hard-dependency producer is simply omitted: no block, the hard chain still runs/reuses correctly', async (t) => {
  const f = await fixture(t);
  // Reproduces P2's missing-ancestor shape, but research now has a user skip toggled on
  // despite having a saved completed output: script has no HARD_DEPENDENCY on research, so
  // research must be 'skip' and simply omitted, never a skipped_prerequisite block.
  const runR = await f.legacyRun(['research']);
  assert.equal(runR.status, 'completed', JSON.stringify(runR));
  const skippedWorkflow = await f.toggleSkip('research', true);
  assert.deepEqual(skippedWorkflow.skippedNodes, ['research']);

  const plan = await f.plan({ mode: 'node', targetNodeId: 'script' });
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.deepEqual(plan.selectedStages, ['trend', 'script'], 'research is skipped and simply omitted; trend still has to run fresh, script is the target');
  assert.equal(nodeAction(plan, 'research'), 'skip');
  assert.equal(nodeAction(plan, 'trend'), 'run');
  assert.equal(nodeAction(plan, 'script'), 'run');
  assert.deepEqual(plan.skippedNodeIds, ['research']);
});

test('PE a reused node\'s nodeRun carries no leftover skipReason/error/retained*/staleFrom from its prior nodeRun', async (t) => {
  const f = await fixture(t);
  // runA: trend+research+script+storyboard all complete. runB: single-stage 'storyboard'
  // auto-resumes runA; storyboard's only edge-parent/hard-dependency is script, so research
  // (two hops upstream) is never pulled into required-reuse -- it is left as a bare
  // "skip, retain prior completed output" nodeRun (retainedOutput/retainedStatus/retainedFrom).
  const runA = await f.legacyRun(['trend', 'research', 'script', 'storyboard']);
  assert.equal(runA.status, 'completed', JSON.stringify(runA));
  const runB = await f.legacyRun(['storyboard']);
  assert.equal(runB.status, 'completed', JSON.stringify(runB));
  const researchInB = record(runB, 'research');
  assert.equal(researchInB.status, 'skipped');
  assert.equal(researchInB.retainedStatus, 'completed');
  assert.ok(researchInB.retainedOutput, 'precondition: research really does carry retained lineage in runB');

  // runC targets 'script'; research (script's direct edge-parent, reusable in runB) must
  // now be genuinely REUSED, and that fresh nodeRun must not carry runB's retained-lineage
  // fields forward (the bug: `{...prior}` spreads the whole skipped-with-retained record).
  const plan = await f.plan({ mode: 'node', targetNodeId: 'script' });
  assert.equal(nodeAction(plan, 'research'), 'reuse');

  const runC = await f.legacyRun(['script']);
  assert.equal(runC.status, 'completed', JSON.stringify(runC));
  const researchInC = record(runC, 'research');
  assert.equal(researchInC.status, 'completed');
  assert.equal(researchInC.reused, true);
  assert.equal(researchInC.reusedFrom, runB.id);
  for (const field of ['skipReason', 'error', 'retainedOutput', 'retainedStatus', 'retainedFrom', 'staleFrom']) {
    assert.equal(researchInC[field], undefined, `reused research nodeRun in runC must not carry leftover ${field} from runB's prior record`);
  }
});

test('PF staleFrom persists for an unselected output-less node, and staleNodeIds covers a skipped node whose saved output will be dropped', async (t) => {
  const f = await fixture(t);
  const runA = await f.legacyRun(['trend', 'research', 'script']);
  assert.equal(runA.status, 'completed', JSON.stringify(runA));
  const runB = await f.legacyRun(['trend']);
  assert.equal(runB.status, 'completed', JSON.stringify(runB));
  assert.equal(record(runB, 'research').staleFrom, runA.id);
  assert.equal(record(runB, 'research').output, undefined, 'precondition: research has no reusable output in runB any more');

  // runC again reruns only trend (auto-resumes runB); research still has no reusable output
  // of its own anywhere in runB, so its staleFrom marker (pointing at the ORIGINAL source,
  // runA, where the real output was dropped) must be carried forward, not silently cleared.
  const runC = await f.legacyRun(['trend']);
  assert.equal(runC.status, 'completed', JSON.stringify(runC));
  assert.equal(record(runC, 'research').status, 'skipped');
  assert.equal(record(runC, 'research').output, undefined);
  assert.equal(record(runC, 'research').staleFrom, runA.id, 'staleFrom must persist until research actually reruns, not reset to undefined just because it has no output to mark stale this time');

  // A skipped node whose saved output gets dropped by an upstream rerun must also land in
  // staleNodeIds even though its own per-node action is 'skip', not 'stale'.
  const runD = await f.legacyRun(['trend', 'research', 'script']);
  assert.equal(runD.status, 'completed', JSON.stringify(runD));
  await f.toggleSkip('research', true);
  const plan = await f.plan({ mode: 'node', targetNodeId: 'trend' });
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.equal(nodeAction(plan, 'research'), 'skip');
  assert.ok(plan.staleNodeIds.includes('research'), 'a skipped node\'s saved output is still being dropped by this rerun and must be flagged stale for the UI');
});

test('PG a blocked plan labels needed nodes reuse/idle by actual reusability; only the offending node is blocked', async (t) => {
  const f = await fixture(t);
  const runA = await f.legacyRun(['trend', 'research']);
  assert.equal(runA.status, 'completed', JSON.stringify(runA));
  // 'script' is a HARD_DEPENDENCY of 'storyboard' and is skipped with no saved output.
  await f.toggleSkip('script', true);

  const plan = await f.plan({ mode: 'node', targetNodeId: 'storyboard' });
  assert.equal(plan.blocked.code, 'skipped_prerequisite');
  assert.ok(plan.blocked.message.startsWith('건너뛴 선행 노드에 저장된 결과가 없어 실행할 수 없습니다.'), `message must start with the exact contract prefix (node name may be appended): ${plan.blocked.message}`);
  assert.equal(nodeAction(plan, 'script'), 'blocked', 'the offending hard-prerequisite node must be the one labeled blocked');
  // trend/research are already completed in runA; if they appear at all they must be
  // labeled by their real reusability (reuse), never a bare unreasoned 'idle'.
  const trendLabel = nodeAction(plan, 'trend');
  if (trendLabel !== undefined) assert.equal(trendLabel, 'reuse', 'trend has a reusable completed output and must not be mislabeled idle');
  const researchLabel = nodeAction(plan, 'research');
  if (researchLabel !== undefined) assert.equal(researchLabel, 'reuse', 'research has a reusable completed output and must not be mislabeled idle');
});

test('PH active_run is scoped to the whole episode (any workflow) and the global MAX_ACTIVE_RUNS cap also blocks active_run', async (t) => {
  const f = await fixture(t, { stallTrend: true });
  // A second workflow copy on the SAME episode; an active run under the first workflow
  // must still block planning under the second (section 5.H: episode-wide, not per-workflow).
  const templateSame = await f.api('/api/workflows', 'POST', buildGraph('codex', 'BETA'));
  const workflow2 = await f.api(`/api/workflows/${templateSame.id}/copies`, 'POST', { channelId: f.channel.id, episodeId: f.episode.id, expectedTemplateVersion: templateSame.version });
  const ep0 = await f.current();
  const startResponse = await f.run({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep0.version, selectedStages: ['trend'], startStage: 'trend' });
  assert.equal(startResponse.status, 202, await startResponse.clone().text());
  const started = await startResponse.json();

  const epForW2 = await f.current();
  const planOnOtherWorkflow = await f.request(`/api/workflows/${workflow2.id}/plan`, 'POST', { episodeId: f.episode.id, execution: { mode: 'node', targetNodeId: 'research' }, expectedWorkflowVersion: workflow2.version, expectedEpisodeVersion: epForW2.version });
  assert.equal(planOnOtherWorkflow.status, 200, await planOnOtherWorkflow.clone().text());
  const planBody = await planOnOtherWorkflow.json();
  assert.deepEqual(planBody.blocked, { code: 'active_run', message: '이 에피소드에 실행 중인 워크플로우가 있습니다. 끝난 뒤 다시 시도하세요.' }, 'an active run under a DIFFERENT workflow on the same episode must still block');

  f.releaseGate();
  assert.equal((await f.waitRun(started.id)).status, 'completed');

  // Global concurrency cap (MAX_ACTIVE_RUNS=4, server/workflows.mjs): 4 episodes each with a
  // stalled active run must block a 5th, completely unrelated episode's plan with active_run,
  // even though that 5th episode itself has zero active runs.
  const f2 = await fixture(t, { stallTrend: true });
  const started2 = [];
  for (let i = 0; i < 4; i++) {
    const project = i === 0 ? { episode: f2.episode, workflow: f2.workflow } : await f2.freshProject();
    const ep = (await f2.api('/api/state')).episodes.find((item) => item.id === project.episode.id);
    const response = await f2.request(`/api/workflows/${project.workflow.id}/run`, 'POST', { episodeId: project.episode.id, expectedWorkflowVersion: project.workflow.version, expectedEpisodeVersion: ep.version, selectedStages: ['trend'], startStage: 'trend' });
    assert.equal(response.status, 202, `project ${i}: ${response.status} ${await response.clone().text()}`);
    started2.push(await response.json());
  }
  const fifthProject = await f2.freshProject();
  const fifthEp = (await f2.api('/api/state')).episodes.find((item) => item.id === fifthProject.episode.id);
  const capPlanResponse = await f2.request(`/api/workflows/${fifthProject.workflow.id}/plan`, 'POST', { episodeId: fifthProject.episode.id, execution: { mode: 'node', targetNodeId: 'trend' }, expectedWorkflowVersion: fifthProject.workflow.version, expectedEpisodeVersion: fifthEp.version });
  assert.equal(capPlanResponse.status, 200, await capPlanResponse.clone().text());
  const capPlan = await capPlanResponse.json();
  assert.deepEqual(capPlan.blocked, { code: 'active_run', message: '이 에피소드에 실행 중인 워크플로우가 있습니다. 끝난 뒤 다시 시도하세요.' }, 'the global concurrency cap must also surface as blocked active_run, not a 429/500');

  f2.releaseGate();
  for (const run of started2) assert.equal((await f2.waitRun(run.id)).status, 'completed');
});

test('PI a legacy body with an explicit resumeRunId:null is rejected with 400, not silently treated as "no resume"', async (t) => {
  const f = await fixture(t);
  const ep = await f.current();
  const runResponse = await f.run({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version, selectedStages: ['trend'], startStage: 'trend', resumeRunId: null });
  assert.equal(runResponse.status, 400, await runResponse.clone().text());
  const quoteResponse = await f.quote({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: ep.version, selectedStages: ['trend'], startStage: 'trend', resumeRunId: null });
  assert.equal(quoteResponse.status, 400, await quoteResponse.clone().text());
});

test('PJ a prepare-first plan that selects storyboard/layout is strictly read-only: no episode/run/plan/event mutation, zero provider calls, and /quote agrees on deferredStages', async (t) => {
  const f = await fixture(t, { scriptAgent: 'codex' });
  const execution = { mode: 'node', targetNodeId: 'generate' };

  const episodeBefore = await f.current();
  const runsBefore = await f.api(`/api/workflows/${f.workflow.id}/runs`);
  const eventsBefore = (await f.api('/api/state')).events;
  const historyBefore = await f.api(`/api/episodes/${f.episode.id}/history`);

  const planNode = await f.plan(execution);
  assert.equal(planNode.blocked, false, JSON.stringify(planNode));
  // script.agent is 'codex' (not 'existing'): the real prepareCandidate would reject
  // bundling script with a selected generate, so storyboard/layout are selected (the free
  // prefix) while generate is deferred, EXACTLY the condition under which the real
  // (non-dry) prepareCandidate path persists a normalized scene snapshot via
  // store.updateEpisode. The dry/plan path must never do that.
  assert.deepEqual(planNode.selectedStages, ['trend', 'research', 'script', 'storyboard', 'layout']);
  assert.ok(planNode.selectedStages.includes('storyboard') && planNode.selectedStages.includes('layout'));
  assert.deepEqual(planNode.deferredStages, ['generate']);
  assert.equal(planNode.requiresGeneration, false);

  const planAll = await f.plan({ mode: 'all', refresh: false });
  assert.equal(planAll.blocked, false, JSON.stringify(planAll));

  const episodeAfter = await f.current();
  const runsAfter = await f.api(`/api/workflows/${f.workflow.id}/runs`);
  const eventsAfter = (await f.api('/api/state')).events;
  const historyAfter = await f.api(`/api/episodes/${f.episode.id}/history`);

  assert.equal(episodeAfter.version, episodeBefore.version, 'a prepare-first plan must never bump the episode version');
  assert.deepEqual(episodeAfter.scenes, episodeBefore.scenes, 'a prepare-first plan must never persist a normalized scene snapshot (the real prepareCandidate\'s store.updateEpisode side effect)');
  assert.equal(runsAfter.length, runsBefore.length, 'plan must never create a workflow run');
  assert.equal(eventsAfter.length, eventsBefore.length, 'plan must never record an event, including workflows.updated from scene normalization');
  assert.deepEqual(historyAfter, historyBefore, 'plan must never create an episode history snapshot');
  assert.equal(f.schemaCalls(), 0);
  assert.equal(f.estimateCalls(), 0);
  assert.equal(f.submits(), 0);
  assert.deepEqual(f.prompts, []);

  // /quote (the REAL, non-dry path) with the identical execution must agree on deferredStages.
  const epForQuote = await f.current();
  const quoteResponse = await f.quote({ episodeId: f.episode.id, expectedWorkflowVersion: f.workflow.version, expectedEpisodeVersion: epForQuote.version, execution });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();
  assert.deepEqual(quoted.selectedStages, planNode.selectedStages);
  assert.deepEqual(quoted.deferredStages, planNode.deferredStages, '/quote must agree with /plan on exactly which stages were deferred');
});

// --- ServerReview round 2 (Main's follow-up, PK/PL/PM/PN) --------------------------------

async function bareApp(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-plan-bare-'));
  const forbidden = async () => { throw new Error('Unexpected external/paid operation'); };
  let submits = 0;
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}), fetchTrends: forbidden, runAgent: overrides.runAgent || forbidden },
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
    renderer: async (episode, { dataDir: root }) => {
      const filename = `${randomUUID()}.mp4`;
      await writeFile(join(root, 'exports', filename), RENDER_BYTES);
      return { filename, outputUrl: `/api/exports/${filename}`, sha256: RENDER_SHA256 };
    },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = async (path, method = 'GET', body) => { const response = await request(path, method, body); const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value; };
  const channel = await api('/api/channels', 'POST', { name: 'Fixture owner', category: 'information', platform: 'YouTube' });
  const waitRun = async (id) => {
    for (let turn = 0; turn < 5000; turn++) {
      const run = await api(`/api/workflow-runs/${id}`);
      if (['completed', 'failed', 'cancelled', 'awaiting_review', 'approved', 'changes_requested'].includes(run.status)) return run;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`Run ${id} did not reach a terminal state`);
  };
  const project = async (graph) => {
    const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Fixture project', topic: 'Fixture topic' });
    const template = await api('/api/workflows', 'POST', graph);
    const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
    const current = async () => (await api('/api/state')).episodes.find((item) => item.id === episode.id);
    return { episode, workflow, current };
  };
  const toggleSkip = async (workflow, nodeId, skipped = true) => {
    const wf = (await api('/api/state')).workflows.find((item) => item.id === workflow.id);
    return api(`/api/workflows/${workflow.id}/skips`, 'POST', { nodeId, skipped, expectedVersion: wf.version });
  };
  return { api, request, channel, waitRun, project, toggleSkip, submits: () => submits };
}

test('PL a non-prepare-first prepareCandidate rejection is blocked invalid_selection with the real message, not silently deferred', async (t) => {
  const f = await bareApp(t);
  // script(existing)->board->{layout-a,layout-b}->{generate-a,generate-b}->{render-a,render-b}.
  // Running both layout branches leaves the episode holding whichever ran LAST (layout-b);
  // targeting generate-a then finds its saved producer (layout-a) scenes no longer match the
  // live episode -- a real prepareCandidate rejection with nothing to do with script agent or
  // a storyboard/layout-selected-alongside-generate conflict, so it is NOT prepare-first eligible.
  const graph = {
    name: 'PL divergent-branch fixture',
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
  const p = await f.project(graph);
  const ep1 = await p.current();
  const run1Response = await f.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'layout-a', 'layout-b'], startStage: 'script' });
  assert.equal(run1Response.status, 202, await run1Response.clone().text());
  const run1 = await f.waitRun((await run1Response.json()).id);
  assert.equal(run1.status, 'completed', JSON.stringify(run1));

  const epAfterRun1 = await p.current();
  const planResponse = await f.request(`/api/workflows/${p.workflow.id}/plan`, 'POST', { episodeId: p.episode.id, execution: { mode: 'node', targetNodeId: 'generate-a' }, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: epAfterRun1.version });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.blocked && plan.blocked.code, 'invalid_selection');
  assert.equal(plan.blocked.message, 'Save the connected scene branch before quoting generation');
  assert.deepEqual(plan.selectedStages, []);
  assert.deepEqual(plan.deferredStages, [], 'this rejection is not prepare-first eligible; nothing should be silently deferred');

  const ep2 = await p.current();
  const runResponse = await f.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep2.version, execution: { mode: 'node', targetNodeId: 'generate-a' } });
  assert.equal(runResponse.status, 409, await runResponse.clone().text());
  const runBody = await runResponse.json();
  assert.equal(runBody.code, 'invalid_selection');
  assert.equal(f.submits(), 0);

  // PC must still produce a prepare-first prefix for the unrelated script-agent conflict
  // (not re-asserted in full here -- already covered by the standing PC test in this file).
});

test('PM(i) a skipped, invalidated, output-less optional producer is omitted, never blocked (generic parent-reuse loop)', async (t) => {
  // Pragmatic substitution for the literal "news" example: the real target of this addendum
  // is stageSelection's GENERIC parent-reuse loop (any direct edge-parent, any type), which
  // is exactly what research->script already exercises in this file's CHAIN graph. A news
  // node would hit the exact same code path but requires either a real Google News call or
  // extra store seeding unrelated to what's being tested here.
  const f = await fixture(t);
  const runA = await f.legacyRun(['trend', 'research', 'script']);
  assert.equal(runA.status, 'completed', JSON.stringify(runA));
  await f.toggleSkip('research', true);
  // trend reruns (auto-resumes runA), invalidating research; research is now skipped AND
  // invalidated AND output-less in runB -- still must never block, just be omitted.
  const runB = await f.legacyRun(['trend']);
  assert.equal(runB.status, 'completed', JSON.stringify(runB));
  assert.equal(record(runB, 'research').status, 'skipped');
  assert.equal(record(runB, 'research').output, undefined);

  const plan = await f.plan({ mode: 'node', targetNodeId: 'script' });
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.equal(nodeAction(plan, 'research'), 'skip');
  assert.deepEqual(plan.selectedStages, ['script']);
  assert.equal(nodeAction(plan, 'trend'), 'reuse');
});

test('PM(ii) a skipped layout with no valid output never blocks a planned generate; generate falls back to storyboard', async (t) => {
  const f = await fixture(t, { scriptAgent: 'existing' });
  const runA = await f.legacyRun(['trend', 'research', 'script', 'storyboard', 'layout']);
  assert.equal(runA.status, 'completed', JSON.stringify(runA));
  await f.toggleSkip('layout', true);
  // storyboard reruns (auto-resumes runA), invalidating layout; layout is now skipped AND
  // invalidated AND output-less. generate's optional "layout" producer must be silently
  // omitted (falling back to the storyboard producer), never blocked.
  const runB = await f.legacyRun(['storyboard']);
  assert.equal(runB.status, 'completed', JSON.stringify(runB));
  assert.equal(record(runB, 'layout').status, 'skipped');
  assert.equal(record(runB, 'layout').output, undefined);

  const plan = await f.plan({ mode: 'node', targetNodeId: 'generate' });
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.equal(nodeAction(plan, 'layout'), 'skip');
  assert.deepEqual(plan.selectedStages, ['generate']);
  assert.equal(nodeAction(plan, 'storyboard'), 'reuse');
  assert.equal(f.schemaCalls(), 0, 'read-only plan must not touch the generation provider');
});

test('PM(iii) a skipped generate with no valid output never blocks a planned render; its scene producer reruns first', async (t) => {
  const f = await bareApp(t);
  const graph = {
    name: 'PM(iii) minimal fixture',
    nodes: [node('script', 'script', { agent: 'existing' }), node('board', 'storyboard'), node('generate', 'generate', { model: 'fixture_image', prompt: 'Fixture', sceneIndex: 0 }), node('render', 'render')],
    edges: [{ id: 'e1', source: 'script', target: 'board' }, { id: 'e2', source: 'board', target: 'generate' }, { id: 'e3', source: 'generate', target: 'render' }],
  };
  const p = await f.project(graph);
  const legacy = async (ids, extra = {}) => {
    const ep = await p.current();
    const response = await f.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep.version, selectedStages: ids, startStage: ids[0], ...extra });
    assert.equal(response.status, 202, await response.clone().text());
    return f.waitRun((await response.json()).id);
  };
  const run1 = await legacy(['script', 'board']);
  assert.equal(run1.status, 'completed', JSON.stringify(run1));
  const ep1 = await p.current();
  const quoteResponse = await f.request(`/api/workflows/${p.workflow.id}/quote`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['generate'], startStage: 'generate', resumeRunId: run1.id, disclosure });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();
  const genRunResponse = await f.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['generate'], startStage: 'generate', resumeRunId: run1.id, allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(genRunResponse.status, 202, await genRunResponse.clone().text());
  const runA = await f.waitRun((await genRunResponse.json()).id);
  assert.equal(runA.status, 'completed', JSON.stringify(runA));
  assert.equal(record(runA, 'generate').status, 'completed');
  assert.equal(f.submits(), 1);

  await f.toggleSkip(p.workflow, 'generate', true);
  // 'board' reruns (its own single-stage auto-resume picks runA), invalidating generate;
  // generate is now skipped AND invalidated AND output-less. Planning 'render' (whose
  // connected-generate reuse loop currently calls reuse() whenever ANY source exists,
  // regardless of reusability) must omit it, never block with skipped_prerequisite.
  const runB = await legacy(['board']);
  assert.equal(runB.status, 'completed', JSON.stringify(runB));
  assert.equal(record(runB, 'generate').status, 'skipped');
  assert.equal(record(runB, 'generate').output, undefined);

  const ep2 = await p.current();
  const planResponse = await f.request(`/api/workflows/${p.workflow.id}/plan`, 'POST', { episodeId: p.episode.id, execution: { mode: 'node', targetNodeId: 'render' }, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep2.version });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.equal(nodeAction(plan, 'generate'), 'skip');
  assert.deepEqual(plan.selectedStages, ['render']);
  assert.equal(f.submits(), 1, 'planning must never submit a new generation');
});

test('PN a deferred generate with a reusable output the prefix invalidates is labeled stale (not idle), and a never-run deferred node is idle', async (t) => {
  // script(codex)->board->generate1->after-layout->generate2->render.
  const graph = {
    name: 'PN deferred-stale fixture',
    nodes: [
      node('script', 'script', { agent: 'codex', prompt: 'Write a fixture script' }), node('board', 'storyboard'),
      node('generate1', 'generate', { model: 'fixture_image', prompt: 'First pass', sceneIndex: 0 }),
      node('after-layout', 'layout'),
      node('generate2', 'generate', { model: 'fixture_image', prompt: 'Second pass', sceneIndex: 0 }),
      node('render', 'render'),
    ],
    edges: [
      { id: 'e1', source: 'script', target: 'board' }, { id: 'e2', source: 'board', target: 'generate1' },
      { id: 'e3', source: 'generate1', target: 'after-layout' }, { id: 'e4', source: 'after-layout', target: 'generate2' },
      { id: 'e5', source: 'generate2', target: 'render' },
    ],
  };
  // runPrep: script+board only, via the real agent (allowed since no generate is selected
  // alongside it -- prepareCandidate's agent check only fires for a SELECTED script node).
  let prompts = 0;
  const runAgent = async () => { prompts++; if (prompts > 1) throw new Error('Fixture script rerun failure'); return { message: 'Fixture script', scenes: [scene('Fixture scene text')] }; };
  const f2 = await bareApp(t, { runAgent });
  const p2 = await f2.project(graph);
  const legacy = async (ids, extra = {}) => {
    const ep = await p2.current();
    const response = await f2.request(`/api/workflows/${p2.workflow.id}/run`, 'POST', { episodeId: p2.episode.id, expectedWorkflowVersion: p2.workflow.version, expectedEpisodeVersion: ep.version, selectedStages: ids, startStage: ids[0], ...extra });
    assert.equal(response.status, 202, await response.clone().text());
    return f2.waitRun((await response.json()).id);
  };
  const runPrep = await legacy(['script', 'board']);
  assert.equal(runPrep.status, 'completed', JSON.stringify(runPrep));
  const epPrep = await p2.current();
  const quoteResponse = await f2.request(`/api/workflows/${p2.workflow.id}/quote`, 'POST', { episodeId: p2.episode.id, expectedWorkflowVersion: p2.workflow.version, expectedEpisodeVersion: epPrep.version, selectedStages: ['generate1'], startStage: 'generate1', resumeRunId: runPrep.id, disclosure });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();
  const genResponse = await f2.request(`/api/workflows/${p2.workflow.id}/run`, 'POST', { episodeId: p2.episode.id, expectedWorkflowVersion: p2.workflow.version, expectedEpisodeVersion: epPrep.version, selectedStages: ['generate1'], startStage: 'generate1', resumeRunId: runPrep.id, allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(genResponse.status, 202, await genResponse.clone().text());
  const run1 = await f2.waitRun((await genResponse.json()).id);
  assert.equal(run1.status, 'completed', JSON.stringify(run1));
  assert.equal(record(run1, 'generate1').status, 'completed');
  assert.equal(f2.submits(), 1);

  // run2: script fails (single-stage auto-resume picks run1), cascading "upstream stage
  // failed" skips through board/generate1/after-layout/generate2/render -- generate1's
  // reusable run1 output is invalidated and dropped, carrying staleFrom=run1.id forward.
  const ep1 = await p2.current();
  const failResponse = await f2.request(`/api/workflows/${p2.workflow.id}/run`, 'POST', { episodeId: p2.episode.id, expectedWorkflowVersion: p2.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script'], startStage: 'script' });
  assert.equal(failResponse.status, 202, await failResponse.clone().text());
  const run2 = await f2.waitRun((await failResponse.json()).id);
  assert.equal(run2.status, 'failed', JSON.stringify(run2));
  assert.equal(record(run2, 'generate1').status, 'skipped');
  assert.equal(record(run2, 'generate1').output, undefined);
  assert.equal(record(run2, 'generate1').staleFrom, run1.id);

  const ep2 = await p2.current();
  const planResponse = await f2.request(`/api/workflows/${p2.workflow.id}/plan`, 'POST', { episodeId: p2.episode.id, execution: { mode: 'node', targetNodeId: 'generate2' }, expectedWorkflowVersion: p2.workflow.version, expectedEpisodeVersion: ep2.version });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.deepEqual(plan.selectedStages, ['script', 'board']);
  assert.deepEqual(plan.deferredStages, ['generate1', 'after-layout', 'generate2']);
  assert.equal(nodeAction(plan, 'generate1'), 'stale', 'generate1 had a reusable output (run1) that this exact prefix invalidates; it must show 갱신 필요, not a bare idle');
  assert.ok(plan.staleNodeIds.includes('generate1'));
  assert.equal(nodeAction(plan, 'after-layout'), 'idle', 'after-layout never produced output in any run; idle, not stale');
  assert.equal(nodeAction(plan, 'generate2'), 'idle', 'generate2 never produced output in any run; idle, not stale');
});

test('PK an unresolved prior generation job blocks a replanned generate ONLY when it is invalidated by the same plan; a direct non-invalidated retarget keeps HEAD semantics', async (t) => {
  const UNRESOLVED_MESSAGE = '이전 생성 요청이 아직 끝나지 않았거나 결과가 적용되지 않았습니다. 기존 요청을 복구하거나 적용한 뒤 다시 실행하세요.';
  const graph = {
    name: 'PK unresolved-job fixture',
    nodes: [node('script', 'script', { agent: 'existing' }), node('board', 'storyboard'), node('generate', 'generate', { model: 'fixture_image', prompt: 'Fixture', sceneIndex: 0 }), node('render', 'render')],
    edges: [{ id: 'e1', source: 'script', target: 'board' }, { id: 'e2', source: 'board', target: 'generate' }, { id: 'e3', source: 'generate', target: 'render' }],
  };
  // run1: script+board+generate submitted together in one legacy run (script.agent is
  // 'existing' so prepareCandidate's agent check never fires regardless of bundling).
  async function setup(app) {
    const p = await app.project(graph);
    const ep1 = await p.current();
    const quoteResponse = await app.request(`/api/workflows/${p.workflow.id}/quote`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'generate'], startStage: 'script', disclosure });
    assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
    const quoted = await quoteResponse.json();
    const response = await app.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'generate'], startStage: 'script', allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
    assert.equal(response.status, 202, await response.clone().text());
    const run1 = await app.waitRun((await response.json()).id);
    return { p, run1 };
  }

  // (a) completed+applied, mode:'all': never blocked generation_unresolved (cross-check;
  // full dedicated coverage is PA(i)/PA(ii)/P12).
  {
    const app = await bareApp(t);
    const { p, run1 } = await setup(app);
    assert.equal(run1.status, 'completed', JSON.stringify(run1));
    assert.equal(record(run1, 'generate').status, 'completed');
    const ep = await p.current();
    const planResponse = await app.request(`/api/workflows/${p.workflow.id}/plan`, 'POST', { episodeId: p.episode.id, execution: { mode: 'all', refresh: false }, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep.version });
    const plan = await planResponse.json();
    assert.notEqual(plan.blocked && plan.blocked.code, 'generation_unresolved', JSON.stringify(plan));
  }

  // (b) for each unresolved state, mode:'all' INVALIDATES generate (it is a descendant of
  // the rerunning 'board'/'script' set) -- this is the dangerous case: generate's old
  // job/intent gets dropped by invalidation, so without a check the planner would let a
  // brand new paid job be submitted silently on top of an unresolved first one.
  const assertUnresolvedBlocksUnderAll = async (app, p, run1, sourceRun, label) => {
    const jobId = record(run1, 'generate').output.generationJobId;
    const jobBefore = await app.api(`/api/generations/${jobId}`);
    const submitsBefore = app.submits();

    const ep1 = await p.current();
    const planResponse = await app.request(`/api/workflows/${p.workflow.id}/plan`, 'POST', { episodeId: p.episode.id, execution: { mode: 'all', refresh: false }, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version });
    assert.equal(planResponse.status, 200, `${label}: ${await planResponse.clone().text()}`);
    const plan = await planResponse.json();
    assert.equal(plan.blocked && plan.blocked.code, 'generation_unresolved', `${label}: expected blocked.code generation_unresolved, got ${JSON.stringify(plan.blocked)}`);
    assert.equal(plan.blocked.message, UNRESOLVED_MESSAGE, label);
    assert.equal(nodeAction(plan, 'generate'), 'blocked', label);

    const quoteResponse = await app.request(`/api/workflows/${p.workflow.id}/quote`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, execution: { mode: 'all', refresh: false } });
    assert.equal(quoteResponse.status, 409, `${label} quote: ${await quoteResponse.clone().text()}`);
    assert.equal((await quoteResponse.json()).code, 'generation_unresolved', label);

    const execRunResponse = await app.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, execution: { mode: 'all', refresh: false } });
    assert.equal(execRunResponse.status, 409, `${label} run(execution): ${await execRunResponse.clone().text()}`);
    assert.equal((await execRunResponse.json()).code, 'generation_unresolved', label);

    // Legacy body: the full stage set that mirrors the planner's selection, resumed from
    // the run where generate is genuinely invalidated (script/board actually reran there).
    const legacyRunResponse = await app.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'generate'], startStage: 'script', resumeRunId: sourceRun.id });
    assert.equal(legacyRunResponse.status, 409, `${label} run(legacy): ${await legacyRunResponse.clone().text()}`);
    assert.equal((await legacyRunResponse.json()).code, 'generation_unresolved', label);

    assert.equal(app.submits(), submitsBefore, `${label}: zero new submissions`);
    assert.deepEqual(await app.api(`/api/generations/${jobId}`), jobBefore, `${label}: the unresolved job record must be completely untouched`);
  };

  // Forces generate to be genuinely INVALIDATED (not just non-reusable on its own): a
  // single-stage 'script' rerun auto-resumes run1, script/board actually rerun, and
  // generate/render become descendants of a node that RAN in this exact lineage.
  const forceInvalidatingRerun = async (app, p) => {
    const ep = await p.current();
    const response = await app.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep.version, selectedStages: ['script'], startStage: 'script' });
    assert.equal(response.status, 202, await response.clone().text());
    const run2 = await app.waitRun((await response.json()).id);
    assert.equal(run2.status, 'completed', JSON.stringify(run2));
    assert.equal(record(run2, 'generate').status, 'skipped');
    return run2;
  };

  for (const [label, create] of [
    ['submission_unknown', async () => { throw new Error('Fixture: no provider identifier returned'); }],
    ['manual_recovery', async () => ({ requestId: 'fixture-manual-1', status: 'weird_unsupported_state', outputs: [] })],
  ]) {
    const app = await bareApp(t, { create });
    const { p, run1 } = await setup(app);
    assert.equal(run1.status, 'failed', JSON.stringify(run1));

    // Same unresolved job, DIRECT re-target of 'generate' (mode:'node') sourced straight
    // from run1 is NOT invalidated by its own plan (descendants() excludes the node
    // itself) -- intended HEAD semantics: the server lets the run proceed and
    // inherit/resume the existing job reference; a non-resumable state surfaces as a
    // run-time 409 instead, not a plan-time block.
    const ep2 = await p.current();
    const directPlanResponse = await app.request(`/api/workflows/${p.workflow.id}/plan`, 'POST', { episodeId: p.episode.id, execution: { mode: 'node', targetNodeId: 'generate' }, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep2.version });
    const directPlan = await directPlanResponse.json();
    assert.notEqual(directPlan.blocked && directPlan.blocked.code, 'generation_unresolved', `${label} direct retarget must not be plan-blocked (HEAD semantics): ${JSON.stringify(directPlan)}`);

    const run2 = await forceInvalidatingRerun(app, p);
    await assertUnresolvedBlocksUnderAll(app, p, run1, run2, label);
  }

  // polling_failed, mode:'all': create() returns ACTIVE; maxPollDurationMs:1 fails fast.
  {
    const app = await bareApp(t, { create: async () => ({ requestId: 'fixture-poll-1', status: 'in_progress', outputs: [] }), generationOptions: { pollIntervalMs: 5, maxPollDurationMs: 1 } });
    const { p, run1 } = await setup(app);
    assert.equal(run1.status, 'failed', JSON.stringify(run1));
    const run2 = await forceInvalidatingRerun(app, p);
    await assertUnresolvedBlocksUnderAll(app, p, run1, run2, 'polling_failed');
  }
  // NOTE: a literal steady-state 'in_progress' job is intentionally not constructed here
  // (see round-2 checkpoint note -- generations.wait()'s non-unref'd 30 min timeout is a
  // real hang risk on this HTTP-only test surface). submission_unknown/manual_recovery/
  // polling_failed/completed-not-applied exercise the identical "unresolved" family safely.

  // completed-but-not-applied, mode:'all': same mid-flight version-bump technique as before.
  {
    let bump = () => {};
    const app = await bareApp(t, { generationOptions: { download: async (_url, file) => { await bump(); await writeFile(file, GEN_BYTES); return { bytes: GEN_BYTES.length, contentType: 'image/png' }; } } });
    const p = await app.project(graph);
    bump = async () => { const ep = await p.current(); await app.api(`/api/episodes/${p.episode.id}`, 'PUT', { ...ep, title: 'Edited mid-flight', expectedVersion: ep.version }); };
    const ep1 = await p.current();
    const quoteResponse = await app.request(`/api/workflows/${p.workflow.id}/quote`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'generate'], startStage: 'script', disclosure });
    assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
    const quoted = await quoteResponse.json();
    const response = await app.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'generate'], startStage: 'script', allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
    assert.equal(response.status, 202, await response.clone().text());
    const run1 = await app.waitRun((await response.json()).id);
    assert.equal(run1.status, 'failed', JSON.stringify(run1));
    const jobId = record(run1, 'generate').output.generationJobId;
    const job1 = await app.api(`/api/generations/${jobId}`);
    assert.equal(job1.status, 'completed');
    assert.equal(job1.applied, false, 'precondition: completed but never applied');
    // NOTE: unlike the other 3 states, this one is NOT chained into a further
    // forceInvalidatingRerun()+assertUnresolvedBlocksUnderAll() check. The mid-flight
    // version bump needed to force applied:false is a REAL, permanent episode mutation:
    // run1.episodeVersion (captured once, at the end of execute(), from a stale local
    // closure) now permanently differs from the live episode version. By stageSelection's
    // own correct, existing invariant (findResumeSource/compatibleProvenance require an
    // EXACT version match), run1 can never again be `source` for ANY future plan in this
    // project -- so there is no way to construct "job1 unresolved AND still the detectable
    // prior job of a later invalidating plan" for this specific state without a job-history
    // lookup that works even when source is null, which is a materially different, deeper
    // question than what this test (or Main's literal PK/R6 spec) asks for. The precondition
    // above (completed, applied:false) is the full, honest scope of what this state proves here.
  }

  // (c) failed/canceled prior job, mode:'all': definitively terminal, not "unresolved" --
  // fresh generation allowed.
  {
    let creates = 0;
    const app = await bareApp(t, { create: async () => { creates++; return creates === 1 ? { requestId: 'fixture-failed-1', status: 'failed', outputs: [] } : { requestId: `fixture-retry-${creates}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture-retry.png', type: 'image' }] }; } });
    const { p, run1 } = await setup(app);
    assert.equal(run1.status, 'failed', JSON.stringify(run1));
    const job1Id = record(run1, 'generate').output.generationJobId;
    assert.equal((await app.api(`/api/generations/${job1Id}`)).status, 'failed');

    const run2a = await forceInvalidatingRerun(app, p);

    const ep = await p.current();
    const planResponse = await app.request(`/api/workflows/${p.workflow.id}/plan`, 'POST', { episodeId: p.episode.id, execution: { mode: 'all', refresh: false }, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep.version });
    const plan = await planResponse.json();
    assert.notEqual(plan.blocked && plan.blocked.code, 'generation_unresolved', JSON.stringify(plan));
    assert.equal(plan.blocked, false, JSON.stringify(plan));
    assert.ok(plan.selectedStages.includes('generate'));
    assert.equal(plan.resumeRunId, run2a.id);

    const quoteResponse = await app.request(`/api/workflows/${p.workflow.id}/quote`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep.version, execution: { mode: 'all', refresh: false }, disclosure });
    assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
    const quoted = await quoteResponse.json();
    const runResponse = await app.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep.version, execution: { mode: 'all', refresh: false }, allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
    assert.equal(runResponse.status, 202, await runResponse.clone().text());
    const run2 = await app.waitRun((await runResponse.json()).id);
    assert.equal(run2.status, 'completed', JSON.stringify(run2));
    assert.equal(record(run2, 'generate').status, 'completed');
    assert.notEqual(record(run2, 'generate').output.generationJobId, job1Id, 'a genuinely new job for the retried generation');
  }
});

test('PK-hop (R6) an unresolved job keeps blocking across a further script-only rerun, and clears once the job itself is genuinely settled', async (t) => {
  const UNRESOLVED_MESSAGE = '이전 생성 요청이 아직 끝나지 않았거나 결과가 적용되지 않았습니다. 기존 요청을 복구하거나 적용한 뒤 다시 실행하세요.';
  const graph = {
    name: 'PK-hop fixture',
    nodes: [node('script', 'script', { agent: 'existing' }), node('board', 'storyboard'), node('generate', 'generate', { model: 'fixture_image', prompt: 'Fixture', sceneIndex: 0 }), node('render', 'render')],
    edges: [{ id: 'e1', source: 'script', target: 'board' }, { id: 'e2', source: 'board', target: 'generate' }, { id: 'e3', source: 'generate', target: 'render' }],
  };
  // manual_recovery: the only one of the constructible states with a real, available
  // settle path (recover() requires a providerRequestId, which submission_unknown never has).
  let settleStatus = async () => { throw new Error('Fixture: status should not be polled before recovery'); };
  let creates = 0;
  const app = await bareApp(t, {
    create: async () => { creates++; return creates === 1 ? { requestId: 'fixture-manual-1', status: 'weird_unsupported_state', outputs: [] } : { requestId: `fixture-settled-${creates}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture-new.png', type: 'image' }] }; },
    status: async (...args) => settleStatus(...args),
  });
  const p = await app.project(graph);
  const ep1 = await p.current();
  const quoteResponse = await app.request(`/api/workflows/${p.workflow.id}/quote`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'generate'], startStage: 'script', disclosure });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quoted = await quoteResponse.json();
  const response = await app.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'board', 'generate'], startStage: 'script', allowGeneration: true, disclosure, generationPlanId: quoted.id, generationFingerprint: quoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(response.status, 202, await response.clone().text());
  const run1 = await app.waitRun((await response.json()).id);
  assert.equal(run1.status, 'failed', JSON.stringify(run1));
  const jobId = record(run1, 'generate').output.generationJobId;
  assert.equal((await app.api(`/api/generations/${jobId}`)).status, 'manual_recovery');
  const submitsAfterRun1 = app.submits();

  // run2: mode:'node' target:'script' -- a DIRECT retarget of 'script' is allowed (script
  // itself carries no unresolved generation job); generate is recorded skipped/invalidated.
  const ep2 = await p.current();
  const planResponse = await app.request(`/api/workflows/${p.workflow.id}/plan`, 'POST', { episodeId: p.episode.id, execution: { mode: 'node', targetNodeId: 'script' }, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep2.version });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  const run2Response = await app.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, execution: { mode: 'node', targetNodeId: 'script' }, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep2.version });
  assert.equal(run2Response.status, 202, await run2Response.clone().text());
  const run2 = await app.waitRun((await run2Response.json()).id);
  assert.equal(run2.status, 'completed', JSON.stringify(run2));
  assert.equal(record(run2, 'generate').status, 'skipped');

  // From run2's lineage, mode:'all' must STILL be generation_unresolved -- the unresolved
  // job for this node/episode has not gone away just because an unrelated ancestor reran.
  const ep3 = await p.current();
  const stillBlockedResponse = await app.request(`/api/workflows/${p.workflow.id}/plan`, 'POST', { episodeId: p.episode.id, execution: { mode: 'all', refresh: false }, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: ep3.version });
  assert.equal(stillBlockedResponse.status, 200, await stillBlockedResponse.clone().text());
  const stillBlocked = await stillBlockedResponse.json();
  assert.equal(stillBlocked.blocked && stillBlocked.blocked.code, 'generation_unresolved', JSON.stringify(stillBlocked));
  assert.equal(stillBlocked.blocked.message, UNRESOLVED_MESSAGE);
  assert.equal(app.submits(), submitsAfterRun1, 'still zero new submissions after the script-only rerun');

  // Settle job1 for real through the actual recovery surface: recover() re-polls (now
  // resolving 'completed' via the status override), then apply() commits it.
  settleStatus = async () => ({ requestId: 'fixture-manual-1', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture-settled.png', type: 'image' }] });
  const recoverResponse = await app.request(`/api/generations/${jobId}/recover`, 'POST', {});
  assert.equal(recoverResponse.status, 202, await recoverResponse.clone().text());
  let settledJob;
  for (let turn = 0; turn < 2000; turn++) {
    settledJob = await app.api(`/api/generations/${jobId}`);
    if (settledJob.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(settledJob.status, 'completed', JSON.stringify(settledJob));
  const epForApply = await p.current();
  const applyResponse = await app.request(`/api/generations/${jobId}/apply`, 'POST', { expectedVersion: epForApply.version, sceneId: epForApply.scenes[0].id });
  assert.equal(applyResponse.status, 200, await applyResponse.clone().text());
  const appliedJob = await applyResponse.json();
  assert.equal(appliedJob.job.applied, true, JSON.stringify(appliedJob));

  // Now a later mode:'all' plan is allowed, and executing it submits exactly one new job
  // (the settled job1 is now a resolved terminal state, not reused/inherited by a fresh
  // paid generate node -- it already lived its lifecycle under the old, now-severed lineage).
  const epFinal = await p.current();
  const finalPlanResponse = await app.request(`/api/workflows/${p.workflow.id}/plan`, 'POST', { episodeId: p.episode.id, execution: { mode: 'all', refresh: false }, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: epFinal.version });
  assert.equal(finalPlanResponse.status, 200, await finalPlanResponse.clone().text());
  const finalPlan = await finalPlanResponse.json();
  assert.notEqual(finalPlan.blocked && finalPlan.blocked.code, 'generation_unresolved', JSON.stringify(finalPlan));
  assert.equal(finalPlan.blocked, false, JSON.stringify(finalPlan));

  const finalQuoteResponse = await app.request(`/api/workflows/${p.workflow.id}/quote`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: epFinal.version, execution: { mode: 'all', refresh: false }, disclosure });
  assert.equal(finalQuoteResponse.status, 200, await finalQuoteResponse.clone().text());
  const finalQuoted = await finalQuoteResponse.json();
  const finalRunResponse = await app.request(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedWorkflowVersion: p.workflow.version, expectedEpisodeVersion: epFinal.version, execution: { mode: 'all', refresh: false }, allowGeneration: true, disclosure, generationPlanId: finalQuoted.id, generationFingerprint: finalQuoted.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(finalRunResponse.status, 202, await finalRunResponse.clone().text());
  const run3 = await app.waitRun((await finalRunResponse.json()).id);
  assert.equal(run3.status, 'completed', JSON.stringify(run3));
  assert.equal(record(run3, 'generate').status, 'completed');
  assert.equal(app.submits(), submitsAfterRun1 + 1, 'exactly one new submission once the old unresolved job is genuinely settled');
});

test('PO an incidentally reused approved review from a sibling render must never approve a fresh unreviewed render, while the connected review stays the true publish gate', async (t) => {
  // Reproduces the real-app journey regression: a sequential script->storyboard->render-1->
  // review-1->render-2->review-2->publish chain. Targeting render-2 alone walks past render-1/
  // review-1 through stageSelection's GENERIC edge-parent loop -- review-1 is genuinely
  // reusable evidence for this resumed lineage (it IS correctly reused, carrying its real
  // decided approval forward), but render-2's own scene input is 'storyboard', reached by
  // skipping past render-1/review-1 entirely (nearestUpstreamOfType's documented pruning in
  // graph.mjs). review-1 approving render-1 must never make the RUN LEVEL status read as
  // reviewed when the run's only new artifact, render-2, has no review of its own.
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-plan-siblingreview-'));
  const forbidden = async () => { throw new Error('Unexpected external/paid operation in a plan fixture'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({}), fetchTrends: forbidden, runAgent: forbidden },
    generation: { capability: async () => ({ available: true }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, status: forbidden },
    generationOptions: { download: forbidden, probe: forbidden },
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

  // Exact graph shape of the real app's "Sequential reviewed producers" journey scenario.
  const types = ['script', 'storyboard', 'render', 'review', 'render', 'review', 'publish'];
  const ids = ['script', 'storyboard', 'render-1', 'review-1', 'render-2', 'review-2', 'publish'];
  const graph = {
    name: 'Sequential reviewed producers (sibling-review regression)',
    nodes: types.map((type, i) => node(ids[i], type, type === 'script' ? { agent: 'existing' } : {})),
    edges: ids.slice(1).map((target, i) => ({ id: `seq-${i}`, source: ids[i], target })),
  };
  const channel = await api('/api/channels', 'POST', { name: 'Sibling review owner', category: 'information', platform: 'YouTube' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Sibling review project', topic: 'Fixture topic' });
  const template = await api('/api/workflows', 'POST', graph);
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const current = async () => (await api('/api/state')).episodes.find((item) => item.id === episode.id);

  // run1: script through review-1. review-1 is decided -- a REAL human approval, but for
  // render-1's branch only.
  const ep1 = await current();
  const run1Response = await request(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: ep1.version, selectedStages: ['script', 'storyboard', 'render-1', 'review-1'], startStage: 'script' });
  assert.equal(run1Response.status, 202, await run1Response.clone().text());
  const run1 = await waitRun((await run1Response.json()).id);
  assert.equal(run1.status, 'awaiting_review', JSON.stringify(run1));
  const render1Output = record(run1, 'render-1').output;

  const approved1 = await api(`/api/workflows/${workflow.id}/runs/${run1.id}/review`, 'POST', { reviewNodeId: 'review-1', decision: 'approved', notes: 'First exact artifact', expectedEpisodeVersion: run1.episodeVersion });
  assert.equal(approved1.status, 'approved', JSON.stringify(approved1));
  assert.equal(approved1.reviews['review-1'].jobId, render1Output.jobId);

  // /plan targeting render-2 alone (the real UI's exact request shape): review-1 sits on an
  // edge-parent path to render-2 but is never render-2's actual scene input, so only render-2
  // is ever selected to run; review-1 stays genuinely reusable (action 'reuse'), not re-run.
  const epForPlan = await current();
  const planResponse = await request(`/api/workflows/${workflow.id}/plan`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'render-2' }, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: epForPlan.version });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const plan = await planResponse.json();
  assert.equal(plan.blocked, false, JSON.stringify(plan));
  assert.deepEqual(plan.selectedStages, ['render-2']);
  assert.equal(plan.resumeRunId, run1.id);
  assert.equal(nodeAction(plan, 'render-2'), 'run');
  assert.equal(nodeAction(plan, 'review-1'), 'reuse', 'review-1 is genuinely reusable evidence for this resumed lineage, not blocked and not re-run');

  // /run with the identical execution: the server-derived selection the UI actually submits
  // must select exactly what /plan predicted.
  const run2Response = await request(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'render-2' }, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: epForPlan.version });
  assert.equal(run2Response.status, 202, await run2Response.clone().text());
  const run2 = await waitRun((await run2Response.json()).id);
  assert.deepEqual(run2.selectedStages, plan.selectedStages, 'planner and actual execution must agree about which nodes participate');
  assert.equal(run2.resumedFrom, run1.id);

  // THE REGRESSION: render-2 is a genuinely fresh, never-reviewed artifact. review-1's
  // approval belongs to render-1's branch only and must not make this run read as reviewed.
  assert.equal(run2.status, 'completed', JSON.stringify(run2), 'render-2 has no review of its own; review-1 is an incidental sibling-branch approval, not a publication prerequisite for this run');
  assert.equal(run2.reviews, undefined, 'no human review decision was ever made in this run');

  const render2Record = record(run2, 'render-2');
  assert.equal(render2Record.status, 'completed');
  assert.equal(render2Record.reused, undefined, 'render-2 is a fresh artifact, not reused from render-1');
  assert.notEqual(render2Record.output.jobId, render1Output.jobId, 'render-2 is a genuinely distinct render job');

  // review-1's reuse/lineage itself must stay exactly as it always has been: genuinely
  // reused, carrying its real decided approval -- excluding it from the run-level aggregate
  // must not corrupt that data.
  const review1Record = record(run2, 'review-1');
  assert.equal(review1Record.reused, true);
  assert.equal(review1Record.status, 'approved');
  assert.equal(review1Record.output.review.decision, 'approved');
  assert.equal(review1Record.output.review.jobId, render1Output.jobId);

  // review-2 -- render-2's actual nearest review -- was never selected in this narrower run.
  const review2Record = record(run2, 'review-2');
  assert.equal(review2Record.status, 'skipped');
  assert.equal(review2Record.reused, undefined);

  // Publish stays blocked: review-1's real approval of a DIFFERENT render must never satisfy
  // render-2's own publish prerequisite.
  const epBeforeBlocked = await current();
  const blockedPublishResponse = await request(`/api/workflows/${workflow.id}/plan`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'publish' }, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: epBeforeBlocked.version });
  assert.equal(blockedPublishResponse.status, 200, await blockedPublishResponse.clone().text());
  const blockedPublish = await blockedPublishResponse.json();
  assert.deepEqual(blockedPublish.blocked, { code: 'publish_requires_review', message: '게시는 같은 결과에 대한 승인된 검토가 있어야 실행할 수 있습니다.' });

  // Decide render-2's OWN nearest review (review-2) -- the real publication prerequisite.
  const epForReview2Run = await current();
  const reviewRunResponse = await request(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'review-2' }, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: epForReview2Run.version });
  assert.equal(reviewRunResponse.status, 202, await reviewRunResponse.clone().text());
  const reviewRun = await waitRun((await reviewRunResponse.json()).id);
  assert.equal(reviewRun.status, 'awaiting_review', JSON.stringify(reviewRun));
  assert.equal(reviewRun.resumedFrom, run2.id, 'review-2 must resume from the run holding render-2 real completed output, not run1');
  const render2InReviewRun = record(reviewRun, 'render-2').output;
  assert.equal(render2InReviewRun.jobId, render2Record.output.jobId);

  const approved2 = await api(`/api/workflows/${workflow.id}/runs/${reviewRun.id}/review`, 'POST', { reviewNodeId: 'review-2', decision: 'approved', notes: 'Second exact artifact', expectedEpisodeVersion: reviewRun.episodeVersion });
  assert.equal(approved2.status, 'approved', JSON.stringify(approved2));
  assert.equal(approved2.reviews['review-2'].jobId, render2Record.output.jobId);
  assert.equal(approved2.reviews['review-1'], undefined, 'review-1 approval belongs to a different run lineage and must never appear here');

  // Now publish for render-2's branch is genuinely eligible -- gated on review-2, the exact
  // connected review, never on review-1's unrelated sibling approval.
  const epAfterApproval = await current();
  const allowedPublishResponse = await request(`/api/workflows/${workflow.id}/plan`, 'POST', { episodeId: episode.id, execution: { mode: 'node', targetNodeId: 'publish' }, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: epAfterApproval.version });
  assert.equal(allowedPublishResponse.status, 200, await allowedPublishResponse.clone().text());
  const allowedPublish = await allowedPublishResponse.json();
  assert.equal(allowedPublish.blocked, false, JSON.stringify(allowedPublish));
  assert.deepEqual(allowedPublish.selectedStages, ['publish']);
  assert.equal(allowedPublish.resumeRunId, reviewRun.id);
  assert.equal(nodeAction(allowedPublish, 'publish'), 'run');
});
