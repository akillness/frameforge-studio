import { open, unlink } from 'node:fs/promises';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const API_ORIGIN = 'https://api.higgsfield.ai';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const ASSET_HOSTS = new Set(['images.higgs.ai', 'd8j0ntlcm91z4.cloudfront.net', 'd28lhcrx5qdowv.cloudfront.net']);
const terminal = new Set(['completed', 'failed', 'nsfw', 'canceled', 'cancelled']);

// This API mapping is verified against the model-specific reference, not inferred
// from the CLI catalog. CLI models remain independently discoverable in full.
export const HIGGSFIELD_API_MODELS = [{
  id: 'bytedance/seedance-2.5/text-to-video', name: 'Seedance 2.5', type: 'video', transport: 'api',
  documentation: 'https://open.higgsfield.ai/models/bytedance/seedance-2.5/text-to-video/api-reference',
  parameters: [
    { name: 'prompt', type: 'string', required: true },
    { name: 'duration', type: 'integer', minimum: 4, maximum: 30, default: 5 },
    { name: 'resolution', type: 'string', enum: ['480p', '720p', '1080p'], default: '720p' },
    { name: 'aspect_ratio', type: 'string', enum: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'], default: '16:9' },
    { name: 'output_format', type: 'string', enum: ['mp4', 'mov'], default: 'mp4' },
    { name: 'generate_audio', type: 'boolean', default: true },
  ],
}];

export function higgsfieldError(message, code = 'HIGGSFIELD_ERROR', statusCode = 502) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function validateHiggsfieldId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw higgsfieldError('Invalid Higgsfield request identifier', 'INVALID_INPUT', 400);
  return id;
}

export function validateGenerationInput(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw higgsfieldError('Generation parameters must be an object', 'INVALID_INPUT', 400);
  const definitions = new Map((schema.parameters || schema.params || []).map(item => [item.name, item]));
  const result = {};
  for (const [name, value] of Object.entries(input)) {
    const field = definitions.get(name);
    if (!field || !/^[a-z][a-z0-9_]*$/.test(name)) throw higgsfieldError(`Unsupported generation parameter: ${name.slice(0,64)}`, 'INVALID_INPUT', 400);
    const kinds = String(field.type).split('|');
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!(kinds.includes(kind) || (kinds.includes('integer') && Number.isInteger(value)))) throw higgsfieldError(`Invalid type for ${name}`, 'INVALID_INPUT', 400);
    if (typeof value === 'number' && (!Number.isFinite(value) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) throw higgsfieldError(`Out of range: ${name}`, 'INVALID_INPUT', 400);
    if (field.enum && value !== null && !field.enum.includes(value)) throw higgsfieldError(`Unsupported value for ${name}`, 'INVALID_INPUT', 400);
    if (typeof value === 'string' && (value.length > 10000 || value.includes('\0'))) throw higgsfieldError(`Invalid text for ${name}`, 'INVALID_INPUT', 400);
    result[name] = value;
  }
  for (const field of definitions.values()) if (field.required && (result[field.name] === undefined || result[field.name] === null || result[field.name] === '')) throw higgsfieldError(`Required generation parameter: ${field.name}`, 'INVALID_INPUT', 400);
  if (JSON.stringify(result).length > 20000) throw higgsfieldError('Generation input too large', 'INVALID_INPUT', 400);
  return result;
}

export function normalizeHiggsfieldModels(raw) {
  if (!Array.isArray(raw)) throw higgsfieldError('Invalid Higgsfield model catalog');
  return raw.filter(item => item && ID.test(item.job_type || '')).map(item => ({ id: item.job_type, name: String(item.display_name || item.job_type).slice(0,160), type: String(item.type || 'unknown'), transport: 'cli' }));
}

export function normalizeHiggsfieldJob(raw, transport = 'api') {
  if (Array.isArray(raw)) {
    if (raw.length !== 1) throw higgsfieldError('Expected exactly one Higgsfield job', 'AMBIGUOUS_SUBMISSION');
    raw = raw[0];
  }
  if (typeof raw === 'string') raw = { id: raw, status: 'queued' };
  const requestId = validateHiggsfieldId(raw?.request_id || raw?.id);
  const status = String(raw.status || 'queued').toLowerCase();
  if (!['queued', 'pending', 'processing', 'running', 'in_progress', ...terminal].includes(status)) throw higgsfieldError('Unknown Higgsfield generation state');
  const outputs = [];
  const add = (value, type) => { if (typeof value === 'string') outputs.push({ url: value, type }); };
  for (const item of raw.images || []) add(item.url, 'image');
  add(raw.video?.url, 'video');
  add(raw.audio?.url, 'audio');
  add(raw.result_url, raw.type || (/\.(mp4|mov)(\?|$)/i.test(raw.result_url || '') ? 'video' : /\.(wav|mp3|m4a)(\?|$)/i.test(raw.result_url || '') ? 'audio' : 'image'));
  return { requestId, status: ['pending'].includes(status) ? 'queued' : ['processing','running'].includes(status) ? 'in_progress' : status === 'cancelled' ? 'canceled' : status, outputs, transport };
}

async function readBoundedJson(response) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw higgsfieldError('Higgsfield response exceeded limit');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw higgsfieldError('Higgsfield returned invalid JSON'); }
}

const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;

function validateHiggsfieldIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) throw higgsfieldError('Invalid Higgsfield idempotency key', 'INVALID_INPUT', 400);
  return value;
}

function normalizeHiggsfieldEstimate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw higgsfieldError('Invalid Higgsfield estimate response', 'PROVIDER_ERROR', 502);
  const number = (value) => {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(parsed) || parsed < 0) throw higgsfieldError('Invalid Higgsfield estimate response', 'PROVIDER_ERROR', 502);
    return parsed;
  };
  return { credits: number(raw.credits), usd: number(raw.usd) };
}

