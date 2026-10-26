import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlogAutomation } from '../server/blog-automation.mjs';
import { loadBlogSources } from '../server/blog-sources.mjs';
import { analyzeBlogReferences } from '../server/blog-references.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'frameforge-blog-adapter-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.agents', 'jev'), { recursive: true });
  await writeFile(join(home, '.agents', 'jev', 'jev-harness.mjs'), '// Synthetic file; executeImpl is always injected and never executes this file.');
  const cli = join(home, 'synthetic-hermes');
  await writeFile(cli, 'Synthetic CLI marker; never executed.');
  return { home, env: { HERMES_CLI: cli }, noFetch: async () => { throw Error('Tests prohibit network access'); } };
}

const enabled = { profile: 'jeopi', active: true, enabled: true, backends: { api: { configured: true, eligible: true } } };
const routed = { backend: { kind: 'api' }, topK: [{ id: 'source-backed-blog', name: 'Source-backed blog' }] };

for (const row of [
  { name: 'another profile is active', status: { ...enabled, profile: 'jeo' } },
  { name: 'current profile has no API key', status: { ...enabled, backends: { api: { configured: false } } } },
  { name: 'current profile disabled', status: { ...enabled, enabled: false } },
  { name: 'API declared ineligible', status: { ...enabled, backends: { api: { configured: true, eligible: false } } } },
  { name: 'router returned a local fallback', status: enabled, route: { ...routed, backend: { kind: 'local' } } },
  { name: 'router explicitly unavailable', status: enabled, route: { ...routed, unavailable: true } },
]) {
  test(`Jev ${row.name} blocks agent effects without borrowing another profile or backend`, async t => {
    const f = await fixture(t);
    const operations = [];
    let draftEffects = 0;
    const automation = createBlogAutomation({ ...f, bridgeMode: false, fetchImpl: f.noFetch, draftRunner: async () => { draftEffects++; throw Error('Forbidden agent effect'); }, executeImpl: async (_binary, args) => {
      const operation = args.includes('route-skills') && !args.includes('status') ? 'route-skills' : 'status';
      operations.push({ operation, args });
      return { stdout: JSON.stringify(operation === 'status' ? row.status : row.route || routed), stderr: '' };
    } });
    await assert.rejects(automation.route({ summary: 'Write a synthetic source-backed blog draft' }), error => error.status === 503);
    await assert.rejects(automation.draft({ account: {}, workspace: {}, brief: {}, routing: {}, agent: 'hermes' }), error => error.status === 503);
    assert.equal(draftEffects, 0);
    assert.equal(operations.length, row.route ? 2 : 1, 'Only current-profile status and at most one explicit API routing attempt are permitted');
    for (const { args } of operations) {
      assert.equal(args[args.indexOf('--profile') + 1], 'jeopi', 'No other-profile command may be attempted');
      assert.equal(args.some(value => ['enable', 'configure', 'install', 'set-profile'].includes(value)), false);
      if (!args.includes('status')) assert.equal(args[args.indexOf('--backend') + 1], 'api');
    }
  });
}

async function canonicalFixture(t) {
  const f = await fixture(t);
  const root = join(f.home, 'sources');
  const shared = join(root, 'naver-blog-shared');
  const accountRoot = join(root, 'naver-blog-banggujin');
  await mkdir(shared, { recursive: true });
  await mkdir(join(accountRoot, 'persona'), { recursive: true });
  for (const [name, body] of [
    ['aside-publish-guide.md', '# Synthetic rules\nNo publication.'],
    ['category-rotation-policy.json', JSON.stringify({ blogs: { banggujin: { ring: [{ category_no: 7, name: '검증 메뉴' }] } } })],
    ['category-rotation-state.json', JSON.stringify({ blogs: { banggujin: { next: { category_no: 7, category: '검증 메뉴' } } } })],
    ['publish-slot-ledger.json', '{}'],
  ]) await writeFile(join(shared, name), body);
  await writeFile(join(accountRoot, 'LATEST.md'), '# Synthetic current source');
  await writeFile(join(accountRoot, 'persona', 'parkjen-persona.md'), '# Synthetic persona');
  const loadSources = () => loadBlogSources({ root, env: {}, bridgeMode: false, fetchImpl: f.noFetch });
  const loaded = await loadSources();
  const account = loaded.accounts.find(item => item.id === 'naver-banggujin');
  const reference = await analyzeBlogReferences({ account, workspace: loaded.workspace, input: { profileUrl: 'https://in.naver.com/synthetic-author', postUrls: ['https://blog.naver.com/synthetic-author/1234567890'] }, inspectImpl: async (url, { kind }) => ({ url, status: 200, headers: { 'content-type': 'text/html' }, html: kind === 'profile' ? '<section class="hm-component-homeCover-profile-info"><h1>검증 전문 채널</h1><a data-role="fan" data-clickcode="homeCover.fanCount">팬 100,000</a></section><div class="hm-component-activeChannels-item" data-servicetype="NBLOG" data-channelurl="https://blog.naver.com/synthetic-author"><a class="hm-component-activeChannels-link" href="https://blog.naver.com/synthetic-author">공식 블로그</a></div>' : `<meta property="og:type" content="article"><article><h1>검증 메뉴 전문 글</h1><p>${'검증 메뉴의 글쓰기 구조와 실제 관측 근거를 설명하는 문장입니다. '.repeat(8)}</p><h2>핵심</h2><p>${'이미지나 문장을 복사하지 않고 독립적으로 작성해야 하는 이유입니다. '.repeat(8)}</p></article>` }) });
  return { ...f, loaded, loadSources, account, reference };
}

