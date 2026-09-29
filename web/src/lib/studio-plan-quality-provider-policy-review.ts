import { z } from "zod";
import type { CandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry-types";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import {
  createProviderConfigurationProposalView,
  getProviderConfigurationExpiry,
} from "./studio-plan-quality-provider-configuration";
import {
  providerBudgetEventSchema,
  validateProviderBudgetLedger,
} from "../../scripts/local-data-quality-provider.mjs";
import {
  assessProviderPolicyBudget,
  providerPolicyBudgetHeadSchema,
  providerPolicyReviewDigestInput,
  providerPolicyReviewLifetimeMs,
  providerPolicyReviewNotice,
  providerPolicyReviewSchema,
  type ProviderPolicyReview,
} from "./studio-plan-quality-provider-policy-review-types";

export type ProviderPolicyReviewInput = {
  registry: CandidateRegistrySnapshot;
  candidateId: string;
  inspectedAt: string;
  configuration: unknown;
  /**
   * Production events and head from one fully inspected store transaction, never client claims.
   * This module checks the budget chain; the store must also validate its run/receipt evidence.
   */
  budgetEvents: unknown;
  expectedBudgetHead: unknown;
};
export type ProviderPolicyReviewResult =
  | { status: "review"; review: ProviderPolicyReview }
  | {
      status: "unavailable";
      reason:
        | "inspection-invalid"
        | "configuration-missing-or-invalid"
        | "configuration-expired"
        | "budget-invalid"
        | "budget-head-changed"
        | "budget-event-after-inspection";
      review: null;
    };
const unavailable = (
  reason: Extract<ProviderPolicyReviewResult, { status: "unavailable" }>["reason"],
): ProviderPolicyReviewResult => ({ status: "unavailable", reason, review: null });

/** Pure inspection only. A hash binds this review; it does not authenticate client-supplied evidence. */
export function createProviderPolicyReview(
  input: ProviderPolicyReviewInput,
): ProviderPolicyReviewResult {
  if (!z.string().datetime().safeParse(input.inspectedAt).success)
    return unavailable("inspection-invalid");
  const inspectedAt = new Date(input.inspectedAt).toISOString();
  const proposalInput = { ...input, inspectedAt };
  const proposal = createProviderConfigurationProposalView(proposalInput);
  if (!proposal)
    return unavailable(
      getProviderConfigurationExpiry(proposalInput)
        ? "configuration-expired"
        : "configuration-missing-or-invalid",
    );
  const parsedEvents = z.array(providerBudgetEventSchema).max(1000).safeParse(input.budgetEvents);
  const parsedHead = providerPolicyBudgetHeadSchema.safeParse(input.expectedBudgetHead);
  if (!parsedEvents.success || !parsedHead.success) return unavailable("budget-invalid");
  const events = parsedEvents.data;
  let snapshot;
  try {
    snapshot = validateProviderBudgetLedger(events, "candidate-quality-provider-v2-live");
  } catch {
    return unavailable("budget-invalid");
  }
  if (
    snapshot.revision !== parsedHead.data.revision ||
    snapshot.headDigest !== parsedHead.data.headDigest
  )
    return unavailable("budget-head-changed");
  if (events.some((event) => Date.parse(event.recordedAt) > Date.parse(inspectedAt)))
    return unavailable("budget-event-after-inspection");
  const budget = {
    scopeId: "candidate-quality-provider-v2-live" as const,
    revision: snapshot.revision,
    headDigest: snapshot.headDigest,
    currency: snapshot.currency,
    unitScale: snapshot.unitScale,
    capUnits: snapshot.capUnits,
    heldUnits: snapshot.heldUnits,
    recognizedUnits: snapshot.recognizedUnits,
    availableUnits: snapshot.availableUnits,
    deficitUnits: "deficitUnits" in snapshot ? snapshot.deficitUnits : "0",
    boundBreached: "boundBreached" in snapshot ? snapshot.boundBreached : false,
  };
  const costs = proposal.financialBasis.costs;
  const reservation = {
    generationUnits: costs.generation.totalUnits,
    reviewUnits: costs.review.totalUnits,
    totalUnits: costs.totalUnits,
  };
  const value: Omit<ProviderPolicyReview, "reviewDigest"> = {
    schemaVersion: 1,
    kind: "provider-policy-review",
    environment: "production",
    inputProvenance: "registered-synthetic-candidate",
    scope: proposal.scope,
    inspectedAt,
    expiresAt: new Date(
      Math.min(
        Date.parse(inspectedAt) + providerPolicyReviewLifetimeMs,
        ...proposal.proposal.sources.map((source) => Date.parse(source.validUntil)),
      ),
    ).toISOString(),
    bindings: {
      configurationDigest: proposal.proposal.configurationDigest,
      requestReviewDigest: digest(proposal.proposal.requestReview),
      financialBasisDigest: digest(proposal.financialBasis),
      retentionDigest: digest(proposal.retention),
      usagePolicyDigest: digest(proposal.proposal.usagePolicy),
      model: proposal.model,
    },
    budget,
    proposedBudget: proposal.proposal.proposedBudget,
    reservation,
    assessment: assessProviderPolicyBudget(
      budget,
      proposal.proposal.proposedBudget,
      reservation.totalUnits,
    ),
    accountAccess: "not-checked",
    actions: {
      policyAdoptionAllowed: false,
      budgetWriteAllowed: false,
      reservationAllowed: false,
      dispatchAllowed: false,
    },
    notice: providerPolicyReviewNotice,
  };
  const parsed = providerPolicyReviewSchema.safeParse({ ...value, reviewDigest: digest(value) });
  return parsed.success ? { status: "review", review: parsed.data } : unavailable("budget-invalid");
}

/** Recompute against current server evidence. Even a current review grants no action capability. */
export function isProviderPolicyReviewCurrent(
  value: unknown,
  current: ProviderPolicyReviewInput,
): boolean {
  const parsed = providerPolicyReviewSchema.safeParse(value);
  if (!parsed.success || !z.string().datetime().safeParse(current.inspectedAt).success)
    return false;
  const review = parsed.data;
  const now = Date.parse(current.inspectedAt);
  if (
    now < Date.parse(review.inspectedAt) ||
    now >= Date.parse(review.expiresAt) ||
    review.reviewDigest !== digest(providerPolicyReviewDigestInput(review))
  )
    return false;
  const rebuilt = createProviderPolicyReview({ ...current, inspectedAt: review.inspectedAt });
  return rebuilt.status === "review" && rebuilt.review.reviewDigest === review.reviewDigest;
}
