import { z } from "zod";
import {
  providerReviewProposalViewSchema,
  providerReviewViewSchema,
  providerProposalBlockerMessages,
} from "./studio-plan-quality-provider-review-types";
import { providerPolicyReviewSchema } from "./studio-plan-quality-provider-policy-review-types";

export const providerPolicyViewBlockerCodes = [
  "CONFIGURATION_NOT_ADOPTED",
  "ACCOUNT_ACCESS_NOT_CHECKED",
  "PRODUCTION_EXECUTION_DISABLED",
] as const;
export const providerPolicyViewSchema = z
  .object(providerReviewProposalViewSchema.shape)
  .extend({
    viewVersion: z.literal(4),
    policyReview: providerPolicyReviewSchema,
    blockers: z
      .array(
        z
          .object({
            code: z.enum(providerPolicyViewBlockerCodes),
            message: z.string(),
          })
          .strict(),
      )
      .length(providerPolicyViewBlockerCodes.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.blockers.some(
        (item, i) =>
          item.code !== providerPolicyViewBlockerCodes[i] ||
          item.message !== providerProposalBlockerMessages[item.code],
      )
    )
      context.addIssue({ code: "custom", message: "정책 검토 안내가 일치하지 않습니다." });
  });

/** Legacy v1/v2/v3 archives remain readable; new live proposals include a verified budget review. */
export const providerReviewResponseSchema = z.union([
  providerReviewViewSchema,
  providerPolicyViewSchema,
]);
export type ProviderPolicyView = z.infer<typeof providerPolicyViewSchema>;
export type ProviderReviewResponse = z.infer<typeof providerReviewResponseSchema>;
