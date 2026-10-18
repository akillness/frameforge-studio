---
name: router
description: Session bootstrap and navigation hub. Read at the start of every session before any task. Contains project state, routing table, and behavioural contract.
edges:
  - target: context/architecture.md
    condition: when working on system design, integrations, or understanding how components connect
  - target: context/stack.md
    condition: when working with specific technologies, libraries, or making tech decisions
  - target: context/conventions.md
    condition: when writing new code, reviewing code, or unsure about project patterns
  - target: context/decisions.md
    condition: when making architectural choices or understanding why something is built a certain way
  - target: context/setup.md
    condition: when setting up the dev environment or running the project for the first time
  - target: patterns/INDEX.md
    condition: when starting a task — check the pattern index for a matching pattern file
last_updated: 2026-10-18
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State

**Implemented:** browser video editor, channel/episode/template history, typed production DAG, per-node execution history, FFmpeg rendering, token-authenticated agent/speech bridge, queued Korean narration and exact-version/job/hash review decisions. The latest usability slice adds readable scene/node/edge comparisons, version-preserving restore, draft undo/redo and dirty guards, editable node labels/notes/settings, and selected-node input/output inspection. Optional Higgsfield generation has an explicit spending confirmation and a separate version-checked apply action.

**Higgsfield evidence:** `artifacts/higgsfield-live-smoke.json` records one completed paid Seedance 2.5 generation through actual project MCP stdio -> authenticated FrameForge API -> Docker -> authenticated Windows host CLI. The imported video is 1080x1920, 4.042 seconds, 824923 bytes; its local SHA-256 matches the receipt. Application produced episode version 3 and a completed Docker render. The estimate was 64 credits; it is not a measured final charge. Live CLI discovery returned 108 models. The separate official remote MCP still needs OAuth; Developer REST credentials are absent. Do not claim those two connections are authenticated.

**Current deployment (2026-10-18):** the local Docker engine 29.5.2 is healthy. The production service now runs in a non-root/read-only Linux container on host loopback port 4310 behind the unchanged private Tailscale HTTPS URL. Windows hosts the authenticated agent/SAPI bridge. Earlier WSLService Stop Pending and privilege failures are historical; they no longer describe the current deployment. Preserve original host data and the migration snapshot.

**Migration:** `artifacts/docker-migration.json` verifies all original entity IDs, episode/workflow versions and 10 media hashes after import: 4 channels, 3 episodes, 19 episode-history snapshots, 9 workflow-history snapshots and 3 review records. Snapshot/import utilities reject unsafe paths, missing/tampered media and nonempty import destinations; they never reset the live database or overwrite previous data.

**Runtime:** `artifacts/docker-production-smoke.json` proves staged container -> authenticated Windows SAPI -> saved editing -> audible 1080x1920 MP4 (4.821333 seconds, mean -24.1 dB) -> persisted hash-bound test review. `artifacts/local-container-smoke.json` separately proves container render/review/restart persistence. `artifacts/docker-workflow-smoke.json` proves a real Codex script -> storyboard -> render -> awaiting_review path through the container host bridge; this new run did not include trend/RSS stages. Earlier full Google RSS/references/Codex evidence remains in `artifacts/workflow-smoke.json`.

**Browser:** `artifacts/docker-production-browser-smoke.json` verifies staged narration controls, actual audio/video playback, persisted changes_requested review, zero page errors and no 1440/390px horizontal overflow. Its loopback HTTP cookie is not Secure; the private Tailscale HTTPS deployment has separate verification. `artifacts/docker-live-production-browser-smoke.json` verifies the production Tailscale HTTPS URL: Secure cookie, actual audio/video playback, persisted exact-hash changes_requested review, zero page errors and no 1440/390px overflow. `artifacts/live-container-smoke.json` verifies production restart persistence. Original IDs/versions and 10 media hashes were rechecked after that restart in `artifacts/docker-migration.json`. Preview caption scale can differ from final MP4.

**Verification:** the latest root local run passed 127 tests. `artifacts/usability-browser-smoke.json` passed 23 checks in disposable local records at 1440/390px with no page errors. Direct-API catalog and paid-output recovery browser checks used intercepted HTTP fixtures; that receipt did not submit generation. The separate live Higgsfield receipt proves the real paid generation/import/apply/render path. Earlier Docker/CI receipts remain scoped to their recorded source; current-source CI, final rebuild persistence and live HTTPS usability need their own receipts.

**Harness:** immutable current 1.4.0 covers node/history editing and Higgsfield submission, recovery and apply boundaries; 1.3.0 is archived. Resolve `harness/manifest.json` and verify the selected bundle rather than guessing its version. Earlier bundle bytes remain immutable.

