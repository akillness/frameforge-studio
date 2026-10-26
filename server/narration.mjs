import { mkdir, writeFile, realpath, stat, unlink, rm, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execute } from './process.mjs';
import { HttpError, object, text, scenes } from './validation.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/speech.ps1', import.meta.url));
const stamp = () => new Date().toISOString();
const active = job => ['queued', 'running'].includes(job.status);
export const MAX_SPEECH_BYTES = 50 * 1024 * 1024;

export function speechRequest(raw) {
  const body = object(raw);
  if (Object.keys(body).some(key => !['text', 'voice', 'rate'].includes(key))) throw new HttpError(400, 'Unknown speech request field');
  const rate = body.rate ?? 0;
  if (!Number.isInteger(rate) || rate < -10 || rate > 10) throw new HttpError(400, 'Speech rate must be an integer from -10 to 10');
  return { text: text(body.text, 'speech text', 4000), voice: text(body.voice, 'voice', 160), rate };
}

export async function probeSpeechFile(outputPath) {
  const { stdout } = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-f', 'wav', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', outputPath], { timeout: 15000 });
  const parsed = JSON.parse(stdout), duration = Number(parsed.format?.duration);
  if (!parsed.streams?.some(stream => stream.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0 || duration > 119.7) throw new HttpError(400, 'Narration is invalid or exceeds the scene duration limit; shorten the script');
  return { duration };
}

export async function listSpeechVoices() {
  if (process.platform !== 'win32') return { available: false, provider: 'windows-sapi', voices: [], detail: 'Local speech requires a Windows host with installed voices.' };
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', SCRIPT, '-Action', 'voices'], { timeout: 20000 });
    const voices = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    if (!Array.isArray(voices)) throw new Error('Invalid voice listing');
    return { available: voices.length > 0, provider: 'windows-sapi', voices, local: true };
  } catch { return { available: false, provider: 'windows-sapi', voices: [], detail: 'Installed system voices could not be loaded.' }; }
}

export async function synthesizeSpeech({ text: speech, voice, rate, outputPath, workDir }) {
  if (process.platform !== 'win32') throw new HttpError(503, 'Windows speech is unavailable on this host');
  const request = speechRequest({ text: speech, voice, rate });
  const inputPath = path.join(workDir, `${randomUUID()}.json`);
  await writeFile(inputPath, JSON.stringify(request), { mode: 0o600 });
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', SCRIPT, '-Action', 'synthesize', '-InputPath', inputPath, '-OutputPath', outputPath], { timeout: 120000 });
  return probeSpeechFile(outputPath);
}

