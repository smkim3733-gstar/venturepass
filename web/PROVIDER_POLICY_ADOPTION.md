# 정책 채택·초기 예산 설정

2026-09-28. 읽기 전용 정책 검토 계약과 v4 서버·화면 연결에 이어 **3A 명령·쓰기 계획, 3B1 보관 검사, 3B2 schema v7·백업 연결, 3C 채택 저장·동시성·재시도 복구, 3D1 HTTP API, 3D2a v5 검토 화면·다운로드, 3D2b 명시적 확인·채택·미확인 요청 보존/복구를 구현했다.** 이후 예약 연결의 현재 상태는 [PROVIDER_RESERVATION_COMMAND.md](PROVIDER_RESERVATION_COMMAND.md)를 따른다. 3F2b부터 앱의 현재 저장 스키마는 v8이며 아래 v7 정의는 구버전 계약으로 보존한다. 순수 함수의 `prepared-not-committed` 계획과 저장 메서드의 `committed` 결과를 구분하며, 어느 쪽도 예약·전송 권한을 부여하지 않는다. 검증 결과는 아래 실행 기록을 따른다.

## 완료한 3A 계약

- `src/lib/studio-plan-quality-provider-policy-adoption-command.ts`: 브라우저에서 사용할 엄격한 명령 스키마다. 후보/등록본, 승인한 검토 digest, 예상 정책 head, 예산 유지/최초 설정 선택과 명시적 확인을 받는다. 클라이언트가 단가·모델·공식 설정·실행 권한을 추가하는 입력은 거절한다.
- `src/lib/studio-plan-quality-provider-policy-adoption-types.ts`: 승인한 검토와 정확한 요청·공식 근거의 제안 스냅샷, 예산 head 전이, 불변 기록 digest와 원자적 쓰기 계획의 형식을 정의한다. 스키마 통과만으로 보관 기록의 무결성이 검증되는 것은 아니다.
- `src/lib/studio-plan-quality-provider-policy-adoption.ts`: 서버가 같은 쓰기 트랜잭션에서 검사한 최신 후보·공식 설정·예산·정책 head·전체 작업 nonce를 전달받아 계획을 만든다. 이 함수 자체는 저장이나 IO를 수행하지 않는다. 오래된 검토, 변경된 근거·예산, 만료, 잘못된 승인 시각과 nonce 충돌을 거절한다.
- `src/lib/studio-plan-quality-provider-policy-adoption.test.ts`: 메모리 합성 입력으로 초기 설정 영수증의 기존 원장 호환성, 기존 한도·사용액·예약·위반 보존, stale 입력, 중복·변조·재시도 경계를 검증한다.

예산이 없으면 검증된 제안으로 기존 v2 configure 이벤트와 `provider-budget-configure` 영수증을 준비한다. 정책 채택의 `clientRequestId`와 최초 예산의 `initialBudgetRequestId`는 별개이며 두 요청 번호 모두 재사용되지 않아야 한다. 기존 예산이 있으면 초기 설정을 만들지 않고 전후 head를 그대로 유지한다. 자금을 충전하거나 한도를 증액·초기화하지 않는다.

채택 자체는 예약·전송 권한을 주지 않으므로, 호환되는 기존 예산의 부족액이나 한도 위반은 경고를 보존한 채 정책만 채택할 수 있도록 계약을 정했다. 통화/단위가 맞지 않는 예산은 거절한다. 실제 후보 예약 단계는 당시 가용액과 위반 상태를 다시 검사해야 한다. 모든 채택 기록의 `reservationAllowed`와 `dispatchAllowed`는 false다.

요청 digest는 원래 명령 전체에 묶이고 서버의 재시도 시각에 따라 바뀌지 않는다. `compareProviderPolicyAdoptionRetry()`는 원래 명령과 이미 검사한 기록의 식별 비교다. 같은 nonce의 다른 승인 내용은 충돌로 처리하고, 동일 요청은 이후 만료·설정 변경과 무관하게 같은 요청으로 식별한다. 이 함수는 영속화·정책 체인·예산 참조의 완전한 감사 검증이나 현재 실행 허가를 대신하지 않는다.

## 완료한 3B1 공용 보관 기록 검증

