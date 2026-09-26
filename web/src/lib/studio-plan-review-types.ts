import { z } from "zod";
import type { BusinessPlan } from "./studio-schema";

export const planReviewLimits = {
  records: 200,
  characters: 300_000,
  requestBytes: 64 * 1024,
} as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().safe();

// Kept independent of studio-schema's runtime imports for browser consumers.
export const planReviewFindingSchema = z
  .object({
    id: z.string().min(1).max(200),
    severity: z.enum(["error", "warning", "info"]),
    category: z.string().max(200),
    message: z.string().max(3000),
    action: z.string().max(3000),
    sectionKey: z.string().max(200).nullable(),
    sourceIds: z.array(z.string().max(200)).max(40),
  })
  .strict();
export const planReviewStatusLabels = {
  pending: "확인 필요",
  resolved: "담당자 해결 판단",
  deferred: "보류",
} as const;
export const planReviewDecisionInputSchema = z
  .object({
    planId: z.string().uuid(),
    planVersion: z.number().int().positive().safe(),
    findingIndex: z.number().int().nonnegative().max(199),
    finding: planReviewFindingSchema,
    previousRecordId: z.string().uuid().nullable(),
    status: z.enum(["pending", "resolved", "deferred"]),
    reason: z.string().trim().min(1).max(3000),
    reviewer: z.string().trim().min(1).max(100),
  })
  .strict();
export type PlanReviewDecisionInput = z.infer<typeof planReviewDecisionInputSchema>;
export const planReviewStaleReasonSchema = z.enum([
  "plan-missing",
  "plan-changed",
  "finding-changed",
  "evidence-changed",
  "plan-evidence-outdated",
]);
export type PlanReviewStaleReason = z.infer<typeof planReviewStaleReasonSchema>;
export const planReviewStaleReasonLabels: Record<PlanReviewStaleReason, string> = {
  "plan-missing": "연결 원고를 찾을 수 없습니다.",
  "plan-changed": "연결 원고 내용 또는 버전이 달라졌습니다.",
  "finding-changed": "연결한 검토 의견이 달라졌습니다.",
  "evidence-changed": "검토 당시 등록 자료 또는 근거 버전이 달라졌습니다.",
  "plan-evidence-outdated": "이 원고가 최신 근거를 반영했는지 다시 확인해야 합니다.",
};
export const planReviewDecisionSchema = planReviewDecisionInputSchema
  .extend({
    id: z.string().uuid(),
    rootId: z.string().uuid(),
    version: z.number().int().min(1).max(planReviewLimits.records),
    clientRequestId: z.string().uuid(),
    inputDigest: sha,
    recordedAt: z.string().datetime(),
    origin: z.literal("manual"),
    reviewKey: sha,
    planContentSha256: sha,
    findingSha256: sha,
    planSourceRevision: revision,
    evidenceRevision: revision,
    evidenceFingerprint: sha,
    // Derived on every server read/update. The recorded judgement is never rewritten.
    stale: z.boolean().default(true),
    staleReasons: z.array(planReviewStaleReasonSchema).max(5).default([]),
  })
  .strict();
export type PlanReviewDecision = z.infer<typeof planReviewDecisionSchema>;
export const appendPlanReviewMutationSchema = z
  .object({
    action: z.literal("append-plan-review"),
    revision,
    clientRequestId: z.string().uuid(),
    decision: planReviewDecisionInputSchema,
  })
  .strict();

/** Display selection only; the server checks content hashes and current evidence again. */
export function latestPlanReviewDecision(
  records: PlanReviewDecision[],
  plan: Pick<BusinessPlan, "id" | "version" | "review">,
  findingIndex: number,
): PlanReviewDecision | null {
  const finding = plan.review[findingIndex];
  if (!finding) return null;
  const canonical = planReviewFindingSchema.safeParse(finding);
  if (!canonical.success) return null;
  return (
    records
      .filter(
        (entry) =>
          entry.planId === plan.id &&
          entry.planVersion === plan.version &&
          entry.findingIndex === findingIndex &&
          JSON.stringify(entry.finding) === JSON.stringify(canonical.data),
      )
      .at(-1) ?? null
  );
}
