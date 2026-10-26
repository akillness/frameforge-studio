import path from 'node:path';
import { realpath, readFile, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { HttpError } from './validation.mjs';

const contexts = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');
const accounts = [
  { id: 'naver-banggujin', platform: 'naver', accountId: 'banggujin', label: 'Naver · banggujin', directory: 'naver-blog-banggujin', personaFile: 'persona/parkjen-persona.md' },
  { id: 'naver-jelly_ggumi', platform: 'naver', accountId: 'jelly_ggumi', label: 'Naver · jelly_ggumi', directory: 'naver-blog-jelly_ggumi', personaFile: 'persona/persona.md' },
  { id: 'naver-jennie_p', platform: 'naver', accountId: 'jennie_p', label: 'Naver · jennie_p', directory: 'naver-blog-jennie_p', personaFile: 'persona/persona.md' },
  { id: 'tistory', platform: 'tistory', accountId: '', label: 'Tistory', directory: 'tistory', publicUrl: 'https://jellyggumi-journal.tistory.com/', provenance: 'https://jellyggumi-journal.tistory.com/m/category/Living%20in%20Korea' },
  { id: 'github-jellyggumi', platform: 'github', accountId: 'jellyggumi', label: 'GitHub Pages · jellyggumi', directory: 'github-jellyggumi', publicUrl: 'https://jellyggumi.github.io/', provenance: 'https://api.github.com/users/jellyggumi' },
];
const sharedFiles = ['aside-publish-guide.md', 'aside-session-continuity.md', 'category-rotation-policy.json', 'category-rotation-state.json', 'publish-slot-ledger.json', 'daily-intelligence/LATEST.md', 'scripts/diagnose-myinfo.py'];
const safeText = (value, limit = 500) => typeof value === 'string' ? value.replace(/(?:bearer\s+\S+|(?:api[_-]?key|password|access[_-]?token|secret)\s*[:=]\s*\S+)/gi, '[redacted]').slice(0, limit) : '';
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 100).map(item => safeText(item, 200)) : [];
function publicUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url.href : ''; } catch { return ''; }
}
function json(text) { try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } }

