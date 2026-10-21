---
type: Report
title: FRAME Premiere-inspired editing workspace and private HTTPS rollout
description: Implemented sage workspace, real-browser and Docker results, preserved production data, and exact publication limits.
timestamp: 2026-10-20T17:11:06.602703+00:00
---

# FRAME Premiere-inspired editing workspace

## Research and design decisions

[[wiki/sources/premiere-workspace-2026-10-20]] records delegated Aside public-browser research: 12 reported inspected Adobe pages and 14 references. The source synthesis is research evidence, not proof of the implementation. The user's sage/white blueprint supplies visual direction; Adobe supplies task-oriented panel and monitor/timeline hierarchy. No publication, skip-toggle, arbitrary stage, scheduling, waveform or independent multitrack capability was fabricated to imitate the mock.

The implemented application has a platform/channel hierarchy derived from real records, one top task navigation, an actual scene project bin, a sequence preview/program monitor, the existing scene inspector and duration-derived timeline labels. The bin, timeline, preview and inspector share stable scene identities. Native scene/task navigation preserves keyboard focus, and workflow section links open and focus the actual history disclosures. Existing version guards, immutable history, admin controls and generation consent remain intact. Details and repeatable commands are in the [design and operations note](../../../docs/premiere-workspace.md).

## Observed verification

The [browser receipt](../../../artifacts/premiere-workspace-browser.json) records 72 new browser checks and 105 existing operational regression checks, zero page errors, actual scene selection and keyboard focus, an explicit version-bound fixture save, dialog focus restoration, mobile channel switching, contrast measurements and no document overflow for all eight views at 1600/1440/1024/768/375/320px. These tests used disposable fixtures and made no external/provider calls. Published screenshots contain only those fixtures.

The candidate Linux image passed syntax for 65 modules, all 283 tests with no failures/skips, and a real 1080×1920 H.264/AAC two-second render. The [deployment receipt](../../../artifacts/premiere-workspace-deployment.json) binds 57 runtime source hashes to the recreated healthy production container and records SQLite integrity `ok`, unchanged entity IDs, episode/workflow versions, table counts and 22 media hashes. The original named production volume, a consistent private pre-update snapshot and the prior image were retained.

A Windows-host browser loaded the new UI through the existing private Tailscale HTTPS origin. Unauthenticated state access returned 401; authenticated library, knowledge, workflow and episode histories were readable; the cookie was Secure, HttpOnly and SameSite=Strict. Read-only live browser navigation made no persistent API mutations. This is not an independent remote-device test. Tailscale Serve already forwarded loopback 4310 and required no configuration reset or client upgrade. Bridge/inbox processes were already running, not restarted. No paid media generation or public publication occurred.

## Review and sharing boundaries

A separate Aside subagent reviewed current-source snippets, not the entire repository or browser execution. Its actionable finding about task-navigation focus was fixed and tested. Its mobile-label concern was checked against the full CSS, where the label is hidden, and against actual mobile switching/reflow results.

Native Codex inventory showed one enabled `ecc@ecc` 2.2.3 entry; hook trust was not established and no ECC installer or hook mutation ran. The parent's disabled Jev profile was not bypassed. The research subagent's own manual API review returned `proposal_only`, unvalidated tier and insufficient evidence confidence; it is not approval of the final source. See the [research/tooling receipt](../../../artifacts/premiere-workspace-research.json).

Application changes and canonical notes are in the working tree. The deployment is bound by file hashes, not a new Git commit. Git publication has not been performed; a new commit still requires separate authorization before the requested push. Existing unrelated wiki/agent changes were preserved.

Related: [[wiki/entities/frameforge-studio]], [[wiki/concepts/production-history]], [[wiki/concepts/knowledge-layers]].

## Knowledge maintenance limits

The MEX source/context check passed, and Graphify was refreshed with tested exclusion of checkout-local agent state and generated vault metadata. Full-vault wiki validation is not green: existing automated captures use raw wiki links that the generic linter does not resolve, generated metadata is flagged as orphaned, and the project validator reports existing auto-capture/schema issues. These failures were retained rather than hidden or fixed by rewriting unrelated captures. The [knowledge receipt](../../../artifacts/premiere-workspace-knowledge.json) distinguishes current-source graph checks, the new pages' citations and the failing full-vault checks.
