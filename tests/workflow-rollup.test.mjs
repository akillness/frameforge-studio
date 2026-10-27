import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

const integrations = {
  integrationStatus: async () => ({ studio: { available: true } }),
  runAgent: async () => { throw new Error('No provider configured'); },
  fetchTrends: async () => ({ trends: [], sources: [] }),
};

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-rollup-'));
  const server = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
  t.after(async () => {
    db.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (path, method = 'GET', body) => fetch(base + path, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const create = async (path, body) => {
    const response = await request(path, 'POST', body);
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  const channel = await create('/api/channels', { name: 'Rollup owner', category: 'information', platform: 'YouTube' });
  const episode = await create('/api/episodes', { channelId: channel.id, title: 'Rollup project', topic: 'Fixture' });
  const types = ['script', 'storyboard', 'render', 'review'];
  const nodes = types.map((type, i) => ({ id: type, type, x: i * 200, y: 100, config: type === 'script' ? { agent: 'studio', prompt: 'Original prompt' } : {} }));
  const template = await create('/api/workflows', { name: 'Shared workflow', nodes, edges: nodes.slice(1).map((node, i) => ({ id: `e${i}`, source: nodes[i].id, target: node.id })) });
  const copy = await create(`/api/workflows/${template.id}/copies`, { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const edit = async (workflow, changes) => {
    const response = await request(`/api/workflows/${workflow.id}`, 'PUT', { ...workflow, ...changes, expectedVersion: workflow.version });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const snapshot = () => Object.fromEntries(['entities', 'history', 'workflow_history', 'workflow_reviews', 'workflow_node_reviews'].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row }))]));
  const corrupt = (workflow, changes) => db.prepare("UPDATE entities SET data=? WHERE kind='workflows' AND id=?").run(JSON.stringify({ ...workflow, ...changes }), workflow.id);
  return { request, create, edit, snapshot, corrupt, db, channel, episode, template, copy };
}

const body = (workflow, template) => ({ expectedWorkflowVersion: workflow.version, expectedTemplateVersion: template.version });
const history = async (f, workflow) => (await f.request(`/api/workflows/${workflow.id}/history`)).json();
const workflows = async (f) => (await f.request('/api/workflows')).json();

test('rollup writes the project graph as the linked shared template next version without changing copies or past records', async (t) => {
  const f = await fixture(t);
  const otherEpisode = await f.create('/api/episodes', { channelId: f.channel.id, title: 'Other project', topic: 'Fixture' });
  const other = await f.create(`/api/workflows/${f.template.id}/copies`, { channelId: f.channel.id, episodeId: otherEpisode.id, expectedTemplateVersion: f.template.version });
  const nodes = f.copy.nodes.map((node) => node.id === 'script' ? { ...node, config: { ...node.config, prompt: 'Revised reusable prompt' } } : node);
  const edited = await f.edit(f.copy, { name: 'Reusable revised graph', nodes });
  const run = { id: 'historical-run', workflowId: edited.id, episodeId: f.episode.id, status: 'completed', workflowVersion: edited.version, workflowSnapshot: edited };
  f.db.prepare('INSERT INTO entities(kind,id,data) VALUES (?,?,?)').run('workflowRuns', run.id, JSON.stringify(run));
  f.db.prepare('INSERT INTO workflow_reviews(id,run_id,data) VALUES (?,?,?)').run('historical-review', run.id, JSON.stringify({ id: 'historical-review', runId: run.id, decision: 'approved' }));
  f.db.prepare('INSERT INTO workflow_node_reviews(id,run_id,review_node_id,data) VALUES (?,?,?,?)').run('historical-node-review', run.id, 'review', JSON.stringify({ id: 'historical-node-review', runId: run.id, reviewNodeId: 'review', decision: 'approved' }));
  const before = f.snapshot();
  const oldTemplateHistory = await history(f, f.template);
  const oldCopyHistory = await history(f, edited);
  const response = await f.request(`/api/workflows/${edited.id}/rollup`, 'POST', body(edited, f.template));
  assert.equal(response.status, 200, await response.clone().text());
  const all = await workflows(f);
  const updated = all.find((item) => item.id === f.template.id);
  assert.equal(updated.version, f.template.version + 1);
  assert.equal(updated.name, edited.name);
  assert.deepEqual(updated.nodes, edited.nodes);
  assert.deepEqual(updated.edges, edited.edges);
  assert.equal(updated.episodeId, undefined);
  assert.equal(updated.channelId, undefined);
  assert.deepEqual(all.find((item) => item.id === edited.id), edited);
  assert.deepEqual(all.find((item) => item.id === other.id), other);
  const newHistory = await history(f, f.template);
  assert.equal(newHistory.length, oldTemplateHistory.length + 1);
  assert.deepEqual(newHistory.slice(1), oldTemplateHistory);
  assert.deepEqual(newHistory[0].snapshot, updated);
  assert.ok(!newHistory[0].reason.includes(edited.id), 'shared template history must not expose the originating project workflow identity');
  assert.deepEqual(await history(f, edited), oldCopyHistory);
  const after = f.snapshot();
  for (const table of ['history', 'workflow_reviews', 'workflow_node_reviews']) assert.deepEqual(after[table], before[table]);
  for (const kind of ['workflowRuns', 'generationJobs', 'platformSessions', 'platformUploads', 'channels', 'episodes']) {
    assert.deepEqual(after.entities.filter((row) => row.kind === kind), before.entities.filter((row) => row.kind === kind), `${kind} must not change`);
  }
});

test('rollup requires positive expected revisions and rejects either stale revision without writes', async (t) => {
  const f = await fixture(t);
  const edited = await f.edit(f.copy, { name: 'Project revision' });
  const advanced = await f.edit(f.template, { name: 'Template revision' });
  const before = f.snapshot();
  const cases = [
    ['missing workflow revision', { expectedTemplateVersion: advanced.version }, 400],
    ['missing template revision', { expectedWorkflowVersion: edited.version }, 400],
    ['zero workflow revision', { ...body(edited, advanced), expectedWorkflowVersion: 0 }, 400],
    ['non-integer template revision', { ...body(edited, advanced), expectedTemplateVersion: 1.5 }, 400],
    ['stale workflow revision', { ...body(edited, advanced), expectedWorkflowVersion: f.copy.version }, 409],
    ['stale template revision', { ...body(edited, advanced), expectedTemplateVersion: f.template.version }, 409],
  ];
  for (const [name, input, status] of cases) {
    await t.test(name, async () => {
      const response = await f.request(`/api/workflows/${edited.id}/rollup`, 'POST', input);
      assert.equal(response.status, status, await response.clone().text());
      assert.deepEqual(f.snapshot(), before, 'rejected rollup must not write any records');
    });
  }
});

test('rollup rejects missing workflow, ownership, target, or shared-template relationship without writes', async (t) => {
  for (const scenario of ['missing workflow', 'shared source', 'missing episode', 'mismatched channel', 'missing template', 'owned template']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      let source = f.copy;
      if (scenario === 'missing episode') f.corrupt(source, { episodeId: 'missing-episode' });
      if (scenario === 'mismatched channel') f.corrupt(source, { channelId: 'wrong-channel' });
      if (scenario === 'missing template') f.corrupt(source, { templateId: 'missing-template' });
      if (scenario === 'owned template') {
        const second = await f.create(`/api/workflows/${f.template.id}/copies`, { channelId: f.channel.id, episodeId: f.episode.id, expectedTemplateVersion: f.template.version });
        f.corrupt(source, { templateId: second.id });
      }
      if (scenario === 'shared source') source = f.template;
      const before = f.snapshot();
      const id = scenario === 'missing workflow' ? 'missing-workflow' : source.id;
      const response = await f.request(`/api/workflows/${id}/rollup`, 'POST', body(source, f.template));
      assert.ok([400, 404, 409, 422].includes(response.status), `${scenario}: ${response.status} ${await response.clone().text()}`);
      assert.deepEqual(f.snapshot(), before, 'invalid lineage must not write any records');
    });
  }
});

