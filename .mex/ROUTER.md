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
last_updated: 2026-10-19
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State

**Implemented:** browser video editor, channel/episode/template history, typed production DAG, per-node execution history, FFmpeg rendering, token-authenticated agent/speech bridge, queued Korean narration and exact-version/job/hash review decisions. White UI is active across Studio, Workflow, Trends, Templates, History, Knowledge and Settings. The Studio Higgsfield CTA reuses the workflow inspector; opening it creates no save, run or spend. When no existing-script generation path is suitable it creates an unsaved five-node `script(existing) -> storyboard -> generate -> render -> review` draft, preserving the saved graph and the live selected scene's stable ID.
**Operational overview (2026-10-19):** the eighth view composes the existing `/api/state` and history APIs into a real-record queue, API-derived deliverable references, provenance and operations status. Filters, sorting, columns and named views are browser-local presentation state; no task backend, server layout write, owner, deadline or invented health metric was added. `artifacts/ops-workspace/verification.json` records 61-module syntax check, 254/254 tests, 94 browser checks and final screenshot hashes; the browser fixtures were isolated and removed. The earlier Jev proposal receipt predates this diff; the current Jev profile is unavailable, so this diff has no Jev verdict.

**Personal workspace:** the browser-local workspace shell offers `auto` (docked fit), `compact` (1024×768 overlay), `standard` (1280×800 docked), `wide` (1600×900 docked) and `focus` (1280×800 overlay). Users can enter bounded numeric dimensions (width 320–2560px, height 320–1800px, inspector 240–480px) or resize with pointer drag and keyboard arrows; Shift uses the coarse step. Inspector, narration and assistant panels open as native dialog overlays by moving the existing DOM. Named profiles live in browser storage only and make no server layout writes. Assistant unsent drafts are episode-scoped transient state; inspector edits are scene-scoped state. See `artifacts/workspace-browser-smoke.json` and `docs/assets/workspace/`.
**Generation safety:** fresh exact-input quote or explicit no-quote acknowledgement precedes confirmation. The confirmed full workflow automatically applies the generated output with version checks, then renders; retained/recovered outputs have a separate Apply action. UI submissions include the quoted workflow/episode versions; the API's optional exact-version guards reject stale 409 before creating a run. REST uses `POST /estimate/{model}` and persisted generation job ID as `Idempotency-Key`, without automatic submission replay. Configured, authenticated and available remain distinct. Preserve immutable history, optimistic concurrency and known-provider-ID recovery; see [architecture](context/architecture.md) and [decisions](context/decisions.md).

**Historical Higgsfield evidence:** `artifacts/higgsfield-live-smoke.json` records one completed paid Seedance 2.5 generation through actual project MCP stdio -> authenticated FrameForge API -> Docker -> authenticated Windows host CLI. The imported video is 1080x1920, 4.042 seconds, 824923 bytes; its local SHA-256 matches the receipt. Application produced episode version 3 and a completed Docker render. The estimate was 64 credits, not a measured final charge. Live CLI discovery returned 108 models. At that observation, official remote MCP OAuth was pending and Developer REST credentials were absent. Latest white-studio QA makes no new live-provider authentication or generation claim.

**Historical Windows deployment (2026-10-18):** Docker engine 29.5.2 and the non-root/read-only Linux container were verified on host loopback port 4310 behind the private Tailscale HTTPS URL. Windows hosted the authenticated agent/SAPI bridge. WSLService Stop Pending and privilege failures preceded that recovery. The latest macOS local QA is not a production cutover or renewed proof of this route's availability. Preserve original host data and the migration snapshot.

**Migration:** `artifacts/docker-migration.json` verifies all original entity IDs, episode/workflow versions and 10 media hashes after import: 4 channels, 3 episodes, 19 episode-history snapshots, 9 workflow-history snapshots and 3 review records. Snapshot/import utilities reject unsafe paths, missing/tampered media and nonempty import destinations; they never reset the live database or overwrite previous data.

**Runtime:** `artifacts/docker-production-smoke.json` proves staged container -> authenticated Windows SAPI -> saved editing -> audible 1080x1920 MP4 (4.821333 seconds, mean -24.1 dB) -> persisted hash-bound test review. `artifacts/local-container-smoke.json` separately proves container render/review/restart persistence. `artifacts/docker-workflow-smoke.json` proves a real Codex script -> storyboard -> render -> awaiting_review path through the container host bridge; this new run did not include trend/RSS stages. Earlier full Google RSS/references/Codex evidence remains in `artifacts/workflow-smoke.json`.

