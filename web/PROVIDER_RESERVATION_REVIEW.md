# 채택 정책에 연결한 후보 예약 검토

2026-09-28. 3E1 순수 예약 검토 계약, 3E2 검증된 DB 읽기 연결, 3E3a 읽기 전용 HTTP API, 3E3b 검토 화면·재조회·다운로드를 구현했다. 이후 별도 예약 명령·저장·쓰기 HTTP API와 여섯 항목의 명시적 확인·원래 명령 보존/복구 화면을 연결했으며 [PROVIDER_RESERVATION_COMMAND.md](PROVIDER_RESERVATION_COMMAND.md)에 기록한다. 이 검토의 조회 자체는 예약·전송을 실행하지 않고 검토 계약의 실행 권한은 false다. 별도 전송 승인과 provider transport는 아직 연결하지 않았다.

## 입력과 신뢰 범위

입력은 등록본 버전·digest·후보 선택, 검사 시각, 서버 공식 configuration 및 전체 비용/정책 원장의 한 스냅샷이다. `inspectQualityLedgers()`를 재사용해 정책 체인, provider/legacy 실행·예산·영수증·원문 참조, 작업 nonce 충돌과 공유 저장/슬롯 한도를 검사한다. 선택한 등록본도 내용 digest까지 검사한다. 미래에 기록된 원장이 있거나 근거가 손상됐으면 검토를 반환하지 않는다.

순수 함수의 배열·checksum 검사는 자료의 출처나 실제 COMMIT을 인증하지 않는다. 3E2 저장소 연결은 같은 읽기 트랜잭션에서 `inspectQualityDatabase()`로 schema·평가·등록 영수증과 SQL 원본까지 검사하고, 그 DB의 기록만 전달한다. configuration·원장·채택 기록을 클라이언트 본문에서 받으면 안 된다. 메모리에서 준비한 채택 계획을 순수 함수에 넣어 통과한 합성 시험은 실제 채택 완료의 증거가 아니다.

## 검증된 DB 읽기 연결

`PlanQualityStore.providerReservationReview(selection)`은 엄격한 후보 선택 스키마를 먼저 검사한 뒤 부모의 읽기 트랜잭션 하나를 사용한다. 서버 전용 저장소는 전체 DB 검사, 선택 등록본, 전체 원시 원장, 서버 공식 configuration, 현재 검사 시각과 순수 검토 결과를 이 트랜잭션 안에서 구성한다. configuration을 요청 인자로 받지 않으며 쓰기 플래그·transport를 노출하지 않는다.

공용 `readLedgerDatabaseInput()`은 기존 행 디코더를 분리한 함수다. schema·행 digest·컬럼·원문 바이트를 검사하지만, 반환값 자체는 전체 원장 검증 결과가 아니다. 소비자는 같은 트랜잭션에서 `inspectQualityLedgers()`와 필요한 전체 DB 검사를 완료해야 한다. 기존 `inspectLedgerDatabase()`도 이 디코더와 전체 원장 검증을 함께 사용한다. legacy/provider 실행의 `rowid` 삽입 순서를 보존하며 영수증·원문·다른 nonce·등록본 배열의 순서는 고정한다. 실행/정책에서 아직 참조하지 않은 선택 등록본도 함께 읽는다.

입력에 configuration·ledger·policy 등 추가 필드가 있으면 DB 조회 전에 400으로 거절한다. 없는 등록본은 기존 후보 404이며 존재하는 등록본과 맞지 않는 digest/후보는 순수 계약의 `selection-invalid`다. DB 전체 검사나 원장 검증에 실패하면 검토 결과를 반환하지 않는다. 새 저장소의 손상 오류는 409 `QUALITY_PROVIDER_RESERVATION_STORAGE_CORRUPT`이고 부모의 선행 검사에서는 기존 저장/원장 오류가 반환될 수 있다. 트랜잭션의 COMMIT/ROLLBACK은 부모가 소유하며 configuration 조회 예외도 읽기를 종료한다.

임시 DB에서 조회 성공·실패 전후 schema와 전체 품질 테이블 행 digest가 같음을 검증했다. 현재 DELETE journal 방식에서 읽는 동안 다른 연결의 쓰기 예약은 가능하지만 COMMIT은 잠금으로 거절되고, 읽기 종료 뒤 기록한 예산은 다음 조회에서 보인다. 이 검증은 읽기 스냅샷 일관성의 근거이며 이후 예약 쓰기의 원자성·다중 프로세스 경쟁을 대신하지 않는다.

