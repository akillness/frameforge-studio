#!/usr/bin/env node
// Thin CLI over FrameForge Studio's /api/agent/operations REST surface (same catalog as /mcp).
// Reads FRAMEFORGE_URL (HTTPS or loopback HTTP) and FRAMEFORGE_TOKEN || LOGIN_TOKEN from env.
import { pathToFileURL } from 'node:url';

function validateOrigin(rawUrl) {
  const origin = new URL(rawUrl || 'http://127.0.0.1:4310');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback))) {
    throw new Error('FRAMEFORGE_URL must be an HTTPS origin or loopback HTTP');
  }
  return origin;
}

export function createFrameForgeCli({ env = process.env, fetchImpl = fetch } = {}) {
  const origin = validateOrigin(env.FRAMEFORGE_URL || 'http://127.0.0.1:4310');
  const token = env.FRAMEFORGE_TOKEN || env.LOGIN_TOKEN || '';
  if (token && /[^\x21-\x7e]/.test(token)) throw new Error('FRAMEFORGE_TOKEN contains invalid characters');

  async function request(route, init = {}, timeoutMs = 120_000) {
    let response;
    try {
      response = await fetchImpl(new URL(route, origin), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
      });
    } catch {
      throw new Error('FrameForge studio could not be reached. Writes are never retried automatically.');
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body || []) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) throw new Error('FrameForge response exceeds the 8 MiB limit');
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      throw new Error(`FrameForge returned a non-JSON response (HTTP ${response.status})`);
    }
    return { status: response.status, body };
  }

  return {
    async list() {
      const { status, body } = await request('/api/agent/operations', {}, 15_000);
      if (status !== 200 || !Array.isArray(body.operations)) {
        throw new Error(status === 401 ? 'FrameForge rejected token: set FRAMEFORGE_TOKEN or LOGIN_TOKEN' : `FrameForge returned HTTP ${status}`);
      }
      return body.operations.map(({ name, title, description, inputSchema, mutating }) => ({ name, title, description, mutating: Boolean(mutating), required: inputSchema?.required || [] }));
    },
    async call(name, args = {}) {
      if (!name || !/^[a-z0-9_]+$/.test(name)) throw new Error('Operation name must match ^[a-z0-9_]+$');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Operation arguments must be a JSON object');
      const { status, body } = await request(`/api/agent/operations/${encodeURIComponent(name)}`, {
        method: 'POST',
        body: JSON.stringify({ arguments: args }),
      });
      if (status === 200 && body.ok === true) return body.result;
      const err = new Error(typeof body?.error === 'string' ? body.error : `FrameForge returned HTTP ${status}`);
      err.status = body?.status || status;
      if (body?.code) err.code = body.code;
      if (Number.isInteger(body?.currentVersion)) err.currentVersion = body.currentVersion;
      throw err;
    },
  };
}

export async function runFrameForgeCli(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [cmd, maybeName, maybeJson] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    stdout.write(
      'Usage:\n' +
      '  frameforge-cli.mjs list\n' +
      '  frameforge-cli.mjs call <operation> [<json-args>]\n' +
      '  frameforge-cli.mjs <operation> [<json-args>]\n'
    );
    return 0;
  }
  const cli = createFrameForgeCli({ env, fetchImpl });
  try {
    if (cmd === 'list') {
      const ops = await cli.list();
      stdout.write(`${JSON.stringify({ operations: ops }, null, 2)}\n`);
      return 0;
    }
    const opName = cmd === 'call' ? maybeName : cmd;
    const rawArgs = cmd === 'call' ? maybeJson : maybeName;
    let args = {};
    if (rawArgs !== undefined) {
      try { args = JSON.parse(rawArgs); } catch { throw new Error('Arguments must be valid JSON'); }
    }
    const result = await cli.call(opName, args);
    stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: error.message, ...(error.status ? { status: error.status } : {}), ...(error.code ? { code: error.code } : {}), ...(Number.isInteger(error.currentVersion) ? { currentVersion: error.currentVersion } : {}) })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFrameForgeCli().then((code) => { process.exitCode = code; });
}
