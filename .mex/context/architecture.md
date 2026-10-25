---
name: architecture
description: Request flow and ownership boundaries for the video production hub.
triggers:
  - "architecture"
edges:
  - target: context/stack.md
    condition: when related context is needed
  - target: context/decisions.md
    condition: when related context is needed
grounds_to: []
last_updated: 2026-10-25
---

# Architecture
## System Overview
The browser editor in public/ sends authenticated JSON requests to server/app.mjs.
The HTTP layer validates requests before writing production entities.
The Store owns SQLite entities, episode snapshots and knowledge export.
Rendering passes validated scenes to FFmpeg and returns a tracked job.
Optional external agent work crosses a token-authenticated host bridge.
Source evidence and template edits remain associated with channel and episode history.
## Key Components
- server/app.mjs: HTTP boundary and session handling.
- server/store.mjs: persistence and history.
- server/render.mjs: local video assembly.
- Uploaded inputs use standalone-media demuxer allowlists and the local file protocol only for both FFprobe and FFmpeg. Extension checks alone cannot prevent nested playlist references.
- server/integrations.mjs: trend and host bridge adapters.
- public/: shared white editor shell across seven views plus the operational overview. The Studio CTA calls `workflowEditor.openGeneration()` and reuses the existing workflow inspector; a new safe five-node draft uses the existing script, not a replacement storyboard provider. Opening performs no save/run/spend. Stable scene ID resolves against the live editor state after reorder; a deleted target blocks before quote or run.
- public/workspace.js, public/workspace-state.js, public/workspace.css: browser-local personal workspace sizing and tool presentation. Presets are auto/docked, compact 1024×768/overlay, standard 1280×800/docked, wide 1600×900/docked and focus 1280×800/overlay. Numeric width/height/inspector controls are bounded; pointer and keyboard resizing update the custom layout. Native dialog overlays move existing inspector, narration and assistant DOM panels. Named profiles persist only in browser storage; layout changes never write the server. Assistant unsent drafts are episode-scoped transient state, while inspector edits are scene-scoped.
- public/workspace.js, public/workspace-state.js, public/workspace.css also provide the operational overview: queue filters/sort/columns and named views are local-only; deliverables, history and operations panels derive from existing API records. The page adds no server schema, task entity or production write.
- server/workflows.mjs: typed production DAG, immutable workflow/version snapshots and per-node execution records; optional `expectedWorkflowVersion`/`expectedEpisodeVersion` guards reject stale 409 before run creation. Confirmed generate workflows import, atomically apply with episode-version checking, then render; the review checkpoint still awaits explicit human inspection.
- public/history.js and public/app.js: stable scene/node/edge comparisons, history selection, draft undo/redo and dirty-state guards. Restore validates an owned historical snapshot and appends a new current version rather than rewriting history.
- server/generations.mjs and Store.completeGeneration/applyGeneration: persistent idempotent generation intent, known-ID polling/recovery, bounded media import with probe/hash/provenance, and atomic episode apply. Queue completion/import is separate from apply; full workflows invoke apply before rendering, while retained/recovered outputs require the explicit Apply action. Stale apply preserves the paid output.
- Store.knowledge/exportKnowledge: runtime generation-job and imported-asset relationships to episodes, refreshed after import/apply with applied-version OKF atoms and signed URL query strings omitted.
- server/higgsfield.mjs, server/higgsfield-cli.mjs and the authenticated host bridge: distinct Developer REST and official CLI adapters. REST estimates use `POST /estimate/{model}` with exact generation input, and create sends persisted `generationJobs.id` as `Idempotency-Key`; ambiguous submissions are not replayed automatically. scripts/higgsfield-mcp.mjs exposes the authenticated project API over stdio, separate from the vendor's OAuth-protected remote MCP. Browser confirmation requires a fresh exact-input quote or explicit no-quote acknowledgement; configured-only status is not verified authentication/availability.
- server/narration.mjs, scripts/agent-bridge.mjs and scripts/speech.ps1: queued Windows voice synthesis locally or through an authenticated container-to-host raw-WAV bridge; generated audio attaches through the Store only if the original episode version still matches. Partial/stale output is cleaned.
- `server/graph.mjs` and `server/workflows.mjs`: deterministic edge-based execution for repeated roles within 128 nodes/256 edges; exact node-ID selection/resume and nearest connected producer boundaries. Layout and render consume their own branch evidence rather than another branch's mutable saved scenes. Each review is keyed by node ID; completed paid jobs retain their original identities.
- `server/candidates.mjs`: shared canonical exact-input generation/publication snapshots and physical local-byte/rights/provenance validation. A whole generation quote covers selected node/scene/slot inputs, costs and the human disclosure decision; approved sibling slot outputs do not invalidate one another's stable jobs.
- `server/media-sources.mjs` and `server/media-credits.mjs`: optional Commons discovery/import, explicit hash-bound rights, versioned source/trim attachment and original text-card fallback. Rendering and the final publication description derive credits from actual scene/slot sources. Generated outputs stay illustrations, not factual event evidence; local provenance never fabricates human rights clearance.
- `enqueueRender` persists the actual input `sceneSnapshot` before queueing asynchronous work; workflow render outputs retain matching branch provenance. `server/publication.mjs` requires that match and derives the selected candidate's assets, generation ancestry and credits from it, not the current sibling episode scenes. Current episode/workflow/channel/version guards remain mandatory.
- `server/youtube-oauth.mjs`, `server/private-runtime.mjs` and `server/publication.mjs`: channel-bound PKCE/one-use-state OAuth, encrypted per-intent recovery identities and separate exact-manifest final approval. Final private upload/readback precedes a same-video public transition and second readback. Last-moment input changes block effects; stale approvals allow only known-identity observation, never duplicate upload or changed-project completion. Concurrent one-use state claims use exclusive ownership and fail closed on uncertainty.
## External Dependencies
- FFmpeg and ffprobe provide local encoding and probing.
- Google Trends supplies a network RSS observation source.
- Agent CLIs run only through the configured host bridge.
- Higgsfield CLI supplies live model schemas and the historically exercised paid-generation transport. Developer REST uses server-only credentials when configured; vendor MCP owns a separate OAuth session. The white-studio change exercised provider catalog/quote/recovery/apply fixtures, not a live provider.
- Docker and Tailscale are deployment dependencies, not proof of application readiness.
## Evidence boundaries
- Local channel records are not OAuth channel ownership verification.
- A local render does not upload or publish a video.
- Generated source graphs are structural; they do not establish semantic truth.
- Workflow review nodes do not perform human visual review or channel publication.

