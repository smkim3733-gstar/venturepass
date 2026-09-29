import { z } from "zod";
import {
  providerPolicyAdoptionCommandSchema,
  providerPolicyAdoptionHeadSchema,
  providerPolicyAdoptionLimits,
} from "./studio-plan-quality-provider-policy-adoption-command";
import {
  providerPolicyBudgetHeadSchema,
  providerPolicyReviewSchema,
} from "./studio-plan-quality-provider-policy-review-types";
import {
  providerPolicyViewSchema,
  providerReviewResponseSchema,
} from "./studio-plan-quality-provider-policy-view-types";

/** Browser-safe HTTP contracts. Frozen v1 review/record and v1–v4 inspection formats stay unchanged. */
export const providerPolicyHttpLimits = { bodyBytes: 64 * 1024 } as const;
export const providerPolicyInspectionSchema = z
  .object(providerPolicyViewSchema.shape)
  .extend({ viewVersion: z.literal(5), policyHead: providerPolicyAdoptionHeadSchema })
  .strict()
  .superRefine((value, context) => {
    const { policyHead: _head, ...review } = value;
    void _head;
    if (!providerPolicyViewSchema.safeParse({ ...review, viewVersion: 4 }).success)
      context.addIssue({ code: "custom", message: "정책 검토 안내가 일치하지 않습니다." });
  });
export const providerPolicyInspectionResponseSchema = z.union([
  providerPolicyInspectionSchema,
  providerReviewResponseSchema,
]);
export type ProviderPolicyInspectionResponse = z.infer<
  typeof providerPolicyInspectionResponseSchema
>;
export type ProviderPolicyInspection = z.infer<typeof providerPolicyInspectionSchema>;
export const providerPolicyAdoptionInputSchema = z
  .object({
    command: providerPolicyAdoptionCommandSchema,
    // Null supports replay of an already committed command; fresh requests still require review.
    approvedReview: providerPolicyReviewSchema.nullable(),
  })
  .strict();
export type ProviderPolicyAdoptionInput = z.infer<typeof providerPolicyAdoptionInputSchema>;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const nonce = z.string().uuid();
export const providerPolicyAdoptionReceiptSchema = z
  .object({
    clientRequestId: nonce,
    requestDigest: hash,
    recordDigest: hash,
    revision: z.number().int().min(1).max(providerPolicyAdoptionLimits.records),
    recordedAt: z.string().datetime(),
    approvedReviewDigest: hash,
    budgetTransition: z
      .object({
        kind: z.enum(["initialize-proposed-budget", "keep-existing-budget"]),
        before: providerPolicyBudgetHeadSchema,
        after: providerPolicyBudgetHeadSchema,
        initializationRequestId: nonce.nullable(),
      })
      .strict(),
    reservationAllowed: z.literal(false),
    dispatchAllowed: z.literal(false),
  })
  .strict();
export const providerPolicyAdoptionResponseSchema = z.discriminatedUnion("state", [
  z
    .object({
      responseVersion: z.literal(1),
      state: z.literal("committed"),
      delivery: z.enum(["new", "replay", "lookup"]),
      receipt: providerPolicyAdoptionReceiptSchema,
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
      responseVersion: z.literal(1),
      // Refusal describes this attempt, not the outcome of any earlier request with this nonce.
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
      code: z.literal("PROVIDER_POLICY_OUTCOME_UNKNOWN"),
      error: z.string(),
      recovery: z.literal("lookup-or-replay-original-request"),
    })
    .strict(),
]);
export type ProviderPolicyAdoptionResponse = z.infer<typeof providerPolicyAdoptionResponseSchema>;