## 채택 기록 식별

- 선택한 **등록본 버전과 후보 ID**에 해당하는 가장 최근 정책 기록을 식별한다. 최신 기록이 현재 조건과 다르면 더 오래된 일치 기록으로 되돌아가지 않는다.
- 다른 후보의 정책 채택은 선택한 후보의 채택을 대신하지 않는다. 다른 후보가 전체 정책 head를 변경해도 해당 후보의 기존 채택 참조를 유지할 수 있다. 검토 결과에는 선택된 기록의 revision/digest/nonce와 전체 정책 head를 별도로 담는다.
- 공식 근거의 현재 유효성을 현재 검사 시각으로 확인한다. 이어서 현재 서버 코드·configuration으로 **원래 채택 검토 시각**의 제안 전체를 재구성하고 보관된 제안 digest와 비교한다. 금융 산정 시각에 따라 달라지는 financialBasis/usagePolicy digest를 잘못 비교하지 않으면서 후보·정확한 요청·모델·단가·보관·사용량 조건의 변경을 검출한다.
- 채택 승인에 사용된 검토의 15분 기한은 소비된 승인 요청의 기한이다. 이것만으로 이미 채택한 정책을 15분 뒤 만료시키지 않는다. 현재 공식 근거가 만료되면 새 예약 검토가 불가능하며, 현재 configuration이나 요청이 달라지면 재채택이 필요하다. 새로운 예약 검토 자체는 별도의 최대 15분 기한과 공식 근거의 더 이른 만료 시각을 적용한다.

## 현재 예산과 실행 상태

기존 정책 검토 함수를 사용해 **현재 production 예산**의 revision/head, 한도, 인정 사용액, 미정산 예약액과 가용액을 계산한다. 채택 당시 예산 스냅샷이나 제안 한도를 현재 잔액으로 대체하지 않는다. 미설정·부족액·통화/단위 불일치·한도 위반은 각각 차단 사유다.

production의 같은 후보가 미정산이면 등록본 버전이 달라져도 차단한다. 기존 provider snapshot의 `reserved` 상태 및 `eligibleForNewCandidateRun` 판정을 재사용한다. 검증된 전송 전 취소는 예약액과 후보 차단을 해제한다. 다른 후보의 예약도 가용액에서 차감하며, synthetic-test 예약은 production 예산/후보 차단과 분리한다. 전체 legacy/provider 실행 수의 공유 20건 한도를 확인한다.

`assessment.state`는 `conditions-met` 또는 `blocked`이며 복수 사유를 보존한다. `conditions-met`는 이 단계의 정책·예산·후보 조건이 맞는다는 의미다. 새 예약의 저장 용량·후속 슬롯 확보, 실제 계정 접근 권한, 토큰 적합성이나 전송 가능성을 확정하지 않는다. `reservationAllowed`, `dispatchAllowed`, `budgetWriteAllowed`는 항상 false이고 다음 단계는 `separate-reservation-command-required`다.

## 재검증

reviewDigest는 현재 정책 검토, 선택한 채택 참조, 전체 정책 head, 실행 수·미정산 후보 목록과 전체 입력 원장 digest를 결합한다. `isProviderReservationReviewCurrent()`는 검토 기한과 형식을 확인하고 최신 서버 입력을 원래 검사 시각으로 재구성해 일치 여부를 확인한다. 관련 없는 원장 작업이 추가돼도 전체 원장 digest가 달라지므로 이전 검토는 무효다. 입력 순서를 포함한 동일한 서버 스냅샷이 필요하다.

이 함수의 true는 차단된 검토에도 반환될 수 있는 **현재 근거와의 일치 여부**다. 예약 승인이나 예약 실행 권한이 아니다. 향후 쓰기 계획기는 최신 근거 재검증뿐 아니라 `conditions-met`, 명시적 예약 확인, 저장 용량·예약 슬롯, 원자성·CAS·동일 nonce 복구를 각각 검사해야 한다. 조회 결과를 받은 뒤 쓰기까지 상태가 유지됐다고 가정하지 않는다.

## 읽기 전용 HTTP API

