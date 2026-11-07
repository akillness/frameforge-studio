// Generates machine-readable descriptions of the agent operation catalog. Everything here is
// derived from the registry in agent-ops.mjs; there is no hand-maintained copy to drift.
import { OPERATIONS_VERSION } from './agent-ops.mjs';

const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const errorSchema = { type: 'object', properties: { ok: { const: false }, error: { type: 'string' }, code: { type: 'string' } }, required: ['ok', 'error'] };

export function toOpenApi(catalog, { serverUrl = 'http://127.0.0.1:4310' } = {}) {
  const paths = { '/api/agent/operations': { get: { operationId: 'listOperations', summary: 'List agent operations with JSON Schemas', responses: { 200: { description: 'Catalog', content: { 'application/json': { schema: { type: 'object' } } } } } } } };
  for (const operation of catalog) {
    paths[`/api/agent/operations/${operation.name}`] = {
      post: {
        operationId: operation.name, summary: operation.title, description: operation.description,
        'x-mcp-annotations': operation.annotations,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { arguments: operation.inputSchema }, required: ['arguments'], additionalProperties: false } } } },
        responses: {
          200: { description: 'Result', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, result: operation.outputSchema }, required: ['ok', 'result'] } } } },
          400: { description: 'Invalid arguments or graph', content: { 'application/json': { schema: errorSchema } } },
          401: { description: 'Missing or invalid credentials' },
          403: { description: 'Not permitted (for example paid generation disabled)', content: { 'application/json': { schema: errorSchema } } },
          404: { description: 'Unknown operation or entity', content: { 'application/json': { schema: errorSchema } } },
          409: { description: 'Stale version or conflicting state', content: { 'application/json': { schema: errorSchema } } },
          429: { description: 'Rate limited; honor Retry-After' },
        },
        security: [{ bearer: [] }, { sessionCookie: [] }],
      },
    };
  }
  return {
    openapi: '3.1.0', jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    info: { title: 'FrameForge Studio Agent API', version: OPERATIONS_VERSION, description: 'Function-style API for driving FrameForge workflows and episodes. The same operations are exposed as MCP tools at POST /mcp.' },
    servers: [{ url: serverUrl }], paths,
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'The LOGIN_TOKEN value. Accepted only on /api/agent/* and /mcp.' }, sessionCookie: { type: 'apiKey', in: 'cookie', name: 'frameforge_session' } } },
  };
}

export function toToolDefinitions(catalog, format = 'mcp') {
  if (format === 'openai') return catalog.map((operation) => ({ type: 'function', function: { name: operation.name, description: operation.description, parameters: operation.inputSchema } }));
  if (format === 'anthropic') return catalog.map((operation) => ({ name: operation.name, description: operation.description, input_schema: operation.inputSchema }));
  if (format === 'mcp') return catalog.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({ name, title, description, inputSchema, outputSchema, annotations: { title, ...annotations } }));
  return null;
}
