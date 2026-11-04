import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const summaryScript = path.join(here, 'ci-test-summary.mjs');
const runnerScript = path.join(here, 'run-npm-tests.sh');

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frameforge-ci-summary-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function summarize(directory, tap) {
  const input = path.join(directory, 'test.tap');
  const output = path.join(directory, 'summary.md');
  await writeFile(input, tap, 'utf8');
  const result = spawnSync(process.execPath, [summaryScript, input, output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return readFile(output, 'utf8');
}

test('uses the root totals after nested TAP and excludes dynamic titles and error text', async () => {
  await withTempDir(async (directory) => {
    const secret = 'PRIVATE_FIXTURE_SECRET_7f8b';
    const tap = [
      '    # tests 2',
      '    # pass 1',
      '    # fail 1',
      `    not ok 2 - nested title ${secret}`,
      `      error: ${secret}`,
      '# tests 12',
      '# pass 9',
      '# fail 3',
      '# skipped 0',
      `not ok 10 - root title ${secret}`,
      `  error: ${secret}`,
    ].join('\n');
    const summary = await summarize(directory, tap);
    assert.match(summary, /Tests: 12; passed: 9; failed: 3; skipped: 0/);
    assert.doesNotMatch(summary, new RegExp(secret));
    assert.doesNotMatch(summary, /root title|nested title|error:/i);
  });
});

test('reports missing TAP totals without copying error output', async () => {
  await withTempDir(async (directory) => {
    const summary = await summarize(directory, 'Error: PRIVATE_ERROR_BODY\nnot ok 1 - PRIVATE_TEST_TITLE\n');
    assert.match(summary, /TAP summary was not present/);
    assert.doesNotMatch(summary, /PRIVATE_ERROR_BODY|PRIVATE_TEST_TITLE|not ok/);
  });
});

test('reports a missing log with fixed text only', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'summary.md');
    const missing = path.join(directory, 'missing.tap');
    const result = spawnSync(process.execPath, [summaryScript, missing, output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const summary = await readFile(output, 'utf8');
    assert.match(summary, /No npm test log was produced/);
    assert.doesNotMatch(summary, /undefined|NaN|PRIVATE_/);
  });
});

test('npm test runner explicitly forwards the original pipeline status', async () => {
  const runnerSource = await readFile(runnerScript, 'utf8');
  assert.match(runnerSource, /npm test 2>&1 \| tee/);
  assert.match(runnerSource, /test_status=\$\{PIPESTATUS\[0\]\}/);
  assert.match(runnerSource, /exit "\$test_status"/);
});