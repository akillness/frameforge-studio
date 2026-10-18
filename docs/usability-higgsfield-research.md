# FrameForge Studio 사용성 및 Higgsfield 연동 조사

- 확인일: 2026-10-18 (Asia/Seoul)
- 목적: 영상 제작 에디터의 편집·상태관리 개선과 Higgsfield 생성 모듈 적용 가능성을 공식 공개 근거로 정리
- 범위: 공식 제품 문서, 공식 API 문서, 공식 GitHub 저장소와 공개 UI 설명. 코드 수정, 생성 요청, 키 발급, 구매, 계정 변경은 하지 않음.

## 핵심 결론

1. FrameForge에 바로 붙일 수 있는 정식 제품 API는 Higgsfield Developer API다. API 인증은 서버에서 `Authorization: Key <KEY_ID>:<KEY_SECRET>`를 사용하며, Developer API 전용 계정과 USD 선불 잔액으로 청구된다. 브라우저 또는 모바일 코드에 비밀키를 넣으면 안 된다. [H1][H2]
2. Higgsfield 공식 CLI와 MCP는 기존 `higgsfield.ai` 계정으로 로그인하고 그 계정의 크레딧을 사용하는 에이전트 연결이다. API 키가 필요하지 않으며, Developer API 인증이나 청구 계정과 동일하지 않다. 사용자가 제공한 현재 상태는 CLI 로그인 성공, 프로젝트 `.env`에 Developer API 키 없음이다. 이는 실제 API 호출이 준비되었다는 증거가 아니다. [H2][H3][H4]
3. 공식 MCP는 존재한다. 공식 연결 URL은 `https://mcp.higgsfield.ai/mcp`이고 Higgsfield 계정 권한 부여를 사용한다. 그러나 조사한 공식 공개 문서는 실제 MCP transport 유형과 tool 식별자 목록을 공개하지 않는다. 구체 tool 이름이나 MCP JSON 설정을 추정해 구현하지 않는다. [H3][H4][H5]
4. API 요청은 모델별 endpoint와 스키마가 다르다. 요청 응답에서 `request_id`, `status_url`, `cancel_url`을 보관하고, 반환된 status URL을 조회한다. 취소는 작업이 아직 `queued`일 때만 가능하다. 완료 결과는 상태 응답의 모델별 media URL로 받으며, 파일은 최소 7일 뒤 삭제될 수 있으므로 FrameForge 자체 저장소로 옮겨야 한다. [H6][H7][H8]
5. 참고 제품에서 가져올 핵심은 선택 대상에 따라 바뀌는 inspector, draft와 publish 구분, 실행 기록과 버전 기록 분리, 비파괴적 복원, 그리고 결과물에서 원 생성 과정을 다시 찾을 수 있는 provenance다. FrameForge에서 병렬 구현 중인 비교·복원, 설정·결과·기록 탭, Undo/Redo는 이 패턴과 맞닿아 있다. [C1][C2][N1][N2][R1][R2][F1][F2]

## 인증 및 계정 상태 판정

### 검증된 공식 차이

| 표면 | 인증 | 과금 / 계정 | FrameForge 적용 판단 |
|---|---|---|---|
| Developer API | API Key ID와 Secret을 서버 측 `Authorization: Key ID:SECRET` 헤더로 전달 | `higgsfield.ai` 구독과 별개의 API 계정, USD 잔액 기반 사용량 과금 | FrameForge 서버가 생성 기능을 직접 제공할 때의 정식 제품 연동 경로 |
| 공식 MCP | 공식 MCP URL에서 Higgsfield 계정 연결 및 권한 부여. API 키 불필요 | 기존 Higgsfield 구독 계정 크레딧을 사용. MCP 자동 생성에는 무료 생성 및 Unlimited 혜택이 적용되지 않는다고 안내 | MCP 호환 에이전트 연결 경로. FrameForge 백엔드용 REST API 대체물로 간주하지 않음 |
| 공식 CLI | `higgsfield auth login`으로 브라우저 로그인. API 키 불필요 | `higgsfield.ai` 계정 크레딧을 사용 | 개발자/코딩 에이전트용 운영 표면. CLI 로그인 여부로 Developer API 키 존재나 사용 권한을 판정하지 않음 |

