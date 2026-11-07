import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { createAgentOperations } from '../server/agent-ops.mjs';
import { validateSchema } from '../server/schema.mjs';

const TOKEN = 'agent-test-login-token-0123456789';
const MODERN = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_ERROR = 'com.frameforge/error';
const PROXY = fileURLToPath(new URL('../scripts/frameforge-mcp.mjs', import.meta.url));
const OPERATION_NAMES = createAgentOperations().catalog().map((operation) => operation.name);
const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });
let sequence = 0;

// ── test application: every paid/render/speech boundary fails loudly if touched ───────────
async function startApp(t, { loginToken = TOKEN, agentApiOptions } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-agent-mcp-'));
  const boundary = [];
  const touched = (name) => async () => { boundary.push(name); throw new Error(`boundary touched: ${name}`); };
  const app = createApp({
    dataDir, loginToken, publicOrigin: '', agentApiOptions,
    integrations: {
      integrationStatus: async () => ({ studio: { available: true } }),
      runAgent: async () => { throw Object.assign(new Error('no bridge'), { code: 'UNAVAILABLE' }); },
      fetchTrends: async () => ({ trends: [{ keyword: '검증 키워드', source: 'Fixture', url: 'https://example.com/trend' }], sources: [{ name: 'Fixture', status: 'ok' }] }),
    },
    renderer: touched('renderer'),
    speech: { listVoices: async () => [], synthesize: touched('speech.synthesize') },
    generation: { transport: 'api', capability: async () => ({ provider: 'fixture', transport: 'api', available: false }), models: touched('generation.models'), modelSchema: touched('generation.modelSchema'), estimate: touched('generation.estimate'), create: touched('generation.create'), status: touched('generation.status') },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const port = app.address().port;
  t.after(async () => {
    await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true });
    assert.deepEqual(boundary, [], 'no renderer, speech or paid generation boundary may be reached by the agent API tests');
  });
  return { port, dataDir, base: `http://127.0.0.1:${port}`, token: loginToken, boundary };
}

function send(app, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const request = http.request({ host: '127.0.0.1', port: app.port, method, path, agent: false, headers: { ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }), ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON bodies keep json undefined */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

/** REST agent operation call. */
const rest = (app, name, args, { headers = bearer() } = {}) => send(app, { method: 'POST', path: `/api/agent/operations/${name}`, headers: { 'content-type': 'application/json', ...headers }, body: args === undefined ? {} : { arguments: args } });

/** Modern (2026-07-28) JSON-RPC message with the required _meta. */
const modernMessage = (method, params = {}) => ({ jsonrpc: '2.0', id: ++sequence, method, params: { ...params, _meta: { [META_VERSION]: MODERN, [META_CAPABILITIES]: {} } } });
function mcpHeaders(message, { token = TOKEN, version = MODERN, extra = {} } = {}) {
  const name = message.params?.name;
  return { 'content-type': 'application/json', ...(token ? bearer(token) : {}), ...(version ? { 'mcp-protocol-version': version } : {}), 'mcp-method': message.method, ...(message.method === 'tools/call' && name ? { 'mcp-name': name } : {}), ...extra };
}
const mcp = (app, message, options = {}) => send(app, { method: 'POST', path: '/mcp', headers: mcpHeaders(message, options), body: message });
const callTool = (app, name, args = {}, options) => mcp(app, modernMessage('tools/call', { name, arguments: args }), options);
const envelope = (response) => JSON.parse(response.json.result.content[0].text);

/** Create the fixtures agents cannot create themselves (the channel) through the cookie-authenticated UI API. */
async function seed(app) {
  const login = await send(app, { method: 'POST', path: '/api/login', headers: { 'content-type': 'application/json' }, body: { token: app.token } });
  assert.equal(login.status, 200, 'cookie login must work for the seeding helper');
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const headers = { cookie, 'content-type': 'application/json' };
  const state = (await send(app, { path: '/api/state', headers })).json;
  const channel = state.channels[0];
  const template = state.workflows.find((workflow) => !workflow.episodeId);
  const makeEpisode = async (title = '에이전트 검증') => (await send(app, { method: 'POST', path: '/api/episodes', headers, body: { channelId: channel.id, title, topic: '정보의 출처' } })).json;
  return { cookie, headers, channel, template, makeEpisode, ui: (path, method = 'GET', body) => send(app, { method, path, headers, ...(body === undefined ? {} : { body }) }) };
}
async function project(app, ids) {
  const episode = await ids.makeEpisode();
  const copied = await rest(app, 'workflow_copy_from_template', { templateId: ids.template.id, channelId: ids.channel.id, episodeId: episode.id, expectedTemplateVersion: ids.template.version });
  assert.equal(copied.status, 200, copied.text);
  return { episode, workflow: copied.json.result.workflow };
}

// ── stdio proxy client ────────────────────────────────────────────────────────────────────
function stdio(t, { url, token, env = {} }) {
  const child = spawn(process.execPath, [PROXY], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LOGIN_TOKEN: '', FRAMEFORGE_URL: url, FRAMEFORGE_TOKEN: token, ...env } });
  const lines = []; const waiting = new Map(); const early = new Map(); let buffer = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); lines.push(line);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); } else early.set(message.id, message);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  return {
    lines, get stderr() { return stderr; }, exited,
    request(message, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(message.id); reject(new Error(`no reply to ${message.method} #${message.id}; stderr: ${stderr}`)); }, timeoutMs);
        const done = (reply) => { clearTimeout(timer); resolve(reply); };
        if (early.has(message.id)) { done(early.get(message.id)); early.delete(message.id); return; }
        waiting.set(message.id, done);
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
    write: (text) => child.stdin.write(text),
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 10000);
      try { return await exited; } finally { clearTimeout(timer); }
    },
  };
}

// ── authentication, origin and transport rules ────────────────────────────────────────────
test('/mcp and the agent routes demand credentials, and the challenge is advertised', async (t) => {
  const app = await startApp(t);
  const message = modernMessage('tools/list');
  for (const [name, headers] of [['no credentials', {}], ['wrong token', bearer('x'.repeat(32))], ['non-bearer scheme', { authorization: `Basic ${Buffer.from(`a:${TOKEN}`).toString('base64')}` }]]) {
    const response = await send(app, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list', ...headers }, body: message });
    assert.equal(response.status, 401, `/mcp with ${name} must be 401`);
    assert.match(response.headers['www-authenticate'], /^Bearer/, `${name}: a 401 from /mcp must carry WWW-Authenticate: Bearer`);
    assert.equal(response.json.result, undefined, `${name}: no tool data may leak`);
  }
  assert.equal((await send(app, { path: '/api/agent/operations' })).status, 401, 'REST catalog needs credentials');
  assert.equal((await rest(app, 'workflow_node_types', {}, { headers: {} })).status, 401, 'REST operations need credentials');
  assert.equal((await send(app, { path: '/api/agent/operations', headers: bearer() })).status, 200, 'the correct bearer token is accepted');
  assert.equal((await mcp(app, message)).status, 200, 'and on /mcp');
});

test('/mcp accepts POST only: GET and DELETE are 405 with an Allow header', async (t) => {
  const app = await startApp(t);
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const response = await send(app, { method, path: '/mcp', headers: bearer() });
    assert.equal(response.status, 405, `${method} /mcp`);
    assert.equal(response.headers.allow, 'POST', `${method} /mcp must advertise POST`);
  }
});