`POST /api/studio/quality/provider-reservation/inspect`는 dynamic Node 경로다. JSON 본문은 기존 엄격한 선택 계약인 `version`, `versionDigest`, `candidateId`만 받는다. 서버 메서드를 한 번 호출하며 HTTP 계층에서 후보·정책 head·예산을 따로 읽지 않는다. 기존 v1~v5 정책 조회 응답은 변경하지 않는다.

공용 로컬 요청 검사로 origin/host/포트·전달 host·fetch-site를 확인하고 query를 거절한다. JSON content-type, 선언/실제 4096바이트 상한, 엄격한 UTF-8·JSON·선택 스키마를 저장소 접근 전에 검사한다. 서비스의 비지원 메서드는 405와 `Allow: POST`를 반환하며 실제 route는 POST만 내보내므로 Next도 다른 메서드를 차단한다. 응답은 `no-store, private, max-age=0`, `nosniff`, `no-referrer`를 적용한다.

브라우저 안전 응답 계약 `providerReservationInspectionResponseSchema`는 `responseVersion: 1`, 원래 `selection`, `status`와 `review`를 결합한다. 정상 검토의 내부 scope가 선택과 같아야 하고 권한 필드는 false만 허용한다. 이 스키마 검사는 checksum/최신성 검사를 대신하지 않으며 화면 연결 단계에서 review와 중첩 policyReview의 digest도 검증해야 한다.

| 결과                                     | HTTP | 응답                                                                |
| ---------------------------------------- | ---- | ------------------------------------------------------------------- |
| 조건 충족 또는 미채택·예산 부족 등 차단  | 200  | `status: review`, 검토와 복수 차단 사유                             |
| 공식 설정 누락/무효 또는 만료            | 200  | `status: unavailable`, 해당 reason, `review: null`                  |
| 등록본 digest/후보 불일치                | 409  | `selection-invalid`, `review: null`                                 |
| 현재 검사 시각보다 미래인 원장           | 409  | `ledger-after-inspection`, `review: null`                           |
| 선택한 등록본 버전 없음                  | 404  | 기존 후보 오류, 검토 없음                                           |
| 전체 저장 검사 실패                      | 409  | 저장소 오류, 검토 없음                                              |
| 예상하지 못한 서버/응답 검증/직렬화 오류 | 500  | `PROVIDER_RESERVATION_REVIEW_UNAVAILABLE`, 내부 내용 없이 일반 안내 |

입력 오류는 기존 400/403/405/413/415 오류 형식을 따른다. 내부 TypeError·SyntaxError·ZodError를 입력 잘못으로 취급하지 않는다. 조회 응답은 예약·전송 권한을 부여하지 않으며 이전에 받은 검토를 실패 뒤 최신 결과로 사용하면 안 된다.

## 검토 화면과 보관본

`quality-provider-reservation-ui.ts`는 후보 등록본과 전체 scope, 외부 reviewDigest와 중첩 policyReview digest, false 권한과 기한을 확인한다. 200 review/설정 unavailable, 409 선택·시각 unavailable을 HTTP 상태와 함께 검증하며 128KiB 본문 상한·엄격한 UTF-8·JSON을 적용한다. 예산 산식과 차단 사유는 공용 스키마 검증을 재사용한다. checksum은 출처 인증이나 실행 승인이 아니다.

`quality-provider-reservation-panel.tsx`는 선택한 후보의 채택 참조, 전체 정책 기록 수, 현재 누적 한도·사용액·예약액·가용액, 추가 예약 계산액, 전역/production/미정산 실행 수, 조회 시각과 재확인 기한을 표시한다. 조건 충족도 별도 예약이 필요하다는 안내이며 미설정·미채택·복수 차단과 unavailable을 구분한다. 현재 금액을 제안 예산으로 대체하지 않는다.

선택·정책 채택 상태/결과·부모 검토 재조회/닫기는 새 panel을 구성해 이전 결과를 버린다. storage·focus·pageshow 이벤트도 결과를 무효화하고 진행 중인 읽기를 취소한다. 요청 번호와 mounted 확인으로 늦은 결과·다운로드를 차단하며 30초 읽기 시간 제한과 busy 해제를 적용한다. 기존 정책 채택 outbox의 명령 보관·복구는 유지한다. 새 예약 검토는 로컬 storage에 저장하지 않는다.

