import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowEditor } from '../public/workflow.js';

// Unit contracts at the controller's injected read API, not workflow-engine or
// browser execution. No Store records, providers, app globals, or DOM are used.
const OWNER_A = { episodeId: 'episode-a', channelId: 'channel-a' };
const OWNER_B = { episodeId: 'episode-b', channelId: 'channel-b' };

function graph(id, owner) {
  return {
    id, ...owner, version: 7, name: `Saved ${id}`,
    nodes: [
      { id: 'render-node', type: 'render', x: 40, y: 60, config: { format: '9:16', options: { subtitles: true } } },
      { id: 'review-node', type: 'review', x: 320, y: 60, config: {} },
    ],
    edges: [{ id: 'render-review', source: 'render-node', target: 'review-node' }],
  };
}

function run(workflow, { id = 'run-selected', status = 'completed', createdAt = '2026-10-25T12:00:00.000Z', ...rest } = {}) {
  return {
    id, workflowId: workflow.id, workflowVersion: workflow.version,
    episodeId: workflow.episodeId, episodeVersion: 3,
    status, createdAt, workflowSnapshot: structuredClone(workflow), nodeRuns: [],
    ...rest,
  };
}

function fixture(t, { workflows, runs = new Map(), owner = OWNER_A }) {
  const state = { workflows, runs };
  const delayedRuns = new Map();
  const editor = createWorkflowEditor({
    api: async (url, options) => {
      if (options?.method && options.method !== 'GET') throw new Error(`Unexpected write in read-only activity fixture: ${url}`);
      if (url === '/api/workflows') return structuredClone(state.workflows);
      const match = /^\/api\/workflows\/([^/]+)\/(runs|history)$/.exec(url);
      if (!match) throw new Error(`Unexpected activity fixture API: ${url}`);
      if (match[2] === 'history') return [];
      const delayed = delayedRuns.get(match[1]);
      if (delayed) {
        delayedRuns.delete(match[1]);
        delayed.requested();
        return structuredClone(await delayed.response);
      }
      return structuredClone(state.runs.get(match[1]) || []);
    },
  });
  t.after(() => editor.destroy()); // Clears the controller's live-run polling timer.
  if (owner) editor.bindProject(owner);
  return {
    editor, state,
    deferRuns(workflowId) {
      let requested, resolve;
      const request = new Promise(done => { requested = done; });
      const response = new Promise(done => { resolve = done; });
      delayedRuns.set(workflowId, { requested, response });
      return { requested: request, resolve };
    },
  };
}

function activity(episodeId, hasActiveRun, selectedRun) {
  return {
    episodeId, hasActiveRun,
    run: selectedRun ? { episodeId: selectedRun.episodeId, status: selectedRun.status } : null,
  };
}

test('unit activity contract: a selected completed result cannot hide another owned LIVE run', async t => {
  for (const status of ['queued', 'running', 'cancelling']) {
    await t.test(status, async t => {
      const workflow = graph('workflow-a', OWNER_A);
      const completed = run(workflow);
      const live = run(workflow, { id: 'run-older-live', status, createdAt: '2026-10-25T11:00:00.000Z' });
      // Persisted history reads, not two runs started by this test. The newer
      // terminal result is selected; the older live record must still gate edits.
      const f = fixture(t, { workflows: [workflow], runs: new Map([[workflow.id, [live, completed]]]) });
      await f.editor.load();
      assert.equal(f.editor.getContext().runId, completed.id, 'the observed result really is the completed run');
      assert.deepEqual(f.editor.getActivity(), activity(OWNER_A.episodeId, true, completed));
    });
  }
});

test('unit activity contract: repeated reads follow refreshed run transitions without rewriting previous projections', async t => {
  const workflow = graph('workflow-a', OWNER_A);
  const f = fixture(t, { workflows: [workflow] });
  const previous = [];
  for (const status of ['queued', 'running', 'cancelling', 'cancelled']) {
    const current = run(workflow, { status });
    f.state.runs.set(workflow.id, [current]);
    await f.editor.load(true);
    const result = f.editor.getActivity();
    const expected = activity(OWNER_A.episodeId, status !== 'cancelled', current);
    assert.deepEqual(result, expected, `the same workflow/run IDs must expose ${status} freshly`);
    previous.push({ result, expected: structuredClone(expected) });
    for (const prior of previous) assert.deepEqual(prior.result, prior.expected, 'a returned projection is not a shared mutable status cache');
  }
  f.state.runs.set(workflow.id, []);
  await f.editor.load(true);
  assert.deepEqual(f.editor.getActivity(), activity(OWNER_A.episodeId, false, null), 'removing the selected run clears its authority projection');
});

