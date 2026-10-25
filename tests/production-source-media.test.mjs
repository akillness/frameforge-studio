// RED-first contract tests for the PW-03 source-media seam
// (.mex/context/decisions.md "Production-workspace interview", plan.media in
// artifacts/production-workspace-implementation/plan.json, VerifiedCommonsProtocol in
// artifacts/production-workspace-implementation/protocols.json).
//
// Exercises the not-yet-implemented SourceMediaService({store,fetchImpl,userAgent,probe}) from
// server/media-sources.mjs against a real Store (temp SQLite dir) and a fully synthetic, injected
// fetchImpl — zero real network traffic, zero Wikimedia access. Also exercises the EXISTING
// server/validation.mjs `scenes` export and server/render.mjs `renderEpisode` to prove
// SourceMediaService's registered uploads are actually compatible with those already-shipped
// contracts ("candidateAsset verification"). The final ffmpeg-gated test mirrors the skip-if-
// unavailable pattern from tests/render-security.test.mjs.
//
// Field/shape choices here (pageId/kind/useAs/rightsAcknowledged on importMedia; flat
// provenance{pageId,sourceUrl,retrievedAt,sha1,extmetadata}; mediaRights keyed to uploadId+sha256;
// scene.source={origin,sourceUrl,licenseId,attribution,retrievedAt,sha256,useAs,generationJobId?})
// were agreed with MediaImplementation over IRC before this file was written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { HttpError, scenes as validateScenes } from '../server/validation.mjs';
import { renderEpisode } from '../server/render.mjs';
import { probeGenerationAsset } from '../server/generations.mjs';
import { execute } from '../server/process.mjs';
import { SourceMediaService } from '../server/media-sources.mjs';

const UA = 'FrameForge-Test/1.0 (+https://frameforge.test/contact; ops@frameforge.test)';
// A real, minimal 1x1 transparent PNG (verified PNG signature + IHDR chunk before use here).
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const WEBM_BYTES = Buffer.from('fixture webm payload, not a decodable video: probe is injected in every test but the final ffmpeg-gated one');

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'frameforge-media-'));
  const store = new Store(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  return store;
}

function episodeFixture(store, scenes) {
  const channel = store.list('channels')[0];
  return store.create('episodes', { channelId: channel.id, title: 'Media contract fixture', topic: 'Synthetic source media coverage', status: 'draft', version: 1, format: '9:16', scenes });
}

/** Registers an upload entity directly in the store (no network, no SourceMediaService) for tests
 * that exercise local-only methods (clearRights/attach/card/validateAssets) in isolation. */
