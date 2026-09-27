import { z } from "zod";
import { planContentSchema } from "./studio-schema";

/** Shared browser-safe record contract; no execution, storage, or result inference. */
export const planQualityCriteria = [
  "technology-business-link",
  "specificity",
  "consistency",
  "evidence-fit",
  "explainability",
] as const;
export const planQualityCriterionLabels = {
  "technology-business-link": "기술·사업 연결",
  specificity: "구체성",
  consistency: "일관성",
  "evidence-fit": "근거 적합성",
  explainability: "실제 설명 가능성",
} as const;
const note = z.string().trim().min(1).max(4000);
const labelId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const criterion = z
  .object({ grade: z.enum(["met", "needs-improvement", "critical-unmet"]), basis: note })
  .strict();
const assessmentSchema = z
  .object({
    criteria: z
      .object({
        "technology-business-link": criterion,
        specificity: criterion,
        consistency: criterion,
        "evidence-fit": criterion,
        explainability: criterion,
      })
      .strict(),
    majorFalseStatements: z.number().int().min(0).max(1000),
    majorFalseStatementBasis: note,
    completeDraft: z.boolean(),
    unnecessaryDeferral: z.boolean(),
    blockingExpectationMet: z.boolean().nullable(),
    behaviorBasis: note,
  })
  .strict();
export const planQualityAnswerKeySchema = z
  .object({
    authorId: labelId,
    factsAndIssues: z.array(note).min(1).max(100),
    sufficientForCompleteDraft: z.boolean(),
    mustBlockSubmission: z.boolean(),
    rationale: note,
  })
  .strict();
export const planQualityExecutionSchema = z
  .object({
    executionId: labelId,
    mode: z.enum(["actual-ai", "assisted", "mock"]),
    provider: z.string().trim().min(1).max(100).nullable(),
    model: z.string().trim().min(1).max(200).nullable(),
    generatedAt: z.string().datetime(),
    inputDigest: digest,
    output: z
      .object({
        plan: planContentSchema.nullable(),
        disposition: z.enum([
          "complete-draft",
          "partial-draft",
          "request-evidence",
          "blocked",
          "failed",
        ]),
        submissionReadiness: z.enum(["ready", "blocked", "not-observed"]),
      })
      .strict(),
    outputDigest: digest,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "actual-ai" && (!value.provider || !value.model))
      context.addIssue({
        code: "custom",
        message: "실제 AI 실행은 제공자와 모델 기록이 필요합니다.",
      });
  });
const reviewBindingSchema = z
  .object({
    executionId: labelId,
    outputDigest: digest,
    answerKeyDigest: digest,
  })
  .strict();
export const planQualityHumanReviewSchema = reviewBindingSchema
  .extend({
    reviewerId: labelId,
    independent: z.literal(true),
    reviewedAt: z.string().datetime(),
    assessment: assessmentSchema,
  })
  .strict();
const resolutionSchema = reviewBindingSchema
  .extend({
    confirmedReviewerIds: z.array(labelId).length(2),
    resolvedAt: z.string().datetime(),
    basis: note,
    evidenceReferences: z.array(note).min(1).max(100),
    assessment: assessmentSchema,
  })
  .strict();
export const planQualityEvaluationSchema = z
  .object({
    schemaVersion: z.literal(1),
    fixtureId: labelId,
    sourceDigest: digest,
    candidateDigest: digest,
    inputPlanDigest: digest,
    rubricDigest: digest,
    answerKey: planQualityAnswerKeySchema.nullable(),
    execution: planQualityExecutionSchema.nullable(),
    humanReviews: z.array(planQualityHumanReviewSchema).max(2),
    resolution: resolutionSchema.nullable(),
  })
  .strict();
export type PlanQualityEvaluation = z.infer<typeof planQualityEvaluationSchema>;
export type PlanQualityExecution = z.infer<typeof planQualityExecutionSchema>;
export type PlanQualityAssessment = z.infer<typeof assessmentSchema>;
export type PlanQualityHumanReview = z.infer<typeof planQualityHumanReviewSchema>;
