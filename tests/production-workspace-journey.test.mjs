// PW-01..PW-07: actual application HTTP + Chromium. Only external transports are fixtures.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { execute } from '../server/process.mjs';
import { createGenerationProvider } from '../server/generation-provider.mjs';
const originalFetch = globalThis.fetch;
const allowedOrigins = new Set();
globalThis.fetch = (url, options) => {
  if (!allowedOrigins.has(new URL(url).origin)) throw new Error('External network disabled in real-app journey');
  return originalFetch(url, options);
};
after(() => { globalThis.fetch = originalFetch; });
const root = resolve(import.meta.dirname, '..');
const modulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const receipt = { schema: 'frameforge-real-journey/v2', command: 'node --test tests/production-workspace-journey.test.mjs', startedAt: new Date().toISOString(), scenarios: [], screenshots: [], network: [], boundary: 'Temporary SQLite, ephemeral loopback HTTP, actual public app; fixture-only external transport. No live consent, credentials, generation or publication.' };
after(async () => {
  receipt.finishedAt = new Date().toISOString();
  receipt.counts = { expected: 12, executed: receipt.scenarios.length, passed: receipt.scenarios.filter(s => s.status === 'passed').length, failed: receipt.scenarios.filter(s => s.status === 'failed').length };
  receipt.fullJourney = receipt.counts.executed === receipt.counts.expected;
  receipt.verdict = receipt.counts.failed ? 'FAILED_OR_BLOCKED' : receipt.fullJourney ? 'PASS' : 'FOCUSED_ONLY';
  receipt.sources = await Promise.all(['public/app.js', 'public/workflow.js', 'public/production-tools.js', 'public/styles.css', 'public/workspace.css', 'server/app.mjs', 'server/publication.mjs', 'server/media-sources.mjs', 'tests/production-workspace-journey.test.mjs'].map(async path => ({ path, sha256: hash(await readFile(join(root, path))) })));
  const filename = receipt.fullJourney ? 'journey-receipt.json' : 'journey-focused-receipt.json';
  await mkdir(join(root, 'artifacts/production-workspace-implementation'), { recursive: true });
  await writeFile(join(root, 'artifacts/production-workspace-implementation', filename), JSON.stringify(receipt, null, 2) + '\n');
});
function scenario(name, criteria, run) { test(name, { timeout: 180000 }, async t => { const record = { name, criteria, status: 'running' }; receipt.scenarios.push(record); try { await run(t); record.status = 'passed'; } catch (e) { record.status = 'failed'; record.error = e.message; throw e; } }); }
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-real-journey-'));
  const unexpected = async url => { throw new Error(`Unexpected external transport: ${url}`); };
  const app = createApp({ dataDir, loginToken: '', publicOrigin: '', generation: createGenerationProvider({ env: {}, fetchImpl: unexpected }), mediaOptions: { userAgent: 'FrameForge-Fixture/1.0 (+https://fixture.invalid/contact)', fetchImpl: unexpected }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: unexpected }, publicationOptions: { fetchImpl: unexpected }, ...options });
  t.after(async () => { await new Promise(done => { app.close(done); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await new Promise(done => app.listen(0, '127.0.0.1', done));
  assert.notEqual(app.address().port, 4310);
  const base = `http://127.0.0.1:${app.address().port}`; allowedOrigins.add(base);
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1600, height: 1120 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const writes = [], external = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', route => { const r = route.request(), url = new URL(r.url()); if (url.origin !== base) { external.push(url.href); return route.abort(); } if (!['GET', 'HEAD'].includes(r.method())) writes.push({ method: r.method(), path: url.pathname, body: r.postData() }); return route.continue(); });
  t.after(() => { receipt.network.push({ base, writes, external, errors }); assert.deepEqual(external, [], 'browser cannot contact external assets, fonts, consent or tracking'); assert.deepEqual(errors, [], 'actual app has no script errors'); });
  const request = (path, method = 'GET', body) => context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
  const api = async (path, method = 'GET', body) => { const r = await request(path, method, body); assert.ok(r.ok(), `${method} ${path}: ${r.status()} ${await r.text()}`); return r.json(); };
  await page.goto(base); await page.locator('#app .shell').waitFor();
  return { app, page, context, dataDir, base, writes, api, request };
}
function graph(name = 'Source editing') { const types = ['script', 'storyboard', 'render', 'review']; return { name, nodes: types.map((type, i) => ({ id: type, type, x: 60 + i * 280, y: 80, config: type === 'script' ? { agent: 'existing' } : {} })), edges: types.slice(1).map((target, i) => ({ id: `e${i}`, source: types[i], target })) }; }
async function project(f, name = 'A', template) {
  const channel = await f.api('/api/channels', 'POST', { name: `Channel ${name}`, category: 'information', platform: 'YouTube' });
  let episode = await f.api('/api/episodes', 'POST', { channelId: channel.id, title: `Project ${name}`, topic: `Keep story ${name}` });
  episode = await f.api(`/api/episodes/${episode.id}`, 'PUT', { ...episode, scenes: episode.scenes.slice(0, 1).map(s => ({ ...s, text: 'Original source-backed card', duration: 1 })), expectedVersion: episode.version });
  template ||= await f.api('/api/workflows', 'POST', graph());
  const workflow = await f.api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  return { channel, episode, workflow, template };
}
async function closeProjectOverlay(page) {
  for (const selector of ['#project-scene-dialog', '#project-tool-dialog']) {
    if (await page.locator(`${selector}[open]`).count()) {
      await page.keyboard.press('Escape');
      await page.locator(`${selector}[open]`).waitFor({ state: 'hidden' });
    }
  }
}
async function selectChannel(page, channelId) {
  await closeProjectOverlay(page);
  const b = page.locator(`[data-action=channel][data-id="${channelId}"]`), group = b.locator('xpath=ancestor::details[1]');
  if (await group.count() && !await group.evaluate(e => e.open)) await group.locator('summary').click();
  await b.click();
}
async function openProject(f, p) {
  await f.page.reload(); await selectChannel(f.page, p.channel.id);
  await f.page.locator(`[data-action=episode][data-id="${p.episode.id}"]`).click();
  await mode(f.page, 'studio');
}
async function mode(page, view) {
  const sceneWasOpen = await page.locator('#project-scene-dialog[open]').count();
  await closeProjectOverlay(page);
  assert.equal(await page.locator('.task-nav [data-view=studio], .project-modes').count(), 0, 'single workbench has no A/B split');
  if (view === 'studio') {
    await page.locator('[data-action=open-scene-editor]').first().focus(); await page.keyboard.press('Enter');
    await page.locator('#project-scene-dialog[open] #preview').waitFor();
    assert.equal(await page.locator('#project-scene-dialog').evaluate(e => e.contains(document.activeElement)), true, 'native scene overlay receives keyboard focus');
  } else {
    await page.locator('#workflow-canvas').waitFor();
    if (sceneWasOpen) assert.equal(await page.locator('[data-action=open-scene-editor]').first().evaluate(e => e === document.activeElement), true, 'native scene close restores its keyboard opener');
  }
}
async function tool(page, key) {
  await closeProjectOverlay(page);
  await page.locator('[data-action=project-tools]').click();
  const names = { source: '소스 · 이용 권리', delivery: '검토 · 공개' };
  await page.getByRole('menuitem', { name: names[key], exact: true }).click();
  await page.locator(`#project-tool-dialog[open] [data-production-tools][data-mode=${key}]`).waitFor();
}
async function screenshot(page, name, target) {
  const dir = join(root, 'artifacts/production-workspace-implementation/journey-evidence'); await mkdir(dir, { recursive: true });
  for (const width of [1600, 1024, 375, 320]) { await page.setViewportSize({ width, height: width >= 1024 ? 1120 : 844 }); if (target) await target.scrollIntoViewIfNeeded(); const geometry = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches })); const path = join(dir, `${name}-${width}.png`); const bytes = await page.screenshot({ path, fullPage: true, animations: 'disabled' }); receipt.screenshots.push({ name, width, path: path.slice(root.length + 1).replaceAll('\\', '/'), sha256: hash(bytes), geometry }); assert.equal(geometry.reducedMotion, true); assert.ok(geometry.scroll <= geometry.client, `${name} overflow ${width}: ${JSON.stringify(geometry)}`); }
  await page.setViewportSize({ width: 1600, height: 1120 });
}
async function terminal(f, workflowId, id) { for (let i = 0; i < 1200; i++) { const run = (await f.api(`/api/workflows/${workflowId}/runs`)).find(r => r.id === id); if (['awaiting_review', 'approved', 'completed', 'failed', 'cancelled'].includes(run?.status)) return run; await new Promise(done => setTimeout(done, 50)); } assert.fail(`run ${id} did not settle`); }
scenario('two channels own independent copied graphs, histories and versions with no execution on copy', ['PW-06'], async t => {
  const f = await fixture(t), a = await project(f), b = await project(f, 'B', a.template);
  assert.notEqual(a.workflow.id, b.workflow.id);
  for (const p of [a, b]) { assert.equal(p.workflow.episodeId, p.episode.id); assert.equal(p.workflow.channelId, p.channel.id); assert.equal(p.workflow.templateId, a.template.id); assert.equal(p.workflow.templateVersion, a.template.version); assert.deepEqual(await f.api(`/api/workflows/${p.workflow.id}/runs`), []); }
  const updated = await f.api(`/api/workflows/${a.workflow.id}`, 'PUT', { ...a.workflow, name: 'A edited', expectedVersion: a.workflow.version });
  const all = await f.api('/api/workflows'); assert.equal(all.find(w => w.id === b.workflow.id).name, b.workflow.name); assert.equal(all.find(w => w.id === a.template.id).version, a.template.version);
  const history = await f.api(`/api/workflows/${a.workflow.id}/history`); assert.ok(history.some(h => h.version === a.workflow.version)); assert.ok(history.some(h => h.version === updated.version));
  const state = await f.api('/api/state'); for (const type of ['jobs', 'generationJobs', 'workflowRuns', 'platformSessions']) assert.equal((state[type] || []).length, 0, `copy/edit created ${type}`);
});
scenario('native scene and stage overlays preserve hidden episode and graph drafts, beforeunload and original stale 409 base', ['PW-01', 'PW-02', 'PW-07'], async t => {
  const f = await fixture(t), a = await project(f), b = await project(f, 'B', a.template); await openProject(f, a);
  await f.page.locator('[data-scene=title]').fill('Unsaved A scene'); await mode(f.page, 'workflow');
  assert.equal(await f.page.locator('#wf-episode').inputValue(), a.episode.id); assert.equal(await f.page.locator('#wf-select').inputValue(), a.workflow.id);
  await f.page.locator('[data-wf-action=open-workflow-settings]').click(); await f.page.locator('#wf-workflow-name').fill('Unsaved A graph'); await f.page.keyboard.press('Escape');
  for (const node of a.workflow.nodes) { await f.page.locator(`.wf-node-header[data-id="${node.id}"]`).click(); for (const action of ['open-tools', 'open-results', 'open-stage-overlay']) { await f.page.locator(`[data-wf-action=${action}]`).first().click(); await f.page.locator('dialog[open]').waitFor(); assert.ok(await f.page.locator('dialog[open]').evaluate(e => e.contains(document.activeElement)), 'dialog focus'); await f.page.keyboard.press('Escape'); } }
  await screenshot(f.page, 'B'); await mode(f.page, 'studio'); assert.equal(await f.page.locator('[data-scene=title]').inputValue(), 'Unsaved A scene'); await screenshot(f.page, 'A');
  await selectChannel(f.page, b.channel.id); await mode(f.page, 'studio'); assert.equal(await f.page.locator('[data-scene=title]').inputValue(), b.episode.scenes[0].title); assert.deepEqual(f.writes, [], 'navigation cannot write');
  let warning; f.page.once('dialog', async d => { warning = d.type(); await d.dismiss(); }); await f.page.reload({ waitUntil: 'commit' }).catch(() => {}); assert.equal(warning, 'beforeunload', 'hidden dirty A must protect clean active B');
  await f.api(`/api/episodes/${a.episode.id}`, 'PUT', { ...a.episode, title: 'Concurrent A', expectedVersion: a.episode.version }); await selectChannel(f.page, a.channel.id); await mode(f.page, 'studio');
  const pending = f.page.waitForResponse(r => r.url() === `${f.base}/api/episodes/${a.episode.id}` && r.request().method() === 'PUT'); await f.page.locator('#save-button').click(); const response = await pending;
  assert.equal(response.request().postDataJSON().expectedVersion, a.episode.version); assert.equal(response.status(), 409); assert.equal(await f.page.locator('[data-scene=title]').inputValue(), 'Unsaved A scene'); assert.equal(await f.page.locator('#save-status').getAttribute('class'), 'unsaved');
  await mode(f.page, 'workflow'); await f.page.locator('[data-wf-action=open-workflow-settings]').click(); assert.equal(await f.page.locator('#wf-workflow-name').inputValue(), 'Unsaved A graph');
  await f.page.keyboard.press('Escape');
  await f.api(`/api/workflows/${a.workflow.id}`, 'PUT', { ...a.workflow, name: 'Concurrent graph', expectedVersion: a.workflow.version });
  const graphSave = f.page.waitForResponse(r => r.url() === `${f.base}/api/workflows/${a.workflow.id}` && r.request().method() === 'PUT');
  await f.page.locator('[data-wf-action=save]').click(); const rejectedGraph = await graphSave;
  assert.equal(rejectedGraph.request().postDataJSON().expectedVersion, a.workflow.version, 'restored graph retains its original saved base');
  assert.equal(rejectedGraph.status(), 409);
  await f.page.locator('[data-wf-action=open-workflow-settings]').click();
  assert.equal(await f.page.locator('#wf-workflow-name').inputValue(), 'Unsaved A graph', 'conflict never discards the independent graph draft');

});
scenario('128-node/256-edge owned canvas fits, pans, inspects and saves the last node without overflow', ['PW-02', 'PW-07'], async t => {
  const f = await fixture(t); const nodes = Array.from({ length: 128 }, (_, i) => ({ id: `node-${String(i).padStart(3, '0')}`, type: 'trend', label: `Unique node ${i}`, x: 40 + i % 16 * 260, y: 50 + Math.floor(i / 16) * 190, config: {} }));
  const edges = nodes.slice(1).map((n, i) => ({ id: `chain-${i}`, source: nodes[i].id, target: n.id })); for (let gap = 2; edges.length < 256; gap++) for (let i = 0; i + gap < 128 && edges.length < 256; i++) edges.push({ id: `extra-${i}-${gap}`, source: nodes[i].id, target: nodes[i + gap].id });
  const template = await f.api('/api/workflows', 'POST', { name: 'Maximum graph', nodes, edges }), p = await project(f, 'Large', template); await openProject(f, p); await mode(f.page, 'workflow'); assert.equal(await f.page.locator('.wf-node').count(), 128);
  await f.page.locator('[data-wf-action=fit]').click(); assert.equal(await f.page.locator('#workflow-canvas').evaluate(e => { const c = e.getBoundingClientRect(); return [...e.querySelectorAll('.wf-node')].every(n => { const r = n.getBoundingClientRect(); return r.left >= c.left - 2 && r.right <= c.right + 2 && r.top >= c.top - 2 && r.bottom <= c.bottom + 2; }); }), true, 'fit includes actual last node');
  const before = await f.page.locator('#wf-world').getAttribute('style'); await f.page.locator('#wf-minimap').focus(); await f.page.keyboard.press('ArrowRight'); assert.notEqual(await f.page.locator('#wf-world').getAttribute('style'), before); assert.deepEqual(f.writes, []); await f.page.locator('[data-wf-action=fit]').click();
  const last = f.page.locator('.wf-node-header[data-id="node-127"]'); await last.focus(); await f.page.keyboard.press('Enter'); await f.page.locator('[data-wf-action=open-tools]').click(); assert.equal(await f.page.locator('dialog[open] [data-wf-field=label]').inputValue(), 'Unique node 127'); assert.equal(await f.page.locator('.wf-node.selected').getAttribute('data-node-id'), 'node-127'); await f.page.keyboard.press('Escape'); await last.focus(); await f.page.keyboard.press('ArrowRight');
  const pending = f.page.waitForResponse(r => r.url() === `${f.base}/api/workflows/${p.workflow.id}` && r.request().method() === 'PUT'); await f.page.locator('[data-wf-action=save]').click(); assert.equal((await pending).status(), 200);
  const saved = (await f.api('/api/workflows')).find(w => w.id === p.workflow.id); assert.equal(saved.nodes.length, 128); assert.equal(saved.edges.length, 256); assert.equal(saved.nodes.find(n => n.id === 'node-127').x, nodes[127].x + 10);
  await f.page.waitForFunction(({ id, version }) => {
    const selected = document.querySelector('#wf-select'), status = document.querySelector('#wf-save-status'), save = document.querySelector('[data-wf-action="save"]');
    const history = document.querySelector(`#wf-history [data-wf-action="history-version"][data-version="${version}"]`);
    return selected?.value === id && status?.textContent?.trim() === `✓ 버전 ${version} · 저장됨` && save?.disabled === true && history?.isConnected === true && history.querySelector('strong')?.textContent?.trim() === `v${version} · 현재`;
  }, { id: saved.id, version: saved.version });
  await screenshot(f.page, 'B-large');
});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function commonsTransport(assets, calls) { return async (raw, options = {}) => { const url = new URL(raw); calls.push(url.href); assert.match(new Headers(options.headers).get('user-agent') || '', /FrameForge-Fixture/); if (url.origin === 'https://commons.wikimedia.org' && url.pathname === '/w/api.php') { const id = Number(url.searchParams.get('pageids')), kind = /video/.test(url.searchParams.get('gsrsearch') || '') ? 'video' : 'image'; return Response.json({ batchcomplete: true, query: { pages: assets.filter(a => id ? a.pageid === id : a.kind === kind).map(a => ({ pageid: a.pageid, ns: 6, title: `File:${a.name}`, imageinfo: [{ url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${a.name}`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${a.name}`, mime: a.mime, mediatype: a.kind === 'video' ? 'VIDEO' : 'BITMAP', size: a.bytes.length, width: 320, height: 180, sha1: createHash('sha1').update(a.bytes).digest('hex'), timestamp: '2026-01-01T00:00:00Z', extmetadata: { Artist: { value: a.author }, Attribution: { value: a.author }, LicenseShortName: { value: 'CC BY 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0/' }, AttributionRequired: { value: 'true' } } }] })) } }); } const a = assets.find(a => url.href === `https://upload.wikimedia.org/wikipedia/commons/a/ab/${a.name}`); assert.ok(a, `unexpected Commons transport: ${url.href}`); return new Response(a.bytes, { headers: { 'content-type': a.mime } }); }; }
async function importUi(f, asset, sceneId) {
  const source = f.page.locator('[data-production-tools][data-mode=source]');
  await source.locator('#pt-search-form [name=query]').fill('Fixture rights');
  await source.locator('#pt-search-form [name=kind]').selectOption(asset.kind);
  const searched = f.page.waitForResponse(r => r.url().includes('/api/sources/search?'));
  await source.locator('#pt-search-form button[type=submit]').click();
  const searchResponse = await searched; assert.equal(searchResponse.status(), 200, await searchResponse.text());
  await source.locator('[data-pt-action=open-import]').first().click(); await source.locator('#pt-import-ack').check();
  const imported = f.page.waitForResponse(r => r.url().endsWith('/api/sources/import') && r.request().method() === 'POST');
  await source.locator('[data-pt-action=confirm-import]').click();
  const importResponse = await imported; assert.equal(importResponse.status(), 201, await importResponse.text());
  const upload = await importResponse.json(); assert.ok(upload.id, 'real import returns exact upload identity');
  await source.locator(`[data-pt-action=open-rights][data-id="${upload.id}"]`).click();
  const rights = source.locator('#pt-rights-form');
  await rights.locator('[name=origin][value=third-party]').check();
  await rights.locator('[name=sourceUrl]').fill(`https://commons.wikimedia.org/wiki/File:${asset.name}`);
  await rights.locator('[name=licenseId]').fill('CC-BY-4.0'); await rights.locator('[name=attribution]').fill(asset.author);
  const cleared = f.page.waitForResponse(r => r.url().endsWith(`/api/uploads/${upload.id}/rights`) && r.request().method() === 'POST');
  await rights.locator('button[type=submit]').click(); const rightsResponse = await cleared;
  assert.equal(rightsResponse.status(), 201, await rightsResponse.text());
  await source.locator(`[data-pt-action=open-attach][data-id="${upload.id}"]`).click();
  await source.locator('#pt-attach-form [name=sceneId]').selectOption(sceneId);
  if (asset.kind === 'video') { await source.locator('[name=trimStart]').fill('0.1'); await source.locator('[name=trimEnd]').fill('0.9'); }
  const attached = f.page.waitForResponse(r => r.url().endsWith('/source') && r.request().method() === 'POST');
  await source.locator('#pt-attach-form button[type=submit]').click(); const response = await attached;
  assert.equal(response.status(), 200, await response.text());
  await source.locator('dialog[open]').waitFor({ state: 'hidden' });
}
scenario('real Commons video/still import, rights, attach and original card retain story without generation', ['PW-03', 'PW-07'], async t => {
  const dir = await mkdtemp(join(tmpdir(), 'frameforge-fixture-video-')); t.after(() => rm(dir, { recursive: true, force: true })); await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=12', '-t', '1', '-c:v', 'libvpx-vp9', join(dir, 'fixture.webm')]);
  const assets = [{ pageid: 601, name: 'Fixture.webm', mime: 'video/webm', kind: 'video', author: 'Video Fixture Author', bytes: await readFile(join(dir, 'fixture.webm')) }, { pageid: 602, name: 'Fixture.png', mime: 'image/png', kind: 'image', author: 'Still Fixture Author', bytes: PNG }], calls = [];
  const f = await fixture(t, { mediaOptions: { userAgent: 'FrameForge-Fixture/1.0 (+https://fixture.invalid/contact)', fetchImpl: commonsTransport(assets, calls) } }), p = await project(f); await openProject(f, p); await tool(f.page, 'source'); await screenshot(f.page, 'source-initial', f.page.locator('[data-production-tools][data-mode=source]'));
  await tool(f.page, 'source');
  for (const asset of assets) { await importUi(f, asset, p.episode.scenes[0].id); const current = (await f.api('/api/state')).episodes.find(e => e.id === p.episode.id); assert.equal(current.scenes[0].source.attribution, asset.author); assert.equal(current.scenes[0].source.sha256, hash(asset.bytes)); assert.equal(current.topic, p.episode.topic); }
  await screenshot(f.page, 'source', f.page.locator('[data-production-tools][data-mode=source]'));
  await tool(f.page, 'source');
  const before = (await f.api('/api/state')).episodes.find(e => e.id === p.episode.id), count = calls.length; await f.page.locator('[data-pt-action=open-card]').click(); await f.page.locator('#pt-card-form [name=sceneId]').selectOption(p.episode.scenes[0].id); await f.page.locator('#pt-card-form button[type=submit]').click(); await f.page.locator('dialog[data-pt-dialog][open]').waitFor({ state: 'hidden' });
  const state = await f.api('/api/state'), current = state.episodes.find(e => e.id === p.episode.id); assert.equal(current.scenes[0].kind, 'title'); assert.ok(!current.scenes[0].assetUrl); assert.equal(current.scenes[0].text, before.scenes[0].text); assert.equal(current.topic, before.topic); assert.equal(calls.length, count); assert.equal((state.generationJobs || []).length, 0); const history = JSON.stringify(await f.api(`/api/episodes/${p.episode.id}/history`)); assert.ok(history.includes('Video Fixture Author') && history.includes('Still Fixture Author'));
});
scenario('unknown media origin, audience and disclosure are initially unanswered; source and delivery reflow', ['PW-03', 'PW-04', 'PW-07'], async t => {
  const f = await fixture(t), p = await project(f); await openProject(f, p); const delivery = f.page.locator('[data-production-tools][data-mode=delivery]');
  await tool(f.page, 'delivery');
  for (const name of ['selfDeclaredMadeForKids', 'containsSyntheticMedia']) { const controls = delivery.locator(`[name=${name}]`); assert.ok(await controls.count(), `missing ${name} control`); assert.equal(await controls.first().evaluate(e => e.type === 'radio' ? [...e.form.elements].some(n => n.name === e.name && n.checked) : e.value !== ''), false, `${name} cannot silently default false`); }
  const r = await f.context.request.post(`${f.base}/api/uploads?name=unknown.png`, { headers: { origin: f.base, 'content-type': 'image/png', 'x-file-name': 'unknown.png' }, data: PNG }); assert.ok(r.ok(), `real upload: ${r.status()} ${await r.text()}`); await tool(f.page, 'source'); await f.page.locator('[data-pt-action=reload-uploads]').click(); await f.page.locator('[data-pt-action=open-rights]').last().click(); assert.equal(await f.page.locator('#pt-rights-form [name=origin]:checked').count(), 0, 'unknown origin cannot auto-select own'); await f.page.keyboard.press('Escape'); await tool(f.page, 'delivery'); await screenshot(f.page, 'delivery', delivery); assert.deepEqual(f.writes, []);
});
scenario('real FFmpeg render and exact review precede server manifest preview and fixture Google public readback', ['PW-03', 'PW-04', 'PW-05', 'PW-07'], async t => {
  const google = [], remoteId = 'fixture-video-001', externalId = `UC${'A'.repeat(22)}`; let snippet, status = { privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: false }; const sessionUrl = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fixture-private-session';
  const fetchImpl = async (raw, options = {}) => { const url = new URL(raw), method = options.method || 'GET'; google.push({ path: url.pathname, method }); if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') return Response.json({ access_token: 'fixture-only-access', refresh_token: 'fixture-only-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.force-ssl', token_type: 'Bearer' }); assert.equal(url.origin, 'https://www.googleapis.com'); if (url.pathname === '/youtube/v3/channels') return Response.json({ items: [{ id: externalId, snippet: { title: 'Fixture owner' } }] }); if (url.pathname === '/upload/youtube/v3/videos' && method === 'POST') { const body = JSON.parse(options.body); snippet = body.snippet; assert.equal(body.status.privacyStatus, 'private'); assert.equal(body.status.selfDeclaredMadeForKids, false); assert.equal(body.status.containsSyntheticMedia, false); assert.ok(!('publishAt' in body.status)); return new Response(null, { status: 200, headers: { location: sessionUrl } }); } if (url.href === sessionUrl && method === 'PUT') { assert.ok(options.body.byteLength > 1000, 'actual rendered MP4 bytes'); return Response.json({ id: remoteId }, { status: 201 }); } if (url.pathname === '/youtube/v3/videos' && method === 'PUT') { const body = JSON.parse(options.body); assert.equal(body.id, remoteId); assert.equal(body.status.privacyStatus, 'public'); status = body.status; return Response.json({ id: remoteId }); } if (url.pathname === '/youtube/v3/videos' && method === 'GET') { assert.equal(url.searchParams.get('id'), remoteId); return Response.json({ items: [{ id: remoteId, snippet: { ...snippet, channelId: externalId }, status: { ...status, uploadStatus: 'processed' }, processingDetails: { processingStatus: 'succeeded' } }] }); } assert.fail(`unexpected Google fixture ${method} ${url.pathname}`); };
  const f = await fixture(t, { youtubeOptions: { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret', redirectUri: 'http://127.0.0.1/oauth/youtube/callback', fetchImpl }, publicationOptions: { fetchImpl } }), p = await project(f);
  const uploadResponse = await f.context.request.post(`${f.base}/api/uploads?name=delivery-credit.png`, { headers: { origin: f.base, 'content-type': 'image/png' }, data: PNG });
  assert.equal(uploadResponse.status(), 201); const upload = await uploadResponse.json();
  await f.api(`/api/uploads/${upload.id}/rights`, 'POST', { origin: 'third-party', attribution: 'Delivery Fixture Artist', licenseId: 'CC-BY-4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Delivery.png' });
  p.episode = await f.api(`/api/episodes/${p.episode.id}/source`, 'POST', { sceneId: p.episode.scenes[0].id, uploadId: upload.id, expectedVersion: p.episode.version, useAs: 'illustration' });

  await f.api(`/api/channels/${p.channel.id}/youtube`, 'PUT', { externalId, expectedUpdatedAt: p.channel.updatedAt }); const auth = await f.api(`/api/channels/${p.channel.id}/youtube/authorize`, 'POST', {}); const state = new URL(auth.authUrl).searchParams.get('state'); const callback = await f.context.request.get(`${f.base}/oauth/youtube/callback?state=${encodeURIComponent(state)}&code=fixture-code`, { maxRedirects: 0 }); assert.ok([302, 303].includes(callback.status()));
  const run = await f.api(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, expectedEpisodeVersion: p.episode.version, expectedWorkflowVersion: p.workflow.version, selectedStages: ['script', 'storyboard', 'render', 'review'] }); const done = await terminal(f, p.workflow.id, run.id); assert.equal(done.status, 'awaiting_review', done.error); const current = (await f.api('/api/state')).episodes.find(e => e.id === p.episode.id); await f.api(`/api/workflows/${p.workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId: 'review', decision: 'approved', notes: 'Fixture exact local render technical review', expectedEpisodeVersion: current.version });
  await openProject(f, p); await mode(f.page, 'workflow'); await f.page.locator('.wf-node-header[data-id=review]').click(); await tool(f.page, 'delivery'); const delivery = f.page.locator('[data-production-tools][data-mode=delivery]'), form = delivery.locator('#pt-approval-form'); await form.locator('[name=title]').fill('Fixture approved title'); await form.locator('[name=description]').fill('Fixture final description'); await form.locator('[name=categoryId]').selectOption('25'); for (const name of ['selfDeclaredMadeForKids', 'containsSyntheticMedia']) { const control = form.locator(`[name=${name}]`).first(); if (await control.evaluate(e => e.tagName === 'SELECT')) await control.selectOption('false'); else await form.locator(`[name=${name}][value=false]`).check(); } await form.locator('[name=disclosureRationale]').fill('Original factual cards, no realistic synthetic evidence'); await form.locator('[name=rightsAcknowledged]').check();
  const before = google.length, pending = f.page.waitForResponse(r => r.url() === `${f.base}/api/publication/approvals` && r.request().method() === 'POST'); await form.locator('button[type=submit]').click(); const previewResponse = await pending; assert.equal(previewResponse.status(), 201, await previewResponse.text()); const preview = await previewResponse.json(); assert.equal(google.length, before, 'preview cannot contact provider'); const { candidateFingerprint } = await import('../server/graph.mjs'); assert.ok(preview.manifest, 'show complete server manifest'); assert.equal(preview.fingerprint, candidateFingerprint(preview.manifest)); const displayed = await delivery.innerText(); assert.ok(displayed.includes(preview.fingerprint) && displayed.includes('Fixture final description')); assert.ok(preview.manifest.credits.includes('Delivery Fixture Artist'));
  assert.ok(displayed.includes('Delivery Fixture Artist') && displayed.includes('CC-BY-4.0'));
  await screenshot(f.page, 'delivery-preview', delivery);
  await form.locator('[name=description]').fill('Changed after preview');
  assert.equal(await delivery.locator('[data-pt-action=publish-approval]').count(), 0, 'editing a field invalidates the final action');
  assert.equal(google.length, before, 'invalidating preview has no provider side effect');
  await form.locator('[name=description]').fill('Fixture final description');
  const reprepared = f.page.waitForResponse(r => r.url() === `${f.base}/api/publication/approvals` && r.request().method() === 'POST');
  await form.locator('button[type=submit]').click(); const freshResponse = await reprepared;
  assert.equal(freshResponse.status(), 201, await freshResponse.text()); const fresh = await freshResponse.json();
  assert.notEqual(fresh.id, preview.id); assert.equal(fresh.fingerprint, preview.fingerprint);
  await delivery.locator('[data-pt-action=publish-approval]').click();
  let published; for (let i = 0; i < 120; i++) { published = await f.api(`/api/publication/approvals/${fresh.id}`); if (published.status === 'completed') break; if (['blocked', 'failed', 'unknown'].includes(published.status)) assert.fail(JSON.stringify(published)); await new Promise(done => setTimeout(done, 50)); } assert.equal(published.status, 'completed'); assert.equal(published.videoId, remoteId); assert.equal(google.filter(c => c.path === '/upload/youtube/v3/videos' && c.method === 'POST').length, 1); assert.equal(google.at(-1).method, 'GET', 'only public readback completes project'); const sanitized = JSON.stringify(await f.api('/api/state')); for (const secret of ['fixture-only-access', 'fixture-only-refresh', 'fixture-code', 'fixture-private-session']) assert.ok(!sanitized.includes(secret));
});
scenario('whole-candidate consent displays every generate node and exact costs, and disclosure changes invalidate the quote without spending', ['PW-04', 'PW-07'], async t => {
  const calls = [], model = 'bytedance/seedance-2.5/text-to-video';
  let estimatesAvailable = true;
  const provider = createGenerationProvider({ env: { HF_API_KEY: 'fixture-only-key' }, fetchImpl: async (raw, options = {}) => {
    const url = new URL(raw); calls.push({ path: url.pathname, method: options.method || 'GET' });
    assert.equal(url.origin, 'https://api.higgsfield.ai');
    assert.equal(url.pathname, `/estimate/${model}`, 'only explicit quote may reach provider fixture; never submit generation');
    return estimatesAvailable ? Response.json({ credits: 2, usd: 0.02 }) : Response.json({ error: 'fixture estimate unavailable' }, { status: 503 });
  } });
  const f = await fixture(t, { generation: provider });
  const body = graph('Two-node whole candidate consent');
  body.nodes.splice(2, 0, ...[0, 1].map(i => ({ id: `generate-${i + 1}`, type: 'generate', x: 400, y: 100 + i * 200, config: { model, sceneIndex: i, prompt: `Exact scene ${i + 1}`, params: {} } })));
  body.edges = [{ id: 'e1', source: 'script', target: 'storyboard' }, { id: 'e2', source: 'storyboard', target: 'generate-1' }, { id: 'e3', source: 'storyboard', target: 'generate-2' }, { id: 'e4', source: 'generate-1', target: 'render' }, { id: 'e5', source: 'generate-2', target: 'render' }, { id: 'e6', source: 'render', target: 'review' }];
  const template = await f.api('/api/workflows', 'POST', body), p = await project(f, 'Consent', template);
  p.episode = await f.api(`/api/episodes/${p.episode.id}`, 'PUT', { ...p.episode, scenes: [...p.episode.scenes, { ...p.episode.scenes[0], id: 'second-consent-scene', title: 'Second scene' }], expectedVersion: p.episode.version });
  await openProject(f, p); await mode(f.page, 'workflow');
  assert.deepEqual(calls, [], 'mount cannot search provider models or fetch estimates');
  await f.page.locator('[data-wf-action=run]').click(); const dialog = f.page.locator('#wf-confirm-dialog'); await dialog.waitFor();
  assert.equal(await dialog.locator('#wf-disclosure').inputValue(), '', 'AI decision starts unanswered');
  assert.equal(await dialog.locator('[data-wf-action=confirm-generation-run]').isDisabled(), true);
  await dialog.locator('#wf-disclosure').selectOption('true'); await dialog.locator('#wf-disclosure-rationale').fill('Every realistic generated illustration requires explicit disclosure');
  if (await dialog.locator('[data-wf-action=prepare-generation-source]').count()) {
    const pending = f.page.waitForResponse(r => r.url().endsWith(`/api/workflows/${p.workflow.id}/run`) && r.request().method() === 'POST');
    await dialog.locator('[data-wf-action=prepare-generation-source]').click();
    const response = await pending; assert.equal(response.status(), 202);
    const run = await response.json(); assert.equal((await terminal(f, p.workflow.id, run.id)).status, 'completed');
    if (await dialog.isVisible()) await f.page.keyboard.press('Escape');
    await mode(f.page, 'studio'); await mode(f.page, 'workflow');
    const refreshRuns = f.page.locator('[data-wf-action=refresh-runs]').first();
    const runHistory = refreshRuns.locator('xpath=ancestor::details[1]');
    if (await runHistory.count() && !await runHistory.evaluate(e => e.open)) await runHistory.locator('summary').click();
    const refreshed = f.page.waitForResponse(r => r.url().endsWith(`/api/workflows/${p.workflow.id}/runs`) && r.request().method() === 'GET');
    await refreshRuns.click(); assert.equal((await refreshed).status(), 200);
    await f.page.locator('[data-wf-action=run]').click();
    await dialog.locator('#wf-disclosure').selectOption('true'); await dialog.locator('#wf-disclosure-rationale').fill('Every realistic generated illustration requires explicit disclosure');
  }
  const pending = f.page.waitForResponse(r => r.url().endsWith(`/api/workflows/${p.workflow.id}/quote`) && r.request().method() === 'POST');
  await dialog.locator('[data-wf-action=quote-generation]').click(); const response = await pending; assert.equal(response.status(), 200); const plan = await response.json();
  assert.deepEqual(plan.nodes.map(n => n.nodeId).sort(), ['generate-1', 'generate-2']);
  for (const node of plan.nodes) { const row = dialog.locator(`[data-generation-node="${node.nodeId}"]`); assert.ok((await row.innerText()).includes(node.sceneId)); assert.ok((await row.innerText()).includes(model)); }
  assert.equal(await dialog.locator('[data-testid=generation-fingerprint]').innerText(), plan.fingerprint);
  await screenshot(f.page, 'generation-consent', dialog);
  const confirm = dialog.locator('[data-wf-action=confirm-generation-run]');
  assert.equal(await confirm.isEnabled(), true, 'fresh fully quoted candidate is confirmable');
  const invalidated = async oldPlan => {
    assert.equal(await dialog.locator('[data-generation-quote]').count(), 0, 'complete quote, candidate and waiver block disappears');
    assert.equal(await dialog.locator('[data-testid=generation-fingerprint]').count(), 0);
    assert.equal(await dialog.locator('#wf-estimate-ack').count(), 0, 'old waiver cannot survive changed consent');
    assert.ok(!(await dialog.innerText()).includes(oldPlan.fingerprint));
    for (const cost of await dialog.locator('[data-generation-cost]').allTextContents()) assert.equal(cost, '새 견적 필요', 'old node costs are invalid');
    assert.equal(await confirm.isDisabled(), true);
  };
  const quoteAgain = async () => {
    const response = f.page.waitForResponse(r => r.url().endsWith(`/api/workflows/${p.workflow.id}/quote`) && r.request().method() === 'POST');
    await dialog.locator('[data-wf-action=quote-generation]').click(); const actual = await response;
    assert.equal(actual.status(), 200, await actual.text()); const value = await actual.json();
    assert.equal(await dialog.locator('[data-testid=generation-fingerprint]').innerText(), value.fingerprint);
    assert.equal(value.fingerprint, (await import('../server/graph.mjs')).candidateFingerprint(value.candidate));
    return value;
  };
  await dialog.locator('#wf-disclosure').selectOption('false');
  await invalidated(plan);
  const fresh = await quoteAgain(); assert.notEqual(fresh.fingerprint, plan.fingerprint);
  assert.equal(await confirm.isEnabled(), true, 'new quote restores the current disclosure plan');
  const rationale = dialog.locator('#wf-disclosure-rationale');
  await rationale.evaluate(el => { el.dataset.testIdentity = 'same-focused-field'; });
  await rationale.fill('Revised rationale is a different approval input');
  assert.equal(await rationale.getAttribute('data-test-identity'), 'same-focused-field', 'typing cannot replace or blur the form');
  assert.equal(await rationale.evaluate(el => document.activeElement === el), true);
  await invalidated(fresh);
  estimatesAvailable = false;
  const unquoted = await quoteAgain(); assert.equal(unquoted.aggregate.quoted, false);
  const waiver = dialog.locator('#wf-estimate-ack'); assert.equal(await waiver.isChecked(), false);
  assert.equal(await confirm.isDisabled(), true); await waiver.check(); assert.equal(await confirm.isEnabled(), true);
  await rationale.fill('Another rationale invalidates the prior unknown-cost waiver'); await invalidated(unquoted);
  const nextUnquoted = await quoteAgain(); assert.equal(nextUnquoted.aggregate.quoted, false);
  assert.equal(await dialog.locator('#wf-estimate-ack').isChecked(), false, 'fresh quote cannot inherit previous waiver');
  assert.equal(await confirm.isDisabled(), true);
  await dialog.locator('#wf-disclosure').selectOption('true'); await invalidated(nextUnquoted);
  estimatesAvailable = true;
  const finalPlan = await quoteAgain(); assert.equal(finalPlan.aggregate.quoted, true);
  assert.equal(await confirm.isEnabled(), true, 'fresh quote restores a valid plan without generation');
  assert.equal(await dialog.locator('#wf-estimate-ack').count(), 0);
  for (const node of finalPlan.nodes) assert.ok((await dialog.locator(`[data-generation-node="${node.nodeId}"] [data-generation-cost]`).innerText()).includes('2'));
  assert.ok(calls.length >= 2); assert.ok(calls.every(c => c.path.startsWith('/estimate/')));
  assert.equal((await f.api('/api/state')).generationJobs.length, 0);
});
scenario('both repeated render/review branches use real FFmpeg jobs and require independent exact-node approvals', ['PW-02', 'PW-04'], async t => {
  const f = await fixture(t), body = graph('Two independently reviewed outputs');
  body.nodes = body.nodes.filter(n => ['script', 'storyboard'].includes(n.id));
  for (const index of [1, 2]) body.nodes.push({ id: `render-${index}`, type: 'render', x: 600, y: index * 220, config: {} }, { id: `review-${index}`, type: 'review', x: 900, y: index * 220, config: {} });
  body.edges = [{ id: 's', source: 'script', target: 'storyboard' }];
  for (const index of [1, 2]) body.edges.push({ id: `r${index}`, source: 'storyboard', target: `render-${index}` }, { id: `v${index}`, source: `render-${index}`, target: `review-${index}` });
  const template = await f.api('/api/workflows', 'POST', body), p = await project(f, 'Branches', template);
  const started = await f.api(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, selectedStages: body.nodes.map(n => n.id) });
  const run = await terminal(f, p.workflow.id, started.id); assert.equal(run.status, 'awaiting_review', JSON.stringify(run));
  const renders = [1, 2].map(i => run.nodeRuns.find(n => n.nodeId === `render-${i}`));
  for (const render of renders) { assert.equal(render.status, 'completed'); assert.match(render.output.sha256, /^[a-f0-9]{64}$/); }
  assert.notEqual(renders[0].output.jobId, renders[1].output.jobId, 'each branch retains its own actual render job');
  const second = await f.api(`/api/workflows/${p.workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId: 'review-2', decision: 'approved', notes: 'Exact branch two artifact', expectedEpisodeVersion: run.episodeVersion });
  assert.equal(second.status, 'awaiting_review', 'one approved node cannot approve the other branch');
  assert.equal(second.reviews['review-2'].jobId, renders[1].output.jobId);
  assert.equal(second.reviews['review-1'], undefined);
  const first = await f.api(`/api/workflows/${p.workflow.id}/runs/${run.id}/review`, 'POST', { reviewNodeId: 'review-1', decision: 'approved', notes: 'Exact branch one artifact', expectedEpisodeVersion: run.episodeVersion });
  assert.equal(first.status, 'approved'); assert.equal(first.reviews['review-1'].jobId, renders[0].output.jobId); assert.equal(first.reviews['review-2'].jobId, renders[1].output.jobId); assert.equal(first.review, undefined);
});

function tenRoleGraph(withGeneration = true) {
  const types = ['trend', 'news', 'research', 'script', 'storyboard', 'layout', ...(withGeneration ? ['generate'] : []), 'render', 'review', 'publish'];
  return { name: withGeneration ? 'All ten roles' : 'Source-only whole execution with publication', nodes: types.map((type, i) => ({ id: type, type, x: i * 270, y: 100, config: type === 'script' ? { agent: 'existing' } : type === 'news' ? { source: 'trend_news' } : type === 'generate' ? { model: 'bytedance/seedance-2.5/text-to-video', sceneIndex: 0, prompt: 'Explicit fixture illustration' } : {} })), edges: types.slice(1).map((target, i) => ({ id: `full-${i}`, source: types[i], target })) };
}
const trendFixture = { integrationStatus: async () => ({ studio: { available: true } }), fetchTrends: async () => ({ trends: [{ keyword: 'Fixture sourced headline', title: 'Fixture sourced headline', source: 'Fixture RSS', url: 'https://source.fixture.invalid/story' }], sources: [{ name: 'Fixture RSS', status: 'ok' }] }), runAgent: async () => { throw new Error('Unexpected agent transport'); } };

scenario('all ten roles prepare and quote through the UI while publish stays outside both execution selections', ['PW-02', 'PW-04', 'PW-05'], async t => {
  const estimates = [];
  const generation = createGenerationProvider({ env: { HF_API_KEY: 'fixture-only-key' }, fetchImpl: async raw => { const url = new URL(raw); assert.equal(url.origin, 'https://api.higgsfield.ai'); assert.ok(url.pathname.startsWith('/estimate/'), 'only an explicit quote reaches the fixture'); estimates.push(url.pathname); return Response.json({ credits: 3, usd: 0.03 }); } });
  const f = await fixture(t, { integrations: trendFixture, generation }), template = await f.api('/api/workflows', 'POST', tenRoleGraph()), p = await project(f, 'Ten roles', template);
  assert.equal(p.workflow.nodes.length, 10);
  await openProject(f, p); await mode(f.page, 'workflow');
  assert.deepEqual(estimates, []);
  await f.page.locator('[data-wf-action=run]').click();
  let dialog = f.page.locator('#wf-confirm-dialog'); await dialog.waitFor();
  const prepared = f.page.waitForResponse(r => r.url().endsWith(`/api/workflows/${p.workflow.id}/run`) && r.request().method() === 'POST');
  await dialog.locator('[data-wf-action=prepare-generation-source]').click(); const response = await prepared;
  assert.equal(response.status(), 202, await response.text());
  assert.deepEqual(response.request().postDataJSON().selectedStages.sort(), ['trend', 'news', 'research', 'script', 'storyboard', 'layout'].sort());
  const run = await terminal(f, p.workflow.id, (await response.json()).id); assert.equal(run.status, 'completed', JSON.stringify(run));
  assert.equal(run.nodeRuns.find(n => n.nodeId === 'publish').status, 'skipped');
  await openProject(f, p); await mode(f.page, 'workflow'); await f.page.locator('[data-wf-action=run]').click();
  dialog = f.page.locator('#wf-confirm-dialog');
  await dialog.locator('#wf-disclosure').selectOption('true'); await dialog.locator('#wf-disclosure-rationale').fill('Realistic fixture illustrations need disclosure');
  const quoted = f.page.waitForResponse(r => r.url().endsWith(`/api/workflows/${p.workflow.id}/quote`) && r.request().method() === 'POST');
  await dialog.locator('[data-wf-action=quote-generation]').click(); const quote = await quoted;
  assert.equal(quote.status(), 200, await quote.text());
  const options = quote.request().postDataJSON(); assert.ok(!options.selectedStages.includes('publish')); assert.ok(options.selectedStages.includes('generate')); assert.equal(options.resumeRunId, run.id);
  const plan = await quote.json(); assert.equal(plan.nodes.length, 1); assert.equal(await dialog.locator('[data-testid=generation-fingerprint]').innerText(), plan.fingerprint); assert.equal(await dialog.locator('[data-wf-action=confirm-generation-run]').isEnabled(), true);
  assert.equal((await f.api('/api/state')).generationJobs.length, 0);
  assert.equal(f.writes.filter(w => w.path.startsWith('/api/publication/')).length, 0);
  assert.equal(estimates.length, 1);
  await screenshot(f.page, 'ten-role-quote', dialog);
});

scenario('source-only whole execution excludes publish and stops at the real local review checkpoint', ['PW-02', 'PW-04', 'PW-05'], async t => {
  const f = await fixture(t, { integrations: trendFixture }), template = await f.api('/api/workflows', 'POST', tenRoleGraph(false)), p = await project(f, 'Source-only final gate', template);
  await openProject(f, p); await mode(f.page, 'workflow');
  const pending = f.page.waitForResponse(r => r.url().endsWith(`/api/workflows/${p.workflow.id}/run`) && r.request().method() === 'POST');
  await f.page.locator('[data-wf-action=run]').click(); const response = await pending;
  assert.equal(response.status(), 202, await response.text());
  assert.deepEqual(response.request().postDataJSON().selectedStages.sort(), template.nodes.filter(n => n.type !== 'publish').map(n => n.id).sort());
  const run = await terminal(f, p.workflow.id, (await response.json()).id);
  assert.equal(run.status, 'awaiting_review', JSON.stringify(run));
  assert.equal(run.nodeRuns.find(n => n.nodeId === 'publish').status, 'skipped');
  const render = run.nodeRuns.find(n => n.nodeId === 'render'); assert.equal(render.status, 'completed'); assert.match(render.output.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await f.api('/api/state')).generationJobs.length, 0);
  assert.equal(f.writes.filter(w => /quote|generation|publication/.test(w.path)).length, 0);
});

scenario('sequential reviewed producers enable the next render in the UI while publish requires its nearest approved review', ['PW-02', 'PW-04', 'PW-05'], async t => {
  const f = await fixture(t), types = ['script', 'storyboard', 'render', 'review', 'render', 'review', 'publish'], ids = ['script', 'storyboard', 'render-1', 'review-1', 'render-2', 'review-2', 'publish'];
  const body = { name: 'Sequential reviewed producers', nodes: types.map((type, i) => ({ id: ids[i], type, x: i * 270, y: 100, config: type === 'script' ? { agent: 'existing' } : {} })), edges: ids.slice(1).map((target, i) => ({ id: `seq-${i}`, source: ids[i], target })) };
  const template = await f.api('/api/workflows', 'POST', body), p = await project(f, 'Sequential readiness', template);
  const first = await terminal(f, p.workflow.id, (await f.api(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, selectedStages: ids.slice(0, 4) })).id);
  assert.equal(first.status, 'awaiting_review');
  await f.api(`/api/workflows/${p.workflow.id}/runs/${first.id}/review`, 'POST', { reviewNodeId: 'review-1', decision: 'approved', expectedEpisodeVersion: first.episodeVersion, notes: 'First exact artifact' });
  await openProject(f, p); await mode(f.page, 'workflow'); await f.page.locator('.wf-node-header[data-id=render-2]').click(); await f.page.locator('[data-wf-action=open-stage-overlay]').first().click();
  let dialog = f.page.locator('#wf-stage-dialog'); assert.equal(await dialog.locator('#wf-stage-status').getAttribute('data-stage-state'), 'idle'); assert.equal(await dialog.locator('#wf-stage-start').isEnabled(), true);
  const pending = f.page.waitForResponse(r => r.url().endsWith(`/api/workflows/${p.workflow.id}/run`) && r.request().method() === 'POST'); await dialog.locator('#wf-stage-start').click(); const response = await pending;
  assert.equal(response.status(), 202, await response.text()); const options = response.request().postDataJSON(); assert.deepEqual(options.selectedStages, ['render-2']); assert.equal(options.resumeRunId, first.id);
  const second = await terminal(f, p.workflow.id, (await response.json()).id); assert.equal(second.status, 'completed', JSON.stringify(second)); assert.notEqual(second.nodeRuns.find(n => n.nodeId === 'render-2').output.jobId, first.nodeRuns.find(n => n.nodeId === 'render-1').output.jobId);
  const review = await terminal(f, p.workflow.id, (await f.api(`/api/workflows/${p.workflow.id}/run`, 'POST', { episodeId: p.episode.id, selectedStages: ['review-2'], startStage: 'review-2', resumeRunId: second.id })).id); assert.equal(review.status, 'awaiting_review');
  await openProject(f, p); await mode(f.page, 'workflow'); await f.page.locator('.wf-node-header[data-id=publish]').click(); await f.page.locator('[data-wf-action=open-stage-overlay]').first().click();
  dialog = f.page.locator('#wf-stage-dialog'); assert.equal(await dialog.locator('#wf-stage-status').getAttribute('data-stage-state'), 'blocked'); assert.equal(await dialog.locator('#wf-stage-start').isDisabled(), true, 'approval of review-1 cannot approve nearest review-2');
  await f.page.keyboard.press('Escape');
  await f.api(`/api/workflows/${p.workflow.id}/runs/${review.id}/review`, 'POST', { reviewNodeId: 'review-2', decision: 'approved', expectedEpisodeVersion: review.episodeVersion, notes: 'Second exact artifact' });
  await openProject(f, p); await mode(f.page, 'workflow'); await f.page.locator('.wf-node-header[data-id=publish]').click(); await f.page.locator('[data-wf-action=open-stage-overlay]').first().click();
  dialog = f.page.locator('#wf-stage-dialog'); assert.equal(await dialog.locator('#wf-stage-status').getAttribute('data-stage-state'), 'idle'); assert.equal(await dialog.locator('#wf-stage-start').isEnabled(), true);
  assert.equal(f.writes.filter(w => w.path.startsWith('/api/publication/')).length, 0, 'readiness does not publish');
  await screenshot(f.page, 'sequential-readiness', dialog);
});

scenario('browser-local custom workspace profiles survive graph remount and settings reopen with drafts and fit intact', ['PW-02', 'PW-07'], async t => {
  const f = await fixture(t), p = await project(f, 'Custom mount composition');
  await openProject(f, p);
  await f.page.locator('[data-scene=title]').fill('Scene draft survives custom graph mount');
  await mode(f.page, 'workflow');
  await f.page.locator('[data-wf-action=open-workflow-settings]').click();
  await f.page.locator('#wf-workflow-name').fill('Graph draft survives custom graph mount');
  await f.page.keyboard.press('Escape');
  const settingsButton = f.page.locator('[data-workspace-action=settings]');
  await settingsButton.focus(); await f.page.keyboard.press('Enter');
  const settings = f.page.locator('#workspace-settings-dialog');
  assert.equal(await settings.evaluate(element => element.open && element.contains(document.activeElement)), true, 'custom sizing opens as a keyboard-owned native dialog');
  await f.page.locator('#workspace-width').fill('1173');
  await f.page.locator('#workspace-height').fill('673');
  await f.page.locator('#workspace-inspector-width').fill('347');
  await f.page.locator('#workspace-tools-mode').selectOption('overlay');
  await f.page.locator('#workspace-profile-name').fill('Mount composition profile');
  await f.page.locator('#workspace-profile-form button[type=submit]').click();
  const profileId = await f.page.locator('#workspace-profile-select').inputValue();
  await settings.locator('[data-workspace-action=close-settings]').click();
  assert.equal(await settingsButton.evaluate(element => element === document.activeElement), true, 'closing sizing settings restores the actual opener');
  await selectChannel(f.page, p.channel.id);
  await f.page.locator('#workflow-canvas').waitFor();
  await settingsButton.focus(); await f.page.keyboard.press('Enter');
  assert.equal(await settings.evaluate(element => element.open && element.contains(document.activeElement)), true, 'settings remain keyboard-usable after the owned graph remount');
  assert.equal(await f.page.locator('#workspace-profile-select').inputValue(), profileId);
  assert.equal(await f.page.locator('#workspace-profile-select option:checked').innerText(), 'Mount composition profile');
  for (const [id, value] of [['workspace-width', '1173'], ['workspace-height', '673'], ['workspace-inspector-width', '347'], ['workspace-tools-mode', 'overlay']]) assert.equal(await f.page.locator(`#${id}`).inputValue(), value, `${id} survives graph remount and settings reopen`);
  await f.page.locator('#workspace-width').fill('842'); await f.page.locator('#workspace-height').focus();
  await f.page.locator('#workspace-profile-select').selectOption(profileId);
  await settings.locator('[data-workspace-action=close-settings]').click();
  assert.ok(Math.abs(await f.page.locator('#workspace-window').evaluate(element => element.getBoundingClientRect().width) - 1173) <= 2, 'restoring the browser profile controls actual workbench geometry, not just settings fields');
  await f.page.waitForFunction(() => {
    const canvas = document.querySelector('#workflow-canvas'), bounds = canvas?.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('#workflow-canvas .wf-node')];
    return bounds && nodes.length === 4 && nodes.every(node => { const rect = node.getBoundingClientRect(); return rect.left >= bounds.left - 2 && rect.right <= bounds.right + 2 && rect.top >= bounds.top - 2 && rect.bottom <= bounds.bottom + 2; });
  });
  assert.equal(await f.page.locator('#wf-save-status').getAttribute('class'), 'unsaved');
  await f.page.locator('[data-wf-action=open-workflow-settings]').click();
  assert.equal(await f.page.locator('#wf-workflow-name').inputValue(), 'Graph draft survives custom graph mount');
  await f.page.keyboard.press('Escape');
  await mode(f.page, 'studio');
  assert.equal(await f.page.locator('[data-scene=title]').inputValue(), 'Scene draft survives custom graph mount');
  assert.equal(await f.page.locator('#save-status').getAttribute('class'), 'unsaved');
  assert.deepEqual(f.writes, [], 'local profile, native settings, graph remount and draft restoration never save or execute');
  assert.deepEqual((await f.api('/api/state')).episodes.find(episode => episode.id === p.episode.id), p.episode, 'episode source and original saved version remain intact');
  assert.deepEqual((await f.api('/api/workflows')).find(workflow => workflow.id === p.workflow.id), p.workflow, 'owned graph source and original saved version remain intact');
});
