import { createHash } from "node:crypto";
import { createPlanQualityFixtures } from "./studio-plan-quality-fixtures";
import { sectionDefinitions } from "./studio-schema";
import {
  planQualityCriteria,
  planQualityEvaluationSchema,
  type PlanQualityEvaluation,
  type PlanQualityExecution,
  type PlanQualityAssessment,
} from "./studio-plan-quality-evaluation-types";
export * from "./studio-plan-quality-evaluation-types";

/** Recording and aggregation only. No AI execution or customer corpus. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
export function planQualityEvaluationDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function planQualityOutputDigest(value: Omit<PlanQualityExecution, "outputDigest">) {
  return planQualityEvaluationDigest(value);
}

/** Every digest is reconstructed from the shipped synthetic inputs, never from uploaded files. */
export function createPlanQualityEvaluationManifest() {
  return createPlanQualityFixtures().map((fixture) => ({
    fixtureId: fixture.id,
    label: fixture.label,
    synthetic: true as const,
    sourceDigest: planQualityEvaluationDigest({
      profile: fixture.company.profile,
      sources: fixture.company.sources,
    }),
    candidateDigest: planQualityEvaluationDigest(fixture.candidate),
    inputPlanDigest: planQualityEvaluationDigest(fixture.plan),
    rubricDigest: planQualityEvaluationDigest({
      deterministic: fixture.deterministicExpectation,
      semantic: fixture.semanticRubric,
    }),
    expectedDisposition: fixture.semanticRubric.expectedDisposition,
    expectedChecks: [...fixture.semanticRubric.expectedChecks],
    // A draft rubric is not a human answer key declaring the evidence sufficient.
    sufficientForCompleteDraft: null,
    mustBlockSubmission: null,
  }));
}
type ManifestEntry = ReturnType<typeof createPlanQualityEvaluationManifest>[number];
export function planQualityInputDigest(
  binding: Pick<
    ManifestEntry,
    "fixtureId" | "sourceDigest" | "candidateDigest" | "inputPlanDigest"
  >,
) {
  const { fixtureId, sourceDigest, candidateDigest, inputPlanDigest } = binding;
  return planQualityEvaluationDigest({ fixtureId, sourceDigest, candidateDigest, inputPlanDigest });
}
export function createUnevaluatedPlanQualityRecords(): PlanQualityEvaluation[] {
  return createPlanQualityEvaluationManifest().map(
    ({ fixtureId, sourceDigest, candidateDigest, inputPlanDigest, rubricDigest }) => ({
      schemaVersion: 1,
      fixtureId,
      sourceDigest,
      candidateDigest,
      inputPlanDigest,
      rubricDigest,
      answerKey: null,
      execution: null,
      humanReviews: [],
      resolution: null,
    }),
  );
}

function parseEvaluation(value: unknown, manifest: ManifestEntry[]) {
  const parsed = planQualityEvaluationSchema.safeParse(value);
  if (!parsed.success) return { ok: false as const, errors: ["invalid-record"] };
  const record = parsed.data;
  const expected = manifest.find((item) => item.fixtureId === record.fixtureId);
  if (!expected) return { ok: false as const, errors: ["unknown-fixture"] };
  const errors: string[] = [];
  for (const key of ["sourceDigest", "candidateDigest", "inputPlanDigest", "rubricDigest"] as const)
    if (record[key] !== expected[key]) errors.push(`stale-${key}`);
  const execution = record.execution;
  if (execution) {
    const { outputDigest, ...payload } = execution;
    if (execution.inputDigest !== planQualityInputDigest(expected))
      errors.push("execution-input-mismatch");
    if (outputDigest !== planQualityOutputDigest(payload)) errors.push("output-digest-mismatch");
  }
  if (record.humanReviews.length && (!execution || !record.answerKey))
    errors.push("review-without-execution-or-answer-key");
  const reviewerIds = record.humanReviews.map((item) => item.reviewerId);
  if (new Set(reviewerIds).size !== reviewerIds.length) errors.push("duplicate-reviewer");
  for (const review of [
    ...record.humanReviews,
    ...(record.resolution ? [record.resolution] : []),
  ]) {
    if (
      !execution ||
      !record.answerKey ||
      review.executionId !== execution.executionId ||
      review.outputDigest !== execution.outputDigest ||
      review.answerKeyDigest !== planQualityEvaluationDigest(record.answerKey)
    )
      errors.push("review-binding-mismatch");
    const reviewedAt = "reviewedAt" in review ? review.reviewedAt : review.resolvedAt;
    if (execution && Date.parse(reviewedAt) < Date.parse(execution.generatedAt))
      errors.push("review-before-output");
    if (
      record.answerKey &&
      (record.answerKey.mustBlockSubmission
        ? review.assessment.blockingExpectationMet === null
        : review.assessment.blockingExpectationMet !== null)
    )
      errors.push("blocking-review-scope-mismatch");
  }
  if (
    record.resolution &&
    (reviewerIds.length !== 2 ||
      new Set(record.resolution.confirmedReviewerIds).size !== 2 ||
      !reviewerIds.every((id) => record.resolution!.confirmedReviewerIds.includes(id)) ||
      record.humanReviews.some(
        (review) => Date.parse(review.reviewedAt) > Date.parse(record.resolution!.resolvedAt),
      ))
  )
    errors.push("invalid-human-resolution");
  return errors.length
    ? { ok: false as const, errors: [...new Set(errors)] }
    : { ok: true as const, record };
}
export function validatePlanQualityEvaluation(value: unknown) {
  return parseEvaluation(value, createPlanQualityEvaluationManifest());
}

