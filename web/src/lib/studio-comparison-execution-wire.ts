import { z } from "zod";

export const comparisonPostcaptureOperationSchema = z.enum(["record-result", "settle-finalize"]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const operationState = z.enum(["unattempted", "recovery-required", "stored", "blocked"]);
/** Display only: raw captures, SQL commands, policies and financial heads stay on the server. */
export const comparisonPostcaptureDisplaySchema = z
  .object({
    record: operationState,
    settlement: operationState,
    review: z
      .object({
        reviewDigest: hash,
        comparisonState: z.string().min(1).max(80),
        comparisonRecorded: z.boolean(),
        costSettled: z.boolean(),
        finalized: z.boolean(),
        usageStatus: z.enum(["known", "unknown"]),
        units: z
          .string()
          .regex(/^(0|[1-9][0-9]{0,29})$/)
          .nullable(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        unitScale: z.number().int().min(0).max(12),
        hasPolicyViolations: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** Confirmation never supplies time, policy, company data, budget heads or credentials. */
export const comparisonExecutionConsentSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
    externalTransmissionAcknowledged: z.literal(true),
    comparisonPurposeAcknowledged: z.literal(true),
    singleCallAcknowledged: z.literal(true),
    noAutomaticRetryAcknowledged: z.literal(true),
    unknownCostHoldAcknowledged: z.literal(true),
    noResendAcknowledged: z.literal(true),
    localRetentionAcknowledged: z.literal(true),
  })
  .strict();

export const comparisonExecutionActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("open"),
      companyRevision: z.number().int().nonnegative().safe(),
      clientRequestId: z.string().uuid(),
    })
    .strict(),
  z.object({ action: z.literal("preview") }).strict(),
  z.object({ action: z.literal("inspect") }).strict(),
  z.object({ action: z.literal("recover") }).strict(),
  z.object({ action: z.literal("close") }).strict(),
  z.object({ action: z.literal("postcapture-preview") }).strict(),
  z.object({ action: z.literal("record-result"), reviewDigest: hash }).strict(),
  z.object({ action: z.literal("settle-finalize"), reviewDigest: hash }).strict(),
  z
    .object({
      action: z.literal("recover-postcapture"),
      operation: comparisonPostcaptureOperationSchema,
    })
    .strict(),
  z.object({ action: z.literal("execute"), consent: comparisonExecutionConsentSchema }).strict(),
]);
export const comparisonExecutionSessionHeader = "x-venturepass-comparison-session";
