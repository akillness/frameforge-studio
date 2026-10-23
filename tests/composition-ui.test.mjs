import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { chromium } from 'playwright';
import {defaultComposition, editRectangle, fitText, applyCompositionDrag, finalizeCompositionDrag, nudgeCompositionLayer, updateCompositionInput, syncCompositionInputs, previewFontSize} from '../public/composition.js';

test('moving and resizing a layer keeps its normalized rectangle inside the scene', () => {
  const box = {x:.1,y:.2,width:.4,height:.3};
  assert.deepEqual(editRectangle(box,{x:2,y:-1}),{x:.6,y:0,width:.4,height:.3});
  assert.deepEqual(editRectangle(box,{width:2,height:-1}),{x:.1,y:.2,width:.9,height:.02});
  assert.deepEqual(editRectangle(box,{x:NaN,width:Infinity}),box);
  assert.deepEqual(box,{x:.1,y:.2,width:.4,height:.3});
});

test('presets are independent scene defaults and reset preserves each layout', () => {
  const first=defaultComposition('split');
  assert.deepEqual(first.media,{x:0,y:0,width:1,height:.5});
  first.media.height=.2;
  assert.equal(defaultComposition('split').media.height,.5);
  assert.equal(defaultComposition('lower-third').body.y,.76);
  assert.equal(defaultComposition('center').body.y,.5);
});

test('Korean and hostile text fit bounded text layers without interpreting markup', () => {
  const text='한글 줄바꿈과 <b>원문</b> {\\pos(0,0)}\n둘째 줄';
  const fitted=fitText(text,{x:.1,y:.1,width:.25,height:.12},1080,1920,'body');
  assert.ok(fitted.text.includes('<b>'));
  assert.equal(fitted.text.replace(/\n/g,''),text.replace(/\n/g,''));
  assert.ok(fitted.fontSize>0);
  assert.ok(fitted.text.split('\n').length*fitted.lineHeight<=230.4+.01);
  assert.ok(fitted.text.split('\n').every(line=>Array.from(line).length*fitted.fontSize<=270+.01));
});

test('a drag cannot apply to a different scene after playback advances',()=>{
  const next={id:'next',layout:'center'};
  const drag={sceneId:'first',key:'title',handle:'',startX:0,startY:0,frameWidth:100,frameHeight:100,start:{x:.1,y:.2,width:.4,height:.3},moved:false};
  assert.equal(applyCompositionDrag(next,drag,.2,.1),null);
  assert.equal(next.composition,undefined);
});

test('a moved drag is committed dirty before its scene-mismatch gesture is cleared',()=>{
  let dirty=0;
  assert.equal(finalizeCompositionDrag({moved:true},()=>dirty++),true);
  assert.equal(dirty,1);
  assert.equal(finalizeCompositionDrag({moved:false},()=>dirty++),false);
  assert.equal(dirty,1);
});

test('a tiny drag that changes persisted geometry marks the scene dirty on finalization',()=>{
  for (const handle of ['', 'e', 's', 'nw']) {
    const scene={id:'a',composition:defaultComposition()};
    const start={...scene.composition.title};
    const drag={sceneId:'a',key:'title',handle,start,moved:false};
    let dirty=0;
    const box=applyCompositionDrag(scene,drag,.0005,.0004);
    assert.notDeepEqual(box,start,'the tiny drag must change normalized geometry');
    assert.deepEqual(scene.composition.title,box);
    assert.equal(finalizeCompositionDrag(drag,()=>dirty++),true,`tiny ${handle || 'move'} drag was not finalized`);
    assert.equal(dirty,1);
  }
});

test('clamped and subprecision drags leave geometry unchanged and do not mark dirty',()=>{
  for (const [dx,dy] of [[0,0],[.0000001,0],[-1,0]]) {
    const scene={id:'a',composition:defaultComposition()};
    scene.composition.title.x=0;
    const start={...scene.composition.title};
    const drag={sceneId:'a',key:'title',handle:'',start,moved:false};
    let dirty=0;
    assert.deepEqual(applyCompositionDrag(scene,drag,dx,dy,()=>dirty++),start);
    assert.equal(dirty,0);
    assert.equal(finalizeCompositionDrag(drag,()=>dirty++),false);
    assert.equal(dirty,0);
  }
});

test('drag change tracking follows each saved rectangle mutation before finalization',()=>{
  const scene={id:'a',composition:defaultComposition()};
  const start={...scene.composition.title};
  const drag={sceneId:'a',key:'title',handle:'',start,moved:false};
  const changes=[];
  const onChange=()=>changes.push({...scene.composition.title});
  applyCompositionDrag(scene,drag,.0005,0,onChange);
  assert.equal(changes.length,1);
  assert.equal(changes[0].x,start.x+.0005);
  applyCompositionDrag(scene,drag,.0005,0,onChange);
  assert.equal(changes.length,1,'repeated geometry must not advance the revision');
  applyCompositionDrag(scene,drag,0,0,onChange);
  assert.equal(changes.length,2,'returning to the start still changes the current saved rectangle');
  assert.deepEqual(changes[1],start);
  assert.equal(finalizeCompositionDrag(drag,()=>changes.push('finalized')),true);
  assert.equal(changes.at(-1),'finalized');
});

test('keyboard nudge requests a render so the inspector follows the selected layer',()=>{
  const scene={id:'a',layout:'center',composition:defaultComposition()};
  let rendered=0;
  const start=scene.composition.body.x;
  const box=nudgeCompositionLayer(scene,'body',{x:start+.01},()=>rendered++);
  assert.equal(box.x,start+.01);
  assert.equal(rendered,1);
});

test('typing a multi-digit geometry value does not rewrite the active input',()=>{
  const scene={layout:'center'};
  const field={dataset:{compositionField:'width'},value:'1'};
  const fields=[field];
  updateCompositionInput(scene,'title','width',field.value,fields,field);
  assert.equal(field.value,'1');
  field.value='10';
  updateCompositionInput(scene,'title','width',field.value,fields,field);
  assert.equal(field.value,'10');
  assert.equal(scene.composition.title.width,.1);
  syncCompositionInputs(scene,'title',fields);
  assert.equal(field.value,'10');
});

test('preview font scaling preserves the fitted size and body line-height contract',()=>{
  const fit=fitText('한글 '.repeat(30),{x:.1,y:.1,width:.2,height:.04},1080,1920,'body');
  const pixels=Number.parseFloat(previewFontSize(fit,1080))*1080/100;
  assert.ok(pixels>0 && pixels<=fit.fontSize);
  assert.ok(fit.fontSize-pixels<1e-8);
  assert.equal(fit.lineHeight,fit.fontSize*1.2);
});


