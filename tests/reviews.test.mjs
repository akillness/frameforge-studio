import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store, entity, starterScene } from '../server/store.mjs';
import { WorkflowEngine } from '../server/workflows.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

async function candidate(t, { legacyHash = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-review-'));
  let store = new Store(dataDir), engine;
  const bytes = Buffer.from('Review artifact fixture: exact candidate bytes, not a real MP4.');
  const adapters = () => ({
    store,
    fetchTrends: async () => ({ trends: [{ keyword: 'test source' }], sources: [] }),
    runAgent: async () => { throw new Error('Unexpected external call'); },
    validateAssets: (scenes) => scenes,
    render: async (episode) => {
      const filename = `${randomUUID()}.mp4`;
      await writeFile(path.join(dataDir, 'exports', filename), bytes);
      const job = store.create('jobs', { episodeId: episode.id, episodeVersion: episode.version, status: 'completed', progress: 100, filename, outputUrl: `/api/exports/${filename}`, ...(legacyHash ? {} : { sha256: hash(bytes) }) });
      return { filename, outputUrl: job.outputUrl, jobId: job.id, episodeVersion: episode.version, ...(legacyHash ? {} : { sha256: job.sha256 }) };
    },
  });
  engine = new WorkflowEngine(adapters());
  t.after(async () => { engine.close(); store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const channel = store.list('channels')[0];
  const episode = store.create('episodes', { channelId: channel.id, title: 'Review candidate', topic: '검증할 영상', category: 'information', status: 'draft', format: '9:16', version: 1, scenes: [starterScene('Scene', 'Text')], notes: '' });
  const template = store.list('workflows')[0];
  const workflow = store.createWorkflowCopy({ templateId: template.id, channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  const initial = engine.start(workflow.id, episode.id);
  let run;
  for (let attempt = 0; attempt < 100; attempt++) {
    run = store.get('workflowRuns', initial.id);
    if (run.status === 'awaiting_review') break;
    if (run.status === 'failed') throw new Error('Fixture workflow failed');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(run.status, 'awaiting_review');
  const reviewNodeId = run.nodeRuns.find((node) => node.type === 'review').nodeId;
  const output = run.nodeRuns.find((node) => node.type === 'render').output;
  return {
    get store() { return store; },
    get engine() { return engine; },
    dataDir, bytes, run, workflow, output, reviewNodeId,
    artifactPath: path.join(dataDir, 'exports', output.filename),
    decide: (body = {}) => engine.review(workflow.id, run.id, { reviewNodeId, decision: 'approved', notes: '영상과 출처를 확인했습니다.', expectedEpisodeVersion: run.episodeVersion, ...body }),
    restart: () => { engine.close(); store.close(); store = new Store(dataDir); engine = new WorkflowEngine(adapters()); },
  };
}

test('human approval binds exact rendered version/hash and persists audit across restart without publishing', async (t) => {
  const f = await candidate(t);
  const approved = await f.decide();
  assert.equal(approved.status, 'approved');
  assert.equal(approved.reviews[f.reviewNodeId].decision, 'approved');
  assert.equal(approved.reviews[f.reviewNodeId].sha256, hash(f.bytes));
  assert.equal(approved.reviews[f.reviewNodeId].jobId, f.output.jobId);
  assert.equal(approved.reviews[f.reviewNodeId].outputUrl, f.output.outputUrl);
  assert.equal(approved.reviews[f.reviewNodeId].episodeVersion, f.run.episodeVersion);
  assert.equal(approved.reviews[f.reviewNodeId].workflowVersion, f.run.workflowVersion);
  assert.ok(Number.isFinite(Date.parse(approved.reviews[f.reviewNodeId].reviewedAt)));
  assert.equal(approved.review, undefined, 'the legacy singular run.review alias must never reappear on the new per-node review contract');
  assert.equal(approved.nodeRuns.find((node) => node.type === 'review').status, 'approved');
  assert.equal(f.store.get('episodes', f.run.episodeId).version, f.run.episodeVersion);
  assert.equal(f.store.get('episodes', f.run.episodeId).status, 'draft');
  assert.equal(f.store.workflowNodeReviews(f.run.id).length, 1);
  assert.equal(f.store.list('events').filter((event) => event.type === 'workflow.reviewed').length, 1);
  assert.ok(!f.store.list('events').some((event) => /publish/.test(event.type)));
  f.restart();
  assert.deepEqual(f.engine.listRuns(f.workflow.id).find((run) => run.id === f.run.id).reviews[f.reviewNodeId], approved.reviews[f.reviewNodeId]);
  assert.deepEqual(f.store.workflowNodeReviews(f.run.id), [approved.reviews[f.reviewNodeId]]);
});

test('revision request is a durable terminal decision and legacy render receives a computed artifact hash', async (t) => {
  const f = await candidate(t, { legacyHash: true });
  const revised = await f.decide({ decision: 'changes_requested', notes: '두 번째 장면의 출처 표시를 수정하세요.' });
  assert.equal(revised.status, 'changes_requested');
  assert.equal(revised.review, undefined, 'the legacy singular run.review alias must never reappear on the new per-node review contract');
  assert.equal(revised.reviews[f.reviewNodeId].sha256, hash(f.bytes));
  assert.match(revised.reviews[f.reviewNodeId].notes, /출처/);
  assert.equal(revised.nodeRuns.find((node) => node.type === 'review').status, 'changes_requested');
  assert.throws(() => f.engine.cancel(f.workflow.id, f.run.id), { status: 409 });
  f.restart();
  assert.equal(f.store.get('workflowRuns', f.run.id).status, 'changes_requested');
});

test('review rejects stale episodes even when client submits the new draft version', async (t) => {
  const f = await candidate(t);
  const edited = f.store.updateEpisode(f.run.episodeId, { title: 'Changed after render' }, f.run.episodeVersion);
  await assert.rejects(f.decide(), { status: 409 });
  await assert.rejects(f.decide({ expectedEpisodeVersion: edited.version }), { status: 409 });
  assert.equal(f.store.get('workflowRuns', f.run.id).status, 'awaiting_review');
  assert.deepEqual(f.store.workflowNodeReviews(f.run.id), []);
});

test('wrong run/workflow, malformed review fields and terminal runs cannot create review records', async (t) => {
  const f = await candidate(t);
  await assert.rejects(f.engine.review(randomUUID(), f.run.id, { reviewNodeId: f.reviewNodeId, decision: 'approved', notes: '', expectedEpisodeVersion: f.run.episodeVersion }), { status: 404 });
  await assert.rejects(f.engine.review(f.workflow.id, randomUUID(), { reviewNodeId: f.reviewNodeId, decision: 'approved', notes: '', expectedEpisodeVersion: f.run.episodeVersion }), { status: 404 });
  for (const patch of [{ decision: 'published' }, { notes: 123 }, { notes: 'x'.repeat(10001) }, { notes: undefined }, { expectedEpisodeVersion: undefined }, { expectedEpisodeVersion: '2' }, { expectedEpisodeVersion: 0 }]) await assert.rejects(f.decide(patch), { status: 400 });
  f.store.save('workflowRuns', { ...f.run, status: 'failed' });
  await assert.rejects(f.decide(), { status: 409 });
  assert.deepEqual(f.store.workflowNodeReviews(f.run.id), []);
});

test('parallel and repeated decisions commit exactly once', async (t) => {
  const f = await candidate(t);
  const results = await Promise.allSettled([f.decide(), f.decide({ decision: 'changes_requested', notes: 'Concurrent decision' })]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal(f.store.workflowNodeReviews(f.run.id).length, 1);
  assert.equal(f.store.list('events').filter((event) => event.type === 'workflow.reviewed').length, 1);
  await assert.rejects(f.decide(), { status: 409 });
});

test('transaction rechecks episode changes after asynchronous hashing and rolls back audit failures', async (t) => {
  const f = await candidate(t);
  const commit = f.store.commitWorkflowReview.bind(f.store);
  f.store.commitWorkflowReview = (...args) => {
    f.store.updateEpisode(f.run.episodeId, { notes: 'Concurrent edit during hash' }, f.run.episodeVersion);
    return commit(...args);
  };
  await assert.rejects(f.decide(), { status: 409 });
  assert.deepEqual(f.store.workflowNodeReviews(f.run.id), []);
  const other = await candidate(t);
  const record = other.store.record.bind(other.store);
  other.store.record = (type, details) => { if (type === 'workflow.reviewed') throw new Error('Injected audit failure'); return record(type, details); };
  await assert.rejects(other.decide(), /Injected audit failure/);
  assert.equal(other.store.get('workflowRuns', other.run.id).status, 'awaiting_review');
  assert.deepEqual(other.store.workflowNodeReviews(other.run.id), []);
  other.store.record = record;
  assert.equal((await other.decide()).status, 'approved');
});

test('tampered, missing or mismatched rendered artifacts cannot receive approval', async (t) => {
  const f = await candidate(t);
  await writeFile(f.artifactPath, 'tampered render');
  await assert.rejects(f.decide(), { status: 409 });
  await unlink(f.artifactPath);
  await assert.rejects(f.decide(), { status: 409 });
  await writeFile(f.artifactPath, f.bytes);
  const job = f.store.get('jobs', f.output.jobId);
  f.store.save('jobs', { ...job, episodeVersion: f.run.episodeVersion + 1 });
  await assert.rejects(f.decide(), { status: 409 });
  assert.deepEqual(f.store.workflowNodeReviews(f.run.id), []);
});

test('review rejects export links escaping the artifact root without changing the outside data', async (t) => {
  const f = await candidate(t);
  const outside = path.join(f.dataDir, 'outside');
  await mkdir(outside);
  const sentinel = path.join(outside, 'sentinel.txt');
  await writeFile(sentinel, 'preserve');
  await unlink(f.artifactPath);
  try { await symlink(outside, f.artifactPath, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Cannot create test link on this platform'); throw error; }
  await assert.rejects(f.decide(), { status: 409 });
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
  assert.deepEqual(f.store.workflowNodeReviews(f.run.id), []);
});

test('narration attachment atomically saves uploads, draft scenes and history and rejects stale writes', async (t) => {
  const f = await candidate(t);
  let episode = f.store.get('episodes', f.run.episodeId);
  episode = f.store.updateEpisode(episode.id, { status: 'ready' }, episode.version);
  const makeUpload = () => { const id = randomUUID(); return entity({ id, name: 'Narration.wav', filename: `${id}.wav`, url: `/api/uploads/${id}.wav`, type: 'audio/wav', size: 100 }); };
  const upload = makeUpload();
  const sceneList = episode.scenes.map((scene, index) => index === 0 ? { ...scene, audioUrl: upload.url } : scene);
  const attached = f.store.attachNarration(episode.id, sceneList, episode.version, [upload]);
  assert.equal(attached.version, episode.version + 1);
  assert.equal(attached.status, 'draft');
  assert.equal(f.store.get('uploads', upload.id).url, upload.url);
  assert.equal(f.store.history(episode.id)[0].reason, 'narration');
  const failedUpload = makeUpload();
  const rejectedScenes = sceneList.map((scene, index) => index === 0 ? { ...scene, audioUrl: failedUpload.url } : scene);
  assert.throws(() => f.store.attachNarration(episode.id, rejectedScenes, episode.version, [failedUpload]), { status: 409 });
  assert.throws(() => f.store.get('uploads', failedUpload.id), { status: 404 });
  assert.equal(f.store.get('episodes', episode.id).version, attached.version);
  const record = f.store.record.bind(f.store);
  f.store.record = (type, details) => { if (type === 'episodes.narration') throw new Error('Injected narration audit failure'); return record(type, details); };
  assert.throws(() => f.store.attachNarration(episode.id, rejectedScenes, attached.version, [failedUpload]), /Injected narration audit failure/);
  assert.throws(() => f.store.get('uploads', failedUpload.id), { status: 404 });
  assert.equal(f.store.get('episodes', episode.id).version, attached.version);
  f.store.record = record;
  f.store.exportKnowledge = () => { throw new Error('Injected export projection failure'); };
  const committed = f.store.attachNarration(episode.id, rejectedScenes, attached.version, [failedUpload]);
  assert.equal(committed.version, attached.version + 1);
  assert.equal(f.store.get('uploads', failedUpload.id).url, failedUpload.url);
});

test('existing script mode preserves authored scene edits and narration through storyboard and render', async (t) => {
  const f = await candidate(t);
  const episode = f.store.get('episodes', f.run.episodeId);
  const audioId = randomUUID();
  const audio = f.store.create('uploads', { id: audioId, name: 'Saved narration.wav', filename: `${audioId}.wav`, url: `/api/uploads/${audioId}.wav`, type: 'audio/wav' });
  await writeFile(path.join(f.dataDir, 'uploads', audio.filename), 'Audio metadata preservation fixture');
  const edited = f.store.updateEpisode(episode.id, { scenes: [{ ...episode.scenes[0], title: '직접 편집한 제목', text: '작성한 대본을 덮어쓰지 마세요', duration: 8.5, background: '#246813', layout: 'lower-third', narration: '직접 녹음한 내레이션', audioUrl: audio.url, audioVolume: 0.65, trimStart: 2.25 }] }, episode.version);
  const workflow = f.engine.update(f.workflow.id, { ...f.workflow, expectedVersion: f.workflow.version, nodes: f.workflow.nodes.map((node) => node.type === 'script' ? { ...node, config: { agent: 'existing', prompt: '' } } : node) });
  const render = f.engine.render;
  let rendered;
  f.engine.render = async (snapshot) => { rendered = snapshot; return render(snapshot); };
  f.engine.runAgent = async () => { throw new Error('Existing mode must not call an external agent'); };
  const started = f.engine.start(workflow.id, episode.id);
  let run;
  for (let attempt = 0; attempt < 100; attempt++) {
    run = f.store.get('workflowRuns', started.id);
    if (run.status === 'awaiting_review' || run.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(run.status, 'awaiting_review');
  assert.equal(run.nodeRuns.find((node) => node.type === 'script').output.mode, 'saved');
  assert.deepEqual(rendered.scenes, edited.scenes);
  assert.equal(rendered.version, edited.version + 1);
  assert.deepEqual(f.store.get('episodes', episode.id).scenes, edited.scenes);
  assert.equal(f.store.history(episode.id)[0].reason, `workflow:${workflow.id}:${run.id}`);
});
