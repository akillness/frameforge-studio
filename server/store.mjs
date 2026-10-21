import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { HttpError, object, text, scenes as validateScenes } from './validation.mjs';

const DEFAULT_TREND_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TREND_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_TREND_MAX_CONCURRENCY = 2;
const MIN_TREND_RETENTION_MS = DEFAULT_TREND_RETENTION_MS;
const now = () => new Date().toISOString();
const recordToken = (record) => createHash('sha256').update(JSON.stringify(record)).digest('hex');
const trendDate = (value, fallback = now()) => {
  const parsed = new Date(value || fallback);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
};
const boundedNumber = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;
const boundedText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const cloneJson = (value, max = 200000) => {
  try {
    const json = JSON.stringify(value);
    return json.length > max ? undefined : JSON.parse(json);
  } catch { return undefined; }
};
export const entity = (fields) => ({ id: randomUUID(), createdAt: now(), updatedAt: now(), ...fields });
export const starterScene = (title, text, background = '#282544') => ({ id: randomUUID(), title, text, duration: 5, background, kind: 'title', layout: 'center', narration: '' });

const generationOutput = (upload) => ({ uploadId: upload.id, url: upload.url, type: upload.type, kind: upload.kind, size: upload.size, sha256: upload.sha256, width: upload.width, height: upload.height, ...(upload.duration ? { duration: upload.duration } : {}), ...(upload.codecName ? { codecName: upload.codecName, pixelFormat: upload.pixelFormat, audioCodec: upload.audioCodec } : {}), ...(upload.variant ? { variant: upload.variant } : {}), ...(upload.normalized ? { normalized: true, original: upload.provenance.original } : {}) });

