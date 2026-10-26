import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVerifiedHarnessFile, verifyCurrent } from '../scripts/version-harness.mjs';

export const MAX_BRIDGE_CONTRACT_BYTES = 4096;
export { MAX_HARNESS_FILE_BYTES, MAX_HARNESS_TOTAL_BYTES } from '../scripts/version-harness.mjs';
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const heading = '## Bridge Runtime Contract';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function failure(code, source) {
  const detail = code === 'HARNESS_CONTEXT_TOO_LARGE'
    ? 'Selected bridge runtime contract or harness inputs exceed the byte limit'
    : code === 'BRIDGE_CONTRACT_MISSING'
      ? 'Selected immutable harness has no unique Bridge Runtime Contract; promote a compatible bundle'
      : 'Selected immutable harness is missing, unsafe or fails integrity verification';
  return Object.assign(new Error(detail), { code, statusCode: 503, ...(source ? { source } : {}) });
}



export function loadBridgeRuntimeContract({ root = repositoryRoot } = {}) {
  let source;
  try {
    root = path.resolve(root);
    const verified = verifyCurrent(root);
    const version = verified.pointer.currentVersion;
    const relative = `harness/${verified.pointer.bundlePath}/docs/harness.md`;
    const documentBytes = readVerifiedHarnessFile(verified, 'docs/harness.md');
    const record = verified.bundle.files.find(file => file.path === 'docs/harness.md');
    source = { version, path: relative, sha256: record.sha256, bundleSha256: verified.sha256 };
    const document = new TextDecoder('utf-8', { fatal: true }).decode(documentBytes);
    const sections = [...document.matchAll(/^## Bridge Runtime Contract\r?$/gm)];
    if (sections.length !== 1) throw failure('BRIDGE_CONTRACT_MISSING', source);
    const start = sections[0].index;
    const remainder = document.slice(start + sections[0][0].length);
    const boundary = /^#{1,2} /m.exec(remainder);
    const text = document.slice(start, boundary ? start + sections[0][0].length + boundary.index : undefined).trimEnd();
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_BRIDGE_CONTRACT_BYTES) throw failure('HARNESS_CONTEXT_TOO_LARGE', source);
    if (!text.slice(heading.length).trim()) throw failure('BRIDGE_CONTRACT_MISSING', source);
    return { text, source: { ...source, contractSha256: sha256(text), bytes } };
  } catch (error) {
    if (['HARNESS_CONTEXT_UNAVAILABLE', 'HARNESS_CONTEXT_TOO_LARGE', 'BRIDGE_CONTRACT_MISSING'].includes(error.code)) throw error;
    if (error.code === 'HARNESS_INPUT_TOO_LARGE') throw failure('HARNESS_CONTEXT_TOO_LARGE', source);
    throw failure('HARNESS_CONTEXT_UNAVAILABLE', source);
  }
}

export function inspectHarnessContext(options = {}) {
  try {
    const { source } = loadBridgeRuntimeContract(options);
    return { available: true, status: 'verified', source };
  } catch (error) {
    return { available: false, status: 'unavailable', code: error.code, detail: error.message, ...(error.source ? { source: error.source } : {}) };
  }
}