출처는 Higgsfield 공식 API 인증, MCP 연결, CLI 연결 및 API FAQ다. CLI의 현재 로그인과 프로젝트 `.env` 상태는 사용자 제공 정보이며 이 조사에서 CLI 상태 명령이나 `.env`를 다시 실행·열람하지 않았다. [H1][H2][H3][H4]

### 읽기 전용 브라우저 확인

- FrameForge 지정 URL은 `나의 제작실에 입장` 화면과 `접근 토큰` 입력을 표시했다. 접근 토큰을 입력하지 않았으므로 제작실 내부, 작업 기록, 편집 화면은 확인하지 못했다.
- Higgsfield 공개 홈페이지는 `로그인` 및 `가입하기`를 표시했다. 기존 로그인 세션은 확인되지 않아 계정 내부 또는 MCP 연결 상태는 확인하지 않았다.
- 어떠한 키, 쿠키, 토큰, 개인 정보도 열람·출력·보고서 저장하지 않았다.

## 참고 제품의 사용성 패턴

| 제품 | 노드·객체 선택과 수정 | 저장·Undo/Redo·버전 | 실행 기록·결과물 provenance |
|---|---|---|---|
| **ComfyUI** | 캔버스 선택에 따라 우측 properties panel이 바뀐다. 단일·복수 노드의 입력을 검색·접기할 수 있고 자주 바꾸는 입력을 즐겨찾기할 수 있다. 미선택 시 전체 노드 목록과 즐겨찾기 입력을 제공한다. 오류 패널은 오류 메시지, 누락 노드/모델/입력, 캔버스에서 노드 찾기를 제공한다. [C1] | workflow를 JSON으로 저장·공유할 수 있다. 조사한 공식 문서에서 범용 Undo/Redo의 구체 동작은 확인하지 못했다. | Job History는 활성/과거 작업, 상태·진행률·썸네일을 보여주며 완료 결과 다운로드, 워크플로 열기, 결과를 loader node로 추가, 실행 ID 복사, 대기 작업 취소를 제공한다. 패널은 설정에 따라 노출된다. [C2] 저장 파일에 `workflow`와 `prompt` JSON을 내장할 수 있어 결과를 다시 workflow로 열 수 있다. 단, 메타데이터는 서명이 아니며 작성자 증명이 아니고, 모델·입력 파일·custom node를 모두 포함하지 않으며 재인코딩 중 제거될 수 있다. [C3] |
| **n8n** | 노드 상세 화면에서 input/output을 Schema, Table, JSON으로 확인한다. 노드 설정이나 연결이 바뀌어 출력이 오래된 경우 캔버스와 output 패널에 dirty 표시를 제공한다. [N3][N4] | 편집 중 보통 1~5초 안에 자동 저장되며, 저장된 초안은 Publish 전까지 운영에 반영되지 않는다. publish 상태와 오류 상태도 구분한다. [N1] Workflow history와 execution history는 별도 개념이다. 버전 미리보기, 복원, 다른 탭에서 비교, 복제, JSON 다운로드가 가능하다. [N2] 이번에 확인한 공식 문서에서는 편집기 전체 Undo/Redo 계약을 확정하지 못했다. | 실행 목록은 workflow·상태·시각으로 필터링할 수 있고 과거 실행 데이터로 원본 workflow 또는 현재 workflow를 재시도할 수 있다. [N5] 실행을 버전 기록과 분리하면서 실행된 workflow 버전을 추적하는 것이 중요하다. |
| **Runway** | Agent 작업은 채팅형 생성과 내장 timeline 편집을 함께 제공한다. timeline에서 클립을 자르고 순서를 바꾸고 추가 미디어를 올릴 수 있다. [R1] | timeline 편집에 Undo/Redo가 명시되어 있다. 문서가 설명하는 것은 timeline 편집 단위이며 전체 프로젝트 버전 관리와 동일하다고 보지 않는다. [R1] | Agent session의 Generations 탭은 생성 결과를 grid로 모으고 asset 유형·즐겨찾기로 필터링한다. Assets는 생성물과 업로드물을 구분해 보관한다. [R1][R2] Enterprise의 Asset Lineage는 prompt, model, seed, 생성일, 부모 참조와 사용처를 연결 그래프로 보여주고 CSV/ZIP로 내보낸다. 현재 문서상 lineage 보기/다운로드는 workspace admin 기능이다. [R3] |
| **Figma** | 선택 객체에 따라 우측 properties panel이 해당 객체의 레이아웃·색·타이포그래피 등을 보여준다. 편집 권한은 Design/Prototype 조정, 보기 권한은 Properties 검사와 export를 허용한다. [F1] | 자동 checkpoint를 약 30분마다 만들고, 시각·주요 기여자·이름/설명으로 기록한다. 버전을 미리 보고 복원할 수 있으며 복원은 현재 버전을 보존하는 비파괴적 작업이다. Dev Mode는 선택 객체에서 변경 비교를 제공한다. [F2][F3] | 버전 작성자와 timestamp는 설계 변경의 출처를 설명하는 패턴이다. 이번에 확인한 공식 help 문서에서는 일반 편집기의 Undo/Redo 세부 계약은 확인하지 못했다. |