test('fractional preview font conversion never increases the fitted size',()=>{
  const fit=fitText('\u1100'.repeat(1333),{x:.2,y:.1,width:.02,height:.5},1080,1920);
  for (const fontSize of [fit.fontSize,1e-14]) {
    const css=previewFontSize({fontSize},1080);
    assert.ok(css.endsWith('cqw'));
    const pixels=Number.parseFloat(css)*1080/100;
    assert.ok(pixels>0 && pixels<=fontSize,`${css} exceeds ${fontSize}px or is not positive`);
    assert.ok(fontSize-pixels<1e-8);
  }
});

test('multi-em dashes fit the shared preview/export budget in narrow composition boxes',()=>{
  const box={x:.2,y:.1,width:.02,height:.5};
  for (const [text,units] of [['\u2E3A',2],['\u2E3B',3]]) for (const layer of ['title','body']) {
    const fit=fitText(text,box,1080,1920,layer);
    assert.equal(fit.text,text);
    assert.ok(fit.fontSize>0 && fit.fontSize*units<=21.6,
      `${text.codePointAt(0).toString(16)} ${layer}: ${fit.fontSize}px needs ${units} spacing units within 21.6px`);
  }
});

async function editorFixture(t, {slots, scene:scenePatch={}, episode:episodePatch={}, beforeSaveResponse, mobileContent=false} = {}) {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[],writes=[];
  page.on('pageerror', error=>errors.push(error.message));
  const scene={id:'scene-a',title:'??',text:'??',duration:120,background:'#123456',kind:'video',assetUrl:'/api/uploads/fixture.mp4',audioUrl:'/api/uploads/fixture.wav',layout:'center',trimStart:2,audioVolume:1,narration:'',...(slots?{slots}: {})};
  Object.assign(scene,scenePatch);
  const episode={id:'episode-a',channelId:'channel-a',title:'Fixture',category:'information',topic:'Fixture',format:'9:16',status:'draft',version:1,scenes:[scene],...episodePatch};
  const state={session:{role:'admin',canMutate:true},channels:[{id:'channel-a',name:'Fixture',platform:'youtube',category:'information'}],episodes:[episode],templates:[],jobs:[],events:[],integrations:{},graph:{nodes:[],edges:[]},workflows:[],references:[],trends:[]};
  if (mobileContent) {
    state.channels[0].name='프레임포지 한국어 영상 제작과 에피소드 기록 채널';
    state.channels.push({id:'channel-b',name:'인스타그램 한국어 두 번째 영상 제작 채널',platform:'instagram',category:'drama'});
    episode.title='한국어 장면 편집과 에피소드 내보내기 검증';
    scene.title='첫 번째 한국어 장면';
    scene.duration=3.5;
    episode.scenes.push({...scene,id:'scene-b',title:'두 번째 한국어 장면',duration:8});
  }
  await page.route('**/*', async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='http://frameforge.test') return route.abort();
    if(url.pathname==='/api/episodes/episode-a' && route.request().method()==='PUT') {
      const patch=route.request().postDataJSON(); writes.push(patch);
      Object.assign(episode,patch,{version:episode.version+1});
      await beforeSaveResponse?.(patch,writes.length);
      return route.fulfill({json:episode});
    }
    if(url.pathname==='/api/state') return route.fulfill({json:state});
    if(url.pathname.startsWith('/api/')) return route.fulfill({json:url.pathname==='/api/speech/voices'?{available:false,voices:[]}:[]});
    const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!/^[a-z-]+\.(?:html|js|css)$/.test(file)) return route.abort();
    const body=await readFile(new URL('../public/'+file,import.meta.url),'utf8');
    return route.fulfill({body,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('http://frameforge.test/');
  await page.locator('[data-action="view"][data-view="studio"]').first().click();
  await page.locator('#preview video').waitFor();
  return {page,errors,writes};
}

for (const withSlots of [false,true]) {
  test(`inspector round-trip preserves leading paragraphs and CRLF titles${withSlots?' with slots':''}`,async t=>{
    const body='\nFirst <b>literal</b> paragraph\r\n\r\nSecond paragraph\rThird paragraph\n';
    const title='\r\nFirst title\r\nSecond title\rThird title\n';
    const normalizedBody='\nFirst <b>literal</b> paragraph\n\nSecond paragraph\nThird paragraph\n';
    const normalizedTitle='\nFirst title\nSecond title\nThird title\n';
    const slots=withSlots?[{id:'slot-a',name:'Fixture slot',role:'image-gen',x:10,y:10,w:80,h:20,zIndex:2,text:body,html:body,prompt:body,style:{}}]:undefined;
    const {page,errors,writes}=await editorFixture(t,{slots,scene:{title,text:body,narration:body},episode:{title,topic:body,notes:body}});
    await page.locator('.inspector details').first().locator('summary').click();
    const expected={
      '[data-scene="title"]':normalizedTitle,'[data-scene="text"]':normalizedBody,'[data-scene="narration"]':normalizedBody,
      '[data-episode="title"]':normalizedTitle,'[data-episode="topic"]':normalizedBody,'[data-episode="notes"]':normalizedBody,
      ...(withSlots?{'[data-slot-field="text"]':normalizedBody,'[data-slot-field="html"]':normalizedBody,'[data-slot-field="prompt"]':normalizedBody}:{})
    };
    const values=async()=>Object.fromEntries(await Promise.all(Object.keys(expected).map(async selector=>[selector,await page.locator(selector).inputValue()])));
    assert.deepEqual(await values(),expected,'rendering must preserve each field with LF-normalized form semantics');
    for (const selector of Object.keys(expected)) {
      await page.locator(selector).focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(' edited');
      expected[selector]+=' edited';
    }
    await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/episodes/episode-a')&&response.request().method()==='PUT'),page.keyboard.press('Control+s')]);
    await page.waitForFunction(()=>document.querySelector('#save-status').className==='hint');
    assert.equal(writes.length,1);
    assert.equal(writes[0].expectedVersion,1);
    for (const [selector,value] of Object.entries(expected)) {
      const [,scope,key]=selector.match(/data-(scene|episode|slot-field)="([^"]+)"/);
      const saved=scope==='episode'?writes[0]:scope==='scene'?writes[0].scenes[0]:writes[0].scenes[0].slots[0];
      assert.equal(saved[key],value,`save payload for ${selector}`);
    }
    assert.deepEqual(await values(),expected,'save rerender must retain the edited paragraphs');
    assert.deepEqual(errors,[]);
  });
}

test('Chromium preview retains literal delimiters and CR paragraphs as text nodes', async t => {
  const value='a{b}\\c\r\n\r\\N\\n\\h\n';
  const composition=defaultComposition();
  composition.title=composition.body={x:.1,y:.1,width:.8,height:.8};
  const {page,errors}=await editorFixture(t,{scene:{title:value,text:value,composition}});
  for (const layer of ['title','body']) {
    const element=page.locator(`[data-composition-layer="${layer}"]`);
    assert.equal(await element.textContent(),'a{b}\\c\n\n\\N\\n\\h\n');
    assert.equal(await element.locator('*').count(),0);
  }
  assert.deepEqual(errors,[]);
});

