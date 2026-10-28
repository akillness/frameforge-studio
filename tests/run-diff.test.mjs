import test from 'node:test';
import assert from 'node:assert/strict';
import { digestNodeOutput, diffNodeOutputs, summarizeRun } from '../public/run-diff.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function isBoundedDigest(digest) {
  const keys = Object.keys(digest);
  if (keys.length > 8) return false;
  return keys.every(key => {
    const value = digest[key];
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return true;
    return typeof value === 'string' && value.length <= 80;
  });
}

// --- digestNodeOutput: per-type shape and bounds -------------------------

test('trend digest reports keyword count and up to three top keywords without echoing the full list', () => {
  const output = { query: 'AI', trends: [{ keyword: 'AI 반도체' }, { keyword: '금리 인하' }, { keyword: '전기차' }, { keyword: 'overflow' }] };
  const digest = digestNodeOutput('trend', output);
  assert.deepEqual(digest, { keywordCount: 4, topKeywords: 'AI 반도체, 금리 인하, 전기차' });
  assert.ok(isBoundedDigest(digest));
  assert.equal('trends' in digest, false);
});

test('news digest reports article count and up to three top titles', () => {
  const output = { articles: [{ headline: 'A' }, { headline: 'B' }, { headline: 'C' }, { headline: 'D' }] };
  const digest = digestNodeOutput('news', output);
  assert.deepEqual(digest, { articleCount: 4, topTitles: 'A, B, C' });
  assert.equal('articles' in digest, false);
});

test('research digest reports only the reference count', () => {
  assert.deepEqual(digestNodeOutput('research', { references: [{}, {}, {}], inputs: [{ huge: 'x'.repeat(5000) }] }), { referenceCount: 3 });
});

test('script digest reports scene count, first scene title and agent without echoing scene bodies', () => {
  const output = { agent: 'studio', mode: 'deterministic', scenes: [{ title: '훅', text: 'x'.repeat(5000) }, { title: '전개' }] };
  const digest = digestNodeOutput('script', output);
  assert.deepEqual(digest, { sceneCount: 2, title: '훅', agent: 'studio' });
  assert.equal('scenes' in digest, false);
  assert.ok(JSON.stringify(digest).length < 200);
});

test('storyboard digest reports only scene count', () => {
  assert.deepEqual(digestNodeOutput('storyboard', { episodeId: 'e1', version: 3, scenes: [{}, {}] }), { sceneCount: 2 });
});

test('layout digest reports preset and slot/scene counts', () => {
  assert.deepEqual(digestNodeOutput('layout', { preset: 'split', sceneCount: 3, slotCount: 5, scenes: [{}, {}, {}] }), { preset: 'split', slotCount: 5, sceneCount: 3 });
});

test('generate digest reports model, output count and a short job id', () => {
  const digest = digestNodeOutput('generate', { model: 'bytedance/seedance-2.5', generationJobId: '0123456789abcdef', outputs: [{}, {}] });
  assert.equal(digest.model, 'bytedance/seedance-2.5');
  assert.equal(digest.outputCount, 2);
  assert.equal(digest.jobId.length, 8);
  assert.ok(digest.jobId.endsWith('…'));
  assert.ok('0123456789abcdef'.startsWith(digest.jobId.slice(0, -1)));
});

test('render digest reports a short sha256 and byte size without the full hash', () => {
  const sha256 = 'a'.repeat(64);
  const digest = digestNodeOutput('render', { filename: 'x.mp4', outputUrl: '/api/exports/x.mp4', sha256, size: 1048576 });
  assert.equal(digest.sha256.length, 12);
  assert.ok(digest.sha256.endsWith('…'));
  assert.equal(digest.bytes, 1048576);
  assert.notEqual(digest.sha256, sha256);
});

test('review digest reports only the decision', () => {
  assert.deepEqual(digestNodeOutput('review', { message: 'long review copy'.repeat(20), decision: 'approved' }), { decision: 'approved' });
});

