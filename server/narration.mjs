import { mkdir, writeFile, realpath, stat, unlink, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execute } from './process.mjs';
import { HttpError, object, text, scenes } from './validation.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/speech.ps1', import.meta.url));
const stamp = () => new Date().toISOString();
const active = job => ['queued', 'running'].includes(job.status);

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
  const inputPath = path.join(workDir, `${randomUUID()}.json`);
  await writeFile(inputPath, JSON.stringify({ text: speech, voice, rate }), { mode: 0o600 });
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', SCRIPT, '-Action', 'synthesize', '-InputPath', inputPath, '-OutputPath', outputPath], { timeout: 120000 });
  const { stdout } = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', outputPath], { timeout: 15000 });
  const duration = Number(JSON.parse(stdout).format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 119.7) throw new HttpError(400, 'Narration exceeds the scene duration limit; shorten the script');
  return { duration };
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
    const body = object(raw), episode = this.store.get('episodes', id);
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
      if (this.store.get('episodes', id).version !== episode.version) throw new HttpError(409, 'Episode changed while loading voices');
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
      await mkdir(work, { recursive: true });
      const uploadRoot = await realpath(path.join(root, 'uploads'));
      update({ status: 'running', progress: 1 });
      const next = structuredClone(episode.scenes);
      for (const scene of selected) {
        if (this.closed) return;
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