- `scripts/local-data-quality-provider-policy-schema.mjs`는 보관 형식 v1의 고정 JSON Schema다. TypeScript 기록 계약과의 구조 일치 테스트를 포함한다. JSON Schema에 표현되지 않는 refinement는 아래 공용 검증기가 수행한다. 기존 보관본의 의미를 바꾸려고 이 파일을 재생성하면 안 된다.
- `scripts/local-data-quality-provider-policy.mjs`는 TypeScript 실행기 없이 native Node와 앱에서 사용할 수 있다. 현재 프롬프트·공식 설정·시계·자격 증명을 읽지 않고 당시의 요청, 단가 계산, 공식 근거와 보관/사용량 정책의 연결을 검사한다. 기존 provider 모듈의 고정 재무·요청 검사 부분을 분리해 재사용했으며 기존 실행 준비 검사는 같은 함수를 거친다.
- `validateProviderPolicyAdoptionRecord()`는 기록의 hash·승인·만료·후보/등록본 참조, 당시 예산 원장 prefix의 금액·head와 최초 설정 이벤트를 검사한다. 앱의 순수 쓰기 계획기도 반환 전에 이 검증을 통과해야 한다. 실패는 `archive-proof-invalid`로 거절한다.
- `inspectProviderPolicyLedger()`는 정책 체인의 순서·누락·nonce 충돌, 예산 head의 역행을 검사하고 기존 provider 실행·이벤트·영수증·원본 검사를 함께 수행한다. 정책 nonce와 사용 바이트 수를 반환한다. 호출자는 **등록본/등록 영수증과 legacy 원장의 전체 검사, 모든 원장이 공유하는 용량 검사**를 별도로 완료해야 한다. 이 함수만으로 전체 SQLite 데이터베이스 검사가 끝나는 것은 아니다.
- 기록 hash는 전자서명이나 공식 자료의 진위 증명이 아니다. 모든 관련 파일을 일관되게 다시 위조한 경우까지 탐지한다고 주장하지 않는다. 정책 채택은 예약·전송 권한을 부여하지 않는다.

합성 검증에서 서로 다른 두 채택 기록이 최초 예산을 유지하고, 해시를 다시 계산해도 잘못된 단가·요청·근거 연결·예산·영수증·후보 참조를 거절함을 확인했다. native Node 자식 프로세스에서도 같은 검증기를 실행했다. 이후 3B2에서 백업 CLI와 SQLite의 전체 검사 경로에 연결했다.

## 구현한 3B2 SQLite·백업 연결

- `quality_provider_policies`는 scope/revision과 독립 nonce, 원문과 hash를 보관한다. 기존 13개 테이블에 추가되어 v7은 14개 테이블, 불변 트리거 28개, writer 트리거 14개다. 각 INSERT는 `quality-v7` 계약을 요구하며 이미 열린 v6 연결도 쓰기를 거절한다.
- `migrateQualitySchemaV7()`는 호출자의 쓰기 트랜잭션에서 알려진 구버전만 이전한다. 기존 행·본문·hash·원본 BLOB을 다시 쓰지 않고 새 테이블과 알려진 writer 트리거만 변경한다. 불완전하거나 혼합된 schema는 보수하지 않고 거절한다. 과거 v1~v6 정의와 허용 범위는 유지한다.
- `decodeProviderPolicyRows()`가 최대 100행·행당 2 MiB를 제한하고 원문 바이트 수, rowid 순서, 열과 본문·hash의 일치를 검사한다. `inspectQualityLedgers()`가 legacy, provider, 정책을 결합하며 provider 전체 검사를 중복 수행하지 않는다. 등록본과 등록 영수증 검사는 기존 부모 검사 경로가 유지한다.
- 앱의 모든 작업 nonce에 정책 nonce를 포함한다. 정책 기록이 있으면 기존 평가·후보 조회와 재시도도 정책 검사를 먼저 거친다. 실제 원문 바이트와 다른 원장의 보관 예약량이 공유 256 MiB 한도에 반영되며 기존 예약 슬롯·행 수 한도를 유지한다.
- 백업 manifest v7은 `providerPolicies` 수를 포함하고 논리 digest에 정책 행의 순서·본문·열을 포함한다. 정책 참조와 예산·영수증을 검사한 뒤 백업/복원하며 v1~v6의 manifest와 논리 digest 계산은 유지한다.
- 테스트 자료 변환 함수는 합성 DB에서 제거할 테이블이 비어 있는지 확인한 뒤 과거 형식을 구성한다. 운영 마이그레이션은 테이블·정책 기록을 제거하거나 하위 버전으로 되돌리지 않는다.

## 현재 소스에서 확인한 제약

