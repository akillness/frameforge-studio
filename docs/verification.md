# 실동작 검증 기록

검증일: 2026-10-18. 아래는 실제 실행 결과와 제한을 분리한 기록입니다. 테스트 주입 데이터를 운영 성공으로 취급하지 않습니다.

| 범위 | 확인한 결과 | 근거 |
| --- | --- | --- |
| 자동 테스트 | API·DAG·버전 아카이브·어댑터·경로 격리·음성 큐·정확한 파일 검토 58개 통과, skip 0 | `npm test` |
| 정적 검사 | JS 모듈 구문 검사 통과 | `npm run check` |
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
| 하니스 | 1.0.0→1.1.0→1.2.0 실제 승격, 이전 두 버전의 원본 보존, SHA-256 검증 | `harness/manifest.json`, `harness/archive/` |
| MEX/Wiki | 실제 코드 그래프·심볼 grounding, 지식 구조 validator | `.mex/verification.json`, `.graphify/verification.json`, `.graphify/GRAPH_REPORT.md` |
| ECC | 활성 native plugin `ecc@ecc` 2.2.3 확인, 설치 추가 없음 | `codex plugin list --json` |
| Jev | 격리 프로필로 실제 API 호출, `jev-1.13.0`, `proposal_only`, 528ms, 자동 권한 부여 없음 | `artifacts/jev-live-review.json`, `docs/jev.md` |
| Tailscale | 요청 계정으로 HTTPS Serve 활성화, 실제 브라우저 접근 | `tailscale serve status`; Funnel 비활성 |
| Docker | Linux CI에서 이미지 빌드·비루트/읽기전용 Compose 기동·실제 1080×1920 H.264/AAC 렌더·인증 다운로드·재시작 후 에피소드/이력/작업/MP4 SHA-256 보존 통과 | `artifacts/container-smoke.json`, [CI 39091649080](https://github.com/akillness/frameforge-studio/actions/runs/39091649080) |

## Docker 실행이 막힌 지점

Docker Desktop 4.76의 현재 로그는 `DockerDesktop/Wsl/CommandTimedOut`를 기록합니다. `wsl.exe -l -v --all`에서 배포판 열거가 종료되지 않았고 WSLService는 `Stop Pending` 상태였습니다. 실행 중인 Linux 작업은 관찰되지 않았습니다. Docker 종료 시도는 실패했고, 멈춘 WSLService만 중지하려는 시도는 `Access is denied`, 서비스 시작도 권한 오류로 거부되었습니다.

배포판 삭제, Docker factory reset, 컴퓨터 재부팅은 수행하지 않았습니다. 이후 **Linux GitHub CI에서 이미지 빌드·컨테이너 기동·컨테이너 내부 렌더링과 재시작 영속성을 검증**했습니다. 검증된 소스 커밋은 `f384821e7c0d66719da52171721b00910c5b0d4e`이며 결과는 `artifacts/container-smoke.json`에 저장했습니다. 컨테이너에서 호스트의 인증된 에이전트 브리지를 호출하는 경로는 CI 범위에 포함되지 않습니다.

현재 URL은 숨김 창으로 지속 실행한 호스트 Node 프로세스에 연결됩니다. Windows 관리자 권한으로 WSL 서비스를 복구한 뒤 이 PC에서 `docker compose up -d --build`와 같은 실동작 검증을 다시 실행해야 합니다. 호스트 `data/`에서 Docker 볼륨으로 데이터 전환 시 별도 백업/복사가 필요합니다. HTTPS 운영의 `PUBLIC_ORIGIN`을 설정했고 브라우저에서 Secure·HttpOnly·SameSite=Strict 쿠키를 확인했습니다.

## 현재 기능 경계

- 지식 그래프는 근거 관계이며, 워크플로우 그래프는 실행 의존성입니다. 둘을 같은 그래프로 위장하지 않습니다.
- `awaiting_review`는 검토 대기이며, `approved`·`changes_requested`는 정확한 렌더 파일에 대한 내부 결정입니다. smoke의 결정은 자동화된 기능 검사이며 소유자의 콘텐츠 수락이 아닙니다. YouTube 게시 및 신규 외부 채널 생성 API는 연결하지 않았습니다.
- Naver는 DataLab 출처를 수동 기록하며 전체 인기검색어 실시간 순위를 가장하지 않습니다.
- Windows SAPI로 원고를 실제 음성으로 생성합니다. Linux Docker에서는 제공자가 비활성이며 기존 음성 업로드·렌더가 가능합니다. 클라우드 유료 TTS 및 배우 영상 생성은 연결하지 않았습니다.
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
