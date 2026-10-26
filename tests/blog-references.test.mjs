import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBlogReferences, blogReferenceContextFingerprint } from '../server/blog-references.mjs';

const PROFILE = 'https://in.naver.com/synthetic-author';
const POST = 'https://blog.naver.com/synthetic-author/1234567890';
const READ_POST = 'https://m.blog.naver.com/synthetic-author/1234567890';
const IMAGE = 'https://blogfiles.pstatic.net/synthetic/reference-image.jpg';
const OBSERVED = '2026-10-25T00:00:00.000Z';
const account = { id: 'naver-banggujin', version: 7, persona: '양자 컴퓨팅 기술을 차분하게 설명하는 독립 작성자', keywords: ['양자 컴퓨팅'], menus: ['양자 컴퓨팅'], menuCursor: 0, nextMenu: { categoryNo: 42, name: '양자 컴퓨팅' } };
const workspace = { version: 'synthetic-reference-source-v1', latest: true, sourceEvidence: [{ id: 'synthetic/plan', sha256: 'a'.repeat(64) }] };
function profile({ count = '100,000', metric = '팬', owner = 'synthetic-author' } = {}) { return `<html><section class="hm-component-homeCover-profile-info"><h1>양자 컴퓨팅 전문 채널</h1><a data-role="fan" data-clickcode="homeCover.fanCount">${metric} ${count}</a></section><div class="hm-component-activeChannels-item" data-servicetype="NBLOG" data-channelurl="https://blog.naver.com/${owner}"><a class="hm-component-activeChannels-link" href="https://blog.naver.com/${owner}">공식 블로그</a></div></html>`; }
function article(topic = '양자 컴퓨팅') { return `<html><head><meta property="og:type" content="article"></head><body><article><h1>${topic}를 이해하는 글</h1><p>${`${topic}의 원리를 설명하는 독립적인 검증 문장입니다. `.repeat(6)}</p><h2>${topic}의 핵심</h2><p>${'근거와 적용 범위를 명확히 구분하고 과장 없이 설명합니다. '.repeat(5)}</p><img src="${IMAGE}" width="1200" height="800" alt="참고 그림"><h2>정리</h2><p>${'독자가 확인할 지점을 요약하고 출처를 남깁니다. '.repeat(4)}</p></article></body></html>`; }
function options({ profileHtml = profile(), postHtml = article(), override, currentAccount = account, currentWorkspace = workspace } = {}) {
  const requested = [];
  return { requested, args: { account: currentAccount, workspace: currentWorkspace, input: { profileUrl: PROFILE, postUrls: [POST] }, now: () => new Date(OBSERVED), inspectImpl: async (url, context) => { requested.push({ url, kind: context.kind }); return override ? override(url, context) : { html: context.kind === 'profile' ? profileHtml : postHtml, url, status: 200, headers: { 'content-type': 'text/html' } }; } } };
}

for (const row of [
  { name: '99999 is below the audience threshold', profileHtml: profile({ count: '99,999' }), code: 'REFERENCE_AUDIENCE_TOO_SMALL' },
  { name: 'visits do not establish follower audience', profileHtml: profile({ metric: '방문자' }), code: 'REFERENCE_METRIC_UNVERIFIED' },
  { name: 'views do not establish follower audience', profileHtml: profile({ metric: '조회수' }), code: 'REFERENCE_METRIC_UNVERIFIED' },
  { name: 'likes do not establish follower audience', profileHtml: profile({ metric: '좋아요' }), code: 'REFERENCE_METRIC_UNVERIFIED' },
  { name: 'unobservable metrics have no fabricated audience fallback', profileHtml: '<html><p>JavaScript로만 표시되는 메트릭</p></html>', code: 'REFERENCE_METRIC_UNVERIFIED' },
  { name: 'an unscoped biography cannot forge an authoritative audience count', profileHtml: '<html><span>팬 100,000</span><a href="https://blog.naver.com/synthetic-author">블로그</a></html>', code: 'REFERENCE_METRIC_UNVERIFIED' },
  { name: 'an unrelated category cannot pass with a claimed matching input category', postHtml: article('정원 가꾸기'), code: 'REFERENCE_CATEGORY_UNVERIFIED' },
  { name: 'a profile linked to another author cannot authorize this sample post', profileHtml: profile({ owner: 'another-author' }), code: 'REFERENCE_AUTHOR_UNVERIFIED' },
  { name: 'an unreadable representative article cannot create canned analysis', postHtml: '<html><p>내용을 읽을 수 없습니다.</p></html>', code: 'REFERENCE_ARTICLE_UNREADABLE' },
]) test(row.name, async () => {
  const f = options(row);
  f.args.input.category = '양자 컴퓨팅';
  await assert.rejects(analyzeBlogReferences(f.args), error => error.code === row.code && error.status === 422);
});

