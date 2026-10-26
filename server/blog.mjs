import { randomUUID } from 'node:crypto';
import { HttpError, object, text, optionalText, url } from './validation.mjs';
import { candidateFingerprint } from './graph.mjs';
import { fetchTrends } from './integrations.mjs';
import { fetchGoogleNews } from './workflows.mjs';
import { createBlogAutomation } from './blog-automation.mjs';
import { loadBlogSources } from './blog-sources.mjs';
import { blogReferenceContextFingerprint } from './blog-references.mjs';

const ACCOUNT_IDS = ['naver-banggujin', 'naver-jelly_ggumi', 'naver-jennie_p', 'tistory', 'github-jellyggumi'];
const EDITABLE = ['persona', 'keywords', 'menus', 'publicUrl', 'editorUrl'];
const AGENTS = ['hermes', 'codex', 'jeo', 'jeopi', 'aside', 'antigravity'];
const KINDS = { account: 'blogAccounts', workspace: 'blogWorkspaces', brief: 'blogBriefs', draft: 'blogDrafts', run: 'blogRuns', approval: 'blogApprovals', schedule: 'blogSchedules', claim: 'blogMinuteClaims', reference: 'blogReferences', referenceHead: 'blogReferenceHeads' };
const reason = (error) => error instanceof HttpError ? error.message : 'Blog operation failed. Check the local service logs and configured prerequisites.';
const contentHash = (draft) => candidateFingerprint({ title: draft.title, body: draft.body });
const fields = (body, allowed) => {
  object(body);
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HttpError(400, 'Unknown blog request field');
  return body;
};
const strings = (value, name, max = 40) => {
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, `${name} must contain at most ${max} text entries`);
  return [...new Set(value.map((entry) => text(entry, name, 200)))];
};
const evidence = (value = [], maxEntries = 40, maxCharacters = 32000) => {
  if (!Array.isArray(value) || value.length > maxEntries) throw new HttpError(400, `Source evidence must contain at most ${maxEntries} entries`);
  const encoded = JSON.stringify(value);
  if (encoded.length > maxCharacters) throw new HttpError(400, `Source evidence exceeds ${maxCharacters} characters`);
  return JSON.parse(encoded);
};
const selectedMenu = (account) => {
  const index = account.menuCursor;
  const name = Number.isSafeInteger(index) && index >= 0 ? account.menus[index] : undefined;
  if (!name) return null;
  const entry = account.menuEntries?.[index];
  return entry?.name === name && Number.isInteger(entry.categoryNo) ? entry : { name, categoryNo: null };
};
const menuState = (account) => ({ ...account, nextMenu: selectedMenu(account) });
const formattingReview = (title, body, reference) => ({
  status: 'needs-format-review',
  detail: 'Text structure measured; the owner must review the actual draft and image placement plan. Rendered compliance and media rights remain unverified.',
  measurements: { headingCount: (body.match(/^#{1,6}\s+\S|<h[1-6]\b/gim) || []).length, paragraphCount: body.split(/\n\s*\n/).filter((part) => part.trim()).length, imageCount: (body.match(/!\[[^\]]*\]\([^)]*\)|<img\b/gi) || []).length },
  inputFingerprint: candidateFingerprint({ title, body, referenceFingerprint: reference?.fingerprint || null, appliedFormattingPlan: reference?.analysis || null }),
});
function explicitTarget(account, publicUrl) {
  if (!publicUrl) return account.platform === 'tistory' ? '' : account.accountId;
  const parsed = new URL(publicUrl);
  if (parsed.protocol !== 'https:') throw new HttpError(400, 'Blog public targets require HTTPS');
  if (account.platform === 'tistory') {
    const match = /^([a-z0-9-]+)\.tistory\.com$/i.exec(parsed.hostname);
    if (!match || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new HttpError(400, 'Use the exact https://<blog>.tistory.com/ public blog URL');
    return match[1];
  }
  if (account.platform === 'github') {
    const match = /^([a-z0-9-]+)\.github\.io$/i.exec(parsed.hostname);
    if (!match || !/^\/(?:[a-zA-Z0-9_.-]+\/?)?$/.test(parsed.pathname) || parsed.search || parsed.hash) throw new HttpError(400, 'Use the exact GitHub Pages owner and optional repository URL');
    return match[1];
  }
  if (parsed.hostname !== 'blog.naver.com' || parsed.pathname.replace(/\/$/, '') !== `/${account.accountId}` || parsed.search || parsed.hash) throw new HttpError(400, 'Public Naver URL must identify this requested account');
  return account.accountId;
}
function cronFields(expression) {
  const parts = text(expression, 'cron', 120).split(/\s+/);
  if (parts.length !== 5) throw new HttpError(400, 'Cron requires five fields: minute hour day month weekday');
  return parts.map((part, index) => {
    const [min, max] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]][index];
    const values = new Set();
    for (const token of part.split(',')) {
      const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(token);
      if (!match) throw new HttpError(400, 'Unsupported cron field');
      const step = match[2] ? Number(match[2]) : 1;
      const range = match[1] === '*' ? [min, max] : match[1].split('-').map(Number);
      const start = range[0], end = range[1] ?? (match[2] ? max : start);
      if (start < min || end > max || end < start || step < 1 || step > max + 1) throw new HttpError(400, 'Cron field is outside its supported range');
      for (let number = start; number <= end; number += step) values.add(index === 4 && number === 7 ? 0 : number);
    }
    return { values, wildcard: part.split(',').some((token) => token.startsWith('*')) };
  });
}
export function matchesBlogCron(expression, instant) {
  const parsed = cronFields(expression);
  const date = new Date(new Date(instant).getTime() + 9 * 60 * 60 * 1000);
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()];
  const matches = parsed.map((field, index) => field.values.has(values[index]));
  const day = !parsed[2].wildcard && !parsed[4].wildcard ? matches[2] || matches[4] : matches[2] && matches[4];
  return matches[0] && matches[1] && matches[3] && day;
}

// Reuse the video workspace's actual RSS parsers without creating video entities or jobs.
async function collectResearch({ query }) {
  const boundedFetch = async (...args) => {
    const response = await fetch(...args);
    if (!response.ok) return response;
    return { ok: true, text: async () => {
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1000000) throw new HttpError(503, 'News RSS exceeds the source size limit');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf8');
    } };
  };
  const [trends, news] = await Promise.allSettled([fetchTrends(), fetchGoogleNews(query, 8, boundedFetch)]);
  const trendResult = trends.status === 'fulfilled' ? trends.value : { trends: [], sources: [] };
  const newsResult = news.status === 'fulfilled' ? news.value : { articles: [] };
  return { trends: trendResult.trends, articles: newsResult.articles, sources: [...trendResult.sources, ...(news.status === 'fulfilled' ? [{ name: 'Google News KR', status: 'ok', url: newsResult.sourceUrl }] : [{ name: 'Google News KR', status: 'error', detail: 'News RSS unavailable' }])] };
}