for (const mode of ['missing', 'fabricated', 'verified']) {
  test(`draft evidence ${mode} is checked against actual research before any draft can be returned`, async t => {
    const f = await canonicalFixture(t);
    const sourceUrl = 'https://example.com/research/observed';
    const automation = createBlogAutomation({ ...f, bridgeMode: false, fetchImpl: f.noFetch, executeImpl: async (_binary, args) => ({ stdout: JSON.stringify(args.includes('status') ? enabled : routed) }), draftRunner: async () => ({ title: '검증 제목', body: '검증 근거를 사용한 본문.', sourceEvidence: mode === 'missing' ? [] : [{ url: mode === 'fabricated' ? 'https://example.com/invented' : sourceUrl, title: '관측 기사' }] }) });
    const routing = await automation.route('Write a synthetic blog');
    const draft = () => automation.draft({ account: f.account, workspace: f.loaded.workspace, reference: f.reference, brief: { query: '검증 주제', sourceEvidence: [{ url: sourceUrl, title: '관측 기사' }] }, routing, agent: 'hermes' });
    if (mode === 'verified') {
      const output = await draft();
      assert.equal(output.title, '검증 제목');
      assert.equal(output.body, '검증 근거를 사용한 본문.');
      assert.deepEqual(output.sourceEvidence, [{ url: sourceUrl, title: '관측 기사' }]);
      assert.equal(output.formatReview.status, 'needs-format-review', 'Generation must never claim actual layout or image rights were verified');
    } else await assert.rejects(draft(), error => error.status === 503 && /evidence/i.test(error.message));
  });
}

test('a missing research brief prevents the real agent boundary instead of generating a fallback article', async t => {
  const f = await canonicalFixture(t);
  let effects = 0;
  const automation = createBlogAutomation({ ...f, bridgeMode: false, fetchImpl: f.noFetch, executeImpl: async (_binary, args) => ({ stdout: JSON.stringify(args.includes('status') ? enabled : routed) }), draftRunner: async () => { effects++; throw Error('Missing sources reached agent'); } });
  const routing = await automation.route('Source-backed synthetic blog');
  await assert.rejects(automation.draft({ account: f.account, workspace: f.loaded.workspace, reference: f.reference, brief: {}, routing, agent: 'hermes' }), error => error.status === 503 && /research brief|source URLs/i.test(error.message));
  assert.equal(effects, 0);
});
test('routing receipts from another host process cannot authorize an agent call', async t => {
  const f = await canonicalFixture(t);
  let effects = 0;
  const options = { ...f, bridgeMode: false, fetchImpl: f.noFetch, executeImpl: async (_binary, args) => ({ stdout: JSON.stringify(args.includes('status') ? enabled : routed) }), draftRunner: async () => { effects++; throw Error('Foreign route reached agent'); } };
  const firstHost = createBlogAutomation(options);
  const otherHost = createBlogAutomation(options);
  const routing = await firstHost.route('Source-backed synthetic blog');
  await assert.rejects(otherHost.draft({ account: f.account, workspace: f.loaded.workspace, brief: { sourceEvidence: [{ url: 'https://example.com/research' }] }, routing, agent: 'hermes' }), error => error.status === 503 && /live host|receipt/i.test(error.message));
  assert.equal(effects, 0);
});

