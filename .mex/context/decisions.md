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
- Use the host's installed Korean SAPI voice for the first verified narration path. Keep unavailable providers explicit on Linux; local voice synthesis is not a hosted generative-video integration.
- Attach generated narration and review decisions only to their exact episode versions. Review additionally binds the render job, URL and SHA-256, so a later edit cannot inherit approval of an earlier output.
- Restrict uploaded media demuxers and protocols at decode/probe time. A DASH playlist disguised as MP4 can otherwise reference a file outside uploads despite a safe top-level path; executable regression tests exercise the escape and all 11 allowed formats.
These are the current implementation rationale and boundaries, not historical claims about unrecorded decisions.
