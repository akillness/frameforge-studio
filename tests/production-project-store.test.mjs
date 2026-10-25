// RED-first regression tests for the PW-06 project-owned workflow and PW-02 per-node review
// Store contract (.mex/context/decisions.md "Production-workspace interview", "store" section of
// artifacts/production-workspace-implementation/plan.json). Exercises the Store class in
// server/store.mjs directly — no HTTP layer, no WorkflowEngine execution — since this file owns
// only the Store contract. Node IDs/run/job fixtures are hand-built to stay independent of the
// repeated-node-type relaxation to validateWorkflow that GraphRedTests/EngineImplementation own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Store, starterScene } from '../server/store.mjs';
import { defaultWorkflow } from '../server/workflows.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-project-store-'));
  const store = new Store(dataDir);
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store };
}

function makeChannel(store, overrides = {}) {
  return store.create('channels', { name: 'Test channel', category: 'information', platform: 'YouTube', accountEmail: '', externalId: '', sample: false, ...overrides });
}

function makeEpisode(store, channelId, overrides = {}) {
  return store.create('episodes', { channelId, title: 'Episode', topic: 'Topic', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [starterScene('Scene', 'Text')], notes: '', ...overrides });
}

/** A valid, Store.create-ready workflow template graph: the shared trend->review chain. */
function makeTemplate(store, overrides = {}) {
  return store.create('workflows', { ...defaultWorkflow(), ...overrides });
}

/** A valid, Store.create-ready workflow template graph with a trailing publish node bound to
 * sourceChannelId, to exercise destination-channel rebind on copy. */
