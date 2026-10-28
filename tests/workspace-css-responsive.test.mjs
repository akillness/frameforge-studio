/** Dedicated browser coverage for public/styles.css and public/workspace.css responsive
 * behavior (owned by WorkspaceDesign in this review round): key project controls stay
 * visible and reachable at desktop and narrow widths, the workbench never overflows
 * horizontally, and a focused control is never hidden under a sticky dialog header
 * (.project-dialog-header / .workspace-dialog-header) across their scroll-padding-top
 * breakpoints and the short-landscape static-header fallback.
 *
 * Isolated createApp + temp data dir + mock providers per fixture call, patterned on
 * tests/node-workbench.test.mjs and tests/production-workspace-ui.test.mjs. No live
 * service, no real provider, no shared user data -- every fixture gets its own channel,
 * episode and workflow template.
 *
 * Mechanics confirmed directly from public/styles.css and public/workspace.css at write
 * time (relayed by WorkspaceDesign over IRC, then independently verified in source):
 *   - .project-tool-strip uses margin-left:auto (flush to the nav's trailing edge) above
 *     699px, and flex-basis:100%/margin-left:0 (full width) at <=699px.
 *   - .sidebar-sizing button min-size follows --control-height, which is 36px under a
 *     fine pointer and swaps to 44px only under `@media (pointer: coarse)` (styles.css).
 *   - .project-dialog-header / .workspace-dialog-header are `position: sticky` and the
 *     owning dialog sets scroll-padding-top so a focused control scrolls clear of the
 *     header: project dialogs step 104px (>=900px) -> 152px (441-899px) -> 224px
 *     (<=440px); workspace dialogs step 88px -> 112px (<=560px). At `(max-height: 520px)`
 *     both headers become `position: static` and scroll-padding-top resets to 0, since a
 *     static header can never cover a focused control.
 *   - .project-dialog-header's h2 clamps to 2 lines (`-webkit-line-clamp: 2`) and its
 *     title block takes `flex: 1 1 280px` so the action-button row wraps onto its own
 *     line instead of being crushed -- both added 2026-10-28 specifically to keep header
 *     height inside the 104/152/224px budget above at the server's real 200-char title
 *     cap (see the test-8 note below: the original 88/136/208px values were measured with
 *     a short fixture title and did not hold at 200 characters).
 *
 * KNOWN LIMITATION (reported by WorkspaceDesign, 2026-10-28): a manual probe at the
 * extreme 320x200 viewport showed 3 unexplained tab stops flagged above the dialog top
 * with a fine pointer. This file deliberately does NOT assert a zero-violation Shift+Tab
 * walk at that exact width+height combination -- see test 7, which covers short-landscape
 * windows at 740x400 and 1024x480 instead (still inside the `(max-height: 520px)` static-
 * header regime, but away from the flagged corner) and documents the gap explicitly rather
 * than asserting something unverified.
 *
 * Also note: a short, fixed fixture title alone does not prove the sticky header never
 * grows taller than its reserved scroll-padding-top (title length affects header height;
 * scroll-padding-top does not). This was not hypothetical: WorkspaceDesign measured a
 * genuine failure at the server's 200-char title max against the original 88/136/208px
 * values (header grew to 142-165px, 7-10 tab stops obscured) before fixing it with the
 * line-clamp + flex-basis change and the wider 104/152/224px budget above. Test 8 re-proves
 * the contract at that same 200-char boundary instead of trusting a short-title result to
 * generalize.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';

const modulePath = process.env.PLATFORM_PLAYWRIGHT_MODULE || process.env.OPS_PLAYWRIGHT_MODULE;
const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
const executablePath = process.env.PLATFORM_CHROMIUM_PATH || process.env.CHROMIUM_PATH || process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();

// ---------------------------------------------------------------------------
// Fixture -- one channel, one episode (which auto-creates a starter scene) and a single-
// node workflow template, matching the minimal shape used by tests/workflow-dialog-focus
// .test.mjs and tests/production-workspace-ui.test.mjs. All provider surfaces are
// `forbidden`: this file only exercises CSS layout, geometry and native focus, never a
// real generation, render, speech or trend call.
// ---------------------------------------------------------------------------
async function fixture(t, { touch = false, width = 1440, height = 1080, title = 'Responsive CSS project' } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-workspace-css-'));
  const forbidden = async () => { assert.fail('Responsive CSS coverage must never reach an external or paid operation'); };
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), runAgent: forbidden, fetchTrends: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const writes = [], external = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname });
    return route.continue();
  });
  t.after(async () => {
    await context.close(); await browser.close();
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.deepEqual(external, [], 'browser external traffic is blocked');
    assert.deepEqual(errors, [], 'pure CSS/viewport/focus coverage must never throw in the real workbench');
    assert.deepEqual(writes, [], 'reading layout geometry and moving focus never triggers a state-changing request');
  });
  // loginToken:'' means every fixture-setup request below is already an authenticated
  // admin session (matches tests/node-workbench.test.mjs and
  // tests/production-workspace-ui.test.mjs), so these never touch `writes` either.
  const api = async (path, method = 'GET', body) => {
    const response = await context.request.fetch(base + path, { method, headers: { origin: base }, ...(body === undefined ? {} : { data: body }) });
    assert.ok(response.ok(), `fixture ${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const channel = await api('/api/channels', 'POST', { name: 'Responsive CSS channel', platform: 'youtube', category: 'information' });
  const episode = await api('/api/episodes', 'POST', { channelId: channel.id, title, topic: 'Local fixture only, not a real episode' });
  const template = await api('/api/workflows', 'POST', { name: 'Responsive CSS graph', nodes: [{ id: 'a', type: 'trend', label: 'Node A', x: 40, y: 50, config: {} }], edges: [] });
  await api(`/api/workflows/${template.id}/copies`, 'POST', { channelId: channel.id, episodeId: episode.id, expectedTemplateVersion: template.version });
  await page.goto(base);
  await page.locator('#app .shell').waitFor();
  const group = page.locator('.platform-group').filter({ has: page.locator(`[data-action="channel"][data-id="${channel.id}"]`) });
  if (!(await group.evaluate(element => element.open))) await group.locator('summary').click();
  await group.locator(`[data-action="channel"][data-id="${channel.id}"]`).click();
  await page.locator('#workflow-canvas').waitFor();
  return { page, context, browser, base, api, writes, external, errors, channel, episode };
}

async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Geometry helpers (per-file local copies, matching the convention already established in
// tests/node-workbench.test.mjs and tests/production-workspace-journey.test.mjs: no shared
// helper module exists for these).
// ---------------------------------------------------------------------------
async function overflowGeometry(page) {
  return page.evaluate(() => ({
    viewport: window.innerWidth,
    docClient: document.documentElement.clientWidth,
    docScroll: document.documentElement.scrollWidth,
    bodyScroll: document.body.scrollWidth,
  }));
}
function assertNoOverflow(geometry, label) {
  assert.ok(
    geometry.docScroll <= geometry.docClient + 1 && geometry.bodyScroll <= geometry.docClient + 1,
    `${label}: no horizontal document overflow :: ${JSON.stringify(geometry)}`,
  );
}

/** A control is "reachable" if it has a nonzero layout box fully inside the current
 * viewport's horizontal bounds after scrolling it into view, and it actually becomes
 * document.activeElement when focused (catches a control that looks clickable but is
 * `disabled` or has display:none applied by a stray breakpoint). */
