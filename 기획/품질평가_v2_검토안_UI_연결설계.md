# 품질평가 v2 검토안 UI 연결 설계

작성일: 2026-09-27

구현 갱신: 읽기 전용 1~5단계를 구현·검증했다. 현재 DTO는 실제로 구현한 configuration-missing 분기만 받으며 미래 reviewable 분기를 허용하지 않는다. provider 원장 6개 GET과 후보 inspect를 연결했고 DB/백업 스키마는 유지했다. 관련13파일346개·lint·타입·격리 빌드, 브라우저 실패 복구·모바일·정확 다운로드·재시작 보존을 통과했다. 상세 결과는 `web/VALIDATION.md`와 작업대장을 따른다. 운영 연결 6단계는 미완료이며 다음은 [운영 근거·검토안 후속 설계](./품질평가_운영근거_검토안_후속설계.md)다.

## 1. 목적과 이번 구현 범위

등록한 합성 후보 한 건에 대해 사용자가 입력 원문, 실행 범위, 비용 근거와 보관 이력을 한 화면에서 이해하도록 한다. 이번 후속 구현의 기본 범위는 **읽기 전용 v2 검토안과 이력 연결**이다. 실제 운영 모델·요율·계정 사용 권한·예산·보관 조건을 채택하거나 유료 전송을 개방하는 작업은 포함하지 않는다.

현재 내부 v2 원장은 예약, 별도 전송 승인, 요청 원문, dispatch, 응답·사용량, 구조화 검증, 종료를 보관할 수 있다. `runQualityProviderSimulation`은 합성 transport만 받는다. 이 구현 사실은 운영 실행 가능이나 실제 AI 성능 검증을 뜻하지 않는다. 운영 store 쓰기는 여전히 `PROVIDER_EXECUTION_DISABLED`로 거절한다.

이 문서는 [전송 승인 후속 설계](./품질평가_v2_전송승인_후속설계.md)의 11~12절을 화면·서비스 작업으로 구체화한다. 새 공식 자료 조사, 키 조회, 고객 DB 조회, 외부 호출은 수행하지 않았다.

## 2. 유지할 계약과 현재 부족한 사실

| 구분 | 현재 확인된 구현 | 다음 화면의 표시 |
| --- | --- | --- |
| A 준비 조회 | `/api/studio/quality/actual-preparation`은 production·blocked, price/tokens/budget null인 읽기 전용 결과를 반환한다. 선택한 모델 문자열은 제공·권한 확인 결과가 아니다. | 기존 응답·검증·내려받기 그대로 유지 |
| v2 금융 예약 | 문맥 전체 입력 상한과 별도 출력 상한을 보수적으로 예약하는 계산 계약이 있다. 실제 입력 적합성이나 절대 청구 보장이 아니다. | ‘금융 예약 기준’으로 표시. A의 토큰 검증 완료로 변환하지 않음 |
| 운영 근거 | v2 운영 모델, 적용 요율·문맥·사용량 해석·보관 조건의 서버 고정 채택본이 없다. | 모델·출처·검토 시각·유효기간 모두 미설정 |
| 운영 예산 | 운영 통화·정수 단위·총한도·지원 가능한 예약 금액을 확정한 정책이 없다. | 예약 가능 금액 `null` / ‘미설정’. 0원으로 대체하지 않음 |
| 운영 인증 | v2 운영 adapter와 계정 권한 확인이 연결되지 않았다. 이 작업에서는 키를 읽거나 존재 여부를 검사하지 않는다. | ‘운영 인증 연결 전’. 전체 PC에 키가 없다고 단정하지 않음 |
| 실제 실행 | production mutation 및 transport가 닫혀 있다. | 실제 실행 버튼 없음. `actualExecutionEnabled:false` |
| 합성 시험 | v2 별도 synthetic 출처로 이벤트·원문·정산 연결을 검증한다. | ‘합성 연결시험’. 합격률·성능·실제 청구액 증명으로 표시하지 않음 |