test('missing approved Git checkout prevents every process and publication effect', async t => {
  const f = await canonicalFixture(t);
  let effects = 0;
  const automation = createBlogAutomation({ ...f, bridgeMode: false, fetchImpl: f.noFetch, executeImpl: async () => { effects++; throw Error('No Git checkout may reach a process'); } });
  const input = { account: f.loaded.accounts.find(item => item.id === 'github-jellyggumi'), draft: { title: '검증', body: '검증 본문' }, workspace: f.loaded.workspace };
  await assert.rejects(automation.planDeploy(input), error => error.status === 503 && /BLOG_GITHUB_CHECKOUT/.test(error.message));
  await assert.rejects(automation.deploy({ ...input, approval: {}, gitConsent: { approved: true, planHash: 'a'.repeat(64) } }), error => error.status === 503);
  assert.equal(effects, 0);
});
test('real drafting adapter gives the agent the measured plan and current persona rather than generic formatting advice', async t => {
  const f = await canonicalFixture(t);
  const sourceUrl = 'https://example.com/research/measured-plan';
  const expectedBody = [f.account.persona, ...Object.values(f.reference.analysis).flat().map(item => item.guidance)].join('\n\n');
  const automation = createBlogAutomation({ ...f, bridgeMode: false, fetchImpl: f.noFetch,
    executeImpl: async (_binary, args) => ({ stdout: JSON.stringify(args.includes('status') ? enabled : routed) }),
    draftRunner: async ({ blog }) => ({ title: `구조 적용: ${blog.account.menu}`, body: [blog.account.persona, ...Object.values(blog.reference.analysis).flat().map(item => item.guidance)].join('\n\n'), sourceEvidence: [{ url: sourceUrl, title: '관측 근거' }] }),
  });
  const routing = await automation.route('Apply observed formatting to this persona');
  const result = await automation.draft({ account: f.account, workspace: f.loaded.workspace, reference: f.reference, brief: { query: '검증 주제', sourceEvidence: [{ url: sourceUrl }] }, routing, agent: 'hermes' });
  assert.equal(result.title, '구조 적용: 검증 메뉴');
  assert.equal(result.body, expectedBody);
  assert.deepEqual(result.appliedFormattingPlan, f.reference.analysis);
  assert.equal(result.referenceFingerprint, f.reference.fingerprint);
  assert.equal(result.formatReview.status, 'needs-format-review');
});

test('Tistory with a persona, selected menu, eligible reference and research never inherits Naver drafting policy', async t => {
  const f = await canonicalFixture(t);
  const account = { ...f.loaded.accounts.find(item => item.id === 'tistory'), persona: '독립적인 티스토리 작성 규칙', menus: ['검증 메뉴'], menuCursor: 0, nextMenu: { name: '검증 메뉴', categoryNo: null } };
  const reference = await analyzeBlogReferences({ account, workspace: f.loaded.workspace, input: { profileUrl: 'https://in.naver.com/synthetic-author', postUrls: ['https://blog.naver.com/synthetic-author/1234567890'] }, inspectImpl: async (url, { kind }) => ({ url, status: 200, headers: { 'content-type': 'text/html' }, html: kind === 'profile' ? '<section class="hm-component-homeCover-profile-info"><a data-role="fan" data-clickcode="homeCover.fanCount">팬 100,000</a></section><div class="hm-component-activeChannels-item" data-servicetype="NBLOG" data-channelurl="https://blog.naver.com/synthetic-author"><a class="hm-component-activeChannels-link" href="https://blog.naver.com/synthetic-author">공식 블로그</a></div>' : `<meta property="og:type" content="article"><article><h1>검증 메뉴의 독립적인 설명</h1><p>${'검증 메뉴의 정보를 독립적으로 설명하는 충분한 근거 문장입니다. '.repeat(6)}</p><h2>정리</h2><p>${'문장과 이미지를 복사하지 않고 작성할 구조만 참고합니다. '.repeat(6)}</p></article>` }) });
  const sourceUrl = 'https://example.com/research/tistory-policy';
  const effects = [];
  const automation = createBlogAutomation({ ...f, bridgeMode: false,
    executeImpl: async (_binary, args) => { effects.push('process'); return { stdout: JSON.stringify(args.includes('status') ? enabled : routed) }; },
    fetchImpl: async () => { effects.push('network'); throw Error('Tistory policy must block before network'); },
    draftRunner: async () => { effects.push('model'); return { title: '잘못된 타 플랫폼 초안', body: 'Naver 정책이 티스토리에 적용되면 안 됩니다.', sourceEvidence: [{ url: sourceUrl }] }; },
  });
  const routing = await automation.route('Draft Tistory using its own approved canonical policy');
  effects.length = 0;
  await assert.rejects(automation.draft({ account, workspace: f.loaded.workspace, reference, brief: { query: '검증 주제', sourceEvidence: [{ url: sourceUrl, title: '관측 기사' }] }, routing, agent: 'hermes' }), error => error.status === 503 && /platform-specific canonical drafting policy/.test(error.message) && /Manual scratch drafts remain available/.test(error.message));
  assert.deepEqual(effects, []);
});
test('regression: a genuine route A receipt still authorizes drafting after route B succeeds while forged receipts are rejected', async t => {
  const f = await canonicalFixture(t);
  const sourceUrl = 'https://example.com/research/route-a';
  let draftEffects = 0;
  const automation = createBlogAutomation({ ...f, bridgeMode: false, fetchImpl: f.noFetch,
    executeImpl: async (_binary, args) => ({ stdout: JSON.stringify(args.includes('status') ? enabled : routed) }),
    draftRunner: async () => {
      draftEffects++;
      return { title: '경로 A의 검증 초안', body: '경로 A의 관측 근거를 사용한 본문.', sourceEvidence: [{ url: sourceUrl, title: '경로 A 근거' }] };
    },
  });
  const routeA = await automation.route('Route A: write the first source-backed draft');
  const routeB = await automation.route('Route B: write a separate source-backed draft');
  assert.equal(routeA.status, 'exercised');
  assert.equal(routeB.status, 'exercised');
  assert.notEqual(routeA.receipt, routeB.receipt);
  const input = { account: f.account, workspace: f.loaded.workspace, reference: f.reference, brief: { query: '경로 A 검증', sourceEvidence: [{ url: sourceUrl }] }, agent: 'hermes' };
  await assert.rejects(automation.draft({ ...input, routing: { ...routeA, receipt: '0'.repeat(64) } }), error => error.status === 503 && /live host|receipt/i.test(error.message));
  assert.equal(draftEffects, 0, 'A forged receipt must never reach the writer');
  const result = await automation.draft({ ...input, routing: routeA });
  assert.equal(result.title, '경로 A의 검증 초안');
  assert.equal(result.body, '경로 A의 관측 근거를 사용한 본문.');
  assert.deepEqual(result.sourceEvidence, [{ url: sourceUrl, title: '경로 A 근거' }]);
  assert.equal(draftEffects, 1);
});

