---
name: generation-recovery
description: Recover known provider generation requests and apply retained media without duplicate submission or stale episode writes.
triggers:
  - "Higgsfield recovery"
  - "generation apply conflict"
edges:
  - target: context/architecture.md
    condition: when tracing provider, queue and Store ownership
  - target: patterns/provider-evidence.md
    condition: when interpreting transport authentication or execution evidence
grounds_to: []
last_updated: 2026-10-18
---

# Generation recovery

## Context
Read `GenerationQueue.recover()` in `server/generations.mjs` and `Store.applyGeneration()` in `server/store.mjs`. The local job ID, client requestId and providerRequestId identify different things. Credentials remain outside tracked project knowledge.

For a completed video whose browser clock advances without decoded frames, inspect `GenerationQueue.normalize()` and `Store.normalizeGeneration()`. An MP4 container or advancing playback time does not prove browser codec compatibility.

## Steps
1. Read the existing generation job and its saved transport/provider ID before taking action.
2. For polling_failed, import_failed or manual_recovery, recover only a known provider ID through the matching transport. The recovery endpoint resumes status polling/import and never calls create.
3. For submission_unknown or a missing provider ID, inspect provider history. Do not manufacture a replacement identifier or automatically submit again.
4. Wait for imported local output and inspect its media type, probe metadata and SHA-256. A completed generation has not necessarily been applied.
5. Re-read the current episode. Preserve unsaved edits, confirm the intended scene still exists and apply with the current expectedVersion. A stale apply retains the paid output; it does not replace the newer draft.

## Browser video normalization
1. Inspect actual video codec, pixel format, audio codec and browser decoded dimensions. The live Seedance output exposed HEVC/yuv420p10le with Chromium videoWidth 0 despite an advancing clock.
2. Normalize the existing completed job locally. This operation makes no provider creation or download request, verifies the original hash and keeps the original registered asset unchanged. The browser candidate uses H.264/yuv420p with AAC when audio exists.
3. Retain original provenance and previous application receipts. Normalization resets the new candidate's apply state but does not change episode scenes or old snapshots.
4. Explicitly apply the normalized candidate at the current episode version, then verify real decoded dimensions/frames. Do not infer final browser success solely from FFprobe metadata or clock advancement.

## Gotchas
Automatic polling pauses after 30 minutes or bounded consecutive status failures. Explicit recovery starts a new polling window but never a new paid generation. Provider terminal refusals and canceled/failed jobs are not automatically recoverable. An already active or completed job returns its existing state. Queue capacity includes pending schema validation. Switching CLI/API transport does not make saved provider IDs interchangeable.

Explicit normalization is idempotent for already compatible media, rejects changed original hashes and blocks application while conversion is active. At most two explicit normalizations run concurrently (or the lower configured active-job limit). FFmpeg uses single-thread encoder/decoder settings, a 180-second timeout, a 100-MiB output bound and standalone local demuxer/protocol restrictions. Failed conversion/commit cleans only new candidates and leaves original assets/history intact.

## Verify
Run `node --test tests/generations.test.mjs` for duplicate-submission prevention, recovery, age limits, stale apply, atomic rollback, actual HEVC conversion and original/hash/history preservation. Use `artifacts/higgsfield-live-smoke.json` only for its recorded real-provider path; browser recovery fixtures do not prove a provider recovery occurred. `artifacts/higgsfield-normalization.json` records the real original-preserving local conversion and explicit version-5 application without another provider call; final browser decoding requires its own receipt.

## Debug
Separate connection failure, unknown submission, polling failure, import rejection and apply conflict. Check current model schema and the exact allowed CDN origin; never broaden asset downloads to arbitrary URLs to clear an import error. Check the original transport before recovery.

## Update Scaffold
Update the current report and `.mex/ROUTER.md` when a new real execution receipt changes provider status. Keep historical evidence and immutable harness bundles intact.
