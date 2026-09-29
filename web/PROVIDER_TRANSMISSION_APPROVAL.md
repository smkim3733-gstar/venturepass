# 후보 한 건의 별도 전송 승인 — 3H1~3H3b2

기준: 2026-09-28. 별도 동의 명령·순수 쓰기 계획·동결 승인 결합/coverage·DB v9 이전/감사/백업에 **원자적 저장·원래 명령 복구·HTTP API·브라우저 outbox·명시적 확인/복구 UI**를 연결하고 합성 검증을 마쳤다. 실제 전송은 후속 단계다. 합성 입력의 `explicit-user` 형식은 실제 운영 승인 증거가 아니다.

## 명령과 검토의 결합

`studio-plan-quality-provider-transmission-command.ts`의 엄격한 명령은 선택 run ID/digest, 전체 승인 검토 digest, archive/coverage/예약 결합/manifest digest, 실행 r0 snapshot, 현재 정책 head와 정확한 후보 정책 참조, 현재 예산 head를 포함한다. 동의는 외부 전송, 생성과 그 결과에서 파생할 검토, 정확한 보관 안내 digest, 금융 예약과 토큰 적합성의 차이, 미확인 비용 보류·자동 재시도 없음, 현재 정책/예산 확인과 시각으로 구분한다. 브라우저가 모델·요금·manifest·만료 시각·native payload·쓰기 권한을 추가할 수 없다.

`prepareProviderTransmissionApproval()`는 서버가 쓰기 잠금 안에서 읽은 전체 v8 archive와 명시적 시각/설정을 받아야 한다. 전체 native 원장·정책·예약 결합·coverage를 감사하고 공유 nonce 소유자를 확인한다. 이전 검토 시각으로 현재 자료를 재구성한 결과가 전체 digest와 같고 아직 기한 내여야 한다. `conditions-met`와 명령의 모든 예상 기준·보관 안내가 일치해야 하며 `inspectedAt <= approvedAt <= recordedAt < expiresAt`을 유지한다. 검토 시각으로 원래 preparation/금융 근거를 바꾸거나 기한을 연장하지 않는다.

## 순수 쓰기 계획

| 항목                     | 계획 내용                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| native execution command | 기존 `transmission-approved` payload, 원래 manifest, 서버가 정한 검토 기한                                          |
| native event             | 실행 r1, 이전 event 없음, 현재 예산 revision, 새 명령의 승인 내용                                                   |
| native receipt           | `provider-approve`, 원래 nonce, 기존 `providerExecutionOperationDigest()` 결과                                      |
| approval binding         | 전체 원래 명령·command digest·승인 검토, run ID/digest, native input/event digest, 기록 시각                        |
| 예산·run·artifact        | 기존 내용을 보존하며 새 행을 만들지 않음                                                                            |
| 결과                     | `prepared-not-committed`, 단일 immediate transaction과 완전한 승인 결합 감사 필요, dispatch/budget write 권한 false |

이벤트와 영수증을 추가한 메모리 원장을 기존 전체 감사기로 다시 검사하고 새 결합을 동결 reader로도 검증한다. 원래 32MiB 실행 예약과 native event/receipt 슬롯을 재사용하며 예산을 다시 예약하지 않는다. 새 결합은 128KiB, native event는 32KiB, receipt는 4096바이트 이하여야 한다. 전체 원장의 사용/예약 바이트·기존 v8 결합/coverage·새 결합·부모가 감사한 추가 사용량을 합산해 256MiB 한도를 적용한다. `additionalUsedBytes`에는 승인 coverage·기존 승인 결합·다른 DB 테이블·원시 행 인코딩 차이를 포함해야 하며 생략하거나 클라이언트에 맡기지 않는다. 단일 결합 검증은 다른 승인의 coverage를 대신하지 않으므로 후속 writer의 전체 감사가 필수다.

## 재시도와 보관 경계

전체 명령의 식별값과 native 실행 식별값은 서로 다르다. 두 검토가 동일한 run/manifest/예산·승인 시각/만료를 가리키면 native 승인 payload와 input digest가 같을 수 있지만, 검토 시각·전체 검토 digest가 다르면 **같은 사용자 명령이 아니다**. native 영수증만으로 원래 검토·CAS·동의를 복구했다고 판단하지 않는다. 새 결합은 native receipt nonce를 참조하며 독립적인 nonce 소유자로 중복 등록하지 않는다.

현재 planner는 이미 소유된 nonce를 항상 `nonce-conflict`로 거절한다. 저장 완료 판정이나 replay 결과를 만들지 않으며 검토가 만료되거나 configuration이 없어도 기존 nonce로 새 승인/dispatch 계획을 만들지 않는다. 저장소는 먼저 전체 승인 결합을 감사하고 저장된 원래 명령 전체와 비교한 뒤, 동일한 경우에만 역사적 저장 결과를 반환해야 한다. 이 복구는 새 승인·dispatch가 아니며 현재 configuration/시각을 요구하지 않는다. 다른 명령은 충돌이고, 원래 요청이 관찰되지 않았다는 이유만으로 새 nonce를 발급하지 않는다.