### FrameForge에 적용할 우선 개선 5개

세 가지 화면 개선이 병렬 진행 중이라는 사용자 제공 맥락을 반영해, 아래 1~3은 구현이 완료됐다는 의미가 아니라 수용 기준을 제안한다.

1. **P0, 생성 실행 기록을 결과와 연결**: 실행별 상태, 진행 여부, 오류 요약, Higgsfield `request_id`, 사용한 모델·워크플로 버전, 결과 링크를 한 곳에서 읽는다. `queued`일 때만 취소를 노출하고 `in_progress`에서는 취소 불가를 분명히 한다. ComfyUI와 n8n의 실행 기록 패턴 및 Higgsfield lifecycle에 기반한다. [C2][N2][N5][H6][H7]
2. **P0, 결과물 provenance**: 각 생성 asset에서 정확한 FrameForge 버전과 실행을 역추적한다. 모델/workflow ID, 전달한 파라미터 스냅샷, 참조 입력 asset ID, 공급자 request ID, 시작/완료 시각, 로컬 저장 경로와 공급자 출처를 보존한다. prompt와 입력 media는 개인정보가 될 수 있으므로 별도 접근 정책을 적용한다. ComfyUI metadata와 Runway Asset Lineage가 근거지만, ComfyUI 내장 metadata만으로 출처 무결성이 증명되지는 않는다. [C3][R3]
3. **P1, 노드 설정·결과·기록 탭을 선택 컨텍스트에 연결**: 노드 선택 시 해당 노드의 설정과 최신 결과를 보여주고, 기록 탭은 현재 노드/현재 프로젝트로 필터링한다. 다중 선택에서는 공통 설정만 일괄 편집하고, 전역 설정과 선택 노드 오류를 구분한다. 이는 병렬 구현 중인 탭 구조에 해당한다. [C1][N3][N4]
4. **P1, Undo/Redo를 입력 편집까지 일관되게 적용**: 캔버스 구조 변경뿐 아니라 노드 설정의 인라인 수정도 하나의 명확한 history transaction으로 취급하고, 텍스트 입력 중 단축키 가로채기와 편집기 포커스 혼선을 방지한다. 실행 결과 자체를 undo 대상으로 오인하지 않도록 편집 undo와 실행 취소를 분리한다. 이는 병렬 구현 중인 기능이다. Runway는 timeline에 Undo/Redo를 명시한다. [R1]
5. **P1, 비교·복원을 비파괴적 버전 절차로 완성**: 비교 화면에 버전 이름·시각·작성자·변경 요약을 보여주고, 복원은 현재 상태를 먼저 보존한 뒤 새 버전으로 기록한다. 저장 대기/완료/실패/오프라인 상태를 표시하고, 실행 기록은 실행 당시 버전과 연결한다. 이는 병렬 구현 중인 읽기 쉬운 비교/새 버전 복원에 해당한다. [N1][N2][F2]

## Higgsfield Developer API: 확인된 연동 계약

### 인증과 모델 선택

