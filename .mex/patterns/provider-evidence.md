---
name: provider-evidence
description: Keep integration configuration separate from actual provider execution.
triggers:
  - "provider-evidence"
edges:
  - target: context/architecture.md
    condition: when related context is needed
  - target: context/conventions.md
    condition: when related context is needed
grounds_to: []
last_updated: 2026-10-18
---

# Provider evidence
## Context
Load context/architecture.md and inspect server/integrations.mjs plus scripts/agent-bridge.mjs before altering provider behavior.
## Steps
1. Read the current reported status.
2. Verify the exact CLI/provider invocation separately from executable discovery.
3. Record timeout, missing authentication or invalid output as a failure.
## Gotchas
Never turn an unavailable provider into a fake success. A deterministic built-in helper is not an LLM.
## Verify
Run the integration tests and a narrowly scoped real invocation where configured.
## Debug
Check bridge reachability and token configuration without printing secret values.
## Update Scaffold
Record new provider boundaries and observed failures in the wiki.