/** The bridge sends bytes only. Paths and database mutations stay owned by this queue. */
export function createBridgeSpeechProvider({ bridgeUrl = process.env.AGENT_BRIDGE_URL || 'http://127.0.0.1:4311', token = process.env.AGENT_BRIDGE_TOKEN, fetchImpl = fetch, probe = probeSpeechFile, timeout = 150000 } = {}) {
  const request = async (endpoint, body) => {
    if (typeof token !== 'string' || token.length < 24) throw new HttpError(503, 'Host speech bridge is not configured');
    const base = new URL(bridgeUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new HttpError(503, 'Host speech bridge URL is invalid');
    if (base.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost', 'host.docker.internal'].includes(base.hostname)) throw new HttpError(503, 'Host speech bridge requires HTTPS outside the local host');
    const response = await fetchImpl(new URL(endpoint, base), { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(body ? timeout : Math.min(timeout, 25000)) });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status === 429 ? 429 : 503, response.status === 429 ? 'Host speech bridge is busy; retry later' : 'Host speech bridge is unavailable or rejected the request'); }
    return response;
  };
  return {
    async listVoices() {
      try {
        const response = await request('/speech/voices');
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 65536) throw new Error('Voice response exceeds limit');
          chunks.push(Buffer.from(chunk));
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof result.available !== 'boolean' || !Array.isArray(result.voices) || result.voices.length > 256) throw new Error('Invalid host voice list');
        const voices = result.voices.map(item => ({ id: text(item.id, 'voice', 160), name: text(item.name, 'voice name', 160), language: text(item.language, 'voice language', 80) }));
        return { available: result.available && voices.length > 0, provider: 'windows-sapi', transport: 'host-bridge', local: false, voices, ...(!result.available || !voices.length ? { detail: 'Windows host speech is unavailable or has no installed voices.' } : {}) };
      } catch { return { available: false, provider: 'windows-sapi', transport: 'host-bridge', local: false, voices: [], detail: 'Host speech bridge is unavailable. Check bridge connectivity, credentials and installed Windows voices.' }; }
    },
    async synthesize({ text: speech, voice, rate, outputPath }) {
      const body = speechRequest({ text: speech, voice, rate });
      let file, response, created = false;
      try {
        response = await request('/speech/synthesize', body);
        if (!/^audio\/wav(?:;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > MAX_SPEECH_BYTES) {
          await response.body?.cancel(); throw new HttpError(502, 'Host speech returned invalid or oversized audio');
        }
        file = await open(outputPath, 'wx', 0o600); created = true;
        let size = 0, header = Buffer.alloc(0);
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_SPEECH_BYTES) throw new HttpError(502, 'Host speech audio exceeds size limit');
          if (header.length < 12) header = Buffer.concat([header, Buffer.from(chunk).subarray(0, 12 - header.length)]);
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
            if (!bytesWritten) throw new Error('Audio write made no progress');
            offset += bytesWritten;
          }
        }
        if (size < 44 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new HttpError(502, 'Host speech did not return WAV audio');
        await file.close(); file = undefined;
        const result = await probe(outputPath);
        if (!Number.isFinite(result.duration) || result.duration <= 0 || result.duration > 119.7) throw new HttpError(502, 'Host speech duration is invalid');
        return result;
      } catch (error) {
        await response?.body?.cancel().catch(() => {});
        await file?.close().catch(() => {});
        if (created) await unlink(outputPath).catch(() => {});
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, 'Host speech generation failed or timed out. Check the Windows bridge.');
      }
    },
  };
}

export function createSpeechProvider({ platform = process.platform, mode = process.env.SPEECH_PROVIDER || (platform === 'win32' ? 'windows-sapi' : 'host-bridge'), ...options } = {}) {
  if (mode === 'windows-sapi') return { listVoices: listSpeechVoices, synthesize: synthesizeSpeech };
  if (mode === 'host-bridge') return createBridgeSpeechProvider(options);
  throw new Error('SPEECH_PROVIDER must be windows-sapi or host-bridge');
}

/** One owned queue. A generated candidate is applied only to its original episode version. */
export class NarrationQueue {
  constructor({ store, listVoices = listSpeechVoices, synthesize = synthesizeSpeech }) {
    this.store = store;
    this.listVoices = listVoices;
    this.synthesize = synthesize;
    this.closed = false;
    this.running = false;
    this.queue = [];
    this.pendingEpisodes = new Set();
    for (const job of store.list('narrationJobs').filter(active)) store.save('narrationJobs', { ...job, status: 'failed', error: 'Server restarted before narration completed', updatedAt: stamp() });
  }

