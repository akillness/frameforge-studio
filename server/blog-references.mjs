import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { HttpError } from './validation.mjs';

const HOSTS = new Set(['in.naver.com', 'blog.naver.com', 'm.blog.naver.com']);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_POSTS = 3;
const RIGHTS = 'Public references are for structural analysis only, not permission to reuse text, photographs, illustrations, screenshots, or image URLs. Write original prose in the account persona and use independently created or explicitly rights-cleared assets.';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, code, message) => { const error = new HttpError(status, message); error.code = code; error.statusCode = status; throw error; };
const clean = (value) => String(value || '').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const excerpt = (value, max = 160) => clean(value).slice(0, max);
const normalized = (value) => clean(value).normalize('NFKC').toLocaleLowerCase('ko-KR');
const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

function currentCategory(account) {
  return clean(account?.nextMenu?.name || account?.menus?.[(account.menuCursor || 0) % (account.menus?.length || 1)]);
}

export function blogReferenceContextFingerprint({ account, workspace, category = currentCategory(account) }) {
  return digest(stable({
    account: { id: account?.id, accountId: account?.accountId, platform: account?.platform, persona: account?.persona, keywords: account?.keywords, menus: account?.menus, menuEntries: account?.menuEntries, menuCursor: account?.menuCursor, nextMenu: account?.nextMenu, publicUrl: account?.publicUrl, editorUrl: account?.editorUrl, sourceEvidence: account?.sourceEvidence },
    workspace: { version: workspace?.version, sourceEvidence: workspace?.sourceEvidence, sourceRoots: workspace?.sourceRoots },
    category,
    analysisPolicyVersion: 'blog-reference-policy-1', topicalMappingVersion: CATEGORY_MAPPING.version,
  }));
}

/** Exact public document paths only: never an arbitrary Naver API, redirector, or write endpoint. */
export function validateBlogReferenceUrl(value, kind = 'profile') {
  if (typeof value !== 'string' || value.length > 2000 || /[\s\\\u0000-\u001f]/.test(value)) fail(400, 'REFERENCE_URL_UNSUPPORTED', 'Use an exact public HTTPS Naver profile or article URL.');
  let url;
  try { url = new URL(value); } catch { fail(400, 'REFERENCE_URL_UNSUPPORTED', 'The reference URL is not a valid public HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.has(url.hostname) || url.hash || /%|\/\//.test(url.pathname)) fail(400, 'REFERENCE_URL_UNSUPPORTED', 'Only HTTPS in.naver.com, blog.naver.com and m.blog.naver.com public documents without credentials, ports, fragments or encoded paths are supported.');
  const ownerPattern = '[a-zA-Z0-9_-]{1,80}';
  let owner, postId;
  if (url.hostname === 'in.naver.com') {
    const match = new RegExp(`^/(${ownerPattern})/?$`).exec(url.pathname);
    if (kind !== 'profile' || !match || url.search || ['discover', 'intro', 'myfeed', 'search', 'login', 'logout'].includes(match[1].toLowerCase())) fail(400, 'REFERENCE_URL_UNSUPPORTED', 'Use the creator’s in.naver.com/<account> home and direct Naver blog article URLs, not a feed or content redirector.');
    owner = match[1];
  } else {
    const match = new RegExp(`^/(${ownerPattern})(?:/([0-9]{1,20}))?/?$`).exec(url.pathname);
    const endpoint = kind === 'profile' ? '/PostList.naver' : '/PostView.naver';
    if (url.pathname === endpoint) {
      const allowed = new Set(kind === 'profile' ? ['blogId', 'categoryNo'] : ['blogId', 'logNo', 'redirect', 'from', 'isInf']);
      if ([...url.searchParams.keys()].some((key) => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) fail(400, 'REFERENCE_URL_UNSUPPORTED', 'The reference document has unsupported query parameters.');
      owner = url.searchParams.get('blogId'); postId = url.searchParams.get('logNo');
      if (!new RegExp(`^${ownerPattern}$`).test(owner || '') || (kind === 'post' && !/^[0-9]{1,20}$/.test(postId || ''))) fail(400, 'REFERENCE_URL_UNSUPPORTED', 'The Naver reference needs an unambiguous blogId and article logNo.');
    } else {
      const verifiedQuery = kind === 'post' && [...url.searchParams.keys()].every((key) => key === 'isInf' && url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === 'true');
      if (!match || (url.search && !verifiedQuery) || (kind === 'post') !== Boolean(match[2])) fail(400, 'REFERENCE_URL_UNSUPPORTED', 'Use a Naver profile /<account> or an article /<account>/<numeric-post-id> (optionally ?isInf=true).');
      [, owner, postId] = match;
    }
  }
  return { url: url.href, owner: owner.toLowerCase(), postId: postId || null, platform: url.hostname === 'in.naver.com' ? 'naver-influencer' : 'naver-blog' };
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  const value = address.toLowerCase();
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/.test(value) && !/^2001:(?:db8|0|10|20):/.test(value) && !value.startsWith('2002:');
}

async function requestDocument(url, signal) {
  const parsed = new URL(url);
  let addresses;
  try { addresses = await lookup(parsed.hostname, { all: true, verbatim: true }); } catch { fail(503, 'REFERENCE_SOURCE_UNAVAILABLE', 'Public Naver DNS resolution failed. Try again when the public source is reachable.'); }
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) fail(422, 'REFERENCE_REDIRECT_UNSAFE', 'The public reference resolved to a non-public address and was not fetched.');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(parsed, {
      method: 'GET', signal, agent: false, autoSelectFamily: false, maxHeaderSize: 16384,
      lookup: (_host, _options, callback) => callback(null, addresses[0].address, addresses[0].family),
      headers: { accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'identity', 'user-agent': 'FrameForge-PublicReference/1.0', 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.5' },
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) { response.destroy(); resolve({ status, headers: response.headers, bytes: Buffer.alloc(0) }); return; }
      if (status !== 200) { response.destroy(); reject(Object.assign(new HttpError(503, `Public reference returned HTTP ${status}; provide a readable public page, not a login or protected article.`), { code: 'REFERENCE_SOURCE_UNAVAILABLE' })); return; }
      const type = String(response.headers['content-type'] || '');
      if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type) || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) { response.destroy(); reject(Object.assign(new HttpError(422, 'Reference must be a bounded, uncompressed public HTML document.'), { code: 'REFERENCE_ARTICLE_UNREADABLE' })); return; }
      if (Number(response.headers['content-length']) > MAX_BYTES) { response.destroy(); reject(Object.assign(new HttpError(422, 'Reference HTML exceeds the 2 MiB source limit.'), { code: 'REFERENCE_SOURCE_LIMIT' })); return; }
      const chunks = []; let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_BYTES) { response.destroy(); reject(Object.assign(new HttpError(422, 'Reference HTML exceeds the 2 MiB source limit.'), { code: 'REFERENCE_SOURCE_LIMIT' })); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, headers: response.headers, bytes: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('Public reference timed out')));
    req.on('error', reject); req.end();
  });
}