test('unit activity contract: rebinding isolates owners with shared node IDs and rejects a late prior-project response', async t => {
  const a = graph('workflow-a', OWNER_A), b = graph('workflow-b', OWNER_B);
  const aRunning = run(a, { status: 'running' }), bCompleted = run(b, { id: 'run-b' });
  const f = fixture(t, { workflows: [a, b], runs: new Map([[a.id, [aRunning]], [b.id, [bCompleted]]]) });
  await f.editor.load();
  assert.deepEqual(f.editor.getActivity(), activity(OWNER_A.episodeId, true, aRunning));

  const delayed = f.deferRuns(a.id);
  const refreshA = f.editor.load(true);
  await delayed.requested;
  try {
    f.editor.bindProject(OWNER_B);
    assert.deepEqual(f.editor.getActivity(), activity(OWNER_B.episodeId, false, null), 'binding B cannot temporarily report the stashed A run');
    await f.editor.load(true);
    assert.deepEqual(f.editor.getActivity(), activity(OWNER_B.episodeId, false, bCompleted));
  } finally {
    delayed.resolve([aRunning]);
    await refreshA;
  }
  assert.deepEqual(f.editor.getActivity(), activity(OWNER_B.episodeId, false, bCompleted), 'late A history cannot replace B activity');

  const aCancelled = run(a, { status: 'cancelled' });
  f.state.runs.set(a.id, [aCancelled]);
  f.editor.bindProject(OWNER_A);
  await f.editor.load(true);
  assert.deepEqual(f.editor.getActivity(), activity(OWNER_A.episodeId, false, aCancelled), 'returning to the same A graph/run/node IDs cannot retain the earlier running fact');
});

test('unit activity contract: unowned previews and mismatched run identities never acquire run authority', async t => {
  await t.test('the same template graph and node IDs remain unowned across project bindings', async t => {
    const template = graph('shared-template');
    const foreign = run(template, { episodeId: OWNER_A.episodeId, status: 'running' });
    const f = fixture(t, { workflows: [template], runs: new Map([[template.id, [foreign]]]), owner: null });
    await f.editor.load();
    assert.deepEqual(f.editor.getActivity(), activity(null, false, null), 'an unbound preview cannot claim a live run even before project filtering');
    for (const owner of [OWNER_A, OWNER_B, OWNER_A]) {
      f.editor.bindProject(owner);
      await f.editor.load(true);
      assert.deepEqual(f.editor.getActivity(), activity(owner.episodeId, false, null));
    }
  });

  for (const mismatch of [
    { name: 'wrong episode', fields: { episodeId: OWNER_B.episodeId } },
    { name: 'wrong workflow', fields: { workflowId: 'other-workflow' } },
  ]) {
    await t.test(mismatch.name, async t => {
      const workflow = graph('workflow-a', OWNER_A);
      // Deliberately foreign API response: a defensive read-boundary case, not
      // a claim that the production engine created an inconsistent execution.
      const foreign = run(workflow, mismatch.fields);
      const f = fixture(t, { workflows: [workflow], runs: new Map([[workflow.id, [foreign]]]) });
      await f.editor.load();
      assert.deepEqual(f.editor.getActivity(), activity(OWNER_A.episodeId, false, null));
      assert.equal(f.editor.getContext().runId, null, 'full context keeps the same run-identity exclusion');
    });
  }

  for (const status of ['queued', 'running', 'cancelling']) {
    await t.test(`same-episode wrong-workflow ${status} cannot own activity or hide an owned LIVE run`, async t => {
      const workflow = graph('workflow-a', OWNER_A);
      const foreign = run(workflow, {
        id: 'run-foreign', workflowId: 'other-workflow', status,
        createdAt: '2026-10-25T13:00:00.000Z',
      });
      const f = fixture(t, { workflows: [workflow], runs: new Map([[workflow.id, [foreign]]]) });
      await f.editor.load();
      assert.deepEqual(f.editor.getActivity(), activity(OWNER_A.episodeId, false, null), 'a same-episode foreign LIVE row cannot lock the current workflow');
      assert.equal(f.editor.getContext().runId, null, 'the foreign LIVE row cannot become the selected run');
      assert.equal(Object.hasOwn(f.editor.getContext(), 'run'), false, 'the foreign LIVE row cannot acquire snapshot authority; invalid runs remain omitted');

      const completed = run(workflow);
      const live = run(workflow, { id: 'run-owned-live', status, createdAt: '2026-10-25T11:00:00.000Z' });
      f.state.runs.set(workflow.id, [foreign, live, completed]);
      await f.editor.load(true);
      assert.deepEqual(f.editor.getActivity(), activity(OWNER_A.episodeId, true, completed), 'excluding the foreign row must retain the older owned LIVE lock and selected completed result');
      const context = f.editor.getContext();
      assert.equal(context.runId, completed.id, 'the newest foreign row cannot displace the owned completed selection');
      assert.deepEqual(context.run, completed, 'full context retains the selected owned result, not either LIVE row');
    });
  }

  await t.test('matching episode with a foreign channel cannot own the graph', async t => {
    const workflow = graph('workflow-a', OWNER_A);
    const active = run(workflow, { status: 'running' });
    const f = fixture(t, {
      workflows: [workflow], runs: new Map([[workflow.id, [active]]]),
      owner: { episodeId: OWNER_A.episodeId, channelId: OWNER_B.channelId },
    });
    await f.editor.load();
    assert.deepEqual(f.editor.getActivity(), activity(OWNER_A.episodeId, false, null));
  });
});

