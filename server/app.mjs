import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat, realpath, unlink } from 'node:fs/promises';
import { join, resolve, relative, extname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, entity, starterScene } from './store.mjs';
import { TrendCollector } from './trend-collector.mjs';
import { HttpError, object, text, optionalText, choice, url, scenes, formats, episodePatch } from './validation.mjs';
import { WorkflowEngine, validateWorkflow } from './workflows.mjs';
import { NarrationQueue, createSpeechProvider } from './narration.mjs';
import { GenerationQueue } from './generations.mjs';
import { createGenerationProvider } from './generation-provider.mjs';
import { PlatformSessionManager } from './platform-session.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 100 * 1024 * 1024;
const SESSION_AGE = 12 * 60 * 60 * 1000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.ico': 'image/x-icon' };
const MEDIA_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg'];
const digest = (value) => createHash('sha256').update(value).digest();
const safeEqual = (left, right) => timingSafeEqual(digest(left), digest(right));

// Pure policy seam: exercise non-admin principals without issuing such sessions.
export function requireAdmin(session) {
  if (!session?.authenticated) throw new HttpError(401, 'Login required');
  if (session.role !== 'admin') throw new HttpError(403, 'Administrator required');
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > MAX_JSON) throw new HttpError(413, 'JSON body exceeds 1 MiB');
    parts.push(part);
  }
  try { return object(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Malformed JSON body');
  }
}

function assertSameOrigin(request, publicOrigin) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site writes are not allowed');
  const origin = request.headers.origin;
  if (!origin) return; // Non-browser clients authenticate normally; browsers send Origin on cross-origin writes.
  const host = request.headers.host;
  const allowed = publicOrigin ? [new URL(publicOrigin).origin] : [`http://${host}`, `https://${host}`];
  if (!allowed.includes(origin)) throw new HttpError(403, 'Origin does not match this service');
}