`providerTransmissionApprovalBindingSchema`의 형식을 native 정적 JSON schema로 동결했다. shape/hash 일치는 영속 저장·완전한 coverage·출처 인증을 증명하지 않는다. 새 행들은 결합을 포함해 원자적으로 저장되고 읽기·백업·복원에서 함께 감사돼야 한다. 기존 v2 run/receipt와 native 승인/dispatch 형식, synthetic 전용 실행 gate, 보관본의 false 권한은 그대로다.

## 3H2a: 동결 보관 감사와 이전 경계

`scripts/local-data-quality-provider-transmission-binding.mjs`는 현재 설정·벽시계·application builder·DB/transport를 읽지 않는다. 전체 v8 원장/정책/예약/coverage를 감사한 뒤, 원래 reservation 결합과 요청·금융·보관 근거, nested manifest/usage 계약, 과거 r0 snapshot, 승인 당시 정책/예산 prefix, 정확한 native r1 event/receipt/input digest를 교차 검증한다. 명령/검토/record digest를 다시 만들고 동의·조건·시각·기한을 검사한다. 새 정책·예약·dispatch·해제/종료 이벤트가 추가되거나 근거가 만료돼도 원래 prefix를 읽는다.

기존 DB는 run을 rowid, 이벤트를 run ID/revision, 영수증을 nonce로 읽는다. 영수증 배열은 삽입 prefix가 아니므로 이전 경계로 쓰지 않는다. coverage v1은 전역 run prefix의 개수/digest와 **그때 존재한 각 provider run의 이벤트 개수/prefix digest**, 그 prefix에 실제 포함된 production 승인 event/nonce/input digest를 고정한다. prefix는 run 생성 순서로 대조한다. 이전 당시 r0 예약이던 run에 나중에 추가된 승인과 새 run의 승인은 모두 결합이 필수다. 기존 승인 예외와 새 결합은 겹치지 않으며 누락·중복·불일치를 거절한다. 결합 저장 순서는 run 생성 순서와 달라도 되지만, 원시 row decoder는 증가하는 storage order·run/nonce 색인·body hash·바이트 한도를 검사한다.

`createProviderTransmissionApprovalMigrationCoverage()`는 이전 전용 순수 생성기다. **현재 schema의 coverage 누락 시 재생성하면 안 된다.** 한도는 결합 20개/각 128KiB, coverage 16KiB이며 전체 native 사용/예약·v8 보관·새 보관 합계는 256MiB다. 반환 `usedBytes`는 새 coverage/결합만 포함하고 `reservationArchive`는 기존 v8 감사 결과다. 후속 DB reader는 다른 테이블·raw 인코딩 차이까지 별도 합산해야 한다.

`archiveDigest`는 쓰기 때 비교한 전체 스냅샷 식별값이다. 이후 다른 등록본/nonce/행까지 바뀐 현재 자료에서 완전히 복원한다고 주장하지 않으며, 보관된 명령과 검토 사이의 일치를 검사한다. coverage와 해시 자체도 출처 서명은 아니다. 부모 저장 계층이 기존 coverage를 재발급하지 않고 원자적으로 보존해야 하며, 모든 기록과 경계를 함께 다시 쓴 공격을 해시만으로 인증할 수는 없다.

## 3H2b: DB v9 이전·읽기·백업/복원

`migrateQualitySchemaV9()`는 부모의 `BEGIN IMMEDIATE` 안에서 기존 자료 전체를 감사하고, 필요한 v8 이전까지 마친 뒤 승인 coverage를 한 번 생성한다. `quality_provider_transmission_bindings`와 `quality_provider_transmission_coverage`를 추가하고 18테이블 모두 v9 writer gate로 교체한다. v1~v8 SQL 정의·본문·hash·BLOB·v8 예약 coverage는 보존한다. 결합 nonce는 기존 native 영수증 참조이며 새 전역 nonce 소유자가 아니다. 현재 v9의 coverage 누락은 빈 DB에서도 실패하며 재생성하지 않는다.

앱 초기화와 원장 읽기, 부모 트랜잭션의 읽기/쓰기 전후 감사, 백업/복원에서 전체 승인 coverage를 검사한다. 원시 행은 개수/크기를 SQL로 제한한 뒤 storage order·색인·body hash를 검사한다. canonical 크기뿐 아니라 공백을 포함한 원시 승인 결합/coverage와 다른 모든 테이블·예약 저장량을 공유 한도에 합산한다. 백업 v9 manifest와 logical digest는 새 두 테이블 및 개수까지 포함하며, 검증 CLI도 새 개수를 반환한다. v1~v8 백업은 원래 버전으로 복원하고 앱 초기화 때 이전한다. 검증기/백업 도구는 현재 설정이나 실제 공급자를 호출하지 않는다.

이전 시점에 이미 있던 production 승인만 정확한 이벤트 prefix로 보존한다. 이후 승인은 기존 r0 예약의 승인도 결합이 필수다. 스키마/coverage/필수 결합 손상은 일반 이력 조회·재개방·백업을 차단한다. 구버전 writer와 이전 전 준비된 INSERT도 차단하며, 실패 시 새 테이블·trigger·coverage는 모두 되돌린다. 이 단계에서는 운영 승인 명령의 쓰기를 열지 않는다.

## 3H2c: 원자적 저장과 정확한 원래 명령 복구

