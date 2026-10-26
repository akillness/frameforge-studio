# 다중 블로그 운영 런북

기준일: 2026-10-25. 운영자는 기존 스튜디오 사이드바의 블로그 링크 또는 `/blog.html`에서 작업한다. 이 페이지는 선택된 영상 1.7 작업공간을 대체하거나 복제하지 않는다.

**현재 경계:** `/blog.html`은 기존 비공개 HTTPS 서비스에 배포했고, 다섯 계정 탭과 세 Naver 계정의 현재 MyInfo 신원·원래 탭 복귀를 확인했다. 계정 2개의 실제 공개 reference 분석은 저장되어 있다. 이는 자동 자격 증명 로그인·모델 작성·공개 발행 증명이 아니다. Jev `jeopi` API 설정/키, 플랫폼별 publisher와 승인 패키지 등 미충족 조건은 아래 [검증 결과](#검증-결과와-미충족-연결-조건)에 남긴다.

## 1. 계정과 권한부터 확인

| 탭 / API 계정 ID | 확인된 공개 대상 | 운영 경계 |
| --- | --- | --- |
| Naver `banggujin` / `naver-banggujin` | <https://blog.naver.com/banggujin> | 계정별 격리 프로필과 현재 acting tab을 확인한다. |
| Naver `jelly_ggumi` / `naver-jelly_ggumi` | <https://blog.naver.com/jelly_ggumi> | 다른 Naver 계정의 로그인·분류·기존 초안을 재사용하지 않는다. |
| Naver `jennie_p` / `naver-jennie_p` | <https://blog.naver.com/jennie_p> | 동일한 계정 경계와 수동 MFA·캡차 원칙을 적용한다. |
| Tistory / `tistory` | <https://jellyggumi-journal.tistory.com/> | 공개 사이트 확인만 된 상태다. 로그인 소유권·편집기·게시 어댑터는 별도 증명이 필요하다. |
| GitHub Pages / `github-jellyggumi` | <https://jellyggumi.github.io/> | 저장소는 `jellyggumi/jellyggumi.github.io`, 브랜치는 `gh-pages`다. 공개 저장소 정보는 현재 인증 사용자의 push 권한 증명이 아니다. |

모든 `/api/blog/*` 경로는 기존 스튜디오 인증·관리자·동일 출처 정책을 적용한다. 스튜디오 접근 토큰과 플랫폼 로그인 정보는 서로 다른 권한이다. 비밀번호·쿠키·API 키를 본문, 페르소나, URL, CLI 인수, 실행 영수증 또는 추적 파일에 넣지 않는다.

## 2. 최신 원본 해석과 과거 포인터 충돌

`최신 원본 다시 읽기` 또는 `refresh`로 지정된 원본을 다시 읽고 `workspace.version`, `sourceEvidence`, `blockedReasons`, `sourceConflicts`를 확인한다. `GET /api/blog/state`는 저장된 상태 조회이며 자동 새로고침이나 로그인 검사가 아니다.

- 공통 원본은 `naver-blog-shared/`의 `aside-publish-guide.md`, `aside-session-continuity.md`, `category-rotation-policy.json`, `category-rotation-state.json`, `publish-slot-ledger.json`, `daily-intelligence/LATEST.md`다. 계정별 `LATEST.md`, 페르소나 파일과 선택적 `blog-config.json`도 읽는다. 경로·파일 해시는 근거이며 개인 원문을 이 저장소로 복사하지 않는다.
- Naver 페르소나는 각 계정 디렉터리의 `persona/` 원본, 분류는 공통 policy의 `ring`과 state의 `next`를 함께 따른다. 분류 이름만 맞추지 말고 숫자 `category_no`와 이름의 조합이 일치하는지 확인한다. 원본의 현재 값은 화면에서 확인하며 이 문서에 고정하지 않는다.
- `LATEST.md`의 포인터 갱신 시각, 원본 갱신 시각, 과거 실행/게시 시각은 서로 다르다. `Current source pointers`의 `Pointer refresh`는 메타데이터 정리 시각일 뿐이다. resolver는 `Rotation source updated_at`과 `Current next category`를 canonical state와 대조하며 `Historical snapshot`은 현재 지시로 사용하지 않는다. 과거의 메뉴·예약·미디어 예외·게시 권한을 현재 권한으로 승격하지 않는다.
- 과거 `published_verified` closeout은 일치하는 계정·글 식별자의 **역사적 보고**다. 현재 로그인, 이번 본문 검증 또는 새 게시 권한이 아니다. 원본 날짜나 메뉴가 충돌하면 다른 계정/최근처럼 보이는 기록으로 대체하지 않는다.
- 충돌·필수 원본 누락은 승인/배포를 막는다. 다른 계정에만 해당하는 사유와 공통 차단 사유를 구분한다. 읽기·리서치·수동 저장, 정확한 원본 맥락이 확보된 초안 작성은 승인과 별개다. 충돌이 남은 초안에 공개 가능 표시를 붙이지 않는다.

`refresh`는 사용자 저장 override와 미저장 화면 편집을 덮어쓰지 않으며, 외부 `LATEST`·회전 원본·슬롯 원장을 고치거나 로그인·게시·예약 활성화를 실행하지 않는다. 외부 포인터 정정은 해당 원본 소유자의 별도 작업이다. 원본 해시가 달라지면 이전 승인은 다시 받아야 한다.

## 3. 비밀값 없는 설정과 컨테이너 → 호스트 전송

실제 읽는 필드만 아래에 적는다. 값은 운영자의 비밀 주입 수단과 사용자 전용 설정에서 관리한다. `.env` 또는 프로필을 사용하더라도 비밀값을 Git에 추가하거나 터미널 출력/화면 캡처에 노출하지 않는다.

| 실행 위치 | 실제 필드 | 용도 |
| --- | --- | --- |
| 운영 CLI | `BLOG_API_ORIGIN` | 기본 `http://127.0.0.1:4310`. 자격증명·경로·query 없는 HTTPS origin 또는 loopback HTTP만 허용한다. |
| 운영 CLI | `BLOG_API_SESSION` 또는 `LOGIN_TOKEN` | 현재 `frameforge_session`의 값만 주입하거나 기존 스튜디오 인증을 사용한다. CLI 인수로 받지 않는다. |
| 앱 → 호스트 | `AGENT_BRIDGE_URL`, `AGENT_BRIDGE_TOKEN` | 신뢰한 호스트의 인증 브리지. 토큰은 양쪽에 안전하게 주입하며 24자 이상이다. HTTP는 loopback/`host.docker.internal`만 허용한다. |
| 호스트 브리지 | `BRIDGE_HOST`, `BRIDGE_PORT` | 기본 `127.0.0.1:4311`. 컨테이너에서 도달 가능하게 만드는 바인딩·방화벽 변경은 별도 운영 승인 사항이며 인터넷 공개로 해결하지 않는다. |
| 원본을 읽는 호스트 | `BLOG_WORKSPACE_ROOT` (`BLOG_SOURCE_ROOT` 대체 이름) | 읽기 전용 canonical 부모 경로. 미지정 기본은 사용자 홈 아래 `wiki/workspaces`다. 사용자명이 든 실제 절대 경로는 공유 문서에 기록하지 않는다. |
| GitHub 게시 호스트 | `BLOG_GITHUB_CHECKOUT` | 실제 `gh-pages` checkout과 기존 편집/미디어 패키지. 공개 URL만으로 대체할 수 없다. |
| Naver 진단 호스트 | `BLOG_NAVER_TAB_BANGGUJIN`, `BLOG_NAVER_TAB_JELLY_GGUMI`, `BLOG_NAVER_TAB_JENNIE_P` | 각 격리 프로필의 **현재** acting tab ID. 오래된 탭이나 다른 계정으로 자동 대체하지 않는다. |
| 호스트 실행 파일 | `CODEX_CLI`, `JEOPI_CLI`, `HERMES_CLI`, `ANTIGRAVITY_CLI`, `GH_CLI`, `GIT_CLI` | 구현에서 읽는 실행 파일 override다. 경로 설정 자체가 인증·지원 어댑터·실행 검증을 의미하지 않는다. |
| Jev 전용 호스트 프로필 | `JEV_API_KEY` | 현재 호스트 `jeopi` 프로필의 자체 키. 다른 프로필의 키를 빌리지 않는다. |

선택적 `blog-config.json`에서 읽는 항목은 `persona`(문자열), `keywords`·`menus`(문자열 배열), `menuCursor`(명시적 현재 index), `publicUrl`(인증/query/hash 없는 HTTPS), 고정 ID가 없는 Tistory의 `accountId`다. 명령·스크립트·토큰 필드는 설정 항목이 아니다. 화면/API에서 저장한 persona/menu 등은 로컬 Store override이며 외부 JSON을 수정하지 않는다. 편집기 URL은 화면/API에서 별도로 확인해 저장한다.

컨테이너에 호스트의 홈/자격증명 디렉터리를 통째로 연결하지 않는다. 브리지가 설정된 앱은 인증된 `POST /blog/sources`와 `/blog/status`로 호스트 원본 요약·해시·상태를 받는다. private 규칙/페르소나 원문은 호스트의 서버 전용 맥락에 남으며, 명시적인 초안 실행에서 선택 계정의 맥락만 호스트 작성기에 전달된다. 원본 `refresh` 자체는 모델 호출이 아니다.

브리지의 `/blog/route`, `/blog/draft`, `/blog/login`, `/blog/deploy-plan`, `/blog/deploy`는 서버가 정한 operation만 받는다. UI가 임의 셸 명령·스크립트 경로를 보내는 인터페이스가 아니다. 인증 실패·과대 응답·미설정 어댑터는 차단하며 자동 재시도하지 않는다. 브리지 토큰은 원본/호스트 실행 권한이므로 스튜디오 세션과 별도로 보호한다.

### Jev 선행 조건

현재 호스트의 `~/.agents/jev/jev-harness.mjs`와 **명시적인 `jeopi` 프로필**을 사용한다. 운영자는 전용 키를 안전하게 주입하고 기존 Jev controller의 preview/apply/enable 절차로 API backend를 명시적으로 구성·활성화한다. 이 블로그 기능은 설치·프로필 수정·키 복사·자동 활성화를 하지 않는다.

자동 초안은 `--profile jeopi status --operation route-skills`에서 프로필 활성/enable 및 API configured 상태를 확인한 뒤 `route-skills --backend api --top-k 3`을 실행한다. 실제 `api` 결과와 현재 호스트 프로세스가 발급한 영수증이 있어야 작성기로 넘어간다. 프로필 파일 존재나 CLI 설치만으로 통과하지 않으며, 로컬 backend·`jeo`·Aside 프로필로 우회하지 않는다. 현재 전용 설정/키 및 실제 API 통과 영수증은 미확보다.

## 4. 화면 운영 순서

1. **연결 · 로그인:** 올바른 탭의 공개 URL/편집기와 원본 상태를 확인한다. Naver 로그인 버튼은 기존 격리 harness의 `diagnose-myinfo.py`로 현재 계정과 acting tab 복원을 진단한다. 자격증명 자동 입력이나 계정 자동 전환이 아니다. 활성/불명확 publisher lock이면 차단한다. MFA·캡차는 정확한 프로필에서 사람이 처리한다. 진단 성공을 전체 로그인/게시 워크플로 통과로 기록하지 않는다.
2. **동종 인플루언서 분석:** 현재 메뉴/페르소나와 같은 분야의 공개 프로필 URL과 실제 대표 글 URL을 분석한다. 공개적으로 관찰된 follower/subscriber 지표가 100,000 이상이어야 한다. 화면에서 숫자를 직접 입력해 자격을 만들 수 없으며, 아래 근거를 먼저 확인한다.
3. **리서치 · 본문:** 페르소나·관심 키워드·현재 숫자 메뉴를 확인한다. 명시한 query가 있으면 그 query로, 없으면 키워드와 현재 메뉴로 실제 RSS 뉴스/일치 트렌드를 조사한다. 기사 URL·시각·출처를 검토한다. 근거 없는 샘플 결과는 만들지 않으며 트렌드만으로 본문 사실이나 이미지 사용권이 입증되지 않는다.
4. **초안 저장:** 유효한 동종 reference와 근거 brief를 선택해 지원 작성기를 실행한다. 작성기는 정확한 분석 계획과 현재 페르소나를 함께 받아야 한다. 제목/전체 본문만 수동으로 scratch 저장할 수는 있지만 유효한 reference 없는 초안은 승인/게시할 수 없다. 수동 저장은 모델 실행이 아니며 `manual` 기록으로 남는다. 계정별 탭 이동은 저장/게시를 실행하지 않는다. 미저장 버퍼는 현재 페이지에서만 보존되므로 닫기 전 명시적으로 저장한다.
5. **전체 본문 승인:** 저장된 제목·전체 본문·계정·메뉴·출처 버전·실제 적용한 formatting plan을 미리보기로 확인한다. 별도 형식 검토 확인(`formatReviewed: true`)까지 마친 뒤 `이 정확한 버전 승인`을 실행한다. 승인은 게시 버튼이 아니다. 저장 후 바뀐 본문을 이전 미리보기로 승인하지 않는다.
6. **별도 배포:** 현재 승인과 실제 게시 어댑터가 있어야 별도 버튼을 실행한다. GitHub는 아래 Git 계획 동의까지 필요하다. 실행 기록과 공개 재조회 증거가 없으면 성공 처리하지 않는다.

### 100k 동종 reference의 자격과 사용 범위

100k는 공개적으로 **표기된 팔로워/구독자**다. 현재 Naver 검사기는 공식 프로필 팬 counter 또는 해당 프로필에 실제 연결된 NBLOG 채널의 이웃 counter를 읽는다. 방문수·조회수·좋아요·총 영향력, 본문에 쓴 인기도 숫자는 아니다. 99,999는 미달, 100,000부터 자격 대상이다. 정확한 정수 또는 명시적 `+` 하한만 인정하며, `10만`처럼 반올림된 축약치만으로 경계를 입증하지 않는다. `precision: displayed-lower-bound`는 하한이지 정확한 실시간 총수는 아니다. 비공개·JS 의존 화면·읽기 실패로 지표를 관찰할 수 없으면 차단하며 다른 분야로 자동 대체하지 않는다.

- 프로필의 metric `kind`, `count`, `precision`, 출처 `url`, `observedAt`, 짧은 근거와 SHA256을 확인한다. 입력 category만으로 동일 분야를 인정하지 않는다. 육아 분야는 버전이 명시된 `blog-topical-equivalence-1`의 제한적 어휘 대응과 **공식 프로필 주분류 + 동일 작성자 글의 분류/실질적 내용**을 함께 요구한다. 다른 주분류를 부차적인 육아 관심사로 덮어쓰지 않는다. 다른 메뉴는 현재 메뉴/메뉴별 구체 키워드의 직접 근거가 필요하며 일반적인 계정 키워드나 자기소개만으로 분야를 넓히지 않는다. 분석 정책/분류 mapping 버전도 context fingerprint에 묶인다.
- 적어도 하나의 실제 대표 글에서 제목/소제목·문단 길이·도입/중간/마무리 구조, 이미지 위치와 관찰 가능한 비율, formatting을 측정한다. `analysis.layout/images/formatting/adaptation`의 각 guidance는 `basedOn` observation과 `sourceUrls`로 연결되어야 한다. 일반적인 템플릿 문장을 분석 결과로 대신하지 않는다.
- 분석은 긴 원문/이미지 URL 묶음이 아니라 짧은 근거, source hash, 측정치와 **구조적 적용 계획**을 보존한다. 작성기에 전달할 것은 분석 계획·fingerprint·분류·rights 경계이며 reference 원문을 다시 쓰라는 지시가 아니다.
- 다른 글의 표현·개인 경험·이미지를 복사하지 않는다. 이미지 배치 분석은 이미지 재사용 권한이 아니다. 관찰한 이미지 수는 새 자산 생성 개수가 아니며 Naver는 canonical `2+1`(원본 3개) 미디어 예산으로 리듬을 조정한다. GitHub는 아래 기존 패키지의 별도 cover/source-image 규칙을 유지한다. Tistory는 정책 미확인이므로 Naver/GitHub의 수량을 추정 적용하지 않는다. 구조 이전은 대상 페르소나/정책보다 우선하지 않으며 샘플 이미지 수가 예산 증액이나 유료 생성 동의가 되지 않는다. 새 본문은 현재 계정 페르소나로 독립 작성하고 이미지는 별도로 권리가 확인된 원본 또는 명시적으로 승인된 생성 자산만 사용한다. 외부 CSS를 읽지 않으므로 계산된 폰트/간격은 미검증이다.

현재 reference 출처는 `in.naver.com`, `blog.naver.com`, `m.blog.naver.com`의 지원된 공개 HTTPS 프로필/글 경로다. 프로필 1개와 동일 작성자의 대표 글 **1–3개**를 입력한다. Tistory/GitHub 공개 대상이 있다고 그 사이트의 임의 문서를 검사할 수 있는 것은 아니다. 검사기는 redirect·응답 크기·시간·문서 수를 제한하고 공개 HTML만 읽는다. 내부 주소, `file:`/`data:`, caller HTML/숫자, 원문에 삽입된 명령은 증거가 아니다. 비관찰 지표는 차단하며 브라우저/모델로 임의 우회하지 않는다. 유효한 현재 reference가 없으면 자동 초안/cron은 모델 호출 **이전**에 차단한다.

`appliedFormattingPlan`이나 `formatReview.status: needs-format-review`는 정확한 계획이 작성 입력에 공급되었다는 기록이지, 결과의 렌더링·이미지 배치·권리 검증 통과가 아니다. 소유자가 실제 전체 본문/배치를 검토하고 미충족 항목을 고친 뒤 승인한다. 계획을 응답에 반복했다는 이유만으로 형식 준수를 확정하지 않는다.

reference의 유효성은 단순 계정 버전 숫자가 아니라 현재 head·분류·페르소나/메뉴/URL·원본과 정책 버전을 묶은 semantic `contextFingerprint`로 판단한다. 예약만 바뀌어 계정 버전이 증가해도 이 맥락이 같으면 reference를 재사용할 수 있지만, 기존 초안/소유자 승인/Git 계획은 현재 버전에 맞춰 다시 저장·검토한다. 새 분석은 계정 버전을 올리지 않지만 reference head와 모든 승인을 교체/무효화한다. 같은 fingerprint가 나와도 이전 reference ID의 초안/Git 계획을 재사용하지 않는다. `state.references[].current`는 저장된 상태의 semantic 유효성 표시이며 외부 원본 실시간 조회나 로그인/게시 증명이 아니다. 수동 저장도 현재 reference가 있으면 연결하며 명시한 오래된 `referenceId`는 409다. reference 없는 scratch는 저장만 가능하고 최종 승인은 503으로 차단한다.

### 에이전트 역할과 실제 연결 경계

| 역할 | 현재 지원/관찰 경계 |
| --- | --- |
| Hermes | 원본 규칙·리서치 검토 및 지원 초안 작성기다. 이번 원본 조사는 DB/파일의 읽기 전용 확인이며 실시간 Hermes 모델 실행 증명이 아니다. |
| Codex | 지원 초안 작성기다. 설치 탐지와 별개로 인증된 host runner, Jev 영수증, 실제 본문/출처 응답이 필요하다. |
| jeopi | 지원 초안 작성기 및 현재 호스트 Jev API 라우팅 주체다. 프로필/키 미설정 상태를 명시하며 다른 backend로 숨겨서 진행하지 않는다. |
| Aside | 계정별 격리 Naver 진단 harness를 재사용한다. 완성된 공통 current2+1 게시 CLI는 없으며 예전 one-off 게시 스크립트를 새 본문 게시기로 재사용하지 않는다. |
| Antigravity | 독립 검토 역할이다. 검사된 블로그 review CLI 계약이 없어 현재 configured/exercised로 표시하지 않는다. |
| jeo | 전체 구현/운영 조정 역할과 직접 블로그 작성 어댑터는 별개다. API의 에이전트 이름 허용만으로 지원이 생기지 않으며 현재 blog drafting 어댑터는 차단한다. |
| 소유자 | 본문 최종 승인, 별도 Git 동의, 플랫폼 수동 인증과 외부 실행 판단의 주체다. 에이전트가 대신 승인하지 않는다. |

`installed`, `configured`, `exercised`를 각각 확인한다. 한 역할의 설치, 과거 실행 또는 상태 카드 표시를 “모든 에이전트 연결 완료”로 합산하지 않는다.

## 5. 버전·승인·공개 증명과 복구

계정 수정과 예약 변경은 **계정** `expectedVersion`, 초안 수정/승인/배포는 **초안** `expectedVersion`을 사용한다. 409는 저장된 최신 버전을 다시 읽고 보존한 편집과 비교하라는 뜻이며 숫자를 임의로 올려 재전송하라는 뜻이 아니다. 오래된 계정/원본 해시의 research brief도 새 초안의 근거로 재사용할 수 없다.

초안은 `accountVersion`, `workspaceVersion`, 계정 manifest, 메뉴/숫자 분류, 제목·본문과 `referenceId`, `referenceFingerprint`, `appliedFormattingPlan`을 묶는다. 승인은 현재 reference를 포함한 정확한 초안/계정/원본 manifest와 `contentHash`를 묶는다. 본문·페르소나·메뉴·URL·예약·원본·reference가 바뀌면 이전 승인, 미리보기와 Git 계획 동의를 다시 확인한다. 변경 후 현재 reference와 원본에 맞는 초안을 명시적으로 저장하고 다시 승인한다.

**중복 게시 금지:** 배포 어댑터 호출 전에 publication intent를 저장하고 승인을 소비한다. 그 초안에는 새 배포 의도를 다시 만들거나 본문을 바꿀 수 없다. 타임아웃·중단·서버 재시작 후 deploy가 `unknown`이면 동일 초안을 재실행하지 말고 저장된 run/remote ID와 해당 공개 계정의 실제 글을 대조한다. 신규 초안으로 복사해 우회 게시하지 않는다. 이번 인터페이스에는 불명확 게시를 자동 복구/재전송하는 승인 경로가 없다.

성공은 `status: verified`, `evidence.publicReadback: true`, 정확한 `targetAccountId`·승인 `contentHash`, 대상 범위 안의 HTTPS 공개 글 URL이 모두 일치할 때뿐이다. 이때에만 로컬 메뉴 cursor가 한 번 전진한다. 초안 작성·승인·타이머·실패·불명확 결과는 회전시키지 않으며 외부 canonical 원장도 자동 수정하지 않는다.

### 플랫폼별 게시 경계

- **Naver:** owner 승인된 미디어 묶음, shared lock, 현재 정확한 대상 탭, strict validator, 독립 공개 재조회가 연결된 공통 publisher가 필요하다. 현재 완성 계약이 없어 게시를 차단한다. 과거 글의 성공 기록이나 one-off 스크립트는 새 계약이 아니다.
- **Tistory:** [공식 Open API 종료 공지](https://notice.tistory.com/2664)는 2023년 12월 말부터 2024년 2월 말까지 순차 종료와 에디터 직접 관리를 안내한다. 구 API 발행을 구성하지 않는다. 확인된 계정의 browser/editor publisher와 정확한 본문 공개 재조회가 아직 필요하다.
- **GitHub Pages:** 실제 `BLOG_GITHUB_CHECKOUT`의 기존 `_workspace/current/` 승인 패키지와 도구만 사용한다. 별도 수동 editorial 승인, 일치하는 final validation, 정확한 Jekyll 제목/본문, 두 cover와 검증된 source image 4–12개가 필요하다. FrameForge가 패키지/이미지를 꾸며 만들거나 기존 routine의 standing 권한을 상속하지 않는다.

GitHub는 먼저 읽기 전용 `deploy-plan`으로 `repository`, `branch`, 정확한 `files`, local commit/push `effects`, `artifactSha256`, `contentHash`, `workspaceVersion`, `planHash`를 확인한다. `planHash`는 이 계획뿐 아니라 계정/초안 버전, `referenceId`, `referenceFingerprint`, 전체 `appliedFormattingPlan`을 포함한다. 본문 승인과 **별도로** 그 계획의 `planHash`에 `gitConsent: { approved: true, planHash }`를 부여한다. 계획이 바뀌면 재동의한다. 운영자가 이 동의를 하기 전에는 commit/push 권한이 없다.

게시기는 인증 사용자/저장소 권한, 정확한 `gh-pages` branch·effective push URL, 깨끗한 checkout, 현재 remote와 같은 base SHA, staged 파일 범위를 다시 검사한다. 공개 완료 증명에는 pushed/remote/workflow SHA 일치, workflow success, 승인 artifact hash, permalink 200과 제목·본문·출처 표기, 이미지 전체의 200/hash 확인 및 **독립적인 전체 본문** 재조회 일치가 필요하다. commit 생성이나 push 시작 뒤 결과가 불명확하면 실제 commit SHA를 보존해 기존 commit/Pages 결과를 조사할 뿐 commit/push를 재실행하지 않는다. 이 실제 GitHub 게시 경로는 아직 live 검증하지 않았다.

## 6. CLI와 예약 초안

저장소 루트에서 다음 명령으로 인터페이스를 확인한다. `--help`, `cron`, `request`는 인증/작업 실행 없이 설명 또는 inert JSON을 반환한다. `status`부터 실제 명령은 위의 스튜디오 인증이 필요하다.

**운영 origin 주의:** 서버에 `PUBLIC_ORIGIN`이 설정되어 있으면 `BLOG_API_ORIGIN`도 정확한 `<configured HTTPS origin>`과 일치해야 한다. 기본 loopback 주소로 보낸 CLI 요청이 403이면 인증/원본 설정을 확인하고 올바른 origin을 사용한다. 서버의 동일 출처 검사를 완화해 우회하지 않는다. 이 문서에는 private hostname을 기록하지 않는다.

```text
node scripts/blog-workflow.mjs --help
node scripts/blog-workflow.mjs status
node scripts/blog-workflow.mjs refresh
node scripts/blog-workflow.mjs tick
node scripts/blog-workflow.mjs cron
node scripts/blog-workflow.mjs request --operation status
```

`refresh`는 출처만 갱신한다. `tick`은 **명시적으로 활성화되고 지금 due인 계정**의 리서치/초안만 처리한다. disabled 기본을 활성화하지 않으며 로그인·승인·게시를 실행하지 않는다.

아래는 구문 참조이며 실제 ID/버전/승인/계획을 조회해 대입하기 전에는 실행하지 않는다. 키·비밀번호는 어떤 인수에도 넣지 않는다.

```text
node scripts/blog-workflow.mjs login --account <account-id> --version <account-version>
node scripts/blog-workflow.mjs deploy-plan --draft <draft-id> --version <draft-version>
node scripts/blog-workflow.mjs deploy --draft <draft-id> --version <draft-version> --approval <approval-id>
node scripts/blog-workflow.mjs deploy --draft <draft-id> --version <draft-version> --approval <approval-id> --git-consent <plan-hash>
node scripts/blog-workflow.mjs request --operation deploy-plan --draft <draft-id> --version <draft-version>
```

GitHub만 마지막 별도 Git 동의 인수가 필요하다. `request --operation ...`은 동일 operation의 요청만 출력하고 전송하지 않는다. CLI에는 계정 설정/리서치/본문 저장/승인/예약 활성화 명령이 없으므로 화면 또는 아래 API를 사용한다.

예약 기본은 `cron: "0 9 * * *"`, `timezone: "Asia/Seoul"`, `enabled: false`, `agent: "hermes"`다. 5필드는 분·시·일·월·요일이며 숫자/목록/범위/step을 지원한다. 요일 0/7은 일요일이다. 일과 요일을 모두 제한하면 OR로 평가한다. `Asia/Seoul` 외 시간대는 받지 않는다.

계정별 `enabled: true`를 명시적으로 저장한 경우에만 앱 내부 15초 타이머가 동작한다. 같은 계정/UTC minute의 persisted claim은 중복 초안을 막으며 지난 슬롯을 따라잡아 게시하지 않는다. `enabled: false`로 저장하면 해당 예약을 중지한다. `cron` CLI는 외부 실행 명령 설명만 출력한다. **OS cron/작업 스케줄러, 기존 Hermes/Aside routine, 상시 게시 권한은 이 변경으로 등록·수정·활성화하지 않았다.**

### 현재 API 참조

모든 요청은 JSON이며 허용 필드 외 입력은 거부한다. `{accountId}`와 `{draftId}`는 위 상태에서 얻은 정확한 식별자다.

| 메서드 / 경로 | 본문과 효과 |
| --- | --- |
| `GET /api/blog/state` | `workspace/accounts/briefs/references/drafts/runs/schedules/approvals/agents/routing` 조회. |
| `POST /api/blog/refresh` | `{}`. 원본 재조회만 한다. |
| `PUT /api/blog/accounts/{accountId}` | `expectedVersion` + 변경할 `persona`, `keywords`, `menus`, `publicUrl`, `editorUrl`. |
| `POST /api/blog/accounts/{accountId}/login` | `{expectedVersion}`. 지원 플랫폼의 계정 진단. |
| `POST /api/blog/accounts/{accountId}/research` | `{expectedVersion, query?}`. 실제 근거 brief 저장. |
| `POST /api/blog/accounts/{accountId}/references` | `{expectedVersion, profileUrl, postUrls, category?, categoryEvidence?}` → `{reference, run}`. 현재 메뉴와 실제 공개 근거로 분석하며 입력 category/근거 문자열 자체가 증거는 아니다. |
| `POST /api/blog/accounts/{accountId}/drafts` | `{expectedVersion, agent, briefId?, referenceId?}`는 실제 작성기. `{expectedVersion, title, body, referenceId?}`는 수동 저장. 생략한 reference는 최신 유효 head로 선택한다. |
| `PUT /api/blog/drafts/{draftId}` | `{expectedVersion, title, body, referenceId?}`. 버전 증가, 현재 원본/reference 재결합, 승인 무효화. |
| `POST /api/blog/drafts/{draftId}/approval` | `{expectedVersion, approved:true, formatReviewed:true}`. 정확한 본문/reference/형식 계획/계정/원본 승인만 한다. |
| `POST /api/blog/drafts/{draftId}/deploy-plan` | `{expectedVersion}`. GitHub exact plan 조회, commit/push 없음. |
| `POST /api/blog/drafts/{draftId}/deploy` | `{expectedVersion, approvalId, gitConsent?}`. 별도 게시 의도 저장 후 지원 어댑터 실행. |
| `PUT /api/blog/accounts/{accountId}/schedule` | `{expectedVersion, cron, timezone:"Asia/Seoul", enabled, agent}`. 계정 버전도 증가하며 승인 무효화. |
| `POST /api/blog/scheduler/tick` | `{}`. 현재 due 초안만 처리. |

## 검증 결과와 미충족 연결 조건

Main이 관찰한 최종 명령과 실제 배포 결과는 [sanitized verification receipt](../artifacts/blog-workflow/verification.json), 격리 화면 검증은 [browser-smoke.json](../artifacts/blog-workflow/browser-smoke.json)에 기록한다. 테스트용 전송/모델 fixture의 통과와 실제 계정·모델·공개 게시 증거를 섞지 않는다.

| 게이트 | 관찰한 결과 / 남은 조건 |
| --- | --- |
| 최종 회귀·구문 | 블로그 전용 8개 테스트 모듈 **119/119**, skip 0. `npm run check` **109 modules** 통과. 최종 리뷰의 세 결함은 구 소스에서 새 9개 중 6개 실패/3개 positive control로 재현한 뒤 9/9 green으로 수정했다. 동일 9개는 실제 배포 이미지의 격리·무네트워크 환경에서도 통과했다. |
| 독립 검토 | 활성 호스트 모델의 별도 JavaScript/보안 검토가 route 간 영수증 충돌, 공개 본문 공백 소실 오판, effective 메뉴/분류 불일치를 지적했다. 수정 범위의 독립 재검토는 차단 지적 없음이다. 원래 preset 리뷰 모델은 quota로 실행 실패했으며 그 실패를 통과로 계산하지 않는다. |
| 최종 브라우저 | `node scripts/blog-workspace-browser-smoke.mjs` **85 checks** 통과. 1440/375/320px에서 다섯 탭·미저장 편집·버전 충돌·전체 본문/형식 승인·Git 계획 변경·차단 상태와 reflow를 확인했다. 실제 비공개 HTTPS의 최종 이미지도 인증 200, 다섯 탭, overflow 없음으로 확인했다. |
| 100k 동종 reference | 99,999/100,000 경계, 축약 하한/정확 수치, views/visits 거부, 분류·작성자 불일치, stale 맥락의 작성 전 차단과 승인 무효화가 통과했다. 실제 공개 Naver creator의 `17.8만+` **이웃 하한** 및 소유 글에서 두 육아 계정에 맞는 분석을 저장했다. 레이아웃·문단·이미지 위치 측정과 원본 적용 계획이며 이미지 재사용·생성·렌더 준수 승인은 아니다. |
| canonical 최신 포인터 | 세 기존 `LATEST.md`의 현재 source 포인터를 실제 policy/state/persona와 대조하고 과거 snapshot을 원문 보존했다. 최신 canonical source hash가 갱신되고 충돌이 해소된 Naver 계정의 원본 맥락을 읽었다. Tistory/GitHub의 원본 누락을 감추거나 공유/게시 권한으로 승격하지 않았다. |
| Jev API / 실제 작성 | **미충족.** 현재 `jeopi` 프로필은 disabled이고 전용 설정/키·실제 API 라우팅 영수증이 없다. 다른 프로필·모델로 대체하지 않았다. 실제 모델 작성 결과는 없으며, CLI 설치 감지만으로 인증/작성 성공을 주장하지 않는다. |
| 계정 신원 / 공개 게시 | 최종 배포의 호스트 스크립트로 세 Naver 계정의 현재 MyInfo 신원과 acting-tab 복귀를 다시 확인했다. 비밀번호 입력·MFA 자동화·새 자격 증명 로그인 증명은 아니다. Naver/Tistory의 완전한 공통 publisher는 **미구성**이며 공개 발행 0건이다. Tistory는 자체 persona/menu/작성 정책도 필요하다. |
| GitHub 게시 | 기존 approved editorial package와 exact plan 경로만 연결했다. 실제 checkout, 패키지/이미지 검증, 별도 exact Git 동의와 현재 권한이 없으므로 commit/push는 실행하지 않았다. commit→Pages→독립 공개 전체 본문 증명도 없다. |
| 앱 배포 / 데이터 / 예약 | 수정한 실제 이미지가 healthy이고 체크한 runtime 파일 **12개 hash**가 소스와 일치한다. 최종 교정 배포 직전 **441 entities**, history/settings/workflow 행의 hash multiset, 미디어 **29/29**를 그대로 보존했다. 이전 최초 배포의 390개 baseline도 보존했다. 현재 5개 예약은 모두 disabled, 실제 OS routine 활성화 0건이며 due 초안만 처리하는 동작은 격리 검증이다. |

런북·MEX 맥락과 외부 canonical 포인터 변경은 현재 로컬 작업 트리에만 저장했다. Git commit/push로 공유하지 않았고, 비밀 키·쿠키·탭 ID·개인 원본 본문은 이 문서나 공개 검증 자료에 넣지 않는다.

## 유지보수 근거

동작 변경 시 [API/버전 처리](../server/blog.mjs), [원본 해석](../server/blog-sources.mjs), [reference 검사/분석](../server/blog-references.mjs), [실제 어댑터](../server/blog-automation.mjs), [CLI help](../scripts/blog-workflow.mjs), [호스트 브리지](../scripts/agent-bridge.mjs), [화면](../public/blog.html)을 먼저 확인하고 이 문서를 갱신한다.

공개 1차 근거: [Tistory 공식 종료 공지](https://notice.tistory.com/2664), [확인된 Tistory 공개 분류](https://jellyggumi-journal.tistory.com/m/category/Living%20in%20Korea), [GitHub 저장소 메타데이터](https://api.github.com/repos/jellyggumi/jellyggumi.github.io), [gh-pages 소스](https://github.com/jellyggumi/jellyggumi.github.io/tree/gh-pages), [기존 editorial policy](https://github.com/jellyggumi/jellyggumi.github.io/blob/gh-pages/.claude/editorial-policy.yml). 공개 policy의 기존 routine/standing 설정은 관찰 자료일 뿐 FrameForge의 신규 게시 동의가 아니다.