새 조회 시작과 실패 때는 이전 결과·다운로드를 제거한다. 기한이 경과한 화면은 다시 조회 필요로 바뀌고, JSON 내려받기는 기한을 포함한 원래 검증된 응답 전체를 보관한다. 기한이 지난 보관본도 재검증 후 내려받을 수 있으나 새로운 유효 검토로 취급하지 않는다. 서버 변경을 모두 실시간 관측하는 화면은 아니므로 모든 결과는 조회 시점 기준이며 향후 예약 명령은 서버에서 다시 검증해야 한다.

## 다음 단계

3F1의 별도 명시적 예약 명령·서버 재구성·정책/예산 CAS·native 쓰기 계획, 3F2a의 동결 결합 보관 검증·명시적 이전 경계/필수 결합 감사, 3F2b의 DB v8 이전·전체 저장 검사·백업, 3F2c의 원자적 예약 저장·동일 명령 복구·경쟁 시험, 3F3a의 예약 HTTP API·원래 요청 조회와 3F3b의 별도 확인·브라우저 명령 보존/복구 화면을 구현했다. [PROVIDER_RESERVATION_COMMAND.md](PROVIDER_RESERVATION_COMMAND.md)에 계약과 검증 결과 및 다음 3G1 전송 승인 검토를 기록한다. 기존 v2 기록을 유지하고 검증된 v1 결합 record를 따로 저장하며, coverage 이후 새 production 실행은 결합이 필수다. 기존 `ProviderLedgerStore.enabled()`의 synthetic 제한과 보관된 false 권한을 유지한다.

## 2026-09-28 04:21 KST 실행 검증

- 실제 세션 및 collaboration 설정이 `gpt-6-astra` / `xhigh`임을 확인했다. 이전 Ultra 작업 후 복귀 요청의 실제 적용을 확인한 실행이다.
- 신규 순수 계약 **38개**를 포함해 관련 **6파일 213개 테스트 통과**. 새 시험은 채택된 정책과 현행 요청/설정 불일치, 최신 기록의 우선순위, 이전 승인 기한과 새 검토 기한의 구분, 현재 예약액·취소 근거·후보 미정산·합성 환경 분리·공유 20건 한도, 손상/nonce 충돌·미래 시각, 변조/기한/원장 변경 후 재검증을 다룬다. 기존 정책 검토 34개, 채택 55개, 보관 검사 40개, 공식 설정 34개, provider 저장 통합 12개도 포함한다.
- 최초 합성 자료의 두 번째 채택 시각이 초기 예산보다 앞선 문제와 준비안 기한이 공식 근거보다 긴 문제를 수정했다. nullable configuration에 대한 테스트 자료 단언도 보완했다. 앱의 검증 규칙은 완화하지 않았다.
- 최종 typecheck·lint·Webpack 빌드·신규 소스 Prettier가 통과했다. 신규 로직은 메모리 합성 원장으로 검증했고 기존 저장 회귀는 임시 DB를 사용했다. 네트워크·실제 자격 증명/자료 경로 접근을 차단했다. 실제 운영 예약·유료 호출·고객 전송은 실행하지 않았다.
- 이번 단위는 순수 계약까지다. 실제 DB에서 새 검토 함수를 호출하는 경로, 새 API·화면·브라우저 검증, 신규 예약 쓰기/동시성/복구와 전체 저장소 테스트는 수행하지 않았다. 기존 데이터·키·사용자 변경을 보존했다.

## 2026-09-28 04:38 KST 실행 검증

- 실제 모델·추론 및 collaboration 설정은 `gpt-6-astra` / `xhigh`였다. 3E2 DB 읽기 연결을 완료했으며 새 예약 검토 HTTP API와 화면은 다음 3E3a/3E3b다.
- 신규 저장 통합 22개를 포함한 관련 **8파일 171개 테스트 통과**. 기존 7파일 149개와 수정 후 새 1파일 22개이며 중복 합산하지 않았다. 최초 추가 등록본 시험의 중복 합성 원본을 후속 원본으로 바꿨고 앱의 중복 검사 규칙은 유지했다.
- 임시 DB의 schema와 품질 테이블 전체 행 불변, 기본 환경/재시작의 현재 예산·채택 참조, 참조되지 않은 등록본, legacy/provider 삽입 순서, 독립 합성 예약, 변경/만료/누락 configuration과 손상 자료 거절을 검증했다. 다른 연결의 COMMIT 차단 및 읽기 종료 뒤 새 예산 관측, 예외 후 ROLLBACK도 확인했다.
- 최종 lint·typecheck·Webpack 빌드·변경 소스 Prettier·추적 소스 diff 공백 검사 통과. 모든 시험 자료는 합성 입력과 임시 DB였으며 fetch·OpenAI SDK·회사 저장소 접근을 차단했다. 빌드에는 명령 범위 합성 키와 임시 자료 경로를 사용했다.
- 실제 운영 예약·전송·유료 호출을 실행하지 않았다. 신규 HTTP/화면·브라우저 시험·전체 저장소 시험·production 예약 쓰기의 원자성/다중 프로세스 경쟁은 이번 단위의 범위 밖이다. 실제 키·사용자 자료와 기존 변경을 보존했고 커밋·푸시는 하지 않았다.

