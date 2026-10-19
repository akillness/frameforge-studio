import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpsStore,normalizeOpsView,OPS_STORAGE_KEY,opsQueue,opsDeliverables,localMediaUrl,opsJobGroups} from '../public/workspace-state.js';

// Synthetic test fixtures only. Product defaults never contain these records.
const data={channels:[{id:'c1',name:'한국어 채널'},{id:'c2',name:'두 번째'}],episodes:[
  {id:'e1',title:'한글 장면',channelId:'c1',status:'review',version:2,updatedAt:'2026-10-18T01:00:00Z',format:'9:16',scenes:[{id:'s1',assetUrl:'/api/uploads/asset.png',audioUrl:'/api/uploads/voice.wav'}]},
  {id:'e2',title:'다음 이야기',channelId:'c2',status:'draft',version:3,updatedAt:'2026-10-19T01:00:00Z',scenes:[]},
  {id:'e3',title:'누락된 채널',channelId:'missing',status:'ready',version:1,updatedAt:'invalid',scenes:[]},
],jobs:[{id:'r1',episodeId:'e1',episodeVersion:1,status:'completed',outputUrl:'/api/exports/final.mp4',sha256:'actual-returned-hash'},{id:'r2',episodeId:'e2',status:'failed',outputUrl:'/api/exports/failed.mp4'}],generationJobs:[{id:'g1',episodeId:'e1',episodeVersion:1,outputs:[{url:'/api/uploads/asset.png',sha256:'source-hash',type:'image/png',width:800,height:600}]}],narrationJobs:[],workflowRuns:[]};
function memory(raw) { const values=new Map([['frameforge.workspace.v1','editor-layout-sentinel'],['unrelated','keep']]);if(raw!==undefined)values.set(OPS_STORAGE_KEY,raw); return {values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}; }

