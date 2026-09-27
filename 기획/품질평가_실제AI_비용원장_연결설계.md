# 품질평가 실제 AI 비용 원장 연결 설계

기준: 2026-09-27. A의 요청 원문·가격·토큰·예산 준비 조회 다음 B의 저장 계약과 구현 범위다. 합성 전용 원장·원문 보관·예약·조회 API·v4 백업을 구현했다. 실제 전송 0회, 운영 승인 0회이며 사용자 DB·키·운영 가격을 사용하지 않았다. 최종 시험 수치와 남은 연결은 개발현황·작업대장·VALIDATION.md의 최신 B 항목을 따른다.

현재 B는 단일 합성 예산의 최초 설정과 동일 요청 재현만 지원한다. 후속 예산 정책 변경, 청구 대조, 누락 사용량의 사후 정정은 미구현이다. 아래의 해당 확장 요구는 미래 계약이며 현재 지원 기능으로 해석하지 않는다. 원장 조회는 GET API이고 일반 사용자 화면에 새 메뉴를 추가하지 않았다. 다음 독립 구현은 `품질평가_원장엔진_연결설계.md`의 C1이다.

## 1. 이번 묶음의 경계

B는 **불변 실행 기록, 요청 원문, 비용과 저장 공간 예약, 조회 복구**를 합성 자료로 구현·검증한다. 제품의 실제 실행 시작 경로는 계속 차단한다. 공식 가격이 없어도 임시 DB에 합성 가격·토큰·공급자 어댑터를 주입해 원자성·상한·응답 유실을 시험할 수 있다. 합성 근거를 운영 가격이나 실제 관측 증빙으로 승격하지 않는다.

[승인 준비 설계](품질평가_실제AI_승인준비_개발설계.md)의 C에서만 실제 공급자 연결과 구체적인 사용자 승인을 연결한다. A의 `calculation-ready`, 준비안 조회, 후보 등록, 기존 회사 원고 작성 승인은 실제 전송 승인이 아니다. A의 `approvalRecorded:false`, `reservationRecorded:false`, `executionAllowed:false`를 보존한다. B는 새로운 실행 기록 형식을 사용하며 A 준비안을 수정해 승인됐다고 표시하지 않는다.

## 2. 확인한 현재 기반

| 영역            | 현재 코드와 보존할 계약                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 품질 저장소     | `web/src/lib/studio-plan-quality-store.ts`의 `PlanQualityStore`. `<data root>/quality-evaluation/quality.sqlite`; 회사 `studio.sqlite`와 원본을 열지 않는다.                                                                                            |
| 기존 8개 테이블 | 고정 50개 평가의 `quality_runs/revisions/requests`, 후보 등록의 `quality_candidate_versions/requests`, 모의 실행의 `quality_execution_runs/events/requests`. 각각 UPDATE/DELETE 금지 트리거, 총 16개다.                                                 |
| 트랜잭션        | 경로·파일 identity 확인 → 쓰기 `BEGIN IMMEDIATE` → 무결성/건수/용량 검사 → 변경 → 경로 재검사 → COMMIT. 실패는 ROLLBACK. `busy_timeout=5000`, `synchronous=FULL`, `journal_mode=DELETE`를 사용한다.                                                     |
| 현재 용량       | 모든 JSON body 합산 256MiB. 파일 및 백업 상한 264MiB. 평가 20묶음·묶음별 200개 기록, 후보 20버전, 모의 실행 20회·회당 7이벤트. 이 상한들을 늘리지 않는다.                                                                                               |
| 모의 실행       | start nonce/CAS와 최초 준비안·등록 후보 결합, dispatch/response/validated/finished 이력. `beforeRequest`는 호출 수가 아니다. 모의 계약의 `mode:mock`, 과금 0, 실제 가격 null은 그대로 둔다.                                                             |
| 요청 준비       | `studio-engine-request-preparation.ts`가 생성 요청 전체와 미완성 검토 템플릿을 반환한다. `requestDigest`는 SDK 요청 JSON의 canonical SHA, 별도 raw SHA는 저장 바이트의 SHA다. 검토에는 이번 실행의 검증된 최초 생성 원고만 들어간다.                    |
| A 비용 계산     | `studio-plan-quality-actual-preparation.ts`가 BigInt·요율별 올림으로 최대액을 계산한다. 가격·토큰·예산 근거가 없으면 차단한다. 계산은 예약이 아니다.                                                                                                    |
| 백업            | `scripts/local-data-quality.mjs`의 v1(3테이블), v2(5테이블), v3(8테이블). SQL·트리거·행 SHA·관계·nonce·논리 digest를 검사하며 SQLite backup snapshot을 보관한다. 안전한 임시 디렉터리 검증 후 rename으로 복원하고 기존 품질 디렉터리를 덮어쓰지 않는다. |

