import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesBlogCron } from '../server/blog.mjs';

// UTC inputs cross local midnight/month boundaries; expectations refer to Asia/Seoul.
for (const row of [
  { name: 'weekday range includes Monday morning in Seoul', cron: '15 10 * * 1-5', instant: '2026-10-26T01:15:00Z', expected: true },
  { name: 'weekday range excludes Sunday morning in Seoul', cron: '15 10 * * 1-5', instant: '2026-10-25T01:15:00Z', expected: false },
  { name: 'minute step matches the exact quarter hour', cron: '*/15 9 * * *', instant: '2026-10-25T00:30:00Z', expected: true },
  { name: 'minute step excludes adjacent minute', cron: '*/15 9 * * *', instant: '2026-10-25T00:31:00Z', expected: false },
  { name: 'local month boundary uses Seoul date not UTC date', cron: '0 0 1 11 *', instant: '2026-10-31T15:00:00Z', expected: true },
  { name: 'local month boundary excludes preceding minute', cron: '0 0 1 11 *', instant: '2026-10-31T14:59:00Z', expected: false },
  { name: 'Sunday accepts cron day seven', cron: '0 9 * * 7', instant: '2026-10-25T00:00:00Z', expected: true },
  { name: 'explicit day-of-month and weekday follow cron OR semantics', cron: '0 9 1 * 1', instant: '2026-10-26T00:00:00Z', expected: true },
  { name: 'DOM wildcard step does not turn weekday restriction into daily execution', cron: '0 9 */1 * 1', instant: '2026-10-25T00:00:00Z', expected: false },
  { name: 'day OR excludes dates satisfying neither branch', cron: '0 9 1 * 1', instant: '2026-10-27T00:00:00Z', expected: false },
]) test(row.name, () => assert.equal(matchesBlogCron(row.cron, row.instant), row.expected));

for (const cron of ['60 9 * * *', '0 24 * * *', '0 9 0 * *', '0 9 * 13 *', '0 9 * * 8', '*/0 9 * * *', '5-2 9 * * *', '0 9 * *', 'bad 9 * * *']) {
  test(`invalid cron is rejected instead of silently matching: ${cron}`, () => {
    assert.throws(() => matchesBlogCron(cron, '2026-10-25T00:00:00Z'), error => error.status === 400);
  });
}
