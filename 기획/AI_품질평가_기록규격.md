# AI 품질평가 기록 규격

작성 기준: 2026-09-26 · 기록 스키마 버전 1

## 1. 현재 구현 범위

이 문서는 `벤처패스_최종서비스기획안_v3.md` §13.1에 맞춰, 고정 합성 사례의 평가 기록을 검증하고 요약하는 순수 core의 사용 방법을 설명한다.

**실제 AI 품질평가를 실행한 결과가 아니다. 이 작업에서 실제 AI를 호출하거나 유료 평가를 수행하지 않았으며, 실제 원고 품질과 출시 기준 충족 여부는 아직 검증하지 않았다.**

| 구분           | 현재 상태                                                                           |
| -------------- | ----------------------------------------------------------------------------------- |
| 고정 합성 입력 | 50개 사례가 코드에 존재                                                             |
| 평가 기록      | 타입·스키마·입출력 바인딩 검증 구현                                                 |
| 사람 평가      | 두 독립 검토자의 기록과 공동 조정 기록을 받을 수 있음. 실제 검토 완료를 뜻하지 않음 |
| 요약           | 미평가·반자동·모의·검토 필요·불일치·실패·기록상 통과를 분리                         |
| 자동 실행기    | 미구현. API 호출·모델 실행·요금 발생 기능 없음                                      |
| 평가 스토리지  | 미구현. 파일·DB 저장, 이력 관리, 접근 제어 없음                                     |
| 평가 UI        | 미구현. 일반 작업 화면과 연결되지 않음                                              |
| 실제 고객 검증 | 미수행. 고객자료 입력·저장 경로 없음                                                |

관련 파일은 저장소 기준 다음과 같다.

- `web/src/lib/studio-plan-quality-evaluation.ts`: 기록 계약·검증·요약
- `web/src/lib/studio-plan-quality-evaluation.test.ts`: 계약 회귀 시험
- `web/src/lib/studio-plan-quality-fixtures.ts`: 현재 고정 합성 입력과 기대 검토 항목
- `web/src/lib/studio-plan-quality-fixtures.test.ts`: 기존 결정론적 규칙 회귀 시험
- `web/src/lib/studio-schema.ts`: `PlanContent`와 작성 항목 정의

core는 `node:crypto`를 사용한다. 후속 저장·평가 연결은 Node.js 실행 환경에서 구성한다. 아래 예시는 데이터 형식만 보여 주며 합성 사례 본문, 고객자료, 실제 평가 결과를 싣지 않는다.

## 2. 고정 50개 사례의 한계

현재 50개는 서로 다른 오류·근거·원고 입력을 가진 합성 사례다. 그러나 모두 공통 소프트웨어 사업을 기반으로 만들어졌고 신청 구분은 신규다. 오류 유형의 다양성이 업종·신청 유형의 다양성을 대신하지 않는다.

| §13.1 요구             | 현재 확인 범위와 남은 일                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 최소 50건              | 입력 사례 수는 50건. 실제 AI 실행 50건 또는 사람 평가 50건을 뜻하지 않음                                           |
| 개발 사례와 분리       | 같은 사례를 개발 규칙 회귀에도 사용 중. 독립 held-out 세트가 아님                                                  |
| 제조·소프트웨어·서비스 | 현재 소프트웨어 중심. 제조와 별도 서비스 업종의 대표 사례 및 분포를 추가 설계해야 함                               |
| 신규·재확인            | 현재 신규 입력만 존재. 재확인 사례를 별도로 설계해야 함                                                            |
| 오래된 기준            | 오래된 수치·기간 등의 오류 사례와 공식 기준 버전 오류는 다른 문제다. 공식 기준 변경 사례의 범위를 따로 확인해야 함 |
| 담당자 정답표          | 기존 rubric은 기대 검토 항목이다. 사람이 정한 사실·쟁점·자료 충분성·중대 차단 기대의 정답표는 별도 기록해야 함     |
| 실제 고객 시범         | 수행하지 않음. 합성 평가와 분리된 허용·평가 절차가 필요함                                                          |

