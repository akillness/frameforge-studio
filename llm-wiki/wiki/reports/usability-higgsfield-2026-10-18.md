---
type: Report
title: Node editing and Higgsfield generation verification
description: Readable version history, editable nodes, safe generation recovery and one verified paid generation through the project MCP and Docker host bridge.
tags: [usability, history, nodes, higgsfield, generation, mcp, verification]
timestamp: 2026-10-18T10:13:30.128+00:00
---

# Editing and production history

The editor now compares episode scenes, workflow nodes and connections using stable IDs. Users can inspect saved versions, preserve unsaved drafts, undo/redo draft changes and restore a prior snapshot as a new current version. Restore requires expectedVersion, revalidates editable content and preserves old history/reviews; restored episodes return to draft. Node labels, notes and effective stage settings persist, and the selected node exposes readable execution inputs and outputs. See [[wiki/concepts/production-history]], [history comparison code](../../../public/history.js) and [workflow implementation](../../../server/workflows.mjs).

The [local browser receipt](../../../artifacts/usability-browser-smoke.json) passed 23 checks on disposable records, with zero page errors and no horizontal overflow at 1440/390px. It exercised history restoration, dirty guards, node editing/focus, undo/redo, run inspection, generation configuration and explicit generation confirmation without submission. Its direct Developer API catalog and paid-output recovery controls used intercepted HTTP fixtures. Those checks establish the UI behavior they exercised; they do not prove an authenticated Developer API call or actual provider recovery.

# Generation boundaries and recovery

[GenerationQueue](../../../server/generations.mjs) persists intent and a client idempotency key before submission. The same request identity returns the same job; a different payload with that key conflicts. Schema validation and CLI argument preflight precede submission. A lost or ambiguous provider submission response becomes submission_unknown and is never automatically retried. Restarts resume status polling only when a provider request ID is known and its transport matches.

Downloaded output passes fixed-origin HTTPS/DNS restrictions, size/time bounds, standalone local FFprobe validation and SHA-256 hashing before registration as local media. A completed job is separate from an applied scene. [Store application](../../../server/store.mjs) atomically updates the original surviving scene, episode version/history and job state under expectedVersion. Stale application keeps the paid output for deliberate reconciliation.

Runtime knowledge export now relates generation jobs and imported assets to their episode, preserving the applied version and asset provenance in generated OKF atoms. Export refreshes after import and apply. The root's targeted 23-test run checked these relationships, applied-version atoms and omission of signed URL query strings; these runtime links remain distinct from the structural source-code graph.

Known-ID polling/import failures can use the explicit recovery action. Recovery checks transport and queue capacity and never invokes generation creation. Automatic polling pauses after 30 minutes; explicit recovery starts a fresh polling window for the same request. Provider terminal refusals, unknown outcomes and missing IDs are not automatically recoverable. The detailed operator contract is in [generation recovery](../../../.mex/patterns/generation-recovery.md).

# Observed real provider execution

The [live receipt](../../../artifacts/higgsfield-live-smoke.json), observed at 2026-10-18T09:54:32.769Z, records actual project MCP stdio -> authenticated FrameForge HTTP API -> Docker -> authenticated Windows official Higgsfield CLI. Seedance 2.5 completed a paid generation with requested duration 4 seconds, resolution 1080p and aspect ratio 9:16. The imported video measured 1080x1920 and 4.042 seconds, with 824923 bytes and verified local SHA-256 `1b8aae0485b8aa1c2974c680c9cb068f467c0ea60ff3d66c000dcee0be622239`. It was applied as episode version 3 and rendered successfully in Docker. The reported 64 credits were the estimate; this receipt does not measure the final charge.

Subsequent real-browser inspection found a compatibility defect: the original video used HEVC with yuv420p10le, and Chromium's playback clock advanced while decoded videoWidth remained zero. Advancing time alone was insufficient proof of video playback. The [normalization receipt](../../../artifacts/higgsfield-normalization.json), observed at 2026-10-18T10:13:30.128Z, records a local H.264/yuv420p/AAC copy at 1080x1920 and 4.042 seconds. Its SHA-256 is `cdd5e2e6249c01d7e9400bfb1731ae273d609f0fd718008f1a1b407384f5aa30`; the original bytes and hash above remain preserved. Explicit application created episode version 5 without another provider generation call.

The normalization path keeps the original as a registered asset and links the browser candidate to its original hash/probe metadata. Prior applied versions and their outputs remain recorded; conversion itself does not mutate episode scenes. Apply is blocked while normalization runs and then requires the current expectedVersion. Conversion is bounded by concurrency, single-thread encoder/decoder settings, 180 seconds and 100 MiB. Final production HTTPS verification passed 21 checks: imported footage and final render decode at 1080×1920 and display visible frames, with zero page errors or overflow at 1440/390px. Applied v5 was rendered as v6 without another provider generation or publication approval. Evidence: `artifacts/higgsfield-browser-smoke.json`.

This supersedes the earlier statement that no paid generative-video provider was connected. It does not prove editorial quality, channel ownership, publication, all available models or a paid recovery execution. The [integration notes](../../../docs/higgsfield-integration.md) separately record authenticated official CLI discovery of 108 models and describe these distinct connections:

- Official remote Higgsfield MCP: configured URL and OAuth metadata observed; OAuth approval/authenticated tools remain pending.
- Developer REST API: implemented with contract tests; its separate credential was unavailable and authenticated execution is unverified.
- Project MCP: the repository-owned stdio API bridge used by the completed real-generation receipt. It is not the official remote vendor MCP.

# Verification scope

The latest local run passed 129 tests and syntax checks for 50 modules, including generation idempotency, recovery, stale application, transaction rollback, real HEVC 10-bit conversion, preserved original hashes, prior-application history, explicit reapply and normalization concurrency. The [browser receipt](../../../artifacts/usability-browser-smoke.json), [live-generation receipt](../../../artifacts/higgsfield-live-smoke.json) and [normalization receipt](../../../artifacts/higgsfield-normalization.json) carry their independent scopes above. Final rebuilt-container restart persistence, live HTTPS frame decoding and current-source CI must be read from their own final receipts; earlier success is not automatically inherited by changed code.

The [active harness pointer](../../../harness/manifest.json) selects immutable 1.4.0; 1.3.0 is archived. The [Jev review](../../../artifacts/jev-higgsfield-review.json) is a real jev-1.13.0 API response in 525 ms with proposal_only/unvalidated status. It predates final live execution and does not authorize actions or prove calibrated judgment.

Historical Docker migration, narration, review and CI evidence remains in [[wiki/reports/runtime-verification-2026-10-18]]. Source graph freshness is a separate structural verification step, as described in [[wiki/concepts/knowledge-layers]]. This update changes canonical working-tree knowledge; commit/push is required to share it. Runtime media and credentials remain outside the tracked wiki.



**Current structural refresh:** MEX 70 files, 1735 nodes/5331 edges, check100 with zero drift; Graphify 1274 nodes/2858 unique edges from 183 source files. Wiki structural validation: 9 pages/7 OKF atoms, zero errors. These are structure checks, not semantic or provider authentication claims.
