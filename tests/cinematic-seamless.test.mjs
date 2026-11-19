import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { createPresetSlots, scenes } from '../server/validation.mjs';
import { buildSceneCompositionPlan, renderEpisode } from '../server/render.mjs';
import { WorkflowEngine } from '../server/workflows.mjs';
import { execute } from '../server/process.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

test('cinematic-seamless preset creates full-bleed video-bg and zero-opacity soft-shadow subtitle-layer', () => {
  const slots = createPresetSlots('cinematic-seamless', {
    title: '제목',
    text: '작은 손끝이 아침 햇살을 조심스레 움켜쥡니다.',
    narration: '작은 손끝이 아침 햇살을 조심스레 움켜쥡니다.',
  });
  const validated = scenes([{
    id: 'scene-1',
    title: '제목',
    text: '작은 손끝이 아침 햇살을 조심스레 움켜쥡니다.',
    narration: '작은 손끝이 아침 햇살을 조심스레 움켜쥡니다.',
    duration: 5,
    background: '#0f1419',
    kind: 'title',
    layout: 'cinematic-seamless',
    slots,
  }]);
  assert.equal(validated[0].layout, 'cinematic-seamless');
  assert.deepEqual(validated[0].slots.map((s) => s.role), ['video-bg', 'subtitle-layer']);
  assert.equal(validated[0].slots[0].w, 100);
  assert.equal(validated[0].slots[0].h, 100);
  assert.equal(validated[0].slots[1].style.opacity, 0);

  const plan = buildSceneCompositionPlan(validated[0], 1080, 1920);
  assert.match(plan.ass, /Style: Slot1,.*,2,2\.5,5,20,20,20,1/);
  assert.doesNotMatch(plan.ass, /\[SUBTITLE\]|\[CC\]/);
});

test('cinematic-seamless renders 2s video stretched to 5s scene duration without drawbox or letterboxing', async (t) => {
  try { await execute(ffmpeg, ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg required'); return; } throw error; }

  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-seamless-render-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'uploads'), { recursive: true });
  await mkdir(path.join(root, 'render-work'), { recursive: true });
  await mkdir(path.join(root, 'exports'), { recursive: true });

  const clipPath = path.join(root, 'uploads', 'clip2s.mp4');
  await execute(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=#223344:s=720x1280:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath]);

  const slots = createPresetSlots('cinematic-seamless', {
    title: 'S1',
    text: '문턱에 내려앉은 정적의 시작.',
    narration: '문턱에 내려앉은 정적의 시작.',
  });
  slots[0].assetUrl = '/api/uploads/clip2s.mp4';
  slots[0].mediaKind = 'video';

  const result = await renderEpisode({
    format: '9:16',
    scenes: [{
      id: 's1',
      title: 'S1',
      text: '문턱에 내려앉은 정적의 시작.',
      narration: '문턱에 내려앉은 정적의 시작.',
      duration: 5,
      background: '#0f1419',
      kind: 'title',
      layout: 'cinematic-seamless',
      slots,
    }],
  }, { dataDir: root });

  assert.match(result.outputUrl, /^\/api\/exports\/.*\.mp4$/);
  const { stdout } = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', path.join(root, 'exports', result.filename)]);
  const info = JSON.parse(stdout);
  assert.equal(info.streams[0].width, 1080);
  assert.equal(info.streams[0].height, 1920);
  assert.ok(Math.abs(Number(info.format.duration) - 5.0) < 0.2);
});

test('WorkflowEngine auto-synthesizes unified voice narration in cinematic-seamless layout stage', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-wf-narration-'));
  let storeRef, wfRef;
  t.after(async () => { wfRef?.close(); storeRef?.close?.(); try { storeRef?.db?.close?.(); } catch {} await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'uploads'), { recursive: true });
  await mkdir(path.join(root, 'narration-work'), { recursive: true });

  const store = new Store(root); storeRef = store;
  const channel = store.create('channels', { name: '확인해봄', category: 'information', platform: 'youtube' });
  const episode = store.create('episodes', {
    channelId: channel.id,
    title: '음유적 워크플로우 테스트',
    topic: '자동 보이스 합성 검증',
    format: '9:16',
    status: 'draft',
    version: 1,
    scenes: [{ id: 's1', title: '1장', text: '문턱에 내려앉은 정적.', narration: '문턱에 내려앉은 정적.', duration: 4, background: '#101820', kind: 'title', layout: 'center' }],
  });

  const synthCalls = [];
  const fakeSpeech = {
    async listVoices() { return { available: true, provider: 'windows-sapi', voices: [{ id: 'Microsoft Heami Desktop', name: 'Heami', language: 'ko-KR' }] }; },
    async synthesize({ text, voice, rate, outputPath }) {
      synthCalls.push({ text, voice, rate });
      // Write a tiny valid RIFF/WAVE header (44 bytes + silence)
      const buf = Buffer.alloc(44 + 8000);
      buf.write('RIFF', 0); buf.writeUInt32LE(36 + 8000, 4); buf.write('WAVE', 8);
      buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
      buf.write('data', 36); buf.writeUInt32LE(8000, 40);
      await writeFile(outputPath, buf);
      return { duration: 6.4 };
    },
  };

  const wf = new WorkflowEngine({
    store,
    fetchTrends: async () => ({ trends: [] }),
    runAgent: async () => ({ message: 'ok', scenes: episode.scenes }),
    render: async () => ({ jobId: 'j1', filename: 'out.mp4', outputUrl: '/api/exports/out.mp4', sha256: '0'.repeat(64) }),
    validateAssets: (s) => s,
    speechProvider: fakeSpeech,
  });

  wfRef = wf;
  const tmpl = store.create('workflows', {
    name: 'Seamless Test',
    isTemplate: true,
    version: 1,
    nodes: [
      { id: 'script', type: 'script', x: 50, y: 100, config: { agent: 'existing' } },
      { id: 'storyboard', type: 'storyboard', x: 250, y: 100, config: {} },
      { id: 'layout', type: 'layout', x: 450, y: 100, config: { preset: 'cinematic-seamless', autoPrompts: true } },
      { id: 'render', type: 'render', x: 650, y: 100, config: {} },
      { id: 'review', type: 'review', x: 850, y: 100, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'script', target: 'storyboard' },
      { id: 'e2', source: 'storyboard', target: 'layout' },
      { id: 'e3', source: 'layout', target: 'render' },
      { id: 'e4', source: 'render', target: 'review' },
    ],
  });

  const workflow = wf.copy(tmpl.id, { episodeId: episode.id, channelId: channel.id, expectedTemplateVersion: 1 });
  const run = await wf.start(workflow.id, episode.id, { selectedStages: ['script', 'storyboard', 'layout'] });
  for (let i = 0; i < 40; i++) {
    const curr = store.get('workflowRuns', run.id);
    if (curr.status === 'completed' || curr.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const finalRun = store.get('workflowRuns', run.id);
  assert.equal(finalRun.status, 'completed');
  assert.equal(synthCalls.length, 1);
  assert.equal(synthCalls[0].voice, 'Microsoft Heami Desktop');
  assert.equal(synthCalls[0].rate, 0);

  const updatedEp = store.get('episodes', episode.id);
  assert.match(updatedEp.scenes[0].audioUrl, /^\/api\/uploads\/.*\.wav$/);
  assert.equal(updatedEp.scenes[0].layout, 'cinematic-seamless');
  assert.ok(updatedEp.scenes[0].duration >= 6.6);
});
