import test from 'node:test';
import assert from 'node:assert/strict';
import { createHiggsfieldCli, buildHiggsfieldCliArgs } from '../server/higgsfield-cli.mjs';
const schema = {job_type:'seedance_2_5',display_name:'Seedance 2.5',type:'video',params:[{name:'prompt',type:'string',required:true},{name:'duration',type:'integer'},{name:'batch_size',type:'integer'},{name:'start_image',type:'string'},{name:'mode',type:'string',enum:['t2v','omni_reference']}]};
test('CLI discovery precedes generation and async create returns a provider ID without wait', async () => {
  const calls=[];
  const cli=createHiggsfieldCli({execute:async args => { calls.push(args); return {stdout:JSON.stringify(args[0]==='model'?(args[1]==='list'?[{job_type:'seedance_2_5',display_name:'Seedance 2.5',type:'video'}]:schema):['job-1'])}; }});
  const job=await cli.create({model:'seedance_2_5',prompt:'A portrait; $(not a command)',params:{duration:5}});
  assert.equal(job.requestId,'job-1'); assert.equal(job.transport,'cli');
  assert.deepEqual(calls[0],['model','list','--json']);
  assert.equal(calls[2].includes('--wait'),false);
  assert.ok(calls[2].includes('--batch_size=1'));
  assert.ok(calls[2].includes('--prompt=A portrait; $(not a command)'));
});
test('CLI rejects file uploads, arbitrary flags, batches and unknown schema values before spawn', () => {
  const input={model:'seedance_2_5',prompt:'test'};
  for (const params of [{batch_size:2},{start_image:'C:/secret'},{mode:'evil'},{workspace:'private'},{prompt:'@C:/secret'}]) assert.throws(()=>buildHiggsfieldCliArgs('create',{...input,params,prompt:params.prompt||input.prompt},schema));
  assert.throws(()=>buildHiggsfieldCliArgs('create',{...input,model:'--help'},schema));
  assert.throws(()=>buildHiggsfieldCliArgs('status',{requestId:'../secret'}));
});
test('CLI failures redact raw output and never retry paid submissions', async () => {
  let calls=0;
  const cli=createHiggsfieldCli({execute:async args => { calls++; if(args[0]==='model')return {stdout:JSON.stringify(args[1]==='list'?[{job_type:'seedance_2_5'}]:schema)}; throw new Error('private-token'); }});
  await assert.rejects(cli.create({model:'seedance_2_5',prompt:'test'}),error=>error.code==='AMBIGUOUS_SUBMISSION'&&!error.message.includes('private-token'));
  assert.equal(calls,3);
});
test('CLI status never submits and preserves completed output', async () => {
  const cli=createHiggsfieldCli({execute:async args=>{assert.deepEqual(args,['generate','get','job-1','--json']);return {stdout:JSON.stringify({id:'job-1',status:'completed',result_url:'https://images.higgs.ai/video.mp4'})};}});
  assert.equal((await cli.status('job-1')).outputs[0].type,'video');
});
test('CLI account capability verifies official account response without returning personal fields', async () => {
  const cli=createHiggsfieldCli({execute:async args=>{assert.deepEqual(args,['account','status','--json']);return {stdout:JSON.stringify({email:'fixture@example.invalid',credits:12,subscription_plan_type:'fixture'})};}});
  assert.deepEqual(await cli.accountStatus(),{provider:'higgsfield',transport:'cli',configured:true,authenticated:true,available:true});
  const expired=createHiggsfieldCli({execute:async ()=>{throw new Error('Session expired fixture@example.invalid');}});
  assert.equal((await expired.accountStatus()).available,false);
});
