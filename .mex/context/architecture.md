---
name: architecture
description: Ownership and request-flow map; runtime status and historical verification have separate owners.
triggers:
  - "architecture"
edges:
  - target: context/stack.md
    condition: when changing technology or dependencies
  - target: context/decisions.md
    condition: when changing product scope or architectural decisions
  - target: patterns/knowledge-refresh.md
    condition: when retrieving knowledge or refreshing structural indexes
last_updated: 2026-10-28
---

# Architecture map

## Request flow and ownership

Authenticated browser JSON reaches `server/app.mjs`; validation precedes persistence. `server/store.mjs` owns SQLite entities, optimistic versions, snapshots, audit history and production knowledge export. `server/render.mjs` turns validated local scene inputs into tracked FFmpeg jobs. Optional agent/speech operations cross the token-authenticated host bridge; they are not browser or graph authority.

| Surface | Owner and boundary |
|---|---|
| Workbench and editor | `public/app.js`, `public/workflow.js`: sole project node canvas, native overlays, one live inspector, stable scene/node/edge identity, hidden scene/graph drafts and active-editor Save. Opening tools does not save/run/spend. |
| Personal presentation | `public/workspace.js`, `public/workspace-state.js`, `public/workspace.css`: local sizing, presets, queue/views and dialog presentation; browser-local profiles and drafts, no server layout writes or invented task state. |
| Production DAG and history | `server/graph.mjs`, `server/workflows.mjs`, `public/history.js`, `public/run-diff.js`: edge-based repeated-role branches, version snapshots, exact node selection/resume, per-node review and new-version restore, not history rewriting. Explicit news query owns RSS input. `planExecution` in `server/workflows.mjs` is the only selection authority: read-only `POST /api/workflows/:id/plan` and the `execution` body of `/quote` and `/run` share it, so a UI action, its quote and its run cannot disagree. Per-node skip (`POST /api/workflows/:id/skips`) is project-only state kept outside versions, history snapshots, candidate manifests and publication bindings. `public/run-diff.js` is the pure compact-history/diff module. `public/workflow.js` separates ownership-bound lightweight `getActivity()` from full graph/run snapshots in `getContext()`; background authority/activity reads do not require copying the whole graph. See [workflow-execution](../patterns/workflow-execution.md). |
| Generation | `server/generations.mjs`, `server/candidates.mjs`, `Store.completeGeneration/applyGeneration`: exact-input consent/quotes, persistent known job identity, bounded probe/hash/provenance import and version-guarded atomic apply. Confirmed full workflows apply before render; retained/recovered outputs require Apply. Ambiguous submissions are not automatically replayed. |
| Provider transports | `server/higgsfield.mjs`, `server/higgsfield-cli.mjs`, `scripts/higgsfield-mcp.mjs`: Developer REST, official CLI and authenticated project MCP are distinct from vendor remote-MCP OAuth. Configuration is not authentication or availability. |
| Media and rendering | `server/media-sources.mjs`, `server/media-credits.mjs`, `enqueueRender`: original source/rights/hash/trim evidence, actual-source credits and persisted branch `sceneSnapshot`; standalone-media demuxer/local-protocol limits apply to both FFprobe and FFmpeg. |
| Publication and archive | `server/youtube-oauth.mjs`, `server/private-runtime.mjs`, `server/publication.mjs`, `Store.setEpisodeArchived`: channel-bound identity, exact-manifest separate final approval, private upload then same-video public readback and fail-closed recovery; version-guarded archive preserves media/history and blocks active effects. |
| Host bridge and narration | `server/integrations.mjs`, `server/narration.mjs`, `scripts/agent-bridge.mjs`, `scripts/speech.ps1`: host agent adapters and Windows SAPI/raw-WAV bridge; stale version output never silently overwrites scenes. |
| Blog workspace | `public/blog.*`, `server/blog.mjs`, `server/blog-sources.mjs`, `server/blog-automation.mjs`, `server/blog-references.mjs`, `scripts/blog-workflow.mjs`: account-scoped current-source hashes, labelled 100k+ same-category reference evidence and original adaptation, exact draft/format approval, separate publication/public-readback rotation and draft-only schedules. See `docs/blog-workflow.md`; the router owns missing prerequisites. |

## Agent knowledge and context boundaries

- `harness/knowledge-policy.json` owns explicit reviewed authored-page admission. `server/project-knowledge.mjs` supplies bounded status/search/check/index through `scripts/knowledge.mjs`. Paths, hashes, provenance and current-authored versus historical classifications travel with excerpts; a search hit is not an instruction or readiness proof.
- `llm-wiki/index.md` is curated navigation, not admission authority. `llm-wiki/log.md` is the preserved ledger, including unreviewed automatic capture bookkeeping; raw/prompt/query stubs and generated caches never become curated knowledge merely by existing.
- `scripts/project-agent.mjs` launches Jeopi shell-free with original task argv and checkout-private `LLM_WIKI_VAULT` containment under `data/agent-captures`. Conflicting external overrides fail rather than silently redirect. This explicit launch path neither modifies global hooks nor controls every manually launched host.
- `server/harness-context.mjs` and `scripts/agent-bridge.mjs` load only the selected checksum-verified immutable **Bridge Runtime Contract** from `docs/harness.md` after promotion. The bridge remains tool-free/rule-isolated (`--no-tools`/`--no-rules`); root/MEX instructions, whole agent documents, private captures and wiki source are not implicitly imported.
- MEX and Graphify are structural resolvers. Their generated graphs and old freshness counts cannot prove semantic truth, provider readiness, render quality or publication. Query/refresh mechanics live in [knowledge-refresh](../patterns/knowledge-refresh.md#code-graph-navigation).

## Evidence pointers

`ROUTER.md` owns current blockers; `docs/verification.md` owns historical receipts and the verbatim pre-compaction map. The [canonical node-native receipt](../../artifacts/node-native-workbench/verification.json) separates passed candidate UI checks, authorized read-only original preservation, and the revised clone's scoped identity/preservation/six-scene readability approval. The snapshot/import/restart preserves 29 media, six original WAVs and seven table fingerprints without mutating the original production source. Targeted user-reported three-term clarity is not full human narration/comfort/sync certification; 104/1611 playback frame drops leave smoothness uncertified, and owner/creative/API/publication approval remains absent. This verification is not a production cutover or whole-checkout readiness claim. The [knowledge receipt](../../artifacts/node-native-workbench/knowledge-refresh.json) owns structural/admission and failed legacy full-vault evidence. Preserve [the dated correction](../../docs/verification.md#context-governance-correction--2026-10-26); new scoped evidence does not retroactively validate older candidate narratives.

FFmpeg/ffprobe, Google network feeds, configured host agent CLIs, Docker and Tailscale are dependencies, not proof of current application readiness. Workflow review storage and test decisions are not owner acceptance; a local render is not an upload or public post. The original detailed component and deployment facts remain [archived verbatim](../../docs/verification.md#architecture-snapshot), not automatically reloaded on session entry.
