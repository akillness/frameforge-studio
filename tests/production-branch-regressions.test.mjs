// Independent regression evidence: real HTTP/SQLite/asset validation/FFmpeg.
// Only agent and generation transport responses/downloaded bytes are fixtures.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { createGenerationProvider } from '../server/generation-provider.mjs';
import { candidateFingerprint } from '../server/graph.mjs';
import { Store } from '../server/store.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const originalFetch = globalThis.fetch, origins = new Set();
globalThis.fetch = (url, options) => {
  assert.ok(origins.has(new URL(url).origin), 'No external network is permitted');
  return originalFetch(url, options);
};
after(() => { globalThis.fetch = originalFetch; });
const disclosure = { containsSyntheticMedia: true, rationale: 'Fixture illustrations, never event evidence' };
const scene = id => ({ id, title: id, text: `Exact ${id} story`, kind: 'title', layout: 'center', duration: 1, background: '#173940' });
const node = (id, type, config = {}) => ({ id, type, x: 0, y: 0, config });
const edges = pairs => pairs.map(([source, target], i) => ({ id: `e${i}`, source, target }));

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-branch-regression-')), transport = [];
  const unexpected = async () => { throw new Error('Unexpected external transport'); };
  const generation = createGenerationProvider({ env: { AGENT_BRIDGE_TOKEN: 'fixture-only-generation-token-123456', AGENT_BRIDGE_URL: 'https://bridge.fixture.invalid' }, fetchImpl: async (raw, options = {}) => {
    const url = new URL(raw), body = options.body ? JSON.parse(options.body) : null;
    assert.equal(url.origin, 'https://bridge.fixture.invalid');
    transport.push({ path: url.pathname, body });
    if (url.pathname === '/generation/status') return Response.json({ configured: true, available: true });
    if (url.pathname === '/generation/models') return Response.json({ id: 'fixture_image', type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] });
    if (url.pathname === '/generation/estimate') return Response.json({ cost: 2, currency: 'USD', quoted: true });
    if (url.pathname === '/generation/create') return Response.json({ requestId: `fixture-${transport.filter(c => c.path === '/generation/create').length}`, status: 'completed', outputs: [{ url: 'https://images.higgs.ai/fixture.png', type: 'image' }] });
    assert.fail(`Unexpected fixture endpoint ${url.pathname}`);
  } });
  const app = createApp({ dataDir, loginToken: '', publicOrigin: '', generation,
    generationOptions: { pollIntervalMs: 2, download: async (url, file) => { assert.equal(url, 'https://images.higgs.ai/fixture.png'); await writeFile(file, PNG); return { bytes: PNG.length, contentType: 'image/png' }; } },
    integrations: { integrationStatus: async () => ({ codex: { available: true } }), fetchTrends: unexpected, runAgent: async (_agent, prompt) => ({ message: 'External agent fixture', scenes: [options.agentScenes?.[prompt.includes('BRANCH_A') ? 'a' : 'b'] || scene(prompt.includes('BRANCH_A') ? 'branch-a' : 'branch-b')] }) },
    mediaOptions: { userAgent: '', fetchImpl: unexpected }, youtubeOptions: options.publication ? { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-only-secret', redirectUri: 'http://127.0.0.1/oauth/youtube/callback', fetchImpl: async raw => {
      const url = new URL(raw);
      if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') return Response.json({ access_token: 'fixture-only-access', refresh_token: 'fixture-only-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.force-ssl', token_type: 'Bearer' });
      assert.equal(url.origin, 'https://www.googleapis.com'); assert.equal(url.pathname, '/youtube/v3/channels');
      return Response.json({ items: [{ id: `UC${'A'.repeat(22)}`, snippet: { title: 'Fixture owner' } }] });
    } } : { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: unexpected }, publicationOptions: { fetchImpl: unexpected },
  });
  t.after(async () => { await new Promise(done => { app.close(done); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await new Promise(done => app.listen(0, '127.0.0.1', done));
  assert.notEqual(app.address().port, 4310);
  const base = `http://127.0.0.1:${app.address().port}`; origins.add(base);
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value;
  };
  const channel = await api('/api/channels', 'POST', { name: 'Branch fixture', category: 'information', platform: 'YouTube' });
  let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Branch isolation', topic: 'Independent producers' });
  episode = await api(`/api/episodes/${episode.id}`, 'PUT', { ...episode, scenes: [scene('saved-original')], expectedVersion: episode.version });
  const own = async body => { const template = await api('/api/workflows', 'POST', body); return api(`/api/workflows/${template.id}/copies`, 'POST', { episodeId: episode.id, channelId: channel.id, expectedTemplateVersion: template.version }); };
  const wait = async id => { for (let i = 0; i < 1200; i++) { const run = await api(`/api/workflow-runs/${id}`); if (['completed', 'failed', 'awaiting_review', 'approved'].includes(run.status)) return run; await new Promise(done => setTimeout(done, 50)); } assert.fail(`Run ${id} timed out`); };
  const connect = async () => {
    await api(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: `UC${'A'.repeat(22)}`, expectedUpdatedAt: channel.updatedAt });
    const auth = await fetch(`${base}/api/channels/${channel.id}/youtube/authorize`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(auth.status, 200); const state = new URL((await auth.json()).authUrl).searchParams.get('state');
    const cookie = auth.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const callback = await fetch(`${base}/oauth/youtube/callback?state=${encodeURIComponent(state)}&code=fixture-code`, { headers: { cookie }, redirect: 'manual' });
    assert.ok([302, 303].includes(callback.status));
    assert.equal((await api(`/api/channels/${channel.id}/youtube`)).connected, true);
  };
  return { api, episode, own, wait, transport, base, connect, dataDir };
}

function branchedGraph({ generate = false } = {}) {
  const nodes = [node('a-script', 'script', { agent: 'codex', prompt: 'BRANCH_A' }), node('b-script', 'script', { agent: 'codex', prompt: 'BRANCH_B' }), node('c-board-a', 'storyboard'), node('d-board-b', 'storyboard'), node('y-layout-a', 'layout'), node('z-layout-b', 'layout'), node('zz-render-a', 'render'), node('zz-render-b', 'render'), node('zzz-review-a', 'review'), node('zzz-review-b', 'review')];
  nodes.push(node('root-research', 'research'));
  const pairs = [['root-research', 'a-script'], ['root-research', 'b-script'], ['a-script', 'c-board-a'], ['b-script', 'd-board-b'], ['c-board-a', 'y-layout-a'], ['d-board-b', 'z-layout-b'], ['zz-render-a', 'zzz-review-a'], ['zz-render-b', 'zzz-review-b'], ['z-layout-b', 'zz-render-b']];
  if (generate) { nodes.push(node('za-generate', 'generate', { model: 'fixture_image', sceneId: 'branch-a', prompt: 'Only branch A illustration' })); pairs.push(['y-layout-a', 'za-generate'], ['za-generate', 'zz-render-a']); }
  else pairs.push(['y-layout-a', 'zz-render-a']);
  return { name: 'Distinct branch producers', nodes, edges: edges(pairs) };
}

test('distinct scripts and storyboards preserve their own layout and quote scene evidence despite the saved sibling branch', { timeout: 120000 }, async t => {
  const f = await fixture(t), body = branchedGraph({ generate: true }), workflow = await f.own(body);
  const selectedStages = body.nodes.filter(n => ['script', 'storyboard', 'layout'].includes(n.type)).map(n => n.id);
  const run = await f.wait((await f.api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages })).id);
  assert.equal(run.status, 'completed', JSON.stringify(run));
  for (const branch of ['a', 'b']) for (const id of [branch === 'a' ? 'c-board-a' : 'd-board-b', branch === 'a' ? 'y-layout-a' : 'z-layout-b']) {
    assert.deepEqual(run.nodeRuns.find(n => n.nodeId === id).output.scenes.map(s => s.id), [`branch-${branch}`], `${id} must consume only its connected script`);
  }
  const current = (await f.api('/api/state')).episodes.find(e => e.id === f.episode.id);
  assert.deepEqual(current.scenes.map(s => s.id), ['branch-b'], 'the saved sibling intentionally differs from quote target');
  const plan = await f.api(`/api/workflows/${workflow.id}/quote`, 'POST', { episodeId: f.episode.id, selectedStages: ['y-layout-a', 'za-generate', 'zz-render-a', 'zzz-review-a'], resumeRunId: run.id, disclosure });
  assert.deepEqual(plan.candidate.preparation.stages['y-layout-a'].map(s => s.id), ['branch-a']);
  assert.deepEqual(plan.candidate.scenes.map(s => s.sceneId), ['branch-a']);
  assert.equal(plan.fingerprint, candidateFingerprint(plan.candidate));
  assert.equal(f.transport.filter(c => c.path === '/generation/create').length, 0, 'quoting never generates');
});

