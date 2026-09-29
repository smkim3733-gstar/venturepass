# 후보 1건 운영 예약 명령·저장·복구·HTTP API·화면 — 3F1·3F2·3F3

기준: 2026-09-28. 순수 명령·쓰기 계획, DB v8 이전·전체 보관 감사·백업, 원자적 예약 저장·동일 명령 복구, HTTP 예약/조회 API와 명시적 확인·브라우저 원래 명령 보존/복구 화면을 연결했다. 별도 전송 승인·공급자 전송은 다음 단계다. 합성 시험의 `explicit-user` 형식은 실제 운영 승인 증거가 아니다.

## 명령과 최신 근거

`studio-plan-quality-provider-reservation-command.ts`는 후보 등록본 선택, 원래 명령 nonce, 승인한 예약 검토 digest, 선택된 채택 기록 참조와 전체 정책 head, 원장 digest, production 예산 head, 전역/production 실행 수를 받는다. 후보·현재 누적 예산·예약만 수행함·금융 계산이 토큰 적합성 검증은 아님·보관 조건·자동 재시도 없음의 명시적 확인과 별도 전송 승인 필요를 요구한다. 클라이언트의 가격·configuration·준비안·예산 재설정·실행 권한은 허용하지 않는다.

`prepareProviderReservation()`은 서버의 현재 configuration·원장·등록본·검사 시각을 받아 전체 원장을 다시 검사한다. 기존 native 영수증, 정책 채택 및 평가/등록/실행의 `otherNonces`와 충돌하는 요청은 신규 계획으로 처리하지 않는다. 같은 후보의 최신 채택 정책, 현재 설정, 현재 예산, 미정산 실행, 공유 20건 한도를 기존 예약 검토 계약으로 재검증한다. 다른 후보의 정책 채택 등으로 전체 원장이 바뀌어도 예전 검토는 재사용하지 않는다.

검토 시각에서 정확한 요청과 금융 준비안을 재구성하고 현재 시각의 유효성을 검사한다. 요청·금융 근거·보관 조건 digest가 승인한 검토와 일치해야 하며 승인 시각은 검토 이후, 기록 시각 이하, 검토 만료 이전이어야 한다. 서버의 기록 시각은 검토 만료 전에 있어야 한다. 자동으로 새 검토나 다른 준비안을 승인한 것으로 바꾸지 않는다.

## 계획의 내용과 보관 형식

계획은 `prepared-not-committed`, `single-immediate-transaction-required`, `audited-v8-transaction-required`를 명시한다. 실행 권한은 false다. 3F2a에서 결합 draft를 동결 보관 검증을 거친 v1 기록으로 바꿨고 3F2b에서 DB 이전·전체 저장 감사, 3F2c에서 원자적 저장·복구를 연결했다. planner 자체는 저장하지 않으며 실제 완료는 아래 저장소의 COMMIT 후에만 반환한다. 생성하는 native v2 기록은 기존 그대로다.

| 항목                        | 역할                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| start / run                 | 서버에서 재구성한 준비안, 기존 v2 승인 형식, 예산/실행 수 CAS                                 |
| generation-request artifact | 정확한 JSON 요청 본문·hash·바이트 수                                                          |
| reserve-run budget event    | 기존 예산의 다음 revision에 후보 1건의 금액만 예약                                            |
| provider-start receipt      | 기존 start input digest 및 run digest에 연결                                                  |
| policy binding record       | 원래 별도 명령 전체·command digest·승인 검토 전체·run ID/digest·native start digest·기록 시각 |

기존 native start digest에는 정책 참조가 없다. 이를 새 명령 digest로 대체하거나 run/receipt에 알 수 없는 필드를 추가하면 동결된 보관 계약이 깨진다. 따라서 정책 결합 자료는 별도로 연결하며 두 digest를 혼동하지 않는다. 결합 자료는 native 영수증의 동일 nonce를 **참조**한다. 정책 채택처럼 새로운 nonce 소유 행으로 중복 등록하지 않는다.

새 native 행을 기존 원장에 추가한 결과를 `inspectQualityLedgers()`로 재검사한다. 예산 초기화·한도 재설정·정산·전송 이벤트는 만들지 않는다. 기존 v1~v7 보관·백업 정의와 `ProviderLedgerStore.enabled()`의 synthetic 제한을 보존하며 v8 백업을 추가했다.

