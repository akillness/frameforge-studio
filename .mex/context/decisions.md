---
name: decisions
description: Rationale for local storage and portable project knowledge.
triggers:
  - "decisions"
edges:
  - target: context/architecture.md
    condition: when related context is needed
  - target: context/conventions.md
    condition: when related context is needed
grounds_to: []
last_updated: 2026-10-18
---

# Decisions
## Decision Log
- Use a local-first production hub so editable scenes and episode history remain usable without an external video platform connection.
- Use portable Markdown knowledge atoms to preserve sources and production concepts across agent tools; the wiki remains distinct from runtime private data.
- Keep a deterministic structural graph separate from semantic claims. The installed Graphify CLI has a smaller command surface than the current skill reference.
- Treat provider availability, actual invocation and publishing as separate evidence states. A scaffold is not proof that those integrations run.
These are the current implementation rationale and boundaries, not historical claims about unrecorded decisions.