test('the bearer token is accepted ONLY on /mcp and /api/agent/*, never on the studio\'s own API', async (t) => {
  const app = await startApp(t);
  for (const path of ['/api/generation/models', '/api/state', '/api/workflows', '/api/knowledge']) assert.equal((await send(app, { path, headers: bearer() })).status, 401, `GET ${path} with a bearer token must stay 401`);
  const session = await send(app, { path: '/api/session', headers: bearer() });
  assert.equal(session.json.authenticated, false, 'the session endpoint must not treat a bearer header as a login');
  for (const [path, body] of [['/api/episodes', { channelId: 'x', title: 't', topic: 't' }], ['/api/publication/approvals', {}], ['/api/workflows', { name: 'n', nodes: [], edges: [] }]]) {
    assert.equal((await send(app, { method: 'POST', path, headers: { ...bearer(), 'content-type': 'application/json' }, body })).status, 401, `POST ${path} with a bearer token must stay 401`);
  }
  assert.equal((await send(app, { path: '/api/agent/operations', headers: bearer() })).status, 200, 'while the same header works on the agent surface');
});

test('a browser session cookie also works on the agent surface', async (t) => {
  const app = await startApp(t);
  const ids = await seed(app);
  const response = await send(app, { path: '/api/agent/operations', headers: { cookie: ids.cookie } });
  assert.equal(response.status, 200);
});

test('wrong bearer tokens are throttled per client, so the right token cannot be brute-forced', async (t) => {
  const app = await startApp(t);
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await send(app, { path: '/api/agent/operations', headers: bearer(`wrong-token-${attempt}-xxxxxxxx`) })).status, 401);
  const locked = await send(app, { path: '/api/agent/operations', headers: bearer() });
  assert.equal(locked.status, 429, 'after repeated failures even the correct token is refused until the window passes');
});

test('foreign-origin and cross-site writes are refused on the agent surface even with a valid token', async (t) => {
  const app = await startApp(t);
  const post = (path, headers, body) => send(app, { method: 'POST', path, headers: { 'content-type': 'application/json', ...bearer(), ...headers }, body });
  const call = { arguments: {} };
  assert.equal((await post('/api/agent/operations/workflow_node_types', { origin: 'https://evil.example' }, call)).status, 403, 'REST write with a foreign Origin');
  assert.equal((await post('/api/agent/operations/workflow_node_types', { 'sec-fetch-site': 'cross-site' }, call)).status, 403, 'REST write flagged cross-site by the browser');
  const message = modernMessage('tools/list');
  assert.equal((await mcp(app, message, { extra: { origin: 'https://evil.example' } })).status, 403, '/mcp with a foreign Origin');
  assert.equal((await mcp(app, modernMessage('tools/list'), { extra: { 'sec-fetch-site': 'cross-site' } })).status, 403, '/mcp flagged cross-site');
  assert.equal((await mcp(app, modernMessage('tools/list'), { extra: { origin: app.base } })).status, 200, 'a same-origin Origin is allowed');
  const read = await send(app, { path: '/api/agent/operations', headers: { ...bearer(), origin: 'https://evil.example' } });
  assert.equal(read.headers['access-control-allow-origin'], undefined, 'no CORS grant may ever be issued, so a foreign page cannot read agent data');
});

test('without LOGIN_TOKEN the agent routes serve loopback clients only, and bearer headers are ignored', async (t) => {
  const app = await startApp(t, { loginToken: '' });
  assert.equal((await send(app, { path: '/api/agent/operations' })).status, 200, 'a loopback client needs no credentials in token-less development mode');
  assert.equal((await mcp(app, modernMessage('tools/list'), { token: '' })).status, 200);
  assert.equal((await send(app, { path: '/api/agent/operations', headers: bearer('anything-at-all-123456') })).status, 200, 'a bearer header is irrelevant when no token is configured');
  const foreignHost = await send(app, { path: '/api/agent/operations', headers: { host: 'studio.example.com' } });
  assert.equal(foreignHost.status, 403, 'a token-less studio must not be reachable under a non-loopback Host');
});

// ── MCP protocol: modern revision ─────────────────────────────────────────────────────────
test('server/discover advertises the revisions and tools capability and is cacheable only privately', async (t) => {
  const app = await startApp(t);
  const message = modernMessage('server/discover');
  const response = await mcp(app, message);
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store', 'MCP responses must never be stored by intermediaries');
  const { result } = response.json;
  assert.equal(result.resultType, 'complete');
  assert.ok(result.supportedVersions.includes(MODERN) && LEGACY.every((version) => result.supportedVersions.includes(version)), `supportedVersions must list the modern and legacy revisions: ${result.supportedVersions}`);
  assert.ok(result.capabilities.tools, 'tools capability is advertised');
  assert.deepEqual(Object.keys(result.capabilities), ['tools'], 'only tools are implemented, so only tools are advertised');
  assert.ok(Number.isInteger(result.ttlMs) && result.ttlMs > 0);
  assert.equal(result.cacheScope, 'private', 'tool lists are credential-gated and must not be shared-cacheable');
  assert.match(result.instructions, /stale_version/, 'the instructions tell models how to react to the machine-readable error codes');
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'frameforge-studio');
  assert.equal(response.json.id, message.id, 'the reply is correlated to its request');
});

test('tools/list returns every operation in deterministic order with schemas, annotations and cache hints', async (t) => {
  const app = await startApp(t);
  const first = await mcp(app, modernMessage('tools/list'));
  const second = await mcp(app, modernMessage('tools/list'));
  const { result } = first.json;
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.tools.map((tool) => tool.name), OPERATION_NAMES, 'MCP must expose exactly the operation registry, in its sorted order');
  assert.deepEqual(second.json.result.tools, result.tools, 'the list is deterministic');
  assert.ok(Number.isInteger(result.ttlMs) && result.cacheScope === 'private');
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.outputSchema.type, 'object', tool.name);
    assert.ok(tool.description.length > 20 && tool.title, tool.name);
    assert.deepEqual(Object.keys(tool.annotations).sort(), ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint', 'title'], tool.name);
  }
  const catalog = (await send(app, { path: '/api/agent/operations', headers: bearer() })).json.operations;
  assert.deepEqual(result.tools.map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema })), catalog.map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema })), 'MCP and REST must describe the same schemas');
});