function seedUpload(store, bytes = PNG_BYTES, type = 'image/png') {
  const id = randomUUID();
  const filename = `${id}.png`;
  return store.save('uploads', { id, filename, url: `/api/uploads/${filename}`, type, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: 2000, height: 2000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

function baseScene(overrides = {}) {
  return { id: 'scene-1', title: 'Scene', text: '', duration: 5, background: '#101010', kind: 'title', layout: 'center', narration: '', trimStart: 0, audioVolume: 1, ...overrides };
}

/** Records every fetchImpl invocation and plays back queued responses/functions in order. */
function fetchQueue(...responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (i >= responses.length) throw new Error(`Unexpected extra fetch call: ${url}`);
    const next = responses[i++];
    return typeof next === 'function' ? next(url, options) : next;
  };
  return { fetchImpl, calls };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function mediaResponse(bytes, { status = 200, type = 'image/jpeg', headers = {} } = {}) {
  return new Response(bytes, { status, headers: { 'content-type': type, ...headers } });
}

function commonsItem(overrides = {}) {
  return {
    pageid: 501, ns: 6, title: 'File:Fixture Kingfisher.jpg', index: 1, imagerepository: 'local',
    imageinfo: [{
      url: 'https://upload.wikimedia.org/wikipedia/commons/c/cc/Fixture_Kingfisher.jpg',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Fixture_Kingfisher.jpg',
      descriptionshorturl: 'https://commons.wikimedia.org/w/index.php?curid=501',
      size: 2897129, width: 2000, height: 2000, mime: 'image/jpeg', mediatype: 'BITMAP',
      sha1: 'b72cae08ddb2c4a4d06d91d052cf0b78ed1ab74c', timestamp: '2019-05-01T12:00:00Z',
      extmetadata: {
        LicenseShortName: { value: 'CC BY-SA 4.0', source: 'commons-desc-page' },
        LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0', source: 'commons-desc-page' },
        UsageTerms: { value: 'Creative Commons Attribution-ShareAlike 4.0', source: 'commons-desc-page' },
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Fixture">Fixture Photographer</a>', source: 'commons-desc-page' },
        Credit: { value: '<span class="int-own-work">Own work</span>', source: 'commons-desc-page' },
        AttributionRequired: { value: 'true', source: 'commons-desc-page' },
        Copyrighted: { value: 'True', source: 'commons-desc-page' },
        Restrictions: { value: '', source: 'commons-desc-page' },
      },
      ...overrides.imageinfo,
    }],
    ...overrides.page,
  };
}

function searchQueryResponse(pages) { return jsonResponse({ batchcomplete: true, query: { pages } }); }
function emptySearchResponse() { return jsonResponse({ batchcomplete: true }); }

const imageProbe = async () => ({ kind: 'image', width: 2000, height: 2000 });
const videoProbe = async () => ({ kind: 'video', width: 1920, height: 1080, duration: 4 });

// ---------------------------------------------------------------------------
// Commons search shapes
// ---------------------------------------------------------------------------

test('search maps a formatversion=2 Commons response to an explicit status and items, preserving raw booleanish extmetadata strings untouched', async (t) => {
  const store = await fixture(t);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const result = await media.search({ query: 'kingfisher', kind: 'image', limit: 5 });
  assert.equal(result.status, 'ok');
  assert.equal(result.items.length, 1);
  const [item] = result.items;
  assert.equal(item.pageId, 501);
  assert.equal(item.url, 'https://upload.wikimedia.org/wikipedia/commons/c/cc/Fixture_Kingfisher.jpg');
  assert.equal(item.mime, 'image/jpeg');
  assert.equal(item.mediaType, 'BITMAP');
  assert.equal(item.sha1, 'b72cae08ddb2c4a4d06d91d052cf0b78ed1ab74c');
  // AttributionRequired.value is the STRING "true"; Copyrighted.value is the STRING "True".
  // A truthiness bug (Boolean('false') === true) would corrupt these on passthrough.
  assert.equal(item.extmetadata.AttributionRequired.value, 'true');
  assert.equal(item.extmetadata.Copyrighted.value, 'True');
  assert.equal(typeof item.extmetadata.AttributionRequired.value, 'string');
});

test('search builds the documented Commons query per kind and bounds gsrlimit to the Commons public maximum without ever sending zero/negative', async (t) => {
  const store = await fixture(t);
  const probes = [
    { kind: 'image', limit: 5, expectFilter: 'filetype:bitmap' },
    { kind: 'video', limit: 5, expectFilter: 'filetype:video' },
    { kind: 'image', limit: 5000, expectFilter: 'filetype:bitmap' }, // over Commons public max (500)
    { kind: 'image', limit: -5, expectFilter: 'filetype:bitmap' },
  ];
  for (const { kind, limit, expectFilter } of probes) {
    const { fetchImpl, calls } = fetchQueue(emptySearchResponse());
    const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
    await media.search({ query: 'kingfisher', kind, limit });
    const params = new URL(calls[0].url).searchParams;
    assert.equal(params.get('action'), 'query');
    assert.equal(params.get('format'), 'json');
    assert.equal(params.get('formatversion'), '2');
    assert.equal(params.get('generator'), 'search');
    assert.equal(params.get('gsrnamespace'), '6');
    assert.equal(params.get('prop'), 'imageinfo');
    assert.ok(params.get('gsrsearch').includes(expectFilter), `${params.get('gsrsearch')} should include ${expectFilter}`);
    assert.ok(params.get('gsrsearch').includes('kingfisher'));
    assert.equal(params.get('iilimit'), '1');
    assert.equal(params.get('iiextmetadatalanguage'), 'en');
    for (const prop of ['url', 'mime', 'mediatype', 'size', 'sha1', 'timestamp', 'extmetadata']) assert.ok(params.get('iiprop').split('|').includes(prop), `iiprop missing ${prop}`);
    const gsrlimit = Number(params.get('gsrlimit'));
    assert.ok(Number.isInteger(gsrlimit) && gsrlimit >= 1 && gsrlimit <= 500, `gsrlimit ${gsrlimit} out of Commons-documented bounds for requested ${limit}`);
  }
});

test('search returns an explicit empty-but-ok result when Commons has zero matches, never conflated with a blocked/rate-limited provider failure', async (t) => {
  const store = await fixture(t);
  const { fetchImpl } = fetchQueue(emptySearchResponse());
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const result = await media.search({ query: 'no such kingfisher photo exists', kind: 'image', limit: 5 });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.items, []);
});

test('search distinguishes blocked (403) and rate-limited (429, with parsed Retry-After) from each other and from no-results', async (t) => {
  const store = await fixture(t);
  const blocked = new SourceMediaService({ store, fetchImpl: fetchQueue(new Response('Blocked', { status: 403 })).fetchImpl, userAgent: UA, probe: imageProbe });
  const blockedResult = await blocked.search({ query: 'kingfisher', kind: 'image', limit: 5 });
  assert.equal(blockedResult.status, 'provider_blocked');
  assert.notEqual(blockedResult.status, 'ok');
  assert.equal(blockedResult.items?.length ?? 0, 0);

  const limited = new SourceMediaService({ store, fetchImpl: fetchQueue(new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '30' } })).fetchImpl, userAgent: UA, probe: imageProbe });
  const limitedResult = await limited.search({ query: 'kingfisher', kind: 'image', limit: 5 });
  assert.equal(limitedResult.status, 'provider_rate_limited');
  assert.equal(limitedResult.retryAfter, 30);
  assert.notEqual(limitedResult.status, blockedResult.status);

  const limitedNoHeader = new SourceMediaService({ store, fetchImpl: fetchQueue(new Response('Too Many Requests', { status: 429 })).fetchImpl, userAgent: UA, probe: imageProbe });
  const limitedNoHeaderResult = await limitedNoHeader.search({ query: 'kingfisher', kind: 'image', limit: 5 });
  assert.equal(limitedNoHeaderResult.status, 'provider_rate_limited');
  assert.equal(limitedNoHeaderResult.retryAfter, undefined);
});

