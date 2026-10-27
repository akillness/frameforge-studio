import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

const node = (id, type, config = {}) => ({ id, type, x: 0, y: 0, config });
const graph = (nodes, pairs) => ({ name: 'Sequential data fixture', nodes, edges: pairs.map(([source, target], i) => ({ id: `edge-${i}`, source, target })) });
const record = (run, id) => run.nodeRuns.find(item => item.nodeId === id);
const scene = text => ({ id: 'fixture-scene', title: 'Fixture', text, kind: 'title', layout: 'center', duration: 1, background: '#173940' });

async function fixture(t, body) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-sequential-'));
  const nativeFetch = globalThis.fetch;
  const queries = [], prompts = [];
  let base, app;
  const forbidden = async () => { throw new Error('Unexpected paid or external operation'); };
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.origin === base) return nativeFetch(input, options);
    assert.equal(url.origin, 'https://news.google.com');
    assert.equal(url.pathname, '/rss/search');
    const query = url.searchParams.get('q');
    queries.push(query);
    return new Response(`<rss><channel><item><title>Headline for ${query}</title><link>https://fixture.invalid/article</link><source>Fixture News</source><description>Fixture evidence</description></item></channel></rss>`, { headers: { 'content-type': 'application/rss+xml' } });
  };
  const startServer = async () => {
    app = createApp({ dataDir, loginToken: '', publicOrigin: '', integrations: {
      integrationStatus: async () => ({ codex: { available: true } }),
      fetchTrends: async query => ({ trends: [{ keyword: `${query}-RESULT`, source: 'Fixture', url: 'https://fixture.invalid/trend' }], sources: [] }),
      runAgent: async (_agent, prompt) => { prompts.push(prompt); if (prompt.includes('FAIL_SCRIPT')) throw new Error('Fixture script failure'); const id = prompt.includes('BRANCH_A') ? 'branch-a' : prompt.includes('BRANCH_B') ? 'branch-b' : 'fixture-scene'; return { message: 'Fixture script', scenes: [{ ...scene(prompt), id }] }; },
    }, generation: { capability: async () => ({ available: true }), models: forbidden, modelSchema: async model => ({ id: model, type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }), estimate: async () => ({ cost: 1, currency: 'USD', quoted: true }), create: forbidden, submit: forbidden, status: forbidden },
    renderer: forbidden, mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden }, publicationOptions: { fetchImpl: forbidden } });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.address().port}`;
  };
  const stop = () => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
  t.after(async () => { try { if (app?.listening) await stop(); } finally { globalThis.fetch = nativeFetch; await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } });
  await startServer();
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = async (path, method = 'GET', body) => { const response = await request(path, method, body); const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`); return value; };
  const channel = await api('/api/channels', 'POST', { name: 'Sequential owner', category: 'information', platform: 'YouTube' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Sequential project', topic: 'Fixture topic' });
  const template = await api('/api/workflows', 'POST', body);
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const payload = (id, extra = {}) => ({ episodeId: episode.id, expectedWorkflowVersion: workflow.version, expectedEpisodeVersion: episode.version, selectedStages: [id], startStage: id, ...extra });
  const execute = async (id, extra) => {
    const response = await request(`/api/workflows/${workflow.id}/run`, 'POST', payload(id, extra));
    assert.equal(response.status, 202, await response.clone().text());
    const started = await response.json();
    for (let turn = 0; turn < 500; turn++) {
      const run = await api(`/api/workflow-runs/${started.id}`);
      if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(`Run ${started.id} did not finish`);
  };
  return { api, request, episode, workflow, payload, execute, prompts, queries, restart: async () => { await stop(); await startServer(); } };
}

test('individual stages resume saved trend, news and research inputs across a server restart', async t => {
  const f = await fixture(t, graph([
    node('trend', 'trend', { query: 'ALPHA' }), node('news', 'news'), node('research', 'research'), node('script', 'script', { agent: 'codex', prompt: 'Write fixture' }),
  ], [['trend', 'news'], ['news', 'research'], ['research', 'script']]));
  const trend = await f.execute('trend');
  assert.equal(trend.status, 'completed', JSON.stringify(trend));
  assert.equal(record(trend, 'trend').output.trends[0].keyword, 'ALPHA-RESULT');
  const news = await f.execute('news');
  assert.equal(news.status, 'completed', JSON.stringify(news));
  assert.ok(record(news, 'news').output.keywords.includes('ALPHA-RESULT'));
  assert.ok(f.queries.at(-1).includes('ALPHA-RESULT'));
  const research = await f.execute('research');
  assert.equal(research.status, 'completed', JSON.stringify(research));
  assert.deepEqual(record(research, 'research').output.inputs.find(input => input.nodeId === 'news').output, record(news, 'news').output);
  await f.restart();
  assert.deepEqual(await f.api(`/api/workflow-runs/${research.id}`), research);
  const script = await f.execute('script');
  assert.equal(script.status, 'completed', JSON.stringify(script));
  assert.ok(f.prompts.at(-1).includes('Headline for ALPHA-RESULT'), f.prompts.at(-1));
  assert.ok(record(script, 'script').output.scenes[0].text.includes('Headline for ALPHA-RESULT'));
});

test('a single selected stage resolves saved input when startStage is omitted', async t => {
  const f = await fixture(t, graph([node('trend', 'trend', { query: 'IMPLICIT' }), node('news', 'news')], [['trend', 'news']]));
  const trend = await f.execute('trend');
  assert.equal(trend.status, 'completed', JSON.stringify(trend));
  const news = await f.execute('news', { startStage: undefined });
  assert.equal(news.status, 'completed', JSON.stringify(news));
  assert.ok(record(news, 'news').output.keywords.includes('IMPLICIT-RESULT'));
  assert.ok(f.queries.at(-1).includes('IMPLICIT-RESULT'));
});

test('connected branch and nearest repeated trend win over a newer unrelated run', async t => {
  const f = await fixture(t, graph([
    node('root', 'research'), node('old', 'trend', { query: 'OLD' }), node('near', 'trend', { query: 'NEAR' }), node('other', 'trend', { query: 'OTHER' }),
    node('news-a', 'news'), node('news-b', 'news'), node('script-a', 'script', { agent: 'codex' }),
  ], [['root', 'old'], ['root', 'other'], ['old', 'near'], ['near', 'news-a'], ['other', 'news-b'], ['news-a', 'script-a']]));
  for (const id of ['old', 'near', 'other']) assert.equal((await f.execute(id)).status, 'completed');
  const a = await f.execute('news-a');
  assert.equal(a.status, 'completed', JSON.stringify(a));
  assert.ok(record(a, 'news-a').output.keywords.includes('NEAR-RESULT'));
  assert.ok(!record(a, 'news-a').output.keywords.includes('OLD-RESULT'));
  assert.ok(!record(a, 'news-a').output.keywords.includes('OTHER-RESULT'));
  const b = await f.execute('news-b');
  assert.equal(b.status, 'completed', JSON.stringify(b));
  const script = await f.execute('script-a');
  assert.equal(script.status, 'completed', JSON.stringify(script));
  assert.ok(f.prompts.at(-1).includes('Headline for NEAR-RESULT'));
  assert.ok(!f.prompts.at(-1).includes('Headline for OTHER-RESULT'));
});

test('foreign and stale resume evidence is rejected without executing a provider', async t => {
  const f = await fixture(t, graph([node('script', 'script', { agent: 'codex' }), node('board', 'storyboard')], [['script', 'board']]));
  const source = await f.execute('script');
  assert.equal(source.status, 'completed', JSON.stringify(source));
  const other = await f.api('/api/episodes', 'POST', { channelId: f.episode.channelId, title: 'Other project', topic: 'Other' });
  const copy = await f.api(`/api/workflows/${f.workflow.templateId}/copies`, 'POST', { channelId: f.episode.channelId, episodeId: other.id, expectedTemplateVersion: f.workflow.templateVersion });
  const foreign = await f.request(`/api/workflows/${copy.id}/run`, 'POST', { episodeId: other.id, selectedStages: ['board'], startStage: 'board', resumeRunId: source.id, expectedWorkflowVersion: copy.version, expectedEpisodeVersion: other.version });
  assert.equal(foreign.status, 409, await foreign.text());
  const updated = await f.api(`/api/episodes/${f.episode.id}`, 'PUT', { ...f.episode, title: 'Edited project', expectedVersion: f.episode.version });
  const stale = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', f.payload('board', { resumeRunId: source.id, expectedEpisodeVersion: updated.version }));
  assert.equal(stale.status, 409, await stale.text());
  assert.equal(f.prompts.length, 1);
});

test('rerunning an upstream script invalidates its previously saved storyboard', async t => {
  const f = await fixture(t, graph([node('script', 'script', { agent: 'codex' }), node('board', 'storyboard'), node('layout', 'layout'), node('render', 'render')], [['script', 'board'], ['board', 'layout'], ['layout', 'render']]));
  const first = await f.execute('script');
  assert.equal(first.status, 'completed', JSON.stringify(first));
  const board = await f.execute('board');
  assert.equal(board.status, 'completed', JSON.stringify(board));
  const episode = (await f.api('/api/state')).episodes.find(item => item.id === f.episode.id);
  const second = await f.execute('script', { expectedEpisodeVersion: episode.version });
  assert.equal(second.status, 'completed', JSON.stringify(second));
  const response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', f.payload('layout', { expectedEpisodeVersion: episode.version }));
  assert.equal(response.status, 409, await response.text());
});

test('failed script output cannot satisfy a storyboard prerequisite', async t => {
  const f = await fixture(t, graph([node('script', 'script', { agent: 'codex', prompt: 'FAIL_SCRIPT' }), node('board', 'storyboard')], [['script', 'board']]));
  const failed = await f.execute('script');
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  assert.equal(record(failed, 'script').status, 'failed');
  assert.equal(record(failed, 'script').output, undefined);
  const response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', f.payload('board', { resumeRunId: failed.id }));
  assert.equal(response.status, 409, await response.text());
  assert.equal((await f.api(`/api/workflow-runs/${failed.id}`)).status, 'failed');
});

test('a workflow edit makes explicit prior-run evidence stale', async t => {
  const f = await fixture(t, graph([node('script', 'script', { agent: 'codex' }), node('board', 'storyboard')], [['script', 'board']]));
  const source = await f.execute('script');
  assert.equal(source.status, 'completed', JSON.stringify(source));
  const edited = await f.api(`/api/workflows/${f.workflow.id}`, 'PUT', { ...f.workflow, name: 'Edited graph', expectedVersion: f.workflow.version });
  const response = await f.request(`/api/workflows/${f.workflow.id}/run`, 'POST', f.payload('board', { expectedWorkflowVersion: edited.version, resumeRunId: source.id }));
  assert.equal(response.status, 409, await response.text());
  assert.equal(f.prompts.length, 1);
});

test('generate-only quote rejects a different saved branch and accepts the matching storyboard without submitting generation', async t => {
  const f = await fixture(t, graph([
    node('root', 'research'), node('script-a', 'script', { agent: 'codex', prompt: 'BRANCH_A' }), node('script-b', 'script', { agent: 'codex', prompt: 'BRANCH_B' }),
    node('board-a', 'storyboard'), node('board-b', 'storyboard'),
    node('generate-a', 'generate', { model: 'fixture_image', prompt: 'Illustrate A', sceneIndex: 0 }), node('generate-b', 'generate', { model: 'fixture_image', prompt: 'Illustrate B', sceneIndex: 0 }),
    node('render-a', 'render'), node('render-b', 'render'),
  ], [['root', 'script-a'], ['root', 'script-b'], ['script-a', 'board-a'], ['script-b', 'board-b'], ['board-a', 'generate-a'], ['board-b', 'generate-b'], ['generate-a', 'render-a'], ['generate-b', 'render-b']]));
  const source = await f.execute('script-a', { selectedStages: ['script-a', 'script-b', 'board-a', 'board-b'], startStage: undefined });
  assert.equal(source.status, 'completed', JSON.stringify(source));
  assert.deepEqual(record(source, 'board-a').output.scenes.map(item => item.id), ['branch-a']);
  assert.deepEqual(record(source, 'board-b').output.scenes.map(item => item.id), ['branch-b']);
  const current = (await f.api('/api/state')).episodes.find(item => item.id === f.episode.id);
  assert.deepEqual(current.scenes.map(item => item.id), ['branch-b']);
  const quote = id => f.request(`/api/workflows/${f.workflow.id}/quote`, 'POST', { episodeId: current.id, expectedEpisodeVersion: current.version, expectedWorkflowVersion: f.workflow.version, selectedStages: [id], startStage: id, resumeRunId: source.id, disclosure: { containsSyntheticMedia: true, rationale: 'Fixture illustration only' } });
  const matching = await quote('generate-b');
  assert.equal(matching.status, 200, await matching.clone().text());
  assert.deepEqual((await matching.json()).candidate.scenes.map(item => item.sceneId), ['branch-b']);
  const mismatch = await quote('generate-a');
  assert.equal(mismatch.status, 409, await mismatch.text());
  assert.deepEqual((await f.api(`/api/workflow-runs/${source.id}`)).nodeRuns, source.nodeRuns);
});