- API base URL은 `https://api.higgsfield.ai`다. 모든 API 호출은 서버 측 API key ID와 secret을 사용한다. 인증 문서는 표준 헤더로 `Authorization: Key <KEY_ID>:<KEY_SECRET>`을 권장하고 브라우저/모바일에서 직접 호출하지 말라고 경고한다. [H1]
- 모델 목록은 공식 API Console과 API 모델 문서를 기준으로 확인한다. 모델별 workflow 페이지마다 endpoint, 입력 필드, 필수값, 허용값과 결과 형식이 다르며 계정의 모델 접근 가능 여부도 별도일 수 있다. 조사에서 범용 REST `GET /models`를 확인하지 못했다. 공식 CLI에는 `higgsfield model list` 및 parameter schema 확인 기능이 있지만, CLI 명령을 REST endpoint로 취급하면 안 된다. [H5][H9]
- `higgsfield.ai`의 구독 크레딧과 Developer API의 USD 잔액은 별도다. 공식 도움말은 API 사용료 사전 estimate 기능을 언급하지만 조사에서는 그 기능의 정확한 endpoint와 response schema를 확인하지 못했다. 임의의 estimate URL을 만들지 않는다. [H2]

### 구체 예시: Seedance 2.5 Text-to-Video

다음은 선택한 한 workflow에 대한 공식 스키마 예시이며 전 모델 공통 스키마가 아니다. [H10]

- Method/endpoint: `POST https://api.higgsfield.ai/bytedance/seedance-2.5/text-to-video`
- 필수 입력: `prompt` (문자열, 1자 이상)
- 선택 입력: `duration` 정수 4~30, 기본 5; `resolution` `480p|720p|1080p`, 기본 `720p`; `aspect_ratio` `16:9|4:3|1:1|3:4|9:16|21:9`, 기본 `16:9`; `bitrate_mode` `standard|high`, 기본 `high`; `output_format` `mp4|mov`, 기본 `mp4`; `generate_audio` boolean, 기본 `true`
- schema는 `additionalProperties: false`다. UI에서 이 workflow의 미지원 필드를 받지 않거나 명시적으로 거절한다.

### 비동기 작업 수명주기

1. 모델 전용 endpoint로 JSON을 제출하고, 재시도 중 중복을 줄이기 위해 `Idempotency-Key`를 사용한다. [H10][H6]
2. 수락 응답의 `request_id`, `status_url`, `cancel_url`을 그대로 저장한다. 공식 문서는 URL을 직접 조립하는 대신 응답에서 받은 URL을 사용하라고 안내한다. [H6]
3. 반환된 `status_url`을 polling하거나 webhook을 사용한다. 공식 polling 가이드는 2초에서 시작해 최대 10초까지 늘리고 jitter를 추가하는 전략을 제안한다. [H7][H11]
4. 상태값은 `queued`, `in_progress`, `completed`, `failed`, `nsfw`, `canceled`다. `completed` 응답은 이미지/비디오/오디오 종류에 따라 output URL 필드가 달라질 수 있다. [H6][H7]
5. 취소는 모든 하위 job이 아직 `queued`인 경우에 한정된다. 처리 시작 후 취소는 불가하고 `400 Bad Request`가 될 수 있다. 성공 시 `202 Accepted`와 빈 body다. UI는 이 제약을 반영해야 한다. [H7][H8]
6. 완료 파일 URL은 최소 7일 보관된다. 장기 보관은 FrameForge 저장소로 다운로드한다. 결과 다운로드 전용 공통 `/result` endpoint는 확인되지 않았다. 상태 응답의 모델별 URL을 기준으로 처리한다. [H6][H2]

### 입력 업로드 계약

입력 media가 공개 HTTPS URL이 아닐 때 공식 업로드 흐름은 다음과 같다. API 인증으로 `POST https://api.higgsfield.ai/files/generate-upload-url`에 `content_type`을 보내고, 응답의 `upload_url`, `upload_headers`, `public_url`을 받는다. 받은 모든 `upload_headers`로 `upload_url`에 `PUT` 업로드한 뒤, 생성 요청에는 `public_url`을 모델이 요구하는 입력 필드로 전달한다. 업로드 URL은 1시간 후 만료된다. Presigned storage URL에는 Higgsfield API credential을 보내지 않는다. [H12]

### 구현 경계 제안, 사실과 분리

