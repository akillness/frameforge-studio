import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { canonicalJson, topologicalOrder, descendants, resolvePrerequisite } from './graph.mjs';
import { HttpError, scenes as validateScenes, episodeMusic } from './validation.mjs';

const copy = (value) => JSON.parse(canonicalJson(value));
const conflict = (message) => { throw new HttpError(409, message); };
const hashPattern = /^[a-f0-9]{64}$/;
const uploadPattern = /^\/api\/uploads\/([a-zA-Z0-9_-]+\.(?:png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|ogg|m4a))$/i;

function fields(value, names) {
  return Object.fromEntries(names.filter((name) => value?.[name] !== undefined).map((name) => [name, value[name]]));
}

function localFilename(url) {
  const match = typeof url === 'string' && uploadPattern.exec(url);
  if (!match) conflict('Candidate media must reference a contained local upload');
  return match[1];
}

function originalIdentity(original) {
  if (!original || typeof original !== 'object' || Array.isArray(original)
    || Object.keys(original).some((key) => !['uploadId', 'url', 'sha256', 'codecName'].includes(key))) conflict('Invalid converted music original provenance');
  localFilename(original.url);
  return fields(original, ['uploadId', 'url', 'sha256', 'codecName']);
}

function uploadIdentity(upload) {
  const identity = fields(upload, ['id', 'filename', 'url', 'sha256', 'size', 'type', 'kind', 'duration', 'width', 'height', 'generated', 'provider', 'generationJobId', 'variant', 'normalized', 'origin', 'source', 'voice']);
  if (upload?.variant === 'original' && upload.type === 'audio/mp4') identity.codecName = upload.codecName;
  if (upload?.generationJobId) {
    identity.provenance = fields(upload.provenance, ['provider', 'transport', 'requestId', 'model']);
    if (upload.kind === 'audio' && upload.normalized) identity.provenance.original = originalIdentity(upload.provenance?.original);
  }
  return identity;
}

function rightsIdentity(rights) {
  return fields(rights, ['id', 'uploadId', 'sha256', 'origin', 'sourceUrl', 'licenseId', 'attribution', 'retrievedAt', 'acknowledgedAt', 'generationJobId']);
}

function generationIdentity(job) {
  // Provider download URLs (including signed URLs) are deliberately not copied into a manifest.
  return {
    ...fields(job, ['id', 'episodeId', 'episodeVersion', 'sceneId', 'slotId', 'target', 'model', 'prompt', 'params', 'transport', 'mediaKind', 'status', 'providerRequestId']),
    outputs: (job.outputs || []).map((output) => ({
      ...fields(output, ['uploadId', 'sha256', 'kind', 'variant', ...(job.target === 'music' && output.normalized ? ['type', 'size', 'normalized'] : [])]),
      ...(job.target === 'music' && output.normalized ? { original: originalIdentity(output.original) } : {}),
      ...(typeof output.url === 'string' && uploadPattern.test(output.url) ? { url: output.url } : {}),
    })),
  };
}

function narrationIdentity(job) {
  return fields(job, ['id', 'episodeId', 'episodeVersion', 'resultVersion', 'sceneIds', 'status', 'provider', 'voice', 'rate', 'audioUrls']);
}

function containedSync(store, filename) {
  const declared = path.resolve(store.dataDir, 'uploads');
  const root = realpathSync(declared);
  if (root !== declared || lstatSync(declared).isSymbolicLink()) conflict('Candidate upload directory must not be redirected');
  const file = path.join(root, filename), info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(file) !== file) conflict('Candidate media must be a regular contained file');
  return file;
}

function hashSync(file) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024), fd = openSync(file, 'r');
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

