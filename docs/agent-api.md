# Agent API · 워크플로 조작 함수

에이전트가 FrameForge 워크플로와 에피소드를 **함수처럼 호출**해 결과(MP4, 장면, 실행 상태)를 가져오는 API입니다. REST(`/api/agent/*`)와 MCP 도구(`/mcp`, stdio)는 같은 operation 레지스트리(`server/agent-ops.mjs`)에서 생성되므로 서로 달라질 수 없습니다. MCP 연결은 [mcp.md](mcp.md)를 보세요.

이 문서의 "Operation reference" 구역은 `node scripts/agent-docs.mjs --write`로 레지스트리에서 생성합니다. `--check`는 문서가 오래되면 실패합니다.

## 연결과 인증

| 항목 | 값 |
| --- | --- |
| Base URL | `FRAMEFORGE_URL` (기본 `http://127.0.0.1:4310`, 원격은 HTTPS) |
| 인증 | `Authorization: Bearer <LOGIN_TOKEN>` 또는 기존 `frameforge_session` 쿠키 |
| Bearer 허용 범위 | `/api/agent/*` 와 `/mcp` **만**. 다른 `/api/*` 는 Bearer를 계속 거부합니다. |
| 토큰 없는 개발 서버 | `LOGIN_TOKEN` 이 비어 있으면 loopback 클라이언트만 허용합니다. Docker/Compose는 `LOGIN_TOKEN`이 필수입니다. |
| 인증 실패 제한 | IP당 분당 10회 실패 후 429 |
| 호출 제한 | 조회 분당 300회, 쓰기 분당 60회. 초과 시 429와 `Retry-After` |

토큰은 저장소에 넣지 않습니다. `.env`(Git 제외) 또는 에이전트 호스트의 비밀 저장소를 사용하세요.

