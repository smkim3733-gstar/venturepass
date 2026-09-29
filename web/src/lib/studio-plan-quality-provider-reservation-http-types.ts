import { z } from "zod";
import { providerReviewInputSchema } from "./studio-plan-quality-provider-review-types";
import { providerReservationReviewSchema } from "./studio-plan-quality-provider-reservation-review-types";
import { providerReservationCommandSchema } from "./studio-plan-quality-provider-reservation-command";

/** Browser-safe inspection envelope. No command or execution capability. */
export const providerReservationInspectionResponseSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        responseVersion: z.literal(1),
        status: z.literal("review"),
        selection: providerReviewInputSchema,
        review: providerReservationReviewSchema,
      })
      .strict(),
    z
      .object({
        responseVersion: z.literal(1),
        status: z.literal("unavailable"),
        selection: providerReviewInputSchema,
        reason: z.enum([
          "configuration-missing-or-invalid",
          "configuration-expired",
          "selection-invalid",
          "ledger-after-inspection",
        ]),
        review: z.null(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.status !== "review") return;
    const scope = value.review.policyReview.scope;
    if (
      scope.version !== value.selection.version ||
      scope.versionDigest !== value.selection.versionDigest ||
      scope.candidateId !== value.selection.candidateId
    )
      context.addIssue({ code: "custom", message: "예약 검토와 선택 후보가 일치하지 않습니다." });
  });
export type ProviderReservationInspectionResponse = z.infer<
  typeof providerReservationInspectionResponseSchema
>;

/** Separate consent/write envelope. A null review only supports an already committed replay. */
export const providerReservationHttpLimits = { bodyBytes: 64 * 1024 } as const;
export const providerReservationInputSchema = z
  .object({
    command: providerReservationCommandSchema,
    approvedReview: providerReservationReviewSchema.nullable(),
  })
  .strict();
export type ProviderReservationInput = z.infer<typeof providerReservationInputSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nonce = z.string().uuid();
/** Historical commit receipt, not a statement about the current run or permission to transmit. */
export const providerReservationReceiptSchema = z
  .object({
    clientRequestId: nonce,
    commandDigest: hash,
    recordDigest: hash,
    approvedReviewDigest: hash,
    runId: nonce,
    runDigest: hash,
    startInputDigest: hash,
    recordedAt: z.string().datetime(),
    dispatchAllowed: z.literal(false),
  })
  .strict();
export const providerReservationResponseSchema = z.discriminatedUnion("state", [
  z
    .object({
      responseVersion: z.literal(1),
      state: z.literal("committed"),
      delivery: z.enum(["new", "replay", "lookup"]),
      receipt: providerReservationReceiptSchema,
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
      // Describes this attempt only; does not settle an earlier attempt with the same nonce.
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
      code: z.literal("PROVIDER_RESERVATION_OUTCOME_UNKNOWN"),
      error: z.string(),
      recovery: z.literal("lookup-or-replay-original-request"),
    })
    .strict(),
]);
export type ProviderReservationResponse = z.infer<typeof providerReservationResponseSchema>;