function assetSnapshot(store, uploads, rights, reference, episodeId) {
  const filename = localFilename(reference.assetUrl);
  const matches = uploads.filter((upload) => upload.url === reference.assetUrl);
  if (matches.length !== 1 || matches[0].filename !== filename) conflict('Candidate media has no unique registered upload');
  const upload = matches[0];
  const source = reference.source ?? null;
  const job = upload.generationJobId ? store.get('generationJobs', upload.generationJobId) : null;
  const narration = reference.use === 'audio' && upload.generated && !job
    ? store.list('narrationJobs').filter((item) => item.episodeId === episodeId && item.status === 'completed' && item.audioUrls?.includes(upload.url))
    : [];
  if (narration.length > 1) conflict('Candidate audio has ambiguous narration provenance');
  // Older local narration uploads have no registry hash. Bind their real bytes now, then rehash
  // at verification; do not invent or persist an upload hash on this read-only path.
  const sha256 = upload.sha256 || hashSync(containedSync(store, filename));
  let originalUpload = null;
  if (reference.use === 'music' && upload.normalized) {
    const original = upload.provenance?.original;
    const matches = uploads.filter((item) => item.id === original?.uploadId);
    if (matches.length !== 1) conflict('Converted music original is not registered');
    originalUpload = uploadIdentity(matches[0]);
  }
  return {
    ...reference,
    source,
    uploadId: upload.id,
    sha256,
    upload: uploadIdentity(upload),
    ...(originalUpload ? { originalUpload } : {}),
    rights: rights.filter((item) => item.uploadId === upload.id).map(rightsIdentity).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    generation: job ? generationIdentity(job) : null,
    narration: narration[0] ? narrationIdentity(narration[0]) : null,
  };
}

function normalizedScene(scene) {
  const normalized = validateScenes([scene])[0];
  return {
    ...scene,
    ...normalized,
    sceneId: scene.id,
    assetUrl: scene.assetUrl || '',
    audioUrl: scene.audioUrl || '',
    source: scene.source ?? null,
    trimStart: scene.trimStart ?? 0,
    trimEnd: scene.trimEnd ?? null,
    slots: (normalized.slots || []).map((slot) => ({ ...slot, slotId: slot.id, assetUrl: slot.assetUrl || '', source: slot.source ?? null, trimStart: slot.trimStart ?? 0, trimEnd: slot.trimEnd ?? null })),
  };
}

/** Read-only exact-input snapshot. Fingerprint this object with graph.candidateFingerprint. */
export function candidateManifest(store, episode, workflow, options = {}) {
  if (!episode?.id || !workflow?.id || !Array.isArray(episode.scenes)) throw new HttpError(400, 'Candidate requires an episode and workflow');
  if ((workflow.episodeId && workflow.episodeId !== episode.id) || (workflow.channelId && workflow.channelId !== episode.channelId)) conflict('Workflow belongs to a different production');
  if (options.expectedWorkflowVersion !== undefined && options.expectedWorkflowVersion !== workflow.version) conflict('Workflow version changed');
  if (options.expectedEpisodeVersion !== undefined && options.expectedEpisodeVersion !== episode.version) conflict('Episode version changed');
  const order = topologicalOrder(workflow.nodes, workflow.edges);
  const selected = options.selectedStages ?? order;
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some((id) => !order.includes(id))) throw new HttpError(400, 'Candidate stages must be unique exact node IDs');
  if (options.startStage !== undefined && !order.includes(options.startStage)) throw new HttpError(400, 'Candidate start stage must be an exact node ID');
  const reachable = options.startStage === undefined ? null : descendants(workflow.edges, options.startStage).add(options.startStage);
  const selectedStages = order.filter((id) => selected.includes(id) && (!reachable || reachable.has(id)));
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const sceneIds = new Set();
  for (const scene of episode.scenes) {
    if (!scene.id || sceneIds.has(scene.id)) conflict('Candidate scenes require unique stable IDs');
    sceneIds.add(scene.id);
    const slots = (scene.slots || []).map((slot) => slot.id);
    if (slots.some((id) => !id) || new Set(slots).size !== slots.length) conflict('Candidate slots require unique stable IDs');
  }
  const nodes = selectedStages.map((id) => byId.get(id)).filter((node) => node.type === 'generate').map((node) => {
    const config = node.config || {};
    if (config.sceneId === undefined && (!Number.isInteger(config.sceneIndex ?? 0) || (config.sceneIndex ?? 0) < 0)) throw new HttpError(400, 'Generation requires a stable scene ID or valid legacy scene index');
    const scene = config.sceneId !== undefined
      ? episode.scenes.find((item) => item.id === config.sceneId)
      : episode.scenes[config.sceneIndex ?? 0];
    if (!scene) throw new HttpError(400, `Generation target scene does not exist for ${node.id}`);
    const slot = config.slotId ? scene.slots?.find((item) => item.id === config.slotId) : null;
    if (config.slotId && !slot) throw new HttpError(400, `Generation target slot does not exist for ${node.id}`);
    if (config.targetMode === 'slot' && !slot) throw new HttpError(400, 'Slot generation requires an explicit slot ID');
    const storyboard = resolvePrerequisite(workflow.nodes, workflow.edges, node.id, 'storyboard');
    return {
      nodeId: node.id, type: 'generate', sceneId: scene.id,
      ...(slot ? { slotId: slot.id } : {}),
      storyboardNodeId: storyboard.id,
      model: config.model,
      prompt: config.prompt || slot?.prompt || scene.text || episode.topic || '',
      params: config.params || {},
      targetMode: slot ? 'slot' : 'scene',
      source: (slot || scene).source ?? null,
    };
  });
  const allScenes = episode.scenes.map(normalizedScene);
  const targetIds = new Set(nodes.map((node) => node.sceneId));
  const uploads = store.list('uploads'), rights = store.list('mediaRights');
  const assets = [];
  const add = (reference) => { if (reference.assetUrl) assets.push(assetSnapshot(store, uploads, rights, reference, episode.id)); };
  for (const scene of allScenes) {
    add({ sceneId: scene.sceneId, use: 'asset', assetUrl: scene.assetUrl, source: scene.source });
    add({ sceneId: scene.sceneId, use: 'audio', assetUrl: scene.audioUrl, source: scene.audioSource ?? null });
    for (const slot of scene.slots) add({ sceneId: scene.sceneId, slotId: slot.slotId, use: 'asset', assetUrl: slot.assetUrl, source: slot.source });
  }
  if (episode.music) {
    const music = episodeMusic(episode.music);
    add({ use: 'music', assetUrl: music.assetUrl, source: music.source });
  }
  return copy({
    schema: 'frameforge-candidate/v1',
    workflowId: workflow.id, workflowVersion: workflow.version,
    episodeId: episode.id, episodeVersion: episode.version, channelId: episode.channelId,
    selectedStages, startStage: options.startStage ?? null, resumeRunId: options.resumeRunId ?? null,
    disclosure: options.disclosure ?? null,
    nodes,
    scenes: nodes.length ? allScenes.filter((scene) => targetIds.has(scene.sceneId)) : allScenes,
    // Keep the full production, including untargeted scenes, in the consent fingerprint.
    episode: { ...episode, scenes: allScenes },
    workflow: { ...workflow, nodes: order.map((id) => byId.get(id)), edges: [...workflow.edges].sort((a, b) => String(a.id).localeCompare(String(b.id))) },
    publication: options.publication ?? null,
    assets,
  });
}

