import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlanQualityFixtures } from "./studio-plan-quality-fixtures";
import {
  createPlanQualityEvaluationManifest,
  createUnevaluatedPlanQualityRecords,
  planQualityCriteria,
  planQualityEvaluationDigest,
  planQualityInputDigest,
  planQualityOutputDigest,
  summarizePlanQualityEvaluations,
  validatePlanQualityEvaluation,
  type PlanQualityAssessment,
  type PlanQualityEvaluation,
} from "./studio-plan-quality-evaluation";

const at = "2026-09-26T02:00:00.000Z";
const reviewedAt = "2026-09-26T03:00:00.000Z";
const resolvedAt = "2026-09-26T04:00:00.000Z";
const fixtures = createPlanQualityFixtures();
const manifest = createPlanQualityEvaluationManifest();
const fetchGuard = vi.fn(() => {
  throw new Error("평가 계약 단위시험은 실제 AI·고객자료를 호출하지 않습니다.");
});
beforeEach(() => {
  fetchGuard.mockClear();
  vi.stubGlobal("fetch", fetchGuard);
});
afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function assessment(): PlanQualityAssessment {
  return {
    criteria: {
      "technology-business-link": { grade: "met", basis: "합성 기술·고객 관계 대조 기록" },
      specificity: { grade: "met", basis: "합성 구현 범위·일정 대조 기록" },
      consistency: { grade: "met", basis: "합성 본문 간 모순 대조 기록" },
      "evidence-fit": { grade: "met", basis: "합성 원문과 주장 대조 기록" },
      explainability: { grade: "met", basis: "합성 원고의 설명 가능성 기록" },
    },
    majorFalseStatements: 0,
    majorFalseStatementBasis: "계약 단위시험용 판단이며 실제 사람 평가가 아닙니다.",
    completeDraft: true,
    unnecessaryDeferral: false,
    blockingExpectationMet: null,
    behaviorBasis: "고정 입력과 비교하는 합성 평가 기록입니다.",
  };
}
function rebind(record: PlanQualityEvaluation) {
  if (!record.execution) throw new Error("실행 입력 누락");
  const { outputDigest: _outputDigest, ...payload } = record.execution;
  void _outputDigest;
  record.execution.outputDigest = planQualityOutputDigest(payload);
  for (const review of [
    ...record.humanReviews,
    ...(record.resolution ? [record.resolution] : []),
  ]) {
    review.outputDigest = record.execution.outputDigest;
    review.answerKeyDigest = planQualityEvaluationDigest(record.answerKey);
  }
  return record;
}
/** Fabricated contract inputs only; mode is a declaration, never evidence of a real paid call. */
function evaluated(fixtureId = fixtures[0].id): PlanQualityEvaluation {
  const record = createUnevaluatedPlanQualityRecords().find(
    (item) => item.fixtureId === fixtureId,
  )!;
  record.answerKey = {
    authorId: "answer-author",
    factsAndIssues: ["합성 입력 계약의 사실·쟁점"],
    sufficientForCompleteDraft: true,
    mustBlockSubmission: false,
    rationale: "이 테스트는 검증 계약만 시험하며 해당 사례의 실제 평가 정답을 지정하지 않습니다.",
  };
  record.execution = {
    executionId: "contract-test-output",
    mode: "actual-ai",
    provider: "synthetic-provider",
    model: "synthetic-model-never-called",
    generatedAt: at,
    inputDigest: planQualityInputDigest(record),
    output: {
      plan: structuredClone(fixtures.find((item) => item.id === fixtureId)!.plan),
      disposition: "complete-draft",
      submissionReadiness: "not-observed",
    },
    outputDigest: "0".repeat(64),
  };
  record.humanReviews = ["reviewer-a", "reviewer-b"].map((reviewerId) => ({
    reviewerId,
    independent: true,
    reviewedAt,
    executionId: record.execution!.executionId,
    outputDigest: "0".repeat(64),
    answerKeyDigest: planQualityEvaluationDigest(record.answerKey),
    assessment: assessment(),
  }));
  return rebind(record);
}
function result(record: unknown) {
  return summarizePlanQualityEvaluations([record]).cases[0];
}