`ProviderTransmissionApprovalStore`를 부모의 `providerApproveTransmission(command, approvedReview)`와 `providerTransmissionApprovalLookup(nonce)`에 연결했다. 쓰기는 `BEGIN IMMEDIATE` 안에서 schema·모든 원장/평가/등록·v8/v9 coverage/결합·raw 공유 용량을 감사한다. 기존 nonce의 결합에 보존된 원래 명령 전체가 일치하면 현재 설정/시각/검토를 읽기 전에 역사적 결과를 반환한다. 다른 명령이나 다른 작업의 nonce는 충돌이다. native receipt만 있는 이전 승인은 `not-observed`이며 승인 명령으로 재제출하면 충돌한다. 과거 동의나 원래 검토를 만들어 복구하지 않는다.

신규 명령만 현재 configuration·시각과 portable v8 archive로 검토를 재구성하고 CAS·동의/기한·용량을 검사해 native r1 event/receipt/결합 세 행을 같은 트랜잭션에 저장한다. 세 행이 완성된 후 전체 v9 재감사와 부모의 공유 용량/nonce/경로 검사에 통과해야 COMMIT한다. run/artifact/예산은 쓰지 않는다. 반환 `committed`는 보존된 전체 명령/검토를 가진 역사적 결과이며 `dispatchAllowed`, `budgetWriteAllowed`는 false다. 조회도 전체 감사를 거치며 현재 실행 상태를 승인 영수증으로 대체하지 않는다.

추가 용량은 `전체 raw usedBytes - native canonical usedBytes - v8 canonical usedBytes`다. 기존 승인 coverage/결합·다른 테이블·raw 인코딩 차이를 포함하고 planner가 이미 세는 v8 바이트를 중복 계산하지 않는다. native event/receipt는 기존 run의 저장 예약을 소비하므로 새 노출량은 결합 크기만 증가한다. planner의 256MiB와 부모의 raw 공유 한도를 모두 검사한다.

세 INSERT 각각의 예외 rollback과 실제 프로세스 종료, 감사 후 COMMIT 직전/직후 종료, 같은 명령·다른 nonce의 stale run·native input digest가 같은 다른 검토, 정책/예약과 공유 nonce 및 현재 근거 경쟁을 시험했다. 복구는 재개방·2035년·현재 설정/시각 차단·백업 복원 후에도 원래 결과를 반환한다. 기존 production native 실행 gate는 합성 테스트 옵션으로도 열리지 않는다.

## 3H3a: 승인 HTTP 명령과 원래 요청 조회

`POST /api/studio/quality/provider-transmission/approvals`는 `{command, approvedReview}`를 받고 `GET /api/studio/quality/provider-transmission/requests/[clientRequestId]`는 원래 요청 번호를 조회한다. 두 경로는 dynamic Node handler이며 기존 `/inspect`는 읽기 전용으로 유지한다. 계약은 별도 `studio-plan-quality-provider-transmission-approval-http-types.ts`, 경계는 `*-approval-service.ts`다.

로컬 URL/Host·origin·프록시/fetch-site·method/query·JSON content type을 확인한다. 승인 본문은 선언 길이와 실제 UTF-8 바이트 모두 **128KiB** 이하여야 하며, 분할 본문도 같은 한도를 적용하고 초과 스트림을 취소한다. 입력 스키마는 엄격하고 설정/현재 archive/native payload/추가 권한을 클라이언트가 지정할 수 없다. 모든 입력 검사는 저장소를 열기 전에 수행하며 승인 또는 조회 메서드는 한 번만 호출한다. NEW에는 유효한 승인 검토가 필요하고 `approvedReview: null`은 감사된 동일 명령 replay만 성공할 수 있다.

완료 응답은 `responseVersion: 1`, `state: committed`, `delivery: new|replay|lookup`과 간결한 영수증이다. 원래 nonce·command/record/approvedReview digest·run ID/digest·executionInputDigest·approvalEventDigest·approvalRevision 1·기록 시각을 반환하고 `dispatchAllowed`, `budgetWriteAllowed`는 false다. 저장소 결과의 상태/상호 배타적 delivery flag/false 권한과 전체 명령/검토/run/CAS/시각을 검증한다. 원래 동결 필드만으로 native 승인 식별을 다시 계산해 잘못 연결된 영수증을 거절하며 현재 시각/설정이나 추가 DB 조회를 요구하지 않는다. 이는 출력 일관성 검사이고 전체 보관 감사나 실제 사용자 동의의 출처 인증을 대체하지 않는다.

| 결과         | HTTP                    | 의미                                                                                              |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------------------- |
| committed    | 200                     | 원래 승인 명령의 역사적 저장 완료                                                                 |
| not-observed | 200                     | 감사된 승인 결합을 찾지 못함. 원래 명령 replay로 확인                                             |
| refused      | 400/403/405/409/413/415 | 이번 입력/명령 시도가 거절됨. 이전 미확인 시도까지 실패로 확정하지 않음                           |
| unknown      | 500                     | 저장소 열기·전체 감사·저장/COMMIT·응답 생성/검증 실패. 원래 nonce 조회 또는 동일 명령 replay 필요 |

확정 거절은 입력 검사와 쓰기 전 명령 검사 코드로 한정한다. 내부 archive/planned-archive 오류와 저장 용량/감사 실패는 unknown으로 남기며 내부 TypeError/SyntaxError/ZodError를 사용자 입력 오류로 오인하지 않는다. COMMIT 뒤 응답 생성에 실패해도 확정 거절로 바꾸지 않는다. 모든 응답은 no-store/private, nosniff, no-referrer이며 내부 경로·자격 증명·상류 오류를 공개하지 않는다. API는 실제 전송·예산 변경·runner를 호출하지 않는다.

