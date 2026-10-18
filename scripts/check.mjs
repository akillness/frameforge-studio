import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
let count = 0;
for (const dir of ['server', 'scripts', 'public', 'tests']) {
  for (const file of readdirSync(dir, { recursive: true }).filter(f => /\.(mjs|js)$/.test(f))) {
    const result = spawnSync(process.execPath, ['--check', path.join(dir, file)], { encoding: 'utf8' });
    if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
    count++;
  }
}
console.log(`Syntax check passed for ${count} modules.`);
