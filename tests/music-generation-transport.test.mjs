import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { createGenerationProvider } from '../server/generation-provider.mjs';

function wav() {
  const rate = 8000, bytes = Buffer.alloc(44 + rate * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(rate * 2, 40); return bytes;
}

test('explicit CLI music quote and generation stay on the bridge even with API credentials configured', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'music-transport-'));
  const requests = [], bytes = wav();
  const generation = createGenerationProvider({ env: { HF_API_KEY: 'fixture-api-key', AGENT_BRIDGE_TOKEN: 'fixture-long-enough-token-123', AGENT_BRIDGE_URL: 'http://127.0.0.1:4311' }, fetchImpl: async (url, options) => {
    const target = new URL(url); requests.push({ target, method: options.method });
    assert.equal(target.origin, 'http://127.0.0.1:4311', 'API credentials must not silently reroute CLI music');
    if (target.pathname === '/generation/models' && !target.search) return Response.json([{ id: 'music_fixture', type: 'audio', transport: 'cli' }]);
    if (target.pathname === '/generation/models') return Response.json({ id: 'music_fixture', type: 'audio', transport: 'cli', parameters: [{ name: 'prompt', type: 'string', required: true }] });
    if (target.pathname === '/generation/estimate') return Response.json({ credits: 2.82 });
    if (target.pathname === '/generation/create') return Response.json({ requestId: 'cli-provider-1', transport: 'cli', status: 'queued', outputs: [] });
    if (target.pathname === '/generation/jobs/cli-provider-1') return Response.json({ requestId: 'cli-provider-1', transport: 'cli', status: 'completed', outputs: [{ url: 'https://images.higgs.ai/track.wav', type: 'audio' }] });
    throw new Error(`Unexpected fixture route: ${target.pathname}`);
  } });
  const app = createApp({ dataDir, loginToken: '', publicOrigin: '', generation, integrations: { integrationStatus: async () => ({}) }, generationOptions: { pollIntervalMs: 1, download: async (_url, file) => { await writeFile(file, bytes, { flag: 'wx' }); return { bytes: bytes.length, contentType: 'audio/wav' }; } } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (route, body) => { const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() }; };
  const visualModels = await call('/api/generation/models');
  assert.equal(visualModels.status, 200);
  assert.ok(visualModels.value.some(model => model.type === 'video' && model.transport === 'api'), 'default visual catalog remains on the API');
  const cliModels = await call('/api/generation/models?transport=cli');
  assert.equal(cliModels.status, 200); assert.equal(cliModels.value[0].id, 'music_fixture');
  const state = (await call('/api/state')).value;
  const episodeResponse = await call('/api/episodes', { channelId: state.channels[0].id, title: 'Transport fixture', topic: 'Music' });
  assert.equal(episodeResponse.status, 201); const episode = episodeResponse.value;
  const root = `/api/episodes/${episode.id}/generations`;
  const input = { requestId: 'transport-fixture-1', expectedVersion: episode.version, target: 'music', transport: 'cli', model: 'music_fixture', prompt: 'Instrumental fixture', params: {} };
  const quoted = await call(`${root}/quote`, input); assert.equal(quoted.status, 200, JSON.stringify(quoted.value));
  assert.equal(quoted.value.credits, 2.82);
  const approved = { ...input, quoteId: quoted.value.id, quoteFingerprint: quoted.value.fingerprint, acceptedCredits: quoted.value.credits };
  assert.ok((await call(root, { ...approved, transport: 'api' })).status >= 400, 'transport change invalidates consent');
  assert.equal(requests.filter(entry => entry.target.pathname === '/generation/create').length, 0);
  const started = await call(root, approved); assert.equal(started.status, 202, JSON.stringify(started.value));
  let job;
  for (let i = 0; i < 500; i++) { job = (await call(`/api/generations/${started.value.id}`)).value; if (['completed', 'failed', 'import_failed', 'manual_recovery', 'submission_unknown'].includes(job.status)) break; }
  assert.equal(job.status, 'completed', JSON.stringify(job));
  assert.equal(job.transport, 'cli'); assert.equal(job.providerRequestId, 'cli-provider-1');
  assert.equal(requests.filter(entry => entry.target.pathname === '/generation/create').length, 1);
  assert.equal(requests.filter(entry => entry.target.pathname === '/generation/jobs/cli-provider-1').length, 1);
});