test('publish digest reports status and whether a destination URL exists, not the URL itself', () => {
  const digest = digestNodeOutput('publish', { status: 'staged', exportUrl: '/api/exports/x.mp4', channelId: 'c1' });
  assert.equal(digest.status, 'staged');
  assert.equal(digest.hasUrl, true);
  assert.equal('exportUrl' in digest, false);
});

test('an unrecognized node type falls back to a bounded set of primitive top-level fields', () => {
  const output = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
  output.nested = { deep: true };
  output.list = [1, 2, 3];
  const digest = digestNodeOutput('mystery-stage', output);
  assert.ok(Object.keys(digest).length <= 8);
  assert.equal('nested' in digest, false);
  assert.equal('list' in digest, false);
});

test('digestNodeOutput never throws and returns an empty object for missing, primitive or array output', () => {
  for (const value of [undefined, null, 'text', 42, true, [1, 2, 3]]) {
    assert.deepEqual(digestNodeOutput('trend', value), {});
  }
});

test('digest values stay within the key and string-length budget for every known node type', () => {
  const samples = {
    trend: { trends: [{ keyword: 'x'.repeat(60) }, { keyword: 'y'.repeat(60) }, { keyword: 'z'.repeat(60) }] },
    news: { articles: [{ headline: 'x'.repeat(60) }, { headline: 'y'.repeat(60) }, { headline: 'z'.repeat(60) }] },
    script: { agent: 'studio', scenes: [{ title: 'x'.repeat(200) }] },
    layout: { preset: 'x'.repeat(200), sceneCount: 1, slotCount: 1 },
  };
  for (const [type, output] of Object.entries(samples)) assert.ok(isBoundedDigest(digestNodeOutput(type, output)), `${type} digest exceeded bounds`);
});

test('hostile strings pass through digestNodeOutput as plain unescaped data', () => {
  const hostile = '<script>alert(1)</script>';
  const digest = digestNodeOutput('trend', { trends: [{ keyword: hostile }] });
  assert.ok(digest.topKeywords.includes(hostile));
  assert.equal(digest.topKeywords.includes('&lt;'), false);
});

test('digestNodeOutput is pure: it does not mutate its input and is deterministic', () => {
  const output = deepFreeze({ trends: [{ keyword: 'stable' }], query: 'q' });
  assert.doesNotThrow(() => digestNodeOutput('trend', output));
  assert.deepEqual(digestNodeOutput('trend', output), digestNodeOutput('trend', output));
});

// --- diffNodeOutputs: state machine and bounds ----------------------------

test('diffNodeOutputs reports same with no changes when both sides are absent', () => {
  assert.deepEqual(diffNodeOutputs('trend', undefined, undefined), { state: 'same', changes: [] });
  assert.deepEqual(diffNodeOutputs('trend', null, null), { state: 'same', changes: [] });
});

test('diffNodeOutputs reports same when the digested values are identical', () => {
  const before = { scenes: [{ title: '훅' }] };
  const after = { scenes: [{ title: '훅' }] };
  assert.deepEqual(diffNodeOutputs('storyboard', before, after), { state: 'same', changes: [] });
});

test('diffNodeOutputs reports added when a node produces its first output', () => {
  const result = diffNodeOutputs('research', undefined, { references: [{}, {}] });
  assert.equal(result.state, 'added');
  assert.deepEqual(result.changes, [{ label: '참고 자료 수', before: undefined, after: 2 }]);
});

test('diffNodeOutputs reports removed when a previously present output disappears', () => {
  const result = diffNodeOutputs('research', { references: [{}, {}] }, undefined);
  assert.equal(result.state, 'removed');
  assert.deepEqual(result.changes, [{ label: '참고 자료 수', before: 2, after: undefined }]);
});

