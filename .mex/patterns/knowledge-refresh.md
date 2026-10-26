---
name: knowledge-refresh
description: Retrieve reviewed authored knowledge; refresh admission, navigation or structural evidence without replaying private captures.
triggers:
  - "knowledge-refresh"
edges:
  - target: context/architecture.md
    condition: when tracing knowledge and runtime ownership
  - target: context/conventions.md
    condition: when choosing relevant verification commands
last_updated: 2026-10-26
---

# Knowledge refresh

## Retrieve before updating

1. Run `node scripts/knowledge.mjs status` for admitted corpus and selected-harness identity; use `node scripts/knowledge.mjs search "subject phrase"` for bounded excerpts. Use `llm-wiki/index.md` for human navigation, not the raw corpus or entire log. Path, hash, provenance and historical/current-authored labels must remain attached to evidence. Excerpts are not complete instructions or current runtime proof.
2. Admission belongs to the explicit repository-owned `harness/knowledge-policy.json` allowlist, not folder presence, a submitted flag, index links or automatic prompt/query summaries. Keep raw captures byte-for-byte; new observations get new source atoms. Admit only reviewed durable authored pages with their source/evidence and explicit policy update. Raw, prompt/query stubs, generated graph caches, operational/private runtime state, symlinks and outside-root paths stay excluded.
3. Run `node scripts/knowledge.mjs check` after a reviewed content/hash change. Unsupported/oversized corpus or request bounds fail closed; do not silently clip trusted instructions. Update deterministic navigation with `node scripts/knowledge.mjs index --write`; its managed block lists admitted titles/paths/classifications/hashes without source bodies. Keep historical bookkeeping outside that block in `llm-wiki/log.md`; never auto-promote capture stubs.
4. Preserve separate gates. Bounded corpus validation/index integrity does not replace `python .mex/verify-knowledge.py` or generic full-vault wiki/OKF lint. Run those only when assigned, retain exact failed diagnostics and leave the validator strict. Historical snapshots include 1705, 3408 and 5692 failures, not a clean vault. Read `artifacts/node-native-workbench/knowledge-refresh.json` for timestamped structural/admission/full-vault results. The separate `artifacts/node-native-workbench/verification.json` records candidate UI and scoped source-preserving video revision evidence; it does not grant unqualified human/owner/creative/API/publication approval or deployment authority.

## Explicit project launch and instruction boundary

Use `node scripts/project-agent.mjs --dry-run -- <original task argv>` to inspect the safe plan, or omit `--dry-run` for the supported interactive launch. The launcher derives the checkout from its script path, launches shell-free and preserves task arguments without injecting a profile/model/permission choice. Its documented `LLM_WIKI_VAULT` override defaults to a fresh `data/agent-captures/launch-<uuid>` subfolder, keeping separate launches from rescanning prior sessions. An explicit selected capture location is retained only within that real non-symlink private boundary; otherwise launch fails without echoing the external value. Dry-run creates no capture directory. The safe plan does not dump environment secrets, but original task argv can itself be private: retain it checkout-only.

This is process-scoped capture containment, not a repo-aware vendor-hook opt-out and not proof every manual host runs hooks. Root/MEX rules are prompt-only unless that actual host loads them. No global settings, credentials, scheduled jobs or provider calls are changed by this procedure. Raw historical captures remain intact and outside retrieval. The tool-free native bridge keeps `--no-tools`/`--no-rules` isolation and gets only the selected immutable, checksum/size-validated Bridge Runtime Contract; whole director/orchestrator instructions, wiki source and global rules are not imported.

Already-running or manually launched uncontained hosts can still append automatic stubs to the legacy index/log and can rewrite managed-block line endings. Explicit admission still excludes those stubs; strict index consistency may fail until reviewed navigation is regenerated after those sessions stop. Preserve full local history, but treat `llm-wiki/log.md` as mixed authored/capture material, not publication-safe. Share only separately reviewed authored ledger entries through selective staging; never include automatic capture history or private raw/source/query records merely because they are in that file.

## Code graph navigation

The repository graph is `.mex/graph.db`, one resolver alongside exact text/structural search, not a replacement for them.

- Known exact symbol: `mex graph query <who-calls|what-calls|where-defined> <symbol>` and `mex graph get <id...>`. Each call proves whole-index freshness and can take seconds; batch several IDs. Approximate names can confidently match the wrong symbol.
- Unfamiliar scope: `mex graph scope "<task>"` returns bounded source-backed JSONL and execution flows, matched by words rather than meaning. Treat returned source as already read. `status: "ok"` with `truncated: true` omits optional evidence; `partial`/`degraded` requires narrowing or its suggested commands.
- Expand with `mex graph get <id> --detail source` only for missing source, exact expansion or a partial/degraded suggestion, not a node quota. If scope evidence is insufficient, fall back to exact search/globbing; reword scope at most once.
- Before symbol edits, run `mex impact <symbol|file>` for callers/scaffold effects. During `mex sync`, adjudicate AMBIGUOUS grounding and ensure repaired grounding is re-emitted. Generated graphs remain structural evidence, not semantic or provider truth.

For Inbox/Relay mutations resolve only the intended action using `mex inbox contract --action <command-id> --json` or `mex relay contract --action <command-id> --json`; use `mex capabilities --json` only for broader discovery. Explicitly requested checkout-local draft creation may be previewed/applied without redundant confirmation. Draft deletion and canonical publish/approve/reject/withdraw/stale/repair/take/acknowledge/close require fresh explicit confirmation after semantic preview. Git commit/push/pull require their own authorization.

## Structural refresh, only when assigned

Inspect the native corpus before `mex graph refresh --json` and `mex check --json`. Installed MEX 0.8.3 uses repository-relative `.mex/config.json` `graph.ignore` globs, not `.gitignore`; exclude private operational/workspace files/chunks. Retain a consistent checkout-private SQLite backup before a policy-changing rebuild. Native ignores filter enumeration, not every compiler dependency read: audit metadata/grounding separately without payload bodies. Explicitly close SQLite source/backup handles before Windows atomic publication; connection context managers alone do not close them. Preserve failed candidates/locks; use native lease recovery, never remove live locks or unknown processes to manufacture success.

Read `.graphify/GRAPH_REPORT.md` only for a matching structural task. Use canonical `python .graphify/refresh.py`, the installed version's supported extraction/visualization recipe. Graphify 0.8.39 rejects `scope` and newer update flags; `export html` works despite missing help. Canonical exclusions remove generated operational/config/native-receipt paths before normalization/export: directory entries cover roots/descendants, file entries match exactly. The refresh implementation/tests under `.graphify/` are outside the native default corpus; bind their hashes/behavioral evidence separately rather than inventing flags. Do not confuse a bare CLI output directory with canonical freshness.

## Verification and scaffold update

Read `.mex/verification.json` and `.graphify/verification.json`, then update only from freshly executed commands within scope. Label partial graphs and untested semantic extraction honestly; inspect version/help before retrying unsupported flags. Keep failed full-vault/cache/prompt-ingest gates visible while repairing supported navigation/metadata without deleting pages or weakening validation.

Date changed scaffolds and update index/log/evidence consistently. Root instructions own optional MEX logging policy and the exact sharing boundary: drafts/captures are checkout-private, canonical files are working-tree-only until separately committed/pushed. No hook coverage, billing-token savings, owner approval or goal completion is implied by smaller context or successful indexing.