test('render-only resume reuses exact connected scene producers instead of the saved sibling episode', { timeout: 120000 }, async t => {
  const f = await fixture(t), body = branchedGraph(), workflow = await f.own(body);
  const source = await f.wait((await f.api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: body.nodes.filter(n => ['script', 'storyboard', 'layout'].includes(n.type)).map(n => n.id) })).id);
  assert.equal(source.status, 'completed', JSON.stringify(source));
  assert.deepEqual((await f.api('/api/state')).episodes.find(e => e.id === f.episode.id).scenes.map(s => s.id), ['branch-b']);
  const run = await f.wait((await f.api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: ['zz-render-a'], startStage: 'zz-render-a', resumeRunId: source.id })).id);
  assert.equal(run.status, 'completed', JSON.stringify(run));
  for (const id of ['c-board-a', 'y-layout-a']) { const retained = run.nodeRuns.find(n => n.nodeId === id); assert.equal(retained.reused, true); assert.deepEqual(retained.output.scenes.map(s => s.id), ['branch-a']); }
  const render = run.nodeRuns.find(n => n.nodeId === 'zz-render-a');
  assert.deepEqual(render.output.sceneSnapshot.map(s => s.id), ['branch-a']);
  assert.match(render.output.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(render.output.generationNodeIds, []);
  assert.equal(f.transport.filter(c => c.path === '/generation/create').length, 0);
  const editor = new Store(f.dataDir);
  try { editor.save('workflowRuns', { ...source, nodeRuns: source.nodeRuns.map(n => n.nodeId === 'y-layout-a' ? { ...n, output: { ...n.output, scenes: [] } } : n) }); }
  finally { editor.close(); }
  const missing = await fetch(`${f.base}/api/workflows/${workflow.id}/run`, { method: 'POST', headers: { origin: f.base, 'content-type': 'application/json' }, body: JSON.stringify({ episodeId: f.episode.id, selectedStages: ['zz-render-a'], startStage: 'zz-render-a', resumeRunId: source.id }) });
  assert.equal(missing.status, 409, 'missing connected scene evidence must never fall back to saved branch B');
});

