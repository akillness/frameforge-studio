import test from 'node:test';
import assert from 'node:assert/strict';
import {episodeChanges,workflowChanges,nodeChanges,changesHtml,createDraftHistory,historyReason} from '../public/history.js';

test('episode comparison follows scene IDs across reorder, ignores metadata and reports real field edits',()=>{
  const a={version:1,title:'제목',scenes:[{id:'a',title:'훅',text:'전'},{id:'b',title:'끝',text:'동일'}]};
  const b={...a,version:8,updatedAt:'later',scenes:[a.scenes[1],{...a.scenes[0],text:'후'}]};
  assert.deepEqual(episodeChanges(a,b).map(change=>[change.field,change.before,change.after]),[['text','전','후'],['order',['훅','끝'],['끝','훅']]]);
  assert.equal(episodeChanges(a,{...a,version:9}).length,0);
});
test('scene additions and removals are not mistaken for edits at the same array index',()=>{
  const result=episodeChanges({scenes:[{id:'a',title:'기존'}]},{scenes:[{id:'b',title:'새 장면'}]});
  assert.deepEqual(result.map(change=>change.kind),['removed','added']);
});
test('history treats implicit scene defaults as unchanged and displays exact restore source version',()=>{
  assert.deepEqual(episodeChanges({scenes:[{id:'a'}]},{scenes:[{id:'a',audioVolume:1,trimStart:0,narration:''}]}),[]);
  assert.equal(historyReason('restore:v3'),'v3에서 복원');assert.equal(historyReason('restore:3'),'v3에서 복원');
});
test('history reports composition geometry by layer while preserving independent slot changes',()=>{
  const before={scenes:[{id:'a',title:'Scene',slots:[{id:'top',role:'visual',text:'Before'}],composition:{title:{x:.1,y:.2,width:.8,height:.1}}}]};
  const after=structuredClone(before);
  after.scenes[0].composition.title={x:.2,y:.2,width:.7,height:.1};
  after.scenes[0].slots[0].text='After';
  const changes=episodeChanges(before,after);
  assert.deepEqual(changes.map(change=>change.field),['slots','composition.title']);
  assert.deepEqual(changes[0].before,before.scenes[0].slots);
  assert.deepEqual(changes[0].after,after.scenes[0].slots);
  assert.deepEqual(changes[1].before,before.scenes[0].composition.title);
  assert.deepEqual(changes[1].after,after.scenes[0].composition.title);
});
test('history treats migrated composition defaults as unchanged for each legacy layout',()=>{
  const media={x:0,y:0,width:1,height:1};
  const defaults={
    center:{media,title:{x:.08,y:.32,width:.84,height:.16},body:{x:.08,y:.50,width:.84,height:.26}},
    'lower-third':{media,title:{x:.08,y:.65,width:.84,height:.10},body:{x:.08,y:.76,width:.84,height:.16}},
    split:{media:{...media,height:.5},title:{x:.08,y:.56,width:.84,height:.12},body:{x:.08,y:.70,width:.84,height:.22}},
  };
  for (const [layout,composition] of Object.entries(defaults)) {
    const before={scenes:[{id:'a',layout,slots:[{id:'top',role:'visual'}]}]};
    const after=structuredClone(before);after.scenes[0].composition=composition;
    assert.deepEqual(episodeChanges(before,after),[],layout);
    assert.deepEqual(episodeChanges(after,before),[],layout);
  }
});
test('draft undo and redo preserve geometry and slot contents without aliasing snapshots',()=>{
  const before={scenes:[{id:'a',slots:[{id:'top',text:'Keep'}],composition:{body:{x:.1,y:.2,width:.8,height:.3}}}]};
  const after=structuredClone(before);after.scenes[0].composition.body.x=.2;
  const history=createDraftHistory();history.reset(before);history.record(after,'composition.body');
  const restored=history.undo();assert.deepEqual(restored,before);
  restored.scenes[0].slots[0].text='Temporary';
  assert.deepEqual(history.redo(),after);
  assert.deepEqual(history.undo(),before);
});
test('workflow comparison detects configuration, labels and semantic edges without edge ID noise',()=>{
  const a={name:'제작',nodes:[{id:'s',type:'script',config:{agent:'existing',prompt:'전'}},{id:'r',type:'render',config:{}}],edges:[{id:'old',source:'s',target:'r'}]};
  const b=structuredClone(a); b.nodes[0].label='나의 대본';b.nodes[0].config.prompt='후';b.edges[0].id='new';
  assert.deepEqual(workflowChanges(a,b).map(change=>change.field),['label','prompt']);
  b.edges=[];assert.equal(workflowChanges(a,b).at(-1).label,'연결 삭제');
  assert.equal(nodeChanges(null,b.nodes[0])[0].kind,'added');
});
test('comparison HTML escapes content in both headings and values',()=>{
  const escape=value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;');
  const html=changesHtml([{scope:'<script>',label:'<x>',before:'<img>',after:'<svg>',kind:'changed'}],escape);
  assert.equal(html.includes('<script>'),false);assert.ok(html.includes('&lt;img&gt;'));
});
test('draft undo groups typing, supports redo, forks history, bounds memory and clones values',()=>{
  const h=createDraftHistory(2);h.reset({name:'a'});h.record({name:'ab'},'name');h.record({name:'abc'},'name');
  assert.deepEqual(h.undo(),{name:'a'});assert.deepEqual(h.redo(),{name:'abc'});
  h.closeGroup();h.record({name:'b'});h.record({name:'c'});assert.deepEqual(h.undo(),{name:'b'});assert.deepEqual(h.undo(),{name:'abc'});assert.equal(h.undo(),null);
  h.record({name:'fork'});assert.equal(h.canRedo,false);const restored=h.undo();restored.name='mutated';assert.deepEqual(h.redo(),{name:'fork'});
});
