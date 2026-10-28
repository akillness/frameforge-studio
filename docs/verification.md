# 실동작 검증 기록

## Scoped source and isolated-fixture checks — 2026-10-28

This record covers documentation of the current source-level checks only. It is not a deployment, Docker, WSL, live-service, public, or provider verification, and it does not assert a full-suite pass. Docker Desktop was inaccessible and WSL reported an optional component required, so no container result is claimed for this date.

- **Version and knowledge gates:** `node scripts/version-harness.mjs verify` passed for the immutable 1.7.2 selection. `node scripts/knowledge.mjs check` passed within its bounded admitted scope only; this is not a whole-vault or legacy-lint pass.
- **Isolated focused suites:** the menu suite passed 26/26, the UI focus suite passed 5/5, and the paid lost-source regression suite `tests/workflow-paid-lost-source.test.mjs` passed 11/11. All three use isolated fixtures and mock providers, not live providers.
- **Changed-file test run:** of 249 changed test files, 247 passed and 2 failed. The two failing files are not resolved in this record, and the run is not a full-suite pass.
- **Node-native scale journey:** a standalone rerun of the 128-node/256-edge journey still failed with a 5000 ms screenshot timeout. The earlier 2026-10-26 receipt is not superseded by this observation and is not re-established here.
- **Sequential journey review:** an initial approval-state error was fixed, but the review is still in progress. The publish step now fails with the UI idle/blocked state not reached as expected. The review is not closed.
- **Paid recovery boundary:** the unsettled-job guard is source-level evidence only. A `submission_unknown` request has no `providerRequestId`, so `recover()` and generation-panel apply cannot act on it, and the app offers no confirm or abandon path. It remains blocked (`generation_unresolved`) until manual investigation and a separate product decision.
- **Not verified here:** Docker and WSL, deployed image behaviour, live service operation, public publication, and provider generation or account access. Jev `jeopi` route status is recorded in `.mex/ROUTER.md` and is not reproduced here.

- **Follow-up observations (same date, after the entries above):**
  - Backend four-file command `node --test --test-concurrency=1 tests/workflows.test.mjs tests/workflow-plan.test.mjs tests/workflow-paid-lost-source.test.mjs tests/workflow-skip.test.mjs` passed 94/94 with isolated fixtures and mock providers.
  - Menu and UI command `node --test --test-concurrency=1 tests/workflow-menu-run.test.mjs tests/workflow-dialog-focus.test.mjs` passed 35/35.
  - The "sequential reviewed producers" targeted journey passed after its server-planner async synchronization was fixed.
  - The standalone 128-node screenshot reproduction still fails with a 5000 ms timeout.
  - The 247/249 changed-file result above is preserved as recorded at that point. It must not be read as a full-suite pass, and the current full suite is not claimed to pass.
  - Graph native preflight was not refreshed: staleness and privacy exclusion were not confirmed, and the SQLite handle state is unknown. `knowledge check` passed, within the admitted scope only.
  - Not performed: Docker rebuild, live account access, paid provider calls, or push. Docker, live-service, public and provider status remain unverified.

- **Later focused verification (same date):** `node --test --test-concurrency=1 tests/workflows.test.mjs tests/workflow-plan.test.mjs tests/workflow-paid-lost-source.test.mjs tests/workflow-skip.test.mjs tests/workflow-final-edge.test.mjs tests/workflow-review-status.test.mjs` passed 103/103; `node --test --test-concurrency=1 tests/workflow-menu-run.test.mjs tests/workflow-dialog-focus.test.mjs` passed 36/36. `node --test --test-concurrency=1 --test-name-pattern="sequential reviewed producers" tests/production-workspace-journey.test.mjs` passed 1/1. These use isolated fixtures, not live providers. `node scripts/check.mjs` passed syntax checks for 163 modules; harness verification and bounded knowledge check passed. The 128-node full-page screenshot and Docker deployment remain blocked as recorded above.
  - A responsive stacked-grid change was followed by `node --test --test-concurrency=1 --test-name-pattern="128-node/256-edge" tests/production-workspace-journey.test.mjs`: 1/1 passed under the existing 5000 ms screenshot limit. The 1024 px PNG is 14,107 px tall, below the observed 16,384 px wrap boundary. This does not establish valid mobile screenshots: direct pixel comparison of the 375 px and 320 px PNGs showed their content after y=16,384 repeats the image from y=0 exactly. Their full-page visual evidence remains invalid despite the passing test.
  - `node --test --test-concurrency=1 tests/workflow-history-compact.test.mjs tests/run-diff.test.mjs tests/workflow-retained-results-ui.test.mjs tests/workflow-stage-unblock.test.mjs tests/workflow-sequential-node-ui.test.mjs tests/production-publication.test.mjs` passed 115/115 using isolated fixtures.

- **Large-canvas screenshot diagnosis (investigation, not verified):**
  - Observed: the 1024 px viewport 128-node stacked output is about 25,085 px tall, and the standalone screenshot hit its 5000 ms timeout.
  - Observed: an earlier screenshot repeated the screen after y=16384, so it is not valid full-page evidence.
  - Hypothesis, not established: the height and capture cost of the stacked layout are the likely cause of the timeout. Rendering or performance cause is unconfirmed.
  - No layout change has been approved or verified. This record does not claim a fix.

## Harness knowledge delivery audit — 2026-10-26

This later audit supersedes the earlier missing-receipt observation below only where new evidence exists. The now-present native-workbench receipt remains isolated candidate UI evidence, not proof of original-video readability, account access or owner acceptance. Harness/knowledge work is a separate deliverable; its safe machine-readable summary is [`.graphify/harness-audit.json`](../.graphify/harness-audit.json).

- **Actual code gates:** `node --test --test-reporter=spec tests/project-knowledge.test.mjs tests/project-agent.test.mjs tests/harness-context.test.mjs` passed 77/77 with zero skips; `python -m unittest discover -s .graphify -p test_refresh*.py -v` passed 26/26; `npm run check` passed syntax checks for 118 modules. The earlier consolidated changed-test JUnit was independently counted at 285 cases, zero failures/errors/skips; it is a separate recorded run, not an added test total.
- **Learning round trip:** the reviewed entity now records admission, Windows newline freshness and tool-free contract boundaries. Its exact SHA-256 was explicitly repinned; `node scripts/knowledge.mjs index --write`, `check`, and actual `search newline` exercise source → reviewed policy → navigation → retrieval. Ten pages are admitted; raw captures, automatic prompt/query stubs and generated caches are not.
- **Measured context, not billed tokens:** the same three startup anchors changed from 40,917 to 15,280 bytes (62.7% fewer); those anchors plus the now-conditional architecture map changed from 58,156 to 22,360 bytes. Five fresh-process observations per knowledge command all succeeded with stable measured inputs: status median 454 ms, search 490 ms, check 696 ms; RSS ranged 56,152–56,312 KiB. These new commands have no old semantic-equivalent baseline, so no latency/RSS speedup or provider billing saving is claimed.
- **Actual local rollout:** the tested image was promoted with `docker compose --project-name frameforge-studio --file compose.yaml --env-file .env up -d --no-deps --no-build --wait --wait-timeout 60 studio`. Production became healthy; authenticated login, `/api/blog/state` and `/blog.html` returned 200. All 173 runtime files matched current checkout bytes; every existing table schema/row digest and 29 media digests matched the immediate pre-cutover baseline. The ownership-verified host bridge also returned the selected 1.7.2, 1,241-byte contract. The first operational blog probe used an incorrect `/api/blog/accounts` URL and returned 404; it was corrected against the existing dispatcher, not by adding a route or changing a test.
- **Preservation and remaining gates:** all 187 files in the retained 12:01 operation baseline still match exactly, with zero changes/missing files. The earlier 161-file audit-start digest map was not retained; whole-session preservation for that initial set remains unproved, not passed. Native graph publication passed, but structural output is not semantic verification. Legacy full-vault failures remain failed. Jev `jeopi` remains disabled/unconfigured; no successful API routing/review, new provider generation, public blog publication or scheduler activation is claimed. All five schedules remain disabled.