## 3H3b1: 승인 전용 원래 요청 보관과 복구 계약

`quality-provider-transmission-outbox.ts`는 기존 예약 outbox의 저장·재확인·잠금 순서를 재사용한다. 저장 key는 `venturepass:provider-transmission-outbox:v1`, Web Lock은 `venturepass:provider-transmission-outbox`로 정책/예약 journal과 독립된다. journal 160KiB, HTTP 요청 128KiB, 응답 16KiB, 응답 대기 20초 한도다. 실제 화면 연결과 브라우저 시험은 3H3b2에서 완료했다.

`begin(view, registry, snapshot, acknowledgements)`는 기존 전송 검토 validator로 선택한 원래 예약 snapshot/등록본과 현재 유효한 조건 충족 검토를 대조한다. `external`, `generationAndReview`, `currentPolicyAndBudget`, `financial`, `retention`, `retry` 여섯 명시적 확인이 모두 true여야 한다. 원래 전체 명령/검토와 command digest, pending outcome을 브라우저 저장소에 쓰고 다시 읽어 일치한 뒤 승인 POST를 보낸다. 같은 origin·프로필의 협력하는 탭들은 응답 결과 저장까지 전용 Web Lock을 유지한다. 보관 실패/불일치에는 전송하지 않으며 결과 저장 실패에도 원래 요청으로 복구한다.

`read()`와 `recover(originalId, lookup|replay)`는 현재 후보/run 선택이나 현재 설정/시각에 의존하지 않는다. 원래 보관 검토/명령의 연결·중첩 manifest/contract/usage/금융 근거 digest·동의 시각을 역사적으로 검사하며, 재생은 원래 전체 명령과 검토를 사용한다. 브라우저 재시작·검토 만료·not-observed/unknown·후속 거절은 원래 pending을 삭제하거나 새로운 nonce를 만드는 근거가 아니다. 첫 독점 시도에서 직접 관측한 같은 nonce의 4xx 거절만 terminal로 저장할 수 있다. `dismiss(originalId)`는 terminal만 닫으며 오래된 ID나 pending은 거절한다. 늦은 응답 앞에서 저장 값이 달라졌으면 덮어쓰지 않는다.

완료는 HTTP 200·엄격한 JSON/UTF-8/응답 크기·POST/GET delivery 종류와 false 권한을 검사한다. nonce·전체 command/review/run을 대조하고 원래 native 승인 payload로 execution input/event 식별 및 전체 binding digest를 브라우저에서 다시 계산한다. 기록 시각은 동의 이상, 원래 기한 미만이어야 한다. 같은 native input을 가진 다른 전체 검토의 영수증도 완료로 수용하지 않는다. 이 검사는 출력 일관성이며 서버 전체 DB 감사, 출처/사용자 동의 인증, 현재 실행 권한을 대신하지 않는다. 승인 기록 완료와 실제 provider dispatch는 별개다.

## 3H3b2: 명시적 확인·독립된 복구 화면

`QualityProviderTransmissionCommandPanel`은 `QualityProviderReviewPanel`에서 선택한 후보/실행·검토 영역의 unmount와 독립되게 항상 유지한다. 검토 panel은 검증한 view와 선택 snapshot digest를 부모에 전달하고 부모는 현재 보이는 원래 실행과 일치할 때만 새 동의 form을 제공한다. 선택·재조회·부모 초기화·focus/pageshow·정책/예약/승인 key storage 이벤트는 오래된 검토와 동의를 무효화하며 늦은 조회 응답은 복구하지 않는다.

새 form은 후보/고정 모델/실행 번호·원래 예약 금액·기한·정확한 보관 안내와 근거 링크를 표시한다. 여섯 체크박스를 직접 모두 선택하고 검토 조건/기한이 유효해야 `선택 실행 전송 승인 저장`을 누를 수 있다. 승인 기록 저장과 실제 provider 호출 미연결을 구분한다. 새 요청은 승인 전용 outbox의 `begin`을 통해서만 보관·전송하고 부모의 선택/다른 쓰기와 작업 중 상호 배제한다.

원래 보관 요청은 후보/등록본을 열지 않아도 다시 나타나며 조회·동일 요청 복구·원래 전체 요청/결과 JSON 다운로드를 제공한다. 다운로드 직전 보관 자료를 다시 검증한다. pending에는 닫기/새 nonce 교체 기능이 없고 terminal만 로컬 표시를 닫을 수 있다. 서버 승인/예약은 닫기로 취소하지 않는다. 다른 탭의 terminal 결과도 다시 읽어 동기화한다. 완료/첫 거절/결과 닫기에서는 부모의 오래된 조회와 선택 기록을 무효화하고, `검토안·이력 보기`에서 현재 r1 승인 이력을 다시 확인한다. 자동 provider 재전송은 없다.

## 다음 4A6a