현재 manifest의 `expectedDisposition: "reviewable"`을 “자료 충분”으로 해석하면 안 된다. `revise`나 `request-evidence`도 완결 작성 가능 여부 또는 중대 제출 차단 기대를 자동 결정하지 않는다. manifest의 `sufficientForCompleteDraft`와 `mustBlockSubmission`은 항상 `null`로 시작한다.

입력 세트를 독립 검증용으로 확장할 때에는 세트의 출처·버전·업종·신청 유형·정답표를 별도 관리해야 한다. 현재 core는 코드에 포함된 50개 ID와 digest만 수용한다. 임의 사례나 고객 사례를 같은 `fixtureId`로 바꿔 끼우는 확장 방식은 사용할 수 없다.

## 3. 공개 함수와 스키마

| API                                       | 입력                                                              | 출력·역할                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `createPlanQualityEvaluationManifest()`   | 없음                                                              | 고정 50개의 ID·라벨·네 digest·rubric 안내·미확정 기대값 배열. 원문·회사 객체·원고를 반환하지 않음 |
| `createUnevaluatedPlanQualityRecords()`   | 없음                                                              | 50개 `PlanQualityEvaluation`. 정답표·실행·조정은 `null`, 사람 검토는 빈 배열                      |
| `planQualityEvaluationDigest(value)`      | JSON으로 표현할 계약 값                                           | 객체 키를 재귀적으로 정렬한 JSON의 SHA-256 소문자 64자리                                          |
| `planQualityInputDigest(binding)`         | `fixtureId`, `sourceDigest`, `candidateDigest`, `inputPlanDigest` | 실행 입력의 결합 digest                                                                           |
| `planQualityOutputDigest(payload)`        | `outputDigest`를 제외한 `PlanQualityExecution`                    | 실행 메타데이터와 생성 결과 전체의 digest                                                         |
| `validatePlanQualityEvaluation(value)`    | `unknown`                                                         | `{ ok: true, record }` 또는 `{ ok: false, errors: string[] }`                                     |
| `summarizePlanQualityEvaluations(values)` | `readonly unknown[]`                                              | 고정 50개를 분모로 한 상태·기대 결과·미평가·조치 목록                                             |

공개 타입은 `PlanQualityEvaluation`, `PlanQualityExecution`, `PlanQualityAssessment`, `PlanQualityHumanReview`, `PlanQualityEvaluationStatus`, `PlanQualityEvaluationCaseResult`다.

공개 스키마는 `planQualityAnswerKeySchema`, `planQualityExecutionSchema`, `planQualityHumanReviewSchema`, `planQualityEvaluationSchema`다. 스키마는 형태·필드 값 검증에 사용한다. **고정 입력, 생성 출력, 사람 검토의 연결까지 확인하려면 반드시 `validatePlanQualityEvaluation`을 사용한다.** 스키마 파싱 성공만으로 저장 가능한 평가 기록이라고 판단하지 않는다.

함수는 입력 객체를 수정하지 않는다. 성공 검증의 `record`는 파싱된 별도 객체다. 저장·외부 전송·현재 시간 생성·AI 호출은 호출자가 별도로 구현해야 하며 core가 수행하지 않는다.

## 4. 최상위 기록 구조

```ts
type RecordShape = {
  schemaVersion: 1;
  fixtureId: string; // 현재 manifest에 존재하는 ID
  sourceDigest: string;
  candidateDigest: string;
  inputPlanDigest: string;
  rubricDigest: string;
  answerKey: AnswerKey | null;
  execution: Execution | null;
  humanReviews: HumanReview[]; // 0~2개
  resolution: Resolution | null;
};
```

위 `AnswerKey` 등의 이름은 설명용이다. 구현에서는 공개 타입과 스키마를 사용한다. 지정하지 않은 필드를 최상위나 검토 객체에 추가하면 거부된다.

공통 형식은 다음과 같다.

- 작성자·검토자·실행 ID: `^[a-z0-9][a-z0-9_-]{0,63}$`. 예: `reviewer-a`, `reviewer-b`, `local-run-001`. 실명·이메일·전화번호가 필요 없다.
- digest: SHA-256 소문자 16진수 64자리. 임의 상수로 채우지 않는다.
- 시각: 스키마에 맞는 ISO datetime. UTC `YYYY-MM-DDTHH:mm:ss.sssZ` 형식을 사용한다.
- 평가 근거 문구: 공백 제거 후 1~4,000자. 판정 값만 채우고 근거를 생략할 수 없다.
- `execution.mode`: `actual-ai`, `assisted`, `mock` 중 하나. 미실행은 `execution: null`이다.