// ---------------------------------------------------------------------------
// Informative descriptive User-Agent on metadata AND download
// ---------------------------------------------------------------------------

test('search and importMedia both send the configured descriptive User-Agent on every outbound call, including the original-file download', async (t) => {
  const store = await fixture(t);
  const { fetchImpl, calls } = fetchQueue(searchQueryResponse([commonsItem()]), searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  await media.search({ query: 'kingfisher', kind: 'image', limit: 5 });
  await media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true });
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.options.headers['User-Agent'], UA, `missing/incorrect UA on ${call.url}`);
});

test('search and importMedia both reject with 503 before any fetch when the configured User-Agent is missing/blank, instead of silently sending a generic/spoofed header', async (t) => {
  const store = await fixture(t);
  for (const userAgent of [undefined, '', '   ']) {
    const { fetchImpl, calls } = fetchQueue();
    const media = new SourceMediaService({ store, fetchImpl, userAgent, probe: imageProbe });
    await assert.rejects(media.search({ query: 'kingfisher', kind: 'image', limit: 5 }), { status: 503 }, `search must reject for userAgent=${JSON.stringify(userAgent)}`);
    await assert.rejects(media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true }), { status: 503 });
    assert.equal(calls.length, 0, `userAgent=${JSON.stringify(userAgent)} must never reach the network`);
  }
});

