# FrameForge Media & Publication Integration Discovery

**Target:** Exact existing surfaces and safe new adapter/data/API seams for Commons-licensed video/stills + original text card fallback, channel-bound resumable publication, and OAuth/Data API state machine boundaries.

**Status:** READ-ONLY discovery. No edits, credentials, external traffic, or project-wide commands authorized.

---

## EXISTING SURFACES MAP

### 1. Platform Session (server/platform-session.mjs, 436 lines)

**Class:** `PlatformSessionManager`

**Key Methods:**
- `openSession(raw)` (lines 211–340): Creates persistent-chromium browser session, stages server export verification, binds episode + channel context
- `interact(id, body)` (lines 341–436): Browser automation dispatcher; actions: `navigate`, `input`, `click`, `key`, `scroll`, `attach-export`, `update-metadata`, `refresh`
- `verifyServerExport(url, options)` (lines 149–176): SHA256 hash integrity, file-size validation, path containment
- `findReview(job)` (lines 140–147): Finds approved workflow-run matching exact job ID + episode version + sha256
- `screenshot(sessionId)` (lines 422–430): PNG screenshot for UI feedback
- `close()` (lines 432–436): Graceful browser context cleanup

**Session State (lines 262–280):**
```js
{
  id: sessionId,
  channelId, channelName, channelExternalId, accountEmail,
  episodeId,
  platform: 'youtube' | 'tiktok' | 'instagram' | 'other',
  url, status: 'active' | 'closed',
  browser: { available, headless, viewport },
  attachmentStatus: 'none' | 'staged' | 'attached',
  uploadStatus: 'idle' | 'staged' | 'attached',
  uploadProgress: 0–100,
  attachedExport: { filename, exportUrl, size, sha256, jobId, episodeId, episodeVersion, attachedAt },
  publicationStatus: 'not_attempted' | (unspecified),
  review: { required, approved, decision, runId },
  metadata: { title, description, visibility: 'private' | 'unlisted' | 'public' },
  logs: string[],
  createdAt, updatedAt
}
```

**CRITICAL SAFETY RISK — TOS VIOLATION:**
- **Line 407–421:** `attach-export` action uses Playwright `.setInputFiles()` to automate file input to browser
- **app.mjs line 375:** `await platformSessions.interact()` route is currently live
- **PW-07 Decision (decisions.md line 84):** "This existing browser automation is a Terms-of-Service risk, not an approved upload implementation. Do not exercise or extend it for automated YouTube delivery; remove/disable the automated attach/click path during the real cutover."
- **Mitigation:** Delete `attach-export` and `upload` actions; keep `update-metadata`; preserve Studio handoff as user-operated

**Existing Routes (app.mjs lines 337–457):**
- `GET /api/platform-sessions` → `listSessions()`
- `POST /api/platform-sessions` → `openSession(body)`
- `POST /api/platform-sessions/{id}/interact` → `interact(id, body)`
- `GET /api/platform-sessions/{id}/screenshot` → PNG bytes

---

### 2. Media Validation & Input Safety (server/validation.mjs, 262 lines)

**Schema Validations:**
- `scenes(value)` (lines 211–249): Scene array structure validation
  - Fields: `id`, `title`, `text`, `duration`, `background`, `assetUrl`, `audioUrl`, `audioVolume`, `trimStart`, `kind`, `layout`, `narration`
  - **MISSING:** `sourceUrl`, `license`, `attribution`, `retrievedAt`, `trimRange`, `sourceType`
  - Asset URL binding: `validateAssets()` in app.mjs (lines 182–206) checks upload existence and media-type matching
- `createPresetSlots(preset, scene)` (lines 119–209): Slot composition for layouts
- `slotRoles` (line 40): `['image-gen', 'video-bg', 'text-overlay', 'subtitle-layer', 'html-overlay']`
- `layouts` (line 39): `['center', 'lower-third', 'split', 'top-image-mid-video', 'premiere-3tier', 'custom']`

