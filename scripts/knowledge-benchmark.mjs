import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createProjectAgentPlan, runProjectAgent } from './project-agent.mjs';

const options = { root: resolve(fileURLToPath(new URL('../', import.meta.url))), phase: 'observation', iterations: 5 };
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (['--context-only', '--graph-only', '--hook-only'].includes(key)) options[{ '--context-only': 'contextOnly', '--graph-only': 'graphOnly', '--hook-only': 'hookOnly' }[key]] = true;
  else if (['--root', '--output', '--phase', '--iterations', '--compare', '--graph-before', '--graph-after', '--probe-hook', '--python'].includes(key) && process.argv[i + 1]) options[key.slice(2)] = process.argv[++i];
  else throw new Error(`Unsupported benchmark argument: ${key}`);
}
options.root = resolve(options.root);
options.iterations = Number(options.iterations);
if (!Number.isSafeInteger(options.iterations) || options.iterations < 1 || options.iterations > 30) throw new Error('Iterations must be an integer from 1 to 30');
const paths = ['AGENTS.md', '.mex/AGENTS.md', '.mex/ROUTER.md', '.mex/context/architecture.md', '.mex/patterns/knowledge-refresh.md'];
const files = await Promise.all(paths.map(async path => {
  const bytes = await readFile(join(options.root, path));
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return { path, bytes: bytes.length, characters: [...text].length, utf16CodeUnits: text.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
const sum = selected => selected.reduce((total, item) => ({ bytes: total.bytes + item.bytes, characters: total.characters + item.characters, utf16CodeUnits: total.utf16CodeUnits + item.utf16CodeUnits }), { bytes: 0, characters: 0, utf16CodeUnits: 0 });
const report = {
  phase: options.phase, observedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  context: { files, mandatoryStartup: sum(files.slice(0, 3)), startupWithArchitecture: sum(files.slice(0, 4)), allMeasuredFiles: sum(files) },
  workloads: [],
  limitations: [
    'Bytes are exact file bytes; characters are Unicode code points, not billed tokens. UTF-16 code units are separately reported.',
    'Startup groups are fixed comparable file sets: first three anchors and optionally architecture. Current routing may make architecture conditional; these sums are not proof of actual model context ingestion.',
    'Each command uses a fresh Node process. First observed run is not an OS-cache cold run; repeated runs may benefit from warm filesystem caches. No cache flush is attempted.',
    'Wall time includes spawn, module loading, work and exit instrumentation. Measurements do not estimate provider latency or token billing.',
    'Peak RSS is each actual child Node process resourceUsage().maxRSS in KiB, an OS-reported high-water mark, not a sampled aggregate or allocation measurement. No recursive process scans are used.',
    'Only identical argv and semantic workloads are comparable. Newly introduced search commands have no legacy equivalent baseline; distinct semantic searches must not be compared as equivalent.'
  ]
};
const snapshotInputs = () => Promise.all(['scripts/knowledge.mjs', 'server/project-knowledge.mjs', 'harness/knowledge-policy.json', 'harness/manifest.json', 'llm-wiki/index.md'].map(async path => {
  try { const bytes = await readFile(join(options.root, path)); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
  catch (error) { return { path, unavailable: error.code }; }
}));
report.inputIdentity = await snapshotInputs();
if (!options.contextOnly && !options.hookOnly) {
  const directory = await mkdtemp(join(tmpdir(), 'frameforge-knowledge-benchmark-'));
  try {
    const hook = join(directory, 'usage.cjs');
    await writeFile(hook, "const fs = require('node:fs'); process.on('exit', () => { let usage = null, unavailable = null; try { usage = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null; } catch (error) { unavailable = error.code || error.message; } fs.writeFileSync(process.env.FRAMEFORGE_BENCH_USAGE, JSON.stringify({ pid: process.pid, maxRSSKiB: usage?.maxRSS ?? null, unavailable })); });\n");
    const graphLoader = join(directory, 'graph-loader.cjs');
    await writeFile(graphLoader, "const fs=require('node:fs'); const bytes=fs.readFileSync(process.argv[2]); const graph=JSON.parse(bytes.toString('utf8')); process.stdout.write(JSON.stringify({bytes:bytes.length,nodes:Array.isArray(graph.nodes)?graph.nodes.length:Object.keys(graph.nodes||{}).length,edges:Array.isArray(graph.edges)?graph.edges.length:0,links:Array.isArray(graph.links)?graph.links.length:0}));\n");
    const workloads = options.graphOnly ? [] : [['scripts/knowledge.mjs', 'status'], ['scripts/knowledge.mjs', 'search', 'production'], ['scripts/knowledge.mjs', 'check']];
    for (const option of ['graph-before', 'graph-after']) if (options[option]) workloads.push([graphLoader, resolve(options[option])]);
    for (const argv of workloads) {
      const runs = [];
      for (let i = 0; i < options.iterations; i += 1) {
        const usagePath = join(directory, `usage-${report.workloads.length}-${i}.json`);
        const started = performance.now();
        const child = spawnSync(process.execPath, ['--require', hook, ...argv], { cwd: options.root, env: { ...process.env, NODE_OPTIONS: '', FRAMEFORGE_BENCH_USAGE: usagePath }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
        const wallMilliseconds = performance.now() - started;
        let usage = null;
        try { usage = JSON.parse(await readFile(usagePath, 'utf8')); } catch {}
        let response;
        try { response = JSON.parse(child.stdout); } catch {}
        runs.push({ iteration: i + 1, cacheClass: i === 0 ? 'first-observed-not-cache-cold' : 'repeat-os-cache-uncontrolled', wallMilliseconds, exitCode: child.status, signal: child.signal, error: child.error?.message ?? null, stdoutBytes: Buffer.byteLength(child.stdout ?? ''), stdoutSha256: createHash('sha256').update(child.stdout ?? '').digest('hex'), diagnostics: child.status !== 0 ? response?.errors ?? null : null, graph: argv[0] === graphLoader ? response ?? null : undefined, stderr: child.stderr ?? '', process: usage });
      }
      const times = runs.map(run => run.wallMilliseconds).sort((a, b) => a - b);
      const graphLoad = argv[0] === graphLoader;
      const input = graphLoad ? await readFile(argv[1]) : null;
      report.workloads.push({ executable: process.execPath, argv: graphLoad ? ['<temporary-native-json-loader>', basename(argv[1])] : argv, semanticWorkload: graphLoad ? 'native JSON file read + UTF-8 decode + JSON.parse + node/edge counts' : argv.slice(1).join(' '), ...(graphLoad ? { input: { bytes: input.length, sha256: createHash('sha256').update(input).digest('hex') } } : {}), runs, medianWallMilliseconds: times[Math.floor(times.length / 2)], allSucceeded: runs.every(run => run.exitCode === 0 && !run.error) });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (options['probe-hook']) {
  const directory = await mkdtemp(join(tmpdir(), 'frameforge-installed-hook-probe-'));
  try {
    const hookPath = resolve(options['probe-hook']);
    const hookBytes = await readFile(hookPath);
    const preflight = join(directory, 'offline-preflight.py');
    await writeFile(preflight, 'import importlib.util, json, sys\nprint(json.dumps({"executable":sys.executable,"isolated":sys.flags.isolated,"no_site":sys.flags.no_site,"dont_write_bytecode":sys.dont_write_bytecode,"networkx_available":importlib.util.find_spec("networkx") is not None,"graphify_available":importlib.util.find_spec("graphify") is not None}))\n');
    const checked = spawnSync(options.python || 'python', ['-I', '-S', '-B', preflight], { cwd: directory, encoding: 'utf8', timeout: 10000 });
    if (checked.status !== 0) throw new Error(`Offline Python preflight failed: ${checked.stderr}`);
    const preflightResult = JSON.parse(checked.stdout);
    if (!preflightResult.isolated || !preflightResult.no_site || !preflightResult.dont_write_bytecode || preflightResult.networkx_available || preflightResult.graphify_available) throw new Error('Optional graph rebuild is not demonstrably disabled in the isolated interpreter');
    const project = join(directory, 'synthetic-project');
    await mkdir(join(project, 'llm-wiki'), { recursive: true });
    const curatedIndex = join(project, 'llm-wiki/index.md');
    const originalIndex = Buffer.from('# Synthetic curated index\nNever admit capture bodies.\n');
    await writeFile(curatedIndex, originalIndex);
    const marker = `SYNTHETIC_WIKI_PROBE_${randomUUID()}`;
    const payload = { hook_event_name: 'manual', session_id: `probe-${randomUUID()}`, prompt: marker };
    const env = { ...process.env, LLM_WIKI_VAULT: '' };
    const plan = await createProjectAgentPlan({ root: project, env, executable: { file: preflightResult.executable, args: ['-I', '-S', '-B', hookPath] }, taskArgs: [JSON.stringify(payload)] });
    const result = await runProjectAgent(plan, { env });
    const collect = async root => (await Promise.all((await readdir(root, { withFileTypes: true })).map(async entry => entry.isDirectory() ? collect(join(root, entry.name)) : [join(root, entry.name)]))).flat();
    const capturedFiles = await collect(join(plan.captureVault, 'raw'));
    const matching = [];
    for (const path of capturedFiles) if ((await readFile(path, 'utf8')).includes(marker)) matching.push(path);
    const curatedUnchanged = originalIndex.equals(await readFile(curatedIndex));
    report.installedHookProbe = { hookSha256: createHash('sha256').update(hookBytes).digest('hex'), interpreter: preflightResult, exitCode: result.code, captureFilesContainingSyntheticPrompt: matching.length, curatedIndexUnchanged: curatedUnchanged, passed: result.code === 0 && matching.length > 0 && curatedUnchanged, graphRebuild: 'Not exercised: -I -S deliberately excludes third-party graph dependencies; full installed graphify helper behavior is unverified.' };
    if (!report.installedHookProbe.passed) process.exitCode = 1;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
report.inputIdentityAfter = await snapshotInputs();
report.inputsStableDuringMeasurement = JSON.stringify(report.inputIdentity) === JSON.stringify(report.inputIdentityAfter);
if (!report.inputsStableDuringMeasurement) report.limitations.push('Relevant inputs changed during measurement; this run is a drift observation, not a stable performance baseline.');
if (options.compare) {
  const baseline = JSON.parse(await readFile(resolve(options.compare), 'utf8'));
  report.comparison = {
    baselinePhase: baseline.phase,
    context: Object.fromEntries(['mandatoryStartup', 'startupWithArchitecture', 'allMeasuredFiles'].map(group => [group, Object.fromEntries(['bytes', 'characters', 'utf16CodeUnits'].map(metric => [metric, { before: baseline.context[group][metric], after: report.context[group][metric], delta: report.context[group][metric] - baseline.context[group][metric] }]))])),
    commandTiming: baseline.workloads?.length ? 'Repeated command observations only; compare identical argv and verify input identities and semantics before interpreting deltas.' : 'No comparable old command observations. New knowledge command timings are a baseline, not a before/after speedup claim.'
  };
}
if (options['graph-before'] || options['graph-after']) report.limitations.push('Graph before/after uses the identical native read/decode/parse/count workload over different corpus sizes. It measures graph-load cost only, not native extraction CPU savings or equivalent semantic search. RSS high-water differences may be noise.');
const output = `${JSON.stringify(report, null, 2)}\n`;
if (options.output) { await mkdir(dirname(resolve(options.output)), { recursive: true }); await writeFile(resolve(options.output), output); }
else process.stdout.write(output);
if (report.workloads.some(workload => !workload.allSucceeded)) process.exitCode = 1;
