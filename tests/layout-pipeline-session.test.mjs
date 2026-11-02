import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, starterScene } from '../server/store.mjs';
import { scenes, createPresetSlots } from '../server/validation.mjs';
import { buildSceneCompositionPlan, renderEpisode } from '../server/render.mjs';
import { WorkflowEngine, validateWorkflow } from '../server/workflows.mjs';
import { GenerationQueue } from '../server/generations.mjs';
import { PlatformSessionManager } from '../server/platform-session.mjs';
import { execute } from '../server/process.mjs';
import { addWorkflowNode, fullPipelineGraph, workflowErrors } from '../public/workflow.js';
import { episodeChanges } from '../public/history.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const playwrightModulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const browserModule = playwrightModulePath
  ? await import(pathToFileURL(playwrightModulePath))
  : await import('playwright');
const chromiumExecutable = process.env.PLATFORM_CHROMIUM_PATH
  || process.env.CHROMIUM_PATH
  || process.env.PLAYWRIGHT_EXECUTABLE_PATH
  || browserModule.chromium.executablePath();
const fixtureBrowserModule = {
  ...browserModule,
  chromium: {
    ...browserModule.chromium,
    launchPersistentContext: async (...args) => {
      const context = await browserModule.chromium.launchPersistentContext(...args);
      for (const page of context.pages()) await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>FrameForge local browser fixture</title><main>local fixture</main>' }));
      return context;
    },
  },
};

