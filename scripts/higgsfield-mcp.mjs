#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const string = { type: 'string', minLength: 1 };
const version = { type: 'integer', minimum: 1 };
const tools = [
  { name: 'higgsfield_models', description: 'List Higgsfield models, or inspect one model schema through FrameForge.', inputSchema: { type: 'object', properties: { model: string }, additionalProperties: false } },
  { name: 'higgsfield_create', description: 'Submit one billable generation for an episode. Preserve requestId to prevent duplicate submissions; does not automatically apply the result.', inputSchema: { type: 'object', properties: { episodeId: string, sceneId: string, expectedVersion: version, model: string, prompt: string, params: { type: 'object' }, requestId: string }, required: ['episodeId','sceneId','expectedVersion','model','prompt','requestId'], additionalProperties: false } },
  { name: 'higgsfield_status', description: 'Refresh a previously stored FrameForge generation without resubmitting.', inputSchema: { type: 'object', properties: { generationId: string }, required: ['generationId'], additionalProperties: false } },
  { name: 'higgsfield_recover', description: 'Recover polling or media import for an existing provider request ID only. Never submits a new generation or incurs a new generation charge.', inputSchema: { type: 'object', properties: { generationId: string }, required: ['generationId'], additionalProperties: false } },
  { name: 'higgsfield_apply', description: 'Apply a completed generation to one scene at the exact current episode version.', inputSchema: { type: 'object', properties: { generationId: string, sceneId: string, expectedVersion: version }, required: ['generationId','sceneId','expectedVersion'], additionalProperties: false } },
];

export function createHiggsfieldMcp({ env = process.env, fetchImpl = fetch } = {}) {
  const origin = new URL(env.FRAMEFORGE_URL || 'http://127.0.0.1:4310');
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname)))) throw new Error('FrameForge URL must be HTTPS or loopback HTTP');
  const token = env.FRAMEFORGE_TOKEN || env.LOGIN_TOKEN;
  let sessionCookie;
  let loginPending;
  async function login() {
    if (sessionCookie) return;
    if (loginPending) return loginPending;
    loginPending = (async () => {
      if (!token) throw new Error('FrameForge token is not configured');
      let response;
      try { response = await fetchImpl(new URL('/api/login',origin), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({token}), redirect:'error', signal:AbortSignal.timeout(15000) }); }
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
    const send = () => fetchImpl(new URL(route, origin), { method: body ? 'POST' : 'GET', headers: { cookie:sessionCookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000), redirect: 'error' });
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
    for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('FrameForge response exceeds limit'); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return JSON.parse(text); } catch { throw new Error('FrameForge returned invalid JSON'); }
  }
  return async message => {
    if (!message || message.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    if (message.id === undefined) return null;
    const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'frameforge-higgsfield-bridge', version: '1.0.0' }, instructions: 'Project-owned bridge to authenticated FrameForge generation APIs; not an official Higgsfield MCP server.' });
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools });
    if (message.method !== 'tools/call') return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
    try {
      const tool = tools.find(item => item.name === message.params?.name);
      const args = message.params?.arguments || {};
      if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown tool or invalid arguments');
      for (const key of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties,key)) throw new Error('Unexpected tool argument');
      for (const key of tool.inputSchema.required || []) if (args[key] === undefined) throw new Error(`Missing argument: ${key}`);
      for (const [key,value] of Object.entries(args)) {
        const field = tool.inputSchema.properties[key];
        if ((field.type === 'string' && (typeof value !== 'string' || !value.length || value.length > 10000)) || (field.type === 'integer' && (!Number.isInteger(value) || value < 1)) || (field.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value)))) throw new Error(`Invalid argument: ${key}`);
      }
      const id = value => { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid local identifier'); return value; };
      let result;
      if (tool.name === 'higgsfield_models') result = await api(`/api/generation/models${args.model ? `?model=${encodeURIComponent(args.model)}` : ''}`);
      if (tool.name === 'higgsfield_status') result = await api(`/api/generations/${id(args.generationId)}`);
      if (tool.name === 'higgsfield_recover') result = await api(`/api/generations/${id(args.generationId)}/recover`, {});
      if (tool.name === 'higgsfield_create') { const { episodeId, ...body } = args; result = await api(`/api/episodes/${id(episodeId)}/generations`, body); }
      if (tool.name === 'higgsfield_apply') { const { generationId, ...body } = args; result = await api(`/api/generations/${id(generationId)}/apply`, body); }
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (error) { return reply({ isError: true, content: [{ type: 'text', text: error.message }] }); }
  };
}

export async function runHiggsfieldMcp(input = process.stdin, output = process.stdout) {
  const handle = createHiggsfieldMcp();
  let pending = '';
  input.setEncoding('utf8');
  for await (const chunk of input) {
    pending += chunk;
    if (pending.length > 65536) throw new Error('MCP request exceeds limit');
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      let response;
      try { response = await handle(JSON.parse(line)); }
      catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
      if (response) output.write(`${JSON.stringify(response)}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHiggsfieldMcp().catch(() => { process.stderr.write('FrameForge Higgsfield MCP stopped\n'); process.exitCode = 1; });
