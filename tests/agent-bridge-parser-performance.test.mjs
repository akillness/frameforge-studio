import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { parseResult } from '../scripts/agent-bridge.mjs';
const result = JSON.stringify({
  message: '검토된 결과',
  scenes: [{ id: 'scene-1', title: '장면', text: '내용', duration: 5, background: '#20342d', kind: 'title', layout: 'center' }],
});

test('agent output parsing stays responsive after unmatched opening braces', () => {
  const payload = `${'{'.repeat(12_000)}${result}`;
  const started = performance.now();
  const responseBody = parseResult(payload);
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 250, `parsing blocked the bridge for ${Math.round(elapsedMs)}ms`);
  assert.deepEqual(responseBody, {
    message: '검토된 결과',
    scenes: [{ id: 'scene-1', title: '장면', text: '내용', duration: 5, background: '#20342d', kind: 'title', layout: 'center', trimStart: 0, audioVolume: 1, narration: '' }],
  });
});

test('agent output parsing recovers after an unmatched quote before the JSON result', () => {
  const reordered = JSON.stringify({
    meta: 'ignored',
    scenes: [{ id: 'scene-1', title: '장면', text: '내용', duration: 5, background: '#20342d', kind: 'title', layout: 'center' }],
    message: '검토된 결과',
  });
  assert.equal(parseResult(`{ "unterminated ${reordered}`).message, '검토된 결과');
});

test('agent output parsing prefers the outer result over nested result-shaped metadata', () => {
  const scenes = JSON.parse(result).scenes;
  const payload = JSON.stringify({ message: 'outer result', scenes, metadata: { message: 'nested result', scenes } });
  assert.equal(parseResult(payload).message, 'outer result');
});

test('agent output parsing recovers braces inside a result message after a malformed prefix', () => {
  const scenes = JSON.parse(result).scenes;
  const payload = `{ "unterminated ${JSON.stringify({ message: 'has {', scenes })}`;
  assert.equal(parseResult(payload).message, 'has {');
});

test('agent output parsing keeps the earliest valid result before a later fenced result', () => {
  const scenes = JSON.parse(result).scenes;
  const first = JSON.stringify({ message: 'first result', scenes });
  const later = `\`\`\`json\n${JSON.stringify({ message: 'later fenced result', scenes })}\n\`\`\``;
  assert.equal(parseResult(`${first}\n${later}`).message, 'first result');
});

test('agent output parsing does not spend its parse budget on nested invalid objects before a valid result', () => {
  const layers = 1_000;
  const noise = '{"message":"noise","scenes":[{"duration":500,"background":"#20342d"}],"child":'.repeat(layers) + 'null' + '}'.repeat(layers);
  assert.equal(parseResult(`${noise}${result}`).message, '검토된 결과');
});

test('agent output parsing keeps the earliest result after a malformed prefix', () => {
  const trailing = JSON.stringify({
    message: '후행 결과',
    scenes: [{ id: 'scene-2', title: '다른 장면', text: '다른 내용', duration: 5, background: '#20342d', kind: 'title', layout: 'center' }],
  });
  assert.equal(parseResult(`{ "unterminated ${result} ${trailing}`).message, '검토된 결과');
});

test('agent output parsing recovers in bounded time after thousands of JSON-like prefixes', () => {
  const prefixes = '{"message":'.repeat(4_000);
  const started = performance.now();
  const responseBody = parseResult(`{ "unterminated ${prefixes}${result}`);
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 250, `recovery blocked the bridge for ${Math.round(elapsedMs)}ms`);
  assert.equal(responseBody.message, '검토된 결과');
});

test('agent output parsing rejects deeply nested braces without repeated JSON parsing', () => {
  const payload = '{'.repeat(8_000) + '}'.repeat(8_000);
  const started = performance.now();
  assert.throws(() => parseResult(payload), /Agent returned invalid message/);
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 250, `invalid nested output blocked the bridge for ${Math.round(elapsedMs)}ms`);
});

test('agent output parsing bounds repeated parsing of nested result-like noise', () => {
  const layers = 3_000;
  const prefix = '{"message":"noise","scenes":[],"child":';
  const payload = prefix.repeat(layers) + 'null' + '}'.repeat(layers);
  const started = performance.now();
  assert.throws(() => parseResult(payload), /Agent returned invalid message/);
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs < 250, `nested result-like output blocked the bridge for ${Math.round(elapsedMs)}ms`);
});

test('agent output parsing keeps an early result when followed by many JSON objects', () => {
  const trailingObjects = Array.from({ length: 40 }, (_, index) => JSON.stringify({ noise: index })).join(' ');
  assert.equal(parseResult(`${result} ${trailingObjects}`).message, '검토된 결과');
});