test('diffNodeOutputs reports only the fields that actually changed, with Korean labels', () => {
  const before = { preset: 'split', slotCount: 2, sceneCount: 2 };
  const after = { preset: 'custom', slotCount: 4, sceneCount: 2 };
  const result = diffNodeOutputs('layout', before, after);
  assert.equal(result.state, 'changed');
  assert.deepEqual(result.changes, [
    { label: '레이아웃 프리셋', before: 'split', after: 'custom' },
    { label: '슬롯 수', before: 2, after: 4 },
  ]);
});

test('diffNodeOutputs caps changes at six even when more fields differ', () => {
  const before = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i]));
  const after = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, i + 100]));
  const result = diffNodeOutputs('mystery-stage', before, after);
  assert.equal(result.state, 'changed');
  assert.ok(result.changes.length <= 6);
  assert.equal(result.changes.length, 6);
});

test('diffNodeOutputs is pure: it does not mutate inputs and is deterministic', () => {
  const before = deepFreeze({ preset: 'split', slotCount: 2, sceneCount: 2 });
  const after = deepFreeze({ preset: 'custom', slotCount: 2, sceneCount: 2 });
  assert.doesNotThrow(() => diffNodeOutputs('layout', before, after));
  assert.deepEqual(diffNodeOutputs('layout', before, after), diffNodeOutputs('layout', before, after));
});

// --- summarizeRun: counts, trigger, changed, untouched --------------------

function run(overrides) {
  return { id: 'run-id', workflowId: 'wf-1', episodeId: 'ep-1', status: 'completed', createdAt: '2026-10-27T00:00:00.000Z', nodeRuns: [], ...overrides };
}

test('summarizeRun on a first run (no previousRun) counts every produced output as added, not same', () => {
  const current = run({
    execution: { mode: 'all', refresh: false },
    selectedStages: ['trend', 'research', 'script'],
    nodeRuns: [
      { nodeId: 'trend', type: 'trend', status: 'completed', output: { trends: [{ keyword: 'a' }] } },
      { nodeId: 'news', type: 'news', status: 'skipped', skipReason: 'unselected', error: 'unused' },
      { nodeId: 'research', type: 'research', status: 'completed', output: { references: [{}, {}] } },
      { nodeId: 'script', type: 'script', status: 'completed', output: { agent: 'studio', scenes: [{ title: '훅' }] } },
    ],
  });
  const summary = summarizeRun(current, undefined);
  assert.deepEqual(summary.counts, { ran: 3, reused: 0, kept: 0, skipped: 0, failed: 0, blocked: 1 });
  assert.equal(summary.trigger, '전체 실행');
  assert.equal(summary.changed.length, 3);
  assert.deepEqual(summary.changed.map(item => item.nodeId).sort(), ['research', 'script', 'trend']);
  assert.equal(summary.untouched, 1);
  assert.equal(summary.changed.length + summary.untouched, current.nodeRuns.length);
});

