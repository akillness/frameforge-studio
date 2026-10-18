---
type: Report
title: FrameForge runtime verification on 2026-10-18
description: The host service completed a live production DAG and real agent requests while local Windows Docker remained privilege-blocked and Linux Docker CI passed.
tags: [verification, runtime, workflow]
timestamp: 2026-10-18T02:55:58.518066+00:00
---

# Runtime verification

The [full workflow receipt](../../../artifacts/workflow-smoke.json) records an actual Google RSS → references → Codex → storyboard update → FFmpeg execution. Trend, research, script, storyboard and render completed; review ended at `awaiting_review`. The generated output belongs to episode version 2. This is a local rendered candidate awaiting review, not a published video.

Separate real-response receipts for [Codex](../../../artifacts/agent-codex.json), [JEO](../../../artifacts/agent-jeo.json) and [JEOPI](../../../artifacts/agent-jeopi.json) each record HTTP 200 and three validated scenes. A configured CLI alone was not used as success evidence.

The [verification record](../../../docs/verification.md) documents actual Tailscale HTTPS browser access, browser workflow edits, API/media render checks and remaining limitations. The private [GitHub repository](https://github.com/akillness/frameforge-studio) has received main commit [`f384821`](https://github.com/akillness/frameforge-studio/commit/f384821e7c0d66719da52171721b00910c5b0d4e). [CI run 39091649080](https://github.com/akillness/frameforge-studio/actions/runs/39091649080) completed successfully on f384821. Both node-and-harness and docker-render-and-persistence passed, including image build/start, authenticated MP4 render/download and exact artifact/history/job persistence after a container restart.

The [browser smoke receipt](../../../artifacts/browser-smoke.json), observed at 2026-10-18T02:52:01Z, records authenticated Tailscale login with `secureCookie: true`, persisted scene edits, workflow-edge disconnect/reconnect, node drag/save, a 390px mobile viewport with 390px document width, an Aside command received, a web command submitted and zero page errors. Screenshots are [desktop studio](../../../docs/assets/studio-desktop.png), [desktop workflow](../../../docs/assets/workflow-desktop.png) and [mobile workflow](../../../docs/assets/workflow-mobile.png).

Docker Compose configuration validated, but Docker Desktop's WSL distribution enumeration timed out. Recovery of the stuck WSLService required Windows privileges unavailable to the agent. On this Windows host, image building, container startup and container-side rendering remain unverified. Separately, the Linux GitHub Actions run verified image building, startup, an actual 1080x1920 H.264/AAC render and restart persistence. The container-to-host agent bridge path was not tested by that CI job. The current URL serves a host Node process. `PUBLIC_ORIGIN` is passed through the deployment configuration and the local HTTPS origin is configured; the refreshed browser receipt verifies the secure session cookie.

Native Graphify artifacts are [graph.json](../../../.graphify/graph.json), [graph.html](../../../.graphify/graph.html), [GRAPH_REPORT.md](../../../.graphify/GRAPH_REPORT.md) and [verification.json](../../../.graphify/verification.json). MEX evidence is in [.mex/verification.json](../../../.mex/verification.json). There is no BUILD_RECEIPT.md artifact. Structural graphs and code checks do not certify semantic truth or content quality.

Related: [[wiki/concepts/production-history]], [[wiki/concepts/knowledge-layers]], [[wiki/reports/knowledge-bootstrap]].

The final [visual verdict](../../../artifacts/visual-verdict.json) records a score of 92 after contrast and workflow-wire routing corrections. This is a visual review result, separate from functional tests and container CI.

Graphify 0.8.39 can retain exact duplicate edge records across native updates. The project refresh now removes only whole-record-identical edges using stable sorted-key JSON before native HTML export; distinct metadata is preserved. Two sequential refreshes each produced 649 nodes and 1133 unique edge records with zero duplicates remaining. The [normalization validation](../../../.graphify/normalization-validation.json) records both runs and regression checks. This is structural normalization, with no semantic extraction claim.