실행 횟수가 0인 기록과 사용량이 미확인인 기록을 구분한다. `dispatch-intent` 개수는 전송 의도를 먼저 보관한 개수이며, 그 자체로 공급자가 요청을 수신했거나 청구했다는 증거가 아니다. 합성 예산 수치는 테스트 값이며 운영 지원 금액이나 실제 견적에 합산하지 않는다.

## 3. 화면은 후보 선택 아래 한 개의 검토 영역으로 연결한다

기존 `QualityCandidateRegistryPanel` 아래에 v2 검토 영역을 둔다. 일반 신청 화면에 새로운 단계나 운영자 메뉴를 추가하지 않는다. 기본 흐름은 **보관한 후보 선택 → 검토안 보기 → 부족한 조건 또는 보관 이력 확인**이다.

1. 선택한 등록 버전·후보 이름을 보여 준다. v2 조회는 이 선택의 ID·SHA를 고정하며 다른 버전으로 자동 교체하지 않는다.
2. 첫 줄에는 현재 결과 한 가지를 표시한다. 현재 운영 설정에서는 ‘실제 실행 준비 미완료’가 맞다. 가격이나 모델을 임시로 채워 ‘준비 완료’ 화면을 만들지 않는다.
3. 기본 본문에는 후보, 대상 자료 범위, 생성 1회·검토 1회, 자동 재시도 없음, 모델, 금액과 출처의 미설정 상태를 표시한다.
4. 생성 요청 원문, 검토 파생 규칙, 비용 계산 근거, SHA·상세 기록은 접힌 상세 영역으로 제공한다. 원문은 잘라서 승인 대상으로 대체하지 않고 전체를 열람·내려받을 수 있게 한다.
5. 하단에는 해당 후보의 보관 이력을 보여 준다. 예약만 한 기록, 취소 기록, 합성 전송 시험 기록을 구분한다. 최신 이력이 다른 후보라면 임의로 연결하지 않는다.

현재 A의 선택 입력·원문 열람·모바일 줄바꿈·선택 변경 시 응답 폐기 패턴은 재사용할 수 있다. 다만 A 응답에 v2 필드를 추가하거나 A의 `qualityActualPreparation` 검증을 느슨하게 만들어서는 안 된다. A와 v2의 요청 SHA 계산 및 계약 버전도 통합하지 않는다.

기존 모의 실행 패널은 기존 계약 그대로 남긴다. 기존 모의 시험을 v2 시험으로 재명명하거나, 그 결과를 v2 원장으로 복사하지 않는다. v2 UI의 정상·실패 예시는 컴포넌트 시험과 격리된 합성 미리보기로 검증한다. 이번 읽기 전용 묶음에 새 공개 모의 실행 POST는 필요하지 않다.

## 4. 최소 서버·클라이언트 계약

아래 경로는 신규 제안이며 현재 구현된 HTTP 경로가 아니다. 기존 A, 기존 candidate-executions, 기존 actual-ledger 경로의 의미를 바꾸지 않는다.

### 4.1 읽기 전용 검토안

`POST /api/studio/quality/provider-review/inspect`

- 요청: `{version, versionDigest, candidateId}`만 허용하는 strict 객체. 기존 A의 자유 모델 문자열, 가격, budget, approval, environment, transport, body를 받지 않는다.
- 서버는 등록 원본과 후보를 재대조하고 운영 설정을 고정된 서버 공급원에서 조회한다. 현재 공급원은 명시적인 미설정 결과만 반환한다. 클라이언트 값이나 합성 fixture를 운영 설정으로 사용하지 않는다.
- 응답은 신규 browser-safe `ProviderReviewView` 판별 union을 사용한다. `viewVersion:1`, `providerContractVersion:2`, 정확한 등록 범위, `inspectedAt`, `viewDigest`, `actualExecutionEnabled:false`를 공통으로 둔다.
- 현재 분기 `state:'configuration-missing'`에는 `model:null`, `financialBasis:null`, `budget:null`, `retention:null`, `preparation:null`, `transmissionManifest:null`과 구체적인 blockers를 둔다. 모델이 없으면 정확한 생성 요청도 완성하지 않는다.
- 향후 충분한 서버 근거가 있는 `state:'reviewable'`은 완전한 v2 preparation과 그 SHA를 담을 수 있다. 그래도 실제 전송 허가를 의미하지 않는다. 영속 예약 run이 없으면 `transmissionManifest`는 계속 null이다. manifest는 실제 `runDigest`에 결합되므로 가짜 run ID를 만들지 않는다.
- `viewDigest`는 해당 조회본 전체의 고정 digest input을 대상으로 한다. 내려받기는 화면에서 검증한 조회본을 그대로 사용하고 새 시각·새 설정으로 다시 생성하지 않는다.
- 이 POST는 읽기 전용 계산이다. 승인·예약·nonce·전송·비용 이벤트를 생성하지 않는다.

