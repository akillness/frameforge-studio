# Jev 실제 검토

2026-10-18에 TypeSafe API를 호출해 제품 구현 요약과 실제 생산 smoke 근거를 검토했습니다. 모델 `jev-1.13.0`은 528ms에 응답했고, 899 입력·80 출력 토큰을 보고했습니다. [원본 응답 영수증](../artifacts/jev-live-review.json)은 키·쿠키를 포함하지 않습니다.

결과 `proposal_only`는 과제 부합성 yes 0.93, 근거 지지 yes 0.80, 관련 없는 변경 no 0.76, 추가 확인 필요 no 0.67에 근거합니다. 뒤의 두 확신도가 기준 0.80 미만입니다. 이 결과는 실행 허가가 아니며 테스트를 대신하지 않습니다. 검토 내용은 생성된 영상과 구현 근거의 요약이고 전체 소스 감사가 아닙니다.

## 실행 경계

- 호스트: Codex. 프로필: `frameforge-codex`. 실행 모드: 명시적 advisory CLI.
- API backend tier: `unvalidated`. 모델 검증 attestation을 임의로 설정하지 않았습니다.
- 자동 훅을 설치하거나 신뢰 설정을 변경하지 않았습니다.
- 기존 구형 Jev 실행기, shared/Aside 스킬 카탈로그는 보존했습니다.
- 최신 실행기는 [akillness/jeo-skills](https://github.com/akillness/jeo-skills/tree/d9af9e3de37b0fd940d5cab1897c9b9a00fd8a35/jev)의 커밋 `d9af9e3de37b0fd940d5cab1897c9b9a00fd8a35`에 고정했습니다. `jev/` 파일만 별도 캐시에 받고 Git blob 해시를 확인했습니다.

## 재현

비공개 프로필은 저장소 밖 `<profile-home>/.agents/jev/profiles/frameforge-codex.env` 및 `frameforge-codex.api.env`에 둡니다. 현재 사용자만 읽을 수 있도록 Windows ACL을 제한했습니다. 실제 키는 웹 UI·README·Git에 저장하지 않습니다.

기본 프로필은 `JEV_ENABLED=true`, `JEV_MODE=api`, `JEV_RUNTIME_MODE=advisory`, `JEV_REVIEW_MODE=advisory`입니다. API 프로필에는 `JEV_API_KEY`, `JEV_API_ENDPOINT=https://api.typesafe.ai/v1/systemone`, `JEV_API_MODEL=jev-latest`가 필요합니다. Windows에서는 Bash HOME과 Node USERPROFILE의 경로 차이를 피하려고 격리된 프로필 파일을 직접 구성한 뒤 plugin의 enable preview/apply를 사용했습니다.

```powershell
$env:JEV_HARNESS_PATH='<pinned-runtime>/jev/jev-harness.mjs'
$env:JEV_PROFILE_HOME='<private-profile-home>'
$env:JEV_RUNTIME_COMMIT='d9af9e3de37b0fd940d5cab1897c9b9a00fd8a35'
node scripts/jev-review.mjs
```

스크립트는 먼저 동일 프로필의 review 상태를 검사하고, 키 없이 제품 요약과 `artifacts/production-smoke.json`을 전송합니다. 실행하면 실제 API 호출이 발생하며 영수증을 갱신합니다. 이번 검토 이후 추가된 변경은 별도 테스트·코드 검토로 확인하며 이 영수증이 새 변경까지 검토했다고 주장하지 않습니다.
