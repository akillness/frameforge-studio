# FrameForge MCP 서버

FrameForge는 [Agent API](agent-api.md)의 모든 operation을 MCP 도구로 제공합니다. 대상 규격은 **MCP 2026-07-28**이며, 핸드셰이크 방식의 이전 클라이언트(2025-11-25 이하)도 같은 엔드포인트에서 상태 없이 응답합니다.

범위: **tools**. 리소스, 프롬프트, 구독(`subscriptions/listen`), Tasks 확장은 광고하지 않습니다. 긴 작업은 `workflow_run_get`, `render_job_get` 폴링 도구로 처리합니다.

## 두 가지 전송

| 전송 | 엔드포인트 | 용도 |
| --- | --- | --- |
| Streamable HTTP | `POST {FRAMEFORGE_URL}/mcp` | 원격/컨테이너. 요청마다 독립 POST, JSON 응답 |
| stdio | `node scripts/frameforge-mcp.mjs` | 로컬 에이전트가 자식 프로세스로 실행. 실행 중인 스튜디오의 REST를 호출하는 프록시 |

stdio 서버는 카탈로그와 호출을 모두 `/api/agent/operations`로 위임하므로 HTTP 서버와 도구가 항상 같습니다.

### 클라이언트 설정

`.mcp.json`에는 stdio 서버가 `frameforge-studio`로 등록되어 있습니다.

```json
"frameforge-studio": {
  "type": "stdio",
  "command": "node",
  "args": ["--env-file=.env", "scripts/frameforge-mcp.mjs"]
}
```

`.env`의 `FRAMEFORGE_TOKEN`(또는 `LOGIN_TOKEN`)과 선택적 `FRAMEFORGE_URL`을 읽습니다. 원격 URL은 HTTPS여야 합니다(loopback HTTP만 예외).

Streamable HTTP 클라이언트는 URL `…/mcp`에 `Authorization: Bearer <LOGIN_TOKEN>` 헤더를 설정하세요.

## 규격 준수 요약

| 항목 | 동작 |
| --- | --- |
| 버전 선언 | 요청마다 `params._meta["io.modelcontextprotocol/protocolVersion"]`와 `["io.modelcontextprotocol/clientCapabilities"]` 필수. 누락 → 400 / -32602 |
| 미지원 버전 | 400 / -32022, `data.supported`에 지원 목록 |
| `server/discover` | 지원 버전, `capabilities.tools`, `instructions`, `ttlMs`, `cacheScope` |
| 헤더 미러링 | `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`(tools/call)이 본문과 다르면 400 / -32020 (Base64 sentinel 디코딩 지원) |
| `tools/list` | 이름순 결정적 순서, `inputSchema`(JSON Schema 2020-12), `outputSchema`, `annotations`, `ttlMs`/`cacheScope: private` |
| `tools/call` | `structuredContent`(outputSchema 준수)와 동일 JSON의 텍스트 content, `isError`, `resultType: "complete"` |
| 도구 오류 | `isError: true`, 본문 JSON `{"error":{"status","code","message"}}`, `_meta["com.frameforge/error"]` |
| 알 수 없는 도구 | JSON-RPC -32602 |
| 알 수 없는 메서드 | 404 / -32601 |
| 알림 | 202, 본문 없음 |
| `Origin` | 존재하는데 서비스 출처와 다르면 403 |
| GET/DELETE | 405 (세션과 스트림 없음) |
| 인증 | Bearer 또는 세션 쿠키, 없으면 401 + `WWW-Authenticate: Bearer` |

도구 annotation(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)은 **힌트**입니다. 클라이언트는 이를 보안 판단에 쓰면 안 됩니다. 서버의 버전 검사, 유료 생성 거절, 사람 승인 단계가 실제 방어선입니다.

## 클라이언트 호환 검증

2026-11-06, 임시 데이터 디렉터리의 실제 서버에 대해 다음 클라이언트로 같은 시나리오를 실행했습니다(도구 목록, structuredContent, 오류 봉투, 409 stale, 제안 후 적용, 인증/Origin/GET).

| 클라이언트 | 연결 | 결과 |
| --- | --- | --- |
| `@modelcontextprotocol/client` 2.4.0, `{pin: '2026-07-28'}` | Streamable HTTP | modern era, 통과 |
| 같은 클라이언트, `auto` | Streamable HTTP | modern era 선택 |
| 같은 클라이언트, 기본(legacy 핸드셰이크) | Streamable HTTP | legacy era, 통과 |
| `@modelcontextprotocol/sdk` 1.32.2 (최신 프로토콜 2025-11-25) | Streamable HTTP | 통과 |
| `@modelcontextprotocol/client` 2.4.0 pin | stdio 프록시 | modern era, 통과 |

총 50개 확인 통과. 이 검증은 저장소 밖의 임시 디렉터리에서 SDK를 설치해 수행했고, 저장소에는 SDK 의존성을 추가하지 않았습니다. 저장소 테스트(`tests/agent-mcp.test.mjs`)는 외부 의존성 없이 원시 JSON-RPC로 같은 계약을 고정합니다. 실제 MCP 클라이언트 제품(Claude Desktop 등)과의 연결은 이 검증 범위에 포함되지 않습니다.

## 보안 모델

- 에이전트 API는 `LOGIN_TOKEN` 소유자와 같은 관리자 권한입니다. 토큰을 신뢰하는 에이전트에게만 주세요.
- 에이전트에게 **검토 승인, 게시, 유료 생성(기본 꺼짐)** 은 노출하지 않습니다. 그래서 에이전트가 자기 결과를 스스로 승인하거나 공개할 수 없습니다.
- 모든 쓰기는 `expectedVersion`을 요구하고 이력을 남깁니다.
- 호출 제한(조회 300/분, 쓰기 60/분)과 인증 실패 제한이 적용됩니다.
- `LOGIN_TOKEN`이 비어 있는 개발 서버는 loopback 클라이언트만 허용합니다.
- 입력은 스키마로 검증하고, 출력도 스키마로 검증한 뒤 반환합니다. 스키마를 위반한 결과는 반환되지 않고 500으로 막힙니다.
