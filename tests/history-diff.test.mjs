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
