import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HttpError, choice, object, optionalText, text, url as validateUrl } from './validation.mjs';

const PLATFORM_URLS = {
  youtube: 'https://studio.youtube.com/channel/upload',
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
  instagram: 'https://www.instagram.com/create/select/',
  other: 'https://studio.youtube.com',
};

const VISIBILITIES = ['private', 'unlisted', 'public'];
const ACTIONS = ['navigate', 'input', 'click', 'key', 'scroll', 'attach-export', 'update-metadata', 'upload', 'refresh', 'close'];
const stamp = () => new Date().toISOString();
const NAVIGATION_TIMEOUT = 30_000;
const ACTION_TIMEOUT = 15_000;
const MAX_SELECTOR = 500;
const MAX_INPUT = 20_000;
const PROFILE_ROOT = 'platform-profiles';

function isYouTubeUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'youtube.com' || hostname.endsWith('.youtube.com') || hostname === 'youtu.be' || hostname.endsWith('.youtu.be');
  } catch { return false; }
}

function isYouTubeSession(session) {
  return String(session.platform).toLowerCase() === 'youtube' || isYouTubeUrl(session.url);
}

function automatedYouTubeDisabled() {
  return httpError(409, 'YouTube browser automation is disabled. Use channel-bound OAuth publication or open YouTube Studio manually.');
}

function httpError(status, message) {
  const error = new HttpError(status, message);
  error.statusCode = status;
  return error;
}
function browserUnavailable(error) {
  if (error instanceof HttpError) {
    if (error.statusCode === undefined) error.statusCode = error.status;
    return error;
  }
  const unavailable = httpError(503, 'Chromium browser unavailable. Install Playwright/Chromium or configure PLATFORM_PLAYWRIGHT_MODULE.');
  unavailable.statusCode = 503;
  return unavailable;
}

function selector(value) {
  const selected = text(value, 'selector', MAX_SELECTOR).trim();
  if (!selected || /^(?:javascript|data|file):/i.test(selected)) throw httpError(400, 'A safe CSS/Playwright selector is required');
  return selected;
}

function boundedInteger(value, name, fallback, min, max) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) throw httpError(400, `${name} must be an integer between ${min} and ${max}`);
  return selected;
}

function normalizeModule(module) {
  const candidate = module?.default?.chromium ? module.default : module;
  if (!candidate?.chromium?.launchPersistentContext) throw httpError(503, 'Chromium browser unavailable. Playwright Chromium support is not installed.');
  return candidate;
}

export class PlatformSessionManager {
  constructor({ store, browserModule, browserOptions = {} } = {}) {
    if (!store) throw new Error('PlatformSessionManager requires a store');
    this.store = store;
    this.browserModule = browserModule;
    this.browserOptions = { ...browserOptions };
    this.closed = false;
    this.livePages = new Map();
    this.locks = new Map();
    this.activeEpisodes = new Map();
  }

  async loadBrowserModule() {
    if (this.browserModule) return normalizeModule(this.browserModule);
    const configured = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
    try {
      if (configured) {
        const specifier = configured.startsWith('file:') ? configured : pathToFileURL(path.resolve(configured)).href;
        this.browserModule = normalizeModule(await import(specifier));
        return this.browserModule;
      }
      try {
        this.browserModule = normalizeModule(await import('playwright'));
      } catch {
        this.browserModule = normalizeModule(await import('playwright-core'));
      }
      return this.browserModule;
    } catch (error) {
      throw browserUnavailable(error);
    }
  }

  profileDir(sessionId) {
    return path.join(this.store.dataDir, PROFILE_ROOT, sessionId);
  }

  browserSummary(page, headless) {
    return {
      available: true,
      headless,
      viewport: { width: Number(page.viewportSize?.()?.width || 1280), height: Number(page.viewportSize?.()?.height || 800) },
    };
  }