## 엔드포인트

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/agent/operations` | 모든 operation의 JSON Schema 카탈로그 `{version, operations[]}` |
| POST | `/api/agent/operations/{name}` | 호출. 본문 `{"arguments": {...}}` |
| GET | `/api/agent/openapi.json` | OpenAPI 3.1 문서(operation마다 POST 경로 하나) |
| GET | `/api/agent/tools?format=mcp\|openai\|anthropic` | LLM function-calling 도구 정의 |

### 응답 규약

성공: HTTP 200 `{"ok": true, "result": { ... }}`. `result`는 해당 operation의 `outputSchema`를 만족하며 서버가 검증합니다.

실패: 같은 HTTP 상태와 함께 `{"ok": false, "error": "<message>", "status": <int>, "code": "<code>", "currentVersion": <int>}` (`code`, `currentVersion`은 해당할 때만). MCP 도구 오류는 `isError: true` 결과의 `content[0].text`에 `{"error": {"status", "code", "message", "currentVersion"}}` JSON을, `_meta["com.frameforge/error"]`에 `{status, code, currentVersion}`을 담습니다. REST와 MCP의 오류 의미는 동일합니다.

| status | code | 의미와 에이전트의 대응 |
| --- | --- | --- |
| 400 | `invalid_arguments` | 입력이 스키마와 다름. 메시지의 경로를 고쳐 다시 호출 |
| 400 | `invalid_graph` | 편집 결과 그래프가 저장 규칙 위반. **아무것도 저장되지 않음**. `dryRun`으로 먼저 확인 |
| 401 | — | 토큰 누락/오류 |
| 403 | `agent_paid_generation_disabled` | 운영자가 에이전트 유료 생성을 켜지 않음. Studio UI에서 실행 |
| 404 | `unknown_operation` 등 | 없는 operation 또는 항목 |
| 409 | `stale_version` | 읽은 버전이 오래됨. 다시 읽고(`currentVersion`이 있으면 그 버전) 변경을 재적용한 뒤 재시도. **재시도 가능** |
| 409 | `stale_quote` | 정확한 입력 견적이 만료되었거나 입력이 바뀜. `workflow_quote`를 다시 받고 사람의 결정을 다시 받은 뒤 재시도 |
| 409 | `conflict` | 그 밖의 충돌(보관된 에피소드, 진행 중인 작업, 선행 조건 누락, 식별 불일치). **같은 요청을 그대로 재시도하면 안 됨**. 상태를 확인하고 원인을 고치거나 사람에게 알림 |
| 429 | — | `Retry-After` 초 후 재시도 |
| 502/503 | `agent_unavailable`, `agent_no_scenes` | 호스트 에이전트 브리지 문제. 가짜 결과를 만들지 않음 |

## 동시성: expectedVersion

모든 쓰기는 읽었던 `version`을 `expectedVersion`으로 보냅니다. 서버는 한 번에 한 버전만 올리고 이전 버전을 이력에 남깁니다. 사람이 Studio에서 같은 워크플로를 편집 중이면 에이전트 쓰기는 409로 거절되거나 사람의 다음 저장이 409를 받습니다. 이 경우 어느 쪽도 조용히 덮어쓰지 않습니다.

## 사람이 하는 단계 (도구가 없음)

- **검토 승인** (`review` 노드): 렌더 결과를 사람이 Studio에서 승인하거나 수정을 요청합니다. 에이전트가 시작한 실행은 `awaiting_review`에서 멈춥니다.
- **게시 승인과 게시**: 에이전트에게 노출하지 않습니다.
- 플랫폼 세션, 업로드 등록, 음악 권리 확인, 블로그 도구도 노출하지 않습니다.

## 유료 생성 정책

`workflow_run_start`가 `generate` 노드를 포함하면 비용이 발생합니다. 기본값은 **에이전트에게 거절(403)** 입니다. 운영자가 서버에 `AGENT_API_ALLOW_PAID_GENERATION=true`를 설정한 경우에만 허용되며, 그때도 기존 계약을 모두 만족해야 합니다.

1. `workflow_quote` (`disclosure` 필수)로 정확한 입력의 견적과 5분 유효한 `generationPlanId`/`fingerprint`를 받습니다. 견적은 비용을 발생시키지 않습니다.
2. 사람이 비용과 합성 미디어 공개 결정을 확인합니다.
3. `workflow_run_start`에 `allowGeneration: true`, 같은 `disclosure`, `generationPlanId`, `generationFingerprint`를 전달합니다. 견적을 받지 못한 노드가 있으면 `acceptUnquotedEstimate: true`가 추가로 필요합니다.

## 권장 흐름

```text
workflow_node_types                      # 노드 종류와 제한 확인
episode_list / workflow_list             # 대상 찾기
workflow_copy_from_template              # 에피소드 전용 워크플로 복사(처음 한 번)
workflow_patch {dryRun:true, ops:[...]}  # 편집 미리보기
workflow_patch {expectedVersion, ops}    # 원자적 적용 → 새 version
workflow_plan                            # 무엇이 실행되는지 무료 확인
workflow_run_start                       # 무료 단계 실행
workflow_run_get (폴링)                  # terminal=true 까지. awaiting_review면 사람이 검토
episode_render → render_job_get (폴링)   # 장면 직접 편집 후 MP4
```

## curl 예시

```sh
export FRAMEFORGE_URL=http://127.0.0.1:4310
export FRAMEFORGE_TOKEN=<LOGIN_TOKEN>
call() { curl -sS -X POST "$FRAMEFORGE_URL/api/agent/operations/$1" \
  -H "Authorization: Bearer $FRAMEFORGE_TOKEN" -H 'Content-Type: application/json' -d "$2"; }

call workflow_node_types '{"arguments":{}}'
call workflow_propose_blueprint '{"arguments":{"topic":"국민연금 개편","style":"news"}}'
call workflow_patch '{"arguments":{"workflowId":"WF","expectedVersion":1,"dryRun":true,"ops":[
  {"op":"addNode","type":"news","id":"news-2","config":{"query":"국민연금"}},
  {"op":"connect","source":"news-2","target":"research"},
  {"op":"autoLayout"}]}}'
