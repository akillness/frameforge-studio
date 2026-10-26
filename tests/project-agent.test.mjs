import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createProjectAgentPlan, runProjectAgent } from '../scripts/project-agent.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'frameforge-project-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'fixture-home');
  await mkdir(home);
  const globalSettings = join(home, 'global-settings.json');
  const settingsBytes = '{"capture":"never-edit-global-config"}\n';
  await writeFile(globalSettings, settingsBytes);
  const receipt = join(root, 'child.json');
  const executable = join(root, 'fixture-agent.cjs');
  await writeFile(executable, "const fs = require('node:fs'); fs.writeFileSync(process.env.FIXTURE_RECEIPT, JSON.stringify({argv:process.argv.slice(2),captureVault:process.env.LLM_WIKI_VAULT,cwd:process.cwd(),marker:process.env.FIXTURE_MARKER}));\n");
  const env = Object.freeze({ ...process.env, HOME: home, USERPROFILE: home, LLM_WIKI_VAULT: '', FIXTURE_RECEIPT: receipt, FIXTURE_MARKER: 'child-visible-value' });
  return { root, home, globalSettings, settingsBytes, receipt, env, executable: { file: process.execPath, args: [executable] } };
}

test('actual child receives a checkout-private capture target and every original task argument unchanged', async t => {
  const f = await fixture(t);
  const taskArgs = Object.freeze(['original task with spaces', '--model', 'fixture/model', '--dry-run', '--', '한글 "quotes"', '$(never-a-shell)', '']);
  const parentCapture = process.env.LLM_WIKI_VAULT;
  const plan = await createProjectAgentPlan({ root: f.root, env: f.env, taskArgs, executable: f.executable });
  await assert.rejects(realpath(plan.captureVault), { code: 'ENOENT' }, 'Read-only launch planning must not create capture directories');
  const result = await runProjectAgent(plan, { env: f.env });
  assert.equal(result.code, 0);
  const child = JSON.parse(await readFile(f.receipt, 'utf8'));
  assert.deepEqual(child.argv, [...taskArgs]);
  const captureRelative = relative(await realpath(join(f.root, 'data/agent-captures')), child.captureVault);
  assert.equal(isAbsolute(captureRelative), false);
  assert.equal(captureRelative.startsWith('..'), false);
  assert.equal(child.captureVault, await realpath(child.captureVault));
  assert.equal(child.cwd, await realpath(f.root));
  assert.equal(child.marker, 'child-visible-value');
  assert.equal(process.env.LLM_WIKI_VAULT, parentCapture);
  assert.equal(f.env.LLM_WIKI_VAULT, '');
  assert.equal(await readFile(f.globalSettings, 'utf8'), f.settingsBytes);
  assert.equal(JSON.stringify(plan).includes('child-visible-value'), false, 'Dry-run plans must not disclose inherited environment values');
});

test('an explicit capture subdirectory is honored by the actual child instead of silently replaced', async t => {
  const f = await fixture(t);
  const selected = join(f.root, 'data/agent-captures/session-specific');
  const env = Object.freeze({ ...f.env, LLM_WIKI_VAULT: selected });
  const plan = await createProjectAgentPlan({ root: f.root, env, taskArgs: ['retain owner selection'], executable: f.executable });
  assert.equal((await runProjectAgent(plan, { env })).code, 0);
  assert.equal(JSON.parse(await readFile(f.receipt, 'utf8')).captureVault, await realpath(selected));
  assert.equal(env.LLM_WIKI_VAULT, selected);
  assert.equal(await readFile(f.globalSettings, 'utf8'), f.settingsBytes);
});

for (const target of ['outside', 'curated']) test(`conflicting ${target} capture destination rejects without child or global effects`, async t => {
  const f = await fixture(t);
  const selected = target === 'curated' ? join(f.root, 'llm-wiki') : join(f.home, 'external-vault');
  await mkdir(selected, { recursive: true });
  const sentinel = join(selected, 'preserve.txt');
  await writeFile(sentinel, 'original external bytes');
  const env = Object.freeze({ ...f.env, LLM_WIKI_VAULT: selected });
  await assert.rejects(createProjectAgentPlan({ root: f.root, env, taskArgs: ['must not launch'], executable: f.executable }), /capture|vault|conflict|outside/i);
  await assert.rejects(readFile(f.receipt), { code: 'ENOENT' });
  assert.equal(await readFile(sentinel, 'utf8'), 'original external bytes');
  assert.equal(await readFile(f.globalSettings, 'utf8'), f.settingsBytes);
  assert.equal(env.LLM_WIKI_VAULT, selected);
});

