/** Focused, local-file verification. No server, downloads, production or provider access.
 * Run: node artifacts/production-workspace-research/verify-workspace-prototype.mjs
 */
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join, relative, resolve} from 'node:path';
import {chromium} from 'playwright';

const dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(dir, '../..');
const receiptPath = join(dir, 'workspace-prototype-verification.json');
const target = pathToFileURL(join(dir, 'workspace-prototype.html')).href;
const command = 'node artifacts/production-workspace-research/verify-workspace-prototype.mjs';
const previous = JSON.parse(await readFile(receiptPath, 'utf8'));
const history = previous.schemaVersion === 2 ? [...previous.history, previous.finalRun] : [
  {attempt: 'initial-independent-run', ...Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'finalRun'))},
  {attempt: 'prior-blocked-follow-up', ...previous.finalRun}
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['workspace-prototype.html', 'workspace-prototype.css', 'workspace-prototype.js', 'verify-workspace-prototype.mjs'];
const sourceHashes = await Promise.all(sourceFiles.map(async name => ({path: relative(root, join(dir, name)).replaceAll('\\', '/'), sha256: sha256(await readFile(join(dir, name)))})));
const run = {
  attempt: 'file-based-post-fix-run', startedAt: new Date().toISOString(), command, target,
  scope: 'DOM-only local prototype; no production execution, media generation, approval record, account, upload or publication verified.',
  sourceHashes: {algorithm: 'SHA-256', files: sourceHashes}, scenarios: [], screenshots: [],
  networkRequests: [], nonlocalRequests: [], persistenceAttempts: [], consoleErrors: [], consoleWarnings: [], pageErrors: [],
  limitations: [
    'Editable exclusions use temporary browser DOM probes because the prototype has no editable fields; probes are removed after the scenario.',
    'No-persistence evidence covers exercised browser APIs and browser context, not a general static security audit.',
    'Screenshots record the final source appearance; no approved pixel baseline was supplied.'
  ]
};
run.priorAttemptInterpretation = 'The first file-based run is preserved in history with 41 passes and four failures. Those four extra assertions incorrectly expected modal edge Tab/Shift+Tab to wrap directly between page controls; Chromium can focus browser chrome (reported as BODY). This runner tests native :modal state and actual within-dialog Tab then Shift+Tab order instead. All original 41 scenarios and four required regressions remain, including every dialog close path for both openers.';
const lines = [];
const log = line => { lines.push(line); console.log(line); };
const variants = ['A', 'B', 'C'];
const scenes = [['hook', '훅', '01'], ['news-1', '뉴스 1', '02'], ['news-2', '뉴스 2', '03'], ['news-3', '뉴스 3', '04'], ['closing', '마무리', '05']];
const nodeResults = {
  topic: '검색 키워드 및 조사 결과 없음',
  'source-1': '기사·영상·이미지 및 이용 권리 증거 없음', 'source-2': '기사·영상·이미지 및 이용 권리 증거 없음', 'source-3': '기사·영상·이미지 및 이용 권리 증거 없음',
  evidence: '검증된 근거·소스 기록 없음', script: '훅 / 뉴스 1 / 뉴스 2 / 뉴스 3 / 마무리 구조만 합의',
  storyboard: '실제 장면 자산·타이밍·내레이션 없음', edit: '레이아웃 예시만 있음 · 실제 편집/렌더 없음',
  'generation-1': '생성 미실행 · 비용/작업/결과 없음', 'generation-2': '생성 미실행 · 비용/작업/결과 없음', 'generation-3': '생성 미실행 · 비용/작업/결과 없음',
  render: '렌더 작업·파일·해시 없음', review: '검토 증거·승인 기록 없음', publish: 'OAuth/API 미연결 · 업로드/공개 실행 불가'
};
const expectedPanels = {
  A: ['전체 제작 경로', '소스 / 장면 빈', '프로그램 모니터', '선택 항목', '장면 순서 / 타임라인'],
  B: ['프로젝트 워크플로 캔버스', '프로그램 모니터', '선택 항목', '장면 순서 / 타임라인'],
  C: ['스토리보드', '프로그램 모니터', '선택 항목', '전체 제작 경로']
};
const launchArgs = ['--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--metrics-recording-only', '--no-first-run'];
let browser, context, page;
async function scenario(id, contract, action) {
  try {
    const observed = await action();
    run.scenarios.push({id, contract, status: 'pass', observed});
    log(`PASS ${id}`);
  } catch (error) {
    run.scenarios.push({id, contract, status: 'fail', error: error.stack});
    log(`FAIL ${id}: ${error.message}`);
  }
}
const currentVariant = () => page.locator('#candidate-letter').innerText();
async function assertVariant(expected) {
  assert.equal(await currentVariant(), expected);
  assert.equal(new URL(page.url()).searchParams.get('variant'), expected);
  assert.deepEqual(await page.locator('[data-variant][aria-pressed="true"]').evaluateAll(elements => elements.map(e => e.dataset.variant)), [expected]);
}
async function baseline(variant = 'A') {
  await page.setViewportSize({width: 1600, height: 1100});
  await page.goto(`${target}?variant=${variant}`);
  await assertVariant(variant);
}
async function field(label) {
  return page.locator('.inspector-fields > div').filter({has: page.locator('dt', {hasText: label})}).locator('dd').innerText();
}
async function selection() {
  return {node: await page.locator('.inspector .identity code').innerText(), scene: await page.locator('.monitor-footer strong').innerText()};
}
async function focused(selector) {
  assert.equal(await page.locator(selector).evaluate(e => e === document.activeElement), true, `Expected focus on ${selector}; actual ${await page.evaluate(() => document.activeElement.outerHTML.slice(0, 350))}`);
}
async function screenshot(variant, width) {
  const path = join(dir, 'prototype-evidence', `${variant.toLowerCase()}-${width}.png`);
  await page.screenshot({path, fullPage: true, animations: 'disabled'});
  const bytes = await readFile(path);
  run.screenshots.push({path: relative(root, path).replaceAll('\\', '/'), variant, viewport: [width, 1100], image: [bytes.readUInt32BE(16), bytes.readUInt32BE(20)], fullPage: true, sha256: sha256(bytes)});
}
const inspectorControls = {summary: '.policy-details > summary', review: '.inspector .review-trigger'};
async function focusTransitions(control, key, tab = false) {
  const observations = [];
  for (const start of variants) {
    await baseline(start);
    await page.locator('[data-node="generation-3"]').click();
    await page.locator(inspectorControls[control]).focus();
    await page.keyboard.press(key);
    const expected = variants[(variants.indexOf(start) + (key === 'ArrowRight' ? 1 : 2)) % 3];
    await assertVariant(expected);
    await focused(inspectorControls[control]);
    assert.deepEqual(await selection(), {node: 'generation-3', scene: '뉴스 3'});
    let next;
    if (tab) {
      await page.keyboard.press('Tab');
      next = control === 'summary' ? '.inspector .review-trigger' : expected === 'C' ? '.workflow-panel [data-node="topic"]' : '.timeline [data-scene="hook"]';
      await focused(next);
      if (control === 'summary') {
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('#approval-dialog').evaluate(e => e.open && e.matches(':modal')), true);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('approval-dialog').open && document.activeElement.matches('.inspector .review-trigger'));
      } else {
        await page.keyboard.press('Enter');
        if (expected === 'C') assert.equal((await selection()).node, 'topic');
        else assert.equal((await selection()).scene, '훅');
      }
    }
    observations.push({start, key, destination: expected, focus: inspectorControls[control], ...(next ? {nextTab: next, activationVerified: true} : {})});
  }
  return observations;
}
try {
  await mkdir(join(dir, 'prototype-evidence'), {recursive: true});
  browser = await chromium.launch({headless: true, args: launchArgs});
  context = await browser.newContext({viewport: {width: 1600, height: 1100}, serviceWorkers: 'block'});
  run.tooling = {node: process.version, playwright: JSON.parse(await readFile(join(root, 'node_modules/playwright/package.json'), 'utf8')).version, browser: browser.version(), executable: chromium.executablePath(), launchArgs, freshNonpersistentContext: true, noDownloads: true, noApplicationServer: true};
  await context.route('**/*', route => new URL(route.request().url()).protocol === 'file:' ? route.continue() : route.abort());
  await context.exposeBinding('__verificationPersistenceAttempt', (_source, operation) => {run.persistenceAttempts.push(operation);});
  await context.addInitScript(() => {
    const forbidden = operation => {
      void window.__verificationPersistenceAttempt(operation);
      throw new Error(`Verification blocked persistence: ${operation}`);
    };
    for (const name of ['setItem', 'removeItem', 'clear']) Storage.prototype[name] = function () {return forbidden(`Storage.${name}`);};
    for (const name of ['open', 'deleteDatabase']) {
      const original = IDBFactory.prototype[name];
      if (original) IDBFactory.prototype[name] = function () {return forbidden(`indexedDB.${name}`);};
    }
    if (typeof CacheStorage !== 'undefined') CacheStorage.prototype.open = function () {return forbidden('caches.open');};
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cookie?.set) Object.defineProperty(Document.prototype, 'cookie', {...cookie, set() {return forbidden('document.cookie=');}});
  });
  page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('request', request => {
    const record = {url: request.url(), method: request.method()};
    run.networkRequests.push(record);
    if (new URL(record.url).protocol !== 'file:') run.nonlocalRequests.push(record);
  });
  page.on('pageerror', error => run.pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') run.consoleErrors.push(message.text());
    if (message.type() === 'warning') run.consoleWarnings.push(message.text());
  });

  for (const variant of variants) for (const width of [1600, 1024, 768, 375]) {
    await scenario(`layout-${variant}-${width}`, 'Candidate-specific panels reflow within the viewport while retaining honest prototype and preview labels.', async () => {
      await baseline(variant);
      await page.setViewportSize({width, height: 1100});
      const geometry = await page.evaluate(() => ({documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, panels: [...document.querySelectorAll('#candidate .panel')].map(e => ({title: e.querySelector('.panel-heading h3').textContent, left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right, height: e.getBoundingClientRect().height}))}));
      assert.ok(geometry.documentWidth <= width && geometry.bodyWidth <= width, JSON.stringify(geometry));
      assert.deepEqual(geometry.panels.map(p => p.title), expectedPanels[variant]);
      assert.ok(geometry.panels.every(p => p.left >= -0.5 && p.right <= width + 0.5 && p.height > 0), JSON.stringify(geometry));
      assert.match(await page.locator('.boundary').innerText(), /서버 저장·외부 실행 없음/);
      const preview = await page.locator('.news-layout').innerText();
      for (const text of ['실제 뉴스가 아닌', '뉴스 카드 배치 예시', '뉴스 문안·미디어 없음', 'LAYOUT ONLY']) assert.ok(preview.includes(text), text);
      if (width === 1600 || (variant === 'A' && width === 375)) await screenshot(variant, width);
      return geometry;
    });
  }
  for (const variant of variants) {
    await scenario(`node-selection-${variant}`, 'Every node exposes its own identity and evidence; scene-bound nodes select their scene and other nodes preserve it.', async () => {
      await baseline(variant);
      const observed = [];
      for (const [id, result] of Object.entries(nodeResults)) {
        const prior = await selection();
        await page.locator(`[data-node="${id}"]`).click();
        assert.equal((await selection()).node, id);
        assert.equal(await page.locator(`[data-node="${id}"]`).getAttribute('aria-pressed'), 'true');
        assert.equal(await field('결과 / 증거'), result);
        const sceneNumber = /^(source|generation)-(\d)$/.exec(id)?.[2];
        assert.equal((await selection()).scene, sceneNumber ? `뉴스 ${sceneNumber}` : prior.scene);
        observed.push({id, result, selection: await selection()});
      }
      return observed;
    });
    await scenario(`scene-selection-${variant}`, 'All scene controls update monitor and inspector independently without changing a deliberately selected non-scene node.', async () => {
      await baseline(variant);
      await page.locator('[data-node="evidence"]').click();
      const observed = [];
      for (const [id, title, number] of scenes) {
        await page.locator(`[data-scene="${id}"]`).first().click();
        assert.deepEqual(await selection(), {node: 'evidence', scene: title});
        assert.ok((await field('선택 장면')).startsWith(`${number} · ${title}`));
        assert.ok((await page.locator('.inspector .eyebrow').innerText()).includes('SELECTED NODE'));
        assert.match(await page.locator('.inspector .panel-heading').innerText(), /노드 \/ 장면/);
        assert.ok((await page.locator(`[data-scene="${id}"]`).evaluateAll(elements => elements.every(e => e.getAttribute('aria-pressed') === 'true'))));
        observed.push({id, title, retainedNode: 'evidence', inspectorScene: await field('선택 장면')});
      }
      return observed;
    });
  }
  await scenario('selection-survives-layout-switches', 'Node and independently selected scene survive every candidate switch and URL reflects the visible candidate.', async () => {
    await baseline();
    await page.locator('[data-node="generation-3"]').click();
    await page.locator('[data-scene="news-2"]').first().click();
    const observed = [];
    for (const variant of ['B', 'C', 'A']) {
      await page.locator(`[data-variant="${variant}"]`).click();
      await assertVariant(variant);
      assert.deepEqual(await selection(), {node: 'generation-3', scene: '뉴스 2'});
      observed.push({variant, selection: await selection(), url: page.url()});
    }
    return observed;
  });
  await scenario('variant-arrows-and-wrap', 'Buttons and unmodified arrow keys switch in both directions with wraparound and matching pressed/URL state.', async () => {
    await baseline();
    await page.locator('#previous-variant').click(); await assertVariant('C');
    await page.locator('#next-variant').click(); await assertVariant('A');
    await page.locator('.project-heading .review-trigger').focus();
    await page.keyboard.press('ArrowRight'); await assertVariant('B');
    await page.keyboard.press('ArrowLeft'); await assertVariant('A');
    return ['A ← C', 'C → A', 'A ArrowRight B', 'B ArrowLeft A'];
  });
  await scenario('editable-arrows-not-intercepted', 'Both arrow keys keep native editing behavior and do not switch layout for input, textarea, select or nested editable content.', async () => {
    await baseline();
    await page.evaluate(() => {
      const box = document.createElement('section'); box.id = 'verification-editable-probes';
      box.innerHTML = '<input value="abcd"><textarea>abcd</textarea><select><option>one</option><option>two</option></select><div contenteditable="true"><span>abcd</span></div>';
      document.getElementById('workspace').append(box);
      window.__editableEvents = [];
      window.__editableListener = event => {if (event.target.closest('#verification-editable-probes')) window.__editableEvents.push({key: event.key, prevented: event.defaultPrevented});};
      window.addEventListener('keydown', window.__editableListener);
    });
    const observed = [];
    try {
      for (const tag of ['input', 'textarea', 'select', '[contenteditable]']) {
        const locator = page.locator(`#verification-editable-probes ${tag}`);
        await locator.focus();
        if (tag === 'input' || tag === 'textarea') await locator.evaluate(e => e.setSelectionRange(2, 2));
        if (tag === '[contenteditable]') await locator.evaluate(e => {const selection = window.getSelection(); selection.collapse(e.firstElementChild.firstChild, 2);});
        for (const [key, position] of [['ArrowLeft', 1], ['ArrowRight', 2]]) {
          await page.keyboard.press(key);
          await assertVariant('A');
          if (tag === 'input' || tag === 'textarea') assert.equal(await locator.evaluate(e => e.selectionStart), position);
          if (tag === '[contenteditable]') assert.equal(await page.evaluate(() => window.getSelection().anchorOffset), position);
        }
        observed.push({tag, selection: await locator.evaluate(e => e.selectionStart ?? (e.isContentEditable ? window.getSelection().anchorOffset : e.value))});
      }
      const events = await page.evaluate(() => window.__editableEvents);
      assert.equal(events.length, 8); assert.ok(events.every(e => !e.prevented));
      return {observed, events};
    } finally {
      await page.evaluate(() => {document.getElementById('verification-editable-probes').remove(); window.removeEventListener('keydown', window.__editableListener); delete window.__editableEvents; delete window.__editableListener;});
    }
  });
  for (const variant of variants) await scenario(`review-dialog-${variant}`, 'Native modal supports internal keyboard order, ignores layout arrows, disables publication and restores exact opener for Escape and both close buttons.', async () => {
    await baseline(variant);
    const observed = [];
    for (const opener of ['.project-heading .review-trigger', '.inspector .review-trigger']) {
      for (const close of ['Escape', '#close-review', '#back-to-workspace']) {
        await page.locator(opener).click();
        assert.equal(await page.locator('#approval-dialog').evaluate(e => e.open && e.matches(':modal')), true);
        await focused('#close-review');
        assert.equal(await page.locator('.dialog-actions button:last-child').isDisabled(), true);
        await page.keyboard.press('Tab'); await focused('#back-to-workspace');
        await page.keyboard.press('Shift+Tab'); await focused('#close-review');
        await page.keyboard.press('ArrowRight'); await assertVariant(variant);
        await page.keyboard.press('ArrowLeft'); await assertVariant(variant);
        if (close === 'Escape') await page.keyboard.press('Escape'); else await page.locator(close).click();
        await page.waitForFunction(selector => !document.getElementById('approval-dialog').open && document.querySelector(selector) === document.activeElement, opener);
        observed.push({opener, close, focusRestored: true});
      }
    }
    return observed;
  });
  await scenario('keyboard-scene-focus-preserved', 'Scene focus survives timeline-to-storyboard replacement and reverse arrow navigation.', async () => {
    await baseline(); await page.locator('.timeline [data-scene="hook"]').focus();
    for (const [key, expected] of [['ArrowRight', 'B'], ['ArrowRight', 'C'], ['ArrowLeft', 'B'], ['ArrowLeft', 'A']]) {
      await page.keyboard.press(key); await assertVariant(expected);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.scene), 'hook');
    }
    return 'hook scene focus preserved A→B→C→B→A';
  });
  await scenario('keyboard-inspector-summary-focus-preserved', 'Policy summary keeps equivalent inspector focus after every ArrowRight transition.', () => focusTransitions('summary', 'ArrowRight'));
  await scenario('keyboard-review-button-focus-preserved', 'Inspector review button keeps equivalent inspector focus after every ArrowRight transition.', () => focusTransitions('review', 'ArrowRight'));
  await scenario('publication-node-does-not-execute', 'Publication node only exposes blocked evidence; review cannot activate publication and returns inspector focus.', async () => {
    await baseline(); await page.locator('[data-node="publish"]').click();
    assert.equal(await field('결과 / 증거'), nodeResults.publish);
    assert.equal(await page.locator('#approval-dialog').evaluate(e => e.open), false);
    await page.locator('.inspector .review-trigger').click();
    const disabled = page.locator('.dialog-actions button:last-child');
    assert.equal(await disabled.isDisabled(), true);
    const blocked = await page.locator('#publication-blocked').innerText(); assert.match(blocked, /공개 게시 불가/);
    await page.keyboard.press('Tab'); await focused('#back-to-workspace');
    await page.keyboard.press('Shift+Tab'); await focused('#close-review');
    await page.locator('#close-review').click();
    await page.waitForFunction(() => !document.getElementById('approval-dialog').open && document.activeElement.matches('.inspector .review-trigger'));
    return {nodeResult: await field('결과 / 증거'), blocked, publicationDisabled: true};
  });
  for (const variant of variants) await scenario(`url-reload-${variant}`, 'Explicit URL layout survives reload while in-memory user selections do not persist.', async () => {
    await baseline(variant); const before = await selection();
    await page.locator('[data-node="generation-3"]').click();
    assert.notDeepEqual(await selection(), before);
    await page.reload(); await assertVariant(variant);
    assert.deepEqual(await selection(), before);
    return {variant, selectionBeforeInteraction: before, selectionAfterReload: await selection()};
  });
  const invalids = [
    ['INVALID', '?variant=INVALID'], ['prototype-key', '?variant=__proto__'], ['inherited-key', '?variant=toString'],
    ['lowercase', '?variant=b'], ['empty', '?variant='], ['markup', '?variant=%3Cscript%3E'], ['absent-preserves-other-query', '?unrelated=keep']
  ];
  for (const [name, query] of invalids) await scenario(`invalid-url-${name}`, 'Invalid or absent candidate input falls back to candidate A, normalizes URL to A and preserves unrelated query data.', async () => {
    await page.goto(target + query);
    const candidate = await currentVariant();
    assert.equal(candidate, 'A'); await assertVariant('A');
    assert.deepEqual(await page.locator('#candidate .panel-heading h3').allTextContents(), expectedPanels.A);
    if (name === 'absent-preserves-other-query') assert.equal(new URL(page.url()).searchParams.get('unrelated'), 'keep');
    return {input: query, candidate, normalizedURL: page.url()};
  });
  await scenario('reduced-motion-all-candidates', 'Reduced-motion users can select nodes in every candidate without running animation or significant transition durations.', async () => {
    await page.emulateMedia({reducedMotion: 'reduce'});
    const observed = [];
    try {
      for (const variant of variants) {
        await baseline(variant); await page.locator('[data-node="generation-2"]').click();
        assert.deepEqual(await selection(), {node: 'generation-2', scene: '뉴스 2'});
        const motion = await page.evaluate(() => ({matches: matchMedia('(prefers-reduced-motion: reduce)').matches, running: document.getAnimations().filter(a => a.playState === 'running').length, durations: [...document.querySelectorAll('*')].flatMap(e => {const s = getComputedStyle(e); return `${s.transitionDuration},${s.animationDuration}`.split(',').map(v => v.trim().endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v));})}));
        assert.equal(motion.matches, true); assert.equal(motion.running, 0); assert.ok(motion.durations.every(value => value <= 0.001));
        observed.push({variant, matches: motion.matches, running: motion.running, maximumDurationSeconds: Math.max(...motion.durations)});
      }
    } finally {await page.emulateMedia({reducedMotion: 'no-preference'});}
    return observed;
  });
  await scenario('keyboard-inspector-summary-arrowleft-focus-preserved', 'Policy summary keeps equivalent inspector focus after every ArrowLeft transition including A-to-C wraparound.', () => focusTransitions('summary', 'ArrowLeft'));
  await scenario('keyboard-review-button-arrowleft-focus-preserved', 'Inspector review button keeps equivalent inspector focus after every ArrowLeft transition including A-to-C wraparound.', () => focusTransitions('review', 'ArrowLeft'));
  await scenario('keyboard-inspector-summary-next-tab', 'After either arrow direction, next Tab reaches usable inspector review and Enter opens its modal.', async () => [...await focusTransitions('summary', 'ArrowRight', true), ...await focusTransitions('summary', 'ArrowLeft', true)]);
  await scenario('keyboard-review-button-next-tab', 'After either arrow direction, next Tab reaches the candidate-specific next control and Enter performs its meaningful selection.', async () => [...await focusTransitions('review', 'ArrowRight', true), ...await focusTransitions('review', 'ArrowLeft', true)]);
  await scenario('no-persistence-or-remote-requests', 'All exercised UI actions remain read-only and local with no storage writes, cookies, workers, external requests or file mutations.', async () => {
    const storage = await page.evaluate(() => ({local: localStorage.length, session: sessionStorage.length}));
    assert.deepEqual(run.persistenceAttempts, []); assert.deepEqual(run.nonlocalRequests, []);
    assert.deepEqual(storage, {local: 0, session: 0}); assert.deepEqual(await context.cookies(), []); assert.equal(context.serviceWorkers().length, 0);
    const allowed = new Set(sourceFiles.slice(0, 3).map(name => pathToFileURL(join(dir, name)).pathname));
    assert.ok(run.networkRequests.every(r => r.method === 'GET' && new URL(r.url).protocol === 'file:' && allowed.has(new URL(r.url).pathname)));
    for (const [index, name] of sourceFiles.entries()) assert.equal(sha256(await readFile(join(dir, name))), sourceHashes[index].sha256, `${name} changed during run`);
    return {requests: run.networkRequests.length, nonlocalAttempts: 0, persistenceAttempts: [], storage, cookies: [], serviceWorkers: 0, sourceHashesUnchanged: true};
  });
  await scenario('no-console-errors', 'Every scenario executes without browser exceptions, console errors or console warnings.', async () => {
    assert.deepEqual(run.pageErrors, []); assert.deepEqual(run.consoleErrors, []); assert.deepEqual(run.consoleWarnings, []);
    return {pageErrors: [], consoleErrors: [], consoleWarnings: []};
  });
} catch (error) {
  run.runnerFailure = error.stack;
  log(`RUNNER FAILURE: ${error.message}`);
} finally {
  await context?.close(); await browser?.close();
}
const originalIds = new Set((history.find(attempt => attempt.attempt === 'initial-independent-run')?.scenarios ?? []).map(s => s.id));
run.originalScenarioCoverage = {expected: originalIds.size, executed: run.scenarios.filter(s => originalIds.has(s.id)).length, missing: [...originalIds].filter(id => !run.scenarios.some(s => s.id === id))};
run.counts = {total: run.scenarios.length, passed: run.scenarios.filter(s => s.status === 'pass').length, failed: run.scenarios.filter(s => s.status === 'fail').length, blocked: 0, skipped: 0};
run.failures = run.scenarios.filter(s => s.status === 'fail');
run.complete = !run.runnerFailure && run.counts.total === 45 && run.counts.failed === 0 && run.originalScenarioCoverage.executed === 41 && run.originalScenarioCoverage.missing.length === 0 && run.screenshots.length === 4;
run.verdict = run.complete ? 'PASS' : 'FAIL';
run.originalFailureResolution = ['keyboard-inspector-summary-focus-preserved', 'keyboard-review-button-focus-preserved'].map(id => ({scenario: id, initialStatus: 'fail', finalStatus: run.scenarios.find(s => s.id === id)?.status ?? 'not-executed'}));
run.finishedAt = new Date().toISOString();
run.implementationEdits = false;
run.gitInstallServerProviderAccountOrProjectSuiteAccess = false;
log(`RESULT ${run.verdict}: ${run.counts.total} scenarios; ${run.counts.passed} passed; ${run.counts.failed} failed; 0 skipped; ${run.screenshots.length} screenshots`);
run.output = lines.join('\n') + '\n';
await writeFile(receiptPath, JSON.stringify({schemaVersion: 2, verifiedAt: run.finishedAt, verifier: 'PrototypeVerificationRunner', verdict: run.verdict, counts: run.counts, history, finalRun: run}, null, 2) + '\n');
if (!run.complete) process.exitCode = 1;
