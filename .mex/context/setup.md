---
name: setup
description: Run and verify the local service without committing operational credentials.
triggers:
  - "setup"
edges:
  - target: context/architecture.md
    condition: when related context is needed
  - target: context/conventions.md
    condition: when related context is needed
grounds_to: []
last_updated: 2026-10-18
---

# Setup
## Prerequisites
Node >=22.13 and FFmpeg/ffprobe for media export. Docker Desktop is needed for container verification. Tailscale access requires the intended tailnet and a reachable local service.
## First-time Setup
Read .env.example. Supply deployment credentials through local environment configuration. Start the service with npm start. Start the optional host agent bridge with npm run bridge only after its configuration is available.
## Environment Variables
.env.example is the canonical inventory; do not copy live .env values into memory. Bridge credentials, service access secrets and external provider credentials stay out of Git.
## Common Commands
npm start; npm run bridge; npm run check; npm test; npm run test:render.
## Common Issues
Docker failure may originate in WSL rather than this app. No configured host bridge means external agents are unavailable. Naver source collection is manual and must not be advertised as an automatic real-time ranking feed.

## Observed deployment on 2026-10-18
The production service runs in a Linux Docker container on host loopback 4310, with the existing private Tailscale HTTPS Serve URL unchanged. Docker engine 29.5.2 is healthy. Earlier WSLService Stop Pending/privilege failures are historical. Do not delete distributions, factory-reset Docker or prune unrelated volumes to repair an application failure.

Compose passes `SPEECH_PROVIDER=host-bridge`; its container bridge route uses `HOST_AGENT_BRIDGE_URL`, separate from the Windows process's `AGENT_BRIDGE_URL`. The host bridge authenticates both agent and speech requests. Inspect `/api/speech/voices` for actual availability; a Windows voice is not installed inside Linux. Preserve loopback/private-network exposure and keep credentials in ignored local environment files.

`scripts/start-local.ps1` and `stop-local.ps1` select studio, bridge and/or aside-inbox services. Docker deployment needs the host bridge/inbox; it must not also start a Windows studio process on port 4310. PID ownership checks prevent stopping unrelated processes. Startup archives a stale recycled PID record only when the requested service port is free.

`scripts/snapshot-data.mjs` reads SQLite consistently without constructing Store; choose a new snapshot directory outside live data. Mount the completed snapshot read-only and run `scripts/import-snapshot.mjs` into an empty dedicated volume, setting UID/GID 1000 for the non-root container. It checks database/media hashes, identity/version/history metadata and media references. Keep original data and failed partial imports. Migration verified 4 original channels, 3 episodes and 10 media hashes; see `artifacts/docker-migration.json`.

`artifacts/local-container-smoke.json` verifies render, review and restart persistence. `artifacts/docker-production-smoke.json` verifies actual Korean speech across the container host bridge and an audible final MP4. `artifacts/docker-workflow-smoke.json` verifies real Codex script/storyboard/render through that bridge. Its run did not fetch RSS; earlier RSS evidence is separately scoped in `artifacts/workflow-smoke.json`.

Read `docs/verification.md` and the latest `artifacts/` receipts for browser, live URL and CI results. Previous CI39095384742 passed on c56cc4a; it does not automatically certify subsequent changes.

## Native narration and Jev availability
The Windows host has Microsoft Heami Desktop installed. Original Windows narration evidence remains in `artifacts/production-smoke.json`; container narration uses the same installed voice through the authenticated bridge and returns bounded raw WAV bytes without host filesystem paths. Provider failure is explicit and does not attach partial audio.

`artifacts/jev-status.json` retains the initial legacy-runtime unavailable audit as history. The pinned runtime d9af9e3 uses an isolated frameforge-codex profile, and `scripts/jev-review.mjs` invokes it without installing hooks or changing shared catalogs. Read the actual advisory receipts; proposal-only/unvalidated decisions never provide automatic execution authority. Private configuration stays outside the repository and memory.

Live HTTPS verification: `artifacts/docker-live-production-browser-smoke.json` verifies the production Tailscale HTTPS URL: Secure cookie, actual audio/video playback, persisted exact-hash changes_requested review, zero page errors and no 1440/390px overflow. `artifacts/live-container-smoke.json` verifies production restart persistence. Original IDs/versions and 10 media hashes were rechecked after that restart in `artifacts/docker-migration.json`. The guarded launcher rejects missing or empty production databases before application startup; it does not silently seed a new production workspace.