4A1 첫 생성 전송 계획, 4A2 원자적 저장·신규 실행 소유권·모의 transport, 4A3 별도 응답 원문 보존·usage/비용 정산, 4A4a 생성 도메인 검증·파생 review 계획/DB 읽기, 4A4b1 검증 r5의 원자적 저장·원래 요청 복구와 4A4b2a 종료·review 보류액 해제의 순수 계획/DB 읽기를 연결했다. 상세 계약은 `PROVIDER_GENERATION_DISPATCH.md`를 따른다. 4A4b2b 종료·review 해제의 원자적 저장/복구와 응답/검증 경쟁까지 연결했다. 4A5a 유효 generation r5에서 review 준비·전송으로 이어지는 순수 계획/DB 읽기도 연결했다. 보관된 validated artifact와 고정 template, 현재 정책/설정/누적 예산과 원래 기한, generation 정산과 남은 review 예약액을 재검사한다. r6/r7·artifact/receipt는 무변경 계획으로만 반환하고 전체 v9·원래 저장 예약·공유 256MiB를 다시 감사한다. 4A5b는 이 다섯 행의 원자적 저장·정확한 원래 요청 복구·새 소유권/모의 전송을 연결했다. 같은 BEGIN IMMEDIATE의 새 커밋을 직접 관측한 호출만 최종 현재성 검사 뒤 모의 전송을 시작하고, 과거 조회/불확실한 커밋/종료 상태는 소유권을 만들지 않는다. 다음 4A6a는 review 응답 보존·비용 평가의 순수 계획/DB 읽기이며 정상 r8와 종료 뒤 late r9 응답을 구분하고 원래 usage/금융 근거로 알려진 비용과 미확인 보류를 보존한다. 종료 writer는 synthetic-enabled 저장소에 한정되며 generation 보류액과 기존 인식 비용을 보존하고 미전송 review만 해제한다. 원래 요청 replay는 늦은 응답 뒤에도 종료 당시 기록만 복구해 중복 해제를 막는다. 내부 검증 오류·contract 변경·보관 손상을 출력 불량으로 종료하지 않는다. 이후 별도 단위로 review 준비·전송·응답을 연결한다. r5 저장은 별도 synthetic-enabled writer만 수행하며 r6나 전송 권한은 만들지 않는다. 실제 adapter/SDK·HTTP/UI에는 아직 연결하지 않았으며 합성 시험을 실제 AI 완료로 취급하지 않는다. 일반 native production gate/false 권한과 원래 승인 범위를 유지한다.

## 2026-09-28 09:27 KST 실행 검증

- 실제 세션 `2026-09-28T00:12:19.045Z`의 model·effort 및 collaboration 설정 모두 Astra/Ultra를 확인했다. 3H1의 순수 신규 승인 계획과 명령/결합 형식을 구현했고 운영 저장소에는 연결하지 않았다.
- 관련 **6파일 273개 시험 통과**: 새 계획 61개와 기존 전송 검토·예약 계획/결합·native 실행·usage 212개다. 원래 자료 무변경·결정성·명시적 시각·native r1 호환, 가용액 0의 기예약 승인, 기한 보존, 엄격한 동의/선택/기준, 공유 nonce·정책/취소/이미 승인된 실행·변조/누락 archive·256MiB 정확한 경계를 확인했다.
- 두 유효한 서로 다른 검토가 동일한 native input digest를 만드는 사례를 구성해 command/record digest가 서로 달라짐을 확인했다. 동일 nonce는 만료/설정 누락 뒤에도 재계획하지 않는다. 역사적 저장 결과 복구는 아직 구현하지 않았으며 native 영수증만을 근거로 복구하지 않는다.
- 최초 시험의 production `actualAiCalls` 기대값 0을 기존 계약의 null로 바로잡았다. dispatch/response count 0과 외부 호출 금지는 유지했다. 최종 5파일 241개 및 usage 32개를 통과했고 재실행은 합산하지 않았다. lint·typecheck·Webpack 빌드·새 파일 Prettier 검사도 통과했다.
- 메모리 합성 입력만 사용했고 DB·provider/SDK import 및 fetch를 차단했다. 빌드는 시험 후 합성 키와 임시 자료 경로로 수행했다. 실제 자격 증명·사용자 데이터·기존 서버/변경은 보존했으며 실제 승인/예약/전송·유료 호출·고객 자료 전송은 수행하지 않았다. 새 DB/API/UI·브라우저·전체 저장소 시험과 커밋/푸시는 이번 단위에 포함하지 않았다.
- 다음은 3H2a 동결 보관 validator와 승인 이벤트 단위의 coverage 경계다. 이어지는 구조·저장 무결성 단위까지 실제 Ultra를 유지하고 해결 후 xhigh로 복귀한다. 자동 후속 실행은 유지한다.

## 2026-09-28 09:50 KST 실행 검증

