import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function strings(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.includes('\0'))) {
    throw new Error(`${label} must be an array of strings without NUL characters`);
  }
  return [...value];
}

function within(parent, target) {
  const relative = path.relative(parent, target);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function environmentValue(env, name) {
  const keys = Object.keys(env).filter(key => process.platform === 'win32' ? key.toUpperCase() === name : key === name);
  if (keys.length > 1) throw new Error(`Conflicting ${name} environment entries`);
  const value = keys.length ? env[keys[0]] : undefined;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Invalid ${name} environment entry`);
  return value;
}

function explicitCapturePath(value, root, env) {
  let selected = value.trim();
  if (process.platform === 'win32') selected = selected.replace(/^\/([a-zA-Z])(?:\/|$)/, '$1:/');
  if (/^~(?:[/\\]|$)/.test(selected)) {
    const home = environmentValue(env, process.platform === 'win32' ? 'USERPROFILE' : 'HOME') || homedir();
    selected = path.join(home, selected.slice(2));
  } else if (selected.startsWith('~')) {
    throw new Error('LLM_WIKI_VAULT must use an absolute or checkout-relative private capture path');
  }
  if (process.platform === 'win32' && /^[a-zA-Z]:(?![/\\])/.test(selected)) {
    throw new Error('LLM_WIKI_VAULT cannot use a drive-relative path');
  }
  return path.resolve(root, selected);
}

async function inspectDirectory(file) {
  try {
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error('Private capture paths must be directories without symlinks or junctions');
    }
    return await realpath(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function validateCapturePath(root, selected) {
  const boundary = path.join(root, 'data', 'agent-captures');
  if (!within(boundary, selected)) {
    throw new Error('Conflicting LLM_WIKI_VAULT: select data/agent-captures or a directory below it; external and curated root-wiki capture overrides are not allowed');
  }
  let current = root;
  for (const part of path.relative(root, selected).split(path.sep)) {
    current = path.join(current, part);
    const resolved = await inspectDirectory(current);
    if (resolved !== null && path.relative(current, resolved)) {
      throw new Error('Private capture path does not match its real directory');
    }
  }
  const curatedVault = path.join(root, 'llm-wiki');
  const curatedReal = await inspectDirectory(curatedVault);
  if (curatedReal !== null && (within(curatedReal, selected) || within(selected, curatedReal))) {
    throw new Error('Private captures and the curated root wiki must remain distinct');
  }
  return curatedVault;
}

// Read-only planning: no directory creation, provider calls, or global configuration changes.
export async function createProjectAgentPlan({ taskArgs = [], env = process.env, root = repositoryRoot, executable } = {}) {
  const args = strings(taskArgs, 'Task arguments');
  const cwd = await realpath(root);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Project root must be a directory');
  const override = environmentValue(env, 'LLM_WIKI_VAULT');
  const explicit = Boolean(override?.trim());
  const captureVault = explicit ? explicitCapturePath(override, cwd, env) : path.join(cwd, 'data', 'agent-captures', `launch-${randomUUID()}`);
  const curatedVault = await validateCapturePath(cwd, captureVault);
  const selectedExecutable = executable ?? {
    file: environmentValue(env, 'JEOPI_CLI') || path.join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'jeopi.exe' : 'jeopi'),
    args: [],
  };
  if (!selectedExecutable || typeof selectedExecutable.file !== 'string' || selectedExecutable.file.includes('\0') || !path.isAbsolute(selectedExecutable.file) || /\.(?:cmd|bat|ps1)$/i.test(selectedExecutable.file)) {
    throw new Error('Jeopi requires an absolute native executable path, not a shell command or wrapper');
  }
  const prefix = strings(selectedExecutable.args ?? [], 'Executable arguments');
  return Object.freeze({
    executable: selectedExecutable.file,
    argv: Object.freeze([...prefix, ...args]),
    taskArgs: Object.freeze(args),
    cwd,
    captureVault,
    curatedVault,
    captureSelection: explicit ? 'explicit' : 'default',
    policy: Object.freeze({
      scope: 'per-launch containment',
      captureVariable: 'LLM_WIKI_VAULT',
      taskArguments: 'unchanged',
      shell: false,
      globalConfigurationChanged: false,
      nativeHookEnforcement: false,
    }),
  });
}

export async function runProjectAgent(plan, { env = process.env, spawnProcess = spawn } = {}) {
  const args = strings(plan.taskArgs, 'Task arguments');
  const argv = strings(plan.argv, 'Process arguments');
  const prefixLength = argv.length - args.length;
  if (prefixLength < 0 || args.some((arg, index) => arg !== argv[prefixLength + index])) {
    throw new Error('Launch plan no longer preserves the original task arguments');
  }
  const selected = environmentValue(env, 'LLM_WIKI_VAULT');
  if (selected?.trim() ? explicitCapturePath(selected, plan.cwd, env) !== plan.captureVault : plan.captureSelection !== 'default') {
    throw new Error('Capture override changed after planning');
  }
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (process.platform === 'win32' ? key.toUpperCase() === 'LLM_WIKI_VAULT' : key === 'LLM_WIKI_VAULT') delete childEnv[key];
  }
  // Absolute routing preserves an approved explicit target even if the hook later receives a different cwd.
  childEnv.LLM_WIKI_VAULT = plan.captureVault;
  const current = await createProjectAgentPlan({
    taskArgs: args,
    env: childEnv,
    root: plan.cwd,
    executable: { file: plan.executable, args: argv.slice(0, prefixLength) },
  });
  if (current.cwd !== plan.cwd || current.captureVault !== plan.captureVault || current.curatedVault !== plan.curatedVault) {
    throw new Error('Launch paths or capture override changed after planning');
  }
  let installed;
  try { installed = await stat(current.executable); } catch {
    throw new Error('Selected Jeopi executable is unavailable; no installation or fallback was attempted');
  }
  if (!installed.isFile()) throw new Error('Selected Jeopi executable is not a file');
  await mkdir(current.captureVault, { recursive: true, mode: 0o700 });
  await validateCapturePath(current.cwd, current.captureVault);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(current.executable, current.argv, {
      cwd: current.cwd,
      env: childEnv,
      shell: false,
      stdio: 'inherit',
    });
    const forwardSignal = signal => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const interrupt = () => forwardSignal('SIGINT');
    const terminate = () => forwardSignal('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => { cleanup(); resolve({ code, signal }); });
  });
}

const main = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (main) {
  try {
    const args = process.argv.slice(2);
    const dryRun = args[0] === '--dry-run';
    if (dryRun) args.shift();
    if (args[0] === '--') args.shift();
    const plan = await createProjectAgentPlan({ taskArgs: args });
    if (dryRun) console.log(JSON.stringify(plan, null, 2));
    else {
      console.error('FrameForge: per-launch private capture containment; no universal native-hook enforcement or global settings changes.');
      const result = await runProjectAgent(plan);
      process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
    }
  } catch (error) {
    console.error(`Project agent launch failed: ${error.message}`);
    process.exitCode = 1;
  }
}