test('scene layout preset slots validate and build multi-layer FFmpeg composition plans', () => {
  const rawScene = {
    id: 'scene-multi-1',
    title: 'AI 반도체 뉴스 브리핑',
    text: '중단 배경 영상 위 자막 레이어입니다.',
    narration: '내레이션 자막이 배경 영상 위에 표시됩니다.',
    duration: 4,
    background: '#123456',
    kind: 'title',
    layout: 'top-image-mid-video',
    slots: createPresetSlots('top-image-mid-video', {
      title: 'AI 반도체 뉴스 브리핑',
      text: '중단 배경 영상 위 자막 레이어입니다.',
      narration: '내레이션 자막이 배경 영상 위에 표시됩니다.',
    }),
  };
  const validated = scenes([rawScene]);
  assert.equal(validated.length, 1);
  assert.equal(validated[0].layout, 'top-image-mid-video');
  assert.equal(validated[0].slots.length, 4);
  assert.deepEqual(validated[0].slots.map((s) => s.role), ['image-gen', 'text-overlay', 'video-bg', 'subtitle-layer']);

  const plan = buildSceneCompositionPlan(validated[0], 1080, 1920);
  assert.equal(plan.hasSlots, true);
  assert.equal(plan.slotBoxes.length, 4);
  assert.deepEqual(plan.slotBoxes.map((b) => b.slot.role), ['video-bg', 'image-gen', 'text-overlay', 'subtitle-layer']);
  assert.match(plan.ass, /Style: Slot0/);
  assert.match(plan.ass, /\\an5\\pos\(/);
  assert.match(plan.ass, /\[HEADLINE\]/);
  assert.match(plan.ass, /\[CC\]/);

  const diff = episodeChanges({ scenes: [{ ...validated[0], slots: [] }] }, { scenes: validated });
  assert.ok(diff.some((change) => change.field === 'slots'));
});

test('FFmpeg multi-layer renderer composites top image slot, middle video background, and HTML/subtitle overlays into MP4', async (t) => {
  try { await execute(ffmpeg, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg required'); return; } throw error; }

  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-multilayer-render-'));
  const uploads = path.join(root, 'uploads');
  await mkdir(uploads, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const imgId = '11111111-1111-4111-8111-111111111111';
  const vidId = '22222222-2222-4222-8222-222222222222';
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=teal:s=128x128:r=2:d=1', '-frames:v', '1', path.join(uploads, `${imgId}.png`)]);
  await execute(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=navy:s=128x128:r=10:d=1', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(uploads, `${vidId}.mp4`)]);

  const multiSlotScene = {
    id: 'scene-1',
    title: '상단 이미지와 중단 영상 합성',
    text: '하단 자막 오버레이',
    duration: 1,
    background: '#101820',
    kind: 'title',
    layout: 'top-image-mid-video',
    slots: [
      { id: 'slot-top-img', name: '상단 이미지', role: 'image-gen', dataBinding: 'scene.imagePrompt', x: 5, y: 4, w: 90, h: 32, zIndex: 2, assetUrl: `/api/uploads/${imgId}.png`, mediaKind: 'image', text: '상단 AI 생성 이미지' },
      { id: 'slot-mid-vid', name: '중단 영상', role: 'video-bg', dataBinding: 'scene.videoPrompt', x: 0, y: 38, w: 100, h: 62, zIndex: 1, assetUrl: `/api/uploads/${vidId}.mp4`, mediaKind: 'video' },
      { id: 'slot-sub', name: '자막 오버레이', role: 'subtitle-layer', dataBinding: 'scene.text', x: 8, y: 74, w: 84, h: 16, zIndex: 10, text: '백그라운드 영상 위 자막 레이어', style: { backgroundColor: '#111827', textColor: '#ffffff', fontSize: 38, opacity: 0.85, badge: 'CC' } },
    ],
  };

  const result = await renderEpisode({ format: '9:16', scenes: [multiSlotScene] }, { dataDir: root });
  assert.match(result.outputUrl, /^\/api\/exports\/[a-f0-9-]+\.mp4$/);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

function incrementalPipelineGraph() {
  const baseWf = {
    name: 'Incremental pipeline',
    nodes: [
      { id: 'script', type: 'script', x: 0, y: 0, config: { agent: 'studio', prompt: '' } },
      { id: 'storyboard', type: 'storyboard', x: 10, y: 0, config: {} },
      { id: 'render', type: 'render', x: 20, y: 0, config: {} },
      { id: 'review', type: 'review', x: 30, y: 0, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'script', target: 'storyboard' },
      { id: 'e2', source: 'storyboard', target: 'render' },
      { id: 'e3', source: 'render', target: 'review' },
    ],
  };
  const withNews = addWorkflowNode(baseWf, 'news', { id: 'news', config: { query: 'AI 반도체', maxArticles: 3, source: 'trend_news' } });
  const withLayout = addWorkflowNode(withNews, 'layout', { id: 'layout', config: { preset: 'premiere-3tier', autoPrompts: true } });
  const withGen = addWorkflowNode(withLayout, 'generate', { id: 'generate', config: { model: 'seedance_2_5', prompt: '', sceneIndex: 0, slotId: 'slot-top-image' } });
  return addWorkflowNode(withGen, 'publish', { id: 'publish', config: { platform: 'youtube', visibility: 'private', autoAttachExport: true } });
}

test('unique-stage insertion preserves adjacent wiring when prepending news and adding layout, generation and publish', () => {
  const workflow = incrementalPipelineGraph();
  assert.deepEqual(workflow.nodes.map(n => n.type), ['news', 'script', 'storyboard', 'layout', 'generate', 'render', 'review', 'publish']);
  assert.deepEqual(workflowErrors(workflow), []);
});

test('full 10-stage workflow preserves slot generation and exact-node review before local publication staging', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-full-pipeline-'));
  const store = new Store(dataDir);
  store.create('trends', { keyword: 'AI 반도체 HBM4', title: 'HBM4 source fixture', source: 'Local news fixture', url: 'https://example.test/hbm4', capturedAt: '2026-10-25T00:00:00.000Z' });
  let renderCount = 0;
  let generationCalls = 0;
  const provider = {
    transport: 'api',
    capability: async () => ({ available: true, authenticated: true }),
    models: async () => [{ id: 'seedance_2_5', name: 'Seedance 2.5', type: 'video' }],
    modelSchema: async () => ({ id: 'seedance_2_5', type: 'image', parameters: [{ name: 'prompt', type: 'string', required: true }] }),
    create: async () => { generationCalls++; return { requestId: 'hf-slot-req-1', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/slot-output.png', type: 'image' }] }; },
    status: async () => ({ requestId: 'hf-slot-req-1', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/slot-output.png', type: 'image' }] }),
  };
  const generations = new GenerationQueue({
    store,
    provider,
    pollIntervalMs: 1,
    download: async (_url, file) => { await writeFile(file, 'slot-image-bytes'); return { bytes: 16, contentType: 'image/png' }; },
    probe: async () => ({ kind: 'image', width: 512, height: 512 }),
  });
  const platformSessions = new PlatformSessionManager({ store, browserModule: fixtureBrowserModule, browserOptions: { executablePath: chromiumExecutable } });
  const workflows = new WorkflowEngine({
    store,
    fetchTrends: async () => ({ trends: [{ keyword: 'AI 반도체 HBM4', source: 'Google Trends KR', url: 'https://trends.google.com/trending?geo=KR' }], sources: [{ name: 'Google Trends KR', status: 'ok' }] }),
    runAgent: async () => { throw new Error('unused'); },
    render: async (ep) => {
      renderCount++;
      const filename = `pipeline-export-${renderCount}.mp4`;
      const bytes = Buffer.from('rendered-mp4-binary-fixture');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const verifiedSceneAssets = [];
      for (const scene of ep.scenes) {
        const references = [
          ...(scene.assetUrl ? [{ sceneId: scene.id, use: 'asset', assetUrl: scene.assetUrl }] : []),
          ...(scene.audioUrl ? [{ sceneId: scene.id, use: 'audio', assetUrl: scene.audioUrl }] : []),
          ...(scene.slots || []).filter(slot => slot.assetUrl).map(slot => ({ sceneId: scene.id, slotId: slot.id, use: 'asset', assetUrl: slot.assetUrl })),
        ];
        for (const reference of references) {
          const matches = store.list('uploads').filter(upload => upload.url === reference.assetUrl);
          assert.equal(matches.length, 1, 'the fixture renderer only receipts a uniquely registered upload');
          const upload = matches[0], file = await readFile(path.join(dataDir, 'uploads', upload.filename));
          const actualHash = createHash('sha256').update(file).digest('hex');
          assert.equal(actualHash, upload.sha256, 'fixture render receipts must match bytes actually read');
          assert.equal(file.length, upload.size, 'fixture render receipts must match the registered byte count');
          verifiedSceneAssets.push({ ...reference, sha256: actualHash, size: file.length });
        }
      }
      await writeFile(path.join(dataDir, 'exports', filename), bytes);
      const sceneSnapshot = structuredClone(ep.scenes);
      const job = store.create('jobs', { episodeId: ep.id, episodeVersion: ep.version, status: 'completed', progress: 100, filename, outputUrl: `/api/exports/${filename}`, sha256, sceneSnapshot, sceneIntegrity: structuredClone(verifiedSceneAssets), verifiedSceneAssets: structuredClone(verifiedSceneAssets) });
      return { filename, outputUrl: `/api/exports/${filename}`, jobId: job.id, episodeVersion: ep.version, sha256, verifiedSceneAssets };
    },
    validateAssets: (sceneList) => scenes(sceneList),
    generations,
    platformSessions,
  });

  t.after(async () => {
    workflows.close();
    generations.close();
    await platformSessions.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // 1. Validate full 10-stage pipeline graph
  const fullGraph = fullPipelineGraph('seedance_2_5');
  assert.equal(fullGraph.nodes.length, 10);
  assert.deepEqual(workflowErrors(fullGraph), []);
  assert.equal(validateWorkflow(fullGraph).nodes.length, 10);

  // Explicit node-ID edges isolate engine integration from the insertion regression above.
  // The nodes deliberately retain their unsorted storage order.
  const withPublish = { ...incrementalPipelineGraph(), edges: [
    { id: 'news-script', source: 'news', target: 'script' },
    { id: 'script-storyboard', source: 'script', target: 'storyboard' },
    { id: 'storyboard-layout', source: 'storyboard', target: 'layout' },
    { id: 'layout-generate', source: 'layout', target: 'generate' },
    { id: 'generate-render', source: 'generate', target: 'render' },
    { id: 'render-review', source: 'render', target: 'review' },
    { id: 'review-publish', source: 'review', target: 'publish' },
  ] };
  assert.deepEqual(workflowErrors(withPublish), []);

  const channel = store.list('channels')[0];
  const ep = store.create('episodes', {
    channelId: channel.id,
    title: 'HBM4 반도체 시나리오',
    topic: '차세대 AI 메모리 동향',
    category: 'information',
    status: 'draft',
    format: '9:16',
    version: 1,
    scenes: [starterScene('오프닝', 'HBM4 반도체 시나리오')],
    notes: '',
  });
  const template = workflows.create(withPublish);
  const createdWf = workflows.copy(template.id, { episodeId: ep.id, channelId: channel.id, expectedTemplateVersion: template.version });
  assert.notEqual(createdWf.id, template.id);
  assert.equal(createdWf.episodeId, ep.id);
  const preparation = workflows.start(createdWf.id, ep.id, { selectedStages: ['news', 'script', 'storyboard', 'layout'], startStage: 'news' });
  let prepared;
  for (let i = 0; i < 100; i++) {
    prepared = store.get('workflowRuns', preparation.id);
    if (['completed', 'failed'].includes(prepared.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(prepared.status, 'completed', prepared.error);
  assert.equal(prepared.nodeRuns.find(n => n.nodeId === 'news').status, 'completed');
  assert.equal(generationCalls, 0, 'preparing source and layout cannot submit paid generation');
  assert.equal(renderCount, 0);
  const selection = { selectedStages: ['generate', 'render', 'review'], startStage: 'generate', resumeRunId: prepared.id };
  const disclosure = { containsSyntheticMedia: true, rationale: 'Owner reviewed the synthetic fixture illustration' };
  const plan = await workflows.quote(createdWf.id, ep.id, { ...selection, disclosure });
  const startedRun = workflows.start(createdWf.id, ep.id, {
    allowGeneration: true,
    ...selection,
    disclosure,
    generationPlanId: plan.id,
    generationFingerprint: plan.fingerprint,
    acceptUnquotedEstimate: true,
  });

  let completedRun;
  for (let i = 0; i < 100; i++) {
    const current = workflows.listRuns(createdWf.id).find((r) => r.id === startedRun.id);
    if (['awaiting_review', 'completed', 'failed'].includes(current?.status)) {
      completedRun = current;
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(completedRun.status, 'awaiting_review', completedRun.error || 'should reach awaiting_review');
  assert.equal(completedRun.nodeRuns.find((n) => n.nodeId === 'news').status, 'skipped');
  assert.equal(completedRun.nodeRuns.find((n) => n.type === 'review').status, 'awaiting_review');
  assert.equal(completedRun.nodeRuns.find((n) => n.type === 'publish').status, 'skipped');
  assert.equal(completedRun.nodeRuns.find((n) => n.type === 'generate').status, 'completed');
  assert.equal(generationCalls, 1);

  const renderOutput = completedRun.nodeRuns.find((n) => n.type === 'render').output;
  assert.match(renderOutput.outputUrl, /^\/api\/exports\/pipeline-export-1\.mp4$/);
  assert.match(renderOutput.sha256, /^[a-f0-9]{64}$/);

  // Verify the episode's scene 0 has staged layout slots and the generated image attached to slot-top-image.
  const updatedEpisode = store.get('episodes', ep.id);
  assert.equal(updatedEpisode.scenes[0].layout, 'premiere-3tier');
  const topImgSlot = updatedEpisode.scenes[0].slots.find((s) => s.id === 'slot-top-image');
  assert.ok(topImgSlot?.assetUrl?.startsWith('/api/uploads/'));
  assert.equal(topImgSlot.mediaKind, 'image');

  const reviewNodeId = completedRun.nodeRuns.find((n) => n.type === 'review').nodeId;
  const reviewed = await workflows.review(createdWf.id, completedRun.id, {
    reviewNodeId,
    decision: 'approved',
    notes: 'Fixture review approved for local publication staging only.',
    expectedEpisodeVersion: completedRun.episodeVersion,
  });
  assert.equal(reviewed.review, undefined, 'the legacy singular run.review alias must never reappear on the new per-node review contract');
  assert.equal(reviewed.reviews[reviewNodeId].decision, 'approved');
  assert.equal(reviewed.reviews[reviewNodeId].sha256, renderOutput.sha256);
  assert.equal(reviewed.nodeRuns.find((n) => n.type === 'review').output.review.decision, 'approved');
  assert.equal(reviewed.nodeRuns.find((n) => n.type === 'review').output.review.sha256, renderOutput.sha256);
  const runCountBeforeArtifactResume = workflows.listRuns(createdWf.id).length;
  const renderCountBeforeArtifactResume = renderCount;
  assert.throws(
    () => workflows.start(createdWf.id, ep.id, {
      selectedStages: ['render', 'publish'],
      startStage: 'render',
      resumeRunId: completedRun.id,
      expectedEpisodeVersion: completedRun.episodeVersion,
    }),
    (error) => error.status === 409 && error.message === 'review requires fresh evidence after an upstream stage is rerun',
  );
  assert.equal(workflows.listRuns(createdWf.id).length, runCountBeforeArtifactResume);
  assert.equal(renderCount, renderCountBeforeArtifactResume);

  const resumed = workflows.start(createdWf.id, ep.id, {
    selectedStages: ['publish'],
    startStage: 'publish',
    resumeRunId: completedRun.id,
    expectedEpisodeVersion: updatedEpisode.version,
  });
  let resumedRun;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = workflows.listRuns(createdWf.id).find((r) => r.id === resumed.id);
    if (['approved', 'completed', 'failed'].includes(current?.status)) { resumedRun = current; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(resumedRun, `publish resume did not reach terminal state within 30s; run=${resumed.id}`);
  assert.equal(resumedRun.status, 'approved', resumedRun.error || 'staging retains the connected candidate approval');
  assert.equal(resumedRun.nodeRuns.find(node => node.nodeId === reviewNodeId).output.review.id, reviewed.reviews[reviewNodeId].id);
  assert.equal(resumedRun.review, undefined);
  const publishOutput = resumedRun.nodeRuns.find((n) => n.type === 'publish').output;
  assert.ok(publishOutput.stagingId);
  assert.equal(publishOutput.channelId, channel.id);
  assert.equal(publishOutput.exportUrl, renderOutput.outputUrl);
  assert.equal(publishOutput.status, 'staged');
  assert.equal(publishOutput.publicationStatus, 'not_attempted');
  assert.equal(publishOutput.sessionId, undefined);
  assert.notEqual(publishOutput.uploadStatus, 'completed');
  const staged = store.get('publicationStages', publishOutput.stagingId);
  assert.equal(staged.reviewNodeId, reviewNodeId);
  assert.equal(staged.reviewId, reviewed.reviews[reviewNodeId].id);
  assert.equal(staged.render.jobId, renderOutput.jobId);
  assert.equal(staged.render.sha256, renderOutput.sha256);
  assert.equal(platformSessions.listSessions().length, 0, 'workflow staging cannot open an automated YouTube browser');
  assert.notEqual(store.get('episodes', ep.id).status, 'completed', 'local staging is not verified public delivery');
  assert.equal(store.list('platformUploads').length, 0);
});

test('FFmpeg preserves cross-type z-order and renders slot text alignment', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-render-pixels-'));
  const uploads = path.join(dataDir, 'uploads');
  await mkdir(uploads, { recursive: true });
  const white = path.join(uploads, 'white.png');
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=32x32', '-frames:v', '1', white]);
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  async function redPixels(rendered) {
    const ppm = path.join(dataDir, `${rendered.filename}.ppm`);
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(dataDir, 'exports', rendered.filename), '-frames:v', '1', '-f', 'image2', ppm]);
    const bytes = await readFile(ppm);
    const marker = Buffer.from('\n255\n');
    const offset = bytes.indexOf(marker);
    assert.ok(offset > 0, 'FFmpeg pixel fixture must be a binary PPM');
    const pixelOffset = offset + marker.length;
    const dimensionsLine = bytes.subarray(0, offset).toString('ascii').split(/\s+/).filter(Boolean);
    const width = Number(dimensionsLine.at(-2));
    const pixels = [];
    for (let i = pixelOffset, index = 0; i + 2 < bytes.length; i += 3, index++) {
      const r = bytes[i], g = bytes[i + 1], b = bytes[i + 2];
      if (r > 170 && g < 100 && b < 100) pixels.push([index % width, Math.floor(index / width)]);
    }
    return pixels;
  }

  const text = (zIndex, align = 'center') => ({ id: 'overlay-text', role: 'text-overlay', x: 0, y: 0, w: 100, h: 100, zIndex, text: 'ALIGN', style: { textColor: '#ff0000', fontSize: 120, align } });
  const image = (zIndex) => ({ id: 'opaque-image', role: 'image-gen', x: 0, y: 0, w: 100, h: 100, zIndex, assetUrl: '/api/uploads/white.png', mediaKind: 'image' });
  const render = (slots) => renderEpisode({ format: '1:1', scenes: [{ id: 'pixel-scene', duration: 0.5, background: '#000000', kind: 'title', layout: 'pixel-regression', text: '', slots }] }, { dataDir });

  const hidden = await render([text(1), image(2)]);
  assert.equal((await redPixels(hidden)).length, 0, 'text below an opaque image must be hidden');
  const visible = await render([image(1), text(2)]);
  assert.ok((await redPixels(visible)).length > 20, 'text above an opaque image must remain visible');

  const aligned = [];
  for (const align of ['left', 'center', 'right']) aligned.push(await redPixels(await render([text(1, align)])));
  const centers = aligned.map((pixels) => {
    assert.ok(pixels.length > 20, 'aligned text must render visible pixels');
    return pixels.reduce((sum, [x]) => sum + x, 0) / pixels.length;
  });
  assert.ok(centers[0] + 100 < centers[1] && centers[1] + 100 < centers[2], `alignment centers must move left to right: ${centers.join(', ')}`);
});