- 실제 세션 `2026-09-28T00:29:19.286Z`의 model·effort와 collaboration 설정 모두 Astra/Ultra를 확인했다. 3H2a 동결 native reader·정적 schema·coverage 형식/검증·원시 행 decoder를 구현하고 신규 planner의 결합 검증에 연결했다. 운영 DB/API/UI에는 연결하지 않았다.
- 관련 **7파일 353개 시험 통과**: 새 보관 감사 80개와 기존 승인 계획·전송 검토·예약 계획/보관·native 실행·usage 273개다. 후속 영수증 순서/prefix 순서 검사를 보강한 뒤 새 80개를 재실행해 통과했으며 중복 합산하지 않았다. 변경 재해시·잘못된 동의/기준·정책/금융/manifest/보관 근거·누락/중복/색인/원시 크기·이전 경계와 과거 prefix를 검사했다.
- 이전에 예약만 된 run의 나중 승인과 이전 뒤 새 run 승인에서 결합 누락을 거절했다. 정확한 이전 승인만 예외로 보존하며, 만료/정책 교체·새 예약·prepared/dispatch·두 단계 예산 해제/종료 뒤에도 원래 결합을 읽었다. native Node 단독 실행과 fetch/벽시계 차단으로 application builder·현재 설정·외부 호출에 의존하지 않는 읽기를 확인했다.
- 최초 추가 시험은 테스트 configuration/registry 필드 참조를 바로잡고 통과했다. 최종 lint·typecheck·Webpack 빌드·소스/새 문서 Prettier 검사가 통과했다. lint는 이 PC의 pnpm 실행기로 최종 재검증했다. 직접 Node ESLint 실행은 외부 의존성의 Next parser 해석에 실패하므로 기존 실행기를 사용한다.
- 메모리 합성 입력과 빌드용 합성 키/임시 자료 경로만 사용했다. 실제 자료/키·기존 서버/변경, v8 DB·native 형식·synthetic gate를 보존했다. 실제 승인/예약/전송·과금·고객 자료 전송·기관 제출·커밋/푸시·새 채팅/하위 에이전트는 수행하지 않았다. 전체 저장소·DB migration/backup·브라우저 시험은 다음 단위다.
- 다음은 3H2b DB v9 이전·전체 읽기 감사·백업/복원이다. 구조·저장 무결성 작업까지 실제 Ultra와 자동 후속 실행을 유지한다.

## 2026-09-28 10:15 KST 실행 검증

- 실제 세션 `2026-09-28T00:51:19.597Z`의 model·effort 및 collaboration 설정 모두 Astra/Ultra였다. 3H2b v9 스키마/이전, 승인 원시 행 decoder, 앱/전체 DB 감사, raw 공유 용량, 백업/복원/CLI 연결을 구현했다. 기존 v1~v8 정의를 보존하고 앱의 현재 쓰기 계약을 v9로 바꿨다.
- 관련 **16파일 438개 시험을 최종 통과**했다. 핵심 6파일 173개와 추가 10파일 265개이며, 새 이전/보관/백업 시험 36개와 기존 회귀 402개다. v0~v8 이전/rollback·기존 바이트 보존·기존 승인 event prefix·누락 결합/coverage·재해시 변조·구버전 prepared INSERT/전체 writer 차단·불변 행·빈 v9 coverage 누락·raw 공백/정확한 용량 경계·만료 뒤 재개방·v8/v9 복원·변조 manifest/미완성 backup 차단을 검사했다.
- 최초 새 시험의 1건이 앱 용량 합산식에서 새 두 테이블의 누락을 발견해 수정했다. 추가 회귀 1건은 v8 구조 개수 64를 v9의 72개 객체로 갱신한 뒤 해당 15개 시험 모두 통과했다. 새 CLI 확인을 보강한 두 복원 시험도 재실행해 통과했다. 두 실행 모두 위 총계에 중복 합산하지 않았다. 중간 시험 helper의 잘못 삽입된 문장과 타입 오류도 바로잡았다.
- CLI는 지정 백업만 검증하고 새 결합/coverage 수를 반환하며 경로·합성 비밀값을 출력하거나 환경변수의 자료 폴더를 만들지 않았다. 기존 HTTP·정책/예약 쓰기·원장/이력·legacy native 실행 백업과 현재 구조를 사용하는 fixture를 v9에 맞춰 회귀 검증했다. 전체 저장소 시험/브라우저 시험은 수행하지 않았다.
- lint·typecheck·Prettier·scoped diff 검사에 통과했다. 시험 종료 후 합성 키와 임시 자료 경로로 Webpack 빌드까지 통과했다. 실제 사용자 DB에 이전 명령을 실행하거나 실제 승인/예약/전송·유료 호출·고객 자료 전송·기관 제출을 수행하지 않았다. 기존 키/자료/서버/변경을 보존하고 커밋/푸시·새 채팅/하위 에이전트는 만들지 않았다.
- 다음은 3H2c 승인 세 행의 원자적 저장·정확한 원래 명령 복구와 종료/동시성 시험이다. 실제 Ultra와 자동 후속 실행을 유지한다.

## 2026-09-28 10:36 KST 실행 검증

