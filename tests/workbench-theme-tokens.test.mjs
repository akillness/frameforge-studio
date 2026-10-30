// Browser contract for DESIGN.md section 2: the studio workbench (index.html) and the blog
// workspace (blog.html) share ONE bright theme declared in public/styles.css :root. Every listed
// token must resolve to the contract value on both pages, at desktop and at the 375px QA width,
// and the essential text/control pairs must meet WCAG 2.2 AA when computed from the live values.
//
// Isolated createApp + temp data dir + mock providers, patterned on tests/node-workbench.test.mjs
// and tests/blog-workspace.test.mjs. No live service, no real provider, no project data, no
// mutating UI calls: this file only reads computed CSS custom properties.
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

// DESIGN.md section 2 "Color" contract table, verbatim. These are the ONLY values this file asserts.
const LIGHT_TOKENS = {
  canvas: '#f6f7fb', surface: '#ffffff', surfaceSide: '#f1f3f9', surfaceSubtle: '#eef1f8',
  ink: '#1b2130', textSecondary: '#485166', muted: '#5b6478',
  line: '#e1e5ee', lineStrong: '#868fa3',
  accent: '#3451e0', accentSoft: '#ebefff', onAccent: '#ffffff',
  success: '#1c7350', successSoft: '#e6f5ed',
  warning: '#8f5600', warningSoft: '#fff3dc',
  danger: '#b93a2c', dangerSoft: '#fdecea',
  focus: '#1f36b8',
};

function hexToRgb(hex) {
  const n = parseInt(hex.trim().replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Chromium reports a custom property's computed value as the raw declared text (e.g.
// "#f5f4ef"), not normalized to rgb() the way a resolved color property like `color` would
// be. Normalize to "r,g,b" anyway so this assertion is not sensitive to incidental
// whitespace or to a future token author switching the declared syntax to rgb()/hsl().
function normalizeColor(value) {
  const text = String(value ?? '').trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) { const { r, g, b } = hexToRgb(text); return `${r},${g},${b}`; }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) { const [r, g, b] = rgb[1].split(',').slice(0, 3).map((part) => Math.round(parseFloat(part))); return `${r},${g},${b}`; }
  return text;
}

function relativeLuminance({ r, g, b }) {
  const linear = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

// WCAG 2.x contrast ratio, computed from the live rendered hex values (not hardcoded), so a
// future "technically light but low-contrast" regression is still caught even if it never
// touches these exact hex strings.
function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexToRgb(hexA));
  const lb = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(la, lb), darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameforge-theme-tokens-'));
  const forbidden = async () => { assert.fail('Reading computed theme tokens must never invoke a production/provider effect'); };
  const instant = new Date('2026-10-25T00:00:00Z');
  const app = createApp({
    dataDir, loginToken: '', publicOrigin: '',
    integrations: { integrationStatus: async () => ({ studio: { available: false } }), runAgent: forbidden, fetchTrends: forbidden },
    generation: { capability: async () => ({ available: false }), models: forbidden, modelSchema: forbidden, estimate: forbidden, create: forbidden, submit: forbidden, status: forbidden },
    speech: { listVoices: async () => ({ available: false, voices: [] }), synthesize: forbidden },
    mediaOptions: { fetchImpl: forbidden }, youtubeOptions: { clientId: '', clientSecret: '', redirectUri: '', fetchImpl: forbidden },
    publicationOptions: { fetchImpl: forbidden }, renderer: forbidden,
    blogOptions: {
      loadSources: async () => ({ workspace: { version: 'fixture-v1', latest: true, sourceRoots: [], sourceEvidence: [], refreshedAt: instant.toISOString(), blockedReasons: [] }, accounts: [] }),
      automation: { status: () => ({ agents: [], routing: { profile: 'jeopi', backend: 'none', status: 'unavailable', detail: 'theme-token fixture' } }), route: forbidden, draft: forbidden, login: forbidden, deploy: forbidden },
      research: forbidden,
      referenceOptions: { inspectImpl: forbidden },
      now: () => instant,
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const writes = [], external = [], errors = [];
  await context.route('**/*', (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.href); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname });
    return route.continue();
  });
  t.after(async () => {
    await context.close(); await browser.close();
    await new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.deepEqual(external, [], 'browser external traffic is blocked');
    assert.deepEqual(errors, [], 'neither the workbench nor the blog page may throw while only reading computed theme tokens');
    assert.deepEqual(writes, [], 'reading computed CSS custom properties must never issue a mutating request');
  });
  async function openPage(path, readySelector) {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
    await page.goto(base + path);
    await page.locator(readySelector).waitFor();
    return page;
  }
  async function readRootTokens(page) {
    return page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const read = (name) => style.getPropertyValue(name).trim();
      return {
        colorScheme: style.colorScheme,
        canvas: read('--canvas'), surface: read('--surface'), surfaceSide: read('--surface-side'), surfaceSubtle: read('--surface-subtle'),
        ink: read('--ink'), textSecondary: read('--text-secondary'), muted: read('--muted'),
        line: read('--line'), lineStrong: read('--line-strong'),
        accent: read('--accent'), accentSoft: read('--accent-soft'), onAccent: read('--on-accent'),
        success: read('--success'), successSoft: read('--success-soft'),
        warning: read('--warning'), warningSoft: read('--warning-soft'),
        danger: read('--danger'), dangerSoft: read('--danger-soft'),
        focus: read('--focus'),
      };
    });
  }
  return { base, openPage, readRootTokens };
}

