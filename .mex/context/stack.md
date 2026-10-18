---
name: stack
description: Runtime inventory and dependency constraints.
triggers:
  - "stack"
edges:
  - target: context/architecture.md
    condition: when related context is needed
  - target: context/conventions.md
    condition: when related context is needed
grounds_to: []
last_updated: 2026-10-18
---

# Stack
## Core Technologies
Node.js ECMAScript modules, the native HTTP API and node:sqlite support the service. The browser uses JavaScript, HTML and CSS. FFmpeg handles rendering.
## Key Libraries
There are no npm runtime dependencies in package.json. Native node:crypto, node:fs and node:path support identities, files and boundaries. Development knowledge tools are separate installed CLIs.
## What We Deliberately Do NOT Use
There is no required frontend bundler or database server. No provider API key is embedded in the browser bundle.
## Version Constraints
package.json requires Node >=22.13. Environment checks observed Node 22.17.0, FFmpeg 8.1.1, MEX 0.8.3 and Graphify 0.8.39. Recheck installed versions before using newer documentation flags.