test('rollup fails closed for project-specific generation targets and publish channel identity', async (t) => {
  for (const scenario of ['sceneId', 'slotId', 'sceneIndex', 'secret parameter', 'publish channel']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      const nodes = structuredClone(f.copy.nodes);
      const edges = structuredClone(f.copy.edges);
      if (scenario === 'publish channel') {
        nodes.push({ id: 'publish', type: 'publish', x: 900, y: 100, config: { channelId: f.channel.id, platform: 'youtube', visibility: 'private' } });
        edges.push({ id: 'publish-edge', source: 'review', target: 'publish' });
      } else {
        nodes.push({ id: 'generate', type: 'generate', x: 300, y: 200, config: { model: 'fixture', prompt: 'Visual', params: scenario === 'secret parameter' ? { api_key: 'private-secret' } : {}, sceneIndex: scenario === 'sceneIndex' ? 2 : 0, ...(scenario === 'sceneId' ? { sceneId: 'private-scene' } : scenario === 'slotId' ? { targetMode: 'slot', slotId: 'private-slot' } : {}) } });
        edges.push({ id: 'generate-in', source: 'storyboard', target: 'generate' }, { id: 'generate-out', source: 'generate', target: 'render' });
      }
      const edited = await f.edit(f.copy, { nodes, edges });
      const before = f.snapshot();
      const response = await f.request(`/api/workflows/${edited.id}/rollup`, 'POST', body(edited, f.template));
      if (scenario === 'publish channel' && response.status === 200) {
        const updated = (await workflows(f)).find((workflow) => workflow.id === f.template.id);
        const publish = updated.nodes.find((node) => node.id === 'publish');
        const { channelId, ...portableConfig } = edited.nodes.find((node) => node.id === 'publish').config;
        assert.equal(channelId, f.channel.id);
        assert.deepEqual(publish.config, portableConfig, 'only the known project binding may be removed');
        assert.deepEqual(updated.nodes.filter((node) => node.id !== 'publish'), edited.nodes.filter((node) => node.id !== 'publish'));
        assert.deepEqual(updated.edges, edited.edges);
        assert.deepEqual((await workflows(f)).find((workflow) => workflow.id === edited.id), edited);
      } else {
        assert.ok([400, 409, 422].includes(response.status), `${scenario} must fail closed: ${response.status} ${await response.clone().text()}`);
        assert.deepEqual(f.snapshot(), before, 'unsafe rollup must leave all records untouched');
      }
    });
  }
});

