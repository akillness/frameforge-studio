import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const MAX_DOWNLOAD = 20 * 1024 * 1024;

async function waitForHealth(base) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch { /* Compose may still be starting or restarting. */ }
    await delay(1000);
  }
  throw new Error('Service did not become healthy within 90 seconds');
}

async function download(base, cookie, outputUrl) {
  assert.match(outputUrl, /^\/api\/exports\/[a-zA-Z0-9_-]+\.mp4$/, 'Unsafe render export URL');
  const response = await fetch(base + outputUrl, { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, 'Authenticated MP4 download failed');
  assert.match(response.headers.get('content-type') || '', /^video\/mp4/);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= MAX_DOWNLOAD, 'Smoke MP4 exceeds the bounded download size');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  assert.ok(bytes.length > 1000, 'Rendered MP4 is unexpectedly small');
  assert.equal(bytes.subarray(4, 8).toString('ascii'), 'ftyp', 'Download is not an MP4 container');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function probeVideo(bytes, outputUrl, mode) {
  let result;
  const probeArgs = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json'];
  if (mode === 'container') {
    result = await execute('docker', ['compose', 'exec', '-T', 'studio', 'ffprobe', ...probeArgs, `/data/exports/${outputUrl.split('/').pop()}`], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  } else if (mode === 'host') {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'frameforge-container-smoke-'));
    try {
      const file = path.join(temporaryRoot, 'render.mp4');
      await writeFile(file, bytes);
      result = await execute(process.env.FFPROBE_PATH || 'ffprobe', [...probeArgs, file], { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
    } finally {
      assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(tmpdir()));
      assert.ok(path.basename(temporaryRoot).startsWith('frameforge-container-smoke-'));
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  } else throw new Error('Probe mode must be container or host');
  const probe = JSON.parse(result.stdout);
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
  assert.equal(video?.width, 1080);
  assert.equal(video?.height, 1920);
  assert.equal(video?.codec_name, 'h264');
  assert.equal(audio?.codec_name, 'aac');
  assert.ok(Math.abs(Number(probe.format.duration) - 1) <= 0.2, 'Render duration differs from the saved timeline');
  return { width: video.width, height: video.height, videoCodec: video.codec_name, audioCodec: audio.codec_name, duration: Number(probe.format.duration) };
}

/** Independent authenticated deployment smoke. Tokens/cookies never enter its durable receipt. */
export async function runContainerSmoke({ stage = 'render', baseUrl = process.env.STUDIO_URL || 'http://127.0.0.1:4310', loginToken = process.env.LOGIN_TOKEN, artifactPath = 'artifacts/container-smoke.json', probeMode = process.env.CONTAINER_SMOKE_PROBE || 'container' } = {}) {
  assert.ok(['render', 'verify-persistence'].includes(stage), 'Stage must be render or verify-persistence');
  assert.ok(typeof loginToken === 'string' && loginToken.length >= 16, 'Set LOGIN_TOKEN in the execution environment');
  const parsed = new URL(baseUrl);
  assert.ok(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash, 'STUDIO_URL must be a plain HTTP(S) origin');
  const base = parsed.origin;
  await waitForHealth(base);
  const denied = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(denied.status, 401, 'Deployment must protect state before login');
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: loginToken }), signal: AbortSignal.timeout(10_000) });
  assert.equal(login.status, 200, 'Smoke authentication failed');
  const setCookie = login.headers.get('set-cookie') || '';
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(';')[0];
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Smoke API ${method} ${route} returned HTTP ${response.status}`);
    return response.json();
  };
  const state = await api('/api/state');
  let receipt;
  if (stage === 'render') {
    const marker = `container-smoke-${randomUUID()}`;
    const channel = state.channels.find((item) => item.sample) || await api('/api/channels', 'POST', { name: 'CI 검증 전용 워크스페이스', category: 'information', platform: 'test' });
    let episode = await api('/api/episodes', 'POST', { channelId: channel.id, title: `CI Docker render ${marker}`, topic: '컨테이너 렌더링과 영속 저장소 검증', category: 'information' });
    episode = await api(`/api/episodes/${episode.id}`, 'PUT', { expectedVersion: episode.version, notes: marker, scenes: [{ ...episode.scenes[0], title: 'Docker render verification', text: '컨테이너 실동작 검증\n저장부터 영상 출력까지', duration: 1, background: '#234a3c', kind: 'title', layout: 'center' }] });
    const job = await api(`/api/episodes/${episode.id}/render`, 'POST', {});
    const deadline = Date.now() + 180_000;
    let finished;
    while (Date.now() < deadline) {
      finished = (await api('/api/state')).jobs.find((item) => item.id === job.id);
      if (finished?.status === 'completed') break;
      if (finished?.status === 'failed') throw new Error(`Container render job ${job.id} failed`);
      await delay(1000);
    }
    assert.equal(finished?.status, 'completed', 'Render did not complete within three minutes');
    const deniedDownload = await fetch(base + finished.outputUrl, { signal: AbortSignal.timeout(10_000) });
    assert.equal(deniedDownload.status, 401, 'Rendered exports must require authentication');
    const media = await download(base, cookie, finished.outputUrl);
    const dimensions = await probeVideo(media.bytes, finished.outputUrl, probeMode);
    const history = await api(`/api/episodes/${episode.id}/history`);
    assert.ok(history.some((item) => item.version === episode.version && item.snapshot.notes === marker), 'Edited snapshot was not persisted');
    receipt = { schema: 'frameforge-container-smoke/v1', verifiedAt: new Date().toISOString(), probeMode, stage: 'rendered', marker, episodeId: episode.id, episodeVersion: episode.version, title: episode.title, jobId: job.id, outputUrl: finished.outputUrl, downloadBytes: media.bytes.length, sha256: media.sha256, ...dimensions, historySnapshots: history.length, authenticatedState: true, authenticatedExport: true, persistenceVerified: false };
  } else {
    const existing = JSON.parse(await readFile(artifactPath, 'utf8'));
    assert.equal(existing.schema, 'frameforge-container-smoke/v1', 'Invalid smoke receipt');
    assert.equal(existing.stage, 'rendered', 'Persistence stage requires a completed render receipt');
    const episode = state.episodes.find((item) => item.id === existing.episodeId);
    assert.ok(episode, 'Episode did not survive service restart');
    assert.equal(episode.version, existing.episodeVersion);
    assert.equal(episode.title, existing.title);
    assert.equal(episode.notes, existing.marker);
    const job = state.jobs.find((item) => item.id === existing.jobId);
    assert.equal(job?.status, 'completed', 'Completed job did not survive restart');
    assert.equal(job.outputUrl, existing.outputUrl);
    const media = await download(base, cookie, existing.outputUrl);
    assert.equal(media.sha256, existing.sha256, 'Export bytes changed or disappeared after restart');
    const history = await api(`/api/episodes/${episode.id}/history`);
    assert.equal(history.length, existing.historySnapshots);
    receipt = { ...existing, stage: 'persistence-verified', persistenceVerified: true, restartVerifiedAt: new Date().toISOString() };
  }
  await api('/api/logout', 'POST', {});
  const revoked = await fetch(`${base}/api/state`, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
  assert.equal(revoked.status, 401, 'Logout did not revoke the session');
  await mkdir(path.dirname(path.resolve(artifactPath)), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const receipt = await runContainerSmoke({ stage: process.argv[2] || 'render' });
    console.log(`Container smoke ${receipt.stage}: ${receipt.width}x${receipt.height} ${receipt.videoCodec}/${receipt.audioCodec}; ${receipt.downloadBytes} bytes; persistence=${receipt.persistenceVerified}`);
  } catch (error) {
    console.error(`Container smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}
