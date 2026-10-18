---
name: conventions
description: Small changes with version and evidence boundaries preserved.
triggers:
  - "conventions"
edges:
  - target: context/stack.md
    condition: when related context is needed
  - target: context/decisions.md
    condition: when related context is needed
grounds_to: []
last_updated: 2026-10-18
---

# Conventions
## Naming
Use explicit channel, episode, topic, template, asset and job identities. Do not overload a title as a unique ID.
## Structure
Keep HTTP validation in server/app.mjs and server/validation.mjs, persistence in server/store.mjs and local media assembly in server/render.mjs. Do not put private operational data in tracked documentation.
## Patterns
Version-bound edits must reconcile conflicts rather than replace newer history. Integration status must distinguish configured, available and successfully exercised. Retain source attribution and uncertainty.
## Verify Checklist
- npm run check for source syntax.
- npm test for runtime behavior.
- npm run test:render for actual FFmpeg integration when media tooling is available.
- Inspect the changed diff for secrets and unsupported completion claims.
- Refresh MEX and Graphify after code changes; lint the wiki after atom edits.