**Final package/publication correction:** the first image's 173-file inventory exposed one unnecessary `scripts/__pycache__` bytecode file. The build-context deny rules now exclude Python caches; the rebuilt and actually deployed `harness-audit-20261026-clean` image contains 172 source files, zero generated cache entries and the same verified contract. All 172 source bytes, prior row/schema digests and 29 media digests were rechecked after this second healthy cutover. Host cache/history files were preserved, not force-added to Git. A separate staged-byte check caught Git newline normalization changing runtime/graph bytes; the default byte-preserving attribute fixes that source problem. Fifteen additional already-tracked runtime files differ from HEAD only in preserved CRLF bytes, with no logical source edits; authored wiki staging excludes only private capture suffixes.

## Context governance correction — 2026-10-26

This is a documentation/admission-boundary correction, not a new render, deployment, CI or provider verification. Root/MEX instructions are the constitution; `.mex/context/architecture.md` is the ownership map; `.mex/ROUTER.md` is current status; this record and `llm-wiki/log.md` retain history. The archive below preserves removed long routing/map blocks verbatim, including original failed references, source paths and block hashes. It is loaded only for relevant historical reconciliation, not at every session entry.

**Unavailable native-workbench receipt:** `artifacts/node-native-workbench/verification.json` does not exist at this correction. The three original router/architecture/log links and the entity/workspace-pattern follow-on references must not be cited as successful verification. Their original wording is preserved in the archived snapshots; current references explicitly mark evidence pending/unavailable. The candidate narration (five articles, six scenes, 53.721333-second 1080×1920 H.264/AAC at `awaiting_review`) remains a historical claim awaiting its missing receipt, not established render/deployment/owner acceptance or a completed exact-image cutover. Resolve current harness identity from the selected manifest, not the archived 1.7.1/1.7.0/1.6.0 observations.

The existing [knowledge-only receipt](../artifacts/node-native-workbench/knowledge-refresh.json), captured 2026-10-25T15:14:22.216Z, covers bounded structural/privacy work only: MEX check score 67, exit 1; wiki/OKF exit 1 with 3408 diagnostics; unresolved import endpoints 512; final source freshness held after subsequent patches. Its harness checksum observation and successful structural extraction do not fill the missing native/browser/render/deployment receipt. The earlier audit retained 1705 diagnostics; those and 3408 describe different failed snapshots. No full-vault validator was relaxed and no clean full-vault result is claimed.

**Enforcement boundary:** `scripts/knowledge.mjs` and the explicit repository policy gate admitted paths, bytes/hashes, historical labels and bounded search/index output; captured prompt/query stubs and generated caches are not admitted. `scripts/project-agent.mjs` uses the documented launch-scoped `LLM_WIKI_VAULT` override under private `data/agent-captures`, preserves task argv and rejects conflicting external overrides. This is supported process containment, not a repo-policy opt-out or universal hook enforcement. The current audit process uses its private capture subfolder without changing vendor/global settings. The bridge remains `--no-rules`/`--no-tools` isolated and receives only a checksum/size-validated dedicated immutable Bridge Runtime Contract after promotion, not whole agent docs, wiki pages or raw prompts.

**Goal and sharing boundary:** original production/blog acceptance criteria still require their actual evidence. Disabled/unconfigured `jeopi` Jev API, blocked/dropped tasks, installed adapters, fixture-only checks and `awaiting_review` do not become verified completion. Canonical edits remain local working-tree changes until separately committed/pushed. The complete local `llm-wiki/log.md` mixes authored history with automatic capture metadata and is not publication-safe: share only separately reviewed authored ledger/audit entries through selective staging, excluding automatic capture history and private raw/source/query records. Snapshots, credentials, private media and runtime state remain unshared. Uncontained existing/manual sessions can still append index/log stubs or rewrite line endings; explicit source admission still protects search, while strict index consistency may fail until regeneration after those sessions stop. This limitation is not universal hook enforcement. Byte/character/time/RSS observations are not billed-token savings. Existing receipts below retain their original source, host and effect limits.


## Scene layout and browser delivery — 2026-10-21
**Scene layout editor with reusable slots:** browser-smoke receipt `artifacts/scene-layout-browser-smoke.json` records 24 checks passed on isolated loopback with disposable fixtures, Playwright running real Chromium via `PLATFORM_CHROMIUM_PATH` environment variable. Docker now includes both ffmpeg and chromium packages. Container render and restart verified at `artifacts/layout-container-smoke.json`.

| Scene slots | 24 checks: authentication, presets (premiere/top-image/clear), image-gen/text-overlay/video-bg/subtitle-layer slots, geometry/copy/styling/z-order persistence, slot preview rendering | `artifacts/scene-layout-browser-smoke.json`, before-save and after-reload screenshots |
| --- | --- | --- |
| Editable overlays | Image slot (attachment, geometry), text slot (copy, styling, z-order), video slot (prompt, geometry), subtitle layer (copy, styling) | All edits persisted through save/reload cycle |
| Browser isolation | No provider calls, no external origins, zero unexpected console errors | One expected pre-login 401 for unauthenticated resource requests |
| Database writes | Login, local upload, one episode PUT with fixture channel/episode creation | Temporary disposable fixture database, no production data |
| Docker build | Includes chromium (already present) and Playwright path configured in environment | `PLATFORM_CHROMIUM_PATH=/usr/bin/chromium` in Dockerfile |
| Playwright session | Final corrected image Linux run (checkout path redacted): `docker run --rm -v <checkout>/tests:/app/tests:ro -e PLATFORM_PLAYWRIGHT_MODULE=/app/node_modules/playwright/index.mjs frameforge-studio:layout-20261021 node --test tests/platform-session.test.mjs tests/layout-pipeline-session.test.mjs` passed 8/8 zero skipped, includes cross-type pixel z/alignment regression. Real Chromium file input exact-hash attachment verified; publication not attempted | Receipt `artifacts/layout-container-smoke.json` persistence-verified 08:12:32Z |