바이트 계산은 새 원장의 사용량+미해제 예약 바이트+새 결합 자료+원장 계산 밖의 기존 DB 바이트를 합쳐 공유 256MiB와 대조한다. `additionalUsedBytes`는 필수 서버 입력으로, 평가·등록·실행 테이블, 기존 결합 자료와 coverage 메타데이터, raw 행 인코딩 차이를 포함해야 한다. 사용자가 보내는 수치나 암묵적인 0으로 대신하지 않는다. 결합 기록 상한은 64KiB이며 기존 run/event/receipt 상한도 유지한다. native 초기 행을 포함한 budget 16개·receipt 64개의 예약 슬롯과 모든 기존 원장을 함께 계산한다. 저장소는 실제 raw 행 기준으로 쓰기 전후 한도를 다시 검사한다.

## 3F2a: 동결 보관 검증과 명시적 이전 경계

`scripts/local-data-quality-provider-reservation-binding.mjs`는 앱의 현재 builder·공식 configuration·현재 시각을 불러오지 않는 v1 검증기다. `*-binding-schema.mjs`에 동결한 엄격한 JSON 스키마와 TypeScript 형식의 일치를 시험한다. 신규 planner는 출력 전에 완성된 native 원장과 결합 기록을 이 검증기로 확인한다. 기존 run/receipt의 바이트 계약은 바꾸지 않는다.

- `validateProviderReservationBinding()`은 기본 원장 전체를 감사한 뒤 한 결합의 명령·두 검토 digest·선택 후보·원래 승인 시각·정확한 요청·금융/usage/보관 근거·native run/receipt·역사적 예산과 정책 prefix를 확인한다. 다른 run의 결합 누락을 검사하는 함수는 아니다.
- `inspectProviderReservationArchive()`는 위 검사에 더해 coverage와 모든 결합을 native 실행 삽입 순서대로 검사한다. 새 production run은 정확히 하나의 결합을 요구하며 누락·중복·고아·순서 변경을 거절한다. 결합/coverage 바이트도 기본 원장 사용량과 예약 용량에 합산한다. 3F2b부터 앱 비용 원장 검사와 전체 DB/백업 경로가 이 함수를 호출한다.
- `createProviderReservationMigrationCoverage()`는 이전 시점의 전체 run 수·run ID/버전/digest prefix와 그 안의 native v2 production run 목록을 만드는 순수 함수다. prefix에는 legacy와 synthetic 실행도 포함한다. 이후 새 기록을 추가해도 coverage는 그대로이며 기존 목록에 결합을 겹쳐 붙일 수 없다. 부모 저장소가 실제 구버전 이전 여부를 보장해야 한다.
- 정책 head에 포함된 채택은 예약 직전 예산 revision 이하를 관측해야 한다. head 밖의 후속 정책은 예약 이벤트 이상의 예산 revision을 관측해야 한다. 이 규칙으로 동일 timestamp에서 이전 정책을 누락하거나 나중 정책을 끼워 넣는 모순을 거절한다. 후속 채택·취소 및 현재 근거 만료는 과거의 정상 결합을 무효화하지 않는다.
- `decodeProviderReservationBindingRows()`는 원시 body/hash·run/nonce 색인·바이트 상한·storage order를 확인한다. 반환한 자료는 위 전체 감사에 넣어야 한다. 원래 공백을 포함한 바이트 수와 canonical JSON 바이트의 차이는 부모 DB의 실제 용량 검사에 반영해야 한다.

검토의 `ledgerDigest`는 당시 쓰기 잠금 안에서 비교한 전체 읽기 근거의 식별값이다. 보관 검증은 이를 원래 명령과 대조하지만 현재 DB만으로 당시의 모든 외부 작업 nonce와 raw 배열을 재구성하지 않는다. checksum은 출처 인증·서명·실제 사용자 동의의 증명이 아니며 과거 기록 검증을 새 예약/전송 권한으로 사용하지 않는다. coverage 생성도 정상적인 이전 경로에 한정해야 한다. 전체 자료와 checksum을 일관되게 다시 쓴 외부 위조를 검증기가 인증하는 것은 아니다.

