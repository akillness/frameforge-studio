import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { createHiggsfieldCli } from '../server/higgsfield-cli.mjs';

test('music quote uses the CLI adapter live catalog, schema and numeric cost without creating a job', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'music-cli-quote-'));
  let creates = 0, estimates = 0;
  const schema = { job_type: 'music_fixture', display_name: 'Music fixture', type: 'audio', params: [{ name: 'prompt', type: 'string', required: true }, { name: 'duration', type: 'integer', minimum: 1, maximum: 30 }] };
  const generation = createHiggsfieldCli({ execute: async args => {
    if (args[0] === 'model' && args[1] === 'list') return { stdout: JSON.stringify([{ job_type: 'music_fixture', type: 'audio' }]) };
    if (args[0] === 'model' && args[1] === 'get') return { stdout: JSON.stringify(schema) };
    if (args[0] === 'generate' && args[1] === 'cost') { estimates++; return { stdout: JSON.stringify({ credits: 2.82 }) }; }
    if (args[0] === 'generate' && args[1] === 'create') { creates++; throw new Error('unexpected paid submission'); }
    throw new Error(`Unexpected CLI fixture command: ${args.join(' ')}`);
  } });
  const app = createApp({ dataDir, loginToken: '', publicOrigin: '', generation, integrations: { integrationStatus: async () => ({}) } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  const episodeResponse = await fetch(`${base}/api/episodes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: state.channels[0].id, title: 'CLI fixture', topic: 'Music quote' }) });
  assert.equal(episodeResponse.status, 201);
  const episode = await episodeResponse.json();
  const request = { requestId: 'cli-music-1', expectedVersion: episode.version, target: 'music', model: 'music_fixture', prompt: 'An original instrumental', params: { duration: 12 } };
  const response = await fetch(`${base}/api/episodes/${episode.id}/generations/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(response.status, 200, await response.clone().text());
  const quote = await response.json();
  assert.equal(quote.credits, 2.82);
  assert.equal(estimates, 1); assert.equal(creates, 0);
});
