import { z } from "zod";
import { providerPolicyAdoptionHeadSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { providerTransmissionReviewInputSchema } from "./studio-plan-quality-provider-transmission-review-types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Browser-safe first-transmission consent. The server owns the manifest, expiry and native rows. */
export const providerTransmissionCommandSchema = providerTransmissionReviewInputSchema
  .extend({
    commandVersion: z.literal(1),
    kind: z.literal("approve-provider-transmission"),
    clientRequestId: z.string().uuid(),
    approvedReviewDigest: hash,
    expectedArchiveDigest: hash,
    expectedCoverageDigest: hash,
    expectedReservationBindingDigest: hash,
    expectedManifestDigest: hash,
    expectedRun: z.object({ revision: z.literal(0), snapshotDigest: hash }).strict(),
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
        revision: z.number().int().min(1).max(1000),
        headDigest: hash,
      })
      .strict(),
    approval: z
      .object({
        noticeVersion: z.literal(1),
        acknowledgedExternalTransmission: z.literal(true),
        acknowledgedGenerationAndDerivedReview: z.literal(true),
        acknowledgedRetentionNoticeDigest: hash,
        acknowledgedFinancialReservationNotTokenFit: z.literal(true),
        acknowledgedUnknownCostHoldAndNoRetry: z.literal(true),
        acknowledgedCurrentPolicyAndBudget: z.literal(true),
        approvedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const reference = value.expectedPolicyReference;
    if (
      reference.revision > value.expectedPolicyHead.revision ||
      (reference.revision === value.expectedPolicyHead.revision &&
        reference.recordDigest !== value.expectedPolicyHead.headDigest)
    )
      context.addIssue({ code: "custom", message: "전송 확인의 정책 기준이 일치하지 않습니다." });
  });
export type ProviderTransmissionCommand = z.infer<typeof providerTransmissionCommandSchema>;