test('tools/call success returns text identical to structuredContent, validated against the published outputSchema', async (t) => {
  const app = await startApp(t);
  const list = (await mcp(app, modernMessage('tools/list'))).json.result.tools;
  const message = modernMessage('tools/call', { name: 'workflow_node_types', arguments: {} });
  const response = await mcp(app, message);
  assert.equal(response.status, 200);
  const { result } = response.json;
  assert.deepEqual([result.resultType, result.isError], ['complete', false]);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, 'text content must be the JSON of structuredContent, for clients that only read text');
  assert.deepEqual(validateSchema(list.find((tool) => tool.name === 'workflow_node_types').outputSchema, result.structuredContent), [], 'structuredContent must conform to the advertised outputSchema');
  assert.equal(result.structuredContent.types.length, 10);
  assert.equal(response.json.id, message.id, 'the reply is correlated to its request');
});

test('tool failures are tool results with isError, a JSON error envelope and a machine-readable _meta mirror', async (t) => {
  const app = await startApp(t);
  const invalid = await callTool(app, 'episode_get', { episodeId: '../x' });
  assert.equal(invalid.status, 200, 'execution failures are results, not HTTP errors');
  assert.equal(invalid.json.result.isError, true);
  assert.equal(invalid.json.result.resultType, 'complete');
  assert.equal(invalid.json.result.structuredContent, undefined);
  assert.deepEqual([envelope(invalid).error.status, envelope(invalid).error.code], [400, 'invalid_arguments']);
  assert.match(envelope(invalid).error.message, /Invalid arguments/);
  assert.deepEqual(invalid.json.result._meta[META_ERROR], { status: 400, code: 'invalid_arguments' });
  const missing = await callTool(app, 'episode_get', { episodeId: 'does-not-exist' });
  assert.equal(missing.json.result.isError, true);
  assert.equal(envelope(missing).error.status, 404);
  assert.equal(missing.json.result._meta[META_ERROR].status, 404);
  const unknown = await callTool(app, 'workflow_approve_review', {});
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.error.code, -32602, 'an unknown tool is a protocol error (invalid params), not an execution error');
  assert.match(unknown.json.error.message, /Unknown tool: workflow_approve_review/);
  assert.equal(unknown.json.result, undefined);
  const badArgs = await mcp(app, modernMessage('tools/call', { name: 'workflow_node_types', arguments: [] }));
  assert.equal(badArgs.status, 400);
  assert.equal(badArgs.json.error.code, -32602, 'non-object arguments are invalid params');
  const noName = await mcp(app, { ...modernMessage('tools/call', {}), params: { _meta: { [META_VERSION]: MODERN, [META_CAPABILITIES]: {} } } }, { extra: { 'mcp-name': '' } });
  assert.equal(noName.status, 400);
});

test('every Streamable HTTP header rule is enforced against the body, and a mismatch cannot run a tool', async (t) => {
  const app = await startApp(t);
  const ids = await seed(app);
  const base = () => modernMessage('tools/call', { name: 'workflow_node_types', arguments: {} });
  const cases = [
    ['missing MCP-Protocol-Version', (message) => mcpHeaders(message, { version: '' }), /MCP-Protocol-Version header is required/],
    ['protocol version header differs from the body', (message) => mcpHeaders(message, { version: '2025-11-25' }), /does not match body/],
    ['missing Mcp-Method', (message) => { const headers = mcpHeaders(message); delete headers['mcp-method']; return headers; }, /Mcp-Method/],
    ['Mcp-Method differs from the body method', (message) => mcpHeaders(message, { extra: { 'mcp-method': 'tools/list' } }), /Mcp-Method/],
    ['missing Mcp-Name on tools/call', (message) => { const headers = mcpHeaders(message); delete headers['mcp-name']; return headers; }, /Mcp-Name/],
    ['Mcp-Name names a different tool than the body', (message) => mcpHeaders(message, { extra: { 'mcp-name': 'workflow_list' } }), /Mcp-Name/],
  ];
  for (const [name, headersFor, pattern] of cases) {
    const message = base();
    const response = await send(app, { method: 'POST', path: '/mcp', headers: headersFor(message), body: message });
    assert.equal(response.status, 400, `${name}: must be rejected`);
    assert.equal(response.json.error.code, -32020, `${name}: header mismatch is JSON-RPC error -32020`);
    assert.match(response.json.error.message, pattern, name);
    assert.equal(response.json.id, message.id, `${name}: the error must be correlated to the request id`);
  }
  // The mismatch that matters: routing/auth layers see Mcp-Name, so a different body must never execute.
  const episode = await ids.makeEpisode();
  const before = (await ids.ui('/api/state')).json.episodes.length;
  const smuggled = modernMessage('tools/call', { name: 'episode_create', arguments: { channelId: ids.channel.id, title: 'smuggled' } });
  const rejected = await send(app, { method: 'POST', path: '/mcp', headers: mcpHeaders(smuggled, { extra: { 'mcp-name': 'workflow_node_types' } }), body: smuggled });
  assert.equal(rejected.status, 400);
  assert.equal((await ids.ui('/api/state')).json.episodes.length, before, 'a header/body mismatch must not execute the body\'s tool');
  assert.ok(episode.id);
  const matching = await callTool(app, 'workflow_node_types');
  assert.equal(matching.json.result.isError, false, 'matching headers pass');
  const encoded = modernMessage('tools/call', { name: 'workflow_node_types', arguments: {} });
  const encodedResponse = await send(app, { method: 'POST', path: '/mcp', headers: mcpHeaders(encoded, { extra: { 'mcp-name': `=?base64?${Buffer.from('workflow_node_types').toString('base64')}?=` } }), body: encoded });
  assert.equal(encodedResponse.json.result.isError, false, 'the base64 sentinel form of Mcp-Name is decoded before comparison');
  const list = modernMessage('tools/list');
  const noName = await send(app, { method: 'POST', path: '/mcp', headers: mcpHeaders(list), body: list });
  assert.equal(noName.status, 200, 'Mcp-Name is only required for named methods');
});

