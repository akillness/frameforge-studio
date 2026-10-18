import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, starterScene } from '../server/store.mjs';
import { TrendCollector } from '../server/trend-collector.mjs';

const later = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function eventually(predicate, message = 'condition did not settle') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await later();
  }
  assert.fail(message);
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'frameforge-trend-'));
  const store = new Store(root);
  const collector = new TrendCollector({ store, ...options });
  t.after(() => {
    collector.close();
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  return { root, store, collector };
}

const trendResult = (trends = []) => ({
  trends: trends.map((keyword, index) => ({ keyword, source: 'fixture', url: `https://example.test/trends/${index}` })),
  sources: [{ name: 'fixture', status: 'ok', count: trends.length }],
});

test('collection is disabled by default and starts only after explicit enablement', async (t) => {
  let calls = 0;
  const f = await fixture(t, { fetchTrends: async () => { calls += 1; return trendResult(['disabled']); } });
  assert.equal(f.store.getTrendCollectorSettings().enabled, false);
  f.collector.start();
  await later();
  assert.equal(calls, 0);

  f.store.saveTrendCollectorSettings({ enabled: true });
  const result = await f.collector.runNow();
  assert.equal(calls, 1);
  assert.equal(result.trends[0].keyword, 'disabled');
  assert.equal(f.store.listTrendKeywords({ limit: 10 })[0].keyword, 'disabled');
});

test('concurrent runNow calls never overlap collection calls', async (t) => {
  const entered = deferred();
  const release = deferred();
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const f = await fixture(t, {
    concurrency: 1,
    fetchTrends: async () => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      entered.resolve();
      await release.promise;
      active -= 1;
      return trendResult(['serialized']);
    },
  });
  f.store.saveTrendCollectorSettings({ enabled: true });
  const first = f.collector.runNow();
  await entered.promise;
  const second = f.collector.runNow();
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(maximum, 1);
  assert.equal(active, 0);
  assert.equal(calls, 1);
});

test('failed collection is persisted with a future retry and successful retry clears the failure', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    fetchTrends: async () => {
      calls += 1;
      if (calls === 1) throw new Error('fixture source unavailable');
      return trendResult(['recovered']);
    },
  });
  f.store.saveTrendCollectorSettings({ enabled: true });
  await assert.rejects(f.collector.runNow(), /fixture source unavailable/);
  const failed = f.store.listTrendCollectionRuns({ limit: 1 })[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /fixture source unavailable/);
  assert.ok(Date.parse(failed.nextDueAt) > Date.parse(failed.startedAt));

  const statusWhileBackedOff = f.collector.status();
  assert.ok(Date.parse(statusWhileBackedOff.nextDueAt) >= Date.parse(failed.nextDueAt));
  await f.collector.runNow({ force: true });
  assert.equal(calls, 2);
  const succeeded = f.store.listTrendCollectionRuns({ limit: 1 })[0];
  assert.equal(succeeded.status, 'completed');
  assert.equal(f.store.listTrendKeywords({ limit: 10 })[0].keyword, 'recovered');
});

test('stop prevents a queued retry from starting and close is idempotent', async (t) => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const f = await fixture(t, {
    fetchTrends: async () => {
      calls += 1;
      entered.resolve();
      await release.promise;
      return trendResult(['shutdown']);
    },
  });
  f.store.saveTrendCollectorSettings({ enabled: true });
  const first = f.collector.runNow();
  await entered.promise;
  f.collector.stop();
  const queued = f.collector.runNow();
  release.resolve();
  await Promise.allSettled([first, queued]);
  assert.equal(calls, 1);
  f.collector.close();
  f.collector.close();
});
test('close persists a terminal interruption before an in-flight fetch can finish', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    fetchTrends: async () => { entered.resolve(); await release.promise; return trendResult(['late']); },
  });
  f.store.saveTrendCollectorSettings({ enabled: true });
  const pending = f.collector.runNow();
  await entered.promise;
  const beforeClose = f.store.listTrendCollectionRuns({ limit: 1 })[0];
  const closed = f.collector.close();
  const interrupted = f.store.get('trendCollectionRuns', beforeClose.id);
  assert.equal(interrupted.status, 'failed');
  assert.match(interrupted.error, /interrupted|shutdown/i);
  assert.ok(Date.parse(interrupted.nextDueAt) > Date.parse(interrupted.startedAt));
  assert.equal(closed.running, false);
  release.resolve();
  await assert.rejects(pending, /closed|interrupted/i);
});