한 번의 요약에는 fixture별 기록 하나만 넣는다. 같은 fixture의 여러 실행 이력을 한 배열에 넣으면 해당 사례는 `duplicate-fixture-record`로 무효가 된다. 후속 스토리지는 실행 이력을 별도로 보존하고, 비교할 평가 회차별로 fixture당 한 기록을 선택해 요약해야 한다. 현재 core가 최신 실행을 임의 선택하거나 이전 기록을 덮어쓰지는 않는다.

## 5. digest 계산과 변경 규칙

| 필드                   | 정확한 계산 대상                                                        |
| ---------------------- | ----------------------------------------------------------------------- |
| `sourceDigest`         | fixture의 `{ profile: company.profile, sources: company.sources }` 전체 |
| `candidateDigest`      | fixture의 `candidate` 전체                                              |
| `inputPlanDigest`      | fixture의 입력 `plan` 전체                                              |
| `rubricDigest`         | `{ deterministic: deterministicExpectation, semantic: semanticRubric }` |
| 실행 `inputDigest`     | `{ fixtureId, sourceDigest, candidateDigest, inputPlanDigest }`         |
| 실행 `outputDigest`    | 실행 객체에서 `outputDigest`만 제외한 모든 값                           |
| 검토 `answerKeyDigest` | 현재 `answerKey` 전체                                                   |

객체 키 순서 차이는 digest를 바꾸지 않는다. 배열 순서는 보존하므로 자료·섹션·질문 순서가 바뀌면 digest가 바뀔 수 있다. 정렬·문자열 처리를 호출자가 별도로 구현하지 말고 공개 함수를 재사용한다.

해시에는 저장할 정규화된 값을 사용한다. 정답표 입력은 먼저 `planQualityAnswerKeySchema.parse(rawAnswerKey)`로 파싱한 다음 그 결과를 `answerKey`로 보관하고 해시한다. 스키마는 근거 문구와 제공자·모델의 앞뒤 공백 등을 정리하므로, 정규화 전 입력의 해시를 정규화된 기록에 붙이면 불일치가 생길 수 있다. 실행 제공자·모델·시각 등도 저장할 정확한 값으로 고정한 뒤 출력 digest를 계산한다.

`inputPlanDigest`는 검증 입력 원고의 digest이며 생성 결과 digest가 아니다. `outputDigest`에는 `executionId`, `mode`, 제공자·모델, 생성 시각, 입력 digest와 결과 원고·동작 상태가 모두 포함된다. 모의 결과의 `mode`만 실제 AI로 바꾸거나 생성 후 원고를 편집하면 기존 출력 digest와 검토 연결이 깨진다.

새 실행·원고 수정·정답표 변경 후에는 새 결과에 대한 평가가 필요하다. 이전 검토의 digest 값만 새 값으로 덮어써 검토를 재사용해서는 안 된다. 이 절차를 강제할 권한·서명·감사 저장 기능은 아직 없다.

## 6. 정답표와 실행 결과 기록

`answerKey`에는 다음을 기록한다.

| 필드                         | 의미                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `authorId`                   | 정답표 담당자의 로컬 ID                                              |
| `factsAndIssues`             | 확인할 사실·쟁점 1~100개                                             |
| `sufficientForCompleteDraft` | 해당 입력으로 항목별 완결 원고를 작성할 수 있는지 담당자가 판단      |
| `mustBlockSubmission`        | 중대 문제가 남은 상태에서 제출 준비 완료 진행을 막아야 하는 사례인지 |
| `rationale`                  | 위 기대 동작을 정한 근거                                             |

`execution.output`에는 생성 결과를 그대로 기록한다.

```ts
type OutputShape = {
  plan: PlanContent | null;
  disposition:
    | "complete-draft"
    | "partial-draft"
    | "request-evidence"
    | "blocked"
    | "failed";
  submissionReadiness: "ready" | "blocked" | "not-observed";
};
```

