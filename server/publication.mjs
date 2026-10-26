import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HttpError, text } from './validation.mjs';
import { ancestors, candidateFingerprint, canonicalJson, resolvePrerequisite } from './graph.mjs';
import { candidateManifest, verifyCandidateAssets } from './candidates.mjs';
import { requiredMediaCredits } from './media-credits.mjs';
import { PrivateRuntime } from './private-runtime.mjs';

const VIDEOS = 'https://www.googleapis.com/youtube/v3/videos';
const INSERT = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const APPROVALS = 'publicationApprovals';
const INTENTS = 'publicationIntents';
// Constant prefix plus a validated local intent ID; opaque URLs never become filenames.
const PRIVATE_NAMESPACE = 'publication_';
const CHUNK_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;
const now = () => new Date().toISOString();
const conflict = (message) => { throw new HttpError(409, message); };

function metadata(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Publication manifest required');
  const result = {
    title: text(body.title, 'title', 100),
    description: text(body.description, 'description', 5000),
    categoryId: text(body.categoryId, 'categoryId', 10),
    disclosureRationale: text(body.disclosureRationale, 'disclosureRationale', 2000),
  };
  if (/[<>]/.test(result.title + result.description) || !/^\d+$/.test(result.categoryId)) throw new HttpError(400, 'Invalid YouTube metadata');
  if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || /[<>\u0000-\u001f]/.test(tag))) throw new HttpError(400, 'Explicit tags array required');
  result.tags = body.tags.map((tag) => tag.trim());
  // YouTube counts delimiters and quotes around tags containing spaces toward 500.
  if (result.tags.reduce((length, tag) => length + tag.length + (/\s/.test(tag) ? 2 : 0), Math.max(0, result.tags.length - 1)) > 500) throw new HttpError(400, 'YouTube tags exceed 500 characters');
  for (const key of ['selfDeclaredMadeForKids', 'containsSyntheticMedia']) {
    if (typeof body[key] !== 'boolean') throw new HttpError(400, `Explicit ${key} decision required`);
    result[key] = body[key];
  }
  if (body.rightsAcknowledged !== true) throw new HttpError(400, 'Explicit rights acknowledgement required');
  if (body.publishAt !== undefined || (body.visibility !== undefined && body.visibility !== 'public')) throw new HttpError(400, 'Only immediate public publication is supported');
  return { ...result, rightsAcknowledged: true, visibility: 'public' };
}

function trustedUrl(value, session = false) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(502, 'Invalid Google upload endpoint'); }
  const expected = session ? '/upload/youtube/v3/videos' : ['/upload/youtube/v3/videos', '/youtube/v3/videos'];
  if (url.origin !== 'https://www.googleapis.com' || url.username || url.password || url.hash || (Array.isArray(expected) ? !expected.includes(url.pathname) : url.pathname !== expected)) throw new HttpError(502, 'Untrusted Google endpoint');
  if (session && (url.searchParams.get('uploadType') !== 'resumable' || !url.searchParams.get('upload_id'))) throw new HttpError(502, 'Invalid resumable upload session');
  return url.href;
}

async function jsonResponse(response) {
  let length = 0;
  const parts = [];
  for await (const part of response.body || []) {
    length += part.length;
    if (length > 1024 * 1024) throw new HttpError(502, 'Google response exceeds the allowed size');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new HttpError(502, 'Invalid Google response'); }
}