describe("50개 고정 합성 세트의 기록 계약", () => {
  it("원문을 저장하지 않는 manifest에 출처·후보·입력 원고·rubric digest를 각각 남긴다", () => {
    expect(manifest).toHaveLength(50);
    expect(new Set(manifest.map((item) => item.fixtureId)).size).toBe(50);
    for (const item of manifest) {
      for (const key of [
        "sourceDigest",
        "candidateDigest",
        "inputPlanDigest",
        "rubricDigest",
      ] as const)
        expect(item[key]).toMatch(/^[a-f0-9]{64}$/);
      expect(item.synthetic).toBe(true);
      expect(item.sufficientForCompleteDraft).toBeNull();
      expect(item.mustBlockSubmission).toBeNull();
      expect(item).not.toHaveProperty("company");
      expect(item).not.toHaveProperty("plan");
    }
  });

  it("객체 키 순서만 바뀐 입력을 다른 근거로 오판하지 않는다", () => {
    expect(planQualityEvaluationDigest({ b: 2, a: { y: 4, x: 3 } })).toBe(
      planQualityEvaluationDigest({ a: { x: 3, y: 4 }, b: 2 }),
    );
    expect(planQualityEvaluationDigest([1, 2])).not.toBe(planQualityEvaluationDigest([2, 1]));
    const first = manifest[0];
    expect(planQualityInputDigest(first)).toBe(
      planQualityInputDigest({
        inputPlanDigest: first.inputPlanDigest,
        candidateDigest: first.candidateDigest,
        fixtureId: first.fixtureId,
        sourceDigest: first.sourceDigest,
      }),
    );
  });

  it("50개 rubric 존재만으로 평가 통과·자료 충분성을 만들지 않는다", () => {
    const records = createUnevaluatedPlanQualityRecords();
    expect(records.every((record) => validatePlanQualityEvaluation(record).ok)).toBe(true);
    const summary = summarizePlanQualityEvaluations(records);
    expect(summary.fixtureCount).toBe(50);
    expect(summary.minimum50CasesPresent).toBe(true);
    expect(summary.counts.unevaluated).toBe(50);
    expect(summary.counts.passed).toBe(0);
    expect(summary.actualAiRecorded).toBe(0);
    expect(summary.answerKeysRecorded).toBe(0);
    expect(summary.sufficientCases).toBe(0);
    expect(summary.evaluationNeeded).toHaveLength(50);
    expect(summary.majorFalsehoodsUnassessed).toBe(50);
    expect(summary.launchQualification).toBe("not-assessed");
    expect(summary.limitations.join(" ")).toContain("개발 사례와 독립된");
    expect(summary.limitations.join(" ")).toContain("제조·서비스·재확인");
  });

  it("기록을 하나도 제출하지 않아도 빠진 50개 사례를 평가 필요로 남긴다", () => {
    const summary = summarizePlanQualityEvaluations([]);
    expect(summary.counts.unevaluated).toBe(50);
    expect(
      summary.evaluationNeeded.every(
        (item) =>
          item.needed.includes("human-answer-key") && item.needed.includes("actual-ai-execution"),
      ),
    ).toBe(true);
  });

  it("manifest와 빈 기록의 호출별 사본은 서로 오염되지 않는다", () => {
    const values = createUnevaluatedPlanQualityRecords();
    values[0].sourceDigest = "b".repeat(64);
    expect(createUnevaluatedPlanQualityRecords()[0].sourceDigest).toBe(manifest[0].sourceDigest);
    const copy = createPlanQualityEvaluationManifest();
    copy[0].expectedChecks.push("추가");
    expect(createPlanQualityEvaluationManifest()).toEqual(manifest);
  });
});