test('unit activity contract: projections are detached while getContext preserves full graph, run and review snapshots', async t => {
  const workflow = graph('workflow-a', OWNER_A);
  const candidate = run(workflow, {
    status: 'awaiting_review', selectedStages: ['render-node', 'review-node'],
    nodeRuns: [
      { nodeId: 'render-node', type: 'render', status: 'completed', output: { outputUrl: '/api/exports/candidate.mp4', sceneIds: ['scene-a'] } },
      { nodeId: 'review-node', type: 'review', status: 'awaiting_review' },
    ],
    reviews: {}, episodeSnapshot: { id: OWNER_A.episodeId, title: 'Saved candidate', scenes: [{ id: 'scene-a', text: 'Saved narration' }] },
  });
  candidate.workflowSnapshot.nodes[0].config.options.subtitles = false;
  const f = fixture(t, { workflows: [workflow], runs: new Map([[workflow.id, [candidate]]]) });
  await f.editor.load();
  const expectedContext = {
    workflowId: workflow.id, workflowVersion: workflow.version,
    episodeId: OWNER_A.episodeId, channelId: OWNER_A.channelId,
    selectedNodeId: 'render-node', hasActiveRun: false, runId: candidate.id,
    reviewNodeId: 'review-node', renderNodeId: 'render-node',
    workflow: structuredClone(workflow), run: structuredClone(candidate),
  };
  const context = f.editor.getContext();
  assert.deepEqual(context, expectedContext, 'getContext must retain its complete consumer-facing contract, including historical graph and outputs');
  const projection = f.editor.getActivity();
  assert.deepEqual(projection, activity(OWNER_A.episodeId, false, candidate));

  // Mutate nested snapshot fields, not merely the top-level result container.
  context.workflow.nodes[0].config.options.subtitles = false;
  context.workflow.edges[0].target = 'foreign-node';
  context.run.workflowSnapshot.nodes[0].config.options.subtitles = true;
  context.run.nodeRuns[0].output.sceneIds.push('foreign-scene');
  context.run.episodeSnapshot.scenes[0].text = 'Foreign narration';
  context.run.reviews['review-node'] = { decision: 'approved' };
  projection.episodeId = OWNER_B.episodeId;
  projection.hasActiveRun = true;
  projection.run.episodeId = OWNER_B.episodeId;
  projection.run.status = 'running';

  assert.deepEqual(f.editor.getActivity(), activity(OWNER_A.episodeId, false, candidate), 'consumer mutation cannot change the next authority query');
  assert.deepEqual(f.editor.getContext(), expectedContext, 'consumer mutation cannot change the internal graph, run, review selection or historical payloads');
});
