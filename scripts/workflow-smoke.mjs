import { writeFile, mkdir } from 'node:fs/promises';
try { process.loadEnvFile('.env'); } catch {}
const base = process.env.STUDIO_URL || 'http://127.0.0.1:4310';
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: process.env.LOGIN_TOKEN }) });
if (!login.ok) throw new Error('Login failed');
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (route, body, method = 'GET') => {
  const response = await fetch(base + route, { method, headers: { cookie, 'content-type': 'application/json' }, ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
};
const state = await api('/api/state');
const channelId = state.channels.find(c => c.externalId === 'UCJswn08Sz-3-0JTLH56IRVQ').id;
const episode = await api('/api/episodes', { channelId, title: '노드로 만드는 첫 이야기', topic: '출처를 확인하는 콘텐츠 제작', category: 'information' }, 'POST');
const source = state.workflows[0];
const template = await api('/api/workflows', { name: 'Codex 실제 제작 · 조사부터 MP4까지', nodes: source.nodes.map(n => n.type === 'script' ? { ...n, config: { agent: 'codex', prompt: '한국어 정보 전달 영상. 3개 장면 각각 duration 1초, 총 3초로 테스트용 제작. 화면 문장은 짧게. 미확인 시사 주장을 추가하지 마세요.' } } : n), edges: source.edges }, 'POST');
const workflow = await api(`/api/workflows/${template.id}/copies`, { channelId, episodeId: episode.id, expectedTemplateVersion: template.version }, 'POST');
const renderNodeId = workflow.nodes.find(n => n.type === 'render').id;
const start = await api(`/api/workflows/${workflow.id}/run`, { episodeId: episode.id }, 'POST');
let run;
for (let i = 0; i < 180; i++) {
  run = (await api(`/api/workflows/${workflow.id}/runs`)).find(r => r.id === start.id);
  if (['failed', 'cancelled', 'awaiting_review', 'completed'].includes(run.status)) break;
  await new Promise(r => setTimeout(r, 1000));
}
await mkdir('artifacts', { recursive: true });
const output = run.nodeRuns.find(n => n.nodeId === renderNodeId)?.output;
const result = { verifiedAt: new Date().toISOString(), workflowId: workflow.id, episodeId: episode.id, runId: run.id, status: run.status, nodes: run.nodeRuns.map(n => ({ type: n.type, status: n.status, error: n.error })), output };
await writeFile(process.env.WORKFLOW_SMOKE_RECEIPT_PATH || 'artifacts/workflow-smoke.json', JSON.stringify(result, null, 2));
if (run.status !== 'awaiting_review' || !output?.outputUrl) throw new Error(JSON.stringify(result));
const rendered = await fetch(base + output.outputUrl, { headers: { cookie } });
if (!rendered.ok || Number(rendered.headers.get('content-length')) < 1000) throw new Error('Workflow artifact missing');
console.log(JSON.stringify(result, null, 2));