- `ProviderLedgerStore.enabled()`는 synthetic-test만 허용한다. 기존 budgetConfigure/start/전송 메서드의 제한을 일괄 해제하면 안 된다.
- 기존 production 예산은 `candidate-quality-provider-v2-live`에 누적된다. `budgetConfigure()`는 한 번만 설정하고 기존 한도를 덮어쓰지 않는다. nonce 중복·동일 요청 재실행 검사가 이미 있다.
- `scripts/local-data-quality-provider.mjs`의 `inspectProviderLedger()`는 runId=null인 영수증을 scope당 정확히 하나의 `provider-budget-configure`로 해석하며 입력 digest까지 다시 계산한다. 여기에 새 채택 영수증을 무조건 넣으면 기존 원장 검사를 깨뜨린다.
- `quality_actual_requests`의 레코드 상한은 4096바이트다. 전체 검토 근거·정확한 요청을 그대로 보관하는 용도로 전용하면 안 된다.
- `inspectQualitySchema()`는 알려진 테이블·트리거와 SQL을 정확히 비교한다. 새 정책 보관 테이블을 추가하려면 마이그레이션과 백업/복원 검사를 함께 확장해야 한다.
- `migrateQualitySchemaV6()`는 기존 행·본문·hash·원본 BLOB을 다시 쓰지 않는다. 저장 버전이 과거에는 허용하지 않던 행을 소급해서 허용하지 않는다는 규칙도 보존해야 한다.
- `inspectQualityLedgers()`는 전체 nonce 충돌, 다른 원장과 공유하는 기록 수·용량·예약 슬롯을 검사한다. 새 채택 기록을 도입하면 해당 용량과 충돌 검사에서 빠지지 않아야 한다.
- `providerReviewContext()`는 동일 SQLite 읽기 트랜잭션에서 검증한 후보·production 이벤트·head를 제공한다. 쓰기 시에는 별도의 `BEGIN IMMEDIATE` 안에서 최신 입력과 기한을 다시 검사해야 한다. 공개 hash만으로 사용자 제출 근거를 신뢰하지 않는다.

## 구현한 3C 채택 저장·동시성·복구

`studio-plan-quality-provider-policy-adoption-store.ts`는 서버 전용 저장 메서드다. `PlanQualityStore`의 `providerPolicyHead()`, `providerPolicyLookup(nonce)`, `providerPolicyAdopt(command, approvedReview)`로 접근한다. 이후 3D1에서 HTTP 경로를 연결했다.

- 새 채택은 부모의 `BEGIN IMMEDIATE`에서 전체 보관 기록 검사 → 동일 nonce의 원래 명령 조회 → 최신 서버 configuration·후보·production 예산·정책 head·만료 검사 → 용량과 예약 슬롯 검사 → 정책 및 필요한 초기 예산/영수증 INSERT → 전체 재검사 → COMMIT 순서다. 성공 객체는 부모가 COMMIT한 뒤에만 호출자에게 반환된다.
- `inspectQualityDatabase(db, { inTransaction: true })`는 실제 활성 트랜잭션을 요구하며 부모의 COMMIT/ROLLBACK을 실행하지 않는다. 정책·비용 원장뿐 아니라 기존 평가·등록 영수증·실행 기록·원본의 무결성도 확인한다. 일반 백업 호출의 기본 트랜잭션 동작은 유지한다.
- 동일 명령은 최신 시계·설정·정책 head 검사보다 먼저 원래 저장 결과를 반환한다. 이때 원래 review는 이미 보관돼 있으므로 재전송 입력이 없어도 복구할 수 있다. 같은 nonce의 다른 명령은 거절한다. lookup/replay도 전체 보관 무결성 검사를 생략하지 않는다.
- 새 요청의 configuration은 함수 인자로 받지 않고 쓰기 잠금을 얻은 후 `getProviderConfigurationProposal()`에서 읽는다. 승인된 review는 참고 입력이며 서버 근거로 다시 만든 검토 digest와 일치해야 한다. 기존 production 예산과 사용액·미정산 예약을 덮어쓰지 않는다.
- 정책 행과 최초 예산 이벤트·영수증은 한 트랜잭션에 속한다. 모든 작업 nonce와 공유 바이트 한도, 기존 원장의 후속 기록 예약 슬롯을 적용한다. 기존 `ProviderLedgerStore.enabled()` 제한은 유지하며 채택 메서드만 명시적인 정책 계약에 따른 로컬 저장을 수행한다.
- 별도 native Node 프로세스에서 동일 요청/서로 다른 요청/같은 nonce의 다른 명령/기존 provider 예약과의 경쟁을 검사했다. COMMIT 직후 자식 프로세스를 실제 종료한 뒤 재시작·lookup·replay하는 경계도 검증했다. 합성 저장 시험이며 실제 운영 승인이나 유료 전송은 아니다.

## 구현한 3D1 검토·채택·조회 HTTP API