test('a capture ancestor junction cannot redirect the child into an external vault', async t => {
  const f = await fixture(t);
  const external = await mkdtemp(join(tmpdir(), 'frameforge-agent-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(join(f.root, 'data'));
  await symlink(external, join(f.root, 'data/agent-captures'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createProjectAgentPlan({ root: f.root, env: f.env, taskArgs: ['no escape'], executable: f.executable }), /symlink|symbolic|capture|unsafe/i);
  await assert.rejects(readFile(f.receipt), { code: 'ENOENT' });
  assert.equal(await readFile(f.globalSettings, 'utf8'), f.settingsBytes);
});

test('a conflicting environment supplied after planning blocks launch rather than silently rerouting captures', async t => {
  const f = await fixture(t);
  const plan = await createProjectAgentPlan({ root: f.root, env: f.env, taskArgs: ['preserve task'], executable: f.executable });
  await assert.rejects(runProjectAgent(plan, { env: { ...f.env, LLM_WIKI_VAULT: join(f.home, 'other-vault') } }), /capture|vault|conflict|changed/i);
  await assert.rejects(readFile(f.receipt), { code: 'ENOENT' });
  assert.equal(await readFile(f.globalSettings, 'utf8'), f.settingsBytes);
});

test('capture root replacement after planning cannot escape through a junction at launch time', async t => {
  const f = await fixture(t);
  const plan = await createProjectAgentPlan({ root: f.root, env: f.env, taskArgs: ['no race escape'], executable: f.executable });
  const external = await mkdtemp(join(tmpdir(), 'frameforge-agent-race-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(join(f.root, 'data'));
  await symlink(external, join(f.root, 'data/agent-captures'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runProjectAgent(plan, { env: f.env }), /symlink|symbolic|capture|unsafe/i);
  await assert.rejects(readFile(f.receipt), { code: 'ENOENT' });
});

test('regression: an ignored first signal does not suppress later signals before child completion', async t => {
  const f = await fixture(t);
  const plan = await createProjectAgentPlan({ root: f.root, env: f.env, taskArgs: ['finish lifecycle'], executable: f.executable });
  const baseline = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, killed: false });
  const received = [];
  child.kill = signal => { child.killed = true; received.push(signal); return true; };
  let ready;
  const spawned = new Promise(resolve => { ready = resolve; });
  let settled = false;
  const running = runProjectAgent(plan, { env: f.env, spawnProcess: () => { queueMicrotask(ready); return child; } });
  running.then(() => { settled = true; }, () => { settled = true; });
  await spawned;
  try {
    process.emit('SIGINT');
    await Promise.resolve();
    assert.equal(settled, false, 'Sending a signal is not evidence that the child exited');
    process.emit('SIGTERM');
    process.emit('SIGINT');
    assert.deepEqual(received, ['SIGINT', 'SIGTERM', 'SIGINT'], 'A still-live child must receive every later termination request');
  } finally {
    child.exitCode = 0;
    child.emit('close', 0, null);
    assert.deepEqual(await running, { code: 0, signal: null });
    assert.equal(process.listenerCount('SIGINT'), baseline.SIGINT);
    assert.equal(process.listenerCount('SIGTERM'), baseline.SIGTERM);
  }
  process.emit('SIGTERM');
  assert.deepEqual(received, ['SIGINT', 'SIGTERM', 'SIGINT'], 'Completion removes forwarding rather than retaining a stale child');
  t.diagnostic(`Lifecycle seam on ${process.platform}; process.emit exercises Node handlers, not OS signal delivery`);
});

for (const terminal of [{ name: 'exit code', code: 23, signal: null }, { name: 'signal termination', code: null, signal: 'SIGTERM' }]) test(`regression: actual ${terminal.name} completion suppresses forwarding and releases lifecycle listeners`, async t => {
  const f = await fixture(t);
  const plan = await createProjectAgentPlan({ root: f.root, env: f.env, taskArgs: ['observe completion'], executable: f.executable });
  const baseline = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, killed: false });
  const received = [];
  child.kill = signal => { received.push(signal); return true; };
  let ready;
  const spawned = new Promise(resolve => { ready = resolve; });
  const running = runProjectAgent(plan, { env: f.env, spawnProcess: () => { queueMicrotask(ready); return child; } });
  await spawned;
  try {
    child.exitCode = terminal.code;
    child.signalCode = terminal.signal;
    process.emit('SIGINT');
    process.emit('SIGTERM');
    assert.deepEqual(received, [], 'A completed child must not receive signals while stdio close is pending');
  } finally {
    child.emit('close', terminal.code, terminal.signal);
    assert.deepEqual(await running, { code: terminal.code, signal: terminal.signal });
    assert.equal(process.listenerCount('SIGINT'), baseline.SIGINT);
    assert.equal(process.listenerCount('SIGTERM'), baseline.SIGTERM);
  }
});

test('regression: child execution failure rejects honestly and removes signal handlers', async t => {
  const f = await fixture(t);
  const plan = await createProjectAgentPlan({ root: f.root, env: f.env, taskArgs: ['surface launch error'], executable: f.executable });
  const baseline = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, killed: false });
  const received = [];
  child.kill = signal => { received.push(signal); return true; };
  let ready;
  const spawned = new Promise(resolve => { ready = resolve; });
  const running = runProjectAgent(plan, { env: f.env, spawnProcess: () => { queueMicrotask(ready); return child; } });
  const rejected = assert.rejects(running, error => error.code === 'EACCES' && error.message === 'Fixture execution denied');
  await spawned;
  child.emit('error', Object.assign(new Error('Fixture execution denied'), { code: 'EACCES' }));
  await rejected;
  assert.equal(process.listenerCount('SIGINT'), baseline.SIGINT);
  assert.equal(process.listenerCount('SIGTERM'), baseline.SIGTERM);
  process.emit('SIGTERM');
  process.emit('SIGINT');
  assert.deepEqual(received, [], 'A rejected launch must not retain a signal sink');
});
