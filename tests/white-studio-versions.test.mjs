import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

const integrations = {
  integrationStatus: async () => ({ studio: { available: true } }),
  fetchTrends: async () => ({ trends: [], sources: [] }),
  runAgent: async () => { throw new Error('provider must not run in version guard tests'); },
};

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-white-versions-'));
  let providerCalls = 0;
  const guardedIntegrations = { ...integrations, runAgent: async (...args) => { providerCalls++; return integrations.runAgent(...args); } };
  const server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations: guardedIntegrations });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, method = 'GET', body) => fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const state = await (await request('/api/state')).json();
  const episode = await (await request('/api/episodes', 'POST', {
    channelId: state.channels[0].id,
    title: '버전 보호 에피소드',
    topic: '인용 검증',
  })).json();
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const template = state.workflows[0];
  const copied = await request(`/api/workflows/${template.id}/copies`, 'POST', { episodeId: episode.id, channelId: episode.channelId, expectedTemplateVersion: template.version });
  assert.equal(copied.status, 201);
  const workflow = await copied.json();
  assert.notEqual(workflow.id, template.id);
  assert.equal(workflow.episodeId, episode.id);
  return { request, workflow, episode, providerCalls: () => providerCalls };
}

async function runs(f, workflowId) {
  return (await f.request(`/api/workflows/${workflowId}/runs`)).json();
}

test('workflow run accepts matching version guards and preserves omitted compatibility', async (t) => {
  const f = await fixture(t);
  const matching = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', {
    episodeId: f.episode.id,
    expectedWorkflowVersion: f.workflow.version,
    expectedEpisodeVersion: f.episode.version,
  });
  assert.equal(matching.status, 202);
  const omitted = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id });
  assert.equal(omitted.status, 202);
  assert.equal(f.providerCalls(), 0);
});

test('workflow run rejects malformed and stale version guards before creating a run or calling a provider', async (t) => {
  const cases = [
    { name: 'malformed workflow version', expectedWorkflowVersion: '1' },
    { name: 'malformed episode version', expectedEpisodeVersion: 0 },
    { name: 'stale workflow version', expectedWorkflowVersion: 999 },
    { name: 'stale episode version', expectedEpisodeVersion: 999 },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const f = await fixture(subtest);
      const response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', { episodeId: f.episode.id, ...scenario });
      assert.equal(response.status, scenario.name.startsWith('malformed') ? 400 : 409);
      assert.equal(f.providerCalls(), 0);
      assert.deepEqual(await runs(f, f.workflow.id), []);
    });
  }
});

test('matching guards detect a cross-tab episode edit before any workflow run or provider call', async (t) => {
  const f = await fixture(t);
  const changed = await f.request(`/api/episodes/${f.episode.id}`, 'PUT', {
    ...f.episode,
    title: '다른 탭에서 수정됨',
    expectedVersion: f.episode.version,
  });
  assert.equal(changed.status, 200);
  const response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', {
    episodeId: f.episode.id,
    expectedWorkflowVersion: f.workflow.version,
    expectedEpisodeVersion: f.episode.version,
  });
  assert.equal(response.status, 409);
  assert.equal(f.providerCalls(), 0);
  assert.deepEqual(await runs(f, f.workflow.id), []);
});
