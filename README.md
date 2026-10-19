# FrameForge Studio

최종 갱신: 2026-10-19.

채널의 소재 조사부터 연출, 장면 편집, MP4 출력과 검토까지 연결하는 개인 영상 제작 허브입니다. 드라마·재연·정보 전달용 템플릿을 수정하고, **ComfyUI에서 참고한 노드 연결 방식**으로 제작 순서를 구성합니다. 실행 워크플로우와 장기 지식 그래프는 서로 다른 화면과 데이터로 관리합니다.

![제작 워크플로우와 영구 지식 구조](docs/assets/workflow.svg)

**기존 Windows/Tailscale 운영 경로:** [Tailscale 개인 제작실](https://desktop-qrf3t5t.taila2003e.ts.net/) · 같은 tailnet과 접근 토큰을 사용하는 비공개 경로입니다. 아래 최신 macOS 로컬 QA는 이 운영 경로의 전환·재배포 증거가 아닙니다.

![흰색 제작실의 장면 편집 화면 — 로컬 QA 레코드](docs/assets/white-studio/studio-1440.png)

![흰색 워크플로우와 기존 노드 검사기 — 로컬 QA 레코드](docs/assets/white-studio/workflow-1440.png)

기존 흰색 UI는 Studio·Workflow·Trends·Templates·History·Knowledge·Settings 7개 화면에 적용했습니다. [390px 장면 편집 화면](docs/assets/white-studio/studio-390.png)과 [101개 로컬 브라우저 검사](artifacts/white-studio-browser-smoke.json)는 별도 테스트 레코드이며, 제공자 모델 목록·견적·복구·적용에는 명시적 fixture를 사용했습니다. 실제 Higgsfield 연결·생성 성공을 뜻하지 않습니다.

2026-10-19에는 **운영 개요**를 여덟 번째 화면으로 추가했습니다. 실제 `/api/state`와 기존 이력 API에서 작업 큐·결과물 참조·변경 이력·운영 상태를 구성하며, 필터·정렬·표시 항목과 저장 뷰는 브라우저 로컬 설정입니다. 담당자·기한·가짜 건강 지표는 추가하지 않았습니다. [1440px 운영 개요 캡처](artifacts/ops-workspace/overview-1440.png)와 [검증 영수증](artifacts/ops-workspace/verification.json)을 확인하세요. 이 QA 캡처는 격리된 한국어 테스트 자료이며 운영 데이터 화면이 아닙니다. 이전 Jev 응답 영수증은 이 diff의 독립 리뷰가 아니며, 이번 diff 리뷰는 Jev 프로필 부재로 실행하지 않았습니다.
개인 작업 창은 브라우저 안의 작업 영역 크기와 도구 표시를 조절합니다. `자동 맞춤`은 가용 폭·높이에 맞춘 도킹형 기본값이고, `컴팩트`는 1024×768 오버레이, `표준`은 1280×800 도킹형, `와이드`는 1600×900 도킹형, `집중`은 1280×800 오버레이입니다. 숫자 입력은 사용자 지정 폭 320–2560px·높이 320–1800px·검사기 폭 240–480px 범위로 정규화하며, 모서리 핸들의 포인터 드래그와 방향키(Shift는 큰 간격)로도 크기를 바꿀 수 있습니다.
검사기·내레이션·제작 어시스턴트는 기존 DOM 패널을 이동하는 native dialog 오버레이로 열고 닫습니다. 브라우저 로컬 named profile에 작업 창 레이아웃을 저장·복원하며 서버 레이아웃 쓰기는 하지 않습니다. 어시스턴트의 제출 전 초안은 에피소드 범위의 일시 상태이고, 검사기 편집은 선택한 장면 범위의 상태입니다. [작업 창 스크린샷](docs/assets/workspace/final-workspace.png)과 [인증 브라우저 영수증](artifacts/workspace-browser-smoke.json)을 함께 확인하세요.

아래 음성·영상 화면은 이전 Windows/Tailscale 검증 기록입니다.

![실제 한국어 음성을 붙인 편집 화면](docs/assets/narration-desktop.png)

![완성 MP4 재생과 버전별 검토 기록](docs/assets/review-desktop.png)

[음성·영상 검토의 모바일 화면](docs/assets/review-mobile.png) · [실제 재생·검토 저장 검증](artifacts/production-browser-smoke.json)

## 실제로 할 수 있는 작업

- 채널을 등록하고 소재·에피소드·수정 버전·렌더링 결과를 연결합니다. 현재 운영 데이터에는 Aside에서 확인한 세 채널을 등록했습니다. 새 설치에는 명확히 표시된 예제 채널만 생성합니다.
- 장면을 추가·복제·재정렬하고 화면 문구, 배경, 길이, 9:16·16:9·1:1 포맷과 레이아웃을 수정합니다. 이미지·영상을 업로드하고 영상 시작점, 장면별 음성·음악과 볼륨을 조절합니다.
- 편집 결과를 재사용 템플릿으로 저장합니다. FFmpeg가 한국어 자막을 포함한 H.264/AAC MP4를 생성하며 인증된 다운로드와 작업 이력을 제공합니다.
- Windows에 설치된 한국어 음성으로 장면별 내레이션을 생성하고 미리 듣습니다. 음성 길이에 맞춰 장면을 늘리고, 저장된 편집본과 음성을 그대로 워크플로우에서 렌더링합니다.
- 완성 MP4를 웹에서 재생하고 승인 또는 수정 요청을 기록합니다. 결정은 에피소드 버전·렌더 작업·파일 SHA-256에 연결되며, 변경된 편집본은 다시 렌더해야 검토할 수 있습니다.
- Google Trends KR RSS에서 실제 소재를 수집합니다. Naver DataLab과 공식 크리에이터 레퍼런스는 출처·조사일·관찰 메모와 함께 기록합니다. [조사 근거와 템플릿 제안](docs/research-playbook.md)을 제공합니다.
- 웹 채팅에서 Codex·JEO·JEOPI가 작성한 스토리보드를 검증한 뒤 에피소드 버전으로 적용합니다. `Studio`는 규칙 기반 도우미이며 외부 LLM과 구분해 표시합니다.
- Aside 지정 세션의 명령을 영속 명령함으로 가져옵니다. 웹 명령함 접수는 기록이며, 실행은 에이전트 채팅 또는 워크플로우에서 명시적으로 시작합니다.

## 연결해서 실행하는 제작 흐름

```mermaid
flowchart LR
  T[트렌드 · 실제 RSS] --> R[레퍼런스 · 채널 근거]
  R --> S[대본 · Codex/JEO/JEOPI]
  S --> B[스토리보드 · 버전 저장]
  B --> V[렌더 · FFmpeg MP4]
  B -. 선택 생성 .-> H[Higgsfield · API / MCP]
  H --> A[검사된 미디어 · 버전 적용]
  A --> V
  V --> Q[영상 재생 · 승인 / 수정 요청]
  B -. 기록 .-> E[채널 / 소재 / 에피소드]
  E --> K[OKF + LLM Wiki]
  K --> G[Graphify 지식 그래프]
```

노드를 이동하고 입·출력 포트를 연결하거나 연결 폼을 사용합니다. 확대·축소, 전체 보기, 자동 배치, 노드 설정, 저장·불러오기, 실행·취소와 노드별 실행 결과를 제공합니다. 저장 시 순환, 잘못된 포트, 끊어진 필수 경로를 거부합니다.

현재 실행기는 `trend`, `research` 선택 노드와 `script → storyboard → render → review` 필수 노드로 구성됩니다. 선택 `generate` 노드를 storyboard와 render 사이에 연결할 수 있습니다. 각 종류는 한 번씩 사용하며 4–7개 노드를 지원합니다. 범용 ComfyUI 플러그인 런타임이나 무제한 모델 그래프가 아닙니다. `script`에서 에이전트와 연출 프롬프트 또는 **저장된 편집본 사용**을 선택합니다. 완료된 MP4는 `awaiting_review`로 멈추고 웹 검토 후 `approved` 또는 `changes_requested`로 기록됩니다. 승인해도 자동 공개되지 않습니다. 실행 시 워크플로우와 에피소드 스냅샷을 저장하고, 수정 충돌·실패·중단을 기록합니다.

## 노드 편집·이력·Higgsfield

노드를 선택하면 **설정 / 실행 결과 / 변경 기록** 탭에서 이름·메모와 종류별 설정을 수정하고 실행 당시 버전과 결과를 확인합니다. 초안 Undo/Redo와 저장 상태를 제공하며, 에피소드·워크플로우의 이전 버전은 필드별 비교 후 **새 버전으로 복원**합니다.

Studio의 **Higgsfield 장면 생성**은 별도 폼 대신 기존 워크플로우 검사기를 엽니다. 기존 대본을 쓰는 생성 경로가 없으면 `script(existing) → storyboard → generate → render → review` 5노드 초안을 만들고, 선택한 장면을 안정 ID로 추적합니다. 열기만으로 저장·실행·과금하지 않으며, 장면 순서가 바뀌면 최신 인덱스를 사용하고 대상이 삭제되면 실행을 막습니다.

실행 확인에는 현재 모델·프롬프트·설정의 새 견적을 표시합니다. 견적이 없으면 **비용 미확인 상태로 진행한다는 명시적 확인**이 필요합니다. 전체 생성 워크플로우는 결과를 버전 검사 후 **자동 적용하고 렌더**합니다. 충돌·취소 뒤 보존하거나 복구한 결과는 별도 **적용**으로 처리하며 새 생성 요청을 보내지 않습니다. UI는 견적 당시 워크플로우·에피소드 버전을 실행 요청에 보내고, 서버는 전달된 버전이 오래되면 실행·과금 전에 409로 거부합니다.

Developer REST 어댑터는 공식 `POST /estimate/{model}`과 영속 생성 작업 ID를 사용하는 `Idempotency-Key`를 지원합니다. 이것은 생성 POST 자동 재시도가 아닙니다. 응답이 불명확하면 제공자 기록을 확인하고, 알려진 제공자 요청 ID만 복구합니다. **설정됨**은 **인증·가용성 검증됨**과 다릅니다. [16개 디자인 근거·12개 공식 Higgsfield 근거 및 Aside 공개 UI 관찰](artifacts/white-studio-research.json), [공식 비용 견적](https://docs.higgsfield.ai/docs/concepts/billing-and-retention), [공식 멱등성 계약](https://docs.higgsfield.ai/docs/concepts/idempotency)을 참고하세요.

[연결 및 인증 구분](docs/higgsfield-integration.md) · [Aside 딥리서치](docs/usability-higgsfield-research.md) · [Jev 실제 API 리뷰](artifacts/jev-higgsfield-review.json)

![노드별 변경 기록과 버전 비교](docs/assets/usability/workflow-history-desktop.png)

[에피소드 비교 화면](docs/assets/usability/history-desktop.png) · [모바일 생성 설정](docs/assets/usability/generation-mobile.png) · [사용성 23개 검증](artifacts/usability-browser-smoke.json)

**이전 Windows/Tailscale의 실제 Higgsfield 생성 검증:** 프로젝트 MCP → 인증된 서비스 API → Docker/호스트 공식 CLI → Seedance 2.5 1080×1920 영상(4.042초) → 로컬 미디어 해시 확인 → 에피소드 v3 적용 → Docker MP4 렌더를 완료했습니다. [실행 영수증](artifacts/higgsfield-live-smoke.json). 견적은 64크레딧이며 실제 청구 명세 검증과는 구분합니다. 당시 공식 원격 MCP는 OAuth 대기, Developer API는 키 설정 대기였습니다. 이번 흰색 UI 변경에서는 유료 생성이나 공개 배포를 수행하지 않았습니다.

HEVC·10비트 생성 영상은 원본과 SHA-256을 보존하고 브라우저용 H.264 8비트/AAC 사본으로 변환합니다. 이미 받은 영상도 제공자 재호출 없이 변환할 수 있으며, 새 사본 적용은 버전 충돌을 검사합니다. [실제 원본 보존·변환 검증](artifacts/higgsfield-normalization.json).

![실제 Higgsfield 생성 영상을 편집기에 적용한 화면](docs/assets/higgsfield-live/editor-desktop.png)

[이전 운영 HTTPS 재생 검사 21개](artifacts/higgsfield-browser-smoke.json)와 [당시 Docker 재시작 후 기존 에피소드·미디어 보존](artifacts/higgsfield-persistence.json)을 확인했습니다. 영상 프레임 디코딩과 1440/390px 화면을 검사했으며 추가 생성·자동 게시 없이 저장된 편집본을 렌더했습니다. 최신 로컬 QA와는 별도 근거입니다.

## 실행

Node 22.13 이상, FFmpeg/ffprobe와 한국어 폰트가 필요합니다. npm 런타임 의존성은 없습니다. 개발 기본 주소는 `127.0.0.1:4310`입니다.

내레이션 생성은 Windows SAPI의 설치된 목소리를 사용합니다. Linux Docker도 인증된 호스트 브리지로 한국어 WAV를 받아 장면에 연결합니다. 실제 Docker → Windows 음성 → 1080×1920 MP4 제작과 브라우저 재생을 확인했습니다. 브리지가 없으면 제공자 실패를 명시하며, 업로드한 음성의 편집·렌더도 지원합니다.

```powershell
node scripts/configure.mjs
node --env-file=.env server/app.mjs
```

`configure`는 `.env`에 접근 토큰과 별도 브리지 토큰을 생성하고 기존 설정은 보존합니다. 접근 토큰은 로컬 `.env`의 `LOGIN_TOKEN` 값입니다. 파일은 Git에서 제외됩니다. Windows에서 서버·브리지·Aside 수신기를 숨김 창으로 지속 실행하려면 다음을 사용합니다.

```powershell
powershell -NoProfile -File scripts/start-local.ps1
# 이 프로젝트의 기록된 PID만 종료
powershell -NoProfile -File scripts/stop-local.ps1
```

에이전트 브리지는 호스트에 설치된 인증된 Codex/JEO/JEOPI CLI를 사용합니다. 임의 셸 명령을 받지 않고 텍스트 전용 호출 및 장면 스키마 검증을 수행합니다. JEO 어댑터는 실행 프로세스 안에서 OAuth 모델 목록을 갱신하여 오래된 정적 목록 문제를 처리합니다. 설치 여부와 실제 응답 검증 여부는 구분됩니다. Hermes 기존 하니스는 참고 기록이며 현재 실행 어댑터는 비활성입니다.

## Docker와 Tailscale

```powershell
# 기존 운영 데이터가 이전된 이 PC에서
& .\scripts\start-docker.ps1
# 소스 변경 후 이미지 갱신
& .\scripts\start-docker.ps1 -Build
docker compose -p frameforge-studio ps
```

컨테이너는 비루트 계정, 읽기 전용 루트 파일시스템, `/data` 영속 볼륨, 루프백 포트 바인딩을 사용합니다. FFmpeg와 Noto CJK 폰트를 이미지에 포함합니다. 호스트 실행과 컨테이너 실행은 같은 4310 포트를 사용하므로 전환 전에 기존 서버만 중지합니다. 호스트 `data/`와 Docker 볼륨은 별도 저장소이므로 기존 운영 데이터는 백업 후 명시적으로 옮겨야 합니다.

컨테이너의 에이전트·음성 호출 대상은 `host.docker.internal:4311`입니다. 이 PC의 Docker에서 호스트 루프백 브리지 접근과 실제 Codex 응답을 확인했습니다. `HOST_AGENT_BRIDGE_URL`로 대상만 별도 지정할 수 있습니다. 브리지 토큰은 비공개 환경변수로 공급하며 CLI OAuth 자격증명은 호스트에 유지합니다. [초기 이전·재시작·복구 운영 절차](docs/docker-operations.md)를 제공합니다. 런처는 기존 볼륨과 비어 있지 않은 DB를 확인하여 빈 제작실로 잘못 시작하지 않습니다.

**이전 소스의 Docker 실동작 검증:** [GitHub CI 39110221470](https://github.com/akillness/frameforge-studio/actions/runs/39110221470)에서 소스 `0f59211`의 77개 테스트, 이미지 빌드, 비루트·읽기 전용 Compose 기동, 인증된 1080×1920 H.264/AAC 렌더링·다운로드와 저장된 편집본의 검토를 통과했습니다. 재시작 후 에피소드·이력·검토 결정·동일 MP4 해시 보존도 확인했습니다. [컨테이너 검증 결과](artifacts/docker-ci-smoke.json)를 저장했습니다. 이 결과를 변경된 최신 소스의 검증으로 재사용하지 않습니다.

**Windows 운영 전환의 역사적 기록:** WSL 서비스를 복구한 뒤 Docker 29.5.2로 운영 URL을 전환했고, 기존 채널 4개·에피소드 3개·미디어 10개의 ID·버전·해시를 보존했습니다. 한국어 음성, 실제 Codex 대본, MP4 렌더, HTTPS 브라우저 재생·검토와 컨테이너 재시작 보존을 검증했습니다. [이전 근거](artifacts/docker-migration.json), [당시 운영 Docker 근거](artifacts/docker-verification.json), [당시 재시작 근거](artifacts/live-container-smoke.json)를 보존합니다. 최신 macOS 흰색 UI·컨테이너 QA와 남은 검증은 [전체 검증 기록](docs/verification.md)에서 구분합니다.

```mermaid
flowchart LR
  U[Tailscale HTTPS] --> D[Docker 웹 편집기 · FFmpeg]
  D --> V[영속 볼륨 · SQLite / 미디어 / 이력]
  D -->|인증된 요청| B[Windows 호스트 브리지]
  B --> S[한국어 SAPI · WAV]
  B --> A[Codex / JEO / JEOPI]
  I[Aside 명령 수신기] --> D
```

![Docker 운영 서비스의 제작·영상 검토 화면](docs/assets/docker-live/review-desktop.png)

[Docker HTTPS 브라우저 검증](artifacts/docker-live-production-browser-smoke.json): 음성·영상 재생, 검토 저장, 1440/390px 화면, 페이지 오류 0.

HTTPS 프록시를 사용할 때 `.env`에 `PUBLIC_ORIGIN=https://서비스주소`를 지정합니다. Compose에도 전달되며 로그인 쿠키에 `Secure`가 적용되고 쓰기 요청의 Origin을 제한합니다.

## 하니스 최신 버전과 아카이브

활성 버전은 `harness/manifest.json`이 가리키는 **1.4.0**입니다. 버전 비교·복원과 Higgsfield 생성·복구 계약을 반영했고, 이전 **1.0.0·1.1.0·1.2.0·1.3.0** 번들은 `harness/archive/`에 원본 그대로 보존됩니다. 원본 `.claude/agents/`, `.claude/skills/` 및 `docs/harness.md`를 수정한 다음 새 버전을 승격합니다. 보존된 버전 파일은 직접 수정하지 않습니다.

```powershell
node scripts/version-harness.mjs verify
# 다음 계약을 수정한 뒤 새 버전으로 승격
node scripts/version-harness.mjs promote 1.5.0
node scripts/version-harness.mjs rollback 1.3.0
```

SHA-256 검증, 독점 잠금, 원자적 활성 포인터 변경, 중복 버전 거부와 이전 번들 보존을 수행합니다. 외부의 과거 Hermes 제작물은 삭제하거나 저장소로 무단 복사하지 않았습니다. [버전 운영 규칙](docs/harness-versioning.md)을 참고하세요.

## 지속되는 지식

| 저장소 | 책임 |
| --- | --- |
| `data/studio.sqlite` | 채널·소재·에피소드·작업·워크플로우와 버전 기록 |
| `data/knowledge/` | 운영 데이터에서 생성한 OKF Markdown 원자와 관계 그래프 |
| `llm-wiki/raw/` | 수정하지 않는 출처와 해시 |
| `llm-wiki/wiki/` | 근거·개념·설계·검증 기록, index/log |
| `.mex/` | 실제 코드 심볼에 연결한 프로젝트 메모리 |
| `.graphify/` | 코드·문서 관계와 HTML 시각화; 구조 추출과 의미 추론 여부 구분 |
| `harness/versions/`, `harness/archive/` | 재현 가능한 제작 하니스와 이전 계약 |

```powershell
mex graph rebuild --json
mex check
python .graphify/refresh.py
python .mex/verify-knowledge.py
```

## 검증과 현재 경계

운영 개요 변경의 최신 로컬 검증은 `npm run check` **61개 모듈**, `npm test` **254/254 통과·실패 0·skip 0**, 격리 브라우저 검사 **94개**, 시각 검토 **94/100 PASS**입니다. 이어서 commit `0af4b0698abcffb9f719401605fa2a6cdf1fa2ee`의 [GitHub Actions run 39201562842](https://github.com/akillness/frameforge-studio/actions/runs/39201562842)에서 Linux Docker image build, 인증 렌더·다운로드와 재시작 persistence 검증도 통과했습니다([receipt](artifacts/ops-workspace-ci-smoke.json)). CI는 격리 volume을 사용합니다. Windows 운영 서비스는 아직 최신화되지 않았습니다: Docker Desktop 시작 실패로 로컬 런처가 기존 volume에 접근하지 못해 중단됐으며 4310 listener도 없습니다. 정확한 범위와 한계는 [운영 작업공간 검증](docs/verification.md)을 참조하세요.

이전 흰색 UI의 Linux Docker 전체 테스트는 당시 소스에서 213/213 통과했습니다. 최신 운영 개요 소스는 별도 정확한 커밋 근거가 있습니다. GitHub Actions run 39201562842가 Linux Docker 이미지를 빌드·기동하고 인증 MP4를 렌더·다운로드했으며 재시작 후 영속성도 검증했습니다. 이 CI 결과는 Windows 운영 배포 영수증이 아닙니다.

```powershell
npm test
npm run check
npm run test:render
node scripts/media-smoke.mjs
node --env-file=.env scripts/workflow-smoke.mjs
node --env-file=.env scripts/production-smoke.mjs
python scripts/production-browser-smoke.py
```

자동 테스트는 인증·CSRF·경로 격리·업로드·버전 충돌·실행 실패·DAG·취소·재시작 복구·하니스 아카이브를 확인합니다. 실제 검증은 MP4 출력/다운로드, 영상 트리밍과 비무음 오디오, Google RSS, 각 에이전트 응답 및 브라우저 편집 흐름을 별도로 기록합니다. 테스트용 주입 렌더러와 실제 FFmpeg 결과를 구분합니다.

Naver의 전체 실시간 순위를 자동 수집한다고 주장하지 않습니다. YouTube 채널 등록과 제작 관리를 지원하며 채널 생성·OAuth 게시 API는 포함하지 않습니다. 게시 전 YouTube Studio에서 검토합니다. 음성은 Windows 로컬 TTS 또는 업로드 자산을 사용합니다. 에이전트 채팅은 스토리보드를 작성하며, Higgsfield 생성 노드와 프로젝트 MCP는 이미지·영상 생성 작업을 에피소드에 연결합니다. Developer API 키와 공식 MCP OAuth는 별도이며, 현재 실제 인증 경로는 호스트의 공식 CLI입니다. 참고 미디어 업로드·배우/음성 참조·배치 생성은 이 연결 범위에 포함하지 않습니다.

장면 편집기의 미리보기는 레이아웃 확인용이며 MP4와 자막 크기가 완전히 일치하지 않습니다. 최종 자막·음성·길이는 완성 영상 검토 플레이어에서 확인합니다.

ECC 2.2.3 활성 설치를 확인했고 실제 코드/검증 작업에 적용했습니다. Jev는 최신 실행기를 별도 캐시에 고정하고 `frameforge-codex` 프로필로 **이전 작업의 실제 API 검토**를 실행했습니다. 응답 모델은 `jev-1.13.0`, 결과는 `proposal_only`입니다. 과제 부합성 0.93, 근거 지지 0.80이었으나 두 항목의 확신도가 기준 0.80에 못 미쳤습니다. `unvalidated` 참고 모드이며 자동 훅·권한 부여는 없습니다. 이 기록은 이번 운영 개요 diff의 리뷰가 아닙니다. 이번에는 private profile/credential이 없어 새 diff 리뷰를 실행하지 않았습니다. [이전 응답](artifacts/jev-live-review.json), [재현 방법](docs/jev.md)을 제공합니다. API 키는 저장소 밖 비공개 프로필에서만 읽습니다.

Docker 변경에 대해서도 Jev 실제 API 검토를 추가 실행했습니다. 결과는 `proposal_only`이며, [현재 구현 검토 영수증](artifacts/jev-docker-review.json)에 근거와 한계를 보존했습니다. 자동 허가로 취급하지 않고 ECC 독립 리뷰와 실동작 검증을 별도로 완료했습니다.

설계 참고: [ComfyUI 노드](https://docs.comfy.org/development/core-concepts/nodes), [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Google Trends](https://support.google.com/trends/answer/3076011), [Naver DataLab](https://developers.naver.com/docs/serviceapi/datalab/search/search.md). README SVG는 이 프로젝트를 위해 직접 작성했습니다.