기존 `executionDownload`, 평가 다운로드, 후보 등록 다운로드의 형식과 기존 body는 B에서 변경하지 않는다. 새 저장 형식을 인식하지 못하는 구버전 도구는 거절해야 하며, actual 테이블을 제외한 부분 백업이나 v3로 내리는 경로를 만들지 않는다.

## 3. 최소 저장 구조: 5개 테이블 추가

동일 SQLite를 사용한다. 별도 파일로 예산을 분리하면 실행 시작·nonce·비용 예약을 한 트랜잭션으로 묶을 수 없으므로 B에서는 분리하지 않는다. 기존 8개와 합쳐 13개 테이블, UPDATE/DELETE 금지 트리거 26개와 아래 구버전 쓰기 차단 트리거 8개, 총 34개 트리거다.

```sql
CREATE TABLE quality_actual_budget_events (
  scope_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  PRIMARY KEY(scope_id,revision)
);
CREATE TABLE quality_actual_runs (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL
);
CREATE TABLE quality_actual_events (
  run_id TEXT NOT NULL REFERENCES quality_actual_runs(id),
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  PRIMARY KEY(run_id,revision)
);
CREATE TABLE quality_actual_artifacts (
  run_id TEXT NOT NULL REFERENCES quality_actual_runs(id),
  artifact_key TEXT NOT NULL,
  payload BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY(run_id,artifact_key)
);
CREATE TABLE quality_actual_requests (
  nonce TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL
);
```

각 테이블에 기존과 동일한 `<table>_no_update`, `<table>_no_delete` 트리거를 만든다. 새 테이블/트리거 생성은 한 트랜잭션으로 한다. 일부만 존재하거나 알려지지 않은 DDL·트리거가 있으면 보관·복원을 거절한다. CREATE IF NOT EXISTS만으로 다른 구조의 기존 테이블을 정상으로 간주하지 않는다.

**구버전 앱 쓰기 차단:** 현재 구버전 `PlanQualityStore`는 추가 actual 테이블을 모른 채 기존 8개만 합산할 수 있다. 백업 v4 거절만으로 이 쓰기를 막을 수 없다. 기존 8개 테이블에 `<table>_v4_writer` BEFORE INSERT 트리거를 추가한다. 새 앱은 해당 DB 연결에만 `quality_storage_contract()` 함수를 등록하여 `quality-v4`를 반환한다. 트리거는 `SELECT CASE WHEN quality_storage_contract() IS NOT 'quality-v4' THEN RAISE(ABORT,'unsupported writer') END;`를 실행한다. 구버전은 함수가 없어 INSERT가 실패한다. 이 gate는 버전 호환 방어이며 같은 PC에서 DB를 임의 편집할 권한이 있는 사람에 대한 인증 장치가 아니다. 읽기·백업은 함수를 등록하거나 쓰기를 허용할 필요가 없다. 시작 시 실제 34개 트리거를 모두 검사한다.

| 저장 행         | 필수 내용과 의미                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| budget event    | `scopeId/revision/previousDigest/eventId/kind/recordedAt/provenance/currency/unitScale/payload/eventDigest`. 최초 정책, 실행 총액 예약, 사용량 반영, 미사용 해제, 명시적 대조 결과를 각각 append한다. 현재 잔액 컬럼을 덮어쓰지 않는다.                                                                                                                           |
| run             | `schemaVersion:1`, 실행 ID, 시작 nonce/inputDigest, 정확한 A 준비안과 digest, 등록 버전·후보 결합, 명시 승인 계약, 예산 scope/head, 단계별 최대액, 기록 용량 예약, 출처, `archiveFormatVersion:1`, runDigest. 최초 승인과 이후 관측을 분리한다.                                                                                                                   |
| run event       | revision/previousEventDigest 및 단계별 `request-prepared`, `dispatch-intent`, `response-received`, `domain-validated`, `execution-stopped`, 후속 대조 기록. 관련 원문 artifact·예산 event digest를 참조한다. 시간 정렬 대신 revision/chain으로 순서를 결정한다.                                                                                                   |
| artifact        | 고정 키 `generation-request`, `generation-response`, `generation-validated`, `review-request`, `review-response`, `review-validated`, `final-result`. 본문 바이트, byteLength, raw SHA를 보관한다. 임의 파일 경로를 받지 않는다. 요청은 완전한 SDK body JSON, 응답은 `captureKind:sdk-response-json`으로 기록한다. HTTP 원시 바이트를 관측했다고 주장하지 않는다. |
| request receipt | `kind/clientRequestId/inputDigest/runId?/runRevision?/budgetRevision/operationDigest`. start 외의 내부 영속 훅도 일관된 operation nonce를 갖는다. 하나의 논리 작업에서 원문·event·예산 변경과 영수증을 함께 commit한다.                                                                                                                                           |