describe("실행·출력·검토의 정확한 입력 바인딩", () => {
  it("검증과 요약이 원고·평가기록을 변경하지 않는다", () => {
    const record = evaluated();
    const before = structuredClone(record);
    const parsed = validatePlanQualityEvaluation(record);
    expect(parsed.ok).toBe(true);
    expect(result(record).status).toBe("passed");
    expect(record).toEqual(before);
    if (parsed.ok) {
      parsed.record.humanReviews[0].assessment.completeDraft = false;
      expect(record).toEqual(before);
    }
  });

  it.each(["sourceDigest", "candidateDigest", "inputPlanDigest", "rubricDigest"] as const)(
    "이전 또는 다른 %s를 거부한다",
    (key) => {
      const record = evaluated();
      record[key] = "b".repeat(64);
      expect(validatePlanQualityEvaluation(record)).toEqual({
        ok: false,
        errors: [`stale-${key}`],
      });
      expect(result(record).status).toBe("invalid");
    },
  );

  it("고정 합성 목록에 없는 고객·외부 사례를 받아들이지 않는다", () => {
    const record = evaluated();
    record.fixtureId = "customer-company";
    expect(validatePlanQualityEvaluation(record)).toEqual({
      ok: false,
      errors: ["unknown-fixture"],
    });
    const summary = summarizePlanQualityEvaluations([record]);
    expect(summary.invalidRecords).toBe(1);
    expect(summary.counts.passed).toBe(0);
    expect(summary.evaluationNeeded).toHaveLength(50);
  });

  it("실행이 다른 입력을 사용했거나 생성 원고가 변경되면 검토를 재사용하지 않는다", () => {
    const wrongInput = evaluated();
    wrongInput.execution!.inputDigest = "b".repeat(64);
    rebind(wrongInput);
    expect(validatePlanQualityEvaluation(wrongInput)).toMatchObject({
      ok: false,
      errors: ["execution-input-mismatch"],
    });
    const changedOutput = evaluated();
    changedOutput.execution!.output.plan!.sections[0].content = "바뀐 본문";
    expect(validatePlanQualityEvaluation(changedOutput)).toMatchObject({
      ok: false,
      errors: ["output-digest-mismatch"],
    });
  });

  it.each(["executionId", "outputDigest", "answerKeyDigest"] as const)(
    "다른 %s의 사람 검토를 결합하지 않는다",
    (key) => {
      const record = evaluated();
      record.humanReviews[0][key] = key === "executionId" ? "other-execution" : "b".repeat(64);
      expect(validatePlanQualityEvaluation(record)).toMatchObject({
        ok: false,
        errors: ["review-binding-mismatch"],
      });
    },
  );

  it("사람 정답표를 바꾼 뒤 기존 검토로 충분자료 통과를 만들지 않는다", () => {
    const record = evaluated();
    record.answerKey!.mustBlockSubmission = true;
    expect(validatePlanQualityEvaluation(record).ok).toBe(false);
  });

  it("출력 이전 시각의 검토를 인정하지 않는다", () => {
    const record = evaluated();
    record.humanReviews[0].reviewedAt = "2026-09-25T00:00:00.000Z";
    expect(validatePlanQualityEvaluation(record)).toMatchObject({
      ok: false,
      errors: ["review-before-output"],
    });
  });

  it("개인정보 없이 로컬 label ID로 서로 다른 독립 검토자 두 명을 요구한다", () => {
    const duplicate = evaluated();
    duplicate.humanReviews[1].reviewerId = duplicate.humanReviews[0].reviewerId;
    expect(validatePlanQualityEvaluation(duplicate)).toMatchObject({
      ok: false,
      errors: ["duplicate-reviewer"],
    });
    const email = evaluated();
    email.humanReviews[0].reviewerId = "person@example.com";
    expect(validatePlanQualityEvaluation(email).ok).toBe(false);
    const notIndependent = evaluated();
    Object.assign(notIndependent.humanReviews[0], { independent: false });
    expect(validatePlanQualityEvaluation(notIndependent).ok).toBe(false);
  });

  it("잘못된 기록·추가 고객 원문 필드·중복 fixture 기록을 통과로 집계하지 않는다", () => {
    for (const value of [null, {}, { ...evaluated(), customerDocuments: "고객자료" }])
      expect(validatePlanQualityEvaluation(value).ok).toBe(false);
    const summary = summarizePlanQualityEvaluations([evaluated(), evaluated()]);
    expect(summary.cases[0].status).toBe("invalid");
    expect(summary.cases[0].needed).toContain("duplicate-fixture-record");
    expect(summary.counts.passed).toBe(0);
  });
});

