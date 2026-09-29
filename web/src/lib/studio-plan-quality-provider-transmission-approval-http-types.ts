import { z } from "zod";
import { providerTransmissionCommandSchema } from "./studio-plan-quality-provider-transmission-command";
import { providerTransmissionReviewSchema } from "./studio-plan-quality-provider-transmission-review-types";

/** Separate from the 4KiB inspection request. No client-owned current archive/config/native payload. */
export const providerTransmissionApprovalHttpLimits = { bodyBytes: 128 * 1024 } as const;
export const providerTransmissionApprovalInputSchema = z
  .object({
    command: providerTransmissionCommandSchema,
    // Only an already committed exact-command replay can succeed without its review.
    approvedReview: providerTransmissionReviewSchema.nullable(),
  })
  .strict();
export type ProviderTransmissionApprovalInput = z.infer<
  typeof providerTransmissionApprovalInputSchema
>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nonce = z.string().uuid();
/** Historical approval receipt; never current run state or permission to send/reset a budget. */
export const providerTransmissionApprovalReceiptSchema = z
  .object({
    clientRequestId: nonce,
    commandDigest: hash,
    recordDigest: hash,
    approvedReviewDigest: hash,
    runId: nonce,
    runDigest: hash,
    executionInputDigest: hash,
    approvalEventDigest: hash,
    approvalRevision: z.literal(1),
    recordedAt: z.string().datetime(),
    dispatchAllowed: z.literal(false),
    budgetWriteAllowed: z.literal(false),
  })
  .strict();
export const providerTransmissionApprovalResponseSchema = z.discriminatedUnion("state", [
  z
    .object({
      responseVersion: z.literal(1),
      state: z.literal("committed"),
      delivery: z.enum(["new", "replay", "lookup"]),
      receipt: providerTransmissionApprovalReceiptSchema,
    })
    .strict(),
  z
    .object({
      responseVersion: z.literal(1),
      state: z.literal("not-observed"),
      clientRequestId: nonce,
      recovery: z.literal("replay-original-request"),
    })
    .strict(),
  z
    .object({
      // This attempt only; never settles an earlier attempt using this nonce.
      responseVersion: z.literal(1),
      state: z.literal("refused"),
      clientRequestId: nonce.nullable(),
      code: z.string(),
      error: z.string(),
    })
    .strict(),
  z
    .object({
      responseVersion: z.literal(1),
      state: z.literal("unknown"),
      clientRequestId: nonce.nullable(),
      code: z.literal("PROVIDER_TRANSMISSION_APPROVAL_OUTCOME_UNKNOWN"),
      error: z.string(),
      recovery: z.literal("lookup-or-replay-original-request"),
    })
    .strict(),
]);
export type ProviderTransmissionApprovalResponse = z.infer<
  typeof providerTransmissionApprovalResponseSchema
>;