JSON body_hash는 기존 canonical JSON digest를 재사용한다. artifact의 raw SHA와 요청의 canonical requestDigest는 서로 대체하지 않는다. 허용된 key·크기·SHA·JSON 형식·단계 연결을 모두 확인한다. 요청·가격·토큰 원문은 보관하되 키, 인증 헤더, 전체 SDK client, 원시 예외 문자열은 보관하지 않는다.

## 4. 예산 의미와 동시 예약

초기 B는 한 품질 DB에서 `scopeId:candidate-quality-executions` 한 개의 누적 예산을 사용한다. 통화와 unitScale을 고정한다. 모델별·후보별 새 scope를 만들어 미확인 예약을 우회하지 못한다. 기간 경과나 새 준비안으로 예산을 자동 초기화하지 않는다. 통화 변경·여러 운영 예산은 이후 별도 설계 대상이다.

예산 원장에서 다음 값을 유도한다.

- `capUnits`: 명시적으로 설정한 누적 한도.
- `recognizedUsageUnits`: 고정 요율과 관측한 usage로 계산한 누적 금액. 공급자 청구 확정과는 다르다.
- `heldUnits`: 아직 미사용 또는 사용량 미확인인 예약액의 합계.
- `exposureUnits = recognizedUsageUnits + heldUnits`.
- `availableUnits = max(0, capUnits - exposureUnits)`. 초과가 확인되면 `deficitUnits`를 따로 보존하고 새 전송을 차단한다.

**A와의 연결 주의:** 현재 A에는 `capUnits/unsettledUnits`만 있다. 이미 정산한 금액을 빼지 않고 최초 한도를 다시 넣으면 비용이 반복 사용된다. 호환 adapter는 A의 `budget.capUnits = 원장 capUnits - recognizedUsageUnits`, `budget.unsettledUnits = heldUnits`, `ledgerDigest = 정확한 원장 head`를 제공한다. 이 값이 음수가 되면 A 준비를 차단한다. B 화면은 누적 한도·사용량 기반 금액·유지 예약·가용액을 전부 표시하고, A에 전달한 남은 한도를 최초 누적 예산이라고 표시하지 않는다. 이후 B 전용 계약에 네 값을 명시하는 것은 가능하나 A의 저장된 준비안을 재작성하지 않는다.

시작은 다음 한 트랜잭션으로 처리한다.

1. 네 종류 request 테이블 전체에서 nonce를 찾는다. 동일 kind·inputDigest의 기존 영수증이면 원래 기록을 반환한다. 다른 내용·다른 종류면 충돌이다.
2. 등록 원문·A 준비 digest·현재 엔진·모델·검토 파생 규칙·가격/토큰 근거의 유효성과 환경을 재검증한다. 시계 역행 시 과거 이력을 손상으로 처리하지 않되, 현재 근거 유효성을 입증하지 못하면 신규 전송을 막는다.
3. 전역 `expectedBudgetRevision/headDigest`와 `expectedActualRunCount`, 같은 후보의 미확정 이전 실행을 검사한다. 후보 새 버전도 동일 후보의 미확인 비용·실행을 우회할 수 없다.
4. 두 단계 최대액 합계와 기존 exposure가 누적 한도 이내인지 BigInt로 검사한다. 통화·unitScale·올림 방식은 모두 같아야 한다.
5. run, 생성 요청 artifact, 예산 `reserve-run` event, 시작 receipt, 기록 용량 예약을 함께 삽입한다. 완료 전에는 공급자 함수에 진입하지 않는다.

두 프로세스의 시작이 동시에 들어와도 `BEGIN IMMEDIATE` 안에서 최신 head를 확인한다. 첫 예약 후 두 번째는 CAS 또는 잔액 검사로 거절된다. DB lock/commit 오류는 자동 재전송 근거가 아니다. nonce 조회로 확인한다.

