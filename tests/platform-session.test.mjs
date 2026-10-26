import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, lstat, stat, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, starterScene } from '../server/store.mjs';
import { PlatformSessionManager } from '../server/platform-session.mjs';

const playwrightModulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const browserModule = playwrightModulePath
  ? await import(pathToFileURL(playwrightModulePath))
  : await import('playwright');
const chromiumExecutable = process.env.PLATFORM_CHROMIUM_PATH
  || process.env.CHROMIUM_PATH
  || process.env.PLAYWRIGHT_EXECUTABLE_PATH
  || browserModule.chromium.executablePath();

async function fixtureServer(t) {
  const received = { body: Buffer.alloc(0), path: '', requests: [] };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    received.requests.push({ method: request.method, path: request.url, body });
    if (request.method === 'POST' && request.url === '/submit') {
      received.body = body;
      received.path = request.url;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Received</title><output id="received">received</output>');
      return;
    }
    if (request.url === '/alternate') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>Alternate Fixture</title>${formMarkup()}`);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Start Fixture</title>${formMarkup()}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { server, received, base: `http://127.0.0.1:${server.address().port}` };
}

function formMarkup() {
  return '<form action="/submit" method="post" enctype="multipart/form-data">'
    + '<label>Title<input id="title" name="title"></label>'
    + '<input id="upload" name="media" type="file">'
    + '<button id="submit" type="submit">Submit fixture</button>'
    + '</form>';
}

async function managerFixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-platform-session-'));
  const store = new Store(dataDir);
  const episode = store.create('episodes', { channelId: store.list('channels')[0].id, title: 'Browser export episode', topic: 'Fixture', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [starterScene('Fixture scene', 'Fixture text')] });
  const fixture = await fixtureServer(t);
  const manager = new PlatformSessionManager({ store, browserModule, browserOptions: { executablePath: chromiumExecutable } });
  t.after(async () => {
    await manager.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, episode, fixture, manager };
}

function multipartContains(body, value) {
  return body.includes(Buffer.from(value));
}

test('real persistent browser session navigates, inputs, screenshots, and closes without leaking private handles', async (t) => {
  const { dataDir, fixture, manager, store, episode } = await managerFixture(t);
  const exportBytes = Buffer.from('real local export bytes\n\x00\xff');
  await mkdir(path.join(dataDir, 'exports'), { recursive: true });
  await writeFile(path.join(dataDir, 'exports', 'browser-fixture.mp4'), exportBytes);
  store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'completed', outputUrl: '/api/exports/browser-fixture.mp4', sha256: createHash('sha256').update(exportBytes).digest('hex') });

  const session = await manager.openSession({
    platform: 'other',
    url: `${fixture.base}/start`,
    title: 'Fixture browser title',
    description: 'Local fixture only',
    visibility: 'private',
  });
  assert.equal(session.status, 'active');
  assert.equal(session.mode, 'persistent-chromium');
  assert.equal(session.browser.available, true);
  assert.equal(session.url, `${fixture.base}/start`);
  assert.match(session.screenshotUrl, new RegExp(`^/api/platform-sessions/${session.id}/screenshot$`));
  assert.equal(session.attachmentStatus, 'none');
  assert.equal(session.publicationStatus, 'not_attempted');
  assert.ok(!JSON.stringify(session).includes(dataDir), 'session serialization must not expose profile/data paths');
  assert.equal('serverPath' in session, false);
  assert.equal('browserContext' in session, false);

  const firstShot = await manager.screenshot(session.id);
  assert.ok(Buffer.isBuffer(firstShot));
  assert.deepEqual(firstShot.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(firstShot.length > 1000, 'screenshot must be a rendered PNG, not a serialized placeholder');

  const navigated = await manager.interact(session.id, { action: 'navigate', url: `${fixture.base}/alternate` });
  assert.equal(navigated.url, `${fixture.base}/alternate`);
  const input = await manager.interact(session.id, { action: 'input', selector: '#title', value: 'Input reached the real fixture page' });
  assert.equal(input.id, session.id);

  const attached = await manager.interact(session.id, {
    action: 'attach-export',
    exportUrl: '/api/exports/browser-fixture.mp4',
    selector: '#upload',
  });
  assert.equal(attached.attachmentStatus, 'attached');
  assert.equal(attached.attachedExport.filename, 'browser-fixture.mp4');
  assert.equal(attached.attachedExport.size, exportBytes.length);
  assert.equal(attached.attachedExport.sha256, createHash('sha256').update(exportBytes).digest('hex'));
  assert.equal(attached.publicationStatus, 'not_attempted');

  await manager.interact(session.id, { action: 'click', selector: '#submit' });
  assert.equal(fixture.received.path, '/submit');
  assert.ok(multipartContains(fixture.received.body, 'Input reached the real fixture page'));
  assert.ok(multipartContains(fixture.received.body, exportBytes), 'fixture received the exact server-export bytes through a live file input');
  assert.equal(store.list('platformUploads').length, 0, 'file attachment must not claim publication');
  assert.equal(manager.getSession(session.id).publicationStatus, 'not_attempted');

  const closed = await manager.interact(session.id, { action: 'close' });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.browser.available, false);
  assert.match(closed.closedAt, /^20\d\d-/);
  assert.ok(!JSON.stringify(closed).includes(dataDir), 'closed session serialization must remain private');
});

