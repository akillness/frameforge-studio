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
- server/narration.mjs, scripts/agent-bridge.mjs and scripts/speech.ps1: queued Windows voice synthesis locally or through an authenticated container-to-host raw-WAV bridge; generated audio attaches through the Store only if the original episode version still matches. Partial/stale output is cleaned.
## External Dependencies
- FFmpeg and ffprobe provide local encoding and probing.
- Google Trends supplies a network RSS observation source.
- Agent CLIs run only through the configured host bridge.
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