test('an instance with no configured User-Agent still fully supports local-only clearRights/attach/card/validateAssets, and never lazy-skips the rights validator for a missing network config', async (t) => {
  const store = await fixture(t);
  const episode = episodeFixture(store, [baseScene()]);
  const upload = seedUpload(store);
  await writeFile(path.join(store.dataDir, 'uploads', upload.filename), PNG_BYTES);
  const media = new SourceMediaService({ store, fetchImpl: async () => { throw new Error('must not be called: this instance has no User-Agent and must never touch the network'); }, userAgent: '', probe: imageProbe });
  await media.clearRights(upload.id, { origin: 'third-party', licenseId: 'CC-BY-SA-4.0', attribution: 'Fixture Photographer', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Kingfisher.jpg' });
  const updated = await media.attach(episode.id, { sceneId: 'scene-1', uploadId: upload.id, expectedVersion: 1, useAs: 'illustration' });
  assert.equal(updated.scenes[0].source.licenseId, 'CC-BY-SA-4.0');
  const card = await media.card(episode.id, { sceneId: 'scene-1', expectedVersion: updated.version });
  assert.equal(card.scenes[0].kind, 'title');
  const clearedScene = [{ ...baseScene(), kind: 'image', assetUrl: upload.url, source: { origin: 'third-party', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Kingfisher.jpg', sha256: upload.sha256, useAs: 'evidence' } }];
  assert.doesNotThrow(() => media.validateAssets(clearedScene));
  const unclearedUpload = seedUpload(store, PNG_BYTES, 'image/png');
  await writeFile(path.join(store.dataDir, 'uploads', unclearedUpload.filename), PNG_BYTES);
  const unclearedScene = [{ ...baseScene(), kind: 'image', assetUrl: unclearedUpload.url, source: { origin: 'third-party', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Uncleared.jpg', sha256: unclearedUpload.sha256, useAs: 'evidence' } }];
  assert.throws(() => media.validateAssets(unclearedScene), 'validateAssets must still enforce the rights gate on an offline/unconfigured instance, never lazily skip it');
});

// ---------------------------------------------------------------------------
// importMedia: required human rights acknowledgement, structural URL safety
// ---------------------------------------------------------------------------

test('importMedia requires an actual boolean rightsAcknowledged:true before any network call; missing/false/truthy-string are all rejected', async (t) => {
  const store = await fixture(t);
  for (const rightsAcknowledged of [undefined, false, 'true']) {
    const { fetchImpl, calls } = fetchQueue();
    const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
    await assert.rejects(media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged }), { status: 400 });
    assert.equal(calls.length, 0, `rightsAcknowledged=${JSON.stringify(rightsAcknowledged)} must not reach the network`);
  }
});

test('importMedia requires a valid positive integer Commons pageId before any network call', async (t) => {
  const store = await fixture(t);
  for (const pageId of [undefined, -1, 1.5, '501', 0]) {
    const { fetchImpl, calls } = fetchQueue();
    const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
    await assert.rejects(media.importMedia({ pageId, kind: 'image', useAs: 'evidence', rightsAcknowledged: true }), { status: 400 });
    assert.equal(calls.length, 0);
  }
});

test('importMedia always re-fetches by pageId itself; a caller-supplied sourceUrl is never fetched, downloaded, or trusted', async (t) => {
  const store = await fixture(t);
  const { fetchImpl, calls } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  await media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true, sourceUrl: 'https://evil.invalid/payload.exe', url: 'https://evil.invalid/payload.exe' });
  assert.equal(calls.length, 2);
  for (const call of calls) assert.ok(!call.url.includes('evil.invalid'), `fetched the untrusted caller-supplied URL: ${call.url}`);
  assert.ok(calls[1].url.startsWith('https://upload.wikimedia.org/'));

  const { fetchImpl: noPageFetch, calls: noPageCalls } = fetchQueue();
  const noPageMedia = new SourceMediaService({ store, fetchImpl: noPageFetch, userAgent: UA, probe: imageProbe });
  await assert.rejects(noPageMedia.importMedia({ kind: 'image', useAs: 'evidence', rightsAcknowledged: true, sourceUrl: 'https://evil.invalid/payload.exe' }), { status: 400 });
  assert.equal(noPageCalls.length, 0, 'a bare sourceUrl with no pageId must never substitute for the verified Commons re-fetch');
});

// ---------------------------------------------------------------------------
// Bounded approved original host / redirect / media-type / probe / hash
// ---------------------------------------------------------------------------

test('importMedia rejects an imageinfo URL on an untrusted host or a thumb/preview path, without ever attempting the download', async (t) => {
  const store = await fixture(t);
  const untrustedHost = new SourceMediaService({ store, fetchImpl: fetchQueue(searchQueryResponse([commonsItem({ imageinfo: { url: 'https://evil-mirror.example/wikipedia/commons/x.jpg' } })])).fetchImpl, userAgent: UA, probe: imageProbe });
  await assert.rejects(untrustedHost.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true }), { status: 422 });

  const { fetchImpl: thumbFetch, calls: thumbCalls } = fetchQueue(searchQueryResponse([commonsItem({ imageinfo: { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/Fixture_Kingfisher.jpg/120px-Fixture_Kingfisher.jpg' } })]));
  const thumbHost = new SourceMediaService({ store, fetchImpl: thumbFetch, userAgent: UA, probe: imageProbe });
  await assert.rejects(thumbHost.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true }), { status: 422 });
  assert.equal(thumbCalls.length, 1, 'a thumbnail preview path must never be promoted to an original download');
  assert.equal(store.list('uploads').length, 0);
});

test('importMedia requests the download with redirects disabled and cleanly rejects a server-side redirect instead of silently following it', async (t) => {
  const store = await fixture(t);
  let downloadOptions;
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), (url, options) => { downloadOptions = options; throw new TypeError('fetch failed'); });
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  await assert.rejects(media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true }));
  assert.equal(downloadOptions.redirect, 'error');
  assert.equal(store.list('uploads').length, 0);
});

test('importMedia accepts only formats BOTH Commons-documented as originals AND locally decodable: webm passes; mp4 (locally decodable, Commons-original-support unverified) and ogv (Commons-documented, outside the local 11-format decoder set) and svg (vector, not raster) are each rejected for their own distinct reason', async (t) => {
  const store = await fixture(t);
  const rejected = [
    { url: '.../Fixture.mp4', mime: 'video/mp4', mediatype: 'VIDEO', kind: 'video' }, // render.mjs DOES map .mp4 and validation.mjs DOES allow mp4 scene assets — locally decodable; rejected because Commons' own MP4-original availability is documented as unverified (protocols.json), not because of a local codec gap
    { url: '.../Fixture.ogv', mime: 'video/ogg', mediatype: 'VIDEO', kind: 'video' }, // Commons-documented Ogg Theora original; render.mjs's MEDIA_FORMATS has no .ogv entry (only .ogg, audio) — genuinely outside the local 11-format decoder set
    { url: '.../Fixture.svg', mime: 'image/svg+xml', mediatype: 'DRAWING', kind: 'image' }, // vector, not raster — outside Commons' documented raster recommendation
  ];
  for (const { url, mime, mediatype, kind } of rejected) {
    const item = commonsItem({ imageinfo: { url: `https://upload.wikimedia.org/wikipedia/commons/c/cc/${url.split('/').pop()}`, mime, mediatype } });
    const { fetchImpl, calls } = fetchQueue(searchQueryResponse([item]));
    const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: kind === 'video' ? videoProbe : imageProbe });
    await assert.rejects(media.importMedia({ pageId: 501, kind, useAs: 'evidence', rightsAcknowledged: true }), { status: 422 }, `${mime} should be rejected`);
    assert.equal(calls.length, 1, `${mime} must not reach the download leg`);
  }

  const webmItem = commonsItem({ imageinfo: { url: 'https://upload.wikimedia.org/wikipedia/commons/c/cc/Fixture.webm', mime: 'video/webm', mediatype: 'VIDEO' } });
  const { fetchImpl: webmFetch } = fetchQueue(searchQueryResponse([webmItem]), mediaResponse(WEBM_BYTES, { type: 'video/webm' }));
  const webmMedia = new SourceMediaService({ store, fetchImpl: webmFetch, userAgent: UA, probe: videoProbe });
  const upload = await webmMedia.importMedia({ pageId: 501, kind: 'video', useAs: 'illustration', rightsAcknowledged: true });
  assert.match(upload.type, /^video\//);
  assert.equal(store.list('uploads').length, 1);

  // Declared kind mismatching Commons' own verified mediatype is also rejected, not silently coerced.
  const { fetchImpl: mismatchFetch, calls: mismatchCalls } = fetchQueue(searchQueryResponse([commonsItem()]));
  const mismatch = new SourceMediaService({ store, fetchImpl: mismatchFetch, userAgent: UA, probe: videoProbe });
  await assert.rejects(mismatch.importMedia({ pageId: 501, kind: 'video', useAs: 'evidence', rightsAcknowledged: true }), { status: 422 });
  assert.equal(mismatchCalls.length, 1);
});

test('importMedia rejects when the actual downloaded Content-Type disagrees with the metadata-declared mime (interstitial/error-page defense)', async (t) => {
  const store = await fixture(t);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(Buffer.from('<html>captcha</html>'), { type: 'text/html' }));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  await assert.rejects(media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true }), { status: 422 });
  assert.equal(store.list('uploads').length, 0);
  assert.deepEqual((await readdir(path.join(store.dataDir, 'uploads'))).length, 0);
});

