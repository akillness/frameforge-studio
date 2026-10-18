---
name: knowledge-refresh
description: Refresh portable context after code and knowledge changes.
triggers:
  - "knowledge-refresh"
edges:
  - target: context/architecture.md
    condition: when related context is needed
  - target: context/conventions.md
    condition: when related context is needed
grounds_to: []
last_updated: 2026-10-18
---

# Knowledge refresh
## Context
Read llm-wiki/index.md and .graphify/GRAPH_REPORT.md.
## Steps
1. Keep raw source captures unchanged; create new source atoms for new evidence.
2. Run mex graph and mex check.
3. Run the installed Graphify version's documented structural extraction and visualization path.
4. Lint wiki links and OKF required fields.
## Gotchas
Graphify 0.8.39 rejects scope and newer update flags; export html works despite being absent from help. Use the recorded actual CLI recipe. Runtime private data is excluded from the repository corpus.
## Verify
Read .mex/verification.json and .graphify/verification.json, then update them from fresh commands.
## Debug
Inspect version and actual help before retrying unsupported flags. Label partial graphs and untested semantic extraction honestly.
## Update Scaffold
Update last_updated, wiki index/log and evidence receipts together.