예약이 풀려도 원래 예약 event는 삭제하지 않는다. `release-unused`와 `recognize-usage`가 어느 실행·단계·예약 event를 소비하는지 고정한다. 예약 잔량을 초과하는 **예약 소비·해제**와 동일 예약 event의 중복 소비는 거절한다. 이 검사는 실제 관측한 비용의 전액 기록을 거절하는 조건이 아니다.

단계 예약 잔량을 R, 유효한 usage로 계산한 비용을 C라 하면 `consumedReservedUnits = min(R, C)`, `unusedReleasedUnits = max(R - C, 0)`, `boundExcessUnits = max(C - R, 0)`로 나눠 기록하고 recognizedUsage에는 C 전액을 더한다. 예를 들어 예약 10, 비용 12이면 예약은 10만 소비하고 recognizedUsage 12, 단계 상한 초과 2를 보존한다. 누적 예산도 10이고 다른 비용이 없다면 `deficitUnits`는 2다. 누적 가용액이 더 있더라도 단계 승인 상한 초과는 별도 위반으로 남고 신규 dispatch를 차단한다. 원문 응답·세 금액·초과 상태는 같은 트랜잭션에 기록하여 예약 산술 오류 때문에 초과 사용 사실이 유실되지 않도록 한다.

## 5. 실행 상태와 비용 상태는 별개

다음은 정상 흐름의 영속 순서다. 제품 C 연결 전까지 합성 어댑터로만 시험한다.

| 영속 전이                                         | 조건·같은 트랜잭션에서 기록할 내용                                                                                                      | 다음 호출                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 없음 → reserved                                   | 정확한 승인 + 생성 body + 두 단계 비용/공간 예약 + nonce 영수증. B 시험에서는 승인 출처가 synthetic-test다.                             | 아직 없음                       |
| reserved → generation request-prepared            | 생성 artifact raw SHA/canonical digest·전체 토큰 상한·현재 예산 head를 재대조한다. start에 보관한 원문을 교체하지 않는다.               | 아직 없음                       |
| request-prepared → dispatch-intent                | 현재 run revision·모델·원문·원가 상한 재검사 후 전송 의도 영속 기록.                                                                    | commit이 확인된 최초 작업만 1회 |
| dispatch-intent → response-received               | 응답 metadata와 제한된 SDK 응답 JSON artifact를 먼저 보관한다. 가능하면 같은 트랜잭션에 usage 기반 금액 및 미사용 차액 반영도 기록한다. | 아직 없음                       |
| response-received → generation domain-validated   | 구조 검증뿐 아니라 10개 항목·근거·금지 단정 등 기존 domain 검증을 통과한 최초 원고 artifact와 digest를 연결한다.                        | 검토 준비 가능                  |
| generation validated → review request-prepared    | 저장된 최초 원고/validation event를 검토 템플릿에 결합. 새 요청 전체를 보관하고 실제 토큰 상한·남은 단계 예약 이내인지 재검사한다.      | 아직 없음                       |
| review prepared → dispatch → response → validated | 생성과 동일한 순서. 검토 응답의 참조·항목 검사 후 저장한다.                                                                             | 최대 두 번째 호출까지만         |
| 검토 validated → stopped/completed                | 최종 후처리 원고·검토 결과 artifact를 보관하고 종료 event를 append한다. 사람 검토·품질 합격·기관 승인 상태는 바꾸지 않는다.             | 없음                            |

`dispatch-intent`는 실제 공급자 수신 완료 증거가 아니다. 그 직후 프로세스가 종료되면 `result-unobserved`이며 예약을 유지한다. 재시작 때 동일 원고를 다시 전송하지 않는다. 이전 과정이 살아 있을 수 있으므로 늦은 응답은 원래 run/phase/requestDigest/dispatch event에 맞는 경우에만 append한다. 다른 프로세스에 새 전송 권한을 넘겨주는 lease 재발급은 B에서 구현하지 않는다.