function normalizedTokenSet(tokens) {
  const out = { colorScheme: tokens.colorScheme };
  for (const key of Object.keys(LIGHT_TOKENS)) out[key] = normalizeColor(tokens[key]);
  return out;
}

// Essential pairs from DESIGN.md section 2, computed from the live rendered tokens (not the table),
// so a technically-light but low-contrast regression still fails.
const CONTRAST_PAIRS = [
  ['ink', 'canvas', 4.5], ['ink', 'surface', 4.5], ['textSecondary', 'surface', 4.5], ['textSecondary', 'canvas', 4.5],
  ['muted', 'surface', 4.5], ['muted', 'surfaceSide', 4.5], ['muted', 'surfaceSubtle', 4.5],
  ['accent', 'surface', 4.5], ['accent', 'accentSoft', 4.5], ['onAccent', 'accent', 4.5],
  ['success', 'successSoft', 4.5], ['warning', 'warningSoft', 4.5], ['danger', 'dangerSoft', 4.5],
  ['lineStrong', 'surface', 3], ['lineStrong', 'canvas', 3], ['focus', 'surface', 3], ['focus', 'surfaceSide', 3],
];

function assertContract(tokens, label) {
  const expected = { colorScheme: 'light' };
  for (const [key, hex] of Object.entries(LIGHT_TOKENS)) expected[key] = normalizeColor(hex);
  assert.deepEqual(normalizedTokenSet(tokens), expected, `${label}: every DESIGN.md section 2 token must resolve to its single bright-theme value`);
  for (const [fg, bg, min] of CONTRAST_PAIRS) {
    const ratio = contrastRatio(tokens[fg], tokens[bg]);
    assert.ok(ratio >= min, `${label}: --${fg} on --${bg} must meet WCAG AA ${min}:1 (got ${ratio.toFixed(2)}:1)`);
  }
}

test('the studio workbench and the blog resolve one bright DESIGN.md section 2 theme at desktop and 375px, with AA contrast on every essential pair', async (t) => {
  const f = await fixture(t);
  for (const [path, ready, label] of [['/', '#app .shell', 'workbench'], ['/blog.html', '#blog-main', 'blog']]) {
    const page = await f.openPage(path, ready);
    const desktop = await f.readRootTokens(page);
    assertContract(desktop, `${label} 1440px`);
    const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(normalizeColor(bodyBackground), normalizeColor(LIGHT_TOKENS.canvas), `${label}: the rendered page ground actually uses the bright canvas token`);
    // DESIGN.md section 8 QA width: root tokens are not media-dependent, so a narrow-viewport-only
    // dark or alternate branch is a regression.
    await page.setViewportSize({ width: 375, height: 812 });
    assert.deepEqual(normalizedTokenSet(await f.readRootTokens(page)), normalizedTokenSet(desktop), `${label}: root theme tokens must not differ between 1440px and 375px`);
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), LIGHT_TOKENS.canvas, `${label}: browser theme-color matches the shared canvas token`);
  }
});
