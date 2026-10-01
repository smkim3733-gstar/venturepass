import { z } from "zod";
import {
  providerReviewProposalViewSchema,
  versionedProviderReviewProposalViewSchema,
} from "./studio-plan-quality-provider-review-types";
import {
  providerPolicyBudgetHeadSchema,
  providerPolicyReviewSchema,
} from "./studio-plan-quality-provider-policy-review-types";
import {
  providerBudgetEventSchema,
  providerReceiptSchema,
} from "../../scripts/local-data-quality-provider.mjs";
import {
  providerPolicyAdoptionCommandSchema,
  providerPolicyAdoptionLimits,
} from "./studio-plan-quality-provider-policy-adoption-command";
export {
  providerPolicyAdoptionCommandSchema,
  providerPolicyAdoptionHeadSchema,
  providerPolicyAdoptionLimits,
  type ProviderPolicyAdoptionCommand,
} from "./studio-plan-quality-provider-policy-adoption-command";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const date = z.string().datetime();

/** Proposed immutable row only. Its presence in a write plan is not proof of a committed write. */
export const providerPolicyAdoptionRecordSchema = z
  .object({
    recordVersion: z.literal(1),
    kind: z.literal("provider-policy-adoption"),
    scopeId: z.literal("candidate-quality-provider-policy-live"),
    revision: z.number().int().min(1).max(providerPolicyAdoptionLimits.records),
    previousDigest: hash.nullable(),
    clientRequestId: uuid,
    requestDigest: hash,
    recordedAt: date,
    command: providerPolicyAdoptionCommandSchema,
    /** Frozen evidence: future audit must not substitute today's prompts or official configuration. */
    reviewedProposal: providerReviewProposalViewSchema,
    approvedReview: providerPolicyReviewSchema,
    budgetTransition: z
      .object({
        kind: z.enum(["initialize-proposed-budget", "keep-existing-budget"]),
        before: providerPolicyBudgetHeadSchema,
        after: providerPolicyBudgetHeadSchema,
        initializationRequestId: uuid.nullable(),
      })
      .strict(),
    reservationAllowed: z.literal(false),
    dispatchAllowed: z.literal(false),
    recordDigest: hash,
  })
  .strict();
export type ProviderPolicyAdoptionRecord = z.infer<typeof providerPolicyAdoptionRecordSchema>;
export const providerPolicyAdoptionWritePlanSchema = z
  .object({
    planVersion: z.literal(1),
    status: z.literal("prepared-not-committed"),
    transaction: z.literal("single-immediate-transaction-required"),
    record: providerPolicyAdoptionRecordSchema,
    initialization: z
      .object({ event: providerBudgetEventSchema, receipt: providerReceiptSchema })
      .strict()
      .nullable(),
  })
  .strict();
export type ProviderPolicyAdoptionWritePlan = z.infer<typeof providerPolicyAdoptionWritePlanSchema>;
export function providerPolicyAdoptionRecordDigestInput(
  value:
    Omit<StoredProviderPolicyAdoptionRecord, "recordDigest"> | StoredProviderPolicyAdoptionRecord,
) {
  const { recordDigest: _ignored, ...body } = value as StoredProviderPolicyAdoptionRecord;
  void _ignored;
  return body;
}

export const versionedProviderPolicyAdoptionRecordSchema =
  providerPolicyAdoptionRecordSchema.extend({
    recordVersion: z.literal(2),
    reviewedProposal: versionedProviderReviewProposalViewSchema,
  });
export type VersionedProviderPolicyAdoptionRecord = z.infer<
  typeof versionedProviderPolicyAdoptionRecordSchema
>;
export type StoredProviderPolicyAdoptionRecord =
  ProviderPolicyAdoptionRecord | VersionedProviderPolicyAdoptionRecord;
export const versionedProviderPolicyAdoptionWritePlanSchema =
  providerPolicyAdoptionWritePlanSchema.extend({
    planVersion: z.literal(2),
    record: versionedProviderPolicyAdoptionRecordSchema,
  });
export type VersionedProviderPolicyAdoptionWritePlan = z.infer<
  typeof versionedProviderPolicyAdoptionWritePlanSchema
>;
