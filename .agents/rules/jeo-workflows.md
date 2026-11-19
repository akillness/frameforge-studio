---
description: Per-prompt workflow order - openspace, rtk, semble, jev, then project memory
alwaysApply: true
---
<!-- JEO-WORKFLOWS:START -->
# Workflow Rules (openspace → rtk → semble → jev, then project memory)

Applies automatically to every prompt in every project. The user never has to
name these tools or run setup. Written and refreshed by `scripts/setup-workspace.py`;
re-running the installer updates this block in place.

## Per-prompt order

Run in this order. If a tool is missing, say so in one line and continue.

1. **openspace** — skill routing. If the host hook already appended an OpenSpace
   route note, load the named skill's `SKILL.md` before acting. Otherwise, for any
   task that could match an installed skill, run
   `~/.agents/venvs/openspace/bin/python ~/.agents/skills/openspace/scripts/route_prompt.py --explain "<prompt>"`
   (the system `python3` lacks the `openspace` module) and load the top match.
2. **rtk** — every shell command goes through the rtk hook; where the hook is not
   active, prefix the command with `rtk`.
3. **semble** — discovery before reading: `semble search "<query>" <path>`, then
   `semble find-related <file> <line> <path>`. No grep-and-read of whole files.
4. **jev** — only after steps 2 and 3 both ran for this prompt, and only when a Jev
   profile is enabled (`node ~/.agents/jev/jev-harness.mjs --profile "$JEV_PROFILE" status`).
   Then `route-skills --top-k 3 "<task>"` (advisory) and, before a risky action,
   `review`. Never run jev before rtk and semble; skip silently when no profile is
   enabled. Details: `jev-control-plane.md`.
5. **Route by query type** (below).

## Route by query type

- **Knowledge, past decisions, notes** → second-brain vault `C:\Users\bangg\vaults\jeo-second-brain`. Read its
  index and `wiki/` pages first; file durable findings under `wiki/`. `raw/**` is
  immutable. If the vault is not initialised, say "second-brain pending" and fall
  back to normal search.
- **Code structure, callers, impact, project conventions** → mex. Read
  `.mex/ROUTER.md` first when it exists (an empty `.mex/` means mex has not run:
  say so and use semble), then `mex-agent graph query ...` and
  `mex-agent impact <symbol|file>` before editing. Use `mex-agent`, never bare
  `mex` (TeX Live ships a `mex`).
- **Meaning-based search when the exact name is unknown** → `zg query "<q>" --limit 8`,
  then confirm with `rg` or a file read. Exact identifiers go to `rg`, not `zg`.
  If `zg status --check-ready` fails, run `zg index` (incremental), then query.
- **RDF / OWL / SHACL / ontology work** → the `open-ontologies` skill, via its CLI
  `batch -` mode. Start no network listener and register no MCP server on your own.
- **Improving this agent harness (rules, prompts, skills, hooks)** → harness2 method
  mode. `.harness2/workspace.json` maps the eight harness components to real files.

## Staying current

- After meaningful work: `mex-agent log "<note>"`, `mex-agent check`, `zg index`.
- Git post-commit hooks (`mex-agent watch` and the `zg index` block) and the
  second-brain cron schedules refresh memory without a command from the user.
- Re-running the installer refreshes rules, `.mex/`, the zvec index and the
  `.harness2/` manifest.
<!-- JEO-WORKFLOWS:END -->
