#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  SUPPORTED_VERSIONS,
  MODERN_VERSIONS,
  LEGACY_VERSIONS,
  META_VERSION,
  META_CAPABILITIES,
  META_SERVER_INFO,
  META_ERROR,
  ERROR,
  rpcError,
  consumeJsonLines,
} from '../server/mcp.mjs';

const string = { type: 'string', minLength: 1 };
const version = { type: 'integer', minimum: 1 };
const annotations = (title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint) => Object.freeze({
  title,
  readOnlyHint,
  destructiveHint,
  idempotentHint,
  openWorldHint,
});
const tools = Object.freeze([
  Object.freeze({
    name: 'higgsfield_models',
    title: 'List Higgsfield models',
    description: 'List Higgsfield models, or inspect one model schema through FrameForge.',
    inputSchema: { type: 'object', properties: { model: string }, additionalProperties: false },
    annotations: annotations('List Higgsfield models', true, false, true, true),
  }),
  Object.freeze({
    name: 'higgsfield_create',
    title: 'Submit billable Higgsfield generation',
    description: 'Submit one billable generation for an episode. Preserve requestId to prevent duplicate submissions; does not automatically apply the result.',
    inputSchema: { type: 'object', properties: { episodeId: string, sceneId: string, expectedVersion: version, model: string, prompt: string, params: { type: 'object' }, requestId: string }, required: ['episodeId', 'sceneId', 'expectedVersion', 'model', 'prompt', 'requestId'], additionalProperties: false },
    annotations: annotations('Submit billable Higgsfield generation', false, true, false, true),
  }),
  Object.freeze({
    name: 'higgsfield_status',
    title: 'Get Higgsfield generation status',
    description: 'Refresh a previously stored FrameForge generation without resubmitting.',
    inputSchema: { type: 'object', properties: { generationId: string }, required: ['generationId'], additionalProperties: false },
    annotations: annotations('Get Higgsfield generation status', true, false, true, true),
  }),
  Object.freeze({
    name: 'higgsfield_recover',
    title: 'Recover existing Higgsfield generation',
    description: 'Recover polling or media import for an existing provider request ID only. Never submits a new generation or incurs a new generation charge.',
    inputSchema: { type: 'object', properties: { generationId: string }, required: ['generationId'], additionalProperties: false },
    annotations: annotations('Recover existing Higgsfield generation', false, false, true, true),
  }),
  Object.freeze({
    name: 'higgsfield_apply',
    title: 'Apply completed generation to scene',
    description: 'Apply a completed generation to one scene at the exact current episode version.',
    inputSchema: { type: 'object', properties: { generationId: string, sceneId: string, expectedVersion: version }, required: ['generationId', 'sceneId', 'expectedVersion'], additionalProperties: false },
    annotations: annotations('Apply completed generation to scene', false, true, false, false),
  }),
]);
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
const serverInfo = Object.freeze({ name: 'frameforge-higgsfield-bridge', title: 'FrameForge Higgsfield Bridge', version: '1.0.0' });
const instructions = 'Project-owned bridge to authenticated FrameForge generation APIs; not an official Higgsfield MCP server.';
const capabilities = Object.freeze({ tools: Object.freeze({ listChanged: false }) });
const CACHE = Object.freeze({ ttlMs: 300000, cacheScope: 'private' });
const COMPAT_VERSIONS = Object.freeze([...SUPPORTED_VERSIONS, '2024-11-05']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createHiggsfieldMcp({ env = process.env, fetchImpl = fetch } = {}) {
  const origin = new URL(env.FRAMEFORGE_URL || 'http://127.0.0.1:4310');
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) throw new Error('FrameForge URL must be HTTPS or loopback HTTP');
  const token = env.FRAMEFORGE_TOKEN || env.LOGIN_TOKEN;
  let sessionCookie;
  let loginPending;
  async function login() {
    if (sessionCookie) return;
    if (loginPending) return loginPending;
    loginPending = (async () => {
      if (!token) throw new Error('FrameForge token is not configured');
      let response;
      try { response = await fetchImpl(new URL('/api/login', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), redirect: 'error', signal: AbortSignal.timeout(15000) }); }
      catch { throw new Error('FrameForge login could not be reached'); }
      const cookie = response.headers.get('set-cookie')?.match(/(?:^|,\s*)frameforge_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      response.body?.cancel().catch(() => {});
      if (!response.ok || !cookie) throw new Error(`FrameForge login failed (HTTP ${response.status})`);
      sessionCookie = `frameforge_session=${cookie}`;
    })();
    try { await loginPending; } finally { loginPending = undefined; }
  }
  async function api(route, body) {
    await login();
    let response;
    const send = () => fetchImpl(new URL(route, origin), { method: body ? 'POST' : 'GET', headers: { cookie: sessionCookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000), redirect: 'error' });
    try { response = await send(); }
    catch { throw new Error('FrameForge request did not complete; preserve requestId before retrying'); }
    if (response.status === 401) {
      sessionCookie = undefined;
      if (!body) {
        response.body?.cancel().catch(() => {});
        await login();
        try { response = await send(); } catch { throw new Error('FrameForge request did not complete'); }
      }
      // POSTs are never replayed automatically, including generation and apply.
    }
    if (!response.ok) { response.body?.cancel().catch(() => {}); throw new Error(`FrameForge returned HTTP ${response.status}`); }
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of response.body || []) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { response.body?.cancel().catch(() => {}); throw new Error('FrameForge response exceeds limit'); }
        chunks.push(chunk);
      }
    } catch (error) {
      response.body?.cancel().catch(() => {});
      throw error;
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return JSON.parse(text); } catch { throw new Error('FrameForge returned invalid JSON'); }
  }
  return async (message) => {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(isObject(message) ? message.id : null, ERROR.INVALID_REQUEST, 'Invalid request');
    if (message.id === undefined) return null;
    const id = message.id;
    if (!(typeof id === 'string' || Number.isInteger(id))) return rpcError(null, ERROR.INVALID_REQUEST, 'Request id must be a string or integer');
    if (message.params !== undefined && !isObject(message.params)) return rpcError(id, ERROR.INVALID_PARAMS, 'params must be an object');
    const params = message.params || {};

    if (message.method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = COMPAT_VERSIONS.includes(requested) ? requested : '2024-11-05';
      return { jsonrpc: '2.0', id, result: { protocolVersion, capabilities, serverInfo, instructions } };
    }
    const meta = isObject(params._meta) ? params._meta : {};
    const requestedVersion = meta[META_VERSION];
    const modern = requestedVersion !== undefined;
    if (modern) {
      if (!MODERN_VERSIONS.includes(requestedVersion)) return rpcError(id, ERROR.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...COMPAT_VERSIONS], requested: requestedVersion });
      if (!isObject(meta[META_CAPABILITIES])) return rpcError(id, ERROR.INVALID_PARAMS, `params._meta["${META_CAPABILITIES}"] is required`);
    }
    const reply = (result, cacheable = false) => ({
      jsonrpc: '2.0',
      id,
      result: modern ? { resultType: 'complete', ...result, ...(cacheable ? CACHE : {}), _meta: { ...(result._meta || {}), [META_SERVER_INFO]: serverInfo } } : result,
    });

    if (message.method === 'server/discover' && modern) return reply({ supportedVersions: COMPAT_VERSIONS, capabilities, instructions }, true);
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools }, true);
    if (message.method !== 'tools/call') return rpcError(id, ERROR.METHOD_NOT_FOUND, 'Method not found');

    try {
      const tool = toolsByName.get(params.name);
      const args = params.arguments || {};
      if (!tool || !isObject(args)) throw new Error('Unknown tool or invalid arguments');
      for (const key of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error('Unexpected tool argument');
      for (const key of tool.inputSchema.required || []) if (args[key] === undefined) throw new Error(`Missing argument: ${key}`);
      for (const [key, value] of Object.entries(args)) {
        const field = tool.inputSchema.properties[key];
        if ((field.type === 'string' && (typeof value !== 'string' || !value.length || value.length > 10000)) || (field.type === 'integer' && (!Number.isInteger(value) || value < 1)) || (field.type === 'object' && !isObject(value))) throw new Error(`Invalid argument: ${key}`);
      }
      const idVal = (value) => { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid local identifier'); return value; };
      let result;
      if (tool.name === 'higgsfield_models') result = await api(`/api/generation/models${args.model ? `?model=${encodeURIComponent(args.model)}` : ''}`);
      if (tool.name === 'higgsfield_status') result = await api(`/api/generations/${idVal(args.generationId)}`);
      if (tool.name === 'higgsfield_recover') result = await api(`/api/generations/${idVal(args.generationId)}/recover`, {});
      if (tool.name === 'higgsfield_create') { const { episodeId, ...body } = args; result = await api(`/api/episodes/${idVal(episodeId)}/generations`, body); }
      if (tool.name === 'higgsfield_apply') { const { generationId, ...body } = args; result = await api(`/api/generations/${idVal(generationId)}/apply`, body); }
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], ...(isObject(result) ? { structuredContent: result } : {}) });
    } catch (error) {
      return reply({
        isError: true,
        content: [{ type: 'text', text: error.message }],
        ...(modern ? { _meta: { [META_ERROR]: { status: 400, message: error.message } } } : {}),
      });
    }
  };
}

export async function runHiggsfieldMcp(input = process.stdin, output = process.stdout) {
  const handle = createHiggsfieldMcp();
  const pending = new Set();
  const write = (value) => output.write(`${JSON.stringify(value)}\n`);
  async function dispatch(line) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return write(rpcError(null, ERROR.PARSE, 'Parse error')); }
    const response = await handle(parsed);
    if (response) write(response);
  }
  await consumeJsonLines(input, {
    maxLineBytes: 1024 * 1024,
    onTooLarge: () => write(rpcError(null, ERROR.INVALID_REQUEST, 'Message exceeds 1 MiB')),
    onLine: (line) => {
      const task = dispatch(line).catch(() => write(rpcError(null, ERROR.INTERNAL, 'Internal error'))).finally(() => pending.delete(task));
      pending.add(task);
    },
  });
  await Promise.allSettled([...pending]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHiggsfieldMcp().catch(() => { process.stderr.write('FrameForge Higgsfield MCP stopped\n'); process.exitCode = 1; });
