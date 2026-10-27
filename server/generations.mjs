import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, object, text } from './validation.mjs';
import { downloadHiggsfieldAsset, validateGenerationInput, validateHiggsfieldId } from './higgsfield.mjs';
import { buildHiggsfieldCliArgs } from './higgsfield-cli.mjs';
import { localMediaInputOptions } from './render.mjs';
import { execute } from './process.mjs';

const stamp = () => new Date().toISOString();
const ACTIVE = new Set(['queued', 'submitting', 'pending', 'in_progress', 'downloading']);
const RECOVERABLE = new Set([...ACTIVE, 'polling_failed', 'import_failed']);
const IMPORT_LEASE_MS = 30 * 60 * 1000;
const TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a' };
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const signature = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const needsBrowserVideo = (media) => media.kind === 'video' && ((media.codecName !== undefined && media.codecName !== 'h264') || (media.pixelFormat !== undefined && media.pixelFormat !== 'yuv420p') || (media.audioCodec && media.audioCodec !== 'aac'));
async function fileHash(filename) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }

/** Probe only standalone local media; a remote URL never reaches FFprobe. */
export async function probeGenerationAsset(filename, contentType) {
  const options = contentType === 'audio/mp4' && path.extname(filename).toLowerCase() === '.m4a' ? ['-protocol_whitelist', 'file', '-format_whitelist', 'mov'] : localMediaInputOptions(filename);
  const { stdout } = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', ...options, '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,pix_fmt,width,height', '-of', 'json', filename], { timeout: 20000 });
  const metadata = JSON.parse(stdout);
  if (['audio/wav', 'audio/mpeg', 'audio/mp4'].includes(contentType)) {
    const streams = metadata.streams || [], audio = streams[0], duration = Number(metadata.format?.duration), formats = String(metadata.format?.format_name || '').split(',');
    const supported = contentType === 'audio/wav' ? formats.includes('wav') && /^pcm_[a-z0-9]+$/.test(audio?.codec_name || '') : contentType === 'audio/mpeg' ? formats.includes('mp3') && audio?.codec_name === 'mp3' : formats.includes('mov') && audio?.codec_name === 'aac';
    if (streams.length !== 1 || audio?.codec_type !== 'audio' || !supported || !Number.isFinite(duration) || duration <= 0 || duration > 1800) throw new HttpError(422, 'Generated audio is not a supported standalone stream');
    return { kind: 'audio', duration, codecName: audio.codec_name };
  }
  const visual = metadata.streams?.find((stream) => stream.codec_type === 'video');
  if (!visual || !Number.isInteger(visual.width) || !Number.isInteger(visual.height) || visual.width < 1 || visual.height < 1 || visual.width > 16384 || visual.height > 16384) throw new HttpError(422, 'Generated output has no supported visual stream');
  const kind = contentType.startsWith('video/') ? 'video' : 'image';
  const duration = Number(metadata.format?.duration);
  if (kind === 'video' && (!Number.isFinite(duration) || duration <= 0 || duration > 1800)) throw new HttpError(422, 'Generated video duration is unsupported');
  return { kind, width: visual.width, height: visual.height, codecName: visual.codec_name, pixelFormat: visual.pix_fmt, ...(kind === 'video' ? { duration, audioCodec: metadata.streams?.find((stream) => stream.codec_type === 'audio')?.codec_name || null } : {}) };
}