export class BlogService {
  constructor({ store, automation = createBlogAutomation(), loadSources = loadBlogSources, research = collectResearch, referenceOptions = {}, now = () => new Date() } = {}) {
    this.store = store;
    this.automation = automation;
    this.loadSources = loadSources;
    this.researchSource = research;
    this.referenceOptions = { inspectImpl: referenceOptions.inspectImpl };
    this.now = now;
    this.active = new Set();
    this.closed = false;
    this.atomic(() => {
      if (!this.find('workspace', 'current')) this.save('workspace', { id: 'current', version: 'unrefreshed', latest: false, sourceRoots: [], sourceEvidence: [], refreshedAt: null, blockedReasons: ['Refresh the explicitly configured canonical blog workspace before automated work.'] });
      for (const id of ACCOUNT_IDS) {
        if (!this.find('account', id)) {
          const platform = id.startsWith('naver-') ? 'naver' : id.startsWith('github-') ? 'github' : 'tistory';
          const accountId = platform === 'naver' ? id.slice(6) : platform === 'github' ? id.slice(7) : '';
          this.save('account', { id, version: 1, platform, label: id, accountId, persona: '', keywords: [], menus: [], menuCursor: 0, publicUrl: '', editorUrl: '', sourceEvidence: [], overrides: [], connection: { status: 'missing', detail: 'Canonical account configuration and scripted target verification are required.' } });
        }
        if (!this.find('schedule', id)) this.save('schedule', { id, accountId: id, version: 1, cron: '0 9 * * *', timezone: 'Asia/Seoul', enabled: false, agent: 'hermes' });
      }
      for (const run of this.list('run')) if (run.status === 'running') {
        this.save('run', { ...run, version: run.version + 1, status: run.kind === 'deploy' ? 'unknown' : 'interrupted', finishedAt: this.stamp(), detail: 'Service restarted before completion. Publication intent is never resubmitted.' });
        if (run.kind === 'deploy' && run.draftId) {
          const draft = this.find('draft', run.draftId);
          if (draft) this.save('draft', { ...draft, version: draft.version + 1, status: 'unknown' });
        }
      }
    });
    this.syncTimer();
  }