**Seam for Source Fields (Required Addition):**
```ts
// NEW: In validation.mjs, extend sceneSlots or add sourceMetadata validator
export function sourceMetadata(value) {
  if (!value) return undefined;
  return {
    sourceUrl: value.sourceUrl ? url(value.sourceUrl) : undefined,
    sourceType: choice(value.sourceType, ['uploaded', 'search', 'rss', 'og:image', 'generated', 'fallback-text'], 'sourceType'),
    license: optionalText(value.license, 'license', 200),
    attribution: optionalText(value.attribution, 'attribution', 500),
    retrievedAt: value.retrievedAt ? new Date(value.retrievedAt).toISOString() : undefined,
    trimRange: value.trimRange ? { start: Number(value.trimRange.start) || 0, end: Number(value.trimRange.end) || 0 } : undefined,
  };
}
```

---

### 3. Media Import & Probe (server/generations.mjs, top 30 lines + GenerationQueue)

**Machinery (generations.mjs lines 18–30):**

```js
async function fileHash(filename)
  // SHA256 stream-based hashing for local uploads
  
async function probeGenerationAsset(filename, contentType)
  // FFprobe metadata extraction with strict bounds checking
  // Input: filename (local path), contentType (MIME)
  // Returns: { kind, width, height, codecName, pixelFormat, duration?, audioCodec? }
  // Bounds: 1–16384px; video duration 0–1800s; codec validation h264/yuv420p/aac
  // SAFETY: Restricted to local media only; remote URLs never reach FFprobe
```

**Upload Handler (app.mjs lines 256–290):**
```js
async function upload(request, requestUrl) {
  // Input: Binary stream + ?name=filename query param
  // Validation: Safe filename, no path separators, reserved-name rejection
  // Max: 100 MiB
  // Storage: store.dataDir/uploads/{uuid}.{ext}
  // Record: store.save('uploads', { id, createdAt, updatedAt, name, type, size, filename, url })
  // Media type: Derived from extension via MIME map
  
  // MISSING: source URL, license, attribution, retrieval metadata
}
```

**Supported Formats (render.mjs lines 8–13):**
```js
MEDIA_FORMATS = {
  '.mp4': 'mov', '.mov': 'mov', '.webm': 'matroska,webm',  // video
  '.png': 'png_pipe', '.jpg': 'jpeg_pipe', '.jpeg': 'jpeg_pipe',  // image
  '.webp': 'webp_pipe', '.gif': 'gif',
  '.mp3': 'mp3', '.wav': 'wav', '.ogg': 'ogg',  // audio
}
```

**Playlist Attack Prevention (render.mjs lines 17–21):**
```js
export function localMediaInputOptions(filename)
  // FFmpeg: -protocol_whitelist file -format_whitelist {formats}
  // PREVENTS: DASH/M3U8 playlists disguised as MP4 referencing files outside uploads
  // APPLIED TO: Every untrusted input including audio probe
```

---

### 4. Workflow & Review Model (server/workflows.mjs, 900+ lines)

**Workflow Types (line 8):**
```js
TYPES = ['trend', 'news', 'research', 'script', 'storyboard', 'layout', 'generate', 'render', 'review', 'publish']
```

**Current Validation Constraints (lines 56–160):**
- **One node per type** (line 108): `if (types.has(type)) throw` duplicate-type error
- **Max 45 edges** (line 105): Bounded DAG
- **Node coordinate bounds:** ±100,000 (line 100)
- **Required for render:** All scenes must have valid assetUrl or kind='title'

**CRITICAL GAP FOR PW-02 (Repeated Roles):**
- Current: Only one `generate` node allowed
- Required: Multiple `generate` nodes per workflow, each with unique ID and bound scene
- **Risk:** PW-02 requires per-node job identity, dependency tracking, partial resume support
- **Boundary:** Need to extend to 128 nodes, 256 edges, repeated role types

**Review Model (workflows.mjs review() method):**
```ts
workflow.review(workflowId, runId, {
  decision: 'approved' | 'changes_requested',
  notes: string (max 10000),
  expectedEpisodeVersion: integer
})
// Binds: run.review = {
//   id, decision, notes, reviewedAt,
//   workflowId, workflowVersion, runId,
//   episodeId, episodeVersion,
//   jobId, outputUrl, sha256
// }
```