  async launchRuntime(session) {
    if (isYouTubeSession(session)) throw automatedYouTubeDisabled();
    let module;
    try { module = await this.loadBrowserModule(); } catch (error) { throw browserUnavailable(error); }
    const profileRoot = path.join(this.store.dataDir, PROFILE_ROOT);
    const profileDir = this.profileDir(session.id);
    await mkdir(profileRoot, { recursive: true, mode: 0o700 });
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const requestedHeadless = this.browserOptions.headless ?? process.env.PLATFORM_HEADLESS !== 'false';
    const requestedViewport = this.browserOptions.viewport || { width: 1280, height: 800 };
    const { userDataDir: _ignoredUserDataDir, headless: _ignoredHeadless, viewport: _ignoredViewport, ...options } = this.browserOptions;
    const launchOptions = {
      ...options,
      headless: Boolean(requestedHeadless),
      viewport: { width: Number(requestedViewport.width) || 1280, height: Number(requestedViewport.height) || 800 },
      timeout: Number(options.timeout) || NAVIGATION_TIMEOUT,
    };
    const executablePath = launchOptions.executablePath || process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    if (executablePath) launchOptions.executablePath = executablePath;
    if (session.episodeId) this.store.assertEpisodeActive(session.episodeId);
    let context;
    try {
      context = await module.chromium.launchPersistentContext(profileDir, launchOptions);
      // Other platform sessions cannot bypass the cutover by redirecting to YouTube.
      await context.route?.('**/*', (route) => isYouTubeUrl(route.request().url()) ? route.abort('blockedbyclient') : route.continue());
      context.setDefaultTimeout?.(ACTION_TIMEOUT);
      const page = context.pages()[0] || await context.newPage();
      page.setDefaultTimeout?.(ACTION_TIMEOUT);
      const runtime = { context, page, profileDir, headless: Boolean(requestedHeadless) };
      this.livePages.set(session.id, runtime);
      return runtime;
    } catch (error) {
      throw browserUnavailable(error);
    }
  }

  async ensureRuntime(session) {
    if (isYouTubeSession(session)) throw automatedYouTubeDisabled();
    if (this.closed) throw httpError(503, 'Platform session manager is stopping');
    if (session.status === 'closed') throw httpError(409, 'Platform browser session is closed');
    let runtime = this.livePages.get(session.id);
    if (!runtime) runtime = await this.launchRuntime(session);
    if (runtime.context?.pages) {
      const pages = runtime.context.pages();
      if (!pages.includes(runtime.page)) runtime.page = pages[0] || await runtime.context.newPage();
    }
    runtime.page.setDefaultTimeout?.(ACTION_TIMEOUT);
    return runtime;
  }