test('unsupported and missing protocol metadata are rejected with the documented codes', async (t) => {
  const app = await startApp(t);
  const future = '2099-01-01';
  const bodyFuture = { jsonrpc: '2.0', id: 91, method: 'tools/list', params: { _meta: { [META_VERSION]: future, [META_CAPABILITIES]: {} } } };
  const viaBody = await send(app, { method: 'POST', path: '/mcp', headers: { ...mcpHeaders(bodyFuture, { version: future }) }, body: bodyFuture });
  assert.equal(viaBody.status, 400);
  assert.equal(viaBody.json.error.code, -32022, 'an unsupported version is -32022');
  assert.ok(viaBody.json.error.data.supported.includes(MODERN) && LEGACY.every((version) => viaBody.json.error.data.supported.includes(version)), 'the error lists the versions the server does support');
  assert.equal(viaBody.json.error.data.requested, future);
  const headerOnly = { jsonrpc: '2.0', id: 92, method: 'tools/list' };
  const viaHeader = await send(app, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', ...bearer(), 'mcp-protocol-version': future }, body: headerOnly });
  assert.equal(viaHeader.status, 400);
  assert.equal(viaHeader.json.error.code, -32022, 'an unsupported version in the header alone is also -32022');
  const noMeta = { jsonrpc: '2.0', id: 93, method: 'tools/list', params: {} };
  const missingMeta = await send(app, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', ...bearer(), 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' }, body: noMeta });
  assert.equal(missingMeta.status, 400);
  assert.equal(missingMeta.json.error.code, -32602, 'a modern header without the _meta fields is invalid params');
  const noCapabilities = { jsonrpc: '2.0', id: 94, method: 'tools/list', params: { _meta: { [META_VERSION]: MODERN } } };
  const missingCapabilities = await send(app, { method: 'POST', path: '/mcp', headers: mcpHeaders(noCapabilities), body: noCapabilities });
  assert.equal(missingCapabilities.status, 400);
  assert.equal(missingCapabilities.json.error.code, -32602);
  assert.match(missingCapabilities.json.error.message, /clientCapabilities/);
  const unknownMethod = await mcp(app, modernMessage('resources/list'));
  assert.equal(unknownMethod.status, 404);
  assert.equal(unknownMethod.json.error.code, -32601, 'resources are not implemented, and must not be pretended');
});

test('notifications are accepted with an empty 202 and never executed', async (t) => {
  const app = await startApp(t);
  for (const [name, message, headers] of [
    ['modern notification', { jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: { [META_VERSION]: MODERN, [META_CAPABILITIES]: {} } } }, { 'mcp-protocol-version': MODERN }],
    ['bare notification', { jsonrpc: '2.0', method: 'notifications/initialized' }, {}],
    ['a tools/call sent as a notification', { jsonrpc: '2.0', method: 'tools/call', params: { name: 'episode_create', arguments: {} } }, {}],
  ]) {
    const response = await send(app, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', ...bearer(), ...headers }, body: message });
    assert.equal(response.status, 202, name);
    assert.equal(response.text, '', `${name}: the body must be empty`);
  }
});

test('malformed MCP bodies are protocol errors, not server crashes', async (t) => {
  const app = await startApp(t);
  const post = (headers, body) => send(app, { method: 'POST', path: '/mcp', headers: { ...bearer(), ...headers }, body });
  const invalidJson = await post({ 'content-type': 'application/json' }, '{"jsonrpc":');
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.json.error.code, -32700, 'unparseable JSON is a parse error');
  assert.equal(invalidJson.json.id, null);
  const wrongType = await post({ 'content-type': 'text/plain' }, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert.equal(wrongType.status, 415);
  const array = await post({ 'content-type': 'application/json' }, '[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
  assert.ok(array.status >= 400 && array.status < 500, 'batches are not supported and must be rejected');
  const wrongVersion = await post({ 'content-type': 'application/json' }, JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }));
  assert.equal(wrongVersion.status, 400);
  assert.equal(wrongVersion.json.error.code, -32600, 'a message that is not JSON-RPC 2.0 is an invalid request');
  const badId = await post({ 'content-type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' }));
  assert.equal(badId.json.error.code, -32600);
  assert.equal((await mcp(app, modernMessage('ping'))).json.result.resultType, 'complete', 'the server still answers after bad input');
});

// ── MCP protocol: legacy revisions, stateless ─────────────────────────────────────────────
test('legacy clients get initialize, tools/list and tools/call statelessly: no session header, no resultType', async (t) => {
  const app = await startApp(t);
  const legacy = (method, params, id = ++sequence, version = '2025-11-25') => send(app, { method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json', ...bearer(), ...(version ? { 'mcp-protocol-version': version } : {}) }, body: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } });
  for (const requested of LEGACY) {
    const init = await legacy('initialize', { protocolVersion: requested, capabilities: {}, clientInfo: { name: 't', version: '1' } }, 1, requested);
    assert.equal(init.status, 200);
    assert.equal(init.json.result.protocolVersion, requested, `a supported legacy revision (${requested}) is echoed`);
    assert.ok(init.json.result.capabilities.tools);
    assert.equal(init.json.result.serverInfo.name, 'frameforge-studio');
    assert.ok(init.json.result.instructions.length > 50);
    assert.equal(init.headers['mcp-session-id'], undefined, 'the server is stateless: no session is issued');
    assert.equal(init.json.result.resultType, undefined, 'legacy results carry no resultType');
  }
  const unknown = await legacy('initialize', { protocolVersion: '2024-01-01', capabilities: {} });
  assert.equal(unknown.json.result.protocolVersion, '2025-11-25', 'an unknown requested revision falls back to the newest legacy one');
  const noParams = await legacy('initialize');
  assert.equal(noParams.json.result.protocolVersion, '2025-11-25');
  for (const version of ['2025-11-25', null]) {
    const list = await legacy('tools/list', undefined, ++sequence, version);
    assert.equal(list.status, 200, `tools/list with header ${version}`);
    assert.deepEqual(list.json.result.tools.map((tool) => tool.name), OPERATION_NAMES);
    assert.equal(list.json.result.resultType, undefined);
    assert.equal(list.json.result._meta, undefined, 'legacy results have no modern _meta');
    const call = await legacy('tools/call', { name: 'workflow_node_types', arguments: {} }, ++sequence, version);
    assert.equal(call.json.result.isError, false);
    assert.equal(call.json.result.resultType, undefined);
    assert.equal(call.json.result.structuredContent.types.length, 10);
    const failure = await legacy('tools/call', { name: 'episode_get', arguments: { episodeId: 'nope' } }, ++sequence, version);
    assert.equal(failure.json.result.isError, true);
    assert.equal(JSON.parse(failure.json.result.content[0].text).error.status, 404);
    assert.equal((await legacy('ping', undefined, ++sequence, version)).json.result.resultType, undefined);
  }
  assert.equal((await legacy('tools/list', undefined, ++sequence, 'garbage')).json.error.code, -32022, 'an unknown protocol header is rejected rather than guessed');
});

// ── agent boundary rules over every transport ─────────────────────────────────────────────
test('review, approval, publication and upload are not reachable as agent operations over any transport', async (t) => {
  const app = await startApp(t);
  const names = (await mcp(app, modernMessage('tools/list'))).json.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, OPERATION_NAMES);
  assert.deepEqual((await send(app, { path: '/api/agent/operations', headers: bearer() })).json.operations.map((operation) => operation.name), OPERATION_NAMES);
  for (const name of ['workflow_review', 'workflow_approve', 'publication_approve', 'publication_publish', 'upload_create', 'platform_session_open', 'episode_archive']) {
    const viaRest = await rest(app, name, {});
    assert.equal(viaRest.status, 404, `${name} over REST`);
    assert.equal(viaRest.json.code, 'unknown_operation');
    assert.equal((await callTool(app, name)).json.error.code, -32602, `${name} over MCP`);
  }
  assert.equal((await send(app, { method: 'POST', path: '/api/publication/approvals', headers: { ...bearer(), 'content-type': 'application/json' }, body: {} })).status, 401, 'the studio\'s own publication routes stay behind the human session');
});

test('paid generation is refused with 403 before any engine call over REST and MCP, and nothing is created', async (t) => {
  const app = await startApp(t);
  const ids = await seed(app);
  const { episode, workflow } = await project(app, ids);
  const args = { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'all' }, allowGeneration: true, generationPlanId: 'plan-1', generationFingerprint: 'fp', acceptUnquotedEstimate: true, disclosure: { containsSyntheticMedia: true, rationale: 'reviewed' } };
  const viaRest = await rest(app, 'workflow_run_start', args);
  assert.equal(viaRest.status, 403, 'the HTTP status is the error status');
  assert.deepEqual([viaRest.json.ok, viaRest.json.status, viaRest.json.code], [false, 403, 'agent_paid_generation_disabled']);
  assert.match(viaRest.json.error, /AGENT_API_ALLOW_PAID_GENERATION/);
  const viaMcp = await callTool(app, 'workflow_run_start', args);
  assert.equal(viaMcp.status, 200);
  assert.equal(viaMcp.json.result.isError, true);
  assert.deepEqual([envelope(viaMcp).error.status, envelope(viaMcp).error.code], [403, 'agent_paid_generation_disabled']);
  assert.deepEqual(viaMcp.json.result._meta[META_ERROR], { status: 403, code: 'agent_paid_generation_disabled' });
  const runs = (await ids.ui('/api/workflow-runs')).json;
  assert.deepEqual([runs.total, runs.items], [0, []], 'a refused start must not create a run');
  assert.deepEqual((await rest(app, 'workflow_run_list', { workflowId: workflow.id })).json.result.runs, [], 'nor a run visible to the agent');
  assert.deepEqual(app.boundary, [], 'the generation provider was never contacted');
});