## 3F2b: DB 이전·전체 감사·백업 연결

`local-data-quality-schema.mjs`는 기존 v1~v7 정의를 유지하고 `quality_provider_reservation_bindings`와 singleton `quality_provider_reservation_coverage`를 추가한다. 두 테이블은 수정·삭제 금지이며 모든 16개 테이블에 v8 쓰기 gate를 적용한다. 결합 nonce는 native receipt를 참조하는 외래키이고 전역 nonce 소유자 목록에 중복 합산하지 않는다.

`local-data-quality.mjs`의 `migrateQualitySchemaV8()`은 호출자의 `BEGIN IMMEDIATE` 안에서 구버전 전체 DB를 원래 계약으로 검사하고 검증된 run prefix의 coverage를 한 번만 기록한다. 이전 후 전체 검사를 통과해야 부모가 commit하며 실패 시 원래 테이블·gate·행으로 rollback한다. 이미 v8이면 재검사만 하므로 누락된 coverage를 다시 만들어 새 예약을 구버전으로 편입할 수 없다. 앱 생성자가 이 경로를 사용하며 이번 개발에서 실제 사용자 DB를 직접 열거나 이전하지 않았다.

`readProviderReservationDatabaseRows()`는 행 수·원시 body 바이트를 먼저 제한한 뒤 body/hash·run/nonce 색인·삽입 순서를 디코딩한다. 이 함수만으로 의미 검증이 끝난 것은 아니다. 전체 DB 검사는 같은 트랜잭션에서 평가/등록/실행 영수증·native 원장·정책·coverage·모든 결합을 검사한다. 앱의 일반 읽기/replay 전과 쓰기 완료 후에도 원장/coverage 감사와 공백을 포함한 전체 raw 바이트+예약 용량을 확인한다.

v8 backup manifest는 `providerReservationBindings`와 항상 1인 `providerReservationCoverage`를 포함한다. 논리 digest에는 두 테이블의 원본 body/hash·색인·결합 삽입 순서가 포함된다. 백업 생성·검증·복원은 동일한 전체 감사를 사용하며 손상된 원본으로 완료 marker를 발행하지 않는다. v1~v7 백업은 기존 형식으로 읽고 그대로 복원한 뒤 앱을 열 때 명시적으로 v8로 이전한다. 현재 configuration이나 시각이 바뀌어도 정상적인 과거 보관 기록은 재해석하지 않는다.

## 3F2c: 원자적 예약 저장·동일 명령 복구

1. `BEGIN IMMEDIATE` 안에서 전체 DB/원장을 감사하고 기존 nonce를 먼저 찾는다. 완전히 감사된 결합의 원래 명령 전체가 같으면 역사적 결과를 반환하고 다르면 충돌이다. 만료·현재 정책 변경 후에도 같은 명령의 완료 결과 조회는 허용하되 새 예약을 만들지 않는다. native receipt만으로 정책 승인까지 복구됐다고 판단하지 않는다.
2. 신규 요청만 최신 근거/CAS/한도를 검사하고 native 행+결합 행을 한 트랜잭션에 쓰며 전체 감사 후 commit한다. `additionalUsedBytes`에는 원장 밖의 DB 테이블·기존 결합/coverage·raw 인코딩 차이를 포함한다. 응답 유실·rollback·재시작·다중 연결/프로세스 경쟁·백업 복원 회귀 후 UI/API를 연결한다. 전송 승인은 계속 별도다.

`ProviderReservationStore`를 부모 저장소의 `providerReserve(command, approvedReview)`와 `providerReservationLookup(nonce)`에 연결했다. 쓰기는 같은 `BEGIN IMMEDIATE` 안에서 전체 DB 감사→보관된 동일 명령 replay/전역 nonce 충돌 확인→서버의 현재 configuration·시각·등록본으로 신규 계획 재검증→다섯 행 INSERT→전체 재감사→COMMIT 순서다. 조회도 전체 DB를 감사하며 native receipt만 있는 요청은 결합 완료로 반환하지 않는다.