- 서버 전용 `HiggsfieldApiAdapter`를 두고 UI에서는 생성 요청과 취소 권한만 호출한다. API key ID/secret은 서버 환경의 비밀 저장소에서만 읽고 브라우저 bundle, 로그, DB 평문에 두지 않는다.
- 모델별 `endpoint + JSON Schema + input/output mapping`을 데이터로 관리한다. 공통 생성 endpoint나 모든 모델에 공통인 prompt/image 필드가 있다고 가정하지 않는다.
- 실행 record에는 내부 run ID와 provider `request_id`, 반환 URL, 원본 status, 모델 ID, workflow revision, retry/idempotency key, 시간, 비용 확인 상태를 연결한다. provider raw response에서 secret이 포함될 수 있는 헤더나 URL query가 있으면 로그 전에 제거한다.
- 사용자 확인/예산 한도는 submit 전에 둔다. 공식 도움말은 비용 estimate 기능이 있다고 하지만 route/schema가 확인되지 않았으므로 정확한 호출 계약을 확보하기 전에는 사전 비용 계산 완료로 표시하지 않는다.
- 결과는 반환 URL에서 다운로드해 장기 보관 정책에 맞는 FrameForge storage로 복사한다. provider URL 만료 또는 보관기간 경고를 asset 화면에서 보여준다.

## 공식 MCP: 존재, 인증, 공개 범위

- Higgsfield 공식 도움말은 MCP 연결 URL을 `https://mcp.higgsfield.ai/mcp`로 명시하며, Claude custom connector 등에서 Higgsfield 계정으로 연결하고 권한을 부여하도록 안내한다. API key는 필요하지 않다. 활성 유료 구독이 필요하다는 안내도 있다. [H3][H4]
- 공식 MCP는 이미지/비디오 생성, 일부 편집·업스케일, 캐릭터와 참조 입력, 잔액 및 생성 기록 조회를 제품 기능으로 소개한다. 생성 결과는 Higgsfield Assets에 저장되고 MCP source로 표시/필터링된다고 도움말이 설명한다. 이 출처 태그는 계정 내 origin 표시이지 공개 문서상 암호학적 서명은 아니다. [H3]
- 공식 문서가 공개한 것은 연결 URL과 계정 권한 부여 흐름이다. 조사한 공식 공개 문서/GitHub에서 MCP `tools/list` 결과, 정확한 tool 이름, 개별 MCP tool input/output schema, 구현 transport 유형은 확인하지 못했다. 공식 `higgsfield-ai/cli` GitHub 저장소는 CLI 제품이다. 커뮤니티의 별도 Higgsfield MCP 저장소는 공식 구현으로 간주하지 않는다. [H3][H4][H5][H9]
- 따라서 MCP 적용은 선택적 별도 adapter로 보류한다. 실제 tool contract가 필요하면 Higgsfield의 공식 도구 목록/SDK 계약 또는 승인된 계정으로 read-only MCP discovery를 받아야 한다. tool 이름, transport, OAuth scope를 추정하거나 CLI 명령을 MCP tool이라고 부르지 않는다.

## 실제 연동 전 누락 항목 및 차단 요인

1. **Developer API credential**: 사용자가 제공한 맥락에서 프로젝트 `.env`에 API key ID/secret이 없다. 값을 채팅에 보내지 말고 승인된 서버 secret store를 정한 뒤 그 이름/연결만 설정해야 한다. CLI 로그인은 대체재가 아니다. API key 발급이나 계정 설정은 이번 조사에서 하지 않았다.
2. **모델과 workflow 확정**: 우선 적용할 생성 종류, 모델, 입력 참조 방식, 품질/비율/길이, 결과 asset 타입을 선택해야 한다. 선택된 모델의 실제 계정 접근 가능 여부와 최신 schema는 API Console에서 확인해야 한다.
3. **비용 통제**: 프롬프트 단위 estimate의 정확한 endpoint/schema, 사용자 확인 시점, 한 작업 및 월별 비용 상한이 미정이다. 구매/충전 없이 이 조건을 해결할 수 없다면 생성 실행은 막아야 한다.
4. **MCP 공개 계약**: 공식 MCP의 실제 transport, tool 식별자, 입력 schema, 인증 scope와 토큰 수명은 공개 문서에서 확인되지 않았다. MCP 연결 테스트에도 Higgsfield 계정 승인 및 크레딧 사용 가능성이 있으므로 별도 승인/공식 계약 전에는 실사용하지 않는다.
5. **저장·권한 정책**: 반환 파일의 장기 저장 위치, 보존/삭제 정책, 참조 이미지·영상의 접근 제어, 프롬프트와 개인정보의 로그 범위가 미정이다.
6. **서비스 접근 범위**: 현재 FrameForge 세션은 접근 토큰 입력 단계에서 멈췄다. 기존 로그인 상태가 없으므로 내부 편집 화면 또는 현재 저장 구조에 맞춘 구현 판단은 본 보고서 범위에 없다.