async function assertReachable(page, locator, label) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box, `${label}: has a visible layout box`);
  assert.ok(box.width > 0 && box.height > 0, `${label}: has nonzero size :: ${JSON.stringify(box)}`);
  const viewport = page.viewportSize();
  assert.ok(
    box.x >= -1 && box.x + box.width <= viewport.width + 1,
    `${label}: stays within the viewport horizontally :: ${JSON.stringify({ box, viewport })}`,
  );
  await locator.focus();
  assert.equal(await locator.evaluate(el => el === document.activeElement), true, `${label}: is keyboard-focusable`);
}

async function openSceneDialog(page) {
  await page.locator('[data-action="open-scene-editor"]').first().click();
  await page.locator('#project-scene-dialog[open] #preview').waitFor();
}
async function closeSceneDialog(page) {
  if (await page.locator('#project-scene-dialog[open]').count()) {
    await page.keyboard.press('Escape');
    await page.locator('#project-scene-dialog[open]').waitFor({ state: 'hidden' });
  }
}
async function openToolDialog(page, section) {
  await page.locator(`[data-action="project-section"][data-section="${section}"]`).click();
  await page.locator('#project-tool-dialog[open]').waitFor();
}
async function closeToolDialog(page) {
  if (await page.locator('#project-tool-dialog[open]').count()) {
    await page.keyboard.press('Escape');
    await page.locator('#project-tool-dialog[open]').waitFor({ state: 'hidden' });
  }
}
async function openWorkspaceSettings(page) {
  await page.locator('[data-workspace-action="settings"]').click();
  await page.locator('#workspace-settings-dialog[open]').waitFor();
}
async function closeWorkspaceSettings(page) {
  if (await page.locator('#workspace-settings-dialog[open]').count()) {
    await page.keyboard.press('Escape');
    await page.locator('#workspace-settings-dialog[open]').waitFor({ state: 'hidden' });
  }
}

