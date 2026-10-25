import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { defaultWorkflow, validateWorkflow } from '../server/workflows.mjs';
import { createAgentBridge } from '../scripts/agent-bridge.mjs';
import { createGenerationProvider } from '../server/generation-provider.mjs';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function graph() {
  const value = defaultWorkflow();
  value.nodes = value.nodes.filter(node => !['trend','research'].includes(node.type));
  value.nodes.push({ id: 'generate', type: 'generate', x: 600, y: 200, config: { model: 'fixture', prompt: 'Fixture visual', params: {}, sceneIndex: 0 } });
  value.edges = [{ id:'a',source:'script',target:'storyboard' },{ id:'b',source:'storyboard',target:'generate' },{ id:'c',source:'generate',target:'render' },{ id:'d',source:'render',target:'review' }];
  return value;
}

test('optional generation DAG requires explicit ordered connections and bounded parameters', () => {
  assert.equal(defaultWorkflow().nodes.some(node => node.type === 'generate'), false);
  assert.equal(validateWorkflow(graph()).nodes.length, 5);
  const disconnected = graph(); disconnected.edges[1].source = 'script';
  assert.throws(() => validateWorkflow(disconnected), { status: 400 });
  const invalid = graph(); invalid.nodes.at(-1).config.params = { nested: {} };
  assert.throws(() => validateWorkflow(invalid), { status: 400 });
});

test('authenticated bridge preserves safe errors and never invokes unauthenticated generation', async t => {
  let creates = 0;
  const token = 'fixture-private-bridge-token-123456';
  const base = await listen(createAgentBridge({ token, generation: {
    capability: async () => ({ available: true, transport: 'cli' }), models: async () => [{ id: 'fixture' }],
    create: async () => { creates++; throw Object.assign(new Error('secret-provider-output'), { code: 'INVALID_INPUT', statusCode: 400 }); },
  } }), t);
  assert.equal((await fetch(base + '/generation/create', { method:'POST' })).status, 401);
  assert.equal(creates, 0);
  const provider = createGenerationProvider({ env: { AGENT_BRIDGE_URL: base, AGENT_BRIDGE_TOKEN: token } });
  assert.equal((await provider.capability()).available, true);
  assert.equal((await provider.models())[0].id, 'fixture');
  await assert.rejects(provider.create({ model:'fixture', prompt:'test' }), error => error.status === 400 && error.code === 'INVALID_INPUT' && !error.message.includes('secret-provider-output'));
  assert.equal(creates, 1);
  const unsafe = createGenerationProvider({ env: { AGENT_BRIDGE_URL: 'http://example.com', AGENT_BRIDGE_TOKEN: token }, fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.equal((await unsafe.capability()).available, false);
});

test('workflow generation consent precedes edits; completed asset applies with versioned provenance', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-generation-api-'));
  let creates = 0;
  const generation = { transport:'api', capability:async () => ({available:true}), models:async () => [], modelSchema:async () => ({ type:'image', parameters:[{name:'prompt',type:'string',required:true}] }), create:async () => { creates++; return {requestId:'fixture-provider',status:'completed',outputs:[{url:'https://images.higgs.ai/fixture.png',type:'image'}]}; }, status:async () => { throw new Error('unexpected poll'); } };
  const base = await listen(createApp({ dataDir, loginToken: '', publicOrigin: '', generation, generationOptions: {
    pollIntervalMs:1, download:async (_url,file) => { await writeFile(file,'fixture bytes'); return { bytes:13,contentType:'image/png' }; }, probe:async () => ({kind:'image',width:64,height:64}),
  }, integrations:{ integrationStatus:async () => ({}) }, renderer:async (_episode,{dataDir}) => { await writeFile(path.join(dataDir,'exports','fixture.mp4'),'fixture render'); return {outputUrl:'/api/exports/fixture.mp4',filename:'fixture.mp4'}; } }), t);
  t.after(() => rm(dataDir, { recursive:true, force:true, maxRetries:3, retryDelay:100 }));
  const call = (route,body) => fetch(base+route,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
  const initial = await (await call('/api/state')).json();
  const episode = await (await call('/api/episodes',{channelId:initial.channels[0].id,title:'Generation fixture',topic:'Safe API test'})).json();
  const template = await (await call('/api/workflows',graph())).json();
  const copied = await call(`/api/workflows/${template.id}/copies`, { episodeId: episode.id, channelId: episode.channelId, expectedTemplateVersion: template.version });
  assert.equal(copied.status, 201); const workflow = await copied.json();
  assert.equal((await call(`/api/workflows/${workflow.id}/run`,{episodeId:episode.id})).status,400);
  assert.equal(creates,0);
  assert.equal((await (await call(`/api/episodes/${episode.id}/history`)).json()).length,1);
  const preparation = await call(`/api/workflows/${workflow.id}/run`, { episodeId: episode.id, selectedStages: ['script', 'storyboard'], startStage: 'script' });
  assert.equal(preparation.status, 202); const prepared = await preparation.json();
  let sourceRun;
  for (let i = 0; i < 200; i++) {
    sourceRun = (await (await call(`/api/workflows/${workflow.id}/runs`)).json()).find(item => item.id === prepared.id);
    if (['completed', 'failed'].includes(sourceRun.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(sourceRun.status, 'completed', JSON.stringify(sourceRun)); assert.equal(creates, 0);
  const selection = { resumeRunId: prepared.id, selectedStages: ['generate', 'render', 'review'], startStage: 'generate' };
  const disclosure = { containsSyntheticMedia: true, rationale: 'Explicit fixture generation disclosure' };
  const quote = await call(`/api/workflows/${workflow.id}/quote`, { episodeId: episode.id, disclosure, ...selection });
  assert.equal(quote.status, 200, await quote.clone().text()); const plan = await quote.json();
  const started = await call(`/api/workflows/${workflow.id}/run`, { episodeId: episode.id, allowGeneration: true, disclosure, ...selection, generationPlanId: plan.id, generationFingerprint: plan.fingerprint, acceptUnquotedEstimate: true });
  assert.equal(started.status, 202, await started.clone().text()); const run = await started.json();
  let complete;
  for (let i=0;i<200;i++) {
    complete = (await (await call(`/api/workflows/${workflow.id}/runs`)).json()).find(item => item.id === run.id);
    if (['awaiting_review','failed'].includes(complete.status)) break;
    await new Promise(resolve => setTimeout(resolve,10));
  }
  assert.equal(complete.status,'awaiting_review',JSON.stringify(complete));
  assert.equal(creates,1);
  const output = complete.nodeRuns.find(node => node.type === 'generate').output;
  const job = await (await call(`/api/generations/${output.generationJobId}`)).json();
  assert.equal(job.applied,true);
  assert.match(job.outputs[0].url,/^\/api\/uploads\//);
  const history = await (await call(`/api/episodes/${episode.id}/history`)).json();
  assert.equal(history[0].version,3);
  assert.match(history[0].reason,/^generation:/);
  assert.equal(history[0].snapshot.scenes[0].assetUrl,job.outputs[0].url);
});
