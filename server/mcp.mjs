// Transport-agnostic MCP server core for FrameForge, targeting protocol revision 2026-07-28.
//
// Modern clients are served statelessly: every request carries its protocol version and client
// capabilities in params._meta (no initialize handshake, no sessions). Clients that still speak
// the handshake revisions (2025-11-25 and earlier) are answered by a minimal, stateless legacy
// path (initialize / tools only). Scope of this server: tools. Resources, prompts, subscriptions
// and the Tasks extension are intentionally not advertised; long work uses poll tools instead.
import { HttpError } from './validation.mjs';

export const MODERN_VERSIONS = Object.freeze(['2026-07-28']);
export const LEGACY_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
export const SUPPORTED_VERSIONS = Object.freeze([...MODERN_VERSIONS, ...LEGACY_VERSIONS]);
export const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
export const ERROR = Object.freeze({ PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, HEADER_MISMATCH: -32020, MISSING_CAPABILITY: -32021, UNSUPPORTED_VERSION: -32022 });
export const META_ERROR = 'com.frameforge/error';
/** Machine-readable error body shared by REST (/api/agent/*) and MCP tool errors. */
export const errorEnvelope = (error) => ({ error: { status: error.status, ...(error.code ? { code: error.code } : {}), ...(Number.isInteger(error.currentVersion) ? { currentVersion: error.currentVersion } : {}), message: error.message } });
const CACHE = Object.freeze({ ttlMs: 300000, cacheScope: 'private' });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });

/** Decode the =?base64?...?= sentinel used for non-ASCII header values. */
export function decodeHeaderValue(value) {
  const match = /^=\?base64\?(.*)\?=$/.exec(value ?? '');
  if (!match) return value;
  try { return Buffer.from(match[1], 'base64').toString('utf8'); } catch { return undefined; }
}

/**
 * Streamable HTTP request-metadata validation. Returns { legacy } or { status, body } for a
 * rejection. Header values are mirrored from the body, which stays the source of truth.
 */
export function validateHttpHeaders(message, headers) {
  const id = message?.id;
  const header = headers['mcp-protocol-version'];
  const bodyVersion = message?.params?._meta?.[META_VERSION];
  const mismatch = (reason) => ({ status: 400, body: rpcError(id, ERROR.HEADER_MISMATCH, `Header mismatch: ${reason}`) });
  if (bodyVersion !== undefined) {
    if (header === undefined) return mismatch('MCP-Protocol-Version header is required');
    if (header !== bodyVersion) return mismatch(`MCP-Protocol-Version header '${header}' does not match body '${bodyVersion}'`);
    if (message.id === undefined) return { legacy: false };
    if (headers['mcp-method'] !== message.method) return mismatch('Mcp-Method header is missing or does not match the body method');
    if (['tools/call', 'resources/read', 'prompts/get'].includes(message.method)) {
      const expected = message.params?.name ?? message.params?.uri;
      if (decodeHeaderValue(headers['mcp-name']) !== expected) return mismatch('Mcp-Name header is missing or does not match the body');
    }
    return { legacy: false };
  }
  if (header === undefined || LEGACY_VERSIONS.includes(header)) return { legacy: true };
  if (MODERN_VERSIONS.includes(header)) return { legacy: false }; // body lacks _meta: core answers -32602
  return { status: 400, body: rpcError(id, ERROR.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS], requested: header }) };
}

const toolDescriptor = ({ name, title, description, inputSchema, outputSchema, annotations }) => ({
  name, title, description, inputSchema, outputSchema,
  annotations: { title, readOnlyHint: annotations.readOnlyHint, destructiveHint: annotations.destructiveHint, idempotentHint: annotations.idempotentHint, openWorldHint: annotations.openWorldHint },
});

/**
 * @param options.serverInfo { name, title?, version }
 * @param options.instructions guidance text for models
 * @param options.listTools async () => catalog entries (name, title, description, inputSchema, outputSchema, annotations)
 * @param options.callTool async (name, args) => result object; throws HttpError (status, code) on failure
 * @returns { handle(message, { legacy? }) => { status, body } }  body === null for notifications
 */