function checkRights(asset, rights, upload, manifest, store) {
  const source = asset.source;
  if (source?.sha256 && source.sha256 !== asset.sha256) conflict('Candidate source hash no longer matches the upload');
  if (upload.generationJobId || source?.origin === 'generated') {
    if (!upload.generationJobId || (source?.generationJobId && source.generationJobId !== upload.generationJobId) || (source && source.origin !== 'generated')) conflict('Candidate generated source does not match upload provenance');
    if (source?.useAs === 'evidence') conflict('Generated imagery cannot serve as footage of the reported event');
    const job = store.get('generationJobs', upload.generationJobId);
    if (asset.use === 'music' && (job.target !== 'music' || job.mediaKind !== 'audio' || upload.kind !== 'audio')) conflict('Generated music requires audio generation provenance');
    if (asset.use === 'music') {
      const output = job.outputs?.find((item) => item.uploadId === upload.id);
      if (upload.normalized || upload.provenance?.original || output?.normalized || output?.original || upload.variant === 'converted') {
        const original = upload.provenance?.original, registered = asset.originalUpload;
        if (upload.normalized !== true || upload.variant !== 'converted' || upload.type !== 'audio/wav' || output?.normalized !== true || output.variant !== 'converted' || output.kind !== upload.kind || output.type !== upload.type || output.size !== upload.size
          || !original || canonicalJson(original) !== canonicalJson(output.original) || !registered
          || registered.id !== original.uploadId || registered.url !== original.url || registered.sha256 !== original.sha256
          || registered.variant !== 'original' || registered.type !== 'audio/mp4' || registered.kind !== 'audio'
          || registered.generationJobId !== job.id || !registered.generated || !hashPattern.test(original.sha256 || '')
          || !Number.isSafeInteger(registered.size) || registered.size < 1 || registered.size > 100 * 1024 * 1024
          || !original.codecName || registered.codecName !== original.codecName
          || canonicalJson(registered.provenance) !== canonicalJson(fields(upload.provenance, ['provider', 'transport', 'requestId', 'model']))) conflict('Converted music original provenance does not match');
      }
    }
    if (canonicalJson(generationIdentity(job)) !== canonicalJson(asset.generation) || job.status !== 'completed' || job.episodeId !== manifest.episodeId || job.sceneId !== asset.sceneId || (job.slotId || null) !== (asset.slotId || null)
      || !upload.generated || !job.providerRequestId || upload.provenance?.requestId !== job.providerRequestId
      || upload.provenance?.model !== job.model || upload.provenance?.transport !== job.transport || upload.provenance?.provider !== upload.provider
      || !job.outputs?.some((output) => output.uploadId === upload.id && output.url === upload.url && output.sha256 === asset.sha256)) conflict('Candidate media has no matching completed generation output');
    return;
  }
  if (asset.use === 'audio' && asset.narration) {
    const job = store.get('narrationJobs', asset.narration.id);
    if (!upload.generated || job.episodeId !== manifest.episodeId || job.status !== 'completed' || !job.sceneIds?.includes(asset.sceneId) || !job.audioUrls?.includes(upload.url) || job.provider !== upload.provider || job.voice !== upload.voice || canonicalJson(narrationIdentity(job)) !== canonicalJson(asset.narration)) conflict('Candidate narration provenance changed');
    if (!source) return;
  }
  if (upload.generated && !asset.narration) conflict('Generated upload requires completed job provenance');
  if (source?.origin === 'own') {
    if (asset.use === 'audio' && !rights.some((item) => item.uploadId === upload.id && item.sha256 === asset.sha256 && item.origin === 'own'
      && Number.isFinite(Date.parse(item.acknowledgedAt || '')) && Date.parse(item.acknowledgedAt) <= Date.now()
      && ['sourceUrl', 'licenseId', 'attribution', 'retrievedAt'].every((key) => source[key] === undefined || source[key] === item[key]))) conflict('Scene audio requires matching human rights clearance');
    return;
  }
  if (source?.origin !== 'third-party') conflict('Candidate media origin requires a human decision');
  if (!source.sourceUrl || !source.licenseId || !source.attribution) conflict('Third-party media requires source, license and attribution');
  const matching = rights.filter((item) => item.uploadId === upload.id && item.sha256 === asset.sha256 && item.origin === 'third-party'
    && Number.isFinite(Date.parse(item.acknowledgedAt || '')) && Date.parse(item.acknowledgedAt) <= Date.now()
    && ['sourceUrl', 'licenseId', 'attribution'].every((key) => item[key] === source[key])
    && (!source.retrievedAt || item.retrievedAt === source.retrievedAt));
  if (!matching.length) conflict('Candidate third-party media has no matching human rights clearance');
}