test('importMedia probes the downloaded bytes and uses the verified result rather than trusting Commons-declared dimensions; a probe rejection registers no upload and leaves no orphaned file', async (t) => {
  const store = await fixture(t);
  let probedArgs;
  const probe = async (filename, contentType) => { probedArgs = [filename, contentType]; return { kind: 'image', width: 42, height: 24 }; };
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem({ imageinfo: { width: 2000, height: 2000 } })]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true });
  assert.equal(upload.width, 42);
  assert.equal(upload.height, 24);
  assert.notEqual(upload.width, 2000, 'Commons-declared dimensions must not override the local probe result');
  assert.match(probedArgs[1], /^image\//);

  const { fetchImpl: failFetch } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES));
  const failProbe = async () => { throw new Error('unsupported visual stream'); };
  const failMedia = new SourceMediaService({ store, fetchImpl: failFetch, userAgent: UA, probe: failProbe });
  const before = await readdir(path.join(store.dataDir, 'uploads'));
  await assert.rejects(failMedia.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true }));
  const after = await readdir(path.join(store.dataDir, 'uploads'));
  assert.deepEqual(after, before, 'a failed probe must not leave an orphaned downloaded file');
  assert.equal(store.list('uploads').length, 1, 'only the earlier successful import is registered');
});

test('importMedia hashes the actually-written bytes with sha256 and retains Commons\' own sha1 as separate upstream evidence', async (t) => {
  const store = await fixture(t);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES, { headers: { 'content-length': '999999' } }));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true });
  assert.equal(upload.sha256, createHash('sha256').update(PNG_BYTES).digest('hex'));
  assert.equal(upload.size, PNG_BYTES.length, 'a forged Content-Length must not be trusted over actually-written bytes');
  assert.equal(upload.provenance.sha1, 'b72cae08ddb2c4a4d06d91d052cf0b78ed1ab74c');
  assert.notEqual(upload.sha256, upload.provenance.sha1);
  const persisted = await readFile(path.join(store.dataDir, 'uploads', upload.filename));
  assert.deepEqual(persisted, PNG_BYTES);
});

test('importMedia never auto-creates a mediaRights clearance record; AttributionRequired/Copyrighted/license fields are preserved only as raw evidence for later human review', async (t) => {
  const store = await fixture(t);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true });
  assert.equal(store.list('mediaRights').length, 0);
  assert.equal(upload.provenance.extmetadata.LicenseShortName.value, 'CC BY-SA 4.0');
  assert.equal(upload.provenance.extmetadata.AttributionRequired.value, 'true');
});

// ---------------------------------------------------------------------------
// clearRights: explicit human decision, no automatic clearance
// ---------------------------------------------------------------------------

test('clearRights requires licenseId+attribution+sourceUrl for third-party origin and binds the record to the upload\'s current sha256', async (t) => {
  const store = await fixture(t);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true });

  for (const body of [{ origin: 'third-party' }, { origin: 'third-party', licenseId: 'CC-BY-SA-4.0' }, { origin: 'third-party', licenseId: 'CC-BY-SA-4.0', attribution: 'Fixture Photographer' }]) {
    await assert.rejects(media.clearRights(upload.id, body), { status: 400 }, `${JSON.stringify(body)} must not create a vacuous rights record`);
  }
  assert.equal(store.list('mediaRights').length, 0);

  const cleared = await media.clearRights(upload.id, { origin: 'third-party', licenseId: 'CC-BY-SA-4.0', attribution: 'Fixture Photographer, CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Kingfisher.jpg' });
  assert.equal(cleared.uploadId, upload.id);
  assert.equal(cleared.sha256, upload.sha256);
  assert.equal(store.list('mediaRights').length, 1);
});

test('clearRights accepts own-origin without a license, rejects an unknown origin value, and rejects an unknown uploadId', async (t) => {
  const store = await fixture(t);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'illustration', rightsAcknowledged: true });
  const own = await media.clearRights(upload.id, { origin: 'own' });
  assert.equal(own.origin, 'own');
  await assert.rejects(media.clearRights(upload.id, { origin: 'public-domain-because-i-said-so' }), { status: 400 });
  await assert.rejects(media.clearRights('00000000-0000-4000-8000-000000000000', { origin: 'own' }), { status: 404 });
});

