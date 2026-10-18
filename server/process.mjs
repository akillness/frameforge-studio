import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export function execute(binary, args, { cwd, input, timeout = 180000, maxBytes = 1024 * 1024, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, failure;
    const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => { failure = new Error('Process timed out'); terminate(); }, timeout);
    const collect = (kind, data) => {
      size += data.length;
      if (size > maxBytes) { failure = new Error('Process output exceeded limit'); terminate(); return; }
      if (kind === 'out') stdout += outDecoder.write(data); else stderr += errDecoder.write(data);
    };
    child.stdout.on('data', d => collect('out', d));
    child.stderr.on('data', d => collect('err', d));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      stdout += outDecoder.end(); stderr += errDecoder.end();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${binary.split(/[\\/]/).at(-1)} exited ${code}: ${stderr.slice(-1800)}`));
      else resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