  async listServerExports() {
    const exportRoot = await realpath(path.join(this.store.dataDir, 'exports'));
    const files = await readdir(exportRoot).catch(() => []);
    const jobs = this.store.list('jobs').filter((job) => job.status === 'completed' && typeof job.outputUrl === 'string');
    const episodes = new Map(this.store.list('episodes').map((ep) => [ep.id, ep]));
    const byFilename = new Map();
    for (const job of jobs) {
      const name = job.outputUrl.split('/').pop();
      if (name && !byFilename.has(name)) byFilename.set(name, job);
    }
    const exportsList = [];
    for (const filename of files.filter((f) => /^[a-zA-Z0-9_-]+\.mp4$/i.test(f))) {
      try {
        const target = path.join(exportRoot, filename);
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const job = byFilename.get(filename);
        if (!job) continue;
        const episode = episodes.get(job.episodeId);
        exportsList.push({
          filename,
          exportUrl: `/api/exports/${filename}`,
          size: info.size,
          updatedAt: info.mtime.toISOString(),
          jobId: job.id,
          episodeId: job.episodeId || null,
          episodeTitle: episode?.title || filename,
          episodeVersion: job.episodeVersion || null,
          sha256: job.sha256 || null,
        });
      } catch {
        // Ignore inaccessible or transient files.
      }
    }
    return exportsList.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async verifyServerExport(exportUrl, { episodeId, episodeVersion, jobId } = {}) {
    const cleanUrl = text(exportUrl, 'exportUrl', 200);
    const match = /^\/api\/exports\/([a-zA-Z0-9_-]+\.mp4)$/.exec(cleanUrl);
    if (!match) throw httpError(400, 'Export file must be a valid /api/exports/*.mp4 path');
    const filename = match[1];
    const jobs = this.store.list('jobs').filter((job) => job.status === 'completed' && job.outputUrl === cleanUrl).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    const job = jobs[0];
    if (!job) throw httpError(409, 'Export is not linked to a completed render job');
    if (jobId && job.id !== jobId) throw httpError(409, 'Export does not match the render job');
    if (episodeId && job.episodeId !== episodeId) throw httpError(409, 'Export does not match the episode');
    if (episodeVersion !== undefined && job.episodeVersion !== episodeVersion) throw httpError(409, 'Export does not match the episode version');
    const episode = this.store.assertEpisodeActive(job.episodeId);
    if (job.episodeVersion !== undefined && episode.version !== job.episodeVersion) throw httpError(409, 'Render candidate is stale; render the current episode version before attaching it');
    const exportRoot = await realpath(path.join(this.store.dataDir, 'exports'));
    const requested = path.join(exportRoot, filename);
    let file;
    try {
      const metadata = await lstat(requested);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw httpError(404, 'Server export artifact is not a regular file');
      const resolved = await realpath(requested);
      if (path.dirname(resolved) !== exportRoot) throw httpError(403, 'Server export artifact is outside the export directory');
      file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await file.stat();
      if (!stat.isFile() || !stat.size) throw httpError(409, 'Server export artifact is empty');
      const digest = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
      const sha256 = digest.digest('hex');
      if (job.sha256 && job.sha256 !== sha256) throw httpError(409, 'Render artifact hash changed since the job completed');
      this.store.assertEpisodeActive(job.episodeId);
      return { filename, exportUrl: cleanUrl, serverPath: resolved, size: stat.size, sha256, jobId: job.id, episodeId: job.episodeId || null, episodeVersion: job.episodeVersion ?? null };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw httpError(404, 'Server export file not found in server storage');
    } finally {
      await file?.close();
    }
  }

  listSessions() {
    return this.store.list('platformSessions');
  }

  getSession(id) {
    return this.store.get('platformSessions', id);
  }

  findReview(job) {
    if (!job) return { required: false, approved: null, decision: null };
    const approved = this.store.list('workflowRuns').find((run) => run.review?.decision === 'approved' && run.review?.jobId === job.id && run.review?.episodeVersion === job.episodeVersion && (!job.sha256 || !run.review.sha256 || run.review.sha256 === job.sha256));
    return { required: true, approved: Boolean(approved), decision: approved ? 'approved' : null, runId: approved?.id || null };
  }

  async withEpisodeWork(episodeId, operation) {
    if (!episodeId) return operation();
    this.store.assertEpisodeActive(episodeId);
    this.activeEpisodes.set(episodeId, (this.activeEpisodes.get(episodeId) || 0) + 1);
    try { return await operation(); }
    finally {
      const remaining = this.activeEpisodes.get(episodeId) - 1;
      if (remaining) this.activeEpisodes.set(episodeId, remaining);
      else this.activeEpisodes.delete(episodeId);
    }
  }

  async openSession(raw = {}) {
    const body = object(raw);
    let episodeId = optionalText(body.episodeId, 'episodeId', 80);
    if (!episodeId && body.exportUrl) episodeId = (await this.verifyServerExport(body.exportUrl)).episodeId;
    return this.withEpisodeWork(episodeId, () => this._openSession({ ...body, ...(episodeId ? { episodeId } : {}) }));
  }

  async withSessionEpisodeWork(sessionId, raw, operation) {
    const session = this.getSession(sessionId), body = object(raw);
    const action = choice(body.action, ACTIONS, 'session action', 'refresh');
    if (action === 'close') return operation();
    if (isYouTubeSession(session) && action !== 'update-metadata') throw automatedYouTubeDisabled();
    let episodeId = session.episodeId || session.attachedExport?.episodeId;
    let attachment;
    if (action === 'attach-export') {
      const requested = body.exportUrl || session.attachedExport?.exportUrl;
      if (!requested) throw httpError(400, 'Choose a verified server export before attaching it');
      attachment = await this.verifyServerExport(requested, { episodeId: episodeId || undefined, episodeVersion: session.attachedExport?.episodeVersion, jobId: session.attachedExport?.jobId });
      episodeId = attachment.episodeId;
    }
    if (episodeId && session.channelId && this.store.assertEpisodeActive(episodeId).channelId !== session.channelId) throw httpError(409, 'Platform session channel does not own this episode');
    return this.withEpisodeWork(episodeId, () => operation(episodeId, attachment));
  }

  async _openSession(raw = {}) {
    if (this.closed) throw httpError(503, 'Platform session manager is stopping');
    const body = object(raw);
    const channelId = optionalText(body.channelId, 'channelId', 80);
    const episodeId = optionalText(body.episodeId, 'episodeId', 80);
    const episode = episodeId ? this.store.assertEpisodeActive(episodeId) : null;
    const channel = channelId ? this.store.get('channels', channelId) : episode?.channelId ? this.store.get('channels', episode.channelId) : null;
    if (episode && channel && episode.channelId !== channel.id) throw httpError(409, 'Platform session channel does not own this episode');
    const platform = choice(String(body.platform || channel?.platform || 'youtube').toLowerCase(), ['youtube', 'tiktok', 'instagram', 'other'], 'platform', 'youtube');
    const targetUrl = platform === 'youtube' ? PLATFORM_URLS.youtube : body.url ? validateUrl(body.url) : PLATFORM_URLS[platform] || PLATFORM_URLS.youtube;
    if (platform !== 'youtube' && isYouTubeUrl(targetUrl)) throw automatedYouTubeDisabled();
    const visibility = choice(body.visibility, VISIBILITIES, 'visibility', 'private');
    const sessionId = randomUUID();
    let stagedExport = null;
    if (body.exportUrl) {
      const verified = await this.verifyServerExport(body.exportUrl, { episodeId: episode?.id });
      stagedExport = { filename: verified.filename, exportUrl: verified.exportUrl, size: verified.size, sha256: verified.sha256, jobId: verified.jobId, episodeId: verified.episodeId, episodeVersion: verified.episodeVersion, attachedAt: stamp() };
    } else if (episode) {
      const latestJob = this.store.list('jobs').filter((job) => job.episodeId === episode.id && job.status === 'completed' && job.outputUrl).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0];
      if (latestJob) {
        try {
          const verified = await this.verifyServerExport(latestJob.outputUrl, { episodeId: episode.id });
          stagedExport = { filename: verified.filename, exportUrl: verified.exportUrl, size: verified.size, sha256: verified.sha256, jobId: verified.jobId, episodeId: verified.episodeId, episodeVersion: verified.episodeVersion, attachedAt: stamp() };
        } catch {
          stagedExport = null;
        }
      }
    }
    const now = stamp();
    const session = {
      id: sessionId,
      channelId: channel?.id || null,
      channelName: channel?.name || '기본 채널',
      channelExternalId: channel?.externalId || '',
      accountEmail: channel?.accountEmail || '',
      episodeId: episode?.id || null,
      platform,
      url: targetUrl,
      status: 'active',
      mode: 'persistent-chromium',
      browser: { available: false, headless: true, viewport: { width: 1280, height: 800 } },
      screenshotUrl: `/api/platform-sessions/${sessionId}/screenshot`,
      attachmentStatus: stagedExport ? 'staged' : 'none',
      uploadStatus: stagedExport ? 'staged' : 'idle',
      uploadProgress: 0,
      attachedExport: stagedExport,
      publicationStatus: 'not_attempted',
      review: this.findReview(stagedExport),
      metadata: {
        title: optionalText(body.title, 'title', 200) || episode?.title || `${channel?.name || '채널'} 신규 업로드`,
        description: optionalText(body.description, 'description', 5000) || episode?.topic || '',
        visibility,
      },
      logs: [`[${now}] ${platform.toUpperCase()} persistent Chromium session starting (${targetUrl})`, ...(stagedExport ? [`[${now}] Verified render artifact staged: ${stagedExport.filename} (${stagedExport.sha256.slice(0, 12)}…)`] : [])],
      createdAt: now,
      updatedAt: now,
    };
    if (platform === 'youtube') {
      session.mode = 'manual-external';
      session.manualUrl = PLATFORM_URLS.youtube;
      session.logs = [`[${now}] Manual YouTube Studio link ready; automated controls are disabled`];
      this.store.save('platformSessions', session);
      this.store.record('platform.session.opened', { entityId: session.id, channelId: session.channelId, platform, url: session.url });
      return session;
    }
    let runtime;
    try { runtime = await this.launchRuntime(session); } catch (error) { throw browserUnavailable(error); }
    try {
      if (session.episodeId) this.store.assertEpisodeActive(session.episodeId);
      await runtime.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
      session.url = runtime.page.url() || targetUrl;
      session.logs.push(`[${stamp()}] Browser page ready`);
    } catch (error) {
      if (error instanceof HttpError) { await this.closeRuntime(session.id); throw error; }
      session.url = runtime.page.url() || targetUrl;
      session.logs.push(`[${stamp()}] Browser navigation unavailable; user can retry from the session controls`);
    }
    session.browser = this.browserSummary(runtime.page, runtime.headless);
    this.store.save('platformSessions', session);
    this.store.record('platform.session.opened', { entityId: session.id, channelId: session.channelId, platform, url: session.url });
    return session;
  }