test('two generation nodes in different slots of one scene complete with original stable job IDs and no duplicate submission on resume', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const current = await f.api(`/api/episodes/${f.episode.id}`, 'PUT', { ...f.episode, scenes: [{ ...scene('shared-scene'), slots: ['left', 'right'].map((id, i) => ({ id, role: 'image-gen', x: i * 50, y: 0, w: 50, h: 100, zIndex: i + 1, prompt: `Original ${id}` })) }], expectedVersion: f.episode.version });
  const workflow = await f.own({ name: 'Independent same-scene slots', nodes: [node('script', 'script', { agent: 'existing' }), node('storyboard', 'storyboard'), ...['left', 'right'].map(id => node(`gen-${id}`, 'generate', { sceneId: 'shared-scene', slotId: id, targetMode: 'slot', model: 'fixture_image', prompt: `Illustration ${id}` })), node('render', 'render'), node('review', 'review')], edges: edges([['script', 'storyboard'], ['storyboard', 'gen-left'], ['storyboard', 'gen-right'], ['gen-left', 'render'], ['gen-right', 'render'], ['render', 'review']]) });
  const selectedStages = workflow.nodes.map(n => n.id), options = { episodeId: current.id, selectedStages, disclosure };
  const plan = await f.api(`/api/workflows/${workflow.id}/quote`, 'POST', options);
  const run = await f.wait((await f.api(`/api/workflows/${workflow.id}/run`, 'POST', { ...options, allowGeneration: true, generationPlanId: plan.id, generationFingerprint: plan.fingerprint })).id);
  assert.equal(run.status, 'awaiting_review', JSON.stringify(run));
  const jobs = new Map(['left', 'right'].map(id => { const record = run.nodeRuns.find(n => n.nodeId === `gen-${id}`); assert.equal(record.status, 'completed'); return [id, record.output.generationJobId]; }));
  assert.notEqual(jobs.get('left'), jobs.get('right'));
  for (const [slotId, jobId] of jobs) { const job = await f.api(`/api/generations/${jobId}`); assert.equal(job.status, 'completed'); assert.equal(job.applied, true); assert.equal(job.slotId, slotId); assert.equal(job.requestId, `${run.id}:gen-${slotId}`); }
  const submits = f.transport.filter(c => c.path === '/generation/create'); assert.equal(submits.length, 2);
  const resumed = await f.wait((await f.api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: current.id, selectedStages: ['render'], startStage: 'render', resumeRunId: run.id })).id);
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  for (const [slotId, jobId] of jobs) assert.equal(resumed.nodeRuns.find(n => n.nodeId === `gen-${slotId}`).output.generationJobId, jobId);
  const output = resumed.nodeRuns.find(n => n.nodeId === 'render').output;
  assert.deepEqual(output.generationNodeIds.sort(), ['gen-left', 'gen-right']);
  for (const slot of output.sceneSnapshot[0].slots) assert.equal(slot.source.generationJobId, jobs.get(slot.id));
  assert.equal(f.transport.filter(c => c.path === '/generation/create').length, 2, 're-render never pays twice');
});