// ── REST surface ──────────────────────────────────────────────────────────────────────────
test('GET /api/agent/operations and openapi.json are generated from the same registry', async (t) => {
  const app = await startApp(t);
  const catalog = (await send(app, { path: '/api/agent/operations', headers: bearer() })).json;
  assert.match(catalog.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(catalog.operations.map((operation) => operation.name), OPERATION_NAMES);
  assert.equal(catalog.operations.length, 22);
  for (const operation of catalog.operations) assert.deepEqual(Object.keys(operation).sort(), ['annotations', 'description', 'inputSchema', 'mutating', 'name', 'outputSchema', 'title'], `${operation.name}: no registry internals (run functions) may leak`);
  const openapi = (await send(app, { path: '/api/agent/openapi.json', headers: bearer() })).json;
  assert.equal(openapi.openapi, '3.1.0');
  const operationPaths = Object.keys(openapi.paths).filter((path) => path.startsWith('/api/agent/operations/'));
  assert.deepEqual(operationPaths.sort(), OPERATION_NAMES.map((name) => `/api/agent/operations/${name}`).sort(), 'exactly one path per operation');
  for (const operation of catalog.operations) {
    const post = openapi.paths[`/api/agent/operations/${operation.name}`].post;
    assert.equal(post.operationId, operation.name);
    assert.deepEqual(post.requestBody.content['application/json'].schema.properties.arguments, operation.inputSchema, `${operation.name}: request schema is the operation's inputSchema under "arguments"`);
    assert.deepEqual(post.responses[200].content['application/json'].schema.properties.result, operation.outputSchema, `${operation.name}: response schema is the outputSchema`);
    for (const status of ['400', '401', '403', '404', '409', '429']) assert.ok(post.responses[status], `${operation.name}: documents ${status}`);
  }
  assert.deepEqual(openapi.paths['/api/agent/operations'].get.operationId, 'listOperations');
  assert.ok(openapi.components.securitySchemes.bearer);
  assert.equal((await send(app, { path: '/api/agent/openapi.json' })).status, 401, 'the API description is behind credentials too');
});

test('GET /api/agent/tools emits MCP, OpenAI and Anthropic definitions from the registry and rejects other formats', async (t) => {
  const app = await startApp(t);
  const catalog = (await send(app, { path: '/api/agent/operations', headers: bearer() })).json.operations;
  const tools = async (query) => send(app, { path: `/api/agent/tools${query}`, headers: bearer() });
  const mcpTools = (await tools('?format=mcp')).json.tools;
  assert.deepEqual(mcpTools.map((tool) => tool.name), OPERATION_NAMES);
  assert.deepEqual((await tools('')).json.tools, mcpTools, 'mcp is the default format');
  for (const [index, tool] of mcpTools.entries()) assert.deepEqual([tool.inputSchema, tool.outputSchema, tool.annotations.title], [catalog[index].inputSchema, catalog[index].outputSchema, catalog[index].title]);
  const openai = (await tools('?format=openai')).json.tools;
  assert.deepEqual(openai.map((tool) => [tool.type, tool.function.name]), OPERATION_NAMES.map((name) => ['function', name]));
  assert.deepEqual(openai.map((tool) => tool.function.parameters), catalog.map((operation) => operation.inputSchema), 'OpenAI parameters are the inputSchema');
  const anthropic = (await tools('?format=anthropic')).json.tools;
  assert.deepEqual(anthropic.map((tool) => tool.name), OPERATION_NAMES);
  assert.deepEqual(anthropic.map((tool) => tool.input_schema), catalog.map((operation) => operation.inputSchema), 'Anthropic input_schema is the inputSchema');
  assert.ok(anthropic.every((tool) => tool.description.length > 20));
  for (const format of ['gemini', 'xml', '']) assert.equal((await tools(`?format=${format}`)).status, format === '' ? 200 : 400, `format=${format}`);
});

test('POST /api/agent/operations/<name> uses an ok/error envelope whose status equals the HTTP status', async (t) => {
  const app = await startApp(t);
  const ok = await rest(app, 'workflow_node_types', {});
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.result.types.length, 10);
  assert.equal(ok.json.error, undefined);
  assert.equal((await rest(app, 'workflow_node_types')).status, 200, 'a body without "arguments" means no arguments');
  const invalid = await rest(app, 'episode_get', { episodeId: '../etc' });
  assert.deepEqual([invalid.status, invalid.json.ok, invalid.json.status, invalid.json.code], [400, false, 400, 'invalid_arguments']);
  assert.equal(typeof invalid.json.error, 'string');
  const missing = await rest(app, 'episode_get', { episodeId: 'nope' });
  assert.deepEqual([missing.status, missing.json.ok, missing.json.status], [404, false, 404]);
  const unknown = await rest(app, 'no_such_operation', {});
  assert.deepEqual([unknown.status, unknown.json.ok, unknown.json.status, unknown.json.code], [404, false, 404, 'unknown_operation']);
  const extra = await send(app, { method: 'POST', path: '/api/agent/operations/workflow_node_types', headers: { ...bearer(), 'content-type': 'application/json' }, body: { arguments: {}, sneaky: true } });
  assert.equal(extra.status, 400, 'extra body keys are refused rather than ignored');
  const notObject = await send(app, { method: 'POST', path: '/api/agent/operations/episode_get', headers: { ...bearer(), 'content-type': 'application/json' }, body: { arguments: 'episode-1' } });
  assert.equal(notObject.status, 400);
  assert.equal(notObject.json.code, 'invalid_arguments');
  const noType = await send(app, { method: 'POST', path: '/api/agent/operations/workflow_node_types', headers: bearer(), body: '{}' });
  assert.equal(noType.status, 415, 'JSON bodies need a JSON content type');
  const upperCase = await send(app, { method: 'POST', path: '/api/agent/operations/Workflow_Node_Types', headers: { ...bearer(), 'content-type': 'application/json' }, body: {} });
  assert.ok(upperCase.status >= 400, 'operation names are lowercase identifiers');
});