// ---------------------------------------------------------------------------
// attach(): reject unlicensed/uncleared assets; accept cleared/own; versioned roundtrip
// ---------------------------------------------------------------------------

test('attach rejects a third-party uploadId with no matching mediaRights record, even though Commons metadata claimed a license (no automatic clearance)', async (t) => {
  const store = await fixture(t);
  const episode = episodeFixture(store, [baseScene()]);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true });
  // clearRights() is never called for this upload — Commons' own license metadata must never substitute
  // for an explicit human rights decision, no matter how confident-looking the implied license is.
  assert.equal(store.list('mediaRights').length, 0);
  await assert.rejects(media.attach(episode.id, { sceneId: 'scene-1', uploadId: upload.id, expectedVersion: episode.version, useAs: 'evidence' }), { status: 409 });
  assert.equal(store.get('episodes', episode.id).version, 1, 'a rejected attach must not mutate the episode');
});

test('attach rejects a third-party uploadId whose mediaRights sha256 no longer matches the upload\'s current sha256 (stale clearance cannot be reused)', async (t) => {
  const store = await fixture(t);
  const episode = episodeFixture(store, [baseScene()]);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true });
  await media.clearRights(upload.id, { origin: 'third-party', licenseId: 'CC-BY-SA-4.0', attribution: 'Fixture Photographer', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Kingfisher.jpg' });
  // Simulate the same upload id later pointing at different bytes (re-upload/replace).
  store.save('uploads', { ...store.get('uploads', upload.id), sha256: 'f'.repeat(64) });
  await assert.rejects(media.attach(episode.id, { sceneId: 'scene-1', uploadId: upload.id, expectedVersion: episode.version, useAs: 'evidence' }), { status: 409 });
});

test('attach succeeds for an own-origin upload cleared with no license/attribution required (bare clearRights record), sets scene.kind/assetUrl/source, and bumps the episode version', async (t) => {
  const store = await fixture(t);
  const episode = episodeFixture(store, [baseScene()]);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'illustration', rightsAcknowledged: true });
  await media.clearRights(upload.id, { origin: 'own' });
  await media.attach(episode.id, { sceneId: 'scene-1', uploadId: upload.id, expectedVersion: episode.version, useAs: 'illustration' });
  const current = store.get('episodes', episode.id);
  assert.equal(current.version, 2);
  const scene = current.scenes.find((item) => item.id === 'scene-1');
  assert.equal(scene.kind, 'image');
  assert.equal(scene.assetUrl, upload.url);
  assert.equal(scene.source.origin, 'own');
  assert.equal(scene.source.useAs, 'illustration');
  assert.equal(scene.source.sha256, upload.sha256);
});

