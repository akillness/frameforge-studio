# Production harness

FrameForge uses a supervisor-led pipeline with independent review. Editable file-based roles live in `.claude/agents/`; production consumers first resolve `harness/manifest.json` and read the selected immutable bundle. Codex, jeo and jeopi can read the same contracts through the root `AGENTS.md`. These files define reusable work contracts. They do not prove that every runtime or external provider is connected. See [versioning and rollback](harness-versioning.md).

```mermaid
flowchart LR
  B[Channel + episode brief] --> S[Supervisor]
  S --> R[Researcher]
  R --> D[Director]
  D --> E[Editor]
  E --> Q[Independent reviewer]
  Q -->|revise| D
  Q -->|verified artifact| H[Episode history]
  H --> K[OKF knowledge atoms]
```

## Roles and handoffs

| Role | Owns | Required output |
|---|---|---|
| Supervisor | Scope, dependencies, version conflict resolution | Run manifest and summary |
| Researcher | Trend and creator evidence | Source URL, observed time, claim, uncertainty, visual reference notes |
| Director | Original treatment and editable template | Scenes, durations, layout, narration and source bindings |
| Editor | Validated scene changes and local render | New episode version, render receipt and artifact hash |
| Reviewer | Independent content and technical acceptance | Pass/fail findings tied to exact version and artifact |

Each run uses an absolute `<repo>/_workspace/<run-id>/` path resolved by the supervisor. Inputs include `channelId`, `episodeId`, `expectedVersion`, requested format, scope and available source IDs. Preserve `tasks.json`, per-role outputs, `conflicts.md` when needed and `run-summary.md`. These operational files may contain personal information; keep them out of public Git history.

Research can fan out by source only when each agent has a separate output path. Direction depends on completed research; editing depends on direction; review depends on the exact rendered candidate. An editor cannot approve its own render. On conflict, re-read the episode version and merge deliberately; never overwrite a newer version. On a timeout, report the existing job ID before considering a retry. Missing factual, rights or final-render evidence prevents a verified completion claim.

## Runtime boundary

The web chat submits bounded requests through `server/integrations.mjs` to the host bridge. The service validates patches before updating SQLite history. A CLI executable on PATH is availability evidence only; provider authentication and a successful invocation are separate checks. The built-in studio assistant is a deterministic helper, not an LLM. Publishing and channel creation remain separate authenticated platform operations.

## Executable production graph

`server/workflows.mjs` implements a bounded typed DAG for the visual node workspace. It has six stage types: `trend`, `research`, `script`, `storyboard`, `render` and `review`. Script, storyboard, render and review are required; trend and research are optional. Each stage type appears at most once. The current engine accepts 4–6 nodes and 3–15 forward edges, requires all nodes to reach the review output and rejects cycles, duplicate IDs, disconnected stages and invalid configuration. This is FrameForge's production graph, not a loader for arbitrary ComfyUI model workflows.

| Stage | Actual responsibility |
|---|---|
| Trend | Fetch source-backed keyword observations; empty results fail the node |
| Research | Gather saved references belonging to the episode channel and upstream outputs |
| Script | Invoke the chosen configured agent, or explicitly use the deterministic studio helper |
| Storyboard | Validate scenes and write a version-bound episode update |
| Render | Execute the local rendering adapter and retain its result |
| Review | Produce an `awaiting_review` checkpoint for the exact rendered candidate |

Each execution saves a workflow/version snapshot, episode/version snapshot and per-node states and outputs. The implementation orders validated dependencies deterministically. It allows at most four active runs and one active workflow per episode. A server restart marks interrupted runs failed. Cancellation prevents later stages; an already-running provider or render process may finish. The review node does not perform human visual review or publish to a channel. The independent reviewer role or owner must inspect the candidate afterward.

The file-based harness defines responsibilities around this executable graph. Graph nodes do not automatically launch every specialist role; agent selection is an explicit script-node configuration. Runtime API and end-to-end test receipts determine which graph paths have actually been exercised.

The authenticated service exposes `GET/POST /api/workflows`, `PUT /api/workflows/:id` with `expectedVersion`, `POST /api/workflows/:id/run` with `episodeId`, `GET /api/workflows/:id/runs`, `GET /api/workflows/:id/history` and `POST /api/workflows/:id/runs/:runId/cancel`. A node is `{id,type,x,y,config}` and an edge is `{id,source,target}`. Only the script node currently accepts configuration: `{agent,prompt}`. Runtime adapter implementations may evolve, so inspect the live route contract and current tests before adding a new node type.

## Durable memory

- `llm-wiki/index.md`: human-readable project knowledge; immutable source excerpts under `raw/` and OKF v0.1 atoms under `wiki/`.
- `.mex/ROUTER.md`: task-specific code context, populated architecture notes and a real CLI graph/check receipt.
- `.graphify/GRAPH_REPORT.md`: structural graph provenance and limitations; `.graphify/graph.html` is a navigable export.
- Application data has its own episode history and generated knowledge export. Build-time code graphs are not the live channel database.

Run the validation commands recorded in `.mex/verification.json` and `.graphify/verification.json` after source changes. Review whether a claim has become stale, not only whether a link still exists. Never store tokens, signed media URLs, browser storage or private source footage in these tracked knowledge layers.

## Acceptance scenarios

1. A sourced information episode retains each factual claim's source and observation time through edits.
2. A fictional drama episode labels fiction and keeps original scene direction separate from creator references.
3. Two editors start from the same version: the second stale write is rejected and reconciled.
4. A failed render stays failed in history and is never described as published.
5. A reviewer can trace the exact output hash to the episode version and input sources.

These are harness contracts. Runtime tests and verification receipts establish which scenarios have actually been exercised.
