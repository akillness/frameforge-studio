import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { createBlogAutomation, blogPublicBodyMatches } from '../server/blog-automation.mjs';
import { loadBlogSources } from '../server/blog-sources.mjs';
import { candidateFingerprint } from '../server/graph.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const REPOSITORY = 'https://github.com/jellyggumi/jellyggumi.github.io.git';

async function fixture(t, mode) {
  const home = await mkdtemp(join(tmpdir(), 'frameforge-blog-git-transport-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'sources');
  const checkout = join(home, 'checkout');
  const slug = 'synthetic-fixture';
  const draft = { id: 'isolated-draft', version: 1, title: '검증 전용 글 제목', body: `<p>${'검증한 본문의 중간 문장입니다. '.repeat(120)}</p><p>반드시 포함해야 하는 마지막 문단.</p>` };
  const articlePath = `_posts/2026-10-25-${slug}.md`;
  const assets = [`img/editorial/${slug}.jpg`, `img/editorial/${slug}.thumb.jpg`];
  const references = [1, 2, 3, 4].map(index => `img/source/${slug}/reference-${index}.jpg`);
  const files = [articlePath, ...assets, ...references].sort();
  const article = `---\ntitle: ${JSON.stringify(draft.title)}\n---\n${draft.body}\n`;
  const bytes = Object.fromEntries(files.map(file => [file, file === articlePath ? article : `Synthetic test image bytes: ${file}`]));
  const put = async (name, value) => { const target = join(checkout, name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, value); };
  await put('LATEST.md', '# Synthetic source 2026-10-25');
  await put('blog-config.json', JSON.stringify({ persona: '격리 검증', menus: ['검증 메뉴'], keywords: ['검증'], publicUrl: 'https://jellyggumi.github.io/' }));
  await put('_workspace/current/manifest.json', JSON.stringify({ status: 'approved', mode: 'draft-only', publication_requires_confirmation: true, approval_ref: 'human-review:abcdef', approval_artifact_sha256: 'a'.repeat(64), run_id: 'synthetic-run', article_path: articlePath, slug, asset_paths: assets, reference_image_paths: references }));
  await put('_workspace/current/validation/validation.json', JSON.stringify({ result: 'PASS', stage: 'final', run_id: 'synthetic-run', package_sha256: Object.fromEntries(files.map(file => [file, sha256(bytes[file])])) }));
  await put('_workspace/current/validation/path-scope.txt', files.join('\n') + '\n');
  for (const file of files) await put(`_workspace/current/draft/${file}`, bytes[file]);
  for (const file of ['tools/apply-editorial-package.mjs', 'tools/verify-publication-scope.mjs', 'tools/verify-deployment.mjs', 'tools/validate-editorial-package.mjs', 'tools/lib/source-images.mjs', '.claude/editorial-policy.yml', '_config.yml']) await put(file, '# Synthetic test marker; never executed.');
  const env = { BLOG_GITHUB_CHECKOUT: checkout, BLOG_WORKSPACE_ROOT: root, GIT_CLI: 'fixture-git', GH_CLI: 'fixture-gh' };
  const sources = () => loadBlogSources({ env, home, bridgeMode: false, fetchImpl: async () => { throw Error('Source network forbidden'); } });
  const loaded = await sources();
  const account = { ...loaded.accounts.find(item => item.id === 'github-jellyggumi'), version: 1 };
  const operations = [];
  let committed = false;
  const executeImpl = async (binary, raw) => {
    const args = raw[0] === '-c' ? raw.slice(2) : raw;
    operations.push({ binary, args });
    if (binary === 'fixture-gh') {
      if (args.join(' ') === 'api user') return { stdout: JSON.stringify({ login: 'jellyggumi' }) };
      if (args[0] === 'api') return { stdout: JSON.stringify({ full_name: 'jellyggumi/jellyggumi.github.io', permissions: { push: true }, default_branch: 'gh-pages', has_pages: true }) };
    }
    if (binary === 'fixture-git') {
      const command = args.join(' ');
      if (command === 'branch --show-current') return { stdout: 'gh-pages\n' };
      if (command === 'remote get-url origin') return { stdout: REPOSITORY + '\n' };
      if (command === 'remote get-url --push --all origin') return { stdout: mode === 'wrong-push-target' ? 'https://github.com/other-owner/other-repo.git\n' : mode === 'multiple-push-targets' ? REPOSITORY + '\nhttps://github.com/other-owner/other-repo.git\n' : REPOSITORY + '\n' };
      if (args[0] === 'status') return { stdout: '' };
      if (command === 'rev-parse HEAD') return { stdout: (committed ? 'b' : 'c').repeat(40) + '\n' };
      if (command === `rev-parse ${'b'.repeat(40)}^`) return { stdout: 'c'.repeat(40) + '\n' };
      if (args[0] === 'ls-remote') return { stdout: 'c'.repeat(40) + '\trefs/heads/gh-pages\n' };
      if (command === 'diff --cached --name-only') return { stdout: files.join('\n') + '\n' };
      if (args[0] === 'diff-tree') return { stdout: files.map(file => `A\t${file}`).join('\n') + '\n' };
      if (args[0] === 'ls-tree') return { stdout: files.map(file => `100644 blob ${createHash('sha1').update(`blob ${Buffer.byteLength(bytes[file])}\0${bytes[file]}`).digest('hex')}\t${file}`).join('\n') + '\n' };
      if (args[0] === 'commit') { committed = true; return { stdout: '' }; }
      if (['add', 'push'].includes(args[0])) return { stdout: '' };
    }
    const tool = basename(args[0] || '');
    if (tool === 'apply-editorial-package.mjs') return { stdout: JSON.stringify({ staged: false, copied: files }) };
    if (tool === 'verify-publication-scope.mjs') return { stdout: '{}' };
    if (tool === 'verify-deployment.mjs') return { stdout: JSON.stringify({ pushed_sha: 'b'.repeat(40), remote_sha: 'b'.repeat(40), workflow_sha: 'b'.repeat(40), workflow_conclusion: 'success', approval_artifact_sha256: 'a'.repeat(64), permalink_status: 200, title_check: true, body_check: true, source_credits_check: true, image_urls: files.filter(file => file !== articlePath).map(file => ({ url: `https://jellyggumi.github.io/${file}`, status: 200, sha256: sha256(bytes[file]) })), permalink: `https://jellyggumi.github.io/journal/${slug}/`, workflow_url: 'https://example.com/synthetic-workflow', verified_at: '2026-10-25T00:00:00Z' }) };
    throw Error(`Unexpected synthetic command: ${binary} ${args.join(' ')}`);
  };
  const automation = createBlogAutomation({ env, home, bridgeMode: false, loadSources: sources, executeImpl, fetchImpl: async () => new Response(`<h1 class="post-heading__title">${draft.title}</h1><div class="post-body">${mode === 'truncated-public-body' ? draft.body.slice(0, 1000) : draft.body}</div>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) });
  const input = { account, draft, workspace: loaded.workspace };
  const plan = await automation.planDeploy(input);
  const { refreshedAt, updatedAt, createdAt, ...stableWorkspace } = loaded.workspace;
  const approval = { status: 'active', draftId: draft.id, draftVersion: draft.version, accountId: account.id, accountVersion: account.version, workspaceVersion: loaded.workspace.version, contentHash: plan.contentHash, manifestHash: candidateFingerprint({ draft, account, workspace: stableWorkspace }) };
  return { automation, operations, input: { ...input, plan, approval, gitConsent: { approved: true, planHash: plan.planHash } } };
}

test('a correct fetch remote cannot authorize a different effective push repository', async t => {
  const f = await fixture(t, 'wrong-push-target');
  await assert.rejects(f.automation.deploy(f.input), error => error.status === 503 && /push URL|repository|push target/i.test(error.message));
  assert.equal(f.operations.some(item => ['add', 'commit', 'push'].includes(item.args[0]) || basename(item.args[0] || '') === 'apply-editorial-package.mjs'), false, 'Wrong effective push URL must fail before package application, staging, commit or push');
});

test('title and matching article prefix never substitute for complete independent public body readback', async t => {
  const f = await fixture(t, 'truncated-public-body');
  const result = await f.automation.deploy(f.input);
  assert.equal(result.status, 'unknown');
  assert.equal(result.remoteId, 'b'.repeat(40), 'Known commit identity must survive failed readback for operator recovery');
  assert.equal(result.evidence.publicReadback, false);
  assert.equal(f.operations.filter(item => item.args[0] === 'push').length, 1, 'A failed post-push readback must not automatically replay publication');
});

test('the existing approved package can be reported verified only after exact full-body readback', async t => {
  const f = await fixture(t, 'complete');
  const result = await f.automation.deploy(f.input);
  assert.equal(result.status, 'verified');
  assert.equal(result.remoteId, 'b'.repeat(40));
  assert.equal(result.evidence.fullBodyReadback, true);
  assert.equal(result.evidence.contentHash, f.input.approval.contentHash);
  assert.equal(f.operations.filter(item => item.args[0] === 'push').length, 1);
});
test('a second unapproved push URL blocks publication even when the first URL is approved', async t => {
  const f = await fixture(t, 'multiple-push-targets');
  await assert.rejects(f.automation.deploy(f.input), error => error.status === 503 && /push URL|repository|push target/i.test(error.message));
  assert.equal(f.operations.some(item => ['add', 'commit', 'push'].includes(item.args[0]) || basename(item.args[0] || '') === 'apply-editorial-package.mjs'), false);
});
for (const row of [
  { name: 'unchanged adjacent inline elements retain their separating space', approved: '<p><span>alpha</span> <span>beta</span></p>', actual: '<p><span>alpha</span> <span>beta</span></p>', expected: true },
  { name: 'deleting the space between adjacent inline elements changes the approved body', approved: '<p><span>alpha</span> <span>beta</span></p>', actual: '<p><span>alpha</span><span>beta</span></p>', expected: false },
  { name: 'unchanged preformatted repeated whitespace is accepted', approved: '<pre><code>alpha  beta\n  gamma\n\nend</code></pre>', actual: '<pre><code>alpha  beta\n  gamma\n\nend</code></pre>', expected: true },
  { name: 'collapsing repeated spaces inside preformatted text changes the approved body', approved: '<pre><code>alpha  beta\n  gamma\n\nend</code></pre>', actual: '<pre><code>alpha beta\n  gamma\n\nend</code></pre>', expected: false },
  { name: 'removing a preformatted blank line changes the approved body', approved: '<pre><code>alpha  beta\n  gamma\n\nend</code></pre>', actual: '<pre><code>alpha  beta\n  gamma\nend</code></pre>', expected: false },
  { name: 'CRLF versus LF normalization preserves preformatted content and spacing', approved: '<pre><code>alpha  beta\r\n  gamma\r\n\r\nend</code></pre>', actual: '<pre><code>alpha  beta\n  gamma\n\nend</code></pre>', expected: true },
]) {
  test(`regression: public body ${row.name}`, () => {
    const title = 'Exact approved whitespace';
    const html = `<h1 class="post-heading__title">${title}</h1><div class="post-body">${row.actual}</div>`;
    assert.equal(blogPublicBodyMatches({ html, title, body: row.approved }), row.expected);
  });
}
