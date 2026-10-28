---
name: workflow-execution
description: Change or verify which workflow nodes an editor action runs, per-node skip, paid-generation safety and the compact run history.
triggers:
  - "workflow plan"
  - "node execution"
  - "skip node"
  - "run all"
edges:
  - target: context/architecture.md
    condition: when tracing planner, store and editor ownership
  - target: patterns/generation-recovery.md
    condition: when a paid request is unresolved and must be recovered or applied before a rerun
grounds_to: []
last_updated: 2026-10-28
---

# Workflow execution

## Context
`planExecution(store, workflow, episode, execution)` in `server/workflows.mjs` is the only place that decides what an action runs. `POST /api/workflows/:id/plan` is its read-only view; `/quote` and `/run` accept the same `execution` body (`{mode:'node',targetNodeId}` or `{mode:'all',refresh?}`) and derive the selection through the same `stageSelection()` that validates legacy `selectedStages` bodies. The editor in `public/workflow.js` never builds a stage list: it posts an intent, shows the plan, then posts the same intent. Before this design the UI built `selectedStages` itself and posted `/run` without `resumeRunId`, so a connected research output was missing when `script` ran.

Read contract detail from the code and `docs/harness.md` ("Execution planning and per-node skip"), not from memory: block codes (`active_run`, `skipped_target`, `skipped_prerequisite`, `publish_requires_review`, `invalid_selection`, `unknown_node`, `generation_unresolved`), plan fields (`selectedStages`, `resumeRunId`, `requiresGeneration`, `needsDecision`, `nothingToRun`, `completedNodeIds`, `staleNodeIds`, `skippedNodeIds`, `deferredStages`, `notice`, `nodes[].action`) and the `HttpError.code` response field live in `planExecution`, `server/app.mjs` and `public/app.js` `api()`.

## Steps
1. Reproduce through the planner first: a failing case in `tests/workflow-plan.test.mjs` (HTTP only, mock providers, no browser) shows what the server would select. Fix the planner or `stageSelection`, never the client list.
2. Skip is state, not a graph edit: `Store.setWorkflowSkip` writes `skippedNodes` without a version bump, history snapshot or `updatedAt`, and `candidateManifest`, publication bindings and history snapshots exclude it. A skipped node is never selected; its saved output is reused only while valid; a skipped hard prerequisite without valid output blocks.
3. Keep plan == quote == run. A plan that selects a paid `generate` node together with free preparation that must be saved first (for example a fresh script) is a prepare-first plan: only the free prefix runs, the paid node is quoted and consented afterwards.
4. UI work stays inside the single run path: right-click menu items are one line, `run-all` asks keep/refresh when completed nodes exist, run history shows diffs from `public/run-diff.js`, and every new `data-wf-action` must be classified read-only or mutating in `public/app.js`.
5. Verify with the focused suites below before any Docker rebuild.

## Gotchas
- Paid safety is the invariant. `allowGeneration:true` is only sent from the consent dialog with a live quote, disclosure and fingerprint. A generate node invalidated by an upstream rerun is a fresh paid generation with a new request ID, but is blocked (`generation_unresolved`) while its previous request is unsettled (settled = completed and applied, failed, NSFW or canceled). The unsettled request pointer is carried through intermediate runs. A non-invalidated retarget keeps the earlier behaviour: resume or apply the existing job, or fail at run time asking for explicit recovery.
- Unsettled paid history is guarded by workflow, episode and node identity across all runs, not only by the newest or version-compatible resume source (`hasUnresolvedNodeJob` in `server/workflows.mjs`). An episode-version change, or `refresh` dropping the resume source, still blocks a generate node while an older job for that node is unsettled, so a lost `source` cannot cause a second billable submission. A known provider job is resumed or applied, not resubmitted. Sibling nodes and other episodes stay unaffected. Evidence is source-level plus isolated fixtures (`tests/workflow-paid-lost-source.test.mjs`, 11/11, mock providers); it is not proof of deployed behaviour. Remaining limit: a `submission_unknown` request has no `providerRequestId`, so `recover()` and the generation-panel apply cannot act on it and the app offers no confirm or abandon path. It stays blocked (`generation_unresolved`) until manual investigation and a separate product decision resolve it; provider-history inspection does not guarantee in-app completion.
- Version guards stay: the dialog pins the plan-time workflow/episode versions; a changed project closes it without a `/run` request.
- Never show the legacy English `Node was not selected for this execution`; user-skipped nodes say 건너뜀, never-run nodes say 미실행.
- A toggle that resolves after the user switched projects must not write into the new workflow; capture the epoch, workflow ID and stash key before the await.

## Verify
Serial, small machine: `node --test --test-concurrency=1 tests/workflow-plan.test.mjs tests/workflow-skip.test.mjs tests/workflow-reused-generation.test.mjs tests/workflow-sequential-node-data.test.mjs tests/workflow-rollup.test.mjs tests/generation-integration.test.mjs tests/production-publication.test.mjs`, then the browser suites `tests/workflow-menu-run.test.mjs`, `tests/workflow-history-compact.test.mjs`, `tests/run-diff.test.mjs`, `tests/node-workbench.test.mjs`, `tests/workflow-stage-unblock.test.mjs`, `tests/workflow-sequential-node-ui.test.mjs`. Full-suite and Docker evidence is recorded in `docs/verification.md`; local fixtures are not live provider, owner-acceptance or publication evidence.

## Debug
Ask the planner (`POST /plan`) what it would run, and read the stored run's `execution`, `selectedStages`, per-node `skipReason`/`staleFrom`. Distinguish a planner block (200 with `blocked`), a stale version (409 without code), and a coded 409 from `/quote` or `/run` (carries the same `code`).

## Update Scaffold
Update `docs/harness.md` (execution planning section), this file and `docs/verification.md` when the contract or its evidence changes; keep Docker/CI receipts separate from local ones.
