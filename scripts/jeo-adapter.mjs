// Run with Bun: populate JEO's live OAuth model catalog before its tool-free chat.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const cli = process.env.JEO_CLI || path.join(process.env.APPDATA || '', 'npm/node_modules/jeo-code/src/cli.ts');
const source = path.dirname(cli);
const { listProviderModels } = await import(pathToFileURL(path.join(source, 'ai/model-discovery.ts')).href);
await listProviderModels('openai', { codexCatalog: true, timeoutMs: 10000 });
const { runChatCommand } = await import(pathToFileURL(path.join(source, 'commands/chat.ts')).href);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
await runChatCommand([Buffer.concat(chunks).toString('utf8')]);
