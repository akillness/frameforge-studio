---
name: production-orchestrator
description: >
  Use for FrameForge channel episode production, research-to-storyboard workflows,
  editable templates and independently reviewed video candidates with durable history.
allowed-tools: Read Write Edit Bash Glob Grep
---
# Production orchestrator
## When to use this skill
Use for multi-stage episode work in FrameForge. Do not trigger for generic video recommendations, unrelated repositories or a simple spelling correction.
## Instructions
1. Run `node scripts/version-harness.mjs verify`, resolve `harness/manifest.json`, and read `docs/harness.md` plus role contracts inside its selected bundle. Load the live `.mex/ROUTER.md` and `llm-wiki/index.md` for current code and source context.
2. Resolve channel, episode, current version, goal and authorization. Create an absolute `_workspace/<run-id>/` manifest.
3. Read the selected bundle's `.claude/agents/production-supervisor.md` and four specialist definitions. Reuse file-based roles; do not silently replace their contracts with unpromoted authoring changes.
4. Use the host's native subagents when available and explicitly authorized. Claude team mode requires its supported Agent Teams runtime; file presence is not runtime activation. Otherwise execute the same stages serially and record that mode.
5. Complete research, direction, editing and independent review in dependency order. Parallel research sources must have separate output paths.
   When using the visual graph, select the exact workflow/version, validate its typed dependencies and execute through the workflow API. The graph has ten stage types — trend, news, research, script, storyboard, layout, generate, render, review and publish — and supports partial runs: `selectedStages`/`startStage` with `resumeRunId` reuse completed outputs instead of recomputing them. Paid `generate` stages require explicit `allowGeneration:true`; publish stages require an approved hash-bound review and stage a browser session or queue entry without public posting. Persist the run ID and observe per-node outputs. Do not confuse the production DAG with the knowledge graph. Hand `awaiting_review` candidates to an independent reviewer.
   For saved edits or narration, choose script agent `existing` so rerendering preserves authored scenes and audio. Use a generative agent only when replacing the storyboard is part of the requested change.
6. Apply only validated, version-bound changes. Preserve inputs, failures and artifacts. Record unavailable integrations as unavailable.
   Restoring episode/workflow history creates a new version with a mandatory expectedVersion; never overwrite historical snapshots. Compare stable scene/node identities. Unsaved graph changes use bounded draft undo/redo.
   Higgsfield generation and slot layout are optional stages between storyboard and render, excluded from default graphs. Discover the selected transport's live model schema and require explicit generation execution. Developer API credentials, official MCP OAuth and the host CLI account are separate authentication/billing surfaces. Project MCP submits through FrameForge to preserve episode lineage. Never infer API access from MCP configuration or export CLI credentials.
   Persist requestId before submission and retain it on retry. An uncertain submission without a provider ID must not be resubmitted automatically. POST /api/generations/:id/recover polls existing provider IDs only. Validate downloaded media, register local uploads, and apply at the exact current expectedVersion. Stale edits retain paid output for later explicit apply. Workflow cancellation stops later stages but may not stop an already submitted provider job.
   Native narration uses installed Windows SAPI voices locally on Windows or through the authenticated host bridge from Linux Docker. Read `/api/speech/voices` and verify availability instead of assuming connectivity or a voice. Save the narration script, and submit `voice`, `expectedVersion` and optional `sceneIds`/`rate` to `/api/episodes/:id/narration`. The bridge accepts bounded text/voice/rate only and returns validated raw WAV bytes; never submit host paths. Wait for the persisted job result, reload its resulting episode version and inspect the attached audio before rendering. Missing credentials, unavailable voices, timeout or invalid audio remain explicit failures. Uploaded audio remains usable.
   After independent inspection and an owner decision or explicit review authority, record `approved` or `changes_requested` at `/api/workflows/:id/runs/:runId/review` with notes and the exact rendered `expectedEpisodeVersion`. Preserve the returned review ID, job ID, output URL and SHA-256. A conflict requires a new current candidate; do not retry by substituting a newer version number for the old render. Automated smoke-test decisions remain test evidence, not owner acceptance.
7. For container migration, use the read-only SQLite snapshot utility into a new directory, then the verified snapshot importer into an empty dedicated volume. Preserve original data, partial failures and recovery routing; no destructive database/volume resets. Compare exact IDs, versions, history and media/review hashes, exercise the container adapters and verify persistence after restart before declaring cutover complete. A staging receipt is not proof that the production URL serves the container.
   File durable source/concept/report atoms with OKF frontmatter, update wiki index/log, refresh code graphs after code changes, and retain exact command evidence.
8. Report local render, QA, upload and publication as separate states. Stop when the requested result is verified or a concrete blocking dependency remains.
## Examples
- Produce a 9:16 information episode from recorded Google trend evidence and an original editable layout.
- Revise a drama template, retain episode history and have an independent reviewer inspect the new candidate.
- Reconcile an episode version conflict before applying an agent-generated patch.
- Generate an installed Korean system voice, preserve the edited scenes with `existing`, and hand the resulting hash-bound candidate to review.
- Resume a terminal run to re-render and review without re-executing completed paid generation; verify the reused node outputs before approval.
## Best practices
Use original media or verified rights. Keep facts separate from fiction. Never copy credentials or private source footage into Git. A successful schema check does not establish factual truth or visual quality.
