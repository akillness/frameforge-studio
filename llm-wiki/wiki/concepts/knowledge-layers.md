---
type: Concept
title: Portable production knowledge
description: Raw evidence, curated OKF atoms, code memory and runtime episode data have separate responsibilities.
tags: [okf, mex, graphify, llm-wiki]
timestamp: 2026-10-18T02:30:52.474119+00:00
---

# Portable production knowledge

- `llm-wiki/raw/` retains immutable public source excerpts.
- `llm-wiki/wiki/` contains curated OKF v0.1 Markdown atoms with type, title and description.
- `.mex/` contains repository context and mechanical code-graph grounding.
- `.graphify/` contains a structural code graph and navigable visualization, with extraction provenance.
- Runtime SQLite and generated knowledge files live in ignored application data; they are not automatically public repository content.

Explicit links assert a relationship; surrounding prose explains its meaning. Code graphs do not establish semantic truth, live service health, provider authentication or channel ownership.

The executable production DAG, the build-time code graph and the curated knowledge graph are separate artifacts. A workflow edge expresses execution dependency; a Graphify edge reflects extracted structure; an OKF link connects documented concepts or evidence. The harness release pointer in `harness/manifest.json` selects immutable role/workflow contracts, and prior active bundles are archived without rewriting their contents.

This design implements [[wiki/sources/product-brief]] for [[wiki/entities/frameforge-studio]]. [[wiki/reports/knowledge-bootstrap]] records actual setup evidence.