`submissionReadiness`는 평가 대상의 제출 준비 진행 상태에 관한 관찰 기록이다. 실제 기관 제출·수신·승인을 나타내지 않는다. 관찰하지 않았다면 `not-observed`를 사용한다. 차단을 기대했다는 이유로 실제 관찰값을 `blocked`로 채우면 안 된다.

`actual-ai`에는 제공자와 모델이 필수다. `assisted`·`mock`에서는 각각 `null`도 허용한다. **`actual-ai`는 기록자의 실행 구분 선언이며 실제 호출 증명이 아니다.** 호출 증빙과 평가 기록을 연결할 실행기는 아직 없다.

다음은 원문 없이 실행 기록을 구성하는 형식 예시다. 평가 회차의 미평가 기록 `record`가 이미 선택되어 있다고 가정한다. 이 코드는 AI를 호출하지 않는다.

```ts
import {
  planQualityInputDigest,
  planQualityOutputDigest,
  validatePlanQualityEvaluation,
  type PlanQualityEvaluation,
  type PlanQualityExecution,
} from "@/lib/studio-plan-quality-evaluation";

declare const record: PlanQualityEvaluation;

const payload: Omit<PlanQualityExecution, "outputDigest"> = {
  executionId: "local-format-example",
  mode: "mock",
  provider: null,
  model: null,
  generatedAt: "2026-09-26T00:00:00.000Z",
  inputDigest: planQualityInputDigest(record),
  output: {
    plan: null,
    disposition: "blocked",
    submissionReadiness: "not-observed",
  },
};

const checked = validatePlanQualityEvaluation({
  ...record,
  execution: { ...payload, outputDigest: planQualityOutputDigest(payload) },
  humanReviews: [],
  resolution: null,
});

if (!checked.ok) {
  // 기존 기록과 입력을 보존하고 errors에 맞는 수정 경로를 제공한다.
  // 저장 함수와 UI는 아직 구현되어 있지 않다.
}
```

## 7. 두 사람의 독립 평가와 불일치 조정

두 검토자는 서로 다른 `reviewerId`를 사용하고 `independent: true`로 기록한다. 같은 ID 두 개는 거부된다. core는 ID 형식과 중복을 검증하지만 실제 두 사람인지, 독립적으로 읽었는지는 인증하지 않는다. 그 확인은 후속 운영 절차의 책임이다.

각 검토는 `executionId`, `outputDigest`, `answerKeyDigest`로 같은 결과와 정답표에 연결한다. 검토 시각은 출력 생성 시각보다 이를 수 없다. 다섯 항목 모두 판정과 근거가 필요하다.

| 항목 키                    | 평가 내용        |
| -------------------------- | ---------------- |
| `technology-business-link` | 기술·사업 연결   |
| `specificity`              | 구체성           |
| `consistency`              | 일관성           |
| `evidence-fit`             | 근거 적합성      |
| `explainability`           | 실제 설명 가능성 |

판정 값은 `met`(충족), `needs-improvement`(보완 필요), `critical-unmet`(중대 미충족)이다. 미검토 항목에 임의의 충족 값을 채우지 않는다. 현재 스키마는 부분 입력 중인 검토 양식의 저장 형식이 아니므로, 후속 UI의 임시 입력과 완성된 검토 기록을 구분해야 한다.

각 `assessment`에는 품질 항목 외에도 다음이 필수다.

- `majorFalseStatements`: 중대한 허위 사실 확정 서술 건수, 0~1,000 정수
- `majorFalseStatementBasis`: 해당 건수 판단 근거
- `completeDraft`: 항목별 완결 원고 여부
- `unnecessaryDeferral`: 불필요한 질문·자료 요청 등으로 작성을 미뤘는지
- `blockingExpectationMet`: 차단 기대 사례이면 `true` 또는 `false`, 차단 기대가 없으면 반드시 `null`
- `behaviorBasis`: 완결·보류·차단 동작을 판단한 근거

두 검토자의 항목 판정, 허위 건수, 완결 여부, 불필요한 보류 여부, 차단 판정 중 하나라도 다르면 불일치다. 근거 설명의 표현만 다른 경우는 불일치로 세지 않는다. 평균 점수나 다수결로 통과시키지 않는다.

