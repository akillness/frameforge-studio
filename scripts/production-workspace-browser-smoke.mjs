import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// This runner always starts the isolated Node test fixture. It accepts no target URL,
// credentials, production data directory or provider configuration.
export function runProductionWorkspaceBrowserSmoke() {
  return new Promise((done, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMSPEC|LANG|LC_ALL|PLATFORM_PLAYWRIGHT_MODULE|OPS_PLAYWRIGHT_MODULE|PLATFORM_CHROMIUM_PATH|CHROMIUM_PATH|PLAYWRIGHT_EXECUTABLE_PATH|FFMPEG_PATH|FFPROBE_PATH)$/i.test(name)));
    env.LOGIN_TOKEN = ''; env.PUBLIC_ORIGIN = '';
    const child = spawn(process.execPath, ['--test', 'tests/production-workspace-journey.test.mjs'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', windowsHide: true, env,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal, receipt: 'artifacts/production-workspace-implementation/journey-receipt.json' }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runProductionWorkspaceBrowserSmoke();
  process.exitCode = result.code ?? 1;
}