**MISSING Publication Fields:**
- No `made_for_kids` decision binding
- No `contains_synthetic_media` flag
- No `disclosure_decision` (AI-use transparency requirement)
- No channel-binding validation (line 566–578 allows fallback to first channel)

---

### 5. Store & Persistence (server/store.mjs, 593 lines)

**Entity Schema:**
```js
entity(fields) → { id: UUID, createdAt: ISO, updatedAt: ISO, ...fields }

// Current tables:
channels, episodes, templates, references, trends, 
jobs, narrationJobs, uploads, generationJobs, 
workflows, workflowRuns, platformSessions, commands, events, ...

// MISSING:
sourceMetadata, publicationApprovals, youtubeTokens (encrypted)
```

**Upload Record (current):**
```ts
{
  id: UUID,
  createdAt, updatedAt,
  name: string,
  type: 'video/mp4' | 'image/png' | etc,
  size: number,
  filename: 'uuid.ext',
  url: '/api/uploads/{filename}'
  // MISSING: sourceUrl, license, attribution, retrievedAt
}
```

**Jobs Table (existing):**
```ts
{
  id, episodeId, episodeVersion,
  status: 'queued' | 'running' | 'completed' | 'failed',
  progress: 0–100,
  outputUrl, sha256, error,
  createdAt, updatedAt
  // MISSING: approvalManifest, quoteJson, sourceType, sceneTrimRange
}
```

---

### 6. Integration Status (server/integrations.mjs, 61 lines)

**Available Integrations:**
```js
integrationStatus() → {
  studio: { available: true, status: 'available', detail: '규칙 기반 스토리보드 도우미 · LLM 아님' },
  codex: { available: ?, status: 'unavailable' | 'available', ... },
  jeo, jeopi, hermes: Same pattern,
  google: { available: true, status: 'configured', detail: 'Google Trends KR RSS' },
  naver: { available: false, status: 'manual', ... },
  youtube: { available: false, status: 'manual', detail: '채널 ID 연결 및 제작 관리. 게시 작업은 YouTube Studio에서 검수 후 실행' },
}
```

**Bridge Configuration (lines 4–6):**
```js
const bridgeUrl = () => process.env.AGENT_BRIDGE_URL || 'http://127.0.0.1:4311'
// SAFETY: Requires AGENT_BRIDGE_TOKEN for authentication
// RISK: No OAuth integration yet; manual channel/token setup required
```

---

## PUBLICATION/DELIVERY WORKFLOW BOUNDARIES

### Current Flow (PW-07 Status: Interview Requirements Only)

```
1. Episode editing (scenes + assets)
   ↓
2. Render job (FFmpeg → MP4 export)
   ↓
3. Workflow review (human approval on exact job hash)
   ↓
4. Platform session creation
   ├─ Stage server export artifact
   ├─ Launch persistent Chromium
   ├─ Navigate to platform URL
   └─ Manual: user clicks upload & handles auth
   ↓
5. [MISSING] YouTube API integration
   ├─ OAuth token exchange
   ├─ videos.insert() with privacy=private
   ├─ Verify returned video ID & processing
   ├─ videos.update() to public
   └─ Read-back confirmation
```

### Required OAuth/Data API State Machine

**Endpoints (NEW):**
```
POST /api/youtube/authorize
  → Initiates Google OAuth consent flow
  → Returns authorizationUrl + state token

POST /api/youtube/callback
  → Receives {code, state}
  → Exchanges for access_token (+ refresh_token if first time)
  → Stores encrypted token in database
  → Returns {authorized: true, channelId, ...}

POST /api/episodes/{id}/upload
  → Input: { channelId, metadata: {title, description, ...}, approvalManifest }
  → Calls videos.insert(privacyStatus='private')
  → Stores {videoId, uploadJobId, status: 'private'}
  → Returns {videoId, uploadUrl, status}

POST /api/episodes/{id}/publish
  → Input: { videoId, approvalManifest }
  → Reads back current video state via videos.list()
  → Calls videos.update(privacyStatus='public')
  → Verifies final state
  → Returns {published: true, finalUrl, ...}

GET /api/episodes/{id}/publication-status
  → Returns {videoId, status: 'private'|'public'|'failed', channelId, ...}
```

