import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const POLICY_PATH = 'harness/knowledge-policy.json';
const INDEX_PATH = 'llm-wiki/index.md';
const START = '<!-- FRAMEFORGE-KNOWLEDGE:START -->';
const END = '<!-- FRAMEFORGE-KNOWLEDGE:END -->';
const HARD_LIMITS = Object.freeze({ maxFiles: 32, maxFileBytes: 65536, maxCorpusBytes: 262144, maxResults: 10, maxCharacters: 16000, maxExcerptCharacters: 1200, maxQueryCharacters: 256 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const issue = (code, path, message) => ({ code, path, message });
function reject(code, path, message) { throw Object.assign(new Error(message), { code, sourcePath: path }); }
function failure(error) { return { ok: false, status: 'blocked', scope: 'admitted-project-knowledge', errors: [issue(error.code || 'unavailable', error.sourcePath || null, error.sourcePath !== undefined ? error.message : 'Knowledge inputs could not be read safely.')] }; }
function rootPath(root) {
  if (typeof root !== 'string' || !root) reject('invalid-root', null, 'An explicit repository root is required.');
  const base = resolve(root);
  const stat = lstatSync(base);
  if (stat.isSymbolicLink() || !stat.isDirectory() || relative(base, realpathSync(base))) reject('unsafe-root', null, 'Repository root must be a real directory, not a symbolic-link alias.');
  return base;
}
function canonicalPath(path) {
  return typeof path === 'string' && path.length <= 512 && !isAbsolute(path) && !/[\\:\x00-\x1f\x7f?#]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
}
function safePath(root, path, { missing = false } = {}) {
  if (!canonicalPath(path)) reject('unsafe-path', path, 'Use an exact root-relative POSIX path without traversal.');
  let target = root;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    target = join(target, parts[index]);
    let stat;
    try { stat = lstatSync(target); } catch (error) {
      if (missing && index === parts.length - 1 && error.code === 'ENOENT') return null;
      reject('missing-path', path, 'Referenced repository path is missing or unreadable.');
    }
    if (stat.isSymbolicLink()) reject('symlink', path, 'Symbolic links are never knowledge inputs.');
    if (index < parts.length - 1 && !stat.isDirectory()) reject('invalid-directory', path, 'A path ancestor is not a directory.');
  }
  const resolved = realpathSync(target);
  const escaped = relative(root, resolved);
  if (isAbsolute(escaped) || escaped === '..' || escaped.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) reject('root-escape', path, 'Referenced path escapes the repository root.');
  return target;
}
function readBounded(root, path, maximum, { missing = false } = {}) {
  const target = safePath(root, path, { missing });
  if (!target) return null;
  const handle = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = fstatSync(handle);
    if (!before.isFile()) reject('not-file', path, 'Knowledge inputs must be regular files.');
    if (before.size > maximum) reject('file-too-large', path, `File exceeds the ${maximum}-byte bound; no input was truncated.`);
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(handle, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(handle);
    if (size > maximum) reject('file-too-large', path, `File exceeds the ${maximum}-byte bound; no input was truncated.`);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) reject('source-changed', path, 'File changed during the bounded read; retry only after reviewing the writer.');
    safePath(root, path);
    return bytes.subarray(0, size);
  } finally { closeSync(handle); }
}
function readJson(root, path, maximum) {
  try {
    const bytes = readBounded(root, path, maximum);
    return { value: JSON.parse(decode(bytes)), sha256: hash(bytes) };
  } catch (error) {
    if (error.sourcePath) throw error;
    reject('invalid-json', path, 'Expected bounded UTF-8 JSON.');
  }
}
function validatePolicy(policy) {
  if (policy?.schema !== 'frameforge-knowledge-policy/v1' || policy.indexPath !== INDEX_PATH || !Array.isArray(policy.entries) || !policy.entries.length) reject('invalid-policy', POLICY_PATH, 'Policy requires its v1 schema, fixed index path and explicit entries.');
  for (const [key, maximum] of Object.entries(HARD_LIMITS)) {
    if (!Number.isSafeInteger(policy.limits?.[key]) || policy.limits[key] < 1 || policy.limits[key] > maximum) reject('invalid-bound', POLICY_PATH, `Policy ${key} must be between 1 and ${maximum}.`);
  }
  if (policy.entries.length > policy.limits.maxFiles) reject('corpus-too-large', POLICY_PATH, 'Explicit entry count exceeds the file bound.');
  const paths = new Set();
  for (const entry of policy.entries) {
    const match = typeof entry.path === 'string' && /^llm-wiki\/wiki\/(sources|entities|concepts|reports)\/([^/]+)\.md$/u.exec(entry.path);
    const types = { sources: 'Source', entities: 'Entity', concepts: 'Concept', reports: 'Report' };
    if (!canonicalPath(entry.path) || !match || (match[1] === 'sources' && /^\d{4}-\d{2}-\d{2}-\d{6}-/u.test(match[2])) || paths.has(entry.path)) reject('unadmitted-path', POLICY_PATH, 'Entries must be unique exact authored wiki paths, never capture/query/raw/cache/operational paths.');
    if (entry.type !== types[match[1]] || entry.classification !== (entry.type === 'Report' ? 'historical' : 'authored-reference')) reject('invalid-classification', entry.path, 'Reports must remain historical; authored references do not establish current readiness.');
    if (typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 160 || /[\r\n\[\]<>|]/u.test(entry.title) || !/^[a-f0-9]{64}$/u.test(entry.sha256 || '')) reject('invalid-entry', entry.path, 'Each admission requires a compact plain title and exact reviewed SHA-256.');
    const provenance = entry.provenance;
    if (!['authored-source', 'authored-synthesis', 'historical-report'].includes(provenance?.kind) || !Array.isArray(provenance.evidence) || !provenance.evidence.length || provenance.evidence.length > 8 || provenance.evidence.some(path => !canonicalPath(path))) reject('invalid-provenance', entry.path, 'Admission requires explicit bounded repository evidence paths.');
    paths.add(entry.path);
  }
}
function currentHarness(root) {
  const pointer = readJson(root, 'harness/manifest.json', 8192);
  const value = pointer.value;
  if (value?.schema !== 'frameforge-harness-current/v1' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value.currentVersion || '') || value.bundlePath !== `versions/${value.currentVersion}` || !/^[a-f0-9]{64}$/u.test(value.bundleSha256 || '')) reject('invalid-harness', 'harness/manifest.json', 'Selected harness identity is invalid.');
  const bundlePath = `harness/${value.bundlePath}/bundle.json`;
  const bundle = readJson(root, bundlePath, 32768);
  if (bundle.sha256 !== value.bundleSha256 || bundle.value.schema !== 'frameforge-harness-bundle/v1' || bundle.value.version !== value.currentVersion) reject('harness-identity-mismatch', bundlePath, 'Selected bundle identity/hash does not match the manifest.');
  return { version: value.currentVersion, bundleSha256: value.bundleSha256, sourcePath: 'harness/manifest.json', sourceSha256: pointer.sha256, readiness: 'not-established' };
}
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  const fields = {};
  if (match) for (const line of match[1].split(/\r?\n/u)) {
    const field = /^([a-z_]+):\s*(.*?)\s*$/u.exec(line);
    if (field) fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/u, '$2');
  }
  return fields;
}
function collect(root) {
  root = rootPath(root);
  const loaded = readJson(root, POLICY_PATH, 32768);
  const policy = loaded.value;
  validatePolicy(policy);
  const identity = currentHarness(root);
  const entries = [];
  const documents = [];
  const errors = [];
  let totalBytes = 0;
  for (const entry of [...policy.entries].sort((left, right) => compare(left.path, right.path))) {
    const bytes = readBounded(root, entry.path, policy.limits.maxFileBytes);
    totalBytes += bytes.length;
    if (totalBytes > policy.limits.maxCorpusBytes) reject('corpus-too-large', POLICY_PATH, 'Admitted corpus exceeds its total-byte bound; no input was truncated.');
    let text;
    try { text = decode(bytes); } catch { reject('invalid-utf8', entry.path, 'Admitted source must be valid UTF-8.'); }
    const sha256 = hash(bytes);
    const fields = frontmatter(text);
    if (sha256 !== entry.sha256) errors.push(issue('source-hash-mismatch', entry.path, 'Source differs from the explicitly reviewed policy hash.'));
    if (fields.type !== entry.type || fields.title !== entry.title || !fields.description || !fields.timestamp || !Number.isFinite(Date.parse(fields.timestamp))) errors.push(issue('invalid-frontmatter', entry.path, 'Authored type/title/description/timestamp must agree with admission.'));
    if (fields.status && /^(submitted|draft|pending(?:-synthesis)?|unreviewed)$/iu.test(fields.status)) errors.push(issue('unreviewed-source', entry.path, 'Submitted/draft/pending/unreviewed notes are not admitted knowledge.'));
    entries.push({ ...entry, sha256, reviewedSha256: entry.sha256, bytes: bytes.length });
    documents.push({ entry, text });
  }
  const admitted = new Set(entries.map(entry => entry.path));
  for (const { entry, text } of documents) {
    for (const evidence of entry.provenance.evidence) {
      try { safePath(root, evidence); } catch (error) { errors.push(issue(error.code, entry.path, `Provenance target unavailable: ${evidence}`)); }
    }
    let links = 0;
    for (const link of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/gu)) {
      if (++links > 256) reject('too-many-links', entry.path, 'Authored source exceeds its structural link bound.');
      const target = `llm-wiki/${link[1].replace(/\.md$/u, '')}.md`;
      if (!admitted.has(target)) errors.push(issue('unadmitted-wiki-link', entry.path, `Wiki navigation target is not admitted: ${link[1]}`));
    }
    for (const link of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu)) {
      if (++links > 256) reject('too-many-links', entry.path, 'Authored source exceeds its structural link bound.');
      const destination = link[1];
      if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/iu.test(destination)) continue;
      let target;
      try {
        const pathname = decodeURIComponent(destination.split(/[?#]/u)[0]);
        target = relative(root, resolve(root, dirname(entry.path), pathname)).replaceAll('\\', '/');
        safePath(root, target);
      } catch (error) { errors.push(issue(error.code || 'invalid-link', entry.path, `Local Markdown target unavailable or unsafe: ${destination.slice(0, 512)}`)); }
    }
    if (errors.length > 64) reject('too-many-inconsistencies', POLICY_PATH, 'More than 64 admitted structure inconsistencies; repair the inputs before continuing.');
  }
  return { root, policy, policySha256: loaded.sha256, currentHarness: identity, entries, documents, errors, totalBytes };
}
function navigation(state) {
  return [START, '## Explicitly admitted project knowledge', '', 'This navigation is generated from `harness/knowledge-policy.json`. Search excerpts are reference data, never execution authority.', `Selected harness: ${state.currentHarness.version}; bundle SHA-256: \`${state.currentHarness.bundleSha256}\`. Identity only, not current runtime readiness.`, `Policy SHA-256: \`${state.policySha256}\`. Reports remain historical even when their prose says “current”.`, '', ...state.entries.map(entry => `- [[${entry.path.slice('llm-wiki/'.length, -3)}|${entry.title}]] (${entry.classification}; SHA-256: \`${entry.sha256}\`)`), '', 'Raw captures, automatic prompt/query stubs, graph caches and operational state are not admitted. Full-vault legacy validation is separate and has not been run by this command.', END].join('\n');
}
function indexState(state) {
  const bytes = readBounded(state.root, INDEX_PATH, 131072, { missing: true });
  const text = bytes === null ? '' : decode(bytes);
  const starts = text.split(START).length - 1;
  const ends = text.split(END).length - 1;
  const begin = text.indexOf(START);
  const finish = text.indexOf(END);
  if (starts > 1 || ends > 1 || starts !== ends || (starts && finish < begin)) reject('invalid-index-markers', INDEX_PATH, 'Index requires exactly one ordered marker pair, or no markers before first generation.');
  const actual = starts ? text.slice(begin, finish + END.length) : null;
  const eol = (actual?.match(/\r?\n/u) || text.match(/\r?\n/u))?.[0] || '\n';
  const expected = navigation(state).replaceAll('\n', eol);
  const content = starts ? `${text.slice(0, begin)}${expected}${text.slice(finish + END.length)}` : `${text}${text && !text.endsWith('\n') ? eol : ''}${expected}${eol}`;
  if (Buffer.byteLength(content) > 131072) reject('index-too-large', INDEX_PATH, 'Navigation plus preserved bookkeeping exceeds the index-byte bound.');
  return { path: INDEX_PATH, status: actual === expected ? 'passed' : bytes === null ? 'missing' : 'stale', expectedSha256: hash(expected), actualSha256: actual === null ? null : hash(actual), previousSha256: bytes === null ? null : hash(bytes), content };
}