test('agent writes go through the studio\'s asset validation and leave the episode untouched when refused', async (t) => {
  const app = await startApp(t);
  const ids = await seed(app);
  const episode = await ids.makeEpisode();
  const scenes = [{ id: 's1', title: '이미지', kind: 'image', duration: 3, background: '#112233', assetUrl: '/api/uploads/00000000-0000-4000-8000-000000000000.png' }];
  const refused = await rest(app, 'episode_update', { episodeId: episode.id, expectedVersion: episode.version, scenes });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /unknown uploaded asset/);
  const after = (await rest(app, 'episode_get', { episodeId: episode.id })).json.result;
  assert.deepEqual([after.episode.version, after.scenes.length], [episode.version, 1], 'a refused scene set must not change the episode');
  const proposal = await rest(app, 'episode_propose_storyboard', { episodeId: episode.id, agent: 'codex' });
  assert.deepEqual([proposal.status, proposal.json.code], [503, 'agent_unavailable'], 'a host agent without a bridge is unavailable, with no silent fallback to the template engine');
});

test('a result that violates its own outputSchema never reaches the agent: REST 500 invalid_result, MCP -32603, no stored data leaked', async (t) => {
  const app = await startApp(t);
  const ids = await seed(app);
  const database = new DatabaseSync(join(app.dataDir, 'studio.sqlite'));
  try {
    const row = database.prepare("SELECT id, data FROM entities WHERE kind = 'workflows' LIMIT 1").get();
    database.prepare("UPDATE entities SET data = ? WHERE kind = 'workflows' AND id = ?").run(JSON.stringify({ ...JSON.parse(row.data), version: 'SECRET-corrupt-version' }), row.id);
  } finally { database.close(); }
  assert.ok(ids.template);
  const logged = []; const original = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  let viaRest; let viaMcp;
  try { viaRest = await rest(app, 'workflow_list', {}); viaMcp = await callTool(app, 'workflow_list'); } finally { console.error = original; }
  assert.equal(viaRest.status, 500);
  assert.deepEqual([viaRest.json.ok, viaRest.json.status, viaRest.json.code], [false, 500, 'invalid_result']);
  assert.ok(!viaRest.text.includes('SECRET-corrupt-version'), 'REST must not echo the stored value');
  assert.equal(viaMcp.json.result, undefined, 'MCP must not return an unvalidated result');
  assert.equal(viaMcp.json.error.code, -32603, 'an output-schema violation is a server-side protocol error, not a tool result');
  assert.equal(viaMcp.json.error.message, 'Tool produced an invalid result');
  assert.ok(!viaMcp.text.includes('SECRET-corrupt-version'), 'MCP must not echo the stored value');
  assert.ok(logged.some((line) => /workflow_list violated its output schema/.test(line)), 'the defect is logged for the operator');
});

// ── the same 409 contract over REST, /mcp and stdio ───────────────────────────────────────
test('REST: stale versions are stale_version (episode with currentVersion, workflow skip, plan) and an archived episode is a conflict', async (t) => {
  const app = await startApp(t);
  const ids = await seed(app);
  const { episode, workflow } = await project(app, ids);
  const stale = await rest(app, 'episode_update', { episodeId: episode.id, expectedVersion: episode.version + 5, title: '늦은 수정' });
  assert.equal(stale.status, 409);
  assert.deepEqual([stale.json.ok, stale.json.status, stale.json.code, stale.json.currentVersion], [false, 409, 'stale_version', episode.version], 'REST body must expose code and currentVersion');
  const skip = await rest(app, 'workflow_set_skip', { workflowId: workflow.id, nodeId: 'research', skipped: true, expectedVersion: workflow.version + 2 });
  assert.deepEqual([skip.status, skip.json.code, skip.json.currentVersion], [409, 'stale_version', workflow.version]);
  const plan = await rest(app, 'workflow_plan', { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'all' }, expectedWorkflowVersion: workflow.version + 1 });
  assert.deepEqual([plan.status, plan.json.code], [409, 'stale_version']);
  assert.equal(plan.json.currentVersion, undefined, 'a project-level staleness has no single version to report');
  const updated = await rest(app, 'episode_update', { episodeId: episode.id, expectedVersion: episode.version, title: '새 제목' });
  assert.equal(updated.json.result.episode.version, episode.version + 1);
  assert.equal((await ids.ui('/api/episodes/' + episode.id + '/archive', 'POST', { expectedVersion: episode.version + 1 })).status, 200, 'archive through the human API');
  const archived = await rest(app, 'episode_update', { episodeId: episode.id, expectedVersion: episode.version + 2, title: '보관 후 수정' });
  assert.deepEqual([archived.status, archived.json.code, archived.json.currentVersion], [409, 'conflict', undefined], 'an archived episode is not retryable: conflict, not stale_version');
  const archivedWorkflow = await rest(app, 'workflow_patch', { workflowId: workflow.id, expectedVersion: workflow.version, ops: [{ op: 'autoLayout' }] });
  assert.deepEqual([archivedWorkflow.status, archivedWorkflow.json.code], [409, 'conflict']);
});

