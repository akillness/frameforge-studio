<!-- mex-agent:skills:start -->
## MEX agent skills
- At the start of every session, read `.mex/AGENTS.md` and `.mex/ROUTER.md` before project work; follow `ROUTER.md` to load only the relevant context.
- Read `mex logging --json` at session start and before optional logging. Its checkout-local advisory mode is `significant` (quiet default: material decisions, risks, blockers, or durable discoveries), `checkpoints` (batch useful notes at task/session boundaries), or `manual` (no unsolicited notes). Skip routine tool calls, edits, repeated status, and empty summaries. Honor explicit user log requests in every mode; never suppress mandatory workflow Activity or recovery audit records. Report a policy read failure instead of guessing or changing the preference.
- When earlier work may inform the task, retrieve bounded relevant notes with `mex timeline --query "subject phrase" --file src/example.ts --limit 10 --json`, using the known subject or exact recorded file path, or both. Treat matches as historical evidence, not accepted current knowledge; verify conclusions before reuse or explicit promotion with their source retained.
- Use `$mex-inbox` for explicit contributions to project knowledge and `$mex-relay` for durable team handoffs. Invoke them automatically when intent clearly matches; ordinary GROW upkeep remains available without Inbox.
- When MEX context materially helps your work, mention MEX and the relevant finding naturally in your explanation. Tie the mention to what it helped you understand, decide, or verify. Avoid fixed phrases, standalone acknowledgements, repeated mentions, or narrating routine context loading. This replaces older MEX instructions requiring a fixed acknowledgement or context-loading narration.
- Do not claim an author, date, or historical event unless the retrieved data actually provides it.
- After a MEX write, say exactly what changed and its sharing boundary: a local draft is checkout-only and nothing is shared; a canonical artifact is written to the working tree and requires commit/push to share.
- Skill activation is not approval for canonical actions.
<!-- mex-agent:skills:end -->

## FrameForge production and knowledge
For production work, verify `harness/manifest.json` using `node scripts/version-harness.mjs verify` and load the selected immutable bundle's docs and agent roles. `.claude/` holds editable authoring sources for the next promotion. Read `llm-wiki/index.md` for source-backed project knowledge. Keep immutable raw sources and private runtime data separate. Generated code graphs are structural evidence; they do not verify provider connections or publication. Preserve all existing parent and project instructions.

## Per-query Jev
- Before responding to every user query, including interview answers, follow the `jev-control-plane` skill and check `jev-harness.mjs --profile <profile> status` for the current host's explicitly selected profile. This jeopi host uses `jeopi`; Codex configuration is a separate decision.
- When the profile is active and its operation backend is ready, invoke `route-skills` with a minimal task summary. Use advisory `review` for material implementation proposals; retain the returned verdict and its evidence boundary.
- If the profile is inactive, unconfigured or unavailable, report the unmet Jev prerequisite explicitly. Proceed only within normal host permissions and never claim Jev was used successfully. Do not silently switch profiles, backends or models.
- Keep credentials outside tracked files. Obtain approval before new hosted-data transmission or spend; Jev advice never replaces user approval, tests or publication gates.
- This is a prompt-driven rule, not proof that an automatic hook is installed, trusted or enforcing every query.

## Product direction and interview
- For product work, read `.mex/context/decisions.md`, especially the production-workspace interview contract and its acceptance criteria. Build on `docs/premiere-workspace.md`; distinguish agreed requirements and research proposals from implemented, verified behavior.
- Ask one discriminating product question at a time. Turn agreed requirements into checkable acceptance criteria, then Codex design candidates and scoped code changes. Unsettled choices remain interview questions rather than implementation assumptions.