test('missing browser dependency fails explicitly instead of creating a fake successful session', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-platform-no-browser-'));
  const store = new Store(dataDir);
  const fixture = await fixtureServer(t);
  const manager = new PlatformSessionManager({ store, browserModule: {} });
  t.after(async () => { await manager.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });

  await assert.rejects(
    () => manager.openSession({ platform: 'other', url: `${fixture.base}/start` }),
    (error) => error?.status === 503 && /Chromium browser unavailable/i.test(error.message),
  );
  assert.equal(manager.listSessions().length, 0, 'failed browser launch must not persist a session');
});

test('server export verification rejects traversal, symlinks, and empty artifacts', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-platform-boundaries-'));
  const store = new Store(dataDir);
  const manager = new PlatformSessionManager({ store, browserModule });
  t.after(async () => { await manager.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const exportsDir = path.join(dataDir, 'exports');
  await mkdir(exportsDir, { recursive: true });
  await writeFile(path.join(exportsDir, 'empty.mp4'), Buffer.alloc(0));
  const outside = path.join(dataDir, 'outside.mp4');
  const outsideBytes = Buffer.from('outside');
  await writeFile(outside, outsideBytes);
  const link = path.join(exportsDir, 'link.mp4');
  const episode = store.create('episodes', { channelId: store.list('channels')[0].id, title: 'Linked episode', topic: 'Fixture', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [starterScene('Fixture scene', 'Fixture text')] });
  for (const filename of ['empty.mp4', 'link.mp4', 'not-present.mp4']) store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'completed', outputUrl: `/api/exports/${filename}` });
  const linkedBytes = Buffer.from('linked render');
  await writeFile(path.join(exportsDir, 'linked.mp4'), linkedBytes);
  const linkedJob = store.create('jobs', { episodeId: episode.id, episodeVersion: 1, status: 'completed', outputUrl: '/api/exports/linked.mp4', sha256: createHash('sha256').update(linkedBytes).digest('hex') });

  await assert.rejects(() => manager.verifyServerExport('/api/exports/../outside.mp4'), (error) => error?.status === 400);
  await assert.rejects(() => manager.verifyServerExport('/api/exports/empty.mp4'), (error) => error?.status === 409);
  await assert.rejects(() => manager.verifyServerExport('/api/exports/not-present.mp4'), (error) => error?.status === 404);
  await assert.rejects(() => manager.verifyServerExport('/api/exports/linked.mp4', { jobId: 'wrong-job' }), (error) => error?.status === 409 && /render job/i.test(error.message));
  await assert.rejects(() => manager.verifyServerExport('/api/exports/linked.mp4', { episodeId: 'wrong-episode' }), (error) => error?.status === 409 && /episode/i.test(error.message));
  await assert.rejects(() => manager.verifyServerExport('/api/exports/linked.mp4', { episodeVersion: 2 }), (error) => error?.status === 409 && /episode version/i.test(error.message));
  assert.equal((await manager.verifyServerExport('/api/exports/linked.mp4', { jobId: linkedJob.id, episodeId: episode.id, episodeVersion: 1 })).sha256, createHash('sha256').update(linkedBytes).digest('hex'));

  // Run the other guards even on hosts that cannot create file symlinks.
  await symlink(outside, link, 'file');
  // A directory junction or malformed reparse point cannot stand in for this
  // readable regular-file escape: the production guard must reject a real link.
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal((await stat(link)).isFile(), true);
  const resolvedLink = await realpath(link);
  assert.equal(resolvedLink, await realpath(outside));
  assert.notEqual(path.dirname(resolvedLink), await realpath(exportsDir));
  assert.deepEqual(await readFile(link), outsideBytes);
  await assert.rejects(() => manager.verifyServerExport('/api/exports/link.mp4'), (error) => error?.status === 404);
});