- 실제 세션 `2026-09-28T01:16:20.043Z`의 model·effort 및 collaboration 설정 모두 Astra/Ultra였다. 3H2c 서버 명령 저장소와 lookup/replay를 연결했다. HTTP/UI·adapter는 후속 단위다.
- 관련 **9파일 286개 시험 통과**: 신규 저장 32개/프로세스 경쟁·종료 12개, 기존 승인 이전/백업 36개·계획 61개·동결 보관 80개·검토 저장소 29개, 예약 저장 25개·예약 경쟁 6개·정책 경쟁 5개다. 최초 상태 기대값 수정과 추가 production gate 검사 재실행은 중복 계산하지 않았다. HTTP 서비스 시험은 잘못된 경로 패턴으로 선택되지 않았으며 총계에 포함하지 않았다.
- 세 INSERT별 예외 rollback·프로세스 강제 종료, 감사 후 COMMIT 전/후 종료, 동일/다른 명령과 정책/예약 경쟁, native input이 같은 두 유효 검토, 공유 nonce·다른 평가 기록 손상·승인 결합/coverage/스키마 손상, 현재 설정/시각을 읽지 않는 재개방/만료/백업 복구를 확인했다. 부모와 planner 양쪽에서 기존 승인 결합과 raw 공백을 포함한 정확한 용량 한계도 통과했다.
- 처음 잘못 기대한 native 상태 이름은 `approved`로 수정했다. production 종료 요청은 합성 실행 옵션으로도 거절되므로 그 제한을 검사하도록 테스트를 정리했다. production gate를 완화하지 않았다. lint·typecheck·Prettier·scoped diff 검사와 시험 후 합성 키/임시 자료 경로의 Webpack 빌드가 모두 통과했다.
- 실제 자료·키/기존 서버/변경·v9 계약을 보존했다. 실제 운영 승인/예약·provider 호출·과금·고객 전송·기관 제출, 전체 저장소/브라우저 시험·커밋/푸시·새 채팅/하위 에이전트는 수행하지 않았다. 다음 3H3a HTTP 경계는 같은 채팅의 지원되는 도구로 Astra/xhigh 후속 실행을 요청하고 실제 적용은 다음 세션에서 확인한다.
- 같은 채팅의 `model: gpt-6-astra`, `thinking: xhigh` 후속 요청이 도구에서 오류 없이 접수됐다. 요청 뒤 조회한 최신 turn_context는 현재 턴의 Ultra이므로 xhigh가 이미 적용됐다고 보고하지 않으며 다음 실행에서 확인한다.

## 2026-09-28 10:52 KST 실행 검증

- 실제 세션 `2026-09-28T01:39:20.452Z`의 model·effort 및 collaboration 설정 모두 Astra/xhigh로 복귀했음을 확인했다. 별도 승인/원래 요청 조회 HTTP API를 구현하고 기존 전송 검토 경계와 화면을 보존했다.
- **5파일 245개 시험 통과**: 신규 HTTP 64개와 기존 예약 HTTP·전송 검토 HTTP·승인 저장·전송 UI 4파일 181개다. COMMIT 전/후 예외, 응답 생성/검증 실패, 원래 명령 replay와 2035년/설정 실패 후 조회, 다른 nonce/변조 run/event/input/record·잘못된 권한/flag, native input이 같은 다른 검토, 전체 손상과 내부 오류 비공개를 검증했다. 신규 61개에 추가 본문 경계 3개를 더했으며 재실행은 중복 계산하지 않았다.
- 실제 UTF-8 128KiB까지 허용하고 선언 길이가 작아도 한 바이트 초과는 저장소를 열기 전에 거절했다. 초과 분할 본문은 취소하며 유효한 다중 바이트 문자가 조각 경계에서 나뉘어도 승인된다. 모든 응답의 no-store/private·nosniff·no-referrer와 원래 nonce 복구 안내를 확인했다.
- lint·typecheck·Prettier와 시험 후 합성 키/임시 자료 경로의 Webpack 빌드가 통과했다. 빌드 결과에서 approvals/requests 경로와 기존 inspect를 확인했다. 실제 사용자 자료/키·운영 승인·유료 호출·고객 전송·기관 제출은 사용하지 않았고 기존 서버/변경·저장 계약/실행 gate를 보존했다. 전체 저장소·브라우저 시험, 커밋/푸시·새 채팅/하위 에이전트는 수행하지 않았다.
- 다음 3H3b 명시적 확인/승인 전용 journal·복구 UI를 같은 채팅에서 이어간다. 필요하면 outbox 계약/검증과 화면/브라우저 단위로 나누되 원래 명령 보존과 기존 두 outbox를 유지한다. 현재 xhigh와 자동 후속 실행을 유지하고 새 구조·동시성 난제는 실제 Ultra 전환을 확인해 처리한다.

## 2026-09-28 11:15 KST 실행 검증