function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

function decode(bytes, headers) {
  const encoding = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(String(header(headers, 'content-type') || ''))?.[1] || /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(bytes.subarray(0, 4096).toString('ascii'))?.[1] || 'utf-8';
  try { return new TextDecoder(encoding).decode(bytes); } catch { fail(422, 'REFERENCE_ARTICLE_UNREADABLE', 'The public source uses an unsupported text encoding.'); }
}

async function boundedInspection(original, kind, inspectImpl, overallSignal, budget) {
  const originalIdentity = validateBlogReferenceUrl(original, kind);
  let url = original;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const signal = AbortSignal.any([overallSignal, AbortSignal.timeout(15000)]);
    let result;
    try {
      signal.throwIfAborted();
      result = await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Public reference deadline exceeded'));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => inspectImpl ? inspectImpl(url, { kind, signal, maxBytes: MAX_BYTES }) : requestDocument(url, signal)).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail(503, 'REFERENCE_SOURCE_UNAVAILABLE', 'Public reference inspection failed or exceeded its deadline. No popularity or article structure was inferred; retry with a readable public source.');
    }
    if (!result || typeof result !== 'object') fail(422, 'REFERENCE_ARTICLE_UNREADABLE', 'The public inspector did not return a readable document.');
    const status = result.status ?? 200;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = header(result.headers, 'location');
      if (redirects === 3 || typeof location !== 'string') fail(422, 'REFERENCE_REDIRECT_UNSAFE', 'The public reference redirect chain is missing a destination or exceeds three hops.');
      let destination;
      try { destination = new URL(location, url).href; } catch { fail(422, 'REFERENCE_REDIRECT_UNSAFE', 'The public reference redirect destination is invalid.'); }
      let identity;
      try { identity = validateBlogReferenceUrl(destination, kind); } catch { fail(422, 'REFERENCE_REDIRECT_UNSAFE', 'A public reference redirected outside the exact supported public document allowlist.'); }
      if (identity.platform !== originalIdentity.platform || identity.owner !== originalIdentity.owner || identity.postId !== originalIdentity.postId) fail(422, 'REFERENCE_REDIRECT_UNSAFE', 'A reference redirect changed the creator or article identity.');
      url = identity.url; continue;
    }
    if (status !== 200) fail(503, 'REFERENCE_SOURCE_UNAVAILABLE', `Public reference returned HTTP ${status}; choose a readable public source.`);
    const finalUrl = result.url || url;
    let finalIdentity;
    try { finalIdentity = validateBlogReferenceUrl(finalUrl, kind); } catch { fail(422, 'REFERENCE_REDIRECT_UNSAFE', 'The inspector returned a final URL outside the exact public document allowlist.'); }
    if (finalIdentity.owner !== originalIdentity.owner || finalIdentity.platform !== originalIdentity.platform || finalIdentity.postId !== originalIdentity.postId || finalUrl !== url) fail(422, 'REFERENCE_REDIRECT_UNSAFE', 'The inspector followed an unchecked redirect or changed source identity.');
    const type = header(result.headers, 'content-type');
    if (type && !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(type)) fail(422, 'REFERENCE_ARTICLE_UNREADABLE', 'The public reference is not an HTML document.');
    const bytes = result.bytes ? Buffer.from(result.bytes) : typeof result.html === 'string' ? Buffer.from(result.html) : null;
    if (!bytes || !bytes.length) fail(422, 'REFERENCE_ARTICLE_UNREADABLE', 'The public reference HTML is empty or unavailable.');
    budget.bytes += bytes.length; budget.documents++;
    if (bytes.length > MAX_BYTES || budget.bytes > MAX_TOTAL_BYTES || budget.documents > 8) fail(422, 'REFERENCE_SOURCE_LIMIT', 'Public reference analysis exceeded its bounded document or byte limit. Choose at most three shorter sample articles.');
    return { url, html: decode(bytes, result.headers), sha256: digest(bytes), bytes: bytes.length, identity: finalIdentity, kind };
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
function entities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, key) => {
    if (key[0] !== '#') return ENTITIES[key.toLowerCase()] ?? all;
    const number = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : ' ';
  });
}

