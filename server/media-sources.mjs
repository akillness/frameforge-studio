import { randomUUID, createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { HttpError, object, text, choice, sceneSource, url as httpUrl } from './validation.mjs';
import { probeGenerationAsset } from './generations.mjs';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
// Only the documented original formats with established local decoding support.
const ORIGINALS = {
  'image/jpeg': { extension: '.jpg', kind: 'image', mediaType: 'BITMAP' },
  'image/png': { extension: '.png', kind: 'image', mediaType: 'BITMAP' },
  'video/webm': { extension: '.webm', kind: 'video', mediaType: 'VIDEO' },
};
const now = () => new Date().toISOString();
const mimeType = (value) => String(value || '').split(';')[0].trim().toLowerCase();

function retryAfter(response) {
  const value = response.headers.get('retry-after');
  if (!value?.trim()) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value);
  const deadline = Date.parse(value);
  return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : undefined;
}

function providerFailure(response) {
  if (![403, 429].includes(response.status)) return null;
  const retry = retryAfter(response);
  return {
    status: response.status === 403 ? 'provider_blocked' : 'provider_rate_limited',
    items: [],
    ...(retry !== undefined ? { retryAfter: retry } : {}),
  };
}

function throwProviderFailure(response) {
  const failure = providerFailure(response);
  const error = new HttpError(response.status >= 400 ? response.status : 502, failure?.status || 'Commons provider request failed');
  if (failure) {
    error.providerStatus = failure.status;
    if (failure.retryAfter !== undefined) error.retryAfter = failure.retryAfter;
  }
  throw error;
}

