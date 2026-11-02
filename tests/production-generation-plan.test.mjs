// RED-first contract tests for the PW-04 whole-candidate generation plan seam
// (.mex/context/decisions.md "Production-workspace interview", criteria PW-04, and the
// "Repeated-node implementation contract"; artifacts/production-workspace-implementation/plan.json
// "graph"/"engineAPI" sections, frozen 2026-10-25).
//
// Exercises ONLY:
//   - candidateManifest(store, episode, workflow, options) from server/candidates.mjs (new; EngineImplementation)
//   - verifyCandidateAssets(store, manifest) from server/candidates.mjs (new; EngineImplementation)
//   - WorkflowEngine.quote(workflowId, episodeId, options) from server/workflows.mjs (new method)
//   - WorkflowEngine.start(..., {generationPlanId, generationFingerprint, acceptUnquotedEstimate, disclosure})
//     (extension of the existing start() method)
// Does not test server/graph.mjs directly (owned by tests/production-workflow-graph.test.mjs) and makes
// no production code changes.
//
// This file is the FIRST red-test author for candidates.mjs, which does not exist yet. plan.json
// documents these exports in prose rather than an exact field schema, so the shapes below are this
// test's concrete proposal for the contract. Trued up by IRC before writing assertions:
//   - EngineImplementation confirmed (no objection) the quote()/start() field names below.
//   - MediaImplementation confirmed the scene/slot source shape is a NESTED optional object
//       `source: {origin:'own'|'third-party'|'generated', sourceUrl?, licenseId?, attribution?,
//       retrievedAt?, sha256?, useAs:'evidence'|'illustration', generationJobId?}` on the scene AND
//       independently on each slot (NOT flat fields on the scene, correcting this file's first draft),
//       with third-party clearance additionally recorded as a separate `mediaRights` store entity
//       `{id,uploadId,sha256,origin,sourceUrl?,licenseId?,attribution?,generationJobId?,retrievedAt?,
//       acknowledgedAt,createdAt,updatedAt}` keyed by uploadId AND bound to sha256 so a replaced file
//       under the same upload id can never silently inherit stale clearance.
// Documented remaining assumptions (not yet confirmed by an implementer; this file is the proposal):
//   - candidateManifest(...) returns { workflowId, episodeId, workflowVersion, episodeVersion,
//       disclosure, nodes: [{nodeId,type:'generate',sceneId,model,prompt}], scenes: [{sceneId,
//       assetUrl,source,trimStart,trimEnd,slots:[{slotId,assetUrl,source}]}] } for exactly the
//       SELECTED generate nodes and the scenes they target.
//   - WorkflowEngine.quote(...) is async (it must call the provider's cost estimate) and returns a
//       PERSISTED plan: { id, workflowId, episodeId, workflowVersion, episodeVersion, fingerprint,
//       candidate, nodes:[{nodeId,sceneId,model,quoted,cost}], aggregate:{quoted,totalCost}, expiresAt,
//       disclosure }, where fingerprint === candidateFingerprint(candidate) from server/graph.mjs
//       (asserted directly against that real, already-implemented export below).
//   - WorkflowEngine.start(...) requires, whenever selectedStages include a generate node:
//       generationPlanId referencing a quote for this exact workflow/episode, generationFingerprint
//       matching that plan's fingerprint (else 409 stale), and either plan.aggregate.quoted===true or
//       acceptUnquotedEstimate===true (else 400) -- all BEFORE any provider.create call. A generation-
//       bearing quote/start without an explicit `disclosure` decision is rejected (400).
//   - Targeting a generate node at a specific scene by stable ID (not array position) uses a NEW
//       generate-node config field `sceneId` (existing schema only has reorder-unsafe `sceneIndex`).
//   - Costs are read entirely from this file's own injected provider.estimate() fixture; no real-world
//       price is assumed anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { WorkflowEngine } from '../server/workflows.mjs';
import { GenerationQueue } from '../server/generations.mjs';
import { candidateFingerprint } from '../server/graph.mjs';
import { candidateManifest, verifyCandidateAssets } from '../server/candidates.mjs';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-generation-plan-'));
  const store = new Store(dataDir);
  const calls = { create: 0, status: 0, estimate: 0, prompts: [] };
  const estimates = options.estimates || {};
  const provider = {
    transport: 'api',
    modelSchema: async (model) => ({ id: model, type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    ...(options.noEstimate ? {} : {
      estimate: async ({ model }) => {
        calls.estimate++;
        if (!(model in estimates)) throw new Error('No fixture estimate configured for this model');
        return { cost: estimates[model], currency: 'USD' };
      },
    }),
    create: async ({ model, prompt }) => {
      calls.create++;
      calls.prompts.push(prompt);
      if (options.createByModel?.[model]) return options.createByModel[model]();
      return { requestId: `req-${model}-${calls.create}`, status: 'completed', outputs: [{ url: `https://images.higgs.ai/${model}.png`, type: 'image' }] };
    },
    status: async (requestId) => {
      calls.status++;
      if (options.statusByRequest?.[requestId]) return options.statusByRequest[requestId]();
      return { requestId, status: 'completed', outputs: [{ url: `https://images.higgs.ai/${requestId}.png`, type: 'image' }] };
    },
  };
  const queue = new GenerationQueue({
    store,
    provider,
    pollIntervalMs: options.pollIntervalMs ?? 2,
    maxPollFailures: options.maxPollFailures ?? 2,
    download: async (_url, file) => { await writeFile(file, 'fixture-generated-bytes'); return { bytes: 23, contentType: 'image/png' }; },
    probe: async () => ({ kind: 'image', width: 64, height: 64 }),
  });
  let renderCount = 0;
  const renderInputs = [];
  const workflows = new WorkflowEngine({
    store,
    fetchTrends: options.fetchTrends || (async () => ({ trends: [], sources: [] })),
    runAgent: async () => { throw new Error('No provider configured in this fixture'); },
    render: async (episode) => {
      renderCount++;
      renderInputs.push(structuredClone(episode));
      const filename = `plan-fixture-${renderCount}.mp4`;
      const verifiedSceneAssets = [];
      for (const scene of episode.scenes) {
        const references = [
          ...(scene.assetUrl ? [{ sceneId: scene.id, use: 'asset', assetUrl: scene.assetUrl }] : []),
          ...(scene.audioUrl ? [{ sceneId: scene.id, use: 'audio', assetUrl: scene.audioUrl }] : []),
          ...(scene.slots || []).filter(slot => slot.assetUrl).map(slot => ({ sceneId: scene.id, slotId: slot.id, use: 'asset', assetUrl: slot.assetUrl })),
        ];
        for (const reference of references) {
          const upload = store.list('uploads').find(item => item.url === reference.assetUrl);
          assert.ok(upload, 'the fixture renderer must receipt registered local media');
          const bytes = await readFile(path.join(dataDir, 'uploads', upload.filename));
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          assert.equal(sha256, upload.sha256, 'fixture render receipt must match bytes actually read');
          assert.equal(bytes.length, upload.size, 'fixture render receipt must match the registered byte count');
          verifiedSceneAssets.push({ ...reference, sha256, size: bytes.length });
        }
      }
      await mkdir(path.join(dataDir, 'exports'), { recursive: true });
      await writeFile(path.join(dataDir, 'exports', filename), 'fixture render bytes');
      return { filename, outputUrl: `/api/exports/${filename}`, jobId: `render-job-${renderCount}`, episodeVersion: episode.version, sha256: createHash('sha256').update('fixture render bytes').digest('hex'), verifiedSceneAssets };
    },
    validateAssets: (sceneList) => sceneList,
    generations: queue,
  });
  const channel = store.list('channels')[0];
  t.after(async () => {
    workflows.close();
    queue.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const waitRun = async (id, statuses = ['awaiting_review', 'completed', 'failed']) => {
    for (let i = 0; i < 400; i++) {
      const run = store.get('workflowRuns', id);
      if (statuses.includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Workflow run did not reach an expected terminal state in time');
  };
  return { dataDir, store, queue, workflows, channel, calls, waitRun, renderInputs, get renderCount() { return renderCount; } };
}

/** Writes real bytes under <dataDir>/uploads and registers a matching store upload entity, so asset
 * hash/verification tests operate on genuine local files rather than fabricated metadata. */
async function realUpload(dataDir, store, bytes, { ext = 'png', type = 'image/png' } = {}) {
  const uploadsDir = path.join(dataDir, 'uploads');
  await mkdir(uploadsDir, { recursive: true });
  const id = randomUUID();
  const filename = `${id}.${ext}`;
  await writeFile(path.join(uploadsDir, filename), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const upload = { id, filename, url: `/api/uploads/${filename}`, name: filename, type, size: bytes.length, kind: 'image', width: 64, height: 64, sha256, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.save('uploads', upload);
  return upload;
}

function basicScene(id, overrides = {}) {
  return { id, title: id, text: '', duration: 4, background: '#101010', kind: 'title', layout: 'center', trimStart: 0, audioVolume: 1, narration: '', ...overrides };
}

function twoImageSlotsScene(id = 'scene-a') {
  return basicScene(id, { slots: [
    { id: 'slot-a', name: 'Slot A', role: 'image-gen', x: 0, y: 0, w: 50, h: 100, zIndex: 1, prompt: 'Generate slot A' },
    { id: 'slot-b', name: 'Slot B', role: 'image-gen', x: 50, y: 0, w: 50, h: 100, zIndex: 2, prompt: 'Generate slot B' },
  ] });
}

/** The smallest graph exercising a single generate node, with no optional trend/news ancestor. */
function initialGraph({ sceneIndex = 0, model = 'fixture-model', prompt = 'A fixture prompt' } = {}) {
  return {
    name: 'Minimal generation consent graph',
    nodes: [
      { id: 'script', type: 'script', x: 0, y: 0, config: { agent: 'existing' } },
      { id: 'storyboard', type: 'storyboard', x: 100, y: 0, config: {} },
      { id: 'generate', type: 'generate', x: 200, y: 0, config: { model, prompt, sceneIndex } },
      { id: 'render', type: 'render', x: 300, y: 0, config: {} },
      { id: 'review', type: 'review', x: 400, y: 0, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'script', target: 'storyboard' },
      { id: 'e2', source: 'storyboard', target: 'generate' },
      { id: 'e3', source: 'generate', target: 'render' },
      { id: 'e4', source: 'render', target: 'review' },
    ],
  };
}

/** The full default ten-stage pipeline (trend through publish), each type exactly once. */
function fullPipelineGraph() {
  const order = ['trend', 'news', 'research', 'script', 'storyboard', 'layout', 'generate', 'render', 'review', 'publish'];
  const nodes = order.map((type, index) => ({
    id: type, type, x: 80 + index * 120, y: 200,
    config: type === 'script' ? { agent: 'existing' }
      : type === 'news' ? { source: 'trend_news', maxArticles: 3 }
      : type === 'generate' ? { model: 'fixture-model', prompt: '', sceneIndex: 0 }
      : type === 'publish' ? { platform: 'youtube', visibility: 'private' }
      : {},
  }));
  return { name: '엔드투엔드 제작·업로드 파이프라인 (fixture)', nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index + 1}`, source: nodes[index].id, target: node.id })) };
}

function sceneIdTargetingGraph(targetSceneId) {
  return {
    name: 'Scene-ID targeted generation',
    nodes: [
      { id: 'script', type: 'script', x: 0, y: 0, config: { agent: 'existing' } },
      { id: 'storyboard', type: 'storyboard', x: 100, y: 0, config: {} },
      { id: 'generate', type: 'generate', x: 200, y: 0, config: { model: 'fixture-model', prompt: 'Targeted prompt', sceneId: targetSceneId } },
      { id: 'render', type: 'render', x: 300, y: 0, config: {} },
      { id: 'review', type: 'review', x: 400, y: 0, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'script', target: 'storyboard' },
      { id: 'e2', source: 'storyboard', target: 'generate' },
      { id: 'e3', source: 'generate', target: 'render' },
      { id: 'e4', source: 'render', target: 'review' },
    ],
  };
}

function parallelGenerateGraph({ sceneIndexes = [0, 1], slotIds = [null, null] } = {}) {
  const targetConfig = (index) => ({
    model: index === 0 ? 'model-a' : 'model-b',
    prompt: index === 0 ? 'Branch 1' : 'Branch 2',
    sceneIndex: sceneIndexes[index],
    ...(slotIds[index] ? { slotId: slotIds[index], targetMode: 'slot' } : {}),
  });
  return {
    name: 'Two independent generate branches',
    nodes: [
      { id: 'script', type: 'script', x: 0, y: 0, config: { agent: 'existing' } },
      { id: 'storyboard', type: 'storyboard', x: 100, y: 0, config: {} },
      { id: 'generate-1', type: 'generate', x: 200, y: -80, config: targetConfig(0) },
      { id: 'render-1', type: 'render', x: 300, y: -80, config: {} },
      { id: 'review-1', type: 'review', x: 400, y: -80, config: {} },
      { id: 'generate-2', type: 'generate', x: 200, y: 80, config: targetConfig(1) },
      { id: 'render-2', type: 'render', x: 300, y: 80, config: {} },
      { id: 'review-2', type: 'review', x: 400, y: 80, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'script', target: 'storyboard' },
      { id: 'e2', source: 'storyboard', target: 'generate-1' },
      { id: 'e3', source: 'generate-1', target: 'render-1' },
      { id: 'e4', source: 'render-1', target: 'review-1' },
      { id: 'e5', source: 'storyboard', target: 'generate-2' },
      { id: 'e6', source: 'generate-2', target: 'render-2' },
      { id: 'e7', source: 'render-2', target: 'review-2' },
    ],
  };
}

const disclosure = { containsSyntheticMedia: true, rationale: 'AI-generated fixture visual' };

// --- A1: smallest RED. A generation request with no prior exact-input quote must be rejected
// --- before ANY provider request, not merely before the run is marked complete.
test('starting generation without a prior exact-input quote is rejected before any provider request', async (t) => {
  const f = await fixture(t, { estimates: { 'fixture-model': 4.2 } });
  const episode = f.store.create('episodes', {
    channelId: f.channel.id, title: 'No-quote generation attempt', topic: 'Consent gating', category: 'information', status: 'draft', format: '9:16', version: 1,
    scenes: [basicScene('scene-1')], notes: '',
  });
  const workflow = ownedWorkflow(f, episode, initialGraph());

  assert.throws(
    () => f.workflows.start(workflow.id, episode.id, { allowGeneration: true, selectedStages: ['script', 'storyboard', 'generate', 'render', 'review'] }),
    (error) => error.status === 400 || error.status === 409,
    'start() must reject paid generation without a persisted exact-input quote (missing generationPlanId)',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.create, 0, 'no provider request may be made before whole-candidate consent is proven');
  assert.equal(f.calls.estimate, 0, 'rejecting an unquoted start must not itself trigger a new provider estimate');
});

// --- A2: candidateManifest/quote must aggregate EXACTLY the selected generate nodes and the scenes
// --- they target, excluding any unselected generate node and any untargeted scene; and quoting a
// --- generation-bearing selection without an explicit disclosure decision must be rejected.
test('candidateManifest and quote() select exactly the chosen generate nodes/scenes and require an explicit disclosure decision', async (t) => {
  const f = await fixture(t, { estimates: { 'model-a': 3.5, 'model-b': 1.25 } });
  const episode = f.store.create('episodes', {
    channelId: f.channel.id, title: 'Selection filtering', topic: 'Candidate aggregation', category: 'information', status: 'draft', format: '9:16', version: 1,
    scenes: [basicScene('scene-a'), basicScene('scene-b'), basicScene('scene-c')], notes: '',
  });
  const workflow = ownedWorkflow(f, episode, {
    name: 'Two generate nodes, one unselected',
    nodes: [
      { id: 'script', type: 'script', x: 0, y: 0, config: { agent: 'existing' } },
      { id: 'storyboard', type: 'storyboard', x: 100, y: 0, config: {} },
      { id: 'generate-a', type: 'generate', x: 200, y: -60, config: { model: 'model-a', prompt: 'Prompt A', sceneIndex: 0 } },
      { id: 'generate-b', type: 'generate', x: 200, y: 60, config: { model: 'model-b', prompt: 'Prompt B', sceneIndex: 1 } },
      { id: 'render', type: 'render', x: 300, y: 0, config: {} },
      { id: 'review', type: 'review', x: 400, y: 0, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'script', target: 'storyboard' },
      { id: 'e2', source: 'storyboard', target: 'generate-a' },
      { id: 'e3', source: 'storyboard', target: 'generate-b' },
      { id: 'e4', source: 'generate-a', target: 'render' },
      { id: 'e5', source: 'generate-b', target: 'render' },
      { id: 'e6', source: 'render', target: 'review' },
    ],
  });
  const selectedStages = ['script', 'storyboard', 'generate-a', 'render', 'review'];

  const manifest = candidateManifest(f.store, episode, workflow, { selectedStages });
  assert.equal(manifest.nodes.length, 1, 'only the selected generate node may appear in the candidate, even though the graph defines two');
  assert.equal(manifest.nodes[0].nodeId, 'generate-a');
  assert.equal(manifest.nodes[0].sceneId, 'scene-a');
  assert.equal(manifest.scenes.length, 1, 'only the scene targeted by a SELECTED generate node is part of the candidate, not every episode scene');
  assert.equal(manifest.scenes[0].sceneId, 'scene-a');

  await assert.rejects(
    f.workflows.quote(workflow.id, episode.id, { selectedStages }),
    (error) => error.status === 400,
    'quoting a generation-bearing selection without an explicit disclosure decision must be rejected',
  );
  assert.equal(f.calls.estimate, 0, 'a rejected disclosure-less quote must not itself spend an estimate call');

  const plan = await f.workflows.quote(workflow.id, episode.id, { selectedStages, disclosure });
  const planGenerateNodes = plan.nodes.filter((node) => node.nodeId === 'generate-a' || node.nodeId === 'generate-b');
  assert.equal(planGenerateNodes.length, 1, 'the persisted plan must only cost the selected generate node, not every generate node in the graph');
  assert.equal(planGenerateNodes[0].nodeId, 'generate-a');
  assert.equal(planGenerateNodes[0].cost, 3.5, 'the persisted per-node cost must be the exact fixture-provided estimate, not an assumed price');
  assert.equal(plan.aggregate.totalCost, 3.5, 'the aggregate total must be the real sum over only the selected nodes');
});

// --- A3: editing the episode after quoting must invalidate the plan's fingerprint; start() must
// --- reject the stale plan (409, zero provider calls) while a fresh quote against the new version
// --- is accepted and actually allowed to spend.
test('editing the episode after quoting invalidates the generation plan; only a fresh quote against the new version is accepted', async (t) => {
  const f = await fixture(t, { estimates: { 'fixture-model': 2 } });
  const episode = f.store.create('episodes', {
    channelId: f.channel.id, title: 'Invalidation test', topic: 'Stale quotes', category: 'information', status: 'draft', format: '9:16', version: 1,
    scenes: [basicScene('scene-1')], notes: '',
  });
  const workflow = ownedWorkflow(f, episode, initialGraph());
  const selectedStages = ['script', 'storyboard', 'generate', 'render', 'review'];

  const stalePlan = await f.workflows.quote(workflow.id, episode.id, { selectedStages, disclosure });
  assert.equal(stalePlan.fingerprint, candidateFingerprint(stalePlan.candidate), 'the persisted fingerprint must be the REAL graph.mjs candidateFingerprint of the embedded candidate, not an independently invented hash');
  assert.equal(f.calls.estimate, 1);

  f.store.updateEpisode(episode.id, { title: 'Edited after quoting' }, episode.version);

  assert.throws(
    () => f.workflows.start(workflow.id, episode.id, { allowGeneration: true, selectedStages, generationPlanId: stalePlan.id, generationFingerprint: stalePlan.fingerprint, disclosure }),
    (error) => error.status === 409,
    'starting with a quote whose episode version has since changed must be rejected as stale',
  );
  assert.equal(f.calls.create, 0, 'a rejected stale plan must spend no provider request');

  const freshEpisode = f.store.get('episodes', episode.id);
  const freshPlan = await f.workflows.quote(workflow.id, episode.id, { selectedStages, expectedEpisodeVersion: freshEpisode.version, disclosure });
  assert.notEqual(freshPlan.fingerprint, stalePlan.fingerprint, 'a fingerprint bound to episode version must change once the episode changes');
  const run = f.workflows.start(workflow.id, episode.id, { allowGeneration: true, selectedStages, generationPlanId: freshPlan.id, generationFingerprint: freshPlan.fingerprint, disclosure });
  const completed = await f.waitRun(run.id);
  assert.equal(completed.status, 'awaiting_review');
  assert.equal(f.calls.create, 1, 'the fresh, matching plan must be allowed to actually spend exactly once');
});

// --- A4: a cost estimate that the provider cannot supply must leave the plan explicitly unquoted
// --- rather than a fabricated price; starting it requires an explicit acknowledgement, and that
// --- acknowledgement must actually unblock the run, not merely avoid throwing.
test('a quote with an unavailable cost estimate is marked unquoted; starting it requires explicit acceptUnquotedEstimate', async (t) => {
  const f = await fixture(t, { noEstimate: true });
  const episode = f.store.create('episodes', {
    channelId: f.channel.id, title: 'Unknown cost', topic: 'No-quote acknowledgement', category: 'information', status: 'draft', format: '9:16', version: 1,
    scenes: [basicScene('scene-1')], notes: '',
  });
  const workflow = ownedWorkflow(f, episode, initialGraph());
  const selectedStages = ['script', 'storyboard', 'generate', 'render', 'review'];

  const plan = await f.workflows.quote(workflow.id, episode.id, { selectedStages, disclosure });
  assert.equal(plan.aggregate.quoted, false, 'a node whose provider cost estimate is unavailable must leave the aggregate explicitly unquoted, never a fabricated price');
  assert.equal(plan.nodes.find((node) => node.nodeId === 'generate').quoted, false);

  assert.throws(
    () => f.workflows.start(workflow.id, episode.id, { allowGeneration: true, selectedStages, generationPlanId: plan.id, generationFingerprint: plan.fingerprint, disclosure }),
    (error) => error.status === 400,
    'an unquoted plan must require explicit acceptUnquotedEstimate before any paid call',
  );
  assert.equal(f.calls.create, 0);

  const run = f.workflows.start(workflow.id, episode.id, { allowGeneration: true, selectedStages, generationPlanId: plan.id, generationFingerprint: plan.fingerprint, acceptUnquotedEstimate: true, disclosure });
  const completed = await f.waitRun(run.id);
  assert.equal(completed.status, 'awaiting_review', 'explicit acknowledgement must actually unblock the run, not merely avoid throwing');
  assert.equal(f.calls.create, 1);
});

// --- A5: verifyCandidateAssets must re-hash real local files and gate on real rights clearance,
// --- not trust stored metadata or echo input unverified.
test('verifyCandidateAssets checks real on-disk asset hashes and blocks third-party assets with no matching rights clearance', async (t) => {
  const f = await fixture(t, { estimates: { 'fixture-model': 1 } });
  const selectedStages = ['script', 'storyboard', 'generate', 'render', 'review'];

  const ownBytes = Buffer.from('own-origin-fixture-bytes');
  const ownUpload = await realUpload(f.dataDir, f.store, ownBytes);
  const ownEpisode = f.store.create('episodes', {
    channelId: f.channel.id, title: 'Own asset', topic: 'Own', category: 'information', status: 'draft', format: '9:16', version: 1,
    scenes: [basicScene('scene-own', { kind: 'image', assetUrl: ownUpload.url, source: { origin: 'own', useAs: 'illustration' } })], notes: '',
  });
  const ownWorkflow = ownedWorkflow(f, ownEpisode, initialGraph());
  await assert.doesNotReject(
    verifyCandidateAssets(f.store, candidateManifest(f.store, ownEpisode, ownWorkflow, { selectedStages })),
    'a hash-matching own-origin asset needs no third-party clearance and must verify cleanly',
  );

  const clearedBytes = Buffer.from('cleared-third-party-fixture-bytes');
  const clearedUpload = await realUpload(f.dataDir, f.store, clearedBytes);
  f.store.create('mediaRights', { uploadId: clearedUpload.id, sha256: clearedUpload.sha256, origin: 'third-party', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture.png', licenseId: 'cc-by-sa-4.0', attribution: 'Fixture Author, CC BY-SA 4.0', retrievedAt: new Date().toISOString(), acknowledgedAt: new Date().toISOString() });
  const clearedEpisode = f.store.create('episodes', {
    channelId: f.channel.id, title: 'Cleared asset', topic: 'Cleared', category: 'information', status: 'draft', format: '9:16', version: 1,
    scenes: [basicScene('scene-cleared', { kind: 'image', assetUrl: clearedUpload.url, source: { origin: 'third-party', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture.png', licenseId: 'cc-by-sa-4.0', attribution: 'Fixture Author, CC BY-SA 4.0', useAs: 'evidence' } })], notes: '',
  });
  const clearedWorkflow = ownedWorkflow(f, clearedEpisode, initialGraph());
  await assert.doesNotReject(
    verifyCandidateAssets(f.store, candidateManifest(f.store, clearedEpisode, clearedWorkflow, { selectedStages })),
    'a hash-matching third-party asset with an explicit matching mediaRights record must verify cleanly',
  );

  const unclearedBytes = Buffer.from('uncleared-third-party-fixture-bytes');
  const unclearedUpload = await realUpload(f.dataDir, f.store, unclearedBytes);
  const unclearedEpisode = f.store.create('episodes', {
    channelId: f.channel.id, title: 'Uncleared asset', topic: 'Uncleared', category: 'information', status: 'draft', format: '9:16', version: 1,
    scenes: [basicScene('scene-uncleared', { kind: 'image', assetUrl: unclearedUpload.url, source: { origin: 'third-party', sourceUrl: 'https://example.com/uncleared.png', useAs: 'evidence' } })], notes: '',
  });
  const unclearedWorkflow = ownedWorkflow(f, unclearedEpisode, initialGraph());
  await assert.rejects(
    verifyCandidateAssets(f.store, candidateManifest(f.store, unclearedEpisode, unclearedWorkflow, { selectedStages })),
    'a third-party asset with no matching mediaRights clearance must never silently verify as approvable; public appearance is not permission',
  );

  await writeFile(path.join(f.dataDir, 'uploads', ownUpload.filename), 'TAMPERED BYTES, DOES NOT MATCH THE REGISTERED HASH');
  await assert.rejects(
    verifyCandidateAssets(f.store, candidateManifest(f.store, ownEpisode, ownWorkflow, { selectedStages })),
    'verification must re-hash the actual file on disk, not trust stored metadata, so silent tampering is caught',
  );
});

// --- B1/B2: generation targeted by a stable scene ID must resolve the correct scene after a reorder
// --- (never array position), and a missing target must fail before any provider request is made.
test('generation targeted by stable scene ID resolves the correct scene after a reorder; a missing target fails before any provider request', async (t) => {
  const f = await fixture(t, { estimates: { 'fixture-model': 1 } });
  const sceneA = basicScene('scene-a');
  const sceneB = basicScene('scene-b');
  const episode = f.store.create('episodes', { channelId: f.channel.id, title: 'Reorder-safe targeting', topic: 'Scene ID binding', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [sceneA, sceneB], notes: '' });
  // Reorder BEFORE quoting/starting: scene-b now sits at array index 0, scene-a at index 1.
  const reordered = f.store.updateEpisode(episode.id, { scenes: [sceneB, sceneA] }, episode.version);
  const selectedStages = ['script', 'storyboard', 'generate', 'render', 'review'];

  const workflow = ownedWorkflow(f, episode, sceneIdTargetingGraph('scene-b'));
  const plan = await f.workflows.quote(workflow.id, reordered.id, { selectedStages, expectedEpisodeVersion: reordered.version, disclosure });
  const run = f.workflows.start(workflow.id, reordered.id, { allowGeneration: true, selectedStages, expectedEpisodeVersion: reordered.version, generationPlanId: plan.id, generationFingerprint: plan.fingerprint, disclosure });
  const completed = await f.waitRun(run.id);
  assert.equal(completed.status, 'awaiting_review');
  const generateOutput = completed.nodeRuns.find((node) => node.nodeId === 'generate').output;
  const job = f.store.get('generationJobs', generateOutput.generationJobId);
  assert.equal(job.sceneId, 'scene-b', 'a scene-ID target must resolve the scene by its stable identity, not by its position in the reordered array');
  assert.equal(f.calls.create, 1);

  const workflow2 = ownedWorkflow(f, episode, sceneIdTargetingGraph('scene-does-not-exist'));
  await assert.rejects(
    f.workflows.quote(workflow2.id, reordered.id, { selectedStages, expectedEpisodeVersion: reordered.version, disclosure }),
    (error) => error.status === 400 || error.status === 409,
    'quoting a generate node whose target scene does not exist must fail before any provider request',
  );
  assert.equal(f.calls.create, 1, 'the missing-target quote failure must spend no NEW provider request beyond the earlier successful run');
  assert.equal(f.calls.estimate, 1, 'the missing-target quote failure must not even attempt a cost estimate, since the target cannot be resolved');
});

// --- B3: independent generate branches must persist separate jobs bound to their own scene. A
// --- recoverable failure in one branch must resume via explicit recovery -- never resubmit, recharge
// --- or reapply -- while the OTHER, already-completed branch's job identity is left untouched.
test('independent generate branches persist separate jobs; a recoverable failure resumes without resubmitting, recharging or losing job identity', async (t) => {
  let modelBRecovered = false;
  const f = await fixture(t, { estimates: { 'model-a': 2, 'model-b': 3 } });
  f.queue.download = async (url, file) => {
    if (url.includes('model-b') && !modelBRecovered) throw new Error('simulated transient download outage');
    await writeFile(file, 'fixture-generated-bytes');
    return { bytes: 23, contentType: 'image/png' };
  };

  const episode = f.store.create('episodes', { channelId: f.channel.id, title: 'Parallel branch resume', topic: 'Independent job identity', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [twoImageSlotsScene()], notes: '' });
  const workflow = ownedWorkflow(f, episode, parallelGenerateGraph({ sceneIndexes: [0, 0], slotIds: ['slot-a', 'slot-b'] }));
  const allStages = ['script', 'storyboard', 'generate-1', 'render-1', 'review-1', 'generate-2', 'render-2', 'review-2'];

  const plan0 = await f.workflows.quote(workflow.id, episode.id, { selectedStages: allStages, disclosure });
  const run0 = f.workflows.start(workflow.id, episode.id, { allowGeneration: true, selectedStages: allStages, generationPlanId: plan0.id, generationFingerprint: plan0.fingerprint, disclosure });
  const failed0 = await f.waitRun(run0.id, ['failed']);
  assert.equal(failed0.status, 'failed', "branch 2's transient download failure must fail the overall run, not silently continue");
  assert.equal(f.calls.create, 2, 'both branches must have submitted exactly once each on the first attempt');

  const jobA = f.store.list('generationJobs').find((job) => job.model === 'model-a');
  const jobB = f.store.list('generationJobs').find((job) => job.model === 'model-b');
  assert.equal(jobA.status, 'completed', 'branch 1 must have actually completed even though branch 2 failed');
  assert.equal(jobB.status, 'import_failed', "branch 2's job must land in a recoverable terminal state, not a silent loss of identity");
  assert.equal(jobA.sceneId, 'scene-a');
  assert.equal(jobB.sceneId, 'scene-a');
  assert.equal(jobA.slotId, 'slot-a');
  assert.equal(jobB.slotId, 'slot-b');
  const jobAOriginalId = jobA.id, jobBOriginalId = jobB.id;

  modelBRecovered = true;
  f.queue.recover(jobB.id);
  for (let i = 0; i < 400 && f.store.get('generationJobs', jobB.id).status !== 'completed'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.store.get('generationJobs', jobB.id).status, 'completed');
  assert.equal(f.store.get('generationJobs', jobB.id).id, jobBOriginalId, 'recovery must preserve the original job identity, never mint a new one');
  assert.equal(f.calls.create, 2, 'recovering a stalled job must poll/import, never resubmit a new provider.create request');

  const resumeStages = ['generate-2', 'render-2', 'review-2'];
  const plan1 = await f.workflows.quote(workflow.id, episode.id, { resumeRunId: run0.id, startStage: 'generate-2', selectedStages: resumeStages, disclosure });
  const run1 = f.workflows.start(workflow.id, episode.id, { allowGeneration: true, resumeRunId: run0.id, startStage: 'generate-2', selectedStages: resumeStages, generationPlanId: plan1.id, generationFingerprint: plan1.fingerprint, disclosure });
  const completed1 = await f.waitRun(run1.id);
  assert.equal(completed1.status, 'awaiting_review');
  assert.equal(f.calls.create, 2, "resuming branch 2 after explicit recovery must never have issued a THIRD provider.create call");
  const resumedOutput = completed1.nodeRuns.find((node) => node.nodeId === 'generate-2').output;
  assert.equal(resumedOutput.generationJobId, jobBOriginalId, 'the resumed branch must reuse the exact original job ID, not mint a replacement');
  const renderOutput = completed1.nodeRuns.find((node) => node.nodeId === 'render-2').output;
  const renderedScene = renderOutput.sceneSnapshot.find(scene => scene.id === 'scene-a');
  assert.equal(renderedScene?.slots?.find(slot => slot.id === 'slot-a')?.source?.generationJobId, jobAOriginalId, 'the independent completed branch remains in the resumed render');
  assert.equal(renderedScene?.slots?.find(slot => slot.id === 'slot-b')?.source?.generationJobId, jobBOriginalId, 'the recovered branch is rendered from its original job');
  const savedEpisode = f.store.get('episodes', episode.id);
  assert.deepEqual(renderOutput.sceneSnapshot, savedEpisode.scenes, 'the rendered scene snapshot must exactly equal the saved episode, not an ordered guess at its composition');
  assert.deepEqual(f.renderInputs.at(-1).scenes, savedEpisode.scenes, 'the renderer must receive precisely the saved scene composition');
  const renderReceipts = renderOutput.verifiedSceneAssets;
  assert.equal(renderReceipts.find(item => item.slotId === 'slot-a')?.sha256, renderedScene.slots.find(slot => slot.id === 'slot-a')?.source?.sha256, 'slot A receipt matches its persisted generated-source hash');
  assert.equal(renderReceipts.find(item => item.slotId === 'slot-b')?.sha256, renderedScene.slots.find(slot => slot.id === 'slot-b')?.source?.sha256, 'slot B receipt matches its persisted generated-source hash');
  assert.ok(jobA.appliedVersion < f.store.get('generationJobs', jobBOriginalId).appliedVersion, 'receipt history proves branch 1 was applied before recovered branch 2');
  assert.equal(f.store.get('generationJobs', jobAOriginalId).status, 'completed', "branch 1's completed job must remain untouched by branch 2's resume");
});

test('selected sibling generators that target the same scene and slot are rejected before estimates or provider submissions', async (t) => {
  const f = await fixture(t, { estimates: { 'model-a': 2, 'model-b': 3 } });
  const episode = f.store.create('episodes', { channelId: f.channel.id, title: 'Duplicate selected target', topic: 'Do not spend twice', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [twoImageSlotsScene()], notes: '' });
  const workflow = ownedWorkflow(f, episode, parallelGenerateGraph({ sceneIndexes: [0, 0], slotIds: ['slot-a', 'slot-a'] }));
  const allStages = ['script', 'storyboard', 'generate-1', 'render-1', 'review-1', 'generate-2', 'render-2', 'review-2'];

  await assert.rejects(
    f.workflows.quote(workflow.id, episode.id, { selectedStages: allStages, disclosure }),
    (error) => error.status === 409 && /same scene\/slot/.test(error.message),
    'two selected sibling jobs cannot race to overwrite the same saved target',
  );
  assert.equal(f.calls.estimate, 0, 'target collision is rejected before even quoting costs');
  assert.equal(f.calls.create, 0, 'target collision must never submit paid generation');
  assert.equal(f.store.get('episodes', episode.id).version, 1, 'rejected quote leaves saved episode version unchanged');
});

test('resuming an applied sibling on the same scene and slot fails closed without altering saved media or resubmitting', async (t) => {
  const f = await fixture(t, { estimates: { 'model-a': 2, 'model-b': 3 } });
  const episode = f.store.create('episodes', { channelId: f.channel.id, title: 'Applied sibling target conflict', topic: 'Preserve saved output', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [twoImageSlotsScene()], notes: '' });
  const workflow = ownedWorkflow(f, episode, parallelGenerateGraph({ sceneIndexes: [0, 0], slotIds: ['slot-a', 'slot-a'] }));
  const firstStages = ['script', 'storyboard', 'generate-1'];
  const firstPlan = await f.workflows.quote(workflow.id, episode.id, { selectedStages: firstStages, disclosure });
  const firstRun = f.workflows.start(workflow.id, episode.id, { allowGeneration: true, selectedStages: firstStages, generationPlanId: firstPlan.id, generationFingerprint: firstPlan.fingerprint, disclosure });
  const firstDone = await f.waitRun(firstRun.id, ['completed', 'failed']);
  assert.equal(firstDone.status, 'completed');
  const jobA = f.store.list('generationJobs').find((job) => job.model === 'model-a');
  assert.ok(jobA?.applied);
  const savedBefore = f.store.get('episodes', episode.id);
  const assetBefore = savedBefore.scenes[0].slots.find((slot) => slot.id === 'slot-a');

  await assert.rejects(
    f.workflows.quote(workflow.id, episode.id, { resumeRunId: firstRun.id, startStage: 'generate-2', selectedStages: ['generate-2'], disclosure }),
    (error) => error.status === 409 && /already-applied sibling/.test(error.message),
    'a different sibling may not replace a scene/slot already applied by another branch during resume',
  );
  const savedAfter = f.store.get('episodes', episode.id);
  assert.equal(savedAfter.version, savedBefore.version);
  assert.deepEqual(savedAfter.scenes, savedBefore.scenes);
  assert.equal(savedAfter.scenes[0].slots.find((slot) => slot.id === 'slot-a').source.generationJobId, jobA.id);
  assert.equal(f.store.list('generationJobs').length, 1, 'resume conflict creates no replacement paid job');
  assert.equal(f.calls.estimate, 1, 'resume conflict is rejected before another quote estimate');
  assert.equal(f.calls.create, 1, 'resume conflict never submits a duplicate paid generation');
  assert.equal(f.renderCount, 0, 'no render is produced from an unresolved target conflict');
  assert.equal(assetBefore.source.generationJobId, jobA.id);
});

test('resume rejects a retained receipt whose full scene composition differs from saved application history', async (t) => {
  const f = await fixture(t, { estimates: { 'model-a': 2, 'model-b': 3 } });
  const episode = f.store.create('episodes', { channelId: f.channel.id, title: 'Tampered composition receipt', topic: 'Require exact saved evidence', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [twoImageSlotsScene()], notes: '' });
  const workflow = ownedWorkflow(f, episode, parallelGenerateGraph({ sceneIndexes: [0, 0], slotIds: ['slot-a', 'slot-b'] }));
  const firstStages = ['script', 'storyboard', 'generate-1'];
  const firstPlan = await f.workflows.quote(workflow.id, episode.id, { selectedStages: firstStages, disclosure });
  const firstRun = f.workflows.start(workflow.id, episode.id, { allowGeneration: true, selectedStages: firstStages, generationPlanId: firstPlan.id, generationFingerprint: firstPlan.fingerprint, disclosure });
  assert.equal((await f.waitRun(firstRun.id, ['completed', 'failed'])).status, 'completed');
  const savedBefore = f.store.get('episodes', episode.id);
  const persistedRun = f.store.get('workflowRuns', firstRun.id);
  const tamperedNodes = persistedRun.nodeRuns.map((item) => {
    if (item.nodeId !== 'generate-1') return item;
    return { ...item, output: { ...item.output, scene: { ...item.output.scene, slots: item.output.scene.slots.map((slot) => slot.id === 'slot-b' ? { ...slot, name: 'Forged non-target composition' } : slot) } } };
  });
  f.store.save('workflowRuns', { ...persistedRun, nodeRuns: tamperedNodes });

  await assert.rejects(
    f.workflows.quote(workflow.id, episode.id, { resumeRunId: firstRun.id, startStage: 'generate-2', selectedStages: ['generate-2'], disclosure }),
    (error) => error.status === 409 && /matching node receipt/.test(error.message),
    'a target asset hash alone cannot authorize a forged non-target part of the composed scene snapshot',
  );
  assert.deepEqual(f.store.get('episodes', episode.id).scenes, savedBefore.scenes, 'receipt validation never changes the persisted episode');
  assert.equal(f.calls.estimate, 1, 'tampered composition is rejected before a new quote estimate');
  assert.equal(f.calls.create, 1, 'tampered composition never causes another paid submission');
  assert.equal(f.renderCount, 0, 'tampered composition cannot reach the renderer');
});

// --- B4: selecting only non-generate stages must never touch the generation provider, and must not
// --- require any generationPlanId at all.
test('source-only selected execution (no generate node selected) makes zero generation or provider requests', async (t) => {
  const f = await fixture(t, { estimates: { 'fixture-model': 1 } });
  const episode = f.store.create('episodes', {
    channelId: f.channel.id, title: 'Source-only run', topic: 'No generation requested', category: 'information', status: 'draft', format: '9:16', version: 1,
    scenes: [basicScene('scene-1')], notes: '',
  });
  const workflow = ownedWorkflow(f, episode, initialGraph());
  const run = f.workflows.start(workflow.id, episode.id, { selectedStages: ['script', 'storyboard'], startStage: 'script' });
  const completed = await f.waitRun(run.id, ['awaiting_review', 'completed', 'failed']);
  assert.notEqual(completed.status, 'failed', JSON.stringify(completed));
  assert.equal(f.calls.create, 0, 'editing source-only stages must never touch the generation provider');
  assert.equal(f.calls.estimate, 0, 'a source-only run must not require or attempt any cost estimate');
});

// --- C1: the minimal initialGraph has no optional trend/news ancestor; its absence must not be
// --- treated as a required-input failure anywhere in the quote/start/candidate path.
test('initialGraph (no optional news/trend context) quotes and executes with absent optional context, not a required error', async (t) => {
  const f = await fixture(t, { estimates: { 'fixture-model': 1.5 } });
  const episode = f.store.create('episodes', {
    channelId: f.channel.id, title: 'No optional context', topic: 'Minimal graph', category: 'information', status: 'draft', format: '9:16', version: 1,
    scenes: [basicScene('scene-1')], notes: '',
  });
  const workflow = ownedWorkflow(f, episode, initialGraph());
  assert.equal(workflow.nodes.some((node) => ['trend', 'news'].includes(node.type)), false, 'initialGraph has no optional trend/news ancestor by design');
  const selectedStages = ['script', 'storyboard', 'generate', 'render', 'review'];
  const manifest = candidateManifest(f.store, episode, workflow, { selectedStages });
  assert.equal(manifest.nodes.length, 1, 'absent optional context must not prevent the candidate from resolving the one real generate node');
  const plan = await f.workflows.quote(workflow.id, episode.id, { selectedStages, disclosure });
  assert.equal(plan.aggregate.quoted, true);
  const run = f.workflows.start(workflow.id, episode.id, { allowGeneration: true, selectedStages, generationPlanId: plan.id, generationFingerprint: plan.fingerprint, disclosure });
  const completed = await f.waitRun(run.id);
  assert.equal(completed.status, 'awaiting_review');
  assert.equal(f.calls.create, 1);
});

// --- C2: the default full ten-stage pipeline must aggregate every selected generate node and must
// --- actually submit the real, transitively-resolved prompt (news headline flowing through layout
// --- into the generate node's provider request), not a blank/literal node.config.prompt.
test('fullPipelineGraph (default, all ten stage types) aggregates selected generate nodes and resolves transitive data through the whole pipeline', async (t) => {
  const f = await fixture(t, {
    estimates: { 'fixture-model': 2.75 },
    fetchTrends: async () => ({ trends: [{ keyword: 'HBM4 반도체', source: 'Fixture Trends', url: 'https://example.com/trend' }], sources: [{ name: 'Fixture Trends', status: 'ok' }] }),
  });
  f.store.create('trends', { keyword: 'HBM4 반도체', source: 'Fixture Trends', url: 'https://example.com/trend', title: 'HBM4 반도체 관련 소식', capturedAt: new Date().toISOString(), selected: true });
  const episode = f.store.create('episodes', {
    channelId: f.channel.id, title: '전체 파이프라인', topic: 'HBM4 반도체 동향', category: 'information', status: 'draft', format: '9:16', version: 1,
    scenes: [basicScene('scene-1')], notes: '',
  });
  const graph = fullPipelineGraph();
  assert.equal(graph.nodes.length, 10, 'the default full pipeline must cover every supported stage type exactly once');
  const workflow = ownedWorkflow(f, episode, graph);
  const selectedStages = graph.nodes.filter((node) => node.type !== 'publish').map((node) => node.id); // publish needs an approved review; out of this file's scope

  const manifest = candidateManifest(f.store, episode, workflow, { selectedStages });
  assert.equal(manifest.nodes.length, 1, 'exactly one selected generate node must appear in the full-pipeline candidate');

  const plan = await f.workflows.quote(workflow.id, episode.id, { selectedStages, disclosure });
  assert.equal(plan.nodes.length, 1);
  const run = f.workflows.start(workflow.id, episode.id, { allowGeneration: true, selectedStages, generationPlanId: plan.id, generationFingerprint: plan.fingerprint, disclosure });
  const completed = await f.waitRun(run.id);
  assert.equal(completed.status, 'awaiting_review', JSON.stringify(completed));
  assert.equal(f.calls.create, 1);
  const newsOutput = completed.nodeRuns.find((node) => node.nodeId === 'news').output;
  assert.ok(newsOutput.articles.length > 0, 'the news stage must have produced real downstream data since this graph DOES include it');
  assert.match(f.calls.prompts[0], /HBM4 반도체 관련 소식/, "the real submitted prompt must carry the news headline transitively through layout, not a blank node.config.prompt");
});

function ownedWorkflow(f, episode, body) {
  const template = f.workflows.create(body);
  return f.store.createWorkflowCopy({ templateId: template.id, channelId: episode.channelId, episodeId: episode.id, expectedTemplateVersion: template.version });
}


test('recovering an already-applied generation preserves its job id and applied version without duplicate generation', async (t) => {
  const f = await fixture(t, { estimates: { 'fixture-model': 1 } });
  const episode = f.store.create('episodes', { channelId: f.channel.id, title: 'Applied job recovery', topic: 'Preserve receipt identity', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [basicScene('scene-a')], notes: '' });
  const workflow = ownedWorkflow(f, episode, initialGraph());
  const allStages = ['script', 'storyboard', 'generate', 'render', 'review'];
  const plan0 = await f.workflows.quote(workflow.id, episode.id, { selectedStages: allStages, disclosure });
  const run0 = f.workflows.start(workflow.id, episode.id, { allowGeneration: true, selectedStages: allStages, generationPlanId: plan0.id, generationFingerprint: plan0.fingerprint, disclosure });
  const done0 = await f.waitRun(run0.id, ['completed', 'failed', 'awaiting_review']);
  assert.equal(done0.status, 'awaiting_review');
  const originalJob = f.store.list('generationJobs')[0];
  assert.equal(originalJob.status, 'completed');
  assert.equal(originalJob.applied, true);
  const appliedVersion = originalJob.appliedVersion;
  const appliedScene = f.store.history(episode.id).find((entry) => entry.version === appliedVersion).snapshot.scenes[0];
  assert.equal(done0.nodeRuns.find((item) => item.nodeId === 'generate').output.episodeVersion, appliedVersion);

  // Model a persisted interruption after the provider job was applied but before the
  // workflow recorded a successful generate-node result. Keep the public recovery path:
  // quote() and start() must recover the exact job rather than submit a replacement.
  const current = f.store.get('episodes', episode.id);
  const advanced = f.store.updateEpisode(current.id, { notes: 'Unrelated later edit' }, current.version, 'fixture:unrelated-edit');
  const interrupted = f.store.get('workflowRuns', run0.id);
  f.store.save('workflowRuns', {
    ...interrupted,
    status: 'failed',
    episodeVersion: advanced.version,
    nodeRuns: interrupted.nodeRuns.map((item) => {
      if (item.nodeId === 'generate') {
        const { generationIntent, ...withoutIntent } = item;
        return { ...withoutIntent, status: 'failed', error: 'Simulated interruption after application' };
      }
      return item.nodeId === 'storyboard' ? { ...item, output: { ...item.output, scenes: advanced.scenes } } : item;
    }),
  });

  const resumeStages = ['generate', 'render', 'review'];
  const plan1 = await f.workflows.quote(workflow.id, episode.id, { resumeRunId: run0.id, startStage: 'generate', selectedStages: resumeStages, disclosure });
  const run1 = f.workflows.start(workflow.id, episode.id, { allowGeneration: true, resumeRunId: run0.id, startStage: 'generate', selectedStages: resumeStages, generationPlanId: plan1.id, generationFingerprint: plan1.fingerprint, disclosure });
  const recovered = await f.waitRun(run1.id, ['completed', 'failed', 'awaiting_review']);

  assert.equal(recovered.status, 'awaiting_review', 'the recovered applied job must pass its receipt into render');
  const generateOutput = recovered.nodeRuns.find((item) => item.nodeId === 'generate').output;
  assert.equal(generateOutput.generationJobId, originalJob.id, 'recovery keeps the original generation job identity');
  assert.equal(generateOutput.episodeVersion, appliedVersion, 'the receipt version remains the job application version, not the later episode version');
  assert.deepEqual(generateOutput.scene, appliedScene, 'recovery exposes the scene snapshot from the exact applied history version');
  assert.equal(f.store.get('episodes', episode.id).version, advanced.version, 'recovering an applied job does not apply it a second time');
  assert.equal(f.calls.create, 1, 'recovering an already-applied job never submits another paid generation');
  assert.equal(f.store.list('generationJobs').length, 1, 'recovery does not create a replacement job');
});