test('exactly 100000 publicly observed fans qualifies with URL/time/hash provenance and original-asset-only guidance', async () => {
  const f = options();
  const result = await analyzeBlogReferences(f.args);
  assert.equal(result.status, 'analyzed');
  assert.equal(result.category, '양자 컴퓨팅');
  assert.equal(result.metricEvidence.kind, 'fans');
  assert.equal(result.metricEvidence.count, 100000);
  assert.equal(result.metricEvidence.url, PROFILE);
  assert.equal(result.metricEvidence.observedAt, OBSERVED);
  assert.match(result.metricEvidence.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.references[0].sourceUrl, READ_POST);
  assert.equal(result.references[0].authorId, 'synthetic-author');
  const measured = result.references[0].measurements;
  assert.equal(measured.headings.count, 3);
  assert.equal(measured.paragraphs.count, 3);
  assert.equal(measured.images.count, 1);
  assert.equal(measured.images.positions[0].paragraphsBefore, 2);
  assert.equal(measured.images.positions[0].width, 1200);
  assert.equal(measured.images.positions[0].height, 800);
  assert.equal(measured.images.positions[0].aspectRatio, 1.5);
  assert.equal(measured.flow.introParagraphsBeforeFirstSection, 1);
  assert.equal(measured.flow.bodySectionHeadings, 2);
  assert.equal(measured.flow.closingLabelObserved, true);
  const observations = new Map(result.references.flatMap(reference => reference.observations).map(observation => [observation.id, observation]));
  for (const section of ['layout', 'images', 'formatting', 'adaptation']) {
    assert.equal(result.analysis[section].length, 1);
    for (const item of result.analysis[section]) {
      assert.ok(item.basedOn.length > 0, `${section} guidance must be justified by actual observations`);
      for (const id of item.basedOn) {
        const source = observations.get(id);
        assert.ok(source, `${section} references real measured observation ${id}`);
        assert.equal(source.sourceUrl, READ_POST);
        assert.equal(source.observedAt, OBSERVED);
      }
    }
  }
  assert.equal(JSON.stringify(result).includes(IMAGE), false, 'Publicly viewed images must never be exported as reusable assets');
  assert.equal(JSON.stringify(result).includes(article()), false, 'Analysis must not retain the complete copied article');
  assert.match(result.rightsStatement, /original|rights|독립|권리|복사/i);
  assert.deepEqual(f.requested.map(item => item.url), [PROFILE, READ_POST], 'Only representative HTML is inspected; reference assets are not downloaded');
});

test('context identity binds source bytes, persona and exact current category, while reference edits change the reference fingerprint', async () => {
  const first = await analyzeBlogReferences(options().args);
  const changedEvidence = await analyzeBlogReferences(options({ profileHtml: profile({ count: '100,001' }) }).args);
  assert.notEqual(changedEvidence.fingerprint, first.fingerprint);
  const before = blogReferenceContextFingerprint({ account, workspace });
  for (const change of [
    { account: { ...account, persona: '다른 독자와 글쓰기 규칙' }, workspace },
    { account: { ...account, menus: ['다른 분야'], nextMenu: { categoryNo: 43, name: '다른 분야' } }, workspace },
    { account, workspace: { ...workspace, version: 'changed-source-v2' } },
  ]) assert.notEqual(blogReferenceContextFingerprint(change), before);
});

for (const url of ['http://in.naver.com/synthetic-author', 'https://127.0.0.1/profile', 'https://localhost/profile', 'https://in.naver.com:444/synthetic-author', 'https://user:secret@in.naver.com/synthetic-author', 'file:///private', 'data:text/html,fan100000']) {
  test(`unsupported reference URL cannot reach inspection: ${url}`, async () => {
    const f = options();
    f.args.input.profileUrl = url;
    await assert.rejects(analyzeBlogReferences(f.args), error => error.code === 'REFERENCE_URL_UNSUPPORTED' && error.status === 400);
    assert.deepEqual(f.requested, []);
  });
}

