---
type: Report
title: FrameForge runtime verification on 2026-10-18
description: Local Linux Docker now serves the existing private URL with preserved production data and authenticated Windows speech and agent bridges.
tags: [verification, runtime, workflow, docker, migration]
timestamp: 2026-10-18T08:01:06.897385+00:00
---

# Current Docker deployment

The Docker engine 29.5.2 is healthy. The production service runs in a non-root/read-only Linux container on host loopback 4310 behind the unchanged private Tailscale HTTPS URL. Windows retains the authenticated agent/SAPI bridge. Earlier WSLService Stop Pending and privilege failures were real historical blockers; they are superseded by the current container evidence.

The [migration receipt](../../../artifacts/docker-migration.json) verifies original entity IDs, episode/workflow versions and 10 media hashes: 4 channels, 3 episodes, 19 episode-history snapshots, 9 workflow-history snapshots and 3 reviews. Consistent SQLite snapshots and empty-volume imports preserve original data. Invalid paths, hashes, missing media and nonempty destinations fail explicitly; no destructive resets are used.

The [staged container narration receipt](../../../artifacts/docker-production-smoke.json) records Microsoft Heami Desktop through the authenticated host bridge, preserved edits, a 1080x1920 MP4 lasting 4.821333 seconds with mean volume -24.1 dB, and a persisted exact-hash test review. The Linux image itself has no SAPI installation. The [local container receipt](../../../artifacts/local-container-smoke.json) separately verifies authenticated render/download and exact review/history/job/export persistence after restart.

The [staged browser receipt](../../../artifacts/docker-production-browser-smoke.json) verifies actual narration/video playback, latest-job display, recovered controls, saved-scenes execution and persisted changes_requested review. It reports zero page errors and no overflow at 1440/390px. Its loopback HTTP cookie is not Secure; private HTTPS is a separate deployment check. The [live HTTPS browser receipt](../../../artifacts/docker-live-production-browser-smoke.json) independently verifies Secure cookie, audio/video playback, persistent exact-hash changes_requested review, zero page errors and no 1440/390px overflow. [Live restart evidence](../../../artifacts/live-container-smoke.json) verifies production persistence, and the migration receipt rechecks original identities/versions and all 10 hashes afterward. [Live narration](../../../artifacts/docker-live-production-smoke.json) confirms the same 4.821333-second, -24.1 dB audible output through the production URL. Preview caption scale can differ from the encoded MP4.

The [Docker workflow receipt](../../../artifacts/docker-workflow-smoke.json) proves actual Codex script -> storyboard -> render -> awaiting_review execution through the host bridge. This new run excludes trend/research nodes; it does not claim a new RSS fetch. Earlier full Google RSS -> references -> Codex -> storyboard -> FFmpeg evidence remains in [workflow-smoke.json](../../../artifacts/workflow-smoke.json). Separate earlier [JEO](../../../artifacts/agent-jeo.json) and [JEOPI](../../../artifacts/agent-jeopi.json) receipts prove their named calls, not perpetual availability.

Local checks passed 77 tests and syntax checks for 38 files. The current [harness pointer](../../../harness/manifest.json) selects 1.3.0, adding container speech transport and verified migration/restart contracts. 1.2.0 is archived; all prior immutable bytes remain checksum-valid.

# Historical evidence and limits

[CI39095384742](https://github.com/akillness/frameforge-studio/actions/runs/39095384742) succeeded for c56cc4a3e706b978a1f091a3079fb289a59fcb36 with 58 tests and earlier Linux Docker review/restart checks. That named source is historical; later source CI/publication requires a fresh receipt. Original [Windows narration](../../../artifacts/production-smoke.json) and [HTTPS browser](../../../artifacts/production-browser-smoke.json) results remain preserved separately.

Jev's initial unavailable audit is retained in [jev-status.json](../../../artifacts/jev-status.json); [live API review](../../../artifacts/jev-live-review.json) and [Docker work proposal](../../../artifacts/jev-docker-plan.json) record real advisory calls. The final [Docker review](../../../artifacts/jev-docker-review.json) returned a real jev-1.13.0 API response in 649 ms: proposal_only with an unvalidated tier and below-threshold confidence, not automatic approval. The isolated profile does not install global hooks or grant model decisions execution authority. Secrets are absent from these notes.

Automated review decisions are technical test evidence, not owner acceptance or publication. Channel OAuth/ownership verification, upload APIs, automatic Naver rankings and paid generative-video/TTS providers remain unconnected. The code knowledge graph, editable production DAG and runtime history are distinct layers: [[wiki/concepts/knowledge-layers]] and [[wiki/concepts/production-history]].

Final refresh: MEX 47 files, 1138 nodes/3526 edges, check100/100 with zero source changes; Graphify 1005 nodes/1961 whole-record-unique edges from 148 source files, zero duplicates and portable source paths. No semantic enrichment or provider calls were used. Completed evidence lives in [MEX verification](../../../.mex/verification.json) and [Graphify verification](../../../.graphify/verification.json). Structural extraction does not assert semantic truth. See [[wiki/entities/frameforge-studio]] and [verification details](../../../docs/verification.md).

**Docker release CI:** code commit `0f59211601cba11c7885ed2d28a76581cc695bad` passed [run 39110221470](https://github.com/akillness/frameforge-studio/actions/runs/39110221470): 77 regressions, immutable harness verification, Linux Docker build/render/exact-review/restart persistence. Receipts: `artifacts/docker-ci-run.json` and `artifacts/docker-ci-smoke.json`. Later documentation-only commits do not replace this tested source identity.

## Newer usability and generation evidence

The newer [[wiki/reports/usability-higgsfield-2026-10-18]] supersedes this report's earlier 77-test/harness-1.3.0/no-paid-generation state. The completed [Higgsfield receipt](../../../artifacts/higgsfield-live-smoke.json) proves real paid generation through the project MCP and official CLI transport, local hash-verified import, a new episode version and Docker rendering. Vendor MCP OAuth and Developer REST authentication remain unverified. Preserve the Docker/CI evidence above as historical, source-scoped receipts rather than applying it automatically to the newer revision.