test('summarizeRun classifies reused, kept-with-retained-output, blocked-without-output and a real field change', () => {
  const previous = run({
    id: 'run-1',
    nodeRuns: [
      { nodeId: 'trend', type: 'trend', status: 'completed', output: { trends: [{ keyword: 'a' }] } },
      { nodeId: 'news', type: 'news', status: 'skipped', skipReason: 'unselected', error: 'unused' },
      { nodeId: 'research', type: 'research', status: 'completed', output: { references: [{}, {}] } },
      { nodeId: 'script', type: 'script', status: 'completed', output: { agent: 'studio', scenes: [{ title: '훅' }] } },
    ],
  });
  const current = run({
    id: 'run-2',
    resumedFrom: 'run-1',
    execution: { mode: 'node', targetNodeId: 'research' },
    nodeRuns: [
      { nodeId: 'trend', type: 'trend', status: 'completed', output: { trends: [{ keyword: 'a' }] }, reused: true, reusedFrom: 'run-1' },
      { nodeId: 'news', type: 'news', status: 'skipped', skipReason: 'unselected', error: 'unused' },
      { nodeId: 'research', type: 'research', status: 'completed', output: { references: [{}, {}, {}] } },
      { nodeId: 'script', type: 'script', status: 'skipped', skipReason: 'unselected', error: 'unused', retainedOutput: { agent: 'studio', scenes: [{ title: '훅' }] } },
    ],
  });
  const summary = summarizeRun(current, previous);
  assert.deepEqual(summary.counts, { ran: 1, reused: 1, kept: 1, skipped: 0, failed: 0, blocked: 1 });
  assert.equal(summary.trigger, '리서치 실행');
  assert.equal(summary.changed.length, 1);
  assert.equal(summary.changed[0].nodeId, 'research');
  assert.equal(summary.changed[0].state, 'changed');
  assert.deepEqual(summary.changed[0].changes, [{ label: '참고 자료 수', before: 2, after: 3 }]);
  assert.equal(summary.untouched, 3);
  assert.equal(summary.changed.length + summary.untouched, current.nodeRuns.length);
});

test('summarizeRun treats skipReason:"user" as skipped even when a retained output exists, distinct from unselected-with-output (kept)', () => {
  const current = run({
    selectedStages: [],
    nodeRuns: [
      { nodeId: 'publish', type: 'publish', status: 'skipped', skipReason: 'user', retainedOutput: { status: 'staged' } },
      { nodeId: 'review', type: 'review', status: 'skipped', skipReason: 'unselected', retainedOutput: { decision: 'approved' } },
    ],
  });
  const summary = summarizeRun(current, undefined);
  assert.deepEqual(summary.counts, { ran: 0, reused: 0, kept: 1, skipped: 1, failed: 0, blocked: 0 });
});

test('summarizeRun treats a legacy skipped node (no skipReason field at all) by presence of retainedOutput', () => {
  const withRetained = run({ nodeRuns: [{ nodeId: 'a', type: 'trend', status: 'skipped', error: 'Node was not selected for this execution', retainedOutput: { trends: [{ keyword: 'x' }] } }] });
  const withoutRetained = run({ nodeRuns: [{ nodeId: 'a', type: 'trend', status: 'skipped', error: 'Node was not selected for this execution' }] });
  assert.deepEqual(summarizeRun(withRetained, undefined).counts, { ran: 0, reused: 0, kept: 1, skipped: 0, failed: 0, blocked: 0 });
  assert.deepEqual(summarizeRun(withoutRetained, undefined).counts, { ran: 0, reused: 0, kept: 0, skipped: 0, failed: 0, blocked: 1 });
});

test('summarizeRun treats a staleFrom-marked node with no retained output as blocked, not kept', () => {
  const current = run({ nodeRuns: [{ nodeId: 'storyboard', type: 'storyboard', status: 'skipped', skipReason: 'unselected', staleFrom: 'run-1' }] });
  assert.deepEqual(summarizeRun(current, undefined).counts, { ran: 0, reused: 0, kept: 0, skipped: 0, failed: 0, blocked: 1 });
});

test('summarizeRun counts a failed node as failed regardless of any retained output', () => {
  const current = run({ nodeRuns: [{ nodeId: 'script', type: 'script', status: 'failed', error: 'provider unavailable', retainedOutput: { scenes: [] } }] });
  assert.deepEqual(summarizeRun(current, undefined).counts, { ran: 0, reused: 0, kept: 0, skipped: 0, failed: 1, blocked: 0 });
});