`actualRecordDispatch`의 반환 계약은 최초 commit이면 `{ receipt, newlyCommitted:true, replayed:false }`, 기존 동일 nonce/body의 재현이면 `{ receipt, newlyCommitted:false, replayed:true }`다. 해당 함수 호출에서 **새 commit을 직접 완료한 최초 caller**만 동일 body로 transport 1회를 수행할 수 있다. replay 응답이나 GET lookup으로 receipt를 얻은 caller의 transport 횟수는 0이다. `newlyCommitted`는 영수증의 영속 권한 필드가 아니라 이번 함수 호출의 결과다. 과거 영수증을 읽어 true로 복원하지 않는다. commit 결과를 caller가 확인하지 못하면 전송하지 않고 미확인 상태로 남긴다.

| 관측 상황                                      | 실행 상태                       | 비용 상태                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dispatch 이전 확정 실패                        | stopped-before-dispatch         | 미전송 단계 예약만 해제. 전송 의도 event가 없는 것을 CAS로 확인한다.                                                                                       |
| dispatch 뒤 응답 없음·저장 실패                | result-unobserved               | 해당 단계 최대액 유지. 오류가 곧 미과금이라는 가정 금지.                                                                                                   |
| 응답 있으나 usage 누락/불일치·모델 연결 불명확 | stopped-needs-cost-review       | 최대액 유지, 다음 단계 중단. 정상 출력만으로 비용 확정하지 않는다.                                                                                         |
| 유효한 usage·모델·가격 연결                    | 단계별 observed                 | 요율별 올림으로 recognizedUsage를 기록하고 승인 최대액의 남은 차액 해제. 할인은 적용하지 않고 확인된 추가 요금 상한을 포함한다. 공급자 청구 확정은 아니다. |
| 응답 구조/domain 검증 실패                     | stopped-output-invalid          | 이미 관측한 usage 및 예약은 유지. 미전송 검토 단계만 해제 가능하다.                                                                                        |
| usage가 승인 상한 초과                         | stopped-bound-breached          | 원문과 초과 사실을 보존하고 전체 신규 전송을 차단한다. 관측한 비용을 한도에 맞춰 자르거나 기록을 거절해 숨기지 않는다.                                     |
| 출력 완료지만 비용 미확정                      | content-complete/cost-unsettled | 두 상태를 함께 표시한다. 완료를 청구 확정이나 미확인 예약 해제로 사용하지 않는다.                                                                          |

독립적인 청구 대조는 이후 `reconciliation` event로만 추가한다. 원래 usage를 덮어쓰지 않는다. 공식 근거 없이 미확인 비용을 임의의 0원으로 해제하는 UI는 B에 없다. 출력 상태와 비용 상태가 모두 해결되기 전에는 같은 후보의 새 nonce 실행을 차단한다.

## 6. nonce, 내부 훅, 응답 유실

- 시작 요청 digest는 `{kind,clientRequestId,approvedPreparationDigest,approval,expectedBudgetRevision,expectedBudgetDigest,expectedActualRunCount}`의 canonical SHA다. 요청 ID만 같고 승인 범위가 달라지면 재사용하지 않는다.
- 내부 훅은 run 생성 때 준비한 단계별 operation UUID 또는 최초 호출에서 고정한 UUID를 사용한다. 동일 nonce/body는 현재 상태와 관계없이 원래 commit receipt를 재현한다. 같은 nonce로 다른 원문·사용량·event를 넣을 수 없다.
- 모든 새 nonce는 기존 평가·후보·mock·actual request 테이블과 양방향으로 충돌 검사한다. 기존 세 경로도 새 actual receipt를 조회해야 한다.
- `GET request/{nonce}`의 committed는 시작/기록 commit 확인이다. 실행 완료·응답 확인을 뜻하지 않는다. `not-observed`는 호출이 미처리인지 진행 중인지 확정하지 않는다.
- 자동 POST 재시도는 없다. 정확한 nonce 조회가 not-observed인 경우만 사용자가 같은 body/nonce로 명시적으로 재확인할 수 있다. committed 이후에는 snapshot 조회만 제공하고 runner를 다시 실행하지 않는다.
- 원문/예산 기록 함수는 commit receipt를 반환한다. 전송 함수는 dispatch 결과의 `newlyCommitted:true && replayed:false`를 먼저 확인하고, receipt의 requestDigest·원문 SHA·run revision과 메모리 body까지 대조한 뒤 1회만 전송한다. receipt 일치만으로 전송 권한을 부여하지 않는다. replay/lookup caller는 transport 0회다. DB guard/hook 예외를 공급자 오류로 바꾸거나 삼키지 않는다.

## 7. 요청 원문 경로와 C에 필요한 훅