**Jev:** real TypeSafe API advisory evidence exists in `artifacts/jev-live-review.json`; current Docker work has `artifacts/jev-docker-plan.json` and final `artifacts/jev-docker-review.json` (real jev-1.13.0 API, 649 ms, proposal_only, unvalidated tier). The isolated frameforge-codex profile uses a pinned runtime. Model proposals are not automatic authority, and no global hook/catalog changes are implied. Keep all credential values outside tracked memory.

The newer `artifacts/jev-higgsfield-review.json` records a real jev-1.13.0 API response in 525 ms, still `proposal_only` with an unvalidated tier. Its proposal predates the final live-generation receipt and does not grant execution authority.

**Boundaries:** no automatic channel ownership/OAuth verification or publication API; Naver collection remains manual. Paid Higgsfield video generation is now exercised through the official CLI transport; official remote MCP OAuth and Developer REST authentication remain separate unfinished connections. Hosted paid TTS is not connected. Automated review decisions are test evidence, not owner acceptance. SAPI remains Windows-hosted, never native Linux synthesis.

**Memory:** the earlier Docker-only refresh recorded MEX 47 files, 1138 nodes/3526 edges and Graphify 1005 nodes/1961 unique edges. These counts predate the usability/Higgsfield changes and must not be presented as current freshness evidence. Read `.mex/verification.json` and `.graphify/verification.json` after the next refresh. Structural graphs are not semantic truth or execution evidence. The current narrative is in `llm-wiki/wiki/reports/usability-higgsfield-2026-10-18.md`.

## Routing Table

Load the relevant file based on the current task. Always load `context/architecture.md` first if not already in context this session.

| Task type | Load |
|-----------|------|
| Understanding how the system works | `context/architecture.md` |
| Working with a specific technology | `context/stack.md` |
| Writing or reviewing code | `context/conventions.md` |
| Making a design decision | `context/decisions.md` |
| Setting up or running the project | `context/setup.md` |
| Any specific task | Check `patterns/INDEX.md` for a matching pattern |

## Behavioural Contract

For every task, follow this loop:

1. **CONTEXT** — Load the relevant context file(s) from the routing table above. Check `patterns/INDEX.md` for a matching pattern. If one exists, follow it.
2. **BUILD** — Do the work. If a pattern exists, follow its Steps. If you are about to deviate from an established pattern, say so before writing any code — state the deviation and why.
3. **VERIFY** — Load `context/conventions.md` and run the Verify Checklist item by item. State each item and whether the output passes. Do not summarise — enumerate explicitly.
4. **DEBUG** — If verification fails or something breaks, check `patterns/INDEX.md` for a debug pattern. Follow it. Fix the issue and re-run VERIFY.
5. **GROW** — After meaningful work, run this binary checklist:
   - **Ground:** What changed in reality? Name the changed behavior, system, command, dependency, or workflow.
   - **Record:** If project state changed, update the "Current Project State" section above. If documented facts changed, update the relevant `context/` file surgically.
   - **Orient:** If this task can recur and no pattern exists, create one in `patterns/` using `patterns/README.md`, then add it to `patterns/INDEX.md`. If a pattern exists but you learned a gotcha, update it.
   - **Write:** Bump `last_updated` in every scaffold file you changed. Read `mex logging --json` before optional `mex log` notes: `significant` records material rationale, `checkpoints` batches useful notes at task/session boundaries, and `manual` avoids unsolicited notes. Honor explicit user log requests in every mode; mandatory workflow Activity and recovery audits remain required.

## Production task patterns

| Task | Pattern |
|---|---|
| Episode version edits | [episode-edits](patterns/episode-edits.md) |
| Provider availability or failures | [provider-evidence](patterns/provider-evidence.md) |
| Higgsfield job recovery and apply conflicts | [generation-recovery](patterns/generation-recovery.md) |
| Wiki and graph updates | [knowledge-refresh](patterns/knowledge-refresh.md) |

**Docker release CI:** code commit `0f59211601cba11c7885ed2d28a76581cc695bad` passed [run 39110221470](https://github.com/akillness/frameforge-studio/actions/runs/39110221470): 77 regressions, immutable harness verification, Linux Docker build/render/exact-review/restart persistence. Receipts: `artifacts/docker-ci-run.json` and `artifacts/docker-ci-smoke.json`. Later documentation-only commits do not replace this tested source identity.



**Current structural refresh:** MEX 70 files, 1735 nodes/5331 edges, check100 with zero drift; Graphify 1274 nodes/2858 unique edges from 183 source files. Wiki structural validation: 9 pages/7 OKF atoms, zero errors. These are structure checks, not semantic or provider authentication claims.