```

### workflow_patch 연산

| `op` | 필드 | 설명 |
| --- | --- | --- |
| `rename` | `name` | 워크플로 이름 |
| `addNode` | `type`, `id?`, `x?`, `y?`, `label?`, `notes?`, `config?` | 노드 추가. `id`/좌표를 생략하면 자동 배정 |
| `removeNode` | `id` | 노드와 연결된 간선 제거. 마지막 노드는 제거 불가 |
| `setConfig` | `id`, `config?`, `unset?` | 해당 노드 유형의 허용 필드만 병합/삭제 |
| `setLabel` | `id`, `label?`, `notes?` | 표시 이름/메모 |
| `setPosition` | `id`, `x`, `y` | 좌표 |
| `connect` | `source`, `target`, `id?` | 간선 추가. 자기 연결, 중복, 순환은 거절 |
| `disconnect` | `id` 또는 `source`+`target` | 간선 제거 |
| `autoLayout` | — | 결정적 계층 배치 |
| `replaceGraph` | `nodes`, `edges`, `name?` | 그래프 전체 교체. `workflow_propose_blueprint` 결과 적용용 |

연산은 순서대로 복사본에 적용되고, 마지막에 저장과 같은 검증(`validateWorkflow`: 최대 128노드/256간선, 연결된 DAG, 단계 선행 조건)을 한 번 통과해야 합니다. 중간 상태는 연결이 끊겨도 됩니다.

## 에이전트 SDK 없이 function calling에 연결

```sh
curl -sS -H "Authorization: Bearer $FRAMEFORGE_TOKEN" "$FRAMEFORGE_URL/api/agent/tools?format=openai"     # OpenAI tools
curl -sS -H "Authorization: Bearer $FRAMEFORGE_TOKEN" "$FRAMEFORGE_URL/api/agent/tools?format=anthropic"  # Anthropic tools
```

모델이 반환한 도구 호출의 `name`/`arguments`를 `POST /api/agent/operations/{name}`의 `{"arguments": ...}`로 전달하고, `result` 또는 `error`를 그대로 모델에 돌려주세요.

## 규칙 기반 초안과 AI 초안

`workflow_propose_blueprint`는 **규칙 기반** 시작 그래프만 만듭니다(`engine: "rule-based"`). 모델이 직접 설계한 그래프는 에이전트가 `workflow_patch`로 구성합니다. `episode_propose_storyboard`는 기본이 규칙 기반이며, `agent`를 `codex`/`jeo`/`jeopi`/`hermes`로 지정하면 에피소드 본문을 해당 호스트 에이전트에 보내 그 장면을 반환합니다(`engine: "agent:<name>"`). 두 제안 operation 모두 아무것도 저장하지 않으며, 적용은 `workflow_patch`/`episode_update`로 별도로 합니다.

## 운영 참고

- 실행 상태와 결과의 기준은 `workflow_run_get`/`render_job_get`입니다. 알림 스트림은 제공하지 않으므로 폴링하세요.
- `exportUrl`/`outputUrl`(`/api/exports/<file>.mp4`)은 같은 인증으로 내려받습니다.
- 에이전트가 만든 변경의 이력 사유는 `agent-api`입니다.
- 알려진 한계: 구독/알림, 리소스, MCP Tasks 확장은 지원하지 않습니다. 긴 작업은 위의 폴링 operation을 사용합니다.

## Operation reference

<!-- agent-ops:start -->
<!-- Generated by scripts/agent-docs.mjs from server/agent-ops.mjs (operations 1.0.0). Do not edit by hand. -->

| Operation | Behavior | Summary |
| --- | --- | --- |
| [`episode_create`](#episode_create) | writes (additive) · local only | Create an episode |
| [`episode_get`](#episode_get) | read-only · idempotent · local only | Get an episode with scenes |
| [`episode_list`](#episode_list) | read-only · idempotent · local only | List episodes |
| [`episode_propose_storyboard`](#episode_propose_storyboard) | writes (additive) · contacts external services | Propose scenes for an episode |
| [`episode_render`](#episode_render) | writes (additive) · local only | Render an episode to MP4 |
| [`episode_update`](#episode_update) | writes (may remove or replace data) · local only | Update episode fields or scenes |
| [`render_job_get`](#render_job_get) | read-only · idempotent · local only | Get a render job |
| [`workflow_auto_layout`](#workflow_auto_layout) | writes (additive) · idempotent · local only | Tidy node positions |
| [`workflow_copy_from_template`](#workflow_copy_from_template) | writes (additive) · local only | Create a project workflow from a template |
| [`workflow_get`](#workflow_get) | read-only · idempotent · local only | Get a workflow |
| [`workflow_list`](#workflow_list) | read-only · idempotent · local only | List workflows |
| [`workflow_node_types`](#workflow_node_types) | read-only · idempotent · local only | List workflow node types |
| [`workflow_patch`](#workflow_patch) | writes (may remove or replace data) · local only | Edit a workflow graph atomically |
| [`workflow_plan`](#workflow_plan) | read-only · idempotent · local only | Plan an execution (free) |
| [`workflow_propose_blueprint`](#workflow_propose_blueprint) | read-only · idempotent · local only | Propose a starter workflow graph |
| [`workflow_quote`](#workflow_quote) | writes (additive) · contacts external services | Quote paid generation (no spend) |
| [`workflow_run_cancel`](#workflow_run_cancel) | writes (may remove or replace data) · local only | Cancel a workflow run |
| [`workflow_run_get`](#workflow_run_get) | read-only · idempotent · local only | Get a workflow run |
| [`workflow_run_list`](#workflow_run_list) | read-only · idempotent · local only | List runs of a workflow |
| [`workflow_run_start`](#workflow_run_start) | writes (additive) · contacts external services | Start a workflow run |
| [`workflow_set_skip`](#workflow_set_skip) | writes (additive) · idempotent · local only | Skip or unskip a node |
| [`workflow_validate`](#workflow_validate) | read-only · idempotent · local only | Validate a workflow graph (dry run) |

### episode_create

**Create an episode** — writes (additive) · local only

Creates a draft 9:16 episode with one starter scene under an existing channel.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `channelId` | string | yes |  |
| `title` | string (≤200 chars) | yes |  |
| `topic` | string (≤500 chars) |  |  |
| `category` | string (≤100 chars) |  |  |

Returns: `episode`

### episode_get

**Get an episode with scenes** — read-only · idempotent · local only

Returns the episode summary and its scenes. version is the optimistic-concurrency token for episode_update and episode_render.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `episodeId` | string | yes |  |

Returns: `episode`, `scenes`, `notes`

### episode_list

**List episodes** — read-only · idempotent · local only

Episode summaries (projects). Archived episodes are excluded unless includeArchived is true.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `channelId` | string |  |  |
| `includeArchived` | boolean |  |  |
| `limit` | integer (≥1, ≤100) |  |  |

Returns: `episodes`

### episode_propose_storyboard

**Propose scenes for an episode** — writes (additive) · contacts external services

Drafts scenes for an episode from a brief. engine "rule-based" (agent "studio", default) is an offline template; any other agent sends the episode text to that host agent and returns its scenes. Persists nothing: apply with episode_update using baseVersion as expectedVersion.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `episodeId` | string | yes |  |
| `brief` | string (≤2000 chars) |  |  |
| `sceneCount` | integer (≥3, ≤8) |  |  |
| `tone` | `neutral` \\| `energetic` \\| `calm` |  |  |
| `agent` | `studio` \\| `codex` \\| `jeo` \\| `jeopi` \\| `hermes` |  |  |

Returns: `episodeId`, `baseVersion`, `scenes`, `rationale`, `engine`

### episode_render

**Render an episode to MP4** — writes (additive) · local only

Queues an FFmpeg render of the exact episode version. Returns a job to poll with render_job_get. Rendering is local and free; it does not publish.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `episodeId` | string | yes |  |
| `expectedVersion` | integer (≥1) | yes |  |

Returns: `job`

### episode_update

**Update episode fields or scenes** — writes (may remove or replace data) · local only

Updates title, topic, notes, status, format or the full scenes array under optimistic concurrency. Scenes replace the existing list and may reference only registered uploads. Stale expectedVersion returns 409. Music is not editable through this operation.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `episodeId` | string | yes |  |
| `expectedVersion` | integer (≥1) | yes |  |
| `title` | string (≤200 chars) |  |  |
| `topic` | string (≤500 chars) |  |  |
| `notes` | string (≤20000 chars) |  |  |
| `status` | `draft` \\| `review` \\| `ready` |  |  |
| `format` | `9:16` \\| `16:9` \\| `1:1` |  |  |
| `scenes` | array<object> |  |  |

Returns: `episode`

### render_job_get

**Get a render job** — read-only · idempotent · local only

Progress of an MP4 render started by episode_render. Poll until status is completed or failed; completed jobs carry outputUrl.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `jobId` | string | yes |  |

Returns: `job`

### workflow_auto_layout

**Tidy node positions** — writes (additive) · idempotent · local only

Convenience wrapper over workflow_patch [{op:"autoLayout"}]: deterministic left-to-right layered layout. Changes coordinates only.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflowId` | string | yes |  |
| `expectedVersion` | integer (≥1) | yes |  |

