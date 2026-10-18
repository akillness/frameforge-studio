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

Docker Compose configuration validation passed, but Docker Desktop could not enumerate WSL distributions. WSLService remained Stop Pending; targeted process/service recovery was denied by Windows privileges. No container image build or container-side render is verified. Preserve existing host data when a future Docker deployment is prepared.

Read `docs/verification.md` and the `artifacts/` receipts for current limits. Public documentation does not contain the live access token or bridge credential. Git remote creation and a successful push are separate evidence states.
