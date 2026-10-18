---
type: Concept
title: Versioned channel production
description: Channel identity, topic evidence, episode versions and rendered candidates must remain traceable across edits.
tags: [channels, episodes, provenance]
timestamp: 2026-10-18T03:43:14.648136+00:00
---

# Versioned channel production

The production contract associates each episode with a channel and a topic. Each edit creates a new episode version; a render candidate belongs to the exact version it used. Source observations, original treatment, editorial changes and review evidence are distinct records.

The implementation entry is [the Store module](../../../server/store.mjs). Its current version must be re-read before relying on a past description. The [production harness](../../../docs/harness.md) specifies the role handoffs. The contract follows [[wiki/sources/product-brief]] and belongs to [[wiki/entities/frameforge-studio]].

An MP4 existing locally proves neither factual correctness nor publication. A public upload requires its own authenticated platform readback.

The executable graph in [workflows.mjs](../../../server/workflows.mjs) snapshots both the selected workflow version and episode version at run creation. Its typed stages are trend, research, script, storyboard, render and review. The required script → storyboard → render → review dependency chain ends at `awaiting_review`; this is a request for review, not a creative-quality pass. Per-node output and failure history provide execution provenance. Cancellation stops subsequent stages and does not promise to terminate an already-running external request.

Narration jobs snapshot the input episode version and attach generated WAV uploads with one new history version only if it remains current. Concurrent edits cause rejection and cleanup instead of replacing newer scenes. Explicit review decisions persist the exact episode version, render job, output URL and SHA-256. An automated smoke-test decision tests this binding; it is not an owner's editorial approval. The [production receipt](../../../artifacts/production-smoke.json) demonstrates both paths with native Korean speech and an audible MP4.