This evidence distinguishes: local browser-fixture testing (completed) ≠ paid provider execution ≠ external publication ≠ CI/deployment claims.

### GitHub Actions browser prerequisites
Run [39568134293](https://github.com/akillness/frameforge-studio/actions/runs/39568134293) failed before two browser test files could execute because they imported Playwright from a developer-only Codex cache. Both tests now resolve the locked project package by default; explicit module and executable overrides remain supported. The Node CI job runs `npm ci` and `npx playwright install --with-deps chromium` before regression tests. Missing browser prerequisites still fail rather than skip coverage.

Focused Linux verification with the project package and system Chromium: `docker run --rm -v <checkout>/tests:/app/tests:ro -e PLATFORM_CHROMIUM_PATH=/usr/bin/chromium frameforge-studio:layout-20261021 node --test tests/platform-session.test.mjs tests/layout-pipeline-session.test.mjs` passed 8/8, zero skipped. This local result is separate from the subsequent GitHub Actions run.

GitHub run [39569217617](https://github.com/akillness/frameforge-studio/actions/runs/39569217617) on `f7c0afa` subsequently passed all 291 tests with zero failures/skips, 69-module syntax, immutable harness verification, Docker build/render/download and restart persistence. Its runner annotations identified Node 20 action deprecation and the moving `ubuntu-latest` label; the workflow now uses Node 24-based checkout/setup-node/upload-artifact v6 and explicit `ubuntu-24.04`. The application/test Node version remains 22.

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

## Archived context snapshots — 2026-10-26

These are verbatim pre-compaction source blocks, not current status or executable instructions. Resolve original relative references against each named source path, not this file. Earlier words such as “current”, “latest” and “healthy” describe their recorded observation only. Conflicting scene-layout totals (27 in the router versus 24 in the verification record) are retained, not reconciled into a fabricated total. No private prompt bodies are copied here.

### Router status snapshot

Source: `.mex/ROUTER.md`; archived block SHA-256 `51755c9c3aac9953f5905cec7367f1fdae849e8233892232de95e9bb67c28554`. The source text below is unchanged.

```text
## Current Project State

**Blog workflow workspace (2026-10-25):** [The separate authenticated blog page](../public/blog.html) is linked from the existing node workbench; video drafts remain in their original tab. Five account tabs separate session identity checks, same-category 100k+ reference inspection, keyword/news research, persona-specific drafts, exact body/format-plan approval and separate publication. Canonical source bytes and numeric category identities bind references/drafts/approvals; the three external latest-source pointers now separate current sources from verbatim historical snapshots. Source refresh does not replace local overrides or grant publication authority.

**Observed blog gates and private rollout:** `npm run check` passed 109 current modules; the eight focused blog test files passed 119/119 with zero skipped, and `node scripts/blog-workspace-browser-smoke.mjs` passed 85 isolated browser checks at 1440/375/320px. Nine added regressions first reproduced six failures plus three positive controls, then passed 9/9 on the host and inside the exact network-isolated deployment image. They defend concurrent host-issued routing receipts, effective numeric writer categories and whitespace-sensitive complete public readback. The corrected Docker image is healthy behind the existing private HTTPS route, with 12 checked runtime hashes matching source, all 441 immediate pre-correction entities and every historical/settings hash multiset unchanged, plus all 29 snapshot media hashes preserved; the initial 390-entity rollout baseline was separately preserved. Real deployed scripts freshly verified/restored three account-bound MyInfo tabs; two current parenting accounts retain actual public reference analyses from an explicitly labelled `17.8만+` neighbors counter and owned sample, with measured structure and no image reuse. Eight real Google News RSS observations were separately exercised in disposable staging. [Sanitized verification receipt](../artifacts/blog-workflow/verification.json) and [operator runbook](../docs/blog-workflow.md) distinguish these from model/publication proof.

**Blog prerequisites remain explicit:** the selected `jeopi` Jev API profile has no configuration/key, so no real API routing or model-authored blog draft is claimed. Naver/Tistory lack a complete approved common publisher; Tistory also lacks its own canonical drafting policy, while GitHub requires its actual checkout/approved editorial-media package and separate exact Git consent. Antigravity remains unobserved. All five schedules are disabled, no OS routine was activated, and no Git commit/push, paid media generation or public blog post occurred. These canonical notes and source-pointer edits are local working-tree changes; sharing them requires separately authorized commit/push.

**Current source — single node workbench (2026-10-25):** the project canvas is the sole default; the split A/B tabs are removed. Studio scene editing, sources, delivery, history, settings and other tools open as native overlays on that project. Menus/tooltips support pointer, keyboard and touch without writes on open. Exact-target node/edge removal changes only the draft, cleans incident references and remains undoable until explicit version-guarded Save. One live inspector, hidden scene/graph drafts, original conflict versions and the active scene-versus-graph save owner are preserved.

**Recoverable project removal:** archive/unarchive is an explicit `POST /api/episodes/:id/archive|unarchive` with mandatory positive safe-integer `expectedVersion`, not destructive deletion. History and media remain; active jobs and provider/browser/quote preflights block archive. Archived projects allow read-only inspection, while editing/production effects require unarchive.

**Observed source and Docker candidate:** the explicit news query had been polluted by OR-appended trend keywords, episode topic and title. It now takes precedence over derived context; genuine RSS errors or empty results fail without fabricated fallback. 국민연금공단 was selected from the feed observed at 13:10:38Z on 2026-10-25, then absent from the 14:31 refresh: retain it as dated curation, not a current-rank claim. The isolated source/native path produced real evidence, Windows SAPI narration and original text cards. The later actual Docker candidate fetched five live articles, retained six sourced scenes, rendered 1080×1920 H.264/AAC for 53.721333 seconds and stopped at `awaiting_review`; no paid generation/public posting or owner approval follows. [Sanitized evidence receipt](../artifacts/node-native-workbench/verification.json) remains parent-owned and pending finalization; final exact-image gates/cutover are still pending. Canonical updates remain working-tree-only until separately committed/pushed.

**Selected harness and scoped source gates:** `harness/manifest.json` selects immutable 1.7.1, SHA-256 `960f256f33f75dd0de01904bbfefefef3a33932db66867c1a4804b9c461fb174`, preserving earlier 1.7.0 and 1.6.0 evidence as history. Parent-observed scoped checks passed native-login 1/1, legitimate-empty/copy/save 3/3 and `npm run check` across 109 modules. These are named source gates, not a fabricated combined browser total, CI result or completed Docker rollout.

### Historical implementation and rollout receipts

**Implemented:** browser video editor, channel/episode/template history, typed production DAG, per-node execution history, FFmpeg rendering, token-authenticated agent/speech bridge, queued Korean narration and exact-version/job/hash review decisions. White UI is active across Studio, Workflow, Trends, Templates, History, Knowledge and Settings. The Studio Higgsfield CTA reuses the workflow inspector; opening it creates no save, run or spend. When no existing-script generation path is suitable it creates an unsaved five-node `script(existing) -> storyboard -> generate -> render -> review` draft, preserving the saved graph and the live selected scene's stable ID. **Scene layout editor (2026-10-21):** reusable slot system with image-gen/text-overlay/video-bg/subtitle-layer types, editable overlays (copy, geometry, z-order, styling), preset layouts (premiere four-slot, top-image, clear), local image attachments, real Playwright/Chromium browser sessions with screenshot capture. `artifacts/scene-layout-browser-smoke.json` records 27 passed checks on isolated loopback fixture, one expected pre-login 401 console error, zero unexpected errors/external requests/provider calls, local-only database writes (login, upload, episode save). `artifacts/layout-container-smoke.json` records authenticated Docker render and restart persistence. Docker includes chromium via `PLATFORM_CHROMIUM_PATH` environment variable.
**Operational overview (2026-10-19):** the eighth view composes the existing `/api/state` and history APIs into a real-record queue, API-derived deliverable references, provenance and operations status. Filters, sorting, columns and named views are browser-local presentation state; no task backend, server layout write, owner, deadline or invented health metric was added. `artifacts/ops-workspace/verification.json` records 61-module syntax check, 254/254 tests, 94 browser checks and final screenshot hashes; the browser fixtures were isolated and removed. The earlier Jev proposal receipt predates this diff; the current Jev profile is unavailable, so this diff has no Jev verdict.

**Personal workspace:** the browser-local workspace shell offers `auto` (docked fit), `compact` (1024×768 overlay), `standard` (1280×800 docked), `wide` (1600×900 docked) and `focus` (1280×800 overlay). Users can enter bounded numeric dimensions (width 320–2560px, height 320–1800px, inspector 240–480px) or resize with pointer drag and keyboard arrows; Shift uses the coarse step. Inspector, narration and assistant panels open as native dialog overlays by moving the existing DOM. Named profiles live in browser storage only and make no server layout writes. Assistant unsent drafts are episode-scoped transient state; inspector edits are scene-scoped state. See `artifacts/workspace-browser-smoke.json` and `docs/assets/workspace/`.
**Generation safety:** fresh exact-input quote or explicit no-quote acknowledgement precedes confirmation. The confirmed full workflow automatically applies the generated output with version checks, then renders; retained/recovered outputs have a separate Apply action. UI submissions include the quoted workflow/episode versions; the API's optional exact-version guards reject stale 409 before creating a run. REST uses `POST /estimate/{model}` and persisted generation job ID as `Idempotency-Key`, without automatic submission replay. Configured, authenticated and available remain distinct. Preserve immutable history, optimistic concurrency and known-provider-ID recovery; see [architecture](context/architecture.md) and [decisions](context/decisions.md).

**Historical Higgsfield evidence:** `artifacts/higgsfield-live-smoke.json` records one completed paid Seedance 2.5 generation through actual project MCP stdio -> authenticated FrameForge API -> Docker -> authenticated Windows host CLI. The imported video is 1080x1920, 4.042 seconds, 824923 bytes; its local SHA-256 matches the receipt. Application produced episode version 3 and a completed Docker render. The estimate was 64 credits, not a measured final charge. Live CLI discovery returned 108 models. At that observation, official remote MCP OAuth was pending and Developer REST credentials were absent. Latest white-studio QA makes no new live-provider authentication or generation claim.

**Historical Windows deployment (2026-10-18):** Docker engine 29.5.2 and the non-root/read-only Linux container were verified on host loopback port 4310 behind the private Tailscale HTTPS URL. Windows hosted the authenticated agent/SAPI bridge. WSLService Stop Pending and privilege failures preceded that recovery. The latest macOS local QA is not a production cutover or renewed proof of this route's availability. Preserve original host data and the migration snapshot.

**Migration:** `artifacts/docker-migration.json` verifies all original entity IDs, episode/workflow versions and 10 media hashes after import: 4 channels, 3 episodes, 19 episode-history snapshots, 9 workflow-history snapshots and 3 review records. Snapshot/import utilities reject unsafe paths, missing/tampered media and nonempty import destinations; they never reset the live database or overwrite previous data.

**Runtime:** `artifacts/docker-production-smoke.json` proves staged container -> authenticated Windows SAPI -> saved editing -> audible 1080x1920 MP4 (4.821333 seconds, mean -24.1 dB) -> persisted hash-bound test review. `artifacts/local-container-smoke.json` separately proves container render/review/restart persistence. `artifacts/docker-workflow-smoke.json` proves a real Codex script -> storyboard -> render -> awaiting_review path through the container host bridge; this new run did not include trend/RSS stages. Earlier full Google RSS/references/Codex evidence remains in `artifacts/workflow-smoke.json`.

**Browser:** `artifacts/docker-production-browser-smoke.json` verifies staged narration controls, actual audio/video playback, persisted changes_requested review, zero page errors and no 1440/390px horizontal overflow. Its loopback HTTP cookie is not Secure; the private Tailscale HTTPS deployment has separate verification. `artifacts/docker-live-production-browser-smoke.json` verifies the production Tailscale HTTPS URL: Secure cookie, actual audio/video playback, persisted exact-hash changes_requested review, zero page errors and no 1440/390px overflow. `artifacts/live-container-smoke.json` verifies production restart persistence. Original IDs/versions and 10 media hashes were rechecked after that restart in `artifacts/docker-migration.json`. Preview caption scale can differ from final MP4.

**Latest white-studio/workspace verification:** `npm run check` passed 55 modules and Linux Docker `npm test` passed 213/213 with 0 failures and 0 skipped. `artifacts/white-studio-browser-smoke.json` records 101 authenticated checks and `artifacts/workspace-browser-smoke.json` records 157 authenticated checks on loopback port 4329; both have zero page errors. The final image is `sha256:d4424d7f59c495f97d72ea2e85fb643fe64e9f35b69ff374da90617ca9ce6023`; `artifacts/white-studio-verification.json` records 15/15 inspected source hashes matching, final-image render and restart persistence. Provider catalog/quote/recovery/apply remain fixtures; no paid generation or public deployment occurred in this change. Scope and commands: [verification](../docs/verification.md).
**Latest operational workspace verification:** the 2026-10-19 UI-only change passed `npm run check` (61 modules), `npm test` (254/254), and an isolated loopback smoke (94 checks, no page errors/external/provider calls, temporary database removed). Screenshots cover the overview at 1440/768/375px; all eight views were measured with no document overflow. `artifacts/ops-workspace/verification.json` binds 10 source hashes and 14 screenshot hashes. GitHub Actions run 39201562842 on pushed commit `0af4b0698abcffb9f719401605fa2a6cdf1fa2ee` also passed isolated Linux Docker build/render/restart persistence; receipt: `artifacts/ops-workspace-ci-smoke.json`. This does not establish Windows production deployment. At that earlier attempt Docker Desktop was stopped, the launcher could not access the required volume, and port 4310 had no listener; no volume or production data was changed. See the subsequent 2026-10-20 verification below for current local status.
**Windows Docker refresh (2026-10-20):** current checkout `adab575699e9436529a4113e53464941f741ecdd` was rebuilt and the production container recreated through the guarded launcher on `127.0.0.1:4310`, retaining `frameforge-studio_studio-data`. Unlike the earlier unavailable observation, the Windows Docker engine and service are now healthy. All 56 runtime files already matched the previously running container; this was a verified rebuild/recreation, not deployment of previously missing source. `artifacts/docker-update-20261020.json` records the new image, 64-module syntax check, 280/280 isolated Linux tests with no skips, actual 1080×1920 FFmpeg render, authenticated admin library/knowledge/workflow-history reads, SQLite integrity and unchanged table counts/IDs/episode-workflow versions plus 22 media hashes. A private pre-update snapshot and rollback image were retained. Host bridge/inbox were already running and were not restarted; live provider generation, browser interaction and external HTTPS were not reverified. No application source or immutable harness bytes changed.

**FRAME workspace rollout (later 2026-10-20):** the sage/white Premiere-inspired shell now groups real channels by platform, offers one task navigation and a synchronized scene bin/monitor/timeline, and exposes real workflow history/review navigation with keyboard focus preservation. `artifacts/premiere-workspace-browser.json` records 72 new and 105 existing operational browser checks, all eight views at 1600/1440/1024/768/375/320px, contrast/reflow and fixture-only screenshots. The candidate passed 65-module syntax, 283/283 isolated Linux tests with no skips, and actual 1080×1920 FFmpeg render. `artifacts/premiere-workspace-deployment.json` proves a healthy recreated production container, 57 runtime source hashes, unchanged IDs/versions/table counts/22 media hashes and authenticated Windows-host browser checks through private Tailscale HTTPS. Serve configuration was already correct; no client upgrade or independent remote-device test occurred. The image was built from source-hash-bound working-tree content before the follow-up Git authorization; Git history records publication separately. Aside research and a separate snippet review informed the change; delegated Jev research review was unvalidated `proposal_only`, not approval. See [workspace runbook](patterns/workspace-ui-verification.md) and [design/verification note](../docs/premiere-workspace.md).

**Container boundary:** `artifacts/white-studio-verification.json` records final image `sha256:d4424d7f59c495f97d72ea2e85fb643fe64e9f35b69ff374da90617ca9ce6023`, 15/15 inspected source SHA-256 values matching checkout, and authenticated Docker browser QA on loopback port 4329. `artifacts/white-studio-container-smoke.json` proves actual final-image render/authenticated download and exact-output saved-edit review with restart persistence. These local receipts do not verify public production deployment, live paid Higgsfield generation, Developer REST authentication or owner acceptance; historical Windows/Tailscale and CI evidence remains separate.

**Historical harness 1.6.0:** immutable 1.6.0 was selected and verified by `node scripts/version-harness.mjs verify`, with bundle SHA-256 `65af70f95e9942cfdaac98008679f4c66b6ee62c8b866c7ef143856fbb8798d4`. Its ten roles support 128-node/256-edge repeated-role DAGs, exact node-ID selection/resume, nearest connected producers, per-node reviews and separate final publication approval. Earlier 1.5.0 bytes match the original baseline and remain preserved. Resolve `harness/manifest.json` for current selection; the prior promotion/runtime evidence remains in `artifacts/production-workspace-implementation/verification.json`.

**Jev:** real TypeSafe API advisory evidence exists in `artifacts/jev-live-review.json`; current Docker work has `artifacts/jev-docker-plan.json` and final `artifacts/jev-docker-review.json` (real jev-1.13.0 API, 649 ms, proposal_only, unvalidated tier). The isolated frameforge-codex profile uses a pinned runtime. Model proposals are not automatic authority, and no global hook/catalog changes are implied. Keep all credential values outside tracked memory.

The newer `artifacts/jev-higgsfield-review.json` records a real jev-1.13.0 API response in 525 ms, still `proposal_only` with an unvalidated tier. Its proposal predates the final live-generation receipt and does not grant execution authority.

**Current Windows Jev observation (2026-10-25):** this host's explicit `jeopi` status is inactive/disabled, and native Codex workers report the separate `frameforge-codex` profile disabled. No successful current Jev routing/review is claimed, and no profile, backend, hook or credential configuration was changed. Historical API receipts do not establish current readiness. Root `AGENTS.md` owns the per-query prerequisite and advisory-authority rules.

**Earlier unified A+B production workspace (2026-10-25; navigation superseded):** the approved PW-01–PW-07 contract was implemented in the existing Studio/workflow modules: A was editing-first, B was the same project's node canvas, and full hidden episode/graph drafts retained original conflict versions without navigation saves. Project-owned template copies retain lineage and isolate channel/project settings. Repeated nodes use edge-based order, connected branch snapshots, per-node generation jobs/quotes and review IDs. Commons source import, explicit rights/hash/trim evidence, source-preserving text cards and actual on-screen/final-description credits are wired. YouTube OAuth, private-upload verification, same-video public transition/readback and no-duplicate recovery are real service code with fixture-only external transports in that change. Parent verification passed 181 backend cases, 11 complete Chromium journeys with 40 captures, 89-module syntax and an actual isolated 1080×1920 H.264/AAC render. Use that verification receipt for exact commands, source hashes, caller migrations and immutable harness selection; prototype 45/45 remains separate historical design evidence.

**Final caller gate:** the unchanged full 47-case migrated contract suite passed in an existing pinned local Linux image with current source mounted read-only, network disabled and disposable non-root tmpfs. Genuine outside-file symlink rejection is exercised there. Native Windows retains its explicit 46/47 result because file-symlink creation is denied; neither host permissions nor the test assertions were weakened. Read `artifacts/production-workspace-implementation/legacy-recovery-verification.json` for both failures and the completed recovery. This is test execution, not image deployment or proof of Windows symlink support.

**Boundaries:** the separately authorized Git/Docker update is recorded below; it does not grant live Google consent, account verification, paid generation or upload/public posting authority. None of those provider/publication actions was performed. Only an owner's separate exact-manifest final approval can authorize publication; workflow staging, technical review and generation consent do not. Studio automation is disabled; manual handoff remains. Naver collection stays manual, hosted paid TTS is not connected, and SAPI stays Windows-hosted. The prior full historical wiki audit still records 1705 prompt-ingest/generated-cache/link/schema diagnostics in `artifacts/production-workspace-implementation/knowledge-audit.json`; this operational update neither reran nor repaired that vault gate. Structural graphs are not provider or publication evidence.

**Historical authorized Git/Docker update (2026-10-25; prior 1.6 release):** source `0dd31770bc61e1c2438aa8eeed9c7cc14cbdd637` was pushed to `origin/main` and deployed as `frameforge-studio:local`, image `sha256:fc22099678cee0ae56c2e258987059868c80076eb1533e1e9b255205cd33ab87`. `artifacts/production-workspace-deployment.json` records healthy non-root/read-only operation on the same loopback binding and existing volume, 31 running-source and 10 served-editor byte matches, all 378 preexisting rows unchanged, seven episode/eight workflow versions and 22 original media/download hashes preserved. Source CI passed 482 regressions plus Docker render/restart; exact-image changed tests passed 290/290 and the complete real-app journey 11/11 with 40 verified fixture captures. Seven real private-HTTPS A/B viewport states had zero page/API errors or attempted content writes. Raw production snapshots, row digests and seven real UI captures remain checkout-private. The image records the implementation source commit; later audit-only commits do not change its runtime bytes. Jev remains disabled, not used as an approval. This receipt does not establish deployment of the later single-workbench source.

**Memory:** `artifacts/white-studio-research.json` records 16 design sources, 12 official Higgsfield sources and read-only Aside public UI observations; its pre-implementation findings are not the current runtime contract. In particular, full-workflow auto-apply is clarified in `implementationDecisions`. The narrative is [the scoped report](../llm-wiki/wiki/reports/usability-higgsfield-2026-10-18.md). Read `.mex/verification.json` and `.graphify/verification.json` after the parent's final source refresh; structural graphs are not semantic truth or execution evidence.


```

### Router receipt footer snapshot

Source: `.mex/ROUTER.md`; archived block SHA-256 `7c0e4f9af7915420bfe54983e2c0a90aabe0112679ed679ae75f421dc3d6543b`. The source text below is unchanged.

```text
**Docker release CI:** code commit `0f59211601cba11c7885ed2d28a76581cc695bad` passed [run 39110221470](https://github.com/akillness/frameforge-studio/actions/runs/39110221470): 77 regressions, immutable harness verification, Linux Docker build/render/exact-review/restart persistence. Receipts: `artifacts/docker-ci-run.json` and `artifacts/docker-ci-smoke.json`. Later documentation-only commits do not replace this tested source identity.

**CI browser prerequisites (2026-10-21):** browser regressions default to the locked project Playwright package, not a developer Codex cache. The Node verification job installs locked dependencies and Chromium with Linux system libraries before `npm test`. Focused Linux browser/layout tests passed 8/8 without skips; GitHub execution remains distinct from this local proof. See [verification](../docs/verification.md#github-actions-browser-prerequisites).

**GitHub CI recovery:** run [39569217617](https://github.com/akillness/frameforge-studio/actions/runs/39569217617) on `f7c0afa` passed 291/291 regressions, 69-module syntax, harness verification and Docker render/restart persistence. The workflow additionally pins Ubuntu 24.04 and Node 24-based action runtimes to remove the deprecation/migration annotations; application Node remains 22.



**Prior structural refresh:** MEX 70 files, 1735 nodes/5331 edges, check100 with zero drift; Graphify 1274 nodes/2858 unique edges from 183 source files; wiki 9 pages/7 OKF atoms with zero errors. These counts predate the white-studio changes. The parent refreshes graphs and wiki validation after final sources; use those receipts before claiming freshness.

```

### Architecture snapshot

Source: `.mex/context/architecture.md`; archived block SHA-256 `32b4c93c7c9655d62dd1259a49f04b5387084b403f54591b29bf5a965a63a97e`. The source text below is unchanged.

```text
# Architecture
## System Overview
The browser editor in public/ sends authenticated JSON requests to server/app.mjs.
The HTTP layer validates requests before writing production entities.
The Store owns SQLite entities, episode snapshots and knowledge export.
Rendering passes validated scenes to FFmpeg and returns a tracked job.
Optional external agent work crosses a token-authenticated host bridge.
Source evidence and template edits remain associated with channel and episode history.
## Key Components
- server/app.mjs: HTTP boundary and session handling.
- server/store.mjs: persistence and history.
- server/render.mjs: local video assembly.
- Uploaded inputs use standalone-media demuxer allowlists and the local file protocol only for both FFprobe and FFmpeg. Extension checks alone cannot prevent nested playlist references.
- server/integrations.mjs: trend and host bridge adapters.
- public/app.js and public/workflow.js: the project node canvas is the sole default workbench; former A/B tabs are removed. Studio scene editing, source/delivery, history/settings and other tools open in native overlays with one live inspector and no duplicated control IDs. Opening performs no save/run/spend. Scene and graph drafts retain their own original versions and hidden stashes; explicit Save targets the active editor. Exact-target node/edge draft removal cleans incident references and supports undo before version-guarded persistence. Generation still reuses the existing workflow inspector and live stable scene ID; a deleted target blocks before quote/run.
- public/workspace.js, public/workspace-state.js, public/workspace.css: browser-local personal workspace sizing and tool presentation. Presets are auto/docked, compact 1024×768/overlay, standard 1280×800/docked, wide 1600×900/docked and focus 1280×800/overlay. Numeric width/height/inspector controls are bounded; pointer and keyboard resizing update the custom layout. Native dialog overlays move existing inspector, narration and assistant DOM panels. Named profiles persist only in browser storage; layout changes never write the server. Assistant unsent drafts are episode-scoped transient state, while inspector edits are scene-scoped.
- public/workspace.js, public/workspace-state.js and public/workspace.css retain browser-local sizing, queue filters/sort/columns and named views within the workbench/overlay shell. Deliverables, history and operations derive from existing API records; presentation adds no server layout write, task entity or invented production status.
- server/workflows.mjs: typed production DAG, immutable workflow/version snapshots and per-node execution records; optional `expectedWorkflowVersion`/`expectedEpisodeVersion` guards reject stale 409 before run creation. Confirmed generate workflows import, atomically apply with episode-version checking, then render; the review checkpoint still awaits explicit human inspection.
- public/history.js and public/app.js: stable scene/node/edge comparisons, history selection, draft undo/redo and dirty-state guards. Restore validates an owned historical snapshot and appends a new current version rather than rewriting history.
- server/generations.mjs and Store.completeGeneration/applyGeneration: persistent idempotent generation intent, known-ID polling/recovery, bounded media import with probe/hash/provenance, and atomic episode apply. Queue completion/import is separate from apply; full workflows invoke apply before rendering, while retained/recovered outputs require the explicit Apply action. Stale apply preserves the paid output.
- Store.knowledge/exportKnowledge: runtime generation-job and imported-asset relationships to episodes, refreshed after import/apply with applied-version OKF atoms and signed URL query strings omitted.
- server/higgsfield.mjs, server/higgsfield-cli.mjs and the authenticated host bridge: distinct Developer REST and official CLI adapters. REST estimates use `POST /estimate/{model}` with exact generation input, and create sends persisted `generationJobs.id` as `Idempotency-Key`; ambiguous submissions are not replayed automatically. scripts/higgsfield-mcp.mjs exposes the authenticated project API over stdio, separate from the vendor's OAuth-protected remote MCP. Browser confirmation requires a fresh exact-input quote or explicit no-quote acknowledgement; configured-only status is not verified authentication/availability.
- server/narration.mjs, scripts/agent-bridge.mjs and scripts/speech.ps1: queued Windows voice synthesis locally or through an authenticated container-to-host raw-WAV bridge; generated audio attaches through the Store only if the original episode version still matches. Partial/stale output is cleaned.
- `server/graph.mjs` and `server/workflows.mjs`: deterministic edge-based execution for repeated roles within 128 nodes/256 edges; exact node-ID selection/resume and nearest connected producer boundaries. Layout and render consume their own branch evidence rather than another branch's mutable saved scenes. Each review is keyed by node ID; completed paid jobs retain their original identities.
- `server/candidates.mjs`: shared canonical exact-input generation/publication snapshots and physical local-byte/rights/provenance validation. A whole generation quote covers selected node/scene/slot inputs, costs and the human disclosure decision; approved sibling slot outputs do not invalidate one another's stable jobs.
- `server/media-sources.mjs` and `server/media-credits.mjs`: optional Commons discovery/import, explicit hash-bound rights, versioned source/trim attachment and original text-card fallback. Rendering and the final publication description derive credits from actual scene/slot sources. Generated outputs stay illustrations, not factual event evidence; local provenance never fabricates human rights clearance.
- `enqueueRender` persists the actual input `sceneSnapshot` before queueing asynchronous work; workflow render outputs retain matching branch provenance. `server/publication.mjs` requires that match and derives the selected candidate's assets, generation ancestry and credits from it, not the current sibling episode scenes. Current episode/workflow/channel/version guards remain mandatory.
- `server/youtube-oauth.mjs`, `server/private-runtime.mjs` and `server/publication.mjs`: channel-bound PKCE/one-use-state OAuth, encrypted per-intent recovery identities and separate exact-manifest final approval. Final private upload/readback precedes a same-video public transition and second readback. Last-moment input changes block effects; stale approvals allow only known-identity observation, never duplicate upload or changed-project completion. Concurrent one-use state claims use exclusive ownership and fail closed on uncertainty.
- `server/app.mjs` and `Store.setEpisodeArchived`: recoverable project archive/unarchive uses explicit POST actions with a mandatory positive safe-integer `expectedVersion`. Active persisted jobs and in-flight agent, narration, workflow-quote, generation, publication and browser preflights block archive. The new version preserves media/history; archived effects fail closed while cached/read-only inspection remains available.
- `WorkflowEngine.execute` and `fetchGoogleNews` in `server/workflows.mjs`: an explicit validated news query owns the RSS request. The former OR expansion mixed it with trend keywords, episode topic/title and could return no articles; derived context now applies only when no explicit query exists. Google RSS HTTP/parser-empty failures remain errors, not cached or fabricated success.
- `public/blog.html`, `public/blog.js` and `public/blog.css` provide the separate authenticated multi-account blog page; the existing workbench links to it in a new tab so video drafts remain intact. `server/blog.mjs` stores account/brief/reference/draft/run/schedule/approval history with expected-version guards, account-scoped source prerequisites and separate exact-content/format-plan/Git consent. Only verified public readback advances numeric menu rotation; uncertain publication intents cannot replay. Explicitly enabled KST timers create drafts only and preserve semantic reference eligibility across schedule-only bookkeeping.
- `server/blog-sources.mjs`, `server/blog-automation.mjs`, the authenticated host bridge and `scripts/blog-workflow.mjs` read canonical current pointers/personas/policy/state, hash their bytes, retain private rule context and expose sanitized provenance. Host-local source reads do not require a broad container mount. Jev is explicit `jeopi`/API-only with no profile/backend fallback. Installed CLI, verified account identity, actual draft execution and publication are separate capability states; missing platform policies/transports fail closed.
- `server/blog-references.mjs` inspects bounded DNS-pinned HTTPS Naver profile/post documents, requires official 100k+ follower/subscriber/fan/neighbor counter evidence and same-author/category proof, and measures article/paragraph/image formatting. Versioned parenting equivalence retains both raw category labels and evidence; views/visits, biographies and rounded counts without an explicit lower bound do not qualify. Source hashes/context/head identities bind an original adaptation plan; reference imagery is not reusable media. Naver 2+1 and GitHub editorial-image policies remain destination-specific, and generated formatting still requires explicit owner review.
## External Dependencies
- FFmpeg and ffprobe provide local encoding and probing.
- Google Trends supplies a network RSS observation source.
- Agent CLIs run only through the configured host bridge.
- Higgsfield CLI supplies live model schemas and the historically exercised paid-generation transport. Developer REST uses server-only credentials when configured; vendor MCP owns a separate OAuth session. The white-studio change exercised provider catalog/quote/recovery/apply fixtures, not a live provider.
- Docker and Tailscale are deployment dependencies, not proof of application readiness.
## Evidence boundaries
- Local channel records are not OAuth channel ownership verification.
- A local render does not upload or publish a video.
- Generated source graphs are structural; they do not establish semantic truth.
- Workflow review nodes do not perform human visual review or channel publication.

## Current source and Docker candidate evidence (2026-10-25)

The isolated source/native path used 국민연금공단 selected from the feed observed at 13:10:38Z, Windows SAPI narration and original text cards. The keyword was absent from the later 14:31 feed, so the selection remains dated curation rather than current ranking. A later actual Docker candidate fetched five live articles, retained six sourced scenes and rendered a 1080×1920 H.264/AAC MP4 of 53.721333 seconds, SHA-256 `59764fdc350177c09dbd0b7f26e84f96b50f38510162c59d3e4d6de8d149791a`, then stopped at `awaiting_review`. No paid generation, public posting or owner visual approval occurred. `harness/manifest.json` now selects immutable 1.7.1; 1.7.0/1.6.0 remain historical. The parent owns [the sanitized receipt](../../artifacts/node-native-workbench/verification.json) and pending final exact-image gates/cutover. Candidate rendering is not completed production rollout or CI proof; canonical notes remain working-tree-only until separately committed/pushed.

## Historical runtime and deployment evidence

**Scene layout editor (2026-10-21):** 24 browser checks on isolated loopback with real Playwright/Chromium, one expected pre-login 401, zero unexpected errors/external/provider calls. Slot types: image-gen, text-overlay, video-bg, subtitle-layer with editable geometry/copy/styling/z-order. Presets: premiere (four-slot), top-image, clear. Local image attachment without provider execution. Save/reload persistence across all slot edits. `artifacts/scene-layout-browser-smoke.json` with before-save/after-reload screenshots. Container render and restart verified at `artifacts/layout-container-smoke.json`. Docker includes chromium with `PLATFORM_CHROMIUM_PATH` environment variable. Focused layout 3/3 pass. This evidence is isolated browser-fixture testing, not paid…

Latest macOS white-studio/workspace QA: 16 scoped regression tests, Linux Docker `npm test` 213/213 with 0 failures and 0 skipped, `npm run check` 55 modules, actual host FFmpeg 1080x1920 H.264/AAC output, 101 authenticated white-studio browser checks and 157 authenticated workspace checks on loopback port 4329, with zero page errors. Provider catalog/quote/recovery/apply responses are fixtures; `artifacts/white-studio-research.json` links the design and official Higgsfield evidence. See [verification](../../docs/verification.md) for exact evidence boundaries. No paid generation or public deployment occurred in this change; bundle 1.4.0 remains unchanged.

`artifacts/white-studio-verification.json` records final image `sha256:d4424d7f59c495f97d72ea2e85fb643fe64e9f35b69ff374da90617ca9ce6023` built, 15/15 inspected source SHA-256 values matching checkout and authenticated Docker browser QA on loopback port 4329. `artifacts/white-studio-container-smoke.json` records final-image render/authenticated download, exact-output saved-edit review and restart persistence. These receipts do not establish public production deployment, live paid Higgsfield generation, Developer REST authentication or owner acceptance; historical Windows/Tailscale and CI evidence remains separate.

The following receipts are historical Windows/Tailscale or earlier-source observations, not latest-source production cutover evidence.

The 2026-10-18 full workflow receipt in `artifacts/workflow-smoke.json` records completed trend, research, script, storyboard and render nodes, followed by review awaiting human inspection. The script node used the real Codex bridge; separate `artifacts/agent-jeo.json` and `artifacts/agent-jeopi.json` receipts record validated real responses from those adapters. This proves the exercised path, not all possible graph configurations or external publishing.

`artifacts/production-smoke.json` additionally verifies native Korean speech, audible final MP4, saved-edit preservation and a persisted exact-output review. This test review proves decision storage/binding, not owner approval or creative quality. Windows SAPI remains host-specific. Linux Docker now reaches it through the authenticated host bridge; `artifacts/docker-production-smoke.json` proves that exercised path. Availability must still be checked.

Container migration uses `scripts/snapshot-data.mjs` and `scripts/import-snapshot.mjs` to preserve consistent SQLite state, referenced media, IDs, versions, history and review hashes in a new data volume. Neither utility constructs Store or resets live data. `artifacts/docker-migration.json` records the real migration; `artifacts/local-container-smoke.json` records restart persistence.

`artifacts/higgsfield-live-smoke.json` records the historical paid-generation path: project MCP -> authenticated API -> Docker/host CLI produced a real 1080x1920 video, verified its local hash, applied it as a new episode version and completed a Docker render. This did not verify Developer REST authentication, vendor MCP OAuth or channel publication. `artifacts/usability-browser-smoke.json` had a different scope: 23 local browser checks, with direct-API catalog and recovery interactions explicitly using HTTP fixtures.

## FRAME workspace boundary (2026-10-20)
The existing application/workflow modules still own actions, version-bound saves and generation consent. Presentation adds real-record platform grouping, one task navigation, a scene bin synchronized by scene identity with the monitor/inspector/timeline, cumulative scene timing, and links that disclose/focus existing workflow histories. No arbitrary stage types, skip toggles, independent tracks, provider transport or publication API was added. Shared tokens remain in public/styles.css, workflow presentation in public/workflow.css and shell breakpoints in public/workspace.css.

The 2026-10-20 image was deployed from source-hash-bound working-tree content, not a newly published commit. artifacts/premiere-workspace-deployment.json records 57 matching runtime files and unchanged SQLite integrity/IDs/versions/table counts/22 media hashes, plus authenticated Windows-host browser checks over the existing private Tailscale HTTPS proxy. The browser/render gates are distinct from research, snippet review, unvalidated Jev proposals and public publication. See the workspace-ui-verification pattern and docs/premiere-workspace.md for the 65-module, 283-test, 72-new/105-regression-browser evidence and exact limitations. This is historical rollout evidence, not the later single-workbench cutover.

```

### Original wiki log receipt reference

Source: `llm-wiki/log.md`; archived block SHA-256 `b40d2670cf9a9150bb28036a28d007373e5e5bef235b726e63297aedf5ce5bd4`. The source text below is unchanged.

```text
- 2026-10-25: Aligned [[wiki/entities/frameforge-studio]] and existing MEX memory to the sole node workbench/native overlays, recoverable version-guarded archive, preserved drafts/save ownership and actual explicit-query pollution diagnosis. Preserved 국민연금공단 as dated 13:10:38Z curation after its absence from the 14:31 feed; linked publishers/NPS guidance distinguish proposal from enactment. The isolated source/native SAPI/text-card path and later actual Docker five-article/six-scene render reached `awaiting_review` with a 53.721333-second 1080×1920 H.264/AAC MP4. Harness 1.7.1 is selected; prior 1.7.0/1.6/deployment receipts remain historical. [The sanitized receipt](../artifacts/node-native-workbench/verification.json) and final exact-image gates/cutover remain parent pending. No new CI, owner approval, paid generation or public posting is claimed; canonical notes remain working-tree-only until separately committed/pushed.
```

### Original entity candidate and missing receipt reference

Source: `llm-wiki/wiki/entities/frameforge-studio.md`; archived block SHA-256 `7567a5836f2ecdefa9ed1dfb45dc7b0aa84163fee9335e7b562a1f23af6b7c85`. The source text below is unchanged.

```text
The actual news failure was query pollution: OR-appended trend keywords and episode topic/title changed an explicit query. `server/workflows.mjs` now gives that query precedence; real RSS errors/empty responses still fail without fake output. 국민연금공단 was selected from the 2026-10-25 13:10:38Z feed and absent from the 14:31 refresh, so it remains dated curation, not a current-rank claim. The isolated source/native smoke used real evidence, SAPI and original text cards. A later actual Docker candidate fetched five live articles, kept six sourced scenes, rendered a 1080×1920 H.264/AAC MP4 lasting 53.721333 seconds and reached `awaiting_review`, without paid generation/public posting. Immutable 1.7.1 is selected; earlier 1.7.0/1.6.0 remain historical. [Sanitized receipt](../../../artifacts/node-native-workbench/verification.json) finalization and exact-image gates/cutover remain parent pending. This is not owner approval or completed production/CI proof; canonical notes remain working-tree-only until separately committed/pushed.
```

### Original workspace verification receipt references

Source: `.mex/patterns/workspace-ui-verification.md`; archived block SHA-256 `cd6b13d97e0bc6ced0ef104e8ec1154e5db9609af082fa50dba6674340f9c29f`. The source text below is unchanged.

```text
3. Run syntax and the tests changed by the scoped work, then the matching isolated browser runner. Resolve current workbench commands and results from [the parent-owned receipt](../../artifacts/node-native-workbench/verification.json), which is pending finalization. The earlier PW-01–PW-07 runner is `node scripts/production-workspace-browser-smoke.mjs`, using the actual app with temporary storage, ephemeral ports and fixture-only external transport. Retain exact commands, counts, warnings and failed attempts; historical counts are not current gates. Run broader suites or deployment smoke only when separately in scope.
Read the relevant browser and deployment JSON artifacts with their source identities. The node-native-workbench final receipt and exact-image gates/cutover are parent-owned and pending finalization; a native preview or real candidate-container render is not completed production rollout. Preserve a dated selected topic when it disappears from the next live feed instead of relabeling it as currently ranked. A research synthesis, plugin inventory, structural graph or Jev `proposal_only` verdict does not replace executed tests or grant authority. Commit, push and pull require their own authorization; do not include pre-existing user work in an incidental release commit.
```