**Browser:** `artifacts/docker-production-browser-smoke.json` verifies staged narration controls, actual audio/video playback, persisted changes_requested review, zero page errors and no 1440/390px horizontal overflow. Its loopback HTTP cookie is not Secure; the private Tailscale HTTPS deployment has separate verification. `artifacts/docker-live-production-browser-smoke.json` verifies the production Tailscale HTTPS URL: Secure cookie, actual audio/video playback, persisted exact-hash changes_requested review, zero page errors and no 1440/390px overflow. `artifacts/live-container-smoke.json` verifies production restart persistence. Original IDs/versions and 10 media hashes were rechecked after that restart in `artifacts/docker-migration.json`. Preview caption scale can differ from final MP4.

**Latest white-studio/workspace verification:** `npm run check` passed 55 modules and Linux Docker `npm test` passed 213/213 with 0 failures and 0 skipped. `artifacts/white-studio-browser-smoke.json` records 101 authenticated checks and `artifacts/workspace-browser-smoke.json` records 157 authenticated checks on loopback port 4329; both have zero page errors. The final image is `sha256:d4424d7f59c495f97d72ea2e85fb643fe64e9f35b69ff374da90617ca9ce6023`; `artifacts/white-studio-verification.json` records 15/15 inspected source hashes matching, final-image render and restart persistence. Provider catalog/quote/recovery/apply remain fixtures; no paid generation or public deployment occurred in this change. Scope and commands: [verification](../docs/verification.md).
**Latest operational workspace verification:** the 2026-10-19 UI-only change passed `npm run check` (61 modules), `npm test` (254/254), and an isolated loopback smoke (94 checks, no page errors/external/provider calls, temporary database removed). Screenshots cover the overview at 1440/768/375px; all eight views were measured with no document overflow. `artifacts/ops-workspace/verification.json` binds 10 source hashes and 14 screenshot hashes. GitHub Actions run 39201562842 on pushed commit `0af4b0698abcffb9f719401605fa2a6cdf1fa2ee` also passed isolated Linux Docker build/render/restart persistence; receipt: `artifacts/ops-workspace-ci-smoke.json`. This does not establish Windows production deployment. The local Docker Desktop remains stopped, the project launcher could not access the required existing volume, and port 4310 has no listener; no volume or production data was changed.

**Container boundary:** `artifacts/white-studio-verification.json` records final image `sha256:d4424d7f59c495f97d72ea2e85fb643fe64e9f35b69ff374da90617ca9ce6023`, 15/15 inspected source SHA-256 values matching checkout, and authenticated Docker browser QA on loopback port 4329. `artifacts/white-studio-container-smoke.json` proves actual final-image render/authenticated download and exact-output saved-edit review with restart persistence. These local receipts do not verify public production deployment, live paid Higgsfield generation, Developer REST authentication or owner acceptance; historical Windows/Tailscale and CI evidence remains separate.

**Harness:** immutable current 1.4.0 covers node/history editing and Higgsfield submission, recovery and apply boundaries; 1.3.0 is archived. Resolve `harness/manifest.json` and verify the selected bundle rather than guessing its version. Earlier bundle bytes remain immutable.

**Jev:** real TypeSafe API advisory evidence exists in `artifacts/jev-live-review.json`; current Docker work has `artifacts/jev-docker-plan.json` and final `artifacts/jev-docker-review.json` (real jev-1.13.0 API, 649 ms, proposal_only, unvalidated tier). The isolated frameforge-codex profile uses a pinned runtime. Model proposals are not automatic authority, and no global hook/catalog changes are implied. Keep all credential values outside tracked memory.

The newer `artifacts/jev-higgsfield-review.json` records a real jev-1.13.0 API response in 525 ms, still `proposal_only` with an unvalidated tier. Its proposal predates the final live-generation receipt and does not grant execution authority.

**Boundaries:** no automatic channel ownership/OAuth verification or publication API; Naver collection remains manual. Historical paid Higgsfield video generation used official CLI transport; Developer REST credentials, CLI login, vendor MCP OAuth and the project-owned MCP bridge remain separate. Hosted paid TTS is not connected. Automated review decisions are test evidence, not owner acceptance. SAPI remains Windows-hosted, never native Linux synthesis.

**Memory:** `artifacts/white-studio-research.json` records 16 design sources, 12 official Higgsfield sources and read-only Aside public UI observations; its pre-implementation findings are not the current runtime contract. In particular, full-workflow auto-apply is clarified in `implementationDecisions`. The narrative is [the scoped report](../llm-wiki/wiki/reports/usability-higgsfield-2026-10-18.md). Read `.mex/verification.json` and `.graphify/verification.json` after the parent's final source refresh; structural graphs are not semantic truth or execution evidence.

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



**Prior structural refresh:** MEX 70 files, 1735 nodes/5331 edges, check100 with zero drift; Graphify 1274 nodes/2858 unique edges from 183 source files; wiki 9 pages/7 OKF atoms with zero errors. These counts predate the white-studio changes. The parent refreshes graphs and wiki validation after final sources; use those receipts before claiming freshness.