Returns: `version`, `workflow`

### workflow_copy_from_template

**Create a project workflow from a template** — writes (additive) · local only

Copies a template workflow into an independent, versioned workflow owned by one episode and channel. Required before running anything for that episode.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `templateId` | string | yes |  |
| `channelId` | string | yes |  |
| `episodeId` | string | yes |  |
| `expectedTemplateVersion` | integer (≥1) | yes |  |

Returns: `workflow`

### workflow_get

**Get a workflow** — read-only · idempotent · local only

Returns one workflow with nodes, edges, version and skipped nodes. Use its version as expectedVersion for edits.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflowId` | string | yes |  |

Returns: `workflow`

### workflow_list

**List workflows** — read-only · idempotent · local only

Lists workflow summaries. Project workflows belong to one episode; templates (isTemplate) have no episode and are copied per project.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `episodeId` | string |  | Only workflows owned by this episode. |
| `templatesOnly` | boolean |  |  |

Returns: `workflows`

### workflow_node_types

**List workflow node types** — read-only · idempotent · local only

Returns every node type with its allowed config fields, its required upstream stage, graph limits and the patch operations accepted by workflow_patch. Call this first.

_No arguments._

Returns: `types`, `limits`, `patchOps`

### workflow_patch

**Edit a workflow graph atomically** — writes (may remove or replace data) · local only

Applies 1-100 ordered ops (rename, addNode, removeNode, setConfig, setLabel, setPosition, connect, disconnect, autoLayout, replaceGraph) to a copy of the graph, validates the whole result with the same rules as save, then writes one new version. Any invalid op or an invalid final graph rejects everything. Stale expectedVersion returns 409. Use dryRun to preview without writing.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflowId` | string | yes |  |
| `expectedVersion` | integer (≥1) | yes |  |
| `dryRun` | boolean |  |  |
| `ops` | array<object> | yes |  |