입력 파일 경로는 받지 않는다. 원문은 같은 DB의 artifact BLOB이다. 향후 조회는 `/api/studio/quality/actual-executions/{id}/artifacts/{artifactKey}`처럼 실행과 고정 키를 사용한다. 응답은 원문 바이트와 SHA/길이/종류를 반환한다. 로컬 접근·Origin/CSRF·크기 검사·no-store 응답 정책을 기존 품질 API와 동일하게 적용한다.

generation은 A에서 확인한 완성 body와 byte-for-byte 일치해야 한다. review는 A에 존재하지 않던 완성 요청이다. 저장된 템플릿 + 같은 실행의 generation domain-validated artifact로 다시 만들고, 해당 검증 event digest를 `derivedFrom`으로 남긴다. 최종 의미 검토가 수정한 결과·자동 수정 원고·다른 실행 원고·추가 자료를 검토 입력에 넣지 않는다. 상한 초과를 해결하려고 조용히 절삭·요약·모델 전환하지 않는다.

현재 engine의 `onDispatch(request)`에는 body가 없고 `onResponse`에는 전체 응답 JSON이 없다. C는 키 없는 `onRequestPrepared({request,body})`와 구조 검증 이전 `onResponseReceived({metadata,capturedResponse})` 또는 동등한 adapter 계약을 추가해야 한다. 순서는 **원문/예약 commit → dispatch-intent commit → 단일 transport → 응답 원문/metadata commit → 구조/domain 검증 → 다음 단계**다. B는 이 계약의 가짜 emitter로 저장을 시험하며 기존 실제 엔진 호출을 하지 않는다.

본문이 보관 상한을 초과하거나 직렬화가 불가능하면 안전한 오류 코드와 응답 관측 여부만 기록하고 중단한다. 잘린 원문을 완전한 원문으로 표시하지 않는다. response raw 예외·인증 헤더를 로그나 archive로 내보내지 않는다.

## 8. 비용뿐 아니라 기록 용량도 예약

제안 상한은 actual 실행 20개, 실행 event 32개, 예산 event 1,000개, actual receipt 1,000개다. 하나의 누적 예산만 지원한다. JSON event 32KiB, receipt 4KiB, run 2MiB, 단계별 요청 2MiB·응답 8MiB·검증 결과 2MiB, 최종 결과 2MiB, artifact 키는 위의 7개로 제한한다. 실행당 예산 event 16개·receipt 64개까지 포함해 **시작당 32MiB를 논리 예약**한다. 실제 크기 산정 시험으로 이 예약이 모든 허용 레코드를 포함하는지 고정한다. 바이트뿐 아니라 남은 event·receipt 슬롯도 시작할 때 예약하여, 이후 정책 변경이나 다른 실행이 기록 개수 한도를 먼저 소진하지 못하게 한다. 한도를 넘는 추가 대조 절차가 필요하면 기존 이력을 삭제하지 않고 별도 확장 계약을 설계한다.

전체 256MiB 한도는 유지한다. 모든 기존 쓰기 경로도 `기존 실제 사용량 + actual 미사용 공간 예약 + 이번 증가량`을 검사해야 한다. actual 기록을 append할 때는 그 실행의 남은 공간 예약을 같은 트랜잭션에서 줄여 이중 계산을 피한다. unresolved 실행은 늦은 응답 보관 공간을 유지한다. 종료 후 더는 사용할 수 없는 공간만 해제한다. 20개는 개수 상한이며, 256MiB 안에 항상 20개를 보관할 수 있다는 약속이 아니다.

예상보다 큰 응답이나 실제 디스크 오류를 완전히 없앨 수는 없다. 이 경우 전송 intent와 비용 예약을 남겨 응답 미확인을 보존한다. 저장 실패 후 다음 호출 0회를 보장한다. 기존 물리 파일 264MiB 한도·SQLite 제한을 늘리지 않고 시험한다.

## 9. 백업 v4와 과거 바이트

`local-data-quality.mjs`에 v4를 추가한다. v4 manifest는 기존 건수에 `actualBudgetEvents/actualRuns/actualEvents/actualArtifacts/actualRequests`를 더한다. 13테이블/34트리거가 정확히 있는 경우만 v4다. 기존 v1/v2/v3의 검사·digest·출력 바이트는 변경하지 않는다.