**Safety Gates (PW-05):**
- ✓ Verify OAuth scopes (`youtube.upload`, `youtube.readonly`)
- ✓ Bind approval manifest to exact: scene hashes, source types, generation inputs, cost
- ✓ Quote exact generation cost before approval (no blind execution)
- ✓ Never auto-retry `videos.insert` on failure (preserve remote video ID)
- ✓ Handle 7-day refresh-token expiry (Testing app non-profile scopes)
- ✓ Reject channel mismatch, unknown IDs, stale versions

---

## TOKEN-PRIVATE STORAGE PATTERNS

### Current (Existing)

**Session Tokens (app.mjs lines 142–160):**
```js
frameforge_session = randomBytes(32).toString('hex')
// Stored in sessions Map: { expiresAt: Date.now() + 24h, role: 'admin' }
// Cookie: HttpOnly, SameSite=Strict, Path=/, Max-Age=86400
// Hashed with HMAC-SHA256 before map lookup
```

**Agent Bridge Token (integrations.mjs line 6):**
```js
process.env.AGENT_BRIDGE_TOKEN  // Required for host agent access
// Passed as Bearer header to AGENT_BRIDGE_URL
```

### Required (NEW for OAuth)

**YouTube OAuth Tokens (NEW in store):**
```ts
youtubeOAuthTokens table: {
  id: UUID,
  channelId: string,
  accessToken: string (encrypted),  // AES-256-GCM with master key
  refreshToken: string (encrypted),  // Same encryption
  expiresAt: ISO timestamp,
  scopes: string[] (snapshot),
  createdAt, updatedAt
}

// Encryption key: process.env.ENCRYPTION_KEY or fallback to KDF(LOGIN_TOKEN)
// Refresh flow: If expiresAt < now(), refresh before API call
// Expiry notification: Surface to user when token < 24h to expiry (7-day Testing app tokens)
```

**Generation Approval Manifest (NEW in jobs):**
```ts
generationJobs: {
  ...existing,
  approvalManifest?: {
    episodeId, episodeVersion,  // Binding to exact state
    sceneIndex, sceneTrimRange,
    model, prompt, parameters,
    costEstimate: { credits, usdEstimate },
    quotedAt: ISO,
    approvedBy: 'admin' (session), approvedAt: ISO,
    disclosureDecision: 'required' | 'not_required',  // For PW-05
    madeForKids: boolean,
    containsSyntheticMedia: boolean,
  }
}
```

---

## INJECTION SEAMS FOR ISOLATED TESTS

### Mockable Dependencies (app.mjs)

**1. Platform Sessions (line 253):**
```js
const platformSessions = injectedPlatformSessions || new PlatformSessionManager({ store, ... })
// Test: Pass `{ injected: MockPlatformSessionManager }` to route handler
```

**2. Generation Provider (line 252):**
```js
const generationProvider = generation || createGenerationProvider()
// Test: Pass `{ generation: { capability: () => {...}, models: () => [...], ... } }`
```

**3. Speech Provider (line 258):**
```js
const speechProvider = speech || createSpeechProvider()
// Test: Pass `{ speech: { listVoices: () => [...] } }`
```

**4. Adapter Bridge (line 115):**
```js
async function adapter() {
  // Returns { fetchTrends, runAgent }
  // Test: Override to return mock implementations
}
```

### Upload Testing (Existing)

**Route:** `POST /api/uploads?name=test-file.mp4`
**Testable:** Binary stream + content-type validation
**Evidence:** tests/api.test.mjs line 353: "uploads use safe generated names and media supports byte ranges"

---

## SOURCES & RIGHTS SCHEMA (REQUIRED ADDITION)

### Scene Extension