export function createMcpCore({ serverInfo, instructions, listTools, callTool, log = (message) => console.error(message) }) {
  let legacySession = false; // stdio only: a handshake scopes legacy semantics to the process

  async function handle(message, context = {}) {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return { status: 400, body: rpcError(isObject(message) ? message.id : null, ERROR.INVALID_REQUEST, 'Invalid request') };
    const id = message.id;
    const notification = id === undefined;
    if (!notification && !(typeof id === 'string' || Number.isInteger(id))) return { status: 400, body: rpcError(null, ERROR.INVALID_REQUEST, 'Request id must be a string or integer') };
    if (message.params !== undefined && !isObject(message.params)) return { status: 400, body: rpcError(id, ERROR.INVALID_PARAMS, 'params must be an object') };
    const params = message.params || {};

    if (message.method === 'initialize') {
      if (notification) return { status: 202, body: null };
      legacySession = true;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
      return { status: 200, body: { jsonrpc: '2.0', id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo, instructions } } };
    }
    if (notification) return { status: 202, body: null };

    const meta = isObject(params._meta) ? params._meta : {};
    const requestedVersion = meta[META_VERSION];
    const modern = requestedVersion !== undefined;
    const legacy = !modern && (context.legacy ?? legacySession);
    if (!modern && !legacy) return { status: 400, body: rpcError(id, ERROR.INVALID_PARAMS, `params._meta["${META_VERSION}"] and params._meta["${META_CAPABILITIES}"] are required`) };
    if (modern) {
      if (!MODERN_VERSIONS.includes(requestedVersion)) return { status: 400, body: rpcError(id, ERROR.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: [...SUPPORTED_VERSIONS], requested: requestedVersion }) };
      if (!isObject(meta[META_CAPABILITIES])) return { status: 400, body: rpcError(id, ERROR.INVALID_PARAMS, `params._meta["${META_CAPABILITIES}"] is required`) };
    }
    const reply = (result, cacheable = false) => ({
      status: 200,
      body: { jsonrpc: '2.0', id, result: modern ? { resultType: 'complete', ...result, ...(cacheable ? CACHE : {}), _meta: { ...(result._meta || {}), [META_SERVER_INFO]: serverInfo } } : result },
    });

    try {
      if (message.method === 'ping') return reply({});
      if (message.method === 'server/discover' && modern) return reply({ supportedVersions: [...SUPPORTED_VERSIONS], capabilities: { tools: { listChanged: false } }, instructions }, true);
      if (message.method === 'tools/list') return reply({ tools: (await listTools()).map(toolDescriptor) }, true);
      if (message.method === 'tools/call') {
        if (typeof params.name !== 'string' || !params.name) return { status: 400, body: rpcError(id, ERROR.INVALID_PARAMS, 'params.name is required') };
        if (params.arguments !== undefined && !isObject(params.arguments)) return { status: 400, body: rpcError(id, ERROR.INVALID_PARAMS, 'params.arguments must be an object') };
        if (!(await listTools()).some((tool) => tool.name === params.name)) return { status: 200, body: rpcError(id, ERROR.INVALID_PARAMS, `Unknown tool: ${params.name}`) };
        let result;
        try { result = await callTool(params.name, params.arguments ?? {}); }
        catch (error) {
          if (error?.code === 'invalid_result') return { status: 200, body: rpcError(id, ERROR.INTERNAL, 'Tool produced an invalid result') };
          if (error instanceof HttpError) return reply({ content: [{ type: 'text', text: JSON.stringify(errorEnvelope(error)) }], isError: true, _meta: { [META_ERROR]: { status: error.status, ...(error.code ? { code: error.code } : {}), ...(Number.isInteger(error.currentVersion) ? { currentVersion: error.currentVersion } : {}) } } });
          log(`MCP tool ${params.name} failed: ${error?.message || error}`);
          return reply({ content: [{ type: 'text', text: JSON.stringify({ error: { status: 500, code: 'operation_failed', message: 'Operation failed. Check the local service logs.' } }) }], isError: true, _meta: { [META_ERROR]: { status: 500, code: 'operation_failed' } } });
        }
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      }
      return { status: 404, body: rpcError(id, ERROR.METHOD_NOT_FOUND, 'Method not found') };
    } catch (error) {
      if (error instanceof HttpError) return { status: error.status >= 400 && error.status < 600 ? error.status : 500, body: rpcError(id, ERROR.INTERNAL, error.message, { status: error.status, ...(error.code ? { code: error.code } : {}) }) };
      log(`MCP request ${message.method} failed: ${error?.message || error}`);
      return { status: 500, body: rpcError(id, ERROR.INTERNAL, 'Internal error') };
    }
  }
  return { handle };
}