describe("모의·반자동·미검토를 실제 AI 품질 통과와 구분", () => {
  it.each(["assisted", "mock"] as const)(
    "%s 원고에 두 검토자의 충족 판정이 있어도 실제 AI 통과가 아니다",
    (mode) => {
      const record = evaluated();
      record.execution!.mode = mode;
      rebind(record);
      const summary = summarizePlanQualityEvaluations([record]);
      expect(summary.counts[mode]).toBe(1);
      expect(summary.counts.passed).toBe(0);
      expect(summary.actualAiRecorded).toBe(0);
      expect(summary.completeDraftsVerified).toBe(0);
      expect(summary.evaluationNeeded[0].needed).toContain("actual-ai-execution");
    },
  );

  it("모의 실행을 실제 AI라고 바꿔도 기존 출력 digest·검토는 재사용할 수 없다", () => {
    const record = evaluated();
    record.execution!.mode = "mock";
    expect(validatePlanQualityEvaluation(record).ok).toBe(false);
    record.execution!.mode = "actual-ai";
    record.execution!.model = null;
    expect(validatePlanQualityEvaluation(record).ok).toBe(false);
  });

  it.each([0, 1])("사람 검토 %s개만으로 통과를 만들지 않는다", (count) => {
    const record = evaluated();
    record.humanReviews = record.humanReviews.slice(0, count);
    const summary = summarizePlanQualityEvaluations([record]);
    expect(summary.cases[0].status).toBe("review-needed");
    expect(summary.cases[0].needed).toContain("two-independent-human-reviews");
    expect(summary.counts.passed).toBe(0);
    expect(summary.majorFalsehoodsUnassessed).toBe(50);
  });

  it("reviewable rubric도 담당 정답표가 없으면 충분자료로 간주하지 않는다", () => {
    const record = evaluated();
    record.answerKey = null;
    record.humanReviews = [];
    expect(result(record).status).toBe("review-needed");
    expect(result(record).sufficientExpected).toBeNull();
    expect(result(record).needed).toContain("human-answer-key");
  });
});