/** Persist submission intent before spending; recovery only polls known provider IDs. */
export class GenerationQueue {
  constructor({ store, provider, download = downloadHiggsfieldAsset, probe = probeGenerationAsset, pollIntervalMs = 2500, maxActive = 4, maxPollFailures = 5, maxPollDurationMs = 30 * 60 * 1000, now = Date.now }) {
    this.store = store;
    this.provider = provider;
    this.download = download;
    this.probe = probe;
    this.pollIntervalMs = pollIntervalMs;
    this.maxActive = maxActive;
    this.maxPollFailures = maxPollFailures;
    this.maxPollDurationMs = maxPollDurationMs;
    this.now = now;
    this.closed = false;
    this.pending = new Map();
    this.busy = new Set();
    this.normalizing = new Set();
    this.timers = new Map();
    this.waiters = new Map();
    this.tasks = new Set();
    for (const job of store.list('generationJobs').filter((item) => RECOVERABLE.has(item.status))) {
      const episode = store.get('episodes', job.episodeId);
      if (episode.status === 'archived' || episode.archivedAt) continue;
      if (job.status === 'downloading' && job.importLeaseToken) { this.schedule(job.id, Math.max(0, Date.parse(job.importLeaseExpiresAt) - this.now()) || 0); continue; }
      let available = true;
      try { if (job.target === 'music') this.providerFor(job.transport); else if (job.transport !== provider.transport) available = false; } catch { available = false; }
      if (!available) this.update(job.id, { status: 'manual_recovery', error: 'Generation transport changed. Recover this job with its original provider connection.' });
      else if (job.target === 'music' && job.status === 'queued' && !job.providerRequestId) this.schedule(job.id, 0);
      else if (!job.providerRequestId) this.update(job.id, { status: 'submission_unknown', error: 'Submission was interrupted. Inspect provider history before creating another request.' });
      else {
        const retrying = ['polling_failed', 'import_failed'].includes(job.status);
        const resumed = this.update(job.id, { status: 'pending', pollFailures: 0, ...(retrying ? { recoveryEpoch: randomUUID(), pollStartedAt: stamp(), error: undefined } : {}) }, { expectedStatus: job.status, expectedEpoch: job.recoveryEpoch });
        if (ACTIVE.has(resumed.status)) this.schedule(job.id, 0);
      }
    }
  }

  get(id) { return this.store.get('generationJobs', id); }

  providerFor(transport) {
    if (!['api', 'cli'].includes(transport)) throw new HttpError(400, 'Invalid generation transport');
    if (this.provider.forTransport) return this.provider.forTransport(transport);
    if (this.provider.transport !== transport) throw new HttpError(503, 'Requested generation transport is unavailable');
    return this.provider;
  }

  recover(id) {
    if (this.closed) throw new HttpError(503, 'Generation service is stopping');
    const job = this.get(id);
    this.store.assertEpisodeActive(job.episodeId);
    if (job.status === 'completed' || ACTIVE.has(job.status)) return job;
    if (!['polling_failed', 'import_failed', 'manual_recovery'].includes(job.status) || !job.providerRequestId) throw new HttpError(409, 'This generation cannot be recovered automatically. Inspect provider history without resubmitting.');
    try { if (job.target === 'music') this.providerFor(job.transport); else if (job.transport !== this.provider.transport) throw new Error('Transport changed'); } catch { throw new HttpError(409, 'Restore the original generation transport before recovering this request'); }
    try { validateHiggsfieldId(job.providerRequestId); } catch { throw new HttpError(409, 'Generation has no valid provider identifier to recover'); }
    if (this.pending.size + this.store.list('generationJobs').filter((item) => ACTIVE.has(item.status)).length >= this.maxActive) throw new HttpError(429, 'Generation queue is full');
    const recovered = this.update(id, { status: 'pending', pollFailures: 0, pollStartedAt: stamp(), error: undefined, recoveredAt: stamp(), recoveryEpoch: randomUUID() }, { expectedStatus: job.status, expectedEpoch: job.recoveryEpoch });
    this.schedule(id, 0);
    return recovered;
  }

