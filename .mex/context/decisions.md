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
- Use the host's installed Korean SAPI voice for the first verified narration path. Use its authenticated host bridge from Linux containers and keep bridge/voice failures explicit; local voice synthesis is not a hosted generative-video integration.
- Attach generated narration and review decisions only to their exact episode versions. Review additionally binds the render job, URL and SHA-256, so a later edit cannot inherit approval of an earlier output.
- Restrict uploaded media demuxers and protocols at decode/probe time. A DASH playlist disguised as MP4 can otherwise reference a file outside uploads despite a safe top-level path; executable regression tests exercise the escape and all 11 allowed formats.
- Use a distinct `HOST_AGENT_BRIDGE_URL` Compose override so host loopback configuration cannot redirect container traffic to itself.
- Migrate consistent read-only SQLite snapshots into new empty volumes with hash/identity checks and explicit non-root ownership. Preserve original data and failed outputs rather than resetting storage.
- Restore episode/workflow snapshots as new current versions with required optimistic concurrency; preserve identity, old snapshots and review records. Episode restoration returns to draft, and comparisons use stable IDs rather than array positions.
- Persist a client idempotency key and normalized request identity before provider submission. Unknown submission outcomes require provider-history inspection; never retry creation automatically. Known provider IDs can resume status polling/import through the recovery action without a new paid request.
- Keep generation output import separate from episode apply. Register probed local assets with SHA-256 and provenance, retain paid candidates after stale edits, and atomically apply only to the intended surviving scene at the supplied current version.
- Bound automatic polling to 30 minutes. Recovery resets the polling window, preserves the provider ID and checks transport/capacity. A changed transport must not reinterpret a request identifier.
- Keep vendor MCP OAuth, Developer REST credentials, official CLI account login and the project-owned MCP bridge distinct. A configured connection or model catalog is weaker evidence than a completed generation/import/apply receipt.
These are the current implementation rationale and boundaries, not historical claims about unrecorded decisions.
