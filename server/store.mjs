import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { HttpError, scenes as validateScenes } from './validation.mjs';

const now = () => new Date().toISOString();
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
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (!this.db.prepare('SELECT value FROM settings WHERE key = ?').get('seeded')) this.seed();
    for (const job of this.list('jobs')) if (['queued', 'running'].includes(job.status)) this.save('jobs', { ...job, status: 'failed', error: 'Server restarted before render completed', updatedAt: now() });
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
  save(kind, item) {
    this.db.prepare('INSERT INTO entities(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, item.id, JSON.stringify(item));
    return item;
  }
  record(type, details = {}) { return this.save('events', entity({ type, ...details })); }

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
      this.record('episodes.updated', { entityId: id, version: next.version, reason });
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
      const existingUploads = this.list('uploads');
      if (uploads.some((upload) => existingUploads.some((existing) => existing.id === upload.id || existing.filename === upload.filename))) throw new HttpError(409, 'Generated narration upload already exists');
      const audioByUrl = new Map([...existingUploads, ...uploads].map((upload) => [upload.url, upload]));
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

  applyGeneration(id, expectedVersion, sceneId) {
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
      if (!previous.scenes.some((scene) => scene.id === sceneId)) throw new HttpError(409, 'The generation target scene no longer exists');
      const output = job.outputs[0], upload = this.get('uploads', output.uploadId);
      if (upload.generationJobId !== id || upload.url !== output.url || upload.sha256 !== output.sha256 || !['image', 'video'].includes(upload.kind)) throw new HttpError(409, 'Generation output identity does not match its imported upload');
      const scenes = validateScenes(previous.scenes.map((scene) => scene.id === sceneId ? { ...scene, kind: upload.kind, assetUrl: upload.url, trimStart: 0, ...(upload.kind === 'video' ? { duration: Math.max(0.5, Math.min(120, upload.duration)) } : {}) } : scene));
      episode = { ...previous, scenes, status: 'draft', version: previous.version + 1, updatedAt: now() };
      this.save('episodes', episode);
      this.snapshot(episode, `generation:${id}`);
      applied = { ...job, applied: true, appliedVersion: episode.version, appliedSceneId: sceneId, appliedAt: now(), updatedAt: now() };
      this.save('generationJobs', applied);
      this.record('generation.applied', { entityId: previous.id, jobId: id, sceneId, version: episode.version });
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

  knowledge() {
    const nodes = [], edges = [], atoms = [];
    const add = (id, type, title, description, timestamp, related = [], resource) => {
      if (nodes.some((node) => node.id === id)) return;
      nodes.push({ id, type, label: title, title });
      atoms.push({ id, type, title, description, timestamp, tags: ['frameforge', type], ...(resource ? { resource } : {}), related });
      for (const target of related) edges.push({ source: id, target, relation: type === 'episode' ? 'belongs_to' : 'references' });
    };
    for (const channel of this.list('channels')) add(channel.id, 'channel', channel.name, `${channel.platform} / ${channel.category}${channel.sample ? ' / example only' : ''}`, channel.updatedAt);
    for (const episode of this.list('episodes')) {
      const topicId = `topic-${createHash('sha256').update(episode.topic).digest('hex').slice(0, 20)}`;
      add(topicId, 'topic', episode.topic, `Production subject: ${episode.topic}`, episode.updatedAt);
      add(episode.id, 'episode', episode.title, `${episode.topic} — ${episode.status}; revision ${episode.version}`, episode.updatedAt, [episode.channelId, topicId]);
    }
    for (const reference of this.list('references')) add(reference.id, 'reference', reference.title, reference.notes || reference.category, reference.updatedAt, reference.channelId ? [reference.channelId] : [], reference.url);
    for (const trend of this.list('trends')) add(trend.id, 'trend', trend.keyword, `Captured from ${trend.source}; ${trend.capturedAt}`, trend.updatedAt, [], trend.url);
    for (const job of this.list('generationJobs')) {
      add(job.id, 'generation', `Higgsfield · ${job.model}`, `${job.transport}; ${job.status}; source episode v${job.episodeVersion}${job.applied ? `; applied v${job.appliedVersion}` : '; not applied'}`, job.updatedAt, [job.episodeId]);
      for (const output of job.outputs || []) {
        add(output.uploadId, 'asset', `Generated ${output.kind}`, `Higgsfield ${job.model}; SHA-256 ${output.sha256}`, job.completedAt || job.updatedAt, [job.id, job.episodeId, ...(output.original ? [output.original.uploadId] : [])], output.url);
        if (output.original) add(output.original.uploadId, 'asset', 'Original provider output', `Preserved original; SHA-256 ${output.original.sha256}; ${output.original.codecName || 'unknown codec'}`, job.completedAt || job.updatedAt, [job.id, job.episodeId], output.original.url);
      }
    }
    return { nodes, edges, atoms };
  }

  exportKnowledge() {
    const graph = this.knowledge();
    const root = join(this.dataDir, 'knowledge');
    for (const atom of graph.atoms) {
      const metadata = ['type', 'title', 'description', 'resource', 'tags', 'timestamp'].filter((key) => atom[key] !== undefined).map((key) => `${key}: ${JSON.stringify(atom[key])}`).join('\n');
      const body = `---\n${metadata}\n---\n\n# ${atom.title.replace(/[\r\n]/g, ' ')}\n\n${atom.description}\n\n${atom.related.map((id) => `- [[${id}]]`).join('\n')}\n`;
      writeFileSync(join(root, 'atoms', `${atom.id}.md`), body, { mode: 0o600 });
    }
    const temporary = join(root, 'graph.json.tmp');
    writeFileSync(temporary, JSON.stringify(graph, null, 2), { mode: 0o600 });
    renameSync(temporary, join(root, 'graph.json'));
  }
  close() { this.db.close(); }
}
