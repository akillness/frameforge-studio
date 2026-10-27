import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { renderEpisode } from '../server/render.mjs';
import { Store } from '../server/store.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('music-free workflow review and publication reject missing or forged scene receipts', { timeout: 180000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'scene-workflow-publication-'));
  let renderFinished;
  let editor;
  const rendered = new Promise(resolve => { renderFinished = resolve; });
  const external = [];
  const unexpected = async url => { external.push(String(url)); throw new Error('Unexpected provider call'); };
  const app = createApp({ dataDir, loginToken: '', publicOrigin: '',
    renderer: async (episode, options) => { try { return await renderEpisode(episode, options); } finally { renderFinished(); } },
    integrations: { integrationStatus: async () => ({}) },
    mediaOptions: { fetchImpl: unexpected }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: unexpected }, publicationOptions: { fetchImpl: unexpected },
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { editor?.close(); await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  async function request(url, method = 'GET', body) {
    const response = await fetch(base + url, { method, headers: { origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    return { response, value };
  }
  async function api(url, method = 'GET', body) {
    const { response, value } = await request(url, method, body);
    assert.ok(response.ok, `${method} ${url}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  const uploaded = await fetch(`${base}/api/uploads?name=scene.png`, { method: 'POST', headers: { origin: base }, body: PNG });
  assert.equal(uploaded.status, 201);
  const upload = await uploaded.json();
  const hash = createHash('sha256').update(PNG).digest('hex');
  assert.equal(upload.sha256, hash);
  const source = { origin: 'third-party', useAs: 'illustration', sha256: hash, sourceUrl: 'https://example.invalid/scene', licenseId: 'CC-BY-4.0', attribution: 'Scene Artist' };
  await api(`/api/uploads/${upload.id}/rights`, 'POST', source);
  let channel = await api('/api/channels', 'POST', { name: 'Fixture', category: 'information', platform: 'YouTube' });
  channel = await api(`/api/channels/${channel.id}/youtube`, 'PUT', { externalId: `UC${'A'.repeat(22)}`, expectedUpdatedAt: channel.updatedAt });
  let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: 'Scene workflow', topic: 'Original fixture' });
  episode = await api(`/api/episodes/${episode.id}`, 'PUT', { expectedVersion: episode.version, format: '1:1', scenes: [{ ...episode.scenes[0], kind: 'image', assetUrl: upload.url, source, title: 'Fixture', text: 'Original card', duration: 1, background: '#173940', layout: 'center' }] });
  const types = ['script', 'storyboard', 'render', 'review'];
  const template = await api('/api/workflows', 'POST', { name: 'Scene workflow', nodes: types.map((type, i) => ({ id: type, type, x: i * 200, y: 0, config: type === 'script' ? { agent: 'existing' } : {} })), edges: types.slice(1).map((target, i) => ({ id: `e${i}`, source: types[i], target })) });
  const workflow = await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const started = await api(`/api/workflows/${workflow.id}/run`, 'POST', { episodeId: episode.id, expectedEpisodeVersion: episode.version, expectedWorkflowVersion: workflow.version, selectedStages: types });
  await rendered;
  let run;
  for (let turn = 0; turn < 2000; turn++) {
    run = await api(`/api/workflow-runs/${started.id}`);
    if (['awaiting_review', 'failed', 'cancelled'].includes(run.status)) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(run.status, 'awaiting_review', JSON.stringify(run));
  const render = run.nodeRuns.find(node => node.nodeId === 'render');
  const state = await api('/api/state');
  const job = state.jobs.find(item => item.id === render.output.jobId);
  assert.deepEqual(render.output.verifiedSceneAssets, job.verifiedSceneAssets);
  assert.deepEqual(job.sceneIntegrity, job.verifiedSceneAssets);
  assert.equal(job.verifiedSceneAssets.find(item => item.assetUrl === upload.url).sha256, hash);
  const mp4 = await readFile(path.join(dataDir, 'exports', job.filename));
  assert.equal(createHash('sha256').update(mp4).digest('hex'), render.output.sha256);
  editor = new Store(dataDir);
  const reviewBody = { reviewNodeId: 'review', decision: 'approved', notes: 'Reviewed exact render', expectedEpisodeVersion: run.episodeVersion };
  const reviewUrl = `/api/workflows/${workflow.id}/runs/${run.id}/review`;
  const noReceipt = { ...job }; delete noReceipt.verifiedSceneAssets;
  editor.save('jobs', noReceipt);
  assert.equal((await request(reviewUrl, 'POST', reviewBody)).response.status, 409, 'review must not bless a job with no receipt');
  editor.save('jobs', job);
  const reviewed = await api(reviewUrl, 'POST', reviewBody);
  assert.equal(reviewed.reviews.review.sha256, render.output.sha256);
  const approvalBody = { workflowId: workflow.id, runId: run.id, reviewNodeId: 'review', expectedEpisodeVersion: run.episodeVersion, title: 'Scene workflow', description: 'Fixture description', categoryId: '25', tags: ['fixture'], selfDeclaredMadeForKids: false, containsSyntheticMedia: false, disclosureRationale: 'Original fixture', rightsAcknowledged: true };
  const approval = await api('/api/publication/approvals', 'POST', approvalBody);
  assert.equal(approval.manifest.render.sha256, render.output.sha256);
  const currentRun = editor.get('workflowRuns', run.id);
  const currentRender = currentRun.nodeRuns.find(node => node.nodeId === 'render');
  const setOutput = output => editor.save('workflowRuns', { ...currentRun, nodeRuns: currentRun.nodeRuns.map(node => node.nodeId === 'render' ? { ...node, output } : node) });
  const forged = job.verifiedSceneAssets.map(item => ({ ...item, sha256: 'f'.repeat(64) }));
  const cases = [
    ['job receipt missing', () => editor.save('jobs', noReceipt), () => editor.save('jobs', job)],
    ['render receipt missing', () => { const output = { ...currentRender.output }; delete output.verifiedSceneAssets; setOutput(output); }, () => editor.save('workflowRuns', currentRun)],
    ['same forged receipts disagree with queued asset', () => { editor.save('jobs', { ...job, verifiedSceneAssets: forged }); setOutput({ ...currentRender.output, verifiedSceneAssets: forged }); }, () => { editor.save('jobs', job); editor.save('workflowRuns', currentRun); }],
    ['registered asset hash changed', () => { const saved = editor.get('uploads', upload.id); editor.save('uploads', { ...saved, sha256: 'e'.repeat(64) }); }, () => { const saved = editor.get('uploads', upload.id); editor.save('uploads', { ...saved, sha256: hash }); }],
  ];
  for (const [name, change, restore] of cases) await t.test(name, async () => {
    await change();
    try {
      assert.equal((await request('/api/publication/approvals', 'POST', approvalBody)).response.status, 409);
      assert.equal((await request(`/api/publication/approvals/${approval.id}/publish`, 'POST', {})).response.status, 409);
      assert.deepEqual(external, []);
    } finally { await restore(); }
  });
});
