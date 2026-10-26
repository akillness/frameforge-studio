# FrameForge structural graph

Native Graphify structural extraction after admission: **3075 nodes, 5469 edges**.

The installed native CLI can accumulate exact duplicate edge records. This refresh
normalized 5469 native records to
5469 whole-record-unique edges within their native
collections, removing 0 exact
duplicates before HTML export. Stable sorted-key JSON identifies equality of the entire
record within each collection; edges with different metadata remain separate. graph.json,
this report and graph.html all derive from the normalized artifact. No exact duplicate
records remain within either native collection.

Before normalization/export, checkout-local agent state and generated vault metadata
are removed with their incident or locally sourced edges. This refresh removed
263 nodes and
368 edges from these noncanonical
paths. The exclusion audit is retained in verification.json; canonical source
relationships with distinct metadata remain intact.

Exact reviewed authored wiki bodies are admitted through `harness/knowledge-policy.json`.
This refresh removed 212 unadmitted wiki nodes and
207 incident or locally sourced edges. Raw captures,
prompt/query stubs, caches, operational state and all index/log/instruction bodies are
excluded. Provenance evidence paths do not admit their target bodies. Reports remain
historical references, never current readiness or goal-completion authority.

This is a deterministic structural graph, not semantic verification. Extraction and
interactive tree export use the installed Graphify CLI; no provider or model call is
required. The native extractor still scans rejected local inputs before final filtering;
no extraction CPU or billed-token savings are claimed. Unfiltered native artifacts and
caches stay in temporary local staging; only filtered graph/report/tree are published.
The native command receives an absolute source root and a staged working directory, so
the installed CLI's relative `graphify-out/manifest.json` also stays local to staging.
The retained source scope and source hashes are in [scope.json](scope.json); admission
policy/hash, reviewed file hashes, removed counts and command exit codes are in
[verification.json](verification.json).

Publication covers graph.json, graph.html, scope.json, this report and verification.json
as one rollback-protected generation. Fsynced private snapshots and a journal preserve
the previous bytes on ordinary publication failure; this is not atomic multi-file reader
visibility. If restoration itself fails or the process is interrupted, publication is
blocked by `.refresh-publication.lock`. Its private transaction path can be recovered
with `python .graphify/refresh.py --recover-publication <private-transaction>`; snapshots
remain private until recovery completes. Failed attempts never overwrite the previous
shared receipt and are recorded separately under private `data/harness-audit/`.

Open [graph.html](graph.html) for the native interactive tree. Its D3 dependency
loads from a CDN. [graph.json](graph.json) is the portable machine-readable artifact.
Only explicitly reviewed project knowledge joins the code graph. Private live episode
data and unadmitted vault content are not shared structural evidence.

The installed 0.8.39 CLI rejected `scope` and newer `update --no-description`
flags. Its `export html` succeeded even though omitted from help. A one-time
`cluster-only --no-label` run produced placeholder Community N labels; that
historical output is under `clustered/` and is not automatically refreshed.
Use current graph.json and this report for current counts.

Refresh with `python .graphify/refresh.py`. No hooks or shared skills are installed.
