import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runHermesAgent } from '../scripts/agent-bridge.mjs';

test('Hermes adapter writes the prompt as data and invokes one bounded safe-tool turn', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'frameforge-hermes-adapter-'));
  const calls = [];
  try {
    const result = await runHermesAgent('JSON only: \'$(not-a-shell-command)\'', {
      cwd,
      binary: 'hermes-fixture',
      executeImpl: async (binary, args, options) => {
        calls.push({ binary, args, options });
        return { stdout: '{"ok":true}', stderr: '' };
      },
    });
    assert.equal(result.stdout, '{"ok":true}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].binary, 'hermes-fixture');
    assert.deepEqual(calls[0].args.slice(0, 3), ['chat', '--query-file', path.join(cwd, 'hermes-query.txt')]);
    assert.ok(calls[0].args.includes('--oneshot'));
    assert.ok(calls[0].args.includes('--quiet'));
    assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--toolsets'), calls[0].args.indexOf('--toolsets') + 2), ['--toolsets', 'search']);
    assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--max-turns'), calls[0].args.indexOf('--max-turns') + 2), ['--max-turns', '1']);
    assert.equal(calls[0].options.cwd, cwd);
    assert.equal(calls[0].options.timeout, 170000);
    assert.equal(calls[0].options.maxBytes, 262144);
    assert.equal(await readFile(path.join(cwd, 'hermes-query.txt'), 'utf8'), 'JSON only: \'$(not-a-shell-command)\'');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Hermes adapter rejects an empty prompt before invoking a process', async () => {
  let called = false;
  await assert.rejects(runHermesAgent('  ', {
    cwd: tmpdir(),
    executeImpl: async () => { called = true; return { stdout: '', stderr: '' }; },
  }), /Invalid Hermes request/);
  assert.equal(called, false);
});