- `providerPolicyReviewContext(version)`는 전체 보관 기록을 검사하고 후보·production 예산 이벤트/head·정책 head를 하나의 읽기 트랜잭션에서 반환한다. `providerReviewContext()`와 `providerPolicyHead()`를 따로 호출해 조합하지 않는다.
- `POST /api/studio/quality/provider-policy/inspect`는 v5 검토 응답에 `policyHead`를 포함하며 전체 viewDigest에 묶는다. 설정 누락 v1·만료 v3 응답을 유지한다. 기존 `/provider-review/inspect`의 v4 응답, 기존 화면과 고정 보관 review/record는 변경하지 않았다.
- `POST /api/studio/quality/provider-policy/adoptions`는 엄격한 `{ command, approvedReview }`와 기존 로컬 origin·Host·요청 방식·JSON·64 KiB 본문 제한을 검사한다. 단가·configuration·예산 이벤트·실행 권한은 추가 입력으로 받지 않는다. `approvedReview`는 승인 당시 검토를 전달하는 참고 자료이며 서버가 쓰기 트랜잭션 안에서 재구성한 근거로 검증한다. `null`은 이미 저장된 명령의 replay에만 유효하다.
- `GET /api/studio/quality/provider-policy/requests/[clientRequestId]`는 전체 저장 무결성을 확인한 뒤 원래 정책 기록의 최소 영수증을 반환한다. 영수증은 원래 명령의 requestDigest와 기록 digest, 검토 digest, 예산 head 전이 및 false 예약/전송 권한을 포함한다. 조회로 쓰기나 새 명령을 생성하지 않는다.
- 응답 버전 1은 `committed`(new/replay/lookup), `refused`, `not-observed`, `unknown`을 구분한다. `refused`는 **이번 시도**의 입력·계획 거절이며 이전의 응답 유실 요청까지 실패했다고 증명하지 않는다. `not-observed`도 다른 진행 중 요청의 실패를 증명하지 않으므로 원래 명령을 보존한다. 저장/COMMIT/응답 생성 오류와 무결성 검사 실패는 결과를 추정하지 않고 `unknown`으로 반환한다. 내부 오류·자격 증명·경로는 출력하지 않는다.
- 서버 API는 `studio-plan-quality-provider-policy-service.ts`, 브라우저에서 사용할 계약은 `studio-plan-quality-provider-policy-http-types.ts`다. 3D2b에서 명시적 확인과 요청 보존을 거쳐 화면에 연결했다.

## 구현한 3D2a v5 검토 화면·다운로드

- `QualityProviderReviewPanel`은 새 `/provider-policy/inspect`를 조회하며 검증된 v5와 기존 v1~v4 자료를 같은 UI 검증기로 읽는다. 기존 API 경로의 v4 계약은 바꾸지 않는다.
- 브라우저 검증은 전체 viewDigest에 policyHead를 포함하고 기존 제안·공식 근거·정확한 요청·예산·검토 digest의 관계 검사를 유지한다. 정책 head의 구조·상한·revision/null 관계가 잘못되거나 알 수 없는 필드가 있으면 거절한다. 이 검사만으로 클라이언트 자료에 서버의 채택 권한이 생기지는 않는다.
- 조회 시 확인한 전체 정책 채택 기록 수를 예산 옆에 표시한다. 기존 기록 수를 이번 제안의 새 채택 완료로 표시하지 않는다. JSON 다운로드는 정책 head를 포함한 전체 조회본을 보존하며, 만료된 검토도 보관 자료로 읽을 수 있다.
- 이 조회 단계 자체는 승인 명령을 만들지 않는다. 별도의 3D2b 화면에서 확인받은 뒤 원래 요청을 보존하고 채택 API를 호출한다.

## 구현한 3D2b: 명시적 채택·명령 보존·복구

