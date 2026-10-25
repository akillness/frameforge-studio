// Pure, store-free workflow DAG helpers shared by server/workflows.mjs, server/candidates.mjs
// and server/store.mjs. See artifacts/production-workspace-implementation/plan.json "graph"
// section (frozen) and .mex/context/decisions.md "Repeated-node implementation contract".
//
// Every function here operates only on plain {id,type,...} nodes and {id,source,target} edges
// passed in by the caller; nothing is read from or written to persistent storage.
import { createHash } from 'node:crypto';
import { HttpError } from './validation.mjs';

/**
 * Deterministic execution order derived strictly from edges via Kahn's algorithm: whenever more
 * than one node is simultaneously ready (in-degree zero), the lexically smallest node ID is
 * chosen next. Never consults node array position or any role-type ordering. Throws HttpError(400)
 * when the edge set does not admit a complete order (a real cycle, including a self-edge).
 */
export function topologicalOrder(nodes, edges) {
  const ids = nodes.map((node) => node.id);
  const known = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) throw new HttpError(400, 'Edge refers to an unknown node');
    outgoing.get(edge.source).push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target) + 1);
  }
  const order = [];
  const ready = ids.filter((id) => indegree.get(id) === 0);
  while (ready.length) {
    ready.sort();
    const id = ready.shift();
    order.push(id);
    for (const target of outgoing.get(id)) {
      const next = indegree.get(target) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (order.length !== ids.length) throw new HttpError(400, 'Workflow graph contains a cycle');
  return order;
}

/** All node IDs that can reach nodeId via one or more edges (nodeId itself is never included). */
export function ancestors(edges, nodeId) {
  const seen = new Set();
  const stack = [nodeId];
  while (stack.length) {
    const current = stack.pop();
    for (const edge of edges) if (edge.target === current && !seen.has(edge.source)) {
      seen.add(edge.source);
      stack.push(edge.source);
    }
  }
  return seen;
}

/** All node IDs reachable from nodeId via one or more edges (nodeId itself is never included). */
export function descendants(edges, nodeId) {
  const seen = new Set();
  const stack = [nodeId];
  while (stack.length) {
    const current = stack.pop();
    for (const edge of edges) if (edge.source === current && !seen.has(edge.target)) {
      seen.add(edge.target);
      stack.push(edge.target);
    }
  }
  return seen;
}

/**
 * Walks every incoming path upstream from nodeId and, on each path, keeps only the FIRST
 * (nearest) node of the given type, then stops advancing that path past it — a same-type node
 * further upstream on the same path is never counted. This is what makes a serial chain like
 * render-1 -> review-1 -> render-2 -> review-2 bind review-2 to render-2 ONLY: render-1 sits
 * beyond render-2 on review-2's single incoming path and is pruned, not treated as a second,
 * ambiguous candidate. Distinct branches that each independently reach their OWN nearest match
 * still produce multiple candidates, which is genuine ambiguity, not a false positive.
 */
function nearestUpstreamOfType(nodes, edges, nodeId, type) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const found = new Set();
  const visited = new Set([nodeId]);
  const stack = [nodeId];
  while (stack.length) {
    const current = stack.pop();
    for (const edge of edges) {
      if (edge.target !== current || visited.has(edge.source)) continue;
      visited.add(edge.source);
      if (byId.get(edge.source)?.type === type) found.add(edge.source);
      else stack.push(edge.source);
    }
  }
  return [...found].map((id) => byId.get(id));
}

/**
 * The exactly-one nearest transitive upstream node of the given type on nodeId's incoming paths
 * (not merely a direct parent, and never "the first node of that type" in the whole workflow).
 * Zero candidates or more than one candidate is a required-prerequisite conflict: HttpError(409).
 */
export function resolvePrerequisite(nodes, edges, nodeId, type) {
  const candidates = nearestUpstreamOfType(nodes, edges, nodeId, type);
  if (candidates.length === 0) throw new HttpError(409, `${nodeId} has no connected ${type} prerequisite`);
  if (candidates.length > 1) throw new HttpError(409, `${nodeId} has ambiguous ${type} prerequisites: ${candidates.map((c) => c.id).join(', ')}`);
  return candidates[0];
}

/**
 * Same nearest-upstream search as resolvePrerequisite, but absence is not an error: zero
 * candidates returns null (e.g. a news/trend node is genuinely optional context), one candidate
 * returns that node, and more than one candidate is still an explicit ambiguity: HttpError(409).
 */
export function resolveOptional(nodes, edges, nodeId, type) {
  const candidates = nearestUpstreamOfType(nodes, edges, nodeId, type);
  if (candidates.length > 1) throw new HttpError(409, `${nodeId} has ambiguous optional ${type} candidates: ${candidates.map((c) => c.id).join(', ')}`);
  return candidates[0] || null;
}

/**
 * Deterministic JSON serialization: object keys are sorted lexically at every depth, array order
 * is preserved, and `undefined`/function values are dropped exactly like JSON.stringify. Used so
 * two structurally identical candidate manifests always hash to the same fingerprint regardless
 * of property insertion order.
 */
export function canonicalJson(value) {
  const active = new Set();
  const stringify = (input) => {
    if (input === undefined || typeof input === 'function' || typeof input === 'symbol') return undefined;
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (typeof input.toJSON === 'function') return stringify(input.toJSON());
    if (active.has(input)) throw new TypeError('canonicalJson does not support circular references');
    active.add(input);
    try {
      if (Array.isArray(input)) return `[${input.map((item) => stringify(item) ?? 'null').join(',')}]`;
      const parts = [];
      for (const key of Object.keys(input).sort()) {
        const encoded = stringify(input[key]);
        if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${parts.join(',')}}`;
    } finally { active.delete(input); }
  };
  return stringify(value) ?? 'null';
}

/** Stable sha256 fingerprint of a candidate manifest's canonical JSON form. */
export function candidateFingerprint(manifest) {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}