// Bounding rectangles include content clipped out of nested scrolling containers.
function toastViewportState() {
  const toast=document.querySelector('#toast'),rect=toast.getBoundingClientRect();
  const overlaps=[...document.querySelectorAll('button,a,input,select,textarea,summary,[role="button"],[tabindex]:not([tabindex="-1"])')]
    .filter(element=>{
      const bounds=element.getBoundingClientRect(),style=getComputedStyle(element);
      if (style.display==='none'||style.visibility==='hidden') return false;
      let {left,right,top,bottom}=bounds;
      for (let parent=element.parentElement;parent;parent=parent.parentElement) {
        const clip=parent.getBoundingClientRect(),css=getComputedStyle(parent);
        if (css.overflowX!=='visible') {left=Math.max(left,clip.left);right=Math.min(right,clip.right);}
        if (css.overflowY!=='visible') {top=Math.max(top,clip.top);bottom=Math.min(bottom,clip.bottom);}
      }
      return left<right&&top<bottom&&left<rect.right&&right>rect.left&&top<rect.bottom&&bottom>rect.top;
    }).map(element=>element.getAttribute('aria-label')||element.textContent.trim()||element.tagName);
  return {visible:rect.width>0&&rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth,
    text:toast.textContent,overlaps,scrollY:scrollY+document.querySelector('#app').scrollTop};
}

test('existing save-conflict toast has no modal content overlap on inspector open and reopen',async t=>{
  const {page,errors}=await editorFixture(t,{slots:[]});
  await page.setViewportSize({width:375,height:812});
  await page.locator('[data-scene="title"]').fill('Pending modal conflict');
  await page.route('**/api/episodes/episode-a',route=>route.fulfill({status:409,json:{error:'Save conflict'}}));
  await page.clock.install({time:0});
  await page.clock.pauseAt(0);
  await page.locator('#save-button').click();
  const toast=page.locator('#toast.visible.error');
  await toast.waitFor();
  const message=await toast.textContent();
  const opener=page.locator('[data-workspace-action="tool"][data-workspace-tool="inspector"]');
  for (const phase of ['open','reopen']) {
    await page.clock.fastForward(2000);
    await opener.click();
    const geometry=await toast.evaluate(node=>{
      const dialog=node.closest('dialog:modal'),rect=node.getBoundingClientRect();
      const bounds=dialog.getBoundingClientRect();
      const intersects=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
      const overlaps=[...dialog.querySelectorAll('.workspace-dialog-header,label,input,textarea,select,button,a,summary,[role="button"],[tabindex]:not([tabindex="-1"]),p,.hint')]
        .filter(element=>{
          if (!element.checkVisibility()) return false;
          const clip={...element.getBoundingClientRect().toJSON()};
          for (let parent=element.parentElement;parent;parent=parent.parentElement) {
            const box=parent.getBoundingClientRect(),css=getComputedStyle(parent);
            if (css.overflowX!=='visible') {clip.left=Math.max(clip.left,box.left);clip.right=Math.min(clip.right,box.right);}
            if (css.overflowY!=='visible') {clip.top=Math.max(clip.top,box.top);clip.bottom=Math.min(clip.bottom,box.bottom);}
          }
          return clip.left<clip.right&&clip.top<clip.bottom&&intersects(rect,clip);
        }).map(element=>({tag:element.tagName,text:element.textContent.trim(),field:element.getAttribute('data-scene')}));
      return {overlaps,text:node.textContent,readable:rect.width>0&&rect.height>0&&node.scrollHeight<=node.clientHeight,
        within:rect.top>=Math.max(0,bounds.top)&&rect.bottom<=Math.min(innerHeight,bounds.bottom)&&rect.left>=bounds.left&&rect.right<=bounds.right,
        exposed:[[rect.left+12,rect.top+12],[rect.right-12,rect.bottom-12],[(rect.left+rect.right)/2,(rect.top+rect.bottom)/2]]
          .every(([x,y])=>document.elementFromPoint(x,y)===node),focus:dialog.contains(document.activeElement)};
    });
    assert.deepEqual(geometry.overlaps,[],`${phase}: toast overlaps visible modal content`);
    assert.deepEqual({...geometry,overlaps:undefined},{overlaps:undefined,text:message,readable:true,within:true,exposed:true,focus:true},phase);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#workspace-tool-dialog').evaluate(dialog=>dialog.contains(document.activeElement)),true);
    await page.keyboard.press('Escape');
    assert.equal(await toast.evaluate(node=>node.parentElement===document.body),true);
    assert.equal(await opener.evaluate(node=>node===document.activeElement),true);
  }
  await page.clock.fastForward(4999);
  assert.equal(await toast.isVisible(),true);
  await page.clock.fastForward(1);
  assert.equal(await page.locator('#toast').isVisible(),false,'promotion must preserve the original deadline');
  assert.deepEqual(errors,[]);
});