test('a redirected public source cannot cross into an internal or unsupported host', async () => {
  const f = options({ override: () => ({ html: profile(), url: 'https://127.0.0.1/private', status: 200, headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(analyzeBlogReferences(f.args), error => error.code === 'REFERENCE_REDIRECT_UNSAFE' && error.status === 422);
});

function parentingProfile({ label = '육아 전문블로거', owner = 'synthetic-author' } = {}) {
  return profile({ owner }).replace('<h1>양자 컴퓨팅 전문 채널</h1>', `<h1>독립 작성자</h1><span class="hm-component-homeCover-profile-meta-item">${label}</span>`);
}
function parentingArticle({ category = '알콩달콩 양육법', owner = 'synthetic-author', title = '아이가 혼자 자기 시작할 때 확인할 점', topic = '아이의 생활 리듬과 자녀의 상황을 살펴보고 안전하게 적용할 방법을 설명합니다.' } = {}) {
  return `<meta property="og:type" content="article"><meta property="og:title" content="${title}"><div class="se-documentTitle"><div class="blog_category"><a href="https://blog.naver.com/PostList.naver?blogId=${owner}&amp;categoryNo=72">${category}</a></div><h1>${title}</h1></div><article><p>${topic.repeat(4)}</p><h2>확인할 점</h2><p>${topic.repeat(3)}</p></article>`;
}
const parentingAccount = menu => ({ ...account, persona: '아이의 성장 과정을 신중하게 기록하는 작성자', keywords: ['육아'], menus: [menu], nextMenu: { categoryNo: 27, name: menu } });

for (const menu of ['육아지식', '우당탕탕 육아일기']) test(`personalized ${menu} accepts observed parenting equivalence without rewriting raw labels`, async () => {
  const result = await analyzeBlogReferences(options({ currentAccount: parentingAccount(menu), profileHtml: parentingProfile(), postHtml: parentingArticle() }).args);
  const evidence = result.references[0].categoryEvidence;
  assert.equal(result.category, menu);
  assert.equal(evidence.rawTargetMenu, menu);
  assert.deepEqual(evidence.rawProfileCategoryLabels, ['육아 전문블로거']);
  assert.deepEqual(evidence.rawArticleCategoryLabels, [{ label: '알콩달콩 양육법', categoryNo: '72' }]);
  assert.equal(evidence.domain, 'parenting');
  assert.equal(evidence.mapping.version, 'blog-topical-equivalence-1');
  assert.match(evidence.mapping.provenance, /explicit.*official profile.*article/i);
  assert.deepEqual(evidence.mapping.targetTerms, ['육아']);
  assert.deepEqual(evidence.mapping.profileTerms, ['육아']);
  assert.ok(evidence.mapping.articleTerms.includes('양육'));
  assert.ok(evidence.supportingExcerpts.some(item => item.excerpt.includes('아이')));
  for (const item of evidence.supportingExcerpts) {
    assert.equal(item.url, READ_POST);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(result.references[0].authorId, 'synthetic-author');
  assert.equal(result.metricEvidence.count, 100000);
});

for (const row of [
  { name: 'unrelated actual article', postHtml: article('정원 가꾸기') },
  { name: 'conflicting official category despite parenting words', postHtml: parentingArticle({ category: '금융 투자', topic: '육아와 양육에 필요한 돈을 투자 상품으로 모으는 방법을 설명합니다.' }) },
  { name: 'arbitrary biography keyword instead of official profile category', profileHtml: profile().replace('</html>', '<p>육아 전문블로거이며 양육과 부모 이야기를 합니다.</p></html>') },
  { name: 'unrelated official profile category', profileHtml: parentingProfile({ label: '경제 전문블로거' }) },
  { name: 'secondary parenting interest overriding unrelated primary expertise', profileHtml: parentingProfile({ label: '경제 전문블로거' }).replace('</section>', '<span class="hm-component-homeCover-profile-meta-item">육아</span></section>') },
  { name: 'category link belonging to another author', postHtml: parentingArticle({ owner: 'another-author' }) },
  { name: 'footer-only parenting keyword', postHtml: article('정원 가꾸기').replace('</html>', '<footer>육아 양육 부모 유아</footer></html>') },
]) test(`parenting mapping rejects ${row.name}`, async () => {
  const f = options({ currentAccount: parentingAccount('육아지식'), profileHtml: parentingProfile(), postHtml: parentingArticle(), ...row });
  await assert.rejects(analyzeBlogReferences(f.args), error => error.status === 422 && error.code === 'REFERENCE_CATEGORY_UNVERIFIED');
});

for (const count of ['10만+', '100K+']) test(`explicit ${count} audience qualifies as a lower bound, never an exact count`, async () => {
  const result = await analyzeBlogReferences(options({ profileHtml: profile({ count }) }).args);
  assert.equal(result.metricEvidence.count, 100000);
  assert.equal(result.metricEvidence.precision, 'displayed-lower-bound');
  assert.ok(result.metricEvidence.excerpt.includes(count));
});
for (const count of ['10만', '100K']) test(`rounded ${count} without plus does not establish the threshold`, async () => {
  await assert.rejects(analyzeBlogReferences(options({ profileHtml: profile({ count }) }).args), error => error.status === 422 && error.code === 'REFERENCE_METRIC_UNVERIFIED');
});

test('caller-supplied numeric popularity cannot replace actual official metric inspection', async () => {
  const f = options({ profileHtml: profile({ count: '99,999' }) });
  f.args.input.followerCount = 100000;
  await assert.rejects(analyzeBlogReferences(f.args), error => error.status === 400 && error.code === 'REFERENCE_INPUT_INVALID');
  assert.deepEqual(f.requested, []);
});

test('reference semantic identity ignores operational version and connection bookkeeping but not the observed source', async () => {
  const reference = await analyzeBlogReferences(options().args);
  const changed = { ...account, version: account.version + 1, connection: { status: 'verified', detail: 'Synthetic bookkeeping' }, updatedAt: '2026-10-25T01:00:00Z' };
  assert.equal(blogReferenceContextFingerprint({ account: changed, workspace }), reference.contextFingerprint);
  assert.notEqual(blogReferenceContextFingerprint({ account: changed, workspace: { ...workspace, version: 'changed-source' } }), reference.contextFingerprint);
});
