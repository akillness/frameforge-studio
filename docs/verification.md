# 실동작 검증 기록

## Single-admin canonical graph editing — 2026-10-19

Scoped local implementation on baseline `525cadd603d6ff349892633b5855e56ed38076ea`. All application tests and browser writes used disposable OS-temporary fixture databases. No production data, credentials, deployment, build, commit, push or external service execution was performed.

| Command | Observed result |
| --- | --- |
| `npm run check` | Exit 0; syntax passed for 61 modules |
| `node --test tests/api.test.mjs tests/narration.test.mjs` | Exit 0; 25/25 passed, including all 18 API tests |
| `npm test` | Exit 0; 260 passed, zero failures, zero skipped (unfiltered, after the graph-export metadata fix) |
| `node scripts/version-harness.mjs verify` | Exit 0; immutable 1.4.0 bundle verified |
| `node --test tests/harness.test.mjs` | Exit 0; 5/5 passed |
| `node scripts/ops-workspace-browser-smoke.mjs` | Exit 0; 105 checks; zero page errors, external requests or provider calls |
| `git diff --check` | Exit 0 |

The targeted regression initially showed that persisted `graph.json` must not inherit role-independent UI editing metadata. `Store.exportKnowledge()` now strips `editable`, `edit`, and `readOnlyReason` from persisted nodes/edges while retaining those fields in authenticated API graph responses; the targeted regression and complete unfiltered suite were rerun successfully.

Authorization coverage includes 32 unauthenticated mutation routes (401), real token-issued admin sessions and successful guarded edits, ignored client role claims, same-origin/cross-site rejection, and authenticated non-admin rejection (403) through the pure `requireAdmin` policy seam. Production cannot issue non-admin sessions. Browser viewer capability is mocked only to verify disabled controls and continued reads; it is not server authorization evidence.

Canonical SQLite read-back, graph JSON/OKF atom regeneration and obsolete-topic cleanup, episode history/audit, channel fingerprint and episode version conflicts, read-only/invalid edits, media/unrelated-record preservation, restart persistence, and injected audit-failure rollback are covered. Browser checks exercise channel/episode/relation edits, derived read-only topics and retained typed input after a stale conflict. Evidence and 15 screenshots are written to a fresh OS-temporary `frameforge-ops-browser-evidence-*` directory, printed by the smoke command; tracked historical receipts are untouched.

A fresh Codex read-only review of the exact candidate (same provider family as implementation, so not fully independent) returned `no_ship` and identified two UI defects: unauthenticated role gating left the persistent modal submit disabled after successful admin login, and moving the selected episode left the studio channel context stale. Both findings were reproduced by new browser-smoke assertions that failed before fixes and passed afterward. A follow-up Codex review of the updated diff returned `ship` (confidence 0.88), confirmed both fixes and found no remaining P0–P3 issues by static inspection. Neither Codex pass ran tests; coordinator-run checks are listed above, and provider independence remains limited. The reviewer noted the documented post-commit export-failure boundary and a stale relation request may be classified 400 instead of 409 although it is safely rejected. Claude's separate-provider review remains unavailable until its weekly quota resets on October 20, 2026, at 8 p.m. KST. Filesystem export remains after the SQLite commit; an export failure cannot roll back an already committed source record and is documented in the API contract.

최종 갱신: 2026-10-19. 이전 macOS 로컬 검증, 현재 Windows 로컬 운영작업공간 검증, 과거 Linux Docker 전체 테스트와 이전 Windows/Tailscale 운영 근거를 구분합니다. fixture를 라이브 제공자 성공으로 취급하지 않습니다.

## 운영 작업공간 — 2026-10-19

`public/`의 UI 전용 변경으로 운영 개요 화면, 구성 가능한 작업 큐, 브라우저 로컬 저장 뷰, API 참조 기반 결과물·이력·운영 패널을 추가했습니다. 서버/API, SQLite 모델, 자격 증명, 의존성, immutable harness는 변경하지 않았습니다.