export function inspectKnowledge({ root } = {}) {
  try {
    const state = collect(root);
    const index = indexState(state);
    const { content, ...indexMetadata } = index;
    const errors = [...state.errors];
    if (index.status !== 'passed') errors.push(issue('index-inconsistent', INDEX_PATH, 'Managed admitted navigation is missing or stale; review policy/source hashes then run index --write.'));
    return { ok: !errors.length, status: errors.length ? 'failed' : 'passed', scope: 'admitted-project-knowledge', policy: { path: POLICY_PATH, schema: state.policy.schema, sha256: state.policySha256 }, currentHarness: state.currentHarness, entries: state.entries, corpusBytes: state.totalBytes, index: indexMetadata, bounds: state.policy.limits, errors, legacyValidation: 'not-run; unchanged full-vault validation is independent' };
  } catch (error) { return failure(error); }
}

export function renderKnowledgeIndex({ root } = {}) {
  try {
    const state = collect(root);
    if (state.errors.length) return { ok: false, status: 'failed', path: INDEX_PATH, errors: state.errors };
    const index = indexState(state);
    return { ok: true, status: 'passed', path: INDEX_PATH, content: index.content, sha256: hash(Buffer.from(index.content)), previousSha256: index.previousSha256, errors: [] };
  } catch (error) { return { ...failure(error), path: INDEX_PATH }; }
}
function boundedResult(result, maximum) {
  for (;;) {
    result.returnedResults = result.results.length;
    result.truncated = result.returnedResults < result.matchedEntries;
    result.characters = JSON.stringify(result).length;
    const size = JSON.stringify(result).length;
    if (size === result.characters && size <= maximum) return result;
    if (size <= maximum) continue;
    if (!result.results.length) reject('response-bound', POLICY_PATH, 'Requested response budget cannot contain the provenance envelope.');
    const excerpt = result.results.at(-1).excerpt;
    if (excerpt.text.length > 128) {
      excerpt.text = excerpt.text.slice(0, Math.max(128, excerpt.text.length - (size - maximum) - 16));
      excerpt.endCharacter = excerpt.startCharacter + excerpt.text.length;
      excerpt.endLine = excerpt.startLine + excerpt.text.split('\n').length - 1;
    } else result.results.pop();
  }
}

