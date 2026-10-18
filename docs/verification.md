# 실동작 검증 기록

검증일: 2026-10-18. 아래는 실제 실행 결과와 제한을 분리한 기록입니다. 테스트 주입 데이터를 운영 성공으로 취급하지 않습니다.

| 범위 | 확인한 결과 | 근거 |
| --- | --- | --- |
| 자동 테스트 | API·DAG·버전 아카이브·어댑터·경로 격리·음성 큐·정확한 파일 검토·HEVC 호환 변환 129개 통과, 실패·skip 0 | `npm test` |
| 정적 검사 | JS 50개 모듈 구문 검사 통과 | `npm run check` |
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

## 로컬 Docker 복구와 운영 전환

2026-10-18에 멈춘 `WSLService`를 정상 Windows UAC 관리자 동의 후 복구했습니다. 스크립트는 같은 PID의 Stop Pending 상태, Microsoft 서명, 실행 중인 WSL 게스트 부재를 재확인했습니다. 배포판·볼륨 삭제, Docker reset, 재부팅은 수행하지 않았습니다. 이후 별도 호스트 재시작으로 세션이 중단된 것을 관찰했으므로, 서비스 복구만으로 연속 운영을 증명했다고 주장하지 않습니다. 재개 후 Docker 29.5.2와 실제 제품을 새로 검증했습니다.

운영 URL은 이제 `frameforge-studio` Compose의 비루트·읽기 전용 컨테이너에 연결됩니다. 호스트 브리지와 Aside 명령 수신기는 Windows에서 실행됩니다. `scripts/start-docker.ps1`의 빌드 시작과 반복 시작을 실제로 확인했습니다. 기존 볼륨과 비어 있지 않은 DB를 확인하고, 다른 서비스의 포트를 종료하지 않습니다.

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
- Windows SAPI로 원고를 실제 음성으로 생성합니다. Linux Docker는 인증된 Windows 호스트 음성 브리지를 사용합니다. Higgsfield 공식 CLI를 통한 유료 영상 생성은 별도로 검증했습니다. Developer API 인증과 공식 MCP OAuth는 아직 설정 대기입니다.
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

최신 로컬 검증은 129개 테스트와 JS 50개 모듈 구문 검사를 통과했습니다. HEVC 10비트 실제 파일의 변환, 원본 해시 보존, 변환 트랜잭션 실패 시 복구, 이전 적용 이력 유지, 명시적 재적용, 중복 변환 방지 및 동시 변환 제한을 검증했습니다.

운영 컨테이너 재시작 후 기존 에피소드 5개와 미디어 16개의 ID·버전·해시, 생성 결과·적용 기록·지식 관계가 보존되었습니다. 제공자 작업은 최초 1개이며 재시작으로 재제출되지 않았습니다. `artifacts/higgsfield-persistence.json`.