test('attach image source/attribution/trim/history roundtrip: history preserves the first version unchanged while the current version reflects the second attach', async (t) => {
  const store = await fixture(t);
  const episode = episodeFixture(store, [baseScene()]);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES), searchQueryResponse([commonsItem({ page: { pageid: 777 }, imageinfo: { url: 'https://upload.wikimedia.org/wikipedia/commons/c/cc/Fixture_Second.jpg' } })]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const first = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true });
  await media.clearRights(first.id, { origin: 'third-party', licenseId: 'CC-BY-SA-4.0', attribution: 'First Photographer', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Kingfisher.jpg' });
  const afterFirst = await media.attach(episode.id, { sceneId: 'scene-1', uploadId: first.id, expectedVersion: 1, trimStart: 1.5, useAs: 'evidence' });
  assert.equal(afterFirst.scenes[0].source.attribution, 'First Photographer');
  assert.equal(afterFirst.scenes[0].trimStart, 1.5);

  const second = await media.importMedia({ pageId: 777, kind: 'image', useAs: 'illustration', rightsAcknowledged: true });
  await media.clearRights(second.id, { origin: 'third-party', licenseId: 'CC0-1.0', attribution: 'Second Photographer', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Second.jpg' });
  await media.attach(episode.id, { sceneId: 'scene-1', uploadId: second.id, expectedVersion: 2, trimStart: 3, useAs: 'illustration' });

  const current = store.get('episodes', episode.id);
  assert.equal(current.version, 3);
  assert.equal(current.scenes[0].source.attribution, 'Second Photographer');
  assert.equal(current.scenes[0].trimStart, 3);

  const history = store.history(episode.id);
  const v2 = history.find((entry) => entry.version === 2);
  assert.equal(v2.snapshot.scenes[0].source.attribution, 'First Photographer', 'editing to a second asset must not retroactively rewrite the first version\'s recorded attribution');
  assert.equal(v2.snapshot.scenes[0].trimStart, 1.5);
});

test('attach video roundtrip with trimStart/trimEnd and useAs, and rejects a stale expectedVersion (409) leaving the episode unchanged', async (t) => {
  const store = await fixture(t);
  const episode = episodeFixture(store, [baseScene()]);
  const webmItem = commonsItem({ imageinfo: { url: 'https://upload.wikimedia.org/wikipedia/commons/c/cc/Fixture.webm', mime: 'video/webm', mediatype: 'VIDEO' } });
  const { fetchImpl } = fetchQueue(searchQueryResponse([webmItem]), mediaResponse(WEBM_BYTES, { type: 'video/webm' }));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: videoProbe });
  const upload = await media.importMedia({ pageId: 501, kind: 'video', useAs: 'evidence', rightsAcknowledged: true });
  await media.clearRights(upload.id, { origin: 'third-party', licenseId: 'CC-BY-4.0', attribution: 'Fixture Videographer', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture.webm' });

  await assert.rejects(media.attach(episode.id, { sceneId: 'scene-1', uploadId: upload.id, expectedVersion: 99, trimStart: 1, trimEnd: 3, useAs: 'evidence' }), { status: 409 });
  assert.equal(store.get('episodes', episode.id).version, 1);

  const updated = await media.attach(episode.id, { sceneId: 'scene-1', uploadId: upload.id, expectedVersion: 1, trimStart: 1, trimEnd: 3, useAs: 'evidence' });
  const scene = updated.scenes.find((item) => item.id === 'scene-1');
  assert.equal(scene.kind, 'video');
  assert.equal(scene.trimStart, 1);
  assert.equal(scene.trimEnd, 3);
  assert.equal(scene.source.useAs, 'evidence');
  assert.equal(scene.source.licenseId, 'CC-BY-4.0');
});

// ---------------------------------------------------------------------------
// card(): original text-only fallback, no fabrication, no provider call
// ---------------------------------------------------------------------------

test('card preserves title/text/narration, clears assetUrl/source, flips kind to title, bumps version, and calls no provider/network at all', async (t) => {
  const store = await fixture(t);
  const episode = episodeFixture(store, [baseScene({ kind: 'image', assetUrl: '/api/uploads/11111111-1111-4111-8111-111111111111.png', title: 'The actual reported event', text: 'Evidence paragraph describing what happened', narration: 'Narration describing the event' })]);
  const fetchCalls = [];
  const media = new SourceMediaService({ store, fetchImpl: async (url) => { fetchCalls.push(url); throw new Error('must never be called'); }, userAgent: UA, probe: imageProbe });
  const updated = await media.card(episode.id, { sceneId: 'scene-1', expectedVersion: 1 });
  const scene = updated.scenes.find((item) => item.id === 'scene-1');
  assert.equal(scene.kind, 'title');
  assert.equal(scene.assetUrl, undefined);
  assert.equal(scene.source, undefined);
  assert.equal(scene.title, 'The actual reported event');
  assert.equal(scene.text, 'Evidence paragraph describing what happened');
  assert.equal(scene.narration, 'Narration describing the event');
  assert.equal(store.get('episodes', episode.id).version, 2);
  assert.equal(fetchCalls.length, 0, 'the no-footage fallback must never invoke a provider/network call');
  assert.equal(store.list('uploads').length, 0);
  assert.equal(store.list('mediaRights').length, 0);
});

// ---------------------------------------------------------------------------
// candidateAsset verification across the EXISTING validation.mjs/render.mjs contracts
// ---------------------------------------------------------------------------

test('the existing scenes() validator accepts SourceMediaService\'s registered upload URL unmodified, and still rejects a raw Commons description URL used directly as assetUrl', async (t) => {
  const store = await fixture(t);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'illustration', rightsAcknowledged: true });
  assert.doesNotThrow(() => validateScenes([{ ...baseScene(), kind: 'image', assetUrl: upload.url }]));

  assert.throws(() => validateScenes([{ ...baseScene(), kind: 'image', assetUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Kingfisher.jpg' }]), HttpError);
  assert.throws(() => validateScenes([{ ...baseScene(), kind: 'image', assetUrl: 'https://upload.wikimedia.org/wikipedia/commons/c/cc/Fixture_Kingfisher.jpg' }]), HttpError);
});

test('media.validateAssets rejects a scene whose third-party source has no/mismatched mediaRights, passes a cleared match, and passes a legacy source-less scene untouched', async (t) => {
  const store = await fixture(t);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem()]), mediaResponse(PNG_BYTES));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: imageProbe });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'evidence', rightsAcknowledged: true });

  const uncleared = [{ ...baseScene(), kind: 'image', assetUrl: upload.url, source: { origin: 'third-party', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Kingfisher.jpg', sha256: upload.sha256, useAs: 'evidence' } }];
  assert.throws(() => media.validateAssets(uncleared));

  await media.clearRights(upload.id, { origin: 'third-party', licenseId: 'CC-BY-SA-4.0', attribution: 'Fixture Photographer', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Kingfisher.jpg' });
  assert.doesNotThrow(() => media.validateAssets(uncleared));

  const mismatched = [{ ...baseScene(), kind: 'image', assetUrl: upload.url, source: { origin: 'third-party', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Kingfisher.jpg', sha256: 'f'.repeat(64), useAs: 'evidence' } }];
  assert.throws(() => media.validateAssets(mismatched));

  const legacy = [{ ...baseScene(), kind: 'image', assetUrl: '/api/uploads/22222222-2222-4222-8222-222222222222.png' }];
  assert.doesNotThrow(() => media.validateAssets(legacy), 'a pre-existing scene with no source field at all must never be blocked by the new rights gate');
});

// ---------------------------------------------------------------------------
// Editable-but-not-implicitly-cleared / actual rendering
// ---------------------------------------------------------------------------

test('scene and slot provenance survive validation independently, and generated visuals cannot claim factual-event evidence', () => {
  const source = { origin: 'third-party', useAs: 'evidence', attribution: 'Scene Reporter', licenseId: 'CC-BY-4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Report.png', retrievedAt: '2026-01-01T00:00:00Z', sha256: 'a'.repeat(64) };
  const slotSource = { ...source, attribution: 'Illustration Author', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Illustration.png', useAs: 'illustration' };
  const input = [baseScene({ kind: 'image', assetUrl: '/api/uploads/11111111-1111-4111-8111-111111111111.png', source, slots: [{ id: 'source-slot', role: 'image-gen', x: 0, y: 0, w: 50, h: 50, zIndex: 1, assetUrl: '/api/uploads/22222222-2222-4222-8222-222222222222.png', source: slotSource }] })];
  const result = validateScenes(input);
  assert.deepEqual(result[0].source, source);
  assert.deepEqual(result[0].slots[0].source, slotSource);
  for (const patch of [{ origin: 'unknown' }, { sourceUrl: 'javascript:alert(1)' }, { sha256: 'a'.repeat(63) }, { retrievedAt: 'yesterday' }, { useAs: 'evidence', origin: 'generated', generationJobId: 'job-1' }, { attribution: 'x'.repeat(4001) }]) {
    assert.throws(() => validateScenes([{ ...input[0], source: { ...source, ...patch } }]), { status: 400 });
    assert.throws(() => validateScenes([{ ...input[0], slots: [{ ...input[0].slots[0], source: { ...slotSource, ...patch } }] }]), { status: 400 });
  }
});

test('attaching an uncleared own-origin asset leaves the episode a draft and renders mechanically through the unmodified local pipeline, and rendering never fabricates a mediaRights record', async (t) => {
  try { await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']); await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg and FFprobe are required to prove mechanical render success'); return; } throw error; }
  const store = await fixture(t);
  const episode = episodeFixture(store, [baseScene()]);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem({ imageinfo: { mime: 'image/png', mediatype: 'BITMAP' } })]), mediaResponse(PNG_BYTES, { type: 'image/png' }));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: probeGenerationAsset });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'illustration', rightsAcknowledged: true });
  await media.clearRights(upload.id, { origin: 'own' });
  const updated = await media.attach(episode.id, { sceneId: 'scene-1', uploadId: upload.id, expectedVersion: 1, useAs: 'illustration' });
  assert.equal(store.get('episodes', episode.id).status, 'draft', 'attaching media must not auto-promote review/ready status');

  const result = await renderEpisode({ format: '9:16', scenes: updated.scenes }, { dataDir: store.dataDir });
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(store.list('mediaRights').length, 1, 'rendering must not create, require or imply any additional rights clearance as a side effect (PW-03: render may remain a draft, never implies clearance)');
});

