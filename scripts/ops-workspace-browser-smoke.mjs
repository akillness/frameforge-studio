/** Feature-only browser gate. All records are test fixtures in a disposable database.
 * Uses installed Playwright/Chromium, real local APIs, and no external services.
 * No generation, narration, render, upload or provider execution is permitted.
 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.mjs';

const out=await mkdtemp(join(tmpdir(),'frameforge-ops-browser-evidence-'));
console.log(`Browser evidence: ${out}`);
await mkdir(out,{recursive:true});
const installed=process.env.OPS_PLAYWRIGHT_MODULE || join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {chromium}=await import(pathToFileURL(installed));
const dataDir=await mkdtemp(join(tmpdir(),'frameforge-ops-smoke-'));
const testToken=randomUUID();
const receipt={scope:'Isolated loopback app; Korean API-created test fixtures only; no production/provider/render/upload evidence',startedAt:new Date().toISOString(),checks:[],pageErrors:[],externalRequests:[],browserWrites:[],screenshots:[],geometry:[],providerCalls:[],fixtureRequests:[],consoleErrors:[]};
const check=(name,condition,detail)=>{assert.ok(condition,JSON.stringify({name,detail}));receipt.checks.push(name);console.log(name);};
const forbidden=name=>async()=>{receipt.providerCalls.push(name);throw Error(`Smoke forbids ${name}`);};
const capability=async()=>({available:false,status:'unavailable',detail:'Disabled in isolated browser test'});
const app=createApp({dataDir,loginToken:testToken,publicOrigin:'',
 integrations:{integrationStatus:async()=>({studio:{available:false,status:'unavailable',detail:'Isolated smoke test: execution disabled'}}),runAgent:forbidden('agent'),fetchTrends:forbidden('trends')},
 speech:{listVoices:async()=>({available:false,voices:[],detail:'Disabled in isolated browser test'}),synthesize:forbidden('speech')},
 generation:{capability,models:async()=>[],modelSchema:forbidden('schema'),submit:forbidden('generation-submit'),status:forbidden('generation-status')},
 renderer:forbidden('render')});
// Prevent any server-side HTTP egress as a second boundary, while retaining local test API access.
let base='';
const originalFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>{if(!base||new URL(url).origin!==base){receipt.externalRequests.push(String(url));throw Error('Smoke forbids external fetch');}return originalFetch(url,options);};
let browser,context,phase='read-only',allowedWrite='';
try {
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 const port=app.address().port;assert.ok(port>1024&&port!==4310);base=`http://127.0.0.1:${port}`;receipt.base=base;receipt.dataBoundary='OS temporary directory; removed after test';
 browser=await chromium.launch({headless:true});
 context=await browser.newContext({viewport:{width:1440,height:1040},deviceScaleFactor:1,reducedMotion:'reduce'});
 const page=await context.newPage();page.setDefaultTimeout(12000);await page.clock.install();
 page.on('pageerror',error=>receipt.pageErrors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')receipt.consoleErrors.push(message.text());});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==base){receipt.externalRequests.push(request.url());return route.abort();}
  if(!['GET','HEAD'].includes(request.method())){
   const write={phase,method:request.method(),path:url.pathname};receipt.browserWrites.push(write);
   if(!(phase==='login'&&url.pathname==='/api/login')&&!(['editor-save','graph-edit'].includes(phase)&&request.method()==='PUT'&&url.pathname===allowedWrite))return route.fulfill({status:409,json:{error:'Smoke blocked unexpected mutation'}});
  }
  return route.continue();
 });
 await page.goto(base);await page.locator('#login-form').waitFor();
 check('authentication gate shown before records',await page.locator('#ops-workspace').count()===0);
 phase='login';await page.locator('#login-form input').fill(testToken);await page.locator('#login-form button').click();await page.locator('#ops-workspace').waitFor();phase='read-only';
 check('successful isolated login opens overview',await page.locator('[data-view=overview][aria-current=page]').count()===1);
 check('admin modal save is enabled after fresh login',await page.locator('#modal-form [type=submit]').isEnabled());
 check('honest empty queue and deliverables',await page.locator('#ops-content').innerText().then(text=>text.includes('조건에 맞는 에피소드가 없습니다')) && await page.locator('.ops-rail').innerText().then(text=>text.includes('로컬 결과물을 찾지 못했습니다')));
 await page.screenshot({path:join(out,'empty-1440.png'),fullPage:true});receipt.screenshots.push(join(out,'empty-1440.png'));
 const client=context.request;
 const request=async(path,method='GET',body)=>{const response=await client.fetch(base+path,{method,...(body?{data:body}:{}),headers:{origin:base}});assert.ok(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);if(method!=='GET')receipt.fixtureRequests.push({method,path,status:response.status()});return response.json();};
 const channel=await request('/api/channels','POST',{name:'브라우저 검증 전용 · 한국어 제작실',category:'information',platform:'Local test fixture'});
 const episodes=[];
 for(const [title,status] of [['한글 자막과 긴 제목의 줄바꿈을 확인하는 제작 기록','review'],['두 번째 이야기 · 장면 편집과 버전 이력 검증','draft'],['완성된 에피소드 · 게시 상태와 구분','ready']]){
  let episode=await request('/api/episodes','POST',{channelId:channel.id,title,topic:'운영 개요 브라우저 테스트 픽스처'});
  if(status!=='draft')episode=await request(`/api/episodes/${episode.id}`,'PUT',{expectedVersion:episode.version,status});
  episodes.push(episode);
 }
 const before=await request('/api/state');check('automatic collector disabled in disposable store',before.trendCollector.settings.enabled===false);
 await page.locator('[data-ops-action=refresh]').click();await page.locator('[data-episode-id]').first().waitFor();
 check('queue contains all and only isolated episode records',await page.locator('[data-episode-id]').count()===3);
 await page.locator('#ops-query').fill('긴 제목');check('Korean text filtering',await page.locator('[data-episode-id]').count()===1);
 check('typing preserves focus',await page.locator('#ops-query').evaluate(e=>e===document.activeElement));
 await page.locator('#ops-query').fill('');await page.locator('#ops-status').selectOption('review');check('real status filtering',await page.locator('[data-episode-id]').count()===1);
 await page.locator('[data-ops-action=config]').click();await page.locator('#ops-config').waitFor({state:'visible'});
 for(let i=0;i<18;i++){await page.keyboard.press('Tab');check(`config keyboard focus contained ${i+1}`,await page.locator('#ops-config').evaluate(e=>e.contains(document.activeElement)));}
 await page.locator('#ops-view-name').fill('검토할 에피소드');await page.locator('[data-ops-action=save-view]').click();
 await page.keyboard.press('Escape');check('Escape closes dialog and restores opener focus',await page.locator('#ops-config').evaluate(e=>!e.open)&&await page.locator('[data-ops-action=config]').evaluate(e=>e===document.activeElement));
 await page.locator('[data-ops-action=clear]').click();
 await page.locator('[data-ops-action=sort][data-sort=version]').click();check('keyboard-accessible sorting updates aria-sort',await page.locator('.ops-table th[aria-sort=ascending]').count()===1);
 await page.locator('[data-ops-action=config]').click();await page.locator('#ops-saved-view').selectOption('검토할 에피소드');
 check('saved view restores local filter',await page.locator('[data-episode-id]').count()===1);
 await page.locator('[name=column][value=channel]').uncheck();await page.locator('#ops-config-form [type=submit]').click();
 check('column configuration applies without changing records',await page.locator('.ops-table thead th').count()===5);
 await page.reload();await page.locator('#ops-workspace').waitFor();check('local preferences survive reload',await page.locator('#ops-status').inputValue()==='review'&&await page.locator('.ops-table thead th').count()===5);
 const prefs=await page.evaluate(()=>JSON.parse(localStorage.getItem('frameforge.ops.v1')));check('saved preference envelope is browser-local',prefs.saved.length===1&&prefs.current.status==='review');
 const other=await browser.newContext();await other.addCookies(await context.cookies());const otherPage=await other.newPage();await otherPage.goto(base);await otherPage.locator('#ops-workspace').waitFor();check('independent context has no saved view',await otherPage.evaluate(()=>localStorage.getItem('frameforge.ops.v1'))===null);await other.close();
 await page.locator('[data-ops-action=config]').click();await page.locator('[data-ops-action=reset]').click();await page.keyboard.press('Escape');
 const afterPreferences=await request('/api/state');check('overview configuration and navigation perform zero production mutations',JSON.stringify(before.episodes)===JSON.stringify(afterPreferences.episodes)&&JSON.stringify(before.workflows)===JSON.stringify(afterPreferences.workflows)&&receipt.browserWrites.every(item=>item.phase==='login'));
 await page.locator('.ops-tabs [data-pane=operations]').click();check('operations distinguishes disabled availability',await page.locator('#ops-content').innerText().then(text=>text.includes('unavailable')&&text.includes('자동 수집 꺼짐')));
 check('queue-only filters hidden on operations pane',await page.locator('#ops-filters').isHidden());
 await page.locator('.ops-tabs [data-pane=deliverables]').click();check('no fabricated deliverables',await page.locator('#ops-content a').count()===0);
 check('queue-only filters hidden on deliverables pane',await page.locator('#ops-filters').isHidden());
 await page.locator('.ops-tabs [data-pane=history]').click();check('history derives actual events and offers version route',await page.locator('#ops-content [data-action=ops-history]').count()>0);
 check('queue-only filters hidden on history pane',await page.locator('#ops-filters').isHidden());
 await page.locator('[data-ops-action=workflow-history]').first().click();await page.locator('#ops-provenance .ops-records').waitFor();check('workflow provenance reads actual immutable version history',await page.locator('#ops-provenance').innerText().then(text=>text.includes('v1')));await page.keyboard.press('Escape');
 await page.locator('.ops-tabs [data-pane=queue]').click();
 // Real editor mutation is limited to our own fixture and uses the normal version guard.
 await page.locator(`[data-action=ops-open][data-id="${episodes[1].id}"]`).click();await page.locator('[data-scene=text]').waitFor();
 await page.locator('[data-scene=text]').fill('편집 중인 한국어 초안은 탐색 후에도 보존됩니다.');
 check('editor marks unsaved changes',await page.locator('#save-status').innerText().then(text=>text.includes('저장되지')));
 phase='editor-save';allowedWrite=`/api/episodes/${episodes[1].id}`;
 await page.locator('[data-action=view][data-view=overview]').click();await page.locator('#ops-workspace').waitFor();phase='read-only';
 const saved=await request('/api/state');const edited=saved.episodes.find(item=>item.id===episodes[1].id);
 check('navigation saves the dirty fixture as a new version',edited.version===episodes[1].version+1&&edited.scenes[0].text==='편집 중인 한국어 초안은 탐색 후에도 보존됩니다.');
 await page.locator(`[data-action=ops-history][data-id="${edited.id}"]`).first().click();await page.locator('[data-testid=episode-history-comparison]').waitFor();
 check('history retains exact versions and restore guard',await page.locator('[data-action=history-version]').count()>=2&&await page.locator('[data-action=restore-episode]').isDisabled());
 await page.locator('[data-action=view][data-view=workflow]').click();await page.locator('#workflow-host').waitFor();
 check('workflow navigation is available without execution',await page.locator('.wf-canvas').count()===1);
 // Preserve and exercise existing workspace native overlay and keyboard sizing controls.
 await page.locator('[data-workspace-action=settings]').click();check('existing workspace settings dialog opens',await page.locator('#workspace-settings-dialog').evaluate(e=>e.open));await page.keyboard.press('Escape');
 for(const view of ['trends','templates','knowledge','settings','studio','overview']){
  await page.locator(`.nav [data-action=view][data-view=${view}]`).click();await page.locator(`.nav [data-view=${view}][aria-current=page]`).waitFor();check(`existing ${view} view renders`,await page.locator(`[data-view=${view}][aria-current=page]`).count()===1);
 }
 // Graph editing persists only owned fixture records through guarded canonical APIs.
 await page.locator('.nav [data-action=view][data-view=knowledge]').click();
 check('admin session capability is visible',await page.locator('[data-testid=session-capability]').innerText().then(text=>text.includes('\uad00\ub9ac\uc790')));
 check('existing write controls are explicitly admin-only',await page.locator('[data-action=new-channel]').first().getAttribute('data-admin-only')==='true');
 const derived=page.locator('[data-graph-node]').filter({has:page.locator('.eyebrow', {hasText:'topic'})}).first();
 check('derived topic has explicit read-only reason and no edit control',await derived.locator('[data-testid=graph-readonly]').innerText().then(text=>text.includes('\uc77d\uae30 \uc804\uc6a9')&&text.includes('episode.topic'))&&await derived.locator('[data-action=edit-graph-node]').count()===0);
 await page.screenshot({path:join(out,'knowledge-admin-1440.png'),fullPage:true});receipt.screenshots.push(join(out,'knowledge-admin-1440.png'));
 await page.locator(`[data-action=edit-graph-node][data-id="${channel.id}"]`).click();
 await page.locator('#modal [name=label]').fill('Graph edited channel');
 phase='graph-edit';allowedWrite=`/api/knowledge/nodes/${channel.id}`;
 await page.locator('#modal-form [type=submit]').click();await page.locator('#modal').waitFor({state:'hidden'});phase='read-only';
 check('channel graph editor persists canonical channel name',await request('/api/state').then(data=>data.channels.find(item=>item.id===channel.id).name==='Graph edited channel'));
 await page.locator(`[data-action=edit-graph-node][data-id="${edited.id}"]`).click();
 await page.locator('#modal [name=label]').fill('Graph edited episode');await page.locator('#modal [name=topic]').fill('Graph regenerated topic');
 phase='graph-edit';allowedWrite=`/api/knowledge/nodes/${edited.id}`;
 await page.locator('#modal-form [type=submit]').click();await page.locator('#modal').waitFor({state:'hidden'});phase='read-only';
 const graphSaved=await request('/api/state'), graphEpisode=graphSaved.episodes.find(item=>item.id===edited.id);
 check('episode graph editor persists canonical title, topic, version and media',graphEpisode.title==='Graph edited episode'&&graphEpisode.topic==='Graph regenerated topic'&&graphEpisode.version===edited.version+1&&JSON.stringify(graphEpisode.scenes)===JSON.stringify(edited.scenes));
 const refreshedGraph=await request('/api/knowledge');
 check('canonical edit regenerates graph and atom export',refreshedGraph.nodes.some(item=>item.type==='topic'&&item.label===graphEpisode.topic)&&refreshedGraph.atoms.some(item=>item.id===edited.id&&item.title===graphEpisode.title));
 const otherChannel=await request('/api/channels','POST',{name:'Relation target channel',category:'information',platform:'Local test fixture'});
 await page.locator('[data-action=refresh-knowledge]').click();
 const relationIndex=refreshedGraph.edges.findIndex(edge=>edge.source===edited.id&&edge.target===channel.id);
 await page.locator(`[data-action=edit-graph-edge][data-index="${relationIndex}"]`).click();await page.locator('#modal [name=newTarget]').selectOption(otherChannel.id);
 phase='graph-edit';allowedWrite='/api/knowledge/edges';
 await page.locator('#modal-form [type=submit]').click();await page.locator('#modal').waitFor({state:'hidden'});phase='read-only';
 const movedEpisode=(await request('/api/state')).episodes.find(item=>item.id===edited.id);
 check('relation editor persists episode channel with new version',movedEpisode.channelId===otherChannel.id&&movedEpisode.version===graphEpisode.version+1);
 await page.locator('[data-action=view][data-view=studio]').click();
 check('moved episode refreshes the selected channel context',await page.locator('.breadcrumb strong').innerText()===otherChannel.name&&await page.locator('.channel.active').innerText().then(text=>text.includes(otherChannel.name)));
 await page.locator('[data-action=view][data-view=knowledge]').click();
 await page.locator(`[data-action=edit-graph-node][data-id="${edited.id}"]`).click();await page.locator('#modal [name=label]').fill('Preserve conflict input');
 await request(`/api/episodes/${edited.id}`,'PUT',{expectedVersion:movedEpisode.version,notes:'Concurrent fixture change'});
 phase='graph-edit';allowedWrite=`/api/knowledge/nodes/${edited.id}`;
 const conflict=page.waitForResponse(response=>response.url()===base+allowedWrite&&response.request().method()==='PUT');
 await page.locator('#modal-form [type=submit]').click();check('stale graph edit returns conflict without discarding typed input',(await conflict).status()===409&&await page.locator('#modal').evaluate(element=>element.open)&&await page.locator('#modal [name=label]').inputValue()==='Preserve conflict input');phase='read-only';
 await page.locator('#modal-cancel').click();
 const viewer=await browser.newContext();await viewer.addCookies(await context.cookies());
 await viewer.route('**/api/state',async route=>{const response=await route.fetch();const data=await response.json();data.session={authenticated:true,role:'viewer',canMutate:false};await route.fulfill({response,json:data});});
 const viewerPage=await viewer.newPage();await viewerPage.goto(base);await viewerPage.locator('#ops-workspace').waitFor();
 await viewerPage.locator('.nav [data-action=view][data-view=knowledge]').click();
 check('non-admin capability keeps reads available and disables graph and existing mutations',await viewerPage.locator('[data-testid=session-capability]').innerText().then(text=>text.includes('\uc77d\uae30 \uc804\uc6a9'))&&await viewerPage.locator('[data-action=edit-graph-node]').first().isDisabled()&&await viewerPage.locator('[data-action=new-channel]').first().isDisabled()&&await viewerPage.locator('[data-action=refresh-knowledge]').isEnabled());await viewer.close();
 await page.locator('.nav [data-action=view][data-view=overview]').click();
 // Recoverable refresh error retains previously fetched records.
 await page.route('**/api/state',route=>route.fulfill({status:503,json:{error:'Intentional isolated availability test'}}));
 await page.locator('[data-ops-action=refresh]').click();await page.waitForTimeout(150);check('failed refresh explicitly retains stale records',await page.locator('#ops-freshness').innerText().then(text=>text.includes('갱신 실패')&&text.includes('이전 자료'))&&await page.locator('[data-episode-id]').count()===3);
 await page.unroute('**/api/state');await page.locator('[data-ops-action=refresh]').click();await page.waitForTimeout(150);
 for(const interaction of ['input','dialog']) {
  let release,start;
  const started=new Promise(resolve=>{start=resolve;});
  const handler=async route=>{await new Promise(resolve=>{release=resolve;start();});await route.continue();};
  await page.route('**/api/state',handler);
  await page.locator('[data-ops-action=refresh]').click();await started;
  if(interaction==='input')await page.locator('#ops-query').fill('한글');
  else {await page.locator('[data-ops-action=config]').click();await page.locator('#ops-view-name').fill('미적용 이름 보존');await page.locator('[name=column][value=channel]').uncheck();}
  const response=page.waitForResponse(response=>response.url()===base+'/api/state');release();await response;await page.waitForTimeout(150);
  if(interaction==='input')check('slow refresh preserves newly focused input and text',await page.locator('#ops-query').inputValue()==='한글'&&await page.locator('#ops-query').evaluate(e=>e===document.activeElement));
  else check('slow refresh preserves newly opened dialog and unapplied fields',await page.locator('#ops-config').evaluate(e=>e.open)&&await page.locator('#ops-view-name').inputValue()==='미적용 이름 보존'&&!(await page.locator('[name=column][value=channel]').isChecked()));
  await page.unroute('**/api/state',handler);
  if(interaction==='dialog')await page.keyboard.press('Escape');
  await page.locator('#ops-query').fill('');await page.locator('[data-ops-action=refresh]').click();await page.waitForTimeout(150);
 }
 await page.locator('#ops-query').focus();await page.clock.fastForward(90000);await page.waitForTimeout(100);
 check('polling preserves focused filter and explicitly marks stale data',await page.locator('#ops-query').evaluate(e=>e===document.activeElement)&&await page.locator('#ops-freshness').innerText().then(text=>text.includes('오래된 자료')));
 await page.clock.setSystemTime(new Date());await page.locator('[data-ops-action=refresh]').focus();await page.clock.fastForward(30000);await page.waitForTimeout(250);
 check('background polling resumes without writes',await page.locator('#ops-freshness').innerText().then(text=>!text.includes('오래된 자료')&&!text.includes('갱신 실패')));
 check('background refresh retains focused action',await page.locator('[data-ops-action=refresh]').evaluate(e=>e===document.activeElement));
 await page.locator('[data-ops-action=sort][data-sort=title]').focus();await page.clock.fastForward(30000);await page.waitForTimeout(250);
 check('background refresh preserves focused queue action through request start and completion',await page.locator('[data-ops-action=sort][data-sort=title]').evaluate(e=>e===document.activeElement));
 await page.clock.setSystemTime(new Date());
 // Invalid storage fallback is checked in a fresh module instance after reload.
 await page.evaluate(()=>localStorage.setItem('frameforge.ops.v1','{broken'));
 await page.reload();await page.locator('#ops-workspace').waitFor();check('invalid browser storage fallback is visible',await page.locator('#ops-workspace').innerText().then(text=>text.includes('기본 보기를 사용')));
 await page.locator('[data-ops-action=config]').click();await page.locator('[data-ops-action=reset]').click();await page.keyboard.press('Escape');
 check('preference reset clears the recovery warning immediately',await page.locator('#ops-preference-error').isHidden());
 receipt.contrast=await page.evaluate(()=>{
  const style=getComputedStyle(document.documentElement), token=name=>style.getPropertyValue(name).trim();
  const lum=hex=>{const values=hex.match(/[a-f\d]{2}/gi).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return .2126*values[0]+.7152*values[1]+.0722*values[2];};
  return [['--ink','--surface',4.5],['--text-secondary','--canvas',4.5],['--muted','--surface-side',4.5],['--muted','--surface-subtle',4.5],['--accent','--accent-soft',4.5],['--surface','--accent',4.5],['--success','--success-soft',4.5],['--warning','--warning-soft',4.5],['--danger','--danger-soft',4.5],['--line-strong','--surface',3],['--focus','--surface',3]].map(([a,b,minimum])=>{const values=[lum(token(a)),lum(token(b))].sort((a,b)=>b-a);return {foreground:a,background:b,minimum,ratio:(values[0]+.05)/(values[1]+.05)};});
 });
 check('measured contract text and essential control contrasts',receipt.contrast.every(pair=>pair.ratio>=pair.minimum),receipt.contrast);
 // Final screenshots are captured after all interaction checks.
 for(const width of [1440,768,375]){
  await page.setViewportSize({width,height:1040});await page.waitForTimeout(150);
  await page.locator('.ops-tabs [data-pane=queue]').click();
  await page.evaluate(()=>window.scrollTo(0,0));
  const geometry=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,visibleOverflow:[...document.querySelectorAll('main *,header *,aside *')].filter(e=>e.getClientRects().length&&!e.closest('.nav')).filter(e=>{const b=e.getBoundingClientRect();return b.left< -1||b.right>innerWidth+1;}).slice(0,10).map(e=>({tag:e.tagName,id:e.id,class:e.className}))}));
  receipt.geometry.push({width,view:'overview',...geometry});check(`overview ${width}px document has no overflow`,!geometry.overflow,geometry);
  const path=join(out,`overview-${width}.png`);await page.screenshot({path:resolve(path),fullPage:true});receipt.screenshots.push(path);
  await page.locator('[data-ops-action=config]').click();const d=await page.locator('#ops-config').boundingBox();check(`dialog ${width}px fits viewport`,d.x>=0&&d.x+d.width<=width+1,d);await page.keyboard.press('Escape');
  if(width===375){await page.locator('[data-ops-action=config]').click();await page.screenshot({path:join(out,'config-375.png'),fullPage:true});receipt.screenshots.push(join(out,'config-375.png'));await page.keyboard.press('Escape');}
  if(width===1440)for(const pane of ['deliverables','history','operations']) {
   await page.locator(`.ops-tabs [data-pane=${pane}]`).click();
   const path=join(out,`${pane}-1440.png`);await page.screenshot({path:resolve(path),fullPage:true});receipt.screenshots.push(path);
  }
  for(const view of ['studio','workflow']){
   await page.locator(`.nav [data-action=view][data-view=${view}]`).click();await page.waitForTimeout(150);
   const size=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));receipt.geometry.push({width,view,...size,overflow:size.scroll>size.client});check(`${view} ${width}px document has no overflow`,size.scroll<=size.client,size);
   const path=join(out,`${view}-${width}.png`);await page.screenshot({path:resolve(path),fullPage:true});receipt.screenshots.push(path);
  }
  await page.locator('[data-action=view][data-view=overview]').click();await page.waitForTimeout(150);
  for(const view of ['history','trends','templates','knowledge','settings']) {
   await page.locator(`.nav [data-action=view][data-view=${view}]`).click();await page.waitForTimeout(100);
   const size=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));receipt.geometry.push({width,view,...size,overflow:size.scroll>size.client});check(`${view} ${width}px document has no overflow`,size.scroll<=size.client,size);
  }
  await page.locator('[data-action=view][data-view=overview]').click();await page.waitForTimeout(100);
 }
 // Reflow equivalent to a 1440px viewport at 200% zoom. This is a CSS viewport
 // simulation, not a claim about native browser chrome zoom controls.
 await page.setViewportSize({width:720,height:520});
 const zoom=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
 receipt.geometry.push({width:720,view:'overview',zoom:'200% equivalent CSS viewport',...zoom,overflow:zoom.scroll>zoom.client});check('overview 200 percent equivalent viewport reflows without document overflow',zoom.scroll<=zoom.client,zoom);
 await page.setViewportSize({width:320,height:800});const narrow=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));receipt.geometry.push({width:320,view:'overview',...narrow,overflow:narrow.scroll>narrow.client});check('overview 320px reflow has no document overflow',narrow.scroll<=narrow.client,narrow);
 check('no browser page errors',receipt.pageErrors.length===0,receipt.pageErrors);
 check('no external HTTP requests or provider execution',receipt.externalRequests.length===0&&receipt.providerCalls.length===0);
 check('browser writes limited to login, owned dirty save and explicit graph edits',receipt.browserWrites.every(item=>['login','editor-save','graph-edit'].includes(item.phase))&&receipt.browserWrites.filter(item=>item.phase==='editor-save').length===1&&receipt.browserWrites.filter(item=>item.phase==='graph-edit').length===4,receipt.browserWrites);
 receipt.result='PASS';
} catch(error) {receipt.result='FAIL';receipt.failure=error.stack;process.exitCode=1;console.error(error.stack);}
finally {
 receipt.finishedAt=new Date().toISOString();
 await writeFile(join(out,'browser-smoke.json'),JSON.stringify(receipt,null,2)+'\n');
 await context?.close();await browser?.close();
 await new Promise(resolve=>{app.close(resolve);app.closeAllConnections();});
 globalThis.fetch=originalFetch;
 const resolved=resolve(dataDir),temp=resolve(tmpdir());assert.ok(resolved.startsWith(temp+'\\')||resolved.startsWith(temp+'/'));
 await rm(resolved,{recursive:true,force:true});
}