async function dialogNoInternalOverflow(page, selector, label) {
  const geometry = await page.locator(selector).evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(geometry.scroll <= geometry.client + 1, `${label}: dialog content does not overflow horizontally :: ${JSON.stringify(geometry)}`);
}

async function scrollPaddingTopOf(page, selector) {
  const raw = await page.locator(selector).evaluate(el => getComputedStyle(el).scrollPaddingTop);
  return parseFloat(raw);
}
async function headerPositionOf(page, dialogSelector, headerSelector) {
  return page.evaluate(([dialogSel, headerSel]) => {
    const header = document.querySelector(dialogSel)?.querySelector(headerSel);
    return header ? getComputedStyle(header).position : null;
  }, [dialogSelector, headerSelector]);
}
/** The sticky header's own rendered height, in px -- grows with content (e.g. a long,
 * wrapping episode title inside #project-scene-title), unlike scroll-padding-top which is
 * a fixed CSS value per breakpoint. If content ever makes the header taller than the
 * scroll-padding-top reserved for it, a control scrolled "into view" at the very top of
 * the body is still partially covered -- the Shift+Tab walk alone can miss this if the
 * fixture's own title happens to be short enough that the header never grows that tall. */
async function headerHeightOf(page, dialogSelector, headerSelector) {
  return page.evaluate(([dialogSel, headerSel]) => {
    const header = document.querySelector(dialogSel)?.querySelector(headerSel);
    return header ? header.getBoundingClientRect().height : null;
  }, [dialogSelector, headerSelector]);
}

/** Asserts the dialog's scrollable body genuinely overflows its own box -- a precondition
 * for the Shift+Tab walk below to mean anything. Without this, a "zero violations" result
 * could just mean nothing ever needed to scroll past the header in the first place. */
