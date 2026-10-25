import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const baseIntegrations = {
  integrationStatus: async () => ({ studio: { available: true } }),
  fetchTrends: async () => ({ trends: [], sources: [] }),
};

async function fixture(t, { fetchTrends = baseIntegrations.fetchTrends } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-trends-api-'));
  let server = createApp({
    dataDir,
    loginToken: '',
    integrations: { ...baseIntegrations, fetchTrends },
  });
  let base;
  const start = async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  await start();
  t.after(async () => {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    request: (path, method = 'GET', body) => fetch(base + path, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    }),
    restart: async () => {
      await stop();
      server = createApp({ dataDir, loginToken: '', integrations: { ...baseIntegrations, fetchTrends } });
      await start();
    },
  };
}

async function body(response) {
  return response.json();
}

async function addTrend(f, keyword, suffix = keyword.toLowerCase()) {
  const response = await f.request('/api/trends', 'POST', {
    keyword,
    source: 'fixture',
    url: `https://example.test/trends/${suffix}`,
  });
  assert.equal(response.status, 201);
  return body(response);
}

test('trend collector settings persist through the API and survive restart', async (t) => {
  const f = await fixture(t);
  const update = await f.request('/api/trends/settings', 'PUT', {
    enabled: true,
    intervalMs: 2 * HOUR,
    retentionMs: 21 * DAY,
    maxConcurrency: 3,
  });
  assert.equal(update.status, 200);
  const updated = await body(update);
  assert.equal(updated.settings.enabled, true);
  assert.equal(updated.settings.intervalMs, 2 * HOUR);
  assert.equal(updated.settings.retentionMs, 21 * DAY);
  assert.equal(updated.settings.maxConcurrency, 3);
  assert.equal(updated.collector.settings.intervalMs, 2 * HOUR);
  assert.equal(updated.collector.settings.retentionMs, 21 * DAY);
  assert.equal((await f.request('/api/trends/status')).status, 200);

  await f.restart();
  const persisted = await body(await f.request('/api/trends/status'));
  assert.equal(persisted.settings.enabled, true);
  assert.equal(persisted.settings.intervalMs, 2 * HOUR);
  assert.equal(persisted.settings.retentionMs, 21 * DAY);
  assert.equal(persisted.settings.maxConcurrency, 3);
});

test('trend query, selected, pagination, and popular controls return semantic results', async (t) => {
  const f = await fixture(t);
  await addTrend(f, 'Alpha', 'alpha-1');
  await addTrend(f, 'Alpha', 'alpha-2');
  await addTrend(f, 'Beta', 'beta');
  await addTrend(f, 'Gamma', 'gamma');

  const select = await f.request('/api/trends/select', 'POST', { keyword: 'Beta', selected: true });
  assert.equal(select.status, 200);
  assert.equal((await body(select)).selected, true);

  const query = await body(await f.request('/api/trends?query=alp&limit=10'));
  assert.deepEqual(query.keywords.map((item) => ({ keyword: item.keyword, count: item.count })), [{ keyword: 'Alpha', count: 2 }]);
  assert.deepEqual(query.trends, query.keywords);

  const selected = await body(await f.request('/api/trends?selected=true&limit=10'));
  assert.deepEqual(selected.keywords.map((item) => item.keyword), ['Beta']);
  assert.equal(selected.keywords[0].selected, true);

  const page = await body(await f.request('/api/trends?limit=1&offset=1'));
  assert.deepEqual(page.keywords.map((item) => item.keyword), ['Beta']);

  const popular = await body(await f.request('/api/trends/popular?limit=2'));
  assert.deepEqual(popular.map((item) => ({ keyword: item.keyword, count: item.count })), [
    { keyword: 'Alpha', count: 2 },
    { keyword: 'Beta', count: 1 },
  ]);
});

test('trend API rejects invalid windows, settings, and selections without collection', async (t) => {
  let collectionCalls = 0;
  const f = await fixture(t, { fetchTrends: async () => { collectionCalls += 1; return { trends: [], sources: [] }; } });
  const invalidQueries = [
    '/api/trends?selected=maybe',
    '/api/trends?since=not-a-date',
    '/api/trends?limit=0',
    '/api/trends?limit=101',
    '/api/trends?offset=-1',
    `/api/trends?query=${'x'.repeat(301)}`,
  ];
  for (const path of invalidQueries) {
    const response = await f.request(path);
    assert.equal(response.status, 400, path);
    assert.match((await body(response)).error, /Trend|selected|date/i);
  }

  const invalidSettings = [
    { enabled: 'yes' },
    { intervalMs: 0 },
    { intervalMs: 1.5 },
    { retentionMs: 14 * DAY - 1 },
    { maxConcurrency: 0 },
  ];
  for (const patch of invalidSettings) {
    const response = await f.request('/api/trends/settings', 'PUT', patch);
    assert.equal(response.status, 400, JSON.stringify(patch));
  }
  for (const selection of [{ keyword: '', selected: true }, { keyword: 'Alpha', selected: 'true' }]) {
    const response = await f.request('/api/trends/select', 'POST', selection);
    assert.equal(response.status, 400, JSON.stringify(selection));
  }
  assert.equal(collectionCalls, 0);
});

test('failed trend collection is reported safely and retention pruning is reflected in the API', async (t) => {
  const failure = await fixture(t, { fetchTrends: async () => { throw new Error('fixture provider secret'); } });
  const failed = await failure.request('/api/trends/refresh', 'POST');
  assert.equal(failed.status, 500);
  const failedPayload = await body(failed);
  assert.equal(failedPayload.error, 'Operation failed. Check the local service logs.');
  assert.doesNotMatch(failedPayload.error, /fixture provider secret/);
  const failedStatus = await body(await failure.request('/api/trends/status'));
  assert.equal(failedStatus.lastRun.status, 'failed');
  assert.equal(failedStatus.lastError, 'fixture provider secret');

  const oldCapturedAt = '2000-01-01T00:00:00.000Z';
  const retained = await fixture(t, {
    fetchTrends: async () => ({
      trends: [{ keyword: 'expired-via-api', source: 'fixture', url: 'https://example.test/expired', capturedAt: oldCapturedAt }],
      sources: [{ name: 'fixture', status: 'ok', count: 1 }],
    }),
  });
  const settings = await retained.request('/api/trends/settings', 'PUT', { retentionMs: 14 * DAY });
  assert.equal(settings.status, 200);
  const refreshed = await retained.request('/api/trends/refresh', 'POST');
  assert.equal(refreshed.status, 200);
  const summary = await body(refreshed);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.inserted, 1);
  assert.ok(summary.pruned >= 1);
  const expired = await body(await retained.request('/api/trends?query=expired-via-api'));
  assert.deepEqual(expired.keywords, []);
  const runs = await body(await retained.request('/api/trends/runs?limit=1'));
  assert.equal(runs[0].status, 'completed');
  assert.ok(runs[0].pruned >= 1);
});