Returns: `applied`, `dryRun`, `version`, `stats`, `validation`, `workflow`, `preview`

### workflow_plan

**Plan an execution (free)** — read-only · idempotent · local only

Dry-run plan for running part or all of a project workflow: which nodes would run, be reused, be stale or blocked, and whether paid generation would be required. Never writes and never calls a provider.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflowId` | string | yes |  |
| `episodeId` | string | yes |  |
| `execution` | object | yes |  |
| `expectedWorkflowVersion` | integer (≥1) |  |  |
| `expectedEpisodeVersion` | integer (≥1) |  |  |

Returns: `selectedStages`, `requiresGeneration`, `nothingToRun`, `nodes`

### workflow_propose_blueprint

**Propose a starter workflow graph** — read-only · idempotent · local only

Builds a RULE-BASED starter graph (trend/news → research → script → storyboard → layout → render → human review [→ private upload]) for a topic. Persists nothing; apply it with workflow_patch using a replaceGraph op. For model-written graphs, compose workflow_patch ops yourself.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `topic` | string (≤300 chars) | yes |  |
| `style` | `news` \\| `explainer` \\| `short-hook` |  |  |
| `includeGeneration` | boolean |  |  |
| `includePublish` | boolean |  |  |
| `model` | string (≤160 chars) |  | Higgsfield model id. A generate node is added only when this is supplied. |

Returns: `name`, `nodes`, `edges`, `rationale`, `warnings`, `engine`

### workflow_quote

**Quote paid generation (no spend)** — writes (additive) · contacts external services

Prices the generate nodes selected by execution and stores an exact-input quote valid for 5 minutes. Contacts the provider for estimates only; nothing is generated or charged. Required before a paid run; pass the returned id and fingerprint to workflow_run_start. Needs a human-reviewed disclosure when generate nodes are selected.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflowId` | string | yes |  |
| `episodeId` | string | yes |  |
| `execution` | object | yes |  |
| `disclosure` | object |  |  |
| `expectedWorkflowVersion` | integer (≥1) |  |  |
| `expectedEpisodeVersion` | integer (≥1) |  |  |