## 공식 출처

모든 웹 출처는 2026-10-18에 열람했다. 동적 모델 카탈로그와 플랜 조건은 실제 연동 시 다시 확인한다.

### UI / 편집기

- [C1] ComfyUI, Right Side Panel: Node Properties and Errors: https://docs.comfy.org/interface/right-side-panel
- [C2] ComfyUI, Job History: https://docs.comfy.org/interface/job-history
- [C3] ComfyUI, Workflow Metadata: https://docs.comfy.org/development/api-development/workflow-metadata
- [C4] ComfyUI, Workflows: https://docs.comfy.org/basic-concepts/workflow
- [N1] n8n, Save and publish workflows: https://docs.n8n.io/build/understand-workflows/save-and-publish-workflows
- [N2] n8n, View change history: https://docs.n8n.io/build/manage-workflows/view-change-history
- [N3] n8n, Understand dirty nodes: https://docs.n8n.io/build/understand-workflows/understand-executions/understand-dirty-nodes
- [N4] n8n, Work with data: https://docs.n8n.io/build/work-with-data
- [N5] n8n, View all executions: https://docs.n8n.io/build/understand-workflows/understand-executions/view-all-executions
- [R1] Runway, Creating with Runway Agent: https://help.runwayml.com/hc/en-us/articles/51601639579667-Creating-with-Runway-Agent
- [R2] Runway, Managing assets: https://help.runwayml.com/hc/en-us/articles/4408611980563-Managing-assets
- [R3] Runway, Viewing and downloading an asset's lineage: https://help.runwayml.com/hc/en-us/articles/53718574533395-Viewing-and-downloading-an-asset-s-lineage
- [F1] Figma, Design, prototype, and explore layer properties in the right sidebar: https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-right-sidebar
- [F2] Figma, View a file's version history: https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history
- [F3] Figma, Guide to inspecting: https://help.figma.com/hc/en-us/articles/22012921621015-Guide-to-inspecting

### Higgsfield API / MCP / CLI

- [H1] API Docs, Authentication: https://docs.higgsfield.ai/docs/authentication
- [H2] Higgsfield Help Center, What is the Higgsfield API?: https://higgsfield.ai/creator-hub/help-center/integrations/what-is-the-higgsfield-api
- [H3] Higgsfield Help Center, What is Higgsfield MCP?: https://higgsfield.ai/creator-hub/help-center/integrations/what-is-higgsfield-mcp
- [H4] Higgsfield Help Center, Connect Higgsfield to AI agents: https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-connect-higgsfield-to-ai-agent
- [H5] Higgsfield Help Center, Official Higgsfield platforms: https://higgsfield.ai/creator-hub/help-center/getting-started/official-higgsfield-platforms
- [H6] API Docs, Requests and lifecycle: https://docs.higgsfield.ai/docs/concepts/requests
- [H7] API Docs, Polling: https://docs.higgsfield.ai/docs/concepts/polling
- [H8] API Docs, Cancel a queued request: https://docs.higgsfield.ai/docs/api-reference/requests/cancel-a-queued-request
- [H9] Official Higgsfield CLI GitHub: https://github.com/higgsfield-ai/cli
- [H10] API Docs, Seedance 2.5 Text-to-Video: https://docs.higgsfield.ai/docs/models/seedance-2-5/text-to-video
- [H11] API Docs, How the API works: https://docs.higgsfield.ai/docs/how-to/introduction
- [H12] API Docs, File uploads: https://docs.higgsfield.ai/docs/concepts/file-uploads
- [H13] API Docs, Model API Reference: https://docs.higgsfield.ai/docs/models
- [H14] Higgsfield MCP setup: https://higgsfield.ai/mcp
- [H15] Higgsfield CLI setup: https://higgsfield.ai/cli