불일치를 정리하려면 `resolution`에 같은 실행·출력·정답표 연결, 원래 두 검토자의 `confirmedReviewerIds`, 최종 `assessment`, 조정 근거 `basis`, 근거 위치 `evidenceReferences` 1~100개를 기록한다. `resolvedAt`은 두 검토 시각보다 빠를 수 없다. 다른 검토자 ID나 같은 ID의 반복은 거부된다.

원래 `humanReviews`는 보존한다. 조정 후 통과하더라도 `disagreement: true`와 전체 `disagreements` 집계에는 이력이 남는다. 불일치가 없는 경우 core는 첫 검토자의 판정을 사용하므로 불필요한 조정 기록을 만들지 않는다.

## 8. 판정과 요약 해석

| 사례 상태             | 의미                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `unevaluated`         | 실행 기록 없음                                                                                          |
| `assisted`            | 반자동 결과. 두 사람의 충족 기록이 있어도 실제 AI 통과로 집계하지 않음                                  |
| `mock`                | 모의 결과. 실제 AI 통과로 집계하지 않음                                                                 |
| `review-needed`       | 실제 AI로 기록됐으나 정답표·두 사람 검토·생성 원고 등이 부족                                            |
| `review-disagreement` | 두 검토의 판정이 다르고 유효한 공동 조정 없음                                                           |
| `failed`              | 실제 AI 생성 실패, 또는 평가 준비 후 중대 허위·품질 미충족·차단 실패·충분자료 미완결·불필요한 보류 발견 |
| `passed`              | 이 계약에 입력된 실제 AI 결과·정답표·독립 검토가 연결되고 실패 조건 없음. 출시 통과나 실행 증명이 아님  |
| `invalid`             | 형태·digest·검토 연결 불일치 또는 같은 fixture 기록 중복                                                |

기록상 통과에는 다섯 품질 항목이 모두 충족이어야 한다. 충분한 자료로 지정한 사례에는 추가로 다음 조건이 필요하다.

1. 실제 AI 실행으로 기록되어 있고 두 검토 또는 유효한 조정이 완료됨
2. 중대 허위 0건, 사람 판정 `completeDraft: true`, `unnecessaryDeferral: false`
3. 결과 동작이 `complete-draft`
4. `sectionDefinitions`의 각 항목이 정확히 한 번 존재하고 내용이 비어 있지 않으며 `needsConfirmation`이 아님

충분자료 사례를 부분 원고·추가 자료 요청·차단·실패로 돌리면 완결 작성 실패다. 모든 사례를 검토 대기로 돌리는 방식은 통과할 수 없다.

차단 기대 충족은 사람의 `blockingExpectationMet: true`와 기록된 `submissionReadiness: "blocked"`가 함께 필요하다. `not-observed`는 차단 성공이 아니다. 자료부족 사례의 차단 성공은 별도 `blockingVerified`에 집계될 수 있지만, 원고가 없는 결과를 원고 품질 통과로 바꾸지는 않는다.

주요 요약 필드의 분모와 의미는 다음과 같다.

