import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createHook } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { Store } from '../server/store.mjs';
import { defaultWorkflow } from '../server/workflows.mjs';
import { YouTubeOAuth } from '../server/youtube-oauth.mjs';
import { PublicationService } from '../server/publication.mjs';
import { candidateFingerprint } from '../server/graph.mjs';
import { requiredMediaCredits } from '../server/media-credits.mjs';

// Server-only contract tests for 1.5 (persistent skip) and its planner interactions
// (1.2/1.3). No browser, no real provider calls: every graph below uses deterministic
// node types (research/script[agent:'existing']) that never touch runAgent/fetchTrends.

const SKIPPED_TARGET_MESSAGE = '건너뛰기가 설정된 노드입니다. 건너뛰기를 해제한 뒤 실행하세요.';
const SKIPPED_PREREQUISITE_MESSAGE = '건너뛴 선행 노드에 저장된 결과가 없어 실행할 수 없습니다.';

const node = (id, type, config = {}) => ({ id, type, x: 0, y: 0, config });
const edgeList = (pairs) => pairs.map(([source, target], i) => ({ id: `e${i}`, source, target }));
const graph = (name, nodes, pairs) => ({ name, nodes, edges: edgeList(pairs) });
const record = (run, id) => run.nodeRuns.find((item) => item.nodeId === id);

// p1, p2 both feed mid; mid feeds tail. No hard dependencies anywhere: lets us
// distinguish a user-skipped node (p1) from a merely-unselected one (p2) while mid is
// genuinely required (direct parent of the resumed target) and tail always runs.
const GRAPH_SIMPLE = graph('Skip fixture simple', [
  node('p1', 'research'), node('p2', 'research'), node('mid', 'research'), node('tail', 'research'),
], [['p1', 'mid'], ['p2', 'mid'], ['mid', 'tail']]);

// storyboard's HARD_DEPENDENCY prerequisite is script (nearest upstream of type 'script').
const GRAPH_HARD = graph('Skip fixture hard dependency', [
  node('script', 'script', { agent: 'existing' }), node('storyboard', 'storyboard'),
], [['script', 'storyboard']]);

// ctx is a plain connected producer of doc with no HARD_DEPENDENCY/optional-context role
// for the 'script' type: skipping it must never block doc.
const GRAPH_OMIT = graph('Skip fixture omitted producer', [
  node('ctx', 'research'), node('doc', 'script', { agent: 'existing' }),
], [['ctx', 'doc']]);

// Full paid-generation chain for section 5.B (SB*) tests: extra is a connected but
// unrelated ancestor of script, never part of any selection below, used to prove a skip
// toggle on a node OUTSIDE the quoted/run/approved selection cannot perturb it.
const RENDER_BYTES = Buffer.from('frameforge workflow-skip fixture render, not a real MP4');
const RENDER_SHA256 = createHash('sha256').update(RENDER_BYTES).digest('hex');
const GEN_BYTES = Buffer.from('frameforge workflow-skip fixture generated image');
const DISCLOSURE = { containsSyntheticMedia: true, rationale: 'Fixture illustration only, reviewed before quoting' };
const GRAPH_GENERATE = graph('Skip fixture generation chain', [
  node('extra', 'research'), node('script', 'script', { agent: 'existing' }), node('storyboard', 'storyboard'),
  node('generate', 'generate', { model: 'fixture_image', prompt: 'Illustrate fixture', sceneIndex: 0 }),
  node('render', 'render'), node('review', 'review'), node('publish', 'publish'),
], [['extra', 'script'], ['script', 'storyboard'], ['storyboard', 'generate'], ['generate', 'render'], ['render', 'review'], ['review', 'publish']]);
const GENERATE_NON_PUBLISH = ['script', 'storyboard', 'generate', 'render'];

// extra(no hard-dependency role) -> mid -> tail: for section 5.D, "a skipped node
// WITHOUT a reusable output does not make its descendants dirty by itself".
const GRAPH_DIRTY = graph('Skip fixture dirty propagation', [
  node('extra', 'research'), node('mid', 'research'), node('tail', 'research'),
], [['extra', 'mid'], ['mid', 'tail']]);