```ts
scene: {
  ...existing,
  sourceMetadata?: {
    // SOURCE TRACKING
    sourceUrl: string (HTTP/HTTPS URL),
    sourceType: 'uploaded' | 'search' | 'rss' | 'og:image' | 'generated' | 'fallback-text',
    retrievedAt: ISO,
    
    // RIGHTS & ATTRIBUTION
    license: string ('CC-BY-4.0', 'CC0-1.0', 'proprietary', etc),
    attribution: string (required text to display),
    licensingConfidence: 'verified' | 'inferred' | 'assumed',  // Evidence strength
    
    // TRIMMING (for video)
    trimRange?: { start: seconds, end: seconds },  // For verification
    originalDuration?: seconds,
    
    // FALLBACK BEHAVIOR
    fallbackToText: boolean,  // If image/video unavailable, use text-only card
    textCardFallback: { title, text }  // Backup card content
  }
}
```

### Upload Extension (for source tracking)

```ts
upload: {
  ...existing,
  sourceUrl?: string,  // Where it came from
  license?: string,
  attribution?: string,
  retrievedAt?: ISO,
  importedAs: 'user-upload' | 'searched' | 'rss-thumbnail' | 'og:image',
}
```

---

## UNRESOLVED TECHNICAL RISKS

| Risk | Evidence | Severity | Mitigation Path |
|------|----------|----------|-----------------|
| **Browser Automation ToS** | platform-session.mjs lines 407–421; PW-07 decision | **HIGH** | Delete `attach-export` action; keep `update-metadata`; preserve manual Studio path |
| **No Source/License Schema** | validation.mjs 211–249 lacks sourceUrl/license fields | **MEDIUM** | Add `sourceMetadata` validator; extend upload/scene tables; validate on creation |
| **Multi-Scene Generation** | workflows.mjs line 56 allows 1 generate node only | **HIGH** | Extend to 128 nodes/256 edges; per-node ID binding; per-node job identity |
| **Approval Manifest Missing** | generationJobs lacks approvalManifest; PW-04 requires quote binding | **MEDIUM** | Add approvalManifest table with cost/model/prompt; gate approval before submission |
| **Channel Binding Risk** | workflows.mjs 566–578 fallback to first channel; PW-05 requires explicit binding | **MEDIUM** | Validate channel on publish; reject mismatches; remove fallback logic |
| **YouTube API Unimplemented** | No OAuth token storage, no videos.insert/update, no read-back | **CRITICAL** | Implement full state machine; verify scopes; handle token refresh; test mock |
| **No Artifact Hash Binding** | Job completion doesn't bind to approval decision artifact | **MEDIUM** | Add job.sha256 to approvalManifest; revalidate before publish |
| **Made-for-Kids Undeclared** | No `containsSyntheticMedia`, `madeForKids` fields; PW-05 requires both | **MEDIUM** | Add to approval manifest; include in publish request; set on videos.insert |
| **Token Expiry Handling** | YouTube refresh tokens (Testing app): 7-day expiry unhandled | **MEDIUM** | Surface reconsent UI before expiry; fail gracefully; block publish if expired |
| **Platform Session Lifecycle** | Browser context cleanup on error not fully tested | **LOW** | Add error recovery tests; verify profile dir cleanup |

---

## RECOMMENDED VERIFICATION PATHS

### Already Verified (Existing Tests)

- ✓ `tests/api.test.mjs:353` — uploads use safe generated names + byte-range support
- ✓ `tests/api.test.mjs:473` — uploaded scene audio persists through episode edits
- ✓ `server/render.mjs:17–21` — FFmpeg playlist-attack prevention
- ✓ `server/generations.mjs:20–30` — FFprobe bounds checking (video h264/yuv420p/aac)

### Required for Completion (PW-01 through PW-07)

**PW-01: Workflow Persistence**
- [ ] Browser journey: open → edit scenes → apply template → save → reopen → verify state intact
- [ ] Stage status visible without triggering save/render
- [ ] Unsaved edits preserved across navigation

**PW-02: Repeated Nodes & Partial Resume**
- [ ] Validate 128-node, 256-edge workflow structure
- [ ] Per-node ID binding (not type-based)
- [ ] Partial resume: select exact node ID, execute from that point
- [ ] Duplicate-role edge ordering deterministic

