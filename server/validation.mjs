import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'JSON object required');
  return value;
}

export function text(value, name, max = 500, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new HttpError(400, `${name} must be nonempty text (maximum ${max} characters)`);
  }
  return value.trim();
}

export function optionalText(value, name, max = 5000) {
  return value === undefined || value === '' ? '' : text(value, name, max);
}

export function choice(value, values, name, fallback) {
  const selected = value ?? fallback;
  if (!values.includes(selected)) throw new HttpError(400, `Invalid ${name}`);
  return selected;
}

export function url(value) {
  const input = text(value, 'url', 2000);
  let parsed;
  try { parsed = new URL(input); } catch { throw new HttpError(400, 'Invalid URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new HttpError(400, 'Only HTTP(S) URLs without credentials are allowed');
  return parsed.href;
}

export const formats = ['9:16', '16:9', '1:1'];

function boundedNumber(value, name, min, max, fallback) {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== 'number' || !Number.isFinite(selected) || selected < min || selected > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return selected;
}

export function scenes(value) {
  if (!Array.isArray(value) || !value.length || value.length > 60) throw new HttpError(400, 'Between 1 and 60 scenes are required');
  const ids = new Set();
  const result = value.map((raw) => {
    const scene = object(raw);
    const id = scene.id === undefined ? randomUUID() : text(scene.id, 'scene id', 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new HttpError(400, 'Scene IDs must be unique and portable');
    ids.add(id);
    if (typeof scene.duration !== 'number' || !Number.isFinite(scene.duration) || scene.duration < 0.5 || scene.duration > 120) throw new HttpError(400, 'Scene duration must be 0.5–120 seconds');
    if (typeof scene.background !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(scene.background)) throw new HttpError(400, 'Background must be a six-digit hex color');
    const assetUrl = optionalText(scene.assetUrl, 'assetUrl', 200);
    if (assetUrl && !/^\/api\/uploads\/[a-f0-9-]{36}\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|ogg)$/i.test(assetUrl)) throw new HttpError(400, 'Scene assets must be local uploaded media');
    const audioUrl = optionalText(scene.audioUrl, 'audioUrl', 200);
    if (audioUrl && !/^\/api\/uploads\/[a-f0-9-]{36}\.(?:mp3|wav|ogg)$/i.test(audioUrl)) throw new HttpError(400, 'Scene audio must be a local uploaded audio file');
    const trimStart = boundedNumber(scene.trimStart, 'trimStart', 0, 36000, 0);
    const audioVolume = boundedNumber(scene.audioVolume, 'audioVolume', 0, 2, 1);
    const kind = choice(scene.kind, ['title', 'video', 'image'], 'scene kind', 'title');
    if (kind !== 'title' && !assetUrl) throw new HttpError(400, `${kind} scenes require an uploaded asset`);
    return { id, title: text(scene.title, 'scene title', 160, '장면'), text: optionalText(scene.text, 'scene text', 2000), duration: scene.duration, background: scene.background, kind, layout: choice(scene.layout, ['center', 'lower-third', 'split'], 'layout', 'center'), ...(assetUrl ? { assetUrl } : {}), ...(audioUrl ? { audioUrl } : {}), trimStart, audioVolume, narration: optionalText(scene.narration, 'narration', 4000) };
  });
  if (result.reduce((sum, scene) => sum + scene.duration, 0) > 1800) throw new HttpError(400, 'Episode duration must not exceed 30 minutes');
  return result;
}

export function episodePatch(body) {
  object(body);
  const patch = {};
  for (const [key, max] of [['title', 200], ['topic', 500]]) if (key in body) patch[key] = text(body[key], key, max);
  if ('notes' in body) patch.notes = optionalText(body.notes, 'notes', 20000);
  if ('status' in body) patch.status = choice(body.status, ['draft', 'review', 'ready'], 'status');
  if ('format' in body) patch.format = choice(body.format, formats, 'format');
  if ('scenes' in body) patch.scenes = scenes(body.scenes);
  if ('expectedVersion' in body && (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1)) throw new HttpError(400, 'expectedVersion must be a positive integer');
  if (!Object.keys(patch).length) throw new HttpError(400, 'No editable fields supplied');
  return patch;
}