async function fixture(t, { loginToken = '', withGeneration = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-skip-'));
  const forbidden = async () => { throw new Error('Unexpected external or provider operation'); };
  let submits = 0;
  let app, base;
  const startServer = async () => {
    app = createApp({
      dataDir, loginToken, publicOrigin: '',
      integrations: { integrationStatus: async () => ({}), runAgent: forbidden, fetchTrends: forbidden },
      generation: withGeneration ? {
        capability: async () => ({ available: true }), models: forbidden,
        modelSchema: async (model) => ({ id: model, type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
        estimate: async () => ({ cost: 1, currency: 'USD', quoted: true }),
        create: async () => { submits++; return { requestId: `fixture-provider-${submits}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] }; },
        status: forbidden,
      } : { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
      generationOptions: withGeneration ? {
        download: async (_url, file) => { await writeFile(file, GEN_BYTES); return { bytes: GEN_BYTES.length, contentType: 'image/png' }; },
        probe: async () => ({ kind: 'image', width: 64, height: 64 }),
      } : undefined,
      renderer: withGeneration ? async (episode, { dataDir: root, sceneIntegrity }) => {
        const filename = `${randomUUID()}.mp4`;
        await writeFile(join(root, 'exports', filename), RENDER_BYTES);
        return { filename, outputUrl: `/api/exports/${filename}`, sha256: RENDER_SHA256, ...(sceneIntegrity ? { verifiedSceneAssets: sceneIntegrity } : {}) };
      } : forbidden,
      mediaOptions: { fetchImpl: forbidden },
      youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
      publicationOptions: { fetchImpl: forbidden },
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.address().port}`;
  };
  await startServer();
  const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
  const stop = () => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
  t.after(async () => {
    db.close();
    try { if (app.listening) await stop(); }
    finally { await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });

  const rawRequest = (path, method = 'GET', body, headers = {}) => fetch(base + path, {
    method, headers: { origin: base, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let authHeaders = {};
  const request = (path, method = 'GET', body, headers = {}) => rawRequest(path, method, body, { ...authHeaders, ...headers });
  const api = async (path, method = 'GET', body, headers) => {
    const response = await request(path, method, body, headers);
    const value = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };

  if (loginToken) {
    const login = await rawRequest('/api/login', 'POST', { token: loginToken });
    assert.equal(login.status, 200, 'fixture login must succeed');
    authHeaders = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  }

  const channel = await api('/api/channels', 'POST', { name: 'Skip owner', category: 'information', platform: 'YouTube' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Skip project', topic: 'Skip fixture' });

  const own = async (bodyGraph) => {
    const template = await api('/api/workflows', 'POST', bodyGraph);
    return api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  };

  const wait = async (id) => {
    for (let i = 0; i < 5000; i++) {
      const run = await api(`/api/workflow-runs/${id}`);
      if (['completed', 'failed', 'cancelled', 'awaiting_review', 'approved', 'changes_requested'].includes(run.status)) return run;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`Run ${id} did not finish`);
  };
  const start = (workflow, body) => request(`/api/workflows/${workflow.id}/run`, 'POST', {
    episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version, ...body,
  });
  const startAndWait = async (workflow, body) => {
    const response = await start(workflow, body);
    assert.equal(response.status, 202, await response.clone().text());
    return wait((await response.json()).id);
  };
  const quote = (workflow, body) => request(`/api/workflows/${workflow.id}/quote`, 'POST', {
    episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version, ...body,
  });
  const plan = (workflow, execution, extra = {}) => request(`/api/workflows/${workflow.id}/plan`, 'POST', {
    episodeId: episode.id, execution, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version, ...extra,
  });
  const skip = (workflow, nodeId, skipped, expectedVersion) => request(`/api/workflows/${workflow.id}/skips`, 'POST', {
    nodeId, skipped, expectedVersion: expectedVersion ?? workflow.version,
  });
  const editWorkflow = (workflow, changes, expectedVersion) => api(`/api/workflows/${workflow.id}`, 'PUT', {
    ...workflow, ...changes, expectedVersion: expectedVersion ?? workflow.version,
  });
  const restore = (workflow, version, expectedVersion) => request(`/api/workflows/${workflow.id}/restore`, 'POST', {
    version, expectedVersion: expectedVersion ?? workflow.version,
  });
  const archive = (ep) => api(`/api/episodes/${ep.id}/archive`, 'POST', { expectedVersion: ep.version });
  const decideReview = (workflow, run, decision = 'approved') => {
    const reviewNodeId = record(run, 'review').nodeId;
    return api(`/api/workflows/${workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId, decision, notes: 'Fixture review notes', expectedEpisodeVersion: run.episodeVersion });
  };

  const events = (type) => db.prepare("SELECT data FROM entities WHERE kind='events' ORDER BY rowid").all()
    .map((row) => JSON.parse(row.data)).filter((item) => !type || item.type === type);
  const rawEntities = () => db.prepare('SELECT kind,id,data FROM entities ORDER BY kind,id').all()
    .map((row) => ({ kind: row.kind, id: row.id, data: JSON.parse(row.data) }));
  const historyRows = (id) => db.prepare('SELECT data FROM workflow_history WHERE workflow_id=? ORDER BY version DESC').all(id)
    .map((row) => JSON.parse(row.data));

  const otherProject = async () => {
    const otherChannel = await api('/api/channels', 'POST', { name: 'Unrelated owner', category: 'information', platform: 'YouTube' });
    const otherEpisode = await api('/api/episodes', 'POST', { channelId: otherChannel.id, title: 'Unrelated project', topic: 'Unrelated' });
    const template = await api('/api/workflows', 'POST', graph('Unrelated graph', [node('solo', 'research')], []));
    const otherWorkflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: otherChannel.id, episodeId: otherEpisode.id, expectedTemplateVersion: template.version });
    return { channel: otherChannel, episode: otherEpisode, workflow: otherWorkflow };
  };

  const restart = async () => { await stop(); await startServer(); };
  const currentEpisode = async () => (await api('/api/state')).episodes.find((item) => item.id === episode.id);

  return {
    api, request, rawRequest, own, wait, start, startAndWait, quote, plan, skip, editWorkflow, restore, archive, decideReview,
    events, rawEntities, historyRows, otherProject, restart, currentEpisode, channel, episode, db,
  };
}

// ---------------------------------------------------------------------------
// S1: persistence shape, version/history untouched, event recorded, isolation,
// unskip, survives restart.
// ---------------------------------------------------------------------------

test('POST /api/workflows/:id/skips persists sorted unique skippedNodes without bumping version or history, records workflows.skipped, leaves unrelated data untouched, supports unskip, and survives a restart', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_SIMPLE);
  const other = await f.otherProject();
  const historyBefore = await f.api(`/api/workflows/${workflow.id}/history`);
  const eventsBefore = f.events();
  const otherSnapshotBefore = f.rawEntities().filter((row) => ['workflows', 'episodes', 'uploads'].includes(row.kind));

  const tailResponse = await f.skip(workflow, 'tail', true, workflow.version);
  assert.equal(tailResponse.status, 200, await tailResponse.clone().text());
  const afterTail = await tailResponse.json();
  assert.deepEqual(afterTail.skippedNodes, ['tail']);
  assert.equal(afterTail.version, workflow.version);

  const midResponse = await f.skip(workflow, 'mid', true, afterTail.version);
  const afterMid = await midResponse.json();
  assert.equal(midResponse.status, 200, JSON.stringify(afterMid));

  const p2Response = await f.skip(workflow, 'p2', true, afterMid.version);
  const afterP2 = await p2Response.json();
  assert.equal(p2Response.status, 200, JSON.stringify(afterP2));

  // re-skip an already-skipped node to the SAME value: per section 5.B/SB2 this is a
  // no-op (no write, no event) -- skippedNodes must still read back sorted/unique.
  const dupeResponse = await f.skip(workflow, 'mid', true, afterP2.version);
  const afterDupe = await dupeResponse.json();
  assert.equal(dupeResponse.status, 200, JSON.stringify(afterDupe));
  assert.deepEqual(afterDupe.skippedNodes, ['mid', 'p2', 'tail'], 'skippedNodes must be sorted and unique');
  assert.equal(afterDupe.version, workflow.version, 'skip must never bump workflow.version');
  assert.equal(afterDupe.updatedAt, workflow.updatedAt, 'section 5.B (binding, supersedes 1.5 \'bumps updatedAt\' wording): setWorkflowSkip must leave updatedAt untouched so hashed evidence built from the workflow object is unaffected by a skip toggle');

  const historyAfter = await f.api(`/api/workflows/${workflow.id}/history`);
  assert.equal(historyAfter.length, historyBefore.length, 'skip must not write a workflow_history snapshot');

  const skipEvents = f.events('workflows.skipped');
  assert.equal(skipEvents.length, 3, 'one workflows.skipped event per CHANGING skip call; the same-value re-skip of mid is a no-op per section 5.B/SB2 and records none');
  assert.ok(skipEvents.every((item) => item.entityId === workflow.id));
  assert.equal(f.events().length, eventsBefore.length + 3, 'no other event kind was recorded');

  const untouchedAfter = f.rawEntities().filter((row) => ['workflows', 'episodes', 'uploads'].includes(row.kind) && row.id !== workflow.id);
  const untouchedBefore = otherSnapshotBefore.filter((row) => row.id !== workflow.id);
  assert.deepEqual(untouchedAfter, untouchedBefore, 'unrelated workflows, episodes and media must not change');
  assert.deepEqual((await f.api('/api/workflows')).find((w) => w.id === other.workflow.id), other.workflow);

  const unskipResponse = await f.skip(workflow, 'mid', false, afterDupe.version);
  const afterUnskip = await unskipResponse.json();
  assert.equal(unskipResponse.status, 200, JSON.stringify(afterUnskip));
  assert.deepEqual(afterUnskip.skippedNodes, ['p2', 'tail'], 'unskip removes exactly that id');
  assert.equal(afterUnskip.version, workflow.version);
  assert.equal(f.events('workflows.skipped').length, 4, 'unskip is a genuine true->false change: a 4th event (3 changing skips + this unskip)');

  await f.restart();
  const reloaded = (await f.api('/api/workflows')).find((w) => w.id === workflow.id);
  assert.deepEqual(reloaded.skippedNodes, ['p2', 'tail'], 'skip state survives an app restart on the same data dir');
  assert.equal(reloaded.version, workflow.version);
});

// ---------------------------------------------------------------------------
// S2: normal PUT save preserves/prunes, restore prunes, copies start clean.
// ---------------------------------------------------------------------------

test('a normal PUT save preserves skippedNodes, bumps version, and the workflow_history snapshot carries no skip state', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_SIMPLE);
  const skipResponse = await f.skip(workflow, 'mid', true, workflow.version);
  const skipped = await skipResponse.json();
  assert.equal(skipResponse.status, 200, JSON.stringify(skipped));
  assert.deepEqual(skipped.skippedNodes, ['mid']);

  const edited = await f.editWorkflow(skipped, { name: 'Renamed simple graph' });
  assert.deepEqual(edited.skippedNodes, ['mid'], 'a normal save must preserve skippedNodes');
  assert.equal(edited.version, skipped.version + 1, 'a normal save must still bump version');

  const [latestSnapshot] = f.historyRows(workflow.id);
  assert.equal(latestSnapshot.version, edited.version);
  assert.ok(!('skippedNodes' in latestSnapshot.snapshot), 'the versioned history snapshot must not carry skip state');
});

test('a PUT that deletes a node prunes its id from skippedNodes while keeping other skipped ids', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_SIMPLE);
  await f.skip(workflow, 'p1', true, workflow.version);
  const secondSkip = await (await f.skip(workflow, 'p2', true, workflow.version)).json();
  assert.deepEqual(secondSkip.skippedNodes, ['p1', 'p2']);

  const trimmed = graph('Skip fixture simple', [node('p1', 'research'), node('mid', 'research'), node('tail', 'research')], [['p1', 'mid'], ['mid', 'tail']]);
  const edited = await f.editWorkflow(secondSkip, trimmed);
  assert.deepEqual(edited.skippedNodes, ['p1'], 'deleting p2 must prune it from skippedNodes but keep p1');
});

test('restoring to an older workflow version prunes skippedNodes ids unknown to that version', async (t) => {
  const f = await fixture(t);
  const v1 = graph('Prune fixture', [node('p1', 'research')], []);
  const workflow = await f.own(v1);
  const v2 = await f.editWorkflow(workflow, graph('Prune fixture', [node('p1', 'research'), node('p2', 'research')], [['p1', 'p2']]));
  const skipResponse = await f.skip(v2, 'p2', true, v2.version);
  const skipped = await skipResponse.json();
  assert.equal(skipResponse.status, 200, JSON.stringify(skipped));
  assert.deepEqual(skipped.skippedNodes, ['p2']);

  const restoreResponse = await f.restore(skipped, 1, skipped.version);
  assert.equal(restoreResponse.status, 200, await restoreResponse.clone().text());
  const restored = await restoreResponse.json();
  assert.deepEqual(restored.skippedNodes ?? [], [], 'restoring to v1 (no p2) must prune the unknown skipped id');
  assert.equal(restored.nodes.length, 1);
});

test('a template copy starts with no skipped nodes, independent of skips on a sibling project copy', async (t) => {
  const f = await fixture(t);
  const template = await f.api('/api/workflows', 'POST', GRAPH_SIMPLE);
  const workflowA = await f.api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: f.channel.id, episodeId: f.episode.id, expectedTemplateVersion: template.version });
  assert.deepEqual(workflowA.skippedNodes ?? [], []);
  const skipResponse = await f.skip(workflowA, 'p1', true, workflowA.version);
  assert.equal(skipResponse.status, 200, await skipResponse.clone().text());

  const otherEpisode = await f.api('/api/episodes', 'POST', { channelId: f.channel.id, title: 'Sibling project', topic: 'Sibling' });
  const workflowB = await f.api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: f.channel.id, episodeId: otherEpisode.id, expectedTemplateVersion: template.version });
  assert.deepEqual(workflowB.skippedNodes ?? [], [], 'a fresh copy must never inherit skips from a sibling project copy');
});

// ---------------------------------------------------------------------------
// S3: validation and authorization error paths.
// ---------------------------------------------------------------------------

test('skip requires a project-owned workflow, an existing node id, a boolean skipped flag, and a matching expectedVersion', async (t) => {
  const f = await fixture(t);
  const template = await f.api('/api/workflows', 'POST', GRAPH_SIMPLE);
  const templateSkip = await f.skip(template, 'p1', true, template.version);
  assert.equal(templateSkip.status, 409, await templateSkip.clone().text());
  assert.equal((await templateSkip.json()).error, 'Skip applies to project workflows');

  const workflow = await f.own(GRAPH_SIMPLE);

  const unknownNode = await f.skip(workflow, 'no-such-node', true, workflow.version);
  assert.ok([400, 404].includes(unknownNode.status), `expected 400 or 404 for an unknown node, got ${unknownNode.status}`);

  const nonBoolean = await f.request(`/api/workflows/${workflow.id}/skips`, 'POST', { nodeId: 'p1', skipped: 'yes', expectedVersion: workflow.version });
  assert.equal(nonBoolean.status, 400, await nonBoolean.clone().text());

  const staleVersion = await f.skip(workflow, 'p1', true, workflow.version + 1);
  assert.equal(staleVersion.status, 409, await staleVersion.clone().text());

  // none of the rejected attempts above may have mutated anything: this must still succeed
  // against the original, unchanged version.
  const ok = await f.skip(workflow, 'p1', true, workflow.version);
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual((await ok.json()).skippedNodes, ['p1']);
});

test('skip requires authentication and rejects a cross-site write like other mutating routes', async (t) => {
  const f = await fixture(t, { loginToken: 'skip-fixture-token' });
  const workflow = await f.own(GRAPH_SIMPLE);

  const unauthenticated = await f.rawRequest(`/api/workflows/${workflow.id}/skips`, 'POST', { nodeId: 'p1', skipped: true, expectedVersion: workflow.version });
  assert.equal(unauthenticated.status, 401, await unauthenticated.clone().text());

  const crossSite = await f.request(`/api/workflows/${workflow.id}/skips`, 'POST', { nodeId: 'p1', skipped: true, expectedVersion: workflow.version }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403, await crossSite.clone().text());
});

// ---------------------------------------------------------------------------
// S4: planner interactions with skipped nodes.
// ---------------------------------------------------------------------------

test('plan mode "all" never selects a skipped node, marks it action "skip", and reports it in skippedNodeIds', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_SIMPLE);
  const skipped = await (await f.skip(workflow, 'p2', true, workflow.version)).json();

  const response = await f.plan(skipped, { mode: 'all' });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.blocked, false);
  assert.deepEqual(body.skippedNodeIds, ['p2']);
  assert.ok(!body.selectedStages.includes('p2'), 'a skipped node must never appear in selectedStages');
  assert.deepEqual(body.selectedStages, ['p1', 'mid', 'tail']);
  const p2Entry = body.nodes.find((item) => item.nodeId === 'p2');
  assert.equal(p2Entry.action, 'skip');
});

test('plan mode "node" targeting a skipped node is blocked with code skipped_target and the exact Korean message', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_SIMPLE);
  const skipped = await (await f.skip(workflow, 'mid', true, workflow.version)).json();

  const response = await f.plan(skipped, { mode: 'node', targetNodeId: 'mid' });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.selectedStages, []);
  assert.equal(body.blocked.code, 'skipped_target');
  assert.ok(body.blocked.message.startsWith(SKIPPED_TARGET_MESSAGE), body.blocked.message);
});

test('a skipped hard-prerequisite node with a reusable saved output is reused (not rerun), and the target still runs', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_HARD);
  const scriptRun = await f.startAndWait(workflow, { selectedStages: ['script'], startStage: 'script' });
  assert.equal(scriptRun.status, 'completed', JSON.stringify(scriptRun));
  const skipped = await (await f.skip(workflow, 'script', true, workflow.version)).json();

  const planResponse = await f.plan(skipped, { mode: 'node', targetNodeId: 'storyboard' });
  assert.equal(planResponse.status, 200, await planResponse.clone().text());
  const planBody = await planResponse.json();
  assert.equal(planBody.blocked, false);
  assert.deepEqual(planBody.selectedStages, ['storyboard']);
  assert.equal(planBody.resumeRunId, scriptRun.id);
  const scriptEntry = planBody.nodes.find((item) => item.nodeId === 'script');
  assert.equal(scriptEntry.action, 'skip');

  const storyboardRun = await f.startAndWait(workflow, { selectedStages: ['storyboard'], startStage: 'storyboard', resumeRunId: scriptRun.id });
  assert.equal(storyboardRun.status, 'completed', JSON.stringify(storyboardRun));
  const scriptNodeRun = record(storyboardRun, 'script');
  assert.equal(scriptNodeRun.status, 'completed', 'a required-reuse hard prerequisite keeps the existing reuse mechanism, not the skip status');
  assert.equal(scriptNodeRun.reused, true);
  assert.equal(scriptNodeRun.reusedFrom, scriptRun.id);
});

test('a skipped hard prerequisite with no saved output blocks a node that needs it, in both mode "node" and mode "all"', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_HARD);
  const skipped = await (await f.skip(workflow, 'script', true, workflow.version)).json();

  const nodeResponse = await f.plan(skipped, { mode: 'node', targetNodeId: 'storyboard' });
  assert.equal(nodeResponse.status, 200, await nodeResponse.clone().text());
  const nodeBody = await nodeResponse.json();
  assert.deepEqual(nodeBody.selectedStages, []);
  assert.equal(nodeBody.blocked.code, 'skipped_prerequisite');
  assert.ok(nodeBody.blocked.message.startsWith(SKIPPED_PREREQUISITE_MESSAGE), nodeBody.blocked.message);

  const allResponse = await f.plan(skipped, { mode: 'all' });
  assert.equal(allResponse.status, 200, await allResponse.clone().text());
  const allBody = await allResponse.json();
  assert.deepEqual(allBody.selectedStages, []);
  assert.equal(allBody.blocked.code, 'skipped_prerequisite');

  const runResponse = await f.start(workflow, { selectedStages: ['storyboard'], startStage: 'storyboard' });
  assert.equal(runResponse.status, 409, await runResponse.clone().text());
});

test('plan mode "all" refresh:true drops the source, so a skipped hard prerequisite blocks even if it completed earlier', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_HARD);
  const sourceRun = await f.startAndWait(workflow, { selectedStages: ['script', 'storyboard'], startStage: 'script' });
  assert.equal(sourceRun.status, 'completed', JSON.stringify(sourceRun));
  const skipped = await (await f.skip(workflow, 'script', true, workflow.version)).json();
  const episodeAfterStoryboard = await f.currentEpisode();

  const response = await f.plan(skipped, { mode: 'all', refresh: true }, { expectedEpisodeVersion: episodeAfterStoryboard.version });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.resumeRunId, null, 'refresh must drop the source');
  assert.equal(body.blocked.code, 'skipped_prerequisite');
  assert.deepEqual(body.selectedStages, []);
});

test('skipping a connected producer that is not a hard prerequisite is simply omitted, never blocks, and the downstream node still runs', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_OMIT);
  const skipped = await (await f.skip(workflow, 'ctx', true, workflow.version)).json();

  const response = await f.plan(skipped, { mode: 'node', targetNodeId: 'doc' });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.blocked, false);
  assert.equal(body.resumeRunId, null);
  assert.deepEqual(body.selectedStages, ['doc']);
  const ctxEntry = body.nodes.find((item) => item.nodeId === 'ctx');
  assert.equal(ctxEntry.action, 'skip');

  const docRun = await f.startAndWait(workflow, { selectedStages: ['doc'], startStage: 'doc' });
  assert.equal(docRun.status, 'completed', JSON.stringify(docRun));
});

// ---------------------------------------------------------------------------
// S5: legacy /run and /quote reject an explicit selectedStages with a skipped node.
// ---------------------------------------------------------------------------

test('legacy /run and /quote reject an explicit selectedStages that contains a skipped node with the exact Korean message', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_SIMPLE);
  const skipped = await (await f.skip(workflow, 'mid', true, workflow.version)).json();

  const runResponse = await f.start(skipped, { selectedStages: ['p1', 'mid'], startStage: 'p1' });
  assert.equal(runResponse.status, 409, await runResponse.clone().text());
  assert.ok((await runResponse.json()).error.startsWith(SKIPPED_TARGET_MESSAGE));

  const quoteResponse = await f.quote(skipped, { selectedStages: ['p1', 'mid'], startStage: 'p1' });
  assert.equal(quoteResponse.status, 409, await quoteResponse.clone().text());
  assert.ok((await quoteResponse.json()).error.startsWith(SKIPPED_TARGET_MESSAGE));
});

// ---------------------------------------------------------------------------
// S6: nodeRun fields distinguish user-skip from merely-unselected.
// ---------------------------------------------------------------------------

test('a run marks a user-skipped node {status:"skipped", skipReason:"user"} without the legacy error, while a merely unselected node keeps its error and skipReason:"unselected", preserving retained lineage for both', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_SIMPLE);
  const sourceRun = await f.startAndWait(workflow, { selectedStages: ['p1', 'p2', 'mid', 'tail'], startStage: undefined });
  assert.equal(sourceRun.status, 'completed', JSON.stringify(sourceRun));
  const skipped = await (await f.skip(workflow, 'p1', true, workflow.version)).json();

  const resumedRun = await f.startAndWait(workflow, { selectedStages: ['tail'], startStage: 'tail', resumeRunId: sourceRun.id });
  assert.equal(resumedRun.status, 'completed', JSON.stringify(resumedRun));

  const p1Run = record(resumedRun, 'p1');
  assert.equal(p1Run.status, 'skipped');
  assert.equal(p1Run.skipReason, 'user');
  assert.equal(p1Run.error, undefined, 'a user-skipped node must not carry the legacy English error');
  assert.deepEqual(p1Run.retainedOutput, record(sourceRun, 'p1').output);
  assert.equal(p1Run.retainedFrom, sourceRun.id);

  const p2Run = record(resumedRun, 'p2');
  assert.equal(p2Run.status, 'skipped');
  assert.equal(p2Run.skipReason, 'unselected');
  assert.equal(p2Run.error, 'Node was not selected for this execution');
  assert.deepEqual(p2Run.retainedOutput, record(sourceRun, 'p2').output);
  assert.equal(p2Run.retainedFrom, sourceRun.id);

  const midRun = record(resumedRun, 'mid');
  assert.equal(midRun.status, 'completed');
  assert.equal(midRun.reused, true);
  assert.equal(midRun.reusedFrom, sourceRun.id);
});

// ---------------------------------------------------------------------------
// S7: skip toggling does not invalidate resume evidence.
// ---------------------------------------------------------------------------

test('toggling skip between two runs does not invalidate the earlier terminal run as resume evidence', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_SIMPLE);
  const sourceRun = await f.startAndWait(workflow, { selectedStages: ['p1', 'p2', 'mid', 'tail'], startStage: undefined });
  assert.equal(sourceRun.status, 'completed', JSON.stringify(sourceRun));

  const afterOn = await (await f.skip(workflow, 'p2', true, workflow.version)).json();
  assert.equal(afterOn.version, workflow.version, 'skip must not bump version between runs');
  const afterOff = await (await f.skip(workflow, 'p2', false, afterOn.version)).json();
  assert.equal(afterOff.version, workflow.version);

  const resumed = await f.start(afterOff, { selectedStages: ['tail'], startStage: 'tail', resumeRunId: sourceRun.id });
  assert.equal(resumed.status, 202, await resumed.clone().text());
  const finished = await f.wait((await resumed.json()).id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.equal(finished.resumedFrom, sourceRun.id, 'toggling skip must not force the resume to be rejected as incompatible provenance');
});

// ---------------------------------------------------------------------------
// S8: version/optimistic concurrency and archived-episode rejection.
// ---------------------------------------------------------------------------

test('skipping never bumps version, so a stale expectedVersion from a concurrent edit is rejected while the current version still succeeds', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_SIMPLE);
  const afterSkip = await (await f.skip(workflow, 'p1', true, workflow.version)).json();
  assert.equal(afterSkip.version, workflow.version);

  const edited = await f.editWorkflow(afterSkip, { name: 'Concurrently edited' }, workflow.version);
  assert.equal(edited.version, workflow.version + 1);
  assert.deepEqual(edited.skippedNodes, ['p1']);

  const staleSkip = await f.skip(workflow, 'p2', true, workflow.version);
  assert.equal(staleSkip.status, 409, await staleSkip.clone().text());

  const freshSkip = await f.skip(workflow, 'p2', true, edited.version);
  assert.equal(freshSkip.status, 200, await freshSkip.clone().text());
  const afterFresh = await freshSkip.json();
  assert.deepEqual(afterFresh.skippedNodes, ['p1', 'p2']);
  assert.equal(afterFresh.version, edited.version);
});

test('an archived episode rejects skip the same way it rejects other workflow writes', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_SIMPLE);
  const archived = await f.archive(f.episode);
  assert.equal(archived.status, 'archived');

  const response = await f.skip(workflow, 'p1', true, workflow.version);
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error, 'Episode is archived. Unarchive it before editing or production.');
});

// ---------------------------------------------------------------------------
// Section 5 addendum (binding, 2026-10-27, independent review): SB1-SB3 (skip must not
// alter hashed evidence) and SD1 (re-verifying 5.D, skipped producers / dirty propagation).
// ---------------------------------------------------------------------------

test('SB1a: toggling skip on a node outside the quoted selection does not invalidate the quote -- /run with the SAME quote still succeeds', async (t) => {
  const f = await fixture(t, { withGeneration: true });
  const workflow = await f.own(GRAPH_GENERATE);
  const quoteResponse = await f.quote(workflow, { selectedStages: GENERATE_NON_PUBLISH, startStage: 'script', disclosure: DISCLOSURE });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const plan = await quoteResponse.json();

  const skipped = await (await f.skip(workflow, 'extra', true, workflow.version)).json();
  assert.equal(skipped.skippedNodes?.length ? skipped.skippedNodes[0] : undefined, 'extra');

  const runResponse = await f.start(workflow, {
    selectedStages: GENERATE_NON_PUBLISH, startStage: 'script', disclosure: DISCLOSURE,
    allowGeneration: true, generationPlanId: plan.id, generationFingerprint: plan.fingerprint, acceptUnquotedEstimate: true,
  });
  assert.equal(runResponse.status, 202, await runResponse.clone().text());
  const run = await f.wait((await runResponse.json()).id);
  assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.equal(record(run, 'generate').status, 'completed');
});

test('SB1b: a skip toggle on an unrelated node does not move an existing publication approval to stale or blocked -- a publish-only resume still succeeds', async (t) => {
  const f = await fixture(t, { withGeneration: true });
  const workflow = await f.own(GRAPH_GENERATE);
  const sourceStages = ['script', 'storyboard', 'generate', 'render', 'review'];
  const quoteResponse = await f.quote(workflow, { selectedStages: sourceStages, startStage: 'script', disclosure: DISCLOSURE });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const plan = await quoteResponse.json();
  const runResponse = await f.start(workflow, {
    selectedStages: sourceStages, startStage: 'script', disclosure: DISCLOSURE,
    allowGeneration: true, generationPlanId: plan.id, generationFingerprint: plan.fingerprint, acceptUnquotedEstimate: true,
  });
  assert.equal(runResponse.status, 202, await runResponse.clone().text());
  const sourceRun = await f.wait((await runResponse.json()).id);
  assert.equal(sourceRun.status, 'awaiting_review', JSON.stringify(sourceRun));
  const approved = await f.decideReview(workflow, sourceRun, 'approved');
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  const episodeAfterApproval = await f.currentEpisode();

  // Toggle skip on 'extra' -- unrelated to the already-approved render/review branch.
  const skipped = await (await f.skip(workflow, 'extra', true, workflow.version)).json();
  assert.deepEqual(skipped.skippedNodes, ['extra']);

  const publishResponse = await f.start(workflow, { selectedStages: ['publish'], startStage: 'publish', resumeRunId: approved.id, expectedEpisodeVersion: episodeAfterApproval.version });
  assert.equal(publishResponse.status, 202, await publishResponse.clone().text());
  const publishRun = await f.wait((await publishResponse.json()).id);
  assert.equal(publishRun.status, 'approved', JSON.stringify(publishRun));
  assert.equal(record(publishRun, 'publish').status, 'completed', 'the publish node itself must have run and completed');
  assert.equal(record(publishRun, 'publish').output.status, 'staged');

  // Unskip and prove the SAME publication resume is still accepted (toggling again later
  // must not retroactively stale an already-staged publication either).
  await f.skip(workflow, 'extra', false, workflow.version);
  const secondPublishResponse = await f.start(workflow, { selectedStages: ['publish'], startStage: 'publish', resumeRunId: approved.id, expectedEpisodeVersion: episodeAfterApproval.version });
  assert.equal(secondPublishResponse.status, 202, await secondPublishResponse.clone().text());
});

test('SB2: toggling skip to its current value is a true no-op -- no write, no workflows.skipped event, updatedAt identical', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_SIMPLE);
  const skipped = await (await f.skip(workflow, 'p1', true, workflow.version)).json();
  assert.deepEqual(skipped.skippedNodes, ['p1']);

  const rowBefore = f.rawEntities().find((row) => row.kind === 'workflows' && row.id === workflow.id);
  const eventsBefore = f.events('workflows.skipped').length;

  const noopOn = await f.skip(workflow, 'p1', true, skipped.version);
  assert.equal(noopOn.status, 200, await noopOn.clone().text());
  const afterNoopOn = await noopOn.json();
  assert.deepEqual(afterNoopOn.skippedNodes, ['p1']);
  assert.equal(afterNoopOn.updatedAt, skipped.updatedAt);

  const rowAfterOn = f.rawEntities().find((row) => row.kind === 'workflows' && row.id === workflow.id);
  assert.deepEqual(rowAfterOn, rowBefore, 'an unchanged skip:true->true toggle must write nothing to the entities row');
  assert.equal(f.events('workflows.skipped').length, eventsBefore, 'an unchanged toggle must record no workflows.skipped event');

  // Same proof for the false->false direction, on a node that was never skipped.
  const noopOff = await f.skip(workflow, 'p2', false, skipped.version);
  assert.equal(noopOff.status, 200, await noopOff.clone().text());
  assert.deepEqual((await noopOff.json()).skippedNodes, ['p1']);
  const rowAfterOff = f.rawEntities().find((row) => row.kind === 'workflows' && row.id === workflow.id);
  assert.deepEqual(rowAfterOff, rowBefore, 'an unchanged skip:false->false toggle must write nothing to the entities row');
  assert.equal(f.events('workflows.skipped').length, eventsBefore, 'an unchanged false->false toggle must record no event either');
});

test('SB3: the quote/generation-plan fingerprint for the same selection is identical before and after a skip toggle on an unrelated node', async (t) => {
  const f = await fixture(t, { withGeneration: true });
  const workflow = await f.own(GRAPH_GENERATE);
  const selection = { selectedStages: GENERATE_NON_PUBLISH, startStage: 'script', disclosure: DISCLOSURE };

  const before = await (await f.quote(workflow, selection)).json();
  const skipped = await (await f.skip(workflow, 'extra', true, workflow.version)).json();
  assert.equal(skipped.version, workflow.version, 'skip must not bump version between the two quotes');
  const after = await (await f.quote(skipped, selection)).json();

  assert.equal(after.fingerprint, before.fingerprint, 'candidateManifest / generation-plan fingerprint must not change when only skippedNodes changed on an unrelated node');
  assert.deepEqual(after.candidate.scenes, before.candidate.scenes);
  assert.deepEqual(after.candidate.nodes, before.candidate.nodes);
});

test('SD1 (section 5.D re-verification): a skipped node with no reusable output does not make its reusable descendants dirty', async (t) => {
  const f = await fixture(t);
  const workflow = await f.own(GRAPH_DIRTY);
  const sourceRun = await f.startAndWait(workflow, { selectedStages: ['extra', 'mid', 'tail'], startStage: 'extra' });
  assert.equal(sourceRun.status, 'completed', JSON.stringify(sourceRun));

  // 'extra' is skipped WITHOUT ever having a reusable output removed (it ran fine in
  // sourceRun, so this specifically tests dirty propagation of a skipped-but-completed
  // node once it is excluded from `needed`, per 5.D: skip alone must not dirty descendants).
  const skipped = await (await f.skip(workflow, 'extra', true, workflow.version)).json();
  assert.deepEqual(skipped.skippedNodes, ['extra']);

  const response = await f.plan(skipped, { mode: 'all' });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.blocked, false);
  assert.deepEqual(body.selectedStages, [], 'mid and tail stay reuse-able; skipping extra must not force them to rerun');
  assert.equal(body.nothingToRun, true);
  assert.ok(body.completedNodeIds.includes('mid') && body.completedNodeIds.includes('tail'));
  const midEntry = body.nodes.find((item) => item.nodeId === 'mid');
  assert.equal(midEntry.action, 'reuse', 'mid must settle as reuse, not run, despite its ancestor being skipped');
});

// ---------------------------------------------------------------------------
// R4 (ServerReview round 2, P3): server/publication.mjs:224 `_snapshot().binding` embeds the
// LIVE workflow entity (including skippedNodes) via `canonicalJson({ workflow, run, episode,
// channel, job, candidate })`; `_assertCurrent` recomputes it after every await. A skip toggle
// on a node completely unrelated to the approved render/review branch must never perturb this
// binding. Engine-level (Store + PublicationService directly), the same seam already proven by
// tests/production-publication.test.mjs's "final async validation rejects an intervening edit"
// family -- these SK tests mirror that exact harness (async_hooks interception of the second
// `_export` lstat call) but assert the OPPOSITE outcome for a skip toggle: it must NOT reject.
// ---------------------------------------------------------------------------

const FIXTURE_OAUTH = { clientId: 'fixture-client-id.apps.googleusercontent.com', clientSecret: 'fixture-client-secret', redirectUri: 'https://workspace.fixture.invalid/oauth/youtube/callback' };

function boundChannel(store, overrides = {}) {
  return store.create('channels', { name: '확인해봄', category: 'information', platform: 'YouTube', sample: false, accountEmail: 'owner@fixture.invalid', externalId: `UC${'A'.repeat(22)}`, ...overrides });
}

function jsonBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return JSON.parse(body);
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'));
  return body;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function sequentialFetch(responses) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);
    if (index >= responses.length) throw new Error(`Unexpected outbound call #${calls.length}: ${options.method || 'GET'} ${url}`);
    const next = responses[index++];
    return typeof next === 'function' ? next(call) : next;
  };
  return { fetchImpl, calls };
}

function tokenResponseBody({ accessToken = 'fixture-access-token', refreshToken = 'fixture-refresh-token', expiresIn = 3600, scope = 'https://www.googleapis.com/auth/youtube.force-ssl' } = {}) {
  return { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, scope, refresh_token: refreshToken };
}

function channelsListBody(externalIds) {
  return { kind: 'youtube#channelListResponse', items: externalIds.map((id) => ({ id, snippet: { title: `Fixture channel ${id}` } })) };
}

async function connectChannel(store, channel) {
  const { fetchImpl } = sequentialFetch([() => Response.json(tokenResponseBody()), () => Response.json(channelsListBody([channel.externalId]))]);
  const oauth = new YouTubeOAuth({ store, fetchImpl, ...FIXTURE_OAUTH });
  const sessionId = randomUUID(), correlationToken = randomUUID();
  const { authUrl } = await oauth.begin(channel.id, { sessionId, correlationToken });
  const state = new URL(authUrl).searchParams.get('state');
  const result = await oauth.complete({ state, code: 'fixture-auth-code', correlationToken }, { isSessionActive: async () => true });
  assert.equal(result.status, 'connected');
  return { oauth };
}

function sceneAssetReceipts(store, scenes) {
  const uploads = store.list('uploads'), receipts = [];
  const add = (reference) => { const upload = uploads.find((item) => item.url === reference.assetUrl); receipts.push({ ...reference, sha256: upload.sha256, size: upload.size }); };
  for (const scene of scenes) {
    if (scene.assetUrl) add({ sceneId: scene.id, use: 'asset', assetUrl: scene.assetUrl });
    if (scene.audioUrl) add({ sceneId: scene.id, use: 'audio', assetUrl: scene.audioUrl });
    for (const slot of scene.slots || []) if (slot.assetUrl) add({ sceneId: scene.id, slotId: slot.id, use: 'asset', assetUrl: slot.assetUrl });
  }
  return receipts;
}

/** Builds a completed render + approved review candidate directly in the store, using
 * defaultWorkflow() (which includes 'trend') so a skip toggle on it can be exercised; 'trend'
 * never gates approval's lineage checks, only workflow.skippedNodes itself changes. */
async function skipPublicationCandidate(store, channel) {
  const scenes = [{ id: 'sk-fixture-card', title: 'Original fixture card', text: 'Fixture factual text', kind: 'title', layout: 'center', duration: 1, background: '#173940' }];
  const episode = store.create('episodes', { channelId: channel.id, title: 'SK fixture episode', topic: 'Publication binding fixture', category: 'information', status: 'draft', format: '9:16', version: 1, scenes, notes: '' });
  const bytes = Buffer.from(`SK publication fixture render bytes ${randomUUID()}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const filename = `${randomUUID()}.mp4`;
  await writeFile(join(store.dataDir, 'exports', filename), bytes);
  const outputUrl = `/api/exports/${filename}`;
  const verifiedSceneAssets = sceneAssetReceipts(store, scenes);
  const job = store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'completed', progress: 100, filename, outputUrl, sha256, sceneSnapshot: structuredClone(scenes), sceneIntegrity: verifiedSceneAssets, verifiedSceneAssets });
  const template = store.create('workflows', defaultWorkflow());
  const workflow = store.createWorkflowCopy({ templateId: template.id, channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const reviewNodeId = 'review';
  let run = store.create('workflowRuns', {
    workflowId: workflow.id, workflowVersion: workflow.version, episodeId: episode.id, episodeVersion: episode.version, status: 'awaiting_review',
    nodeRuns: [
      { nodeId: 'render', type: 'render', status: 'completed', output: { jobId: job.id, outputUrl, sha256, episodeVersion: episode.version, sceneSnapshot: structuredClone(scenes), generationNodeIds: [], verifiedSceneAssets } },
      { nodeId: reviewNodeId, type: 'review', status: 'awaiting_review', output: {} },
    ],
    reviews: {},
  });
  const review = { decision: 'approved', notes: '', reviewedAt: new Date().toISOString(), workflowId: workflow.id, workflowVersion: workflow.version, runId: run.id, episodeId: episode.id, episodeVersion: episode.version, jobId: job.id, outputUrl, sha256 };
  run = store.save('workflowRuns', { ...run, status: 'approved', reviews: { [reviewNodeId]: review }, nodeRuns: run.nodeRuns.map((node) => node.nodeId === reviewNodeId ? { ...node, status: 'approved', output: { review } } : node) });
  return { channel, episode, job, workflow, run, reviewNodeId, bytes, sha256, outputUrl };
}

function skipApproveBody(candidate, overrides = {}) {
  return {
    workflowId: candidate.workflow.id, runId: candidate.run.id, reviewNodeId: candidate.reviewNodeId, expectedEpisodeVersion: candidate.episode.version,
    title: 'SK fixture title', description: 'Fixture description for the publication skip-binding test.', categoryId: '25', tags: ['fixture'],
    selfDeclaredMadeForKids: false, containsSyntheticMedia: false, disclosureRationale: 'Original fixture only', rightsAcknowledged: true,
    ...overrides,
  };
}

function readbackSnippet(candidate) {
  const body = skipApproveBody(candidate);
  const credits = requiredMediaCredits(candidate.episode.scenes);
  return { channelId: candidate.channel.externalId, title: body.title, description: credits ? `${body.description}\n\n${credits}` : body.description, categoryId: body.categoryId, tags: body.tags };
}

/** Drives the exact 5-call publish sequence (private insert -> byte PUT -> owner readback ->
 * public update -> final readback) that PublicationService.publish() issues. */
function publishFlowFixture(candidate, accessToken) {
  const videoId = `fixture-video-${randomUUID().slice(0, 8)}`;
  const sessionUrl = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fixture-session-id';
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    const step = (fetchImpl.calls = fetchImpl.calls || []).push({ url, method: options.method || 'GET', headers: options.headers, body: options.body });
    if (step === 1) {
      assert.equal(options.method, 'POST');
      assert.equal(headerValue(options.headers, 'Authorization'), `Bearer ${accessToken}`);
      return new Response(null, { status: 200, headers: { Location: sessionUrl } });
    }
    if (step === 2) {
      assert.equal(url.href, sessionUrl);
      assert.equal(options.method, 'PUT');
      assert.equal(Buffer.compare(Buffer.from(options.body), candidate.bytes), 0);
      return Response.json({ id: videoId, status: { privacyStatus: 'private', uploadStatus: 'uploaded' } }, { status: 201 });
    }
    if (step === 3) {
      assert.equal(url.searchParams.get('id'), videoId);
      return Response.json({ items: [{ id: videoId, snippet: readbackSnippet(candidate), status: { privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: false, uploadStatus: 'processed' }, processingDetails: { processingStatus: 'succeeded' } }] });
    }
    if (step === 4) {
      assert.equal(options.method, 'PUT');
      const body = jsonBody(options.body);
      assert.equal(body.id, videoId);
      assert.equal(body.status.privacyStatus, 'public');
      return Response.json({ id: videoId, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: false } });
    }
    if (step === 5) {
      assert.equal(url.searchParams.get('id'), videoId);
      return Response.json({ items: [{ id: videoId, snippet: readbackSnippet(candidate), status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: false }, processingDetails: { processingStatus: 'succeeded' } }] });
    }
    throw new Error(`Unexpected call #${step}: ${options.method || 'GET'} ${url.href}`);
  };
  return { fetchImpl, calls: () => fetchImpl.calls || [], videoId };
}

async function waitForCondition(check, { attempts = 2000, intervalMs = 5 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Condition not met in time');
}

async function engineFixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-skip-publication-'));
  const store = new Store(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  return store;
}

test('SK1: a skip toggle on an unrelated node around an approve/publish cycle produces an identical fingerprint and never blocks publish', async (t) => {
  const store = await engineFixture(t);
  const channel = boundChannel(store);
  const candidate = await skipPublicationCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const { fetchImpl, calls } = publishFlowFixture(candidate, 'fixture-access-token');
  const service = new PublicationService({ store, oauth, fetchImpl });
  t.after(() => service.close());

  const firstPreview = await service.approve(skipApproveBody(candidate), { ownerId: 'owner-1' });
  const fingerprintBefore = firstPreview.fingerprint;
  assert.equal(fingerprintBefore, candidateFingerprint(firstPreview.manifest));

  // Toggle skip on 'trend' -- present in defaultWorkflow()'s chain but never gates approval
  // (no HARD_DEPENDENCY/lineage check in _snapshot() reads it); only workflow.skippedNodes
  // itself changes, which is exactly the binding leak R4 targets.
  const workflow = store.get('workflows', candidate.workflow.id);
  const skippedOn = store.setWorkflowSkip(workflow.id, 'trend', true, workflow.version);
  assert.deepEqual(skippedOn.skippedNodes, ['trend']);
  assert.equal(skippedOn.version, workflow.version, 'skip must not bump version');

  const secondPreview = await service.approve(skipApproveBody(candidate), { ownerId: 'owner-1' });
  assert.equal(secondPreview.fingerprint, fingerprintBefore, 'a skip toggle on an unrelated node must not change the candidate fingerprint');
  assert.equal(calls().length, 0, 'preview must never contact the provider');

  // Publish using the FIRST approval, computed BEFORE the toggle -- proves _assertCurrent's
  // binding recomputation (which runs again inside publish/_revalidate) tolerates the
  // now-different skippedNodes state instead of rejecting it as a changed binding.
  await service.publish(firstPreview.id, { ownerId: 'owner-1' });
  const finalState = await waitForCondition(async () => { const state = await service.state(firstPreview.id); return state.status === 'completed' ? state : null; });
  assert.equal(finalState.status, 'completed');
  assert.equal(calls().length, 5, 'the full private->byte->readback->public->readback sequence must run exactly once, uninterrupted by the skip toggle');

  // Unskip and prove a FRESH preview still matches the original fingerprint (full round trip).
  store.setWorkflowSkip(workflow.id, 'trend', false, skippedOn.version);
  const thirdPreview = await service.approve(skipApproveBody(candidate), { ownerId: 'owner-1' });
  assert.equal(thirdPreview.fingerprint, fingerprintBefore);
});

test('SK2 (race): a skip toggle landing between the two internal binding snapshots during approve()/publish() must NOT raise "Publication state changed during validation"', async (t) => {
  const store = await engineFixture(t);
  const channel = boundChannel(store);
  const candidate = await skipPublicationCandidate(store, channel);
  const { oauth } = await connectChannel(store, channel);
  const workflow = store.get('workflows', candidate.workflow.id);
  const transport = publishFlowFixture(candidate, 'fixture-access-token');

  let armed = false, exportStarts = 0, toggled = false;
  const hook = createHook({
    init(_id, type) {
      if (!armed || type !== 'FSREQPROMISE') return;
      const stack = new Error().stack;
      if (!stack.includes('PublicationService._export') || !stack.includes('lstat')) return;
      if (++exportStarts !== 2) return;
      // The 2nd _export lstat is the LAST real await before _assertCurrent's final binding
      // recomputation (the same interception point production-publication.test.mjs uses to
      // prove an intervening episode/rights/channel edit DOES get caught). Land the skip
      // write here, between the first _snapshot() (inside _manifest) and the second
      // (inside the post-await _assertCurrent).
      armed = false;
      queueMicrotask(() => {
        const current = store.get('workflows', workflow.id);
        store.setWorkflowSkip(workflow.id, 'trend', true, current.version);
        toggled = true;
      });
    },
  });
  t.after(() => hook.disable());

  const service = new PublicationService({
    store, oauth,
    fetchImpl: async (...args) => {
      const response = await transport.fetchImpl(...args);
      if (transport.calls().length === 3) { armed = true; hook.enable(); }
      return response;
    },
  });
  t.after(() => service.close());

  const approval = await service.approve(skipApproveBody(candidate), { ownerId: 'owner-1' });
  await service.publish(approval.id, { ownerId: 'owner-1' });
  const finalState = await waitForCondition(async () => { const state = await service.state(approval.id); return ['completed', 'failed', 'blocked'].includes(state.status) ? state : null; });
  hook.disable();

  assert.equal(toggled, true, 'the skip toggle must actually have landed inside the real asynchronous export validation window');
  assert.equal(exportStarts, 2, 'must exercise the last beforeSend validation, not an earlier one');
  // Before the R4 fix: _assertCurrent's binding recomputation sees workflow.skippedNodes
  // differ and throws HttpError(409, 'Publication state changed during validation; prepare a
  // new final approval'); the dispatch loop's catch (publication.mjs ~663-665) then wraps ANY
  // 409 into status:'blocked', message:'Approved candidate or recovery evidence changed;
  // reconciliation is required' -- the raw _assertCurrent string is never directly observable
  // here, so this is the correct literal symptom to assert against, not the inner message.
  assert.equal(finalState.status, 'completed', `expected the skip toggle to be harmless once skippedNodes is excluded from the binding; got status=${finalState.status} message=${finalState.message}`);
  assert.notEqual(finalState.message, 'Approved candidate or recovery evidence changed; reconciliation is required', 'a mid-flight skip toggle must never be treated as changed approval/recovery evidence');
  const publicWrites = transport.calls().filter((c) => c.url.pathname === '/youtube/v3/videos' && c.method === 'PUT');
  assert.equal(publicWrites.length, 1, 'the toggle must not prevent or duplicate the public update');
  assert.equal(transport.calls().length, 5, 'exactly the expected 5-call sequence, in order, with no extra retries caused by a false binding mismatch');
  assert.deepEqual(store.get('workflows', workflow.id).skippedNodes, ['trend'], 'the toggle write itself must have landed (not silently dropped)');
});