for (const status of [409,500]) {
  test(`active save failure ${status} follows a later inspector dialog without extending its timeout`,async t=>{
    const {page,errors}=await editorFixture(t);
    await page.setViewportSize({width:375,height:812});
    await page.locator('[data-scene="title"]').fill('Pending modal failure');
    const serverMessage='Save failed: preserve these edits and retry.';
    const message=status===409?'다른 작업에서 이 에피소드가 수정되었습니다. 현재 편집은 보존했습니다. 페이지를 다시 열기 전에 편집 내용을 복사해 주세요.':serverMessage;
    await page.route('**/api/episodes/episode-a',route=>route.fulfill({status,json:{error:serverMessage}}));
    await page.clock.install({time:0});
    await page.clock.pauseAt(0);
    await page.locator('#save-button').click();
    const toast=page.locator('#toast.visible.error');
    await toast.waitFor();
    await page.evaluate(()=>{window.fixtureToast=document.querySelector('#toast');});
    assert.equal(await toast.textContent(),message);
    assert.equal(await toast.evaluate(node=>node.parentElement===document.body),true);
    await page.clock.fastForward(3000);
    const opener=page.locator('[data-workspace-action="tool"][data-workspace-tool="inspector"]');
    await opener.click();
    const dialog=page.locator('#workspace-tool-dialog');
    assert.equal(await dialog.evaluate(node=>node.matches(':modal')),true);
    const feedback=await toast.evaluate(node=>{
      const rect=node.getBoundingClientRect();
      return {same:node===window.fixtureToast,text:node.textContent,topLayer:node.closest('dialog')?.matches(':modal')||false,
        exposed:document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===node};
    });
    assert.deepEqual(feedback,{same:true,text:message,topLayer:true,exposed:true},'an already visible failure must be exposed above the newly opened dialog');
    await page.clock.fastForward(2000);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.evaluate(node=>node.open),false);
    assert.equal(await opener.evaluate(node=>document.activeElement===node),true);
    assert.equal(await toast.evaluate(node=>node===window.fixtureToast&&node.parentElement===document.body&&!node.hasAttribute('popover')),true);
    assert.equal(await toast.textContent(),message);
    const restored=await toast.evaluate(node=>{
      const rect=node.getBoundingClientRect();
      return document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===node;
    });
    assert.equal(restored,true,'closing must restore exposed feedback for its remaining lifetime');
    await page.clock.fastForward(3999);
    assert.equal(await toast.isVisible(),true);
    await page.clock.fastForward(1);
    assert.equal(await page.locator('#toast').isVisible(),false,'opening and closing must keep the original 9000ms deadline');
    assert.deepEqual(errors,[]);
  });

  test(`modal inspector keeps full save failure ${status} visible in the top layer`,async t=>{
    const {page,errors}=await editorFixture(t);
    await page.setViewportSize({width:375,height:812});
    const opener=page.locator('[data-workspace-action="tool"][data-workspace-tool="inspector"]');
    await opener.click();
    const dialog=page.locator('#workspace-tool-dialog');
    assert.equal(await dialog.evaluate(node=>node.matches(':modal')),true);
    const title=dialog.locator('[data-scene="title"]');
    await title.fill('Modal save fixture');
    const message=status===409?'Save conflict: copy your edits before reloading the latest version.':'Save failed: your edits are preserved. Please try saving again.';
    await page.route('**/api/episodes/episode-a',route=>route.fulfill({status,json:{error:message}}));
    await page.clock.install({time:0});
    await page.clock.pauseAt(0);
    await page.keyboard.press('Control+s');
    const toast=page.locator('#toast.visible.error');
    await toast.waitFor();
    const feedback=await toast.evaluate(node=>{
      const rect=node.getBoundingClientRect();
      const points=[[rect.left+12,rect.top+12],[rect.right-12,rect.bottom-12],[(rect.left+rect.right)/2,(rect.top+rect.bottom)/2]];
      return {text:node.textContent,visible:rect.width>0&&rect.top>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth,
        exposed:points.every(([x,y])=>document.elementFromPoint(x,y)===node),unclipped:node.scrollHeight<=node.clientHeight,
        hits:points.map(([x,y])=>document.elementFromPoint(x,y)?.outerHTML.slice(0,120)),
        focus:document.activeElement===document.querySelector('#workspace-tool-dialog [data-scene="title"]')};
    });
    assert.equal(feedback.text,message);
    assert.equal(feedback.visible,true,JSON.stringify(feedback));
    assert.equal(feedback.exposed,true,`save feedback is covered by the modal top layer: ${JSON.stringify(feedback)}`);
    assert.equal(feedback.unclipped,true,'the full actionable feedback must be visible');
    assert.equal(feedback.focus,true,'feedback must preserve inspector input focus');
    await page.clock.fastForward(8999);
    assert.equal(await toast.isVisible(),true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.evaluate(node=>node.open),false,'Escape must dismiss the inspector');
    assert.equal(await opener.evaluate(node=>document.activeElement===node),true,'dismissal must restore opener focus');
    assert.equal(await toast.isVisible(),true,'dialog dismissal must retain the remaining feedback');
    await page.clock.fastForward(1);
    assert.equal(await page.locator('#toast').isVisible(),false);
    assert.equal(await page.locator('#toast').evaluate(node=>node.parentElement===document.body),true);
    assert.deepEqual(errors,[]);
  });
}

test('modal audio upload preserves its promoted toast through rerender and restarts the completion deadline',async t=>{
  const {page,errors}=await editorFixture(t);
  await page.setViewportSize({width:375,height:812});
  await page.locator('[data-workspace-action="tool"][data-workspace-tool="inspector"]').click();
  assert.equal(await page.locator('#workspace-tool-dialog').evaluate(dialog=>dialog.matches(':modal')),true);
  let releaseUpload;
  const heldResponse=new Promise(resolve=>{releaseUpload=resolve;});
  t.after(()=>releaseUpload());
  let uploadStarted;
  const uploadRequest=new Promise(resolve=>{uploadStarted=resolve;});
  await page.route('**/api/uploads?name=*',async route=>{
    assert.equal(route.request().method(),'POST');
    assert.equal(route.request().headers()['content-type'],'audio/wav');
    uploadStarted();
    await heldResponse;
    await route.fulfill({json:{url:'/api/uploads/completed.wav'}});
  });
  await page.clock.install({time:0});
  await page.clock.pauseAt(0);
  await page.locator('#audio-file').setInputFiles({name:'modal.wav',mimeType:'audio/wav',buffer:Buffer.from('fixture audio')});
  await uploadRequest;
  const progress=await page.locator('#toast').evaluate(node=>{
    window.fixtureToast=node;
    return {text:node.textContent,visible:node.classList.contains('visible'),modal:node.closest('dialog')?.matches(':modal')||false};
  });
  assert.equal(progress.visible,true);
  assert.equal(progress.modal,true,'the held upload must promote its progress toast into the inspector');
  await page.clock.fastForward(1000);
  await page.evaluate(()=>{
    window.fixtureRerendered=new Promise(resolve=>{
      const observer=new MutationObserver(()=>{observer.disconnect();resolve();});
      observer.observe(document.querySelector('#app'),{childList:true});
    });
  });
  const completed=page.waitForResponse(response=>response.url().includes('/api/uploads?name=')&&response.request().method()==='POST');
  releaseUpload();
  await completed;
  await page.evaluate(()=>window.fixtureRerendered);
  const feedback=await page.evaluate(()=>{
    const node=window.fixtureToast,rect=node.getBoundingClientRect();
    return {same:document.querySelector('#toast')===node,connected:node.isConnected,text:node.textContent,
      visible:node.classList.contains('visible')&&rect.width>0&&rect.height>0};
  });
  assert.deepEqual(errors,[],'audio upload completion must not throw while replacing the inspector');
  assert.equal(feedback.same,true,'completion must retain the promoted toast node');
  assert.equal(feedback.connected,true,'completion feedback must stay connected across render()');
  assert.equal(feedback.visible,true);
  assert.notEqual(feedback.text,progress.text,'completion must replace upload progress feedback');
  assert.match(feedback.text,/MP4/,'completion must explain that attached audio is included after saving');
  await page.clock.fastForward(3500);
  assert.equal(await page.locator('#toast').isVisible(),true,'the old progress deadline must not hide completion feedback');
  await page.clock.fastForward(999);
  assert.equal(await page.locator('#toast').isVisible(),true);
  await page.clock.fastForward(1);
  assert.equal(await page.locator('#toast').isVisible(),false,'completion must expire 4500ms after the upload response');
  assert.equal(await page.locator('#toast').evaluate(node=>node===window.fixtureToast&&node.parentElement===document.body),true);
  assert.deepEqual(errors,[]);
});