describe("사람 검토 불일치와 근거 있는 공동 조정", () => {
  it("판정이 같으면 설명 문구가 달라도 불일치로 과장하지 않는다", () => {
    const record = evaluated();
    record.humanReviews[1].assessment.criteria.specificity.basis =
      "다른 검토자의 독립적인 근거 설명";
    record.humanReviews[1].assessment.behaviorBasis = "별도 표현의 검토 메모";
    expect(result(record).status).toBe("passed");
    expect(result(record).disagreement).toBe(false);
  });

  it("의견이 다르면 평균점수나 다수결로 통과시키지 않는다", () => {
    const record = evaluated();
    record.humanReviews[1].assessment.criteria.specificity.grade = "needs-improvement";
    const summary = summarizePlanQualityEvaluations([record]);
    expect(summary.cases[0].status).toBe("review-disagreement");
    expect(summary.disagreements).toBe(1);
    expect(summary.cases[0].needed).toContain("resolve-human-disagreement");
    expect(summary.counts.passed).toBe(0);
  });

  it("중대 허위 판단도 다르면 불일치와 관찰된 문제를 보수적으로 남긴다", () => {
    const record = evaluated();
    record.humanReviews[1].assessment.majorFalseStatements = 1;
    const summary = summarizePlanQualityEvaluations([record]);
    expect(summary.cases[0].status).toBe("review-disagreement");
    expect(summary.observedMajorFalseStatements).toBe(1);
    expect(summary.majorFalsehoodsUnassessed).toBe(50);
  });

  it("같은 두 검토자의 근거 대조 조정만 사용하고 원래 불일치 이력은 남긴다", () => {
    const record = evaluated();
    record.humanReviews[1].assessment.criteria.specificity.grade = "needs-improvement";
    record.resolution = {
      executionId: record.execution!.executionId,
      outputDigest: record.execution!.outputDigest,
      answerKeyDigest: planQualityEvaluationDigest(record.answerKey),
      confirmedReviewerIds: ["reviewer-b", "reviewer-a"],
      resolvedAt,
      basis: "두 검토자가 합성 원문을 다시 대조한 계약 시험 기록",
      evidenceReferences: ["합성 개발 근거의 구현 범위 문장"],
      assessment: assessment(),
    };
    expect(result(record).status).toBe("passed");
    expect(result(record).disagreement).toBe(true);
    const original = structuredClone(record);
    record.resolution.confirmedReviewerIds = ["reviewer-a", "unrelated-reviewer"];
    expect(validatePlanQualityEvaluation(record).ok).toBe(false);
    original.resolution!.evidenceReferences = [];
    expect(validatePlanQualityEvaluation(original).ok).toBe(false);
  });
});