function sameFile(left, right) {
  return left.ino === right.ino && left.dev === right.dev && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function verifyFile(root, filename, asset, upload) {
  const file = path.join(root, filename);
  let handle;
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || await realpath(file) !== file) conflict('Candidate media must be a regular contained file');
    handle = await open(file, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) conflict('Candidate media changed while opening');
    const hash = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    const after = await lstat(file), final = await handle.stat();
    if (!after.isFile() || after.isSymbolicLink() || !sameFile(before, after) || !sameFile(opened, final)
      || await realpath(file) !== file || (upload.size !== undefined && after.size !== upload.size)
      || hash.digest('hex') !== asset.sha256) conflict('Candidate media bytes changed');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    conflict('Candidate media is missing or unreadable');
  } finally { await handle?.close(); }
}

/** Verify actual bytes, containment and current registry/rights/provenance. No provider traffic. */
export async function verifyCandidateAssets(store, manifest) {
  if (!manifest || manifest.schema !== 'frameforge-candidate/v1' || !Array.isArray(manifest.assets) || !manifest.episode?.scenes) throw new HttpError(400, 'Invalid candidate manifest');
  // Rebuild the reference set so callers cannot bypass verification by omitting an asset entry.
  const expected = [];
  for (const scene of manifest.episode.scenes) {
    if (scene.assetUrl) expected.push({ sceneId: scene.sceneId, use: 'asset', assetUrl: scene.assetUrl, source: scene.source ?? null });
    if (scene.audioUrl) expected.push({ sceneId: scene.sceneId, use: 'audio', assetUrl: scene.audioUrl, source: scene.audioSource ?? null });
    for (const slot of scene.slots || []) if (slot.assetUrl) expected.push({ sceneId: scene.sceneId, slotId: slot.slotId, use: 'asset', assetUrl: slot.assetUrl, source: slot.source ?? null });
  }
  if (manifest.episode.music) {
    const music = episodeMusic(manifest.episode.music);
    expected.push({ use: 'music', assetUrl: music.assetUrl, source: music.source });
  }
  const references = manifest.assets.map((asset) => fields(asset, ['sceneId', 'slotId', 'use', 'assetUrl', 'source']));
  if (canonicalJson(expected) !== canonicalJson(references)) conflict('Candidate asset references do not cover the production');
  let root;
  if (manifest.assets.length) {
    const declared = path.resolve(store.dataDir, 'uploads');
    root = await realpath(declared);
    if (root !== declared || (await lstat(declared)).isSymbolicLink()) conflict('Candidate upload directory must not be redirected');
  }
  for (const asset of manifest.assets) {
    const filename = localFilename(asset.assetUrl);
    const matches = store.list('uploads').filter((upload) => upload.url === asset.assetUrl);
    const upload = matches[0];
    if (asset.use === 'music' && !upload?.type?.startsWith('audio/')) conflict('Candidate music must be an audio upload');
    if (matches.length !== 1 || upload.id !== asset.uploadId || upload.filename !== filename || canonicalJson(uploadIdentity(upload)) !== canonicalJson(asset.upload)) conflict('Candidate upload registry changed');
    if (!hashPattern.test(asset.sha256) || (upload.sha256 && upload.sha256 !== asset.sha256)) conflict('Candidate upload hash does not match its registry');
    await verifyFile(root, filename, asset, upload);
    if (asset.originalUpload) {
      const original = asset.originalUpload;
      const originals = store.list('uploads').filter((item) => item.url === original.url);
      if (originals.length !== 1 || canonicalJson(uploadIdentity(originals[0])) !== canonicalJson(original)
        || originals[0].filename !== localFilename(original.url) || !hashPattern.test(original.sha256 || '')) conflict('Converted music original registry changed');
      await verifyFile(root, originals[0].filename, original, originals[0]);
    }
  }
  // Registry/rights can change while filesystem I/O yields. Recheck all of them together after
  // the final await, so a clearance revoked during hashing cannot be accepted from an old list.
  const uploads = store.list('uploads'), rights = store.list('mediaRights');
  for (const asset of manifest.assets) {
    const matches = uploads.filter((upload) => upload.url === asset.assetUrl), upload = matches[0];
    if (matches.length !== 1 || canonicalJson(uploadIdentity(upload)) !== canonicalJson(asset.upload)) conflict('Candidate upload registry changed during verification');
    if (asset.originalUpload) {
      const originals = uploads.filter((item) => item.url === asset.originalUpload.url);
      if (originals.length !== 1 || canonicalJson(uploadIdentity(originals[0])) !== canonicalJson(asset.originalUpload)) conflict('Converted music original registry changed during verification');
    }
    const currentRights = rights.filter((item) => item.uploadId === upload.id).map(rightsIdentity).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (canonicalJson(currentRights) !== canonicalJson(asset.rights)) conflict('Candidate media rights changed');
    checkRights(asset, rights, upload, manifest, store);
  }
  return manifest;
}

