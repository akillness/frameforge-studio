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
last_updated: 2026-10-18
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
- public/: browser editor assets.
- server/workflows.mjs: typed production DAG, workflow/version snapshots and per-node execution records; render candidates reach an awaiting-review checkpoint and explicit decisions persist against the exact version/job/output hash.
- public/history.js and public/app.js: stable scene/node/edge comparisons, history selection, draft undo/redo and dirty-state guards. Restore validates an owned historical snapshot and appends a new current version rather than rewriting history.
- server/generations.mjs and Store.completeGeneration/applyGeneration: persistent idempotent generation intent, status polling, bounded media import with probe/hash/provenance, and separate atomic episode apply. Stale apply keeps the paid output available for deliberate reconciliation.
- Store.knowledge/exportKnowledge: runtime generation-job and imported-asset relationships to episodes, refreshed after import/apply with applied-version OKF atoms and signed URL query strings omitted.
- server/higgsfield.mjs, server/higgsfield-cli.mjs and the authenticated host bridge: distinct Developer REST and official CLI adapters. scripts/higgsfield-mcp.mjs exposes the same authenticated project API over stdio; it is separate from Higgsfield's OAuth-protected official remote MCP.
- server/narration.mjs, scripts/agent-bridge.mjs and scripts/speech.ps1: queued Windows voice synthesis locally or through an authenticated container-to-host raw-WAV bridge; generated audio attaches through the Store only if the original episode version still matches. Partial/stale output is cleaned.
## External Dependencies
- FFmpeg and ffprobe provide local encoding and probing.
- Google Trends supplies a network RSS observation source.
- Agent CLIs run only through the configured host bridge.
- Higgsfield CLI supplies live model schemas and the exercised paid-generation transport. Developer REST uses server-only credentials when configured; the vendor MCP owns its separate OAuth session.
- Docker and Tailscale are deployment dependencies, not proof of application readiness.
## What Does NOT Exist Here
- Local channel records are not OAuth channel ownership verification.
- A local render does not upload or publish a video.
- Generated source graphs are structural; they do not establish semantic truth.
- Workflow review nodes do not perform human visual review or channel publication.

## Runtime evidence
The 2026-10-18 full workflow receipt in `artifacts/workflow-smoke.json` records completed trend, research, script, storyboard and render nodes, followed by review awaiting human inspection. The script node used the real Codex bridge; separate `artifacts/agent-jeo.json` and `artifacts/agent-jeopi.json` receipts record validated real responses from those adapters. This proves the exercised path, not all possible graph configurations or external publishing.

`artifacts/production-smoke.json` additionally verifies native Korean speech, audible final MP4, saved-edit preservation and a persisted exact-output review. This test review proves decision storage/binding, not owner approval or creative quality. Windows SAPI remains host-specific. Linux Docker now reaches it through the authenticated host bridge; `artifacts/docker-production-smoke.json` proves that exercised path. Availability must still be checked.

Container migration uses `scripts/snapshot-data.mjs` and `scripts/import-snapshot.mjs` to preserve consistent SQLite state, referenced media, IDs, versions, history and review hashes in a new data volume. Neither utility constructs Store or resets live data. `artifacts/docker-migration.json` records the real migration; `artifacts/local-container-smoke.json` records restart persistence.

`artifacts/higgsfield-live-smoke.json` supersedes the earlier absence of paid generation: project MCP -> authenticated API -> Docker/host CLI produced a real 1080x1920 video, verified its local hash, applied it as a new episode version and completed a Docker render. This does not verify Developer REST authentication, vendor MCP OAuth or channel publication. `artifacts/usability-browser-smoke.json` has a different scope: 23 local browser checks, with direct-API catalog and recovery interactions explicitly using HTTP fixtures.
