import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';
import { candidateFingerprint } from '../server/graph.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-blog-git-consent-'));
  let revision = 'a';
  let publications = 0;
  const automation = {
    status: () => ({ agents: [], routing: { profile: 'jeopi', backend: 'api', status: 'available' } }),
    route: async () => { throw Error('No agent route permitted'); },
    draft: async () => { throw Error('No agent generation permitted'); },
    login: async () => { throw Error('No login permitted'); },
    planDeploy: async ({ draft, workspace }) => ({ repository: 'https://github.com/jellyggumi/synthetic-blog', branch: 'test-only', files: ['posts/synthetic-review.md'], effects: ['commit', 'push', 'public-pages-update'], artifactSha256: revision.repeat(64), contentHash: candidateFingerprint({ title: draft.title, body: draft.body }), workspaceVersion: workspace.version, planHash: revision.repeat(64) }),
    deploy: async ({ account, approval }) => { publications++; return { status: 'verified', publicUrl: 'https://jellyggumi.github.io/synthetic-blog/posts/synthetic-review', remoteId: 'synthetic-commit-id', evidence: { publicReadback: true, targetAccountId: account.accountId, contentHash: approval.contentHash } }; },
  };
  const server = createApp({ dataDir, loginToken: '', publicOrigin: '', blogOptions: {
    loadSources: async () => ({ workspace: { version: 'git-test-source-v1', latest: true, sourceRoots: [], sourceEvidence: [], blockedReasons: [] }, accounts: [{ id: 'github-jellyggumi', platform: 'github', accountId: 'jellyggumi', persona: 'Synthetic review persona', keywords: ['검증'], menus: ['검증 메뉴', '다음 메뉴'], publicUrl: 'https://jellyggumi.github.io/synthetic-blog/', editorUrl: 'https://github.com/jellyggumi/synthetic-blog' }] }), automation,
    referenceOptions: { inspectImpl: async (url, { kind }) => ({ url, status: 200, headers: { 'content-type': 'text/html' }, html: kind === 'profile' ? '<section class="hm-component-homeCover-profile-info"><h1>검증 전문 채널</h1><a data-role="fan" data-clickcode="homeCover.fanCount">팬 100,000</a></section><div class="hm-component-activeChannels-item" data-servicetype="NBLOG" data-channelurl="https://blog.naver.com/synthetic-author"><a class="hm-component-activeChannels-link" href="https://blog.naver.com/synthetic-author">공식 블로그</a></div>' : `<meta property="og:type" content="article"><article><h1>검증 메뉴 · 검증 글</h1><p>${'검증 메뉴의 내용과 글쓰기 구조를 분석하는 충분한 길이의 문장입니다. '.repeat(8)}</p><h2>정리</h2><p>${'이미지는 독립적으로 만들고 원문을 복사하지 않는 방법을 설명합니다. '.repeat(8)}</p></article>` }) },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const ok = async (path, method, body) => { const response = await request(path, method, body); const value = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`); return value; };
  await ok('/api/blog/refresh', 'POST', {});
  const account = (await ok('/api/blog/state')).accounts.find(item => item.id === 'github-jellyggumi');
  const { reference } = await ok(`/api/blog/accounts/${account.id}/references`, 'POST', { expectedVersion: account.version, profileUrl: 'https://in.naver.com/synthetic-author', postUrls: ['https://blog.naver.com/synthetic-author/1234567890'] });
  const { draft } = await ok(`/api/blog/accounts/${account.id}/drafts`, 'POST', { expectedVersion: account.version, title: '검토 전용 Git 글', body: '실제 저장소에 기록하지 않는 테스트 본문.', referenceId: reference.id });
  const { approval } = await ok(`/api/blog/drafts/${draft.id}/approval`, 'POST', { expectedVersion: draft.version, approved: true, formatReviewed: true });
  return { request, ok, draft, approval, account, changePlan: () => { revision = 'b'; }, get publications() { return publications; } };
}

for (const consent of [undefined, { approved: false, planHash: 'a'.repeat(64) }]) {
  test(`body approval alone never authorizes Git commit/push: ${consent ? 'explicitly declined' : 'separate consent missing'}`, async t => {
    const f = await fixture(t);
    const before = await f.ok('/api/blog/state');
    const response = await f.request(`/api/blog/drafts/${f.draft.id}/deploy`, 'POST', { expectedVersion: f.draft.version, approvalId: f.approval.id, ...(consent ? { gitConsent: consent } : {}) });
    assert.equal(response.status, 400);
    assert.equal(f.publications, 0);
    assert.deepEqual(await f.ok('/api/blog/state'), before, 'A rejected Git consent must not consume approval, persist intent, or move rotation');
  });
}

test('Git planning is read-only and changing artifact/repository plan requires new separate consent', async t => {
  const f = await fixture(t);
  const before = await f.ok('/api/blog/state');
  const { plan } = await f.ok(`/api/blog/drafts/${f.draft.id}/deploy-plan`, 'POST', { expectedVersion: f.draft.version });
  assert.equal(plan.repository, 'https://github.com/jellyggumi/synthetic-blog');
  assert.deepEqual(plan.files, ['posts/synthetic-review.md']);
  assert.equal(plan.artifactSha256, 'a'.repeat(64));
  assert.deepEqual(await f.ok('/api/blog/state'), before);
  f.changePlan();
  const response = await f.request(`/api/blog/drafts/${f.draft.id}/deploy`, 'POST', { expectedVersion: f.draft.version, approvalId: f.approval.id, gitConsent: { approved: true, planHash: plan.planHash } });
  assert.equal(response.status, 409);
  assert.equal(f.publications, 0);
  assert.deepEqual(await f.ok('/api/blog/state'), before);
});

test('only matching separate Git consent reaches the test publisher once and verified readback advances rotation', async t => {
  const f = await fixture(t);
  const { plan } = await f.ok(`/api/blog/drafts/${f.draft.id}/deploy-plan`, 'POST', { expectedVersion: f.draft.version });
  const { draft } = await f.ok(`/api/blog/drafts/${f.draft.id}/deploy`, 'POST', { expectedVersion: f.draft.version, approvalId: f.approval.id, gitConsent: { approved: true, planHash: plan.planHash } });
  assert.equal(draft.status, 'published');
  assert.equal(f.publications, 1);
  assert.equal((await f.ok('/api/blog/state')).accounts.find(item => item.id === f.account.id).menuCursor, (f.account.menuCursor + 1) % f.account.menus.length);
  assert.equal((await f.request(`/api/blog/drafts/${draft.id}/deploy`, 'POST', { expectedVersion: draft.version, approvalId: f.approval.id, gitConsent: { approved: true, planHash: plan.planHash } })).status, 409);
  assert.equal(f.publications, 1);
});