const approvalBody = (f, workflow, run, reviewNodeId) => ({ workflowId: workflow.id, runId: run.id, reviewNodeId, expectedEpisodeVersion: run.episodeVersion, title: 'Exact selected branch', description: 'Exact rendered candidate', categoryId: '25', tags: [], selfDeclaredMadeForKids: false, containsSyntheticMedia: true, disclosureRationale: disclosure.rationale, rightsAcknowledged: true });

for (const missing of ['scene', 'slot']) test(`publication verifies the exact selected render and credits despite a skipped sibling generation with a missing ${missing}`, { timeout: 120000 }, async t => {
  const options = { publication: true, agentScenes: {} }, f = await fixture(t, options);
  const uploads = {};
  await f.connect();
  for (const branch of ['a', 'b']) {
    const response = await fetch(`${f.base}/api/uploads?name=credit-${branch}.png`, { method: 'POST', headers: { origin: f.base, 'content-type': 'image/png' }, body: PNG });
    assert.equal(response.status, 201); const upload = await response.json();
    uploads[branch] = upload;
    const source = { origin: 'third-party', attribution: `Artist-${branch}`, licenseId: 'CC-BY-4.0', sourceUrl: `https://commons.wikimedia.org/wiki/File:Branch_${branch}.png`, sha256: upload.sha256, useAs: 'illustration' };
    await f.api(`/api/uploads/${upload.id}/rights`, 'POST', source);
    options.agentScenes[branch] = { ...scene(`branch-${branch}`), kind: 'image', assetUrl: upload.url, source };
  }
  const body = branchedGraph();
  body.nodes.push(node('zz-generation-b', 'generate', { model: 'fixture_image', sceneId: missing === 'scene' ? 'absent-scene' : 'branch-b', ...(missing === 'slot' ? { slotId: 'absent-slot', targetMode: 'slot' } : {}), prompt: 'Unselected sibling' }));
  body.edges = body.edges.filter(e => !(e.source === 'z-layout-b' && e.target === 'zz-render-b'));
  body.edges.push({ id: 'to-unselected', source: 'z-layout-b', target: 'zz-generation-b' }, { id: 'from-unselected', source: 'zz-generation-b', target: 'zz-render-b' });
  const workflow = await f.own(body);
  const run = await f.wait((await f.api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: f.episode.id, selectedStages: body.nodes.filter(n => !['zz-generation-b', 'zz-render-b', 'zzz-review-b'].includes(n.id)).map(n => n.id) })).id);
  assert.equal(run.status, 'awaiting_review', run.error);
  assert.deepEqual((await f.api('/api/state')).episodes.find(e => e.id === f.episode.id).scenes.map(s => s.id), ['branch-b']);
  await f.api(`/api/workflows/${workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId: 'zzz-review-a', decision: 'approved', expectedEpisodeVersion: run.episodeVersion, notes: 'Exact branch A' });
  const approval = await f.api('/api/publication/approvals', 'POST', approvalBody(f, workflow, run, 'zzz-review-a'));
  const snapshot = run.nodeRuns.find(n => n.nodeId === 'zz-render-a').output.sceneSnapshot;
  assert.deepEqual(approval.manifest.candidate.scenes.map(s => s.sceneId), snapshot.map(s => s.id));
  assert.ok(approval.manifest.credits.includes('Artist-a')); assert.ok(!approval.manifest.credits.includes('Artist-b'));
  assert.ok(approval.manifest.description.includes('Artist-a')); assert.ok(!approval.manifest.description.includes('Artist-b'));
  assert.equal(approval.fingerprint, candidateFingerprint(approval.manifest));
  assert.equal(run.nodeRuns.find(n => n.nodeId === 'zz-generation-b').status, 'skipped');
  const aFile = join(f.dataDir, 'uploads', uploads.a.url.split('/').pop());
  await writeFile(aFile, Buffer.from('tampered branch A bytes'));
  const approveRaw = () => fetch(`${f.base}/api/publication/approvals`, { method: 'POST', headers: { origin: f.base, 'content-type': 'application/json' }, body: JSON.stringify(approvalBody(f, workflow, run, 'zzz-review-a')) });
  const tampered = await approveRaw(); assert.equal(tampered.status, 409, await tampered.text());
  await writeFile(aFile, PNG);
  const editor = new Store(f.dataDir);
  try { const aRights = editor.list('mediaRights').filter(r => r.uploadId === uploads.a.id); assert.equal(aRights.length, 1); editor.save('mediaRights', { ...aRights[0], acknowledgedAt: '' }); }
  finally { editor.close(); }
  const uncleared = await approveRaw(); assert.equal(uncleared.status, 409, await uncleared.text());
  assert.equal(f.transport.filter(c => c.path === '/generation/create').length, 0, 'source-only approval never spends on skipped generation');
});

test('publication candidate includes only the selected render generation ancestry and its exact slot snapshot', { timeout: 120000 }, async t => {
  const f = await fixture(t, { publication: true }); await f.connect();
  await f.api(`/api/episodes/${f.episode.id}`, 'PUT', { ...f.episode, scenes: [{ ...scene('shared-scene'), slots: ['left', 'right'].map((id, i) => ({ id, role: 'image-gen', x: i * 50, y: 0, w: 50, h: 100, zIndex: i + 1 })) }], expectedVersion: f.episode.version });
  const body = { name: 'Selected generation ancestry', nodes: [node('script', 'script', { agent: 'existing' }), node('storyboard', 'storyboard')], edges: edges([['script', 'storyboard']]) };
  for (const id of ['left', 'right']) { body.nodes.push(node(`gen-${id}`, 'generate', { sceneId: 'shared-scene', slotId: id, targetMode: 'slot', model: 'fixture_image', prompt: `Illustration ${id}` }), node(`render-${id}`, 'render'), node(`review-${id}`, 'review')); body.edges.push(...edges([['storyboard', `gen-${id}`], [`gen-${id}`, `render-${id}`], [`render-${id}`, `review-${id}`]]).map(e => ({ ...e, id: `${id}-${e.id}` }))); }
  const workflow = await f.own(body), options = { episodeId: f.episode.id, selectedStages: body.nodes.map(n => n.id), disclosure };
  const plan = await f.api(`/api/workflows/${workflow.id}/quote`, 'POST', options);
  const run = await f.wait((await f.api(`/api/workflows/${workflow.id}/run`, 'POST', { ...options, allowGeneration: true, generationPlanId: plan.id, generationFingerprint: plan.fingerprint })).id);
  assert.equal(run.status, 'awaiting_review', run.error);
  await f.api(`/api/workflows/${workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId: 'review-left', decision: 'approved', expectedEpisodeVersion: run.episodeVersion, notes: 'Exact generated left branch' });
  const approval = await f.api('/api/publication/approvals', 'POST', approvalBody(f, workflow, run, 'review-left'));
  assert.deepEqual(approval.manifest.candidate.nodes.map(n => n.nodeId), ['gen-left']);
  const snapshot = run.nodeRuns.find(n => n.nodeId === 'render-left').output.sceneSnapshot[0];
  const actual = approval.manifest.candidate.scenes[0];
  for (const slot of snapshot.slots) { const approved = actual.slots.find(s => s.slotId === slot.id); assert.equal(approved.assetUrl, slot.assetUrl || ''); assert.equal(approved.source?.generationJobId, slot.source?.generationJobId); }
  const siblingJob = run.nodeRuns.find(n => n.nodeId === 'gen-right').output.generationJobId;
  assert.ok(!JSON.stringify(approval.manifest.candidate.assets).includes(siblingJob), 'unselected generated sibling is absent from approved assets');
});