export async function requestBlogBridge(route, payload, { env = process.env, fetchImpl = fetch, timeout = 180000 } = {}) {
  if (!['/blog/sources', '/blog/status', '/blog/route', '/blog/draft', '/blog/login', '/blog/deploy-plan', '/blog/deploy', '/run'].includes(route)) throw new HttpError(400, 'Unsupported blog bridge operation');
  let base;
  try {
    base = new URL(env.AGENT_BRIDGE_URL);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || !['http:', 'https:'].includes(base.protocol)) throw new Error();
    if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(base.hostname)) throw new Error();
  } catch { throw new HttpError(503, 'Configure an authenticated trusted AGENT_BRIDGE_URL host bridge.'); }
  if (typeof env.AGENT_BRIDGE_TOKEN !== 'string' || env.AGENT_BRIDGE_TOKEN.length < 24) throw new HttpError(503, 'Configure the private host bridge authentication token.');
  let response;
  try {
    response = await fetchImpl(new URL(route, base), { method: 'POST', headers: { authorization: `Bearer ${env.AGENT_BRIDGE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) {
      let message = '';
      try { message = safeText((await response.json()).error, 900); } catch {}
      if ([400, 409, 429, 503].includes(response.status) && message) throw new HttpError(response.status, message);
      throw new Error();
    }
    const reader = response.body?.getReader();
    let text = '';
    if (reader) {
      const decoder = new TextDecoder(); let bytes = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error(); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } else text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error();
    return JSON.parse(text);
  } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, response?.status === 401 ? 'Host bridge authentication failed.' : 'Host blog adapter unavailable; inspect host prerequisites. No automatic retry was attempted.'); }
}

// Only inspected canonical files are read; LATEST is history, not proof of current login or publication.
export async function loadBlogSources(options = {}) {
  const { env = process.env, home = homedir(), root = env.BLOG_WORKSPACE_ROOT || env.BLOG_SOURCE_ROOT || path.join(home, 'wiki/workspaces'), roots = {}, now = () => new Date(), fetchImpl = fetch, bridgeMode = true } = options;
  if (bridgeMode && env.AGENT_BRIDGE_URL && !Object.hasOwn(options, 'root') && !Object.keys(roots).length) return requestBlogBridge('/blog/sources', {}, { env, fetchImpl, timeout: 15000 });
  const evidence = [], texts = new Map(), blockedReasons = [], rootLabels = [], sourceConflicts = [];
  async function canonical(label, directory, name) {
    const id = `${label}/${name}`;
    let item = { id, sha256: null, bytes: 0, modifiedAt: null, status: 'missing' };
    if (directory) {
      try {
        const base = await realpath(directory), file = await realpath(path.resolve(base, name));
        const relative = path.relative(base, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe canonical source');
        const info = await stat(file);
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid canonical source');
        const bytes = await readFile(file);
        if (bytes.length > 1024 * 1024) throw new Error('Oversized canonical source');
        item = { id, sha256: hash(bytes), bytes: bytes.length, modifiedAt: info.mtime.toISOString(), status: 'invalid' };
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (name.endsWith('.json')) JSON.parse(text);
        item.status = 'loaded';
        texts.set(id, text);
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) item.status = 'invalid'; }
    }
    evidence.push(item);
    return texts.get(id) || '';
  }
  const sharedRoot = roots.shared || (root && path.join(root, 'naver-blog-shared'));
  if (sharedRoot) rootLabels.push('shared');
  for (const file of sharedFiles) await canonical('shared', sharedRoot, file);
  const policy = json(texts.get('shared/category-rotation-policy.json'));
  const rotation = json(texts.get('shared/category-rotation-state.json'));
  let recentRuns = [];
  if (sharedRoot) {
    try { recentRuns = (await readdir(path.join(sharedRoot, 'runs'), { withFileTypes: true })).filter(item => item.isDirectory() && /^\d{4}-\d{2}-\d{2}[-_]/.test(item.name)).map(item => item.name).sort().reverse().slice(0, 20); } catch {}
  }
  if (!root && !Object.keys(roots).length) blockedReasons.push('Configure BLOG_WORKSPACE_ROOT with the read-only canonical workspace parent; no source root is configured.');
  const loadedAccounts = [];
  for (const definition of accounts) {
    const directory = roots[definition.id] || (definition.platform === 'github' && env.BLOG_GITHUB_CHECKOUT) || (root && path.join(root, definition.directory));
    if (directory) rootLabels.push(definition.id);
    const latest = await canonical(definition.id, directory, 'LATEST.md');
    const persona = definition.personaFile ? await canonical(definition.id, directory, definition.personaFile) : '';
    const metadata = json(await canonical(definition.id, directory, 'blog-config.json'));
    if (definition.platform === 'github' && env.BLOG_GITHUB_CHECKOUT) {
      for (const file of ['_workspace/current/manifest.json', '_workspace/current/validation/validation.json', '_workspace/current/validation/path-scope.txt', '.claude/editorial-policy.yml', '_config.yml', 'tools/apply-editorial-package.mjs', 'tools/verify-publication-scope.mjs', 'tools/verify-deployment.mjs', 'tools/validate-editorial-package.mjs', 'tools/lib/source-images.mjs']) await canonical(definition.id, directory, file);
      const manifest = json(texts.get(`${definition.id}/_workspace/current/manifest.json`));
      if (/^_posts\/\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*\.md$/.test(manifest.article_path || '')) await canonical(definition.id, directory, `_workspace/current/draft/${manifest.article_path}`);
    }
    const githubManifest = json(texts.get(`${definition.id}/_workspace/current/manifest.json`));
    const ring = policy.blogs?.[definition.accountId]?.ring;
    const validRing = Array.isArray(ring) && ring.length > 0 && ring.every(item => item && Number.isSafeInteger(item.category_no) && item.category_no > 0 && typeof item.name === 'string' && item.name.trim() && item.name.length <= 200) && new Set(ring.map(item => item.category_no)).size === ring.length && new Set(ring.map(item => safeText(item.name, 200).trim())).size === ring.length;
    const menuEntries = validRing ? ring.map(item => ({ categoryNo: item.category_no, name: safeText(item.name, 200) })) : [];
    const menus = menuEntries.length ? menuEntries.map(item => item.name) : strings(metadata.menus);
    const next = rotation.blogs?.[definition.accountId]?.next;
    const index = definition.platform === 'naver' ? menuEntries.findIndex(item => item.categoryNo === next?.category_no && item.name === next?.category) : Number.isSafeInteger(metadata.menuCursor) && metadata.menuCursor >= 0 && metadata.menuCursor < menus.length ? metadata.menuCursor : -1;
    const currentSection = latest.match(/^# Current source pointers\s*\r?\n([\s\S]*?)(?=^# Historical snapshot|$(?![\s\S]))/m)?.[1];
    const pointerRefreshedAt = currentSection?.match(/Pointer refresh:\s*`([^`]+)`/)?.[1] || null;
    const pointerState = currentSection?.match(/Rotation source updated_at:\s*`([^`]+)`/)?.[1] || null;
    const pointerDate = pointerState?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || (!currentSection ? latest.match(/\d{4}-\d{2}-\d{2}/)?.[0] : null) || null;
    const lastVerified = rotation.blogs?.[definition.accountId]?.last_verified;
    const verifiedDate = String(lastVerified?.slot_key || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] || null;
    const pointerCategory = currentSection?.match(/Current next category:\s*`(\d+)`\s*\/\s*`([^`]+)`/);
    const pointerStale = currentSection ? pointerState !== rotation.updated_at || Number(pointerCategory?.[1]) !== next?.category_no || pointerCategory?.[2] !== next?.category : Boolean(pointerDate && verifiedDate && verifiedDate > pointerDate);
    if (pointerStale) sourceConflicts.push(`${definition.id}: the LATEST pointer metadata does not match current canonical rotation evidence; current persona/menu/state remain authoritative and no external pointer was rewritten.`);
    let historicalPublication = null;
    for (const run of recentRuns) {
      if (definition.platform !== 'naver' || !verifiedDate || run.slice(0, 10) < verifiedDate) continue;
      const file = `runs/${run}/${definition.accountId}/closeout.json`;
      const closeout = json(await canonical('shared', sharedRoot, file));
      if (closeout.profile === definition.accountId && String(closeout.logNo) === String(lastVerified?.logNo) && closeout.status === 'published_verified') {
        historicalPublication = { status: 'historical-reported', date: safeText(closeout.verification_timestamp || closeout.verified_at, 60), logNo: String(closeout.logNo), categoryNo: Number(closeout.categoryNo), sourceId: `shared/${file}` };
        break;
      }
    }
    const reasons = [], metadataRequirements = [];
    if (!latest && !(definition.platform === 'github' && githubManifest.status)) reasons.push(definition.platform === 'github' ? 'Configure the real GitHub editorial _workspace/current/manifest.json source pointer.' : 'Canonical LATEST.md is missing or unreadable.');
    if (!persona && !metadata.persona) metadataRequirements.push({ field: 'persona', detail: 'Canonical persona metadata is missing.' });
    if (!menus.length) metadataRequirements.push({ field: 'menus', detail: 'Canonical menu/category metadata is missing.' });
    if (definition.platform !== 'naver' && menus.length && index < 0) metadataRequirements.push({ field: 'menus', detail: 'An explicit current menu selection is required.' });
    reasons.push(...metadataRequirements.map(item => item.detail));
    if (definition.platform === 'naver' && !validRing) reasons.push('Canonical category ring is missing, malformed or contains duplicate numeric identities or ambiguous labels; partial or ambiguous taxonomy was not used.');
    if (definition.platform === 'naver' && index < 0) reasons.push('Canonical next category is missing or does not match the current category ring.');
    if (definition.platform === 'tistory') reasons.push('Tistory account identity and an inspected browser/editor publisher remain unconfigured; the retired Open API is not a supported transport.');
    if (definition.platform === 'github' && (!env.BLOG_GITHUB_CHECKOUT || !githubManifest.status)) reasons.push('Configure BLOG_GITHUB_CHECKOUT with the real editorial package; public repository proof alone does not establish a configured publisher.');
    const accountEvidence = evidence.filter(item => item.id.startsWith(`${definition.id}/`) || item.id.startsWith('shared/'));
    const result = {
      id: definition.id, platform: definition.platform, label: definition.label, accountId: definition.accountId || safeText(metadata.accountId, 100), metadataRequirements,
      persona: safeText(metadata.persona || persona.match(/^#\s+(.+)$/m)?.[1], 400), keywords: strings(metadata.keywords), menus,
      menuCursor: index, menuEntries, nextMenu: index >= 0 ? menuEntries[index] || { name: menus[index], categoryNo: null } : null,
      latestRecord: { date: definition.platform === 'github' ? safeText(githubManifest.approved_at_kst, 60) || null : pointerDate, pointerRefreshedAt, status: definition.platform === 'github' && githubManifest.status ? 'configured-editorial-manifest-not-live-verification' : !latest ? 'missing' : pointerStale ? 'stale' : currentSection ? 'current-pointers-not-live-verification' : 'loaded-history' }, historicalPublication,
      publicUrl: definition.platform === 'naver' ? `https://blog.naver.com/${definition.accountId}` : publicUrl(metadata.publicUrl) || definition.publicUrl,
      ...(definition.provenance ? { publicTargetProvenance: { url: definition.provenance, status: 'public-reference-only', ownershipVerified: false } } : {}),
      editorUrl: '', sourceEvidence: accountEvidence,
      connection: { status: 'unverified', detail: reasons.join(' ') || 'Canonical sources loaded; account login and publication have not been exercised.' },
    };
    loadedAccounts.push(result);
    for (const reason of reasons) blockedReasons.push(`${definition.id}: ${reason}`);
  }
  for (const file of ['aside-publish-guide.md', 'category-rotation-policy.json', 'category-rotation-state.json', 'publish-slot-ledger.json']) {
    if (!texts.has(`shared/${file}`)) blockedReasons.push(`Required shared canonical source ${file} is missing or invalid.`);
  }
  const version = `sha256:${hash(JSON.stringify({ sources: evidence.map(item => [item.id, item.status, item.sha256]), targets: loadedAccounts.map(item => [item.id, item.publicUrl]) }))}`;
  const requiredLoaded = evidence.filter(item => !item.id.endsWith('/blog-config.json') && !item.id.includes('/runs/') && !(item.id === 'github-jellyggumi/LATEST.md' && texts.has('github-jellyggumi/_workspace/current/manifest.json'))).every(item => item.status === 'loaded');
  const workspace = { version, latest: requiredLoaded && sourceConflicts.length === 0, sourceRoots: rootLabels, sourceEvidence: evidence, refreshedAt: new Date(now()).toISOString(), blockedReasons, sourceConflicts };
  contexts.set(workspace, { texts, sharedRoot, accountRoots: Object.fromEntries(accounts.map(definition => [definition.id, roots[definition.id] || (definition.platform === 'github' && env.BLOG_GITHUB_CHECKOUT) || (root && path.join(root, definition.directory))])) });
  return { workspace, accounts: loadedAccounts };
}

// Server-only access. Private rule/persona bodies never become enumerable public state.
export function blogSourceContext(workspace) { return contexts.get(workspace); }
