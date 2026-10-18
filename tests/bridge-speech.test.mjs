import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentBridge } from '../scripts/agent-bridge.mjs';
import { createBridgeSpeechProvider, createSpeechProvider, listSpeechVoices, MAX_SPEECH_BYTES } from '../server/narration.mjs';

const token = 'test-only-speech-bridge-token-123456';
const voices = { available: true, voices: [{ id: 'Korean', name: 'Korean', language: 'ko-KR' }] };
const speech = { text: '검증용 음성', voice: 'Korean', rate: 0 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function wav() {
  const data = Buffer.alloc(16044);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(16000, 40);
  return data;
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-bridge-test-'));
  const speechRoot = path.join(root, 'work');
  const server = createAgentBridge({ token, speechRoot, listVoices: async () => voices,
    synthesize: async ({ outputPath }) => { await writeFile(outputPath, wav()); return { duration: 1 }; }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const post = (body = speech, headers = {}) => fetch(`${url}/speech/synthesize`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { root, speechRoot, url, post };
}
async function cleanWork(root) {
  // The server removes its owned directory after the response stream finishes.
  for (let attempt = 0; attempt < 100; attempt++) {
    const files = await readdir(root).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    if (!files.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Speech work directory was not cleaned');
}

test('speech bridge authenticates before provider access and rejects paths, malformed and oversized input', async t => {
  let calls = 0;
  const f = await fixture(t, { listVoices: async () => { calls++; return voices; } });
  assert.equal((await fetch(`${f.url}/speech/voices`)).status, 401);
  assert.equal((await f.post(speech, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal(calls, 0);
  for (const body of [{ ...speech, outputPath: '../escape.wav' }, { ...speech, text: 'x'.repeat(4001) }, { ...speech, rate: 11 }]) {
    assert.equal((await f.post(body)).status, 400);
  }
  assert.equal((await f.post({ ...speech, text: 'x'.repeat(17000) })).status, 413);
  assert.equal((await f.post(speech, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${f.url}/speech/synthesize`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await f.post({ ...speech, voice: 'Not installed' })).status, 400);
  await cleanWork(f.speechRoot);
});

test('HTTP adapter transfers only WAV bytes to an exclusive owned file and probes actual audio', async t => {
  const f = await fixture(t);
  const provider = createBridgeSpeechProvider({ bridgeUrl: f.url, token });
  assert.deepEqual(await provider.listVoices(), { ...voices, provider: 'windows-sapi', transport: 'host-bridge', local: false });
  const outputPath = path.join(f.root, 'local.wav');
  assert.equal((await provider.synthesize({ ...speech, outputPath })).duration, 1);
  assert.deepEqual(await readFile(outputPath), wav());
  await assert.rejects(provider.synthesize({ ...speech, outputPath }), error => error.status === 503);
  assert.deepEqual(await readFile(outputPath), wav(), 'Existing output must not be overwritten or deleted');
  await cleanWork(f.speechRoot);
});

test('bridge serializes speech work and cleans files after synthesis failure and successful retry', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, { synthesize: async ({ outputPath }) => {
    await writeFile(outputPath, wav());
    if (++calls === 1) { entered.resolve(); await release.promise; throw new Error('private-provider-detail'); }
    return { duration: 1 };
  } });
  const first = f.post(); await entered.promise;
  assert.equal((await f.post()).status, 429);
  release.resolve(); const failure = await first;
  assert.equal(failure.status, 502); assert.doesNotMatch(await failure.text(), /private-provider-detail/);
  await cleanWork(f.speechRoot);
  const success = await f.post(); assert.equal(success.status, 200); await success.arrayBuffer();
  await cleanWork(f.speechRoot);
});

test('bridge rejects invalid or oversized generated files before streaming and cleans owned work', async t => {
  for (const mode of ['invalid-header', 'oversized', 'duration']) {
    const f = await fixture(t, { synthesize: async ({ outputPath }) => {
      await writeFile(outputPath, mode === 'invalid-header' ? Buffer.alloc(44) : mode === 'oversized' ? Buffer.alloc(MAX_SPEECH_BYTES + 1) : wav());
      return { duration: mode === 'duration' ? 120 : 1 };
    } });
    assert.equal((await f.post()).status, 502);
    await cleanWork(f.speechRoot);
  }
});

test('remote adapter rejects oversized, invalid and failed audio and cleans partial candidates', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'frameforge-remote-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    () => new Response(wav(), { headers: { 'content-type': 'audio/wav', 'content-length': String(MAX_SPEECH_BYTES + 1) } }),
    () => new Response(Buffer.alloc(44), { headers: { 'content-type': 'audio/wav' } }),
    () => new Response(wav(), { headers: { 'content-type': 'text/plain' } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(MAX_SPEECH_BYTES)); controller.enqueue(Buffer.alloc(1)); controller.close(); } }), { headers: { 'content-type': 'audio/wav' } }),
    () => new Response(wav(), { headers: { 'content-type': 'audio/wav' } }),
  ];
  for (const [index, response] of cases.entries()) {
    const outputPath = path.join(root, `${index}.wav`);
    const provider = createBridgeSpeechProvider({ token, fetchImpl: async () => response(), probe: async () => { throw new Error('invalid codec'); } });
    await assert.rejects(provider.synthesize({ ...speech, outputPath }));
    await assert.rejects(stat(outputPath), error => error.code === 'ENOENT');
  }
  const busy = createBridgeSpeechProvider({ token, fetchImpl: async () => new Response('', { status: 429 }) });
  await assert.rejects(busy.synthesize({ ...speech, outputPath: path.join(root, 'busy.wav') }), error => error.status === 429);
});

test('voice and URL failures are explicit; credentials never follow redirects or nonlocal plaintext URLs', async t => {
  for (const bridgeUrl of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'file:///tmp/bridge']) {
    let called = false;
    const provider = createBridgeSpeechProvider({ bridgeUrl, token, fetchImpl: async () => { called = true; } });
    assert.equal((await provider.listVoices()).available, false); assert.equal(called, false);
  }
  const f = await fixture(t);
  assert.equal((await createBridgeSpeechProvider({ bridgeUrl: f.url, token: 'wrong-token-12345678901234567' }).listVoices()).available, false);
  const malformed = createBridgeSpeechProvider({ token, fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'error'); return new Response('{bad'); } });
  assert.equal((await malformed.listVoices()).available, false);
  const huge = createBridgeSpeechProvider({ token, fetchImpl: async () => new Response('x'.repeat(65537)) });
  assert.equal((await huge.listVoices()).available, false);
  assert.equal(createSpeechProvider({ platform: 'win32', mode: 'windows-sapi' }).listVoices, listSpeechVoices);
  assert.notEqual(createSpeechProvider({ platform: 'win32', mode: 'host-bridge', token }).listVoices, listSpeechVoices);
  assert.notEqual(createSpeechProvider({ platform: 'linux', mode: 'host-bridge', token }).listVoices, listSpeechVoices);
});