| 범위 | 확인 결과 | 근거 |
| --- | --- | --- |
| 구문 검사 | 61개 모듈 통과, exit 0 | `npm run check`, `artifacts/ops-workspace/check.log` |
| 전체 테스트 | 254 통과, 실패 0, skip 0 | `npm test`, `artifacts/ops-workspace/test.log` |
| 격리 브라우저 검사 | 94개 검사, 페이지 오류·외부 요청·제공자 호출 0, 임시 DB 삭제 | `node scripts/ops-workspace-browser-smoke.mjs`, `artifacts/ops-workspace/browser-smoke.json` |
| 반응형 | 8개 화면, 1440/768/375px와 명시된 추가 viewport에서 문서 가로 넘침 0; tablet 표는 자체 영역에서 스크롤 | `artifacts/ops-workspace/browser-smoke.json` |
| 시각 검토 | 94/100 PASS, 차이 목록 없음 | `artifacts/ops-workspace/visual-verdict.json` 및 최종 캡처 |
| 무결성 | 소스·캡처 SHA-256 24/24 일치; harness 1.4.0 검증·불변; `git diff --check` 통과 | `artifacts/ops-workspace/verification.json`, `node scripts/version-harness.mjs verify` |
| Jev 독립 diff 리뷰 | 실행하지 않음: `frameforge-codex` private profile/credential이 로컬에 없고 status exit 2. 과거 Jev 영수증은 이번 diff 리뷰가 아님 | `artifacts/jev-live-review.json`은 이전 변경의 역사 자료 |

브라우저 smoke는 loopback 임시 DB와 명시적으로 분리된 한국어 fixture만 썼습니다. 한 번의 테스트 편집 저장은 해당 임시 DB에만 적용됐으며 production data, port 4310, provider, render, upload, publication은 건드리지 않았습니다. 결과물 뷰는 기존 API가 반환하는 media references만 표시하며 전체 uploads inventory는 아닙니다. 200% zoom 검증은 동등 viewport reflow였고, native browser zoom 및 full screen-reader certification은 수행하지 않았습니다. 이 기록은 로컬 검증을 설명합니다. 아래 CI 결과는 격리 환경 근거이며, 로컬 운영 서비스 배포는 확인되지 않았습니다.

## 최신 GitHub CI 및 로컬 운영 반영 상태 — 2026-10-19

