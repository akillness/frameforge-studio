import { createHiggsfieldApi, validateHiggsfieldId } from './higgsfield.mjs';
import { HttpError } from './validation.mjs';

/** Credentials stay on the server/host; browser and MCP use the authenticated studio API. */
export function createGenerationProvider({ env = process.env, fetchImpl = fetch } = {}) {
  const api = createHiggsfieldApi({ env, fetchImpl });
  const apiProvider = { ...api, capability: async () => ({ provider: 'higgsfield', transport: 'api', configured: api.configured, available: api.configured, authentication: api.configured ? 'configured' : 'not_configured', detail: 'Developer API key configuration is checked before generation.' }) };
  const configured = typeof env.AGENT_BRIDGE_TOKEN === 'string' && env.AGENT_BRIDGE_TOKEN.length >= 24;
  async function request(endpoint, body) {
    if (!configured) throw new HttpError(503, 'Higgsfield requires a Developer API key or an authenticated host bridge');
    let base;
    try { base = new URL(env.AGENT_BRIDGE_URL || 'http://127.0.0.1:4311'); } catch { throw new HttpError(503, 'Invalid generation bridge URL'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash || (base.protocol === 'http:' && !['127.0.0.1','localhost','[::1]','host.docker.internal'].includes(base.hostname))) throw new HttpError(503, 'Generation bridge must use a local host or HTTPS');
    let response;
    try { response = await fetchImpl(new URL(endpoint, base), { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${env.AGENT_BRIDGE_TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(150000) }); }
    catch { throw new HttpError(503, body && endpoint === '/generation/create' ? 'Generation submission outcome is unknown; inspect provider history before resubmitting' : 'Higgsfield host bridge is unavailable'); }
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new HttpError(502, 'Generation bridge response exceeds limit'); chunks.push(chunk); }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(502, 'Invalid generation bridge response'); }
    if (!response.ok) {
      const error = new HttpError([400,401,403,404,409,422,429,503].includes(response.status) ? response.status : 502, 'Higgsfield bridge rejected the request; verify model parameters and host login');
      if (['INVALID_INPUT','UNSUPPORTED','NOT_CONFIGURED','AUTH_REQUIRED','RATE_LIMITED','EXPIRED_QUOTE','SCHEMA_CHANGED','AMBIGUOUS_SUBMISSION','PROVIDER_UNAVAILABLE'].includes(result.code)) error.code = result.code;
      throw error;
    }
    return result;
  }
  const cli = {
    configured, transport: 'cli',
    capability: async () => { try { return await request('/generation/status'); } catch { return { provider: 'higgsfield', transport: 'cli', available: false, configured, detail: 'Check host bridge connectivity and Higgsfield login.' }; } },
    models: () => request('/generation/models'),
    modelSchema: model => request(`/generation/models?model=${encodeURIComponent(model)}`),
    estimate: input => request('/generation/estimate', input),
    create: input => request('/generation/create', input),
    status: id => request(`/generation/jobs/${validateHiggsfieldId(id)}`),
  };
  const selected = api.configured ? apiProvider : cli;
  return { ...selected, forTransport: (transport) => {
    if (transport === 'api' && api.configured) return apiProvider;
    if (transport === 'cli' && configured) return cli;
    throw new HttpError(503, 'Requested generation transport is unavailable');
  } };
}