function validateGenerationUploads(id, uploads) {
  if (!Array.isArray(uploads) || !uploads.length || uploads.length > 8 || !uploads.some((upload) => upload.variant !== 'original') || uploads.filter((upload) => upload.variant !== 'original').length > 4) throw new HttpError(400, 'Generation requires 1–4 outputs and at most 4 preserved originals');
  const ids = new Set();
  for (const upload of uploads) {
    if (!upload || !/^[a-f0-9-]{36}$/.test(upload.id || '') || ids.has(upload.id) || !new RegExp(`^${upload.id}\\.(png|jpg|webp|mp4|mov)$`).test(upload.filename || '') || upload.url !== `/api/uploads/${upload.filename}` || !/^(image|video)\//.test(upload.type || '') || !/^[a-f0-9]{64}$/.test(upload.sha256 || '') || upload.generationJobId !== id) throw new HttpError(400, 'Invalid generated upload');
    ids.add(upload.id);
  }
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    for (const directory of ['', 'uploads', 'exports', 'knowledge', 'knowledge/atoms']) mkdirSync(join(dataDir, directory), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, episode_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(episode_id,version));
      CREATE INDEX IF NOT EXISTS history_episode ON history(episode_id,version);
      CREATE TABLE IF NOT EXISTS workflow_history (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(workflow_id,version));
      CREATE TABLE IF NOT EXISTS workflow_reviews (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entities_trend_captured ON entities(kind, json_extract(data, '$.capturedAt'));
      CREATE INDEX IF NOT EXISTS entities_trend_runs ON entities(kind, json_extract(data, '$.startedAt'));`); 
    if (!this.db.prepare('SELECT value FROM settings WHERE key = ?').get('seeded')) this.seed();
    for (const job of this.list('jobs')) if (['queued', 'running'].includes(job.status)) this.save('jobs', { ...job, status: 'failed', error: 'Server restarted before render completed', updatedAt: now() });
    const restartAt = now();
    const trendSettings = this.getTrendCollectorSettings();
    const trendRetryAt = new Date(Date.parse(restartAt) + trendSettings.intervalMs).toISOString();
    const interruptedTrends = this.list('trendCollectionRuns').filter((run) => run.status === 'running');
    for (const run of interruptedTrends) this.save('trendCollectionRuns', { ...run, status: 'failed', completedAt: restartAt, nextDueAt: trendRetryAt, error: 'Server restarted before trend collection completed', updatedAt: restartAt });
    if (interruptedTrends.length && trendSettings.enabled) this.saveTrendCollectorSettings({ nextDueAt: trendRetryAt });
    this.exportKnowledge();
  }

  seed() {
    this.db.exec('BEGIN');
    try {
      this.save('channels', entity({ name: '예제 워크스페이스 · 실제 채널 아님', category: 'information', platform: 'YouTube', sample: true, accountEmail: '', externalId: '' }));
      for (const [category, name, titles] of [
        ['drama', '드라마 · 갈등과 반전', ['한 문장 훅', '인물의 선택', '뜻밖의 결말']],
        ['reenactment', '재연 · 상황과 해설', ['상황 제시', '장면 재연', '사실과 각색 구분']],
        ['information', '정보 · 질문과 근거', ['궁금증 제시', '출처와 핵심 근거', '요약과 다음 행동']],
      ]) this.save('templates', entity({ name, category, format: '9:16', scenes: titles.map((title) => starterScene(title, `${title} 내용을 작성하세요`)), sample: true }));
      this.db.prepare('INSERT INTO settings VALUES (?, ?)').run('seeded', '1');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  list(kind) { return this.db.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid DESC').all(kind).map((row) => JSON.parse(row.data)); }
  get(kind, id) {
    const row = this.db.prepare('SELECT data FROM entities WHERE kind = ? AND id = ?').get(kind, id);
    if (!row) throw new HttpError(404, `${kind} item not found`);
    return JSON.parse(row.data);
  }
  listWorkflowRunHistory({ page = 1, limit = 20, query = '' } = {}) {
    const offset = (page - 1) * limit;
    const where = query ? ' AND instr(lower(data), lower(?)) > 0' : '';
    const params = query ? ['workflowRuns', query] : ['workflowRuns'];
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM entities WHERE kind = ?${where}`).get(...params).count);
    const rows = this.db.prepare(`SELECT data FROM entities WHERE kind = ?${where} ORDER BY json_extract(data, '$.createdAt') DESC, rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const items = rows.map(({ data }) => {
      const run = JSON.parse(data);
      return {
        id: run.id,
        workflowId: run.workflowId,
        workflowName: run.workflowSnapshot?.name || '',
        workflowVersion: run.workflowVersion,
        episodeId: run.episodeId,
        episodeTitle: run.episodeSnapshot?.title || '',
        episodeVersion: run.episodeVersion,
        selectedStages: Array.isArray(run.selectedStages) ? run.selectedStages : [],
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        nodeRuns: Array.isArray(run.nodeRuns) ? run.nodeRuns.map(({ nodeId, type, status }) => ({ nodeId, type, status })) : [],
      };
    });
    return { items, total, page, pageSize: limit, pageCount: Math.ceil(total / limit) };
  }
  save(kind, item) {
    this.db.prepare('INSERT INTO entities(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, item.id, JSON.stringify(item));
    return item;
  }
  record(type, details = {}) { return this.save('events', entity({ type, ...details })); }
  *iterate(kind) {
    for (const row of this.db.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid DESC').iterate(kind)) yield JSON.parse(row.data);
  }

  getTrendCollectorSettings() {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('trendCollector');
    let stored = {};
    try { stored = row ? JSON.parse(row.value) : {}; } catch { stored = {}; }
    return {
      enabled: stored.enabled === true,
      intervalMs: boundedNumber(stored.intervalMs, DEFAULT_TREND_INTERVAL_MS, 60 * 1000, 30 * 24 * 60 * 60 * 1000),
      retentionMs: boundedNumber(stored.retentionMs, DEFAULT_TREND_RETENTION_MS, MIN_TREND_RETENTION_MS, 90 * 24 * 60 * 60 * 1000),
      maxConcurrency: boundedNumber(stored.maxConcurrency, DEFAULT_TREND_MAX_CONCURRENCY, 1, 8),
      nextDueAt: stored.nextDueAt && Number.isFinite(Date.parse(stored.nextDueAt)) ? new Date(stored.nextDueAt).toISOString() : null,
      selectedKeywords: Array.isArray(stored.selectedKeywords) ? [...new Set(stored.selectedKeywords.map((value) => boundedText(value, 300)).filter(Boolean))].slice(0, 500) : [],
    };
  }

  saveTrendCollectorSettings(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'Invalid trend collector settings');
    const current = this.getTrendCollectorSettings();
    if (patch.retentionMs !== undefined && Number.isFinite(Number(patch.retentionMs)) && Number(patch.retentionMs) < MIN_TREND_RETENTION_MS) throw new HttpError(400, 'Trend retention must be at least 14 days');
    const next = { ...current, ...patch };
    next.enabled = next.enabled === true;
    next.intervalMs = boundedNumber(next.intervalMs, current.intervalMs, 60 * 1000, 30 * 24 * 60 * 60 * 1000);
    next.retentionMs = boundedNumber(next.retentionMs, current.retentionMs, MIN_TREND_RETENTION_MS, 90 * 24 * 60 * 60 * 1000);
    next.maxConcurrency = boundedNumber(next.maxConcurrency, current.maxConcurrency, 1, 8);
    next.nextDueAt = next.nextDueAt && Number.isFinite(Date.parse(next.nextDueAt)) ? new Date(next.nextDueAt).toISOString() : null;
    next.selectedKeywords = Array.isArray(next.selectedKeywords) ? [...new Set(next.selectedKeywords.map((value) => boundedText(value, 300)).filter(Boolean))].slice(0, 500) : current.selectedKeywords;
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('trendCollector', JSON.stringify(next));
    return next;
  }

  collectTrendSnapshot(result = {}, { now: capturedNow = now(), runId } = {}) {
    const trends = Array.isArray(result.trends) ? result.trends : [];
    const sources = cloneJson(Array.isArray(result.sources) ? result.sources : [], 200000) || [];
    const settings = this.getTrendCollectorSettings();
    const selected = new Set(settings.selectedKeywords);
    const captured = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of trends.slice(0, 200)) {
        const keyword = boundedText(item?.keyword, 300);
        if (!keyword) continue;
        const source = boundedText(item?.source, 100) || boundedText(sources.find((entry) => entry?.name)?.name, 100) || 'unknown';
        const capturedAt = trendDate(item?.capturedAt, capturedNow);
        const fields = { keyword, source, capturedAt, collectedAt: capturedNow, selected: selected.has(keyword), ...(runId ? { runId } : {}) };
        if (typeof item.url === 'string' && item.url.trim()) fields.url = item.url.trim().slice(0, 2000);
        for (const key of ['relatedMedia', 'media', 'mediaUrl', 'imageUrl', 'videoUrl', 'thumbnailUrl', 'mediaType', 'mediaTitle', 'description', 'metadata']) {
          const value = item[key];
          if (value === undefined || value === null || value === '') continue;
          const copy = cloneJson(value, key === 'relatedMedia' || key === 'media' ? 100000 : 20000);
          if (copy !== undefined) fields[key] = Array.isArray(copy) ? copy.slice(0, 20) : copy;
        }
        const trend = entity(fields);
        this.save('trends', trend);
        captured.push(trend);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { trends: captured, sources };
  }

  _trendKeywordRows({ query, selected, since, limit, offset, popular = false } = {}) {
    const boundedLimit = boundedNumber(limit, 50, 1, 200);
    const boundedOffset = boundedNumber(offset, 0, 0, 10000);
    const clauses = ["kind = 'trends'"];
    const params = [];
    let sinceIso;
    if (query) { clauses.push("lower(json_extract(data, '$.keyword')) LIKE ?"); params.push(`%${String(query).toLocaleLowerCase()}%`); }
    if (since) {
      if (!Number.isFinite(Date.parse(since))) throw new HttpError(400, 'Invalid trend since date');
      sinceIso = new Date(since).toISOString();
      clauses.push("json_extract(data, '$.capturedAt') >= ?"); params.push(sinceIso);
    }
    if (selected === true) clauses.push("json_extract(data, '$.selected') = 1");
    if (selected === false) clauses.push("COALESCE(json_extract(data, '$.selected'), 0) = 0");
    const order = popular ? 'count DESC, firstRowId ASC' : 'firstRowId ASC';
    const rows = this.db.prepare(`SELECT json_extract(data, '$.keyword') AS keyword, COUNT(*) AS count, MAX(json_extract(data, '$.capturedAt')) AS latestCapturedAt, MIN(rowid) AS firstRowId FROM entities WHERE ${clauses.join(' AND ')} GROUP BY json_extract(data, '$.keyword') ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, boundedLimit, boundedOffset);
    return rows.map((row) => {
      const latest = sinceIso ? this.db.prepare("SELECT data FROM entities WHERE kind='trends' AND json_extract(data, '$.keyword')=? AND json_extract(data, '$.capturedAt')>=? ORDER BY rowid DESC LIMIT 1").get(row.keyword, sinceIso) : this.db.prepare("SELECT data FROM entities WHERE kind='trends' AND json_extract(data, '$.keyword')=? ORDER BY rowid DESC LIMIT 1").get(row.keyword);
      let detail = {};
      try { detail = latest ? JSON.parse(latest.data) : {}; } catch { detail = {}; }
      return { keyword: row.keyword, count: Number(row.count), capturedAt: row.latestCapturedAt, latestCapturedAt: row.latestCapturedAt, selected: detail.selected === true, ...(detail.source ? { source: detail.source } : {}), ...(detail.url ? { url: detail.url } : {}), ...(detail.relatedMedia ? { relatedMedia: detail.relatedMedia } : {}) };
    });
  }

  listTrendKeywords(options = {}) { return this._trendKeywordRows(options); }
  listPopularTrendKeywords(options = {}) { return this._trendKeywordRows({ ...options, popular: true }); }

  setTrendKeywordSelection(keyword, selected) {
    const value = boundedText(keyword, 300);
    if (!value) throw new HttpError(400, 'Keyword is required');
    const settings = this.getTrendCollectorSettings();
    const selectedKeywords = new Set(settings.selectedKeywords);
    if (selected === true) selectedKeywords.add(value); else selectedKeywords.delete(value);
    const next = this.saveTrendCollectorSettings({ selectedKeywords: [...selectedKeywords] });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare("SELECT id, data FROM entities WHERE kind='trends' AND json_extract(data, '$.keyword')=?").all(value);
      for (const row of rows) {
        let item;
        try { item = JSON.parse(row.data); } catch { continue; }
        this.save('trends', { ...item, selected: selected === true, updatedAt: now() });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return next;
  }

  listTrendCollectionRuns({ limit = 50 } = {}) {
    const boundedLimit = boundedNumber(limit, 50, 1, 200);
    return this.db.prepare("SELECT data FROM entities WHERE kind='trendCollectionRuns' ORDER BY rowid DESC LIMIT ?").all(boundedLimit).map((row) => JSON.parse(row.data));
  }

  _isUploadReferenced(upload) {
    const needles = [upload.id, upload.url, upload.filename].filter(Boolean);
    for (const row of this.db.prepare("SELECT data FROM entities WHERE kind NOT IN ('uploads', 'events')").iterate()) {
      if (needles.some((needle) => row.data.includes(needle))) return true;
    }
    for (const table of ['history', 'workflow_history', 'workflow_reviews']) {
      for (const row of this.db.prepare(`SELECT data FROM ${table}`).iterate()) if (needles.some((needle) => row.data.includes(needle))) return true;
    }
    return false;
  }

  pruneTrendRetention({ now: pruneNow = now() } = {}) {
    const settings = this.getTrendCollectorSettings();
    const pruneTime = Date.parse(pruneNow);
    if (!Number.isFinite(pruneTime)) throw new HttpError(400, 'Invalid trend retention time');
    const cutoff = new Date(pruneTime - settings.retentionMs).toISOString();
    let removed = 0, removedMedia = 0;
    const files = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const trends = this.db.prepare("SELECT id FROM entities WHERE kind='trends' AND json_extract(data, '$.capturedAt') < ?").all(cutoff);
      for (const trend of trends) { this.db.prepare("DELETE FROM entities WHERE kind='trends' AND id=?").run(trend.id); removed += 1; }
      const uploads = [...this.iterate('uploads')].filter((upload) => upload.trend === true && Number.isFinite(Date.parse(upload.createdAt || '')) && Date.parse(upload.createdAt || '') < Date.parse(cutoff) && !this._isUploadReferenced(upload));
      for (const upload of uploads) {
        this.db.prepare("DELETE FROM entities WHERE kind='uploads' AND id=?").run(upload.id);
        if (typeof upload.filename === 'string' && /^[a-f0-9-]{36}\.[a-z0-9]+$/i.test(upload.filename)) files.push(join(this.dataDir, 'uploads', upload.filename));
        removedMedia += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    let cleanupFailures = 0;
    for (const file of files) {
      try { if (existsSync(file)) unlinkSync(file); } catch { cleanupFailures += 1; }
    }
    if (removed || removedMedia) this.exportKnowledge();
    return { removed, removedMedia, cleanupFailures, cutoff };
  }

  create(kind, fields) {
    const item = entity(fields);
    this.db.exec('BEGIN');
    try {
      this.save(kind, item);
      if (kind === 'episodes') this.snapshot(item, 'created');
      if (kind === 'workflows') this.workflowSnapshot(item, 'created');
      this.record(`${kind}.created`, { entityId: item.id });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.exportKnowledge();
    return item;
  }

  updateEpisode(id, patch, expectedVersion, reason = 'edited') {
    this.db.exec('BEGIN IMMEDIATE');
    let next;
    try {
      const previous = this.get('episodes', id);
      if (expectedVersion !== undefined && previous.version !== expectedVersion) throw new HttpError(409, `Episode changed: current version is ${previous.version}. Reload before saving.`);
      next = { ...previous, ...patch, version: previous.version + 1, updatedAt: now() };
      this.save('episodes', next);
      this.snapshot(next, reason);
      this.record('episodes.updated', { entityId: id, version: next.version, reason, ...(reason === 'knowledge edited' ? { actorRole: 'admin' } : {}) });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.exportKnowledge();
    return next;
  }

  attachNarration(id, sceneList, expectedVersion, uploads) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new HttpError(400, 'Narration requires a positive expectedVersion');
    const normalized = validateScenes(sceneList);
    if (!Array.isArray(uploads) || !uploads.length || uploads.length > 60) throw new HttpError(400, 'Narration requires 1–60 generated uploads');
    const ids = new Set();
    for (const upload of uploads) {
      if (!upload || typeof upload.id !== 'string' || !/^[a-f0-9-]{36}$/.test(upload.id) || ids.has(upload.id) || upload.filename !== `${upload.id}.wav` || upload.url !== `/api/uploads/${upload.filename}` || upload.type !== 'audio/wav') throw new HttpError(400, 'Invalid generated narration upload');
      ids.add(upload.id);
      if (!normalized.some((scene) => scene.audioUrl === upload.url)) throw new HttpError(400, 'Generated narration upload is not attached to a scene');
    }
    this.db.exec('BEGIN IMMEDIATE');
    let next;
    try {
      const previous = this.get('episodes', id);
      if (previous.version !== expectedVersion) throw new HttpError(409, `Episode changed: current version is ${previous.version}. Reload before attaching narration.`);
      const existingIds = new Set();
      const existingFilenames = new Set();
      const audioByUrl = new Map();
      for (const existing of this.iterate('uploads')) {
        existingIds.add(existing.id);
        existingFilenames.add(existing.filename);
        audioByUrl.set(existing.url, existing);
      }
      if (uploads.some((upload) => existingIds.has(upload.id) || existingFilenames.has(upload.filename))) throw new HttpError(409, 'Generated narration upload already exists');
      for (const upload of uploads) audioByUrl.set(upload.url, upload);
      for (const scene of normalized) if (scene.audioUrl && !audioByUrl.get(scene.audioUrl)?.type.startsWith('audio/')) throw new HttpError(400, 'Narration scene refers to unknown audio');
      for (const upload of uploads) this.save('uploads', upload);
      next = { ...previous, scenes: normalized, status: 'draft', version: previous.version + 1, updatedAt: now() };
      this.save('episodes', next);
      this.snapshot(next, 'narration');
      this.record('episodes.narration', { entityId: id, version: next.version, uploadIds: uploads.map((upload) => upload.id) });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try { this.exportKnowledge(); }
    catch (error) { console.error('Narration committed; knowledge export refresh failed:', error.message); }
    return next;
  }

  snapshot(episode, reason) {
    const entry = { id: randomUUID(), episodeId: episode.id, version: episode.version, reason, createdAt: now(), snapshot: episode };
    this.db.prepare('INSERT INTO history(episode_id,version,data) VALUES (?,?,?)').run(episode.id, episode.version, JSON.stringify(entry));
  }

  completeGeneration(id, uploads) {
    validateGenerationUploads(id, uploads);
    this.db.exec('BEGIN IMMEDIATE');
    let next;
    try {
      const job = this.get('generationJobs', id);
      if (job.status !== 'downloading' || !job.providerRequestId) throw new HttpError(409, 'Generation is not awaiting imported output');
      if (uploads.some((upload) => this.db.prepare('SELECT 1 FROM entities WHERE kind=? AND id=?').get('uploads', upload.id))) throw new HttpError(409, 'Generated upload already exists');
      for (const upload of uploads) this.save('uploads', upload);
      next = { ...job, status: 'completed', outputs: uploads.filter((upload) => upload.variant !== 'original').map(generationOutput), completedAt: now(), updatedAt: now() };
      this.save('generationJobs', next);
      this.record('generation.completed', { entityId: job.episodeId, jobId: id, uploadIds: uploads.map((upload) => upload.id) });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try { this.exportKnowledge(); } catch (error) { console.error('Generation imported; knowledge export refresh failed:', error.message); }
    return next;
  }

  normalizeGeneration(id, expectedOutputs, replacements) {
    validateGenerationUploads(id, replacements.map((item) => item.browser));
    this.db.exec('BEGIN IMMEDIATE');
    let next;
    try {
      const job = this.get('generationJobs', id);
      if (job.status !== 'completed' || JSON.stringify(job.outputs) !== JSON.stringify(expectedOutputs)) throw new HttpError(409, 'Generation output changed during normalization');
      const byOriginal = new Map();
      for (const { original, browser } of replacements) {
        const stored = this.get('uploads', original.id);
        if (byOriginal.has(original.id) || stored.generationJobId !== id || stored.sha256 !== original.sha256 || !job.outputs.some((output) => output.uploadId === original.id && output.sha256 === original.sha256) || browser.provenance?.original?.sha256 !== original.sha256 || browser.provenance?.original?.uploadId !== original.id || this.db.prepare('SELECT 1 FROM entities WHERE kind=? AND id=?').get('uploads', browser.id)) throw new HttpError(409, 'Original generation identity changed during normalization');
        this.save('uploads', { ...stored, codecName: original.codecName, pixelFormat: original.pixelFormat, audioCodec: original.audioCodec, variant: 'original' });
        this.save('uploads', browser);
        byOriginal.set(original.id, browser);
      }
      const previousApplication = job.applied ? [{ version: job.appliedVersion, sceneId: job.appliedSceneId, appliedAt: job.appliedAt, outputs: job.outputs }] : [];
      next = { ...job, outputs: job.outputs.map((output) => byOriginal.has(output.uploadId) ? generationOutput(byOriginal.get(output.uploadId)) : output), priorApplications: [...(job.priorApplications || []), ...previousApplication], applied: false, appliedVersion: undefined, appliedSceneId: undefined, appliedAt: undefined, normalizedAt: now(), updatedAt: now() };
      this.save('generationJobs', next);
      this.record('generation.normalized', { entityId: job.episodeId, jobId: id, originalIds: [...byOriginal.keys()], uploadIds: replacements.map((item) => item.browser.id) });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try { this.exportKnowledge(); } catch (error) { console.error('Generation normalized; knowledge export refresh failed:', error.message); }
    return next;
  }

  applyGeneration(id, expectedVersion, sceneId, slotId) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new HttpError(400, 'Applying generation requires a positive expectedVersion');
    this.db.exec('BEGIN IMMEDIATE');
    let episode, applied;
    try {
      const job = this.get('generationJobs', id);
      if (job.status !== 'completed') throw new HttpError(409, 'Generation output is not ready to apply');
      if (job.applied) throw new HttpError(409, 'Generation output has already been applied');
      if (job.sceneId !== sceneId) throw new HttpError(400, 'Generation belongs to a different scene');
      const previous = this.get('episodes', job.episodeId);
      if (previous.version !== expectedVersion) throw new HttpError(409, `Episode changed: current version is ${previous.version}. Reload before applying generation.`);
      const currentScene = previous.scenes.find((scene) => scene.id === sceneId);
      if (!currentScene) throw new HttpError(409, 'The generation target scene no longer exists');
      const output = job.outputs[0], upload = this.get('uploads', output.uploadId);
      if (upload.generationJobId !== id || upload.url !== output.url || upload.sha256 !== output.sha256 || !['image', 'video'].includes(upload.kind)) throw new HttpError(409, 'Generation output identity does not match its imported upload');
      const targetSlotId = slotId || job.slotId;
      const targetSlot = targetSlotId ? currentScene.slots?.find((slot) => slot.id === targetSlotId) : undefined;
      if (targetSlotId && !targetSlot) throw new HttpError(409, 'The generation target slot no longer exists');
      if (targetSlot && ((upload.kind === 'image' && targetSlot.role !== 'image-gen') || (upload.kind === 'video' && targetSlot.role !== 'video-bg'))) throw new HttpError(409, 'Generation output media kind does not match the target slot role');
      const scenes = validateScenes(previous.scenes.map((scene) => {
        if (scene.id !== sceneId) return scene;
        if (targetSlot) {
          const updatedSlots = scene.slots.map((slot) => slot.id === targetSlot.id ? { ...slot, assetUrl: upload.url, mediaKind: upload.kind } : slot);
          return { ...scene, slots: updatedSlots };
        }
        return {
          ...scene,
          kind: upload.kind,
          assetUrl: upload.url,
          trimStart: 0,
          ...(upload.kind === 'video' ? { duration: Math.max(0.5, Math.min(120, upload.duration)) } : {}),
        };
      }));
      episode = { ...previous, scenes, status: 'draft', version: previous.version + 1, updatedAt: now() };
      this.save('episodes', episode);
      this.snapshot(episode, `generation:${id}`);
      applied = { ...job, applied: true, appliedVersion: episode.version, appliedSceneId: sceneId, ...(targetSlotId ? { appliedSlotId: targetSlotId } : {}), appliedAt: now(), updatedAt: now() };
      this.save('generationJobs', applied);
      this.record('generation.applied', { entityId: previous.id, jobId: id, sceneId, ...(targetSlotId ? { slotId: targetSlotId } : {}), version: episode.version });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    try { this.exportKnowledge(); } catch (error) { console.error('Generation committed; knowledge export refresh failed:', error.message); }
    return { job: applied, episode };
  }
  history(id) { this.get('episodes', id); return this.db.prepare('SELECT data FROM history WHERE episode_id=? ORDER BY version DESC').all(id).map((row) => JSON.parse(row.data)); }

  workflowSnapshot(workflow, reason) {
    const entry = { id: randomUUID(), workflowId: workflow.id, version: workflow.version, reason, createdAt: now(), snapshot: workflow };
    this.db.prepare('INSERT INTO workflow_history(workflow_id,version,data) VALUES (?,?,?)').run(workflow.id, workflow.version, JSON.stringify(entry));
  }

  workflowHistory(id) { this.get('workflows', id); return this.db.prepare('SELECT data FROM workflow_history WHERE workflow_id=? ORDER BY version DESC').all(id).map((row) => JSON.parse(row.data)); }

  updateWorkflow(id, patch, expectedVersion, reason = 'edited') {
    this.db.exec('BEGIN IMMEDIATE');
    let next;
    try {
      const previous = this.get('workflows', id);
      if (expectedVersion !== undefined && previous.version !== expectedVersion) throw new HttpError(409, `Workflow changed: current version is ${previous.version}. Reload before saving.`);
      next = { ...previous, ...patch, version: previous.version + 1, updatedAt: now() };
      this.save('workflows', next);
      this.workflowSnapshot(next, reason);
      this.record('workflows.updated', { entityId: id, version: next.version, reason });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return next;
  }

  reviewCandidate(workflowId, runId, expectedEpisodeVersion) {
    const run = this.get('workflowRuns', runId);
    if (run.workflowId !== workflowId) throw new HttpError(404, 'Workflow run not found');
    if (run.status !== 'awaiting_review' || run.review) throw new HttpError(409, 'Only an unreviewed awaiting_review run can receive a decision');
    const episode = this.get('episodes', run.episodeId);
    if (expectedEpisodeVersion !== run.episodeVersion || episode.version !== run.episodeVersion) throw new HttpError(409, 'Episode changed since this render. Render the current version before review.');
    const render = run.nodeRuns.find((node) => node.type === 'render');
    const reviewNode = run.nodeRuns.find((node) => node.type === 'review');
    if (render?.status !== 'completed' || !render.output?.jobId || !render.output?.outputUrl || reviewNode?.status !== 'awaiting_review') throw new HttpError(409, 'Run has no completed render candidate awaiting review');
    const job = this.get('jobs', render.output.jobId);
    if (job.status !== 'completed' || job.episodeId !== episode.id || job.episodeVersion !== run.episodeVersion || job.outputUrl !== render.output.outputUrl || (render.output.episodeVersion !== undefined && render.output.episodeVersion !== run.episodeVersion)) throw new HttpError(409, 'Render candidate does not match the episode version');
    return { run, job, render };
  }

  commitWorkflowReview(workflowId, runId, { decision, notes, expectedEpisodeVersion, jobId, outputUrl, sha256 }) {
    if (!['approved', 'changes_requested'].includes(decision) || typeof notes !== 'string' || notes.length > 10000 || !Number.isInteger(expectedEpisodeVersion) || expectedEpisodeVersion < 1 || !/^[a-f0-9]{64}$/.test(sha256)) throw new HttpError(400, 'Invalid review decision');
    this.db.exec('BEGIN IMMEDIATE');
    let next;
    try {
      const { run, job, render } = this.reviewCandidate(workflowId, runId, expectedEpisodeVersion);
      if (job.id !== jobId || job.outputUrl !== outputUrl || (job.sha256 && job.sha256 !== sha256) || (render.output.sha256 && render.output.sha256 !== sha256)) throw new HttpError(409, 'Rendered artifact changed during review');
      const review = { id: randomUUID(), decision, notes, reviewedAt: now(), workflowId, workflowVersion: run.workflowVersion, runId, episodeId: run.episodeId, episodeVersion: run.episodeVersion, jobId, outputUrl, sha256 };
      this.db.prepare('INSERT INTO workflow_reviews(id,run_id,data) VALUES (?,?,?)').run(review.id, runId, JSON.stringify(review));
      next = { ...run, status: decision, review, updatedAt: review.reviewedAt, nodeRuns: run.nodeRuns.map((node) => node.type === 'review' ? { ...node, status: decision, reviewedAt: review.reviewedAt, review, output: { ...node.output, review } } : node) };
      this.save('workflowRuns', next);
      this.record('workflow.reviewed', { entityId: workflowId, runId, review });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return next;
  }

  workflowReviews(runId) { return this.db.prepare('SELECT data FROM workflow_reviews WHERE run_id=? ORDER BY rowid').all(runId).map((row) => JSON.parse(row.data)); }

  editKnowledgeNode(id, body) {
    object(body);
    const node = this.knowledge().nodes.find((item) => item.id === id);
    if (!node?.editable) throw new HttpError(400, node?.readOnlyReason || 'Unknown or read-only graph node');
    const allowed = node.type === 'channel' ? ['label', 'expectedRecord'] : ['label', 'topic', 'channelId', 'expectedVersion'];
    if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HttpError(400, 'Unsupported graph edit field');
    if (node.type === 'channel') {
      const name = text(body.label, 'label', 160);
      if (typeof body.expectedRecord !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRecord)) throw new HttpError(400, 'expectedRecord is required');
      let next;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const previous = this.get('channels', id);
        if (recordToken(previous) !== body.expectedRecord) throw new HttpError(409, 'Channel changed. Reload before saving.');
        next = { ...previous, name, updatedAt: now() };
        this.save('channels', next);
        this.record('channels.updated', { entityId: id, reason: 'knowledge edited', actorRole: 'admin' });
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.exportKnowledge();
      return next;
    }
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) throw new HttpError(400, 'expectedVersion is required');
    const patch = {};
    if ('label' in body) patch.title = text(body.label, 'label', 200);
    if ('topic' in body) patch.topic = text(body.topic, 'topic', 500);
    if ('channelId' in body) {
      patch.channelId = text(body.channelId, 'channelId', 100);
      if (!this.list('channels').some((channel) => channel.id === patch.channelId)) throw new HttpError(400, 'Unknown target channel');
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'No editable fields supplied');
    return this.updateEpisode(id, patch, body.expectedVersion, 'knowledge edited');
  }

  editKnowledgeEdge(body) {
    object(body);
    if (Object.keys(body).some((key) => !['source', 'target', 'relation', 'newTarget', 'expectedVersion'].includes(key))) throw new HttpError(400, 'Unsupported graph edge field');
    const graph = this.knowledge();
    const edge = graph.edges.find((item) => item.source === body.source && item.target === body.target && item.relation === body.relation);
    if (!edge?.editable) throw new HttpError(400, edge?.readOnlyReason || 'Unknown or read-only graph relation');
    const target = graph.nodes.find((node) => node.id === body.newTarget);
    const field = edge.edit.field;
    if (!target || target.type !== (field === 'channelId' ? 'channel' : 'topic')) throw new HttpError(400, 'Invalid relation target');
    return this.editKnowledgeNode(body.source, { [field]: field === 'topic' ? target.label : target.id, expectedVersion: body.expectedVersion });
  }

  knowledge() {
    const nodes = [], edges = [], atoms = [];
    const nodeIds = new Set();
    const add = (id, type, title, description, timestamp, related = [], resource) => {
      if (nodeIds.has(id)) return;
      nodeIds.add(id);
      nodes.push({ id, type, label: title, title });
      atoms.push({ id, type, title, description, timestamp, tags: ['frameforge', type], ...(resource ? { resource } : {}), related });
      for (const target of related) edges.push({ source: id, target, relation: type === 'episode' ? 'belongs_to' : 'references' });
    };
    for (const channel of this.iterate('channels')) add(channel.id, 'channel', channel.name, `${channel.platform} / ${channel.category}${channel.sample ? ' / example only' : ''}`, channel.updatedAt);
    for (const episode of this.iterate('episodes')) {
      const topicId = `topic-${createHash('sha256').update(episode.topic).digest('hex').slice(0, 20)}`;
      add(topicId, 'topic', episode.topic, `Production subject: ${episode.topic}`, episode.updatedAt);
      add(episode.id, 'episode', episode.title, `${episode.topic} — ${episode.status}; revision ${episode.version}`, episode.updatedAt, [episode.channelId, topicId]);
    }
    for (const reference of this.iterate('references')) add(reference.id, 'reference', reference.title, reference.notes || reference.category, reference.updatedAt, reference.channelId ? [reference.channelId] : [], reference.url);
    for (const trend of this.iterate('trends')) add(trend.id, 'trend', trend.keyword, `Captured from ${trend.source}; ${trend.capturedAt}`, trend.updatedAt, [], trend.url);
    for (const job of this.iterate('generationJobs')) {
      add(job.id, 'generation', `Higgsfield · ${job.model}`, `${job.transport}; ${job.status}; source episode v${job.episodeVersion}${job.applied ? `; applied v${job.appliedVersion}` : '; not applied'}`, job.updatedAt, [job.episodeId]);
      for (const output of job.outputs || []) {
        add(output.uploadId, 'asset', `Generated ${output.kind}`, `Higgsfield ${job.model}; SHA-256 ${output.sha256}`, job.completedAt || job.updatedAt, [job.id, job.episodeId, ...(output.original ? [output.original.uploadId] : [])], output.url);
        if (output.original) add(output.original.uploadId, 'asset', 'Original provider output', `Preserved original; SHA-256 ${output.original.sha256}; ${output.original.codecName || 'unknown codec'}`, job.completedAt || job.updatedAt, [job.id, job.episodeId], output.original.url);
      }
    }
    for (const node of nodes) {
      node.editable = ['channel', 'episode'].includes(node.type);
      if (node.type === 'channel') node.edit = { fields: ['label'], expectedRecord: recordToken(this.get('channels', node.id)) };
      else if (node.type === 'episode') {
        const episode = this.get('episodes', node.id);
        node.edit = { fields: ['label', 'topic', 'channelId'], expectedVersion: episode.version, topic: episode.topic, channelId: episode.channelId };
      } else node.readOnlyReason = node.type === 'topic' ? 'Derived from episode.topic; edit the episode topic instead.' : node.type === 'reference' ? 'Reference updates have no versioned concurrency path.' : 'Derived record; no canonical editable source.';
    }
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const edge of edges) {
      const source = byId.get(edge.source), target = byId.get(edge.target);
      edge.editable = source?.type === 'episode' && edge.relation === 'belongs_to' && ['channel', 'topic'].includes(target?.type);
      if (edge.editable) edge.edit = { expectedVersion: source.edit.expectedVersion, field: target.type === 'channel' ? 'channelId' : 'topic' };
      else edge.readOnlyReason = 'Derived relation; no canonical editable source.';
    }
    return { nodes, edges, atoms };
  }

  exportKnowledge() {
    const graph = this.knowledge();
    const exported = {
      nodes: graph.nodes.map(({ editable, edit, readOnlyReason, ...node }) => node),
      edges: graph.edges.map(({ editable, edit, readOnlyReason, ...edge }) => edge),
      atoms: graph.atoms,
    };
    const root = join(this.dataDir, 'knowledge');
    for (const atom of graph.atoms) {
      const metadata = ['type', 'title', 'description', 'resource', 'tags', 'timestamp'].filter((key) => atom[key] !== undefined).map((key) => `${key}: ${JSON.stringify(atom[key])}`).join('\n');
      const body = `---\n${metadata}\n---\n\n# ${atom.title.replace(/[\r\n]/g, ' ')}\n\n${atom.description}\n\n${atom.related.map((id) => `- [[${id}]]`).join('\n')}\n`;
      writeFileSync(join(root, 'atoms', `${atom.id}.md`), body, { mode: 0o600 });
    }
    const atomIds = new Set(graph.atoms.map((atom) => `${atom.id}.md`));
    for (const file of readdirSync(join(root, 'atoms'))) if (file.endsWith('.md') && !atomIds.has(file)) unlinkSync(join(root, 'atoms', file));
    const temporary = join(root, 'graph.json.tmp');
    writeFileSync(temporary, JSON.stringify(exported, null, 2), { mode: 0o600 });
    renameSync(temporary, join(root, 'graph.json'));
  }
  close() { this.db.close(); }
}