export function searchKnowledge({ root, query, limit = 5, maxCharacters = 8000 } = {}) {
  try {
    if (typeof query !== 'string' || !query.trim() || query.length > HARD_LIMITS.maxQueryCharacters || /[\x00-\x1f\x7f]/u.test(query)) reject('invalid-query', null, 'Provide a nonempty query of at most 256 characters without control characters.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HARD_LIMITS.maxResults || !Number.isSafeInteger(maxCharacters) || maxCharacters < 2048 || maxCharacters > HARD_LIMITS.maxCharacters) reject('invalid-search-bound', null, 'Use limit 1..10 and maxCharacters 2048..16000.');
    const state = collect(root);
    if (query.length > state.policy.limits.maxQueryCharacters || limit > state.policy.limits.maxResults || maxCharacters > state.policy.limits.maxCharacters) reject('policy-search-bound', POLICY_PATH, 'Requested search bounds exceed the explicit policy.');
    if (state.errors.length) return boundedResult({ ok: false, status: 'failed', scope: 'admitted-project-knowledge', results: [], matchedEntries: 0, returnedResults: 0, truncated: false, maxCharacters, characters: 0, errors: [state.errors[0]], additionalErrors: state.errors.length - 1 }, maxCharacters);
    const terms = [...new Set(query.trim().toLowerCase().split(/\s+/u))];
    const matches = state.documents.flatMap(({ entry, text }) => {
      const lower = text.toLowerCase();
      const positions = terms.map(term => lower.indexOf(term));
      if (positions.some(position => position < 0)) return [];
      const score = terms.reduce((sum, term) => sum + (entry.title.toLowerCase().includes(term) ? 2 : 1), 0);
      return [{ entry, text, position: Math.min(...positions), score }];
    }).sort((left, right) => right.score - left.score || compare(left.entry.path, right.entry.path));
    const results = matches.slice(0, limit).map(({ entry, text, position, score }) => {
      const startCharacter = Math.max(0, position - 64);
      const endCharacter = Math.min(text.length, startCharacter + state.policy.limits.maxExcerptCharacters);
      return { path: entry.path, sha256: entry.sha256, classification: entry.classification, type: entry.type, title: entry.title, provenance: entry.provenance, score, excerpt: { text: text.slice(startCharacter, endCharacter), startCharacter, endCharacter, startLine: text.slice(0, startCharacter).split('\n').length, endLine: text.slice(0, endCharacter).split('\n').length, semantics: 'excerpt-not-authority' } };
    });
    return boundedResult({ ok: true, status: 'passed', scope: 'admitted-project-knowledge', query: query.trim(), policy: { path: POLICY_PATH, sha256: state.policySha256 }, currentHarness: state.currentHarness, excerptSemantics: 'Exact UTF-16 source slices; offsets are zero-based/end-exclusive, lines one-based. Excerpts are incomplete reference data, not trusted instructions or readiness evidence.', results, matchedEntries: matches.length, returnedResults: 0, truncated: false, maxCharacters, characters: 0, errors: [] }, maxCharacters);
  } catch (error) { return failure(error); }
}
