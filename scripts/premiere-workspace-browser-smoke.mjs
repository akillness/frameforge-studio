/** Real-browser acceptance gate for the FRAME editing workspace.
 * Uses disposable API fixtures, blocks provider execution and HTTP egress.
 * Never opens the production database or starts a render/generation/publication.
 */
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.mjs';

const out=await mkdtemp(join(tmpdir(),'frameforge-premiere-evidence-'));
const dataDir=await mkdtemp(join(tmpdir(),'frameforge-premiere-fixture-'));
const token=randomUUID();
const receipt={scope:'Isolated loopback, disposable fixtures; no production/provider/publication evidence',startedAt:new Date().toISOString(),checks:[],pageErrors:[],externalRequests:[],providerCalls:[],browserWrites:[],screenshots:[],geometry:[]};
const check=(name,condition,detail)=>{assert.ok(condition,JSON.stringify({name,detail}));receipt.checks.push(name);console.log(name);};
const forbidden=name=>async()=>{receipt.providerCalls.push(name);throw Error(`Forbidden in browser test: ${name}`);};
const app=createApp({dataDir,loginToken:token,publicOrigin:'',
 integrations:{integrationStatus:async()=>({studio:{available:false,status:'unavailable',detail:'Isolated browser test'}}),runAgent:forbidden('agent'),fetchTrends:forbidden('trends')},
 speech:{listVoices:async()=>({available:false,voices:[],detail:'Isolated browser test'}),synthesize:forbidden('speech')},
 generation:{capability:async()=>({available:false,status:'unavailable'}),models:async()=>[],modelSchema:forbidden('schema'),submit:forbidden('generation'),status:forbidden('generation-status')},renderer:forbidden('render')});
