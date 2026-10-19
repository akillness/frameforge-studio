---
type: Report
title: Operational workspace release and deployment boundary
description: Evidence for the 2026-10-19 operational workspace push, exact-source CI, and the blocked local Windows Docker service update.
timestamp: 2026-10-19T04:53:12.265Z
grounds_to:
  - public/workspace.js
  - artifacts/ops-workspace-ci-smoke.json
---

# Operational workspace release — 2026-10-19

## Scope

The operational overview change was pushed to `main` as `0af4b0698abcffb9f719401605fa2a6cdf1fa2ee`. It adds a real-API overview, queue presentation controls, browser-local saved views, API-derived deliverable references, history and status panels. No server/API, SQLite schema, credential, dependency or immutable harness changes were included. The isolated browser checks used a temporary loopback database and Korean fixtures, not production records.

## Verification

Local verification reported 61 modules passing `npm run check`, 254/254 tests passing, 94 isolated browser checks and a 94/100 visual pass. The 24 source/screenshot hashes in `artifacts/ops-workspace/verification.json` matched.

GitHub Actions run [39201562842](https://github.com/akillness/frameforge-studio/actions/runs/39201562842) completed successfully for the pushed commit. Both `node-and-harness` and `docker-render-and-persistence` jobs passed. The latter built and started the non-root/read-only Linux Compose service in an isolated CI volume, rendered and downloaded an authenticated 1080×1920 H.264/AAC MP4, then verified episode/history/job/output-hash persistence after restart. Its receipt is `artifacts/ops-workspace-ci-smoke.json`; it is CI test data, not production content.

## Deployment boundary

The Windows local update did not complete. `scripts/start-docker.ps1` could not access the required existing volume because Docker Desktop did not start. The observed state was Docker Desktop `stopped`, `com.docker.service` `Stopped`, `WslService` `Running`, no running WSL distro and no listener on 4310. The launcher refused to create a replacement volume. No volume, database, or production service data was modified; no service was deployed or restarted. Existing historical Tailscale/production receipts do not establish current availability.

Continue only after Docker Desktop is running in the user session, using the guarded existing-volume launcher. Do not apply WSL recovery or request elevated access without separate authorization.

## Review boundary

A fresh Jev diff review was not run: the required private profile/credential was unavailable in this session. Earlier Jev receipts relate to prior changes and are not substituted for this review.