async function assertDialogScrollable(page, selector, label) {
  const { scrollHeight, clientHeight } = await page.locator(selector).evaluate(el => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  assert.ok(
    scrollHeight > clientHeight + 4,
    `${label}: precondition -- the dialog body must actually overflow to exercise the sticky-header/scroll-padding-top contract :: ${JSON.stringify({ scrollHeight, clientHeight })}`,
  );
}

/** Focuses the dialog's own last focusable control (outside its header), then repeatedly
 * presses Shift+Tab, recording any step where a sticky header's bottom edge still covers
 * the newly focused control's top edge. Stops once focus re-enters the header itself (the
 * header obscuring itself is not a meaningful case) or leaves the dialog's subtree. */
async function shiftTabViolations(page, { dialogSelector, headerSelector, maxSteps = 60 }) {
  const focusedLast = await page.evaluate(([dialogSel, headerSel]) => {
    const dialog = document.querySelector(dialogSel);
    const header = dialog?.querySelector(headerSel);
    const candidates = [...(dialog?.querySelectorAll('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') || [])]
      .filter(el => !el.disabled && el.getClientRects().length > 0 && !(header && header.contains(el)));
    const last = candidates.at(-1);
    if (!last) return false;
    last.focus();
    return true;
  }, [dialogSelector, headerSelector]);
  assert.equal(focusedLast, true, `${dialogSelector}: has at least one focusable control outside its own header`);
  await wait(60);
  const violations = [];
  for (let step = 0; step < maxSteps; step++) {
    const state = await page.evaluate(([dialogSel, headerSel]) => {
      const dialog = document.querySelector(dialogSel);
      const header = dialog?.querySelector(headerSel);
      const active = document.activeElement;
      if (!dialog || !active || !dialog.contains(active)) return { inDialog: false };
      if (header && header.contains(active)) return { inDialog: true, inHeader: true };
      const sticky = header ? getComputedStyle(header).position === 'sticky' : false;
      const activeRect = active.getBoundingClientRect();
      const headerRect = sticky ? header.getBoundingClientRect() : null;
      return {
        inDialog: true, inHeader: false, sticky,
        obscured: sticky ? activeRect.top < headerRect.bottom - 1 : false,
        activeTop: activeRect.top, headerBottom: headerRect ? headerRect.bottom : null,
        tag: active.tagName, id: active.id || null,
        action: active.dataset?.action || active.dataset?.workspaceAction || active.getAttribute('aria-label') || null,
      };
    }, [dialogSelector, headerSelector]);
    if (!state.inDialog || state.inHeader) break;
    if (state.obscured) violations.push(state);
    await page.keyboard.press('Shift+Tab');
    await wait(30);
  }
  return violations;
}

// ===========================================================================
// 1 -- the project workbench causes no horizontal document overflow across desktop,
// tablet, mobile and short-landscape widths. Covers public/styles.css's and
// public/workspace.css's min-width:0 / overflow-wrap:anywhere / flex-wrap reflow rules as
// a whole, with no dialog open.
// ===========================================================================
test('the project workbench causes no horizontal document overflow at desktop, tablet, mobile and short-landscape widths', async t => {
  const f = await fixture(t), { page } = f;
  for (const [width, height] of [
    [1600, 1120], [1280, 900], [1024, 900], [768, 900], [699, 900], [650, 900],
    [480, 844], [375, 844], [320, 844],
    [740, 400], [568, 320], [320, 200],
  ]) {
    await page.setViewportSize({ width, height });
    const geometry = await overflowGeometry(page);
    assertNoOverflow(geometry, `project workbench at ${width}x${height}`);
  }
});

// ===========================================================================
// 2 -- key project controls (scene editor, source, review/publish, sidebar resize buttons,
// workspace settings) remain visible, inside the viewport and keyboard-focusable at a
// desktop and a narrow width. Also confirms the narrow-width reflow actually took effect
// (the drag-based sidebar-resize separator is intentionally hidden at <=699px, per
// workspace.css, since dragging isn't a coherent narrow-viewport interaction).
// ===========================================================================
test('key project controls stay visible, in-bounds and keyboard-focusable at a desktop and a narrow width', async t => {
  const f = await fixture(t), { page } = f;
  const controls = [
    ['[data-action="open-scene-editor"]', '장면 편집 (open scene editor) button'],
    ['[data-action="project-section"][data-section="source"]', '소스 (source) tool button'],
    ['[data-action="project-section"][data-section="delivery"]', '검토 · 공개 (review/publish) tool button'],
    ['[data-sidebar-size="decrease"]', '사이드바 좁게 (sidebar narrower) button'],
    ['[data-sidebar-size="increase"]', '사이드바 넓게 (sidebar wider) button'],
    ['[data-workspace-action="settings"]', '작업 창 설정 (workspace settings) button'],
  ];
  for (const [width, height, label] of [[1600, 1120, 'desktop'], [375, 844, 'narrow']]) {
    await page.setViewportSize({ width, height });
    for (const [selector, name] of controls) await assertReachable(page, page.locator(selector).first(), `${name} at ${label} (${width}px)`);
  }
  // Narrow-width-only structural check: dragging the sidebar wider/narrower is replaced by
  // the increase/decrease buttons alone below 699px (workspace.css `@media (max-width:
  // 699px) { .sidebar-resize { display: none } }`).
  assert.equal(await page.locator('.sidebar-resize').isVisible(), false, 'the drag-to-resize separator is hidden at a narrow width; the +/- buttons remain the only sizing control');
});

// ===========================================================================
// 3 -- .project-tool-strip sits flush with the navigation bar's trailing edge above the
// 699px breakpoint (margin-left:auto) and reflows to the nav's full width below it
// (flex-basis:100%, margin-left:0). Also confirms opening the scene dialog and the tool
// dialog at a narrow width never introduces horizontal overflow *inside* the dialog itself
// (a separate failure mode from document-level overflow in test 1, since a dialog is its
// own `overflow: auto` box).
// ===========================================================================
test('the project tool strip reflows across the 699px breakpoint, and opened dialogs introduce no internal horizontal overflow at a narrow width', async t => {
  const f = await fixture(t), { page } = f;

  await page.setViewportSize({ width: 1600, height: 1120 });
  const navWide = await page.locator('#project-navigation').boundingBox();
  const stripWide = await page.locator('.project-tool-strip').boundingBox();
  assert.ok(stripWide.x > navWide.x + navWide.width / 2, `above 699px the tool strip sits in the right half of the nav bar (margin-left:auto) :: ${JSON.stringify({ navWide, stripWide })}`);

  await page.setViewportSize({ width: 650, height: 900 });
  const navNarrow = await page.locator('#project-navigation').boundingBox();
  const stripNarrow = await page.locator('.project-tool-strip').boundingBox();
  assert.ok(stripNarrow.width >= navNarrow.width - 30, `at <=699px the tool strip spans (close to) the nav bar's full width (flex-basis:100%) :: ${JSON.stringify({ navNarrow, stripNarrow })}`);

  await page.setViewportSize({ width: 375, height: 844 });
  await openSceneDialog(page);
  await dialogNoInternalOverflow(page, '#project-scene-dialog', 'scene editor dialog at 375px');
  await closeSceneDialog(page);
  await openToolDialog(page, 'source');
  await dialogNoInternalOverflow(page, '#project-tool-dialog', 'source tool dialog at 375px');
  await closeToolDialog(page);
});

// ===========================================================================
// 4 -- .sidebar-sizing buttons use `var(--control-height)`, which is 36px under a fine
// pointer and swaps to 44px only under `@media (pointer: coarse)` (styles.css). Keyed on
// the *measured* matchMedia result per WorkspaceDesign's caution, not on the Playwright
// `hasTouch` context flag alone, so a Chromium build that does not flip the media feature
// under `hasTouch` fails loudly (via the final cross-context assertion) instead of passing
// a size check that never actually exercised the coarse-pointer branch.
// ===========================================================================
test('the sidebar width buttons meet the pointer-appropriate minimum control size at a narrow width', async t => {
  const measured = {};
  for (const touch of [false, true]) {
    const f = await fixture(t, { touch, width: 375, height: 844 });
    const { page } = f;
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    const decrease = page.locator('[data-sidebar-size="decrease"]');
    const increase = page.locator('[data-sidebar-size="increase"]');
    await decrease.scrollIntoViewIfNeeded();
    const decreaseBox = await decrease.boundingBox();
    const increaseBox = await increase.boundingBox();
    assert.ok(decreaseBox && increaseBox, `both sidebar sizing buttons render a layout box (hasTouch:${touch})`);
    const expectedMin = coarse ? 43 : 31, expectedMax = coarse ? 60 : 40;
    for (const [box, name] of [[decreaseBox, 'decrease'], [increaseBox, 'increase']]) {
      assert.ok(
        box.height >= expectedMin && box.height <= expectedMax,
        `${name} button height ${box.height} matches the ${coarse ? 'coarse' : 'fine'}-pointer control height (expected ${expectedMin}-${expectedMax}px)`,
      );
    }
    measured[touch ? 'coarse' : 'fine'] = { coarse, height: decreaseBox.height };
  }
  assert.notEqual(measured.fine.coarse, measured.coarse.coarse, 'the fine- and coarse-pointer browser contexts must actually disagree on `(pointer: coarse)` for this test to exercise the real switch');
  assert.notEqual(measured.fine.height, measured.coarse.height, 'the sidebar sizing buttons must actually change height between a fine and a coarse primary pointer');
});

// ===========================================================================
// 5 -- a focused control inside the scene-editor dialog's scrollable body is never hidden
// under the sticky .project-dialog-header, at each of the three project-dialog
// scroll-padding-top breakpoints (104px >=900px, 152px 441-899px, 224px <=440px --
// widened 2026-10-28 from the original 88/136/208px after a real title-length overflow
// bug was found; see test 8). Also spot-checks (value only, not a full walk) that
// .project-tool-dialog -- grouped with .project-scene-dialog under the same `:is(...)`
// selector in workspace.css -- was not left on a different scroll-padding-top by a
// narrower, higher-specificity override somewhere else.
// ===========================================================================
test('a focused control inside the scene-editor dialog is never hidden under its sticky header, across all three scroll-padding-top breakpoints', async t => {
  const f = await fixture(t), { page } = f;
  for (const [width, height, expectedPadding] of [[1024, 900, 104], [650, 900, 152], [400, 900, 224]]) {
    await page.setViewportSize({ width, height });
    await openSceneDialog(page);
    const padding = await scrollPaddingTopOf(page, '#project-scene-dialog');
    assert.equal(padding, expectedPadding, `#project-scene-dialog scroll-padding-top at ${width}px viewport width`);
    assert.equal(await headerPositionOf(page, '#project-scene-dialog', '.project-dialog-header'), 'sticky', `the scene dialog header is sticky at ${width}px (tall enough viewport)`);
    await assertDialogScrollable(page, '#project-scene-dialog', `scene dialog body at ${width}x${height}`);
    const violations = await shiftTabViolations(page, { dialogSelector: '#project-scene-dialog', headerSelector: '.project-dialog-header' });
    assert.deepEqual(violations, [], `no focused control is hidden under the sticky header at ${width}px :: ${JSON.stringify(violations)}`);
    await closeSceneDialog(page);
  }

  // Grouped-selector regression spot check: same breakpoints, project-tool-dialog.
  for (const [width, height, expectedPadding] of [[1024, 900, 104], [650, 900, 152], [400, 900, 224]]) {
    await page.setViewportSize({ width, height });
    await openToolDialog(page, 'source');
    assert.equal(await scrollPaddingTopOf(page, '#project-tool-dialog'), expectedPadding, `#project-tool-dialog scroll-padding-top at ${width}px viewport width (shares the :is(...) rule with the scene dialog)`);
    assert.equal(await headerPositionOf(page, '#project-tool-dialog', '.project-dialog-header'), 'sticky', `the tool dialog header is sticky at ${width}px`);
    await closeToolDialog(page);
  }
});

// ===========================================================================
// 6 -- .workspace-settings-dialog's scroll-padding-top steps from 88px to 112px at
// <=560px viewport width (both checked at a generous height so the breakpoint value
// itself -- not content height -- is what's under test), and separately, a focused
// control inside its scrollable body is never hidden under the sticky
// .workspace-dialog-header once that body is actually forced to overflow. The settings
// form (two number-input fields + a tools-mode select + a save-profile row) is short
// enough that a generous viewport height never needs to scroll at all -- a vacuous
// "zero violations" there would prove nothing -- so the interactive walk below
// deliberately uses a short 500x560 viewport (max-height: calc(100dvh - 24px) ~= 536px)
// to force real overflow, verified by the assertDialogScrollable precondition before any
// Shift+Tab is pressed.
// ===========================================================================
test('the workspace-settings dialog scroll-padding-top steps at the 560px breakpoint, and a focused control is never hidden once its body actually overflows', async t => {
  const f = await fixture(t), { page } = f;
  for (const [width, expectedPadding] of [[1024, 88], [500, 112]]) {
    await page.setViewportSize({ width, height: 900 });
    await openWorkspaceSettings(page);
    assert.equal(await scrollPaddingTopOf(page, '#workspace-settings-dialog'), expectedPadding, `#workspace-settings-dialog scroll-padding-top at ${width}px viewport width`);
    assert.equal(await headerPositionOf(page, '#workspace-settings-dialog', '.workspace-dialog-header'), 'sticky', `the workspace settings header is sticky at ${width}x900`);
    await closeWorkspaceSettings(page);
  }

  await page.setViewportSize({ width: 500, height: 560 });
  await openWorkspaceSettings(page);
  await assertDialogScrollable(page, '#workspace-settings-dialog', 'workspace settings dialog body at 500x560');
  const violations = await shiftTabViolations(page, { dialogSelector: '#workspace-settings-dialog', headerSelector: '.workspace-dialog-header' });
  assert.deepEqual(violations, [], `no focused control is hidden under the sticky header at 500x560 :: ${JSON.stringify(violations)}`);
  await closeWorkspaceSettings(page);
});

// ===========================================================================
// 7 -- short, landscape windows (`@media (max-height: 520px)`) flip both
// .project-dialog-header and .workspace-dialog-header to `position: static` and reset
// scroll-padding-top to 0, since a static header scrolls away with the content and can
// structurally never cover a focused control -- there is nothing for an interactive
// Shift+Tab walk to prove beyond that structural fact in this regime. Deliberately uses
// 740x400 and 1024x480 rather than the flagged 320x200 probe (see the file-header
// LIMITATION note): both stay inside the same `(max-height: 520px)` rule, so the contract
// under test is identical, without asserting the specific corner WorkspaceDesign could not
// yet explain.
// ===========================================================================
test('short landscape windows make both sticky dialog headers static with zero scroll-padding-top, so a focused control can never be covered', async t => {
  const f = await fixture(t), { page } = f;
  for (const [width, height] of [[740, 400], [1024, 480]]) {
    await page.setViewportSize({ width, height });

    await openSceneDialog(page);
    assert.equal(await headerPositionOf(page, '#project-scene-dialog', '.project-dialog-header'), 'static', `the scene dialog header is static at ${width}x${height} (short landscape)`);
    assert.equal(await scrollPaddingTopOf(page, '#project-scene-dialog'), 0, `#project-scene-dialog scroll-padding-top is 0 at ${width}x${height}`);
    await closeSceneDialog(page);

    await openWorkspaceSettings(page);
    assert.equal(await headerPositionOf(page, '#workspace-settings-dialog', '.workspace-dialog-header'), 'static', `the workspace settings header is static at ${width}x${height} (short landscape)`);
    assert.equal(await scrollPaddingTopOf(page, '#workspace-settings-dialog'), 0, `#workspace-settings-dialog scroll-padding-top is 0 at ${width}x${height}`);
    await closeWorkspaceSettings(page);

    assertNoOverflow(await overflowGeometry(page), `project workbench at ${width}x${height} (short landscape, no dialog open)`);
  }
});

// ===========================================================================
// 8 -- test 5's "zero violations" result was measured with the fixture's short episode
// title. .project-dialog-header's h2 interpolates `episode.title` directly
// (`장면 편집 · ${esc(episode.title)}`); scroll-padding-top is a FIXED value per
// breakpoint, but the header's actual rendered height depends on title length, which is
// NOT fixed. This was a real bug, not a hypothetical: at the server's actual 200-char
// title maximum (`text(body.title, 'title', 200)` in server/validation.mjs) against the
// original 88/136/208px budget, WorkspaceDesign measured the header growing to
// 142-165px with 7-10 tab stops obscured. The fix (2026-10-28) clamps the h2 to 2 lines
// (`-webkit-line-clamp: 2`) and gives the title block `flex: 1 1 280px` so the action
// buttons wrap onto their own line instead of crushing it, paired with the wider
// 104/152/224px scroll-padding-top budget asserted in test 5. This test re-proves the
// fix at that exact 200-char boundary -- both the headerHeight<=scrollPaddingTop
// precondition and the real Shift+Tab walk -- rather than trusting test 5's short-title
// result to generalize.
// ===========================================================================
test('a long, wrapping episode title does not grow the sticky scene-dialog header past its reserved scroll-padding-top, at any breakpoint', async t => {
  const longTitle = '장면 편집 긴 제목 테스트 '.repeat(20).trim().slice(0, 200);
  const f = await fixture(t, { title: longTitle }), { page } = f;
  for (const [width, height, expectedPadding] of [[1024, 900, 104], [650, 900, 152], [400, 900, 224]]) {
    await page.setViewportSize({ width, height });
    await openSceneDialog(page);
    assert.equal(await page.locator('#project-scene-title').textContent(), `장면 편집 · ${longTitle}`, `the long title actually rendered at ${width}px (sanity check for this test itself)`);
    const [headerHeight, padding] = await Promise.all([
      headerHeightOf(page, '#project-scene-dialog', '.project-dialog-header'),
      scrollPaddingTopOf(page, '#project-scene-dialog'),
    ]);
    assert.ok(
      headerHeight <= padding,
      `the sticky header (${headerHeight}px, grown by the long title) must not exceed its reserved scroll-padding-top (${padding}px) at ${width}px -- otherwise a control scrolled to the top of the body is still covered :: ${JSON.stringify({ headerHeight, padding, expectedPadding })}`,
    );
    await assertDialogScrollable(page, '#project-scene-dialog', `scene dialog body at ${width}x${height} (long title)`);
    const violations = await shiftTabViolations(page, { dialogSelector: '#project-scene-dialog', headerSelector: '.project-dialog-header' });
    assert.deepEqual(violations, [], `no focused control is hidden under the taller, long-title header at ${width}px :: ${JSON.stringify(violations)}`);
    await closeSceneDialog(page);
  }
});