test('/mcp: the same 409 classification arrives as isError results with status, code and currentVersion in text and _meta', async (t) => {
  const app = await startApp(t);
  const ids = await seed(app);
  const { episode, workflow } = await project(app, ids);
  const stale = await callTool(app, 'episode_update', { episodeId: episode.id, expectedVersion: episode.version + 5, title: '늦은 수정' });
  assert.equal(stale.status, 200, 'a business conflict is an execution result, not an HTTP 409');
  assert.equal(stale.json.result.isError, true);
  assert.deepEqual(envelope(stale).error, { status: 409, code: 'stale_version', currentVersion: episode.version, message: envelope(stale).error.message });
  assert.match(envelope(stale).error.message, /current version is \d+/);
  assert.deepEqual(stale.json.result._meta[META_ERROR], { status: 409, code: 'stale_version', currentVersion: episode.version });
  const skip = await callTool(app, 'workflow_set_skip', { workflowId: workflow.id, nodeId: 'research', skipped: true, expectedVersion: workflow.version + 2 });
  assert.deepEqual(skip.json.result._meta[META_ERROR], { status: 409, code: 'stale_version', currentVersion: workflow.version });
  const plan = await callTool(app, 'workflow_plan', { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'all' }, expectedWorkflowVersion: workflow.version + 1 });
  assert.deepEqual(plan.json.result._meta[META_ERROR], { status: 409, code: 'stale_version' });
  assert.equal(envelope(plan).error.currentVersion, undefined);
  await rest(app, 'episode_update', { episodeId: episode.id, expectedVersion: episode.version, title: '새 제목' });
  assert.equal((await ids.ui(`/api/episodes/${episode.id}/archive`, 'POST', { expectedVersion: episode.version + 1 })).status, 200);
  const archived = await callTool(app, 'episode_update', { episodeId: episode.id, expectedVersion: episode.version + 2, title: '보관 후 수정' });
  assert.equal(archived.json.result.isError, true);
  assert.deepEqual(archived.json.result._meta[META_ERROR], { status: 409, code: 'conflict' });
  assert.equal(envelope(archived).error.currentVersion, undefined);
});

// ── rate limits ───────────────────────────────────────────────────────────────────────────
test('mutating agent calls are limited to 60 per minute with Retry-After, while reads keep working', async (t) => {
  const app = await startApp(t);
  const ids = await seed(app);
  const episode = await ids.makeEpisode();
  const propose = () => rest(app, 'episode_propose_storyboard', { episodeId: episode.id });
  for (let call = 1; call <= 60; call++) {
    const response = await propose();
    assert.equal(response.status, 200, `mutating call ${call} is within the limit (${response.text.slice(0, 120)})`);
  }
  const limited = await propose();
  assert.equal(limited.status, 429, 'the 61st mutating call in one window is refused');
  assert.match(limited.headers['retry-after'], /^\d+$/, 'Retry-After must be an integer number of seconds');
  assert.ok(Number(limited.headers['retry-after']) >= 1 && Number(limited.headers['retry-after']) <= 60);
  assert.equal(limited.json.ok, undefined, 'a throttled call is a transport-level refusal, not an operation result');
  assert.equal((await propose()).status, 429, 'it stays refused for the rest of the window');
  const read = await rest(app, 'workflow_node_types', {});
  assert.equal(read.status, 200, 'reads have their own, larger budget');
  assert.equal((await callTool(app, 'workflow_node_types')).json.result.isError, false);
});

test('the write budget is shared by REST and /mcp, and a throttled MCP call is an HTTP 429 with Retry-After', async (t) => {
  const app = await startApp(t);
  const ids = await seed(app);
  const episode = await ids.makeEpisode();
  for (let call = 0; call < 30; call++) assert.equal((await rest(app, 'episode_propose_storyboard', { episodeId: episode.id })).status, 200);
  for (let call = 0; call < 30; call++) assert.equal((await callTool(app, 'episode_propose_storyboard', { episodeId: episode.id })).json.result.isError, false, `MCP mutating call ${call + 1}`);
  const throttledRest = await rest(app, 'episode_propose_storyboard', { episodeId: episode.id });
  assert.equal(throttledRest.status, 429, 'REST sees the budget consumed through MCP');
  const throttledMcp = await callTool(app, 'episode_propose_storyboard', { episodeId: episode.id });
  assert.equal(throttledMcp.status, 429);
  assert.match(throttledMcp.headers['retry-after'], /^\d+$/);
  assert.equal(throttledMcp.json.result, undefined, 'a throttled tool call must not run');
  assert.equal((await callTool(app, 'workflow_node_types')).json.result.isError, false, 'read-only tools are not throttled by the write budget');
});

// ── stdio proxy ───────────────────────────────────────────────────────────────────────────
test('stdio: modern tools/list and tools/call round trips, stdout carries only JSON lines, closing stdin exits cleanly', async (t) => {
  const app = await startApp(t);
  const client = stdio(t, { url: app.base, token: TOKEN });
  const list = await client.request(modernMessage('tools/list'));
  assert.equal(list.result.resultType, 'complete');
  assert.deepEqual(list.result.tools.map((tool) => tool.name), OPERATION_NAMES, 'the proxy exposes the studio\'s operation registry');
  const call = await client.request(modernMessage('tools/call', { name: 'workflow_node_types', arguments: {} }));
  assert.equal(call.result.isError, false);
  assert.deepEqual(JSON.parse(call.result.content[0].text), call.result.structuredContent);
  assert.equal(call.result.structuredContent.types.length, 10);
  const failure = await client.request(modernMessage('tools/call', { name: 'episode_get', arguments: { episodeId: 'nope' } }));
  assert.equal(failure.result.isError, true);
  assert.equal(JSON.parse(failure.result.content[0].text).error.status, 404);
  client.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const ping = await client.request(modernMessage('ping'));
  assert.equal(ping.result.resultType, 'complete');
  const unknown = await client.request(modernMessage('tools/call', { name: 'workflow_approve_review', arguments: {} }));
  assert.equal(unknown.error.code, -32602);
  const exit = await client.close();
  assert.deepEqual(exit, { code: 0, signal: null }, 'closing stdin must end the process cleanly');
  assert.equal(client.lines.length, 5, 'one line per request; the notification produced no output');
  for (const line of client.lines) assert.doesNotThrow(() => JSON.parse(line), `stdout must contain only JSON lines, got: ${line.slice(0, 80)}`);
  const unexpected = client.stderr.split('\n').filter((line) => line.trim() && !/ExperimentalWarning: SQLite|--trace-warnings/.test(line));
  assert.deepEqual(unexpected, [], 'a healthy session logs nothing to stderr beyond Node\'s own SQLite experimental notice');
});

test('stdio: a legacy handshake is served statelessly without modern fields', async (t) => {
  const app = await startApp(t);
  const client = stdio(t, { url: app.base, token: TOKEN });
  const init = await client.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'frameforge-studio');
  assert.equal(init.result.resultType, undefined);
  const list = await client.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), OPERATION_NAMES);
  assert.equal(list.result.resultType, undefined);
  const call = await client.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workflow_node_types', arguments: {} } });
  assert.equal(call.result.isError, false);
  assert.equal(call.result.structuredContent.types.length, 10);
  assert.equal((await client.close()).code, 0);
});