설정이 없는 상태를 기존 strict `ProviderPreparation`에 null 필드로 억지 삽입하지 않는다. 완성 전 검토 화면 DTO와 실제 실행용 준비안은 다른 계약이다. 새 응답의 조회 시각은 기존 보관 이력의 원문이나 SHA에 섞지 않는다.

### 4.2 v2 원장 읽기 전용 경로

기본 경로 제안: `/api/studio/quality/provider-ledger`.

| 경로 | 연결할 Store 메서드 | 범위 |
| --- | --- | --- |
| `GET /` | `providerList`, `providerBudgetGet` | 출처별 목록·예산. production 미설정은 null, synthetic 합계와 분리 |
| `GET /runs/{id}` | `providerGet(id)` | 현재 확인 가능한 snapshot |
| `GET /runs/{id}/revisions/{revision}` | `providerGet(id, revision)` | 정확한 과거 prefix |
| `GET /runs/{id}/revisions/{revision}/download` | `providerDownload(id, revision)` | 저장 원문 기반 format2 또는 format3 archive 바이트 |
| `GET /runs/{id}/revisions/{revision}/artifacts/{key}` | `providerGet(id, revision)` 후 `providerArtifact(id,key)` | 선택 revision에 포함된 artifact만 반환 |
| `GET /requests/{clientRequestId}` | `providerLookup` | 정확한 v2 영수증 또는 not-observed |

현재 `providerArtifact`는 run 전체에서 key를 찾는다. 따라서 새 revision 경로는 먼저 snapshot의 `artifacts` 목록에 해당 key·SHA·크기가 존재하는지 확인해야 한다. 과거 r0 조회에 나중 review나 response가 새어 나와서는 안 된다. archive는 서버가 보관한 문자열·BLOB을 반환하며 브라우저에서 재직렬화한 파일로 대체하지 않는다.

환경 scope는 서버가 고정하며 URL이나 요청 본문으로 선택하지 않는다. 목록에서 출처를 보여 주는 것과 클라이언트가 쓰기 scope를 바꾸는 것은 다르다. 이력 읽기 때문에 `PlanQualityStore`를 synthetic 쓰기 옵션으로 다시 열지 않는다.

새 서비스도 기존 `assertLocalRequest`, strict query 거부, UUID·revision·artifact key 검사, POST JSON 4 KiB 상한, 일반화한 오류, no-store/첨부 헤더를 재사용한다. GET 경로의 쓰기 메서드는 405로 거절한다. 파일 경로나 raw 오류·키·응답 원문을 로그로 보내지 않는다.

### 4.3 브라우저 검증

새 `quality-provider-review-ui.ts`에 strict DTO 검증, 범위 비교, digest 검증, archive·artifact 검증을 둔다. 기존 Node crypto를 포함하는 `.mjs` 또는 provider core를 client runtime에서 import하지 않는다. 타입은 type-only로 사용하고 런타임 schema는 browser-safe 계약으로 제공한다.

digest 종류를 명시적으로 구분한다. provider 기록·manifest의 정렬 규칙, v1 prompt/wire 계약의 `localeCompare` 정렬, 원문 BLOB의 SHA-256은 서로 바꾸지 않는다. 같은 JSON 의미라도 원문 바이트 SHA를 만족한다고 간주하지 않는다.

후보·등록 버전·원문 범위·조회 sequence가 달라진 늦은 응답은 표시하지 않는다. snapshot은 schemaVersion, archiveFormatVersion, environment, runDigest, revision, receipt·budget prefix와 연결해 읽는다. 형식만 맞는 다른 후보의 이력은 채택하지 않는다.