  async start(id, raw) {
    const body = object(raw), episode = this.store.assertEpisodeActive(id);
    if (!Number.isInteger(body.expectedVersion) || body.expectedVersion !== episode.version) throw new HttpError(409, 'Episode changed. Save and reload before generating narration.');
    const voice = text(body.voice, 'voice', 160);
    const rate = body.rate ?? 0;
    if (!Number.isInteger(rate) || rate < -10 || rate > 10) throw new HttpError(400, 'Speech rate must be an integer from -10 to 10');
    const ids = body.sceneIds ?? episode.scenes.map(scene => scene.id);
    if (!Array.isArray(ids) || !ids.length || ids.length > 60 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !episode.scenes.some(scene => scene.id === id))) throw new HttpError(400, 'Choose existing unique scenes');
    const selected = episode.scenes.filter(scene => ids.includes(scene.id)).map(scene => ({ ...scene, speech: text(scene.narration || scene.text, 'narration', 4000) }));
    if (this.closed) throw new HttpError(503, 'Service is stopping');
    if (this.pendingEpisodes.has(id) || this.store.list('narrationJobs').some(job => job.episodeId === id && active(job))) throw new HttpError(409, 'Narration is already active for this episode');
    if (this.pendingEpisodes.size + this.store.list('narrationJobs').filter(active).length >= 5) throw new HttpError(429, 'Narration queue is full');
    this.pendingEpisodes.add(id);
    try {
      const capability = await this.listVoices();
      if (this.closed) throw new HttpError(503, 'Service is stopping');
      if (!capability.available) throw new HttpError(503, capability.detail || 'Speech service unavailable');
      if (!capability.voices.some(item => item.id === voice)) throw new HttpError(400, 'Voice is not installed');
      if (this.store.assertEpisodeActive(id).version !== episode.version) throw new HttpError(409, 'Episode changed while loading voices');
      const job = this.store.create('narrationJobs', { episodeId: id, episodeVersion: episode.version, sceneIds: ids, provider: capability.provider, voice, rate, status: 'queued', progress: 0 });
      this.queue.push({ job, episode, selected });
      setImmediate(() => this.process());
      return job;
    } finally { this.pendingEpisodes.delete(id); }
  }

  async process() {
    if (this.closed || this.running || !this.queue.length) return;
    this.running = true;
    const { job, episode, selected } = this.queue.shift();
    const root = path.resolve(this.store.dataDir);
    const work = path.join(root, 'narration-work', randomUUID());
    const files = [], uploads = [];
    let applied = false;
    const update = patch => { if (!this.closed) this.store.save('narrationJobs', { ...this.store.get('narrationJobs', job.id), ...patch, updatedAt: stamp() }); };
    try {
      this.store.assertEpisodeActive(episode.id);
      await mkdir(work, { recursive: true });
      const uploadRoot = await realpath(path.join(root, 'uploads'));
      update({ status: 'running', progress: 1 });
      const next = structuredClone(episode.scenes);
      for (const scene of selected) {
        if (this.closed) return;
        this.store.assertEpisodeActive(episode.id);
        const id = randomUUID(), filename = `${id}.wav`, outputPath = path.join(uploadRoot, filename);
        files.push(outputPath);
        const { duration } = await this.synthesize({ text: scene.speech, voice: job.voice, rate: job.rate, outputPath, workDir: work });
        if (this.closed) return;
        if (!Number.isFinite(duration) || duration <= 0 || duration > 119.7) throw new HttpError(400, 'Generated narration is too long');
        const info = await stat(outputPath);
        if (!info.isFile() || info.size < 44 || info.size > 50 * 1024 * 1024 || await realpath(outputPath) !== outputPath) throw new Error('Invalid generated audio');
        const url = `/api/uploads/${filename}`;
        uploads.push({ id, filename, url, name: `${scene.title} · narration.wav`, type: 'audio/wav', size: info.size, generated: true, provider: job.provider, voice: job.voice, duration, createdAt: stamp(), updatedAt: stamp() });
        const target = next.find(item => item.id === scene.id);
        Object.assign(target, { narration: scene.speech, audioUrl: url, audioVolume: 1, duration: Math.max(target.duration, Math.ceil((duration + .2) * 10) / 10) });
        update({ progress: Math.round(uploads.length / selected.length * 95) });
      }
      if (this.closed) return;
      const updated = this.store.attachNarration(episode.id, scenes(next), episode.version, uploads);
      applied = true;
      update({ status: 'completed', progress: 100, resultVersion: updated.version, audioUrls: uploads.map(item => item.url), completedAt: stamp() });
    } catch (error) {
      update({ status: 'failed', error: error instanceof HttpError ? error.message : 'Speech generation failed. Check the installed voice and local service log.', completedAt: stamp() });
      if (!this.closed) this.store.record('narration.failed', { entityId: episode.id, jobId: job.id });
      console.error('Narration failed:', error.message);
    } finally {
      if (!applied) for (const file of files) await unlink(file).catch(() => {});
      const actual = await realpath(work).catch(() => undefined);
      const parent = await realpath(path.join(root, 'narration-work')).catch(() => undefined);
      if (actual && parent && path.dirname(actual) === parent) await rm(actual, { recursive: true, force: true });
      this.running = false;
      if (!this.closed) setImmediate(() => this.process());
    }
  }

  close() { this.closed = true; }
}