검사는 각 JSON SHA, BLOB size/raw SHA, 연속 event chain, 등록 후보와 run, 승인과 요청 원문, 검토 파생 원고, dispatch/response/validated 순서, 예산 journal 산술·참조·중복 소비, 글로벌 nonce, 비용/공간 예약 불변식을 포함한다. 과거 기록을 현재 가격이나 프롬프트로 재계산해 거절하지 않는다. 보관 당시 schema/가격/계약 결합을 검사하고, 새로운 실행의 유효성은 별도로 판단한다.

현재의 SQLite snapshot·완료 marker·nativePaths/safePath·원본 identity 재검사·검증 후 rename 복원·기존 대상 거절을 유지한다. actual 테이블의 일부 제거, actual 표식이 남은 채 gate 제거, v4 manifest·schema·건수 불일치는 거절한다. 일반 회사 DB/원본 백업과 품질 백업을 혼동하지 않는다.

검증 한계도 명시한다. actual 5개 테이블과 gate 8개를 전부 제거하고 DB·manifest·완료 marker의 SHA까지 정상 legacy 형식으로 다시 구성하면, 외부의 신뢰 가능한 digest나 서명·이력 anchor가 없는 검사기는 원래부터 legacy였던 백업과 구별할 수 없다. B는 이 전체 삭제·재구성 위조를 탐지한다고 보장하지 않는다. 로컬 SHA와 관계 검사는 내부 일관성을 검사하며 작성자의 진정성이나 지워진 이력의 부재를 증명하지 않는다. 외부 신뢰 anchor를 도입하려면 보관·복구·권한을 별도로 설계해야 한다.

새 actual의 정확한 revision JSON은 `archiveFormatVersion:1` 전용 serializer로 저장 당시 raw run/event와 해당 revision에서 참조한 artifact/예산 event만 조합한다. 현재 시각·최신 예산 잔액·현재 revision·최신 평가 집계를 섞지 않는다. artifact 다운로드는 저장 bytes를 그대로 반환한다. 이후 새 event·후보 버전·가격 정책이 생겨도 과거 revision 다운로드 SHA가 동일해야 한다. 이 serializer를 변경해야 할 때는 새 formatVersion을 만들고 이전 구현을 유지한다.

## 10. 실제 가격 없이 검증할 구현 순서

1. 신규 `studio-plan-quality-actual-ledger-types.ts`와 순수 ledger reducer: 정책·run·event·원문 참조·예산/공간 산술 및 상태 유도. 숫자 대신 unsigned decimal string과 BigInt를 사용한다.
2. `PlanQualityStore`에 actual 5테이블과 메서드 추가: `actualBudgetGet`, 내부 `actualBudgetConfigure`, `actualStart`, `actualRecordPrepared`, `actualRecordDispatch`, `actualRecordResponse`, `actualRecordValidated`, `actualStop`, `actualLookup/Get/List/Download/Artifact`.
3. 실제 provider 함수를 import하지 않는 테스트용 emitter로 순서·실패·동시 예약을 시험한다. 임시 데이터 루트에서만 `environment:synthetic-test`, `executionKind:actual-ledger-simulation`, `approval.provenance:synthetic-test`, `observedTransport:synthetic-adapter`, `actualAiCalls:0`을 사용한다.
4. production 경로는 `PRICE_NOT_CONFIGURED`, `TOKEN_BOUND_NOT_CONFIGURED`, `BUDGET_NOT_CONFIGURED`와 `ACTUAL_EXECUTION_DISABLED`를 유지한다. 합성 근거를 HTTP payload로 받아 운영 상태를 만들지 않는다. B의 시험용 생성자/adapter는 제품 route에서 사용할 수 없도록 import 경계를 시험한다.
5. v4 backup/verify/restore와 합성 CLI 왕복을 구현한다. 기존 3/5/8테이블 기록 및 기존 다운로드 SHA를 함께 검증한 뒤 C로 이동한다.

대표 회귀는 다음과 같다.

