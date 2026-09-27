import { z } from "zod";

const label = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const count = z.number().int().min(0).max(50);
const statuses = [
  "unevaluated",
  "assisted",
  "mock",
  "review-needed",
  "review-disagreement",
  "failed",
  "passed",
  "invalid",
] as const;
const status = z.enum(statuses);
const needed = z.array(z.string().min(1).max(200)).max(30);
const caseResult = z
  .object({
    fixtureId: label,
    status,
    needed,
    actualAiRecorded: z.boolean(),
    answerKeyRecorded: z.boolean(),
    independentReviews: z.number().int().min(0).max(2),
    disagreement: z.boolean(),
    sufficientExpected: z.boolean().nullable(),
    blockExpected: z.boolean().nullable(),
    completeDraftVerified: z.boolean(),
    blockingVerified: z.boolean(),
    majorFalseStatementsObserved: z.number().int().min(0).max(1000).nullable(),
  })
  .strict();

/** Validate informational server totals before using them in an operator-facing result screen. */
export const planQualitySummarySchema = z
  .object({
    scope: z.literal("fixed-synthetic-records-only"),
    fixtureCount: z.literal(50),
    minimum50CasesPresent: z.literal(true),
    counts: z
      .object({
        unevaluated: count,
        assisted: count,
        mock: count,
        "review-needed": count,
        "review-disagreement": count,
        failed: count,
        passed: count,
        invalid: count,
      })
      .strict(),
    invalidRecords: count,
    actualAiRecorded: count,
    answerKeysRecorded: count,
    reviewedByTwo: count,
    disagreements: count,
    sufficientCases: count,
    completeDraftsVerified: count,
    sufficientDraftsVerified: count,
    blockingCases: count,
    blockingVerified: count,
    observedMajorFalseStatements: z.number().int().min(0).max(50_000),
    majorFalsehoodsUnassessed: count,
    launchQualification: z.literal("not-assessed"),
    limitations: z.array(z.string().min(1).max(4000)).min(1).max(20),
    evaluationNeeded: z.array(z.object({ fixtureId: label, status, needed }).strict()).max(50),
    cases: z.array(caseResult).length(50),
  })
  .strict()
  .superRefine((value, context) => {
    const fail = (field: string) =>
      context.addIssue({
        code: "custom",
        path: [field],
        message: "평가 사례와 집계 기록이 일치하지 않습니다.",
      });
    if (new Set(value.cases.map((item) => item.fixtureId)).size !== 50) fail("cases");
    for (const key of statuses)
      if (value.counts[key] !== value.cases.filter((item) => item.status === key).length)
        fail("counts");
    const expected = {
      actualAiRecorded: value.cases.filter((item) => item.actualAiRecorded).length,
      answerKeysRecorded: value.cases.filter((item) => item.answerKeyRecorded).length,
      reviewedByTwo: value.cases.filter((item) => item.independentReviews === 2).length,
      disagreements: value.cases.filter((item) => item.disagreement).length,
      sufficientCases: value.cases.filter((item) => item.sufficientExpected === true).length,
      completeDraftsVerified: value.cases.filter((item) => item.completeDraftVerified).length,
      sufficientDraftsVerified: value.cases.filter(
        (item) => item.sufficientExpected === true && item.completeDraftVerified,
      ).length,
      blockingCases: value.cases.filter((item) => item.blockExpected === true).length,
      blockingVerified: value.cases.filter((item) => item.blockingVerified).length,
      observedMajorFalseStatements: value.cases.reduce(
        (sum, item) => sum + (item.majorFalseStatementsObserved ?? 0),
        0,
      ),
      majorFalsehoodsUnassessed: value.cases.filter(
        (item) =>
          !item.actualAiRecorded ||
          !item.answerKeyRecorded ||
          item.independentReviews !== 2 ||
          item.status === "review-disagreement",
      ).length,
    };
    for (const key of Object.keys(expected) as (keyof typeof expected)[])
      if (value[key] !== expected[key]) fail(key);
    const required = value.cases
      .filter((item) => item.status !== "passed")
      .map(({ fixtureId, status, needed }) => ({ fixtureId, status, needed }));
    if (JSON.stringify(required) !== JSON.stringify(value.evaluationNeeded))
      fail("evaluationNeeded");
    if (
      value.cases.some(
        (item) =>
          item.status === "passed" &&
          (!item.actualAiRecorded || !item.answerKeyRecorded || item.independentReviews !== 2),
      )
    )
      fail("cases");
  });