export function createHiggsfieldApi({ env = process.env, fetchImpl = fetch } = {}) {
  const credentials = env.HF_API_KEY || env.HF_CREDENTIALS || '';
  const configured = Boolean(credentials && !/[\r\n]/.test(credentials));
  async function call(path, body, { ambiguousSubmission = false, idempotencyKey } = {}) {
    if (!configured) throw higgsfieldError('Higgsfield API key is not configured', 'NOT_CONFIGURED', 503);
    let response;
    const headers = { authorization: `Key ${credentials}`, 'content-type': 'application/json' };
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = validateHiggsfieldIdempotencyKey(idempotencyKey);
    try { response = await fetchImpl(`${API_ORIGIN}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw higgsfieldError(ambiguousSubmission ? 'Higgsfield submission outcome is unknown; do not automatically resubmit' : 'Higgsfield request could not be reached', ambiguousSubmission ? 'AMBIGUOUS_SUBMISSION' : 'PROVIDER_UNAVAILABLE'); }
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      const code = response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED' : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_ERROR';
      throw higgsfieldError(`Higgsfield API returned HTTP ${response.status}`, code, response.status === 429 ? 429 : 502);
    }
    try { return await readBoundedJson(response); }
    catch (error) {
      if (ambiguousSubmission) throw higgsfieldError('Higgsfield submission response is unreadable; do not automatically resubmit', 'AMBIGUOUS_SUBMISSION');
      throw error;
    }
  }
  const modelSchema = async id => {
    const model = HIGGSFIELD_API_MODELS.find(item => item.id === id);
    if (!model) throw higgsfieldError('API model mapping has not been verified; select the CLI transport for the complete live catalog', 'INVALID_INPUT', 400);
    return structuredClone(model);
  };
  return {
    configured, transport: 'api', models: async () => structuredClone(HIGGSFIELD_API_MODELS), modelSchema,
    estimate: async ({ model, prompt, params = {} }) => {
      const schema = await modelSchema(model);
      return normalizeHiggsfieldEstimate(await call(`estimate/${schema.id}`, validateGenerationInput(schema, { ...params, prompt })));
    },
    create: async ({ model, prompt, params = {}, idempotencyKey }) => {
      const schema = await modelSchema(model);
      const raw = await call(schema.id, validateGenerationInput(schema, { ...params, prompt }), { ambiguousSubmission: true, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
      try { return normalizeHiggsfieldJob(raw); }
      catch { throw higgsfieldError('Higgsfield submission returned an unrecognized receipt; do not automatically resubmit', 'AMBIGUOUS_SUBMISSION'); }
    },
    status: async id => normalizeHiggsfieldJob(await call(`requests/${validateHiggsfieldId(id)}/status`)),
    cancel: async id => call(`requests/${validateHiggsfieldId(id)}/cancel`, {}),
  };
}

export function validateHiggsfieldAssetUrl(value) {
  let url; try { url = new URL(value); } catch { throw higgsfieldError('Invalid Higgsfield asset URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !ASSET_HOSTS.has(url.hostname)) throw higgsfieldError('Higgsfield asset host is not trusted', 'UNTRUSTED_ASSET', 422);
  return url;
}

export function isPublicAddress(address) {
  if (isIP(address) !== 4) return false; // Pin public IPv4; reject IPv6/private aliases rather than guess.
  const [a,b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0));
}

export async function downloadHiggsfieldAsset(value, destination, { lookupImpl = lookup, requestImpl = https.get, maxBytes = 100 * 1024 * 1024 } = {}) {
  const url = validateHiggsfieldAssetUrl(value);
  let dnsDeadline;
  let addresses;
  try {
    addresses = await Promise.race([lookupImpl(url.hostname, { all: true, family: 4 }), new Promise((_, reject) => { dnsDeadline = setTimeout(() => reject(higgsfieldError('Higgsfield asset DNS lookup timed out')), 10000); dnsDeadline.unref?.(); })]);
  } finally { clearTimeout(dnsDeadline); }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw higgsfieldError('Higgsfield asset resolved to an unsafe network address', 'UNTRUSTED_ASSET', 422);
  const address = addresses[0];
  let file;
  let deadline;
  try {
    file = await open(destination, 'wx');
    const response = await new Promise((resolve, reject) => {
      const request = requestImpl(url, { timeout: 30000, lookup: (_host, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, 4) }, resolve);
      deadline = setTimeout(() => request.destroy(higgsfieldError('Higgsfield asset download deadline exceeded')), 60000);
      deadline.unref?.();
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', () => reject(higgsfieldError('Higgsfield asset download failed')));
    });
    if (response.statusCode !== 200 || !/^(image\/(png|jpeg|webp)|video\/(mp4|quicktime)|audio\/(mpeg|wav|x-wav|mp4))(;|$)/i.test(response.headers['content-type'] || '')) { response.destroy(); throw higgsfieldError('Higgsfield asset response is not supported media'); }
    let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > maxBytes) { response.destroy(); throw higgsfieldError('Higgsfield asset exceeds size limit'); }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw higgsfieldError('Higgsfield asset could not be written');
        offset += bytesWritten;
      }
    }
    if (!bytes) throw higgsfieldError('Higgsfield asset is empty');
    await file.close(); file = null;
    return { bytes, contentType: response.headers['content-type'].split(';')[0] };
  } catch (error) {
    if (file) { await file.close(); await unlink(destination).catch(() => {}); }
    throw error;
  } finally { clearTimeout(deadline); }
}