`inspectQualityDatabaseUsage()`는 호출자의 트랜잭션을 요구하며 전체 감사에서 산출한 실제 raw 바이트와 예약 바이트를 반환한다. 저장소는 그 값과 검증된 native 원장의 canonical 사용량 차이로 `additionalUsedBytes`를 계산한다. 부모 용량 검사도 쓰기 전후 수행하며 초기 native 행을 포함하는 32MiB 보관 예약을 이중 합산하지 않는다. 기존 누적 예산을 다시 설정하지 않는다.

같은 명령의 재시도는 현재 configuration·시각을 읽거나 새로운 run ID를 만들기 전에 원래 결합을 반환한다. 새 요청만 현재 근거를 사용한다. `committed`는 역사적 저장 완료이고 현재 실행 상태나 전송 승인을 뜻하지 않는다. `not-observed`는 해당 결합을 찾지 못했다는 조회 결과이며 이전 요청 실패·새 nonce 발급 허가가 아니다. 저장/COMMIT/응답 오류 뒤의 미확인 처리는 아래 HTTP 경계에서 구분한다. native 실행의 synthetic gate와 보관된 false 권한은 유지한다.

## 3F3a: 명시적 예약 API·원래 요청 조회

`POST /api/studio/quality/provider-reservation/reservations`와 `GET /api/studio/quality/provider-reservation/requests/[clientRequestId]`를 dynamic Node 경로로 추가했다. `qualityProviderReservationCommandRoute()`는 로컬 origin/Host·포트·전달 Host·fetch-site, 메서드/query, JSON content-type, 선언 및 실제 본문 64KiB, 엄격한 UTF-8·JSON·명령/검토 스키마를 검사한 뒤에만 저장소를 연다. 원장/configuration/단가/예산 이벤트나 임의 권한을 클라이언트에서 받지 않는다. 기존 읽기 API와 정책 채택 outbox 계약은 유지한다.

본문은 `{ command, approvedReview }`다. `approvedReview: null`은 이미 저장된 원래 명령의 replay에 사용할 수 있고 신규 명령에는 유효한 검토가 필요하다. HTTP 계층에서 정책/예산을 따로 읽거나 DB 트랜잭션을 분할하지 않는다. 응답에는 `no-store, private, max-age=0`, `nosniff`, `no-referrer`를 적용한다.

| 상태                 | 의미                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `committed` / 200    | 저장소가 COMMIT 후 반환한 원래 결합. `delivery`는 `new`, `replay`, `lookup`.                                         |
| `not-observed` / 200 | 해당 nonce의 승인 결합을 관측하지 못함. `replay-original-request` 안내를 유지하며 실패 확정으로 바꾸지 않음.         |
| `refused` / 4xx      | 입력 경계 또는 감사 후 쓰기 이전에 확인된 이번 명령의 거절. 같은 nonce의 이전 시도 결과를 확정하지 않음.             |
| `unknown` / 500      | 저장소 열기·감사·쓰기·COMMIT·서버 응답 검사/직렬화 등에서 결과 미확인. 원래 nonce 조회 또는 동일 명령 replay만 안내. |

완료 영수증은 nonce, command/record/approvedReview digest, run ID/digest, native start input digest, 기록 시각과 false 전송 권한을 반환한다. 전체 결합의 형식·자체 digest·원래 명령 식별을 검사하고 요청한 nonce/명령과 일치해야 발행한다. 새 저장/재시도 플래그가 모순되거나 다른 명령/nonce의 결과가 섞이면 완료 대신 미확인이다. HTTP 검사가 저장소의 전체 보관 감사나 실제 승인 증거를 대체하지는 않는다.

저장소 내부 TypeError·SyntaxError·ZodError를 클라이언트 입력 오류로 반환하지 않으며 내부 경로·자격 증명·상류 오류 내용을 응답에 넣지 않는다. COMMIT 뒤 응답 생성이 실패했어도 확정 거절로 바꾸지 않는다. `committed`는 역사적 예약 저장의 영수증이고 현재 run의 상태나 새 전송 권한을 의미하지 않는다.

## 3F3b: 명시적 확인·브라우저 보존/복구

