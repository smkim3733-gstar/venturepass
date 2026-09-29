import { z } from "zod";
import { providerReviewInputSchema } from "./studio-plan-quality-provider-review-types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
export const providerPolicyAdoptionLimits = {
  records: 100,
  recordBytes: 2 * 1024 * 1024,
  knownNonces: 10000,
} as const;
export const providerPolicyAdoptionHeadSchema = z
  .object({
    revision: z.number().int().min(0).max(providerPolicyAdoptionLimits.records),
    headDigest: hash.nullable(),
  })
  .strict()
  .refine((value) => (value.revision === 0) === (value.headDigest === null));

/** Browser-safe command contract. No client price, configuration or execution grant is accepted. */
export const providerPolicyAdoptionCommandSchema = providerReviewInputSchema
  .extend({
    commandVersion: z.literal(1),
    kind: z.literal("adopt-provider-policy"),
    clientRequestId: uuid,
    expectedPolicyHead: providerPolicyAdoptionHeadSchema,
    approvedReviewDigest: hash,
    budgetAction: z.enum(["initialize-proposed-budget", "keep-existing-budget"]),
    /** A distinct operation nonce keeps the existing budget receipt contract unchanged. */
    initialBudgetRequestId: uuid.nullable(),
    approval: z
      .object({
        noticeVersion: z.literal(1),
        acknowledgedPolicy: z.literal(true),
        acknowledgedBudgetAction: z.literal(true),
        reservationAndTransmission: z.literal("separate-approval-required"),
        approvedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.budgetAction === "initialize-proposed-budget") !==
        (value.initialBudgetRequestId !== null) ||
      value.initialBudgetRequestId === value.clientRequestId
    )
      context.addIssue({
        code: "custom",
        message: "정책 채택과 초기 예산의 요청 번호를 확인해 주세요.",
      });
  });
export type ProviderPolicyAdoptionCommand = z.infer<typeof providerPolicyAdoptionCommandSchema>;
