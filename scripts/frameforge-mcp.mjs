#!/usr/bin/env node
// FrameForge MCP server over stdio (protocol revision 2026-07-28, with the stateless legacy
// fallback). It is a thin proxy: the tool catalog and every call come from the running studio's
// /api/agent/operations REST surface, so MCP and REST cannot drift. Configure with
// FRAMEFORGE_URL (HTTPS or loopback HTTP) and FRAMEFORGE_TOKEN (the studio LOGIN_TOKEN, sent as a
// bearer token; omit it only for a loopback studio started without LOGIN_TOKEN).
import { pathToFileURL } from 'node:url';
import { createMcpCore, rpcError, ERROR } from '../server/mcp.mjs';
import { OPERATIONS_VERSION, AGENT_INSTRUCTIONS } from '../server/agent-ops.mjs';
import { HttpError } from '../server/validation.mjs';

const MAX_LINE = 1024 * 1024;
const CATALOG_TTL_MS = 60_000;

export function createFrameForgeMcp({ env = process.env, fetchImpl = fetch } = {}) {
  const origin = new URL(env.FRAMEFORGE_URL || 'http://127.0.0.1:4310');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback))) throw new Error('FRAMEFORGE_URL must be an HTTPS origin or loopback HTTP');
  const token = env.FRAMEFORGE_TOKEN || env.LOGIN_TOKEN || '';
  if (token && /[^\x21-\x7e]/.test(token)) throw new Error('FRAMEFORGE_TOKEN contains invalid characters');
  let catalog; let catalogAt = 0;

  async function request(route, init = {}, timeoutMs = 120_000) {
    let response;
    try {
      response = await fetchImpl(new URL(route, origin), { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    } catch { throw new HttpError(503, 'FrameForge studio could not be reached. Writes are never retried automatically; check state before repeating.'); }
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new HttpError(502, 'FrameForge response exceeds the 8 MiB limit'); chunks.push(chunk); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(502, `FrameForge returned a non-JSON response (HTTP ${response.status})`); }
    return { status: response.status, body };
  }

  async function listTools() {
    if (catalog && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog;
    const { status, body } = await request('/api/agent/operations', {}, 15_000);
    if (status !== 200 || !Array.isArray(body.operations)) throw new HttpError(status === 401 ? 401 : 502, status === 401 ? 'FrameForge rejected the token: set FRAMEFORGE_TOKEN to the studio LOGIN_TOKEN' : 'FrameForge did not return an operation catalog');
    catalog = body.operations; catalogAt = Date.now();
    return catalog;
  }

  async function callTool(name, args) {
    const { status, body } = await request(`/api/agent/operations/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify({ arguments: args }) });
    if (status === 200 && body.ok === true) return body.result;
    throw Object.assign(new HttpError(body.status || status, typeof body.error === 'string' ? body.error : `FrameForge returned HTTP ${status}`), body.code ? { code: body.code } : {}, Number.isInteger(body.currentVersion) ? { currentVersion: body.currentVersion } : {});
  }

  return createMcpCore({
    serverInfo: { name: 'frameforge-studio', title: 'FrameForge Studio', version: OPERATIONS_VERSION },
    instructions: AGENT_INSTRUCTIONS, listTools, callTool,
    log: (message) => process.stderr.write(`${message}\n`),
  });
}

export async function runFrameForgeMcp(input = process.stdin, output = process.stdout) {
  const core = createFrameForgeMcp();
  const pending = new Set();
  const write = (value) => output.write(`${JSON.stringify(value)}\n`);
  async function dispatch(line) {
    let message;
    try { message = JSON.parse(line); } catch { return write(rpcError(null, ERROR.PARSE, 'Parse error')); }
    const { body } = await core.handle(message);
    if (body) write(body);
  }
  let buffered = '';
  input.setEncoding('utf8');
  for await (const chunk of input) {
    buffered += chunk;
    if (buffered.length > MAX_LINE && !buffered.includes('\n')) { write(rpcError(null, ERROR.INVALID_REQUEST, 'Message exceeds 1 MiB')); buffered = ''; continue; }
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim(); buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const task = dispatch(line).catch(() => write(rpcError(null, ERROR.INTERNAL, 'Internal error'))).finally(() => pending.delete(task));
      pending.add(task);
    }
  }
  await Promise.allSettled([...pending]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runFrameForgeMcp().catch((error) => { process.stderr.write(`FrameForge MCP stopped: ${error.message}\n`); process.exitCode = 1; });
