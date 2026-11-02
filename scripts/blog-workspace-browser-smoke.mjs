/** Real browser + isolated local HTTP API. All records below are synthetic.
 * No source workspace, provider, login script, scheduler tick or publisher is accessed.
 * Evidence (including failed screenshots/traces) is retained under the OS temp directory.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';
import { HttpError } from '../server/validation.mjs';
import { candidateFingerprint } from '../server/graph.mjs';

const IDS = ['naver-banggujin', 'naver-jelly_ggumi', 'naver-jennie_p', 'tistory', 'github-jellyggumi'];
const LONG_ACCOUNT_LABEL = '한국어 장문 계정 이름과 독립적인 편집 기준을 함께 확인하는 블로그 운영 계정 '.repeat(3).trim();
const LONG_ARTICLE_TITLE = '한국어 장문 제목에서도 저장된 초안 선택과 전체 본문 검토를 잃지 않는 편집 흐름 '.repeat(5).trim();
const out = await mkdtemp(join(tmpdir(), 'frameforge-blog-browser-evidence-'));
const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-blog-browser-data-'));
const receipt = { scope: 'Synthetic isolated blog workspace only; no external effects', checks: [], errors: [], blockedRequests: [], forbiddenEffects: [], geometry: [], readability: [], theme: [], screenshots: [], result: 'FAIL' };
console.log(`Browser evidence: ${out}`);
const check = (name, condition, detail) => { assert.ok(condition, JSON.stringify({ name, detail })); receipt.checks.push(name); };
const readable = async (label, selectors) => {
  const results = await page.evaluate(selectors => {
    const rgba = color => { const values = color.match(/[\d.]+/g).map(Number); return [...values.slice(0, 3), values[3] ?? 1]; };
    const over = (front, back) => { const alpha = front[3] + back[3] * (1 - front[3]); return alpha ? [...front.slice(0, 3).map((value, index) => (value * front[3] + back[index] * back[3] * (1 - front[3])) / alpha), alpha] : [0, 0, 0, 0]; };
    const luminance = color => color.slice(0, 3).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    return selectors.map(selector => {
      const element = document.querySelector(selector);
      let foreground = rgba(getComputedStyle(element).color), background = [0, 0, 0, 0];
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node), fill = rgba(style.backgroundColor);
        foreground = over(foreground, fill); background = over(background, fill);
        foreground[3] *= Number(style.opacity); background[3] *= Number(style.opacity);
      }
      const text = luminance(over(foreground, [255, 255, 255, 1])), surface = luminance(over(background, [255, 255, 255, 1]));
      return { selector, text: element.textContent.trim(), visible: element.getClientRects().length > 0, ratio: (Math.max(text, surface) + .05) / (Math.min(text, surface) + .05) };
    });
  }, selectors);
  receipt.readability.push({ label, results });
  check(`${label} is visible and readable including inherited opacity`, results.every(item => item.visible && item.ratio >= 4.5), results);
};
const sharedTheme = async () => {
  const comparisons = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement), canvas = document.createElement('canvas').getContext('2d');
    const color = value => { canvas.fillStyle = value; return canvas.fillStyle; };
    return [['body', 'backgroundColor', '--canvas'], ['#blog-editor', 'backgroundColor', '--surface'], ['#blog-body', 'backgroundColor', '--surface-input'], ['#blog-body', 'color', '--ink'], ['#blog-draft-form button[type=submit]', 'backgroundColor', '--accent'], ['#blog-draft-form button[type=submit]', 'color', '--on-accent']].map(([selector, property, token]) => ({ selector, property, actual: color(getComputedStyle(document.querySelector(selector))[property]), expected: color(root.getPropertyValue(token).trim()) }));
  });
  receipt.theme.push(...comparisons);
  check('rendered blog surfaces and editor actions match the shared editor theme', comparisons.every(item => item.actual === item.expected), comparisons);
  check('blog editor inherits the shared Korean font stack', await page.locator('#blog-body').evaluate(element => getComputedStyle(element).fontFamily === getComputedStyle(document.documentElement).fontFamily));
};
const forbid = name => async () => { receipt.forbiddenEffects.push(name); throw Error(`Browser smoke prohibits ${name}`); };
let sourceVersion = 'synthetic-browser-source-v1';
let researchFailure = false;
let referenceFans = '10,000';
const app = createApp({ dataDir, loginToken: '', publicOrigin: '',
  integrations: { integrationStatus: async () => ({}), runAgent: forbid('non-blog-agent'), fetchTrends: forbid('non-blog-news') },
  speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbid('speech') },
  generation: { capability: async () => ({ available: false }), models: async () => [], modelSchema: forbid('model-schema'), submit: forbid('model-submit'), status: forbid('model-status') },
  renderer: forbid('render'),
  blogOptions: {
    now: () => new Date('2026-10-25T00:00:00Z'),
    loadSources: async () => ({ workspace: { version: sourceVersion, latest: false, sourceRoots: ['synthetic'], sourceEvidence: [{ id: 'synthetic/LATEST.md', status: 'loaded', sha256: sourceVersion, bytes: 37 }], refreshedAt: '2026-10-25T00:00:00Z', blockedReasons: [`${IDS[1]}: Canonical persona metadata is missing.`] },
      accounts: IDS.map((id, index) => ({ id, accountId: index < 3 ? id.slice(6) : index === 3 ? 'synthetic-fixture' : 'jellyggumi', label: index === 0 ? LONG_ACCOUNT_LABEL : `격리 테스트 계정 ${index + 1}`, persona: index === 1 ? '' : `페르소나 ${index + 1}`, metadataRequirements: index === 1 ? [{ field: 'persona', detail: 'Canonical persona metadata is missing.' }] : [], keywords: [`검증 키워드 ${index + 1}`], menus: ['첫 메뉴', '다음 메뉴'], publicUrl: index < 3 ? `https://blog.naver.com/${id.slice(6)}` : index === 3 ? 'https://synthetic-fixture.tistory.com/' : 'https://jellyggumi.github.io/', editorUrl: `https://example.com/editor/${id}`, sourceEvidence: [] })) }),
    automation: { status: () => ({ agents: [{ id: 'hermes', name: 'Hermes', label: 'Hermes', available: true, status: 'available', detail: 'Synthetic transport only' }], routing: { profile: 'jeopi', backend: 'api', status: 'available', detail: 'Synthetic transport only' } }), route: forbid('routing'), draft: forbid('agent-draft'), login: forbid('platform-login'), deploy: forbid('publication'), planDeploy: async ({ draft, workspace }) => ({ repository: 'https://github.com/jellyggumi/synthetic-browser-blog', branch: 'test-only', files: ['posts/synthetic-browser.md'], effects: ['commit', 'push', 'public-pages-update'], artifactSha256: 'a'.repeat(64), contentHash: candidateFingerprint({ title: draft.title, body: draft.body }), workspaceVersion: workspace.version, planHash: 'a'.repeat(64) }) },
    referenceOptions: { inspectImpl: async (url, { kind }) => ({ url, status: 200, headers: { 'content-type': 'text/html' }, html: kind === 'profile' ? `<section class="hm-component-homeCover-profile-info"><h1>테스트 전문 채널</h1><a data-role="fan" data-clickcode="homeCover.fanCount">팬 ${referenceFans}</a></section><div class="hm-component-activeChannels-item" data-servicetype="NBLOG" data-channelurl="https://blog.naver.com/synthetic-author"><a class="hm-component-activeChannels-link" href="https://blog.naver.com/synthetic-author">공식 블로그</a></div>` : `<meta property="og:type" content="article"><article><h1>첫 메뉴 다음 메뉴 테스트 전문 글</h1><p>${'첫 메뉴 다음 메뉴 검증 키워드를 바탕으로 독립적인 설명 구조를 관찰합니다. '.repeat(8)}</p><h2>핵심</h2><p>${'이미지는 권리를 확인하여 독립적으로 만들고 문장을 복사하지 않습니다. '.repeat(8)}</p><img src="https://blogfiles.pstatic.net/synthetic/reference.jpg" width="1200" height="800"><h2>정리</h2><p>${'출처를 검증하고 독자에게 필요한 요점을 정리하는 마지막 문단입니다. '.repeat(6)}</p></article>` }) },
    research: async ({ query }) => { if (researchFailure) throw new HttpError(503, '격리 뉴스 서버 연결 실패'); return { trends: [{ keyword: query, title: '검증한 뉴스 응답 제목', source: '격리 뉴스', url: 'https://example.com/news/browser-evidence' }], sources: [{ name: '격리 뉴스', status: 'ok' }] }; },
  },
});
let browser;
let context;
let page;
const mutations = [];
let releaseInitialState;
const initialStateGate = new Promise(resolve => { releaseInitialState = resolve; });
let interceptInitialState = true;
try {
  let playwright;
  if (process.env.BLOG_PLAYWRIGHT_MODULE) playwright = await import(pathToFileURL(process.env.BLOG_PLAYWRIGHT_MODULE));
  else { try { playwright = await import('playwright'); } catch { playwright = await import(pathToFileURL(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'))); } }
  const { chromium } = playwright;
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const api = async () => { const response = await fetch(base + '/api/blog/state'); assert.equal(response.status, 200); return response.json(); };
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) { receipt.blockedRequests.push(request.url()); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) mutations.push(`${request.method()} ${url.pathname}`);
    if (request.method() === 'GET' && url.pathname === '/api/blog/state' && interceptInitialState) {
      interceptInitialState = false;
      await initialStateGate;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '격리된 초기 상태 연결 실패' }) });
    }
    if (!['GET', 'HEAD'].includes(request.method()) && !(
      (request.method() === 'POST' && url.pathname === '/api/blog/refresh') ||
      (request.method() === 'PUT' && IDS.some(id => url.pathname === `/api/blog/accounts/${id}` || url.pathname === `/api/blog/accounts/${id}/schedule`)) ||
      (request.method() === 'POST' && IDS.some(id => url.pathname === `/api/blog/accounts/${id}/drafts` || url.pathname === `/api/blog/accounts/${id}/research` || url.pathname === `/api/blog/accounts/${id}/references`)) ||
      (request.method() === 'PUT' && /^\/api\/blog\/drafts\/[^/]+$/.test(url.pathname)) ||
      (request.method() === 'POST' && /^\/api\/blog\/drafts\/[^/]+\/(approval|deploy-plan)$/.test(url.pathname))
    )) { receipt.forbiddenEffects.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    return route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => receipt.errors.push(error.message));
  const beforeOpening = await api();
  const initialStateRequested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/blog/state');
  await page.goto(base + '/blog.html', { waitUntil: 'commit' });
  await initialStateRequested;
  await page.locator('#blog-notice').filter({ hasText: '운영 상태를 불러오는 중' }).waitFor();
  check('pending initial load cannot refresh or publish', await page.locator('#blog-retry').isDisabled() && await page.locator('#blog-refresh').isDisabled() && await page.locator('#blog-deploy-button').isDisabled());
  await readable('loading status', ['#blog-notice']);
  releaseInitialState();
  await page.locator('#blog-empty').waitFor({ state: 'visible' });
  await page.locator('#blog-notice').filter({ hasText: '격리된 초기 상태 연결 실패' }).waitFor();
  await readable('failed initial load and recovery instructions', ['#blog-notice', '#blog-empty']);
  await page.locator('#blog-retry').focus();
  await page.keyboard.press('Enter');
  await page.locator('#blog-account-tabs [role=tab]').first().waitFor();
  check('keyboard retry recovers the actual account panel', await page.locator('#blog-account-panel').isVisible() && !(await page.locator('#blog-empty').isVisible()));
  check('opening and retrying the blog never mutates persisted editorial state', mutations.length === 0 && JSON.stringify(await api()) === JSON.stringify(beforeOpening));
  await page.locator('#blog-refresh').click();
  await page.waitForFunction(() => !document.querySelector('#blog-refresh').disabled);
  await page.locator('#blog-account-tabs [role=tab]').first().waitFor();
  check('five real account tabs are rendered', await page.getByRole('tab').count() === IDS.length);
  const tabs = page.getByRole('tab');
  for (const id of IDS) {
    await page.locator(`[role=tab][data-account-id="${id}"]`).click();
    check(`account tab selects isolated identity ${id}`, await page.locator(`[role=tab][data-account-id="${id}"]`).getAttribute('aria-selected') === 'true');
  }
  await page.locator(`[role=tab][data-account-id="${IDS[0]}"]`).click();
  await sharedTheme();
  check('long Korean account labels retain their full accessible content', await page.locator('#blog-account-name').innerText() === LONG_ACCOUNT_LABEL);
  await readable('empty research and blocked publication guidance', ['#blog-research-result .hint', '#blog-approval-state', '#blog-create-draft', '#blog-deploy-button']);
  await page.locator('.blog-config summary').click();
  const saveResponse = (path, method) => page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
  const analyzeCurrent = async id => {
    await page.locator('#blog-reference-profile').fill('https://in.naver.com/synthetic-author');
    await page.locator('#blog-reference-posts').fill('https://blog.naver.com/synthetic-author/1234567890');
    const analyzed = saveResponse(`/api/blog/accounts/${id}/references`, 'POST');
    await page.locator('#blog-analyze-reference').click();
    const response = await analyzed;
    assert.equal(response.status(), 200);
    const reference = (await response.json()).reference;
    await page.waitForFunction(() => document.querySelector('#blog-account-panel').getAttribute('aria-busy') === 'false');
    return reference;
  };
  await page.locator(`[role=tab][data-account-id="${IDS[1]}"]`).click();
  await page.locator('#blog-reference-profile').fill('https://in.naver.com/synthetic-author');
  await page.locator('#blog-reference-posts').fill('https://blog.naver.com/synthetic-author/1234567890');
  const prerequisiteResponse = saveResponse(`/api/blog/accounts/${IDS[1]}/references`, 'POST');
  await page.locator('#blog-analyze-reference').click();
  const prerequisite = await prerequisiteResponse;
  assert.equal(prerequisite.status(), 503);
  check('unresolved source persona blocks analysis and automatic drafting', /persona.*selected category/.test((await prerequisite.json()).error) && await page.locator('#blog-create-draft').isDisabled());
  if (!(await page.locator('#blog-persona').isVisible())) await page.locator('.blog-config summary').click();
  await page.locator('#blog-persona').fill('명시적으로 저장한 독립 작성자 규칙');
  const overrideSaved = saveResponse(`/api/blog/accounts/${IDS[1]}`, 'PUT');
  await page.locator('#blog-config-form button[type=submit]').click();
  assert.equal((await overrideSaved).status(), 200);
  await analyzeCurrent(IDS[1]);
  check('explicit metadata override resolves only its exact source prerequisite without hiding warnings', await page.locator('#blog-create-draft').isEnabled() && (await page.locator('#blog-blocked-reasons').innerText()).includes('Canonical persona metadata is missing.'));
  await page.locator(`[role=tab][data-account-id="${IDS[0]}"]`).click();
  check('unverified references block automatic writing before any agent effect', await page.locator('#blog-create-draft').isDisabled());
  check('reference stage precedes research and editor in keyboard/document order', await page.locator('#blog-reference').evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector('#blog-research')) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(element.compareDocumentPosition(document.querySelector('#blog-editor')) & Node.DOCUMENT_POSITION_FOLLOWING)));
  const firstReference = await analyzeCurrent(IDS[0]);
  const referenceTimeText = await page.evaluate(value => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), firstReference.metricEvidence.observedAt);
  await page.waitForFunction(expected => document.querySelector('#blog-reference-result').textContent.includes(expected), referenceTimeText);
  check('actual reference analysis presents the exact 10,000 metric and source timestamp without copying images', firstReference.metricEvidence.count === 10000 && (await page.locator('#blog-reference-result').innerText()).includes(referenceTimeText) && await page.locator('#blog-reference-result img').count() === 0);
  check('exact displayed metric is not mislabeled as a rounded lower bound', firstReference.metricEvidence.precision === 'exact-displayed' && !(await page.locator('#blog-reference-result').innerText()).includes('표시 반올림 하한'));
  await page.locator(`[role=tab][data-account-id="${IDS[2]}"]`).click();
  await page.locator('#blog-title').fill('레퍼런스 없는 수동 메모');
  await page.locator('#blog-body').fill('레퍼런스 분석 전에도 로컬 메모는 보존하되 게시할 수 없습니다.');
  const scratchSaved = saveResponse(`/api/blog/accounts/${IDS[2]}/drafts`, 'POST');
  await page.locator('#blog-draft-form button[type=submit]').click();
  assert.equal((await scratchSaved).status(), 201);
  await page.locator('#blog-preview-button').click();
  check('manual scratch can persist but cannot approve or publish without eligible reference', await page.locator('#blog-approve-button').isDisabled() && await page.locator('#blog-deploy-button').isDisabled());
  referenceFans = '17.8만+';
  const rounded = await analyzeCurrent(IDS[2]);
  await page.waitForFunction(() => document.querySelector('#blog-reference-result').textContent.includes('178,000 이상'));
  check('explicit rounded audience is honestly labeled a lower bound, not an exact count', rounded.metricEvidence.count === 178000 && rounded.metricEvidence.precision === 'displayed-lower-bound' && (await page.locator('#blog-reference-result').innerText()).includes('표시 반올림 하한'));
  referenceFans = '10,000';
  await page.locator(`[role=tab][data-account-id="${IDS[0]}"]`).click();
  await page.locator('#blog-query').fill('브라우저 실제 조사 키워드');
  const researched = saveResponse(`/api/blog/accounts/${IDS[0]}/research`, 'POST');
  await page.locator('#blog-research-form button[type=submit]').click();
  const researchResponse = await researched;
  assert.equal(researchResponse.status(), 200);
  const researchBrief = (await researchResponse.json()).brief;
  check('research form retains actual query and source link from server evidence', researchBrief.query === '브라우저 실제 조사 키워드' && await page.locator('#blog-research-result a[href="https://example.com/news/browser-evidence"]').count() > 0);
  await page.getByLabel('페르소나 / 글쓰기 규칙').fill('브라우저에서 저장한 고유 페르소나');
  const configSaved = saveResponse(`/api/blog/accounts/${IDS[0]}`, 'PUT');
  await page.locator('#blog-config-form button[type=submit]').click();
  assert.equal((await configSaved).status(), 200);
  await analyzeCurrent(IDS[0]);
  await page.locator('#blog-title').fill('페르소나 변경 뒤 수동 저장');
  await page.locator('#blog-body').fill('이전 리서치 버전이 남아 있어도 수동 본문은 새 현재 버전으로 저장합니다.');
  const afterPersonaSaved = saveResponse(`/api/blog/accounts/${IDS[0]}/drafts`, 'POST');
  await page.locator('#blog-draft-form button[type=submit]').click();
  check('stale research does not block explicit manual save after persona edit', (await afterPersonaSaved).status() === 201);
  await page.reload();
  await page.locator('[role=tab][aria-selected=true]').waitFor();
  if (!(await page.locator('#blog-persona').isVisible())) await page.locator('.blog-config summary').click();
  check('explicit account save survives browser reload', await page.locator('#blog-persona').inputValue() === '브라우저에서 저장한 고유 페르소나');
  await page.getByLabel('제목', { exact: true }).fill(LONG_ARTICLE_TITLE);
  const body = '첫 줄부터 마지막 줄까지 검토하는 본문입니다.\n<script>문자열이지 실행 코드가 아닙니다.</script>\n마지막 줄: 승인 경계 확인.';
  await page.getByLabel('전체 본문', { exact: true }).fill(body);
  const createdResponse = saveResponse(`/api/blog/accounts/${IDS[0]}/drafts`, 'POST');
  await page.locator('#blog-draft-form button[type=submit]').focus();
  await page.keyboard.press('Enter');
  const created = await createdResponse;
  assert.equal(created.status(), 201);
  const { draft } = await created.json();
  await page.reload();
  await page.locator('#blog-draft-select').selectOption(draft.id);
  check('manual draft title and exact multiline body persist after reload', await page.locator('#blog-title').inputValue() === draft.title && await page.locator('#blog-body').inputValue() === body);
  await page.locator('#blog-body').fill(body + '\n계정 A의 미저장 변경.');
  await page.locator(`[role=tab][data-account-id="${IDS[1]}"]`).click();
  check('account A unsaved text never leaks into account B', !(await page.locator('#blog-body').inputValue()).includes('계정 A의 미저장 변경'));
  await page.locator('#blog-title').fill('계정 B의 미저장 제목');
  await page.locator(`[role=tab][data-account-id="${IDS[0]}"]`).click();
  check('tab round trip preserves account A unsaved edits without autosave', await page.locator('#blog-body').inputValue() === body + '\n계정 A의 미저장 변경.' && (await api()).drafts.find(item => item.id === draft.id).body === body);
  await page.locator('#blog-body').fill(body);
  await page.locator('#blog-preview-button').click();
  check('preview shows full exact body as inert text', await page.locator('#blog-preview-body').innerText() === body && await page.locator('#blog-preview-body script').count() === 0);
  await page.locator('#blog-approve-check').check();
  check('body consent does not replace formatting and image-placement plan review', await page.locator('#blog-approve-button').isDisabled());
  check('preview exposes exact applied formatting plan for explicit review', JSON.stringify(JSON.parse(await page.locator('#blog-preview-plan').innerText())) === JSON.stringify(draft.appliedFormattingPlan));
  await page.locator('#blog-format-check').check();
  const approvedResponse = saveResponse(`/api/blog/drafts/${draft.id}/approval`, 'POST');
  await page.locator('#blog-approve-button').click();
  assert.equal((await approvedResponse).status(), 200);
  await page.locator('#blog-deploy-button').waitFor({ state: 'visible' });
  check('exact reviewed version enables separate deployment control', await page.locator('#blog-deploy-button').isEnabled());
  await page.locator('#blog-body').fill(body + '\n승인 후 편집.');
  check('one-character-or-more edit invalidates preview approval immediately', await page.locator('#blog-deploy-button').isDisabled() && await page.locator('#blog-approve-button').isDisabled());
  check('editing clears explicit body and formatting checkboxes, not only disabled buttons', !(await page.locator('#blog-approve-check').isChecked()) && !(await page.locator('#blog-format-check').isChecked()));
  await page.locator('#blog-body').fill(body);
  const reviewCurrent = async () => {
    await page.locator('#blog-preview-button').click();
    await page.locator('#blog-approve-check').check();
    await page.locator('#blog-format-check').check();
    const reviewed = saveResponse(`/api/blog/drafts/${draft.id}/approval`, 'POST');
    await page.locator('#blog-approve-button').click();
    assert.equal((await reviewed).status(), 200);
    check('fresh exact review re-enables deployment for the next independent invalidation scenario', await page.locator('#blog-deploy-button').isEnabled());
  };
  await reviewCurrent();
  const replacementAccount = (await api()).accounts.find(item => item.id === IDS[0]);
  const replacement = await context.request.post(`${base}/api/blog/accounts/${IDS[0]}/references`, { data: { expectedVersion: replacementAccount.version, profileUrl: 'https://in.naver.com/synthetic-author', postUrls: ['https://blog.naver.com/synthetic-author/1234567890'] } });
  assert.equal(replacement.status(), 200);
  const replacementLoaded = saveResponse('/api/blog/refresh', 'POST');
  await page.locator('#blog-refresh').click();
  assert.equal((await replacementLoaded).status(), 200);
  check('reference replacement clears body and formatting review plus deployment authority', await page.locator('#blog-deploy-button').isDisabled() && !(await page.locator('#blog-approve-check').isChecked()) && !(await page.locator('#blog-format-check').isChecked()));
  const reattached = saveResponse(`/api/blog/drafts/${draft.id}`, 'PUT');
  await page.locator('#blog-draft-form button[type=submit]').click();
  assert.equal((await reattached).status(), 200);
  await reviewCurrent();
  sourceVersion = 'synthetic-browser-source-v2';
  const refreshed = saveResponse('/api/blog/refresh', 'POST');
  await page.locator('#blog-refresh').click();
  assert.equal((await refreshed).status(), 200);
  check('changed canonical sources cannot reuse preview approval', await page.locator('#blog-deploy-button').isDisabled());
  const scheduledReference = await analyzeCurrent(IDS[0]);
  await page.locator('#blog-cron').fill('15 10 * * 1-5');
  await page.locator('#blog-schedule-agent').selectOption('hermes');
  await page.locator('#blog-schedule-enabled').check();
  const scheduleSaved = saveResponse(`/api/blog/accounts/${IDS[0]}/schedule`, 'PUT');
  await page.locator('#blog-schedule-form button[type=submit]').click();
  assert.equal((await scheduleSaved).status(), 200);
  const schedule = (await api()).schedules.find(item => item.accountId === IDS[0]);
  check('explicit schedule form saves account-specific Seoul cron without executing it', schedule.cron === '15 10 * * 1-5' && schedule.timezone === 'Asia/Seoul' && schedule.enabled === true && receipt.forbiddenEffects.length === 0);
  const currentAfterSchedule = (await api()).references.find(item => item.id === scheduledReference.id);
  check('enabling a schedule preserves the current semantic reference without reanalysis', currentAfterSchedule?.current === true && (await page.locator('#blog-reference-status').innerText()).includes('1만+ 공개 팬/이웃 · 분야·대표글 측정 검증됨') && await page.locator('#blog-create-draft').isEnabled());
  researchFailure = true;
  await page.locator('#blog-query').fill('실패 경로를 확인하는 실제 요청');
  const failedResearch = saveResponse(`/api/blog/accounts/${IDS[0]}/research`, 'POST');
  await page.locator('#blog-research-form button[type=submit]').click();
  assert.equal((await failedResearch).status(), 503);
  await page.getByRole('status').filter({ hasText: '격리 뉴스 서버 연결 실패' }).waitFor();
  check('server failure is visible and announced instead of fabricated research', (await page.locator('#blog-notice').innerText()).includes('격리 뉴스 서버 연결 실패'));
  await readable('announced research failure', ['#blog-notice']);
  await page.locator(`[role=tab][data-account-id="${IDS[4]}"]`).click();
  await analyzeCurrent(IDS[4]);
  await page.locator('#blog-title').fill('Git 별도 동의 검증');
  await page.locator('#blog-body').fill('실제 커밋이나 푸시를 실행하지 않는 브라우저 검증입니다.');
  const githubSaved = saveResponse(`/api/blog/accounts/${IDS[4]}/drafts`, 'POST');
  await page.locator('#blog-draft-form button[type=submit]').click();
  const githubResponse = await githubSaved;
  assert.equal(githubResponse.status(), 201);
  const githubDraft = (await githubResponse.json()).draft;
  await page.locator('#blog-preview-button').click();
  await page.locator('#blog-approve-check').check();
  await page.locator('#blog-format-check').check();
  const githubApproved = saveResponse(`/api/blog/drafts/${githubDraft.id}/approval`, 'POST');
  await page.locator('#blog-approve-button').click();
  assert.equal((await githubApproved).status(), 200);
  check('body approval alone does not authorize Git publication', await page.locator('#blog-deploy-button').isDisabled());
  const githubPlanned = saveResponse(`/api/blog/drafts/${githubDraft.id}/deploy-plan`, 'POST');
  await page.locator('#blog-git-plan-button').click();
  assert.equal((await githubPlanned).status(), 200);
  check('Git plan exposes exact repository, branch, files, and artifact before separate consent', (await page.locator('#blog-git-proposal').innerText()).includes('https://github.com/jellyggumi/synthetic-browser-blog') && (await page.locator('#blog-git-proposal').innerText()).includes('posts/synthetic-browser.md') && (await page.locator('#blog-git-proposal').innerText()).includes('a'.repeat(64)) && await page.locator('#blog-deploy-button').isDisabled());
  check('Git plan includes exact branch and separate effects before consent', (await page.locator('#blog-git-proposal').innerText()).includes('test-only') && (await page.locator('#blog-git-proposal').innerText()).includes('push'));
  await page.locator('#blog-git-consent').check();
  check('separate exact-plan Git consent enables deployment without executing it', await page.locator('#blog-deploy-button').isEnabled());
  await page.locator('#blog-git-consent').uncheck();
  check('withdrawing Git consent blocks deployment again', await page.locator('#blog-deploy-button').isDisabled());
  await page.locator('#blog-git-consent').check();
  await page.locator('#blog-body').fill('편집으로 이전 Git 제안 동의를 무효화합니다.');
  check('content edits clear Git consent as well as body approval', await page.locator('#blog-deploy-button').isDisabled() && !(await page.locator('#blog-git-consent').isChecked()));
  referenceFans = '9,999';
  const retainedBody = await page.locator('#blog-body').inputValue();
  const rejectedReference = saveResponse(`/api/blog/accounts/${IDS[4]}/references`, 'POST');
  await page.locator('#blog-analyze-reference').click();
  const rejected = await rejectedReference;
  assert.equal(rejected.status(), 422);
  const rejectedError = (await rejected.json()).error;
  await page.getByRole('status').filter({ hasText: rejectedError }).waitFor();
  check('ineligible reference analysis surfaces error while preserving unsaved draft', (await page.locator('#blog-notice').innerText()).includes(rejectedError) && await page.locator('#blog-body').inputValue() === retainedBody);
  await page.locator(`[role=tab][data-account-id="${IDS[1]}"]`).click();
  check('reference failure from Git account is not presented as another account failure', !(await page.locator('#blog-notice').innerText()).includes(rejectedError));
  await page.locator(`[role=tab][data-account-id="${IDS[4]}"]`).click();
  check('account switch after failed analysis preserves the exact unsaved Git draft', await page.locator('#blog-body').inputValue() === retainedBody);
  referenceFans = '10,000';
  const beforeNavigation = await api(), mutationsBeforeNavigation = mutations.length;
  for (const width of [1440, 375, 320, 1024, 1600, 390, 430]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const viewportFile = join(out, `blog-${width}-viewport.png`);
    await page.screenshot({ path: viewportFile });
    receipt.screenshots.push(viewportFile);
    for (const id of IDS) {
      const tab = page.locator(`[role=tab][data-account-id="${id}"]`);
      await tab.focus();
      await page.keyboard.press('Enter');
      check(`${width}px keyboard activates ${id}`, await tab.getAttribute('aria-selected') === 'true');
      check(`${width}px navigation cannot grant approval or publication authority for ${id}`, await page.locator('#blog-approve-button').isDisabled() && await page.locator('#blog-deploy-button').isDisabled());
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      receipt.geometry.push({ width, id, ...geometry });
      check(`${width}px ${id} has no document overflow`, geometry.scroll <= geometry.viewport + 1 && geometry.body <= geometry.viewport + 1, geometry);
    }
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    check(`${width}px tabs support roving keyboard focus and selection`, await page.locator(`[role=tab][data-account-id="${IDS[1]}"]`).evaluate(element => element === document.activeElement && element.getAttribute('aria-selected') === 'true'));
    const focus = await page.locator(`[role=tab][data-account-id="${IDS[1]}"]`).evaluate(element => { const style = getComputedStyle(element); return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth), color: style.outlineColor }; });
    check(`${width}px keyboard tab selection has a visible focus outline`, focus.style !== 'none' && focus.width >= 1 && focus.color !== 'transparent' && focus.color !== 'rgba(0, 0, 0, 0)', focus);
    await page.keyboard.press('Tab');
    check(`${width}px Tab leaves the account tablist for its associated panel`, await page.locator('#blog-account-panel').evaluate(element => element === document.activeElement));
    const contrasts = await page.evaluate(() => {
      const luminance = color => { const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722; };
      return ['#blog-body', '#blog-draft-form button[type=submit]'].map(selector => { const style = getComputedStyle(document.querySelector(selector)); const text = luminance(style.color), background = luminance(style.backgroundColor); return { selector, ratio: (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05), foreground: style.color, background: style.backgroundColor }; });
    });
    check(`${width}px editor and primary action text meet AA contrast`, contrasts.every(item => item.ratio >= 4.5), contrasts);
    await page.locator(`[role=tab][data-account-id="${IDS[0]}"]`).click();
    await page.locator('#blog-draft-select').selectOption(draft.id);
    check(`${width}px long Korean draft label still selects the exact persisted article`, await page.locator('#blog-title').inputValue() === LONG_ARTICLE_TITLE && (await page.locator('#blog-draft-select option:checked').innerText()).includes(LONG_ARTICLE_TITLE));
    await page.locator('.blog-stages a[href="#blog-research"]').focus();
    await page.keyboard.press('Enter');
    if (!(await page.locator('#blog-persona').isVisible())) {
      await page.locator('.blog-config summary').focus();
      await page.keyboard.press('Enter');
    }
    for (const selector of ['#blog-platform-login', '#blog-persona', '#blog-config-form button[type=submit]', '#blog-reference-profile', '#blog-analyze-reference', '#blog-query', '#blog-research-form button[type=submit]', '#blog-draft-select', '#blog-title', '#blog-body', '#blog-draft-form button[type=submit]', '#blog-preview-button', '#blog-cron', '#blog-schedule-agent', '#blog-schedule-enabled', '#blog-schedule-form button[type=submit]']) {
      const control = page.locator(selector);
      await control.scrollIntoViewIfNeeded();
      await control.click({ trial: true });
      const box = await control.boundingBox();
      check(`${width}px ${selector} remains usable within the viewport`, box && box.x >= -1 && box.x + box.width <= width + 1 && box.height >= 18, box);
    }
    await page.locator('#blog-title').focus();
    await page.keyboard.press('Tab');
    check(`${width}px keyboard reaches the full article body`, await page.locator('#blog-body').evaluate(element => document.activeElement === element));
    const bodyFocus = await page.locator('#blog-body').evaluate(element => { const style = getComputedStyle(element), canvas = document.createElement('canvas').getContext('2d'); canvas.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--focus').trim(); const expected = canvas.fillStyle; canvas.fillStyle = style.outlineColor; return { visible: element.matches(':focus-visible'), width: parseFloat(style.outlineWidth), style: style.outlineStyle, color: canvas.fillStyle, expected }; });
    check(`${width}px editorial keyboard focus uses the shared visible focus ring`, bodyFocus.visible && bodyFocus.width >= 2 && bodyFocus.style !== 'none' && bodyFocus.color === bodyFocus.expected, bodyFocus);
    await page.keyboard.press('Tab');
    check(`${width}px keyboard reaches explicit save rather than submitting automatically`, await page.locator('#blog-draft-form button[type=submit]').evaluate(element => document.activeElement === element));
    await page.keyboard.press('Tab');
    check(`${width}px keyboard reaches the separate preview control`, await page.locator('#blog-preview-button').evaluate(element => document.activeElement === element));
    await page.keyboard.press('Space');
    check(`${width}px keyboard preview exposes the complete long title and exact saved body`, await page.locator('#blog-preview').isVisible() && await page.locator('#blog-preview-title').innerText() === LONG_ARTICLE_TITLE && await page.locator('#blog-preview-body').innerText() === beforeNavigation.drafts.find(item => item.id === draft.id).body);
    await readable(`${width}px editorial text and blocked publication controls`, ['#blog-preview-title', '#blog-preview-body', '#blog-format-review', '#blog-approval-state', 'label[for="blog-approve-check"]', 'label[for="blog-format-check"]', '#blog-approve-button', '#blog-deploy-button']);
    const editorialGeometry = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    check(`${width}px long title, selected draft and full preview do not overflow the page`, editorialGeometry.scroll <= width + 1 && editorialGeometry.body <= width + 1, editorialGeometry);
    await page.evaluate(() => window.scrollTo(0, 0));
    const file = join(out, `blog-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    receipt.screenshots.push(file);
  }
  const afterNavigation = await api();
  check('responsive navigation and previews never autosave, approve, enable schedules or publish', mutations.length === mutationsBeforeNavigation && ['drafts', 'approvals', 'schedules', 'runs'].every(key => JSON.stringify(afterNavigation[key]) === JSON.stringify(beforeNavigation[key])));
  const beforeTouch = await api(), mutationsBeforeTouch = mutations.length;
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
  let touchPage;
  try {
    await touchContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
    await touchContext.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) { receipt.blockedRequests.push(request.url()); return route.abort(); }
      if (!['GET', 'HEAD'].includes(request.method())) {
        const effect = `${request.method()} ${url.pathname}`;
        mutations.push(effect); receipt.forbiddenEffects.push(effect);
        return route.abort();
      }
      return route.continue();
    });
    touchPage = await touchContext.newPage();
    touchPage.setDefaultTimeout(12000);
    touchPage.on('pageerror', error => receipt.errors.push(error.message));
    await touchPage.goto(base + '/blog.html');
    await touchPage.locator('#blog-account-tabs [role=tab]').first().waitFor();
    await touchPage.waitForFunction(() => !document.querySelector('#blog-refresh').disabled);
    for (const width of [390, 430]) {
      await touchPage.setViewportSize({ width, height: 844 });
      await touchPage.evaluate(() => window.scrollTo(0, 0));
      const touchViewportFile = join(out, `blog-touch-${width}-viewport.png`);
      await touchPage.screenshot({ path: touchViewportFile });
      receipt.screenshots.push(touchViewportFile);
      for (const id of IDS) {
        const tab = touchPage.locator(`[role=tab][data-account-id="${id}"]`);
        await tab.tap();
        const bounds = await tab.boundingBox();
        check(`${width}px touch selects the visible account ${id}`, await tab.getAttribute('aria-selected') === 'true' && await touchPage.locator('#blog-account-name').innerText() === beforeTouch.accounts.find(item => item.id === id).label);
        check(`${width}px touch account ${id} remains within the page with a usable tap target`, bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1 && bounds.height >= 44, bounds);
        check(`${width}px touch navigation cannot grant publication authority for ${id}`, await touchPage.locator('#blog-approve-button').isDisabled() && await touchPage.locator('#blog-deploy-button').isDisabled());
      }
      await touchPage.locator(`[role=tab][data-account-id="${IDS[0]}"]`).tap();
      await touchPage.locator('#blog-draft-select').selectOption(draft.id);
      const touchBody = beforeTouch.drafts.find(item => item.id === draft.id).body + `\n${width}px 터치 환경에서만 보존하는 미저장 편집.`;
      await touchPage.locator('#blog-title').tap();
      check(`${width}px touch focuses the actual title editor`, await touchPage.locator('#blog-title').evaluate(element => element === document.activeElement));
      await touchPage.locator('#blog-title').fill(LONG_ARTICLE_TITLE);
      await touchPage.locator('#blog-body').tap();
      check(`${width}px touch focuses the full article editor`, await touchPage.locator('#blog-body').evaluate(element => element === document.activeElement));
      await touchPage.locator('#blog-body').fill(touchBody);
      await touchPage.locator('#blog-preview-button').tap();
      check(`${width}px touch preview renders exact local content without saving`, await touchPage.locator('#blog-preview').isVisible() && await touchPage.locator('#blog-preview-title').innerText() === LONG_ARTICLE_TITLE && await touchPage.locator('#blog-preview-body').innerText() === touchBody);
      check(`${width}px previewing unsaved touch edits cannot approve or publish them`, await touchPage.locator('#blog-approve-button').isDisabled() && await touchPage.locator('#blog-deploy-button').isDisabled());
      await touchPage.locator(`[role=tab][data-account-id="${IDS[1]}"]`).tap();
      check(`${width}px touch edits never leak into the next account`, !(await touchPage.locator('#blog-body').inputValue()).includes(touchBody));
      await touchPage.locator(`[role=tab][data-account-id="${IDS[0]}"]`).tap();
      check(`${width}px touch account round trip preserves exact unsaved edits`, await touchPage.locator('#blog-body').inputValue() === touchBody && await touchPage.locator('#blog-title').inputValue() === LONG_ARTICLE_TITLE);
      const geometry = await touchPage.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      receipt.geometry.push({ width, mode: 'touch', ...geometry });
      check(`${width}px actual mobile touch layout has no document overflow or viewport expansion`, geometry.viewport === width && geometry.scroll <= width + 1 && geometry.body <= width + 1, geometry);
      await touchPage.evaluate(() => window.scrollTo(0, 0));
      const touchFile = join(out, `blog-touch-${width}.png`);
      await touchPage.screenshot({ path: touchFile, fullPage: true });
      receipt.screenshots.push(touchFile);
    }
    const afterTouch = await api();
    check('actual mobile touch navigation, editing and preview never mutate drafts, approvals, schedules or runs', mutations.length === mutationsBeforeTouch && ['drafts', 'approvals', 'schedules', 'runs'].every(key => JSON.stringify(afterTouch[key]) === JSON.stringify(beforeTouch[key])));
  } catch (error) {
    if (touchPage) { try { await touchPage.screenshot({ path: join(out, 'touch-failure.png'), fullPage: true }); } catch {} }
    throw error;
  } finally {
    try { await touchContext.tracing.stop({ path: join(out, 'touch-trace.zip') }); } finally { await touchContext.close(); }
  }
  check('no browser JavaScript errors or external side effects occurred', receipt.errors.length === 0 && receipt.forbiddenEffects.length === 0 && receipt.blockedRequests.length === 0, receipt);
  receipt.result = 'PASS';
  console.log(`PASS: ${receipt.checks.length} behavior checks`);
} catch (error) {
  receipt.failure = error.stack;
  process.exitCode = 1;
  console.error(error.stack);
  if (page) { try { await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }); } catch {} }
} finally {
  releaseInitialState();
  if (context) { try { await context.tracing.stop({ path: join(out, 'trace.zip') }); } catch {} }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'browser-smoke.json'), JSON.stringify(receipt, null, 2) + '\n');
  await context?.close();
  await browser?.close();
  await new Promise(resolve => { if (!app.listening) return resolve(); app.close(resolve); app.closeAllConnections(); });
  await rm(dataDir, { recursive: true, force: true });
}
