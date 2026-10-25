# Harness promotion and rollback

The editable role contracts live in `.claude/` and their workflow documentation in `docs/`. A release snapshots that exact file inventory into `harness/versions/<version>/`. Production agents resolve `harness/manifest.json` first and consume its referenced bundle; editable authoring files may contain changes for the next version.

`1.0.0` is the initial linear supervisor production contract. `1.1.0` adds the executable node-graph contract and workflow/version handoffs. `1.2.0` adds native Windows narration handoffs, the `existing` saved-edit preservation mode and exact-version/job/hash review decisions. `1.3.0` adds authenticated Linux-container-to-Windows speech transport and verified snapshot/import migration with restart checks. `1.4.0` adds version comparison/restoration, per-node editing and idempotent Higgsfield generation/recovery contracts. `1.5.0` records the earlier ten-type, 1–10-node graph, selected-stage/resume guards and approved-review-gated publish staging. Those immutable bytes retain their historical meaning; they do not describe the new repeated-node engine. The actual pointer and bundle manifests are authoritative; there are no fabricated releases predating 1.0.0. Existing external shorts harness repositories are historical references only; their credentials, account receipts and media are not imported.

Version `1.6.0` synchronizes the authoring contract with PW-01–PW-07: 128-node/256-edge repeated-role DAGs, exact-node selection and nearest connected prerequisites, per-node reviews and generation recovery, independent project workflow copies, cleared local source media/credits, the shared A/B workspace and separate owner-approved API publication with same-video readback. The manifest, not authoring text, determines the selected release. The source-bound acceptance receipt is `artifacts/production-workspace-implementation/verification.json`; its exact commands distinguish local semantic/integrity checks from live provider, account, generation, publication and deployment evidence.

```sh
node scripts/version-harness.mjs verify
# Main only, after all final gates below pass (not performed by NativeHarness):
node scripts/version-harness.mjs promote 1.6.0
node scripts/version-harness.mjs verify
# Explicitly select a previously created, checksum-valid bundle:
node scripts/version-harness.mjs rollback 1.0.0
node --test tests/harness.test.mjs
```

Promotion rejects an already active or previously created version, so use a new version number for the next release. Earlier version directories and archives remain checksum-valid and readable. Their files are not edited to adopt newer contracts.

## PW-02 promotion gates

Main owns promotion and all writes to `harness/manifest.json`, `harness/versions/` and `harness/archive/`. NativeHarness edits only the allowlisted existing authoring contracts/workspace guide and its shared status JSON; it never promotes or edits immutable bundles. Production consumers continue resolving the selected bundle rather than silently treating authoring changes as released.

Before promotion, compare the exact stable source and independent tests against every PW-01–PW-07 acceptance criterion. Confirm repeated IDs/roles and exact numeric bounds, edge-derived order, nearest same-role boundary/missing/ambiguous prerequisites, node-ID partial/resume and paid-job reuse, branch review/render binding, project/channel/template isolation, physical source/rights/hash/trim/credit rendering, quote/disclosure conflicts, OAuth/manifest/private-to-public recovery without duplicate insert, and the complete A/B production journey including hidden dirty drafts and original-base 409 behavior. Source-only editing must cause no paid calls; navigation must cause no writes. Record exact commands, counts, failures and unresolved prerequisites; a partial test receipt is not full completion.

Use isolated temporary storage/ephemeral ports with explicit `loginToken:''` and `publicOrigin:''`; substitute only external transport. Existing independent tests remain authoritative. Contract/integrity tests and offline provider fixtures establish their bounded behavior, not current production health, live authentication, paid execution or owner acceptance. Live operations require their own authority and evidence. The current assignment excludes production smoke scripts, project-wide suites, linters/formatters and Git operations.

After the required gates, Main promotes a fresh unused version and verifies the new pointer/bundle. Integrity verification proves the selected bytes, while the preceding semantic checks prove engine/contract agreement. If gates fail or sources are still changing, leave 1.5.0 selected and report the exact blocker. A successful old-bundle check cannot satisfy the new-bundle PW-02 requirement.

Each bundle has a `bundle.json` listing each source path, byte count and SHA-256. The current pointer includes the bundle manifest's SHA-256. `verify` rejects modified content, extra files, symbolic links and mismatched identities.

Promotion acquires a local exclusive lock, creates and validates a staging directory, publishes the immutable version directory, validates a snapshot of the previously active version under `harness/archive/`, then atomically replaces the current pointer with a same-directory rename. An existing version or archive is never overwritten. Old version directories remain readable so an in-flight reader holding the former pointer can finish safely.

A failure before the pointer rename leaves the active version unchanged. If an interruption leaves a newly published but inactive bundle, inspect and verify it; do not modify it in place. Use a new version for a corrected release or explicitly roll back/select an existing valid bundle. An abandoned `.promotion.lock` must be removed only after confirming that its PID is no longer performing a promotion. The script never silently breaks a lock.

Rollback changes the active pointer and archives the outgoing bundle. It preserves all version directories and does not overwrite the editable `.claude/` authoring files. Production consumers must follow the current pointer rather than assuming the working files are the selected release.

Commit the current manifest, new immutable bundle and any newly created archives together. Re-run verification before Git publication. Git history is an additional audit trail; a current pointer is not itself an external deployment receipt.