const originalFetch=globalThis.fetch;
let base='',browser,context,page,allowedWrite='';
globalThis.fetch=(url,options)=>{if(!base||new URL(url).origin!==base){receipt.externalRequests.push(String(url));throw Error('External fetch blocked');}return originalFetch(url,options);};
try {
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 assert.notEqual(app.address().port,4310);base=`http://127.0.0.1:${app.address().port}`;
 const installed=process.env.OPS_PLAYWRIGHT_MODULE||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
 const {chromium}=await import(pathToFileURL(installed));
 browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1600,height:1120},reducedMotion:'reduce'});
 page=await context.newPage();page.setDefaultTimeout(12000);
 page.on('pageerror',error=>receipt.pageErrors.push(error.message));
 await context.route('**/*',route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==base){receipt.externalRequests.push(request.url());return route.abort();}
  if(!['GET','HEAD'].includes(request.method())){
   receipt.browserWrites.push({method:request.method(),path:url.pathname});
   if(url.pathname!=='/api/login'&&!(request.method()==='PUT'&&url.pathname===allowedWrite))return route.fulfill({status:409,json:{error:'Unexpected mutation blocked'}});
  }
  return route.continue();
 });
 await page.goto(base);await page.locator('#login-form input').fill(token);await page.locator('#login-form button').click();await page.locator('#ops-workspace').waitFor();
 const request=async(path,method='GET',body)=>{
  const response=await context.request.fetch(base+path,{method,headers:{origin:base},...(body?{data:body}:{})});
  assert.ok(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);return response.json();
 };
 const channel=await request('/api/channels','POST',{name:'FRAME 테스트 제작실',platform:'youtube',category:'information'});
 const other=await request('/api/channels','POST',{name:'다른 플랫폼 테스트',platform:'instagram',category:'drama'});
 let episode=await request('/api/episodes','POST',{channelId:channel.id,title:'장면 편집과 내보내기 검증',topic:'격리된 테스트 자료'});
 const scenes=[{...episode.scenes[0],title:'첫 장면 <b>원문</b>',text:'편집 전 텍스트',duration:3.5},{...episode.scenes[0],id:randomUUID(),title:'두 번째 장면',text:'두 번째 화면',duration:8}];
 episode=await request(`/api/episodes/${episode.id}`,'PUT',{expectedVersion:episode.version,scenes});
 await page.reload();await page.locator('#ops-workspace').waitFor();
 const group=page.locator('.platform-group').filter({has:page.locator(`[data-action=channel][data-id="${channel.id}"]`)});
 if(!await group.evaluate(element=>element.open))await group.locator('summary').click();
 check('platform disclosure exposes its channel through a native control',await group.locator(`[data-id="${channel.id}"]`).isVisible());
 await group.locator(`[data-action=channel][data-id="${channel.id}"]`).click();await page.locator('#preview').waitFor();
 check('platform hierarchy uses actual channel platforms',await page.locator('.platform-group').count()===2&&await page.locator('.platform-group[open]').innerText().then(text=>text.includes('YouTube')&&text.includes(channel.name)));
 check('task navigation has exactly one active view',await page.locator('.task-nav [aria-current=page]').count()===1&&await page.locator('.task-nav [data-view=studio]').getAttribute('aria-current')==='page');
 check('project bin lists real scene identities and escaped titles',await page.locator('.project-bin [data-action=scene]').count()===2&&await page.locator('.project-bin').innerText().then(text=>text.includes('첫 장면 <b>원문</b>'))&&await page.locator('.project-bin b').count()===0);
 await page.locator('.project-bin [data-index="1"]').focus();await page.keyboard.press('Enter');
 check('project selection synchronizes monitor inspector and timeline',await page.locator('[data-scene=title]').inputValue()==='두 번째 장면'&&await page.locator('.scene-card.selected').getAttribute('data-index')==='1'&&await page.locator('.project-bin [aria-current=true]').getAttribute('data-index')==='1');
 check('keyboard project selection restores focus after rerender',await page.locator('.project-bin [aria-current=true]').evaluate(element=>element===document.activeElement));
 await page.locator('.scene-card[data-index="0"]').click();
 check('timeline selection synchronizes project bin',await page.locator('.project-bin [aria-current=true]').getAttribute('data-index')==='0');
 await page.locator('[data-scene=title]').fill('실시간 제목 변경');
 check('project title reflects unsaved inspector edits',await page.locator('.project-bin').innerText().then(text=>text.includes('실시간 제목 변경')));
 check('timeline exposes actual cumulative timing and audio availability',await page.locator('.scene-card').first().getAttribute('aria-label').then(text=>text.includes('00:00')&&text.includes('3.5'))&&await page.locator('.scene-card').nth(1).innerText().then(text=>text.includes('00:03'))&&await page.locator('.scene-media-state').count()===2);
 allowedWrite=`/api/episodes/${episode.id}`;const saveResponse=page.waitForResponse(response=>response.url()===base+allowedWrite&&response.request().method()==='PUT');await page.locator('#save-button').click();assert.ok((await saveResponse).ok());allowedWrite='';
 const saved=await request('/api/state');const edited=saved.episodes.find(item=>item.id===episode.id);
 check('save retains optimistic version and scene identity',edited.version===episode.version+1&&edited.scenes[0].id===scenes[0].id&&edited.scenes[0].title==='실시간 제목 변경');
 const beforeNavigation=JSON.stringify({episodes:saved.episodes,workflows:saved.workflows});
 await page.locator('.task-nav [data-view=workflow]').focus();await page.keyboard.press('Enter');await page.locator('#workflow-canvas').waitFor();
 check('keyboard task navigation transfers focus into the new main content',await page.locator('#main').evaluate(element=>element===document.activeElement));
 check('workflow design navigation targets real history and review sections',await page.locator('.wf-section-nav a[href="#wf-run-history"]').count()===1&&await page.locator('.wf-section-nav a[href="#wf-review"]').count()===1);
 check('workflow cards expose ordered stages without new execution semantics',await page.locator('.wf-stage-index').count()===await page.locator('.wf-node').count()&&await page.locator('.wf-stage-index').first().innerText()==='01');
 await page.locator('.wf-section-nav a[href="#wf-run-history"]').focus();await page.keyboard.press('Enter');
 await page.locator('#wf-run-history-content [data-run-history-search]').waitFor();
 check('history link opens real records and focuses their summary',await page.locator('#wf-run-history').evaluate(element=>element.open&&element.querySelector('summary')===document.activeElement));
 await page.locator('.wf-section-nav a[href="#workflow-canvas"]').click();
 check('design link returns keyboard focus to the canvas',await page.locator('#workflow-canvas').evaluate(element=>element===document.activeElement));
 await page.locator('.wf-section-nav a[href="#wf-review"]').click();
 check('review empty state explains the real human review boundary',await page.locator('#wf-review').innerText().then(text=>text.includes('자동 게시하지')));
 await page.locator('.wf-section-nav a[href="#workflow-canvas"]').click();
 await page.locator('[data-wf-action=open-add-node]').click();
 check('stage insertion uses existing executable types only',await page.locator('#wf-add-node-dialog').evaluate(e=>e.open)&&await page.locator('#wf-add-type option').evaluateAll(options=>options.every(option=>['trend','research','script','storyboard','generate','render','review'].includes(option.value))));
 await page.keyboard.press('Escape');
 check('stage dialog restores keyboard focus',await page.locator('[data-wf-action=open-add-node]').evaluate(e=>e===document.activeElement));
 for(const width of [1600,1440,1024,768,375,320]){
  await page.setViewportSize({width,height:1040});
  for(const view of ['studio','workflow','overview','history','trends','templates','knowledge','settings']){
   await page.locator(`.task-nav [data-view=${view}]`).click();await page.waitForTimeout(100);
   const geometry=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
   receipt.geometry.push({width,view,...geometry});check(`${view} at ${width}px has no document overflow`,geometry.scroll<=geometry.client,geometry);
   if(['studio','workflow','overview'].includes(view)&&[1600,375].includes(width)){
    const path=join(out,`${view}-${width}.png`);await page.screenshot({path,fullPage:true});receipt.screenshots.push(path);
   }
  }
  if(width===375){
   const alternate=page.locator('.platform-group').filter({has:page.locator(`[data-action=channel][data-id="${other.id}"]`)});
   if(!await alternate.evaluate(element=>element.open))await alternate.locator('summary').click();
   await alternate.locator(`[data-id="${other.id}"]`).click();
   check('mobile platform switch reaches an honest empty episode state',await page.locator('.empty h2').innerText()==='에피소드를 만드세요');
   const original=page.locator('.platform-group').filter({has:page.locator(`[data-action=channel][data-id="${channel.id}"]`)});
   if(!await original.evaluate(element=>element.open))await original.locator('summary').click();
   await original.locator(`[data-id="${channel.id}"]`).click();
   check('mobile channel switch returns to the preserved editor',await page.locator('.project-bin [data-action=scene]').count()===2);
  }
 }
 await page.setViewportSize({width:1600,height:1120});await page.locator('.task-nav [data-view=studio]').click();
 await page.locator('[data-workspace-action=settings]').click();
 check('existing workspace layout settings remain operational',await page.locator('#workspace-settings-dialog').evaluate(e=>e.open));await page.keyboard.press('Escape');
 const after=await request('/api/state');check('read-only navigation preserves saved episodes and workflows',beforeNavigation===JSON.stringify({episodes:after.episodes,workflows:after.workflows}));
 check('no script errors, external requests or provider execution',receipt.pageErrors.length===0&&receipt.externalRequests.length===0&&receipt.providerCalls.length===0,receipt);
 check('browser mutations limited to login and one explicit fixture save',receipt.browserWrites.length===2&&receipt.browserWrites[1].path===`/api/episodes/${episode.id}`,receipt.browserWrites);
 receipt.result='PASS';
} catch(error){
 receipt.result='FAIL';receipt.failure=error.stack;process.exitCode=1;console.error(error.stack);
 if(page){
  receipt.failureGeometry=await page.locator('.sidebar,.workspace,.task-nav,.task-nav button').evaluateAll(elements=>elements.map(element=>({class:element.className,view:element.dataset.view,rect:element.getBoundingClientRect().toJSON(),scrollLeft:element.scrollLeft,scrollWidth:element.scrollWidth})));
  await page.screenshot({path:join(out,'failure.png'),fullPage:true});
 }
}
finally {
 receipt.finishedAt=new Date().toISOString();await writeFile(join(out,'browser-smoke.json'),JSON.stringify(receipt,null,2)+'\n');console.log(`Evidence: ${out}`);
 await context?.close();await browser?.close();await new Promise(resolve=>{app.close(resolve);app.closeAllConnections();});globalThis.fetch=originalFetch;
 const resolved=resolve(dataDir);assert.ok(resolved.startsWith(resolve(tmpdir())+'\\')||resolved.startsWith(resolve(tmpdir())+'/'));await rm(resolved,{recursive:true,force:true});
}
