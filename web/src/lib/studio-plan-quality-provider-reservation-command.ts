import { z } from "zod";
import { providerReviewInputSchema } from "./studio-plan-quality-provider-review-types";
import { providerPolicyAdoptionHeadSchema } from "./studio-plan-quality-provider-policy-adoption-command";

const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** Browser-safe consent only. Prices, preparation, configuration and grants belong to the server. */
export const providerReservationCommandSchema = providerReviewInputSchema
  .extend({
    commandVersion: z.literal(1),
    kind: z.literal("reserve-provider-candidate"),
    clientRequestId: z.string().uuid(),
    approvedReviewDigest: hash,
    expectedLedgerDigest: hash,
    expectedPolicyHead: providerPolicyAdoptionHeadSchema,
    expectedPolicyReference: z
      .object({
        revision: z.number().int().min(1).max(100),
        recordDigest: hash,
        clientRequestId: z.string().uuid(),
        recordedAt: z.string().datetime(),
      })
      .strict(),
    expectedBudgetHead: z
      .object({
        revision: z.number().int().min(1).max(999),
        headDigest: hash,
      })
      .strict(),
    expectedGlobalRunCount: z.number().int().min(0).max(19),
    expectedProductionRunCount: z.number().int().min(0).max(19),
    approval: z
      .object({
        noticeVersion: z.literal(1),
        acknowledgedCandidate: z.literal(true),
        acknowledgedCurrentBudget: z.literal(true),
        acknowledgedReservationOnly: z.literal(true),
        acknowledgedFinancialBasisNotTokenFit: z.literal(true),
        acknowledgedRetention: z.literal(true),
        acknowledgedNoAutomaticRetry: z.literal(true),
        transmission: z.literal("separate-approval-required"),
        approvedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const reference = value.expectedPolicyReference;
    if (
      value.expectedProductionRunCount > value.expectedGlobalRunCount ||
      reference.revision > value.expectedPolicyHead.revision ||
      (reference.revision === value.expectedPolicyHead.revision &&
        reference.recordDigest !== value.expectedPolicyHead.headDigest)
    )
      context.addIssue({
        code: "custom",
        message: "예약 확인의 정책·실행 기준이 일치하지 않습니다.",
      });
  });

export type ProviderReservationCommand = z.infer<typeof providerReservationCommandSchema>;
