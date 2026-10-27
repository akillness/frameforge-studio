import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execute, executeWithStreams } from '../server/process.mjs';

const node = process.execPath;
const largeInput = Buffer.alloc(16 * 1024 * 1024, 0x61);
const sha256 = (input) => createHash('sha256').update(input).digest('hex');

// Each child reads some input, then deliberately closes that input and exits zero.
const closeEarly = (fd) => `
  const fs = require('node:fs');
  const input = fs.createReadStream(null, { fd: ${fd}, autoClose: true });
  input.once('data', () => {
    input.destroy();
    process.stdout.write('closed input', () => process.exit(0));
  });
`;

const digestInput = (fd) => `
  const fs = require('node:fs');
  const hash = require('node:crypto').createHash('sha256');
  const input = fs.createReadStream(null, { fd: ${fd}, autoClose: true });
  input.on('data', chunk => hash.update(chunk));
  input.on('end', () => process.stdout.write(hash.digest('hex')));
`;

function isInputFailure(error) {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, /timed out|exited [^:]+:/i);
  return true;
}

test('execute rejects when the child closes stdin before the input is written, even on exit zero', async () => {
  await assert.rejects(
    execute(node, ['-e', closeEarly(0)], { input: largeInput, timeout: 10000 }),
    isInputFailure,
  );
});

test('execute returns the digest of all input delivered before a successful exit', async () => {
  const input = Buffer.from('first line\n한글\0last line');
  const result = await execute(node, ['-e', digestInput(0)], { input, timeout: 10000 });
  assert.equal(result.stdout, sha256(input));
});

test('executeWithStreams rejects when an inherited input pipe closes before writing completes', async () => {
  await assert.rejects(
    executeWithStreams(node, ['-e', closeEarly(3)], {
      streams: [(pipe) => { pipe.end(largeInput); }],
      timeout: 10000,
    }),
    isInputFailure,
  );
});

test('executeWithStreams returns the digest of a fully delivered inherited stream', async () => {
  const input = Buffer.from('verified input\n한글\0end');
  const result = await executeWithStreams(node, ['-e', digestInput(3)], {
    streams: [(pipe) => { pipe.end(input); }],
    timeout: 10000,
  });
  assert.equal(result.stdout, sha256(input));
});

test('executeWithStreams propagates a producer failure after the child exits successfully', async () => {
  const failure = new Error('producer could not finish');
  await assert.rejects(
    executeWithStreams(node, ['-e', 'process.exit(0)'], {
      streams: [async (pipe) => {
        await new Promise((resolve) => pipe.once('close', resolve));
        throw failure;
      }],
      timeout: 10000,
    }),
    (error) => error === failure,
  );
});

test('a fast successful child with no input is not mistaken for an input failure', async () => {
  const result = await execute(node, ['-e', "process.stdout.write('complete')"], {
    input: '',
    timeout: 10000,
  });
  assert.equal(result.stdout, 'complete');
});
