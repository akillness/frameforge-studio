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
last_updated: 2026-10-20
---

# Workspace UI verification

## Context

Use current-source behavior, not a design mock, as the execution contract. Read [the FRAME workspace note](../../docs/premiere-workspace.md) and the relevant receipts. Preserve user changes, immutable history, expected-version guards and private production media.

## Steps

1. Capture a failing observable browser case before changing presentation. Use disposable API fixtures, an ephemeral loopback port, and blocked external/provider calls; never point a fixture test at production.
2. Reuse existing IDs/actions and semantic CSS tokens. Keep shared shell breakpoints in `public/workspace.css`. New visual stage types, tracks or publication controls require real backend behavior, not placeholder buttons.
3. Run `npm run check`, `npm test`, `npm run test:render`, `node scripts/premiere-workspace-browser-smoke.mjs` and `node scripts/ops-workspace-browser-smoke.mjs` after the final source edit. Retain warnings and failure evidence.
4. Check keyboard focus after any DOM replacement, native disclosure/dialog behavior, source escaping, actual save versions, all eight views at narrow widths, and custom workspace/overlay compatibility. Publish only fixture screenshots.
5. For rollout, finish active jobs, retain the current image, take a fresh consistent owner-readable snapshot and test a candidate without the production volume. Use `scripts/start-docker.ps1`, then compare runtime hashes, IDs/versions/table counts/media hashes and authenticated private HTTPS UI. Keep bridge/provider, local render and publication evidence separate.

## Gotchas

- Mobile shell rules can override desktop sticky-sidebar rules. A full-viewport sticky sidebar in the mobile block layout intercepts the task bar; test real clicks, not only document overflow.
- A collapsed native platform disclosure must be opened before selecting its channel. Keep mobile channel access available even when the desktop rail collapses.
- This environment's line-edit tool accepts one anchored block per call. Multiple block markers in one payload become literal file contents; syntax checking exposed this failure. Use separate edits and scan for accidental markers.
- Native Windows tools need explicit supported runtimes from WSL; default WSL Node 12 is not the project's Node 22 runtime. Keep shell interpolation out of embedded JavaScript helpers.
- Reusing the private Tailscale Serve proxy is not a client upgrade or an independent remote-device test. Do not enable Funnel or reset unrelated routing.

## Verify

Read the latest browser and deployment JSON artifacts. A research synthesis, plugin inventory, structural graph or Jev `proposal_only` verdict does not replace executed tests or grant authority. Commit, push and pull require their own authorization; do not include pre-existing user work in an incidental release commit.

## Debug

Preserve the failing receipt and screenshot, inspect computed geometry and selector visibility, fix the owning breakpoint/action, then rerun the same gate without weakening assertions. Keep incomplete snapshots and failed candidate containers for diagnosis until their cause is understood.

## Update Scaffold

Update the router, relevant context, wiki source/report and index/log with actual observed results. Refresh MEX/Graphify, lint wiki structure, and bump changed scaffold dates. Canonical notes remain working-tree artifacts until separately committed and pushed.
