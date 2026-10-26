import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync, createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execute } from './process.mjs';
import { HttpError } from './validation.mjs';
import { loadBlogSources, blogSourceContext, requestBlogBridge } from './blog-sources.mjs';
import { candidateFingerprint } from './graph.mjs';

const naverAccounts = { banggujin: 9322, jelly_ggumi: 9323, jennie_p: 9324 };
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new HttpError(503, message); };
const text = (value, limit = 600) => typeof value === 'string' ? value.replace(/(?:bearer\s+\S+|(?:api[_-]?key|password|access[_-]?token|secret)\s*[:=]\s*\S+)/gi, '[redacted]').slice(0, limit) : '';
function parseJson(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 262144) fail('Host adapter returned an invalid bounded JSON response.');
  try { return JSON.parse(output.trim()); } catch { fail('Host adapter did not return valid JSON evidence.'); }
}
function sourceUrls(brief) {
  const result = [];
  for (const item of [...(brief?.sourceEvidence || []), ...(brief?.sources || []), ...(brief?.evidence || [])]) {
    try { const url = new URL(typeof item === 'string' ? item : item.url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) result.push({ url: url.href, title: text(item.title || '', 250) }); } catch {}
  }
  return result.slice(0, 30);
}
function normalizedHtmlText(value) {
  return String(value || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&#x([0-9a-f]+);?/gi, (_, hex) => { const code = Number.parseInt(hex, 16); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; }).replace(/&#([0-9]+);?/g, (_, number) => { const code = Number(number); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; }).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}

function htmlElement(html, predicate) {
  const tokens = /<!--[\s\S]*?-->|<\/?([a-z][a-z0-9]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  let opening, depth = 0;
  for (const token of html.matchAll(tokens)) {
    if (!token[1]) continue;
    const closing = token[0].startsWith('</'), tag = token[1].toLowerCase();
    if (!opening && !closing && predicate(token[0], tag)) { opening = { start: token.index, contentStart: token.index + token[0].length, tag }; depth = 1; continue; }
    if (opening && tag === opening.tag) {
      depth += closing ? -1 : 1;
      if (!depth) return { ...opening, end: token.index + token[0].length, content: html.slice(opening.contentStart, token.index) };
    }
  }
  return null;
}
const classes = tag => (tag.match(/\sclass\s*=\s*["']([^"']*)["']/i)?.[1] || '').split(/\s+/);
const cleanHtml = html => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '');

export function blogPublicBodyMatches({ html, title, body }) {
  if (typeof html !== 'string' || typeof body !== 'string' || !body.trim()) return false;
  const source = cleanHtml(html), approved = cleanHtml(body);
  const container = htmlElement(source, (tag, name) => name === 'div' && classes(tag).includes('post-body'));
  const heading = htmlElement(source, (tag, name) => name === 'h1' && classes(tag).includes('post-heading__title'));
  if (!container || !heading || normalizedHtmlText(heading.content) !== normalizedHtmlText(title)) return false;
  const templateClasses = ['editorial-disclosure', 'article-sources', 'post-ad', 'post-author'];
  if (htmlElement(approved, tag => classes(tag).some(name => templateClasses.includes(name) || name === 'small'))) return false;
  let actual = container.content;
  for (let count = 0; count < 20; count++) {
    const template = htmlElement(actual, tag => classes(tag).some(name => templateClasses.includes(name)));
    if (!template) break;
    actual = actual.slice(0, template.start) + actual.slice(template.end);
  }
  actual = actual.replace(/<hr\b[^>]*class=["']small["'][^>]*\/?\s*>/gi, '');
  const canonical = value => value.replace(/\r\n?/g, '\n').trim();
  return canonical(actual) === canonical(approved) && normalizedHtmlText(actual) === normalizedHtmlText(approved);
}

export function createBlogAutomation({ env = process.env, home = homedir(), executeImpl = execute, fetchImpl = fetch, loadSources = loadBlogSources, bridgeMode = true, draftRunner, now = () => new Date() } = {}) {
  const harness = path.join(home, '.agents/jev/jev-harness.mjs');
  const npmRoot = env.APPDATA ? path.join(env.APPDATA, 'npm/node_modules') : path.join(home, '.local/lib/node_modules');
  const executables = {
    codex: env.CODEX_CLI || path.join(npmRoot, '@openai/codex/bin/codex.js'),
    jeopi: env.JEOPI_CLI || path.join(home, '.bun/bin', process.platform === 'win32' ? 'jeopi.exe' : 'jeopi'),
    hermes: env.HERMES_CLI || path.join(home, process.platform === 'win32' ? 'AppData/Local/hermes/hermes-agent/venv/Scripts/hermes.exe' : '.local/bin/hermes'),
    aside: path.join(home, '.aside/u/0/tools/naver-browser-harness-runtime/invoke-naver-harness.ps1'),
    antigravity: env.ANTIGRAVITY_CLI || '',
  };
  const exercised = new Set();
  const issuedRoutes = new Set();
  const packageBlobs = new WeakMap();
  let routing = { profile: 'jeopi', backend: 'api', status: 'unverified', detail: 'Explicit Jev API routing has not been exercised. No profile is enabled or modified automatically.' };
  const remote = bridgeMode && Boolean(env.AGENT_BRIDGE_URL);
  const bridge = (route, payload, timeout) => requestBlogBridge(route, payload, { env, fetchImpl, timeout });
  async function fresh(workspace, account) {
    const loaded = await loadSources({ env, home, bridgeMode: false });
    if (!workspace?.version || loaded.workspace.version !== workspace.version) throw new HttpError(409, 'Canonical latest sources changed; refresh and obtain a new approval.');
    const canonical = loaded.accounts.find(item => item.id === account?.id);
    if (!canonical || canonical.platform !== account.platform || canonical.accountId !== account.accountId) throw new HttpError(409, 'Account identity does not match the canonical source.');
    const context = blogSourceContext(loaded.workspace);
    const required = account.platform === 'github' ? `${account.id}/_workspace/current/manifest.json` : `${account.id}/LATEST.md`;
    if (!context || !canonical.sourceEvidence.some(item => item.id === required && item.status === 'loaded')) fail(account.platform === 'github' ? 'Configure BLOG_GITHUB_CHECKOUT with the real approved editorial workspace and package; no repository content was fabricated.' : 'Canonical latest workspace evidence is unavailable.');
    return { ...loaded, canonical, context };
  }
  async function githubPlan({ account, draft, workspace }) {
    if (account?.id !== 'github-jellyggumi' || account.platform !== 'github' || account.accountId !== 'jellyggumi' || !env.BLOG_GITHUB_CHECKOUT) fail('Configure BLOG_GITHUB_CHECKOUT with the exact jellyggumi/jellyggumi.github.io gh-pages checkout and its existing approved editorial package.');
    if (account.publicUrl !== 'https://jellyggumi.github.io/' && account.publicUrl !== 'https://jellyggumi.github.io') fail('The configured public target does not match the exact approved GitHub Pages repository origin.');
    const loaded = await fresh(workspace, account);
    const prefix = `${account.id}/_workspace/current/`;
    const manifest = parseJson(loaded.context.texts.get(`${prefix}manifest.json`));
    const validation = parseJson(loaded.context.texts.get(`${prefix}validation/validation.json`));
    if (manifest.status !== 'approved' || manifest.mode !== 'draft-only' || manifest.publication_requires_confirmation !== true || !/^(?:aside-confirmation|human-review):[A-Za-z0-9._-]{6,}$/.test(manifest.approval_ref || '') || !/^[a-f0-9]{64}$/.test(manifest.approval_artifact_sha256 || '')) fail('The existing GitHub package requires its own exact manual editorial approval; standing routine authority is never inherited by FrameForge.');
    if (validation.result !== 'PASS' || validation.stage !== 'final' || validation.run_id !== manifest.run_id) fail('The existing package needs matching final PASS editorial validation after manual approval.');
    if (!/^_posts\/\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9-]*\.md$/.test(manifest.article_path || '') || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.slug || '') || !Array.isArray(manifest.asset_paths) || !Array.isArray(manifest.reference_image_paths)) fail('The existing editorial package has no valid inspected article and media path schema.');
    const covers = [`img/editorial/${manifest.slug}.jpg`, `img/editorial/${manifest.slug}.thumb.jpg`].sort();
    if (JSON.stringify([...manifest.asset_paths].sort()) !== JSON.stringify(covers) || manifest.reference_image_paths.length < 4 || manifest.reference_image_paths.length > 12 || manifest.reference_image_paths.some(item => typeof item !== 'string' || !item.startsWith(`img/source/${manifest.slug}/`) || !/^img\/source\/[a-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpg|jpeg|webp)$/.test(item))) fail('The approved package must include the exact two covers and its validated 4–12 source reference images.');
    const files = [manifest.article_path, ...manifest.asset_paths, ...manifest.reference_image_paths].sort();
    const scope = (loaded.context.texts.get(`${prefix}validation/path-scope.txt`) || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean).sort();
    if (new Set(files).size !== files.length || JSON.stringify(scope) !== JSON.stringify(files) || JSON.stringify(Object.keys(validation.package_sha256 || {}).sort()) !== JSON.stringify(files)) fail('The package scope and final validation hash inventory do not exactly match the approved new file set.');
    const checkout = await realpath(env.BLOG_GITHUB_CHECKOUT), packageRoot = await realpath(path.join(checkout, '_workspace/current/draft'));
    if (path.relative(checkout, packageRoot).split(path.sep).join('/') !== '_workspace/current/draft') fail('The package draft root escapes its exact configured checkout.');
    const blobs = new Map();
    for (const relative of files) {
      const requested = path.join(packageRoot, relative), actual = await realpath(requested), info = await stat(actual);
      if (actual !== requested || !info.isFile() || info.size > 15 * 1024 * 1024) fail('Every approved package file must be a bounded regular file inside its exact draft path; symlink parents are refused.');
      const fileHash = createHash('sha256'), blobHash = createHash('sha1').update(`blob ${info.size}\0`);
      let bytes = 0;
      for await (const chunk of createReadStream(actual)) {
        bytes += chunk.length;
        if (bytes > info.size) fail('An approved package file grew during its immutable hash read.');
        fileHash.update(chunk); blobHash.update(chunk);
      }
      if (bytes !== info.size || fileHash.digest('hex') !== validation.package_sha256[relative]) fail('An approved package file changed after final validation.');
      blobs.set(relative, blobHash.digest('hex'));
    }
    const article = loaded.context.texts.get(`${prefix}draft/${manifest.article_path}`);
    const front = article?.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
    let title = front?.[1].match(/^title:\s*(.+)$/m)?.[1].trim();
    if (title?.startsWith('"')) { try { title = JSON.parse(title); } catch { fail('The approved article title is not a supported YAML scalar.'); } }
    else if (title?.startsWith("'")) title = title.replace(/^'|'$/g, '').replace(/''/g, "'");
    const body = front && article.slice(front[0].length);
    if (title !== draft?.title || typeof body !== 'string' || body.trim() !== draft?.body?.trim() || validation.package_sha256[manifest.article_path] !== digest(article)) throw new HttpError(409, 'The exact approved FrameForge title/body does not match the existing validated Jekyll HTML article. No conversion or package fabrication is performed.');
    const plan = { repository: 'https://github.com/jellyggumi/jellyggumi.github.io.git', branch: 'gh-pages', files, effects: ['local commit', 'push exact HEAD to origin/gh-pages'], artifactSha256: manifest.approval_artifact_sha256, contentHash: candidateFingerprint({ title: draft.title, body: draft.body }), workspaceVersion: workspace.version };
    const result = { ...plan, planHash: candidateFingerprint({ plan, accountVersion: account.version, draftVersion: draft.version, referenceId: draft.referenceId, referenceFingerprint: draft.referenceFingerprint, appliedFormattingPlan: draft.appliedFormattingPlan }) };
    packageBlobs.set(result, blobs);
    return result;
  }
  async function publishGithub(input) {
    const { account, draft, approval, gitConsent, workspace } = input;
    const plan = await githubPlan(input);
    if (gitConsent?.approved !== true || gitConsent.planHash !== plan.planHash || input.plan?.planHash !== plan.planHash) throw new HttpError(409, 'Separate consent to the exact repository, branch, files and local commit/push plan is required.');
    if (approval.contentHash !== plan.contentHash) throw new HttpError(409, 'GitHub publication content differs from the current owner approval.');
    const checkout = await realpath(env.BLOG_GITHUB_CHECKOUT);
    const run = (binary, args, timeout = 90000) => executeImpl(binary, args, { cwd: checkout, env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GH_PROMPT_DISABLED: '1' }, timeout, maxBytes: 262144 });
    const git = args => run(env.GIT_CLI || 'git', ['-c', 'core.hooksPath=' + path.join(checkout, '.git/frameforge-disabled-hooks'), ...args]);
    const tool = async (name, args = [], timeout) => {
      const script = await realpath(path.join(checkout, 'tools', name));
      if (path.relative(checkout, script).split(path.sep).join('/') !== `tools/${name}`) fail('Publisher script is outside its exact configured repository path.');
      return run(process.execPath, [script, '--root', checkout, ...args], timeout);
    };
    let pushed = false, pushStarted = false, committedSha = null;
    try {
      const who = parseJson((await run(env.GH_CLI || 'gh', ['api', 'user'])).stdout);
      const repo = parseJson((await run(env.GH_CLI || 'gh', ['api', 'repos/jellyggumi/jellyggumi.github.io'])).stdout);
      if (who.login !== account.accountId || repo.full_name !== 'jellyggumi/jellyggumi.github.io' || repo.permissions?.push !== true || repo.default_branch !== 'gh-pages' || repo.has_pages !== true) fail('GitHub authenticated identity and exact repository write/Pages target were not confirmed.');
      if ((await git(['branch', '--show-current'])).stdout.trim() !== 'gh-pages' || !['https://github.com/jellyggumi/jellyggumi.github.io.git', 'git@github.com:jellyggumi/jellyggumi.github.io.git'].includes((await git(['remote', 'get-url', 'origin'])).stdout.trim())) fail('The configured checkout does not match the approved gh-pages repository.');
      if ((await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()) fail('GitHub checkout is not clean; unrelated work is preserved and publication is blocked.');
      const expectedRemotes = ['https://github.com/jellyggumi/jellyggumi.github.io.git', 'git@github.com:jellyggumi/jellyggumi.github.io.git'];
      const pushUrls = (await git(['remote', 'get-url', '--push', '--all', 'origin'])).stdout.trim().split(/\r?\n/).filter(Boolean);
      if (pushUrls.length !== 1 || !expectedRemotes.includes(pushUrls[0])) fail('The effective origin push URLs do not match the single separately approved repository.');
      const baseSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      const remoteSha = (await git(['ls-remote', 'https://github.com/jellyggumi/jellyggumi.github.io.git', 'refs/heads/gh-pages'])).stdout.trim().split(/\s+/)[0];
      if (!/^[a-f0-9]{40}$/.test(baseSha) || remoteSha !== baseSha) fail('Local HEAD is not the exact current remote gh-pages base; unrelated ahead/behind commits cannot be published.');
      const applied = parseJson((await tool('apply-editorial-package.mjs')).stdout);
      if (applied.staged !== false || JSON.stringify([...(applied.copied || [])].sort()) !== JSON.stringify(plan.files)) fail('The repository apply tool did not copy exactly the approved package.');
      await git(['add', '--', ...plan.files]);
      await tool('verify-publication-scope.mjs', ['--staged']);
      const cached = (await git(['diff', '--cached', '--name-only'])).stdout.trim().split(/\r?\n/).filter(Boolean).sort();
      if (JSON.stringify(cached) !== JSON.stringify(plan.files)) fail('The staged paths differ from the separately approved Git publication scope.');
      if ((await githubPlan(input)).planHash !== plan.planHash) throw new HttpError(409, 'Canonical Git publication approval changed before commit; inspect the preserved staged package.');
      await git(['commit', '-m', `Publish approved blog draft ${draft.id}`]);
      const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      if (!/^[a-f0-9]{40}$/.test(sha)) fail('The publication commit did not return an exact SHA.');
      committedSha = sha;
      const outgoing = (await git(['diff-tree', '--no-commit-id', '--name-status', '-r', sha])).stdout.trim().split(/\r?\n/).filter(Boolean).sort();
      if (JSON.stringify(outgoing) !== JSON.stringify(plan.files.map(file => `A\t${file}`).sort())) fail('The immutable outgoing commit adds paths outside the separately approved package.');
      const tree = (await git(['ls-tree', '-r', sha, '--', ...plan.files])).stdout.trim().split(/\r?\n/).filter(Boolean);
      const frozenBlobs = packageBlobs.get(plan);
      if (tree.length !== plan.files.length || tree.some(line => { const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(line); return !match || frozenBlobs?.get(match[2]) !== match[1]; })) fail('The immutable outgoing commit bytes or file modes do not match the frozen approved package.');
      const finalPushUrls = (await git(['remote', 'get-url', '--push', '--all', 'origin'])).stdout.trim().split(/\r?\n/).filter(Boolean);
      if ((await git(['rev-parse', `${sha}^`])).stdout.trim() !== baseSha || finalPushUrls.length !== 1 || !expectedRemotes.includes(finalPushUrls[0])) fail('The outgoing commit parent or effective push target changed; no push was attempted.');
      pushStarted = true;
      await git(['push', '--no-follow-tags', '--recurse-submodules=no', 'origin', `${sha}:refs/heads/gh-pages`]);
      pushed = true;
      const proof = parseJson((await tool('verify-deployment.mjs', ['--wait-seconds', '120'], 170000)).stdout);
      if (proof.pushed_sha !== sha || proof.remote_sha !== sha || proof.workflow_sha !== sha || proof.workflow_conclusion !== 'success' || proof.approval_artifact_sha256 !== plan.artifactSha256 || proof.permalink_status !== 200 || proof.title_check !== true || proof.body_check !== true || proof.source_credits_check !== true || !Array.isArray(proof.image_urls) || proof.image_urls.length !== plan.files.length - 1 || !proof.image_urls.every(item => item.status === 200 && /^[a-f0-9]{64}$/.test(item.sha256)) || !/^https:\/\/jellyggumi\.github\.io\/journal\/[a-z0-9-]+\/$/.test(proof.permalink || '')) throw new Error('Public readback did not bind the exact approved commit and complete package.');
      const readbackUrl = new URL(proof.permalink);
      readbackUrl.searchParams.set('deploy_sha', sha);
      const publicResponse = await fetchImpl(readbackUrl, { redirect: 'error', cache: 'no-store', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
      const html = await publicResponse.text();
      if (Buffer.byteLength(html) > 2 * 1024 * 1024 || publicResponse.status !== 200 || !/^text\/html\b/i.test(publicResponse.headers.get('content-type') || '')) throw new Error('Complete public body was not available as bounded HTML.');
      if (!blogPublicBodyMatches({ html, title: draft.title, body: draft.body })) throw new Error('The complete scoped public article markup/title/body did not exactly match the approved content.');
      return { status: 'verified', publicUrl: proof.permalink, remoteId: sha, evidence: { publicReadback: true, fullBodyReadback: true, targetAccountId: account.accountId, contentHash: approval.contentHash, artifactSha256: plan.artifactSha256, commitSha: sha, workflowUrl: proof.workflow_url, observedAt: proof.verified_at } };
    } catch (error) {
      if (pushStarted || pushed || committedSha) return { status: 'unknown', remoteId: committedSha || '', evidence: { publicReadback: false, targetAccountId: account.accountId, contentHash: approval.contentHash, artifactSha256: plan.artifactSha256, commitSha: committedSha, pushAttempted: pushStarted, pushReportedSuccess: pushed, detail: 'Existing commit/Pages/public evidence must be reconciled; no automatic commit or push replay is permitted.' } };
      if (error instanceof HttpError) throw error;
      fail('GitHub package/authentication/scope prerequisite failed. No publication push was attempted; inspect the preserved checkout and existing editorial validation.');
    }
  }
  return {
    async status() {
      if (remote) {
        try { return await bridge('/blog/status', {}, 15000); }
        catch { return { agents: Object.keys(executables).map(id => ({ id, label: id, role: id === 'aside' ? 'publisher' : id === 'hermes' ? 'read-only watchdog and research' : 'draft', installed: null, configured: null, exercised: false, status: 'unknown', detail: 'Host bridge unavailable; installed/configured host capabilities were not observed.' })), routing: { profile: 'jeopi', backend: 'api', status: 'unavailable', detail: 'Authenticated host Jev status is unavailable. No model request was attempted.' } }; }
      }
      const roles = { hermes: 'read-only watchdog and research', aside: 'account-bound publisher', jeopi: 'draft and Jev API host', codex: 'draft', antigravity: 'independent review' };
      const agents = Object.entries(executables).map(([id, file]) => {
        const installed = file ? existsSync(file) : null;
        const configured = Boolean(installed && (id === 'aside' || id === 'antigravity' ? false : typeof draftRunner === 'function'));
        return { id, label: id, role: roles[id], installed, configured, exercised: exercised.has(id), status: exercised.has(id) ? 'exercised' : installed ? 'installed' : installed === null ? 'unknown' : 'unavailable', detail: id === 'aside' ? 'Inspected isolated Naver harness; no complete approved publisher transport is configured.' : id === 'antigravity' ? 'Installation has not been observed unless a host path is explicitly configured. No inspected blog review CLI contract is configured or executed.' : installed ? 'CLI detected; provider authentication and a real blog response are verified only by explicit execution.' : 'Host CLI not found; installation/configuration is an operator prerequisite.' };
      });
      const configurationPresent = existsSync(path.join(home, '.agents/jev/profiles/jeopi.env'));
      return { agents, routing: { ...routing, installed: existsSync(harness), configurationPresent, configured: configurationPresent ? routing.status === 'exercised' ? true : null : false, exercised: routing.status === 'exercised' } };
    },
    async route(task) {
      const summary = text(typeof task === 'string' ? task : task?.summary || 'Create a source-backed Korean blog draft with persona and category rotation.', 600);
      if (!summary.trim()) throw new HttpError(400, 'A minimal blog routing task is required.');
      if (remote) return bridge('/blog/route', { task: summary });
      if (!existsSync(harness)) fail('Install the current-host Jev harness for profile jeopi; no other host profile can be used.');
      const run = args => executeImpl(process.execPath, [harness, '--profile', 'jeopi', ...args], { env: { ...env, JEV_AGENT: 'jeopi', JEV_PROFILE: 'jeopi' }, timeout: 90000, maxBytes: 262144 });
      try {
        const status = parseJson((await run(['status', '--operation', 'route-skills'])).stdout);
        if (status.profile !== 'jeopi' || status.active !== true || status.enabled !== true || status.backends?.api?.configured !== true || status.backends.api.eligible === false) fail('Configure and explicitly enable the jeopi API profile with its own key; other profiles and backends are not borrowed.');
        const result = parseJson((await run(['route-skills', '--backend', 'api', '--top-k', '3', summary])).stdout);
        if (result.backend?.kind !== 'api' || result.unavailable || result.error || !Array.isArray(result.topK)) fail('Jev API routing was unavailable or returned an invalid backend envelope.');
        const receipt = digest(JSON.stringify({ profile: 'jeopi', backend: 'api', task: summary, result }));
        routing = { profile: 'jeopi', backend: 'api', status: 'exercised', detail: 'Explicit API route completed on the current-host jeopi profile; routing advice does not approve publication.', receipt };
        issuedRoutes.add(receipt);
        if (issuedRoutes.size > 64) issuedRoutes.delete(issuedRoutes.values().next().value);
        return { ...routing, topK: result.topK.map(item => ({ id: text(item.id || item.name || item.slug, 200), name: text(item.name, 200) })), selection: { reason: text(result.selection?.reason, 100) } };
      } catch (error) {
        routing = { profile: 'jeopi', backend: 'api', status: 'blocked', detail: 'Jev jeopi API prerequisite failed. Configure and explicitly enable that profile with its own API key; no fallback or configuration change was attempted.' };
        if (error instanceof HttpError) throw error;
        fail(routing.detail);
      }
    },
    async draft({ account, brief, workspace, routing: routed, agent, reference }) {
      if (!['codex', 'jeopi', 'hermes'].includes(agent)) fail('This blog drafting agent has no inspected real CLI adapter.');
      if (!['naver', 'github'].includes(account?.platform)) fail('No inspected platform-specific canonical drafting policy is configured for this account. Manual scratch drafts remain available; Naver media rules were not applied.');
      if (!remote && !issuedRoutes.has(routed?.receipt)) fail('The Jev receipt was not issued by this live host process; run explicit API routing again.');
      if (routed?.profile !== 'jeopi' || routed.backend !== 'api' || !routed.receipt || routed.status !== 'exercised') fail('An explicit successful current-host Jev API routing receipt is required before agent drafting.');
      const category = account.nextMenu?.name || account.menus?.[account.menuCursor];
      if (reference?.status !== 'analyzed' || reference.category !== category || !['fans', 'neighbors', 'followers', 'subscribers'].includes(reference.metricEvidence?.kind) || !Number.isSafeInteger(reference.metricEvidence?.count) || reference.metricEvidence.count < 100000 || !/^[a-f0-9]{64}$/.test(reference.fingerprint || '') || !reference.analysis || !Array.isArray(reference.references) || !reference.references.length) throw new HttpError(409, 'A current same-category analyzed reference with an observed 100,000+ followers/subscribers metric and exact formatting plan is required before drafting.');
      const { blogReferenceContextFingerprint } = await import('./blog-references.mjs');
      if (reference.contextFingerprint !== blogReferenceContextFingerprint({ account, workspace, category })) throw new HttpError(409, 'Reference context changed with the persona/menu/source; analyze a current reference before drafting.');
      if (remote) return bridge('/blog/draft', { account, brief, workspace, routing: routed, agent, reference });
      const loaded = await fresh(workspace, account);
      if (typeof draftRunner !== 'function' || !existsSync(executables[agent])) fail('Configure the existing authenticated host agent bridge with an installed blog drafting CLI.');
      const rules = account.platform === 'naver' ? ['shared/aside-publish-guide.md', 'shared/category-rotation-policy.json', 'shared/category-rotation-state.json'] : [`${account.id}/.claude/editorial-policy.yml`];
      if (rules.some(id => !loaded.context.texts.has(id))) fail('Required current canonical blog rules or rotation metadata are unavailable.');
      if (!account.persona || !account.menus?.length) fail('Provide a canonical persona and menu before drafting.');
      const sources = sourceUrls(brief);
      if (!sources.length) fail('A real research brief with source URLs is required; no fabricated evidence fallback is available.');
      const boundedRule = content => { if (content.length > 24000) fail('A current canonical drafting rule exceeds the complete-context bound; no partial rule was silently applied.'); return text(content, 24000); };
      const personaRules = Array.from(loaded.context.texts).filter(([id]) => id.startsWith(`${account.id}/persona/`)).map(([id, content]) => ({ id, content: boundedRule(content) }));
      const context = [...personaRules, { id: rules[0], content: boundedRule(loaded.context.texts.get(rules[0])) }];
      if (account.platform === 'naver') {
        const selectedPolicy = parseJson(loaded.context.texts.get(rules[1]));
        const selectedState = parseJson(loaded.context.texts.get(rules[2]));
        context.push({ id: rules[1], content: JSON.stringify({ selection_rules: selectedPolicy.selection_rules, blog: selectedPolicy.blogs?.[account.accountId] }) }, { id: rules[2], content: JSON.stringify({ blog: selectedState.blogs?.[account.accountId] }) });
      }
      const articles = (Array.isArray(brief?.articles) ? brief.articles : []).filter(item => sources.some(source => source.url === item.url)).slice(0, 12).map(item => ({ url: item.url, headline: text(item.headline, 300), summary: text(item.summary, 3000), source: text(item.source, 200) }));
      const result = await draftRunner({ jobType: 'blog', agent, message: 'Write one source-backed Korean BLOG draft for owner review. Apply the exact measured layout/image/formatting/adaptation plan to this persona without copying reference wording or assets. Use independently generated or rights-cleared original imagery only. Do not publish, log in, schedule, claim personal experience, or advance category rotation.', blog: { account: { id: account.id, persona: account.persona, menu: category, categoryNo: account.nextMenu?.categoryNo ?? null, keywords: account.keywords }, brief: { query: text(brief?.query, 500), sources, articles }, reference: { fingerprint: reference.fingerprint, category: reference.category, analysis: reference.analysis, rightsStatement: reference.rightsStatement }, rules: context, workspaceVersion: workspace.version } });
      if (!result || typeof result.title !== 'string' || !result.title.trim() || result.title.length > 300 || typeof result.body !== 'string' || !result.body.trim() || result.body.length > 60000 || !Array.isArray(result.sourceEvidence)) fail('Blog agent did not return the required title/body/evidence schema.');
      const allowed = new Set(sources.map(item => item.url));
      if (!result.sourceEvidence.length || result.sourceEvidence.some(item => !allowed.has(item.url))) fail('Blog agent returned missing or unsupported source evidence.');
      exercised.add(agent);
      const headingCount = [...result.body.matchAll(/^#{1,6}\s+.+|<h[1-6]\b/gim)].length;
      const htmlParagraphs = [...result.body.matchAll(/<p\b/gi)].length;
      const paragraphCount = htmlParagraphs || result.body.split(/\n\s*\n/).filter(block => block.trim() && !/^#{1,6}\s/.test(block.trim())).length;
      const imageCount = [...result.body.matchAll(/!\[[^\]]*\]\([^)]*\)|<img\b/gi)].length;
      const formatReview = { status: 'needs-format-review', detail: 'The exact measured reference plan and persona were generation input. Source-text counts are observed; rendered layout, image placement, asset rights and plan compliance still require review.', measurements: { kind: 'source-text-counts', headingCount, paragraphCount, imageCount }, inputFingerprint: candidateFingerprint({ referenceFingerprint: reference.fingerprint, analysis: reference.analysis, persona: account.persona, category, workspaceVersion: workspace.version }) };
      return { title: result.title, body: result.body, sourceEvidence: result.sourceEvidence.map(item => ({ url: item.url, title: text(item.title, 250) })), appliedFormattingPlan: reference.analysis, referenceFingerprint: reference.fingerprint, formatReview };
    },
    async login({ account, workspace }) {
      if (remote) return bridge('/blog/login', { account, workspace });
      if (account?.platform !== 'naver' || !naverAccounts[account.accountId]) fail('No inspected account-bound login adapter exists for this platform; configure the confirmed platform publisher first.');
      const loaded = await fresh(workspace, account);
      const tabId = env[`BLOG_NAVER_TAB_${account.accountId.toUpperCase()}`];
      if (!tabId || !/^[A-Za-z0-9_-]{1,100}$/.test(tabId)) fail('Select the live dedicated acting tab and configure BLOG_NAVER_TAB_<ACCOUNT> on the host. Existing drafts are preserved; no stale-tab or account-switch fallback is allowed.');
      if (process.platform !== 'win32' || !existsSync(executables.aside)) fail('The inspected Windows account-bound Aside Naver harness is unavailable on this host.');
      const script = path.join(loaded.context.sharedRoot, 'scripts/diagnose-myinfo.py');
      const scriptEvidence = loaded.workspace.sourceEvidence.find(item => item.id === 'shared/scripts/diagnose-myinfo.py');
      if (!existsSync(script) || scriptEvidence?.status !== 'loaded' || !scriptEvidence.sha256) fail('Restore the loaded canonical shared scripts/diagnose-myinfo.py identity verifier; missing or unsafe source evidence cannot be executed.');
      const sharedRoot = await realpath(loaded.context.sharedRoot), exactScript = await realpath(script), exactWrapper = await realpath(executables.aside);
      if (exactScript !== path.join(sharedRoot, 'scripts/diagnose-myinfo.py') || exactWrapper !== path.resolve(executables.aside)) fail('The identity verifier or isolated wrapper escapes its exact canonical path.');
      const scriptBytes = await readFile(exactScript);
      if (scriptBytes.length > 1024 * 1024 || digest(scriptBytes) !== scriptEvidence.sha256) throw new HttpError(409, 'Canonical identity verifier changed; refresh source evidence before browser access.');
      try {
        const lockPath = path.join(loaded.context.sharedRoot, '.publish-lock.json');
        const lock = JSON.parse(await readFile(lockPath, 'utf8'));
        if (!lock || typeof lock !== 'object' || Array.isArray(lock) || Object.keys(lock).length) fail('A publisher lock is active or uncertain; no browser identity check was started.');
      } catch (error) { if (error instanceof HttpError) throw error; fail('Canonical publisher lock state is unavailable; browser access is blocked.'); }
      const powershell = path.join(env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      let result;
      try {
        const output = await executeImpl(powershell, ['-NoProfile', '-NonInteractive', '-File', exactWrapper, '-Blog', account.accountId, '-ScriptPath', exactScript], { env: { ...env, NAVER_EXPECTED_ID: account.accountId, NAVER_CDP_PORT: String(naverAccounts[account.accountId]), NAVER_EXPECTED_TAB_ID: tabId }, timeout: 90000, maxBytes: 65536 });
        result = parseJson(output.stdout);
      } catch { fail('Account-bound MyInfo verification failed. Complete manual login/MFA in the exact isolated profile; no account switching or automatic retry was attempted.'); }
      if (result.profile !== account.accountId || Number(result.port) !== naverAccounts[account.accountId] || result.acting_tab_id !== tabId || result.identity_verified !== true || result.acting_tab_restored !== true || result.password_field_present !== false || result.navigation_error || !Array.isArray(result.operation_errors) || result.operation_errors.length) fail('Observed identity/acting-tab restoration evidence does not match this account. Login remains unverified.');
      exercised.add('aside');
      return { status: 'verified', detail: 'The exact account was freshly verified by the established isolated MyInfo script; the acting tab was restored. This is identity verification, not automatic credential login.', evidence: { targetAccountId: account.accountId, identityVerified: true, actingTabRestored: true, observedAt: new Date(now()).toISOString() } };
    },
    async planDeploy(input) {
      if (remote) return bridge('/blog/deploy-plan', { account: input.account, draft: input.draft, workspace: input.workspace }, 15000);
      return githubPlan(input);
    },
    async deploy(input) {
      const { account, draft, approval, workspace } = input;
      if (remote) return bridge('/blog/deploy', { account, draft, approval, workspace, gitConsent: input.gitConsent, plan: input.plan }, 240000);
      await fresh(workspace, account);
      if (!approval?.manifestHash || !approval?.contentHash || !draft?.title || !draft?.body || approval.status !== 'active' || approval.contentHash !== candidateFingerprint({ title: draft.title, body: draft.body })) throw new HttpError(409, 'Exact content and manifest-bound owner approval are required.');
      const stableWorkspace = { ...workspace };
      for (const key of ['refreshedAt', 'updatedAt', 'createdAt']) delete stableWorkspace[key];
      if (approval.draftId !== draft.id || approval.draftVersion !== draft.version || approval.accountId !== account.id || approval.accountVersion !== account.version || approval.workspaceVersion !== workspace.version || approval.manifestHash !== candidateFingerprint({ draft, account, workspace: stableWorkspace })) throw new HttpError(409, 'Owner approval does not match the exact current draft/account/source manifest.');
      if (account.platform === 'github') return publishGithub(input);
      fail(account.platform === 'naver' ? 'The canonical Aside workflow has no complete account-bound publication CLI contract. Owner-approved media bundle, shared lock, exact target tab, strict validator and independent public readback adapter are required; no publication was attempted.' : 'Tistory Open API publishing is retired. A confirmed account-bound browser/editor publisher and exact-content public readback adapter are required. No publication was attempted.');
    },
  };
}