test('enabled due state survives restart and is collected once after the interval', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'frameforge-trend-restart-'));
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  let calls = 0;
  const now = () => new Date(clock).toISOString();
  let store = new Store(root);
  store.saveTrendCollectorSettings({ enabled: true, intervalMs: 60_000 });
  let collector = new TrendCollector({ store, now, fetchTrends: async () => { calls += 1; return trendResult(['restart']); } });
  await collector.runNow({ force: true });
  assert.equal(calls, 1);
  collector.close();
  store.close();

  clock += 60_001;
  store = new Store(root);
  collector = new TrendCollector({ store, now, fetchTrends: async () => { calls += 1; return trendResult(['restart']); } });
  t.after(() => { collector.close(); store.close(); return rm(root, { recursive: true, force: true }); });
  collector.start();
  await eventually(() => calls === 2, 'due collection did not resume after restart');
  assert.equal(store.listTrendCollectionRuns({ limit: 10 }).filter((run) => run.status === 'completed').length, 2);
});
test('restart converts an interrupted run into a future retry instead of replaying stale due state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'frameforge-trend-interrupted-'));
  let store = new Store(root);
  store.saveTrendCollectorSettings({ enabled: true, intervalMs: 60_000, nextDueAt: '2000-01-01T00:00:00.000Z' });
  const run = store.create('trendCollectionRuns', { status: 'running', startedAt: '2000-01-01T00:00:00.000Z', nextDueAt: '2000-01-01T00:00:00.000Z', error: null });
  store.close();
  const restartStarted = Date.now();
  store = new Store(root);
  let calls = 0;
  const collector = new TrendCollector({ store, fetchTrends: async () => { calls += 1; return trendResult(['must-wait']); } });
  t.after(() => { collector.close(); store.close(); return rm(root, { recursive: true, force: true }); });
  const recovered = store.get('trendCollectionRuns', run.id);
  assert.equal(recovered.status, 'failed');
  assert.match(recovered.error, /restarted/i);
  assert.ok(Date.parse(recovered.nextDueAt) > restartStarted);
  assert.equal(store.getTrendCollectorSettings().nextDueAt, recovered.nextDueAt);
  collector.start();
  await later();
  assert.equal(calls, 0);
});

test('keyword reads support query, selected filter, pagination and bounded popular results', async (t) => {
  const f = await fixture(t);
  const capturedAt = '2026-01-10T00:00:00.000Z';
  f.store.collectTrendSnapshot({ trends: [
    { keyword: 'Alpha', source: 'fixture', url: 'https://example.test/a', capturedAt },
    { keyword: 'Alpha', source: 'fixture', url: 'https://example.test/a2', capturedAt },
    { keyword: 'Beta', source: 'fixture', url: 'https://example.test/b', capturedAt },
    { keyword: 'Gamma', source: 'fixture', url: 'https://example.test/c', capturedAt },
  ], sources: [{ name: 'fixture', status: 'ok' }] }, { now: capturedAt });
  f.store.setTrendKeywordSelection('Beta', true);
  const selected = f.store.listTrendKeywords({ selected: true, limit: 10 });
  assert.deepEqual(selected.map((item) => item.keyword), ['Beta']);
  assert.deepEqual(f.store.listTrendKeywords({ query: 'alp', limit: 10 }).map((item) => item.keyword), ['Alpha']);
  assert.deepEqual(f.store.listTrendKeywords({ limit: 1, offset: 1 }).map((item) => item.keyword), ['Beta']);
  const popular = f.store.listPopularTrendKeywords({ since: '2026-01-01T00:00:00.000Z', limit: 2 });
  assert.equal(popular.length, 2);
  assert.equal(popular[0].keyword, 'Alpha');
  assert.ok(popular[0].count >= popular[1].count);
});

