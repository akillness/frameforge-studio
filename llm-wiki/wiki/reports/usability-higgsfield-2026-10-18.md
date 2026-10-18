---
type: Report
title: White studio, production history and Higgsfield verification
description: Seven-view white UI, shared generation inspector, exact cost/version consent and scoped local QA, separated from historical paid CLI evidence.
tags: [usability, history, nodes, higgsfield, generation, mcp, verification, white-studio]
timestamp: 2026-10-18T10:13:30.128+00:00
last_updated: 2026-10-18
---

# White studio — latest local scope

The white UI is active in Studio, Workflow, Trends, Templates, History, Knowledge and Settings. The Studio Higgsfield CTA reuses the existing workflow inspector rather than introducing another generation form. If the current graph is not an existing-script generation path, it opens an unsaved five-node `script(existing) -> storyboard -> generate -> render -> review` draft and preserves the saved graph. Opening does not save, run or spend. Targeting uses the live selected scene's stable ID, including unsaved appended scenes; reordering updates its index and deleting it blocks before quote/run.
The personal workspace adds browser-local sizing without a second editor: `auto` is the docked fit, `compact` is 1024×768 overlay, `standard` is 1280×800 docked, `wide` is 1600×900 docked and `focus` is 1280×800 overlay. Numeric width/height/inspector controls are bounded to 320–2560px, 320–1800px and 240–480px; pointer dragging and keyboard arrows resize the custom layout, with Shift selecting the coarse step. Inspector, narration and assistant panels open as native dialog overlays by moving the existing DOM. Named profiles remain in browser storage and issue no server layout writes. Assistant unsent drafts are episode-scoped transient state; inspector edits are scene-scoped state. Screenshots and the authenticated receipt are [workspace assets](../../../docs/assets/workspace/) and [workspace-browser-smoke.json](../../../artifacts/workspace-browser-smoke.json).