## Runtime evidence

**Scene layout editor (2026-10-21):** 24 browser checks on isolated loopback with real Playwright/Chromium, one expected pre-login 401, zero unexpected errors/external/provider calls. Slot types: image-gen, text-overlay, video-bg, subtitle-layer with editable geometry/copy/styling/z-order. Presets: premiere (four-slot), top-image, clear. Local image attachment without provider execution. Save/reload persistence across all slot edits. `artifacts/scene-layout-browser-smoke.json` with before-save/after-reload screenshots. Container render and restart verified at `artifacts/layout-container-smoke.json`. Docker includes chromium with `PLATFORM_CHROMIUM_PATH` environment variable. Focused layout 3/3 pass. This evidence is isolated browser-fixture testing, not paid…

Latest macOS white-studio/workspace QA: 16 scoped regression tests, Linux Docker `npm test` 213/213 with 0 failures and 0 skipped, `npm run check` 55 modules, actual host FFmpeg 1080x1920 H.264/AAC output, 101 authenticated white-studio browser checks and 157 authenticated workspace checks on loopback port 4329, with zero page errors. Provider catalog/quote/recovery/apply responses are fixtures; `artifacts/white-studio-research.json` links the design and official Higgsfield evidence. See [verification](../../docs/verification.md) for exact evidence boundaries. No paid generation or public deployment occurred in this change; bundle 1.4.0 remains unchanged.

`artifacts/white-studio-verification.json` records final image `sha256:d4424d7f59c495f97d72ea2e85fb643fe64e9f35b69ff374da90617ca9ce6023` built, 15/15 inspected source SHA-256 values matching checkout and authenticated Docker browser QA on loopback port 4329. `artifacts/white-studio-container-smoke.json` records final-image render/authenticated download, exact-output saved-edit review and restart persistence. These receipts do not establish public production deployment, live paid Higgsfield generation, Developer REST authentication or owner acceptance; historical Windows/Tailscale and CI evidence remains separate.

The following receipts are historical Windows/Tailscale or earlier-source observations, not latest-source production cutover evidence.

The 2026-10-18 full workflow receipt in `artifacts/workflow-smoke.json` records completed trend, research, script, storyboard and render nodes, followed by review awaiting human inspection. The script node used the real Codex bridge; separate `artifacts/agent-jeo.json` and `artifacts/agent-jeopi.json` receipts record validated real responses from those adapters. This proves the exercised path, not all possible graph configurations or external publishing.

`artifacts/production-smoke.json` additionally verifies native Korean speech, audible final MP4, saved-edit preservation and a persisted exact-output review. This test review proves decision storage/binding, not owner approval or creative quality. Windows SAPI remains host-specific. Linux Docker now reaches it through the authenticated host bridge; `artifacts/docker-production-smoke.json` proves that exercised path. Availability must still be checked.

Container migration uses `scripts/snapshot-data.mjs` and `scripts/import-snapshot.mjs` to preserve consistent SQLite state, referenced media, IDs, versions, history and review hashes in a new data volume. Neither utility constructs Store or resets live data. `artifacts/docker-migration.json` records the real migration; `artifacts/local-container-smoke.json` records restart persistence.

`artifacts/higgsfield-live-smoke.json` records the historical paid-generation path: project MCP -> authenticated API -> Docker/host CLI produced a real 1080x1920 video, verified its local hash, applied it as a new episode version and completed a Docker render. This did not verify Developer REST authentication, vendor MCP OAuth or channel publication. `artifacts/usability-browser-smoke.json` had a different scope: 23 local browser checks, with direct-API catalog and recovery interactions explicitly using HTTP fixtures.

## FRAME workspace boundary (2026-10-20)
The existing application/workflow modules still own actions, version-bound saves and generation consent. Presentation adds real-record platform grouping, one task navigation, a scene bin synchronized by scene identity with the monitor/inspector/timeline, cumulative scene timing, and links that disclose/focus existing workflow histories. No arbitrary stage types, skip toggles, independent tracks, provider transport or publication API was added. Shared tokens remain in public/styles.css, workflow presentation in public/workflow.css and shell breakpoints in public/workspace.css.

The latest image was deployed from source-hash-bound working-tree content, not a newly published commit. artifacts/premiere-workspace-deployment.json records 57 matching runtime files and unchanged SQLite integrity/IDs/versions/table counts/22 media hashes, plus authenticated Windows-host browser checks over the existing private Tailscale HTTPS proxy. The browser/render gates are distinct from research, snippet review, unvalidated Jev proposals and public publication. See the workspace-ui-verification pattern and docs/premiere-workspace.md for the 65-module, 283-test, 72-new/105-regression-browser evidence and exact limitations.
