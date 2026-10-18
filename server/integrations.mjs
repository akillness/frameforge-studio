import { randomUUID } from 'node:crypto';

const agentNames = ['codex', 'jeo', 'jeopi', 'hermes'];
const bridgeUrl = () => process.env.AGENT_BRIDGE_URL || 'http://127.0.0.1:4311';
async function bridge(endpoint, body) {
  if (!process.env.AGENT_BRIDGE_TOKEN) throw new Error('Host agent bridge is not configured');
  const response = await fetch(`${bridgeUrl()}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${process.env.AGENT_BRIDGE_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(body ? 180000 : 2500),
  });
  const result = JSON.parse(await boundedText(response, 262144));
  if (!response.ok) throw new Error(result.error || 'Bridge request failed');
  return result;
}
export async function integrationStatus() {
  let agents = {};
  try { const result = (await bridge('/status')).agents; if (result && typeof result === 'object') agents = result; } catch { /* Explicit unavailable status below. */ }
  return {
    studio: { available: true, status: 'available', detail: '규칙 기반 스토리보드 도우미 · LLM 아님' },
    ...Object.fromEntries(agentNames.map(name => [name, agents[name] || { available: false, status: 'unavailable', detail: '호스트 에이전트 브리지 연결 필요' }])),
    google: { available: true, status: 'configured', detail: 'Google Trends KR RSS · 새로고침 시 실제 응답 확인' },
    naver: { available: false, status: 'manual', detail: 'DataLab/검색 출처를 조사 후 URL과 키워드 기록. DataLab은 실시간 인기 순위 API가 아닙니다.' },
    aside: { available: true, status: 'external', detail: 'Aside 세션 9XBgVHBJYEGclLhz · ops/aside-inbox.jsonl 명령 수신' },
    youtube: { available: false, status: 'manual', detail: '채널 ID 연결 및 제작 관리. 게시 작업은 YouTube Studio에서 검수 후 실행' },
  };
}
export async function runAgent(agent, message, episode) {
  if (!agentNames.includes(agent)) throw new Error('Unknown agent');
  return bridge('/run', { agent, message, episode });
}
const decode = value => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
async function boundedText(response, max) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new Error('Response exceeds size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function parseTrendRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 40).map(([, body]) => {
    const title = decode(body.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim();
    return { id: randomUUID(), keyword: title, source: 'Google Trends KR', url: 'https://trends.google.com/trending?geo=KR', capturedAt: new Date().toISOString() };
  }).filter(t => t.keyword && t.keyword.length < 200);
}
export async function fetchTrends() {
  const sources = [], trends = [];
  try {
    const response = await fetch('https://trends.google.com/trending/rss?geo=KR', { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await boundedText(response, 2000000);
    trends.push(...parseTrendRss(xml));
    if (!trends.length) throw new Error('No trend items in feed');
    sources.push({ name: 'Google Trends KR', status: 'ok', count: trends.length, url: 'https://trends.google.com/trending?geo=KR', capturedAt: new Date().toISOString() });
  } catch (error) { sources.push({ name: 'Google Trends KR', status: 'error', error: error.message }); }
  sources.push({ name: 'Naver DataLab', status: 'manual', url: 'https://datalab.naver.com/', detail: '관심 키워드 비교와 수동 조사 기록을 사용합니다. 자동 실시간 순위로 표시하지 않습니다.' });
  return { trends, sources };
}