export type PlanQualityEvaluationStatus =
  | "unevaluated"
  | "assisted"
  | "mock"
  | "review-needed"
  | "review-disagreement"
  | "failed"
  | "passed"
  | "invalid";
export type PlanQualityEvaluationCaseResult = {
  fixtureId: string;
  status: PlanQualityEvaluationStatus;
  needed: string[];
  actualAiRecorded: boolean;
  answerKeyRecorded: boolean;
  independentReviews: number;
  disagreement: boolean;
  sufficientExpected: boolean | null;
  blockExpected: boolean | null;
  completeDraftVerified: boolean;
  blockingVerified: boolean;
  majorFalseStatementsObserved: number | null;
};
function decision(assessment: PlanQualityAssessment) {
  return {
    ...assessment,
    criteria: Object.fromEntries(
      planQualityCriteria.map((key) => [key, assessment.criteria[key].grade]),
    ),
    majorFalseStatementBasis: undefined,
    behaviorBasis: undefined,
  };
}
function assess(record: PlanQualityEvaluation): PlanQualityEvaluationCaseResult {
  const { execution, answerKey, humanReviews, resolution } = record;
  const disagreement =
    humanReviews.length === 2 &&
    planQualityEvaluationDigest(decision(humanReviews[0].assessment)) !==
      planQualityEvaluationDigest(decision(humanReviews[1].assessment));
  const assessment =
    humanReviews.length === 2
      ? disagreement
        ? resolution?.assessment
        : humanReviews[0].assessment
      : undefined;
  const needed: string[] = [];
  if (!answerKey) needed.push("human-answer-key");
  if (!execution) needed.push("actual-ai-execution");
  else if (execution.mode !== "actual-ai") needed.push("actual-ai-execution");
  if (!execution?.output.plan) needed.push("generated-draft");
  if (humanReviews.length < 2) needed.push("two-independent-human-reviews");
  if (disagreement && !resolution) needed.push("resolve-human-disagreement");
  const actualAiRecorded = execution?.mode === "actual-ai";
  const ready = !!execution && actualAiRecorded && !!answerKey && !!assessment;
  const allQualityMet =
    !!assessment && planQualityCriteria.every((key) => assessment.criteria[key].grade === "met");
  const sections = execution?.output.plan?.sections ?? [];
  const completeDraftVerified =
    ready &&
    allQualityMet &&
    assessment.majorFalseStatements === 0 &&
    assessment.completeDraft &&
    !assessment.unnecessaryDeferral &&
    execution.output.disposition === "complete-draft" &&
    sectionDefinitions.every(({ key }) => {
      const matches = sections.filter((section) => section.key === key);
      return matches.length === 1 && !!matches[0].content.trim() && !matches[0].needsConfirmation;
    });
  const blockingVerified =
    ready &&
    answerKey.mustBlockSubmission &&
    assessment.blockingExpectationMet === true &&
    execution.output.submissionReadiness === "blocked";
  const failures: string[] = [];
  if (execution?.output.disposition === "failed") failures.push("generation-failed");
  if (ready) {
    if (assessment.majorFalseStatements > 0) failures.push("major-false-statement");
    if (!allQualityMet) failures.push("quality-criteria-unmet");
    if (answerKey.mustBlockSubmission && !blockingVerified)
      failures.push("submission-block-failed");
    if (answerKey.sufficientForCompleteDraft && !completeDraftVerified)
      failures.push("sufficient-case-incomplete");
    if (assessment.unnecessaryDeferral) failures.push("unnecessary-deferral");
  }
  needed.push(...failures);
  const status: PlanQualityEvaluationStatus = !execution
    ? "unevaluated"
    : execution.mode === "mock"
      ? "mock"
      : execution.mode === "assisted"
        ? "assisted"
        : execution.output.disposition === "failed"
          ? "failed"
          : !answerKey || humanReviews.length < 2
            ? "review-needed"
            : disagreement && !resolution
              ? "review-disagreement"
              : failures.length
                ? "failed"
                : !execution.output.plan
                  ? "review-needed"
                  : "passed";
  return {
    fixtureId: record.fixtureId,
    status,
    needed: [...new Set(needed)],
    actualAiRecorded,
    answerKeyRecorded: !!answerKey,
    independentReviews: humanReviews.length,
    disagreement,
    sufficientExpected: answerKey?.sufficientForCompleteDraft ?? null,
    blockExpected: answerKey?.mustBlockSubmission ?? null,
    completeDraftVerified,
    blockingVerified,
    majorFalseStatementsObserved:
      assessment?.majorFalseStatements ??
      (humanReviews.length
        ? Math.max(...humanReviews.map((review) => review.assessment.majorFalseStatements))
        : null),
  };
}