- `quality-provider-policy-adoption-panel.tsx`는 후보·고정 모델과 최초 예산 설정/기존 한도 유지 내용을 표시하고, 기본 해제된 두 확인란을 모두 선택해야 채택 요청을 만든다. 재조회한 검토에서는 확인란을 초기화하며 기한 만료·통화/단위 불일치·보관 한도 도달 시 새 채택을 차단한다. 부족한 가용액에 관한 기존 검토 표시는 유지한다.
- `quality-provider-policy-outbox.ts`는 전체 명령·승인 당시 검토·원래 nonce와 결과를 하나의 엄격한 journal로 `localStorage`에 보관한다. journal/request/review digest와 참조·기한 관계를 검증하고 저장 직후 같은 바이트를 다시 읽은 뒤에만 POST한다. 본문은 서버의 64 KiB 한도를 지키고 journal은 96 KiB, 응답은 16 KiB, 요청 대기는 20초로 제한한다.
- 같은 origin·브라우저 프로필의 협력하는 탭은 단일 Web Lock을 보관→전송→결과 보관까지 유지한다. `ifAvailable: true`로 경쟁 요청을 즉시 중단하며 대기열에 승인 작업을 쌓거나 잠금을 강제로 빼앗지 않는다. 원래 journal과 현재 저장 바이트를 다시 비교해 늦은 응답이 다른 요청을 덮어쓰지 못하게 한다. 잠금·보관 기능이 없거나 저장/검증에 실패하면 새 전송을 차단한다.
- 상태는 `pending`, `committed`, `refused`다. 성공은 원래 요청 번호·명령/검토 digest·정책 revision·저장 시각·예산 전이를 대조한 영수증만 인정한다. 영수증도 보관·재확인한 뒤 화면에 성공으로 표시한다. 새 원래 요청의 첫 단독 시도에서 직접 확인한, 요청 번호가 일치하는 4xx `refused`만 닫을 수 있는 거절이다.
- 네트워크·응답 검증·시간 초과는 원래 `pending`을 유지한다. 이후 lookup의 `not-observed` 또는 replay의 `refused`도 이전 미확인 요청을 닫는 근거로 사용하지 않는다. 복구는 원래 요청 조회 또는 바이트가 동일한 명령 replay이며 nonce를 새로 만들지 않는다. 미확인 요청에는 삭제·초기화·다음 승인 생성 경로가 없다. 결과가 확인된 기록만 해당 요청 번호를 다시 검사한 뒤 닫을 수 있다.
- 복구 패널은 후보 선택과 독립적으로 마운트되어 새로고침 후에도 나타난다. storage/focus/pageshow에서 검증된 보관 상태를 다시 읽고 오래된 비동기 조회 결과는 무시한다. 정책 결과가 확인되면 이전 검토 화면을 무효화하고 경합 안내를 해제한다. 다른 탭의 채택 완료로 진행 중 검토 조회가 무효화돼도 그 조회의 로딩 상태는 종료한다. 검증된 원래 요청·결과 JSON을 내려받을 수 있다.

브라우저 동작 근거: [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), [storage 이벤트](https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event), [localStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage). 보관·잠금의 범위는 동일 origin과 프로필이다. 다른 포트/호스트/프로필/컴퓨터 간 승인 의도를 공유하거나, 사용자의 사이트 자료 삭제·브라우저 저장소 유실·임의 스크립트 변조까지 복구하는 계약은 아니다. 공개 checksum은 인증 서명이 아니며 서버의 전체 원장 검사와 승인 근거 재구성을 대신하지 않는다. 이러한 범위를 넘어서는 조정은 이후 별도의 서버 계약이 필요하다.

## 진행 중인 3E: 채택 정책에 연결한 후보 1건 예약

3E1 **검증된 채택 기록과 현재 후보·서버 공식 설정·정확한 요청·누적 예산을 묶는 예약 검토 계약**, 3E2 **검증된 DB 읽기 연결**, 3E3a **읽기 전용 HTTP API**를 구현했다. 계약과 검증 범위는 [PROVIDER_RESERVATION_REVIEW.md](PROVIDER_RESERVATION_REVIEW.md)를 따른다. 서버 메서드 `PlanQualityStore.providerReservationReview(selection)`은 schema·평가/등록 원본과 전체 원장을 같은 읽기 트랜잭션에서 검사하고 현재 서버 configuration을 읽는다. `POST /api/studio/quality/provider-reservation/inspect`가 이 검토를 반환하며 3E3b 검토 화면·재조회·다운로드도 완료했다. 다음은 3F1 별도 후보 예약 명령과 채택 정책/현재 예산 연결 계약이며, 동결된 보관 기록과 CAS·복구 경계를 검토하기 위해 실제 Ultra 적용을 확인하고 진행한다. 채택 당시 예산 스냅샷을 현재 가용액으로 사용하지 않고 현재 revision/head·사용액·예약액·실행 수와 채택 참조를 함께 확인한다. 과거 검토/기록의 false 권한을 true로 바꾸거나 `ProviderLedgerStore.enabled()`를 일괄 해제하지 않는다.

그다음 예약 명령·동일 요청 복구·원자적 저장, 명시적 예약 UI/API, 별도 전송 승인, adapter 연결 순서로 진행한다. 현재 provider start 계약과 전체 nonce·보관/예약 슬롯·백업 검증을 재사용하되 production 예약을 무조건 허용하지 않는다. 이미 해결한 3D2b를 반복하지 말고 새 저장/동시성 난제가 필요한 시점에 실제 Ultra 설정을 확인한다. 모든 검증은 합성 입력·임시 DB·모의 transport를 사용하며 실제 운영 승인·유료 호출·고객 전송으로 취급하지 않는다.

## 회귀에서 유지할 실패 경계

