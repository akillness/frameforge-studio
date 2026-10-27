import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { higgsfieldError, normalizeHiggsfieldModels, normalizeHiggsfieldJob, validateGenerationInput, validateHiggsfieldId } from './higgsfield.mjs';

const run = promisify(execFile);
const MODEL = /^[a-z][a-z0-9_]{0,100}$/;
const forbidden = new Set(['batch_size', 'batch_count', 'num_images', 'num_outputs', 'wait', 'json', 'help', 'workspace', 'api_key', 'token', 'url']);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function resolveHiggsfieldBinary(env = process.env) {
  const candidates = process.platform === 'win32' ? [
    env.APPDATA && path.join(env.APPDATA, 'npm/node_modules/@higgsfield/cli/vendor/hf.exe'),
    path.join(path.dirname(process.execPath), 'node_modules/@higgsfield/cli/vendor/hf.exe'),
  ] : ['/usr/local/bin/higgsfield', '/usr/bin/higgsfield'];
  return candidates.filter(Boolean).find(file => existsSync(file)) || null;
}

export function buildHiggsfieldCliArgs(action, { model, prompt, params = {}, requestId } = {}, schema) {
  if (action === 'models') return ['model', 'list', '--json'];
  if (action === 'status') return ['generate', 'get', validateHiggsfieldId(requestId), '--json'];
  if (!MODEL.test(model || '')) throw higgsfieldError('Invalid Higgsfield CLI model', 'INVALID_INPUT', 400);
  if (action === 'modelSchema') return ['model', 'get', model, '--json'];
  if (!['estimate','create'].includes(action)) throw higgsfieldError('Unsupported Higgsfield action', 'INVALID_INPUT', 400);
  const input = validateGenerationInput(schema, { ...params, prompt });
  const args = ['generate', action === 'estimate' ? 'cost' : 'create', model];
  for (const [name, value] of Object.entries(input)) {
    if (forbidden.has(name) || !['string','number','boolean'].includes(typeof value) || (typeof value === 'string' && value.startsWith('@'))) throw higgsfieldError(`Unsupported generation input: ${name}`, 'INVALID_INPUT', 400);
    // CLI media flags can read local files. This adapter supports prompt-only
    // generation; references need a separate authenticated upload/ownership flow.
    if (/image|video|audio_reference|medias|voice|draft_job/.test(name)) throw higgsfieldError('Reference media needs the authenticated upload integration', 'UNSUPPORTED', 422);
    args.push(`--${name}=${String(value)}`);
  }
  // Some image models default to multiple outputs. Explicitly ask for one when
  // the live schema declares a batch control; never create untracked siblings.
  for (const field of schema.parameters || schema.params || []) {
    if (['batch_size','batch_count','num_images','num_outputs'].includes(field.name)) {
      if ((field.enum && !field.enum.includes(1)) || (field.minimum !== undefined && field.minimum > 1)) throw higgsfieldError('This model cannot submit a single output through the editor', 'UNSUPPORTED', 422);
      args.push(`--${field.name}=1`);
    }
  }
  args.push('--json');
  return args;
}

export function createHiggsfieldCli({ execute, binary = resolveHiggsfieldBinary(), now = Date.now } = {}) {
  const invoke = execute || (async args => {
    if (!binary || !path.isAbsolute(binary) || /\.(cmd|bat|ps1)$/i.test(binary)) throw higgsfieldError('Higgsfield CLI is not installed', 'NOT_CONFIGURED', 503);
    return run(binary, args, { windowsHide: true, shell: false, timeout: 45000, maxBuffer: 1024 * 1024, env: { ...process.env, HIGGSFIELD_INSTALL_METHOD: 'npm' } });
  });
  async function command(args, submission = false) {
    try {
      const result = await invoke(args);
      const text = typeof result === 'string' ? result : result.stdout;
      return JSON.parse(text);
    } catch (error) {
      if (error.code === 'NOT_CONFIGURED') throw error;
      // CLI errors can contain prompts, account details or tokens: never relay.
      throw higgsfieldError(submission ? 'Higgsfield submission outcome is unknown; inspect provider history before resubmitting' : 'Higgsfield CLI request failed; check host authentication and connectivity', submission ? 'AMBIGUOUS_SUBMISSION' : 'PROVIDER_UNAVAILABLE');
    }
  }
  const models = async () => normalizeHiggsfieldModels(await command(buildHiggsfieldCliArgs('models')));
  const modelSchema = async model => {
    const raw = await command(buildHiggsfieldCliArgs('modelSchema', { model }));
    if (raw.job_type !== model || !Array.isArray(raw.params)) throw higgsfieldError('Invalid Higgsfield model schema');
    return { id: model, name: String(raw.display_name || model), type: raw.type, transport: 'cli', parameters: raw.params, rules: raw.rules || [], inputMode: 'prompt-only' };
  };
  async function generate(action, payload) {
    // Unfiltered catalog discovery precedes schema lookup; never invent IDs.
    if (!(await models()).some(item => item.id === payload.model)) throw higgsfieldError('Higgsfield model is not in the live catalog', 'INVALID_INPUT', 400);
    const schema = await modelSchema(payload.model);
    const args = buildHiggsfieldCliArgs(action, payload, schema);
    if (action === 'create' && (payload.quoteExpiresAt !== undefined || payload.quoteSchemaHash !== undefined)) {
      const schemaHash = createHash('sha256').update(JSON.stringify(canonical(schema))).digest('hex');
      if (typeof payload.quoteSchemaHash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.quoteSchemaHash) || payload.quoteSchemaHash !== schemaHash) throw higgsfieldError('Music model schema changed before provider submission', 'SCHEMA_CHANGED', 409);
      const deadline = payload.quoteExpiresAt;
      if (typeof deadline !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(deadline) || !Number.isFinite(Date.parse(deadline)) || new Date(deadline).toISOString() !== deadline || !Number.isFinite(now()) || now() >= Date.parse(deadline)) throw higgsfieldError('Music quote expired before provider submission', 'EXPIRED_QUOTE', 409);
    }
    return command(args, action === 'create');
  }
  const provider = {
    configured: Boolean(execute || binary), transport: 'cli', models, modelSchema,
    accountStatus: async () => {
      const configured = Boolean(execute || binary);
      try {
        const raw = await command(['account','status','--json']);
        // Installed official CLI 1.1.26 returns account fields on authenticated
        // success (and exits nonzero for an expired session), not an auth flag.
        const authenticated = raw?.authenticated === true || (typeof raw?.email === 'string' && raw.email.includes('@') && Number.isFinite(raw.credits));
        return { provider: 'higgsfield', transport: 'cli', configured, authenticated, available: authenticated };
      } catch {
        return { provider: 'higgsfield', transport: 'cli', configured, authenticated: false, available: false };
      }
    },
    estimate: async payload => {
      const raw = await generate('estimate', payload);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw higgsfieldError('Invalid Higgsfield cost response');
      return Object.fromEntries(Object.entries(raw).filter(([key,value]) => /cost|credit|currency|price|balance/i.test(key) && ['number','string'].includes(typeof value)));
    },
    create: async payload => {
      const raw = await generate('create', payload);
      try { return normalizeHiggsfieldJob(raw, 'cli'); }
      catch { throw higgsfieldError('Higgsfield submission returned an unrecognized receipt; inspect provider history before resubmitting', 'AMBIGUOUS_SUBMISSION'); }
    },
    status: async requestId => normalizeHiggsfieldJob(await command(buildHiggsfieldCliArgs('status', { requestId })), 'cli'),
  };
  provider.capability = provider.accountStatus;
  return provider;
}
