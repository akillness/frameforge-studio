import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { HttpError, scenes as validateScenes } from './validation.mjs';

const now = () => new Date().toISOString();
export const entity = (fields) => ({ id: randomUUID(), createdAt: now(), updatedAt: now(), ...fields });
export const starterScene = (title, text, background = '#282544') => ({ id: randomUUID(), title, text, duration: 5, background, kind: 'title', layout: 'center', narration: '' });

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
  history(id) { this.get('episodes', id); return this.db.prepare('SELECT data FROM history WHERE episode_id=? ORDER BY version DESC').all(id).map((row) => JSON.parse(row.data)); }

  workflowSnapshot(workflow, reason) {
    const entry = { id: randomUUID(), workflowId: workflow.id, version: workflow.version, reason, createdAt: now(), snapshot: workflow };
    this.db.prepare('INSERT INTO workflow_history(workflow_id,version,data) VALUES (?,?,?)').run(workflow.id, workflow.version, JSON.stringify(entry));
  }

  workflowHistory(id) { this.get('workflows', id); return this.db.prepare('SELECT data FROM workflow_history WHERE workflow_id=? ORDER BY version DESC').all(id).map((row) => JSON.parse(row.data)); }

  updateWorkflow(id, patch, expectedVersion) {
    this.db.exec('BEGIN IMMEDIATE');
    let next;
    try {
      const previous = this.get('workflows', id);
      if (expectedVersion !== undefined && previous.version !== expectedVersion) throw new HttpError(409, `Workflow changed: current version is ${previous.version}. Reload before saving.`);
      next = { ...previous, ...patch, version: previous.version + 1, updatedAt: now() };
      this.save('workflows', next);
      this.workflowSnapshot(next, 'edited');
      this.record('workflows.updated', { entityId: id, version: next.version });
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