- 실제 세션 `2026-09-28T01:54:20.714Z`의 model·effort 및 collaboration 설정 모두 Astra/xhigh를 확인했다. 기존 예약 outbox의 보관/잠금 순서를 재사용해 3H3b1 승인 전용 원래 요청 보관·복구 계약을 완료했다. 실제 확인/복구 화면과 브라우저 연결은 다음 3H3b2다.
- 관련 **5파일 261개 시험 최종 통과**: 신규 전송 outbox 76개, 기존 승인 HTTP 64개·전송 UI 45개·예약 outbox 40개·정책 outbox 36개다. 초기 신규 40개와 확장 76개 재실행은 중복 집계하지 않았다. 기존 정책 outbox 두 실패는 합성 DB 연결의 writer가 v8인 원인을 확인해 v9로 수정하고 해당 36개를 다시 통과했다. 앱의 기존 정책/예약 outbox 구현과 쓰기 gate는 변경하지 않았다.
- 원래 전체 요청을 보관/재확인한 뒤 전송, 여섯 확인/선택/기한 검사, 실제 COMMIT 전/후 오류와 DB 재개방·2035년/현재 설정 실패 후 복구, 만료한 미관측 요청의 보존, 저장 실패·두 탭/중복 클릭·결과 보관까지 잠금·다른 journal 보존·늦은 응답/다른 저장 값 보호를 검증했다.
- HTTP 상태/엄격한 응답/UTF-8/선언·실제 크기/기한과 nonce·전체 command/review/run/native input/event/전체 binding 식별·false 권한을 검사했다. 서로 다른 유효 검토가 같은 native input을 갖고 요약 식별값까지 바꿔 반환된 경우도 잘못 완료 처리하지 않았다. 보관 자료를 다시 해시해도 내부 결합이 맞지 않으면 네트워크/덮어쓰기 없이 거절했다. 합성 승인 뒤 예산 무변경·r1 approved·dispatch/response count 0을 확인했다.
- lint·typecheck·새 소스/변경 시험/승인 문서 Prettier가 통과했고 모든 시험 종료 후 합성 키·임시 자료 경로의 Webpack 빌드가 통과했다. 확장 시험 중 이벤트 payload union 타입을 명시적으로 좁혀 타입 검사를 통과했다. 문서 갱신 스크립트의 단일 배열 처리로 두 문서에 잘못 적용된 문자 치환은 이전 기록의 정확한 원문 행과 대조해 복원했고, 나머지 세 문단도 원문을 대조해 복구/후속 포인터를 갱신했다. 복원용 임시 스크립트는 제거했다.
- 모든 DB 쓰기는 임시 합성 자료였고 외부 fetch/SDK·사용자 회사 DB 접근은 시험에서 금지했다. 실제 자료/키·운영 승인/예약·유료 호출·고객 전송·기관 제출을 사용하지 않았다. 실제 브라우저/전체 저장소 시험, 커밋/푸시·새 채팅/하위 에이전트는 수행하지 않았다. 기존 서버/변경을 보존했으며 `.env.local` Git 제외를 확인했다.
- 다음은 새 outbox를 사용하는 3H3b2 명시적 확인/선택과 독립된 복구 화면·다운로드·현재 이력 갱신 및 합성 브라우저 검증이다. 실제 Astra/xhigh와 자동 후속 실행은 유지한다.

## 2026-09-28 11:40 KST 실행 검증

- 실제 세션 `2026-09-28T02:17:21.184Z`의 model·effort 및 collaboration 설정 모두 Astra/xhigh를 확인했다. 3H3b2 여섯 명시적 확인·선택과 독립된 전송 승인 복구 화면을 완료했다. 기존 승인 outbox/서버/저장 계약은 변경하지 않았다.
- 관련 **4파일 180개 시험 통과**: 전송 UI 49개, 부모 검토 화면 16개, 예약 UI 39개, 전송 outbox 76개다. lint·typecheck·변경 소스 Prettier가 통과했고 시험 종료 후 합성 키와 임시 자료 경로의 Webpack 빌드가 통과했다.
- 실제 headless Edge에서 **13개 합성 시나리오를 최종 통과**했다. 정확한 보관 안내/초기 미동의·데스크톱/모바일 표시, 재조회/선택/창 복귀/storage 변경에 따른 동의 초기화, 만료·늦은 조회 응답, 최초 보관 실패, 새로고침/등록본 없이 원래 요청 복구, 만료 후 거절에도 pending 유지, COMMIT 후 응답 유실, 늦은 승인 응답과 결과 보관 실패, 두 탭 잠금/결과 동기화, 원래 JSON·현재 r1 이력·결과 닫기를 확인했다.
- 브라우저 스크립트의 중단 요청 응답 완료 전 interceptor 해제와 접힌 이력 영역의 가시성 대기를 바로잡은 뒤 전체 13개를 재실행해 통과했다. 앱 소스의 추가 수정은 없었다. 보고서는 `.venturepass-tools/transmission-command-ui-smoke-20260928.json`이며 두 화면 캡처도 확인했다. 동일 명령 복구 POST 3회에서 승인 결합/event는 각 1개, 고유 명령은 1개였다. 예산과 정책/예약 journal은 보존됐고 dispatch는 0이었다.
- 완료/첫 거절/결과 닫기 뒤 과거 조회와 선택을 무효화하며 `검토안·이력 보기`로 현재 r1 이력을 다시 연다. 복구 영역은 선택 영역을 닫거나 등록본을 열지 않은 상태에서도 유지된다. 원래 요청/결과 다운로드는 보관 자료를 다시 읽고 검증한다.
- 합성 임시 DB·합성 키·외부 요청 차단 브라우저만 사용했으며 유료 호출 0회, 실제 고객 자료 미사용이다. 이번 검증용 서버는 종료했고 기존 서버/자료/키/사용자 변경은 보존했다. `.env.local` Git 제외를 확인했다. 전체 저장소 시험·실제 운영 승인/예약/전송·기관 제출·커밋/푸시·새 채팅/하위 에이전트는 수행하지 않았다.
- 3단계 구현·합성 검증을 마쳤다. 다음 4A는 이미 저장된 r1 승인에서 서버 고정 adapter 실행으로 이어지는 계약·순수 계획·모의 transport다. 기존 synthetic runner를 그대로 재사용하거나 false 권한/gate를 해제하지 않는다. 구조·동시성 단위이므로 같은 채팅에 Astra/Ultra 후속 실행을 요청하고 실제 적용은 다음 실행에서 확인한다. 자동 후속 실행은 유지한다.
- 같은 채팅의 `model: gpt-6-astra`, `thinking: ultra` 후속 실행 요청이 도구에서 오류 없이 접수됐다. 요청 접수와 실행 설정 적용은 구분하며, 실제 Ultra 적용은 다음 turn_context에서 확인한다.