test('queue maps only returned records and filters Korean title, channel and stable identity without mutation',()=>{
 const before=structuredClone(data);
 assert.deepEqual(opsQueue(data,{channel:'c1',status:'review',query:'한국어'}).map(item=>item.id),['e1']);
 assert.deepEqual(opsQueue(data,{query:'E2'}).map(item=>item.id),['e2']);
 assert.deepEqual(opsQueue(data,{query:'not found'}),[]);
 assert.equal(opsQueue(data,{query:'missing'})[0].channelName,'missing');
 assert.deepEqual(data,before);
});
test('queue ordering uses supplied versions and timestamps with stable fallback',()=>{
 assert.deepEqual(opsQueue(data).map(item=>item.id),['e2','e1','e3']);
 assert.deepEqual(opsQueue(data,{sort:'version',direction:'asc'}).map(item=>item.id),['e3','e1','e2']);
 assert.deepEqual(opsQueue({episodes:[...data.episodes].reverse()},{sort:'status',direction:'asc'}).map(item=>item.id),['e2','e3','e1']);
});
test('missing source differs from successfully empty source',()=>{
 assert.equal(opsQueue({}),null);assert.deepEqual(opsQueue({episodes:[]}),[]);
 assert.equal(opsJobGroups({})[0].available,false);assert.equal(opsJobGroups({jobs:[]})[0].available,true);
});
test('deliverables compose real local references, deduplicate and retain exact job provenance',()=>{
 const items=opsDeliverables(data);assert.equal(items.length,3);
 const generated=items.find(item=>item.url.endsWith('asset.png'));
 assert.equal(generated.episodeVersion,1);assert.equal(generated.attachedVersion,2);assert.equal(generated.sha256,'source-hash');
 const render=items.find(item=>item.jobId==='r1');assert.equal(render.episodeVersion,1);assert.equal(render.sha256,'actual-returned-hash');
 assert.ok(!items.some(item=>item.url.includes('failed')));assert.deepEqual(opsDeliverables({}),[]);
});
test('media links never accept remote, scripted, traversal or credential-bearing URLs',()=>{
 for(const value of ['https://example.com/a.mp4','//example.com/a.png','javascript:alert(1)','/api/uploads/../secret','/api/exports/a.mp4?token=secret','/api/uploads/%2e%2e.png',null])assert.equal(localMediaUrl(value),null);
 assert.equal(localMediaUrl('/api/uploads/safe-id.wav'),'/api/uploads/safe-id.wav');
});
test('preferences persist separately from editor layout and never use network',()=>{
 const storage=memory(), store=createOpsStore({storage});
 store.update({query:'검토',status:'review',columns:['status','version'],sort:'title',direction:'asc'});store.save('검토 보기');
 const restored=createOpsStore({storage});assert.deepEqual(restored.getState(),store.getState());
 assert.equal(storage.values.get('frameforge.workspace.v1'),'editor-layout-sentinel');assert.equal(storage.values.get('unrelated'),'keep');
 assert.equal(storage.values.size,3);
 const snapshot=restored.getState();snapshot.current.columns.push('channel');assert.equal(restored.getState().current.columns.length,2);
 restored.update({query:''});restored.select('검토 보기');assert.equal(restored.getState().current.query,'검토');
});
test('separate browser stores do not share preferences',()=>{
 const a=createOpsStore({storage:memory()}),b=createOpsStore({storage:memory()});a.update({query:'private'});a.save('local');assert.equal(b.getState().saved.length,0);assert.equal(b.getState().current.query,'');
});
test('invalid, oversized, duplicate and inaccessible storage recover honestly',()=>{
 for(const raw of ['{bad',JSON.stringify({version:2}), 'x'.repeat(32769),JSON.stringify({version:1,current:{},saved:[{name:'A',view:{}},{name:'a',view:{}}]})]){
  const store=createOpsStore({storage:memory(raw)});assert.ok(store.getState().error);assert.deepEqual(store.getState().current,normalizeOpsView());assert.deepEqual(store.getState().saved,[]);
 }
 const unavailable=createOpsStore({storage:null});unavailable.update({query:'session'});assert.ok(unavailable.getState().error);assert.equal(unavailable.getState().current.query,'session');
 const locked=createOpsStore({storage:{getItem:()=>null,setItem:()=>{throw Error('denied');}}});locked.save('session');assert.ok(locked.getState().error);assert.equal(locked.getState().saved.length,1);
});
test('saved views are bounded, replace by normalized name, delete and reset safely',()=>{
 const store=createOpsStore({storage:memory()});store.save('검토');store.update({status:'review'});store.save(' 검토 ');assert.equal(store.getState().saved.length,1);
 for(let i=0;i<11;i++)store.save(`보기 ${i}`);assert.throws(()=>store.save('too many'));assert.throws(()=>store.save(' '));
 store.remove('보기 0');assert.equal(store.getState().saved.length,11);store.reset();assert.equal(store.getState().saved.length,0);assert.deepEqual(store.getState().current,normalizeOpsView());
});
test('hostile view options are normalized to supported presentation fields only',()=>{
 const p=normalizeOpsView({columns:['owner','status','status'],sort:'deadline',direction:'sideways',query:{},channel:42,productionStatus:'approved'});
 assert.deepEqual(p.columns,['status']);assert.equal(p.sort,'updatedAt');assert.equal(p.direction,'desc');assert.equal(p.query,'');assert.ok(!('productionStatus' in p));
});
import {createOperationalWorkspace} from '../public/workspace.js';

test('operational HTML escapes API and preference content instead of inventing records',()=>{
 const hostile=structuredClone(data);hostile.episodes[0].title='<script>attack</script>';hostile.channels[0].name='\" onclick=attack';
 const overview=createOperationalWorkspace({getData:()=>hostile,api:()=>{throw Error('Unexpected API call');},refresh:()=>{throw Error('Unexpected refresh');}}).html();
 assert.ok(overview.includes('&lt;script&gt;attack&lt;/script&gt;'));assert.ok(!overview.includes('<script>attack'));
 assert.ok(overview.includes('/api/exports/final.mp4'));assert.ok(!overview.includes('owner'));
});
test('overview distinguishes unavailable read sources and explicitly empty sources',()=>{
 const unavailable=createOperationalWorkspace({getData:()=>({})}).html();
 assert.ok(unavailable.includes('에피소드 자료를 확인할 수 없습니다.'));assert.ok(unavailable.includes('결과물 자료를 확인할 수 없습니다.'));
 const empty=createOperationalWorkspace({getData:()=>({episodes:[],channels:[],jobs:[],generationJobs:[],events:[]})}).html();
 assert.ok(empty.includes('조건에 맞는 에피소드가 없습니다.'));assert.ok(empty.includes('로컬 결과물을 찾지 못했습니다.'));assert.ok(!empty.includes('data-episode-id='));
});
