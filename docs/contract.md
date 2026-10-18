# FrameForge Studio implementation contract

Single Node 22+ HTTP service, built-in node:sqlite, dependency-free browser ES modules. Docker includes ffmpeg + Korean fonts. Durable DATA_DIR stores SQLite, uploads, exports, knowledge. Bind loopback on host, expose via private Tailscale Serve. Repository contains no credentials or private media. New independent production workflow; old Hermes assets remain archived in place.

## HTTP API (JSON unless upload/download)
- GET /api/state -> {channels,episodes,templates,trends,references,jobs,events,integrations,graph:{nodes,edges}}
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
- POST /api/uploads?name=<encoded filename> binary -> {id,name,url,type}; size limit, generated safe name
- GET /api/knowledge -> graph + atoms
- GET /api/health -> {status,...}
- GET /api/integrations -> integration status (no credentials)
- POST /api/commands {message,source?,sessionId?} -> durable command/event
- GET /api/commands -> commands

Entities use UUID id and ISO createdAt/updatedAt. Episode: {id,channelId,title,topic,category,status:'draft'|'review'|'ready',format:'9:16'|'16:9'|'1:1',version,scenes:[{id,title,text,duration:seconds,background:'#hex',assetUrl?,kind:'title'|'video'|'image',layout:'center'|'lower-third'|'split',narration?}],notes}. Job {id,episodeId,status:'queued'|'running'|'completed'|'failed',progress,outputUrl?,error?,createdAt}. Trend {id,keyword,source,url,capturedAt}. Initial templates drama/reenactment/information, no fabricated owned channels; seed one explicitly labeled example workspace channel. History stores full snapshots. Persist channel/episode/topic relationships as OKF atoms and graph on mutation. Authentication via HttpOnly session cookie bootstrapped with secret from local env; implement LOGIN_TOKEN optional and default loopback-only for dev. Host bridge token separately internal.

## UI
Korean professional dark video studio: left channel/sidebar, top navigation (studio/trends/templates/history/knowledge/settings), center portrait preview and timeline scene cards, right editable inspector + agent chat. Functional channel/episode creation, scene text/duration/background/layout edits, reorder/add/delete, save/version, real rendering download, upload, template apply/save, research capture/refresh and reference links, history, graph view, integration honesty, responsive. No inert decorative action buttons.

## Ownership
Backend agent: server/app.mjs, server/store.mjs and server/* except render.mjs/integrations.mjs; tests/api.test.mjs. Root supplies render.mjs/integrations.mjs contracts. Frontend agent: public/* only. Root: integration modules, Docker, scripts, docs, harness, memory, repository deployment and verification.

Renderer interface: export async function renderEpisode(episode,{dataDir,onProgress}) -> {outputUrl,filename}; throws on failure. Integration interface: export async function integrationStatus() -> object; export async function runAgent(agent,message,episode) -> {message,scenes?}; export async function fetchTrends() -> {trends,sources}.
