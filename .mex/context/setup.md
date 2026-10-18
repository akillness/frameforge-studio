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
The host Node service is reachable through private Tailscale HTTPS Serve. The service was accessed in Aside and the node workflow edited there. The host bridge returned real validated scenes from Codex, JEO and JEOPI; those observations do not guarantee future authentication availability.

Docker Compose configuration validation passed, but Docker Desktop could not enumerate WSL distributions. WSLService remained Stop Pending; targeted process/service recovery was denied by Windows privileges. No local Windows container image build or container-side render is verified. The separate Linux GitHub Actions run39091649080 passed build/start, real MP4 rendering and restart persistence; it does not verify container-to-host agent bridge connectivity. Preserve existing host data when a future Docker deployment is prepared.

Read `docs/verification.md` and the `artifacts/` receipts for current limits. Public documentation does not contain the live access token or bridge credential. Git remote creation and a successful push are separate evidence states.

The earlier browser smoke receipt records secureCookie=true after PUBLIC_ORIGIN pass-through and local HTTPS origin configuration. The private GitHub main commit f384821 was pushed; CI run39091649080 completed successfully for that source. The new narration/review/media-security source c56cc4a3e706b978a1f091a3079fb289a59fcb36 passed CI run39095384742: 58 tests, 33-file syntax checks, harness verification and Linux non-root/read-only container render/review/restart persistence. See `artifacts/container-smoke.json`. The running Windows Node service and the isolated Linux CI container remain separate deployment environments; local WSL and container-to-host agent bridge limitations remain.

## Native narration and Jev availability
The Windows host has Microsoft Heami Desktop installed. `artifacts/production-smoke.json` verifies actual local Korean speech and audible MP4 rendering without a downloaded voice or hosted TTS provider. Queue tests inject fixture voices/WAVs; they are separate from that native smoke test. Linux containers report this Windows provider unavailable.

Read `artifacts/jev-status.json` before invoking Jev. The initial legacy-runtime unavailable audit is retained there as history. The current pinned runtime d9af9e3 uses an isolated frameforge-codex profile, and `scripts/jev-review.mjs` invokes it without installing hooks or changing shared catalogs. `artifacts/jev-live-review.json` records the real API model jev-1.13.0, latency 528 ms, provider error null and verdict proposal_only. Threshold failures and the unvalidated tier provide no automatic authority. Private configuration stays outside the repository; do not print or copy it into memory.
