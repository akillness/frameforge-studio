# FrameForge Studio implementation contract

Single Node 22+ HTTP service, built-in node:sqlite, dependency-free browser ES modules. Docker includes ffmpeg + Korean fonts. Durable DATA_DIR stores SQLite, uploads, exports, knowledge. Bind loopback on host, expose via private Tailscale Serve. Repository contains no credentials or private media. New independent production workflow; old Hermes assets remain archived in place.

## HTTP API (JSON unless upload/download)
- GET /api/state -> {channels,episodes,templates,trends,references,jobs,events,workflows,workflowRuns,narrationJobs,integrations,graph:{nodes,edges}}
- POST /api/channels {name,category,platform,externalId?,accountEmail?} -> channel
- POST /api/episodes {channelId,title,topic,category?} -> episode
- PUT /api/episodes/:id {title?,topic?,status?,scenes?,format?,notes?,expectedVersion?} -> episode (409 stale)
- GET /api/episodes/:id/history -> history array
- POST /api/templates {name,category,format,scenes} -> template
- POST /api/episodes/:id/template {templateId} -> episode
- POST /api/references {channelId?,title,url,category,notes} -> reference
- POST /api/trends/refresh -> {trends,sources}; actual Google RSS fetch, explicit source errors, no invented current ranks
- POST /api/trends {keyword,source,url,category?} -> trend (manual research capture)
- POST /api/episodes/:id/chat {expectedVersion,agent:'studio'|'codex'|'jeo'|'jeopi'|'hermes',message} -> {message,episode?,job?}; `expectedVersion` is required and must match the current active episode version or the request returns 409 without executing. Studio is the clearly labeled deterministic storyboard assistant; other agents use the actual host bridge or return explicit unavailable, never mock success.
- POST /api/episodes/:id/render {expectedVersion} -> 202 job; `expectedVersion` is required and must match the current active episode version or the request returns 409 without enqueueing. Actual FFmpeg async MP4, polls state jobs, exposes /api/exports/:filename.
- GET /api/speech/voices -> {available,provider:'windows-sapi',voices:[{id,name,language}],detail?,local?}; native Windows installed voices only, explicit unavailable on Linux
- POST /api/episodes/:id/narration {voice,expectedVersion,sceneIds?,rate?} -> narration job (202); asynchronous local WAV generation, polls state narrationJobs
- POST /api/uploads?name=<encoded filename> binary -> {id,name,url,type}; size limit, generated safe name
- GET /api/knowledge -> graph + atoms
- GET /api/health -> {status,...}
- GET /api/integrations -> integration status (no credentials)
- POST /api/commands {message,source?,sessionId?} -> durable command/event
- GET /api/commands -> commands
- GET /api/workflows -> workflow array; POST /api/workflows {name,nodes,edges} -> versioned workflow
- PUT /api/workflows/:id {name,nodes,edges,expectedVersion?} -> workflow (409 stale)
- GET /api/workflows/:id/history -> full workflow-version snapshot array
- POST /api/workflows/:id/run {episodeId} -> queued run (202); GET /api/workflows/:id/runs -> durable run array
- POST /api/workflows/:id/runs/:runId/cancel {} -> cancelled run; cooperative cancellation stops later stages
- POST /api/workflows/:id/runs/:runId/review {decision:'approved'|'changes_requested',notes,expectedEpisodeVersion} -> run with durable review receipt; only an exact current awaiting_review candidate may be reviewed

Entities use UUID id and ISO createdAt/updatedAt. Episode: {id,channelId,title,topic,category,status:'draft'|'review'|'ready',format:'9:16'|'16:9'|'1:1',version,scenes:[{id,title,text,duration:seconds,background:'#hex',assetUrl?,kind:'title'|'video'|'image',layout:'center'|'lower-third'|'split',narration?,trimStart,audioUrl?,audioVolume}],notes}. Scene trimStart is 0–36000 seconds (default 0); audioVolume is 0–2 (default 1); audioUrl must reference an uploaded MP3/WAV/OGG. Job {id,episodeId,episodeVersion,status:'queued'|'running'|'completed'|'failed',progress,outputUrl?,sha256?,error?,createdAt}. Trend {id,keyword,source,url,capturedAt}. Initial templates drama/reenactment/information, no fabricated owned channels; seed one explicitly labeled example workspace channel. History stores full snapshots. Persist channel/episode/topic relationships as OKF atoms and graph on mutation. Authentication via HttpOnly session cookie bootstrapped with secret from local env; implement LOGIN_TOKEN optional and default loopback-only for dev. Host bridge token separately internal.

## Single administrator and canonical knowledge editing

`LOGIN_TOKEN` remains the sole administrator credential. Successful login creates a server-side session with role `admin`; request bodies, headers and browser storage cannot assign a role. Existing authenticated API/media reads remain available. Every API mutation passes the central administrator check before parsing or performing work: unauthenticated requests receive 401, authenticated non-admin principals receive 403. Same-origin/CSRF checks still apply. The only unauthenticated mutation is login itself. No-token development retains its loopback Host guard and implicit local admin capability.

`GET /api/session` returns `{authenticated,role,canMutate}` (including an unauthenticated response); `GET /api/state` includes the same `session` object. Graph node/edge metadata describes canonical edit capability independently of the current user's role. The UI requires both admin capability and editable metadata, labels write controls admin-only, and shows derived items as read-only.