  stamp() { return new Date(this.now()).toISOString(); }
  ensureOpen() { if (this.closed) throw new HttpError(503, 'Blog workspace is closing'); }
  find(kind, id) {
    try { return this.store.get(KINDS[kind], id); } catch (error) { if (error.status === 404) return null; throw error; }
  }
  get(kind, id) {
    const result = this.find(kind, id);
    if (!result) throw new HttpError(404, `Blog ${kind} not found`);
    return result;
  }
  list(kind) { return this.store.list(KINDS[kind]); }
  atomic(operation) {
    this.ensureOpen();
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  save(kind, value) {
    const stamp = this.stamp();
    const saved = { createdAt: stamp, ...(kind === 'account' ? menuState(value) : value), updatedAt: stamp };
    this.store.save(KINDS[kind], saved);
    // Immutable exact-version snapshots stay in SQLite, never in the video knowledge export.
    const id = `${kind}:${saved.id}:${saved.version}`;
    const prior = this.store.db.prepare('SELECT 1 FROM entities WHERE kind = ? AND id = ?').get('blogHistory', id);
    if (!prior) this.store.save('blogHistory', { id, kind, entityId: saved.id, version: saved.version, snapshot: saved, createdAt: stamp });
    return saved;
  }
  expected(current, expectedVersion) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new HttpError(400, 'A positive expectedVersion is required');
    if (current.version !== expectedVersion) throw new HttpError(409, `Blog item changed: current version is ${current.version}. Reload before saving.`);
  }
  idle(accountId) { if (this.active.has(accountId)) throw new HttpError(409, 'This blog account has an active operation'); }
  async exclusive(accountId, operation) {
    this.ensureOpen(); this.idle(accountId); this.active.add(accountId);
    try { return await operation(); } finally { this.active.delete(accountId); }
  }
  invalidate(accountId, draftId) {
    for (const approval of this.list('approval')) if (approval.status === 'active' && approval.accountId === accountId && (!draftId || approval.draftId === draftId)) this.save('approval', { ...approval, version: approval.version + 1, status: 'invalidated' });
  }
  async live() {
    this.ensureOpen();
    let source;
    try { source = await this.loadSources(); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'Canonical blog sources could not be read. Configure BLOG_WORKSPACE_ROOT and inspect the source files.'); }
    this.ensureOpen();
    if (!source?.workspace || typeof source.workspace.version !== 'string' || !source.workspace.version || typeof source.workspace.latest !== 'boolean' || !Array.isArray(source.accounts)) throw new HttpError(503, 'Canonical source loader did not return a current versioned workspace');
    return source;
  }
  effectiveAccount(account, source) {
    const canonical = source.accounts.find((item) => item.id === account.id);
    if (!canonical) return account;
    const effective = { ...account };
    for (const key of [...EDITABLE, 'accountId', 'sourceEvidence', 'menuEntries', 'nextMenu', 'latestRecord', 'historicalPublication', 'publicTargetProvenance', 'metadataRequirements', 'connection']) if (!account.overrides.includes(key) && canonical[key] !== undefined) effective[key] = canonical[key];
    if (!account.overrides.includes('menus') && Number.isSafeInteger(canonical.menuCursor) && !this.list('run').some((run) => run.accountId === account.id && run.kind === 'deploy' && run.status === 'verified')) effective.menuCursor = canonical.menuCursor;
    return menuState(effective);
  }
  ready(workspace, account) {
    const relevant = (message) => !ACCOUNT_IDS.some((id) => message.startsWith(`${id}:`)) || message.startsWith(`${account.id}:`);
    const satisfiedMetadata = (message) => (account.metadataRequirements || []).some(({ field, detail }) => ['persona', 'menus'].includes(field) && account.overrides.includes(field) && account[field]?.length && message === `${account.id}: ${detail}`);
    const problems = [...(workspace.blockedReasons || []), ...(workspace.sourceConflicts || [])].filter(relevant).filter((message) => !satisfiedMetadata(message));
    if (workspace.latest !== true && !(workspace.blockedReasons?.length || workspace.sourceConflicts?.length)) problems.push('Canonical source consistency must be resolved before approval');
    if (problems.length) throw new HttpError(503, `Canonical blog workspace is blocked: ${problems.join('; ').slice(0, 800)}`);
  }
  currentDraft(draft, account, workspace) {
    if (draft.workspaceVersion !== workspace.version || draft.accountVersion !== account.version || draft.accountManifestHash !== candidateFingerprint(account)) throw new HttpError(409, 'Draft sources or account configuration changed. Save a new current draft before approval.');
    if (!draft.referenceId) throw new HttpError(503, 'This manual scratch draft needs a current analyzed same-category reference with at least 100000 public followers or subscribers before owner approval');
    const reference = this.currentReference(account, workspace, draft.referenceId);
    if (draft.referenceFingerprint !== reference.fingerprint || candidateFingerprint(draft.appliedFormattingPlan) !== candidateFingerprint(reference.analysis)) throw new HttpError(409, 'Draft reference analysis or applied formatting plan changed. Save a new current draft before approval.');
  }
  mutableDraft(draft) {
    if (this.list('run').some((run) => run.draftId === draft.id && run.kind === 'deploy')) throw new HttpError(409, 'A publication intent already exists for this draft; do not resubmit or alter uncertain publication content.');
  }
  manifest(draft, account, workspace) {
    const { refreshedAt, updatedAt, createdAt, ...stableWorkspace } = workspace;
    return { draft, account, workspace: stableWorkspace };
  }
  async state() {
    this.ensureOpen();
    const status = await this.automation.status();
    const workspace = this.get('workspace', 'current');
    const accounts = ACCOUNT_IDS.map((id) => this.get('account', id));
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    return { workspace, accounts, briefs: this.list('brief'), references: this.list('reference').map((reference) => ({ ...reference, current: this.referenceIsCurrent(reference, accountsById.get(reference.accountId), workspace) })), drafts: this.list('draft'), runs: this.list('run'), approvals: this.list('approval'), schedules: ACCOUNT_IDS.map((id) => this.get('schedule', id)), agents: status.agents, routing: status.routing };
  }
  referenceIsCurrent(reference, account, workspace) {
    if (!reference || !account) return false;
    const menu = selectedMenu(account)?.name || '';
    const categoryNo = selectedMenu(account)?.categoryNo ?? null;
    return this.find('referenceHead', account.id)?.referenceId === reference.id && reference.status === 'analyzed' && reference.accountId === account.id && reference.workspaceVersion === workspace.version && reference.menu === menu && reference.categoryNo === categoryNo && reference.category === menu && reference.contextFingerprint === blogReferenceContextFingerprint({ account, workspace });
  }
  currentReference(account, workspace, referenceId, { required = true } = {}) {
    const head = this.find('referenceHead', account.id);
    const reference = this.find('reference', referenceId || head?.referenceId || '');
    if (!this.referenceIsCurrent(reference, account, workspace)) {
      if (!required && !referenceId) return null;
      throw new HttpError(reference ? 409 : 503, reference ? 'Reference analysis changed or no longer matches the current account, category and sources. Analyze and save the current formatting plan again.' : 'Analyze a same-category reference with at least 100000 publicly observed followers or subscribers before writing.');
    }
    const metric = reference.metricEvidence;
    if (!metric || !['fans', 'neighbors', 'followers', 'subscribers'].includes(metric.kind) || !Number.isFinite(metric.count) || metric.count < 100000 || !metric.url || !metric.sha256 || !metric.observedAt || !reference.fingerprint || !reference.contextFingerprint || !reference.references?.length || !reference.analysis) throw new HttpError(503, 'Reference lacks eligible public popularity and measured source-backed formatting evidence');
    return reference;
  }
  referenceFields(reference) {
    return { referenceId: reference?.id || null, referenceFingerprint: reference?.fingerprint || null, appliedFormattingPlan: reference ? structuredClone(reference.analysis) : null };
  }
  async analyzeReferences(id, body) {
    fields(body, ['expectedVersion', 'profileUrl', 'postUrls', 'category', 'categoryEvidence']);
    return this.exclusive(id, async () => {
      let account = this.get('account', id); this.expected(account, body.expectedVersion);
      const source = await this.live(), { workspace } = source;
      account = this.effectiveAccount(account, source);
      const sourceVersion = workspace.version, sourceAccountHash = candidateFingerprint(account);
      const menu = selectedMenu(account)?.name || '';
      if (!menu || !account.persona) throw new HttpError(503, 'Configure the current persona and unambiguous selected category before reference analysis');
      const run = this.atomic(() => this.startRun('reference-analysis', id));
      try {
        const { analyzeBlogReferences } = await import('./blog-references.mjs');
        const { expectedVersion, ...input } = body;
        const result = await analyzeBlogReferences({ account, workspace, input, inspectImpl: this.referenceOptions.inspectImpl, now: this.now });
        this.ensureOpen();
        const latest = await this.live();
        if (latest.workspace.version !== sourceVersion || candidateFingerprint(this.effectiveAccount(this.get('account', id), latest)) !== sourceAccountHash) throw new HttpError(409, 'Account or canonical sources changed during reference analysis. Analyze the current source version again.');
        if (result?.status !== 'analyzed' || result.category !== menu || !result.fingerprint || !result.contextFingerprint) throw new HttpError(503, 'Reference inspector did not return an eligible current-category analysis');
        return this.atomic(() => {
          this.expected(this.get('account', id), body.expectedVersion);
          const reference = this.save('reference', { ...result, id: randomUUID(), version: 1, accountId: id, accountVersion: account.version, accountManifestHash: candidateFingerprint(account), workspaceVersion: workspace.version, menu, categoryNo: selectedMenu(account)?.categoryNo ?? null });
          const head = this.find('referenceHead', id);
          this.save('referenceHead', { id, version: (head?.version || 0) + 1, referenceId: reference.id, fingerprint: reference.fingerprint });
          this.invalidate(id);
          return { reference: { ...reference, current: true }, run: this.finishRun(run, 'completed', 'Public popularity, author/category evidence and measured original formatting guidance saved', { referenceId: reference.id, referenceFingerprint: reference.fingerprint }) };
        });
      } catch (error) {
        if (!this.closed) this.atomic(() => this.finishRun(run, 'failed', reason(error)));
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, reason(error));
      }
    });
  }
  async refresh() {
    const source = await this.live();
    return this.atomic(() => {
      const previous = this.get('workspace', 'current');
      const changed = previous.version !== source.workspace.version;
      for (const id of ACCOUNT_IDS) {
        const current = this.get('account', id);
        const canonical = source.accounts.find((account) => account.id === id);
        const next = { ...current };
        if (canonical) {
          for (const key of EDITABLE) if (!current.overrides.includes(key) && canonical[key] !== undefined) next[key] = canonical[key];
          for (const key of ['platform', 'label', 'accountId', 'sourceEvidence', 'connection', 'menuEntries', 'nextMenu', 'latestRecord', 'historicalPublication', 'publicTargetProvenance', 'metadataRequirements']) if (!current.overrides.includes(key) && canonical[key] !== undefined) next[key] = canonical[key];
          if (!current.overrides.includes('menus') && Number.isSafeInteger(canonical.menuCursor) && !this.list('run').some((run) => run.accountId === id && run.kind === 'deploy' && run.status === 'verified')) next.menuCursor = canonical.menuCursor;
        }
        if (candidateFingerprint(menuState(next)) !== candidateFingerprint(current)) {
          this.idle(id);
          this.save('account', { ...next, version: current.version + 1 });
          this.invalidate(id);
        } else if (changed) this.invalidate(id);
      }
      return { workspace: this.save('workspace', { ...source.workspace, id: 'current', sourceEvidence: evidence(source.workspace.sourceEvidence, 256, 200000), sourceRoots: strings(source.workspace.sourceRoots || [], 'source roots', 20), blockedReasons: strings(source.workspace.blockedReasons || [], 'blocked reasons', 40), refreshedAt: this.stamp() }), accounts: ACCOUNT_IDS.map((id) => this.get('account', id)) };
    });
  }
  updateAccount(id, body) {
    fields(body, ['expectedVersion', ...EDITABLE]);
    const patch = {};
    if ('persona' in body) patch.persona = optionalText(body.persona, 'persona', 16000);
    for (const key of ['keywords', 'menus']) if (key in body) patch[key] = strings(body[key], key);
    for (const key of ['publicUrl', 'editorUrl']) if (key in body) patch[key] = body[key] === '' ? '' : url(body[key]);
    if (!Object.keys(patch).length) throw new HttpError(400, 'No account fields were provided');
    return this.atomic(() => {
      const current = this.get('account', id); this.idle(id); this.expected(current, body.expectedVersion);
      if ('publicUrl' in patch) patch.accountId = explicitTarget(current, patch.publicUrl);
      const menusChanged = 'menus' in patch && candidateFingerprint(patch.menus) !== candidateFingerprint(current.menus);
      const account = this.save('account', { ...current, ...patch, version: current.version + 1, menuCursor: menusChanged ? 0 : current.menuCursor, overrides: [...new Set([...current.overrides, ...Object.keys(patch)])] });
      this.invalidate(id);
      return { account };
    });
  }
  startRun(kind, accountId, extra = {}) {
    return this.save('run', { id: randomUUID(), version: 1, accountId, kind, status: 'running', startedAt: this.stamp(), detail: 'Operation started', ...extra });
  }
  finishRun(run, status, detail, output) {
    return this.save('run', { ...this.get('run', run.id), version: this.get('run', run.id).version + 1, status, finishedAt: this.stamp(), detail, ...(output === undefined ? {} : { output }) });
  }
  async research(id, body) {
    fields(body, ['expectedVersion', 'query']);
    const queryOverride = optionalText(body.query, 'research query', 300);
    return this.exclusive(id, async () => {
      let account = this.get('account', id); this.expected(account, body.expectedVersion);
      const source = await this.live(), { workspace } = source;
      account = this.effectiveAccount(account, source);
      const menu = selectedMenu(account)?.name || '';
      const keywords = [...new Set([...account.keywords, menu].filter(Boolean))].slice(0, 12);
      const query = queryOverride || keywords.slice(0, 6).join(' OR ').slice(0, 300);
      if (!query) throw new HttpError(400, 'Configure account keywords or a menu, or supply a research query');
      const run = this.atomic(() => this.startRun('research', id));
      try {
        const result = await this.researchSource({ account, workspace, query, menu, keywords });
        this.ensureOpen();
        const terms = [queryOverride, ...keywords].filter(Boolean).map((term) => term.toLocaleLowerCase());
        const articles = (result.articles || []).slice(0, 12).map((article) => ({ headline: text(article.headline, 'article headline', 1000), url: url(article.url), source: text(article.source || 'RSS', 'article source', 200), summary: optionalText(article.summary, 'article summary', 4000), capturedAt: article.capturedAt || this.stamp() }));
        const trends = (result.trends || []).filter((trend) => typeof trend.keyword === 'string' && (!terms.length || terms.some((term) => trend.keyword.toLocaleLowerCase().includes(term)))).slice(0, 12).map((trend) => ({ keyword: text(trend.keyword, 'trend keyword', 200), url: url(trend.url), source: text(trend.source || 'RSS', 'trend source', 200), capturedAt: trend.capturedAt || this.stamp() }));
        if (!articles.length && !trends.length) throw new HttpError(503, 'Research returned no current source-backed articles or matching keywords. Check RSS availability or revise the account keywords.');
        const sourceEvidence = evidence([...articles.map(({ url, source, capturedAt }) => ({ url, source, capturedAt })), ...trends.map(({ url, source, capturedAt }) => ({ url, source, capturedAt }))]);
        return this.atomic(() => {
          this.expected(this.get('account', id), body.expectedVersion);
          const brief = this.save('brief', { id: randomUUID(), version: 1, accountId: id, accountVersion: account.version, accountManifestHash: candidateFingerprint(account), workspaceVersion: workspace.version, query, menu, categoryNo: selectedMenu(account)?.categoryNo ?? null, keywords, persona: account.persona, articles, trends, sourceEvidence, sources: evidence(result.sources || []) });
          return { brief, run: this.finishRun(run, 'completed', 'Current RSS research saved for human review', { briefId: brief.id }) };
        });
      } catch (error) {
        if (!this.closed) this.atomic(() => this.finishRun(run, 'failed', reason(error)));
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, reason(error));
      }
    });
  }
  async createDraft(id, body) {
    fields(body, ['expectedVersion', 'agent', 'briefId', 'referenceId', 'title', 'body']);
    const manual = body.body !== undefined;
    const manualContent = manual ? { title: text(body.title, 'draft title', 500), body: text(body.body, 'draft body', 200000) } : null;
    if (manual && body.agent !== undefined && !['manual', ...AGENTS].includes(body.agent)) throw new HttpError(400, 'Unknown draft agent');
    if (!manual && !AGENTS.includes(body.agent)) throw new HttpError(400, 'A configured blog agent is required');
    return this.exclusive(id, async () => {
      let account = this.get('account', id); this.expected(account, body.expectedVersion);
      const source = await this.live(), { workspace } = source;
      account = this.effectiveAccount(account, source);
      const brief = body.briefId ? this.get('brief', text(body.briefId, 'brief id', 100)) : null;
      if (brief && (brief.accountId !== id || brief.accountVersion !== account.version || brief.workspaceVersion !== workspace.version || brief.accountManifestHash !== candidateFingerprint(account))) throw new HttpError(409, 'Research brief belongs to another or stale account/workspace version');
      if (!manual && (!account.persona || !account.menus.length || account.menuCursor < 0)) throw new HttpError(503, 'Configure a current account persona and an unambiguous next menu before agent drafting');
      const menu = selectedMenu(account)?.name || '';
      const reference = this.currentReference(account, workspace, body.referenceId === undefined ? undefined : text(body.referenceId, 'reference id', 100), { required: !manual });
      const run = this.atomic(() => this.startRun(manual ? 'manual-draft' : 'draft', id, { agent: manual ? 'manual' : body.agent }));
      try {
        let result = manualContent;
        if (!manual) {
          const routing = await this.automation.route({ kind: 'blog-draft', summary: `Draft a source-backed blog article for ${id}; selected menu: ${menu}; research: ${brief?.query || account.keywords.join(', ')}`.slice(0, 600), accountId: id, agent: body.agent, menu, query: brief?.query || account.keywords.join(', '), workspaceVersion: workspace.version });
          if (routing?.profile !== 'jeopi' || routing.backend !== 'api' || routing.status !== 'exercised' || typeof routing.receipt !== 'string' || !routing.receipt) throw new HttpError(503, 'A successful explicit Jev jeopi API routing receipt is required before agent drafting');
          this.atomic(() => {
            const current = this.get('run', run.id);
            this.save('run', { ...current, version: current.version + 1, routing: { profile: routing.profile, backend: routing.backend, status: routing.status, receipt: routing.receipt.slice(0, 256) }, detail: 'Explicit Jev API routing completed; drafting has not approved publication' });
          });
          result = await this.automation.draft({ account, brief, workspace, routing, reference, agent: body.agent });
        }
        this.ensureOpen();
        const title = text(result.title, 'draft title', 500), draftBody = text(result.body, 'draft body', 200000);
        const sourceEvidence = evidence(result.sourceEvidence || brief?.sourceEvidence || []);
        return this.atomic(() => {
          this.expected(this.get('account', id), body.expectedVersion);
          const draft = this.save('draft', { id: randomUUID(), version: 1, accountId: id, accountVersion: account.version, accountManifestHash: candidateFingerprint(account), menu, categoryNo: selectedMenu(account)?.categoryNo ?? null, ...this.referenceFields(reference), formatReview: formattingReview(title, draftBody, reference), title, body: draftBody, status: 'draft', briefId: brief?.id || null, sourceEvidence, workspaceVersion: workspace.version });
          return { draft, run: this.finishRun(run, 'completed', manual ? 'Explicit article content saved locally; not published' : 'Agent article saved for final owner review', { draftId: draft.id }) };
        });
      } catch (error) {
        if (!this.closed) this.atomic(() => this.finishRun(run, 'failed', reason(error)));
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, reason(error));
      }
    });
  }
  async updateDraft(id, body) {
    fields(body, ['expectedVersion', 'title', 'body', 'referenceId']);
    const title = text(body.title, 'draft title', 500), draftBody = text(body.body, 'draft body', 200000);
    const draft = this.get('draft', id);
    return this.exclusive(draft.accountId, async () => {
      const source = await this.live(), { workspace } = source;
      return this.atomic(() => {
        const current = this.get('draft', id); this.expected(current, body.expectedVersion); this.mutableDraft(current);
        const account = this.effectiveAccount(this.get('account', current.accountId), source);
        const menu = selectedMenu(account)?.name || '';
        const reference = this.currentReference(account, workspace, body.referenceId === undefined ? undefined : text(body.referenceId, 'reference id', 100), { required: false });
        const updated = this.save('draft', { ...current, title, body: draftBody, menu, categoryNo: selectedMenu(account)?.categoryNo ?? null, ...this.referenceFields(reference), formatReview: formattingReview(title, draftBody, reference), accountVersion: account.version, accountManifestHash: candidateFingerprint(account), workspaceVersion: workspace.version, status: 'draft', version: current.version + 1 });
        this.invalidate(current.accountId, id);
        return { draft: updated };
      });
    });
  }
  async approve(id, body) {
    fields(body, ['expectedVersion', 'approved', 'formatReviewed']);
    if (body.approved !== true || body.formatReviewed !== true) throw new HttpError(400, 'Owner approval requires approved: true and separate formatReviewed: true acknowledgement');
    const original = this.get('draft', id);
    return this.exclusive(original.accountId, async () => {
      const source = await this.live(), { workspace } = source;
      return this.atomic(() => {
        const draft = this.get('draft', id); this.expected(draft, body.expectedVersion); this.mutableDraft(draft);
        const account = this.effectiveAccount(this.get('account', draft.accountId), source); this.ready(workspace, account); this.currentDraft(draft, account, workspace);
        this.invalidate(account.id, id);
        const approval = this.save('approval', { id: randomUUID(), version: 1, draftId: id, draftVersion: draft.version, accountId: account.id, accountVersion: account.version, workspaceVersion: workspace.version, manifestHash: candidateFingerprint(this.manifest(draft, account, workspace)), contentHash: contentHash(draft), referenceId: draft.referenceId, referenceFingerprint: draft.referenceFingerprint, formattingPlanHash: candidateFingerprint(draft.appliedFormattingPlan), formatReviewed: true, approvedAt: this.stamp(), status: 'active' });
        return { approval };
      });
    });
  }
  async login(id, body) {
    fields(body, ['expectedVersion']);
    return this.exclusive(id, async () => {
      let account = this.get('account', id); this.expected(account, body.expectedVersion);
      const source = await this.live(), { workspace } = source;
      account = this.effectiveAccount(account, source);
      const run = this.atomic(() => this.startRun('login', id));
      try {
        const result = await this.automation.login({ account, workspace }); this.ensureOpen();
        return this.atomic(() => ({ run: this.finishRun(run, result?.status === 'verified' ? 'verified' : 'manual-required', 'Login script completed; MFA/captcha and account verification remain script-owned', result) }));
      } catch (error) {
        if (!this.closed) this.atomic(() => this.finishRun(run, 'failed', reason(error)));
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, reason(error));
      }
    });
  }
  async publicationPlan(account, draft, workspace) {
    if (account.platform !== 'github') throw new HttpError(400, 'Git publication plans apply only to GitHub Pages');
    if (typeof this.automation.planDeploy !== 'function') throw new HttpError(503, 'Configure the exact GitHub checkout and approved article package before requesting a Git publication plan');
    const plan = await this.automation.planDeploy({ account, draft, workspace });
    object(plan);
    if (plan.contentHash !== contentHash(draft) || plan.workspaceVersion !== workspace.version || typeof plan.planHash !== 'string' || !plan.planHash || !Array.isArray(plan.files) || !plan.files.length || plan.files.length > 100 || !Array.isArray(plan.effects)) throw new HttpError(503, 'Git publication plan is not bound to the exact current content and source manifest');
    const repository = new URL(url(plan.repository));
    if (repository.protocol !== 'https:' || repository.hostname !== 'github.com' || !repository.pathname.startsWith(`/${account.accountId}/`)) throw new HttpError(503, 'Git publication plan repository does not match the configured account');
    for (const file of plan.files) if (typeof file !== 'string' || file.length > 500 || !file || /[\\:\u0000]/.test(file) || file.startsWith('/') || file.split('/').includes('..')) throw new HttpError(503, 'Git publication plan contains an unsafe file path');
    text(plan.branch, 'Git publication branch', 200);
    return plan;
  }
  async planDeploy(id, body) {
    fields(body, ['expectedVersion']);
    const original = this.get('draft', id);
    return this.exclusive(original.accountId, async () => {
      const source = await this.live(), { workspace } = source;
      const draft = this.get('draft', id); this.expected(draft, body.expectedVersion); this.mutableDraft(draft);
      const account = this.effectiveAccount(this.get('account', draft.accountId), source);
      this.currentDraft(draft, account, workspace);
      return { plan: await this.publicationPlan(account, draft, workspace) };
    });
  }
  async deploy(id, body) {
    fields(body, ['expectedVersion', 'approvalId', 'gitConsent']);
    const approvalId = text(body.approvalId, 'approval id', 100);
    const original = this.get('draft', id);
    return this.exclusive(original.accountId, async () => {
      const source = await this.live(), { workspace } = source;
      const previewDraft = this.get('draft', id); this.expected(previewDraft, body.expectedVersion); this.mutableDraft(previewDraft);
      const previewAccount = this.effectiveAccount(this.get('account', previewDraft.accountId), source);
      let plan;
      if (previewAccount.platform === 'github') {
        if (!body.gitConsent || body.gitConsent.approved !== true) throw new HttpError(400, 'GitHub publication requires separate explicit consent to the exact repository, branch, files, local commit and push');
        fields(body.gitConsent, ['approved', 'planHash']);
        plan = await this.publicationPlan(previewAccount, previewDraft, workspace);
        if (body.gitConsent.planHash !== plan.planHash) throw new HttpError(409, 'Git publication plan changed. Inspect the exact current plan and consent again.');
      } else if (body.gitConsent !== undefined) throw new HttpError(400, 'Git consent is not applicable to this blog platform');
      const prepared = this.atomic(() => {
        const draft = this.get('draft', id); this.expected(draft, body.expectedVersion); this.mutableDraft(draft);
        const account = this.effectiveAccount(this.get('account', draft.accountId), source); this.ready(workspace, account); this.currentDraft(draft, account, workspace);
        const approval = this.get('approval', approvalId);
        if (approval.status !== 'active' || approval.formatReviewed !== true || approval.draftId !== id || approval.referenceId !== draft.referenceId || approval.referenceFingerprint !== draft.referenceFingerprint || approval.formattingPlanHash !== candidateFingerprint(draft.appliedFormattingPlan) || approval.manifestHash !== candidateFingerprint(this.manifest(draft, account, workspace))) throw new HttpError(409, 'Approval does not cover the complete current draft/reference/formatting/account/workspace manifest');
        if (!account.accountId || !account.publicUrl || (account.platform !== 'github' && !account.editorUrl)) throw new HttpError(503, 'Configure and verify the exact public account and editor target before deployment');
        const run = this.startRun('deploy', account.id, { draftId: id, approvalId, manifestHash: approval.manifestHash, ...(plan ? { plan, gitConsent: body.gitConsent } : {}), detail: 'Publication intent persisted before invoking the script; never automatically replay' });
        this.save('approval', { ...approval, version: approval.version + 1, status: 'consumed' });
        this.save('draft', { ...draft, version: draft.version + 1, status: 'deploying' });
        return { account, draft, approval, run };
      });
      try {
        const result = await this.automation.deploy({ ...prepared, workspace, ...(plan ? { plan, gitConsent: body.gitConsent } : {}) }); this.ensureOpen();
        const verified = result?.status === 'verified' && result.evidence?.publicReadback === true && result.evidence.targetAccountId === prepared.account.accountId && result.evidence.contentHash === prepared.approval.contentHash;
        let publicUrl = '';
        if (verified) {
          try {
            const candidate = new URL(url(result.publicUrl)), target = new URL(prepared.account.publicUrl);
            const naver = prepared.account.platform === 'naver' && ['blog.naver.com', 'm.blog.naver.com'].includes(candidate.hostname) && candidate.pathname.startsWith(`/${prepared.account.accountId}/`);
            const scoped = candidate.hostname === target.hostname && (target.pathname === '/' || candidate.pathname.startsWith(`${target.pathname.replace(/\/$/, '')}/`));
            if (candidate.protocol === 'https:' && (naver || (prepared.account.platform !== 'naver' && scoped))) publicUrl = candidate.href;
          } catch { /* A malformed or wrong-account public URL is uncertain, never successful. */ }
        }
        return this.atomic(() => {
          const draft = this.get('draft', id), account = this.get('account', prepared.account.id);
          const status = verified && publicUrl ? 'verified' : 'unknown';
          const output = { ...(publicUrl ? { publicUrl } : {}), ...(typeof result?.remoteId === 'string' ? { remoteId: result.remoteId.slice(0, 500) } : {}), evidence: evidence(result?.evidence ? [result.evidence] : []) };
          const run = this.finishRun(prepared.run, status, status === 'verified' ? 'Public article readback verified against target account and approved content' : 'Publication result is uncertain. Do not retry this draft; inspect the saved intent and public account.', output);
          const updated = this.save('draft', { ...draft, version: draft.version + 1, status: status === 'verified' ? 'published' : 'unknown', ...(publicUrl ? { publicUrl } : {}) });
          if (status === 'verified') {
            this.save('account', { ...prepared.account, version: account.version + 1, menuCursor: prepared.account.menus.length ? (prepared.account.menuCursor + 1) % prepared.account.menus.length : 0 });
            this.invalidate(account.id);
          }
          return { run, draft: updated };
        });
      } catch (error) {
        if (!this.closed) this.atomic(() => {
          this.finishRun(prepared.run, 'unknown', `Publication outcome requires manual readback; no retry: ${reason(error)}`);
          const draft = this.get('draft', id);
          this.save('draft', { ...draft, version: draft.version + 1, status: 'unknown' });
        });
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, 'Publication outcome is uncertain. The persisted intent blocks resubmission; inspect the public account.');
      }
    });
  }
  setSchedule(id, body) {
    fields(body, ['expectedVersion', 'cron', 'timezone', 'enabled', 'agent']);
    if (body.timezone !== 'Asia/Seoul' || typeof body.enabled !== 'boolean' || !AGENTS.includes(body.agent)) throw new HttpError(400, 'Schedule requires Asia/Seoul, an explicit enabled boolean and a supported blog agent');
    cronFields(body.cron);
    const result = this.atomic(() => {
      const account = this.get('account', id); this.idle(id); this.expected(account, body.expectedVersion);
      const previous = this.get('schedule', id);
      const schedule = this.save('schedule', { ...previous, cron: body.cron.trim(), timezone: 'Asia/Seoul', enabled: body.enabled, agent: body.agent, version: previous.version + 1 });
      const updated = this.save('account', { ...account, version: account.version + 1 });
      this.invalidate(id);
      return { schedule, account: updated };
    });
    this.syncTimer();
    return result;
  }
  async tick(body = {}) {
    fields(body, []); this.ensureOpen();
    if (this.ticking) throw new HttpError(409, 'A blog scheduler tick is already running');
    this.ticking = true;
    try {
    const instant = new Date(this.now());
    const minute = instant.toISOString().slice(0, 16);
    const results = [];
    for (const schedule of this.list('schedule').filter((item) => item.enabled).slice(0, ACCOUNT_IDS.length)) {
      if (!matchesBlogCron(schedule.cron, instant) || this.active.has(schedule.accountId)) continue;
      const claimed = this.atomic(() => {
        const current = this.get('schedule', schedule.id);
        if (!current.enabled || current.version !== schedule.version) return false;
        const id = `${schedule.accountId}:${minute}`;
        if (this.find('claim', id)) return false;
        this.save('claim', { id, version: 1, accountId: schedule.accountId, scheduleVersion: schedule.version, minute, timezone: 'Asia/Seoul', status: 'claimed' });
        this.save('schedule', { ...current, version: current.version + 1, lastClaimedMinute: minute });
        return true;
      });
      if (!claimed) continue;
      try {
        const account = this.get('account', schedule.accountId);
        const source = await this.live();
        this.currentReference(this.effectiveAccount(account, source), source.workspace);
        const researched = await this.research(account.id, { expectedVersion: account.version });
        const drafted = await this.createDraft(account.id, { expectedVersion: account.version, agent: schedule.agent, briefId: researched.brief.id });
        results.push({ accountId: account.id, status: 'drafted', draftId: drafted.draft.id, runId: drafted.run.id });
      } catch (error) { results.push({ accountId: schedule.accountId, status: 'blocked', detail: reason(error) }); }
      this.atomic(() => {
        const claim = this.get('claim', `${schedule.accountId}:${minute}`);
        this.save('claim', { ...claim, version: claim.version + 1, status: results.at(-1).status, result: results.at(-1) });
      });
    }
    return { minute, timezone: 'Asia/Seoul', draftOnly: true, results };
    } finally { this.ticking = false; }
  }
  syncTimer() {
    if (this.closed || !this.list('schedule').some((schedule) => schedule.enabled)) {
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking || this.closed) return;
      this.tick().catch((error) => { if (!this.closed) console.error('Blog scheduler tick failed:', reason(error)); });
    }, 15000);
    this.timer.unref?.();
  }
  close() { this.closed = true; clearInterval(this.timer); this.timer = null; this.automation.close?.(); }
}