test('14-day retention removes old trend snapshots and related media while preserving authored state', async (t) => {
  const f = await fixture(t);
  const now = '2026-01-15T00:00:00.000Z';
  const old = '2025-12-31T23:59:59.000Z';
  f.store.collectTrendSnapshot({ trends: [{ keyword: 'expired', source: 'fixture', url: 'https://example.test/expired', capturedAt: old, mediaUrl: '/api/uploads/trend-old.png' }], sources: [] }, { now: old });
  f.store.collectTrendSnapshot({ trends: [{ keyword: 'fresh', source: 'fixture', url: 'https://example.test/fresh', capturedAt: now }], sources: [] }, { now });
  const channelId = f.store.list('channels')[0].id;
  const scene = { ...starterScene('Authored media', 'Keep historical reference'), kind: 'image', assetUrl: '/api/uploads/trend-old.png' };
  const episode = f.store.create('episodes', { title: 'Authored', topic: 'Keep', channelId, version: 1, status: 'draft', format: '9:16', scenes: [scene] });
  const editedScene = { ...scene, kind: 'title' };
  delete editedScene.assetUrl;
  const editedEpisode = f.store.updateEpisode(episode.id, { title: 'Authored edit', scenes: [editedScene] }, 1);
  const authored = f.store.create('uploads', { filename: 'authored.png', url: '/api/uploads/authored.png', kind: 'image', generated: false, createdAt: old });
  const trendMedia = f.store.create('uploads', { filename: 'trend-old.png', url: '/api/uploads/trend-old.png', kind: 'image', generated: true, trend: true, trendKeyword: 'expired', createdAt: old });
  const beforeHistory = f.store.history(episode.id);
  const workflow = f.store.create('workflows', { name: 'Authored workflow', version: 1, nodes: [], edges: [] });
  const sha256 = 'a'.repeat(64);
  const job = f.store.create('jobs', { episodeId: episode.id, episodeVersion: editedEpisode.version, status: 'completed', outputUrl: '/api/exports/authored.mp4', sha256 });
  const run = f.store.create('workflowRuns', { workflowId: workflow.id, episodeId: episode.id, episodeVersion: editedEpisode.version, workflowVersion: 1, status: 'awaiting_review', nodeRuns: [
    { type: 'render', status: 'completed', output: { jobId: job.id, outputUrl: job.outputUrl, episodeVersion: editedEpisode.version, sha256 } },
    { type: 'review', status: 'awaiting_review' },
  ] });
  f.store.commitWorkflowReview(workflow.id, run.id, { decision: 'approved', notes: 'Keep authored review', expectedEpisodeVersion: editedEpisode.version, jobId: job.id, outputUrl: job.outputUrl, sha256 });
  const beforeReviews = f.store.workflowReviews(run.id);

  assert.equal(beforeReviews.length, 1);
  const result = f.store.pruneTrendRetention({ now });
  assert.ok(result.removed >= 1);
  assert.deepEqual(f.store.listTrendKeywords({ limit: 10 }).map((item) => item.keyword), ['fresh']);
  assert.equal(f.store.get('uploads', trendMedia.id).id, trendMedia.id);
  assert.deepEqual(f.store.history(episode.id), beforeHistory);
  assert.deepEqual(f.store.workflowReviews(run.id), beforeReviews);
});
test('retention reports media unlink failures after committing database cleanup', async (t) => {
  const f = await fixture(t);
  const now = '2026-01-15T00:00:00.000Z';
  const old = '2025-12-31T23:59:59.000Z';
  const filename = '123e4567-e89b-12d3-a456-426614174000.png';
  await mkdir(join(f.root, 'uploads', filename));
  const media = f.store.create('uploads', { filename, url: `/api/uploads/${filename}`, kind: 'image', trend: true, createdAt: old });
  f.store.collectTrendSnapshot({ trends: [{ keyword: 'unlink-failure', source: 'fixture', capturedAt: old }], sources: [] }, { now: old });
  const result = f.store.pruneTrendRetention({ now });
  assert.equal(result.cleanupFailures, 1);
  assert.throws(() => f.store.get('uploads', media.id), /not found/);
  assert.equal((await stat(join(f.root, 'uploads', filename))).isDirectory(), true);
  assert.deepEqual(f.store.listTrendKeywords({ limit: 10 }), []);
});