| 필드                                          | 해석                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fixtureCount`, `minimum50CasesPresent`       | 코드의 고정 입력 수. 평가 완료 수가 아님                                                                |
| `counts`                                      | 고정 50개 사례의 상태별 수. 누락 사례도 `unevaluated`로 포함                                            |
| `invalidRecords`                              | 입력 배열에서 검증에 실패한 기록 수. 고정 목록 밖의 ID도 포함                                           |
| `actualAiRecorded`                            | `actual-ai`로 유효하게 기록된 사례 수. 호출 증명이 아님                                                 |
| `answerKeysRecorded`                          | 유효한 정답표가 있는 사례 수                                                                            |
| `reviewedByTwo`                               | 두 사람의 기록이 있는 수. 모의·반자동·불일치를 포함할 수 있으므로 통과 수로 쓰지 않음                   |
| `disagreements`                               | 조정 완료 여부와 관계없이 원래 의견이 달랐던 사례 수                                                    |
| `sufficientCases`, `sufficientDraftsVerified` | 충분자료 기대 사례 수와 그중 완결 조건 충족 수                                                          |
| `completeDraftsVerified`                      | 자료 충분성 지정 여부와 별개로 완결 조건을 충족한 수                                                    |
| `blockingCases`, `blockingVerified`           | 차단 기대 사례 수와 검증된 차단 동작 수                                                                 |
| `observedMajorFalseStatements`                | 판정된 허위 건수 합계. 미조정 불일치는 두 검토 중 큰 값을 사용하며, 두 사람의 건수를 단순 합산하지 않음 |
| `majorFalsehoodsUnassessed`                   | 실제 AI 기록·정답표·두 검토가 없거나 불일치가 남아 허위 검증을 완료하지 못한 사례 수                    |
| `evaluationNeeded`                            | 통과하지 않은 fixture의 ID·상태·필요 조치 코드                                                          |
| `cases`                                       | 고정 50개 전체의 사례별 판정                                                                            |
| `launchQualification`                         | 항상 `not-assessed`                                                                                     |
| `limitations`                                 | 현재 세트·실행 증빙·출시·실제 고객 검증 한계                                                            |

알 수 없는 fixture ID의 무효 기록은 `invalidRecords`에 포함되지만 고정 50개 사례 목록에 추가되지 않는다. 서로 같은 fixture의 유효 기록 두 개도 해당 사례를 `invalid`로 만든다. 따라서 `invalidRecords`와 `counts.invalid`를 합산하거나 같은 지표로 표시하지 않는다.

`observedMajorFalseStatements: 0`만으로 “허위 0건 검증 완료”라고 표시하면 안 된다. `majorFalsehoodsUnassessed`, 유효한 평가 수, 불일치와 무효 기록을 함께 보여 줘야 한다.

## 9. 오류·필요 조치 코드

| 코드                                                                                                 | 처리                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `invalid-record`                                                                                     | 스키마·필수 필드·ID·값 범위 확인                                          |
| `unknown-fixture`                                                                                    | 현재 고정 세트 밖의 사례. 기존 ID에 강제로 매핑하지 않음                  |
| `stale-sourceDigest`, `stale-candidateDigest`, `stale-inputPlanDigest`, `stale-rubricDigest`         | 입력 또는 rubric 버전 변경. 옛 실행·검토를 새 버전으로 자동 이전하지 않음 |
| `execution-input-mismatch`, `output-digest-mismatch`                                                 | 실행 입력·결과 연결 재확인                                                |
| `review-without-execution-or-answer-key`, `review-binding-mismatch`                                  | 검토가 읽은 실행·출력·정답표 확인                                         |
| `duplicate-reviewer`, `review-before-output`                                                         | 독립 검토자와 검토 시각 확인                                              |
| `blocking-review-scope-mismatch`                                                                     | 차단 기대가 있으면 불리언, 없으면 `null`로 기록                           |
| `invalid-human-resolution`                                                                           | 원래 두 검토자의 확인·조정 시각·근거 확인                                 |
| `duplicate-fixture-record`                                                                           | 같은 회차에 사용할 기록을 하나 선택하고 다른 실행 이력은 별도 보존        |
| `human-answer-key`, `actual-ai-execution`, `generated-draft`                                         | 각각 정답표·실제 실행 기록·생성 원고가 필요                               |
| `two-independent-human-reviews`, `resolve-human-disagreement`                                        | 독립 두 검토 또는 근거 대조 조정 필요                                     |
| `major-false-statement`, `quality-criteria-unmet`                                                    | 사실 오류·품질 문제 수정 후 재평가                                        |
| `submission-block-failed`, `sufficient-case-incomplete`, `unnecessary-deferral`, `generation-failed` | 기대 동작 실패 원인을 수정하고 같은 입력 조건으로 재검증                  |

## 10. 후속 연결 순서와 남은 출시 검증

1. 기존 개발 회귀 사례와 별도로 독립 검증 세트 및 업종·신청 유형 분포를 설계한다. 현재 고정 세트를 바꾸면 digest도 바뀌므로 세트 버전과 과거 결과를 함께 보존할 방식을 먼저 정한다.
2. 담당자가 사실·쟁점·충분자료·중대 차단 기대의 정답표를 작성한다. 현재 rubric에서 기대값을 자동 생성하지 않는다.
3. 실제 실행이 승인·구성된 뒤 별도 실행기에서 결과와 실행 증빙을 기록한다. 이 core를 호출하는 행위 자체는 실제 실행이 아니다.
4. 생성 원고와 정답표를 고정하고 독립 두 사람이 다섯 품질 항목과 사실·동작을 평가한다. 불일치는 원문 근거와 함께 조정한다.
5. 형태·바인딩 검증을 통과한 기록을 정식 회차 기록으로 저장하되, 품질 실패·미평가 기록도 함께 보존한다. 무효 입력과 오류는 별도로 보존하고 요약에서 누락하지 않는다. 입력·출력·정답표 변경 시 새 검토가 필요하며 과거 기록을 보존한다.
6. UI에는 분모·미평가·모의·반자동·불일치·실패·기대별 결과를 함께 표시한다. `passed`를 공식 승인 확률 또는 출시 가능 표시로 연결하지 않는다.

§13.1의 단순 AI 생성본 대비 개선, 수정 전후 해소 근거와 새 중대 문제 유무, 사람 수정량, 질문 적합성, 검토·승인본과 실제 입력·첨부 버전 일치, 제한된 실제 고객 시범은 아직 이 core가 검증하지 않는다. 합성 고정 세트의 기록상 통과만으로 이 항목들을 완료 처리할 수 없다.

문서 작성 시점 평가 core의 계약 테스트는 54개다. 이 테스트는 형태·바인딩·집계 로직을 합성 입력으로 검증하며 실제 AI나 실제 사람의 평가 결과를 만들지 않는다. 재검증은 `venturepass/web/`에서 다음과 같이 실행한다.

```powershell
& '..\..\.venturepass-tools\pnpm.cmd' exec vitest run src/lib/studio-plan-quality-evaluation.test.ts
```


## 11. 로컬 평가 회차·이력·화면 (2026-09-27)

일반 화면의 설정 → 개발·검토 도구 → 합성 자료 품질 검증에서 연다. 기본 메뉴 세 개와 일반 신청 흐름은 유지한다. 이 화면은 고정된 개발 회귀 50사례의 기록 도구이며 실제 AI 실행기나 출시 합격 판정 도구가 아니다.

- 회차를 만들면 고정 입력 원문·원고·rubric와 manifest SHA를 보관하고 50개 모두 미평가로 시작한다. 정답표와 사람 검토는 자동 생성하지 않는다.
- `VENTURE_DATA_DIR/quality-evaluation/quality.sqlite`에 회사 자료와 분리하여 보관한다. 회사 DB나 외부 AI를 열지 않는다.
- 결과 JSON은 기존 core 계약을 따른다. fixture·입력·출력·정답표·검토자 연결을 확인한 기록만 새 버전으로 보관한다. 기존 버전의 수정·삭제는 금지한다.
- 같은 요청 번호와 본문은 같은 보관 결과를 조회한다. 다른 내용으로 번호를 재사용하면 거절하며, 다른 작업이 먼저 저장되면 기존 초안을 유지한다. 최신 기록과 대조한 명시 동작 뒤에만 다시 저장한다.
- 응답이 유실되면 요청 번호로 조회한다. 저장 여부가 아직 보이지 않을 때는 자동 재전송하지 않는다. 사용자가 선택한 동일 요청 재확인만 같은 번호·본문을 보낸다.
- 과거 버전 JSON은 이후 기록 추가와 현재 집계 규칙 변화로 바뀌지 않는다. 현재 판정 규칙에 맞지 않는 과거 기록도 원문·SHA·요청 연결을 보존하며 현재 집계에서는 연결 확인 필요로 표시할 수 있다. corpus 자체가 달라지면 과거 집계를 제공하지 않고 조회만 허용한다.
- 실제 AI 생성 실패는 정답표나 사람 검토가 없어도 실패로 표시한다. 모의 실패는 모의 결과로 구분한다.
- 회차 20개, 회차별 추가 기록 200회, 사례 기록 512KiB, 고정 입력 8MiB, 전체 기록 본문 256MiB 한도를 적용한다.

`recordSource: user-supplied-records`는 사용자가 입력한 기록이라는 뜻이다. provider·model·검토자 ID를 입력하는 것만으로 실제 유료 실행·독립 평가 수행을 증명하지 않는다. 고정 개발 50개와 별도로 제조·소프트웨어·서비스 × 신규·재확인 후보 12개를 준비했으나 사람 정답표·독립성 확인·정식 평가 등록·실제 AI 품질평가를 수행하지 않았다. 자세한 범위는 `독립_품질검증세트_준비안.md`를 따른다.

API는 `/api/studio/quality/runs` 아래의 회차 생성·목록·고정 원문·버전 조회·기록 추가·요청 조회·버전별 다운로드를 제공한다. 로컬 요청·출처 검사와 본문 크기 제한을 유지한다. 다운로드에는 현재 버전 번호·현재 corpus 여부·실시간 집계를 넣지 않아 보관 바이트를 고정한다.

## 12. 전체 평가 기록의 별도 백업·복원

화면의 JSON 다운로드는 선택 버전 조회용이며 복원용 백업이 아니다. 기존 회사 자료 `backup/verify/restore` 명령에는 평가 DB가 포함되지 않는다. 새 명령은 기존 회사 DB 백업의 지원 스키마 범위를 확대하지 않는다. 평가 기록은 별도 명령으로 고정 원문·모든 회차·버전·요청 이력을 보존한다.

앱 폴더에서 경로를 확인한 뒤 사용한다. `quality-backup`의 source는 앱 데이터 루트, destination은 새 백업 폴더다. `quality-restore`의 destination은 `quality-evaluation`이 아직 없는 앱 데이터 루트이며 기존 평가 저장소를 덮어쓰지 않는다.

```powershell
node scripts/local-data.mjs quality-backup --source '앱 데이터 루트' --destination '새 평가 백업 폴더'
node scripts/local-data.mjs quality-verify --source '평가 백업 폴더'
node scripts/local-data.mjs quality-restore --source '평가 백업 폴더' --destination '복원할 앱 데이터 루트'
```

평가 작업을 멈춘 상태에서 별도 백업을 만든다. 원본 DB가 변경되거나 복원 대상이 이미 있으면 성공으로 처리하지 않는다. SQLite 구조·고정 입력 SHA·요청 연결·백업 파일 SHA를 검증하고 완료 표시를 남긴다. 회사 DB·원본 파일·실행 환경 설정은 변경하지 않는다. 검증 성공은 보관 구조와 바이트의 복원 가능성을 뜻하며 실제 AI 품질이나 사람 평가의 진위를 뜻하지 않는다.

## 13. 별도 합성 후보의 불변 원문 등록

2026-09-27부터 같은 개발 도구의 별도 영역에서 제조·소프트웨어·서비스 및 신규/재확인 후보12의 원문을 등록한다. 기존50의 회차·정답표·실행 결과 입력과 합치지 않는다. 등록은 현재 코드에 포함된 합성 입력만 허용하며 실제 고객자료를 받지 않는다. 입력자료/신청주제와 검토자 메모를 분리하고 각각의 해시·manifest·버전 연결을 보존한다.

`/api/studio/quality/candidate-sets`에서 현재 코드와 등록 이력을 조회하고, 고정 setId `ai-validation-candidates`의 `versions` POST로 정확한 sourceDigest/expectedVersion/nonce/후보상태 확인을 받는다. 버전별 조회/다운로드와 `requests/{nonce}` 조회를 제공한다. 다운로드는 최초 등록 바이트 그대로 반환한다. 최대20버전·버전당8MiB이며 기존 평가와 본문256MiB 한도를 공유한다.

동일 nonce/내용은 최초 결과를 재현하고 다른 내용·오래된 버전·변경된 원문·이미 등록한 원문은 거절한다. 조회가 not-observed이거나 통신이 불명확하면 미접수 확정으로 표시하지 않는다. UI에는 마지막 조회 목록과 이번 요청 상태를 분리하고 명시적인 동일 요청 재확인만 제공한다.

전용 quality 백업은 기존3테이블6트리거의 v1과 후보 테이블2개가 추가된5테이블10트리거의 v2를 지원한다. v2 manifest와 CLI 결과에는 candidateVersions/candidateRequests 개수를 포함한다. 과거 평가 JSON·후보 원문·요청 이력·DB 바이트를 보존하며 회사 자료 백업과는 별도다.

후보 등록은 사람 정답표·독립 holdout·실제 AI 품질평가 완료가 아니다. 등록 후보의 실제 호출/비용 증빙과 사람 평가는 아직 연결하지 않았다. 다음 연결은 `품질평가_실행증빙_연결설계.md`를 따른다.
