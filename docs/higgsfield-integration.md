# Higgsfield generation connections

FrameForge separates three provider surfaces so account access, billing, and saved episode history remain explicit.

| Connection | Credential boundary | Implementation and verification |
| --- | --- | --- |
| Higgsfield official MCP | Higgsfield OAuth managed by the MCP client | Project `.mcp.json` registers `https://mcp.higgsfield.ai/mcp`. Unauthenticated discovery returned HTTP 401 with OAuth metadata on 2026-10-18. OAuth approval and authenticated tool discovery remain pending. |
| Higgsfield Developer API | Complete copied credential in server-only `HF_API_KEY`, or `HF_CREDENTIALS` | `server/higgsfield.mjs` sends `Authorization: Key <credential>` to the fixed official API origin. Contract tests verify submission, status and safe failures. No Developer API credential was available during this implementation. |
| Higgsfield official CLI | Existing host CLI account login; credentials remain with the CLI | The authenticated host bridge invokes the installed official native binary with argument arrays. Live discovery returned 108 models. Actual project MCP submission produced a 1080×1920, 4.042-second Seedance 2.5 video, imported/applied it and rendered MP4 in Docker. See `artifacts/higgsfield-live-smoke.json`. This is a distinct account/transport from Developer API authentication. |

The official MCP endpoint and account distinction are documented in the [Higgsfield MCP help page](https://higgsfield.ai/creator-hub/help-center/integrations/what-is-higgsfield-mcp). Developer API request/authentication guidance is in the [official quick start](https://open.higgsfield.ai/quick-start). A configured key is not proof of successful authentication or generation.

## Project MCP and official MCP

The project configuration contains two deliberately separate server names:

- `higgsfield-official` connects directly to the vendor's hosted MCP. Use an MCP client with OAuth support to authorize the connection. The repository contains no OAuth tokens, static authorization headers, or copied CLI credentials. Official remote tool names are discovered after authentication; they are not guessed here.
- `frameforge-higgsfield` is the project-owned stdio bridge in `scripts/higgsfield-mcp.mjs`. It calls FrameForge's authenticated HTTP API so generation keeps episode identity, the expected version, an idempotency request ID, and a separate apply action. It is not the vendor's official MCP server.

Run the project MCP client from the repository root. The local server command uses Node's `--env-file=.env`; `.env` remains ignored. It reads `FRAMEFORGE_TOKEN` or the existing `LOGIN_TOKEN`. `FRAMEFORGE_URL` defaults to `http://127.0.0.1:4310`; remote URLs require HTTPS. No provider credentials are returned through MCP tools.

The project bridge exposes `higgsfield_models`, `higgsfield_create`, `higgsfield_status`, `higgsfield_recover`, and `higgsfield_apply`. Generation requires `episodeId`, `sceneId`, `expectedVersion`, `model`, `prompt`, and `requestId`. Preserve the same request ID when checking/recovering an uncertain submission. Recover takes the local `generationId` and resumes polling/import only when its provider request ID is known; it never submits a new generation. Apply requires the current episode version and never silently replaces newer edits. The bridge logs in through `/api/login`, caches the session cookie, and automatically reauthenticates only read requests. Generation, recover, and apply POSTs are never automatically replayed.

An agent using the official remote MCP can create assets directly in the Higgsfield account. Such an external creation does not automatically establish FrameForge episode lineage. Use the project bridge for jobs that must enter the production queue and history. Never claim that merely adding `.mcp.json` completed OAuth or verified vendor tools.

## API and model contracts

The direct API adapter currently has one verified model mapping: `bytedance/seedance-2.5/text-to-video`, supported by its [model-specific API reference](https://open.higgsfield.ai/models/bytedance/seedance-2.5/text-to-video/api-reference). It validates duration 4–30 seconds, documented resolutions/aspect ratios, output format, and audio flag. CLI IDs such as `seedance_2_5` are not interchangeable with API model paths.

The CLI transport discovers the complete live catalog and fetches each selected model's live schema. This first integration accepts prompt-only scalar parameters; reference uploads, character/voice references, and batch generation require separate ownership and input handling. Unsupported inputs fail before submission. The full catalog remains discoverable; listing a model is not a claim that every advanced operation is supported by the editor.

No generation POST is automatically retried. Timeouts and unreadable submission receipts become an unknown submission state that requires inspection of the existing provider job. Polling uses stored provider IDs and never creates another job. Returned media is imported through an exact-host HTTPS allowlist, public DNS pinning, bounded size/time, and local media validation. Additional provider CDN hosts must be verified and deliberately added rather than allowing arbitrary remote downloads.

## Browser video compatibility and original preservation

The live Seedance output was HEVC 10-bit (`hevc`, `yuv420p10le`). Chromium advanced its media clock without decoding video frames. A moving clock alone is not a playback pass: browser verification now requires decoded video dimensions and a visible frame.

Import converts incompatible video to H.264 8-bit / AAC MP4 for the editor, using bounded local FFmpeg execution. The original registered upload and its SHA-256 remain intact. The browser candidate records `original` provenance, and the knowledge graph links the candidate, source asset, generation and episode.

For an already imported completed job, `POST /api/generations/:id/normalize` performs local conversion without provider requests. It preserves prior application receipts and leaves the episode untouched. Apply the new candidate separately using the current episode version. Repeating normalization on a compatible candidate is a no-op. A failed conversion cannot remove the original or silently replace an episode.

## Observed MCP discovery

On 2026-10-18 a read-only unauthenticated `initialize` POST to the official endpoint returned HTTP 401 with `resource_metadata=https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp` and scopes `openid email offline_access`. The public metadata returned HTTP 200, identified `https://clerk.higgsfield.ai` as the authorization server, and advertised authorization-code PKCE. No access token was read, no OAuth account was authorized, and no generation was submitted by this probe.

The project-owned MCP was separately verified with a real stdio subprocess: initialize, initialized notification, and tools/list produced valid newline-delimited JSON-RPC without provider calls. This does not prove official remote OAuth access.

## Static dependency review

ECC MCP dependency review found no package runner, mutable package selector, or downloaded executable in `.mcp.json`. The remote official URL is a managed service, and the local Node script is reviewed repository code; neither is an immutable external service version guarantee. The static configuration review executed no MCP server. Runtime protocol tests above are separate evidence. Global MCP settings and shared skill catalogs were not changed.
