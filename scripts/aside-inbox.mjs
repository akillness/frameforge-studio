import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
try { process.loadEnvFile('.env'); } catch {}
await mkdir('ops', { recursive: true });
const targetSession = process.env.ASIDE_SESSION_ID || '9XBgVHBJYEGclLhz';
const base = process.env.STUDIO_URL || 'http://127.0.0.1:4310';
let known = new Set(), cookie;
try { known = new Set(JSON.parse(await readFile('ops/aside-imported.json', 'utf8'))); } catch {}
async function tick() {
  let input;
  try { input = await readFile('ops/aside-inbox.jsonl', 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (input.length > 2000000) throw new Error('Aside inbox exceeds 2 MB; archive processed entries');
  for (const line of input.split('\n').filter(Boolean)) {
    const hash = createHash('sha256').update(line).digest('hex');
    if (known.has(hash)) continue;
    const item = JSON.parse(line);
    if (item.sessionId !== targetSession || typeof item.message !== 'string' || !item.message.trim() || item.message.length > 4000) throw new Error('Invalid Aside command envelope');
    if (!cookie) {
      const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: process.env.LOGIN_TOKEN }) });
      if (!response.ok) throw new Error('Inbox login failed');
      cookie = response.headers.get('set-cookie').split(';')[0];
    }
    const response = await fetch(base + '/api/commands', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ message: item.message, source: 'aside', sessionId: targetSession }) });
    if (response.status === 401) cookie = undefined;
    if (!response.ok) throw new Error(`Inbox import failed ${response.status}`);
    known.add(hash);
    await writeFile('ops/aside-imported.json', JSON.stringify([...known]));
    console.log('Imported one Aside command.');
  }
}
await tick().catch(e => console.error(e.message));
let running = false;
setInterval(async () => { if (running) return; running = true; try { await tick(); } catch (e) { console.error(e.message); } finally { running = false; } }, 5000);