## 5. 정확한 전송 검토서와 승인을 분리한다

향후 실제 한 건의 검토서가 성립하려면 다음 내용이 모두 고정되어야 한다. 지금은 미확인 항목을 빈칸으로 보여 주며 승인 가능한 문서라고 부르지 않는다.

| 검토 대상 | 고정할 내용 |
| --- | --- |
| 대상 한 건 | 등록 set/version/versionDigest, candidateId, source/candidate/modelInput SHA, 정확한 run ID·runDigest·preparationDigest |
| 처리 범위 | 합성 후보의 profile·추출 텍스트·선택 후보·작성 지시. 정답표·검토자 메모·키·임의 고객 자료는 포함하지 않음 |
| 전송 목적지 | 서버 고정 공식 API, 모델의 정확한 ID/버전, standard/default tier, 적용 지역·보관 안내 digest |
| 최초 요청 | generation 전체 body·바이트 SHA·requestDigest·system/instruction/schema 계약 |
| 두 번째 요청 | review 고정 문맥과 JSON slot, 같은 run 최초 검증 생성물에서만 파생하는 규칙·template digest. 아직 생성되지 않은 body는 ‘정확한 검토 원문’이라고 표시하지 않음 |
| 호출 제한 | 생성 1회·독립 검토 1회, 자동 재시도 0회·자동 수정 0회. 생성 실패나 비용 미확인 때 검토를 보내지 않는 조건 |
| 금융 범위 | 통화·정수 단위·phase별 예약액·합계·현재 budget revision/digest, 요율·문맥·usage 해석 정책의 출처·유효기간·digest |
| 미확인 비용 | 실패 무료 보장 없음, 사용량 누락 시 held 유지, 알려진 초과 비용 전액 기록·신규 전송 차단 |
| 보관 및 유효기간 | retention 안내, 요청·응답·검토 기록의 로컬 보관 범위, 승인 시각·만료 시각 |

예약 승인은 `acknowledgedReservationOnly:true`로 유지한다. 전송 검토 화면을 봤거나 예약을 생성한 행위로 `transmission-approved`를 만들지 않는다. 전송 시에는 별도의 명시적 사용자 동작으로 **현재 run에 결합된 `ProviderTransmissionManifest` 전체**를 승인해야 한다. manifest나 현재 예산 head가 달라지면 기존 승인으로 진행하지 않는다.

운영 전송 버튼과 POST는 이번 묶음에서 만들지 않는다. 향후 운영 경로가 추가되어도 브라우저는 승인 사실만 보내며 request-prepared/dispatch/response/validated/finish 원장 훅을 직접 호출할 수 없다. 해당 단계는 고정 서버 runner가 소유한다. 합성 시험은 `synthetic-test` 출처이며 운영 `explicit-user` 승인을 대신하지 않는다.

## 6. 응답 유실·중단·화면 잠금 규칙

읽기 전용 조회 실패는 저장 실패나 실행 실패로 표현하지 않는다. 조회를 다시 하는 것은 전송을 다시 하는 것과 다르다. 향후 승인·예약 쓰기를 연결할 때에는 기존 모의 패널의 처리 패턴을 적용하되 다음 조건을 v2 범위로 검증한다.