  musicInput(episodeId, body) {
    if (body.target !== 'music' || body.sceneId !== undefined || body.slotId !== undefined) throw new HttpError(400, 'Music generation requires an episode target');
    const requestId = text(body.requestId, 'requestId', 160);
    if (!/^[a-zA-Z0-9_:-]+$/.test(requestId)) throw new HttpError(400, 'requestId must be a portable unique token');
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) throw new HttpError(400, 'Generation requires a positive expectedVersion');
    const model = text(body.model, 'model', 200), prompt = text(body.prompt, 'prompt', 10000), params = object(body.params ?? {});
    if ('prompt' in params || JSON.stringify(params).length > 20000) throw new HttpError(400, 'Generation params must be bounded and must not override prompt');
    const transport = body.transport === undefined ? this.provider.transport : text(body.transport, 'transport', 10);
    this.providerFor(transport);
    if (params.duration !== undefined && (typeof params.duration !== 'number' || !Number.isFinite(params.duration) || params.duration <= 0 || params.duration > 1800)) throw new HttpError(400, 'Music duration is outside the supported bounds');
    return { requestId, episodeId, expectedVersion: body.expectedVersion, target: 'music', model, prompt, params, transport };
  }

  async musicQuoteDetails(input) {
    let schema, normalized, estimate;
    try {
      const provider = this.providerFor(input.transport);
      schema = await provider.modelSchema(input.model);
      if (schema.id !== input.model || schema.type !== 'audio' || (schema.transport && schema.transport !== input.transport)) throw new HttpError(422, 'Unsupported music model or transport');
      normalized = validateGenerationInput(schema, { ...input.params, prompt: input.prompt });
      if (input.transport === 'cli') buildHiggsfieldCliArgs('create', { model: input.model, prompt: input.prompt, params: input.params }, schema);
      const { prompt, ...params } = normalized;
      estimate = await provider.estimate({ model: input.model, prompt, params });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError([400, 422].includes(error.statusCode) ? error.statusCode : 503, 'Music model or quote is unavailable');
    }
    if (!estimate || typeof estimate.credits !== 'number' || !Number.isFinite(estimate.credits) || estimate.credits < 0) throw new HttpError(503, 'Provider did not return a verified credit quote');
    return { schemaHash: signature(schema), normalized, credits: estimate.credits };
  }

  async quoteMusic(episodeId, raw) {
    if (this.closed) throw new HttpError(503, 'Generation service is stopping');
    const input = this.musicInput(episodeId, object(raw)), episode = this.store.assertEpisodeActive(episodeId);
    if (episode.version !== input.expectedVersion) throw new HttpError(409, 'Episode changed. Save and reload before generation.');
    if (this.store.hasUnresolvedMusicSubmission(episodeId, input.requestId)) throw new HttpError(409, 'A music submission outcome is unknown. Inspect provider history before creating another request.');
    const details = await this.musicQuoteDetails(input);
    if (this.closed) throw new HttpError(503, 'Generation service is stopping');
    if (this.store.assertEpisodeActive(episodeId).version !== input.expectedVersion) throw new HttpError(409, 'Episode changed while requesting the quote');
    const issuedAt = this.now();
    if (!Number.isFinite(issuedAt)) throw new HttpError(503, 'Generation quote clock is unavailable');
    const expiresAt = new Date(issuedAt + 5 * 60 * 1000).toISOString();
    const fingerprint = signature({ input, ...details, expiresAt });
    return this.store.createMusicQuote({ input, ...details, fingerprint, expiresAt, quotedAt: new Date(issuedAt).toISOString() });
  }

  async startMusic(episodeId, body) {
    const input = this.musicInput(episodeId, body);
    const quoteId = text(body.quoteId, 'quoteId', 80), fingerprint = text(body.quoteFingerprint, 'quoteFingerprint', 64);
    if (typeof body.acceptedCredits !== 'number' || !Number.isFinite(body.acceptedCredits) || body.acceptedCredits < 0) throw new HttpError(400, 'Explicit credit approval is required');
    const inputHash = signature({ input, quoteId, fingerprint, acceptedCredits: body.acceptedCredits });
    const existing = this.store.list('generationJobs').find((job) => job.requestId === input.requestId);
    this.store.assertEpisodeActive(episodeId);
    if (existing) {
      if (existing.inputHash !== inputHash) throw new HttpError(409, 'requestId already belongs to a different generation request');
      return existing;
    }
    const pending = this.pending.get(input.requestId);
    if (pending) {
      if (pending.inputHash !== inputHash) throw new HttpError(409, 'requestId already belongs to a different generation request');
      return pending.promise;
    }
    if (this.store.hasUnresolvedMusicSubmission(episodeId, input.requestId, true)) throw new HttpError(409, 'Another music submission is pending or unknown. Inspect its outcome before creating another request.');
    if (this.pending.size + this.store.list('generationJobs').filter((job) => ACTIVE.has(job.status)).length >= this.maxActive) throw new HttpError(429, 'Generation queue is full');
    const promise = (async () => {
      const quote = this.store.get('generationQuotes', quoteId);
      const valid = () => quote.fingerprint === fingerprint && signature(quote.input) === signature(input) && quote.credits === body.acceptedCredits && quote.fingerprint === signature({ input: quote.input, schemaHash: quote.schemaHash, normalized: quote.normalized, credits: quote.credits, expiresAt: quote.expiresAt }) && Number.isFinite(this.now()) && Date.parse(quote.expiresAt) > this.now();
      if (!valid()) throw new HttpError(409, 'Music quote is invalid or expired');
      const details = await this.musicQuoteDetails(input);
      if (this.closed) throw new HttpError(503, 'Generation service is stopping');
      if (!valid() || signature(details) !== signature({ schemaHash: quote.schemaHash, normalized: quote.normalized, credits: quote.credits })) throw new HttpError(409, 'Music quote changed or expired');
      const { prompt, ...params } = details.normalized;
      const job = this.store.claimMusicGeneration({ requestId: input.requestId, inputHash, episodeId, episodeVersion: input.expectedVersion, target: 'music', model: input.model, prompt, params, transport: input.transport, mediaKind: 'audio', quoteId, quoteFingerprint: fingerprint, acceptedCredits: body.acceptedCredits, status: 'queued', outputs: [], applied: false }, quote, this.now());
      if (job.status === 'queued') this.schedule(job.id, 0);
      return job;
    })();
    this.pending.set(input.requestId, { episodeId, inputHash, promise });
    try { return await promise; } finally { this.pending.delete(input.requestId); }
  }

  async start(episodeId, raw) {
    if (this.closed) throw new HttpError(503, 'Generation service is stopping');
    const body = object(raw);
    if (body.target === 'music') return this.startMusic(episodeId, body);
    const requestId = text(body.requestId, 'requestId', 160);
    if (!/^[a-zA-Z0-9_:-]+$/.test(requestId)) throw new HttpError(400, 'requestId must be a portable unique token');
    if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) throw new HttpError(400, 'Generation requires a positive expectedVersion');
    const model = text(body.model, 'model', 200), prompt = text(body.prompt, 'prompt', 10000), sceneId = text(body.sceneId, 'sceneId', 80);
    const slotId = body.slotId !== undefined && body.slotId !== '' ? text(body.slotId, 'slotId', 80) : undefined;
    const params = object(body.params ?? {});
    if ('prompt' in params || JSON.stringify(params).length > 20000) throw new HttpError(400, 'Generation params must be bounded and must not override prompt');
    const input = { episodeId, expectedVersion: body.expectedVersion, sceneId, ...(slotId ? { slotId } : {}), model, prompt, params, transport: this.provider.transport };
    const inputHash = signature(input);
    const existing = this.store.list('generationJobs').find((job) => job.requestId === requestId);
    const episode = this.store.assertEpisodeActive(episodeId);
    if (existing) {
      if (existing.inputHash !== inputHash) throw new HttpError(409, 'requestId already belongs to a different generation request');
      return existing;
    }
    const pending = this.pending.get(requestId);
    if (pending) {
      if (pending.inputHash !== inputHash) throw new HttpError(409, 'requestId already belongs to a different generation request');
      return pending.promise;
    }
    if (this.pending.size + this.store.list('generationJobs').filter((job) => ACTIVE.has(job.status)).length >= this.maxActive) throw new HttpError(429, 'Generation queue is full');
    if (episode.version !== body.expectedVersion) throw new HttpError(409, 'Episode changed. Save and reload before generation.');
    if (!episode.scenes.some((scene) => scene.id === sceneId)) throw new HttpError(400, 'Generation requires an existing scene');
    const scene = episode.scenes.find((item) => item.id === sceneId);
    if (slotId && !scene.slots?.some((slot) => slot.id === slotId)) throw new HttpError(400, 'Generation requires an existing target slot');
    const targetSlot = slotId ? scene.slots.find((slot) => slot.id === slotId) : undefined;
    const promise = (async () => {
      let schema, normalized;
      try {
        schema = await this.provider.modelSchema(model);
        if (slotId && ((schema.type === 'image' && targetSlot.role !== 'image-gen') || (schema.type === 'video' && targetSlot.role !== 'video-bg'))) throw new HttpError(422, 'Generation model media type does not match the target slot role');
        if (!['image', 'video'].includes(schema.type)) throw new HttpError(422, 'Only image and video generation can be attached to scenes');
        normalized = validateGenerationInput(schema, { ...params, prompt });
        if (this.provider.transport === 'cli') buildHiggsfieldCliArgs('create', { model, prompt, params }, schema);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const invalidInput = [400, 422].includes(error.statusCode);
        throw new HttpError(invalidInput ? error.statusCode : 503, invalidInput ? 'Generation input does not match the supported model parameters' : 'Generation model schema is unavailable');
      }
      if (this.closed) throw new HttpError(503, 'Generation service is stopping');
      if (this.store.assertEpisodeActive(episodeId).version !== episode.version) throw new HttpError(409, 'Episode changed while validating the generation request');
      const { prompt: checkedPrompt, ...checkedParams } = normalized;
      const job = this.store.create('generationJobs', { requestId, inputHash, episodeId, episodeVersion: episode.version, sceneId, ...(slotId ? { slotId } : {}), model, prompt: checkedPrompt, params: checkedParams, transport: this.provider.transport, mediaKind: schema.type, status: 'queued', outputs: [], applied: false });
      this.schedule(job.id, 0);
      return job;
    })();
    this.pending.set(requestId, { episodeId, inputHash, promise });
    try { return await promise; }
    finally { this.pending.delete(requestId); }
  }

  update(id, patch, options = {}) {
    const job = this.store.updateGeneration(id, patch, { ...options, time: this.now() });
    if (!ACTIVE.has(job.status)) this.notify(id);
    return job;
  }

  schedule(id, delay = this.pollIntervalMs) {
    if (this.closed || this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const task = this.process(id);
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task));
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  async process(id) {
    if (this.closed || this.busy.has(id)) return;
    this.busy.add(id);
    let importToken, expectedEpoch;
    try {
      let job = this.get(id), result, quoteExpiresAt, quoteSchemaHash;
      expectedEpoch = job.recoveryEpoch;
      if (!ACTIVE.has(job.status)) return;
      if (job.status === 'downloading' && job.importLeaseToken) {
        const remaining = Date.parse(job.importLeaseExpiresAt) - this.now();
        if (remaining > 0) { this.schedule(id, remaining); return; }
        job = this.update(id, { status: 'pending', importLeaseToken: undefined, importLeaseExpiresAt: undefined, pollStartedAt: stamp(), pollFailures: 0 }, { activeOnly: true, expectedEpoch });
        if (!ACTIVE.has(job.status) || job.recoveryEpoch !== expectedEpoch) return;
      }
      this.store.assertEpisodeActive(job.episodeId);
      if (!job.providerRequestId) {
        if (job.target === 'music') {
          job = this.store.claimMusicSubmission(id);
          if (!job) { if (!ACTIVE.has(this.get(id).status)) this.notify(id); return; }
          try {
            const quote = this.store.get('generationQuotes', job.quoteId);
            const details = await this.musicQuoteDetails(quote.input);
            const currentTime = this.now();
            if (this.closed) { this.update(id, { status: 'queued', submittedAt: undefined }); return; }
            if (!Number.isFinite(currentTime) || Date.parse(quote.expiresAt) <= currentTime || quote.usedBy !== job.id || quote.fingerprint !== job.quoteFingerprint || quote.fingerprint !== signature({ input: quote.input, schemaHash: quote.schemaHash, normalized: quote.normalized, credits: quote.credits, expiresAt: quote.expiresAt }) || job.acceptedCredits !== quote.credits || signature(details) !== signature({ schemaHash: quote.schemaHash, normalized: quote.normalized, credits: quote.credits }) || this.store.assertEpisodeActive(job.episodeId).version !== job.episodeVersion) throw new Error('Music approval no longer matches');
            quoteExpiresAt = quote.expiresAt;
            quoteSchemaHash = quote.schemaHash;
          } catch {
            this.update(id, { status: 'failed', error: 'Music quote expired or changed before submission; no provider request was made.' });
            return;
          }
        } else {
          if (job.status !== 'queued') { this.update(id, { status: 'submission_unknown', error: 'Provider submission identifier is unavailable; inspect provider history.' }); return; }
          this.update(id, { status: 'submitting', submittedAt: stamp() });
        }
        try { result = await (job.target === 'music' ? this.providerFor(job.transport) : this.provider).create({ model: job.model, prompt: job.prompt, params: job.params, ...(job.transport === 'api' ? { idempotencyKey: job.id } : {}), ...(job.target === 'music' && job.transport === 'cli' ? { quoteExpiresAt, quoteSchemaHash } : {}) }); }
        catch (error) {
          const rejected = ['INVALID_INPUT', 'UNSUPPORTED', 'NOT_CONFIGURED', 'AUTH_REQUIRED', 'RATE_LIMITED', 'EXPIRED_QUOTE', 'SCHEMA_CHANGED'].includes(error.code);
          this.update(id, { status: rejected ? 'failed' : 'submission_unknown', error: rejected ? 'Provider rejected generation. Check model settings and provider access.' : 'Submission outcome is unknown. Inspect provider history before creating another request.' });
          return;
        }
        try { validateHiggsfieldId(result?.requestId); }
        catch { this.update(id, { status: 'submission_unknown', error: 'Provider did not return a valid submission identifier. Inspect provider history.' }); return; }
        job = this.update(id, { providerRequestId: result.requestId, status: 'pending', pollFailures: 0, pollStartedAt: stamp() });
        expectedEpoch = job.recoveryEpoch;
        if (this.closed) return;
      } else {
        const started = Date.parse(job.pollStartedAt || job.submittedAt || job.createdAt);
        if (!Number.isFinite(started) || Date.now() - started >= this.maxPollDurationMs) {
          this.update(id, { status: 'polling_failed', error: 'Automatic polling reached its time limit. Recover this existing request to continue checking without resubmitting.' }, { activeOnly: true, expectedEpoch });
          return;
        }
        try { result = await (job.target === 'music' ? this.providerFor(job.transport) : this.provider).status(job.providerRequestId); }
        catch {
          if (this.closed) return;
          const failures = (job.pollFailures || 0) + 1;
          this.update(id, { pollFailures: failures, ...(failures >= this.maxPollFailures ? { status: 'polling_failed', error: 'Provider status could not be retrieved. The existing request must be recovered, not resubmitted.' } : {}) }, { activeOnly: true, expectedEpoch });
          if (failures < this.maxPollFailures) this.schedule(id);
          return;
        }
      }
      if (this.closed) return;
      if (result.requestId !== job.providerRequestId || (result.transport && result.transport !== job.transport)) {
        this.update(id, { status: 'manual_recovery', error: 'Provider returned a different generation identity or transport.' }, { activeOnly: true, expectedEpoch }); return;
      }
      if (result.status === 'completed') {
        const token = randomUUID();
        const importing = this.store.claimGenerationImport(id, token, this.now(), IMPORT_LEASE_MS, expectedEpoch);
        if (importing) { importToken = token; await this.importOutputs(id, result.outputs, token); }
        else {
          const current = this.get(id);
          if (current.status === 'downloading' && current.importLeaseToken) this.schedule(id, Math.max(0, Date.parse(current.importLeaseExpiresAt) - this.now()));
        }
      } else if (['failed', 'nsfw', 'canceled', 'cancelled'].includes(result.status)) {
        this.update(id, { status: result.status === 'cancelled' ? 'canceled' : result.status, providerStatus: result.status, error: 'Provider did not complete the requested generation.', completedAt: stamp() }, { activeOnly: true, expectedEpoch });
      } else if (['queued', 'pending', 'running', 'processing', 'in_progress'].includes(result.status)) {
        this.update(id, { status: 'in_progress', providerStatus: result.status, pollFailures: 0 }, { activeOnly: true, expectedEpoch });
        this.schedule(id);
      } else this.update(id, { status: 'manual_recovery', error: 'Provider returned an unsupported generation state.' }, { activeOnly: true, expectedEpoch });
    } catch {
      const current = this.update(id, { status: 'import_failed', importLeaseToken: undefined, importLeaseExpiresAt: undefined, error: 'Generated media could not be imported safely. Recover the existing provider request without resubmitting.' }, { importToken, activeOnly: true, expectedEpoch });
      if (importToken && current.status === 'downloading' && Date.parse(current.importLeaseExpiresAt) <= this.now()) this.schedule(id, 0);
    } finally { this.busy.delete(id); }
  }

  async importOutputs(id, outputs, importToken) {
    if (!Array.isArray(outputs) || !outputs.length || outputs.length > 4) throw new HttpError(422, 'Generation must return 1–4 media outputs');
    const job = this.get(id), uploadRoot = path.resolve(this.store.dataDir, 'uploads'), rootInfo = await lstat(uploadRoot), root = await realpath(uploadRoot);
    if (job.target === 'music' && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || root !== uploadRoot)) throw new HttpError(422, 'Generated music upload directory is not a contained directory');
    this.store.assertEpisodeActive(job.episodeId);
    const files = [], uploads = [];
    let committed = false;
    try {
      for (const output of outputs) {
        if (this.closed) return;
        this.store.assertEpisodeActive(job.episodeId);
        if (!['image', 'video', 'audio'].includes(output.type) || output.type !== job.mediaKind) throw new HttpError(422, 'Generation output does not match its model media type');
        const uploadId = randomUUID(), temporary = path.join(root, `${uploadId}.download`);
        files.push(temporary);
        const downloaded = await this.download(output.url, temporary);
        if (this.closed) return;
        const receivedType = downloaded.contentType.toLowerCase();
        const type = receivedType === 'audio/x-wav' ? 'audio/wav' : receivedType, extension = TYPES[type];
        if (!extension || !type.startsWith(`${output.type}/`)) throw new HttpError(422, 'Generated content type does not match its output');
        const filename = `${uploadId}${extension}`, destination = path.join(root, filename);
        const info = await lstat(temporary);
        if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > 100 * 1024 * 1024 || info.size !== downloaded.bytes || await realpath(temporary) !== temporary) throw new HttpError(422, 'Generated media is not a valid owned file');
        await copyFile(temporary, destination, constants.COPYFILE_EXCL);
        files.push(destination);
        await unlink(temporary);
        const media = await this.probe(destination, type);
        if (this.closed) return;
        if (media.kind !== output.type) throw new HttpError(422, 'Generated media stream does not match its output');
        const source = new URL(output.url);
        const upload = { id: uploadId, filename, url: `/api/uploads/${filename}`, name: `Higgsfield ${job.model}${extension}`, type, size: info.size, sha256: await fileHash(destination), generated: true, provider: 'higgsfield', generationJobId: id, ...media, provenance: { provider: 'higgsfield', transport: job.transport, requestId: job.providerRequestId, model: job.model, source: `${source.origin}${source.pathname}` }, createdAt: stamp(), updatedAt: stamp() };
        if (type === 'audio/mp4') {
          const converted = await this.convertMusic(upload, root, files);
          uploads.push(converted, { ...upload, variant: 'original' });
        } else if (needsBrowserVideo(media)) {
          const browser = await this.browserVideo(upload, root, files);
          uploads.push(browser, { ...upload, variant: 'original' });
        } else uploads.push(upload);
      }
      if (this.closed) return;
      this.store.completeGeneration(id, uploads, importToken, this.now());
      committed = true;
      this.notify(id);
    } finally { if (!committed) for (const filename of files) await unlink(filename).catch(() => {}); }
  }

  async convertMusic(original, root, files) {
    const id = randomUUID(), filename = `${id}.wav`, destination = path.join(root, filename), input = path.join(root, original.filename);
    files.push(destination);
    await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-threads', '1', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-i', input, '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-fs', String(100 * 1024 * 1024 + 1), destination], { timeout: 180000 });
    if (this.closed) throw new HttpError(503, 'Generation service is stopping');
    const info = await lstat(destination), media = await probeGenerationAsset(destination, 'audio/wav');
    if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > 100 * 1024 * 1024 || await realpath(destination) !== destination || Math.abs(media.duration - original.duration) > Math.max(0.25, original.duration * 0.03)) throw new HttpError(422, 'Music conversion failed media validation');
    if (await fileHash(input) !== original.sha256) throw new HttpError(409, 'Original music changed during conversion');
    const source = { uploadId: original.id, url: original.url, sha256: original.sha256, codecName: original.codecName };
    return { ...original, ...media, id, filename, url: `/api/uploads/${filename}`, name: `${original.name} · converted.wav`, type: 'audio/wav', size: info.size, sha256: await fileHash(destination), variant: 'converted', normalized: true, provenance: { ...original.provenance, original: source }, createdAt: stamp(), updatedAt: stamp() };
  }

  async browserVideo(original, root, files) {
    const id = randomUUID(), filename = `${id}.mp4`, destination = path.join(root, filename);
    files.push(destination);
    await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-threads', '1', ...localMediaInputOptions(original.filename), '-i', path.join(root, original.filename), '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-threads', '1', '-movflags', '+faststart', '-fs', String(100 * 1024 * 1024 + 1), destination], { timeout: 180000 });
    if (this.closed) throw new HttpError(503, 'Generation service is stopping');
    const info = await lstat(destination), media = await probeGenerationAsset(destination, 'video/mp4');
    if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > 100 * 1024 * 1024 || await realpath(destination) !== destination || needsBrowserVideo(media) || Math.abs(media.duration - original.duration) > Math.max(0.25, original.duration * 0.03)) throw new HttpError(422, 'Browser video normalization failed media validation');
    if (await fileHash(path.join(root, original.filename)) !== original.sha256) throw new HttpError(409, 'Original generation asset changed during normalization');
    const source = { uploadId: original.id, url: original.url, sha256: original.sha256, codecName: original.codecName, pixelFormat: original.pixelFormat, audioCodec: original.audioCodec };
    return { ...original, ...media, id, filename, url: `/api/uploads/${filename}`, name: `${original.name} · browser.mp4`, type: 'video/mp4', size: info.size, sha256: await fileHash(destination), variant: 'browser', normalized: true, provenance: { ...original.provenance, original: source }, createdAt: stamp(), updatedAt: stamp() };
  }

  async normalize(id) {
    if (this.closed) throw new HttpError(503, 'Generation service is stopping');
    const job = this.get(id);
    this.store.assertEpisodeActive(job.episodeId);
    if (job.status !== 'completed') throw new HttpError(409, 'Only completed generation output can be normalized');
    if (this.busy.has(id)) throw new HttpError(409, 'Generation media is already being processed');
    if (this.normalizing.size >= Math.min(2, this.maxActive)) throw new HttpError(429, 'Video normalization capacity reached');
    this.normalizing.add(id);
    this.busy.add(id);
    const files = [], replacements = [];
    let committed = false;
    try {
      const root = await realpath(path.join(this.store.dataDir, 'uploads'));
      for (const output of job.outputs) {
        this.store.assertEpisodeActive(job.episodeId);
        const original = this.store.get('uploads', output.uploadId);
        if (original.generationJobId !== id || original.url !== output.url || original.sha256 !== output.sha256 || !/^[a-f0-9-]{36}\.(png|jpg|webp|mp4|mov)$/.test(original.filename)) throw new HttpError(409, 'Generation asset identity does not match');
        const source = path.join(root, original.filename), info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink() || await realpath(source) !== source || await fileHash(source) !== original.sha256) throw new HttpError(409, 'Original generation asset changed; normalization refused');
        if (original.kind !== 'video') continue;
        const media = await probeGenerationAsset(source, original.type);
        if (!needsBrowserVideo(media)) continue;
        const verified = { ...original, ...media };
        replacements.push({ original: verified, browser: await this.browserVideo(verified, root, files) });
      }
      if (this.closed) throw new HttpError(503, 'Generation service is stopping');
      if (!replacements.length) { committed = true; return this.get(id); }
      const normalized = this.store.normalizeGeneration(id, job.outputs, replacements);
      committed = true;
      return normalized;
    } finally {
      if (!committed) for (const filename of files) await unlink(filename).catch(() => {});
      this.busy.delete(id);
      this.normalizing.delete(id);
    }
  }

  apply(id, raw) {
    if (this.closed) throw new HttpError(503, 'Generation service is stopping');
    if (this.normalizing.has(id)) throw new HttpError(409, 'Generation media is being normalized. Apply the new candidate after it finishes.');
    const body = object(raw);
    if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) throw new HttpError(400, 'Applying generation requires a positive expectedVersion');
    const job = this.get(id);
    if (job.target === 'music') return this.store.applyMusicGeneration(id, body.expectedVersion, text(body.outputUploadId, 'outputUploadId', 80));
    const slotId = body.slotId !== undefined && body.slotId !== '' ? text(body.slotId, 'slotId', 80) : undefined;
    return this.store.applyGeneration(id, body.expectedVersion, text(body.sceneId, 'sceneId', 80), slotId);
  }

  wait(id, { timeoutMs = 30 * 60 * 1000 } = {}) {
    if (this.closed) return Promise.reject(new HttpError(503, 'Generation service is stopping'));
    const current = this.get(id);
    if (current.status === 'completed') return Promise.resolve(current);
    if (!ACTIVE.has(current.status)) return Promise.reject(new HttpError(409, current.error || 'Generation did not complete'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => { this.waiters.get(id)?.delete(waiter); reject(new HttpError(504, 'Generation is still pending. Inspect this request without resubmitting.')); }, timeoutMs) };
      if (!this.waiters.has(id)) this.waiters.set(id, new Set());
      this.waiters.get(id).add(waiter);
    });
  }

  notify(id) {
    const waiters = this.waiters.get(id);
    if (!waiters) return;
    const job = this.get(id);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      if (job.status === 'completed') waiter.resolve(job);
      else waiter.reject(new HttpError(409, job.error || 'Generation did not complete'));
    }
    this.waiters.delete(id);
  }

  close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const waiters of this.waiters.values()) for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new HttpError(503, 'Generation service is stopping')); }
    this.waiters.clear();
    return Promise.allSettled([...this.tasks, ...[...this.pending.values()].map((item) => item.promise)]);
  }
}
