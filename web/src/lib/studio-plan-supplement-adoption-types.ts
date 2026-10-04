import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().safe();
export const planSupplementAdoptionSelectionSchema = z
  .object({
    caseId: z.string().uuid(),
    revision,
    executionId: z.string().uuid(),
    executionCommandSha256: hash,
    captureSha256: hash,
    proposalSha256: hash,
    comparisonSha256: hash,
  })
  .strict();
export const planSupplementAdoptionCommandSchema = planSupplementAdoptionSelectionSchema
  .extend({
    action: z.literal("adopt-section-supplement"),
    clientRequestId: z.string().uuid(),
    confirmed: z.literal(true),
  })
  .strict();
export type PlanSupplementAdoptionCommand = z.infer<typeof planSupplementAdoptionCommandSchema>;
export const planSupplementAdoptionReceiptSchema = z
  .object({
    id: z.string().uuid(),
    command: planSupplementAdoptionCommandSchema,
    commandSha256: hash,
    savedRevision: revision,
    planId: z.string().uuid(),
    planVersion: z.number().int().positive().safe(),
    planIdentitySha256: hash,
    basePlanIdentitySha256: hash,
    recordedAt: z.string().datetime(),
  })
  .strict()
  .refine((value) => value.savedRevision === value.command.revision + 1);
export type PlanSupplementAdoptionReceipt = z.infer<typeof planSupplementAdoptionReceiptSchema>;
export const planSupplementAdoptionApiSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("prepare-adoption"), revision, executionId: z.string().uuid() })
    .strict(),
  z
    .object({ action: z.literal("inspect-adoption"), command: planSupplementAdoptionCommandSchema })
    .strict(),
  planSupplementAdoptionCommandSchema,
]);

// A local read disposition. It grants no write or transmission rights.
export const planSupplementAdoptionInspectionSchema = z
  .object({
    format: z.literal("supplement-adoption-inspection-v1"),
    caseId: z.string().uuid(),
    revision,
    command: planSupplementAdoptionCommandSchema,
    commandSha256: hash,
    state: z.enum(["adopted", "not-adopted-stale", "unconfirmed"]),
    receipt: planSupplementAdoptionReceiptSchema.nullable(),
    canClose: z.boolean(),
    databaseChanged: z.literal(false),
    transmissionAllowed: z.literal(false),
  })
  .strict()
  .refine(
    (value) =>
      value.caseId === value.command.caseId &&
      (value.state === "adopted"
        ? value.receipt !== null && !value.canClose
        : value.receipt === null && value.canClose === (value.state === "not-adopted-stale")) &&
      (value.canClose ? value.revision > value.command.revision : true),
  );
export type PlanSupplementAdoptionInspection = z.infer<
  typeof planSupplementAdoptionInspectionSchema
>;