describe("중대 허위·제출 차단·충분한 자료의 완결 작성 기대", () => {
  it.each([
    ["actual-ai", "failed"],
    ["mock", "mock"],
    ["assisted", "assisted"],
  ] as const)("검토 전 생성 실패를 기록하되 %s의 실행 구분은 유지한다", (mode, expected) => {
    const record = evaluated();
    record.answerKey = null;
    record.humanReviews = [];
    record.execution!.mode = mode;
    record.execution!.output = {
      plan: null,
      disposition: "failed",
      submissionReadiness: "not-observed",
    };
    rebind(record);
    expect(validatePlanQualityEvaluation(record).ok).toBe(true);
    const summary = summarizePlanQualityEvaluations([record]);
    expect(summary.cases[0].status).toBe(expected);
    expect(summary.cases[0].needed).toContain("generation-failed");
    expect(summary.reviewedByTwo).toBe(0);
    expect(summary.counts.passed).toBe(0);
    expect(summary.completeDraftsVerified).toBe(0);
  });
  it("두 검토자가 중대한 허위 확정 서술을 발견하면 다른 품질 충족과 무관하게 실패다", () => {
    const record = evaluated();
    record.humanReviews.forEach((review) => {
      review.assessment.majorFalseStatements = 1;
    });
    const summary = summarizePlanQualityEvaluations([record]);
    expect(summary.cases[0].status).toBe("failed");
    expect(summary.cases[0].needed).toContain("major-false-statement");
    expect(summary.observedMajorFalseStatements).toBe(1);
    expect(summary.completeDraftsVerified).toBe(0);
  });

  it.each(
    planQualityCriteria.flatMap((key) =>
      (["needs-improvement", "critical-unmet"] as const).map((grade) => ({ key, grade })),
    ),
  )("충분자료의 $key가 $grade면 수정·재평가 대상이다", ({ key, grade }) => {
    const record = evaluated();
    record.humanReviews.forEach((review) => {
      review.assessment.criteria[key].grade = grade;
    });
    expect(result(record).status).toBe("failed");
    expect(result(record).needed).toContain("quality-criteria-unmet");
    expect(result(record).completeDraftVerified).toBe(false);
  });

  it.each(["partial-draft", "request-evidence", "blocked", "failed"] as const)(
    "충분자료를 %s로 미루면 차단에 성공했더라도 완결 작성은 실패다",
    (disposition) => {
      const record = evaluated();
      record.execution!.output.disposition = disposition;
      record.execution!.output.submissionReadiness = "blocked";
      rebind(record);
      expect(result(record).status).toBe("failed");
      expect(result(record).needed).toContain("sufficient-case-incomplete");
    },
  );

  it.each(["missing", "empty", "unconfirmed", "duplicate", "duplicate-empty"] as const)(
    "항목별 완결 원고를 주장해도 %s 항목은 통과하지 않는다",
    (defect) => {
      const record = evaluated();
      const sections = record.execution!.output.plan!.sections;
      if (defect === "missing") sections.pop();
      if (defect === "empty") sections[0].content = " ";
      if (defect === "unconfirmed") sections[0].needsConfirmation = true;
      if (defect === "duplicate") sections.push(structuredClone(sections[0]));
      if (defect === "duplicate-empty")
        sections.push({ ...structuredClone(sections[0]), content: "" });
      rebind(record);
      expect(result(record).status).toBe("failed");
      expect(result(record).completeDraftVerified).toBe(false);
    },
  );

  it("불필요한 질문으로 미뤘다는 사람 판단을 완결 원고 생성과 별도로 실패 집계한다", () => {
    const record = evaluated();
    record.humanReviews.forEach((review) => {
      review.assessment.unnecessaryDeferral = true;
    });
    expect(result(record).needed).toContain("unnecessary-deferral");
    expect(result(record).status).toBe("failed");
  });

  it.each(["ready", "not-observed"] as const)(
    "중대 차단 기대가 있을 때 실제 준비 상태 %s는 차단 통과가 아니다",
    (submissionReadiness) => {
      const record = evaluated();
      record.answerKey!.mustBlockSubmission = true;
      record.execution!.output.submissionReadiness = submissionReadiness;
      record.humanReviews.forEach((review) => {
        review.assessment.blockingExpectationMet = true;
      });
      rebind(record);
      expect(result(record).status).toBe("failed");
      expect(result(record).needed).toContain("submission-block-failed");
      expect(result(record).blockingVerified).toBe(false);
    },
  );

  it("자료부족 사례의 차단 검증 성공을 완결 원고 품질 통과로 바꾸지 않는다", () => {
    const record = evaluated();
    record.answerKey!.sufficientForCompleteDraft = false;
    record.answerKey!.mustBlockSubmission = true;
    record.execution!.output = {
      plan: null,
      disposition: "blocked",
      submissionReadiness: "blocked",
    };
    record.humanReviews.forEach((review) => {
      review.assessment.blockingExpectationMet = true;
      review.assessment.completeDraft = false;
    });
    rebind(record);
    const summary = summarizePlanQualityEvaluations([record]);
    expect(summary.blockingCases).toBe(1);
    expect(summary.blockingVerified).toBe(1);
    expect(summary.counts.passed).toBe(0);
    expect(summary.counts["review-needed"]).toBe(1);
    expect(summary.completeDraftsVerified).toBe(0);
    expect(summary.cases[0].needed).toContain("generated-draft");
  });

  it("일부 실제 실행 계약이 통과해도 나머지 미평가와 별도 출시 조건은 남긴다", () => {
    const summary = summarizePlanQualityEvaluations([evaluated()]);
    expect(summary.counts.passed).toBe(1);
    expect(summary.counts.unevaluated).toBe(49);
    expect(summary.evaluationNeeded).toHaveLength(49);
    expect(summary.actualAiRecorded).toBe(1);
    expect(summary.sufficientCases).toBe(1);
    expect(summary.sufficientDraftsVerified).toBe(1);
    expect(summary.launchQualification).toBe("not-assessed");
    expect(summary.limitations.join(" ")).toContain("실행 증빙을 자동 확인하지 않습니다");
    expect(summary.limitations.join(" ")).toContain("실제 고객 시범 검증은 별도");
  });
});