- 같은 nonce/body의 응답 유실 재확인은 예약·전송 횟수가 늘지 않으며, 내용 변경·기존 세 종류 nonce 충돌은 모두 거절한다.
- 같은 dispatch nonce/body를 두 별도 프로세스에서 경합시켜 첫 commit caller만 `newlyCommitted:true`와 transport 1회를 얻고 다른 caller는 replay/transport 0회인지 확인한다. 같은 receipt를 GET으로 받은 세 번째 caller도 전송하지 않는다. 첫 caller가 commit 후 전송 전에 중단되면 다른 caller가 대신 전송하지 않고 미확인 예약을 유지한다.
- 두 별도 Node 프로세스가 한도 마지막 1단위를 동시에 예약해도 하나만 commit한다. CAS 재준비 후에도 잔액 초과는 거절한다.
- 저장 실패 지점별(원문/예약/dispatch/응답/검증/종료) 재오픈 시 마지막 확정 기록·미확인 예약이 보존된다. 응답 저장 실패 뒤 두 번째 호출은 없다.
- 이미 recognized된 금액과 유지 예약이 모두 새 시작에 반영된다. 중복 해제·음수 예약·다른 통화·새 scope 우회·초과 usage 은폐를 거절한다.
- 예약 10·유효한 usage 비용 12를 입력하여 예약 소비 10, recognizedUsage 12, 단계 초과 2를 동시에 보존한다. 누적 cap 10이면 deficit 2, cap이 더 커도 신규 dispatch 차단을 확인한다. 예약 잔량 초과 소비 금지가 이 관측 기록을 롤백하지 않아야 한다.
- 다른 실행 검증 원고, 수정된 review body, 재서명한 잘못된 template, 상한 초과 원문은 dispatch 이전에 거절한다.
- 비용 reservation 성공 뒤 다른 평가 기록 쓰기가 actual 기록용 공간을 잠식하지 않는다. unresolved의 늦은 응답 보관 공간이 유지된다.
- 함수 미등록 구버전 연결·잘못된 버전 함수는 기존 8개 테이블 INSERT를 거절하고, 새 연결만 예약 잔량 검사를 거쳐 쓴다. actual 테이블이나 v4 표식이 남은 상태에서 gate가 빠진 재봉합 DB는 inspector가 거절한다.
- v1/v2/v3/v4 왕복, BLOB 변조, outer manifest 재봉합, 일부 actual 테이블 제거, missing nonce/FK/chain을 검사한다. 기존 회사 DB/원본은 열거나 바꾸지 않는다.
- actual 5테이블·8 gate·v4 표식을 모두 제거하고 정상 legacy manifest/marker로 재봉합한 합성 파일은 정상 legacy와 구별할 수 없다는 한계 시험으로 분리한다. 이 경우까지 위조 거절 시험이 통과했다고 표시하지 않는다.
- 과거 actual revision과 artifact bytes는 뒤의 usage/청구 대조·새 정책·새 후보·코드의 현재 가격 변화 후에도 같다. 조회만으로 실행이 다시 시작되지 않는다.
- 합성 실행은 어떤 가격/responseId/model 문자열을 가져도 actual 관측, 유료 청구, 사람 평가 완료 또는 품질 합격이 되지 않는다.

## 11. 지금 필요한 결정과 나중의 승인

테이블·불변 이력·원자성·합성 시험·한도 및 백업 구현은 사용자 자료나 실제 가격 없이 진행할 수 있다. 위 한도와 단일 누적 예산은 개발상의 보수적 기본값이며 운영 예산 금액을 정한 것이 아니다.

실제 전송 전에만 정확한 모델·공식 가격/토큰 근거·유효 정책·운영 예산·입력 원문·보관 조건과 최대 2회 범위를 갖춘 검토안을 제시한다. 운영자가 승인하지 않은 예산/가격 근거를 개발자가 만들어 채우지 않는다. C를 모의 검증한 뒤 해당 한 건의 승인을 받으며, 후보 12개 전체나 고객 자료로 범위를 확대하지 않는다.

B 완료는 비용 원장과 실패 복구의 구현·합성 검증 완료다. 실제 호출이나 독립 품질 평가 완료는 아니다. 기존 50개 개발 회귀와 AI 작성 후보 12개의 `humanAnswerKey:null`, `independentHoldoutConfirmed:false`, `performanceEvaluation:not-performed`를 유지한다.

초기 설계에서는 SQLite `:memory:`의 쓰기 gate만 확인했다. 후속 B 구현은 별도 임시 파일 DB와 Node 프로세스로 예약·전송 소유권·원문·회귀·백업을 검증한다. 실제 가격·키·외부 공급자·고객 회사 DB는 사용하지 않는다. 최종 실행 결과는 최신 검증 기록에 남긴다.

구현 보강: 실행 event envelope에 `budgetRevision`을 고정하고 영수증의 같은 head와 대조한다. 이벤트 본문·budget 사용량/해제·영수증·과거 다운로드가 같은 시점에 결합된다. DDL 검사에서는 문자열 리터럴의 공백과 대소문자를 보존하여 잘못된 writer gate를 정상 구조로 오인하지 않는다.
