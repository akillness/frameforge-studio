import { appendFile, readFile } from 'node:fs/promises';

const [inputPath, statusPath, outputPath] = process.argv.slice(2);
if (!inputPath || !statusPath || !outputPath) {
  console.error('Usage: node ci-test-summary.mjs <tap-log> <exit-status> <summary-output>');
  process.exit(2);
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

const [tap, statusText] = await Promise.all([readOptional(inputPath), readOptional(statusPath)]);
const exitStatus = /^\d+$/.test(statusText.trim()) ? Number(statusText.trim()) : null;
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
} else if (tests === null || passed === null || failed === null || skipped === null) {
  lines.push('The TAP summary was not present in the captured output. Check the grouped Actions log for the first failing step.');
} else {
  lines.push(`- Result: ${exitStatus === 0 && failed === 0 ? 'passed' : 'failed'}`);
  lines.push(`- npm test exit code: ${exitStatus ?? 'unknown'}`);
  lines.push(`- Tests: ${tests}; passed: ${passed}; failed: ${failed}; skipped: ${skipped}`);

  const failures = [...tap.matchAll(/^([ \t]*)not ok ([0-9]+)(?:\s+-[^\r\n]*)?$/gm)];
  if (failures.length) {
    lines.push('', 'Failed TAP entries (titles and diagnostic values omitted):');
    for (const failure of failures) {
      const indentation = failure[1].length ? ' (nested)' : '';
      const number = failure[2];
      const start = failure.index + failure[0].length;
      const nextFailure = tap.slice(start).search(/^[ \t]*not ok /m);
      const block = tap.slice(start, nextFailure < 0 ? tap.length : start + nextFailure);
      const location = block.match(/\blocation:\s*['"](?:[^'"\r\n]*\/)?(tests\/[A-Za-z0-9._/-]+\.test\.mjs):(\d+):\d+['"]/);
      lines.push(`- not ok ${number}${indentation}${location ? `; ${location[1]}:${location[2]}` : '; source location unavailable'}`);
    }
  } else if (failed > 0) {
    lines.push('', 'The TAP failure count is nonzero, but no individual `not ok` line was captured.');
  }
}

lines.push('', 'Test titles, error text, stack traces, and environment or user-data values are intentionally omitted. Full TAP output remains grouped in the job log.');
await appendFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