function makeTemplateWithPublish(store, sourceChannelId, overrides = {}) {
  const classicTypes = ['trend', 'research', 'script', 'storyboard', 'render', 'review', 'publish'];
  const nodes = classicTypes.map((type, index) => ({
    id: type,
    type,
    x: 80 + index * 260,
    y: 180,
    config: type === 'script' ? { agent: 'studio', prompt: 'Build the storyboard from verified sources.' } : type === 'publish' ? { channelId: sourceChannelId, platform: 'youtube', visibility: 'private' } : {},
  }));
  const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${index + 1}`, source: nodes[index].id, target: node.id }));
  return store.create('workflows', { name: 'Template with publish', nodes, edges, version: 1, sample: true, ...overrides });
}

test('createWorkflowCopy produces a fresh v1 workflow owned by episode/channel, with template lineage recorded and node IDs preserved', async (t) => {
  const { store } = await fixture(t);
  const channel = makeChannel(store);
  const episode = makeEpisode(store, channel.id);
  const template = makeTemplate(store);

  const copy = store.createWorkflowCopy({ templateId: template.id, channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });

  assert.notEqual(copy.id, template.id, 'the copy must receive a brand new workflow identity, not reuse the template id');
  assert.equal(copy.version, 1, 'a fresh copy always starts at v1 regardless of the template version');
  assert.equal(copy.episodeId, episode.id);
  assert.equal(copy.channelId, channel.id);
  assert.equal(copy.templateId, template.id);
  assert.equal(copy.templateVersion, template.version);
  assert.equal(copy.name, template.name);
  assert.deepEqual(copy.nodes.map((node) => node.id).sort(), template.nodes.map((node) => node.id).sort(), 'node IDs are preserved verbatim inside the new workflow identity, not regenerated');
  assert.deepEqual(copy.edges, template.edges);
  assert.deepEqual(store.get('workflows', copy.id), copy, 'the copy is actually persisted and independently retrievable');
});

test('createWorkflowCopy rejects a channelId that does not match the target episode\'s own channel', async (t) => {
  const { store } = await fixture(t);
  const channel = makeChannel(store);
  const otherChannel = makeChannel(store, { name: 'Other channel' });
  const episode = makeEpisode(store, channel.id);
  const template = makeTemplate(store);

  assert.throws(() => store.createWorkflowCopy({ templateId: template.id, channelId: otherChannel.id, episodeId: episode.id, expectedTemplateVersion: template.version }), (error) => error.status === 400, 'a project workflow must be bound to the episode\'s own channel, not an arbitrary one');
  assert.equal(store.list('workflows').filter((workflow) => workflow.episodeId === episode.id).length, 0, 'a rejected mismatched copy must never be persisted');
});

test('two project copies from the same template are isolated: editing one never affects the other, with independent version conflicts and history', async (t) => {
  const { store } = await fixture(t);
  const channelA = makeChannel(store, { name: 'Channel A' });
  const channelB = makeChannel(store, { name: 'Channel B' });
  const episodeA = makeEpisode(store, channelA.id, { title: 'Episode A' });
  const episodeB = makeEpisode(store, channelB.id, { title: 'Episode B' });
  const template = makeTemplate(store);

  const copyA = store.createWorkflowCopy({ templateId: template.id, channelId: channelA.id, episodeId: episodeA.id, expectedTemplateVersion: template.version });
  const copyB = store.createWorkflowCopy({ templateId: template.id, channelId: channelB.id, episodeId: episodeB.id, expectedTemplateVersion: template.version });
  assert.notEqual(copyA.id, copyB.id);

  const editedNodesA = copyA.nodes.map((node) => node.id === 'review' ? { ...node, config: { instructions: 'Channel A specific review instructions' } } : node);
  const updatedA = store.updateWorkflow(copyA.id, { name: copyA.name, nodes: editedNodesA, edges: copyA.edges }, copyA.version);
  assert.equal(updatedA.version, 2);
  assert.equal(updatedA.nodes.find((node) => node.id === 'review').config.instructions, 'Channel A specific review instructions');

  const freshB = store.get('workflows', copyB.id);
  assert.equal(freshB.version, 1, 'editing copy A must never bump copy B version');
  assert.deepEqual(freshB.nodes, template.nodes, 'editing copy A must never change copy B graph');

  assert.throws(() => store.updateWorkflow(copyA.id, { name: copyA.name, nodes: copyA.nodes, edges: copyA.edges }, 1), (error) => error.status === 409, 'a stale edit against the now-v2 copy A must conflict, not silently apply');
  const updatedB = store.updateWorkflow(copyB.id, { name: copyB.name, nodes: copyB.nodes, edges: copyB.edges }, 1);
  assert.equal(updatedB.version, 2, "copy B's own first edit must succeed independently of copy A's version history");

  const historyA = store.workflowHistory(copyA.id);
  const historyB = store.workflowHistory(copyB.id);
  assert.deepEqual(historyA.map((entry) => entry.version).sort(), [1, 2]);
  assert.deepEqual(historyB.map((entry) => entry.version).sort(), [1, 2]);
  assert.ok(historyA.every((entry) => entry.workflowId === copyA.id), 'copy A history must never contain copy B snapshots');
  assert.ok(historyB.every((entry) => entry.workflowId === copyB.id), 'copy B history must never contain copy A snapshots');
});

test('project-owned lineage fields are immutable through ordinary graph edits: a patch attempting to change one is rejected, a same-value resend is an ordinary edit', async (t) => {
  const { store } = await fixture(t);
  const channel = makeChannel(store);
  const otherChannel = makeChannel(store, { name: 'Other channel' });
  const episode = makeEpisode(store, channel.id);
  const otherEpisode = makeEpisode(store, otherChannel.id);
  const template = makeTemplate(store);
  const otherTemplate = makeTemplate(store, { name: 'Other template' });
  const copy = store.createWorkflowCopy({ templateId: template.id, channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });

  for (const patch of [{ channelId: otherChannel.id }, { episodeId: otherEpisode.id }, { templateId: otherTemplate.id }, { templateVersion: 99 }]) {
    assert.throws(() => store.updateWorkflow(copy.id, { name: copy.name, nodes: copy.nodes, edges: copy.edges, ...patch }, copy.version), (error) => error.status === 400, `attempting to change ${Object.keys(patch)[0]} through an ordinary edit must be rejected`);
  }
  assert.deepEqual(store.get('workflows', copy.id), copy, 'every rejected lineage-change attempt must leave the copy completely unchanged');

  const resend = store.updateWorkflow(copy.id, {
    name: copy.name, nodes: copy.nodes, edges: copy.edges,
    channelId: copy.channelId, episodeId: copy.episodeId, templateId: copy.templateId, templateVersion: copy.templateVersion,
  }, copy.version);
  assert.equal(resend.version, 2, 'resending the unchanged lineage values alongside a real edit must succeed as an ordinary update');
  assert.equal(resend.channelId, channel.id);
});

test('createWorkflowCopy rebinds a template publish node to the destination channel, never the template source channel', async (t) => {
  const { store } = await fixture(t);
  const sourceChannel = makeChannel(store, { name: 'Source channel' });
  const destinationChannel = makeChannel(store, { name: 'Destination channel' });
  const episode = makeEpisode(store, destinationChannel.id);
  const template = makeTemplateWithPublish(store, sourceChannel.id);
  assert.equal(template.nodes.find((node) => node.type === 'publish').config.channelId, sourceChannel.id);

  const copy = store.createWorkflowCopy({ templateId: template.id, channelId: destinationChannel.id, episodeId: episode.id, expectedTemplateVersion: template.version });

  const publishNode = copy.nodes.find((node) => node.type === 'publish');
  assert.equal(publishNode.config.channelId, destinationChannel.id, 'publish config must rebind to the destination channel, not carry over the stale template channel override');
  assert.notEqual(publishNode.config.channelId, sourceChannel.id);
});

test('createWorkflowCopy creates no operational records and copies no run/job/session/paid-intent/approval fields or sample marker', async (t) => {
  const { store } = await fixture(t);
  const channel = makeChannel(store);
  const episode = makeEpisode(store, channel.id);
  const template = makeTemplate(store);

  const copy = store.createWorkflowCopy({ templateId: template.id, channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });

  for (const kind of ['workflowRuns', 'jobs', 'generationJobs', 'platformSessions', 'platformUploads']) {
    assert.deepEqual(store.list(kind), [], `createWorkflowCopy must never create ${kind} records as a side effect`);
  }
  for (const field of ['runId', 'jobId', 'paidIntentId', 'approvalId', 'sessionId', 'review', 'reviews']) {
    assert.equal(copy[field], undefined, `the copy entity itself must carry no operational field "${field}"`);
  }
  assert.notEqual(copy.sample, true, 'a project-owned copy must never inherit the template-only sample marker');
});

test('an explicit template version update leaves existing project copies pinned to their original graph and templateVersion', async (t) => {
  const { store } = await fixture(t);
  const channel = makeChannel(store);
  const episode1 = makeEpisode(store, channel.id, { title: 'Episode 1' });
  const episode2 = makeEpisode(store, channel.id, { title: 'Episode 2' });
  const template = makeTemplate(store);
  const copy1 = store.createWorkflowCopy({ templateId: template.id, channelId: channel.id, episodeId: episode1.id, expectedTemplateVersion: template.version });

  const extraNode = { id: 'extra-research', type: 'research', x: 999, y: 999, config: {} };
  const templateV2 = store.updateWorkflow(template.id, { name: template.name, nodes: [...template.nodes, extraNode], edges: template.edges }, template.version);
  assert.equal(templateV2.version, 2);

  const copy1Fresh = store.get('workflows', copy1.id);
  assert.equal(copy1Fresh.version, 1, 'the existing project copy is never silently re-versioned by a template edit');
  assert.equal(copy1Fresh.templateVersion, 1, 'templateVersion stays pinned to the version actually copied');
  assert.deepEqual(copy1Fresh.nodes.map((node) => node.id).sort(), template.nodes.map((node) => node.id).sort(), 'the extra node added to the template must never silently appear in an already-created copy');
  assert.ok(!copy1Fresh.nodes.some((node) => node.id === 'extra-research'));

  const copy2 = store.createWorkflowCopy({ templateId: template.id, channelId: channel.id, episodeId: episode2.id, expectedTemplateVersion: templateV2.version });
  assert.equal(copy2.templateVersion, 2);
  assert.ok(copy2.nodes.some((node) => node.id === 'extra-research'), 'a copy made after the template update sees the new graph');

  assert.throws(() => store.createWorkflowCopy({ templateId: template.id, channelId: channel.id, episodeId: episode1.id, expectedTemplateVersion: 1 }), (error) => error.status === 409, 'a stale expectedTemplateVersion against the now-v2 template must conflict, not silently copy the old graph');
});

// --- workflow_node_reviews: additive per-node review table, branch isolation, aggregation,
// --- duplicate/stale/hash rejection and legacy single-review backward compatibility.
// Run/job fixtures below are hand-built directly against Store, bypassing validateWorkflow/
// WorkflowEngine entirely, since the current validateWorkflow still rejects a second node of the
// same type (PW-02 repeated-node relaxation is GraphRedTests/EngineImplementation's non-goal here).
// Store itself has no such restriction; these fixtures exercise exactly the Store surface owned by
// this file.

async function parallelBranchRunFixture(store, dataDir) {
  const channel = makeChannel(store);
  const episode = makeEpisode(store, channel.id);
  const workflow = store.create('workflows', {
    name: 'Hand-built parallel branches',
    nodes: [
      { id: 'storyboard', type: 'storyboard', x: 0, y: 0, config: {} },
      { id: 'render-1', type: 'render', x: 100, y: -50, config: {} },
      { id: 'review-1', type: 'review', x: 200, y: -50, config: {} },
      { id: 'render-2', type: 'render', x: 100, y: 50, config: {} },
      { id: 'review-2', type: 'review', x: 200, y: 50, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'storyboard', target: 'render-1' },
      { id: 'e2', source: 'render-1', target: 'review-1' },
      { id: 'e3', source: 'storyboard', target: 'render-2' },
      { id: 'e4', source: 'render-2', target: 'review-2' },
    ],
    version: 1, sample: false,
  });
  const makeRenderOutput = async (label) => {
    const filename = `${randomUUID()}.mp4`;
    const bytes = Buffer.from(`Parallel branch fixture candidate: ${label}, not a real MP4.`);
    await writeFile(path.join(dataDir, 'exports', filename), bytes);
    const job = store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'completed', progress: 100, filename, outputUrl: `/api/exports/${filename}`, sha256: hash(bytes) });
    return { job, bytes, output: { jobId: job.id, outputUrl: job.outputUrl, sha256: job.sha256, episodeVersion: episode.version, filename } };
  };
  const render1 = await makeRenderOutput('branch 1');
  const render2 = await makeRenderOutput('branch 2');
  const run = store.save('workflowRuns', {
    id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    workflowId: workflow.id, workflowVersion: workflow.version, episodeId: episode.id, episodeVersion: episode.version,
    workflowSnapshot: { nodes: workflow.nodes, edges: workflow.edges },
    status: 'awaiting_review', selectedStages: ['storyboard', 'render-1', 'review-1', 'render-2', 'review-2'],
    nodeRuns: [
      { nodeId: 'storyboard', type: 'storyboard', status: 'completed', output: {} },
      { nodeId: 'render-1', type: 'render', status: 'completed', output: render1.output },
      { nodeId: 'review-1', type: 'review', status: 'awaiting_review', output: {} },
      { nodeId: 'render-2', type: 'render', status: 'completed', output: render2.output },
      { nodeId: 'review-2', type: 'review', status: 'awaiting_review', output: {} },
    ],
  });
  return { channel, episode, workflow, run, render1, render2 };
}

async function singleReviewRunFixture(store, dataDir, { reviewNodeCount = 1 } = {}) {
  const channel = makeChannel(store);
  const episode = makeEpisode(store, channel.id);
  const reviewNodes = reviewNodeCount === 1
    ? [{ id: 'review', type: 'review', x: 200, y: 0, config: {} }]
    : [{ id: 'review-1', type: 'review', x: 200, y: -50, config: {} }, { id: 'review-2', type: 'review', x: 200, y: 50, config: {} }];
  const workflow = store.create('workflows', {
    name: 'Hand-built single branch',
    nodes: [{ id: 'storyboard', type: 'storyboard', x: 0, y: 0, config: {} }, { id: 'render', type: 'render', x: 100, y: 0, config: {} }, ...reviewNodes],
    edges: [{ id: 'e1', source: 'storyboard', target: 'render' }, { id: 'e2', source: 'render', target: reviewNodes[0].id }],
    version: 1, sample: false,
  });
  const filename = `${randomUUID()}.mp4`;
  const bytes = Buffer.from('Legacy single-review fixture candidate, not a real MP4.');
  await writeFile(path.join(dataDir, 'exports', filename), bytes);
  const job = store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'completed', progress: 100, filename, outputUrl: `/api/exports/${filename}`, sha256: hash(bytes) });
  const output = { jobId: job.id, outputUrl: job.outputUrl, sha256: job.sha256, episodeVersion: episode.version, filename };
  const run = store.save('workflowRuns', {
    id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    workflowId: workflow.id, workflowVersion: workflow.version, episodeId: episode.id, episodeVersion: episode.version,
    workflowSnapshot: { nodes: workflow.nodes, edges: workflow.edges },
    status: 'awaiting_review', selectedStages: ['storyboard', 'render', reviewNodes[0].id],
    nodeRuns: [
      { nodeId: 'storyboard', type: 'storyboard', status: 'completed', output: {} },
      { nodeId: 'render', type: 'render', status: 'completed', output },
      { nodeId: reviewNodes[0].id, type: 'review', status: 'awaiting_review', output: {} },
      ...(reviewNodeCount === 2 ? [{ nodeId: 'review-2', type: 'review', status: 'skipped', output: null }] : []),
    ],
  });
  return { channel, episode, workflow, run, job, output };
}

test('reviewCandidate resolves each review node to its own edge-connected render, not any other branch', async (t) => {
  const { store, dataDir } = await fixture(t);
  const { workflow, run, episode, render2 } = await parallelBranchRunFixture(store, dataDir);

  const candidate = store.reviewCandidate(workflow.id, run.id, 'review-2', episode.version);

  assert.equal(candidate.job.id, render2.job.id, 'review-2 must resolve to its own branch render job, never the other branch');
  assert.equal(candidate.job.outputUrl, render2.output.outputUrl);
});

test('committing a decision for review-2 writes a per-node review record and leaves review-1 untouched while the run stays open', async (t) => {
  const { store, dataDir } = await fixture(t);
  const { workflow, run, episode, render2 } = await parallelBranchRunFixture(store, dataDir);

  const updated = store.commitWorkflowReview(workflow.id, run.id, 'review-2', {
    decision: 'approved', notes: 'Branch 2 candidate matches the news source.',
    expectedEpisodeVersion: episode.version, jobId: render2.job.id, outputUrl: render2.output.outputUrl, sha256: render2.output.sha256,
  });

  assert.equal(updated.review, undefined, 'the legacy singular run.review alias must never reappear on the new multi-node contract');
  assert.equal(updated.reviews?.['review-2']?.decision, 'approved', 'the decision is keyed by review node id under run.reviews');
  const review1After = updated.nodeRuns.find((node) => node.nodeId === 'review-1');
  const review2After = updated.nodeRuns.find((node) => node.nodeId === 'review-2');
  assert.equal(review1After.status, 'awaiting_review', 'review-1 must be completely unaffected by a decision on review-2');
  assert.equal(review2After.status, 'approved');
  assert.equal(updated.status, 'awaiting_review', 'the run is not fully decided while review-1 is still pending, even though review-2 is approved');

  const persisted = store.get('workflowRuns', run.id);
  assert.deepEqual(persisted, updated, 'the per-node decision is actually durably persisted');
});

test('the run becomes approved only once every active review node has been approved, regardless of commit order', async (t) => {
  const { store, dataDir } = await fixture(t);
  const { workflow, run, episode, render1, render2 } = await parallelBranchRunFixture(store, dataDir);

  const afterSecond = store.commitWorkflowReview(workflow.id, run.id, 'review-2', { decision: 'approved', notes: 'Branch 2 ok.', expectedEpisodeVersion: episode.version, jobId: render2.job.id, outputUrl: render2.output.outputUrl, sha256: render2.output.sha256 });
  assert.equal(afterSecond.status, 'awaiting_review', 'still one undecided branch');

  const afterFirst = store.commitWorkflowReview(workflow.id, run.id, 'review-1', { decision: 'approved', notes: 'Branch 1 ok.', expectedEpisodeVersion: episode.version, jobId: render1.job.id, outputUrl: render1.output.outputUrl, sha256: render1.output.sha256 });
  assert.equal(afterFirst.status, 'approved', 'both review nodes approved must flip the run to approved');
  assert.equal(afterFirst.nodeRuns.find((node) => node.nodeId === 'review-1').status, 'approved');
  assert.equal(afterFirst.nodeRuns.find((node) => node.nodeId === 'review-2').status, 'approved');
});

test('a changes_requested decision on one branch makes the run terminal even though its sibling branch was already approved', async (t) => {
  const { store, dataDir } = await fixture(t);
  const { workflow, run, episode, render1, render2 } = await parallelBranchRunFixture(store, dataDir);

  store.commitWorkflowReview(workflow.id, run.id, 'review-2', { decision: 'approved', notes: 'Branch 2 ok.', expectedEpisodeVersion: episode.version, jobId: render2.job.id, outputUrl: render2.output.outputUrl, sha256: render2.output.sha256 });
  const final = store.commitWorkflowReview(workflow.id, run.id, 'review-1', { decision: 'changes_requested', notes: 'Branch 1 needs a source fix.', expectedEpisodeVersion: episode.version, jobId: render1.job.id, outputUrl: render1.output.outputUrl, sha256: render1.output.sha256 });

  assert.equal(final.status, 'changes_requested', 'one rejected branch makes the whole run terminal at changes_requested even with an already-approved sibling');
});

test('re-deciding an already-decided review node is rejected and never overwrites the first decision', async (t) => {
  const { store, dataDir } = await fixture(t);
  const { workflow, run, episode, render2 } = await parallelBranchRunFixture(store, dataDir);
  const body = { decision: 'approved', notes: 'First decision.', expectedEpisodeVersion: episode.version, jobId: render2.job.id, outputUrl: render2.output.outputUrl, sha256: render2.output.sha256 };
  store.commitWorkflowReview(workflow.id, run.id, 'review-2', body);

  assert.throws(() => store.commitWorkflowReview(workflow.id, run.id, 'review-2', { ...body, decision: 'changes_requested', notes: 'Attempted overwrite.' }), (error) => error.status === 409, 'a second decision for the same (run,node) pair must be rejected');
  const persisted = store.get('workflowRuns', run.id);
  assert.equal(persisted.nodeRuns.find((node) => node.nodeId === 'review-2').status, 'approved', 'the rejected re-decision must never overwrite the committed first decision');
});

test('reviewCandidate resolves a correctly-versioned candidate and rejects a decision whose expected episode version does not match, whether the client is stale or the episode changed after render', async (t) => {
  const { store, dataDir } = await fixture(t);
  const { workflow, run, episode, render2 } = await parallelBranchRunFixture(store, dataDir);

  const candidate = store.reviewCandidate(workflow.id, run.id, 'review-2', episode.version);
  assert.equal(candidate.job.id, render2.job.id, 'a correctly-versioned call must actually resolve the real candidate, not merely avoid throwing');

  assert.throws(() => store.reviewCandidate(workflow.id, run.id, 'review-2', episode.version + 1), (error) => error.status === 409, 'a client-supplied expectedEpisodeVersion that does not match the run must be rejected');

  store.updateEpisode(episode.id, { title: 'Edited after render' }, episode.version);
  assert.throws(() => store.reviewCandidate(workflow.id, run.id, 'review-2', episode.version), (error) => error.status === 409, 'an episode edited after the render must invalidate the candidate even with the originally-correct version number');
});

test('commitWorkflowReview rejects a tampered artifact hash that does not match the actual rendered output', async (t) => {
  const { store, dataDir } = await fixture(t);
  const { workflow, run, episode, render2 } = await parallelBranchRunFixture(store, dataDir);
  const tamperedHash = render2.output.sha256.split('').reverse().join('');

  assert.throws(() => store.commitWorkflowReview(workflow.id, run.id, 'review-2', { decision: 'approved', notes: 'x', expectedEpisodeVersion: episode.version, jobId: render2.job.id, outputUrl: render2.output.outputUrl, sha256: tamperedHash }), (error) => error.status === 409, 'a hash that does not match the actual rendered artifact must be rejected');
  const persisted = store.get('workflowRuns', run.id);
  assert.equal(persisted.nodeRuns.find((node) => node.nodeId === 'review-2').status, 'awaiting_review', 'a rejected tampered hash must never commit a review');
});

test('unknown workflow, run, or review node ids are rejected as not found, never silently resolved', async (t) => {
  const { store, dataDir } = await fixture(t);
  const { workflow, run, episode } = await parallelBranchRunFixture(store, dataDir);
  const other = makeTemplate(store);

  assert.throws(() => store.reviewCandidate(other.id, run.id, 'review-2', episode.version), (error) => error.status === 404, 'a run requested under the wrong workflow id must not resolve');
  assert.throws(() => store.reviewCandidate(workflow.id, randomUUID(), 'review-2', episode.version), (error) => error.status === 404, 'an unknown run id must not resolve');
  assert.throws(() => store.reviewCandidate(workflow.id, run.id, 'review-99', episode.version), (error) => [400, 404].includes(error.status), 'an unknown review node id must not silently resolve to a different node');
});

test('a legacy single review is attributed to the one review node of an older run, without touching the legacy table', async (t) => {
  const { store, dataDir } = await fixture(t);
  const { workflow, run, episode, job, output } = await singleReviewRunFixture(store, dataDir);
  const legacyReview = { id: randomUUID(), decision: 'approved', notes: 'Pre-migration legacy decision.', reviewedAt: new Date().toISOString(), workflowId: workflow.id, workflowVersion: workflow.version, runId: run.id, episodeId: episode.id, episodeVersion: episode.version, jobId: job.id, outputUrl: output.outputUrl, sha256: output.sha256 };
  // Simulates data written by the old single-table code path before this migration; there is no
  // public write path left for this legacy shape, so seeding it is necessarily direct.
  store.db.prepare('INSERT INTO workflow_reviews(id, run_id, data) VALUES (?, ?, ?)').run(legacyReview.id, run.id, JSON.stringify(legacyReview));
  const before = store.db.prepare('SELECT id, run_id, data FROM workflow_reviews WHERE run_id = ?').all(run.id);

  const reviews = store.workflowNodeReviews(run.id);

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reviewNodeId, 'review', "the single historical review must be attributed to the one review node that exists for this run's workflow");
  assert.equal(reviews[0].decision, 'approved');
  assert.equal(reviews[0].jobId, job.id);

  const after = store.db.prepare('SELECT id, run_id, data FROM workflow_reviews WHERE run_id = ?').all(run.id);
  assert.deepEqual(after, before, 'the legacy workflow_reviews row must be read exactly as written, never mutated by the migration read path');
});

test('an ambiguous legacy review (two review nodes exist on the workflow) is never guess-attributed to either node', async (t) => {
  const { store, dataDir } = await fixture(t);
  const { workflow, run, episode, job, output } = await singleReviewRunFixture(store, dataDir, { reviewNodeCount: 2 });
  const legacyReview = { id: randomUUID(), decision: 'approved', notes: 'Pre-migration legacy decision.', reviewedAt: new Date().toISOString(), workflowId: workflow.id, workflowVersion: workflow.version, runId: run.id, episodeId: episode.id, episodeVersion: episode.version, jobId: job.id, outputUrl: output.outputUrl, sha256: output.sha256 };
  store.db.prepare('INSERT INTO workflow_reviews(id, run_id, data) VALUES (?, ?, ?)').run(legacyReview.id, run.id, JSON.stringify(legacyReview));

  const reviews = store.workflowNodeReviews(run.id);

  assert.deepEqual(reviews, [], 'an ambiguous legacy review (more than one review-type node) must never be guess-attributed to any node');
});

test('a trend upload referenced only through the new per-node review side table survives retention pruning', async (t) => {
  const { store } = await fixture(t);
  const oldEnough = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const referenced = store.save('uploads', { id: randomUUID(), createdAt: oldEnough, updatedAt: oldEnough, trend: true, url: '/api/uploads/referenced.jpg', filename: `${randomUUID()}.jpg`, type: 'image/jpeg', sha256: hash('referenced'), size: 100, kind: 'image' });
  const unreferenced = store.save('uploads', { id: randomUUID(), createdAt: oldEnough, updatedAt: oldEnough, trend: true, url: '/api/uploads/unreferenced.jpg', filename: `${randomUUID()}.jpg`, type: 'image/jpeg', sha256: hash('unreferenced'), size: 100, kind: 'image' });

  // The side table itself is the new pruning-reference surface under test; there is no public
  // write path for a bare node-review row outside a real commitWorkflowReview call, so this
  // exercises the raw schema the same way the migration itself must introduce it.
  store.db.prepare('INSERT INTO workflow_node_reviews(id, run_id, review_node_id, data) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), randomUUID(), 'review-fixture', JSON.stringify({ note: `Matches licensed source ${referenced.id}` }));

  const result = store.pruneTrendRetention();

  assert.ok(store.list('uploads').some((upload) => upload.id === referenced.id), 'an upload referenced only by the new per-node review table must survive pruning');
  assert.ok(!store.list('uploads').some((upload) => upload.id === unreferenced.id), 'an equally old, genuinely unreferenced upload must still be pruned, proving pruning is not vacuously disabled');
  assert.equal(result.removedMedia, 1);
});

// --- Channel externalId setter: optimistic concurrency and known-id format guarding.

test('setChannelExternalId stores a well-formed YouTube channel id and advances updatedAt under optimistic concurrency', async (t) => {
  const { store } = await fixture(t);
  const channel = makeChannel(store);
  const validUcId = 'UC1234567890abcdefghijkl';
  assert.equal(validUcId.length, 24);

  const updated = store.setChannelExternalId(channel.id, validUcId, channel.updatedAt);

  assert.equal(updated.externalId, validUcId);
  assert.notEqual(updated.updatedAt, channel.updatedAt, 'a successful write must advance the concurrency token');
  assert.deepEqual(store.get('channels', channel.id), updated);
});

test('setChannelExternalId rejects a stale expectedUpdatedAt and leaves the stored channel unchanged', async (t) => {
  const { store } = await fixture(t);
  const channel = makeChannel(store);
  const validUcId = 'UC1234567890abcdefghijkl';
  store.setChannelExternalId(channel.id, validUcId, channel.updatedAt);

  assert.throws(() => store.setChannelExternalId(channel.id, 'UCabcdefghijklmnopqrstuv', channel.updatedAt), (error) => error.status === 409, 'retrying with the pre-write updatedAt token must be rejected as stale, not silently re-applied');
  assert.equal(store.get('channels', channel.id).externalId, validUcId, 'a rejected stale write must never change the stored externalId');
});

test('setChannelExternalId rejects identifiers that are not well-formed YouTube channel ids', async (t) => {
  const { store } = await fixture(t);
  const channel = makeChannel(store);
  for (const invalid of ['not-a-channel-id', 'UCshort', `UC${'!'.repeat(22)}`, 'uc1234567890abcdefghijkl', 'UC1234567890abcdefghijklX']) {
    assert.throws(() => store.setChannelExternalId(channel.id, invalid, channel.updatedAt), (error) => error.status === 400, `"${invalid}" must be rejected as an invalid channel id`);
  }
  assert.equal(store.get('channels', channel.id).externalId, '', 'every rejected attempt must leave externalId unset');
});