  async withLock(sessionId, operation) {
    const prior = this.locks.get(sessionId) || Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    this.locks.set(sessionId, current);
    try { return await current; } finally { if (this.locks.get(sessionId) === current) this.locks.delete(sessionId); }
  }

  async closeRuntime(sessionId) {
    const runtime = this.livePages.get(sessionId);
    if (!runtime) return;
    this.livePages.delete(sessionId);
    await runtime.context.close().catch(() => {});
  }

  async interact(sessionId, raw = {}) {
    const id = text(sessionId, 'sessionId', 80);
    return this.withLock(id, () => this.withSessionEpisodeWork(id, raw, async (episodeId, attachment) => {
      if (this.closed) throw httpError(503, 'Platform session manager is stopping');
      const session = this.getSession(id);
      const body = object(raw);
      const action = choice(body.action, ACTIONS, 'session action', 'refresh');
      const now = stamp();
      const next = structuredClone(session);
      if (episodeId) next.episodeId = episodeId;
      next.updatedAt = now;
      next.logs = Array.isArray(next.logs) ? [...next.logs] : [];
      if (action === 'close') {
        await this.closeRuntime(id);
        next.status = 'closed';
        next.browser = { ...next.browser, available: false };
        next.closedAt = now;
        next.logs.push(`[${now}] Persistent Chromium session closed`);
        next.logs = next.logs.slice(-20);
        this.store.save('platformSessions', next);
        return next;
      }
      if (session.status === 'closed') throw httpError(409, 'Platform browser session is closed');
      if (session.episodeId) this.store.assertEpisodeActive(session.episodeId);
      if (action === 'navigate' && isYouTubeUrl(body.url)) throw automatedYouTubeDisabled();
      if (action === 'update-metadata') {
        next.metadata = {
          title: body.title !== undefined ? text(body.title, 'title', 200) : next.metadata?.title || '제목 없음',
          description: body.description !== undefined ? optionalText(body.description, 'description', 5000) : next.metadata?.description || '',
          visibility: body.visibility !== undefined ? choice(body.visibility, VISIBILITIES, 'visibility') : next.metadata?.visibility || 'private',
        };
        if (body.channelId) {
          const channel = this.store.get('channels', text(body.channelId, 'channelId', 80));
          const platform = String(channel.platform || next.platform || 'youtube').toLowerCase();
          if ((platform === 'youtube') !== isYouTubeSession(session)) throw httpError(409, 'Open a new session to change platforms');
          next.channelId = channel.id;
          next.channelName = channel.name;
          next.channelExternalId = channel.externalId || '';
          next.accountEmail = channel.accountEmail || '';
          next.platform = platform;
        }
        next.logs.push(`[${now}] Updated metadata fields`);
        next.logs = next.logs.slice(-20);
        this.store.save('platformSessions', next);
        return next;
      }
      const runtime = await this.ensureRuntime(session);
      if (session.episodeId) this.store.assertEpisodeActive(session.episodeId);
      const page = runtime.page;
      if (isYouTubeUrl(page.url())) throw automatedYouTubeDisabled();
      try {
        if (action === 'navigate') {
          const target = validateUrl(body.url);
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
          next.logs.push(`[${now}] Navigated browser page`);
        } else if (action === 'input') {
          const target = selector(body.selector);
          const value = text(body.value, 'value', MAX_INPUT);
          await page.locator(target).first().fill(value);
          next.logs.push(`[${now}] Filled platform form field`);
        } else if (action === 'click') {
          const target = selector(body.selector);
          await page.locator(target).first().click();
          next.logs.push(`[${now}] Clicked platform control`);
        } else if (action === 'key') {
          const key = text(body.key, 'key', 80);
          if (!/^[\w+\- ]+$/.test(key)) throw httpError(400, 'Invalid keyboard key');
          await page.keyboard.press(key);
          next.logs.push(`[${now}] Sent keyboard input`);
        } else if (action === 'scroll') {
          const x = boundedInteger(body.x, 'scroll x', 0, -5000, 5000);
          const y = boundedInteger(body.y, 'scroll y', 0, -5000, 5000);
          await page.mouse.wheel(x, y);
          next.logs.push(`[${now}] Scrolled platform page`);
        } else if (action === 'attach-export') {
          const verified = attachment;
          const target = body.selector === undefined ? 'input[type="file"]' : selector(body.selector);
          const input = page.locator(target).first();
          if (await input.count() < 1) throw httpError(409, 'Platform file input is unavailable; open the platform upload form first');
          if (next.episodeId) this.store.assertEpisodeActive(next.episodeId);
          await input.setInputFiles(verified.serverPath);
          const unchanged = await this.verifyServerExport(verified.exportUrl, { episodeId: next.episodeId || undefined, episodeVersion: verified.episodeVersion, jobId: verified.jobId });
          next.attachedExport = { filename: unchanged.filename, exportUrl: unchanged.exportUrl, size: unchanged.size, sha256: unchanged.sha256, jobId: unchanged.jobId, episodeId: unchanged.episodeId, episodeVersion: unchanged.episodeVersion, attachedAt: now };
          next.attachmentStatus = 'attached';
          next.uploadStatus = 'attached';
          next.uploadProgress = 0;
          next.review = this.findReview(unchanged);
          next.logs.push(`[${now}] Verified server export attached to the platform file input: ${unchanged.filename}`);
        } else if (action === 'upload') {
          throw httpError(409, 'File attachment is separate from publication; use an explicit platform click action after human review');
        } else if (action === 'refresh') {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
          next.logs.push(`[${now}] Refreshed browser page`);
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        next.logs.push(`[${now}] Browser action failed; retry or continue manually`);
        next.logs = next.logs.slice(-20);
        this.store.save('platformSessions', next);
        throw httpError(409, 'Browser action could not be completed');
      }
      next.url = page.url() || next.url;
      next.browser = this.browserSummary(page, runtime.headless);
      next.screenshotUrl = `/api/platform-sessions/${id}/screenshot`;
      next.logs = next.logs.slice(-20);
      this.store.save('platformSessions', next);
      return next;
    }));
  }

  async screenshot(sessionId) {
    const id = text(sessionId, 'sessionId', 80);
    return this.withLock(id, async () => {
      const session = this.getSession(id);
      if (isYouTubeSession(session)) throw automatedYouTubeDisabled();
      if (this.closed) throw httpError(503, 'Platform session manager is stopping');
      if (session.status === 'closed') throw httpError(409, 'Platform browser session is closed');
      const existing = this.livePages.get(id);
      const pages = existing?.context?.pages?.();
      const needsRuntime = !existing || (pages && !pages.includes(existing.page) && !pages.length);
      const capture = async (page) => {
        try { return await page.screenshot({ type: 'png' }); }
        catch { throw httpError(409, 'Browser screenshot is unavailable'); }
      };
      if (!needsRuntime) return capture(pages && !pages.includes(existing.page) ? pages[0] : existing.page);
      return this.withEpisodeWork(session.episodeId || session.attachedExport?.episodeId, async () => capture((await this.ensureRuntime(session)).page));
    });
  }

  async close() {
    this.closed = true;
    const runtimes = [...this.livePages.values()];
    this.livePages.clear();
    await Promise.all(runtimes.map((runtime) => runtime.context.close().catch(() => {})));
  }
}