test('modal save confirmation survives the inspector rerender and keeps its normal timeout',async t=>{
  const {page,errors}=await editorFixture(t);
  await page.setViewportSize({width:375,height:812});
  await page.locator('[data-workspace-action="tool"][data-workspace-tool="inspector"]').click();
  await page.locator('#workspace-tool-dialog [data-scene="title"]').fill('Saved modal fixture');
  await page.clock.install({time:0});
  await page.clock.pauseAt(0);
  await page.keyboard.press('Control+s');
  await page.locator('#toast.visible').waitFor();
  await page.waitForFunction(()=>document.querySelector('#save-status').className==='hint');
  const confirmation=await page.locator('#toast').evaluate(node=>{
    const rect=node.getBoundingClientRect();
    return {exposed:document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===node,
      modal:node.closest('dialog')?.matches(':modal')||false};
  });
  assert.deepEqual(confirmation,{exposed:true,modal:true});
  await page.clock.fastForward(4499);
  assert.equal(await page.locator('#toast').isVisible(),true);
  await page.clock.fastForward(1);
  assert.equal(await page.locator('#toast').isVisible(),false);
  assert.equal(await page.locator('#toast').evaluate(node=>node.parentElement===document.body),true);
  assert.deepEqual(errors,[]);
});

for (const width of [1600,1440,1024,768,375,320]) {
  for (const status of [500,409]) test(`failed save ${status} stays visible without covering controls while scrolled at ${width}px`,async t=>{
    const {page,errors}=await editorFixture(t);
    await page.setViewportSize({width,height:1040});
    await page.locator('[data-action="composition-mode"]').click();
    const title=page.locator('[data-scene="title"]');
    await title.fill('Failed save fixture');
    await title.press('Tab');
    const message=status===409?'Save conflict: reload the latest version before retrying.':'Save failed: please try again.';
    await page.route('**/api/episodes/episode-a',route=>route.fulfill({status,json:{error:message}}));
    await title.scrollIntoViewIfNeeded();
    const scrollPosition=()=>page.evaluate(()=>scrollY+document.querySelector('#app').scrollTop);
    const before=await scrollPosition();
    assert.ok(before>100,'save must start scrolled into the editor');
    await page.clock.install({time:0});
    await page.clock.pauseAt(0);
    await page.keyboard.press('Control+s');
    await page.locator('#toast.visible.error').waitFor();
    const check=async()=>{
      const geometry=await page.evaluate(toastViewportState);
      assert.equal(geometry.visible,true,`error toast is outside the viewport at scrollY ${geometry.scrollY}`);
      assert.equal(geometry.text,message);
      assert.deepEqual(geometry.overlaps,[],'error toast overlaps actionable controls');
      return geometry.scrollY;
    };
    assert.equal(await check(),before,'failed save must not jump the scroll position');
    await page.evaluate(()=>{
      const app=document.querySelector('#app');
      (getComputedStyle(app).overflowY==='auto'?app:window).scrollBy(0,120);
    });
    const afterScroll=await scrollPosition();
    await page.clock.fastForward(8999);
    assert.equal(await check(),afterScroll,'scrolling must not hide the error before its timeout');
    await page.clock.fastForward(1);
    assert.equal(await page.locator('#toast').isVisible(),false);
    assert.equal(await scrollPosition(),afterScroll,'timeout must not jump the scroll position');
    assert.deepEqual(errors,[]);
  });

  test(`save confirmation never covers playback controls at ${width}px`,async t=>{
    const {page,errors}=await editorFixture(t);
    await page.setViewportSize({width,height:1040});
    await page.locator('[data-action="composition-mode"]').click();
    await page.locator('[data-scene="title"]').fill('Toast fixture');
    await page.locator('[data-scene="title"]').press('Tab');
    await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('#app').scrollTo(0,0);});
    await page.keyboard.press('Control+s');
    await page.locator('#toast.visible').waitFor();
    const geometry=await page.evaluate(toastViewportState);
    assert.equal(geometry.visible,true,'save confirmation must be visible');
    assert.deepEqual(geometry.overlaps,[],`save confirmation overlaps controls at ${width}px`);
    assert.deepEqual(errors,[]);
  });
}

test('keyboard layer selection preserves inspector focus outside composition mode',async t=>{
  const {page,errors}=await editorFixture(t);
  const body=page.locator('[data-action="composition-layer"][data-layer="body"]');
  await body.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-action="composition-layer"][data-layer="body"]').evaluate(element=>element===document.activeElement),true,'keyboard layer selection must retain focus');
  assert.deepEqual(errors,[]);
});

for (const modal of [false,true]) {
  test(`keyboard layer selection preserves inspector focus in composition mode (${modal?'compact modal':'docked'})`,async t=>{
    const {page,errors}=await editorFixture(t);
    await page.locator('[data-action="composition-mode"]').click();
    const previewBody=page.locator('[data-composition-layer="body"]');
    await previewBody.click();
    assert.equal(await previewBody.evaluate(element=>element===document.activeElement),true,'direct preview selection must keep preview focus');
    if (modal) {
      await page.locator('#workspace-template').selectOption('compact');
      await page.locator('[data-workspace-tool="inspector"]').click();
      assert.equal(await page.locator('#workspace-tool-dialog').evaluate(dialog=>dialog.matches(':modal')),true);
    }
    const inspector=page.locator('.composition-inspector');
    const body=inspector.locator('[data-action="composition-layer"][data-layer="body"]');
    await body.focus();
    await page.keyboard.press('Enter');
    assert.equal(await body.getAttribute('aria-pressed'),'true');
    assert.equal(await body.evaluate(element=>element===document.activeElement),true,'keyboard layer selection must retain focus on the replacement inspector button');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Space');
    const title=inspector.locator('[data-action="composition-layer"][data-layer="title"]');
    assert.equal(await title.getAttribute('aria-pressed'),'true');
    assert.equal(await title.evaluate(element=>element===document.activeElement),true,'Space selection must retain inspector focus');
    await page.keyboard.press('Tab');
    assert.equal(await body.evaluate(element=>element===document.activeElement),true);
    await page.keyboard.press('Tab');
    assert.equal(await inspector.locator('[data-composition-field="x"]').evaluate(element=>element===document.activeElement),true,'Tab must continue into the inspector geometry controls');
    assert.deepEqual(errors,[]);
  });
}

// Document overflow alone misses content hidden inside horizontally scrolling strips.
async function clippedContent(page, selector) {
  return page.locator(selector).evaluateAll(elements=>elements.flatMap(element=>{
    const problems=[],rect=element.getBoundingClientRect();
    if (rect.width<=0 || rect.left<0 || rect.right>innerWidth+.5) problems.push('outside viewport');
    if (element.scrollWidth>element.clientWidth+1) problems.push('internal horizontal overflow');
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
    for (let text=walker.nextNode();text;text=walker.nextNode()) {
      const range=document.createRange();range.selectNodeContents(text);
      for (const line of range.getClientRects()) {
        if (line.left<0 || line.right>innerWidth+.5) problems.push('text outside viewport');
        for (let ancestor=text.parentElement;ancestor;ancestor=ancestor.parentElement) {
          const style=getComputedStyle(ancestor),bounds=ancestor.getBoundingClientRect();
          if (style.overflowX!=='visible' && (line.left<bounds.left-.5 || line.right>bounds.right+.5)) problems.push('text clipped by '+ancestor.className);
        }
      }
    }
    return problems.length?[{element:element.className,text:element.textContent,problems}]:[];
  }));
}