`0af4b0698abcffb9f719401605fa2a6cdf1fa2ee`를 `main`에 push한 뒤 GitHub Actions run [39201562842](https://github.com/akillness/frameforge-studio/actions/runs/39201562842)가 성공했습니다. Node/harness 회귀 검증과 격리된 Linux Compose Docker image build, 인증된 1080×1920 H.264/AAC 렌더·다운로드, 서비스 재시작 후 episode/history/job/exact-MP4-hash 보존이 통과했습니다. [CI smoke receipt](../artifacts/ops-workspace-ci-smoke.json). 이는 runner의 격리 데이터 볼륨에 대한 증거이며 Windows 운영 서비스의 배포 완료 증거가 아닙니다.

로컬 `scripts/start-docker.ps1` 재개 시도는 Docker Desktop이 시작되지 않아 완료되지 않았습니다. `docker desktop status`는 `stopped`, `com.docker.service`는 `Stopped`, `WslService`는 `Running`, 실행 중인 WSL 배포판과 4310 listener는 없었습니다. 런처는 기존 production volume에 접근할 수 없어 안전하게 중단했습니다. 볼륨 생성·복원·삭제, SQLite 변경, 서비스 최신화는 하지 않았습니다. Docker Desktop이 사용자 세션에서 정상 실행된 뒤에만 같은 기존-volume 가드 경로로 계속할 수 있습니다; WSL 복구나 관리자 권한 동의는 별도 승인 없이 수행하지 않습니다.

## 몰입형 워크플로우와 트렌드 보존

워크플로우 미니맵은 확대·축소와 현재 뷰포트를 표시하며 클릭·방향키로 이동합니다. 도구와 실행 결과는 팝업으로 열고 닫아도 선택 노드·편집값·키보드 포커스를 보존합니다. 현재 단계의 실제 완료 상태는 유지하고, 비과금 단계는 선행 결과를 재사용하여 다시 실행할 수 있습니다. 선택 실행은 `selectedStages`, 이후 실행은 `startStage`, 이전 실행의 결과 재사용은 `resumeRunId`로 구분합니다. 유료 생성은 별도 동의가 필요하며 기존 생성 요청을 재제출하는 복구 경로로 사용하지 않습니다.

완료된 생성 결과를 재사용하면서 스토리보드를 다시 만드는 조합은 기존 유료 미디어를 덮어쓰지 않도록 실행 생성 전에 409로 거부합니다. 취소·재개가 이어져도 기존 생성 작업 ID를 보존하고 재사용합니다.

트렌드 수집은 실행 중복을 막는 예약 작업으로 관리합니다. 보존 기간은 최소 14일이며 더 짧은 설정은 거부합니다. 인기·선택 키워드를 조회할 수 있고, 보존 정리에서 에피소드와 과거 이력이 참조하는 미디어는 삭제하지 않습니다. Naver 수동 출처 기록과 실제 수집 성공은 구분합니다.

- `scripts/workflow-browser-smoke.py`는 격리 루프백에서 미니맵·팝업·단계 실행 요청·폴링 종료를 검사합니다. 실행 응답은 fixture이며 유료 생성이나 외부 게시를 검증하지 않습니다.
- `scripts/trends-browser-smoke.py`는 격리 루프백에서 키워드 조회·선택·설정·에피소드 생성 흐름을 검사합니다. 실제 외부 수집 버튼은 실행하지 않습니다.
- [성능 측정](../artifacts/runtime-efficiency.json)은 동일 SQLite fixture에서 지식 그래프 순회·중복 제거 변경의 약 4.58배 속도 향상을 기록합니다. 단일 합성 측정이며 실제 운영 처리량이나 힙 감소를 입증하지 않습니다.
- [채널 게시 감사](../artifacts/channel-publication-audit.json)는 채널 메타데이터와 실제 업로드를 구분합니다. OAuth·업로드·게시 확인 어댑터가 없으므로 연결 채널로 직접 게시 완료를 주장하지 않습니다.
- [Jev 검토](../artifacts/jev-immersive-workflow-review.json)는 `proposal_only` 자문이며 자동 실행 권한이나 QA 통과 판정이 아닙니다.

최종 격리 Docker(`127.0.0.1:4329`)에서 [워크플로우 브라우저 20개 검사](../artifacts/workflow-browser-smoke-4329.json)와 [트렌드 브라우저 11개 검사](../artifacts/trends-browser-smoke-4329.json)가 통과했습니다. [컨테이너 렌더·재시작 영수증](../artifacts/immersive-container-smoke.json)은 인증 다운로드, 1080×1920 H.264/AAC 출력과 동일 해시·편집 이력의 재시작 보존을 확인합니다. 컨테이너에서 생성한 다운로드 파일의 코덱은 호스트 `ffprobe`로 검사했습니다.

최종 회귀 명령 `node --test tests/workflows.test.mjs tests/trend-collector.test.mjs tests/trends-api.test.mjs tests/store-knowledge.test.mjs tests/narration.test.mjs tests/generations.test.mjs`는 64개 통과·실패 0개를 기록했습니다. `npm run check`는 59개 모듈의 구문 검사를 통과했고, `docker build -t frameforge-studio:immersive-20261018 .`로 위 격리 검증 이미지를 빌드했습니다. 이 검증은 운영 배포나 새로운 유료 제공자 요청을 포함하지 않습니다.

아래 흰색 제작실 영수증은 앞선 변경의 근거입니다. 새 변경의 최종 이미지·브라우저·회귀 결과는 별도 영수증으로 구분합니다.

## 흰색 제작실 — 앞선 macOS 로컬 QA

Studio·Workflow·Trends·Templates·History·Knowledge·Settings 7개 화면의 흰색 UI와 기존 Higgsfield 검사기 재사용, 개인 작업 창을 검증했습니다. 개인 작업 창은 `자동 맞춤`(도킹형), `컴팩트` 1024×768(오버레이), `표준` 1280×800(도킹형), `와이드` 1600×900(도킹형), `집중` 1280×800(오버레이) 프리셋을 제공하고, 숫자 입력(폭 320–2560px·높이 320–1800px·검사기 240–480px), 포인터 드래그와 방향키(Shift 큰 간격)로 사용자 지정 크기를 조절합니다. 검사기·내레이션·어시스턴트는 기존 DOM을 옮기는 native dialog 오버레이이며, named profile은 브라우저 로컬에만 저장되고 서버 레이아웃 쓰기는 없습니다. 어시스턴트 제출 전 초안은 에피소드 범위의 일시 상태이고 검사기 편집은 선택 장면 범위입니다. 이번 변경에서 유료 생성·공개 배포·Windows/Tailscale 운영 전환은 수행하지 않았습니다. [조사 영수증](../artifacts/white-studio-research.json)은 16개 디자인 근거, 12개 공식 Higgsfield 근거와 Aside 공개 UI 관찰을 담습니다. 관찰된 웹 크레딧 표시는 계정별 API 견적이 아닙니다.

| 범위 | 확인한 결과 | 근거 |
| --- | --- | --- |
| 선택 회귀 | 16개 통과. REST 견적·영속 작업 ID 멱등성·안전한 생성 초안·실행 전 버전 거부 | `node --test tests/white-studio.test.mjs tests/white-studio-versions.test.mjs` |
| 구문 검사 | JS 55개 모듈 통과 | `npm run check` |
| 최종 전체 테스트 | Linux Docker에서 213개 통과·실패 0·skip 0 | `npm test`, [전체 테스트 영수증](artifact://453) |
| 호스트 MP4 | 실제 FFmpeg 1080×1920 H.264/AAC 약 2초 출력 | `node scripts/render-smoke.mjs`, [호스트 영수증](../artifacts/render-smoke.json) |
| 흰색 제작실 브라우저 | 4329 포트 인증 브라우저 101/101개 통과, 페이지 오류 0·생성 create 0·허용된 실행 0 | `artifacts/white-studio-browser-smoke.json` |
| 개인 작업 창 브라우저 | 4329 포트 인증 브라우저 157/157개 통과, 페이지 오류 0·레이아웃 API 쓰기 0; 프리셋·리사이즈·오버레이·profiles·scene/episode 상태 경계를 검사 | [작업 창 영수증](../artifacts/workspace-browser-smoke.json), [작업 창 이미지](assets/workspace/final-workspace.png) |
| 비용·버전 경계 | 정확한 입력의 새 견적/취소, 견적 실패의 명시적 미확인 동의, 실제 서버의 오래된 워크플로우·에피소드 버전 409 2건, 별도 fixture 409 1건 | 흰색 브라우저 영수증; 제공자 catalog·quote는 fixture |
| 복구·적용 | 기존 요청 복구 1건·별도 Apply 1건, 대상 sceneId·현재 버전 전송, 새 생성 없음 | 흰색 브라우저 영수증; recovery·apply 응답은 fixture이며 라이브 제공자 복구 증거 아님 |
| 최종 격리 컨테이너 | 실제 렌더·인증 다운로드 1080×1920 H.264/AAC, 1.021333초·14080바이트, 동일 SHA-256의 정확한 출력 검토와 재시작 영속성 통과 | [컨테이너 영수증](../artifacts/white-studio-container-smoke.json), `stage: persistence-verified`, `persistenceVerified: true` |

최종 이미지 SHA-256은 `d4424d7f59c495f97d72ea2e85fb643fe64e9f35b69ff374da90617ca9ce6023`이며, 최종 영수증은 검사한 이미지 소스 SHA-256 **15/15개 일치**를 기록합니다. 같은 최종 이미지의 인증 브라우저 검사와 `runContainerSmoke(render) → docker restart → runContainerSmoke(verify-persistence)` 결과는 [최종 로컬 검증 영수증](../artifacts/white-studio-verification.json)에 기록합니다. 이는 공개 운영 배포·라이브 Higgsfield 생성·Developer REST 인증 또는 최종 독립 리뷰 통과의 증거가 아니며, 이전 Docker CI·Windows/Tailscale 기록과 구분합니다.

Studio CTA는 저장·실행·과금 없이 현재 선택 장면을 안정 ID로 추적하는 기존 검사기를 엽니다. 안전한 기존 대본 경로가 없으면 `script(existing) → storyboard → generate → render → review` 5노드 초안을 생성합니다. 전체 생성 워크플로우는 동의 후 결과를 버전 검사하여 **자동 적용한 다음 렌더**하며, 보존·복구한 출력은 별도 Apply로 적용합니다. 실행 API의 선택적 `expectedWorkflowVersion`·`expectedEpisodeVersion`은 제공 시 오래된 값을 작업 생성 전에 409로 거부합니다.

REST는 공식 `POST /estimate/{model}`을 호출하고 영속 `generationJobs.id`를 `Idempotency-Key`로 전송합니다. 자동 재제출은 추가하지 않았습니다. 모호한 제출은 제공자 기록 확인, 알려진 ID는 polling/import 복구로 처리합니다. 인증·API·CLI·공식 MCP·프로젝트 MCP 구분은 [연결 문서](higgsfield-integration.md)를 따릅니다. 설정·목록·fixture 성공은 실제 인증·생성 성공과 다릅니다. 하니스 1.4.0 및 보존 번들은 변경하지 않았습니다.

## 이전 Windows/Tailscale 및 소스별 검증 기록

아래 결과는 각 영수증의 당시 소스·호스트에서 관찰한 역사적 근거입니다. 최신 흰색 UI와 개인 작업 창의 최종 전체 테스트·브라우저 검증은 위 표와 최종 영수증에서 별도로 확인합니다.

| 범위 | 확인한 결과 | 근거 |
| --- | --- | --- |
| 자동 테스트 | API·DAG·버전 아카이브·어댑터·경로 격리·음성 큐·정확한 파일 검토·HEVC 호환 변환 129개 통과, 실패·skip 0 | `npm test` |
| 당시 정적 검사 | JS 50개 모듈 구문 검사 통과; 최종 로컬 검사는 위 55개 | 당시 `npm run check` |
| MP4 | 실제 FFmpeg 1080×1920, H.264/AAC, 2초 출력 | `artifacts/render-smoke.json` |
| 실제 API 제작 | 채널→에피소드→템플릿→장면 저장→렌더→인증 다운로드, 3개 스냅샷 | `artifacts/acceptance.json` |
| 미디어 편집 | 업로드 영상 1초 시작점·1초 출력, 별도 음원 볼륨 0.5, 비무음 검출 | `artifacts/media-smoke.json` |
| 실제 음성 제작 | Microsoft Heami Desktop 한국어 음성 → WAV → 저장된 편집본 워크플로우 → 1080×1920 MP4, 4.821초·평균 −24 dB, 버전·SHA-256 결합 검토 기록 | `artifacts/production-smoke.json` |
| 미디어 입력 격리 | MP4로 위장한 DASH의 업로드 밖 참조를 재현하고 probe·영상·음성 입력에서 차단; 정상 11개 확장자 decode와 실제 합성 렌더 통과 | `tests/render-security.test.mjs`, [FFmpeg format_whitelist](https://ffmpeg.org/ffmpeg-formats.html) |
| 제작 브라우저 | 실제 한국어 음성 생성·오디오와 MP4 재생 시간 진행·저장된 편집본 실행·수정 요청 영속성, 1440/390px 넘침 없음·페이지 오류 0 | `artifacts/production-browser-smoke.json` |
| 라이브 에이전트 | Codex·JEO·JEOPI 각각 실제 응답에서 검증된 3개 장면 반환 | `artifacts/agent-*.json` |
| 전체 노드 실행 | 실제 Google RSS→레퍼런스→Codex→스토리보드 버전→FFmpeg→검토 대기 | `artifacts/workflow-smoke.json` |
| 브라우저 | Aside에서 HTTPS 로그인·채널 조회·노드 저장; Playwright에서 장면 영속 저장·연결 해제/재연결·노드 이동/저장·명령 수신/제출, 모바일 390px 가로 넘침 없음, 페이지 오류 0 | `artifacts/browser-smoke.json`, `docs/assets/*-desktop.png`, `docs/assets/workflow-mobile.png` |
| 채널 | Aside YouTube Studio 계정 전환 화면에서 지정 계정의 3개 채널 확인 | 운영 데이터에만 계정 이메일 저장 |
| Aside | 세션 `9XBgVHBJYEGclLhz`에 경과보고, 실제 JSONL append, 서비스 명령함 수신 | Git 제외 `ops/aside-inbox.jsonl`, 명령 API |
| 하니스 | 1.0.0→1.1.0→1.2.0→1.3.0→1.4.0 실제 승격, 이전 네 버전의 원본 보존, SHA-256 검증 | `harness/manifest.json`, `harness/archive/` |
| MEX/Wiki | 실제 코드 그래프·심볼 grounding, 지식 구조 validator | `.mex/verification.json`, `.graphify/verification.json`, `.graphify/GRAPH_REPORT.md` |
| ECC | 활성 native plugin `ecc@ecc` 2.2.3 확인, 설치 추가 없음 | `codex plugin list --json` |
| Jev | 격리 프로필로 실제 API 호출, `jev-1.13.0`, `proposal_only`, 528ms, 자동 권한 부여 없음 | `artifacts/jev-live-review.json`, `docs/jev.md` |
| Tailscale | 요청 계정으로 HTTPS Serve 활성화, 실제 브라우저 접근 | `tailscale serve status`; Funnel 비활성 |
| Docker | Linux CI에서 이미지 빌드·비루트/읽기전용 Compose 기동·실제 1080×1920 H.264/AAC 렌더·인증 다운로드·저장 편집본 검토·재시작 후 에피소드/이력/작업/검토/MP4 SHA-256 보존 통과 | `artifacts/docker-ci-smoke.json`, [CI 39110221470](https://github.com/akillness/frameforge-studio/actions/runs/39110221470) |

## 이전 Windows Docker 복구와 운영 전환

2026-10-18에 멈춘 `WSLService`를 정상 Windows UAC 관리자 동의 후 복구했습니다. 스크립트는 같은 PID의 Stop Pending 상태, Microsoft 서명, 실행 중인 WSL 게스트 부재를 재확인했습니다. 배포판·볼륨 삭제, Docker reset, 재부팅은 수행하지 않았습니다. 이후 별도 호스트 재시작으로 세션이 중단된 것을 관찰했으므로, 서비스 복구만으로 연속 운영을 증명했다고 주장하지 않습니다. 재개 후 Docker 29.5.2와 실제 제품을 새로 검증했습니다.

당시 운영 URL을 `frameforge-studio` Compose의 비루트·읽기 전용 컨테이너에 연결했습니다. 호스트 브리지와 Aside 명령 수신기는 Windows에서 실행했습니다. `scripts/start-docker.ps1`의 빌드 시작과 반복 시작을 확인했고, 기존 볼륨과 비어 있지 않은 DB를 확인하며 다른 서비스의 포트를 종료하지 않았습니다. 최신 macOS QA는 이 경로의 재배포·현재 가용성을 입증하지 않습니다.

| 실제 검증 | 결과 | 근거 |
| --- | --- | --- |
| 데이터 이전 | 기존 채널 4개·에피소드 3개·원래 ID/버전, 미디어 10개 해시 보존; SQLite integrity 및 이력 테이블 수 일치 | `artifacts/docker-migration.json`, 비공개 snapshot/import manifest |
| 컨테이너 → Windows 음성 | 인증 브리지의 Microsoft Heami Desktop으로 WAV 생성, 4.821333초 1080×1920 H.264/AAC, 평균 −24.1 dB, 정확한 해시 검토 | `artifacts/docker-live-production-smoke.json` |
| HTTPS 브라우저 | 실제 음성·영상 재생, 수정 요청 저장·재조회, Secure 쿠키, 1440/390px 넘침 없음, 페이지 오류 0 | `artifacts/docker-live-production-browser-smoke.json` |
| Codex 실제 호출 | 컨테이너 → 호스트 Codex → 저장된 스토리보드 → FFmpeg → 검토 대기; 이번 경로는 4노드이며 RSS 재수집 증거가 아님 | `artifacts/docker-workflow-smoke.json` |
| 운영 재시작 | 에피소드·작업·이력·검토 결정과 동일 MP4 SHA-256 유지; 원래 데이터도 재확인 | `artifacts/live-container-smoke.json`, `artifacts/docker-migration.json` |
| ECC 독립 리뷰 | 77/77 회귀 테스트, JS 38개 구문 검사; 발견한 빈 볼륨 시작 방어 보완 | `artifacts/docker-verification.json` |
| Jev | 현재 Docker 구현과 위 근거를 실제 API로 검토; advisory이며 자동 실행 허가 아님 | `artifacts/jev-docker-review.json` |

원본 호스트 `data/`, 별도 staging/production 스냅샷과 테스트 볼륨을 보존했습니다. staging 컨테이너는 검증 후 중지했으며 볼륨은 삭제하지 않았습니다. 이전 Linux CI 및 Windows-native 영수증도 각각 과거 근거로 유지합니다. [시작·이전·복구 절차](docker-operations.md)를 따릅니다.

## 현재 기능 경계

- 지식 그래프는 근거 관계이며, 워크플로우 그래프는 실행 의존성입니다. 둘을 같은 그래프로 위장하지 않습니다.
- `awaiting_review`는 검토 대기이며, `approved`·`changes_requested`는 정확한 렌더 파일에 대한 내부 결정입니다. smoke의 결정은 자동화된 기능 검사이며 소유자의 콘텐츠 수락이 아닙니다. YouTube 게시 및 신규 외부 채널 생성 API는 연결하지 않았습니다.
- Naver는 DataLab 출처를 수동 기록하며 전체 인기검색어 실시간 순위를 가장하지 않습니다.
- Windows SAPI 한국어 음성과 Linux Docker의 인증된 Windows 호스트 브리지 경로는 이전 영수증으로 검증했습니다. Higgsfield 공식 CLI의 유료 영상 생성도 별도 과거 근거입니다. 당시 Developer API 인증과 공식 MCP OAuth는 설정 대기였으며, 이번 로컬 QA에서 재인증하거나 유료 생성하지 않았습니다.
- 워크플로우 취소는 이후 단계와 쓰기를 중지합니다. 이미 시작한 외부 추론·렌더링 프로세스가 완료될 수 있습니다.
- 외부 CLI 인증과 provider availability는 바뀔 수 있습니다. 브리지는 실패를 성공 데이터로 바꾸지 않습니다.
- Graphify 구조 추출과 placeholder community labels는 의미 추론 완료와 구분합니다. MEX 파일 형식 인식 범위는 실제 설치 버전의 결과를 따릅니다.
- 장면 편집기와 MP4의 자막 크기에 차이가 있습니다. 완성 영상 검토 플레이어는 실제 MP4를 재생하며 최종 출력 확인은 이 화면을 기준으로 합니다.

## 재검증

```powershell
npm test
npm run check
node scripts/version-harness.mjs verify
python .mex/verify-knowledge.py
node scripts/render-smoke.mjs
node scripts/media-smoke.mjs
node --env-file=.env scripts/workflow-smoke.mjs
node --env-file=.env scripts/production-smoke.mjs
python scripts/production-browser-smoke.py
docker compose config --quiet
```

실서비스 smoke는 에피소드·렌더링·작업 이력을 추가합니다. private 미디어, 계정 설정, 로그인 세션, 토큰 및 원본 Aside transcript는 Git에 포함하지 않습니다.

## Higgsfield 및 편집 이력 개선 — 2026-10-18

- 실제 프로젝트 MCP stdio → 인증된 API → Docker/호스트 공식 CLI → Seedance 2.5 영상 생성·다운로드·해시검사·에피소드 v3 적용·MP4 렌더 완료. 원본 영상 1080×1920, 4.042초, 견적64크레딧(실제 청구 명세 검증 아님). `artifacts/higgsfield-live-smoke.json`.
- 사용성 23개 체크, JavaScript 오류0, 1440/390px 넘침 없음. 대체 Developer API 모델 목록·복구 UI는 명시적 HTTP fixture; 실제 제공자 생성 성공 증거와 구분. `artifacts/usability-browser-smoke.json`.
- 운영 HTTPS 검사에서 원본 HEVC/yuv420p10le의 시간만 진행되고 `videoWidth`가 0인 문제를 발견해 수정했습니다. 호환 변환 후 실제 디코딩 크기 1080×1920과 표시 프레임을 확인했고, 브라우저 21개 검사·1440/390px 가로 넘침 없음·페이지 오류 0을 통과했습니다. v5 적용 후 저장된 장면을 보존해 v6로 렌더했으며 추가 생성이나 공개 승인은 없었습니다. `artifacts/higgsfield-browser-smoke.json`.
- 원본 파일과 SHA-256을 보존한 채 로컬 FFmpeg로 H.264/yuv420p/AAC MP4를 생성했습니다. 1080×1920, 4.042초이며, 명시적 적용으로 에피소드 v5를 만들었습니다. 추가 제공자 생성 호출은 없었습니다. `artifacts/higgsfield-normalization.json`은 원본 보존·호환 코덱·새 버전 적용의 근거이며 브라우저 최종 통과 영수증은 아닙니다.
- 공식 원격 MCP는 OAuth 대기, Developer API 키는 미설정. `.mcp.json` 등록과 계약테스트를 인증 완료로 주장하지 않음. 실제 로그인·생성은 공식CLI 경로.
- Jev 실제 API 리뷰는 `proposal_only`/`unvalidated`이며 자동권한이 아님. ECC 독립리뷰에서 API카탈로그 오류, 복구경로 부재, 제출 전429분류 및 MCP 쿠키 인증을 수정.

이전 개선의 로컬 실행은 129개 테스트와 JS 50개 모듈 구문 검사를 통과했습니다. HEVC 10비트 실제 파일의 변환, 원본 해시 보존, 변환 트랜잭션 실패 시 복구, 이전 적용 이력 유지, 명시적 재적용, 중복 변환 방지 및 동시 변환 제한을 검증했습니다. 최신 흰색 UI·개인 작업 창 변경은 선택 회귀 16개, 최종 55개 모듈 구문 검사, Linux Docker 전체 테스트 213개(실패·skip 0), 흰색 브라우저 101개와 작업 창 브라우저 157개로 검증했습니다.

운영 컨테이너 재시작 후 기존 에피소드 5개와 미디어 16개의 ID·버전·해시, 생성 결과·적용 기록·지식 관계가 보존되었습니다. 제공자 작업은 최초 1개이며 재시작으로 재제출되지 않았습니다. `artifacts/higgsfield-persistence.json`.