**PW-03: Source Footages & Card Fallback**
- [ ] Import video + trim range persistence
- [ ] License/attribution stored and readable
- [ ] No-footage scenario: create text-only card without image
- [ ] Fallback text card binds no image-upload requirement

**PW-04: Approval Manifest**
- [ ] Quote exact model/prompt/cost before approval
- [ ] Multi-scene generation: separate persistent jobs per scene
- [ ] Approval binds all inputs; stale inputs invalidate approval

**PW-05: YouTube Publication**
- [ ] OAuth scopes verified (youtube.upload + youtube.readonly)
- [ ] Private upload + public transition in same video
- [ ] Manifest: title, description, visibility, madeForKids, containsSyntheticMedia
- [ ] Read-back verification of all fields post-transition
- [ ] Token refresh < 7 days before expiry
- [ ] Failed/uncertain transitions don't create duplicates

**PW-06: Workflow Template Instantiation**
- [ ] Copy template → new project workflow with fresh ID
- [ ] Template metadata preserved (sourceTemplateId, sourceTemplateVersion)
- [ ] Project changes don't edit template
- [ ] Two projects on same template have independent histories

**PW-07: UI & Accessibility**
- [ ] Keyboard navigation across all stage panels
- [ ] Scene selection focus restoration
- [ ] Stage status visible (queued/running/approved/failed)
- [ ] Source/rights/approval state inspectable

---

## SUMMARY: SAFE INTEGRATION SEAMS

### Immediate Cutover Actions (No New Implementation)

1. **Disable Browser Automation Upload** (PW-07)
   - Delete `attach-export` action from platform-session.mjs lines 407–421
   - Delete `upload` action case (currently throws 409)
   - Keep `update-metadata` and `navigate` for manual workflow

2. **Extract Publication Boundaries**
   - Review/approval already bound (findReview + workflow.review)
   - Platform session state ready for manual handoff
   - No breaking changes to export verification

### New Implementation Boundaries

3. **Source Metadata Schema** (PW-03)
   - Extend `sceneMetadata` validator in validation.mjs
   - Add `upload` table fields: sourceUrl, license, attribution, retrievedAt
   - Integrate with card-fallback logic (PW-03)

4. **Workflow Node Extension** (PW-02)
   - Increase limits: 128 nodes, 256 edges
   - Change type-uniqueness constraint to ID-uniqueness
   - Per-node job binding in generations.mjs GenerationQueue

5. **Approval Manifest** (PW-04)
   - New table: `approvalManifest` with model/prompt/cost/approval state
   - Bind in `generationJobs` before submission
   - Gate publish on manifest.approved + version match

6. **YouTube OAuth State Machine** (PW-05)
   - `/api/youtube/authorize` → Google consent
   - `/api/youtube/callback` → token exchange + encrypted storage
   - `/api/episodes/{id}/upload` → videos.insert(privacyStatus=private)
   - `/api/episodes/{id}/publish` → videos.update + read-back verification
   - Token refresh + 7-day expiry handling

7. **Channel Binding Validation** (PW-05/PW-06)
   - Remove fallback-to-first-channel logic
   - Validate channelId on publish; reject unknown IDs
   - Per-project channel ownership in workflow table

---

## NEXT STEPS FOR ENGINEERING

1. **Immediate:** Disable browser automation (delete attach-export action, 30 min)
2. **Phase 1:** Source metadata schema + card fallback (PW-03, 1–2 days)
3. **Phase 2:** Workflow node extension + approval manifest (PW-02/PW-04, 3–5 days)
4. **Phase 3:** YouTube OAuth + publication flow (PW-05, 5–7 days)
5. **Phase 4:** Verification + edge cases (PW-01/PW-06/PW-07, 3–4 days)

---

**Prepared:** 2026-10-25  
**Scope:** Read-only discovery only; no credentials, external traffic, or commits authorized.  
**Contract:** All findings map to existing surfaces or explicit contract boundaries in `.mex/context/decisions.md` (PW-01 through PW-07).