/** Bind every rendered scene input to the registered bytes, without trusting omitted receipts. */
export function verifySceneReceipts(job, output, manifest) {
  if (!Array.isArray(job?.sceneIntegrity) || !Array.isArray(job?.verifiedSceneAssets) || !Array.isArray(output?.verifiedSceneAssets)
    || canonicalJson(job.verifiedSceneAssets) !== canonicalJson(output.verifiedSceneAssets)) conflict('Scene render byte receipts are missing or mismatched');
  const assets = manifest.assets.filter((asset) => asset.use !== 'music');
  const expected = assets.map((asset) => {
    if (!hashPattern.test(asset.upload?.sha256 || '') || asset.sha256 !== asset.upload.sha256
      || !Number.isSafeInteger(asset.upload.size) || asset.upload.size < 1 || asset.upload.size > 100 * 1024 * 1024) conflict('Scene media requires registered hash and size');
    return { ...fields(asset, ['sceneId', 'slotId', 'use', 'assetUrl']), sha256: asset.sha256, size: asset.upload.size };
  });
  const ordered = (values) => values.map((value) => canonicalJson(value)).sort();
  if (canonicalJson(ordered(expected)) !== canonicalJson(ordered(job.verifiedSceneAssets)) || canonicalJson(ordered(expected)) !== canonicalJson(ordered(job.sceneIntegrity))) conflict('Scene render bytes differ from registered media');
}
