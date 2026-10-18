try { process.loadEnvFile('.env'); } catch {}
const base = 'http://127.0.0.1:4310';
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: process.env.LOGIN_TOKEN }) });
if (!login.ok) throw new Error('Login failed');
const cookie = login.headers.get('set-cookie').split(';')[0];
const state = await (await fetch(base + '/api/state', { headers: { cookie } })).json();
for (const [title, url, category, notes] of [
  ['짧은대본 · 관계와 선택', 'https://www.youtube.com/watch?v=1ztDwV0Dywk', 'drama', '공식 영상의 썸네일·시간표시 자막 관찰. 행동→질문→반응→선택 구조를 자체 원고에 적용. 원본 대사/영상 복제 없음. docs/research-playbook.md 참고.'],
  ['숏박스 · 생활 상황의 재연', 'https://www.youtube.com/watch?v=vJCvApln33A', 'reenactment', '공식 스케치코미디. 한 장소, 구체적 행동과 짧은 질문·답 호흡을 관찰. 실화로 단정하지 않음. 자체 재연은 사실/각색 표시.'],
  ['1분미만 · 질문과 직접 검증', 'https://www.youtube.com/watch?v=CW2hvo5vUcA', 'information', '공식 영상의 조작 화면 중심 썸네일과 자막 주제 전환 관찰. 한 문제→직접 검증→출처·조건을 자체 템플릿으로 제작.'],
]) {
  if (state.references.some(r => r.url === url)) continue;
  const response = await fetch(base + '/api/references', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title, url, category, notes, channelId: state.channels.find(c => c.category === category && c.externalId)?.id }) });
  if (!response.ok) throw new Error(await response.text());
}
console.log('Three evidence-backed creator references imported.');