for (const width of [1024,768]) {
  test(`Chromium task navigation labels are fully discoverable without horizontal scrolling at ${width}px`,async t=>{
    const {page,errors}=await editorFixture(t,{mobileContent:true});
    await page.setViewportSize({width,height:1040});
    await page.reload();
    const navigation=page.locator('.task-nav');
    await navigation.waitFor();
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(await navigation.locator('[data-view="trends"] .nav-label').innerText(),'트렌드 & 리서치');
    assert.deepEqual(await clippedContent(page,'.task-nav, .task-nav button, .task-nav .nav-label'),[],
      'every complete task label must be visible without horizontal scrolling');
    const overflow=await navigation.evaluate(element=>({
      scrollLeft:element.scrollLeft,extraWidth:element.scrollWidth-element.clientWidth,
      documentOverflow:document.documentElement.scrollWidth-innerWidth
    }));
    assert.equal(overflow.scrollLeft,0);
    assert.ok(overflow.extraWidth<=1 && overflow.documentOverflow<=1,JSON.stringify(overflow));
    assert.deepEqual(errors,[]);
  });
}

for (const width of [320,375]) {
  test(`Chromium task navigation labels are fully discoverable without horizontal scrolling at ${width}px`,async t=>{
    const {page,errors}=await editorFixture(t,{mobileContent:true});
    await page.setViewportSize({width,height:1040});
    await page.reload();
    const navigation=page.locator('.task-nav');
    await navigation.waitFor();
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(await navigation.locator('[data-view="trends"] .nav-label').innerText(),'트렌드 & 리서치');
    assert.deepEqual(await clippedContent(page,'.task-nav, .task-nav button, .task-nav .nav-label'),[],
      'every complete task label must be visible before scrolling or focusing a tab');
    const overflow=await navigation.evaluate(element=>({
      scrollLeft:element.scrollLeft,extraWidth:element.scrollWidth-element.clientWidth,
      documentOverflow:document.documentElement.scrollWidth-innerWidth
    }));
    assert.equal(overflow.scrollLeft,0);
    assert.ok(overflow.extraWidth<=1 && overflow.documentOverflow<=1,JSON.stringify(overflow));
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.skip-link').evaluate(element=>element===document.activeElement),true);
    const views=await navigation.locator('button').evaluateAll(buttons=>buttons.map(button=>button.dataset.view));
    await navigation.locator('button').first().focus();
    for (const view of views) {
      assert.equal(await navigation.locator(`button[data-view="${view}"]`).evaluate(element=>element===document.activeElement),true);
      if (view!==views.at(-1)) await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Enter');
    const selectedTab=navigation.locator(`button[data-view="${views.at(-1)}"][aria-current="page"]`);
    await selectedTab.waitFor();
    assert.equal(await selectedTab.getAttribute('data-view'),views.at(-1));
    assert.deepEqual(await clippedContent(page,'.task-nav, .task-nav button, .task-nav .nav-label'),[]);
    assert.deepEqual(errors,[]);
  });

  test(`Chromium mobile platforms and Korean channel metadata are fully readable at ${width}px`,async t=>{
    const {page,errors}=await editorFixture(t,{mobileContent:true});
    await page.setViewportSize({width,height:1040});
    for (const group of await page.locator('.platform-group').all()) {
      if (!await group.evaluate(element=>element.open)) await group.locator('summary').click();
    }
    assert.equal(await page.locator('.platform-group').count(),2);
    assert.deepEqual(await clippedContent(page,'.platform-browser, .platform-group, .platform-browser .channel, .channel-name, .platform-browser .channel small'),[]);
    const groups=await page.locator('.platform-group').evaluateAll(elements=>elements.map(e=>e.getBoundingClientRect().toJSON()));
    assert.ok(groups[1].top>=groups[0].bottom,'platform groups must stack without a partial second group');
    assert.deepEqual(errors,[]);
  });

  test(`Chromium mobile episode tabs and new episode label are fully readable at ${width}px`,async t=>{
    const {page,errors}=await editorFixture(t,{mobileContent:true});
    await page.setViewportSize({width,height:1040});
    assert.equal(await page.locator('.episode-tab').count(),2);
    assert.equal(await page.locator('[data-action="new-episode"] strong').innerText(),'＋ 에피소드 만들기');
    assert.deepEqual(await clippedContent(page,'.episode-strip, .episode-tab, .episode-tab strong, .episode-tab span'),[]);
    assert.deepEqual(errors,[]);
  });

  test(`Korean studio heading keeps the final word intact at ${width}px`,async t=>{
    const {page,errors}=await editorFixture(t);
    await page.setViewportSize({width,height:1040});
    const lines=await page.locator('.page-heading h1').evaluate(element=>{
      const text=element.firstChild,textValue=text.textContent,word='제작실.',start=textValue.indexOf(word),range=document.createRange();
      range.setStart(text,start);range.setEnd(text,start+word.length);
      return range.getClientRects().length;
    });
    assert.equal(lines,1,'the final Korean word must not split across lines');
    assert.deepEqual(errors,[]);
  });

  test(`Chromium mobile scene cards retain every start time and duration at ${width}px`,async t=>{
    const {page,errors}=await editorFixture(t,{mobileContent:true});
    await page.setViewportSize({width,height:1040});
    assert.deepEqual(await page.locator('.scene-card').evaluateAll(elements=>elements.map(e=>e.dataset.sceneId)),['scene-a','scene-b']);
    assert.deepEqual(await page.locator('.scene-card time').allTextContents(),['00:00','00:03']);
    assert.deepEqual(await page.locator('.scene-meta > span:last-child').allTextContents(),['3.5s','8s']);
    assert.deepEqual(await clippedContent(page,'.scenes, .scene-card, .scene-clip-header, .scene-meta, .scene-media-state'),[]);
    await page.locator('.scene-card[data-index="1"]').click();
    assert.equal(await page.locator('.scene-card.selected').getAttribute('data-scene-id'),'scene-b');
    assert.equal(await page.locator('[data-scene="title"]').inputValue(),'두 번째 한국어 장면');
    assert.deepEqual(errors,[]);
  });
}

for (const width of [1024,768,375,320]) {
  test(`Chromium keyboard skip link is visible without obscuring header or task labels at scrollY zero at ${width}px`,async t=>{
    const {page,errors}=await editorFixture(t,{mobileContent:true});
    await page.setViewportSize({width,height:1040});
    await page.reload();
    await page.locator('.task-nav').waitFor();
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.keyboard.press('Tab');
    const focus=await page.locator('.skip-link').evaluate(link=>{
      const rect=link.getBoundingClientRect();
      const obstacles=[...document.querySelectorAll('.brand, .breadcrumb, .task-nav button')];
      return {focused:document.activeElement===link,scrollY,visible:rect.top>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth,
        overlaps:obstacles.filter(element=>{
          const bounds=element.getBoundingClientRect();
          return bounds.left<rect.right&&bounds.right>rect.left&&bounds.top<rect.bottom&&bounds.bottom>rect.top;
        }).map(element=>({text:element.textContent.trim(),kind:element.matches('.brand')?'brand':element.matches('.breadcrumb')?'breadcrumb':'task-tab'}))};
    });
    assert.deepEqual(focus,{focused:true,scrollY:0,visible:true,overlaps:[]});
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#main').evaluate(element=>element===document.activeElement),true);
    assert.deepEqual(errors,[]);
  });
}

for (const [label,cluster] of [
  ...[20,1333].map(count=>[`${count} spacing Jamo`,'\u1100'.repeat(count)]),
  ['U+2030 PER MILLE SIGN','\u2030'],
  ['U+2031 PER TEN THOUSAND SIGN','\u2031'],
  ['U+20A7 PESETA SIGN','\u20A7'],
  ['U+0BF5 TAMIL YEAR SIGN','\u0BF5'],
  ['U+0BF8 TAMIL AS ABOVE SIGN','\u0BF8'],
  ['U+0DF4 SINHALA KUNDDALIYA','\u0DF4'],
  ['U+2E3A TWO-EM DASH','\u2E3A'],
  ['U+2E3B THREE-EM DASH',String.fromCodePoint(0x2E3B)],
  ['U+FDFD ARABIC LIGATURE',String.fromCodePoint(0xFDFD)],
]) {
test(`Chromium preview font size and advance fit narrow boxes with ${label}`, async t => {
  const composition=defaultComposition();
  composition.title={x:.2,y:.1,width:.02,height:.5};
  composition.body={x:.3,y:.1,width:.02,height:.5};
  const {page,errors}=await editorFixture(t,{scene:{title:cluster,text:cluster,composition}});
  // Measure at export scale so tiny glyph advances stay above Chromium's layout precision.
  await page.locator('#preview').evaluate(element=>Object.assign(element.style,{width:'1080px',minWidth:'1080px',maxWidth:'none',height:'1920px',maxHeight:'none',flex:'none'}));
  const measurements=await page.evaluate(async () => {
    await document.fonts.ready;
    const context=document.createElement('canvas').getContext('2d');
    return ['title','body'].map(layer=>{
      const element=document.querySelector(`[data-composition-layer="${layer}"]`);
      const style=getComputedStyle(element);
      context.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const advance=Math.max(...element.textContent.split('\n').map(line=>context.measureText(line).width));
      context.font=`${style.fontWeight} 100px ${style.fontFamily}`;
      return {layer,text:element.textContent,width:element.getBoundingClientRect().width,
        fontSize:Number.parseFloat(style.fontSize),fontFamily:style.fontFamily,frameWidth:document.querySelector('#preview').getBoundingClientRect().width,
        advance,emAdvance:context.measureText(element.textContent).width/100};
    });
  });
  for (const measurement of measurements) {
    assert.equal(measurement.text,cluster);
    const detail=JSON.stringify({...measurement,textLength:measurement.text.length,text:undefined});
    const fit=fitText(cluster,composition[measurement.layer],1080,1920,measurement.layer);
    // getComputedStyle serializes font sizes with six significant digits.
    const fontBudget=fit.fontSize*measurement.frameWidth/1080;
    assert.ok(measurement.fontSize>0 && measurement.fontSize<=fontBudget+fontBudget*5e-6,detail);
    if (label.startsWith('U+')) t.diagnostic(`${label}: ${detail}`);
    assert.ok(measurement.advance>0 && measurement.advance<=measurement.width,detail);
  }
  assert.deepEqual(errors,[]);
});
}

async function startVideo(page, paused, controlledTime=false) {
  await page.evaluate(async ({paused,controlledTime})=>{
    const video=document.querySelector('#preview video');
    const canvas=document.createElement('canvas'); canvas.width=16;canvas.height=16;
    canvas.getContext('2d').fillRect(0,0,16,16);
    video.removeAttribute('src'); video.srcObject=canvas.captureStream(10);
    await video.play();
    if(paused) video.pause();
    video.currentTime=7;
    if (controlledTime) {
      // A media clock tied to Playwright's virtual time makes slow interactions deterministic.
      let time=7,started=performance.now();
      window.fixtureMediaSeeks=0;
      Object.defineProperty(video,'currentTime',{configurable:true,
        get:()=>time+(video.paused?0:(performance.now()-started)/1000),
        set:value=>{time=value;started=performance.now();window.fixtureMediaSeeks++;}});
    }
    window.fixtureVideo=video;
    window.fixtureAudio=document.querySelector('#scene-audio-preview');
    window.fixtureMediaState={time:video.currentTime,paused:video.paused,started:performance.now(),audioPaused:window.fixtureAudio.paused};
  },{paused,controlledTime});
}

test('a save response preserves a drag made before pointerup and the next save uses its version',async t=>{
  const requested=Promise.withResolvers(),response=Promise.withResolvers();
  t.after(()=>response.resolve());
  const {page,errors,writes}=await editorFixture(t,{beforeSaveResponse:async (_patch,count)=>{
    if (count===1) { requested.resolve(); await response.promise; }
  }});
  await page.locator('[data-action="composition-mode"]').click();
  await page.locator('[data-composition-field="width"]').fill('25');
  await page.locator('[data-composition-field="width"]').press('Tab');
  await startVideo(page,false);
  await page.keyboard.press('Control+s');
  await requested.promise;
  const pendingStatus=await page.locator('#save-status').textContent();
  assert.equal(await page.locator('#save-button').isDisabled(),true);
  await page.locator('[data-composition-layer="title"]').scrollIntoViewIfNeeded();
  const title=await page.locator('[data-composition-layer="title"]').boundingBox();
  await page.mouse.move(title.x+title.width/2,title.y+title.height/2);
  await page.mouse.down();
  await page.mouse.move(title.x+title.width/2+20,title.y+title.height/2+10,{steps:4});
  const dragged=await page.locator('[data-composition-layer="title"]').evaluate(element=>Object.fromEntries(
    [['x','left'],['y','top'],['width','width'],['height','height']].map(([key,style])=>
      [key,Math.round(Number.parseFloat(element.style[style])*1e4)/1e6])
  ));
  assert.ok(dragged.x>writes[0].scenes[0].composition.title.x);
  assert.equal(await page.evaluate(()=>document.querySelector('#preview video')===window.fixtureVideo),true,'pointermove replaced the video');
  assert.equal(await page.evaluate(()=>document.querySelector('#scene-audio-preview')===window.fixtureAudio),true,'pointermove replaced the audio');
  assert.equal(await page.evaluate(()=>window.fixtureVideo.paused),false,'pointermove paused playback');
  assert.ok(await page.evaluate(()=>window.fixtureVideo.currentTime>=window.fixtureMediaState.time));
  const saved=page.waitForResponse(result=>result.url().endsWith('/api/episodes/episode-a') && result.request().method()==='PUT');
  response.resolve();
  await saved;
  await page.waitForFunction(pending=>document.querySelector('#save-status').textContent!==pending,pendingStatus);
  // Refresh the inspector from the local episode while the pointer remains down.
  await page.locator('[data-action="composition-layer"][data-layer="title"]').dispatchEvent('click');
  assert.equal(Number(await page.locator('[data-composition-field="x"]').inputValue()),Number((dragged.x*100).toFixed(1)),'save response discarded the local drag');
  assert.equal(await page.locator('#save-status').getAttribute('class'),'unsaved');
  assert.equal(await page.locator('#save-button').isEnabled(),true);
  await page.mouse.up();
  await Promise.all([page.waitForResponse(result=>result.url().endsWith('/api/episodes/episode-a') && result.request().method()==='PUT'),page.locator('#save-button').click()]);
  assert.equal(writes.length,2);
  assert.equal(writes[0].expectedVersion,1);
  assert.equal(writes[1].expectedVersion,2);
  assert.deepEqual(writes[1].scenes[0].composition.title,dragged);
  await page.waitForFunction(()=>document.querySelector('#save-status').className==='hint');
  assert.equal(await page.locator('#save-button').isDisabled(),true);
  await page.reload();
  await page.locator('[data-action="view"][data-view="studio"]').first().click();
  assert.equal(Number(await page.locator('[data-composition-field="x"]').inputValue()),Number((dragged.x*100).toFixed(1)));
  assert.deepEqual(errors,[]);
});

for (const paused of [false,true]) {
  test(`preview selection preserves the video node, time and ${paused?'paused':'playing'} state`,async t=>{
    const {page,errors}=await editorFixture(t);
    await page.clock.install({time:0});
    await page.clock.pauseAt(0);
    await startVideo(page,paused,true);
    // Playback mode: clicking visible copy must be inert.
    await page.locator('[data-composition-layer="body"]').dispatchEvent('click');
    assert.equal(await page.evaluate(()=>document.querySelector('#preview video')===window.fixtureVideo),true,'non-edit click replaced video');
    assert.equal(await page.locator('[data-composition-layer="body"]').getAttribute('data-action'),null,'non-edit copy exposes selection action');
    await page.locator('[data-action="composition-mode"]').click();
    await startVideo(page,paused,true);
    // Pointer selection and keyboard activation must update only selection UI.
    await page.locator('[data-composition-layer="body"]').click();
    await page.locator('[data-composition-layer="title"]').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.locator('[data-action="composition-layer"][data-layer="media"]').click();
    await page.clock.fastForward(4000);
    const result=await page.evaluate(()=>({same:document.querySelector('#preview video')===window.fixtureVideo,sameAudio:document.querySelector('#scene-audio-preview')===window.fixtureAudio,time:window.fixtureVideo.currentTime,paused:window.fixtureVideo.paused,audioPaused:window.fixtureAudio.paused,elapsed:(performance.now()-window.fixtureMediaState.started)/1000,seeks:window.fixtureMediaSeeks,before:window.fixtureMediaState}));
    assert.equal(result.same,true,'edit selection replaced video');
    assert.equal(result.sameAudio,true,'edit selection replaced attached audio control');
    assert.equal(result.paused,result.before.paused);
    assert.equal(result.audioPaused,result.before.audioPaused);
    assert.equal(result.seeks,0,'selection must not seek the retained video');
    assert.equal(result.time,result.before.time+(paused?0:result.elapsed),JSON.stringify(result));
    assert.deepEqual(errors,[]);
  });
}

test('edit-mode selection alone keeps the existing video node',async t=>{
  const {page}=await editorFixture(t);
  await page.locator('[data-action="composition-mode"]').click();
  await startVideo(page,false);
  await page.locator('[data-action="composition-layer"][data-layer="body"]').click();
  assert.equal(await page.evaluate(()=>document.querySelector('#preview video')===window.fixtureVideo),true,'edit selection replaced video');
});

test('slot scenes retain their ordered editable slot stack alongside the composition feature',async t=>{
  const slots=[{id:'slot-a',name:'Text slot',role:'text-overlay',x:10,y:10,w:80,h:20,zIndex:2,text:'Slot copy',style:{},dataBinding:'scene.text'}];
  const {page,errors}=await editorFixture(t,{slots});
  assert.equal(await page.locator('.preview-slot[data-slot-id="slot-a"]').count(),1);
  assert.equal(await page.locator('[data-composition-layer]').count(),0);
  assert.equal(await page.locator('[data-action="composition-mode"]').count(),0);
  assert.equal(await page.locator('[data-slot-field="x"]').count(),1);
  assert.deepEqual(errors,[]);
});

test('geometry controls, pointer drag, keyboard nudge and save retain the authored scene contract',async t=>{
  const {page,errors,writes}=await editorFixture(t);
  await page.locator('[data-action="composition-mode"]').click();
  await page.locator('[data-action="composition-layer"][data-layer="title"]').click();
  const width=page.locator('[data-composition-field="width"]');
  await width.fill('25');
  await width.press('Tab');
  await page.locator('[data-composition-layer="title"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[data-composition-field="x"]').inputValue(),'9');
  const title=page.locator('[data-composition-layer="title"]');
  const before=await title.boundingBox();
  await page.mouse.move(before.x+before.width/2,before.y+before.height/2);
  await page.mouse.down();
  await page.mouse.move(before.x+before.width/2+20,before.y+before.height/2+10,{steps:4});
  await page.mouse.up();
  const x=Number(await page.locator('[data-composition-field="x"]').inputValue());
  assert.ok(x>9);
  await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/episodes/episode-a') && response.request().method()==='PUT'),page.locator('[data-action="save"]').click()]);
  assert.equal(writes.length,1);
  const saved=writes[0];
  assert.equal(saved.expectedVersion,1);
  assert.equal(saved.scenes[0].id,'scene-a');
  assert.equal(saved.scenes[0].composition.title.width,.25);
  assert.ok(saved.scenes[0].composition.title.x>.09);
  assert.equal(saved.scenes[0].trimStart,2);
  assert.equal(saved.scenes[0].assetUrl,'/api/uploads/fixture.mp4');
  await page.reload();
  await page.locator('[data-action="view"][data-view="studio"]').first().click();
  assert.equal(await page.locator('[data-composition-field="width"]').inputValue(),'25');
  assert.deepEqual(errors,[]);
});