function retryAt(response) {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const time = /^\d+$/.test(raw) ? Date.now() + Number(raw) * 1000 : Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Explicit final approval followed by a durable, recoverable private-to-public delivery.
 * Provider transport is the only injectable execution boundary. Public records never contain
 * bearer tokens, opaque upload URLs, provider error bodies or raw transport error messages.
 */
export class PublicationService {
  constructor({ store, oauth, fetchImpl = fetch } = {}) {
    if (!store) throw new TypeError('PublicationService requires a store');
    this.store = store;
    this.oauth = oauth;
    this.fetchImpl = fetchImpl;
    this.privateRuntime = new PrivateRuntime({ dataDir: store.dataDir });
    this.jobs = new Map();
    this.abortController = new AbortController();
    this.polls = new Map();
    this.privateQueue = Promise.resolve();
    this.validatedManifests = new WeakMap();
    this.closing = false;
    this.closed = false;
  }

  _open() {
    if (this.closing || this.closed) throw new HttpError(503, 'Publication service is closed');
  }

  _owner(record, ownerId) {
    if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId !== record.ownerId) throw new HttpError(403, 'Publication belongs to a different owner');
  }

  _intent(approvalId) {
    return this.store.list(INTENTS).find((intent) => intent.approvalId === approvalId) || null;
  }

  async _private(id, update) {
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(id)) throw new HttpError(400, 'Invalid publication intent identity');
    const name = `${PRIVATE_NAMESPACE}${id}`;
    const operation = this.privateQueue.then(async () => {
      this._open();
      const saved = await this.privateRuntime.read(name);
      if (saved !== null && (!saved || typeof saved !== 'object' || Array.isArray(saved))) throw new HttpError(409, 'Private publication storage is invalid');
      if (update === undefined) return saved;
      this._open();
      if (update === null) await this.privateRuntime.remove(name);
      else await this.privateRuntime.write(name, update);
      return update;
    });
    this.privateQueue = operation.catch(() => {});
    return operation;
  }

  async _export(job, sha256) {
    if (!SHA256.test(sha256 || '') || typeof job.filename !== 'string' || !/^[\w.-]+\.mp4$/i.test(job.filename) || job.filename.includes('..') || job.outputUrl !== `/api/exports/${job.filename}`) conflict('Review has no valid local MP4 artifact');
    const root = path.join(this.store.dataDir, 'exports');
    const filename = path.join(root, job.filename);
    let bytes;
    try {
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size === 0) conflict('Render artifact is not a regular nonempty file');
      const [dataRoot, exportRoot, resolved] = await Promise.all([realpath(this.store.dataDir), realpath(root), realpath(filename)]);
      if (path.dirname(exportRoot) !== dataRoot || path.dirname(resolved) !== exportRoot) conflict('Render artifact is outside local exports');
      bytes = await readFile(resolved);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      conflict('Approved render artifact is unavailable');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) conflict('Actual render bytes differ from the approved hash');
    return bytes;
  }

  _snapshot(body, ownerId) {
    const fields = metadata(body);
    for (const key of ['workflowId', 'runId', 'reviewNodeId']) text(body[key], key, 200);
    if (!Number.isInteger(body.expectedEpisodeVersion) || body.expectedEpisodeVersion < 1) throw new HttpError(400, 'Expected episode version required');
    const workflow = this.store.get('workflows', body.workflowId);
    const run = this.store.get('workflowRuns', body.runId);
    if (run.workflowId !== workflow.id) throw new HttpError(404, 'Workflow run not found');
    const episode = this.store.assertEpisodeActive(run.episodeId);
    const channel = this.store.get('channels', episode.channelId);
    if (workflow.episodeId !== episode.id || workflow.channelId !== channel.id) conflict('Publication requires the exact project-owned workflow');
    if (!CHANNEL_ID.test(channel.externalId || '') || String(channel.platform).toLowerCase() !== 'youtube') conflict('An explicitly bound YouTube channel is required');
    const reviewNode = workflow.nodes?.find((node) => node.id === body.reviewNodeId);
    const nodeRun = run.nodeRuns?.find((node) => node.nodeId === body.reviewNodeId);
    const review = run.reviews?.[body.reviewNodeId];
    if (reviewNode?.type !== 'review' || nodeRun?.type !== 'review' || nodeRun.status !== 'approved' || review?.decision !== 'approved') conflict('The selected review node is not approved');
    if (['failed', 'cancelled', 'changes_requested'].includes(run.status)) conflict('The selected run is not an approved candidate');
    if (run.workflowVersion !== workflow.version || review.workflowVersion !== workflow.version || run.episodeVersion !== episode.version || review.episodeVersion !== episode.version || body.expectedEpisodeVersion !== episode.version) conflict('Workflow or episode changed since review');
    if (review.workflowId !== workflow.id || review.runId !== run.id || review.episodeId !== episode.id || (review.reviewNodeId !== undefined && review.reviewNodeId !== body.reviewNodeId)) conflict('Review identities do not match the candidate');
    if (run.workflowSnapshot && (run.workflowSnapshot.id !== workflow.id || run.workflowSnapshot.version !== workflow.version || canonicalJson(run.workflowSnapshot.nodes) !== canonicalJson(workflow.nodes) || canonicalJson(run.workflowSnapshot.edges) !== canonicalJson(workflow.edges))) conflict('Reviewed graph differs from the current workflow');
    const renderNode = resolvePrerequisite(workflow.nodes, workflow.edges, body.reviewNodeId, 'render');
    const renderRun = run.nodeRuns.find((node) => node.nodeId === renderNode.id);
    if (renderRun?.type !== 'render' || renderRun.status !== 'completed' || !renderRun.output?.jobId) conflict('Review has no completed connected render');
    const job = this.store.get('jobs', renderRun.output.jobId);
    if (job.status !== 'completed' || job.episodeId !== episode.id || job.episodeVersion !== episode.version || review.jobId !== job.id || review.outputUrl !== job.outputUrl || renderRun.output.outputUrl !== job.outputUrl || renderRun.output.sha256 !== review.sha256 || job.sha256 !== review.sha256 || (renderRun.output.episodeVersion !== undefined && renderRun.output.episodeVersion !== episode.version)) conflict('Review and render artifact differ');
    const sceneSnapshot = job.sceneSnapshot;
    if (!Array.isArray(sceneSnapshot) || !sceneSnapshot.length || !Array.isArray(renderRun.output.sceneSnapshot)
      || canonicalJson(sceneSnapshot) !== canonicalJson(renderRun.output.sceneSnapshot)) conflict('Render scene provenance is missing or mismatched; a fresh render is required');
    const upstream = ancestors(workflow.edges, renderNode.id);
    const completedGenerations = workflow.nodes.filter((node) => node.type === 'generate' && upstream.has(node.id)
      && run.nodeRuns.some((item) => item.nodeId === node.id && ['completed', 'reused'].includes(item.status) && item.output?.generationJobId)).map((node) => node.id);
    const generationNodeIds = renderRun.output.generationNodeIds ?? completedGenerations;
    if (!Array.isArray(generationNodeIds) || new Set(generationNodeIds).size !== generationNodeIds.length
      || generationNodeIds.some((id) => !completedGenerations.includes(id))
      || completedGenerations.some((id) => !generationNodeIds.includes(id))) conflict('Render generation lineage differs from its connected outputs; a fresh render is required');
    // Preserve current project/version guards, but verify only the scenes actually rendered.
    // Sibling generation targets cannot change this branch's assets or block its approval.
    const candidate = candidateManifest(this.store, { ...episode, scenes: sceneSnapshot }, workflow, {
      selectedStages: workflow.nodes.filter((node) => (node.id === renderNode.id || upstream.has(node.id))
        && (node.type !== 'generate' || generationNodeIds.includes(node.id))).map((node) => node.id),
      disclosure: { containsSyntheticMedia: fields.containsSyntheticMedia, rationale: fields.disclosureRationale },
      publication: fields,
    });
    return {
      fields, workflow, run, episode, channel, job, review, renderNode, candidate, sceneSnapshot, ownerId,
      request: { ...fields, workflowId: workflow.id, runId: run.id, reviewNodeId: body.reviewNodeId, expectedEpisodeVersion: body.expectedEpisodeVersion },
      binding: canonicalJson({ workflow, run, episode, channel, job, candidate }),
    };
  }

  _assertCurrent(manifest) {
    const snapshot = this.validatedManifests.get(manifest);
    if (!snapshot) conflict('Publication manifest has no validated snapshot');
    try {
      if (snapshot.binding !== this._snapshot(snapshot.request, snapshot.ownerId).binding
        || (snapshot.approval && canonicalJson(this.store.get(APPROVALS, snapshot.approval.id)) !== canonicalJson(snapshot.approval))) conflict('Publication state changed during validation; prepare a new final approval');
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) conflict('Publication state was removed during validation');
      throw error;
    }
  }

  async _manifest(body, ownerId) {
    const snapshot = this._snapshot(body, ownerId);
    const { fields, workflow, run, episode, channel, job, review, renderNode, candidate } = snapshot;
    await verifyCandidateAssets(this.store, candidate);
    const bytes = await this._export(job, review.sha256);
    const credits = requiredMediaCredits(snapshot.sceneSnapshot);
    const description = credits ? `${fields.description}\n\n${credits}` : fields.description;
    // Validate the actual final text, including all server-derived attribution.
    if (description.length > 5000 || Buffer.byteLength(description, 'utf8') > 5000 || /[<>]/.test(description)) throw new HttpError(400, 'Final YouTube description including credits exceeds the metadata limits');
    const manifest = {
      schema: 'frameforge-publication-manifest/v1', ownerId,
      workflowId: workflow.id, workflowVersion: workflow.version, runId: run.id,
      reviewNodeId: snapshot.request.reviewNodeId, renderNodeId: renderNode.id,
      episodeId: episode.id, episodeVersion: episode.version,
      channelId: channel.id, channelExternalId: channel.externalId,
      ...fields, description, credits, candidate,
      render: { jobId: job.id, filename: job.filename, outputUrl: job.outputUrl, sha256: review.sha256, size: bytes.length, episodeVersion: episode.version },
    };
    this.validatedManifests.set(manifest, snapshot);
    // Asset/export I/O yields: reread every bound record, including rights/provenance,
    // review and render state, after the final await instead of trusting old snapshots.
    this._assertCurrent(manifest);
    return manifest;
  }

  async approve(body, { ownerId } = {}) {
    this._open();
    text(ownerId, 'ownerId', 200);
    const manifest = await this._manifest(body, ownerId);
    this._open();
    this._assertCurrent(manifest);
    // Retain entered text separately: rebuilding must append credits exactly once.
    const request = this.validatedManifests.get(manifest).request;
    return this.store.create(APPROVALS, { ...manifest, manifest, request, fingerprint: candidateFingerprint(manifest), status: 'approved' });
  }

  async _revalidate(approval) {
    const manifest = await this._manifest(approval.request, approval.ownerId);
    if (candidateFingerprint(manifest) !== approval.fingerprint || candidateFingerprint(approval.manifest) !== approval.fingerprint) conflict('Publication manifest changed; prepare a new final approval');
    this.validatedManifests.get(manifest).approval = approval;
    this._assertCurrent(manifest);
    return manifest;
  }

  async _fresh(approval) {
    try { this._assertCurrent(await this._revalidate(approval)); return true; }
    catch (error) {
      if (error instanceof HttpError && [404, 409].includes(error.status)) return false;
      throw error;
    }
  }

  async publish(approvalId, { ownerId } = {}) {
    this._open();
    const approval = this.store.get(APPROVALS, approvalId);
    this._owner(approval, ownerId);
    this.store.assertEpisodeActive(approval.episodeId);
    if (this._intent(approvalId)) conflict('Publication already has an intent; resume that intent');
    const manifest = await this._revalidate(approval);
    this._open();
    this._assertCurrent(manifest);
    let intent;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      if (this._intent(approvalId)) conflict('Publication already has an intent; resume that intent');
      intent = this.store.save(INTENTS, {
        id: randomUUID(), approvalId, ownerId, episodeId: approval.episodeId,
        channelId: approval.channelId, fingerprint: approval.fingerprint,
        status: 'queued', phase: 'queued', videoId: null, privacyStatus: 'unknown',
        message: 'Publication queued under the final approved manifest', createdAt: now(), updatedAt: now(),
      });
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this._schedule(intent.id);
    return intent;
  }

  async resume(intentId, { ownerId } = {}) {
    this._open();
    const intent = this.store.get(INTENTS, intentId);
    this._owner(intent, ownerId);
    this.store.assertEpisodeActive(intent.episodeId);
    if (intent.status === 'completed' || this.jobs.has(intentId)) return intent;
    if (intent.retryAt && Date.parse(intent.retryAt) > Date.now()) conflict('The provider retry interval has not elapsed');
    const approval = this.store.get(APPROVALS, intent.approvalId);
    this._owner(approval, ownerId);
    if (!await this._fresh(approval)) {
      const saved = intent.videoId ? null : await this._private(intent.id);
      if (!intent.videoId && !saved?.sessionUrl) conflict('Publication approval is stale and no remote identity is available to reconcile');
    }
    this._open();
    clearTimeout(this.polls.get(intent.id));
    this.polls.delete(intent.id);
    this._schedule(intent.id);
    return this.store.get(INTENTS, intent.id);
  }

  state(approvalId) {
    this._open();
    const approval = this.store.get(APPROVALS, approvalId);
    const intent = this._intent(approvalId);
    return intent ? { ...intent, manifest: approval.manifest } : approval;
  }

  list(episodeId) {
    this._open();
    return this.store.list(APPROVALS).filter((approval) => approval.episodeId === episodeId).map((approval) => ({ ...approval, intent: this._intent(approval.id) }));
  }

  _save(intentId, patch) {
    this._open();
    const intent = this.store.get(INTENTS, intentId);
    return this.store.save(INTENTS, { ...intent, ...patch, updatedAt: now() });
  }

  _schedule(intentId) {
    if (this.jobs.has(intentId)) return;
    const job = Promise.resolve().then(() => this._drive(intentId)).catch(() => {
      if (!this.closing && !this.closed) this._save(intentId, { status: 'unknown', privacyStatus: 'unknown', message: 'Publication outcome requires reconciliation of the saved identity' });
    }).finally(() => this.jobs.delete(intentId));
    this.jobs.set(intentId, job);
  }

  _pollProcessing(intentId) {
    if (this.closing || this.closed || this.polls.has(intentId)) return;
    const intent = this.store.get(INTENTS, intentId);
    if (Date.now() - Date.parse(intent.createdAt) > 30 * 60 * 1000) {
      this._save(intentId, { status: 'blocked', message: 'Processing observation window ended; resume the same video identity later' });
      return;
    }
    const timer = setTimeout(() => {
      this.polls.delete(intentId);
      if (!this.closing && !this.closed) this._schedule(intentId);
    }, 1000);
    timer.unref?.();
    this.polls.set(intentId, timer);
  }

  async _fetch(url, options, channelId, beforeSend, episodeId) {
    this._open();
    if (episodeId) this.store.assertEpisodeActive(episodeId);
    const target = trustedUrl(url);
    if (!this.oauth || typeof this.oauth.accessToken !== 'function') throw new HttpError(503, 'Channel OAuth is not configured');
    const token = await this.oauth.accessToken(channelId);
    const manifest = beforeSend ? await beforeSend() : null;
    this._open();
    if (episodeId) this.store.assertEpisodeActive(episodeId);
    // This check runs in the dispatch turn, after OAuth and all validation promises.
    if (manifest) this._assertCurrent(manifest);
    // Keep the abort signal alive through response-body reads as well as response headers.
    const signal = AbortSignal.any([this.abortController.signal, AbortSignal.timeout(60000)]);
    const response = await this.fetchImpl(target, { ...options, redirect: 'manual', signal, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    if (response.redirected || (response.status >= 300 && response.status < 400 && response.status !== 308)) throw new HttpError(502, 'Google redirects are not permitted');
    return response;
  }

  _failure(intentId, response, phase) {
    const restricted = response.status === 403;
    this._save(intentId, {
      status: restricted ? 'private_restricted' : response.status === 429 ? 'blocked' : 'unknown',
      phase, privacyStatus: 'unknown', providerStatus: response.status, retryAt: retryAt(response),
      message: restricted ? 'Provider blocked publication; API project audit or permission review may be required' : response.status === 429 ? 'Provider rate limit requires a later reconciliation' : 'Provider outcome requires reconciliation of the saved identity',
    });
  }

  async _videoId(intentId, response) {
    const result = await jsonResponse(response);
    if (typeof result.id !== 'string' || !/^[\w-]{1,128}$/.test(result.id)) conflict('Provider completion did not return a usable video identity');
    const prior = this.store.get(INTENTS, intentId);
    if (prior.videoId && prior.videoId !== result.id) conflict('Provider returned a different video identity');
    this._save(intentId, { videoId: result.id, phase: 'private_readback', status: 'running', privacyStatus: 'unknown', retryAt: null });
    return result.id;
  }

  _offset(response, total) {
    const range = response.headers.get('range');
    if (!range) return 0;
    const match = /^bytes=0-(\d+)$/.exec(range);
    const next = match && Number(match[1]) + 1;
    if (!Number.isSafeInteger(next) || next < 1 || next > total) conflict('Provider returned an invalid resumable byte range');
    return next;
  }

  async _upload(intentId, approval, fresh) {
    const manifest = approval.manifest;
    if (fresh) {
      // A second service/process must observe the durable claim before either can await
      // OAuth or initiate an insert. An interrupted claim is reconciled, never replayed.
      this._open();
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        fresh = this.store.get(INTENTS, intentId).phase === 'queued';
        if (fresh) this._save(intentId, { status: 'running', phase: 'initiating', privacyStatus: 'unknown' });
        this.store.db.exec('COMMIT');
      } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    }
    let saved = await this._private(intentId);
    if (fresh) {
      if (saved?.sessionUrl) conflict('A resumable session already exists for this intent');
      const response = await this._fetch(INSERT, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(manifest.render.size), 'X-Upload-Content-Type': 'video/mp4' },
        body: JSON.stringify({ snippet: this._snippet(manifest), status: this._status(manifest, 'private') }),
      }, manifest.channelId, () => this._revalidate(approval), approval.episodeId);
      if (response.status !== 200) { this._failure(intentId, response, 'initiating'); return null; }
      const sessionUrl = trustedUrl(response.headers.get('location'), true);
      saved = { sessionUrl, total: manifest.render.size };
      // Commit encrypted session identity before the first byte leaves this process.
      await this._private(intentId, saved);
      this._save(intentId, { phase: 'transferring', status: 'running' });
    }
    if (!saved?.sessionUrl || saved.total !== manifest.render.size) {
      this._save(intentId, { status: 'blocked', privacyStatus: 'unknown', message: 'Upload identity is unavailable; reconcile manually without creating another insert' });
      return null;
    }
    const session = trustedUrl(saved.sessionUrl, true);
    let offset = 0;
    if (!fresh) {
      this._save(intentId, { status: 'running', phase: 'reconciling_upload', privacyStatus: 'unknown' });
      const response = await this._fetch(session, { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${saved.total}` } }, manifest.channelId, undefined, approval.episodeId);
      if ([200, 201].includes(response.status)) return this._videoId(intentId, response);
      if (response.status !== 308) { this._failure(intentId, response, 'reconciling_upload'); return null; }
      offset = this._offset(response, saved.total);
      const delay = retryAt(response);
      if (delay && Date.parse(delay) > Date.now()) {
        this._save(intentId, { status: 'blocked', retryAt: delay, message: 'Provider requested a delay before resuming the saved upload' });
        return null;
      }
    }
    // Read and hash the exact bytes to be sent; metadata never substitutes for actual bytes.
    const bytes = await this._export(manifest.render, manifest.render.sha256);
    while (offset < bytes.length) {
      this._open();
      const end = Math.min(offset + CHUNK_BYTES, bytes.length);
      this._save(intentId, { phase: 'transferring', status: 'running' });
      const response = await this._fetch(session, {
        method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(end - offset), 'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}` }, body: bytes.subarray(offset, end),
      }, manifest.channelId, () => this._revalidate(approval), approval.episodeId);
      if ([200, 201].includes(response.status)) {
        const id = await this._videoId(intentId, response);
        if (end !== bytes.length) {
          this._save(intentId, { status: 'blocked', transferIncomplete: true, privacyStatus: 'unknown', message: 'Provider reported completion before all approved bytes were transferred; reconcile the known video identity' });
          return null;
        }
        return id;
      }
      if (response.status !== 308) { this._failure(intentId, response, 'transferring'); return null; }
      const next = this._offset(response, bytes.length);
      if (next <= offset || next > end) conflict('Provider upload progress is inconsistent; query the saved session before retry');
      offset = next;
      const delay = retryAt(response);
      if (delay && Date.parse(delay) > Date.now()) {
        this._save(intentId, { status: 'blocked', retryAt: delay, message: 'Provider requested a delay before continuing the saved upload' });
        return null;
      }
    }
    this._save(intentId, { status: 'unknown', message: 'All bytes acknowledged without a completion identity; query the saved session' });
    return null;
  }

  _snippet(manifest) {
    return { title: manifest.title, description: manifest.description, categoryId: manifest.categoryId, tags: manifest.tags };
  }

  _status(manifest, privacyStatus, prior = {}) {
    const status = { privacyStatus, selfDeclaredMadeForKids: manifest.selfDeclaredMadeForKids, containsSyntheticMedia: manifest.containsSyntheticMedia };
    for (const key of ['license', 'embeddable', 'publicStatsViewable']) if (Object.hasOwn(prior, key)) status[key] = prior[key];
    return status;
  }

  async _readback(intentId, approval) {
    const intent = this.store.get(INTENTS, intentId);
    const response = await this._fetch(`${VIDEOS}?part=snippet,status,processingDetails&id=${encodeURIComponent(intent.videoId)}`, { method: 'GET' }, approval.channelId, undefined, approval.episodeId);
    if (!response.ok) { this._failure(intentId, response, intent.phase); return null; }
    const result = await jsonResponse(response);
    const matches = Array.isArray(result.items) ? result.items.filter((item) => item.id === intent.videoId) : [];
    if (matches.length !== 1) {
      this._save(intentId, { status: 'unknown', privacyStatus: 'unknown', message: 'Owner readback did not identify exactly one matching video' });
      return null;
    }
    return matches[0];
  }

  _evidence(intentId, approval, video) {
    const manifest = approval.manifest;
    const privacy = video.status?.privacyStatus;
    const observed = ['private', 'unlisted', 'public'].includes(privacy) ? privacy : 'unknown';
    const fail = (status, message) => {
      this._save(intentId, { status, privacyStatus: observed, message });
      return false;
    };
    if (video.snippet?.channelId !== manifest.channelExternalId) return fail('blocked', 'Readback channel does not match the approved destination');
    for (const key of ['selfDeclaredMadeForKids', 'containsSyntheticMedia']) {
      if (typeof video.status?.[key] !== 'boolean') return fail('unknown', `Readback omitted explicit ${key} evidence`);
      if (video.status[key] !== manifest[key]) return fail('blocked', `Readback ${key} differs from final approval`);
    }
    const snippet = this._snippet(manifest);
    for (const key of ['title', 'description', 'categoryId']) {
      if (typeof video.snippet?.[key] !== 'string') return fail('unknown', `Readback omitted approved ${key} metadata`);
      if (video.snippet[key] !== snippet[key]) return fail('blocked', `Readback ${key} differs from final approval`);
    }
    // An empty tag list may be omitted by YouTube; nonempty approved tags need evidence.
    if (manifest.tags.length && !Array.isArray(video.snippet.tags)) return fail('unknown', 'Readback omitted approved tags');
    if (canonicalJson([...(video.snippet.tags || [])].sort()) !== canonicalJson([...manifest.tags].sort())) return fail('blocked', 'Readback tags differ from final approval');
    if (['deleted', 'failed', 'rejected'].includes(video.status?.uploadStatus) || video.processingDetails?.processingStatus === 'failed') return fail('blocked', 'Provider processing failed');
    if (video.processingDetails?.processingStatus !== 'succeeded') {
      const processing = video.processingDetails?.processingStatus === 'processing';
      fail(processing ? 'processing' : 'unknown', 'Successful processing has not been verified');
      if (processing) this._pollProcessing(intentId);
      return false;
    }
    if (observed === 'unknown') return fail('unknown', 'Readback omitted visibility evidence');
    if (video.status.publishAt !== undefined) return fail('blocked', 'Scheduled publication is outside this approval');
    return true;
  }

  async _finish(intentId, approval, video) {
    if (!this._evidence(intentId, approval, video)) return false;
    if (video.status.privacyStatus !== 'public') {
      this._save(intentId, { status: video.status.privacyStatus === 'private' ? 'private_restricted' : 'blocked', privacyStatus: video.status.privacyStatus, message: 'Owner readback confirms the video is not public; resume the same video identity' });
      return false;
    }
    this._assertCurrent(await this._revalidate(approval));
    this._save(intentId, { status: 'completed', phase: 'completed', privacyStatus: 'public', verifiedAt: now(), retryAt: null, message: 'Owner readback verified public visibility and the complete approved manifest' });
    await this._private(intentId, null);
    return true;
  }

  async _reconcileStale(intentId, approval) {
    const stale = (patch = {}) => this._save(intentId, {
      status: 'blocked', phase: 'stale_approval', approvalStatus: 'stale',
      privacyStatus: 'unknown', message: 'Final approval is stale; only the saved remote identity may be observed',
      ...patch,
    });
    stale();
    try {
      let intent = this.store.get(INTENTS, intentId);
      if (!intent.videoId) {
        const saved = await this._private(intentId);
        if (!saved?.sessionUrl || saved.total !== approval.manifest.render.size) {
          stale({ message: 'Final approval is stale and upload identity is unavailable; no new insert is permitted' });
          return;
        }
        // A zero-byte status query observes the persisted session. Never send missing
        // media bytes, initiate another insert, or change visibility on this path.
        const response = await this._fetch(trustedUrl(saved.sessionUrl, true), {
          method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${saved.total}` },
        }, approval.channelId, undefined, approval.episodeId);
        if ([200, 201].includes(response.status)) await this._videoId(intentId, response);
        else {
          stale({ status: response.status === 308 ? 'blocked' : 'unknown', providerStatus: response.status, retryAt: retryAt(response), message: response.status === 308 ? 'Final approval is stale; the known session is incomplete and byte transfer remains blocked' : 'Final approval is stale; the known session outcome remains unknown' });
          return;
        }
        intent = this.store.get(INTENTS, intentId);
      }
      const video = await this._readback(intentId, approval);
      if (!video) { stale({ status: 'unknown', message: 'Final approval is stale; owner readback of the saved video is unavailable' }); return; }
      const privacy = video.status?.privacyStatus;
      stale({
        videoId: intent.videoId,
        privacyStatus: ['private', 'unlisted', 'public'].includes(privacy) ? privacy : 'unknown',
        observedAt: now(),
        message: video.snippet?.channelId === approval.manifest.channelExternalId
          ? 'Owner readback observed the saved video; final approval is stale and the changed project is not complete'
          : 'Final approval is stale; saved video readback does not verify the approved destination',
      });
    } catch {
      if (!this.closing && !this.closed) stale({ status: 'unknown', message: 'Final approval is stale; observation of the saved remote identity remains unavailable' });
    }
  }

  async _drive(intentId) {
    this._open();
    let intent = this.store.get(INTENTS, intentId);
    const approval = this.store.get(APPROVALS, intent.approvalId);
    this.store.assertEpisodeActive(intent.episodeId);
    try {
      if (!await this._fresh(approval)) { await this._reconcileStale(intentId, approval); return; }
      const fresh = intent.phase === 'queued';
      if (!intent.videoId) {
        if (!await this._upload(intentId, approval, fresh)) return;
        intent = this.store.get(INTENTS, intentId);
      }
      // After restart or any uncertain public response, inspect the known ID first.
      this._save(intentId, { status: 'running', phase: 'private_readback', privacyStatus: 'unknown' });
      const video = await this._readback(intentId, approval);
      if (!video || !this._evidence(intentId, approval, video)) return;
      if (this.store.get(INTENTS, intentId).transferIncomplete) {
        this._save(intentId, { status: 'blocked', privacyStatus: video.status.privacyStatus, message: 'The known video has incomplete byte-transfer evidence; automatic publication remains blocked' });
        return;
      }
      if (video.status.privacyStatus === 'public') { await this._finish(intentId, approval, video); return; }
      if (video.status.privacyStatus !== 'private') {
        this._save(intentId, { status: 'blocked', privacyStatus: video.status.privacyStatus, message: 'Only the verified private video may transition to public' });
        return;
      }
      await this._revalidate(approval);
      this._save(intentId, { status: 'running', phase: 'public_update', privacyStatus: 'unknown' });
      let updateResponse = null;
      try {
        updateResponse = await this._fetch(`${VIDEOS}?part=status`, { method: 'PUT', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ id: intent.videoId, status: this._status(approval.manifest, 'public', video.status) }) }, approval.channelId, () => this._revalidate(approval), approval.episodeId);
      } catch (error) {
        this._open();
        if (error instanceof HttpError && error.status === 409) throw error;
        // Transport exceptions cannot establish whether the public transition happened.
      }
      this._save(intentId, { phase: 'public_readback', status: 'running', privacyStatus: 'unknown' });
      const finalVideo = await this._readback(intentId, approval);
      if (!finalVideo) return;
      if (updateResponse && !updateResponse.ok && finalVideo.status?.privacyStatus !== 'public') {
        if (!this._evidence(intentId, approval, finalVideo)) return;
        this._save(intentId, { status: updateResponse.status === 403 ? 'private_restricted' : 'blocked', privacyStatus: finalVideo.status.privacyStatus, providerStatus: updateResponse.status, retryAt: retryAt(updateResponse), message: 'Provider rejected the public transition; owner readback confirms the current visibility' });
        return;
      }
      await this._finish(intentId, approval, finalVideo);
    } catch (error) {
      if (this.closing || this.closed) return;
      if (error instanceof HttpError && [404, 409].includes(error.status)) {
        try {
          if (!await this._fresh(approval)) { await this._reconcileStale(intentId, approval); return; }
        } catch { /* Preserve recovery identity and report the unavailable observation below. */ }
        if (this.closing || this.closed) return;
      }
      // Keep opaque URL-bearing errors out of records, including native fetch exceptions.
      this._save(intentId, {
        status: error instanceof HttpError && [409, 503].includes(error.status) ? 'blocked' : 'unknown', privacyStatus: 'unknown',
        message: error instanceof HttpError && error.status === 409 ? 'Approved candidate or recovery evidence changed; reconciliation is required' : error instanceof HttpError && error.status === 503 ? 'Channel OAuth or encrypted runtime storage is unavailable; reconcile the saved identity after configuration is restored' : 'Publication outcome is uncertain; resume the saved session or video identity',
      });
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.abortController.abort();
    for (const timer of this.polls.values()) clearTimeout(timer);
    this.polls.clear();
    this.closePromise = Promise.allSettled([...this.jobs.values(), this.privateQueue]).then(() => { this.closed = true; });
    return this.closePromise;
  }
}
