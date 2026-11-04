import { readFile, writeFile } from 'node:fs/promises';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: node ci-test-summary.mjs <tap-log> <summary-output>');
  process.exit(2);
}

let tap = '';
try {
  tap = await readFile(inputPath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const lastCount = (name) => {
  const matches = [...tap.matchAll(new RegExp(`^# ${name} ([0-9]+)$`, 'gm'))];
  return matches.length ? Number(matches.at(-1)[1]) : null;
};
const tests = lastCount('tests');
const passed = lastCount('pass');
const failed = lastCount('fail');
const skipped = lastCount('skipped');
const lines = ['## npm test diagnostic summary', ''];

if (!tap) {
  lines.push('No npm test log was produced. Check the earlier setup step and its grouped Actions log.');
} else if (tests === null || failed === null) {
  lines.push('The TAP summary was not present in the captured output. Check the grouped Actions log for the first failing step.');
} else {
  lines.push(`- Result: ${failed === 0 ? 'passed' : 'failed'}`);
  lines.push(`- Tests: ${tests}; passed: ${passed ?? 'unknown'}; failed: ${failed}; skipped: ${skipped ?? 'unknown'}`);
}

lines.push('', 'Test titles, error text, stack traces, and environment values are intentionally omitted.');
await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
