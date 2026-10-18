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
   When using the visual graph, select the exact workflow/version, validate its typed dependencies and execute through the workflow API. Persist the run ID and observe per-node outputs. Do not confuse the production DAG with the knowledge graph. Hand `awaiting_review` candidates to an independent reviewer.
   For saved edits or narration, choose script agent `existing` so rerendering preserves authored scenes and audio. Use a generative agent only when replacing the storyboard is part of the requested change.
6. Apply only validated, version-bound changes. Preserve inputs, failures and artifacts. Record unavailable integrations as unavailable.
   Native narration uses installed Windows SAPI voices. Read `/api/speech/voices`, save the narration script, and submit `voice`, `expectedVersion` and optional `sceneIds`/`rate` to `/api/episodes/:id/narration`. Wait for the persisted job result, reload its resulting episode version and inspect the attached audio before rendering. Linux Docker has no native Windows speech provider; uploaded audio remains usable.
   After independent inspection and an owner decision or explicit review authority, record `approved` or `changes_requested` at `/api/workflows/:id/runs/:runId/review` with notes and the exact rendered `expectedEpisodeVersion`. Preserve the returned review ID, job ID, output URL and SHA-256. A conflict requires a new current candidate; do not retry by substituting a newer version number for the old render. Automated smoke-test decisions remain test evidence, not owner acceptance.
7. File durable source/concept/report atoms with OKF frontmatter, update wiki index/log, refresh code graphs after code changes, and retain exact command evidence.
8. Report local render, QA, upload and publication as separate states. Stop when the requested result is verified or a concrete blocking dependency remains.
## Examples
- Produce a 9:16 information episode from recorded Google trend evidence and an original editable layout.
- Revise a drama template, retain episode history and have an independent reviewer inspect the new candidate.
- Reconcile an episode version conflict before applying an agent-generated patch.
- Generate an installed Korean system voice, preserve the edited scenes with `existing`, and hand the resulting hash-bound candidate to review.
## Best practices
Use original media or verified rights. Keep facts separate from fiction. Never copy credentials or private source footage into Git. A successful schema check does not establish factual truth or visual quality.