test('staged export hash change is rejected before any publication record is created', async (t) => {
  const { dataDir, fixture, manager, store, episode } = await managerFixture(t);
  const exportPath = path.join(dataDir, 'exports', 'mutable.mp4');
  const original = Buffer.from('before-stage');
  await writeFile(exportPath, original);
  store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'completed', outputUrl: '/api/exports/mutable.mp4', sha256: createHash('sha256').update(original).digest('hex') });
  const session = await manager.openSession({ platform: 'other', url: `${fixture.base}/start` });
  const staged = await manager.interact(session.id, { action: 'attach-export', exportUrl: '/api/exports/mutable.mp4', selector: '#upload' });
  await writeFile(exportPath, Buffer.from('after-stage'));

  await assert.rejects(
    () => manager.verifyServerExport('/api/exports/mutable.mp4'),
    (error) => error?.status === 409 && /hash changed since the job completed/i.test(error.message),
  );
  assert.equal(store.list('platformUploads').length, 0);
  assert.equal(manager.getSession(session.id).publicationStatus, 'not_attempted');
  assert.equal(staged.attachedExport.sha256, createHash('sha256').update(original).digest('hex'));
});

test('YouTube keeps a manual Studio handoff and rejects automated browser controls without opening a browser', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-youtube-manual-'));
  const store = new Store(dataDir);
  const episode = store.create('episodes', { channelId: store.list('channels')[0].id, title: 'Manual handoff episode', topic: 'Fixture', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [starterScene('Fixture scene', 'Fixture text')] });
  const exportBytes = Buffer.from('verified manual handoff export');
  await writeFile(path.join(dataDir, 'exports', 'verified.mp4'), exportBytes);
  store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'completed', outputUrl: '/api/exports/verified.mp4', sha256: createHash('sha256').update(exportBytes).digest('hex') });
  let launches = 0;
  const manager = new PlatformSessionManager({ store, browserModule: { chromium: { launchPersistentContext: async () => { launches++; throw new Error('YouTube must never launch an automated browser'); } } } });
  const originalList = store.list.bind(store);
  t.after(() => { store.list = originalList; });
  t.after(async () => { await manager.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const session = await manager.openSession({ platform: 'youtube', autoAttachExport: true });
  assert.equal(session.mode, 'manual-external');
  assert.equal(session.manualUrl, 'https://studio.youtube.com/channel/upload');
  assert.equal(session.browser.available, false);
  assert.equal(session.attachmentStatus, 'none');
  assert.equal(session.publicationStatus, 'not_attempted');
  let exportJobLookups = 0;
  // Observe the real SQLite boundary: policy denial must not read render jobs.
  store.list = kind => { if (kind === 'jobs') exportJobLookups++; return originalList(kind); };
  for (const action of [
    { action: 'navigate', url: 'https://studio.youtube.com' },
    { action: 'input', selector: '#title', value: 'Blocked' },
    { action: 'click', selector: '#publish' },
    { action: 'key', key: 'Enter' },
    { action: 'scroll', deltaY: 100 },
    { action: 'upload' },
    { action: 'refresh' },
    { action: 'attach-export', exportUrl: '/api/exports/fixture.mp4' },
    { action: 'attach-export' },
    { action: 'attach-export', exportUrl: '/api/exports/../outside.mp4' },
    { action: 'attach-export', exportUrl: '/api/exports/verified.mp4', selector: '#upload' },
  ]) {
    await assert.rejects(manager.interact(session.id, action), error => error.status === 409 && /YouTube browser automation is disabled/.test(error.message));
    assert.equal(exportJobLookups, 0, `${action.action} must reject before export lookup`);
    assert.deepEqual(manager.getSession(session.id), session, `${action.action} must not attach an export or mutate the manual session`);
  }
  store.list = originalList;
  await assert.rejects(manager.openSession({ platform: 'other', url: 'https://studio.youtube.com' }), { status: 409 });
  assert.equal(launches, 0);
  assert.equal(store.list('platformUploads').length, 0);
  assert.equal((await manager.interact(session.id, { action: 'close' })).status, 'closed');
});
