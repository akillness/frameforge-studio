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

**Implemented:** browser video editor, channel/episode/template history, visual typed production DAG, per-node execution history, FFmpeg rendering, host agent bridge, queued native Windows narration and persisted render review decisions bound to the exact output hash. Read `harness/manifest.json` for the current immutable harness version.

**Verified on 2026-10-18:** live Codex, JEO and JEOPI responses; an end-to-end Google RSS → references → Codex → episode scene update → FFmpeg → awaiting_review run; Tailscale HTTPS browser access. See `docs/verification.md`, `artifacts/workflow-smoke.json` and `artifacts/agent-*.json` for evidence. The private GitHub main branch received commit f384821e7c0d66719da52171721b00910c5b0d4e; CI run 39091649080 completed successfully, including Linux Docker render/download and restart persistence.

**Browser evidence:** `artifacts/browser-smoke.json` verifies scene persistence, graph disconnect/reconnect and drag/save, a 390px mobile page without horizontal overflow, Aside command receipt, web command submission, zero page errors and a Secure session cookie over HTTPS.

**Latest production evidence:** `artifacts/production-smoke.json` records Microsoft Heami Desktop speech, a WAV attached at episode version 3, a 4.821333-second 1080x1920 MP4 from version 4 with mean audio volume -24 dB, preserved saved edits and a persisted hash-bound test review. The automated decision is not owner acceptance or publication. Latest-source CI run 39095384742 passed on c56cc4a3e706b978a1f091a3079fb289a59fcb36, including Linux Docker render/review/restart persistence; Windows native speech remains a separate host smoke result.

**Jev:** `artifacts/jev-live-review.json` records a real TypeSafe API response from jev-1.13.0 in 528 ms using the isolated frameforge-codex profile and pinned runtime d9af9e3. Verdict is proposal_only: unrelated_changes confidence .76 and needs_clarification .67 are below .8. The unvalidated tier provides no automatic execution authority; no hook is installed. `artifacts/jev-status.json` keeps the earlier legacy-runtime unavailable audit as history.

**Harness:** current 1.2.0 includes native narration and exact-output review; previous 1.1.0 is archived. Verify the manifest before using a bundle.

**Final source verification:** 58/58 tests passed with zero skips, plus syntax checks for 33 source files. `tests/render-security.test.mjs` reproduces an escaping nested DASH reference disguised as uploaded media, verifies rejection through probing and visual/audio encoding, and verifies all 11 allowed standalone formats still decode and render. Input demuxer and protocol allowlists enforce this boundary. The exact-source CI passed: https://github.com/akillness/frameforge-studio/actions/runs/39095384742.

**Boundaries:** Local Windows Docker execution remains blocked by WSLService privileges; current hosting uses Node on Windows. Linux Docker CI passed; container-to-host agent bridge connectivity remains untested. No automatic channel ownership verification or publication API; Naver collection remains manual. A workflow's awaiting_review status is not human acceptance.

**Memory:** project-specific context is populated; Graphify is deterministic structural extraction with explicit CLI version limits.

**Final browser and graph receipts:** `artifacts/production-browser-smoke.json` verifies native audio/video playback, narration v9/render v10, persistent changes_requested review with matching SHA, zero errors and no 1440/390px overflow. Caption scale in the browser preview can differ from the final MP4. Final refresh: MEX 960 nodes/3098 edges with 100/100 check; Graphify 839 nodes/1687 unique edges, zero duplicate records.

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
| Wiki and graph updates | [knowledge-refresh](patterns/knowledge-refresh.md) |