test('a Commons-imported, rights-cleared image actually renders through the existing local pipeline and its credit metadata survives afterward', async (t) => {
  try { await execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']); await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-version']); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('FFmpeg and FFprobe are required for actual credited local rendering'); return; } throw error; }
  const store = await fixture(t);
  const episode = episodeFixture(store, [baseScene()]);
  const { fetchImpl } = fetchQueue(searchQueryResponse([commonsItem({ imageinfo: { mime: 'image/png', mediatype: 'BITMAP' } })]), mediaResponse(PNG_BYTES, { type: 'image/png' }));
  const media = new SourceMediaService({ store, fetchImpl, userAgent: UA, probe: probeGenerationAsset });
  const upload = await media.importMedia({ pageId: 501, kind: 'image', useAs: 'illustration', rightsAcknowledged: true });
  await media.clearRights(upload.id, { origin: 'third-party', licenseId: 'CC-BY-SA-4.0', attribution: 'Fixture Photographer, CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Fixture_Kingfisher.jpg' });
  const updated = await media.attach(episode.id, { sceneId: 'scene-1', uploadId: upload.id, expectedVersion: 1, useAs: 'illustration' });

  const result = await renderEpisode({ format: '9:16', scenes: updated.scenes }, { dataDir: store.dataDir });
  const probe = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', path.join(store.dataDir, 'exports', result.filename)]);
  const streams = JSON.parse(probe.stdout).streams;
  assert.equal(streams.find((stream) => stream.codec_type === 'video').width, 1080);
  assert.equal(streams.find((stream) => stream.codec_type === 'video').height, 1920);

  const current = store.get('episodes', episode.id);
  assert.equal(current.scenes[0].source.attribution, 'Fixture Photographer, CC BY-SA 4.0', 'a successful render must never strip or rewrite the credited attribution it depends on');
  assert.equal(current.scenes[0].source.licenseId, 'CC-BY-SA-4.0');
});