| Graph edit | Canonical write and concurrency guard |
| --- | --- |
| Channel label | `channels.name`, required `expectedRecord` fingerprint of the complete current record, compared under `BEGIN IMMEDIATE` |
| Episode label, topic or channel | `episodes.title`, `episodes.topic`, `episodes.channelId`, required positive `expectedVersion`; existing `updateEpisode` snapshot/history/event transaction |
| Episode `belongs_to` channel/topic edge | Change `episodes.channelId` to an existing channel or `episodes.topic` to the selected existing topic's label, with `expectedVersion` |
| Topic, reference, trend, generation, asset nodes and other edges | Read-only; topics are derived from `episode.topic`, and references have no existing safe update/concurrency path |

- `PUT /api/knowledge/nodes/:id` accepts `{label,expectedRecord}` for channels, or `{label?,topic?,channelId?,expectedVersion}` for episodes, and returns `{record,graph}`. Graph metadata exposes the corresponding guard under `node.edit`.
- `PUT /api/knowledge/edges` accepts `{source,target,relation,newTarget,expectedVersion}` and returns `{record,graph}`. Only an existing editable `belongs_to` edge can be retargeted; relation type and source cannot be rewritten.

Unknown fields, unsupported nodes/edges, missing guards and invalid targets receive 400; stale canonical guards receive 409. No graph-only records, create/delete semantics, role accounts, credentials or schema changes are introduced. Canonical changes and their audit events commit together; episode history is in the same transaction. Knowledge JSON and OKF atoms regenerate from canonical state after commit, removing obsolete topic atoms and preserving unrelated records/media. Persisted `graph.json` excludes UI-only `editable`, `edit`, and `readOnlyReason` capability metadata. As in existing store writes, filesystem export is after the SQLite commit; an export failure returns an error and cannot roll back an already committed source record.

The exported pure `requireAdmin(session)` policy helper is the test seam for 403 coverage. Production has no way to issue a non-admin session or override authentication through this seam.

## Production and review invariants

Workflow nodes are `{id,type,x,y,config}`; edges are `{id,source,target}`. A validated forward DAG has 4–6 unique stage types: optional trend/research and required script/storyboard/render/review, with every node connected to review. Script config is `{agent,prompt?}`; agent is `existing`, `studio`, `codex`, `jeo`, `jeopi` or `hermes`. `existing` preserves the saved scene/audio snapshot and returns mode `saved`; it is not a chat agent or a model call. Storyboard still increments the episode version. Generative modes may replace scenes. Each run retains its workflow snapshot, episode snapshot and per-node state/output; review initially stops at `awaiting_review`.

Narration requires the current `expectedVersion`, a discovered installed voice ID, optional unique existing `sceneIds` and integer rate −10 to 10 (default 0). Selected scenes use narration text or fall back to caption text. On success generated WAV metadata, scene audio URLs, any needed duration extension, status `draft` and a new episode history version commit together. The job records `resultVersion` and `audioUrls`. Failure or concurrent editing prevents partial attachment. Native speech is Windows-only; Linux Docker continues to support uploaded audio and rendering.

Review requires notes as a string of at most 10000 characters and positive integer `expectedEpisodeVersion`. It rejects stale current episodes, nonmatching completed render jobs, missing/changed exports, non-awaiting runs and duplicate decisions. The service hashes the contained artifact and rechecks episode/run/job state transactionally. `run.review` is `{id,decision,notes,reviewedAt,workflowId,workflowVersion,runId,episodeId,episodeVersion,jobId,outputUrl,sha256}`. The decision sets both run and review-node status to `approved` or `changes_requested` and writes durable audit history. The reviewed episode and publication state are not changed. An automated test receipt is not an owner's acceptance; no API here publishes to a channel.

## UI
Korean professional dark video studio: left channel/sidebar, top navigation (studio/trends/templates/history/knowledge/settings), center portrait preview and timeline scene cards, right editable inspector + agent chat. Functional channel/episode creation, scene text/duration/background/layout edits, reorder/add/delete, save/version, real rendering download, upload, template apply/save, research capture/refresh and reference links, history, graph view, integration honesty, responsive. No inert decorative action buttons.

## Ownership
Backend agent: server/app.mjs, server/store.mjs and server/* except render.mjs/integrations.mjs; tests/api.test.mjs. Root supplies render.mjs/integrations.mjs contracts. Frontend agent: public/* only. Root: integration modules, Docker, scripts, docs, harness, memory, repository deployment and verification.

Renderer interface: export async function renderEpisode(episode,{dataDir,onProgress}) -> {outputUrl,filename,sha256}; throws on failure. Integration interface: export async function integrationStatus() -> object; export async function runAgent(agent,message,episode) -> {message,scenes?}; export async function fetchTrends() -> {trends,sources}. Native speech and its queue are implemented in server/narration.mjs with scripts/speech.ps1; the Windows capability is separate from the host LLM bridge.

## Agent API and MCP
Function-style workflow and episode operations for agents: `GET /api/agent/operations`, `POST /api/agent/operations/:name` `{arguments}`, `GET /api/agent/openapi.json`, `GET /api/agent/tools?format=mcp|openai|anthropic`, and MCP (revision 2026-07-28) at `POST /mcp` plus `scripts/frameforge-mcp.mjs` over stdio. Bearer `LOGIN_TOKEN` is accepted only on these paths. Every write requires the current `expectedVersion`; review approval, publication and (by default) paid generation are not exposed. See [agent-api.md](agent-api.md) and [mcp.md](mcp.md); the operation reference is generated from `server/agent-ops.mjs`.
