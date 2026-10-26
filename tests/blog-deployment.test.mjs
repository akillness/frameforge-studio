import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';

async function fixture(t, deploy) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-blog-deploy-'));
  const options = { dataDir, loginToken: '', publicOrigin: '', blogOptions: {
    loadSources: async () => ({ workspace: { version: 'deployment-fixture-v1', latest: true, sourceRoots: [], sourceEvidence: [], blockedReasons: [] }, accounts: [{ id: 'naver-banggujin', accountId: 'banggujin', persona: '격리 테스트', keywords: ['검증'], menus: ['첫 메뉴', '다음 메뉴'], menuCursor: 0, menuEntries: [{ categoryNo: 41, name: '첫 메뉴' }, { categoryNo: 42, name: '다음 메뉴' }], nextMenu: { categoryNo: 41, name: '첫 메뉴' }, publicUrl: 'https://blog.naver.com/banggujin', editorUrl: 'https://example.com/editor' }] }),
    referenceOptions: { inspectImpl: async (url, { kind }) => ({ url, status: 200, headers: { 'content-type': 'text/html' }, html: kind === 'profile' ? '<section class="hm-component-homeCover-profile-info"><h1>검증 전문 채널</h1><a data-role="fan" data-clickcode="homeCover.fanCount">팬 100,000</a></section><div class="hm-component-activeChannels-item" data-servicetype="NBLOG" data-channelurl="https://blog.naver.com/synthetic-author"><a class="hm-component-activeChannels-link" href="https://blog.naver.com/synthetic-author">공식 블로그</a></div>' : `<meta property="og:type" content="article"><article><h1>첫 메뉴 · 검증 글</h1><p>${'첫 메뉴 검증 내용과 작성 구조를 설명하는 충분한 길이의 문장입니다. '.repeat(8)}</p><h2>정리</h2><p>${'이미지는 독립적으로 만들고 원문을 복사하지 않는 방법을 설명합니다. '.repeat(8)}</p></article>` }) },
    automation: { status: () => ({ agents: [], routing: { profile: 'jeopi', backend: 'api', status: 'available' } }), route: async () => ({ profile: 'jeopi', backend: 'api' }), deploy, login: async () => { throw Error('No login permitted'); }, draft: async () => { throw Error('No agent permitted'); } },
  } };
  let server;
  let base;
  const start = async () => { server = createApp(options); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; };
  const close = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await start();
  t.after(async () => { await close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const ok = async (path, method, body) => { const response = await request(path, method, body); const result = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`); return result; };
  await ok('/api/blog/refresh', 'POST', {});
  const account = (await ok('/api/blog/state')).accounts.find(item => item.id === 'naver-banggujin');
  const { reference } = await ok(`/api/blog/accounts/${account.id}/references`, 'POST', { expectedVersion: account.version, profileUrl: 'https://in.naver.com/synthetic-author', postUrls: ['https://blog.naver.com/synthetic-author/1234567890'] });
  const { draft } = await ok(`/api/blog/accounts/${account.id}/drafts`, 'POST', { expectedVersion: account.version, title: '격리 제목', body: '공개 게시하지 않는 본문입니다.', referenceId: reference.id });
  const { approval } = await ok(`/api/blog/drafts/${draft.id}/approval`, 'POST', { expectedVersion: draft.version, approved: true, formatReviewed: true });
  return { request, ok, draft, approval, account, restart: async () => { await close(); await start(); } };
}

test('deployment intent is durable before transport; an uncertain result cannot be resubmitted even after restart', async t => {
  let f;
  let submits = 0;
  let intent;
  f = await fixture(t, async () => {
    submits++;
    const during = await f.ok('/api/blog/state');
    intent = during.runs.find(item => item.kind === 'deploy' && item.draftId === f.draft.id);
    return { status: 'unknown', remoteId: 'known-fixture-id', evidence: { detail: 'Transport returned before readback' } };
  });
  const response = await f.request(`/api/blog/drafts/${f.draft.id}/deploy`, 'POST', { expectedVersion: f.draft.version, approvalId: f.approval.id });
  assert.ok(response.ok, await response.text());
  assert.equal(intent.status, 'running');
  assert.equal(intent.accountId, f.account.id);
  assert.equal((await f.ok('/api/blog/state')).accounts.find(item => item.id === f.account.id).menuCursor, f.account.menuCursor);
  await f.restart();
  const recovered = await f.ok('/api/blog/state');
  const current = recovered.drafts.find(item => item.id === f.draft.id);
  const persisted = recovered.runs.find(item => item.id === intent.id);
  assert.equal(persisted.status, 'unknown');
  assert.equal(persisted.output.remoteId, 'known-fixture-id', 'Known remote identity must remain available for operator readback without resubmission');
  assert.equal(persisted.approvalId, f.approval.id);
  assert.equal(persisted.manifestHash, f.approval.manifestHash);
  assert.equal(current.status, 'unknown');
  assert.equal((await f.request(`/api/blog/drafts/${f.draft.id}/deploy`, 'POST', { expectedVersion: current.version, approvalId: f.approval.id })).status, 409);
  assert.equal(submits, 1);
});

for (const proof of ['missing-readback', 'wrong-account', 'wrong-body', 'wrong-url', 'verified']) {
  test(`menu rotation requires exact public readback: ${proof}`, async t => {
    let submits = 0;
    const f = await fixture(t, async ({ account, approval }) => {
      submits++;
      return { status: 'verified', remoteId: 'fixture-post', publicUrl: proof === 'wrong-url' ? 'https://blog.naver.com/other-account/fixture-post' : 'https://blog.naver.com/banggujin/fixture-post', evidence: {
        publicReadback: proof !== 'missing-readback',
        targetAccountId: proof === 'wrong-account' ? 'different-account' : account.accountId,
        contentHash: proof === 'wrong-body' ? 'different-content-hash' : approval.contentHash,
      } };
    });
    const response = await f.request(`/api/blog/drafts/${f.draft.id}/deploy`, 'POST', { expectedVersion: f.draft.version, approvalId: f.approval.id });
    assert.ok(response.ok, await response.text());
    const after = await f.ok('/api/blog/state');
    const draft = after.drafts.find(item => item.id === f.draft.id);
    const account = after.accounts.find(item => item.id === f.account.id);
    if (proof === 'verified') {
      assert.equal(draft.status, 'published');
      assert.equal(account.menuCursor, (f.account.menuCursor + 1) % f.account.menus.length);
      await f.ok('/api/blog/refresh', 'POST', {});
      await f.ok('/api/blog/refresh', 'POST', {});
      assert.deepEqual((await f.ok('/api/blog/state')).accounts.find(item => item.id === account.id), account, 'Identical source refresh must preserve the verified local rotation without spurious versions or approval invalidation');
    } else {
      assert.notEqual(draft.status, 'published');
      assert.equal(account.menuCursor, f.account.menuCursor);
    }
    assert.equal((await f.request(`/api/blog/drafts/${draft.id}/deploy`, 'POST', { expectedVersion: draft.version, approvalId: f.approval.id })).status, 409);
    assert.equal(submits, 1);
  });
}