- 채택 행과 초기 예산 이벤트/영수증 중간 실패 시 전부 rollback.
- 두 저장 연결의 동일 head 경쟁, 같은 nonce 중복과 다른 내용 충돌.
- 기록 후 응답 유실, 다시 시작한 저장소의 lookup/replay, 재시도 시각에 근거가 만료되거나 설정이 바뀐 경우의 일관된 복구.
- 기존 사용액·미정산 예약·통화·한도 위반 보존, 합성 원장과 production 원장 분리.
- 새 백업 roundtrip 및 구버전 backup 읽기, 행 hash를 다시 만든 변조도 참조/승인 근거 검사에서 거절.

## 검증과 실행 상태

2026-09-28 01:32 KST에 시작한 후속 실행의 실제 세션 model·effort 및 collaboration 설정이 모두 `gpt-6-astra` / `ultra`임을 확인했다. 3A 계약은 이 실행에서 구현했다. 저장·마이그레이션·동시성·복원 작업이 아직 남아 있으므로 Ultra를 유지하며, 해당 난제 해결 후 같은 채팅에서 xhigh 복귀를 적용하고 확인한다.

- 채택 계약, 정책 검토, 정책 읽기 저장소 통합, 공식 설정의 관련 4파일 **129개 테스트 통과**.
- lint, typecheck, `build --webpack` 통과. 소스 diff 공백 검사 통과.
- 이번 실행에서는 전체 테스트와 브라우저 시험을 수행하지 않았다. 활성 UI나 API 연결 변경은 없다.
- 위 실패 경계 중 실제 DB rollback·두 연결 경쟁·재시작 replay·백업 roundtrip은 아직 미실행이며 3B 및 저장 연결에서 검증해야 한다.
- 실제 키·사용자 데이터·운영 예산은 변경하지 않았고 실제 API 호출·승인·전송은 실행하지 않았다. 변경은 로컬 작업 트리에 보존했고 커밋·푸시는 하지 않았다.

### 2026-09-28 01:52 KST 후속 실행

- 실제 세션 model·effort 및 collaboration 설정이 `gpt-6-astra` / `ultra`임을 다시 확인했다. 3B1 공용 보관 검증기를 구현하고 쓰기 계획기에 연결했다. 저장·동시성·복구 난제가 남아 있으므로 Ultra를 유지한다.
- 신규 보관 검증 40개를 포함한 관련 7파일 **261개 테스트 통과**. 신규 파일은 타입 수정과 추가 속성 거절 사례를 반영한 후 40개를 다시 통과했다(261개에 포함). 기존 provider 실행 및 구버전 백업·복원 회귀도 포함한다.
- 최초 타입 검사에서 JS 기본 빈 배열의 타입 추론과 합성 회사명 필드의 오류를 확인해 수정했다. 최종 lint·typecheck·Webpack 빌드와 소스 diff 공백 검사·변경 파일 Prettier 검사는 모두 통과했다.
- 실제 SQLite v7 마이그레이션·정책 저장 rollback·동시성·정책을 포함한 v7 백업 roundtrip은 아직 미실행이다. 이번 단위에서 UI를 변경하거나 브라우저 시험·전체 저장소 테스트를 수행하지 않았다.

### 2026-09-28 02:09 KST 후속 실행

- 실제 model·effort 및 collaboration 설정 `gpt-6-astra` / `ultra`를 확인하고 3B2 저장·백업 기반을 구현했다. `migrateQualitySchemaV7()`, 공용 SQL 행 검사, 전체 원장 결합과 백업 manifest v7을 앱과 native Node에 연결했다.
- 새 `studio-plan-quality-provider-policy-backup.integration.test.ts`의 31개가 통과했다. 과거 정의·바이트 보존, v0~v6 이전/rollback, 열린 이전 writer 차단, 정책/초기 설정의 중간 실패, 두 정책 기록의 백업·복원, 변조·참조 단절·누락·용량·nonce 충돌과 혼합 schema 거절을 검증했다. 합성 회사 자료 sentinel의 보존을 확인했으며 실제 자격 증명은 사용하지 않았다.
- 관련 16파일 **334개 테스트 통과**. 최초 14파일에서 통과한 8파일 119개와 수정 후 재실행한 6파일 169개, 정책 보관·조회 2파일 46개를 합한 중복 없는 수다. 새 roundtrip에 별도 Node `quality-verify`의 정책 수·환경 격리 확인을 추가한 뒤 해당 1개를 다시 통과했다(334개에 포함). 전체 저장소 테스트와 브라우저 검증은 수행하지 않았다.
- 기존 rollback 시험은 미지원 트리거를 추가하는 대신 실제 영수증 INSERT 호출에서 실패시켜 부분 기록이 취소되는지 검증한다. 구버전 백업 시험은 임시 DB의 빈 테이블만 제거해 v1~v6 형식을 명시적으로 유지한다. 새 비동기 백업 시험에는 기존 백업 시험과 같은 150초 제한을 적용했다. 앱의 schema·경로 검사를 완화하지 않았다.
- 최종 lint·typecheck·Webpack 빌드·Prettier·소스 diff 공백·native MJS 문법 검사는 모두 통과했다. 빌드에는 명령 범위의 합성 키와 임시 자료 경로를 사용했다.
- 실제 채택 저장 메서드의 두 연결 CAS·재시작 replay 검증은 아직 남았다. 다음 3C에서 최신 공식 설정 검사와 원자적 저장을 연결하므로 Ultra를 유지한다. API·화면 버튼 및 후보 예약·전송은 이후 단계다. 실제 유료 호출·사용자 자료 전송·운영 채택은 실행하지 않았다.

