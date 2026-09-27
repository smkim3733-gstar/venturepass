import { z } from "zod";

const uuid = z.string().uuid();
const revision = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_GUIDED_ATTEMPTS_PER_SCOPE = 3;
export const guidedPreparationApprovalSchema = z
  .object({
    caseId: uuid,
    revision,
    provider: z.literal("OpenAI"),
    model: z.string().min(1).max(200),
    inputFingerprint: hash,
    sourceIds: z.array(uuid).max(40),
    sourceNames: z.array(z.string().max(300)).max(40),
    profileIncluded: z.literal(true),
    businessNumberIncluded: z.literal(false),
    originalFilesIncluded: z.literal(false),
    derivedDraftIncluded: z.literal(true),
    purpose: z.literal("analysis-plan-review"),
    // Missing on earlier approvals means no automatic repair; never default consent forward.
    autoRevisionLimit: z.literal(1).optional(),
  })
  .strict();
export type GuidedPreparationApproval = z.infer<typeof guidedPreparationApprovalSchema>;
export const guidedPreparationRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("restart"),
      revision,
      clientRequestId: uuid,
      approval: guidedPreparationApprovalSchema,
      approved: z.literal(true),
      previousRunId: uuid,
      acknowledgedPreviousAttempt: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("start"),
      revision,
      clientRequestId: uuid,
      approval: guidedPreparationApprovalSchema,
      approved: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("continue"),
      revision,
      clientRequestId: uuid,
      runId: uuid,
    })
    .strict(),
]);
export type GuidedPreparationRequest = z.infer<typeof guidedPreparationRequestSchema>;
export const guidedPlanRepairSchema = z
  .object({
    initialPlanId: uuid,
    finalPlanId: uuid.nullable(),
    status: z.enum(["pending", "not-needed", "applied", "unresolved", "rejected", "failed"]),
    attempted: z.boolean(),
    reason: z.string().max(1000),
    initialReviewCount: z.number().int().nonnegative().max(200),
    finalReviewCount: z.number().int().nonnegative().max(200).nullable(),
    attemptedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();
export type GuidedPlanRepair = z.infer<typeof guidedPlanRepairSchema>;
export const guidedPreparationRunSchema = z
  .object({
    id: uuid,
    retryOfId: uuid.nullable().optional(),
    mode: z.literal("ai"),
    approval: guidedPreparationApprovalSchema,
    approvedAt: z.string().datetime(),
    status: z.enum([
      "running",
      "awaiting_choice",
      "awaiting_materials",
      "awaiting_review",
      "failed",
    ]),
    phase: z.enum(["analysis", "plan"]),
    analysisDigest: hash.nullable(),
    candidateId: z.string().min(1).max(300).nullable(),
    candidateDigest: hash.nullable(),
    planId: uuid.nullable(),
    code: z.string().max(100).nullable(),
    repair: guidedPlanRepairSchema.optional(),
    requests: z
      .array(z.object({ clientRequestId: uuid, digest: hash }).strict())
      .min(1)
      .max(20),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type GuidedPreparationRun = z.infer<typeof guidedPreparationRunSchema>;

/** A linked, explicitly acknowledged restart preserves the old attempt without treating it as a current worker. */
export function unresolvedGuidedPreparationRuns(runs: GuidedPreparationRun[] = []) {
  const followed = new Set(runs.map((run) => run.retryOfId).filter(Boolean));
  return runs.filter((run) => run.status === "running" && !followed.has(run.id));
}
