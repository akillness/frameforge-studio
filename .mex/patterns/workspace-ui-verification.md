---
name: workspace-ui-verification
description: Verify editor shell and workflow presentation with isolated fixtures before a guarded Docker and private HTTPS rollout.
triggers:
  - "workspace UI"
  - "editor navigation"
  - "Premiere"
edges:
  - target: ../context/conventions.md
    condition: when checking version, permission and evidence boundaries
grounds_to: []
last_updated: 2026-10-25
---

# Workspace UI verification

## Context

Use current-source behavior, not a design mock, as the execution contract. Read [the FRAME workspace note](../../docs/premiere-workspace.md) and the relevant receipts. Preserve user changes, immutable history, expected-version guards and private production media.

## Steps

1. Capture a failing observable browser case before changing presentation. Use disposable API fixtures, an ephemeral loopback port, and blocked external/provider calls; never point a fixture test at production.
2. Reuse existing IDs/actions and semantic CSS tokens. Keep shared shell breakpoints in `public/workspace.css`. New visual stage types, tracks or publication controls require real backend behavior, not placeholder buttons.
3. Run syntax and the tests changed by the scoped work, then the matching isolated browser runner. For PW-01–PW-07 use `node scripts/production-workspace-browser-smoke.mjs`; it exercises the actual app with temporary storage, ephemeral ports and fixture-only external transport. Retain exact commands, counts, warnings and failed attempts. Run broader suites or deployment smoke only when separately in scope.
4. Check keyboard focus after any DOM replacement, native disclosure/dialog behavior, source escaping, actual save versions, all eight views at narrow widths, and custom workspace/overlay compatibility. Publish only fixture screenshots.
5. For rollout, finish active jobs, retain the current image, take a fresh consistent owner-readable snapshot and test a candidate without the production volume. Use `scripts/start-docker.ps1`, then compare runtime hashes, IDs/versions/table counts/media hashes and authenticated private HTTPS UI. Keep bridge/provider, local render and publication evidence separate.

## Gotchas

- Mobile shell rules can override desktop sticky-sidebar rules. A full-viewport sticky sidebar in the mobile block layout intercepts the task bar; test real clicks, not only document overflow.
- A collapsed native platform disclosure must be opened before selecting its channel. Keep mobile channel access available even when the desktop rail collapses.
- Line-edit syntax is runtime-specific. Use the active tool schema and fresh snapshot anchors; historical marker corruption does not establish the current tool's supported operations.
- Native Windows tools need explicit supported runtimes from WSL; default WSL Node 12 is not the project's Node 22 runtime. Keep shell interpolation out of embedded JavaScript helpers.
- Reusing the private Tailscale Serve proxy is not a client upgrade or an independent remote-device test. Do not enable Funnel or reset unrelated routing.
- A/B navigation must preserve full hidden episode and workflow drafts, original base versions and unload protection without writes. Exercise stale-save 409s against an inactive draft as well as the visible editor.
- Repeated-role branches require end-to-end provenance, not just matching job/version/hash fields: persist the actual render input snapshot before queueing; derive review/publication assets, generation ancestry and credits from that exact connected snapshot. A sibling missing generation target must not block an unrelated completed source-only branch.
- Consent invalidation must remove the displayed quote/fingerprint/costs and reset its acknowledgement, not merely disable the submit button. Validate disclosure rationale and multiple node/scene/slot inputs with separate stable jobs.
- Final publication fixtures must cover private upload/readback, same-video public update/readback, stale approval observation-only recovery, encrypted recovery identities and concurrent one-use OAuth claims. These tests never authorize real consent, generation or publication.
- A native worker's Docker/WSL access denial is not proof that the parent session lacks that already-running runtime. Check parent availability read-only before declaring a host prerequisite. For Linux filesystem coverage, use the existing pinned image, read-only current source mounts, no network/ports/production volumes, a non-root user and disposable tmpfs. Linux symlink success does not establish Windows symlink support; retain the native Windows EPERM separately.
- Read-only Chromium fixtures need a writable disposable home/cache/config as well as a profile directory. Set container-only `HOME=/tmp`, `XDG_CONFIG_HOME=/tmp/chromium-config` and `XDG_CACHE_HOME=/tmp/chromium-cache`; preserve the original failed run and rerun the unchanged assertions without installing or downloading a browser.
- Use the repository's `python .graphify/refresh.py` for canonical graph refresh. It sets `GRAPHIFY_OUT=.graphify`, excludes checkout-local state, deduplicates exact whole edge records and verifies portable paths; a successful bare CLI update can write a different default output directory and does not establish canonical freshness.

## Verify

Read the latest browser and deployment JSON artifacts. A research synthesis, plugin inventory, structural graph or Jev `proposal_only` verdict does not replace executed tests or grant authority. Commit, push and pull require their own authorization; do not include pre-existing user work in an incidental release commit.

## Debug

Preserve the failing receipt and screenshot, inspect computed geometry and selector visibility, fix the owning breakpoint/action, then rerun the same gate without weakening assertions. Keep incomplete snapshots and failed candidate containers for diagnosis until their cause is understood.

## Update Scaffold

Update the router, relevant context, wiki source/report and index/log with actual observed results. Refresh MEX/Graphify, lint wiki structure, and bump changed scaffold dates. Canonical notes remain working-tree artifacts until separately committed and pushed.