test('summarizeRun derives trigger text for mode:all with refresh:true, for an empty legacy selection by run status, and for a legacy full selection', () => {
  const refreshRun = run({ execution: { mode: 'all', refresh: true }, nodeRuns: [{ nodeId: 'a', type: 'trend', status: 'completed', output: {} }] });
  assert.equal(summarizeRun(refreshRun, undefined).trigger, '전체 새로고침 실행');

  const reviewOnlyRun = run({ status: 'awaiting_review', selectedStages: [], nodeRuns: [{ nodeId: 'review', type: 'review', status: 'awaiting_review', output: {} }] });
  assert.equal(summarizeRun(reviewOnlyRun, undefined).trigger, '검토 대기');

  const legacyFullRun = run({ selectedStages: ['a', 'b'], nodeRuns: [{ nodeId: 'a', type: 'trend', status: 'completed', output: {} }, { nodeId: 'b', type: 'research', status: 'completed', output: {} }] });
  assert.equal(summarizeRun(legacyFullRun, undefined).trigger, '전체 실행');

  const legacySingleRun = run({ selectedStages: ['a'], nodeRuns: [{ nodeId: 'a', type: 'trend', status: 'completed', output: {} }, { nodeId: 'b', type: 'research', status: 'skipped', skipReason: 'unselected' }] });
  assert.equal(summarizeRun(legacySingleRun, undefined).trigger, '트렌드 수집 실행');

  const legacyPartialRun = run({ selectedStages: ['a', 'c'], nodeRuns: [{ nodeId: 'a', type: 'trend', status: 'completed', output: {} }, { nodeId: 'b', type: 'research', status: 'skipped', skipReason: 'unselected' }, { nodeId: 'c', type: 'script', status: 'completed', output: {} }] });
  assert.equal(summarizeRun(legacyPartialRun, undefined).trigger, '선택 노드 실행');
});

test('summarizeRun merges a run-level review decision into the review node output before diffing', () => {
  const previous = run({ id: 'run-1', nodeRuns: [{ nodeId: 'review-1', type: 'review', status: 'awaiting_review', output: { message: '검토 대기 중' } }] });
  const current = run({ id: 'run-2', status: 'approved', nodeRuns: [{ nodeId: 'review-1', type: 'review', status: 'awaiting_review', output: { message: '검토 대기 중' } }], reviews: { 'review-1': { decision: 'approved' } } });
  const summary = summarizeRun(current, previous);
  assert.equal(summary.changed.length, 1);
  assert.equal(summary.changed[0].nodeId, 'review-1');
  assert.deepEqual(summary.changed[0].changes, [{ label: '검토 결정', before: undefined, after: 'approved' }]);
});

test('summarizeRun untouched plus changed length always equals the node run count, across varied fixtures', () => {
  const fixtures = [
    run({ nodeRuns: [{ nodeId: 'a', type: 'trend', status: 'completed', output: { trends: [{ keyword: 'x' }] } }] }),
    run({ nodeRuns: [{ nodeId: 'a', type: 'trend', status: 'skipped', skipReason: 'user' }, { nodeId: 'b', type: 'research', status: 'failed', error: 'x' }] }),
    run({ nodeRuns: [] }),
  ];
  for (const fixture of fixtures) {
    const summary = summarizeRun(fixture, undefined);
    assert.equal(summary.changed.length + summary.untouched, fixture.nodeRuns.length);
    assert.equal(Object.values(summary.counts).reduce((a, b) => a + b, 0), fixture.nodeRuns.length);
  }
});

test('summarizeRun is pure: it does not mutate run or previousRun and is deterministic', () => {
  const previous = deepFreeze(run({ id: 'run-1', nodeRuns: [{ nodeId: 'a', type: 'trend', status: 'completed', output: { trends: [{ keyword: 'a' }] } }] }));
  const current = deepFreeze(run({ id: 'run-2', execution: { mode: 'all', refresh: false }, nodeRuns: [{ nodeId: 'a', type: 'trend', status: 'completed', output: { trends: [{ keyword: 'b' }] } }] }));
  assert.doesNotThrow(() => summarizeRun(current, previous));
  assert.deepEqual(summarizeRun(current, previous), summarizeRun(current, previous));
});
