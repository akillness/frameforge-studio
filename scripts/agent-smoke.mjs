import { mkdir, writeFile } from 'node:fs/promises';
try { process.loadEnvFile('.env'); } catch {}
const agent = process.argv[2] || 'codex';
const response = await fetch('http://127.0.0.1:4311/run', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AGENT_BRIDGE_TOKEN}` },
  body: JSON.stringify({ agent, message: '출처 확인의 중요성을 알려주는 15초 정보 영상, 총 3장면을 작성해 주세요.', episode: { title: '근거 있는 콘텐츠', topic: '출처 확인', category: 'information', scenes: [] } }),
  signal: AbortSignal.timeout(180000),
});
const result = await response.json();
await mkdir('artifacts', { recursive: true });
await writeFile(`artifacts/agent-${agent}.json`, JSON.stringify({ verifiedAt: new Date().toISOString(), status: response.status, ...result }, null, 2));
if (!response.ok) throw new Error(result.error);
console.log(`${agent}: real response received, ${result.scenes.length} validated scenes`);