`quality-provider-reservation-command-panel.tsx`와 `quality-provider-reservation-outbox.ts`를 기존 검토 화면에 연결했다. 후보·누적 예산·예약만 수행함·금융 계산의 한계·보관 조건·자동 재시도 없음의 여섯 체크박스를 모두 직접 선택해야 `후보 한 건 비용 예약`을 누를 수 있다. 유효한 조건 충족 검토가 필요하며 정책/후보 변경, 재조회, 창 복귀나 보관 변경 시 이전 검토를 무효화한다. 기한 경과·조회 실패·진행 중에는 새 예약을 허용하지 않는다.

원래 명령/검토 전체와 digest·pending 결과를 별도 localStorage key `venturepass:provider-reservation-outbox:v1`에 기록하고 바이트가 동일하게 읽히는지 확인한 뒤에만 POST한다. Web Lock을 네트워크 처리와 결과 보관까지 유지한다. 최초 요청 직전의 전체 검토·scope·hash·기한과 여섯 확인 항목, 명령의 정책/예산 head·원장·실행 수를 검사한다. journal 상한은 96KiB, 원래 HTTP 요청은 64KiB, 응답은 16KiB이며 요청 제한 시간은 20초다. 필요한 브라우저 기능이나 저장소를 사용할 수 없으면 새 요청을 보내지 않는다.

복구 패널은 등록본/후보 선택과 독립되어 새로고침 후에도 원래 nonce 조회·동일 명령 replay·보관 요청 다시 읽기를 제공한다. 보관 중첩 검토와 명령, 영수증 nonce·명령/검토 digest·기록 시각·false 권한·응답 HTTP 상태를 검사한다. 복구는 원래 근거 시각을 보존하고 현재 검토 만료만으로 원래 요청을 버리지 않는다. `not-observed`, 만료, 후속 거절, 잘못된 응답, 응답 유실은 pending을 유지한다. 잠금을 독점한 최초 시도에서 nonce가 결합된 확정 거절만 refused로 보관할 수 있다. pending은 닫거나 새 nonce로 교체할 수 없다.

저장 후 오류·바이트 불일치·다른 탭의 교체가 생기면 원래 기록을 덮어쓰지 않는다. 확정 결과는 원래 요청과 함께 JSON으로 내려받거나 로컬 표시를 닫을 수 있지만 서버 예약을 취소하지 않는다. 완료 뒤 이전 검토를 무효화하고 현재 누적 예약액과 후보 미정산 상태를 다시 조회할 수 있다. 역사적 완료는 전송 승인이나 현재 실행 상태가 아니다. 정책 outbox의 key/lock/기록을 그대로 보존한다. 보관/잠금 범위는 같은 origin·브라우저 프로필이며 다른 컴퓨터·프로필·사이트 자료 삭제에 대한 복구 기능은 아니다.

## 후속 전송 승인 검토

3G1~3G3b 순수 전송 검토 계약·DB 읽기·HTTP 조회·검토 화면을 구현했으며 [PROVIDER_TRANSMISSION_REVIEW.md](PROVIDER_TRANSMISSION_REVIEW.md)에 연결과 검증 결과를 기록했다. 기존 native manifest/승인/dispatch/usage 계약을 재사용하여 감사된 예약 결합·현재 run/예산·고정 공식 설정·정확한 요청 내용을 비교한다. `PlanQualityStore.providerTransmissionReview(selection)`는 전체 DB 감사와 현재 근거 읽기를 같은 트랜잭션에서 수행하며 `POST /api/studio/quality/provider-transmission/inspect`에서 호출한다. 보관 이력의 production run을 선택하면 별도 조회·다운로드·만료 안내를 제공하고, 부모 갱신/선택/저장 이벤트/창 복귀에서 이전 검토를 무효화한다. 두 기존 outbox는 보존한다. 3H1 명시적 전송 승인 명령·순수 쓰기 계획도 완료했으며 [PROVIDER_TRANSMISSION_APPROVAL.md](PROVIDER_TRANSMISSION_APPROVAL.md)에 기록했다. 3H2a 동결 승인 결합/이벤트 prefix coverage 검증도 완료했다. 3H2b DB v9 이전·전체 저장 감사·백업/복원과 3H2c 원자적 승인 저장/복구도 연결했다. 3H3a 별도 승인 POST와 원래 요청 조회 GET도 연결했다. 3H3b1 승인 전용 보관/복구와 3H3b2 명시적 확인/복구 화면·합성 브라우저 검증도 완료했다. 다음은 4A 서버 고정 adapter 실행 연결 계약과 모의 transport다. 현재 예약/검토의 false 권한이나 기존 synthetic gate를 일괄 변경하지 않는다. 별도 승인 UI까지 연결했지만 실제 호출은 아직 연결하지 않았으며 합성 시험은 실제 운영 예약/승인이 아니다.