test('rollup rejects short project scene and slot identities embedded as exact node config values', async (t) => {
  for (const kind of ['scene', 'slot']) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      const scene = { ...f.episode.scenes[0], id: 'sc', slots: [{ id: 'sl', role: 'image-gen' }] };
      f.db.prepare("UPDATE entities SET data=? WHERE kind='episodes' AND id=?").run(JSON.stringify({ ...f.episode, scenes: [scene] }), f.episode.id);
      const identity = kind === 'scene' ? 'sc' : 'sl';
      const nodes = f.copy.nodes.map((node) => node.id === 'script' ? { ...node, config: { ...node.config, prompt: identity } } : node);
      const edited = await f.edit(f.copy, { nodes });
      const before = f.snapshot();
      const response = await f.request(`/api/workflows/${edited.id}/rollup`, 'POST', body(edited, f.template));
      assert.ok([400, 409, 422].includes(response.status), `project ${kind} identity must not enter a shared template`);
      assert.deepEqual(f.snapshot(), before, 'privacy rejection must leave all records untouched');
    });
  }
});

test('rollup rejects project media URLs and identities embedded in graph text without writes', async (t) => {
  for (const kind of ['scene upload URL', 'music upload URL', 'music source URL', 'music upload ID']) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      const sceneId = '01234567-89ab-cdef-0123-456789abcdef';
      const musicId = 'fedcba98-7654-3210-fedc-ba9876543210';
      const sceneUrl = `/api/uploads/${sceneId}.png`;
      const musicUrl = `/api/uploads/${musicId}.mp3`;
      const sourceUrl = 'https://example.com/private-music-source';
      const episode = { ...f.episode, scenes: [{ ...f.episode.scenes[0], kind: 'image', assetUrl: sceneUrl }], music: { assetUrl: musicUrl, start: 0, trimStart: 0, volume: 1, source: { origin: 'own', sourceUrl } } };
      f.db.prepare("UPDATE entities SET data=? WHERE kind='episodes' AND id=?").run(JSON.stringify(episode), episode.id);
      const value = { 'scene upload URL': sceneUrl, 'music upload URL': musicUrl, 'music source URL': sourceUrl, 'music upload ID': musicId }[kind];
      const nodes = f.copy.nodes.map((node) => node.id === 'script' ? { ...node, config: { ...node.config, prompt: `Use this private media: ${value}` } } : node);
      const edited = await f.edit(f.copy, { nodes });
      const before = f.snapshot();
      const response = await f.request(`/api/workflows/${edited.id}/rollup`, 'POST', body(edited, f.template));
      assert.equal(response.status, 400, `${kind} must not be copied into shared graph text`);
      assert.deepEqual(f.snapshot(), before, 'rejection must leave project, template, and histories untouched');
    });
  }
});

test('rollup rolls back the template update if its version snapshot cannot be saved', async (t) => {
  const f = await fixture(t);
  const edited = await f.edit(f.copy, { name: 'Must not partially save' });
  f.db.exec("CREATE TRIGGER fail_rollup_snapshot BEFORE INSERT ON workflow_history BEGIN SELECT RAISE(ABORT, 'fixture snapshot failure'); END");
  const before = f.snapshot();
  const response = await f.request(`/api/workflows/${edited.id}/rollup`, 'POST', body(edited, f.template));
  assert.equal(response.status, 500, 'snapshot failure must surface as a server error');
  assert.deepEqual(f.snapshot(), before, 'template and history must roll back together');
});
