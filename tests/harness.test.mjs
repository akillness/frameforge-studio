import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { HARNESS_FILES, changeHarness, verifyBundle, verifyCurrent } from '../scripts/version-harness.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'frameforge-harness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of HARNESS_FILES) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), `Fixture contract: ${path}\n`); }
  return root;
}

test('first release is verified without inventing an archive', t => {
  const root = fixture(t);
  const pointer = changeHarness(root, 'promote', '1.0.0');
  assert.equal(pointer.previousVersion, null);
  assert.equal(verifyCurrent(root).bundle.files.length, HARNESS_FILES.length);
  assert.equal(existsSync(join(root, 'harness/archive/1.0.0')), false);
  assert.throws(() => changeHarness(root, 'promote', '1.0.0'), /already active/);
});

test('promotion archives exact old bytes and rollback preserves both bundles', t => {
  const root = fixture(t);
  const first = changeHarness(root, 'promote', '1.0.0');
  writeFileSync(join(root, HARNESS_FILES[0]), 'A real revised test contract\n');
  const second = changeHarness(root, 'promote', '1.1.0');
  assert.equal(second.previousVersion, '1.0.0');
  assert.equal(verifyBundle(join(root, 'harness/archive/1.0.0'), '1.0.0').sha256, first.bundleSha256);
  const archiveBefore = readFileSync(join(root, 'harness/archive/1.0.0/bundle.json'));
  const rollback = changeHarness(root, 'rollback', '1.0.0');
  assert.equal(rollback.bundleSha256, first.bundleSha256);
  assert.equal(verifyBundle(join(root, 'harness/archive/1.1.0'), '1.1.0').sha256, second.bundleSha256);
  assert.deepEqual(readFileSync(join(root, 'harness/archive/1.0.0/bundle.json')), archiveBefore);
  assert.equal(readFileSync(join(root, HARNESS_FILES[0]), 'utf8'), 'A real revised test contract\n');
});

test('tampered current bundle prevents promotion and preserves pointer bytes', t => {
  const root = fixture(t);
  changeHarness(root, 'promote', '1.0.0');
  const pointer = readFileSync(join(root, 'harness/manifest.json'));
  writeFileSync(join(root, 'harness/versions/1.0.0', HARNESS_FILES[0]), 'tampered');
  assert.throws(() => verifyCurrent(root), /checksum mismatch/);
  assert.throws(() => changeHarness(root, 'promote', '1.1.0'), /checksum mismatch/);
  assert.deepEqual(readFileSync(join(root, 'harness/manifest.json')), pointer);
  assert.equal(existsSync(join(root, 'harness/.promotion.lock')), false);
});

test('invalid target, missing source and concurrent lock never replace current pointer', t => {
  const root = fixture(t);
  changeHarness(root, 'promote', '1.0.0');
  const pointer = readFileSync(join(root, 'harness/manifest.json'));
  assert.throws(() => changeHarness(root, 'promote', '../1'), /numeric/);
  assert.throws(() => changeHarness(root, 'promote', '0.9.0'), /increase/);
  assert.throws(() => changeHarness(root, 'rollback', '0.9.0'), /does not exist/);
  rmSync(join(root, HARNESS_FILES[0]));
  assert.throws(() => changeHarness(root, 'promote', '1.1.0'), /ENOENT/);
  writeFileSync(join(root, 'harness/.promotion.lock'), '{"pid":123}');
  assert.throws(() => changeHarness(root, 'promote', '1.1.0'), /locked/);
  assert.deepEqual(readFileSync(join(root, 'harness/manifest.json')), pointer);
});

test('an altered archive blocks transition instead of being overwritten', t => {
  const root = fixture(t);
  changeHarness(root, 'promote', '1.0.0');
  changeHarness(root, 'promote', '1.1.0');
  changeHarness(root, 'rollback', '1.0.0');
  const pointer = readFileSync(join(root, 'harness/manifest.json'));
  writeFileSync(join(root, 'harness/archive/1.0.0', HARNESS_FILES[0]), 'tampered archive');
  assert.throws(() => changeHarness(root, 'promote', '1.2.0'), /checksum mismatch/);
  assert.deepEqual(readFileSync(join(root, 'harness/manifest.json')), pointer);
});