## 2026-09-28 04:55 KST 실행 검증

- 실제 세션 및 collaboration 설정 `gpt-6-astra` / `xhigh`에서 3E3a 읽기 전용 HTTP API를 완료했다. 서버 밖에서 원장을 조립하지 않고 단일 저장소 메서드 결과를 엄격한 응답 계약으로 반환한다.
- 신규 HTTP 경계 통합 **47개**와 기존 예약 순수 계약 38개·저장 통합 22개·정책 HTTP 32개·기존 조회 HTTP 52개, 총 **5파일 191개 테스트 통과**. 새 시험은 요청 차단 시 저장소 미접근, 단일 읽기 트랜잭션, 현재 예산/채택·재시작·다음 조회, 자료 손상, 설정 누락/만료·선택 불일치·미래 원장, 서버 오류 비노출·응답 scope/권한 불일치·직렬화 실패를 검증했다. 성공/실패 전후 schema와 전체 품질 테이블 행 digest는 유지됐다.
- lint·typecheck·Webpack 빌드·신규 소스 Prettier·공백/충돌 표시 검사 통과. 새 경로가 dynamic Node endpoint로 빌드됐으며 기존 정책 조회 endpoint를 유지했다.
- Request/Response route handler를 직접 호출하는 임시 SQLite 통합 시험이다. 별도 서버 HTTP·브라우저 화면·전체 저장소 시험은 미실행이며 다음 3E3b에서 실제 화면을 검증한다. fetch·OpenAI SDK·회사 저장소 접근을 차단했고 실제 운영 승인·예산/예약·유료 호출·고객 전송을 실행하지 않았다. 실제 키와 사용자 자료·기존 변경을 보존했으며 커밋·푸시는 하지 않았다.

## 2026-09-28 05:10 KST 실행 검증

- 실제 Astra/xhigh에서 3E3b 화면·재조회·검증된 다운로드를 완료했다. 신규 브라우저 검증/표시/transport 36개를 포함한 관련 **5파일 206개 테스트**, lint·typecheck·Webpack 빌드·Prettier·diff 공백·스크립트 문법 검사가 통과했다.
- 실제 Edge **8개 시나리오**에서 미채택/복수 차단, 명시적 합성 채택·조건 충족·현재 금액, JSON 전체 일치·재조회, 후보 전환·실패 후 초기화·복구, 설정/선택/시각 unavailable, 변조 응답 차단, 다른 탭의 실제 채택 중 지연 응답 폐기·로딩 해제, 기한 경과 표시를 검증했다. 최초 가상 시계를 타이머 이후 설치한 시험 문제를 고친 뒤 새 임시 DB에서 전체를 재실행했다.
- 데스크톱/390px 모바일 화면을 시각 확인했고 영역 넘침·브라우저 오류·외부 요청은 없었다. 조회 전후 행 digest가 같았고 합성 정책 2건·초기 예산 1건·예약/실행 0건이었다. `.venturepass-tools/reservation-ui-smoke-20260928.json`과 desktop/mobile PNG에 증거를 남겼다. 최종 테스트 서버 3101은 종료했고 사용자 3000 서버는 유지했다.
- 최초 테스트 fetch spy 집계와 lint ref 경고를 수정한 후 회귀가 통과했다. 실제 키·사용자 데이터·운영 예산·유료 호출·고객 전송을 다루지 않았고 전체 저장소 테스트는 수행하지 않았다. 다음 3F1의 정책 참조·동결 보관 계약·CAS/복구 설계를 위해 실제 Ultra 후속 설정을 확인하고 진행한다.
