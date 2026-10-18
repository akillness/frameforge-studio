# Harness promotion and rollback

The editable role contracts live in `.claude/` and their workflow documentation in `docs/`. A release snapshots that exact file inventory into `harness/versions/<version>/`. Production agents resolve `harness/manifest.json` first and consume its referenced bundle; editable authoring files may contain changes for the next version.

`1.0.0` is the first actual project harness version. There are no fabricated previous releases. Existing external shorts harness repositories are historical references only; their credentials, account receipts and media are not imported.

```sh
node scripts/version-harness.mjs promote 1.0.0
node scripts/version-harness.mjs verify
# After real role or workflow changes and review:
node scripts/version-harness.mjs promote 1.1.0
# Explicitly select a previously created, checksum-valid bundle:
node scripts/version-harness.mjs rollback 1.0.0
node --test tests/harness.test.mjs
```

The later-version commands above illustrate a future workflow; they do not assert that those releases exist.

Each bundle has a `bundle.json` listing each source path, byte count and SHA-256. The current pointer includes the bundle manifest's SHA-256. `verify` rejects modified content, extra files, symbolic links and mismatched identities.

Promotion acquires a local exclusive lock, creates and validates a staging directory, publishes the immutable version directory, validates a snapshot of the previously active version under `harness/archive/`, then atomically replaces the current pointer with a same-directory rename. An existing version or archive is never overwritten. Old version directories remain readable so an in-flight reader holding the former pointer can finish safely.

A failure before the pointer rename leaves the active version unchanged. If an interruption leaves a newly published but inactive bundle, inspect and verify it; do not modify it in place. Use a new version for a corrected release or explicitly roll back/select an existing valid bundle. An abandoned `.promotion.lock` must be removed only after confirming that its PID is no longer performing a promotion. The script never silently breaks a lock.

Rollback changes the active pointer and archives the outgoing bundle. It preserves all version directories and does not overwrite the editable `.claude/` authoring files. Production consumers must follow the current pointer rather than assuming the working files are the selected release.

Commit the current manifest, new immutable bundle and any newly created archives together. Re-run verification before Git publication. Git history is an additional audit trail; a current pointer is not itself an external deployment receipt.