- pending에는 전송한 exact body·nonce·run/preparation/manifest·CAS를 깊은 복사해 보관한다. POST 응답만으로 pending을 지우지 않는다.
- nonce 조회의 committed 영수증과 그 revision snapshot을 대조해야 기록 확인을 마친다. 전송 승인 영수증은 실행 완료 영수증이 아니다.
- `not-observed`는 ‘요청이 처리되지 않았다’는 확정이 아니다. 자동 재POST하지 않는다. 명시적인 같은 body·같은 nonce 재확인이 허용되는 향후 서비스에서도 마지막 정확한 lookup이 not-observed인 경우에만 허용한다. 이미 committed를 관측했으면 조회만 제공한다.
- 승인·dispatch를 먼저 저장한 뒤 프로세스가 멈췄다면 UI 새로고침이나 앱 재시작으로 transport를 재개하지 않는다. 완료/중단/미확인을 각각 표시하며 사용량 미확인 held를 0으로 정리하지 않는다.
- committed snapshot까지 확인한 비종결 이력은 ‘시작 기록 확인 · 결과 미확인’으로 표시하고 조회만 제공한다. 사용자는 이력을 보관한 채 검토 영역을 닫을 수 있다. 이 동작을 취소·종료·예약 해제로 처리하지 않는다.
- 실제 pending 요청 확인 전에는 후보·버전 변경과 경쟁 편집을 잠근다. 조회본만 열려 있을 때는 명시적인 ‘검토안 닫기’로 해제한다. `QualityCandidateRegistryPanel`의 onBusyChange 합산에는 v2 busy를 넣되 자기 busy가 자신의 blockedReason으로 되돌아오는 교착을 만들지 않는다.
- 취소 버튼은 현재 지원하는 미전송 예약 상태에만 연결한다. 승인·전송 이후의 중단을 기존 예약 취소 API로 대신하지 않는다.

화면 상태는 `state` 문자열만으로 번역하지 않고 failureCode와 보관한 이벤트를 함께 해석한다. 예를 들어 `output-invalid`와 `INTERRUPTED`의 조합은 응답 이후 근거 만료 또는 현재 엔진 변경으로 검증을 중단한 경우도 포함한다. 이때 ‘원고 불량 확인’이라고 표시하지 않고 ‘응답 보관 · 원고 검증 중단’과 확인된 중단 사유를 보여 준다. 실제 도메인 검증이 거절한 경우만 그 검증 실패를 표시한다. `result-unobserved` 뒤 늦은 응답과 사용량이 보관·정산되었더라도 기존 중단은 유지한다. ‘늦은 응답 보관 · 비용 확인’으로 설명하며 중단 철회, 검토 호출 재개, 전체 실행 완료로 바꾸지 않는다.

## 7. 파일 연결과 단계별 구현

| 단계 | 파일·경로 | 작업 |
| --- | --- | --- |
| 1. 읽기 전용 DTO | 신규 `web/src/lib/studio-plan-quality-provider-review-types.ts` | incomplete/reviewable 판별 union, 출처·미설정·허가 false, digest input, browser-safe schema |
| 2. 조회 서비스 | 신규 `studio-plan-quality-provider-review-service.ts`, `studio-plan-quality-provider-ledger-service.ts` 및 4절의 API route | 서버 설정 미설정 공급원, 등록본 재대조, exact revision·원문 조회, strict local 경계. 운영 쓰기 연결 없음 |
| 3. 화면 | 신규 `web/src/components/studio/quality-provider-review-ui.ts`, `quality-provider-review-panel.tsx` | 한 후보 검토, 원문·이력·미설정 금액, archive/receipt 검증, 모바일 표시 |
| 4. 최소 통합 | 기존 `quality-candidate-registry-panel.tsx` | 기존 후보 선택·등록본을 전달하고 busy 합산. A·기존 모의 패널의 계약 유지 |
| 5. 합성 검증 | 신규 UI/service 통합 시험, 기존 provider store/runner/backup 시험 재사용 | 격리된 합성 상태로 reserved/cancelled/completed/unknown/초과·유실 화면 검증. 실제 전송 0회 |
| 6. 운영 연결 | 향후 별도 server-fixed production adapter·설정 모듈·승인 서비스 | 필요한 사실과 사용자 승인 확보 후 별도 설계·검증. 이번 구현에 포함하지 않음 |

기존 참조 파일은 `quality-actual-preparation-panel.tsx`, `quality-actual-preparation-ui.ts`, `studio-plan-quality-actual-service.ts`, `quality-execution-ui.ts`이다. 영속 경로는 `studio-plan-quality-provider-store.ts`, `studio-plan-quality-store.ts`, `studio-plan-quality-provider-runner.ts`, `studio-provider-observation.ts`, `scripts/local-data-quality-provider*.mjs`를 사용한다. 새 원장 테이블이나 A의 중복 준비 엔진을 만들지 않는다.