### 2026-09-28 02:45 KST 후속 실행

- 실제 모델·추론 및 collaboration 설정 `gpt-6-astra` / `ultra`를 확인하고 3C 채택 저장을 완료했다. 서버 전용 `ProviderPolicyAdoptionStore`를 기존 부모 트랜잭션에 연결했고, configuration은 쓰기 잠금 안에서 서버 함수로 다시 읽는다. HTTP 경로와 화면 버튼은 다음 3D 대상이다.
- 신규 저장 통합 19개와 별도 프로세스 경쟁·종료 복구 5개를 포함해 관련 14파일 **306개 테스트 통과**. 첫 5파일 125개와 기존 기능 9파일 181개이며 중복 합산하지 않았다. 기존 예산 및 합성 예약의 바이트 보존, 세 INSERT 각각 직후의 실패 rollback, 만료·변경·위조된 검토 거절, 전체 저장 손상 시 lookup/replay 거절, 전역 nonce·용량 제한도 확인했다.
- 별도 native Node 프로세스는 실제 자격 증명 환경변수를 제거하고 OpenAI 생성자·fetch를 차단한다. 두 프로세스의 같은 요청은 한 번만 저장하고 나머지는 동일 결과를 복구한다. 다른 요청은 head 충돌, 같은 nonce의 다른 명령은 내용 충돌로 거절한다. 기존 provider 예약과 경쟁해도 같은 nonce의 소유자는 하나다. COMMIT 직후 프로세스를 종료하고 새 저장소·2030년 시각에서 lookup/replay해도 초기 예산이나 정책이 다시 생성되지 않았다.
- 최초 테스트 자료의 추가 필드와 configuration digest 함수·nullable 타입 오류를 수정했다. 서버 전용 모듈 도입에 따라 기존 시험의 `server-only` 모킹을 맞췄다. 최종 lint·typecheck·Webpack 빌드·Prettier·소스 diff 공백·native MJS 문법 검사 모두 통과했다. 전체 저장소 시험과 브라우저 시험은 하지 않았다.
- 실제 운영 채택·예산 쓰기·유료 호출·사용자 자료 전송은 실행하지 않았다. 검증은 합성 입력과 임시 DB로 수행했다. 3C 난제를 해결했으므로 다음 3D는 같은 채팅에서 xhigh 복귀를 요청한 후 실제 적용을 확인하고 진행한다.

### 2026-09-28 03:13 KST 후속 실행

- 실제 세션 model·effort와 collaboration 설정 `gpt-6-astra` / `xhigh`를 확인했다. 복귀 요청만 성공한 상태와 구분하며 이번 3D1 API 구현은 xhigh에서 수행했다.
- 신규 HTTP 통합 32개를 포함한 관련 **8파일 236개 테스트 통과**. 동일 읽기 트랜잭션의 v5 검토, v4 호환, 최초 예산과 기설정 예산 보존, 엄격한 로컬/본문/명령 검사, stale 검토와 nonce 거절, COMMIT 전후 예외·응답 생성 실패 및 재시작 복구, 저장 손상 시 결과 미확인을 확인했다. 기존 저장·동시성·읽기 API·브라우저 검증 함수의 회귀도 포함한다.
- 최종 lint·typecheck·Prettier·소스 diff 공백 검사와 Webpack 빌드를 모두 통과했다. 새 API 3개가 동적 경로로 빌드됨을 확인했다. 실제 브라우저 시험과 전체 저장소 테스트는 이번 단위에서 수행하지 않았다. 화면은 기존 읽기 전용 흐름이며 다음 3D2에서 명시적 확인과 미확인 요청 보존·복구를 연결한다.
- 임시 합성 DB에서만 채택 요청을 실행했다. 실제 키·사용자 자료·운영 예산은 변경하지 않았고 유료 API 호출·고객 전송·실제 운영 채택은 실행하지 않았다. 새 채팅·하위 에이전트·커밋·푸시는 만들지 않았다.