test('stdio: a wrong token fails tools/list and tools/call with a message that names FRAMEFORGE_TOKEN and the HTTP-like status', async (t) => {
  const app = await startApp(t);
  const wrong = 'wrong-token-that-must-never-be-echoed';
  const client = stdio(t, { url: app.base, token: wrong });
  const list = await client.request(modernMessage('tools/list'));
  assert.equal(list.result, undefined);
  assert.equal(list.error.code, -32603);
  assert.match(list.error.message, /FRAMEFORGE_TOKEN/, 'the operator must be told which variable to fix, not "Internal error"');
  assert.notEqual(list.error.message, 'Internal error');
  assert.equal(list.error.data.status, 401, 'the HTTP-like status is machine-readable in error.data.status');
  const call = await client.request(modernMessage('tools/call', { name: 'workflow_node_types', arguments: {} }));
  assert.match(call.error.message, /FRAMEFORGE_TOKEN/);
  assert.equal(call.error.data.status, 401);
  assert.ok(![...client.lines, client.stderr].some((text) => text.includes(wrong)), 'the rejected token must not be echoed anywhere');
  await client.close();
});

test('stdio: an unreachable studio is a 503 that warns writes are not retried automatically', async (t) => {
  const app = await startApp(t);
  const dead = http.createServer();
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const { port } = dead.address();
  await new Promise((resolve) => dead.close(resolve));
  void app;
  const client = stdio(t, { url: `http://127.0.0.1:${port}`, token: TOKEN });
  const list = await client.request(modernMessage('tools/list'));
  assert.equal(list.error.data.status, 503);
  assert.match(list.error.message, /could not be reached/);
  assert.match(list.error.message, /never retried/);
  await client.close();
});

test('stdio: malformed lines get a parse error and the session keeps working', async (t) => {
  const app = await startApp(t);
  const client = stdio(t, { url: app.base, token: TOKEN });
  client.write('this is not json\n');
  client.write(`${JSON.stringify([1, 2, 3])}\n`);
  const alive = await client.request(modernMessage('ping'));
  assert.equal(alive.result.resultType, 'complete', 'the process survives bad input');
  await client.close();
  const parsed = client.lines.map((line) => JSON.parse(line));
  assert.ok(parsed.some((message) => message.error?.code === -32700 && message.id === null), 'unparseable input yields a -32700 parse error');
  assert.ok(parsed.some((message) => message.error?.code === -32600), 'a non-object message yields -32600');
});

test('stdio: unsafe configuration stops the process before it can send a token', async (t) => {
  for (const [name, url, token] of [['remote plaintext http', 'http://studio.example.com', TOKEN], ['url with credentials', 'http://user:pass@127.0.0.1:4310', TOKEN], ['url with a path', 'http://127.0.0.1:4310/api', TOKEN], ['token with control characters', 'http://127.0.0.1:4310', 'bad token with spaces']]) {
    const client = stdio(t, { url, token });
    const outcome = await client.request(modernMessage('tools/list'), 3000).then(() => 'replied', () => 'no reply');
    const exit = await client.exited;
    assert.equal(outcome, 'no reply', `${name}: must not serve requests`);
    assert.equal(exit.code, 1, `${name}: must exit non-zero`);
    assert.match(client.stderr, /FRAMEFORGE_(URL|TOKEN)/, `${name}: stderr must name the offending variable`);
    assert.deepEqual(client.lines, [], `${name}: stdout must stay empty`);
  }
});

test('stdio and /mcp return the same machine-readable 409 for a real stale episode_update, and the stale write changes nothing', async (t) => {
  const app = await startApp(t);
  const ids = await seed(app);
  const { episode, workflow } = await project(app, ids);
  const client = stdio(t, { url: app.base, token: TOKEN });
  const args = { episodeId: episode.id, expectedVersion: episode.version + 7, title: '늦은 수정' };
  const viaStdio = (await client.request(modernMessage('tools/call', { name: 'episode_update', arguments: args }))).result;
  const viaHttp = (await callTool(app, 'episode_update', args)).json.result;
  for (const [transport, result] of [['stdio', viaStdio], ['/mcp', viaHttp]]) {
    assert.equal(result.isError, true, `${transport}: isError`);
    const { error } = JSON.parse(result.content[0].text);
    assert.deepEqual([error.status, error.code, error.currentVersion], [409, 'stale_version', episode.version], `${transport}: envelope`);
    assert.deepEqual(result._meta[META_ERROR], { status: 409, code: 'stale_version', currentVersion: episode.version }, `${transport}: _meta mirror`);
  }
  const skipArgs = { workflowId: workflow.id, nodeId: 'research', skipped: true, expectedVersion: workflow.version + 3 };
  const skipViaStdio = (await client.request(modernMessage('tools/call', { name: 'workflow_set_skip', arguments: skipArgs }))).result;
  assert.deepEqual(skipViaStdio._meta[META_ERROR], { status: 409, code: 'stale_version', currentVersion: workflow.version });
  const planArgs = { workflowId: workflow.id, episodeId: episode.id, execution: { mode: 'all' }, expectedWorkflowVersion: workflow.version + 1 };
  const planViaStdio = (await client.request(modernMessage('tools/call', { name: 'workflow_plan', arguments: planArgs }))).result;
  assert.deepEqual(planViaStdio._meta[META_ERROR], { status: 409, code: 'stale_version' });
  const current = (await rest(app, 'episode_get', { episodeId: episode.id })).json.result.episode;
  assert.deepEqual([current.version, current.title], [episode.version, episode.title], 'neither stale write changed the episode');
  assert.ok(!(await rest(app, 'workflow_get', { workflowId: workflow.id })).json.result.workflow.skippedNodes.includes('research'));
  const fresh = (await client.request(modernMessage('tools/call', { name: 'episode_update', arguments: { ...args, expectedVersion: episode.version } }))).result;
  assert.equal(fresh.isError, false, 'the same call with the current version succeeds through the proxy');
  assert.equal(fresh.structuredContent.episode.version, episode.version + 1);
  assert.equal((await ids.ui(`/api/episodes/${episode.id}/archive`, 'POST', { expectedVersion: episode.version + 1 })).status, 200);
  const archived = (await client.request(modernMessage('tools/call', { name: 'episode_update', arguments: { ...args, expectedVersion: episode.version + 2 } }))).result;
  assert.equal(archived.isError, true);
  assert.deepEqual(archived._meta[META_ERROR], { status: 409, code: 'conflict' }, 'archived: conflict (not retryable) with no currentVersion, through stdio too');
  await client.close();
});