for (const row of [
  { name: 'effective selected menu and numeric category override canonical nextMenu', menus: ['검증 메뉴', '선택 메뉴'], menuCursor: 0, nextMenu: { name: '선택 메뉴', categoryNo: 42 }, expected: { menu: '선택 메뉴', categoryNo: 42 } },
  { name: 'unmapped local menu never borrows a canonical category number', menus: ['로컬 메뉴'], menuCursor: 0, nextMenu: { name: '로컬 메뉴', categoryNo: null }, expected: { menu: '로컬 메뉴', categoryNo: null } },
]) {
  test(`regression: writer receives ${row.name}`, async t => {
    const f = await canonicalFixture(t);
    const account = { ...f.account, menus: row.menus, menuCursor: row.menuCursor, nextMenu: row.nextMenu };
    const reference = await analyzeBlogReferences({ account, workspace: f.loaded.workspace,
      input: { profileUrl: 'https://in.naver.com/synthetic-author', postUrls: ['https://blog.naver.com/synthetic-author/1234567890'] },
      inspectImpl: async (url, { kind }) => ({ url, status: 200, headers: { 'content-type': 'text/html' }, html: kind === 'profile'
        ? '<section class="hm-component-homeCover-profile-info"><h1>검증 전문 채널</h1><a data-role="fan" data-clickcode="homeCover.fanCount">팬 100,000</a></section><div class="hm-component-activeChannels-item" data-servicetype="NBLOG" data-channelurl="https://blog.naver.com/synthetic-author"><a class="hm-component-activeChannels-link" href="https://blog.naver.com/synthetic-author">공식 블로그</a></div>'
        : `<meta property="og:type" content="article"><article><h1>${row.nextMenu.name} 전문 글</h1><p>${`${row.nextMenu.name}의 글쓰기 구조와 실제 관측 근거를 설명하는 문장입니다. `.repeat(8)}</p><h2>핵심</h2><p>${'이미지나 문장을 복사하지 않고 독립적으로 작성해야 하는 이유입니다. '.repeat(8)}</p></article>` }),
    });
    const sourceUrl = 'https://example.com/research/effective-menu';
    let writerInput;
    const automation = createBlogAutomation({ ...f, bridgeMode: false, fetchImpl: f.noFetch,
      executeImpl: async (_binary, args) => ({ stdout: JSON.stringify(args.includes('status') ? enabled : routed) }),
      draftRunner: async input => {
        writerInput = input;
        return { title: '선택 메뉴 검증 초안', body: '선택 메뉴의 관측 근거를 사용한 본문.', sourceEvidence: [{ url: sourceUrl }] };
      },
    });
    const routing = await automation.route(`Draft for ${row.nextMenu.name}`);
    const result = await automation.draft({ account, workspace: f.loaded.workspace, reference, brief: { query: row.nextMenu.name, sourceEvidence: [{ url: sourceUrl }] }, routing, agent: 'hermes' });
    assert.equal(result.body, '선택 메뉴의 관측 근거를 사용한 본문.');
    assert.deepEqual({ menu: writerInput.blog.account.menu, categoryNo: writerInput.blog.account.categoryNo }, row.expected);
  });
}
