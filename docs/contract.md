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
- POST /api/episodes/:id/chat {agent:'studio'|'codex'|'jeo'|'jeopi'|'hermes',message} -> {message,episode?,job?}; studio is clearly labeled deterministic storyboard assistant; others actual host bridge or explicit unavailable, never mock success
- POST /api/episodes/:id/render -> job; actual FFmpeg async MP4, polls state jobs, exposes /api/exports/:filename
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

## Production and review invariants

Workflow nodes are `{id,type,x,y,config}`; edges are `{id,source,target}`. A validated forward DAG has 4–6 unique stage types: optional trend/research and required script/storyboard/render/review, with every node connected to review. Script config is `{agent,prompt?}`; agent is `existing`, `studio`, `codex`, `jeo`, `jeopi` or `hermes`. `existing` preserves the saved scene/audio snapshot and returns mode `saved`; it is not a chat agent or a model call. Storyboard still increments the episode version. Generative modes may replace scenes. Each run retains its workflow snapshot, episode snapshot and per-node state/output; review initially stops at `awaiting_review`.

Narration requires the current `expectedVersion`, a discovered installed voice ID, optional unique existing `sceneIds` and integer rate −10 to 10 (default 0). Selected scenes use narration text or fall back to caption text. On success generated WAV metadata, scene audio URLs, any needed duration extension, status `draft` and a new episode history version commit together. The job records `resultVersion` and `audioUrls`. Failure or concurrent editing prevents partial attachment. Native speech is Windows-only; Linux Docker continues to support uploaded audio and rendering.

Review requires notes as a string of at most 10000 characters and positive integer `expectedEpisodeVersion`. It rejects stale current episodes, nonmatching completed render jobs, missing/changed exports, non-awaiting runs and duplicate decisions. The service hashes the contained artifact and rechecks episode/run/job state transactionally. `run.review` is `{id,decision,notes,reviewedAt,workflowId,workflowVersion,runId,episodeId,episodeVersion,jobId,outputUrl,sha256}`. The decision sets both run and review-node status to `approved` or `changes_requested` and writes durable audit history. The reviewed episode and publication state are not changed. An automated test receipt is not an owner's acceptance; no API here publishes to a channel.

## UI
Korean professional dark video studio: left channel/sidebar, top navigation (studio/trends/templates/history/knowledge/settings), center portrait preview and timeline scene cards, right editable inspector + agent chat. Functional channel/episode creation, scene text/duration/background/layout edits, reorder/add/delete, save/version, real rendering download, upload, template apply/save, research capture/refresh and reference links, history, graph view, integration honesty, responsive. No inert decorative action buttons.

## Ownership
Backend agent: server/app.mjs, server/store.mjs and server/* except render.mjs/integrations.mjs; tests/api.test.mjs. Root supplies render.mjs/integrations.mjs contracts. Frontend agent: public/* only. Root: integration modules, Docker, scripts, docs, harness, memory, repository deployment and verification.

Renderer interface: export async function renderEpisode(episode,{dataDir,onProgress}) -> {outputUrl,filename,sha256}; throws on failure. Integration interface: export async function integrationStatus() -> object; export async function runAgent(agent,message,episode) -> {message,scenes?}; export async function fetchTrends() -> {trends,sources}. Native speech and its queue are implemented in server/narration.mjs with scripts/speech.ps1; the Windows capability is separate from the host LLM bridge.
