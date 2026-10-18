import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHiggsfieldApi, normalizeHiggsfieldJob, validateHiggsfieldAssetUrl, isPublicAddress, downloadHiggsfieldAsset } from '../server/higgsfield.mjs';
import { createHiggsfieldMcp } from '../scripts/higgsfield-mcp.mjs';
import { createApp } from '../server/app.mjs';

const model = 'bytedance/seedance-2.5/text-to-video';
test('Higgsfield API preserves complete credential and verified endpoint; never follows returned status URLs', async () => {
  const calls = [];
  const api = createHiggsfieldApi({ env: { HF_API_KEY: 'fixture:key' }, fetchImpl: async (url, options) => { calls.push({url,options}); return Response.json({ request_id: 'job-1', status: 'queued', status_url: 'http://127.0.0.1/secret' }); } });
  assert.equal(api.configured, true);
  await api.create({ model, prompt: 'Korean seaside', params: { duration: 5 } });
  await api.status('job-1');
  assert.equal(calls[0].url, `https://api.higgsfield.ai/${model}`);
  assert.equal(calls[0].options.headers.authorization, 'Key fixture:key');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[1].url, 'https://api.higgsfield.ai/requests/job-1/status');
});
test('Higgsfield API validates schema before any provider call', async () => {
  let calls = 0;
  const api = createHiggsfieldApi({ env: { HF_API_KEY: 'fixture' }, fetchImpl: async () => { calls++; } });
  for (const params of [{ duration: 100 }, { duration: 4.2 }, { resolution: '4k' }, { callback_url: 'https://evil.invalid' }]) await assert.rejects(api.create({ model, prompt: 'test', params }));
  await assert.rejects(api.create({ model: 'seedance_2_5', prompt: 'test' }));
  await assert.rejects(api.status('../secrets'));
  assert.equal(calls, 0);
});
test('missing API credentials do not invent success and provider errors do not disclose secret bodies', async () => {
  await assert.rejects(createHiggsfieldApi({ env: {} }).status('job-1'), { code: 'NOT_CONFIGURED' });
  const api = createHiggsfieldApi({ env: { HF_API_KEY: 'fixture-secret' }, fetchImpl: async () => new Response('fixture-secret private diagnostic', { status: 401 }) });
  await assert.rejects(api.status('job-1'), error => error.code === 'AUTH_REQUIRED' && !error.message.includes('fixture-secret'));
});
test('ambiguous generation submission is never automatically retried', async () => {
  let calls = 0;
  const api = createHiggsfieldApi({ env: { HF_API_KEY: 'fixture' }, fetchImpl: async () => { calls++; throw new Error('secret'); } });
  await assert.rejects(api.create({ model, prompt: 'test' }), { code: 'AMBIGUOUS_SUBMISSION' });
  assert.equal(calls, 1);
});
test('malformed successful provider submission is recorded as ambiguous rather than safe to retry', async () => {
  for (const response of [Response.json({unexpected:true}), new Response('invalid-json')]) {
    const api=createHiggsfieldApi({env:{HF_API_KEY:'fixture'},fetchImpl:async()=>response});
    await assert.rejects(api.create({model,prompt:'test'}),{code:'AMBIGUOUS_SUBMISSION'});
  }
});
test('normalization retains terminal states and rejects multi-job submissions', () => {
  assert.deepEqual(normalizeHiggsfieldJob(['job-1'], 'cli'), { requestId: 'job-1', status: 'queued', outputs: [], transport: 'cli' });
  assert.equal(normalizeHiggsfieldJob({request_id:'job-1',status:'nsfw'}).status, 'nsfw');
  assert.equal(normalizeHiggsfieldJob({id:'job-1',status:'completed',result_url:'https://d8j0ntlcm91z4.cloudfront.net/x.mp4'}, 'cli').outputs[0].type, 'video');
  assert.throws(() => normalizeHiggsfieldJob(['a','b']), { code: 'AMBIGUOUS_SUBMISSION' });
});
test('asset URL and address allowlists reject localhost, hostile hosts, credentials and private DNS', async () => {
  for (const url of ['http://images.higgs.ai/a.png','https://127.0.0.1/a.png','https://images.higgs.ai.evil.invalid/a.png','https://user:pass@images.higgs.ai/a.png','https://evil.cloudfront.net/a.png']) assert.throws(() => validateHiggsfieldAssetUrl(url));
  for (const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.2','169.254.169.254','::1','::ffff:127.0.0.1']) assert.equal(isPublicAddress(address),false);
  await assert.rejects(downloadHiggsfieldAsset('https://images.higgs.ai/a.png','unused', { lookupImpl: async () => [{ address:'127.0.0.1',family:4 }] }), { code:'UNTRUSTED_ASSET' });
});
function requestFixture(statusCode, body, type = 'video/mp4') {
  return (url, options, callback) => {
    assert.equal(url.protocol, 'https:');
    options.lookup(url.hostname, {}, (error,address) => { assert.equal(error,null); assert.equal(address,'8.8.8.8'); });
    const response = Readable.from([Buffer.from(body)]);
    response.statusCode = statusCode; response.headers = { 'content-type': type };
    queueMicrotask(() => callback(response));
    return new EventEmitter();
  };
}
test('asset downloader pins public DNS, bounds bytes, refuses redirects and never overwrites an existing asset', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'ff-higgs-'));
  try {
    const target = path.join(root,'video.mp4');
    const options = { lookupImpl: async () => [{address:'8.8.8.8',family:4}], requestImpl: requestFixture(200,'fixture') };
    assert.equal((await downloadHiggsfieldAsset('https://images.higgs.ai/x.mp4',target,options)).bytes,7);
    assert.equal(await readFile(target,'utf8'),'fixture');
    await assert.rejects(downloadHiggsfieldAsset('https://images.higgs.ai/x.mp4',target,options), { code:'EEXIST' });
    assert.equal(await readFile(target,'utf8'),'fixture');
    const failed = path.join(root,'failed.mp4');
    await assert.rejects(downloadHiggsfieldAsset('https://images.higgs.ai/x.mp4',failed,{...options,requestImpl:requestFixture(302,'redirect')}));
    await assert.rejects(access(failed));
    await assert.rejects(downloadHiggsfieldAsset('https://images.higgs.ai/x.mp4',failed,{...options,maxBytes:2}));
    await assert.rejects(access(failed));
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('MCP tools identify project bridge and preserve version/idempotency arguments across authenticated API', async () => {
  const calls = [];
  const handle = createHiggsfieldMcp({env:{FRAMEFORGE_TOKEN:'fixture'},fetchImpl:async (url,options) => { calls.push({url,options}); return url.pathname==='/api/login'?Response.json({authenticated:true},{headers:{'set-cookie':`frameforge_session=${'a'.repeat(64)}; HttpOnly; Path=/`}}):Response.json({id:'generation-1'}); }});
  const init = await handle({jsonrpc:'2.0',id:1,method:'initialize'});
  assert.equal(init.result.serverInfo.name,'frameforge-higgsfield-bridge');
  assert.equal(await handle({jsonrpc:'2.0',method:'notifications/initialized'}),null);
  const args = {episodeId:'episode-1',sceneId:'scene-1',expectedVersion:3,requestId:'dedupe-1',model:'seedance_2_5',prompt:'test'};
  const result = await handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'higgsfield_create',arguments:args}});
  assert.equal(result.result.isError,undefined);
  assert.equal(calls[0].url.pathname,'/api/login');
  assert.equal(JSON.parse(calls[0].options.body).token,'fixture');
  assert.equal(calls[1].url.pathname,'/api/episodes/episode-1/generations');
  assert.equal(calls[1].options.headers.cookie,`frameforge_session=${'a'.repeat(64)}`);
  assert.equal(calls[1].options.headers.authorization,undefined);
  assert.equal(JSON.parse(calls[1].options.body).requestId,'dedupe-1');
  assert.equal(JSON.parse(calls[1].options.body).expectedVersion,3);
  const invalid = await handle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'higgsfield_apply',arguments:{generationId:'../secret',sceneId:'scene-1',expectedVersion:3}}});
  assert.equal(invalid.result.isError,true); assert.equal(calls.length,2);
  const recovered=await handle({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'higgsfield_recover',arguments:{generationId:'generation-1'}}});
  assert.equal(recovered.result.isError,undefined);
  assert.equal(calls[2].url.pathname,'/api/generations/generation-1/recover');
  assert.equal(calls[2].options.method,'POST');
  assert.deepEqual(JSON.parse(calls[2].options.body),{});
});
test('MCP authenticates against the actual cookie-only app before listing models without generation', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'ff-higgs-mcp-auth-'));
  let creates=0;
  const app=createApp({dataDir:root,loginToken:'fixture-login-token',generation:{transport:'api',models:async()=>[{id:'fixture',type:'image'}],create:async()=>{creates++;throw new Error('must not generate');}}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${app.address().port}`;
    assert.equal((await fetch(`${base}/api/generation/models`,{headers:{authorization:'Bearer fixture-login-token'}})).status,401);
    const handle=createHiggsfieldMcp({env:{FRAMEFORGE_URL:base,FRAMEFORGE_TOKEN:'fixture-login-token'}});
    const result=await handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'higgsfield_models',arguments:{}}});
    assert.equal(result.result.isError,undefined,JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.result.content[0].text),[{id:'fixture',type:'image'}]);
    assert.equal(creates,0);
  } finally { await new Promise(resolve=>{app.close(resolve);app.closeAllConnections();});await rm(root,{recursive:true,force:true}); }
});
test('MCP reauthenticates stale sessions for GET only and never replays a create POST', async () => {
  const calls=[];let gets=0;
  const handle=createHiggsfieldMcp({env:{FRAMEFORGE_TOKEN:'fixture'},fetchImpl:async(url,options)=>{
    calls.push({path:url.pathname,method:options.method});
    if(url.pathname==='/api/login')return Response.json({authenticated:true},{headers:{'set-cookie':`frameforge_session=${'b'.repeat(64)}; Path=/`}});
    if(options.method==='GET' && gets++>0)return Response.json([]);
    return Response.json({error:'Unauthorized'},{status:401});
  }});
  const result=await handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'higgsfield_models',arguments:{}}});
  assert.equal(result.result.isError,undefined);assert.equal(gets,2);
  const failed=await handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'higgsfield_create',arguments:{episodeId:'e',sceneId:'s',expectedVersion:1,model:'fixture',prompt:'test',requestId:'unique'}}});
  assert.equal(failed.result.isError,true);
  assert.equal(calls.filter(item=>item.path==='/api/episodes/e/generations').length,1);
});
test('MCP real stdio process emits only newline JSON-RPC for initialize, notification and tools/list', async () => {
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/higgsfield-mcp.mjs',import.meta.url))],{windowsHide:true,env:{...process.env,FRAMEFORGE_URL:'http://127.0.0.1:4310'}});
  let stdout=''; let stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;}); child.stderr.on('data',chunk=>{stderr+=chunk;});
  const result=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  child.stdin.end([
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list'},
  ].map(x=>JSON.stringify(x)).join('\n')+'\n');
  assert.equal(await result,0); assert.equal(stderr,'');
  const replies=stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(replies.length,2); assert.equal(replies[0].result.serverInfo.name,'frameforge-higgsfield-bridge');
  assert.deepEqual(replies[1].result.tools.map(t=>t.name),['higgsfield_models','higgsfield_create','higgsfield_status','higgsfield_recover','higgsfield_apply']);
});
