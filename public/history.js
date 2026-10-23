// Compare authored content by stable identity. Timestamps and version counters are metadata.
import {defaultComposition} from './composition.js';

export const FIELD_LABELS = {
  title:'제목',topic:'소재',format:'화면 비율',status:'제작 상태',notes:'메모',name:'이름',label:'노드 이름',
  text:'화면 텍스트',narration:'내레이션',duration:'길이 (초)',background:'배경',layout:'레이아웃',slots:'레이아웃 슬롯 구성',
  kind:'소스 종류',assetUrl:'이미지 / 영상',audioUrl:'오디오',audioVolume:'볼륨',trimStart:'영상 시작점',
  agent:'에이전트',prompt:'제작 지시문',query:'검색 키워드',keywords:'뉴스 키워드',maxArticles:'최대 뉴스 수',source:'뉴스 출처',
  limit:'참고 자료 수',preset:'레이아웃 프리셋',topSlotRole:'상단 모듈 용도',midSlotRole:'중단 모듈 용도',
  enableSubtitles:'자막 레이어 포함',enableHtmlOverlay:'HTML 오버레이 포함',autoPrompts:'슬롯 프롬프트 자동 생성',
  slotId:'대상 슬롯',targetMode:'생성 단위',instructions:'검토 지침',channelId:'대상 채널',platform:'플랫폼',
  visibility:'공개 범위',autoAttachExport:'서버 MP4 자동 첨부',titleTemplate:'제목 템플릿',x:'X 위치',y:'Y 위치',
  'composition.media':'미디어 배치','composition.title':'제목 배치','composition.body':'본문 배치',
};
const same = (a,b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
const fields = (before,after,keys,scope) => keys.filter(key=>!same(before?.[key],after?.[key])).map(key=>({scope,field:key,label:FIELD_LABELS[key] || key,before:before?.[key],after:after?.[key],kind:'changed'}));

export function episodeChanges(before,after) {
  const changes=fields(before,after,['title','topic','format','status','notes'],'에피소드');
  const oldScenes=before?.scenes || [],newScenes=after?.scenes || [];
  const oldIds=oldScenes.map(scene=>scene.id),newIds=newScenes.map(scene=>scene.id);
  for (const scene of oldScenes) if (!newIds.includes(scene.id)) changes.push({scope:scene.title || scene.id,field:'scene',label:'장면 삭제',before:scene,after:null,kind:'removed'});
  for (const scene of newScenes) {
    const previous=oldScenes.find(item=>item.id===scene.id),scope=scene.title || scene.id;
    if (!previous) changes.push({scope,field:'scene',label:'장면 추가',before:null,after:scene,kind:'added'});
    else {
      const compareKeys = ['title','text','narration','duration','background','layout','kind','assetUrl','audioUrl','audioVolume','trimStart'];
      if (previous.slots !== undefined || scene.slots !== undefined) compareKeys.push('slots');
      changes.push(...fields({audioVolume:1,trimStart:0,...previous},{audioVolume:1,trimStart:0,...scene},compareKeys,scope));
      const beforeComposition=previous.composition || defaultComposition(previous.layout),afterComposition=scene.composition || defaultComposition(scene.layout);
      for (const layer of ['media','title','body']) if (!same(beforeComposition[layer],afterComposition[layer])) changes.push({scope,field:`composition.${layer}`,label:FIELD_LABELS[`composition.${layer}`],before:beforeComposition[layer],after:afterComposition[layer],kind:'changed'});
    }
  }
  const commonOld=oldIds.filter(id=>newIds.includes(id)),commonNew=newIds.filter(id=>oldIds.includes(id));
  if (!same(commonOld,commonNew)) changes.push({scope:'타임라인',field:'order',label:'장면 순서',before:oldScenes.map(scene=>scene.title || scene.id),after:newScenes.map(scene=>scene.title || scene.id),kind:'moved'});
  return changes;
}

export function nodeChanges(before,after) {
  if (!before || !after) return [{scope:after?.label || before?.label || after?.type || before?.type || '노드',field:'node',label:before?'노드 삭제':'노드 추가',before,after,kind:before?'removed':'added'}];
  const scope=after.label || before.label || after.type;
  const keys=[...new Set([...Object.keys(before.config || {}),...Object.keys(after.config || {})])].filter(key=>key!=='params');
  const paramKeys=[...new Set([...Object.keys(before.config?.params || {}),...Object.keys(after.config?.params || {})])];
  return [...fields(before,after,['label','notes','type','x','y'],scope),...fields(before.config,after.config,keys,scope),...fields(before.config?.params,after.config?.params,paramKeys,scope).map(change=>({...change,field:`params.${change.field}`,label:`모델 설정 · ${change.label}`}))];
}

export function workflowChanges(before,after) {
  const changes=fields(before,after,['name'],'워크플로우');
  const oldNodes=before?.nodes || [],newNodes=after?.nodes || [];
  for (const node of oldNodes) if (!newNodes.some(item=>item.id===node.id)) changes.push(...nodeChanges(node,null));
  for (const node of newNodes) changes.push(...nodeChanges(oldNodes.find(item=>item.id===node.id),node));
  const key=edge=>`${edge.source}:${edge.target}`;
  const label=(edge,nodes)=>[edge.source,edge.target].map(id=>{const node=nodes.find(item=>item.id===id);return node?.label || node?.type || id;}).join(' → ');
  for (const edge of before?.edges || []) if (!(after?.edges || []).some(item=>key(item)===key(edge))) changes.push({scope:'연결',field:'edge',label:'연결 삭제',before:label(edge,oldNodes),after:null,kind:'removed'});
  for (const edge of after?.edges || []) if (!(before?.edges || []).some(item=>key(item)===key(edge))) changes.push({scope:'연결',field:'edge',label:'연결 추가',before:null,after:label(edge,newNodes),kind:'added'});
  return changes;
}

export function historyReason(reason='edited') {
  if (reason.startsWith('restore:')) return `v${reason.split(':')[1].replace(/^v/,'')}에서 복원`;
  if (reason.endsWith(':layout')) return '레이아웃 연출 초안 구성';
  if (reason.startsWith('workflow:')) return '워크플로우 실행';
  if (reason.startsWith('generation:')) return 'Higgsfield 생성 결과 적용';
  return {created:'처음 생성',edited:'직접 편집',narration:'내레이션 생성',template:'템플릿 적용',restored:'이전 버전 복원'}[reason] || reason;
}

export function displayValue(value) {
  if (value === undefined || value === null || value === '') return '없음';
  if (Array.isArray(value)) return value.map(displayValue).join(' → ');
  if (typeof value === 'object') return [value.title || value.name || value.label || value.type || value.role,value.text || value.prompt,value.narration,value.duration !== undefined ? `${value.duration}초` : ''].filter(Boolean).join(' · ') || JSON.stringify(value);
  return String(value);
}

export function changesHtml(changes,escape,beforeLabel='선택 버전',afterLabel='현재 버전') {
  if (!changes.length) return '<p class="history-empty">내용이 같습니다. 버전과 기록 시각만 다를 수 있습니다.</p>';
  return `<div class="change-list">${changes.map(change=>`<article class="change-item ${change.kind}"><h4>${escape(change.scope)} <span>${escape(change.label)}</span></h4><div class="change-values"><div><small>${escape(beforeLabel)}</small><p>${escape(displayValue(change.before))}</p></div><div><small>${escape(afterLabel)}</small><p>${escape(displayValue(change.after))}</p></div></div></article>`).join('')}</div>`;
}

// A keystroke group is one undo step; navigation/blur closes the group. Never stores server versions.
export function createDraftHistory(limit=40) {
  let entries=[],index=-1,group=null;
  const copy=value=>structuredClone(value);
  return {
    reset(value) { entries=[copy(value)];index=0;group=null; },
    record(value,key=null) {
      if (index>=0 && same(entries[index],value)) return;
      entries=entries.slice(0,index+1);
      if (key && group===key && index>0) entries[index]=copy(value);
      else {entries.push(copy(value));if(entries.length>limit+1)entries.shift();index=entries.length-1;}
      group=key;
    },
    closeGroup() {group=null;},
    undo() {group=null;return index>0?copy(entries[--index]):null;},
    redo() {group=null;return index<entries.length-1?copy(entries[++index]):null;},
    get canUndo() {return index>0;},
    get canRedo() {return index<entries.length-1;},
  };
}