## 2026-09-28 05:27 KST 실행 검증

- 실제 세션 model·effort 및 collaboration 설정 `gpt-6-astra` / `ultra`를 확인했다. 별도 채팅이나 하위 에이전트는 만들지 않았다. 결합 자료의 저장·이전 무결성 작업이 남아 Ultra를 유지하며 해결 후 xhigh로 복귀한다.
- 신규 순수 계약 **58개**와 기존 예약 검토·provider core·정책 채택·provider 저장·백업 **197개**, 관련 **6파일 255개 테스트 통과**. 전체 저장소 테스트는 실행하지 않았다.
- 명령의 임의 설정/권한·누락된 확인·다른 후보·변경된 정책/head/예산/count·공유 nonce·만료·재해시된 위조 검토·손상 원장 거절, 최신 정책과 전체 head 구분, 다른 후보의 누적 예약 보존, 취소 이력을 포함한 공유 20건 제한, 예약된 보관 용량과 별도 DB 바이트를 포함한 정확한 256MiB 경계를 검증했다. 일곱 후보가 이미 예약한 상태에서 여덟 번째가 용량 부족으로 거절되는 합성 원장을 확인했다.
- 추가 예산 보존 시험에서 배열 첫 항목인 synthetic 예산을 production 예산으로 착각한 시험 코드를 scope 선택으로 수정했다. 관련 파일을 재실행했고 용량 진단 추가 후 최종 58개를 다시 통과했다. 중복 실행 수는 위 합계에 더하지 않았다.
- 최종 lint·typecheck·Webpack 빌드·신규 소스/문서 Prettier·소스 diff 공백 검사 통과. 빌드는 명령 범위 합성 키와 임시 자료 경로를 사용했다. 쓰기 API/화면은 연결하지 않아 새 브라우저 시험은 수행하지 않았다.
- 실제 키·사용자 데이터·운영 예산은 보존했으며 실제 운영 예약·유료 호출·고객 자료 전송은 실행하지 않았다. 기존 v2 보관 형식과 synthetic 실행 제한을 유지했고 커밋·푸시는 하지 않았다. 다음 자동 실행은 3F2부터 이어간다.

## 2026-09-28 05:48 KST 실행 검증

- 실제 세션 timestamp `2026-09-27T20:48:15.768Z`의 model·effort 및 collaboration 설정 모두 `gpt-6-astra` / `ultra`를 확인했다. 이번 단위는 3F2a 동결 보관 검증·coverage 계약이며 다음 3F2b에서 DB 이전·전체 저장 감사·백업을 연결한다.
- 신규 보관 검증 **55개**, 기존 예약 계획 **58개**, provider core·정책 보관·정책/예약 백업 회귀 **163개**, 관련 **6파일 276개 테스트 통과**. 모든 최종 시험은 첫 실행에서 통과했고 초기 스키마 생성용 일회성 시험은 이 합계에 넣지 않았다.
- 재해시한 명령/정책/예산/요청/승인 모순, 결합 누락·중복·고아·순서, coverage prefix와 이전 목록 변조, 원시 행 색인/hash/크기/순서, 후속 취소·만료 뒤 역사적 조회를 확인했다. 같은 timestamp에서 누락된 정책을 예산 순서로 거절하고 실제 후속 정책 채택은 과거 결합을 깨뜨리지 않는 양쪽 사례를 통과했다.
- 별도 native Node 프로세스에서 TypeScript/current builder를 불러오지 않고 실행했다. 해당 실행은 `fetch`와 `Date.now()`를 차단했으며 동일한 보관 digest를 반환했다. 실제 운영 승인/호출/예약은 수행하지 않았다.
- 최종 lint·typecheck·Webpack 빌드·신규/변경 소스 및 문서 Prettier·native 문법 검사·소스 diff 공백 검사 통과. 실제 환경파일은 읽거나 수정하지 않았고 빌드에는 명령 범위 합성 키와 임시 자료 경로를 사용했다. 전체 저장소 시험과 새 브라우저 시험은 미실행이다.
- 현재 DB v7 및 백업 형식·기존 v2 기록·synthetic gate는 그대로다. 실제 키·사용자 자료·운영 예산·기존 변경을 보존했고 새 채팅·하위 에이전트·커밋·푸시는 만들지 않았다. 이전/복구 무결성 작업이 남아 자동 후속 실행과 Ultra를 유지하며 해결 후 xhigh로 복귀한다.