향후 운영 adapter는 합성 runner의 options에 임의 URL·model·send를 넣어 개방하는 방식으로 만들지 않는다. 서버 전용 고정 provider와 정확한 모델·승인 manifest·무재시도 계약을 가지며, 키는 서버에서만 취급한다. 합성 transport가 운영 증빙으로 표시되는 것을 타입·서버 gate·원장 scope 모두에서 거절한다. 기존 A, v1 합성, v2 합성 기록을 production 기록으로 이식하지 않는다.

## 8. 필요한 회귀와 완료 기준

다음 검증을 통과하면 이번 **읽기 전용 연결 묶음**을 완료할 수 있다. 유료 AI 평가 완료나 서비스 전체 완료로 보고하지 않는다.

1. 기존 A API strict 입력, production·blocked·null 근거, v1 request/template digest와 내려받기 바이트 시험이 그대로 통과한다.
2. v2 inspect는 고객 자료·자유 원문·가격·예산·environment·승인 필드를 거절한다. 모델/금액/근거 누락은 미설정 상태이고 승인·예약·transport 호출은 모두 0회다.
3. provider GET은 쓰기 405, query/경로/본문 한도, 다른 후보·run·revision·SHA 혼합, 잘못된 archive를 거절한다. artifact는 선택 prefix에 없으면 반환하지 않는다.
4. 과거 r0 및 취소 r1 format2, 신규 format3의 이전 revision 파일은 후속 실행·예산·시간 변화 뒤에도 같은 바이트다. 실제 원문 다운로드는 서버 BLOB SHA와 일치한다.
5. 전송 의도/응답 수신/구조화 검증/실행 종료/비용 확인을 구분한다. `output-invalid` + `INTERRUPTED`를 원고 불량으로 단정하지 않고, 늦은 응답 정산 뒤에도 기존 중단을 유지한다. 합성 완료를 실제 품질 합격이나 0원 운영 가능으로 표시하지 않는다.
6. 후보 변경·unmount·느린 응답·다른 registry 버전·committed 뒤 snapshot 실패·not-observed·모바일 긴 ID를 검증한다. 화면에는 현재 선택에 맞는 한 개의 주 동작만 남긴다.
7. 합성 시험에서 정상 2회, 미확인 비용 유지, 상한 초과, 늦은 응답, 중단·재시작 0회 재전송을 확인한다. 기존 v6 백업/복원 호환 및 원문 보존 회귀를 유지한다.

## 9. 독립 진행할 개발과 사용자 검토에 필요한 사실

**현재 독립 진행 가능:** 위 읽기 전용 DTO·서비스·UI·이력·다운로드, 미설정 상태, synthetic fixture 기반 UX/경합·원문 검증, 문서와 안내 문구. 이를 위해 사용자에게 모델이나 결제 정보를 다시 묻거나 운영 키를 읽을 필요가 없다.

**정확한 운영 한 건의 검토서에 필요한 사실:** 운영에서 사용할 특정 모델/버전과 계정 사용 권한, 공식 문맥·요율·tier·지역·cache/usage 조건을 검토한 고정 출처, 내부 신선도 기한, 보관 안내, 통화·정수 단위·총예산 및 한 건의 예약 한도, 대상 등록 후보 한 건의 확정이다. ‘출처 URL이 입력됨’만으로 근거를 독립 검증했다고 표시하지 않는다. 실패·단절 청구가 무료라는 보장이 없다는 조건도 포함한다.

**실제 전송 직전 필요한 별도 승인:** 모든 사실을 고정한 구체적인 한 건의 검토서를 먼저 완성한 뒤, 생성 원문과 검토 파생 범위·최대 2회·비용 예약·미확인 비용 유지·보관 조건을 사용자에게 제시한다. 그 exact manifest에 대한 명시 승인을 받은 뒤에만 운영 전송을 검토한다. 자료가 없다는 이유로 합성 가격·예산·승인 시각을 운영 검토서에 채우지 않는다.

현재 결론은 ‘v2 합성 원장과 실행 연결을 UI에서 정확히 볼 수 있도록 개발 가능, 운영 한 건의 금액·출처·승인서는 아직 미완성’이다. 실제 AI 실행, 운영 예산 예약, 모델 채택은 이번 문서나 합성 시험으로 승인되지 않는다.