The [research artifact](../../../artifacts/white-studio-research.json) contains 16 design references, 12 official Higgsfield sources and Aside read-only public UI observations. Design evidence includes [Adobe Spectrum](https://spectrum.adobe.com/), [GOV.UK Details](https://design-system.service.gov.uk/components/details/) and [WCAG text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Aside observed the prompt/model/settings grouping, a displayed credit amount and separate history in Higgsfield's public UI without generation. Displayed web credits are not an authenticated API quote. The artifact retains pre-implementation findings; its `implementationDecisions` clarifies the actual workflow auto-apply contract below.

## Cost, versions and provider identity

The REST adapter calls official `POST /estimate/{model}` with exact validated generation input and sends persisted `generationJobs.id` as `Idempotency-Key` on create. See [official billing/estimation](https://docs.higgsfield.ai/docs/concepts/billing-and-retention), [official idempotency](https://docs.higgsfield.ai/docs/concepts/idempotency), [adapter](../../../server/higgsfield.mjs) and [queue](../../../server/generations.mjs). No automatic POST replay was added: ambiguous submission still requires provider-history inspection, and known provider IDs support polling/import recovery only.

Before confirmation, the UI fetches a fresh quote for the current model, prompt and parameters; changes invalidate the prior quote. If no exact quote is available, explicit no-quote acknowledgement is required. Confirmation accurately states that the **full workflow automatically applies the generated output with version checks and then renders**. Retained/recovered outputs instead use a separate Apply action. The UI sends quoted `expectedWorkflowVersion` and `expectedEpisodeVersion`; optional exact-version guards reject stale 409 before creating a run or reaching a provider. History, optimistic concurrency and paid-output recovery remain protected. A configured connection is not proof of authenticated availability; REST credentials, CLI login, official MCP OAuth and the project-owned MCP bridge remain distinct [connections](../../../docs/higgsfield-integration.md).

## Current QA evidence

| Evidence | Observed result | Limit |
| --- | --- | --- |
| `node --test tests/white-studio.test.mjs tests/white-studio-versions.test.mjs` | 16 scoped tests passed | Scoped regression coverage; not provider proof |
| `npm run check` | 55 modules passed syntax checks | Syntax check, not a formatter/linter or production deployment |
| Linux Docker `npm test` | 213 tests passed, 0 failures, 0 skipped | Full suite receipt is [artifact://453](artifact://453); no paid provider call |
| [White-studio browser receipt](../../../artifacts/white-studio-browser-smoke.json) | Authenticated loopback 4329: 101/101 checks, zero page errors/generation creates/accepted runs | Provider catalog/quote/recovery/apply responses are explicit fixtures |
| [Workspace browser receipt](../../../artifacts/workspace-browser-smoke.json) | Authenticated loopback 4329: 157/157 checks, zero page errors and zero layout API writes; presets, numeric/pointer/keyboard resize, overlays, profiles and scene/episode state boundaries exercised | Native `showModal` may focus browser chrome; no strict always-inside DOM focus wrap is claimed |
| [Workspace screenshots](../../../docs/assets/workspace/final-workspace.png) | Final workspace, overlay and profile evidence links | Screenshots are evidence of the exercised UI state, not deployment |
| [Final isolated container receipt](../../../artifacts/white-studio-container-smoke.json) | Final-image render/authenticated download and exact-output saved-edit review; restart persistence passed | Local isolated image, not a public production deployment |
| [Final verification receipt](../../../artifacts/white-studio-verification.json) | Image `sha256:d4424d7f59c495f97d72ea2e85fb643fe64e9f35b69ff374da90617ca9ce6023`; 15/15 inspected source hashes matched | No public deployment, live paid Higgsfield generation or Developer REST authentication claim |

The [final local verification receipt](../../../artifacts/white-studio-verification.json) records image `sha256:d4424d7f59c495f97d72ea2e85fb643fe64e9f35b69ff374da90617ca9ce6023` built, 15/15 inspected source SHA-256 values matching checkout, final-image render and restart persistence. Commands and scope are recorded in [verification](../../../docs/verification.md); browser images show [desktop Studio](../../../docs/assets/white-studio/studio-1440.png), [desktop Workflow](../../../docs/assets/white-studio/workflow-1440.png), [390px Studio](../../../docs/assets/white-studio/studio-390.png) and [final workspace](../../../docs/assets/workspace/final-workspace.png). No paid generation, public deployment or Windows/Tailscale production cutover occurred in this change. Developer REST authentication and owner acceptance are not established by these receipts.

The following sections preserve earlier implementation and Windows/Tailscale observations. They are not new-provider execution or latest-source deployment evidence.

# Editing and production history

The editor now compares episode scenes, workflow nodes and connections using stable IDs. Users can inspect saved versions, preserve unsaved drafts, undo/redo draft changes and restore a prior snapshot as a new current version. Restore requires expectedVersion, revalidates editable content and preserves old history/reviews; restored episodes return to draft. Node labels, notes and effective stage settings persist, and the selected node exposes readable execution inputs and outputs. See [[wiki/concepts/production-history]], [history comparison code](../../../public/history.js) and [workflow implementation](../../../server/workflows.mjs).

The [local browser receipt](../../../artifacts/usability-browser-smoke.json) passed 23 checks on disposable records, with zero page errors and no horizontal overflow at 1440/390px. It exercised history restoration, dirty guards, node editing/focus, undo/redo, run inspection, generation configuration and explicit generation confirmation without submission. Its direct Developer API catalog and paid-output recovery controls used intercepted HTTP fixtures. Those checks establish the UI behavior they exercised; they do not prove an authenticated Developer API call or actual provider recovery.

# Generation boundaries and recovery

[GenerationQueue](../../../server/generations.mjs) persists intent and a client idempotency key before submission. The same request identity returns the same job; a different payload with that key conflicts. Schema validation and CLI argument preflight precede submission. A lost or ambiguous provider submission response becomes submission_unknown and is never automatically retried. Restarts resume status polling only when a provider request ID is known and its transport matches.

Downloaded output passes fixed-origin HTTPS/DNS restrictions, size/time bounds, standalone local FFprobe validation and SHA-256 hashing before registration as local media. Queue completion/import and scene application are separate operations. [Store application](../../../server/store.mjs) atomically updates the original surviving scene, episode version/history and job state under expectedVersion. The full workflow invokes apply before rendering; retained/recovered outputs have an explicit Apply action. Stale application keeps the paid output for deliberate reconciliation.

Runtime knowledge export now relates generation jobs and imported assets to their episode, preserving the applied version and asset provenance in generated OKF atoms. Export refreshes after import and apply. The root's targeted 23-test run checked these relationships, applied-version atoms and omission of signed URL query strings; these runtime links remain distinct from the structural source-code graph.

Known-ID polling/import failures can use the explicit recovery action. Recovery checks transport and queue capacity and never invokes generation creation. Automatic polling pauses after 30 minutes; explicit recovery starts a fresh polling window for the same request. Provider terminal refusals, unknown outcomes and missing IDs are not automatically recoverable. The detailed operator contract is in [generation recovery](../../../.mex/patterns/generation-recovery.md).

# Historical real provider execution

The [live receipt](../../../artifacts/higgsfield-live-smoke.json), observed at 2026-10-18T09:54:32.769Z, records actual project MCP stdio -> authenticated FrameForge HTTP API -> Docker -> authenticated Windows official Higgsfield CLI. Seedance 2.5 completed a paid generation with requested duration 4 seconds, resolution 1080p and aspect ratio 9:16. The imported video measured 1080x1920 and 4.042 seconds, with 824923 bytes and verified local SHA-256 `1b8aae0485b8aa1c2974c680c9cb068f467c0ea60ff3d66c000dcee0be622239`. It was applied as episode version 3 and rendered successfully in Docker. The reported 64 credits were the estimate; this receipt does not measure the final charge.

Subsequent real-browser inspection found a compatibility defect: the original video used HEVC with yuv420p10le, and Chromium's playback clock advanced while decoded videoWidth remained zero. Advancing time alone was insufficient proof of video playback. The [normalization receipt](../../../artifacts/higgsfield-normalization.json), observed at 2026-10-18T10:13:30.128Z, records a local H.264/yuv420p/AAC copy at 1080x1920 and 4.042 seconds. Its SHA-256 is `cdd5e2e6249c01d7e9400bfb1731ae273d609f0fd718008f1a1b407384f5aa30`; the original bytes and hash above remain preserved. Explicit application created episode version 5 without another provider generation call.

The normalization path keeps the original as a registered asset and links the browser candidate to its original hash/probe metadata. Prior applied versions and their outputs remain recorded; conversion itself does not mutate episode scenes. Apply is blocked while normalization runs and then requires the current expectedVersion. Conversion is bounded by concurrency, single-thread encoder/decoder settings, 180 seconds and 100 MiB. Final production HTTPS verification passed 21 checks: imported footage and final render decode at 1080×1920 and display visible frames, with zero page errors or overflow at 1440/390px. Applied v5 was rendered as v6 without another provider generation or publication approval. Evidence: `artifacts/higgsfield-browser-smoke.json`.

This supersedes the earlier statement that no paid generative-video provider was connected. It does not prove editorial quality, channel ownership, publication, all available models or a paid recovery execution. The [integration notes](../../../docs/higgsfield-integration.md) separately record authenticated official CLI discovery of 108 models and describe these distinct connections:

- Official remote Higgsfield MCP: configured URL and OAuth metadata observed; OAuth approval/authenticated tools remain pending.
- Developer REST API: implemented with contract tests; its separate credential was unavailable and authenticated execution is unverified.
- Project MCP: the repository-owned stdio API bridge used by the completed real-generation receipt. It is not the official remote vendor MCP.

# Verification scope

The earlier local run passed 129 tests and syntax checks for 50 modules, including generation idempotency, recovery, stale application, transaction rollback, real HEVC 10-bit conversion, preserved original hashes, prior-application history, explicit reapply and normalization concurrency. The [earlier browser receipt](../../../artifacts/usability-browser-smoke.json), [live-generation receipt](../../../artifacts/higgsfield-live-smoke.json) and [normalization receipt](../../../artifacts/higgsfield-normalization.json) retain those independent scopes. The final white-studio/workspace run is 16 scoped tests, 55-module syntax check, Linux Docker full suite 213/213 with zero failures/skips, white-studio browser 101/101 and workspace browser 157/157 above; no new paid provider call or public deployment is claimed.

The [active harness pointer](../../../harness/manifest.json) selects immutable 1.4.0; 1.3.0 is archived. The [Jev review](../../../artifacts/jev-higgsfield-review.json) is a real jev-1.13.0 API response in 525 ms with proposal_only/unvalidated status. It predates final live execution and does not authorize actions or prove calibrated judgment.

Historical Docker migration, narration, review and CI evidence remains in [[wiki/reports/runtime-verification-2026-10-18]]. Source graph freshness is a separate structural verification step, as described in [[wiki/concepts/knowledge-layers]]. This update changes canonical working-tree knowledge; commit/push is required to share it. Runtime media and credentials remain outside the tracked wiki.



**Prior structural refresh:** MEX 70 files, 1735 nodes/5331 edges, check100 with zero drift; Graphify 1274 nodes/2858 unique edges from 183 source files; wiki 9 pages/7 OKF atoms, zero errors. These counts predate the white-studio changes. The parent refreshes graphs and wiki validation after final sources; use the resulting receipts before claiming current freshness. Begin with the [latest scoped verification](../../../docs/verification.md).