async function serveFile(request, response, root, name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.split('/').some((part) => !part || part === '..' || part === '.' || /[:]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new HttpError(400, 'Invalid file path');
  const base = await realpath(root);
  let filename;
  try { filename = await realpath(join(base, name)); } catch { throw new HttpError(404, 'File not found'); }
  const contained = relative(base, filename);
  if (!contained || contained.startsWith('..') || isAbsolute(contained)) throw new HttpError(403, 'File is outside the media directory');
  const info = await stat(filename);
  if (!info.isFile()) throw new HttpError(404, 'File not found');
  let start = 0, end = info.size - 1, status = 200;
  const headers = { 'Content-Type': MIME[extname(filename).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-cache' };
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!match || (!match[1] && !match[2])) throw new HttpError(416, 'Invalid byte range');
    start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    end = match[1] && match[2] ? Number(match[2]) : info.size - 1;
    if (start > end || start >= info.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      response.setHeader('Content-Range', `bytes */${info.size}`);
      throw new HttpError(416, 'Byte range not satisfiable');
    }
    end = Math.min(end, info.size - 1);
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  response.writeHead(status, headers);
  if (request.method === 'HEAD' || !info.size) return response.end();
  const stream = createReadStream(filename, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

function safeError(error) {
  return error instanceof HttpError ? error.message : 'Operation failed. Check the local service logs.';
}

async function generationCall(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError([400,422,429,503].includes(error.statusCode) ? error.statusCode : 502, 'Higgsfield request failed. Check the selected model, parameters and provider connection.');
  }
}

/** Dependency overrides are for local tests; production imports actual adapters. */
export function createApp({ dataDir = process.env.DATA_DIR || resolve('data'), loginToken = process.env.LOGIN_TOKEN || '', publicOrigin = process.env.PUBLIC_ORIGIN, integrations, renderer, speech, generation, generationOptions, platformSessions: injectedPlatformSessions, platformSessionOptions } = {}) {
  if (loginToken && (typeof loginToken !== 'string' || loginToken.length < 16)) throw new Error('LOGIN_TOKEN must contain at least 16 characters');
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without credentials');
    publicOrigin = parsed.origin;
  }
  const store = new Store(resolve(dataDir));
  const sessions = new Map();
  const loginAttempts = new Map();
  const queue = [];
  let rendering = false;
  let closing = false;
  const adapter = async () => integrations || await import('./integrations.mjs');
  const integrationStatus = async () => {
    try { return await (await adapter()).integrationStatus(); }
    catch { return { studio: { available: true, status: 'available', detail: 'Deterministic storyboard assistant' }, bridge: { available: false, status: 'unavailable', detail: 'Integration status unavailable' } }; }
  };

  async function processQueue() {
    if (rendering || closing || !queue.length) return;
    rendering = true;
    const { job, episode, resolve: complete, reject: fail } = queue.shift();
    const saveProgress = (status, progress, extra = {}) => store.save('jobs', { ...store.get('jobs', job.id), status, progress, updatedAt: new Date().toISOString(), ...extra });
    try {
      saveProgress('running', 1);
      const render = renderer || (await import('./render.mjs')).renderEpisode;
      const result = await render(episode, { dataDir: store.dataDir, onProgress: (progress) => { if (!closing) saveProgress('running', Math.max(1, Math.min(99, Number(progress) || 1))); } });
      if (!/^\/api\/exports\/[a-zA-Z0-9_-]+\.mp4$/.test(result.outputUrl)) throw new Error('Renderer returned invalid output path');
      if (!closing) { saveProgress('completed', 100, result); store.record('render.completed', { entityId: episode.id, jobId: job.id }); complete?.({ ...result, jobId: job.id, episodeVersion: episode.version }); }
    } catch (error) {
      if (!closing) { saveProgress('failed', 0, { error: 'Rendering failed. Verify FFmpeg, media files and available disk space.' }); store.record('render.failed', { entityId: episode.id, jobId: job.id }); }
      console.error('Render failed:', error.message);
      fail?.(error);
    } finally { rendering = false; if (!closing) setImmediate(processQueue); }
  }

  function enqueueRender(episode, waitForCompletion = false) {
    if (store.list('jobs').filter((job) => ['queued', 'running'].includes(job.status)).length >= 10) throw new HttpError(429, 'Render queue is full');
    validateAssets(scenes(episode.scenes));
    const job = store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'queued', progress: 0 });
    const completion = waitForCompletion ? new Promise((resolve, reject) => queue.push({ job, episode, resolve, reject })) : undefined;
    if (!waitForCompletion) queue.push({ job, episode });
    setImmediate(processQueue);
    return waitForCompletion ? completion : job;
  }

  function sessionState(request) {
    if (!loginToken) return { authenticated: true, role: 'admin', canMutate: true };
    const cookie = (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('frameforge_session='))?.slice(19);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return { authenticated: false, role: null, canMutate: false };
    const key = digest(cookie).toString('hex');
    const session = sessions.get(key);
    if (!session || session.expiresAt < Date.now()) { sessions.delete(key); return { authenticated: false, role: null, canMutate: false }; }
    return { authenticated: true, role: session.role, canMutate: session.role === 'admin' };
  }

  function login(request, response, body) {
    const address = request.socket.remoteAddress;
    const current = loginAttempts.get(address);
    const attempt = !current || current.until < Date.now() ? { count: 0, until: Date.now() + 60_000 } : current;
    if (attempt.count >= 10) throw new HttpError(429, 'Too many login attempts. Try again in one minute.');
    if (loginToken && (typeof body.token !== 'string' || !safeEqual(body.token, loginToken))) {
      loginAttempts.set(address, { ...attempt, count: attempt.count + 1 });
      throw new HttpError(401, 'Invalid login token');
    }
    loginAttempts.delete(address);
    for (const [key, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(key);
    const token = randomBytes(32).toString('hex');
    sessions.set(digest(token).toString('hex'), { expiresAt: Date.now() + SESSION_AGE, role: 'admin' });
    const secure = request.socket.encrypted || publicOrigin?.startsWith('https:');
    return json(response, 200, { authenticated: true, role: 'admin', canMutate: true }, { 'Set-Cookie': `frameforge_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_AGE / 1000}${secure ? '; Secure' : ''}` });
  }

  function validateAssets(sceneList) {
    const uploads = new Map(store.list('uploads').map((item) => [item.url, item]));
    for (const scene of sceneList) {
      if (scene.assetUrl) {
        const upload = uploads.get(scene.assetUrl);
        if (!upload) throw new HttpError(400, 'Scene refers to an unknown uploaded asset');
        if (scene.kind === 'video' && !upload.type.startsWith('video/')) throw new HttpError(400, 'Video scene requires video media');
        if (scene.kind === 'image' && !upload.type.startsWith('image/')) throw new HttpError(400, 'Image scene requires image media');
      }
      if (Array.isArray(scene.slots)) {
        for (const slot of scene.slots) {
          if (!slot.assetUrl) continue;
          const slotUpload = uploads.get(slot.assetUrl);
          if (!slotUpload) throw new HttpError(400, 'Slot refers to an unknown uploaded asset');
          if (slot.mediaKind === 'video' && !slotUpload.type.startsWith('video/')) throw new HttpError(400, 'Video slot requires video media');
          if (slot.mediaKind === 'image' && !slotUpload.type.startsWith('image/')) throw new HttpError(400, 'Image slot requires image media');
        }
      }
      if (scene.audioUrl) {
        const audio = uploads.get(scene.audioUrl);
        if (!audio) throw new HttpError(400, 'Scene refers to an unknown uploaded audio file');
        if (!audio.type.startsWith('audio/')) throw new HttpError(400, 'Scene audio requires an audio media upload');
      }
    }
    return sceneList;
  }
  const trendCollector = new TrendCollector({
    store,
    fetchTrends: async () => (await adapter()).fetchTrends(),
  });

  async function refreshTrends(options = {}) {
    return trendCollector.runNow({ force: options.force !== false });
  }

  function trendWindow(requestUrl, { defaultLimit = 50, maxLimit = 100 } = {}) {
    const query = requestUrl.searchParams.get('query') ?? requestUrl.searchParams.get('q') ?? '';
    if (query.length > 300) throw new HttpError(400, 'Trend query exceeds 300 characters');
    const selectedParam = requestUrl.searchParams.get('selected');
    const selected = selectedParam === null ? undefined : selectedParam === 'true' ? true : selectedParam === 'false' ? false : (() => { throw new HttpError(400, 'selected must be true or false'); })();
    const sinceParam = requestUrl.searchParams.get('since');
    const since = sinceParam ? new Date(sinceParam) : undefined;
    if (sinceParam && Number.isNaN(since.getTime())) throw new HttpError(400, 'Invalid trend since date');
    const rawLimit = requestUrl.searchParams.get('limit');
    const limit = rawLimit === null ? defaultLimit : Number(rawLimit);
    const rawOffset = requestUrl.searchParams.get('offset');
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) throw new HttpError(400, `Trend limit must be between 1 and ${maxLimit}`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new HttpError(400, 'Trend offset must be between 0 and 10000');
    return { query: query.trim(), selected, since: since ? since.toISOString() : undefined, limit, offset };
  }

  function trendQuery(requestUrl) {
    const window = trendWindow(requestUrl);
    const keywords = store.listTrendKeywords(window);
    const popular = store.listPopularTrendKeywords({ since: window.since, limit: Math.min(window.limit, 20) });
    return { keywords, trends: keywords, popular, collector: trendCollector.status(), runs: store.listTrendCollectionRuns({ limit: Math.min(window.limit, 20) }) };
  }

  function trendState() {
    return {
      trendCollector: trendCollector.status(),
      trendCollectionRuns: store.listTrendCollectionRuns({ limit: 20 }),
      trendKeywords: store.listTrendKeywords({ limit: 100 }),
      popularTrendKeywords: store.listPopularTrendKeywords({ limit: 20 }),
    };
  }

  const generationProvider = generation || createGenerationProvider();
  const generations = new GenerationQueue({ store, provider: generationProvider, ...generationOptions });
  const platformSessions = injectedPlatformSessions || new PlatformSessionManager({ store, ...(platformSessionOptions || {}) });
  const workflows = new WorkflowEngine({ store, fetchTrends: refreshTrends, runAgent: async (...args) => (await adapter()).runAgent(...args), render: (episode) => enqueueRender(episode, true), validateAssets, generations, platformSessions });
  const speechProvider = speech || createSpeechProvider();
  const narration = new NarrationQueue({ store, ...speechProvider });
  trendCollector.start();

  async function upload(request, requestUrl) {
    const name = text(requestUrl.searchParams.get('name'), 'upload name', 200);
    if (/[\\/:\x00]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new HttpError(400, 'Invalid upload name');
    const extension = extname(name).toLowerCase();
    if (!MEDIA_EXTENSIONS.includes(extension)) throw new HttpError(415, 'Unsupported media extension');
    if (Number(request.headers['content-length']) > MAX_UPLOAD) throw new HttpError(413, 'Upload exceeds 100 MiB');
    const item = entity({ name, type: MIME[extension] });
    const filename = `${item.id}${extension}`;
    const path = join(store.dataDir, 'uploads', filename);
    const file = await open(path, 'wx', 0o600);
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw new HttpError(413, 'Upload exceeds 100 MiB');
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new Error('Upload write made no progress');
          offset += bytesWritten;
        }
      }
      if (!size) throw new HttpError(400, 'Empty upload');
    } catch (error) { await file.close(); await unlink(path).catch(() => {}); throw error; }
    await file.close();
    const saved = store.save('uploads', { ...item, filename, size, url: `/api/uploads/${filename}` });
    store.record('uploads.created', { entityId: saved.id, name, size });
    return saved;
  }

  async function route(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    let requestUrl;
    try { requestUrl = new URL(request.url, 'http://localhost'); } catch { throw new HttpError(400, 'Invalid URL'); }
    let path;
    try { path = decodeURIComponent(requestUrl.pathname); } catch { throw new HttpError(400, 'Invalid URL encoding'); }
    if (!loginToken) {
      let hostname;
      try { hostname = new URL(`http://${request.headers.host}`).hostname; } catch { throw new HttpError(400, 'Invalid Host header'); }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) throw new HttpError(403, 'Unauthenticated development access requires a loopback Host');
    }
    assertSameOrigin(request, publicOrigin);
    if (request.method === 'GET' && path === '/api/health') return json(response, 200, { status: 'ok', service: 'frameforge-studio', authRequired: Boolean(loginToken), storage: 'sqlite', version: '1.0.0' });
    if (request.method === 'POST' && path === '/api/login') return login(request, response, await readJson(request));
    const session = sessionState(request);
    if (request.method === 'GET' && path === '/api/session') return json(response, 200, session);
    if (path.startsWith('/api/') && !session.authenticated) throw new HttpError(401, 'Login required');
    if (path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) requireAdmin(session);
    if (request.method === 'POST' && path === '/api/logout') {
      const token = (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('frameforge_session='))?.slice(19);
      if (token) sessions.delete(digest(token).toString('hex'));
      return json(response, 200, { authenticated: false }, { 'Set-Cookie': 'frameforge_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (request.method === 'GET' && path === '/api/trends') return json(response, 200, trendQuery(requestUrl));
    if (request.method === 'GET' && path === '/api/trends/status') return json(response, 200, trendCollector.status());
    if (request.method === 'GET' && path === '/api/trends/runs') {
      const rawLimit = requestUrl.searchParams.get('limit');
      const limit = rawLimit === null ? 20 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'Trend run limit must be between 1 and 100');
      return json(response, 200, store.listTrendCollectionRuns({ limit }));
    }
    if (request.method === 'GET' && path === '/api/trends/popular') {
      const window = trendWindow(requestUrl, { defaultLimit: 20, maxLimit: 50 });
      return json(response, 200, store.listPopularTrendKeywords({ since: window.since, limit: window.limit }));
    }
    if (request.method === 'GET' && path === '/api/state') {
      const state = Object.fromEntries(['channels', 'episodes', 'templates', 'references', 'jobs', 'events', 'workflows', 'workflowRuns', 'narrationJobs', 'generationJobs', 'platformSessions', 'platformUploads'].map((kind) => [kind, store.list(kind)]));
      state.trends = [...new Map(store.list('trends').map((trend) => [`${trend.keyword}\u0000${trend.source || ''}`, trend])).values()];
      const { nodes, edges } = store.knowledge();
      return json(response, 200, { ...state, session, ...trendState(), integrations: await integrationStatus(), graph: { nodes, edges } });
    }
    const platformScreenshot = /^\/api\/platform-sessions\/([^/]+)\/screenshot$/.exec(path);
    if (request.method === 'GET' && platformScreenshot) {
      const image = await platformSessions.screenshot(decodeURIComponent(platformScreenshot[1]));
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'Content-Length': image.length });
      return response.end(image);
    }
    if (request.method === 'GET' && path === '/api/platform-sessions') return json(response, 200, platformSessions.listSessions());
    if (request.method === 'GET' && path === '/api/server-exports') return json(response, 200, await platformSessions.listServerExports());
    if (request.method === 'GET' && path === '/api/integrations') return json(response, 200, await integrationStatus());
    if (request.method === 'GET' && path === '/api/speech/voices') return json(response, 200, await speechProvider.listVoices());
    if (request.method === 'GET' && path === '/api/generation/status') return json(response, 200, await generationProvider.capability());
    if (request.method === 'GET' && path === '/api/generation/models') return json(response, 200, await generationCall(() => requestUrl.searchParams.has('model') ? generationProvider.modelSchema(requestUrl.searchParams.get('model')) : generationProvider.models()));
    const generationGet = /^\/api\/generations\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && generationGet) return json(response, 200, generations.get(generationGet[1]));
    if (request.method === 'GET' && path === '/api/knowledge') return json(response, 200, store.knowledge());
    if (request.method === 'GET' && path === '/api/commands') return json(response, 200, store.list('commands'));
    if (request.method === 'GET' && path === '/api/workflows') return json(response, 200, store.list('workflows'));
    if (request.method === 'GET' && path === '/api/workflow-runs') {
      const readPositiveInteger = (key, fallback, maximum) => {
        const raw = requestUrl.searchParams.get(key);
        if (raw === null) return fallback;
        if (!/^[1-9]\d*$/.test(raw)) throw new HttpError(400, `Workflow run ${key} must be a positive integer`);
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value > maximum) throw new HttpError(400, `Workflow run ${key} exceeds the supported range`);
        return value;
      };
      const page = readPositiveInteger('page', 1, 1000000);
      const limit = readPositiveInteger('limit', 20, 100);
      const query = (requestUrl.searchParams.get('q') || '').trim();
      if (query.length > 200) throw new HttpError(400, 'Workflow run search query must be at most 200 characters');
      return json(response, 200, store.listWorkflowRunHistory({ page, limit, query }));
    }
    const workflowRunDetail = /^\/api\/workflow-runs\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && workflowRunDetail) return json(response, 200, store.get('workflowRuns', decodeURIComponent(workflowRunDetail[1])));
    const workflowGet = /^\/api\/workflows\/([^/]+)\/(runs|history)$/.exec(path);
    if (request.method === 'GET' && workflowGet) return json(response, 200, workflowGet[2] === 'runs' ? workflows.listRuns(workflowGet[1]) : store.workflowHistory(workflowGet[1]));
    const history = /^\/api\/episodes\/([^/]+)\/history$/.exec(path);
    if (request.method === 'GET' && history) return json(response, 200, store.history(history[1]));
    if (['GET', 'HEAD'].includes(request.method) && /^\/api\/(uploads|exports)\//.test(path)) {
      const [, directory, filename] = /^\/api\/(uploads|exports)\/(.*)$/.exec(path);
      if (!/^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(filename)) throw new HttpError(400, 'Invalid media path');
      return serveFile(request, response, join(store.dataDir, directory), filename);
    }
    if (request.method === 'POST' && path === '/api/uploads') return json(response, 201, await upload(request, requestUrl));
    if (request.method === 'POST' && path === '/api/trends/refresh') {
      return json(response, 200, await refreshTrends());
    }
    if (['POST', 'PUT'].includes(request.method) && path.startsWith('/api/')) {
      const body = await readJson(request);
      const knowledgeNode = /^\/api\/knowledge\/nodes\/([a-zA-Z0-9_-]+)$/.exec(path);
      if (request.method === 'PUT' && knowledgeNode) return json(response, 200, { record: store.editKnowledgeNode(knowledgeNode[1], body), graph: store.knowledge() });
      if (request.method === 'PUT' && path === '/api/knowledge/edges') return json(response, 200, { record: store.editKnowledgeEdge(body), graph: store.knowledge() });
      if (request.method === 'POST' && path === '/api/generation/estimate') return json(response, 200, await generationCall(() => generationProvider.estimate(body)));
      const generationStart = /^\/api\/episodes\/([^/]+)\/generations$/.exec(path);
      if (request.method === 'POST' && generationStart) return json(response, 202, await generations.start(generationStart[1], body));
      const generationApply = /^\/api\/generations\/([^/]+)\/apply$/.exec(path);
      if (request.method === 'POST' && generationApply) return json(response, 200, generations.apply(generationApply[1], body));
      const generationRecover = /^\/api\/generations\/([^/]+)\/recover$/.exec(path);
      if (request.method === 'POST' && generationRecover) return json(response, 202, generations.recover(generationRecover[1]));
      const generationNormalize = /^\/api\/generations\/([^/]+)\/normalize$/.exec(path);
      if (request.method === 'POST' && generationNormalize) return json(response, 200, await generations.normalize(generationNormalize[1]));
      const write = (kind, fields) => json(response, 201, store.create(kind, fields));
      if (['POST', 'PUT'].includes(request.method) && path === '/api/trends/settings') {
        const patch = {};
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'Trend collector enabled must be boolean');
          patch.enabled = body.enabled;
        }
        for (const key of ['intervalMs', 'retentionMs', 'maxConcurrency']) {
          if (body[key] !== undefined) {
            if (!Number.isSafeInteger(body[key]) || body[key] < 1) throw new HttpError(400, `${key} must be a positive integer`);
            patch[key] = body[key];
          }
        }
        const settings = store.saveTrendCollectorSettings(patch);
        if (settings.enabled) trendCollector.start();
        else trendCollector.stop();
        return json(response, 200, { settings, collector: trendCollector.status() });
      }
      if (request.method === 'POST' && path === '/api/trends/select') {
        const keyword = text(body.keyword, 'keyword', 300);
        if (typeof body.selected !== 'boolean') throw new HttpError(400, 'Trend selection must be boolean');
        const settings = store.setTrendKeywordSelection(keyword, body.selected);
        return json(response, 200, { keyword, selected: body.selected, settings, keywords: store.listTrendKeywords({ query: keyword, limit: 20 }) });
      }
      const restoreRoute = /^\/api\/(episodes|workflows)\/([^/]+)\/restore$/.exec(path);
      if (request.method === 'POST' && restoreRoute) {
        for (const key of ['version', 'expectedVersion']) if (!Number.isInteger(body[key]) || body[key] < 1) throw new HttpError(400, `Restore requires a positive ${key}`);
        const [, kind, id] = restoreRoute;
        const history = kind === 'episodes' ? store.history(id) : store.workflowHistory(id);
        const entry = history.find((item) => item.version === body.version);
        if (!entry) throw new HttpError(404, 'Requested history version not found');
        const reason = `restore:v${body.version}`;
        if (kind === 'episodes') {
          const patch = episodePatch({ ...entry.snapshot, status: 'draft' });
          if (patch.scenes) validateAssets(patch.scenes);
          return json(response, 200, store.updateEpisode(id, patch, body.expectedVersion, reason));
        }
        return json(response, 200, store.updateWorkflow(id, validateWorkflow(entry.snapshot), body.expectedVersion, reason));
      }
      if (request.method === 'POST' && path === '/api/workflows') return json(response, 201, workflows.create(body));
      const workflowRoute = /^\/api\/workflows\/([^/]+)(?:\/(run)|\/runs\/([^/]+)\/(cancel))?$/.exec(path);
      if (workflowRoute) {
        if (request.method === 'PUT' && !workflowRoute[2] && !workflowRoute[3]) return json(response, 200, workflows.update(workflowRoute[1], body));
        if (request.method === 'POST' && workflowRoute[2]) return json(response, 202, workflows.start(workflowRoute[1], body.episodeId, { allowGeneration: body.allowGeneration, selectedStages: body.selectedStages, startStage: body.startStage, resumeRunId: body.resumeRunId, expectedWorkflowVersion: body.expectedWorkflowVersion, expectedEpisodeVersion: body.expectedEpisodeVersion }));
        if (request.method === 'POST' && workflowRoute[4]) return json(response, 200, workflows.cancel(workflowRoute[1], workflowRoute[3]));
      }
      if (request.method === 'POST' && path === '/api/channels') {
        const email = optionalText(body.accountEmail, 'accountEmail', 254);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Invalid account email');
        return write('channels', { name: text(body.name, 'name', 160), category: text(body.category, 'category', 100), platform: text(body.platform, 'platform', 80), externalId: optionalText(body.externalId, 'externalId', 200), accountEmail: email, sample: false });
      }
      if (request.method === 'POST' && path === '/api/episodes') {
        const channel = store.get('channels', text(body.channelId, 'channelId', 80));
        const title = text(body.title, 'title', 200);
        return write('episodes', { channelId: channel.id, title, topic: text(body.topic, 'topic', 500), category: text(body.category, 'category', 100, channel.category), status: 'draft', format: '9:16', version: 1, scenes: [starterScene('오프닝', title)], notes: '' });
      }
      if (request.method === 'POST' && path === '/api/templates') return write('templates', { name: text(body.name, 'name', 160), category: text(body.category, 'category', 100), format: choice(body.format, formats, 'format'), scenes: validateAssets(scenes(body.scenes)), sample: false });
      if (request.method === 'POST' && path === '/api/references') {
        const channelId = body.channelId ? store.get('channels', text(body.channelId, 'channelId', 80)).id : undefined;
        return write('references', { ...(channelId ? { channelId } : {}), title: text(body.title, 'title', 200), url: url(body.url), category: text(body.category, 'category', 100), notes: optionalText(body.notes, 'notes', 10000) });
      }
      if (request.method === 'POST' && path === '/api/trends') return write('trends', { keyword: text(body.keyword, 'keyword', 300), source: text(body.source, 'source', 100), url: url(body.url), category: optionalText(body.category, 'category', 100), capturedAt: new Date().toISOString() });
      if (request.method === 'POST' && path === '/api/commands') return write('commands', { message: text(body.message, 'message', 20000), source: text(body.source, 'source', 100, 'studio'), sessionId: optionalText(body.sessionId, 'sessionId', 100), status: 'received' });
      if (request.method === 'POST' && path === '/api/platform-sessions') return json(response, 201, await platformSessions.openSession(body));
      const platformSessionInteract = /^\/api\/platform-sessions\/([^/]+)\/interact$/.exec(path);
      if (request.method === 'POST' && platformSessionInteract) return json(response, 200, await platformSessions.interact(decodeURIComponent(platformSessionInteract[1]), body));
      const reviewRoute = /^\/api\/workflows\/([^/]+)\/runs\/([^/]+)\/review$/.exec(path);
      if (request.method === 'POST' && reviewRoute) return json(response, 200, await workflows.review(reviewRoute[1], reviewRoute[2], body));
      const episodeRoute = /^\/api\/episodes\/([^/]+)(?:\/(template|chat|render|narration))?$/.exec(path);
      if (episodeRoute) {
        const [, id, action] = episodeRoute;
        const episode = store.get('episodes', id);
        if (request.method === 'POST' && action === 'narration') return json(response, 202, await narration.start(id, body));
        if (request.method === 'PUT' && !action) {
          const patch = episodePatch(body);
          if (patch.scenes) validateAssets(patch.scenes);
          return json(response, 200, store.updateEpisode(id, patch, body.expectedVersion));
        }
        if (request.method === 'POST' && action === 'template') {
          const template = store.get('templates', text(body.templateId, 'templateId', 80));
          return json(response, 200, store.updateEpisode(id, { format: template.format, scenes: template.scenes.map((scene) => ({ ...scene, id: entity({}).id })) }, episode.version, `template:${template.id}`));
        }
        if (request.method === 'POST' && action === 'chat') {
          const agent = choice(body.agent, ['studio', 'codex', 'jeo', 'jeopi', 'hermes'], 'agent');
          const message = text(body.message, 'message', 12000);
          store.record('chat.requested', { entityId: id, agent, message });
          let result;
          if (agent === 'studio') {
            result = { message: 'Studio는 규칙 기반 스토리보드 도우미입니다. 요청을 훅·전개·마무리 3개 장면으로 구성했습니다. 사실과 출처는 직접 검토하세요.', scenes: [starterScene('훅 · 시선을 잡는 질문', episode.title), starterScene('전개 · 핵심 내용', message.slice(0, 2000), '#173940'), starterScene('마무리 · 검토와 다음 행동', `${episode.topic}\n출처 확인 · 내용 검토 후 게시`, '#382d46')] };
          } else {
            try { result = await (await adapter()).runAgent(agent, message, episode); }
            catch (error) { store.record('chat.failed', { entityId: id, agent }); throw new HttpError(503, `${agent} unavailable: ${error.code === 'UNAVAILABLE' ? 'host bridge is not configured' : 'host bridge could not complete the request'}`); }
          }
          const reply = text(result.message, 'agent response', 20000);
          const updated = result.scenes ? store.updateEpisode(id, { scenes: validateAssets(scenes(result.scenes)) }, episode.version, `agent:${agent}`) : undefined;
          store.record('chat.completed', { entityId: id, agent, message: reply });
          return json(response, 200, { message: reply, ...(updated ? { episode: updated } : {}) });
        }
        if (request.method === 'POST' && action === 'render') {
          return json(response, 202, enqueueRender(episode));
        }
      }
      if (path.startsWith('/api/knowledge/')) throw new HttpError(400, 'Unsupported graph edit');
      throw new HttpError(404, 'API route not found');
    }
    if (path.startsWith('/api/knowledge/') && !['GET', 'HEAD'].includes(request.method)) throw new HttpError(400, 'Unsupported graph edit');
    if (path.startsWith('/api/')) throw new HttpError(404, 'API route not found');
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed');
    return serveFile(request, response, PUBLIC_DIR, path === '/' ? 'index.html' : path.slice(1));
  }

  const server = http.createServer((request, response) => {
    route(request, response).catch((error) => {
      if (response.headersSent) return response.destroy();
      if (!(error instanceof HttpError)) console.error('Request failed:', error.message);
      json(response, error instanceof HttpError ? error.status : 500, { error: safeError(error) });
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.on('close', () => { closing = true; trendCollector.close(); narration.close(); generations.close(); workflows.close(); platformSessions.close(); store.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const host = process.env.HOST || '127.0.0.1';
  if (!process.env.LOGIN_TOKEN && !['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('LOGIN_TOKEN is required for non-loopback binding');
  const port = Number(process.env.PORT || 4310);
  const app = createApp();
  app.listen(port, host, () => console.log(`FrameForge Studio listening on http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close(() => process.exit(0)));
}