## 2026-09-28 06:09 KST 실행 검증

- 실제 세션 timestamp `2026-09-27T21:09:16.115Z`의 model·effort 및 collaboration 설정 모두 Astra/Ultra를 확인했다. 3F2b의 v8 이전·불변 저장 형식·전체 보관 감사·백업/복원을 완료했고 다음 3F2c 예약 저장·복구·동시성 작업을 위해 Ultra를 유지한다.
- 품질평가 통합 **29파일 673개 항목 최종 통과**. 신규 33개는 v0~v7 이전·rollback·재개방, 구버전 열린 연결 차단, 손상된 구버전의 이전 거절, coverage 누락 재생성 금지, 결합 누락/nonce/hash/순서/크기와 coverage prefix 검증, 공유 raw 바이트/예약 용량, v8 및 v7 production 백업 복원·2035년 재조회·manifest 변조·미완료 marker를 확인했다.
- 최초 통합 묶음 665개 통과·8개 실패 후 해당 5파일 70개를 재검증했다. 손상 주입 뒤 트리거를 복원해 스키마/본문 실패를 분리하고, 실제 후보 영수증 INSERT 실패를 spy로 주입하며, 손상 전에 HTTP 요청을 구성하고 v8 기대값을 반영했다. 나머지 24파일 603개와 합산한 고유 항목 수이며 중복 실행은 더하지 않았다. 초기 신규 시험의 메서드 이름 오타도 수정했다.
- 최종 lint·typecheck·Webpack 빌드·Prettier·native 문법·diff 공백 검사 통과. 전체 저장소 시험과 신규 브라우저 시험은 수행하지 않았다. 모든 DB/승인 형식/예산은 임시 합성 fixture이고 빌드에는 합성 키·임시 자료 경로를 사용했다. 실제 사용자 DB·키를 직접 열거나 변경하지 않았고 실제 운영 예약·전송·과금은 실행하지 않았다.
- 기존 native v2 기록·false 실행 권한·synthetic gate를 보존했다. 실제 예약 명령의 저장·완료 결과 replay·HTTP/UI는 다음 3F2c부터 구현하며 현재 planner 자체는 저장을 실행하지 않는다.

## 2026-09-28 06:49 KST 실행 검증

- 실제 세션 `2026-09-27T21:49:16.836Z`의 model·effort 및 collaboration 설정 모두 Astra/Ultra에서 3F2c를 완료했다. 원자적 저장·역사적 replay·조회는 서버 메서드에 연결됐고 예약 쓰기 HTTP/API와 명시적 버튼은 다음 3F3a/3F3b다.
- 관련 **10파일 253개 테스트 통과**. 신규 저장 통합 25개·native 자식 프로세스 6개, 기존 계획 58개·정책 동시성 5개, 기존 저장/조회/백업 6파일 159개다. 다섯 INSERT 각각의 실패 뒤 전체 rollback, 중복 명령/상충 명령/정책 채택과 공유 nonce 경쟁, 실제 COMMIT 전후 프로세스 종료, 재시작·복원 후 2035년 replay와 현재 configuration 실패를 검증했다.
- 평가 기록의 손상은 신규·조회·replay 모두 거절했다. 실제 raw 공백·원장 밖 등록 기록·coverage·결합 바이트를 합산한 한도와 32MiB 예약의 이중 계산 방지, 기존 예산·타 후보 예약 보존을 확인했다. 조회 미관측은 실패 확정으로 변환하지 않는다.
- 최종 lint·typecheck·Webpack 빌드·Prettier·native 문법·diff 공백 검사 통과. 전체 저장소 시험과 새 브라우저 시험은 수행하지 않았다. 시험 자료는 모두 임시 합성 DB이며 외부 IO/자격 증명을 사용하지 않았다. 실제 운영 예약·전송·과금을 실행하지 않았고 기존 데이터·키·사용자 변경을 보존했다.
- 저장·복구 난제를 마쳤으므로 다음 HTTP 경계 작업은 같은 채팅의 실제 후속 설정으로 xhigh 복귀를 요청한다. 전환 요청 성공과 다음 실행의 실제 적용 확인을 구분한다.

