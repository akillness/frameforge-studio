---
name: workspace-ui-verification
description: Verify the sole node workbench, native overlays and guarded project lifecycle with isolated fixtures; bind any later Docker/private HTTPS rollout separately.
triggers:
  - "workspace UI"
  - "editor navigation"
  - "Premiere"
edges:
  - target: ../context/conventions.md
    condition: when checking version, permission and evidence boundaries
grounds_to: []
last_updated: 2026-10-26
---

# Workspace UI verification

## Context

Use current-source behavior, not a design mock, as the execution contract. Read [the FRAME workspace note](../../docs/premiere-workspace.md) and the relevant receipts. Preserve user changes, immutable history, expected-version guards and private production media.

## Steps

1. Capture a failing observable browser case before changing presentation. Use disposable API fixtures, an ephemeral loopback port, and blocked external/provider calls; never point a fixture test at production.
2. Reuse existing IDs/actions and semantic CSS tokens. Keep shared shell breakpoints in `public/workspace.css`. New visual stage types, tracks or publication controls require real backend behavior, not placeholder buttons.
3. Run syntax and the tests changed by the scoped work, then the matching isolated browser runner. Resolve the current source/image identity and exact eight-file affected-suite command from [the canonical native-workbench receipt](../../artifacts/node-native-workbench/verification.json): the recorded focused24/24 and complete unfiltered98/98 checks have zero failures/skips. Its three consecutive strict large-graph journeys retain original5000-ms action/capture deadlines, with twelve actual PNG hashes/headers verified. Keep earlier failed samples and unavailable review attempts distinct from passed gates. The [knowledge receipt](../../artifacts/node-native-workbench/knowledge-refresh.json) covers structural/admission and legacy wiki validation, not browser/media/deployment proof; [the dated correction](../../docs/verification.md#context-governance-correction--2026-10-26) preserves the old missing-receipt boundary. Run broader suites or deployment smoke only when separately in scope.
4. Check the sole canvas and every native overlay at narrow widths: keyboard focus after DOM replacement, one live inspector/no duplicate IDs, native disclosure/dialog behavior, source escaping and original save versions. Confirm Ctrl/Command+S targets the active scene or graph editor, hidden drafts survive switching, and custom workspace layout remains compatible. Publish only fixture screenshots.
5. For rollout, finish active jobs, retain the current image, take a fresh consistent owner-readable snapshot and test a candidate without the production volume. Use `scripts/start-docker.ps1`, then compare runtime hashes, IDs/versions/table counts/media hashes and authenticated private HTTPS UI. Keep bridge/provider, local render and publication evidence separate.

## Gotchas

- Mobile shell rules can override desktop sticky-sidebar rules. A full-viewport sticky sidebar in the mobile block layout intercepts the task bar; test real clicks, not only document overflow.
- A collapsed native platform disclosure must be opened before selecting its channel. Keep mobile channel access available even when the desktop rail collapses.
- Line-edit syntax is runtime-specific. Use the active tool schema and fresh snapshot anchors; historical marker corruption does not establish the current tool's supported operations.
- Native Windows tools need explicit supported runtimes from WSL; default WSL Node 12 is not the project's Node 22 runtime. Keep shell interpolation out of embedded JavaScript helpers.
- Reusing the private Tailscale Serve proxy is not a client upgrade or an independent remote-device test. Do not enable Funnel or reset unrelated routing.
- Canvas/overlay navigation preserves full hidden episode and workflow drafts, original base versions and unload protection without writes. Exercise stale-save 409s against inactive drafts, explicit active-editor Save and exact-target node/edge removal with incident cleanup/undo; restoring focus must not reopen an overlay or scroll the closed canvas unexpectedly.
- Repeated-role branches require end-to-end provenance, not just matching job/version/hash fields: persist the actual render input snapshot before queueing; derive review/publication assets, generation ancestry and credits from that exact connected snapshot. A sibling missing generation target must not block an unrelated completed source-only branch.
- Consent invalidation must remove the displayed quote/fingerprint/costs and reset its acknowledgement, not merely disable the submit button. Validate disclosure rationale and multiple node/scene/slot inputs with separate stable jobs.
- Final publication fixtures must cover private upload/readback, same-video public update/readback, stale approval observation-only recovery, encrypted recovery identities and concurrent one-use OAuth claims. These tests never authorize real consent, generation or publication.
- A native worker's Docker/WSL access denial is not proof that the parent session lacks that already-running runtime. Check parent availability read-only before declaring a host prerequisite. For Linux filesystem coverage, use the existing pinned image, read-only current source mounts, no network/ports/production volumes, a non-root user and disposable tmpfs. Linux symlink success does not establish Windows symlink support; retain the native Windows EPERM separately.
- Read-only Chromium fixtures need a writable disposable home/cache/config as well as a profile directory. Set container-only `HOME=/tmp`, `XDG_CONFIG_HOME=/tmp/chromium-config` and `XDG_CACHE_HOME=/tmp/chromium-cache`; preserve the original failed run and rerun the unchanged assertions without installing or downloading a browser.
- Use the repository's `python .graphify/refresh.py` for canonical graph refresh. It sets `GRAPHIFY_OUT=.graphify`, excludes checkout-local state, deduplicates exact whole edge records and verifies portable paths; a successful bare CLI update can write a different default output directory and does not establish canonical freshness.
- Windows Git archive export can apply `core.autocrlf` even when the committed blob is LF. For byte-exact Docker builds use per-command `git -c core.autocrlf=false -c core.eol=lf archive`; do not change global Git settings. Compare the built and running runtime files to the committed blobs, while preserving immutable bundle bytes and the originally captured Windows QA hashes separately.
- An artifact-free image needs its fixture evidence directory created explicitly. Use a disposable Linux-native output volume for heavy capture runs, retain failed TAP/PNG evidence, and do not mount production data. On pinned Playwright 1.58.2 with distro Chromium, `PLAYWRIGHT_LEGACY_SCREENSHOT=1` omits experimental `CDPScreenshotNewSurface`; the complete 290-test/11-journey gate passed with unchanged assertions, viewports, full-page capture and 5000 ms timeout. Raising shared memory alone passed a focused probe but still failed the complete gate. Treat the compatibility switch as a verified capture-environment setting, not a test exemption or proof of an application defect.
- Shared context menus/tooltips must support hover/focus, keyboard and touch, resolve the exact selected target and make no writes on open. Test queued-scroll/close-focus races, obsolete asynchronous tool responses and uploads returning after a project/scene change; stale work must not overwrite the new context.
- Archive is versioned hiding, not deletion: require only a positive safe-integer `expectedVersion` on explicit archive/unarchive POSTs. Verify history/media preservation, recoverability, all active-work/preflight barriers and archived-effect rejection while retaining read-only inspection. A disabled menu item alone does not enforce lifecycle safety.
- For news failures, inspect the actual encoded RSS query. The observed pollution was explicit query plus OR-appended trend/topic/title context; explicit query now wins and only absent queries derive context. Preserve genuine HTTP/empty-feed failures without fake fallback. Real source-to-narration/render evidence remains separate from fixture transport tests and review/approval.

## Verify

Read source-bound browser/runtime receipts and distinguish native UI, media preservation, creative revision and owner acceptance. A `changes_requested` recommendation requires inspection of the revised exact candidate; permission to read source data is not successful preservation or approval. An inactive tab/`Page.enable` timeout establishes connection unavailability, not logout. A later explicit read-only database/referenced-media isolated-clone approval must retain its credential/settings/production-write exclusions and receive actual snapshot/import/restart/hash evidence. Keep independent visual/audio findings, API review storage, owner acceptance, production deployment and publication as separate gates. Checkout selection1.7.2 is identity, not a tested-image/deployment assertion. Diagnostics, research, installed adapters and structural graphs cannot replace the canonical original-deadline journey/capture gate or grant execution authority.

## Debug

Preserve the failing receipt and screenshot, inspect computed geometry and selector visibility, fix the owning breakpoint/action, then rerun the same gate without weakening assertions. Keep incomplete snapshots and failed candidate containers for diagnosis until their cause is understood.

## Update Scaffold

Update only the existing router, relevant context and wiki knowledge with observed behavior and significant discoveries; bump changed scaffold dates. Read `mex logging --json` before optional event logging and honor its mode; `significant` excludes routine tool history. Run graph refresh and targeted wiki/OKF validators only when assigned, preserving private-state exclusions and historical diagnostics; pending or failed freshness is not a passing gate. Canonical notes remain working-tree artifacts until separately committed/pushed.
