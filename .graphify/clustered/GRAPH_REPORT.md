# Graph Report - .  (2026-10-18)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 312 nodes · 424 edges · 32 communities (30 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]

## God Nodes (most connected - your core abstractions)
1. `$()` - 52 edges
2. `handleAction()` - 20 edges
3. `Store` - 15 edges
4. `studioView()` - 11 edges
5. `esc()` - 9 edges
6. `renderView()` - 9 edges
7. `[Project Name]` - 9 edges
8. `api()` - 8 edges
9. `Inbox CLI workflows` - 8 edges
10. `Relay CLI workflows` - 8 edges

## Surprising Connections (you probably didn't know these)
- `parseResult()` --calls--> `scenes()`  [EXTRACTED]
  scripts/agent-bridge.mjs → server/validation.mjs
- `run()` --calls--> `execute()`  [EXTRACTED]
  scripts/agent-bridge.mjs → server/process.mjs
- `fixture()` --calls--> `createApp()`  [EXTRACTED]
  tests/api.test.mjs → server/app.mjs
- `readJson()` --calls--> `object()`  [EXTRACTED]
  server/app.mjs → server/validation.mjs
- `renderEpisode()` --calls--> `execute()`  [EXTRACTED]
  server/render.mjs → server/process.mjs

## Import Cycles
- None detected.

## Communities (32 total, 2 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.10
Nodes (49): $(), activeChannel(), api(), audioInspectorHtml(), categories, categoryNames, categoryOptions(), chatHtml() (+41 more)

### Community 1 - "Community 1"
Cohesion: 0.12
Nodes (19): createApp(), digest(), MEDIA_EXTENSIONS, MIME, PUBLIC_DIR, readJson(), safeEqual(), starterScene() (+11 more)

### Community 2 - "Community 2"
Cohesion: 0.16
Nodes (14): availability(), parseResult(), root, run(), sceneSchema, schema, verified, dataDir (+6 more)

### Community 3 - "Community 3"
Cohesion: 0.29
Nodes (3): entity(), now(), Store

### Community 4 - "Community 4"
Cohesion: 0.14
Nodes (13): Category 1 — Common task patterns, Category 2 — Integration patterns, Category 3 — Debug/diagnosis patterns, Category 4 — Deploy/release patterns, Format, How many patterns to generate, How patterns get created, Multi-section pattern (one file = multiple related tasks) (+5 more)

### Community 5 - "Community 5"
Cohesion: 0.15
Nodes (12): engines, node, name, private, scripts, bridge, check, start (+4 more)

### Community 6 - "Community 6"
Cohesion: 0.20
Nodes (9): Add only nodes that embody the documented convention; do not ground examples broadly., Conventions, fingerprint: "mh:64:<hex>", grounds_to:, Naming, - node: "function:<tier-1-id>", Patterns, Structure (+1 more)

### Community 7 - "Community 7"
Cohesion: 0.20
Nodes (9): Agent Logging, Code Graph, Commands, MEX context policy, Navigation, Non-Negotiables, [Project Name], Scaffold Growth (+1 more)

### Community 8 - "Community 8"
Cohesion: 0.22
Nodes (8): Delete a local draft, Resolve only the needed contract, Save a checkout-local draft, Find existing knowledge and resolve a correction, Inbox CLI workflows, Publish a draft, Resolve a legacy Spec update, Review canonical proposals

### Community 9 - "Community 9"
Cohesion: 0.22
Nodes (8): Delete a local draft, Resolve only the needed contract, Save a checkout-local draft, Choose an audience and optional context, Close a Relay, Publish a Relay, Relay CLI workflows, Take a Relay

### Community 10 - "Community 10"
Cohesion: 0.22
Nodes (8): Common Commands, Common Issues, Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }, Environment Variables, First-time Setup, Ground only setup behavior implemented by specific code symbols., Prerequisites, Setup

### Community 11 - "Community 11"
Cohesion: 0.33
Nodes (7): agentNames, bridge(), bridgeUrl(), fetchTrends(), integrationStatus(), parseTrendRss(), runAgent()

### Community 12 - "Community 12"
Cohesion: 0.25
Nodes (7): Core Responsibilities, Error Handling, Input Protocol, Operational Principles, Output Protocol, Production director, Team Communication

### Community 13 - "Community 13"
Cohesion: 0.25
Nodes (7): Core Responsibilities, Error Handling, Input Protocol, Operational Principles, Output Protocol, Production editor, Team Communication

### Community 14 - "Community 14"
Cohesion: 0.25
Nodes (7): Core Responsibilities, Error Handling, Input Protocol, Operational Principles, Output Protocol, Production researcher, Team Communication

### Community 15 - "Community 15"
Cohesion: 0.25
Nodes (7): Core Responsibilities, Error Handling, Input Protocol, Operational Principles, Output Protocol, Production reviewer, Team Communication

### Community 16 - "Community 16"
Cohesion: 0.25
Nodes (7): Core Responsibilities, Error Handling, Input Protocol, Operational Principles, Output Protocol, Production supervisor, Team Communication

### Community 17 - "Community 17"
Cohesion: 0.25
Nodes (7): Architecture, Broad overview: keep this empty unless a claim depends on a few specific symbols., Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }, External Dependencies, Key Components, System Overview, What Does NOT Exist Here

### Community 18 - "Community 18"
Cohesion: 0.25
Nodes (7): Broad inventory: ground only claims embodied by a small number of symbols., Core Technologies, Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }, Key Libraries, Stack, Version Constraints, What We Deliberately Do NOT Use

### Community 19 - "Community 19"
Cohesion: 0.25
Nodes (7): After Setup, Detecting Your State, Keeping It Fresh, Option A — Existing Codebase, Option B — Fresh Project, Recommended: Use `mex setup`, Setup — Populate This Scaffold

### Community 20 - "Community 20"
Cohesion: 0.33
Nodes (5): Acceptance scenarios, Durable memory, Production harness, Roles and handoffs, Runtime boundary

### Community 21 - "Community 21"
Cohesion: 0.33
Nodes (5): Apply the approval policy, Keep the scope honest, MEX Inbox, Prepare a draft, Report effects precisely

### Community 22 - "Community 22"
Cohesion: 0.33
Nodes (5): Best practices, Examples, Instructions, Production orchestrator, When to use this skill

### Community 23 - "Community 23"
Cohesion: 0.40
Nodes (4): Decision Log, Decisions, Decisions usually ground sparsely; add only symbols that implement the decision., Entry shape: { node: "function:<tier-1-id>", fingerprint: "mh:64:<hex>" }

### Community 24 - "Community 24"
Cohesion: 0.40
Nodes (4): FrameForge Studio implementation contract, HTTP API (JSON unless upload/download), Ownership, UI

### Community 25 - "Community 25"
Cohesion: 0.40
Nodes (4): Apply the approval policy, MEX Relay, Prepare a Relay draft, Preserve lifecycle meaning

### Community 26 - "Community 26"
Cohesion: 0.40
Nodes (4): Behavioural Contract, Current Project State, Routing Table, Session Bootstrap

### Community 27 - "Community 27"
Cohesion: 0.40
Nodes (4): Manual Resync, Quick Check, Recommended: Use `mex sync`, Sync — Realign This Scaffold

## Knowledge Gaps
- **155 isolated node(s):** `name`, `version`, `private`, `type`, `node` (+150 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Store` connect `Community 3` to `Community 1`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Why does `scenes()` connect `Community 1` to `Community 2`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _155 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.09803921568627451 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.12315270935960591 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._