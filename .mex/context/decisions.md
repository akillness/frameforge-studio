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
- Persist a client request ID and normalized request identity before provider submission; Developer REST additionally sends persisted `generationJobs.id` as `Idempotency-Key`. This header does not authorize automatic replay: ambiguous submission still requires provider-history inspection. Known provider IDs can resume polling/import without a new paid request.
- Keep generation import and atomic episode apply as distinct operations so stale edits preserve paid candidates. A confirmed full generation workflow invokes version-checked apply before render; retained/recovered outputs require explicit Apply to the intended surviving scene at the current version. Describe these paths separately rather than promising manual Apply for every workflow.
- Bound automatic polling to 30 minutes. Recovery resets the polling window, preserves the provider ID and checks transport/capacity. A changed transport must not reinterpret a request identifier.
- Keep vendor MCP OAuth, Developer REST credentials, official CLI account login and the project-owned MCP bridge distinct. A configured connection or model catalog is weaker evidence than a completed generation/import/apply receipt.
- Reuse the workflow inspector for the Studio CTA. Preserve the saved graph and create an unsaved `script(existing) -> storyboard -> generate -> render -> review` draft when needed, so merely opening generation cannot save, run, spend or replace edited scene content. Track the live selected scene by stable ID; reorders update its index and deletion blocks quoting/running.
- Quote exact model/prompt/parameters immediately before paid confirmation using the official REST estimate endpoint; if unavailable, require explicit no-quote acknowledgement. Pass quoted workflow/episode versions through optional run guards, rejecting stale 409 before creating a run, so cross-tab edits cannot silently change the consented input.
- Apply the white design to all seven existing views through the shared shell rather than introducing a second editor. Source design/API facts in `artifacts/white-studio-research.json`; keep configured status weaker than verified authentication/availability, and local fixtures weaker than live-provider proof. The 1.4.0 harness bundle remains immutable and unchanged.
- Keep personal workspace layout client-owned: presets, bounded numeric dimensions, pointer/keyboard resizing and named profiles persist in browser storage only, so layout changes never mutate server episode/workflow data. Native dialog overlays move the existing inspector, narration and assistant panels; assistant unsent drafts remain episode-scoped transient state while inspector edits remain scene-scoped.
These are the current implementation rationale and boundaries, not historical claims about unrecorded decisions.