async function readBounded(response, maximum, consume) {
  if (!response.body) throw new HttpError(422, 'Provider returned no content');
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new HttpError(413, 'Source content exceeds the byte limit');
      await consume(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  if (!size) throw new HttpError(422, 'Provider returned empty content');
  return size;
}

function originalUrl(value) {
  let parsed, decoded;
  try { parsed = new URL(value); decoded = decodeURIComponent(parsed.pathname); }
  catch { throw new HttpError(422, 'Commons original URL is invalid'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'upload.wikimedia.org' || parsed.port || parsed.username || parsed.password || parsed.hash ||
      !/^\/wikipedia\/commons\/[a-f0-9]\/[a-f0-9]{2}\/[^/]+$/.test(decoded) || /[\\\u0000-\u001f]/.test(decoded)) {
    throw new HttpError(422, 'Only trusted Commons original files are supported; thumbnails and previews are not originals');
  }
  return parsed.href;
}

function supportReason(item, kind) {
  if (item.mime === 'video/mp4') return 'MP4 is locally supported, but Commons MP4 original availability is unverified';
  if (item.mime === 'video/ogg' || /\.ogv(?:\?|$)/i.test(item.url)) return 'Commons Ogg Theora originals are outside the supported local video decoder formats';
  const format = ORIGINALS[item.mime];
  if (!format) return 'Original format is outside the verified Commons and local decoder intersection';
  if (format.kind !== kind || item.mediaType !== format.mediaType) return 'Commons media type does not match the requested source kind';
  return null;
}

function commonsItem(page) {
  const info = page?.imageinfo?.[0];
  if (!Number.isSafeInteger(page?.pageid) || page.pageid < 1 || page.ns !== 6 || typeof page.title !== 'string' || !page.title.startsWith('File:') ||
      page.missing !== undefined || !Array.isArray(page.imageinfo) || page.imageinfo.length !== 1 || !info || typeof info.url !== 'string' || typeof info.mime !== 'string' || typeof info.mediatype !== 'string' ||
      !Number.isSafeInteger(info.size) || info.size <= 0 || !/^[a-f0-9]{40}$/i.test(info.sha1 || '') ||
      typeof info.timestamp !== 'string' || !Number.isFinite(Date.parse(info.timestamp)) || !info.extmetadata || typeof info.extmetadata !== 'object' || Array.isArray(info.extmetadata)) {
    throw new HttpError(502, 'Commons returned incomplete original-file metadata');
  }
  let sourceUrl;
  try { sourceUrl = httpUrl(info.descriptionurl); }
  catch { throw new HttpError(502, 'Commons returned an invalid description page'); }
  const description = new URL(sourceUrl);
  if (description.protocol !== 'https:' || description.hostname !== 'commons.wikimedia.org' || description.port) throw new HttpError(502, 'Commons returned an invalid description page');
  return {
    pageId: page.pageid, title: page.title, url: info.url, sourceUrl,
    mime: mimeType(info.mime), mediaType: info.mediatype, size: info.size,
    width: info.width, height: info.height, sha1: info.sha1, timestamp: info.timestamp,
    // Evidence only: never infer clearance or coerce booleanish metadata strings.
    extmetadata: structuredClone(info.extmetadata),
    ...(Number.isFinite(page.index) ? { index: page.index } : {}),
  };
}

function requireVersion(value) {
  if (!Number.isInteger(value) || value < 1) throw new HttpError(400, 'A positive expectedVersion is required');
}

function validateTrim(body, upload) {
  const start = body.trimStart === undefined ? 0 : body.trimStart;
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || start > 36000) throw new HttpError(400, 'Invalid trimStart');
  const end = body.trimEnd;
  if (end !== undefined && (typeof end !== 'number' || !Number.isFinite(end) || end <= start || end > 36000)) throw new HttpError(400, 'Invalid trimEnd');
  if (upload.type.startsWith('video/') && Number.isFinite(upload.duration) && (start >= upload.duration || (end !== undefined && end > upload.duration))) throw new HttpError(400, 'Trim range exceeds the verified video duration');
  return { trimStart: start, ...(end !== undefined ? { trimEnd: end } : {}) };
}

// Hash the opened, contained file rather than trusting registry metadata. A cache
// belongs to one validation call only; later renders must inspect the bytes again.
function verifiedUploadHash(store, upload, cache = new Map(), { allowMissingHash = false } = {}) {
  if (typeof upload.filename !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(upload.filename) ||
      upload.url !== `/api/uploads/${upload.filename}`) throw new HttpError(409, 'Source requires a contained registered upload');
  let verified = cache.get(upload.filename);
  if (!verified) {
    let fd;
    try {
      const root = path.resolve(store.dataDir, 'uploads');
      if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw new HttpError(409, 'Source upload directory must not be redirected');
      const file = path.join(root, upload.filename);
      const before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || realpathSync(file) !== file) throw new HttpError(409, 'Source media must be a regular contained file');
      if (before.size > MAX_MEDIA_BYTES) throw new HttpError(413, 'Source content exceeds the byte limit');
      if (!before.size) throw new HttpError(409, 'Source media is empty');
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const sameFile = (info) => info.isFile() && info.dev === before.dev && info.ino === before.ino && info.size === before.size && info.mtimeMs === before.mtimeMs && info.ctimeMs === before.ctimeMs;
      if (!sameFile(fstatSync(fd))) throw new HttpError(409, 'Source media changed during verification');
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
      let bytes = 0, count;
      while ((count = readSync(fd, buffer, 0, buffer.length, null))) {
        bytes += count;
        if (bytes > MAX_MEDIA_BYTES) throw new HttpError(413, 'Source content exceeds the byte limit');
        hash.update(buffer.subarray(0, count));
      }
      const after = lstatSync(file);
      if (bytes !== before.size || !sameFile(after) || after.isSymbolicLink() || !sameFile(fstatSync(fd)) ||
          realpathSync(file) !== file || realpathSync(root) !== root ||
          (upload.size !== undefined && upload.size !== bytes)) throw new HttpError(409, 'Source media changed or differs from its registered size');
      verified = { sha256: hash.digest('hex'), size: bytes };
      cache.set(upload.filename, verified);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, 'Source media file is missing or unsafe');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  const { sha256, size } = verified;
  if (upload.size !== undefined && upload.size !== size) throw new HttpError(409, 'Source media differs from its registered size');
  if ((!allowMissingHash || upload.sha256 !== undefined) &&
      (!/^[a-f0-9]{64}$/.test(upload.sha256 || '') || upload.sha256 !== sha256)) throw new HttpError(409, 'Source media bytes do not match the registered upload hash');
  return sha256;
}

/** Source discovery/import is optional; local rights enforcement is always active. */
export class SourceMediaService {
  constructor({ store, fetchImpl = globalThis.fetch, userAgent, probe = probeGenerationAsset }) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.userAgent = typeof userAgent === 'string' ? userAgent.trim() : '';
    this.probe = probe;
  }

  requireProvider() {
    if (!this.userAgent) throw new HttpError(503, 'MEDIA_USER_AGENT must identify the application and operator contact before Commons requests');
    if (/[\r\n]/.test(this.userAgent)) throw new HttpError(503, 'MEDIA_USER_AGENT contains invalid header characters');
  }

  async request(url) {
    this.requireProvider();
    try {
      return await this.fetchImpl(url, { headers: { 'User-Agent': this.userAgent }, redirect: 'error', signal: AbortSignal.timeout(60000) });
    } catch { throw new HttpError(502, 'Commons request failed; redirects are not permitted'); }
  }

  async metadata(parameters, { search = false } = {}) {
    const target = new URL(COMMONS_API);
    target.search = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', prop: 'imageinfo',
      iiprop: 'url|mime|mediatype|size|sha1|timestamp|extmetadata', iilimit: '1', iiextmetadatalanguage: 'en',
      ...parameters,
    });
    const response = await this.request(target.href);
    const failure = providerFailure(response);
    if (search && failure) return failure;
    if (!response.ok || response.redirected) throwProviderFailure(response);
    if (mimeType(response.headers.get('content-type')) !== 'application/json') throw new HttpError(502, 'Commons metadata was not JSON');
    const chunks = [];
    await readBounded(response, MAX_METADATA_BYTES, (chunk) => chunks.push(Buffer.from(chunk)));
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(502, 'Commons returned invalid JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || (data.query !== undefined && (!data.query || typeof data.query !== 'object' || Array.isArray(data.query))) ||
        (data.query !== undefined && !Array.isArray(data.query.pages)) || (!data.query && data.batchcomplete !== true)) throw new HttpError(502, 'Commons returned an invalid query response');
    const items = (data.query?.pages || []).map(commonsItem);
    return { status: 'ok', items, ...(data.continue ? { continuation: data.continue } : {}) };
  }

  async search(raw) {
    const body = object(raw);
    const query = text(body.query, 'query', 500);
    const kind = choice(body.kind, ['image', 'video'], 'kind');
    const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(500, Math.floor(Number(body.limit)))) : 5;
    this.requireProvider();
    const result = await this.metadata({ generator: 'search', gsrnamespace: '6', gsrsearch: `${query} filetype:${kind === 'image' ? 'bitmap' : 'video'}`, gsrlimit: String(limit) }, { search: true });
    if (result.status !== 'ok') return result;
    result.items.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity) || a.pageId - b.pageId);
    result.items = result.items.map((item) => {
      let reason = supportReason(item, kind);
      try { originalUrl(item.url); } catch (error) { reason = error.message; }
      return { ...item, supported: !reason, ...(reason ? { unsupportedReason: reason } : {}) };
    });
    return result;
  }

  async importMedia(raw) {
    const body = object(raw);
    if (body.rightsAcknowledged !== true) throw new HttpError(400, 'Explicit boolean rightsAcknowledged:true is required to import source media for review');
    if (!Number.isSafeInteger(body.pageId) || body.pageId < 1) throw new HttpError(400, 'A positive integer Commons pageId is required');
    const kind = choice(body.kind, ['image', 'video'], 'kind');
    const useAs = choice(body.useAs, ['evidence', 'illustration'], 'useAs');
    this.requireProvider();
    const result = await this.metadata({ pageids: String(body.pageId) });
    if (result.items.length !== 1 || result.items[0].pageId !== body.pageId) throw new HttpError(422, 'Commons did not return the requested original page');
    const item = result.items[0];
    const downloadUrl = originalUrl(item.url);
    const reason = supportReason(item, kind);
    if (reason) throw new HttpError(422, reason);
    if (item.size > MAX_MEDIA_BYTES) throw new HttpError(413, 'Commons original exceeds the byte limit');
    const response = await this.request(downloadUrl);
    if (!response.ok || response.redirected) throwProviderFailure(response);
    if (mimeType(response.headers.get('content-type')) !== item.mime) throw new HttpError(422, 'Downloaded Content-Type differs from Commons original metadata');
    const id = randomUUID(), filename = `${id}${ORIGINALS[item.mime].extension}`;
    const destination = path.join(this.store.dataDir, 'uploads', filename);
    let handle, created = false, committed = false;
    try {
      handle = await open(destination, 'wx', 0o600);
      created = true;
      const hash = createHash('sha256');
      const size = await readBounded(response, MAX_MEDIA_BYTES, async (chunk) => { await handle.writeFile(chunk); hash.update(chunk); });
      await handle.close(); handle = null;
      const verified = await this.probe(destination, item.mime);
      if (!verified || verified.kind !== kind || !Number.isInteger(verified.width) || !Number.isInteger(verified.height) || verified.width < 1 || verified.height < 1 || verified.width > 16384 || verified.height > 16384 ||
          (kind === 'video' && (!Number.isFinite(verified.duration) || verified.duration <= 0 || verified.duration > 1800))) throw new HttpError(422, 'Local probe did not verify the requested visual media');
      const retrievedAt = now();
      const upload = {
        id, filename, url: `/api/uploads/${filename}`, type: item.mime, kind, size, sha256: hash.digest('hex'),
        width: verified.width, height: verified.height,
        ...(kind === 'video' ? { duration: verified.duration } : {}),
        ...(verified.codecName ? { codecName: verified.codecName } : {}),
        createdAt: retrievedAt, updatedAt: retrievedAt,
        provenance: { provider: 'commons', pageId: item.pageId, sourceUrl: item.sourceUrl, originalUrl: downloadUrl, retrievedAt, sha1: item.sha1, timestamp: item.timestamp, extmetadata: item.extmetadata, useAs },
      };
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.store.save('uploads', upload);
        this.store.record('sources.imported', { uploadId: id, pageId: item.pageId, sha256: upload.sha256 });
        this.store.db.exec('COMMIT');
        committed = true;
      } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
      return upload;
    } finally {
      if (handle) await handle.close();
      if (created && !committed) await unlink(destination).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async clearRights(uploadId, raw) {
    const body = object(raw);
    const upload = this.store.get('uploads', uploadId);
    const origin = choice(body.origin, ['own', 'third-party', 'generated'], 'origin');
    if (upload.generationJobId && origin !== 'generated') throw new HttpError(409, 'Generated uploads must retain their generated origin');
    const sha256 = verifiedUploadHash(this.store, upload, undefined, { allowMissingHash: true });
    const fields = { uploadId, sha256, origin, retrievedAt: upload.provenance?.retrievedAt || upload.createdAt || now(), acknowledgedAt: now() };
    if (origin === 'third-party') {
      fields.licenseId = text(body.licenseId, 'licenseId', 160);
      fields.attribution = text(body.attribution, 'attribution', 4000);
      fields.sourceUrl = httpUrl(body.sourceUrl);
    } else {
      if (body.licenseId !== undefined && body.licenseId !== '') fields.licenseId = text(body.licenseId, 'licenseId', 160);
      if (body.attribution !== undefined && body.attribution !== '') fields.attribution = text(body.attribution, 'attribution', 4000);
      if (body.sourceUrl !== undefined && body.sourceUrl !== '') fields.sourceUrl = httpUrl(body.sourceUrl);
    }
    if (origin === 'generated') {
      const jobId = text(body.generationJobId, 'generationJobId', 80);
      if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new HttpError(400, 'Invalid generationJobId');
      if (upload.generationJobId !== jobId) throw new HttpError(409, 'Generated rights must match the verified generation output');
      fields.generationJobId = jobId;
    }
    this.store.db.exec('BEGIN IMMEDIATE');
    let rights;
    try {
      if (origin === 'generated') {
        const currentUpload = this.store.get('uploads', uploadId);
        if (currentUpload.generationJobId !== upload.generationJobId || currentUpload.url !== upload.url || currentUpload.sha256 !== upload.sha256) throw new HttpError(409, 'Generated upload changed before rights registration');
        this.generatedProvenance({ ...currentUpload, sha256 });
        const job = this.store.get('generationJobs', fields.generationJobId);
        const episode = this.store.assertEpisodeActive(job.episodeId);
        if (job.target === 'music' && episode.version !== job.episodeVersion) throw new HttpError(409, 'Episode changed since music generation. Generate again for the current version.');
      }
      // Legacy uploads acquire a byte identity only through an explicit decision.
      if (upload.sha256 === undefined) this.store.save('uploads', { ...upload, sha256 });
      rights = { id: randomUUID(), createdAt: now(), updatedAt: now(), ...fields };
      this.store.save('mediaRights', rights);
      this.store.record('mediaRights.created', { entityId: rights.id });
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this.store.exportKnowledge();
    return rights;
  }

  generatedProvenance(upload) {
    if (!upload.generationJobId) throw new HttpError(409, 'Generated source has no registered generation identity');
    let job;
    try { job = this.store.get('generationJobs', upload.generationJobId); }
    catch { throw new HttpError(409, 'Generated source has no matching generation job'); }
    if (job.status !== 'completed' || !job.outputs?.some((output) => output.uploadId === upload.id && output.url === upload.url && output.sha256 === upload.sha256)) throw new HttpError(409, 'Generated source must match an exact completed generation output');
    // Provenance permits local illustration use; it is not human rights clearance.
    const explicit = this.store.list('mediaRights').find((entry) => entry.uploadId === upload.id && entry.sha256 === upload.sha256 && entry.origin === 'generated' && entry.generationJobId === job.id && Number.isFinite(Date.parse(entry.acknowledgedAt || '')));
    return { ...explicit, origin: 'generated', generationJobId: job.id, sha256: upload.sha256, retrievedAt: explicit?.retrievedAt || upload.createdAt };
  }

  rightsFor(upload, cache) {
    verifiedUploadHash(this.store, upload, cache);
    const rights = this.store.list('mediaRights').find((entry) => entry.uploadId === upload.id && entry.sha256 === upload.sha256);
    if (!rights || !['own', 'third-party', 'generated'].includes(rights.origin) || !/^[a-f0-9]{64}$/.test(upload.sha256 || '') || !Number.isFinite(Date.parse(rights.acknowledgedAt || ''))) throw new HttpError(409, 'Media requires explicit rights clearance bound to the current upload hash');
    if (rights.origin === 'third-party' && (!rights.licenseId?.trim() || !rights.attribution?.trim() || !rights.sourceUrl?.trim())) throw new HttpError(409, 'Third-party rights evidence is incomplete');
    if (upload.generationJobId && rights.origin !== 'generated') throw new HttpError(409, 'Generated uploads must retain their generated origin');
    if (rights.origin === 'generated') {
      if (!rights.generationJobId || rights.generationJobId !== upload.generationJobId) throw new HttpError(409, 'Generated rights identity does not match the upload');
      this.generatedProvenance(upload);
    }
    return rights;
  }

  async attach(episodeId, raw) {
    const body = object(raw);
    requireVersion(body.expectedVersion);
    const episode = this.store.get('episodes', episodeId);
    if (episode.version !== body.expectedVersion) throw new HttpError(409, 'Episode changed before source attachment');
    const scene = episode.scenes.find((entry) => entry.id === body.sceneId);
    if (!scene) throw new HttpError(404, 'Source target scene not found');
    const slot = body.slotId !== undefined ? scene.slots?.find((entry) => entry.id === body.slotId) : null;
    if (body.slotId !== undefined && !slot) throw new HttpError(404, 'Source target slot not found');
    const upload = this.store.get('uploads', text(body.uploadId, 'uploadId', 80));
    const kind = upload.type?.startsWith('image/') ? 'image' : upload.type?.startsWith('video/') ? 'video' : null;
    if (!kind || upload.url !== `/api/uploads/${upload.filename}` || !/^[a-f0-9-]{36}\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i.test(upload.filename || '')) throw new HttpError(422, 'Only registered local visual uploads can be attached');
    if (slot && slot.role !== (kind === 'image' ? 'image-gen' : 'video-bg')) throw new HttpError(422, 'Source media kind does not match the target slot role');
    const assetCache = new Map();
    verifiedUploadHash(this.store, upload, assetCache);
    const rights = upload.generationJobId ? this.generatedProvenance(upload) : this.rightsFor(upload, assetCache);
    const useAs = choice(body.useAs, ['evidence', 'illustration'], 'useAs');
    if (rights.origin === 'generated' && useAs !== 'illustration') throw new HttpError(400, 'Generated visuals cannot be factual event evidence');
    const source = { origin: rights.origin, sha256: upload.sha256, retrievedAt: rights.retrievedAt, useAs };
    for (const key of ['sourceUrl', 'licenseId', 'attribution', 'generationJobId']) if (rights[key]) source[key] = rights[key];
    const attachment = { assetUrl: upload.url, source: sceneSource(source), ...validateTrim(body, upload) };
    const sceneList = episode.scenes.map((entry) => {
      if (entry.id !== scene.id) return entry;
      if (slot) return { ...entry, slots: entry.slots.map((candidate) => {
        if (candidate.id !== slot.id) return candidate;
        const next = { ...candidate, ...attachment, mediaKind: kind };
        if (body.trimEnd === undefined) delete next.trimEnd;
        return next;
      }) };
      const next = { ...entry, ...attachment, kind };
      if (body.trimEnd === undefined) delete next.trimEnd;
      return next;
    });
    return this.store.updateEpisode(episodeId, { scenes: sceneList, status: 'draft' }, body.expectedVersion, 'source attached');
  }

  async card(episodeId, raw) {
    const body = object(raw);
    requireVersion(body.expectedVersion);
    const episode = this.store.get('episodes', episodeId);
    if (episode.version !== body.expectedVersion) throw new HttpError(409, 'Episode changed before card fallback');
    if (!episode.scenes.some((entry) => entry.id === body.sceneId)) throw new HttpError(404, 'Card target scene not found');
    const scenes = episode.scenes.map((scene) => {
      if (scene.id !== body.sceneId) return scene;
      const next = { ...scene, kind: 'title', trimStart: 0 };
      for (const key of ['assetUrl', 'source', 'trimEnd']) delete next[key];
      // A text-only fallback cannot retain hidden image/video layers.
      if (next.slots) next.slots = next.slots.filter((slot) => !['image-gen', 'video-bg'].includes(slot.role)).map((slot) => {
        const copy = { ...slot };
        for (const key of ['assetUrl', 'mediaKind', 'source', 'trimStart', 'trimEnd']) delete copy[key];
        return copy;
      });
      return next;
    });
    return this.store.updateEpisode(episodeId, { scenes, status: 'draft' }, body.expectedVersion, 'source-backed text card');
  }

  validateAssets(sceneList) {
    if (!Array.isArray(sceneList)) throw new HttpError(400, 'Scene list required');
    const uploads = this.store.list('uploads');
    const assetCache = new Map();
    for (const scene of sceneList) for (const target of [scene, ...(scene.slots || [])]) {
      const source = target.source;
      // Preserve the pre-existing source-less scene contract.
      if (source === undefined) continue;
      if (!source || typeof source !== 'object' || !target.assetUrl) throw new HttpError(409, 'Source evidence must refer to a local visual asset');
      sceneSource(source);
      const upload = uploads.find((entry) => entry.url === target.assetUrl);
      if (!upload || source.sha256 !== upload.sha256) throw new HttpError(409, 'Source hash does not match its registered upload');
      if (!/^(image|video)\//.test(upload.type || '') || upload.url !== `/api/uploads/${upload.filename}`) throw new HttpError(409, 'Source evidence requires a registered local visual upload');
      verifiedUploadHash(this.store, upload, assetCache);
      const generated = upload.generationJobId || source.origin === 'generated';
      const rights = generated ? this.generatedProvenance(upload) : this.rightsFor(upload, assetCache);
      if (source.origin !== rights.origin || !['evidence', 'illustration'].includes(source.useAs) || (source.origin === 'generated' && source.useAs !== 'illustration')) throw new HttpError(409, 'Source origin or usage does not match its clearance');
      if (generated && source.generationJobId !== rights.generationJobId) throw new HttpError(409, 'Generated source identity does not match the completed output');
      for (const key of ['sourceUrl', 'licenseId', 'attribution', 'generationJobId', 'retrievedAt']) {
        if ((key === 'sourceUrl' && rights.origin === 'third-party') || source[key] !== undefined) {
          if (source[key] !== rights[key]) throw new HttpError(409, `Source ${key} does not match its clearance`);
        }
      }
      validateTrim(target, upload);
    }
    return sceneList;
  }
}