/** Counts are recorded evidence, not a launch decision or a proof that AI calls took place. */
export function summarizePlanQualityEvaluations(values: readonly unknown[]) {
  const manifest = createPlanQualityEvaluationManifest();
  const parsed = values.map((value) => parseEvaluation(value, manifest));
  const invalidRecords = parsed.filter((item) => !item.ok).length;
  const cases = createUnevaluatedPlanQualityRecords().map(
    (empty): PlanQualityEvaluationCaseResult => {
      const matches = values.flatMap((value, index) =>
        value !== null &&
        typeof value === "object" &&
        "fixtureId" in value &&
        value.fixtureId === empty.fixtureId
          ? [parsed[index]]
          : [],
      );
      if (!matches.length) return assess(empty);
      if (matches.length !== 1 || !matches[0].ok)
        return {
          ...assess(empty),
          status: "invalid",
          needed:
            matches.length !== 1
              ? ["duplicate-fixture-record"]
              : matches[0].ok
                ? []
                : matches[0].errors,
        };
      return assess(matches[0].record);
    },
  );
  const counts = Object.fromEntries(
    (
      [
        "unevaluated",
        "assisted",
        "mock",
        "review-needed",
        "review-disagreement",
        "failed",
        "passed",
        "invalid",
      ] as const
    ).map((status) => [status, cases.filter((item) => item.status === status).length]),
  ) as Record<PlanQualityEvaluationStatus, number>;
  return {
    scope: "fixed-synthetic-records-only" as const,
    fixtureCount: manifest.length,
    minimum50CasesPresent: manifest.length >= 50,
    counts,
    invalidRecords,
    actualAiRecorded: cases.filter((item) => item.actualAiRecorded).length,
    answerKeysRecorded: cases.filter((item) => item.answerKeyRecorded).length,
    reviewedByTwo: cases.filter((item) => item.independentReviews === 2).length,
    disagreements: cases.filter((item) => item.disagreement).length,
    sufficientCases: cases.filter((item) => item.sufficientExpected === true).length,
    completeDraftsVerified: cases.filter((item) => item.completeDraftVerified).length,
    sufficientDraftsVerified: cases.filter(
      (item) => item.sufficientExpected === true && item.completeDraftVerified,
    ).length,
    blockingCases: cases.filter((item) => item.blockExpected === true).length,
    blockingVerified: cases.filter((item) => item.blockingVerified).length,
    observedMajorFalseStatements: cases.reduce(
      (total, item) => total + (item.majorFalseStatementsObserved ?? 0),
      0,
    ),
    majorFalsehoodsUnassessed: cases.filter(
      (item) =>
        !item.actualAiRecorded ||
        !item.answerKeyRecorded ||
        item.independentReviews !== 2 ||
        item.status === "review-disagreement",
    ).length,
    launchQualification: "not-assessed" as const,
    limitations: [
      "이 고정 세트는 개발 회귀에도 사용됩니다. 개발 사례와 독립된 검증 세트라는 확인이 필요합니다.",
      "현재 입력은 소프트웨어·신규 신청 중심입니다. 제조·서비스·재확인 및 오래된 공식 기준 사례의 범위를 추가 확인해야 합니다.",
      "담당자가 자료 충분성·중대 차단 기대를 정한 정답표를 기록하기 전에는 기대 동작을 확정하지 않습니다.",
      "실제 AI 실행 여부는 입력된 기록입니다. 이 모듈은 호출·요금·실행 증빙을 자동 확인하지 않습니다.",
      "단순 생성본 비교, 수정 전후 효과, 버전·공식 입력 일치, 실제 고객 시범 검증은 별도입니다.",
      "합성 사례 평가 기록은 실제 고객 품질, 무오류 서비스 또는 승인 가능성을 증명하지 않습니다.",
    ],
    evaluationNeeded: cases
      .filter((item) => item.status !== "passed")
      .map(({ fixtureId, status, needed }) => ({ fixtureId, status, needed })),
    cases,
  };
}
