import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm, access, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, starterScene } from '../server/store.mjs';
import { PlatformSessionManager } from '../server/platform-session.mjs';

const playwrightPath = process.env.PLATFORM_PLAYWRIGHT_MODULE
  || process.env.OPS_PLAYWRIGHT_MODULE
  || path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const browserModule = await import(pathToFileURL(playwrightPath));
async function findChromiumExecutable() {
  const requested = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || browserModule.chromium.executablePath();
  try { await access(requested); return requested; } catch {}
  const cacheRoot = path.resolve(path.dirname(requested), '../../../../..');
  const versions = (await readdir(cacheRoot)).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse();
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error(`Chromium executable is required for real browser acceptance tests: ${requested}`);
}
const chromiumExecutable = await findChromiumExecutable();

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
  const fixture = await fixtureServer(t);
  const manager = new PlatformSessionManager({ store, browserModule, browserOptions: { executablePath: chromiumExecutable } });
  t.after(async () => {
    await manager.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, fixture, manager };
}

function multipartContains(body, value) {
  return body.includes(Buffer.from(value));
}

test('real persistent browser session navigates, inputs, screenshots, and closes without leaking private handles', async (t) => {
  const { dataDir, fixture, manager, store } = await managerFixture(t);
  const exportBytes = Buffer.from('real local export bytes\n\x00\xff');
  await mkdir(path.join(dataDir, 'exports'), { recursive: true });
  await writeFile(path.join(dataDir, 'exports', 'browser-fixture.mp4'), exportBytes);
  store.create('jobs', { episodeId: 'fixture-episode', episodeVersion: 1, status: 'completed', outputUrl: '/api/exports/browser-fixture.mp4', sha256: createHash('sha256').update(exportBytes).digest('hex') });

  const session = await manager.openSession({
    platform: 'youtube',
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
    () => manager.openSession({ url: `${fixture.base}/start` }),
    (error) => error?.status === 503 && /Chromium browser unavailable/i.test(error.message),
  );
  assert.equal(manager.listSessions().length, 0, 'failed browser launch must not persist a session');
});

test('server export verification rejects traversal, symlinks, and empty artifacts', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-platform-boundaries-'));
  const store = new Store(dataDir);
  const manager = new PlatformSessionManager({ store, browserModule });
  const exportsDir = path.join(dataDir, 'exports');
  await mkdir(exportsDir, { recursive: true });
  await writeFile(path.join(exportsDir, 'empty.mp4'), Buffer.alloc(0));
  const outside = path.join(dataDir, 'outside.mp4');
  await writeFile(outside, Buffer.from('outside'));
  await symlink(outside, path.join(exportsDir, 'link.mp4'));
  for (const filename of ['empty.mp4', 'link.mp4', 'not-present.mp4']) store.create('jobs', { episodeId: 'fixture-episode', episodeVersion: 1, status: 'completed', outputUrl: `/api/exports/${filename}` });
  const linkedBytes = Buffer.from('linked render');
  await writeFile(path.join(exportsDir, 'linked.mp4'), linkedBytes);
  const episode = store.create('episodes', { channelId: store.list('channels')[0].id, title: 'Linked episode', topic: 'Fixture', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [starterScene('Fixture scene', 'Fixture text')] });
  const linkedJob = store.create('jobs', { episodeId: episode.id, episodeVersion: 1, status: 'completed', outputUrl: '/api/exports/linked.mp4', sha256: createHash('sha256').update(linkedBytes).digest('hex') });
  t.after(async () => { await manager.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });

  await assert.rejects(() => manager.verifyServerExport('/api/exports/../outside.mp4'), (error) => error?.status === 400);
  await assert.rejects(() => manager.verifyServerExport('/api/exports/link.mp4'), (error) => error?.status === 404);
  await assert.rejects(() => manager.verifyServerExport('/api/exports/empty.mp4'), (error) => error?.status === 409);
  await assert.rejects(() => manager.verifyServerExport('/api/exports/linked.mp4', { jobId: 'wrong-job' }), (error) => error?.status === 409 && /render job/i.test(error.message));
  await assert.rejects(() => manager.verifyServerExport('/api/exports/linked.mp4', { episodeId: 'wrong-episode' }), (error) => error?.status === 409 && /episode/i.test(error.message));
  await assert.rejects(() => manager.verifyServerExport('/api/exports/linked.mp4', { episodeVersion: 2 }), (error) => error?.status === 409 && /episode version/i.test(error.message));
  assert.equal((await manager.verifyServerExport('/api/exports/linked.mp4', { jobId: linkedJob.id, episodeId: episode.id, episodeVersion: 1 })).sha256, createHash('sha256').update(linkedBytes).digest('hex'));
});

test('staged export hash change is rejected before any publication record is created', async (t) => {
  const { dataDir, fixture, manager, store } = await managerFixture(t);
  const exportPath = path.join(dataDir, 'exports', 'mutable.mp4');
  const original = Buffer.from('before-stage');
  await writeFile(exportPath, original);
  store.create('jobs', { episodeId: 'fixture-episode', episodeVersion: 1, status: 'completed', outputUrl: '/api/exports/mutable.mp4', sha256: createHash('sha256').update(original).digest('hex') });
  const session = await manager.openSession({ url: `${fixture.base}/start` });
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
