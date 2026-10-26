# Harness promotion and rollback

The editable role contracts live in `.claude/` and their workflow documentation in `docs/`. A release snapshots that exact file inventory into `harness/versions/<version>/`. Production agents resolve `harness/manifest.json` first and consume its referenced bundle; editable authoring files may contain changes for the next version.

`1.0.0` is the initial linear supervisor production contract. `1.1.0` adds the executable node-graph contract and workflow/version handoffs. `1.2.0` adds native Windows narration handoffs, the `existing` saved-edit preservation mode and exact-version/job/hash review decisions. `1.3.0` adds authenticated Linux-container-to-Windows speech transport and verified snapshot/import migration with restart checks. `1.4.0` adds version comparison/restoration, per-node editing and idempotent Higgsfield generation/recovery contracts. `1.5.0` records the earlier ten-type, 1–10-node graph, selected-stage/resume guards and approved-review-gated publish staging. Those immutable bytes retain their historical meaning; they do not describe the new repeated-node engine. The actual pointer and bundle manifests are authoritative; there are no fabricated releases predating 1.0.0. Existing external shorts harness repositories are historical references only; their credentials, account receipts and media are not imported.

Historical version `1.6.0` records PW-01–PW-07: 128-node/256-edge repeated-role DAGs, exact-node selection and nearest connected prerequisites, per-node reviews and generation recovery, independent project workflow copies, cleared local source media/credits, the former A/B workspace and separate owner-approved API publication with same-video readback. Preserve that bundle and its [source-bound acceptance receipt](../artifacts/production-workspace-implementation/verification.json) unchanged as historical evidence.

The next authoring target is `1.7.0`: one default project node workbench with native tool overlays, shared accessible context menus/tooltips, exact-target draft node/edge removal, recoverable versioned archive, active save ownership/hidden drafts, stable scene mapping and stale async/queued-focus protection. Explicit news queries override derived context; failed/empty requested RSS never becomes sample/cached success. Source-only collection and subsequent authorized source-backed SAPI/render work remain distinct from paid generation and final publication. Main's forthcoming [sanitized verification receipt](../artifacts/node-native-workbench/verification.json) binds stable sources to actual commands/results and remaining prerequisites. The manifest selects the release; authoring changes alone do not select 1.7.0 or prove Docker deployment.

```sh
node scripts/version-harness.mjs verify
# Main only, after all final gates below pass:
node scripts/version-harness.mjs promote 1.7.0
node scripts/version-harness.mjs verify
# Explicitly select a previously created, checksum-valid bundle:
node scripts/version-harness.mjs rollback 1.0.0
node --test tests/harness.test.mjs
```

Promotion rejects an already active or previously created version, so use a new version number for the next release. Earlier version directories and archives remain checksum-valid and readable. Their files are not edited to adopt newer contracts.

## Stable-source promotion gates

Main owns promotion and all writes to `harness/manifest.json`, `harness/versions/` and `harness/archive/`. Documentation alignment edits only the allowlisted existing authoring contracts/workspace guide; it never promotes or edits immutable bundles. Production consumers continue resolving the selected bundle rather than silently treating authoring changes as released. Keep this pass working-tree-only; Git publication requires separate authority.

Before promotion, compare the exact stable source and independent tests against PW-01–PW-07 and the node-workbench contract. Retain repeated-role bounds, edge-derived order, nearest/missing/ambiguous prerequisites, exact-node partial/resume/paid-job reuse, branch review/render binding, project/template isolation, physical source/rights/hash/trim/credits, quote/disclosure and same-video publication recovery checks. Verify the sole default canvas and native overlays, one live inspector/unique IDs, exact scene/slot mapping, active scene-versus-graph save owner, hidden dirty stashes/original-base 409, no-write openings, exact-target removal/incident cleanup/undo/validated Save, accessible menus/tooltips and stale async/queued-focus races. Exercise archive/unarchive expectedVersion, retained history/media, active-work/preflight guards and blocked archived effects. Verify exact explicit news query precedence, empty/error failure and source-only execution boundaries. Record actual commands, counts, failures and unresolved prerequisites; a partial receipt is not full completion.

Current focused entrypoints are `node --test tests/node-workbench.test.mjs` and `node --test tests/project-archive.test.mjs tests/news-query.test.mjs`. Use the recorded browser executable/module environment where required. Earlier split-view smoke scripts remain historical release evidence, not the current workbench gate.

Use isolated temporary storage/ephemeral ports with explicit `loginToken:''` and `publicOrigin:''`; substitute only external transport. Existing independent tests remain authoritative. Contract/integrity tests and offline provider fixtures establish their bounded behavior, not current production health, live authentication, paid execution or owner acceptance. Source-backed current-news/SAPI/local-render evidence must be labeled separately. Live operations require their own authority and evidence; documentation alignment runs no project-wide suites, formatters/linters, deployment or Git operations.

After the required gates, Main promotes fresh unused 1.7.0 and verifies the new pointer/bundle. Integrity verification proves the selected bytes; preceding semantic checks prove engine/contract agreement. If gates fail or sources are still changing, leave the selected manifest unchanged and report the exact blocker. A checksum-valid historical 1.6.0 bundle cannot satisfy the new semantic gate. Bind any later Docker cutover separately to the actual served sources, preserved data and operational readback.

Each bundle has a `bundle.json` listing each source path, byte count and SHA-256. The current pointer includes the bundle manifest's SHA-256. `verify` rejects modified content, extra files, symbolic links and mismatched identities.

Promotion acquires a local exclusive lock, creates and validates a staging directory, publishes the immutable version directory, validates a snapshot of the previously active version under `harness/archive/`, then atomically replaces the current pointer with a same-directory rename. An existing version or archive is never overwritten. Old version directories remain readable so an in-flight reader holding the former pointer can finish safely.

A failure before the pointer rename leaves the active version unchanged. If an interruption leaves a newly published but inactive bundle, inspect and verify it; do not modify it in place. Use a new version for a corrected release or explicitly roll back/select an existing valid bundle. An abandoned `.promotion.lock` must be removed only after confirming that its PID is no longer performing a promotion. The script never silently breaks a lock.

Rollback changes the active pointer and archives the outgoing bundle. It preserves all version directories and does not overwrite the editable `.claude/` authoring files. Production consumers must follow the current pointer rather than assuming the working files are the selected release.

Commit the current manifest, new immutable bundle and any newly created archives together. Re-run verification before Git publication. Git history is an additional audit trail; a current pointer is not itself an external deployment receipt.