## 2026-09-28 07:10 KST 실행 검증

- 실제 세션 timestamp `2026-09-27T22:10:17.133Z`의 model·effort 및 collaboration 설정 모두 Astra/xhigh임을 확인했다. 이전 Ultra 작업 후 복귀의 실제 적용을 확인하고 3F3a 예약 POST·원래 nonce 조회 GET을 완료했다.
- 관련 **5파일 184개 테스트 통과**: 신규 API 통합 44개, 기존 예약 조회 API 47개·예약 저장 25개·예약 화면 검증 36개·정책 채택 API 32개다. 새 검증은 입력/크기/로컬 요청 차단 시 저장소 미접근, 단일 쓰기 트랜잭션, 명령/검토/기록 영수증 식별, 실제 COMMIT 전후 오류와 응답 직렬화 실패, 재시작/만료/설정 오류 후 원래 명령 복구, 서버 결과 변조 및 손상 원장의 미확인을 포함한다.
- lint·typecheck·Webpack 빌드·Prettier·소스 공백/충돌 검사를 통과했다. 새 API 2개와 기존 읽기 경로가 dynamic Node 경로로 빌드됐다. 전체 저장소 시험·별도 서버 HTTP/브라우저 시험·다중 프로세스 재검증은 미실행이다.
- 모든 쓰기 시험은 임시 합성 DB와 승인 형식에 한정했고 외부 IO를 차단했다. 실제 키·사용자 데이터·운영 예산·기존 변경을 보존했으며 실제 운영 예약·유료 호출·고객 전송을 실행하지 않았다. 다음 3F3b에서 별도 확인·원래 명령 보존/복구 UI를 연결한다.

## 2026-09-28 07:25 KST 실행 검증

- 실제 세션 `2026-09-27T22:25:17.311Z`의 model·effort 및 collaboration 설정 모두 Astra/xhigh에서 3F3b를 완료했다. 기존 정책 outbox의 보관/잠금 프로토콜을 재사용했으며 추가 모델 전환은 필요하지 않았다.
- 관련 **6파일 246개 테스트 통과**. 예약 outbox 통합 40개·예약 화면 39개와 기존 정책 outbox/정책 UI/검토 UI/예약 API 167개다. 저장 전 실패의 무전송, COMMIT 전/후 응답 유실과 정확한 원래 명령 복구, 현재 시각 2035년 복구, 최초/후속 거절 구분, 변조·다른 영수증·권한·HTTP 응답 차단, 탭 잠금과 교체/늦은 응답 보존을 확인했다.
- 임시 합성 DB와 가짜 키로 실행한 별도 production 서버에서 headless Edge 8개 시나리오를 통과했다. 여섯 확인·저장 실패·새로고침·요청/응답 유실·두 탭 복구·다운로드·현재 예약액/미정산 후보 조회·로컬 결과 닫기를 확인했다. 정책/실행/예산 이벤트/결합은 각각 1/1/2/1건이고 정책 journal 바이트를 보존했다. 브라우저 오류와 외부 요청은 없었다. 1280px/390px 화면을 시각 확인했으며 가로 넘침이 없었다.
- lint·typecheck·Webpack 빌드를 통과했다. 브라우저 증거는 상위 `.venturepass-tools/reservation-command-ui-smoke-20260928.json` 및 스크립트·화면 PNG에 보관했다. 임시 서버 3101을 종료했고 실제 사용자 서버·키·자료·기존 변경은 보존했다. 전체 저장소/다중 프로세스 회귀 재실행과 실제 운영 예약·유료 호출·고객 전송은 하지 않았다. 다음은 3G1 별도 전송 승인 검토 계약이다.