### 2026-09-28 03:29 KST 후속 실행

- 실제 `gpt-6-astra` / `xhigh`를 확인하고 3D2a v5 검토·다운로드를 기존 화면에 연결했다. 새로운 명령 보관·채택 버튼은 다음 3D2b이며, v5 표시를 채택 성공으로 취급하지 않는다.
- 관련 **5파일 187개 테스트**, lint·typecheck·Webpack 빌드·Prettier·소스 diff 공백 검사 통과. 새 v5 브라우저 검증 17개는 정책 head와 전체 digest 연결, 형식·상한·알 수 없는 권한 필드 거절, 내부 검토 변조, 만료 후 보관본 읽기와 전체 다운로드를 확인한다. 기존 v1~v4 및 API 회귀도 포함한다.
- 임시 합성 DB와 실제 빌드를 Edge headless에서 조회·다운로드·재조회했다. 다운로드 전체 JSON 일치, 모든 저장 행 digest와 예산/head 불변, 오류·외부 요청 0건을 확인했다. 1280px/390px 화면을 시각 검사했고 가로 넘침이 없었다. 임시 서버 3101은 종료했다. 실제 운영 채택·유료 호출·고객 전송은 수행하지 않았다.
- 페이지 재시작·여러 탭·늦은 응답 중 원래 미확인 명령을 보존하는 동시성/복구 문제를 위해 같은 채팅의 `send_message_to_thread`로 `gpt-6-astra` / `ultra` 후속 실행을 요청했고 성공 응답과 메시지 전달을 확인했다. 이번 구현은 xhigh에서 완료했으며 실제 Ultra 적용은 다음 실행에서 확인해야 한다. 해결 뒤 xhigh로 복귀한다.

### 2026-09-28 03:44 KST 후속 실행

- 실제 `gpt-6-astra` / `ultra`에서 3D2b를 구현했다. 04:04 KST 컨텍스트의 세션 및 collaboration 설정도 Astra/Ultra로 재확인했다. 이제 명시적 두 확인, 보관·재확인 후 채택, 재시작 lookup/원래 명령 replay, 검증된 요청·결과 다운로드가 실제 화면에 연결됐다. 예약·전송 권한은 여전히 별도다.
- 관련 **8파일 250개 테스트**가 통과했다. 신규 journal 통합 36개는 실제 임시 API/DB와 주입한 저장/전송 경계를 사용한다. 보관 전후 실패·응답 유실·위조 영수증·손상·후속 거절·미관측·늦은 응답·동시 탭·시간 초과를 확인했다. UI 확인 폼 3개를 추가했고 기존 v1~v5 검토·API·저장·별도 프로세스 경쟁 회귀도 포함했다.
- 실제 Edge의 최종 **8개 브라우저 시나리오**를 통과했다. 두 탭의 native Web Lock 경쟁과 보관 상태 반영, 탭 종료 후 다른 탭 복구, 서버에 도달하지 못한 명령의 동일 바이트 replay, 저장 직후 유실한 응답의 lookup, 저장 공간 실패·잠금 미지원 차단을 검증했다. 추가 경합 검사에서 타 탭 채택으로 읽기 sequence가 무효화될 때 로딩이 남는 문제를 재현하고 수정한 뒤 다시 통과했다. 결과 확인 뒤 오래된 잠금 안내도 해제한다.
- 최종 lint·typecheck·Webpack 빌드·Prettier·diff 공백·브라우저 스크립트 문법 검사 통과. 1280px/390px 화면을 시각 확인했고 가로 넘침, 브라우저 오류, 외부 요청이 없었다. 원래 명령 다운로드와 journal이 일치하고 초기 예산은 한 번만 기록되며 예약/실행 기록은 0건이었다. 증거는 루트 `.venturepass-tools/policy-adoption-ui-*`와 `policy-adoption-*-20260928.png`에 남겼고 임시 3101 서버는 종료했다.
- 모든 쓰기는 격리된 합성 DB에만 수행했다. 실제 키·사용자 데이터·운영 예산을 보존했고 유료 호출·고객 전송은 실행하지 않았다. 전체 저장소 테스트는 미실행이다. 다음 3E1 예약 검토 계약을 위해 같은 채팅에서 xhigh 복귀를 요청하며 실제 적용은 다음 실행에서 확인한다.
- 같은 채팅의 `send_message_to_thread(model: gpt-6-astra, thinking: xhigh)` 복귀 요청이 성공했고 후속 메시지 전달을 확인했다. 현재 구현은 실제 Ultra에서 완료했으며, xhigh 실제 적용은 다음 실행의 세션 설정 검증으로 확정한다.