Returns: `generationPlanId`, `fingerprint`, `expiresAt`, `selectedStages`, `aggregate`, `nodes`, `workflowVersion`, `episodeVersion`

### workflow_run_cancel

**Cancel a workflow run** — writes (may remove or replace data) · local only

Stops subsequent stages. A provider request or renderer already in flight may still finish.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflowId` | string | yes |  |
| `runId` | string | yes |  |

Returns: `run`

### workflow_run_get

**Get a workflow run** — read-only · idempotent · local only

Authoritative run state with per-node status. Poll this until terminal is true. A run whose status is awaiting_review needs a human decision in the Studio UI.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `runId` | string | yes |  |

Returns: `run`

### workflow_run_list

**List runs of a workflow** — read-only · idempotent · local only

Most recent runs first.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflowId` | string | yes |  |
| `limit` | integer (≥1, ≤50) |  |  |

Returns: `runs`

### workflow_run_start

**Start a workflow run** — writes (additive) · contacts external services

Starts execution of the selected nodes. Free stages (trend, news, research, script, storyboard, layout, render) run directly and the run stops at review nodes awaiting a human. Runs containing generate nodes spend money: they are refused unless the server operator enabled AGENT_API_ALLOW_PAID_GENERATION, and then still require allowGeneration:true, disclosure, generationPlanId and generationFingerprint from a fresh workflow_quote.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflowId` | string | yes |  |
| `episodeId` | string | yes |  |
| `execution` | object | yes |  |
| `expectedWorkflowVersion` | integer (≥1) |  |  |
| `expectedEpisodeVersion` | integer (≥1) |  |  |
| `allowGeneration` | boolean |  |  |
| `disclosure` | object |  |  |
| `generationPlanId` | string |  |  |
| `generationFingerprint` | string (≤200 chars) |  |  |
| `acceptUnquotedEstimate` | boolean |  |  |

Returns: `run`

### workflow_set_skip

**Skip or unskip a node** — writes (additive) · idempotent · local only

Marks a node as skipped (or not) on a project workflow. Skipped nodes are not executed.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflowId` | string | yes |  |
| `nodeId` | string | yes |  |
| `skipped` | boolean | yes |  |
| `expectedVersion` | integer (≥1) | yes |  |

Returns: `workflow`

### workflow_validate

**Validate a workflow graph (dry run)** — read-only · idempotent · local only

Checks a stored workflow, or a candidate graph {name,nodes,edges}, against the same rules used on save. Never writes. Provide exactly one of workflowId or graph.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `workflowId` | string |  |  |
| `graph` | object |  |  |

Returns: `valid`, `error`, `nodeCount`, `edgeCount`

<!-- agent-ops:end -->