// Inert bounded source parser: no browser, scripts, stylesheets, assets, or HTML execution.
function parseHtml(html) {
  const root = { tag: 'root', attrs: {}, children: [], parent: null, start: 0, end: html.length };
  const nodes = [root], stack = [root];
  const tokens = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z](?:"[^"]*"|'[^']*'|[^'"<>])*(?:>|$)|[^<]+|</g;
  let match;
  let nodeCount = 0;
  while ((match = tokens.exec(html))) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const tag = /^<\/([\w-]+)/.exec(token)?.[1].toLowerCase();
      const index = stack.findLastIndex((node) => node.tag === tag);
      if (index > 0) { for (const node of stack.splice(index)) node.end = tokens.lastIndex; }
      continue;
    }
    if (token.startsWith('<') && /^<[a-z]/i.test(token)) {
      const tag = /^<([\w-]+)/.exec(token)[1].toLowerCase();
      if (['script', 'style', 'template', 'noscript', 'svg'].includes(tag)) {
        const closer = new RegExp(`</${tag}\\s*>`, 'gi'); closer.lastIndex = tokens.lastIndex;
        const end = closer.exec(html); tokens.lastIndex = end ? closer.lastIndex : html.length; continue;
      }
      const attrs = Object.create(null);
      const attributePattern = /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      attributePattern.lastIndex = tag.length + 1;
      let attribute;
      while ((attribute = attributePattern.exec(token))) {
        const key = attribute[1].toLowerCase();
        if (!(key in attrs)) attrs[key] = entities(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      }
      const parent = stack.at(-1);
      const hidden = Boolean(parent.hidden || 'hidden' in attrs || attrs['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs.style || ''));
      const node = { tag, attrs, children: [], parent, hidden, start: match.index, end: tokens.lastIndex };
      if (!hidden) nodes.push(node);
      parent.children.push(node);
      if (++nodeCount > 40000 || stack.length > 100) fail(422, 'REFERENCE_SOURCE_LIMIT', 'Reference markup exceeds the safe structural complexity limit.');
      if (!['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag) && !/\/\s*>$/.test(token)) stack.push(node);
    } else { stack.at(-1).children.push({ tag: '#text', value: entities(token), start: match.index, end: tokens.lastIndex }); }
  }
  for (const node of stack) node.end = html.length;
  return { root, nodes };
}
function textOf(node) {
  if (node.hidden) return '';
  if (node.tag === '#text') return node.value;
  if (node.tag === 'br') return '\n';
  return node.children.map(textOf).join('');
}
const hasClass = (node, pattern) => pattern.test(node.attrs?.class || '');
function descendants(node) {
  const result = [], queue = [...node.children];
  while (queue.length) { const child = queue.pop(); if (child.tag !== '#text' && !child.hidden) { result.push(child); queue.push(...child.children); } }
  return result.sort((a, b) => a.start - b.start);
}
function ancestor(node, predicate) {
  for (let parent = node.parent; parent; parent = parent.parent) if (predicate(parent)) return parent;
  return null;
}
function linkedBlogChannels(document) {
  const channels = [];
  for (const node of document.nodes) {
    if (!hasClass(node, /(?:^|\s)hm-component-activeChannels-item(?:\s|$)/) || node.attrs['data-servicetype'] !== 'NBLOG' || !node.attrs['data-channelurl']) continue;
    let identity;
    try { identity = validateBlogReferenceUrl(node.attrs['data-channelurl'], 'profile'); } catch { continue; }
    if (identity.platform !== 'naver-blog') continue;
    const children = descendants(node);
    const link = children.find((child) => child.tag === 'a' && hasClass(child, /(?:^|\s)hm-component-activeChannels-link(?:\s|$)/));
    if (!link?.attrs.href) continue;
    try { const linkedIdentity = validateBlogReferenceUrl(new URL(link.attrs.href, document.url).href, 'profile'); if (linkedIdentity.owner !== identity.owner || linkedIdentity.platform !== 'naver-blog') continue; } catch { continue; }
    const counter = descendants(link).find((child) => hasClass(child, /(?:^|\s)hm-component-activeChannels-subscriber(?:\s|$)/));
    channels.push({ owner: identity.owner, counter });
  }
  return channels;
}

function metric(document, observedAt) {
  const scopes = document.nodes.filter((node) => node.tag === 'a' && node.attrs['data-role'] === 'fan' && node.attrs['data-clickcode'] === 'homeCover.fanCount' && ancestor(node, (parent) => hasClass(parent, /(?:^|\s)hm-component-homeCover-profile-info(?:\s|$)/))).map((node) => ({ node, allowedKind: 'fans', owner: document.identity.owner }));
  scopes.push(...linkedBlogChannels(document).filter((channel) => channel.counter).map((channel) => ({ node: channel.counter, allowedKind: 'neighbors', owner: channel.owner })));
  const label = '(팬(?:\\s*수)?|이웃(?:\\s*수)?|구독자(?:\\s*수)?|팔로워|followers?|subscribers?|fans?|neighbors?)';
  const count = '(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)(?:\\s*(만|천|[kKmM]))?(\\+)?';
  const patterns = [new RegExp(`(?:^|[\\s:：])${label}\\s*[:：]?\\s*${count}(?:\\s*명)?(?:$|\\s)`, 'i'), new RegExp(`(?:^|\\s)${count}\\s*(?:명\\s*)?${label}(?:$|\\s)`, 'i')];
  const observations = [];
  for (const { node, allowedKind, owner } of scopes) {
    const value = clean(textOf(node));
    if (!value || value.length > 100 || /(?:조회|방문|좋아요|views?|visits?|likes?|총\s*구독|영향력)/i.test(value)) continue;
    for (const [index, pattern] of patterns.entries()) {
      const found = pattern.exec(value);
      if (!found) continue;
      const [rawLabel, rawCount, suffix, plus] = index === 0 ? found.slice(1) : [found[4], found[1], found[2], found[3]];
      const kind = /^(?:팬|fans?)/i.test(rawLabel) ? 'fans' : /^(?:이웃|neighbors?)/i.test(rawLabel) ? 'neighbors' : /^(?:구독|subscribers?)/i.test(rawLabel) ? 'subscribers' : 'followers';
      const multiplier = suffix === '만' ? 10000 : suffix === '천' || /^k$/i.test(suffix || '') ? 1000 : /^m$/i.test(suffix || '') ? 1000000 : 1;
      const audience = Number(rawCount.replaceAll(',', '')) * multiplier;
      if (kind !== allowedKind || !Number.isSafeInteger(audience) || audience < 0 || audience > 10000000000) continue;
      observations.push({ kind, count: audience, audienceOwnerId: owner, url: document.url, observedAt, excerpt: excerpt(found[0]), sha256: document.sha256, precision: plus ? 'displayed-lower-bound' : suffix ? 'displayed-approximate' : 'exact-displayed' });
    }
  }
  if (!observations.length) fail(422, 'REFERENCE_METRIC_UNVERIFIED', 'No publicly readable labelled followers, subscribers, fans or neighbors count was found in this creator profile. JavaScript-only, aggregate influence, visits, views and likes are not proof; choose a public profile displaying the actual audience metric.');
  const kinds = new Map();
  for (const observation of observations) {
    const prior = kinds.get(observation.kind);
    if (prior && prior.count !== observation.count) fail(422, 'REFERENCE_METRIC_UNVERIFIED', 'Conflicting audience counts were observed. Use a profile with one unambiguous creator audience metric.');
    kinds.set(observation.kind, observation);
  }
  const verified = [...kinds.values()].filter((item) => item.precision !== 'displayed-approximate').sort((a, b) => b.count - a.count);
  const selected = verified[0];
  if (!selected || selected.count < 100000) {
    if ([...kinds.values()].some((item) => item.precision === 'displayed-approximate' && item.count >= 100000)) fail(422, 'REFERENCE_METRIC_UNVERIFIED', 'The abbreviated audience display has no explicit plus/lower-bound marker. Its rounding cannot prove at least 100000; choose an exact count or an explicit 100000+ public metric.');
    fail(422, 'REFERENCE_AUDIENCE_TOO_SMALL', `The observed ${selected?.kind || 'audience'} count is ${selected?.count ?? 'below the threshold'}; a publicly observed count of at least 100000 is required.`);
  }
  return selected;
}

function articleRoot(document) {
  const candidate = document.nodes.find((node) => hasClass(node, /(?:^|\s)se-main-container(?:\s|$)/)) || document.nodes.find((node) => node.attrs.id === 'postViewArea') || document.nodes.find((node) => node.tag === 'article') || document.nodes.find((node) => node.attrs.id === 'post-view' || hasClass(node, /(?:^|\s)post_ct(?:\s|$)/));
  if (candidate) return candidate;
  const articleMeta = document.nodes.some((node) => node.tag === 'meta' && node.attrs.property === 'og:type' && node.attrs.content === 'article');
  if (articleMeta && document.nodes.some((node) => /^h[12]$/.test(node.tag))) return document.nodes.find((node) => node.tag === 'main') || document.nodes.find((node) => node.tag === 'body') || document.root;
  return null;
}

// Deliberately small lexical equivalence registry, not a model guess or caller-supplied taxonomy.
const CATEGORY_MAPPING = { version: 'blog-topical-equivalence-1', domain: 'parenting', terms: ['육아', '양육', '부모', '유아'], relatedArticleTopics: ['아이', '자녀', '아기', '어린이', '유치원', '초등', '공부하기', '혼자 자기'] };

function profileCategoryLabels(profile) {
  return profile.nodes.filter((node) => hasClass(node, /(?:^|\s)hm-component-homeCover-profile-meta-item(?:\s|$)/) && node.attrs['data-role'] !== 'fan' && ancestor(node, (parent) => hasClass(parent, /(?:^|\s)hm-component-homeCover-profile-info(?:\s|$)/))).map((node) => excerpt(textOf(node), 80)).filter(Boolean).slice(0, 4);
}

function articleCategoryLabels(document) {
  const labels = [];
  for (const node of document.nodes) {
    if (node.tag !== 'a' || !node.attrs.href || !ancestor(node, (parent) => hasClass(parent, /(?:^|\s)blog_category(?:\s|$)/)) || !ancestor(node, (parent) => hasClass(parent, /(?:^|\s)se-documentTitle(?:\s|$)/))) continue;
    let link;
    try { link = new URL(node.attrs.href, document.url); } catch { continue; }
    if (!['blog.naver.com', 'm.blog.naver.com'].includes(link.hostname) || link.protocol !== 'https:' || link.username || link.password || link.port || link.pathname !== '/PostList.naver' || link.searchParams.getAll('blogId').length !== 1 || link.searchParams.get('blogId')?.toLowerCase() !== document.identity.owner || link.searchParams.getAll('categoryNo').length !== 1 || !/^\d{1,10}$/.test(link.searchParams.get('categoryNo') || '')) continue;
    const label = excerpt(textOf(node), 80);
    if (label) labels.push({ label, categoryNo: link.searchParams.get('categoryNo') });
  }
  return labels.slice(0, 4);
}

function matchingEvidence(document, root, terms, category, profile) {
  const rawProfileCategoryLabels = profileCategoryLabels(profile), rawArticleCategoryLabels = articleCategoryLabels(document);
  const body = descendants(root).filter((node) => /^(?:h[1-6]|p|li|figcaption)$/.test(node.tag)).map((node) => ({ value: clean(textOf(node)), kind: 'public-article-content' }));
  const titles = document.nodes.filter((node) => node.tag === 'meta' && node.attrs.property === 'og:title').map((node) => ({ value: clean(node.attrs.content), kind: 'public-article-title' }));
  const matches = (value, keywords) => keywords.filter((keyword) => normalized(value).includes(normalized(keyword)));
  const record = (item, matchedTerms) => ({ kind: item.kind, matchedTerms, excerpt: excerpt(item.value), url: document.url, sha256: document.sha256 });
  if (matches(category, CATEGORY_MAPPING.terms).length) {
    const profileMatches = rawProfileCategoryLabels.filter((label) => matches(label, CATEGORY_MAPPING.terms).length);
    if (!profileMatches.length || !matches(rawProfileCategoryLabels[0], CATEGORY_MAPPING.terms).length) fail(422, 'REFERENCE_CATEGORY_UNVERIFIED', 'The current menu maps to parenting, but the inspected primary official profile category does not publicly support that domain. A secondary interest, persona or free-text biography is not category evidence.');
    if (rawArticleCategoryLabels.some(({ label }) => !matches(label, CATEGORY_MAPPING.terms).length)) fail(422, 'REFERENCE_CATEGORY_UNVERIFIED', 'The article’s observed official category conflicts with the current parenting menu; an incidental keyword cannot override that category.');
    const directTitles = titles.filter(({ value }) => value.length >= 8 && matches(value, CATEGORY_MAPPING.terms).length);
    const directBody = body.filter(({ value }) => value.length >= 20 && matches(value, CATEGORY_MAPPING.terms).length);
    const categoryAnchoredTopics = rawArticleCategoryLabels.length ? [...titles.filter(({ value }) => value.length >= 8), ...body.filter(({ value }) => value.length >= 20)].filter(({ value }) => matches(value, [...CATEGORY_MAPPING.terms, ...CATEGORY_MAPPING.relatedArticleTopics]).length) : [];
    const substantive = directTitles.length ? directTitles : directBody.length >= 2 ? directBody : categoryAnchoredTopics;
    if (!substantive.length) fail(422, 'REFERENCE_CATEGORY_UNVERIFIED', 'The official profile is parenting-related, but the representative article category/title/body does not substantively support parenting. Choose a relevant article rather than a generic footer, biography, or unrelated post.');
    const supportingExcerpts = substantive.slice(0, 2).map((item) => record(item, matches(item.value, [...CATEGORY_MAPPING.terms, ...CATEGORY_MAPPING.relatedArticleTopics])));
    return { status: 'supported-by-public-content', category, rawTargetMenu: category, domain: CATEGORY_MAPPING.domain, rawProfileCategoryLabels, rawArticleCategoryLabels, mapping: { version: CATEGORY_MAPPING.version, provenance: 'Explicit local lexical domain equivalence; official profile and same-author article evidence are both required.', targetTerms: matches(category, CATEGORY_MAPPING.terms), profileTerms: [...new Set(profileMatches.flatMap((label) => matches(label, CATEGORY_MAPPING.terms)))], articleTerms: [...new Set([...rawArticleCategoryLabels.flatMap(({ label }) => matches(label, CATEGORY_MAPPING.terms)), ...supportingExcerpts.flatMap((item) => item.matchedTerms)])] }, matchedTerms: [...new Set(supportingExcerpts.flatMap((item) => item.matchedTerms))], profileEvidence: { url: profile.url, sha256: profile.sha256, excerpt: excerpt(profileMatches.join(' / ')) }, supportingExcerpts, uncertainty: 'Evidence-backed lexical topical equivalence, not an expertise, biography, or factual-claim endorsement. Only this explicit domain mapping is supported.' };
  }
  const matched = [...body, ...titles].filter(({ value }) => value.length >= 8).map((item) => record(item, matches(item.value, terms))).filter((item) => item.matchedTerms.length);
  if (!matched.length) fail(422, 'REFERENCE_CATEGORY_UNVERIFIED', `No substantive article heading or paragraph supports the current category “${excerpt(category, 100)}” or its menu-specific keywords. No topical equivalence mapping exists for this menu; a generic account keyword or caller label is not evidence.`);
  return { status: 'supported-by-public-content', category, rawTargetMenu: category, rawProfileCategoryLabels, rawArticleCategoryLabels, matchedTerms: [...new Set(matched.flatMap((item) => item.matchedTerms))], supportingExcerpts: matched.slice(0, 2), uncertainty: 'Direct lexical content evidence, not an inferred biography or independent expertise verification.' };
}

function measure(document, root) {
  const nodes = descendants(root);
  const paragraphs = nodes.filter((node) => node.tag === 'p' && !ancestor(node, (item) => item !== root && ['figcaption', 'blockquote'].includes(item.tag)));
  const lengths = paragraphs.map((node) => [...clean(textOf(node))].length).filter(Boolean);
  if (lengths.reduce((sum, value) => sum + value, 0) < 80 || lengths.length < 2) fail(422, 'REFERENCE_ARTICLE_UNREADABLE', 'The sample does not expose at least two substantive paragraphs (80 characters total). Login pages, teaser cards, empty JS shells and unreadable articles cannot establish a layout.');
  const headingNodes = nodes.filter((node) => /^h[1-6]$/.test(node.tag) || hasClass(node, /(?:^|\s)se-(?:sectionTitle|documentTitle)(?:\s|$)/));
  const headings = headingNodes.map((node) => ({ level: /^h[1-6]$/.test(node.tag) ? Number(node.tag[1]) : hasClass(node, /documentTitle/) ? 1 : 2, characters: [...clean(textOf(node))].length })).filter((item) => item.characters);
  const blocks = nodes.filter((node) => node.tag === 'p' || /^h[1-6]$/.test(node.tag) || node.tag === 'img' || hasClass(node, /(?:^|\s)se-sectionTitle(?:\s|$)/));
  const images = [], nonemptyParagraphs = new Set(paragraphs.filter((node) => clean(textOf(node))));
  let paragraphsBefore = 0, imageCount = 0, dimensionsObserved = 0;
  for (const [blockIndex, node] of blocks.entries()) {
    if (nonemptyParagraphs.has(node)) paragraphsBefore++;
    if (node.tag !== 'img') continue;
    imageCount++;
    const dimension = (name) => {
      const explicit = node.attrs[name] || node.attrs[`data-${name}`];
      const inline = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(\\d+(?:\\.\\d+)?)px(?:;|$)`, 'i').exec(node.attrs.style || '')?.[1];
      const value = Number(explicit || inline);
      return value > 0 && value <= 20000 ? value : null;
    };
    const width = dimension('width'), height = dimension('height');
    if (width && height) dimensionsObserved++;
    if (images.length < 40) images.push({ index: imageCount, blockIndex, paragraphsBefore, relativePosition: Number((blockIndex / Math.max(1, blocks.length - 1)).toFixed(3)), width, height, aspectRatio: width && height ? Number((width / height).toFixed(3)) : null, captionPresent: Boolean(ancestor(node, (item) => item.tag === 'figure')?.children.some((child) => child.tag === 'figcaption' && clean(textOf(child)))) });
  }
  const sorted = [...lengths].sort((a, b) => a - b);
  const firstHeading = headingNodes.find((node) => !hasClass(node, /documentTitle/) && node.tag !== 'h1');
  const firstBody = firstHeading ? paragraphs.filter((node) => node.start < firstHeading.start && clean(textOf(node))).length : null;
  const blankParagraphs = paragraphs.length - lengths.length;
  const styleValues = (property) => [...new Set(nodes.map((node) => new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(node.attrs.style || '')?.[1]?.trim()).filter((value) => value && (property === 'text-align' ? /^(?:left|right|center|justify|start|end)$/i.test(value) : /^(?:normal|0|\d{1,4}(?:\.\d{1,3})?(?:px|em|rem|%)?)$/i.test(value))))].slice(0, 5);
  return {
    headings: { count: headings.length, levels: headings.slice(0, 100), omittedLevels: Math.max(0, headings.length - 100), titleCharacters: headings.find((item) => item.level === 1)?.characters ?? null },
    paragraphs: { count: lengths.length, minCharacters: sorted[0], medianCharacters: sorted[Math.floor(sorted.length / 2)], maxCharacters: sorted.at(-1), meanCharacters: Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length), blankParagraphs, explicitLineBreaks: nodes.filter((node) => node.tag === 'br').length },
    images: { count: imageCount, positions: images, dimensionsObserved, omittedPositions: Math.max(0, imageCount - 40) },
    formatting: { boldRuns: nodes.filter((node) => ['strong', 'b'].includes(node.tag)).length, lists: nodes.filter((node) => ['ul', 'ol'].includes(node.tag)).length, quotes: nodes.filter((node) => node.tag === 'blockquote').length, inlineTextAlign: styleValues('text-align'), inlineLineHeight: styleValues('line-height'), inlineMarginBottom: styleValues('margin-bottom'), externalCss: 'not-fetched; computed spacing/font sizes are unverified' },
    flow: { introParagraphsBeforeFirstSection: firstBody, bodySectionHeadings: headings.filter((item) => item.level > 1).length, finalParagraphCharacters: lengths.at(-1), closingLabelObserved: headingNodes.some((node) => /(?:마무리|정리|결론|총평|요약|conclusion|summary|closing)/i.test(clean(textOf(node)))), semanticIntent: 'Positions and lengths observed; intro/closing rhetorical intent is not inferred when not labelled.' },
  };
}

function plans(references, account) {
  const result = { layout: [], images: [], formatting: [], adaptation: [] };
  const mediaPolicy = account.platform === 'naver' ? 'Adapt pacing to the Naver account’s canonical 2+1 media policy (three original assets), without increasing that limit.' : 'Adapt pacing to this account/workspace’s existing platform-specific media package and asset budget; do not replace it with a Naver 2+1 policy or infer a new image quota.';
  for (const reference of references) {
    const measurement = reference.measurements;
    const plan = (guidance, kind) => ({ guidance, basedOn: [`${reference.observations[0].id.split(':')[0]}:${kind}`], sourceUrls: [reference.sourceUrl] });
    result.layout.push(plan(`Use an original title and adapt the observed section/paragraph rhythm, not copied headings. Observed sample: ${measurement.headings.count} headings, ${measurement.flow.bodySectionHeadings} labelled body section headings, ${measurement.paragraphs.count} nonempty paragraphs; ${measurement.flow.introParagraphsBeforeFirstSection === null ? 'no labelled first section was observable, so do not claim an intro boundary' : `${measurement.flow.introParagraphsBeforeFirstSection} paragraphs precede the first section`}. The last paragraph is ${measurement.flow.finalParagraphCharacters} characters; ${measurement.flow.closingLabelObserved ? 'an explicit closing label was observed' : 'closing intent is unverified'}.`, 'layout'));
    const observedRatios = measurement.images.positions.filter((item) => item.aspectRatio).map((item) => item.aspectRatio);
    result.images.push(plan(`Observed ${measurement.images.count} article image elements at paragraph offsets [${measurement.images.positions.map((item) => item.paragraphsBefore).join(', ')}]${measurement.images.omittedPositions ? `; ${measurement.images.omittedPositions} additional positions omitted` : ''}. ${observedRatios.length ? `Observable width/height ratios: [${observedRatios.join(', ')}].` : 'Image proportions are not exposed by source HTML; do not invent an aspect ratio.'} This source count is not an asset-generation quota. ${mediaPolicy} Paid assets still require explicit consent. Use original or explicitly rights-cleared visuals and descriptive alt text, never source images or their URLs.`, 'images'));
    result.formatting.push(plan(`Target the observed paragraph rhythm (median ${measurement.paragraphs.medianCharacters}, range ${measurement.paragraphs.minCharacters}–${measurement.paragraphs.maxCharacters} characters), adapting for readability rather than reproducing sentences. The sample has ${measurement.paragraphs.blankParagraphs} blank paragraph elements, ${measurement.paragraphs.explicitLineBreaks} explicit line breaks, ${measurement.formatting.boldRuns} bold runs and ${measurement.formatting.lists} lists. ${measurement.formatting.inlineLineHeight.length ? `Source-declared inline line heights: ${measurement.formatting.inlineLineHeight.join(', ')}.` : 'Computed line spacing and fonts are unverified because external stylesheets were not fetched.'}`, 'formatting'));
    result.adaptation.push({ guidance: `Apply the measured structure only to the current account’s configured persona and category. Preserve its own vocabulary, first-person limits and factual evidence; do not adopt the influencer’s biography, claims, distinctive prose or visuals. Use the current persona as authoring context, not a source fact. Account persona binding: ${digest(stable(account.persona || '')).slice(0, 16)}.`, basedOn: reference.observations.map((item) => item.id), sourceUrls: [reference.sourceUrl] });
  }
  return result;
}

/** Public reads only. inspectImpl is a server-owned fixture seam, never a request-body option. */
export async function analyzeBlogReferences({ account, workspace, input, inspectImpl, now = () => new Date() }) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['profileUrl', 'postUrls', 'category', 'categoryEvidence', 'expectedVersion'].includes(key))) fail(400, 'REFERENCE_INPUT_INVALID', 'Provide profileUrl and one to three direct public postUrls. Caller HTML, audience counts and observation evidence are not accepted.');
  if (inspectImpl !== undefined && typeof inspectImpl !== 'function') fail(400, 'REFERENCE_INPUT_INVALID', 'The server-owned public inspector must be a function.');
  const category = currentCategory(account);
  if (!category || (input.category !== undefined && (typeof input.category !== 'string' || normalized(input.category) !== normalized(category)))) fail(422, 'REFERENCE_CATEGORY_UNVERIFIED', 'The reference category must equal the current account menu; select a current menu before analysis.');
  if (!Array.isArray(input.postUrls) || input.postUrls.length < 1 || input.postUrls.length > MAX_POSTS || new Set(input.postUrls).size !== input.postUrls.length) fail(400, 'REFERENCE_INPUT_INVALID', 'Provide one to three distinct representative postUrls from the inspected creator.');
  validateBlogReferenceUrl(input.profileUrl, 'profile');
  for (const url of input.postUrls) validateBlogReferenceUrl(url, 'post');
  const menuKeywords = Array.isArray(account?.nextMenu?.keywords) ? account.nextMenu.keywords : [];
  const terms = [...new Set([category, ...menuKeywords].filter((term) => typeof term === 'string' && clean(term).length >= 2 && clean(term).length <= 120))].slice(0, 40);
  if (!terms.length) fail(422, 'REFERENCE_CATEGORY_UNVERIFIED', 'Configure a specific current menu or its menu-specific category keywords before reference analysis.');
  const instant = typeof now === 'function' ? now() : now;
  let observedAt;
  try { observedAt = new Date(instant).toISOString(); } catch { fail(400, 'REFERENCE_INPUT_INVALID', 'The observation clock must provide a valid date.'); }
  const overallSignal = AbortSignal.timeout(45000), budget = { bytes: 0, documents: 0 }, sourceRegistry = [];
  const inspect = async (url, kind) => {
    const document = await boundedInspection(url, kind, inspectImpl, overallSignal, budget);
    Object.assign(document, parseHtml(document.html));
    sourceRegistry.push({ url: document.url, sha256: document.sha256, observedAt, kind, bytes: document.bytes });
    return document;
  };
  const mobileUrl = (url) => { const parsed = new URL(url); if (parsed.hostname === 'blog.naver.com') parsed.hostname = 'm.blog.naver.com'; return parsed.href; };
  const profile = await inspect(mobileUrl(input.profileUrl), 'profile');
  const metricEvidence = metric(profile, observedAt);
  const owners = new Set(linkedBlogChannels(profile).map((channel) => channel.owner));
  if (profile.identity.platform === 'naver-blog') owners.add(profile.identity.owner);
  const references = [];
  for (const [index, requestedUrl] of input.postUrls.entries()) {
    const identity = validateBlogReferenceUrl(requestedUrl, 'post');
    if (!owners.has(identity.owner)) fail(422, 'REFERENCE_AUTHOR_UNVERIFIED', 'The sample article’s blog account is not the inspected profile account or an observed profile outbound blog link. Supply articles from that creator’s linked Naver blog.');
    if (metricEvidence.kind === 'neighbors' && metricEvidence.audienceOwnerId !== identity.owner) fail(422, 'REFERENCE_AUTHOR_UNVERIFIED', 'The eligible neighbors count belongs to a different linked blog than the sample article. Supply samples from the actual measured channel.');
    let document = await inspect(mobileUrl(requestedUrl), 'post');
    let root = articleRoot(document);
    if (!root) {
      const frame = document.nodes.find((node) => node.tag === 'iframe' && (node.attrs.id === 'mainFrame' || node.attrs.name === 'mainFrame'));
      if (frame?.attrs.src) {
        const frameUrl = new URL(frame.attrs.src, document.url).href;
        const frameIdentity = validateBlogReferenceUrl(frameUrl, 'post');
        if (frameIdentity.owner !== identity.owner || frameIdentity.postId !== identity.postId) fail(422, 'REFERENCE_AUTHOR_UNVERIFIED', 'The article frame changed the author or article identity.');
        document = await inspect(frameUrl, 'post'); root = articleRoot(document);
      }
    }
    if (!root) fail(422, 'REFERENCE_ARTICLE_UNREADABLE', 'The public article body was not exposed in source HTML. JavaScript-only, blocked or login-protected pages need another publicly readable sample; no layout was fabricated.');
    const authorMetadata = document.nodes.filter((node) => node.tag === 'meta' && ['naverblog:blogId', 'blogId'].includes(node.attrs.property || node.attrs.name)).map((node) => node.attrs.content?.toLowerCase()).filter(Boolean);
    if (authorMetadata.some((owner) => owner !== identity.owner)) fail(422, 'REFERENCE_AUTHOR_UNVERIFIED', 'The article metadata contradicts the requested Naver author identity.');
    const categoryEvidence = matchingEvidence(document, root, terms, category, profile);
    const measurements = measure(document, root);
    const prefix = `post${index + 1}`;
    const observations = [
      { id: `${prefix}:layout`, kind: 'layout', summary: `${measurements.headings.count} headings; ${measurements.paragraphs.count} nonempty paragraphs; ${measurements.flow.bodySectionHeadings} body section headings; final paragraph ${measurements.flow.finalParagraphCharacters} characters.` },
      { id: `${prefix}:images`, kind: 'images', summary: `${measurements.images.count} article image elements; ${measurements.images.dimensionsObserved} source-declared width/height pairs; no image bytes fetched or reusable image URLs retained.` },
      { id: `${prefix}:formatting`, kind: 'formatting', summary: `Paragraph characters median ${measurements.paragraphs.medianCharacters}, min ${measurements.paragraphs.minCharacters}, max ${measurements.paragraphs.maxCharacters}; ${measurements.paragraphs.blankParagraphs} blank paragraph elements; ${measurements.paragraphs.explicitLineBreaks} br elements.` },
    ].map((item) => ({ ...item, sourceUrl: document.url, sha256: document.sha256, observedAt }));
    references.push({ url: identity.url, sourceUrl: document.url, sha256: document.sha256, observedAt, authorId: identity.owner, ownership: { method: profile.identity.platform === 'naver-blog' && profile.identity.owner === identity.owner ? 'same-platform-account' : 'observed-profile-outbound-blog-link', profileUrl: profile.url, profileSha256: profile.sha256, authorId: identity.owner }, categoryEvidence, measurements, observations });
  }
  const analysis = plans(references, account);
  const contextFingerprint = blogReferenceContextFingerprint({ account, workspace, category });
  const fingerprint = digest(stable({ contextFingerprint, sources: sourceRegistry.map(({ url, sha256, kind }) => ({ url, sha256, kind })), metric: { kind: metricEvidence.kind, count: metricEvidence.count, sha256: metricEvidence.sha256 }, posts: references.map(({ authorId, measurements, categoryEvidence }) => ({ authorId, measurements, categoryEvidence })), analysis, rightsStatement: RIGHTS }));
  return { category, metricEvidence, references, analysis, sourceRegistry, rightsStatement: RIGHTS, fingerprint, contextFingerprint, status: 'analyzed', observedAt };
}
