import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { HttpError } from '../server/validation.mjs';

const IDS = ['naver-banggujin', 'naver-jelly_ggumi', 'naver-jennie_p', 'tistory', 'github-jellyggumi'];
const TITLE = '검증 전용 한국어 초안';
const BODY = '실제 게시물이 아닌 격리된 회귀 테스트 본문입니다.\n두 번째 문단도 그대로 보존합니다.';

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-blog-contract-'));
  const effects = [];
  let version = 'synthetic-source-v1';
  let instant = new Date('2026-10-25T00:00:00Z');
  const loadSources = async () => ({
    workspace: { version, latest: true, sourceRoots: [], sourceEvidence: [{ path: 'fixture-plan.md', sha256: version }], refreshedAt: instant.toISOString(), blockedReasons: overrides.blockedReasons || [] },
    accounts: IDS.map((id, index) => ({ id, persona: `격리 페르소나 ${index}`, keywords: [`검증키워드${index}`], menus: ['첫 메뉴', '다음 메뉴'], menuCursor: 1, menuEntries: [{ categoryNo: 41, name: '첫 메뉴' }, { categoryNo: 42, name: '다음 메뉴' }], nextMenu: { categoryNo: 42, name: '다음 메뉴' }, publicUrl: index < 3 ? `https://blog.naver.com/${id.slice(6)}` : index === 3 ? 'https://synthetic-fixture.tistory.com/' : 'https://jellyggumi.github.io/', editorUrl: `https://example.com/editor/${id}`, sourceEvidence: [{ path: 'fixture-plan.md', sha256: version }] })),
  });
  const automation = {
    status: () => ({ agents: [{ id: 'hermes', available: true }], routing: { profile: 'jeopi', backend: 'api', status: 'available', detail: 'Isolated test transport' } }),
    route: async () => ({ profile: 'jeopi', backend: 'api', status: 'exercised', receipt: 'fixture-route' }),
    draft: async ({ account }) => { effects.push({ kind: 'draft', accountId: account.id }); return { title: TITLE, body: BODY }; },
    login: async () => { throw Error('Test prohibits login effects'); },
    deploy: async () => { throw Error('Test prohibits publication effects'); },
    ...overrides.automation,
  };
  const research = overrides.research || (async ({ query }) => ({
    trends: [{ keyword: query, source: '격리 검증 뉴스', url: 'https://example.com/news/verified', title: `${query} 확인된 기사` }],
    sources: [{ name: '격리 검증 뉴스', status: 'ok', query }],
  }));
  const referenceOptions = { inspectImpl: async (url, { kind }) => ({ url, status: 200, headers: { 'content-type': 'text/html' }, html: kind === 'profile' ? '<section class="hm-component-homeCover-profile-info"><h1>테스트 전문 채널</h1><a data-role="fan" data-clickcode="homeCover.fanCount">팬 100,000</a></section><div class="hm-component-activeChannels-item" data-servicetype="NBLOG" data-channelurl="https://blog.naver.com/synthetic-author"><a class="hm-component-activeChannels-link" href="https://blog.naver.com/synthetic-author">공식 블로그</a></div>' : `<meta property="og:type" content="article"><article><h1>첫 메뉴 다음 메뉴 사용자 메뉴 · 테스트 전문 글</h1><p>${'첫 메뉴 다음 메뉴 사용자 메뉴 검증키워드 직접 저장을 근거에 따라 독립적으로 설명합니다. '.repeat(8)}</p><h2>분석과 정리</h2><p>${'원문의 문장을 복사하지 않고 구체적인 배치와 구조만 분석합니다. '.repeat(8)}</p></article>` }) };
  const options = { dataDir, loginToken: '', publicOrigin: '', blogOptions: { loadSources, automation, research, referenceOptions, now: () => instant }, ...overrides.app };
  let server;
  let base;
  const start = async () => { server = createApp(options); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; };
  const close = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await start();
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (path, method = 'GET', body, headers = {}) => fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ok = async (path, method = 'GET', body, headers) => { const response = await request(path, method, body, headers); const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`); return result; };
  return { request, ok, effects, automation, loadSources, get base() { return base; }, source: next => { version = next; }, time: next => { instant = new Date(next); }, restart: async () => { await close(); await start(); } };
}

const state = f => f.ok('/api/blog/state');
const refresh = f => f.ok('/api/blog/refresh', 'POST', {});
const account = async (f, id = IDS[0]) => (await state(f)).accounts.find(item => item.id === id);
async function analyze(f, id = IDS[0]) {
  const current = await account(f, id);
  return (await f.ok(`/api/blog/accounts/${id}/references`, 'POST', { expectedVersion: current.version, profileUrl: 'https://in.naver.com/synthetic-author', postUrls: ['https://blog.naver.com/synthetic-author/1234567890'] })).reference;
}
async function manual(f, id = IDS[0], values = {}) {
  const current = await account(f, id);
  const reference = await analyze(f, id);
  return (await f.ok(`/api/blog/accounts/${id}/drafts`, 'POST', { expectedVersion: current.version, title: TITLE, body: BODY, referenceId: reference.id, ...values })).draft;
}
async function approve(f, draft) {
  return (await f.ok(`/api/blog/drafts/${draft.id}/approval`, 'POST', { expectedVersion: draft.version, approved: true, formatReviewed: true })).approval;
}

// Every blocked route is exercised before its body can dispatch an external effect.
test('blog reads and every mutation require a server-issued admin session; foreign writes cannot alter records', async t => {
  const token = 'isolated-blog-admin-token';
  const f = await fixture(t, { app: { loginToken: token } });
  assert.equal((await f.request('/api/blog/state')).status, 401);
  const routes = [
    ['POST', '/api/blog/refresh'], ['PUT', `/api/blog/accounts/${IDS[0]}`],
    ['POST', `/api/blog/accounts/${IDS[0]}/research`], ['POST', `/api/blog/accounts/${IDS[0]}/drafts`],
    ['POST', `/api/blog/accounts/${IDS[0]}/references`],
    ['PUT', '/api/blog/drafts/unknown'], ['POST', '/api/blog/drafts/unknown/approval'],
    ['POST', '/api/blog/drafts/unknown/deploy-plan'],
    ['POST', '/api/blog/drafts/unknown/deploy'], ['POST', `/api/blog/accounts/${IDS[0]}/login`],
    ['PUT', `/api/blog/accounts/${IDS[0]}/schedule`], ['POST', '/api/blog/scheduler/tick'],
  ];
  for (const [method, path] of routes) assert.equal((await f.request(path, method, { role: 'admin', authenticated: true }, { 'X-Role': 'admin' })).status, 401, `${method} ${path}`);
  const login = await f.request('/api/login', 'POST', { token });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  await f.ok('/api/blog/refresh', 'POST', {}, headers);
  const before = await f.ok('/api/blog/state', 'GET', undefined, headers);
  for (const [method, path] of routes) {
    for (const origin of [{ Origin: 'https://foreign.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await f.request(path, method, {}, { ...headers, ...origin })).status, 403, `${method} ${path}`);
  }
  assert.deepEqual(await f.ok('/api/blog/state', 'GET', undefined, headers), before);
  assert.deepEqual(f.effects, []);
  await f.ok('/api/logout', 'POST', {}, headers);
  assert.equal((await f.request('/api/blog/state', 'GET', undefined, headers)).status, 401);
});

test('account and manual draft edits survive restart, reject stale writers, and never leak into another account', async t => {
  const f = await fixture(t);
  await refresh(f);
  const original = await account(f);
  const untouched = await account(f, IDS[1]);
  const { account: edited } = await f.ok(`/api/blog/accounts/${original.id}`, 'PUT', { expectedVersion: original.version, persona: '사용자가 저장한 페르소나', keywords: ['직접 저장'], menus: ['사용자 메뉴', '다음 메뉴'], publicUrl: original.publicUrl, editorUrl: original.editorUrl });
  assert.equal((await f.request(`/api/blog/accounts/${original.id}`, 'PUT', { expectedVersion: original.version, persona: 'stale overwrite' })).status, 409);
  const draft = await manual(f);
  const { draft: saved } = await f.ok(`/api/blog/drafts/${draft.id}`, 'PUT', { expectedVersion: draft.version, title: '수정한 제목', body: BODY + '\n저장된 수정.' });
  assert.equal((await f.request(`/api/blog/drafts/${draft.id}`, 'PUT', { expectedVersion: draft.version, title: 'lost update', body: 'lost update' })).status, 409);
  assert.deepEqual(await account(f, IDS[1]), untouched, 'Edits on account A must not modify account B');
  f.source('synthetic-source-v2');
  await refresh(f);
  await f.restart();
  const restored = await state(f);
  assert.equal(restored.accounts.find(item => item.id === original.id).persona, edited.persona);
  assert.deepEqual(restored.accounts.find(item => item.id === IDS[1]).keywords, untouched.keywords);
  assert.deepEqual(restored.drafts.find(item => item.id === saved.id), saved);
  assert.equal(saved.title, '수정한 제목');
  assert.equal(saved.body, BODY + '\n저장된 수정.');
  assert.equal(saved.accountId, original.id);
  assert.equal(restored.drafts.filter(item => item.accountId === IDS[1]).length, 0);
  assert.deepEqual(f.effects, []);
});

for (const change of ['body', 'account', 'source']) {
  test(`exact preview approval cannot authorize publication after ${change} changes`, async t => {
    let published = false;
    const f = await fixture(t, { automation: { deploy: async () => { published = true; throw Error('Invalid approval reached external transport'); } } });
    await refresh(f);
    const cursorBefore = (await account(f)).menuCursor;
    const draft = await manual(f);
    const approval = await approve(f, draft);
    let current = draft;
    if (change === 'body') current = (await f.ok(`/api/blog/drafts/${draft.id}`, 'PUT', { expectedVersion: draft.version, title: draft.title, body: draft.body + '\n승인 후 변경.' })).draft;
    if (change === 'account') { const a = await account(f); await f.ok(`/api/blog/accounts/${a.id}`, 'PUT', { expectedVersion: a.version, persona: '승인 이후 페르소나' }); }
    if (change === 'source') f.source('source-changed-without-refresh');
    const response = await f.request(`/api/blog/drafts/${draft.id}/deploy`, 'POST', { expectedVersion: current.version, approvalId: approval.id });
    assert.equal(response.status, 409);
    assert.equal(published, false);
    assert.equal((await account(f)).menuCursor, cursorBefore);
  });
}

test('new source bytes block approval before refresh and never silently rebase the saved draft', async t => {
  const f = await fixture(t);
  await refresh(f);
  const draft = await manual(f);
  f.source('fresh-source-v2');
  assert.equal((await f.request(`/api/blog/drafts/${draft.id}/approval`, 'POST', { expectedVersion: draft.version, approved: true, formatReviewed: true })).status, 409);
  assert.deepEqual((await state(f)).drafts.find(item => item.id === draft.id), draft);
});

test('unavailable Jev routing blocks the agent before any draft effect or fabricated draft is persisted', async t => {
  const f = await fixture(t, { automation: { route: async () => { throw new HttpError(503, 'Jev jeopi API unavailable; no fallback'); } } });
  await refresh(f);
  const a = await account(f);
  await analyze(f, a.id);
  const response = await f.request(`/api/blog/accounts/${a.id}/drafts`, 'POST', { expectedVersion: a.version, agent: 'hermes' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Jev|jeopi/);
  assert.deepEqual(f.effects, []);
  assert.deepEqual((await state(f)).drafts, []);
});

test('research retains the actual query and verified article evidence; empty or failed sources never fabricate a brief', async t => {
  const queries = [];
  let result = 'verified';
  const url = 'https://example.com/news/keyword-proof';
  const f = await fixture(t, { research: async input => {
    queries.push(input.query);
    if (result === 'failed') throw new HttpError(503, 'News evidence unavailable');
    if (result === 'empty') return { trends: [], sources: [{ name: 'fixture', status: 'ok' }] };
    return { articles: [{ headline: '실제 응답의 기사 제목', source: '검증 신문', url, summary: '응답이 제공한 기사 요약.' }], trends: [{ keyword: input.query, source: '검증 신문', url }, { keyword: '아무 관계 없는 유행어', source: '무관한 소스', url: 'https://example.com/unrelated' }], sources: [{ name: '검증 신문', status: 'ok' }] };
  } });
  await refresh(f);
  const a = await account(f);
  const query = '양자 컴퓨팅 "오류 정정" A&B';
  const { brief } = await f.ok(`/api/blog/accounts/${a.id}/research`, 'POST', { expectedVersion: a.version, query });
  assert.deepEqual(queries, [query]);
  assert.equal(brief.query, query);
  assert.equal(brief.articles[0].url, url);
  assert.equal(brief.articles[0].headline, '실제 응답의 기사 제목');
  assert.deepEqual(brief.trends.map(item => item.keyword), [query], 'Unrelated general trends cannot masquerade as keyword research');
  assert.ok(brief.sourceEvidence.some(item => item.url === url));
  for (result of ['empty', 'failed']) {
    const response = await f.request(`/api/blog/accounts/${a.id}/research`, 'POST', { expectedVersion: a.version, query: '증거 없는 요청' });
    assert.equal(response.status, 503);
  }
  assert.equal((await state(f)).briefs.length, 1, 'Failed or empty research must not create a fabricated replacement brief');
});

test('inactive schedules do not run; Asia/Seoul cron is matched, deduped across restart, and can only create drafts', async t => {
  let publications = 0;
  const f = await fixture(t, { automation: { deploy: async () => { publications++; throw Error('Schedule must never publish'); } } });
  await refresh(f);
  await f.ok('/api/blog/scheduler/tick', 'POST', {});
  assert.deepEqual(f.effects, []);
  let a = await account(f);
  const reference = await analyze(f, a.id);
  await f.ok(`/api/blog/accounts/${a.id}/schedule`, 'PUT', { expectedVersion: a.version, cron: '0 9 * * *', timezone: 'Asia/Seoul', enabled: true, agent: 'hermes' });
  f.time('2026-10-24T23:59:00Z');
  await f.ok('/api/blog/scheduler/tick', 'POST', {});
  assert.deepEqual(f.effects, []);
  f.time('2026-10-25T00:00:00Z');
  await f.ok('/api/blog/scheduler/tick', 'POST', {});
  await f.ok('/api/blog/scheduler/tick', 'POST', {});
  await f.restart();
  await f.ok('/api/blog/scheduler/tick', 'POST', {});
  assert.deepEqual(f.effects, [{ kind: 'draft', accountId: a.id }]);
  assert.equal(publications, 0);
  const drafts = (await state(f)).drafts;
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].body, BODY);
  assert.equal(drafts[0].referenceId, reference.id, 'Enabling a schedule must preserve the already analyzed semantic reference, not require reanalysis');
  assert.notEqual(drafts[0].status, 'published');
  a = await account(f);
  await f.ok(`/api/blog/accounts/${a.id}/schedule`, 'PUT', { expectedVersion: a.version, cron: '0 9 * * *', timezone: 'Asia/Seoul', enabled: false, agent: 'hermes' });
  f.time('2026-10-26T00:00:00Z');
  await f.ok('/api/blog/scheduler/tick', 'POST', {});
  assert.equal(f.effects.length, 1);
});
test('schedule stale writers and invalid input preserve the previously saved schedule and account version', async t => {
  const f = await fixture(t);
  await refresh(f);
  const original = await account(f);
  const body = { expectedVersion: original.version, cron: '15 10 * * 1-5', timezone: 'Asia/Seoul', enabled: false, agent: 'hermes' };
  await f.ok(`/api/blog/accounts/${original.id}/schedule`, 'PUT', body);
  const before = await state(f);
  assert.equal((await f.request(`/api/blog/accounts/${original.id}/schedule`, 'PUT', { ...body, enabled: true })).status, 409);
  const current = await account(f);
  for (const patch of [{ timezone: 'UTC' }, { cron: '60 9 * * *' }, { enabled: 'true' }, { agent: 'unknown-agent' }]) {
    assert.equal((await f.request(`/api/blog/accounts/${original.id}/schedule`, 'PUT', { ...body, expectedVersion: current.version, ...patch })).status, 400);
  }
  const after = await state(f);
  assert.deepEqual(after.schedules, before.schedules);
  assert.deepEqual(after.accounts, before.accounts);
  assert.deepEqual(f.effects, []);
});

test('a valid approval for account A cannot authorize a different account draft', async t => {
  let publications = 0;
  const f = await fixture(t, { automation: { deploy: async () => { publications++; throw Error('Wrong-account approval reached publisher'); } } });
  await refresh(f);
  const a = await manual(f, IDS[0]);
  const b = await manual(f, IDS[1]);
  const approval = await approve(f, a);
  const response = await f.request(`/api/blog/drafts/${b.id}/deploy`, 'POST', { expectedVersion: b.version, approvalId: approval.id });
  assert.equal(response.status, 409);
  assert.equal(publications, 0);
  assert.deepEqual((await state(f)).drafts.find(item => item.id === b.id), b);
});
test('a blank research field resolves configured keywords and the selected real menu instead of rejecting the form', async t => {
  const f = await fixture(t);
  await refresh(f);
  const a = await account(f);
  const { brief } = await f.ok(`/api/blog/accounts/${a.id}/research`, 'POST', { expectedVersion: a.version, query: '' });
  assert.equal(brief.query, `${a.keywords[0]} OR ${a.menus[a.menuCursor]}`);
  assert.equal(brief.menu, '다음 메뉴');
  assert.equal(brief.categoryNo, 42);
  assert.equal(brief.trends[0].keyword, brief.query);
});

test('submitting an unchanged menu list with a persona edit preserves the selected category across refresh', async t => {
  const f = await fixture(t);
  await refresh(f);
  const a = await account(f);
  const { account: edited } = await f.ok(`/api/blog/accounts/${a.id}`, 'PUT', { expectedVersion: a.version, persona: '페르소나만 실제 변경', keywords: a.keywords, menus: a.menus, publicUrl: a.publicUrl, editorUrl: a.editorUrl });
  assert.equal(edited.menuCursor, a.menuCursor);
  await refresh(f);
  const restored = await account(f);
  assert.equal(restored.menuCursor, a.menuCursor);
  assert.deepEqual(restored.nextMenu, { categoryNo: 42, name: '다음 메뉴' });
  const draft = await manual(f);
  assert.equal(draft.menu, a.menus[a.menuCursor]);
  assert.equal(draft.categoryNo, 42);
});
test('manual scratch persists locally but cannot be approved until a current analyzed formatting plan is attached and reviewed', async t => {
  const f = await fixture(t);
  await refresh(f);
  const a = await account(f);
  const { draft } = await f.ok(`/api/blog/accounts/${a.id}/drafts`, 'POST', { expectedVersion: a.version, title: TITLE, body: BODY });
  assert.equal((await f.request(`/api/blog/drafts/${draft.id}/approval`, 'POST', { expectedVersion: draft.version, approved: true, formatReviewed: true })).status, 503);
  const blockedPublish = await f.request(`/api/blog/drafts/${draft.id}/deploy`, 'POST', { expectedVersion: draft.version, approvalId: 'unapproved-scratch' });
  assert.equal(blockedPublish.status, 503);
  assert.match((await blockedPublish.json()).error, /same-category reference.*100000/);
  assert.equal((await state(f)).drafts.find(item => item.id === draft.id).body, BODY);
  const reference = await analyze(f);
  const { draft: attached } = await f.ok(`/api/blog/drafts/${draft.id}`, 'PUT', { expectedVersion: draft.version, title: draft.title, body: draft.body, referenceId: reference.id });
  for (const review of [undefined, false]) {
    const response = await f.request(`/api/blog/drafts/${attached.id}/approval`, 'POST', { expectedVersion: attached.version, approved: true, ...(review === undefined ? {} : { formatReviewed: review }) });
    assert.equal(response.status, 400, 'Body consent must not stand in for reviewing the actual formatting/image-placement plan');
  }
  const approval = await approve(f, attached);
  assert.equal(approval.formatReviewed, true);
  assert.equal((await state(f)).approvals.filter(item => item.draftId === draft.id && item.status === 'active').length, 1);
  assert.deepEqual(f.effects, []);
});

for (const change of ['missing', 'persona', 'menu', 'source']) {
  test(`automatic writing cannot run with ${change} reference context`, async t => {
    const f = await fixture(t);
    await refresh(f);
    const reference = change === 'missing' ? null : await analyze(f);
    let a = await account(f);
    if (change === 'persona') await f.ok(`/api/blog/accounts/${a.id}`, 'PUT', { expectedVersion: a.version, persona: '변경된 독자와 화자 규칙' });
    if (change === 'menu') await f.ok(`/api/blog/accounts/${a.id}`, 'PUT', { expectedVersion: a.version, menus: ['사용자 메뉴'] });
    if (change === 'source') f.source('new-source-after-reference');
    a = await account(f);
    const response = await f.request(`/api/blog/accounts/${a.id}/drafts`, 'POST', { expectedVersion: a.version, agent: 'hermes', ...(reference ? { referenceId: reference.id } : {}) });
    assert.equal(response.status, change === 'missing' ? 503 : 409);
    assert.deepEqual(f.effects, [], 'No stale or absent reference may reach the agent boundary');
    assert.deepEqual((await state(f)).drafts, []);
  });
}

test('reanalyzing even identical reference evidence supersedes the prior reference identity and body approval', async t => {
  let publications = 0;
  const f = await fixture(t, { automation: { deploy: async () => { publications++; throw Error('Superseded reference reached publication'); } } });
  await refresh(f);
  const draft = await manual(f);
  const approval = await approve(f, draft);
  const reference = await analyze(f);
  assert.notEqual(reference.id, draft.referenceId);
  assert.equal(reference.fingerprint, draft.referenceFingerprint);
  assert.equal((await f.request(`/api/blog/drafts/${draft.id}/deploy`, 'POST', { expectedVersion: draft.version, approvalId: approval.id })).status, 409);
  assert.equal(publications, 0);
  assert.equal((await state(f)).drafts.find(item => item.id === draft.id).body, draft.body);
});

test('one account source blocker prevents its approval without blocking the other account review', async t => {
  const f = await fixture(t, { blockedReasons: [`${IDS[1]}: Canonical persona metadata is missing.`] });
  await refresh(f);
  const healthy = await manual(f, IDS[0]);
  assert.equal((await approve(f, healthy)).status, 'active');
  const blocked = await manual(f, IDS[1]);
  const response = await f.request(`/api/blog/drafts/${blocked.id}/approval`, 'POST', { expectedVersion: blocked.version, approved: true, formatReviewed: true });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /naver-jelly_ggumi/);
  const after = await state(f);
  assert.equal(after.approvals.some(item => item.draftId === blocked.id), false);
  assert.equal(after.drafts.find(item => item.id === blocked.id).body, BODY);
  assert.equal(after.approvals.find(item => item.draftId === healthy.id).status, 'active');
  assert.deepEqual(f.effects, []);
});

test('connection bookkeeping preserves an eligible reference for actual agent drafting without changing its persona or category', async t => {
  const f = await fixture(t, { automation: { login: async () => ({ status: 'manual-required', detail: 'Synthetic connection bookkeeping only' }) } });
  await refresh(f);
  const reference = await analyze(f);
  const before = await account(f);
  await f.ok(`/api/blog/accounts/${before.id}/login`, 'POST', { expectedVersion: before.version });
  const after = await account(f);
  assert.deepEqual([after.persona, after.menus, after.nextMenu], [before.persona, before.menus, before.nextMenu]);
  const { draft } = await f.ok(`/api/blog/accounts/${after.id}/drafts`, 'POST', { expectedVersion: after.version, agent: 'hermes', referenceId: reference.id });
  assert.equal(draft.body, BODY);
  assert.equal(draft.referenceId, reference.id);
  assert.deepEqual(f.effects, [{ kind: 'draft', accountId: after.id }]);
});
