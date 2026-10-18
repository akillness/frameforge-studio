# FrameForge structural graph

Native Graphify code extraction: **649 nodes, 3254 edges**.

This is a deterministic AST graph, not an LLM semantic graph. Extraction and
interactive tree export were executed through the installed Graphify CLI.
No provider key or model call was required. The current corpus is listed in
[scope.json](scope.json); command exit codes and graph hash are in
[verification.json](verification.json).

Open [graph.html](graph.html) for the native interactive tree. Its D3 dependency
loads from a CDN. [graph.json](graph.json) is the portable machine-readable artifact.
The code graph is separate from private live episode data and the curated
[project wiki](../llm-wiki/index.md).

The installed 0.8.39 CLI rejected `scope` and newer `update --no-description`
flags. Its `export html` succeeded even though omitted from help. A one-time
`cluster-only --no-label` run produced placeholder Community N labels; that
historical output is under `clustered/` and is not automatically refreshed.
Use current graph.json and this report for current counts.

Refresh with `python .graphify/refresh.py`. No hooks or shared skills are installed.
