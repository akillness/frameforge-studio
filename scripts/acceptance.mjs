import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execute } from '../server/process.mjs';
try { process.loadEnvFile('.env'); } catch {}
const base = process.env.STUDIO_URL || 'http://127.0.0.1:4310';
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: process.env.LOGIN_TOKEN }) });
if (!login.ok) throw new Error('Authentication failed');
const cookie = login.headers.get('set-cookie').split(';')[0];
const api = async (route, body, method = 'POST') => {
  const response = await fetch(base + route, { method, headers: { cookie, 'content-type': 'application/json' }, ...(method !== 'GET' ? { body: JSON.stringify(body || {}) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: ${response.status} ${result.error}`);
  return result;
};
const state = await api('/api/state', null, 'GET');
const channel = state.channels.find(c => c.externalId === 'UCJswn08Sz-3-0JTLH56IRVQ') || await api('/api/channels', { name: '확인해봄', category: 'information', platform: 'youtube', externalId: 'UCJswn08Sz-3-0JTLH56IRVQ', accountEmail: 'banggujin@gmail.com' });
for (const [name, category, externalId] of [['미완성 소원 보관소', 'drama', 'UC-fIyvnGO6istXfiRQ7Lq8w'], ['쩰리꾸미(Bright’JellyGGumi)', 'reenactment', 'UCRgEfHyFhDWxdlEy5nvP_TQ']]) {
  if (!state.channels.some(c => c.externalId === externalId)) await api('/api/channels', { name, category, platform: 'youtube', externalId, accountEmail: 'banggujin@gmail.com' });
}
let episode = await api('/api/episodes', { channelId: channel.id, title: '새 제작실 · 첫 번째 이야기', topic: '인기 키워드를 확인하고 근거를 남기는 영상 제작', category: 'information' });
episode = await api(`/api/episodes/${episode.id}/template`, { templateId: state.templates.find(t => t.category === 'information').id });
episode = await api(`/api/episodes/${episode.id}`, { expectedVersion: episode.version, scenes: [
  { ...episode.scenes[0], title: '검증된 이야기의 시작', text: '유행보다 먼저\n출처를 확인합니다', duration: 1, background: '#233e35', layout: 'center', kind: 'title' },
  { ...episode.scenes[1], title: '함께 만드는 제작실', text: '소재 → 연출 → 편집\n채널별로 쌓이는 기록', duration: 1, background: '#222d3f', layout: 'lower-third', kind: 'title' },
] }, 'PUT');
const job = await api(`/api/episodes/${episode.id}/render`, { expectedVersion: episode.version });
let completed;
for (let i = 0; i < 90; i++) {
  const current = await api('/api/state', null, 'GET');
  completed = current.jobs.find(j => j.id === job.id);
  if (['completed', 'failed'].includes(completed.status)) break;
  await new Promise(r => setTimeout(r, 1000));
}
if (completed.status !== 'completed') throw new Error(`Actual render ${completed.status}: ${completed.error || ''}`);
const download = await fetch(base + completed.outputUrl, { headers: { cookie } });
if (!download.ok) throw new Error('Authenticated MP4 download failed');
await mkdir('artifacts/private', { recursive: true });
await writeFile('artifacts/private/acceptance.mp4', Buffer.from(await download.arrayBuffer()));
const probe = JSON.parse((await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', 'artifacts/private/acceptance.mp4'])).stdout);
const history = await api(`/api/episodes/${episode.id}/history`, null, 'GET');
const trendResult = await api('/api/trends/refresh');
await api('/api/commands', { message: '실동작 검증: 채널 → 템플릿 → 장면 수정 → MP4 출력 완료', source: 'acceptance' });
const result = { verifiedAt: new Date().toISOString(), base, episodeId: episode.id, jobId: job.id, renderStatus: completed.status, width: probe.streams.find(s => s.codec_type === 'video').width, height: probe.streams.find(s => s.codec_type === 'video').height, duration: probe.format.duration, downloadBytes: Number(probe.format.size), historySnapshots: history.length, trends: trendResult.trends.length, trendSources: trendResult.sources, integrations: await api('/api/integrations', null, 'GET') };
await writeFile('artifacts/acceptance.json', JSON.stringify(result, null, 2));
await writeFile('ops/browser-session.json', JSON.stringify({ cookie, base, episodeId: episode.id }), { mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
