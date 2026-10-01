import { createVersionedProviderPreparationBuilder } from "./studio-plan-quality-provider-core";
import { z } from "zod";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import {
  createProviderConfigurationProposalView,
  createVersionedProviderConfigurationProposalView,
} from "./studio-plan-quality-provider-configuration";
import {
  isProviderPolicyReviewCurrent,
  isVersionedProviderPolicyReviewCurrent,
  type ProviderPolicyReviewInput,
} from "./studio-plan-quality-provider-policy-review";
import {
  providerPolicyReviewSchema,
  providerPolicyReviewDigestInput,
  providerPolicyReviewLifetimeMs,
  type ProviderPolicyReview,
} from "./studio-plan-quality-provider-policy-review-types";
import { providerReviewDigestInput } from "./studio-plan-quality-provider-review-types";
import {
  validateProviderPolicyAdoptionRecord,
  validateVersionedProviderPolicyAdoptionRecord,
} from "../../scripts/local-data-quality-provider-policy.mjs";
import {
  createProviderBudgetEvent,
  createProviderReceipt,
  providerPolicyDigestInput,
} from "../../scripts/local-data-quality-provider.mjs";
import {
  providerPolicyAdoptionCommandSchema,
  providerPolicyAdoptionHeadSchema,
  providerPolicyAdoptionLimits,
  providerPolicyAdoptionRecordSchema,
  providerPolicyAdoptionRecordDigestInput,
  providerPolicyAdoptionWritePlanSchema,
  versionedProviderPolicyAdoptionWritePlanSchema,
  type VersionedProviderPolicyAdoptionRecord,
  type VersionedProviderPolicyAdoptionWritePlan,
  type ProviderPolicyAdoptionCommand,
  type ProviderPolicyAdoptionRecord,
  type ProviderPolicyAdoptionWritePlan,
} from "./studio-plan-quality-provider-policy-adoption-types";

const same = (a: unknown, b: unknown) => digest(a) === digest(b);
/** Unlike expiry or a missing receipt, this ordering can never have authorized a commit. */
export function isProviderPolicyApprovalBeforeReview(
  command: Pick<ProviderPolicyAdoptionCommand, "approval">,
  review: Pick<ProviderPolicyReview, "inspectedAt">,
) {
  return Date.parse(command.approval.approvedAt) < Date.parse(review.inspectedAt);
}
export function providerPolicyAdoptionRequestDigest(raw: unknown): string {
  return digest(providerPolicyAdoptionCommandSchema.parse(raw));
}
type Refusal =
  | "invalid-input"
  | "scope-changed"
  | "review-not-current"
  | "approval-time-invalid"
  | "policy-head-changed"
  | "policy-limit"
  | "nonce-conflict"
  | "budget-action-mismatch"
  | "budget-incompatible"
  | "archive-proof-invalid"
  | "record-too-large";
export type ProviderPolicyAdoptionPlanResult =
  | { status: "prepared"; plan: ProviderPolicyAdoptionWritePlan }
  | { status: "refused"; reason: Refusal; plan: null };
const refuse = (reason: Refusal): ProviderPolicyAdoptionPlanResult => ({
  status: "refused",
  reason,
  plan: null,
});
export type ProviderPolicyAdoptionPlannerInput = {
  command: unknown;
  review: unknown;
  /** Server-owned configuration, registry and complete-ledger evidence from the write transaction. */
  current: ProviderPolicyReviewInput;
  /** Fully inspected adoption head and all operation nonces, from that same transaction. */
  currentPolicyHead: unknown;
  usedRequestIds: unknown;
};

function initializationFor(
  command: ProviderPolicyAdoptionCommand,
  review: ProviderPolicyReview,
  recordedAt: string,
) {
  if (command.initialBudgetRequestId === null) throw new Error("Initial budget nonce required");
  const policy = {
    environment: "production" as const,
    provenance: "explicit-user" as const,
    currency: review.proposedBudget.currency,
    unitScale: review.proposedBudget.unitScale,
    capUnits: review.proposedBudget.capUnits,
  };
  const event = createProviderBudgetEvent({
    schemaVersion: 2,
    scopeId: "candidate-quality-provider-v2-live",
    environment: policy.environment,
    provenance: policy.provenance,
    revision: 1,
    previousDigest: null,
    eventId: command.initialBudgetRequestId,
    recordedAt,
    currency: policy.currency,
    unitScale: policy.unitScale,
    payload: { kind: "configure", capUnits: policy.capUnits },
  });
  const receipt = createProviderReceipt({
    schemaVersion: 2,
    scopeId: event.scopeId,
    kind: "provider-budget-configure",
    clientRequestId: event.eventId,
    inputDigest: digest(
      providerPolicyDigestInput({ clientRequestId: event.eventId, expectedRevision: 0, policy }),
    ),
    runId: null,
    runRevision: null,
    budgetRevision: 1,
    operationDigest: event.eventDigest,
    recordedAt: event.recordedAt,
  });
  return { event, receipt };
}

/** Pure pre-write planning. Caller must commit all rows atomically; this performs no storage or IO. */
export function prepareProviderPolicyAdoption(
  input: ProviderPolicyAdoptionPlannerInput,
): ProviderPolicyAdoptionPlanResult {
  return prepareAdoption(input, null) as ProviderPolicyAdoptionPlanResult;
}
export type VersionedProviderPolicyAdoptionPlanResult =
  | { status: "prepared"; plan: VersionedProviderPolicyAdoptionWritePlan }
  | Extract<ProviderPolicyAdoptionPlanResult, { status: "refused" }>;
export function prepareVersionedProviderPolicyAdoption(
  version: PlanPromptVersion,
  input: ProviderPolicyAdoptionPlannerInput,
): VersionedProviderPolicyAdoptionPlanResult {
  createVersionedProviderPreparationBuilder(version);
  return prepareAdoption(input, version) as VersionedProviderPolicyAdoptionPlanResult;
}
function prepareAdoption(
  input: ProviderPolicyAdoptionPlannerInput,
  version: PlanPromptVersion | null,
) {
  const parsed = providerPolicyAdoptionCommandSchema.safeParse(input.command);
  const reviewInput = providerPolicyReviewSchema.safeParse(input.review);
  const head = providerPolicyAdoptionHeadSchema.safeParse(input.currentPolicyHead);
  const nonces = z
    .array(z.string().uuid())
    .max(providerPolicyAdoptionLimits.knownNonces)
    .safeParse(input.usedRequestIds);
  if (
    !parsed.success ||
    !reviewInput.success ||
    !head.success ||
    !nonces.success ||
    new Set(nonces.data).size !== nonces.data.length ||
    !z.string().datetime().safeParse(input.current.inspectedAt).success
  )
    return refuse("invalid-input");
  const command = parsed.data,
    review = reviewInput.data;
  if (
    command.version !== input.current.registry.version ||
    command.versionDigest !== input.current.registry.versionDigest ||
    command.candidateId !== input.current.candidateId ||
    command.candidateId !== review.scope.candidateId ||
    command.version !== review.scope.version ||
    command.versionDigest !== review.scope.versionDigest
  )
    return refuse("scope-changed");
  if (!same(command.expectedPolicyHead, head.data)) return refuse("policy-head-changed");
  if (head.data.revision >= providerPolicyAdoptionLimits.records) return refuse("policy-limit");
  if (
    nonces.data.includes(command.clientRequestId) ||
    (command.initialBudgetRequestId !== null &&
      nonces.data.includes(command.initialBudgetRequestId))
  )
    return refuse("nonce-conflict");
  if (
    command.approvedReviewDigest !== review.reviewDigest ||
    !(version === null
      ? isProviderPolicyReviewCurrent(review, input.current)
      : isVersionedProviderPolicyReviewCurrent(version, review, input.current))
  )
    return refuse("review-not-current");
  const approvedAt = Date.parse(command.approval.approvedAt),
    now = Date.parse(input.current.inspectedAt);
  if (
    isProviderPolicyApprovalBeforeReview(command, review) ||
    approvedAt > now ||
    approvedAt >= Date.parse(review.expiresAt)
  )
    return refuse("approval-time-invalid");
  if ((review.budget.revision === 0) !== (command.budgetAction === "initialize-proposed-budget"))
    return refuse("budget-action-mismatch");
  if (review.assessment.state === "budget-incompatible") return refuse("budget-incompatible");
  const proposalInput = { ...input.current, inspectedAt: review.inspectedAt };
  const proposal =
    version === null
      ? createProviderConfigurationProposalView(proposalInput)
      : createVersionedProviderConfigurationProposalView(version, proposalInput);
  if (!proposal) return refuse("review-not-current");
  const before = { revision: review.budget.revision, headDigest: review.budget.headDigest };
  let initialization: ProviderPolicyAdoptionWritePlan["initialization"] = null;
  let after = before;
  if (command.budgetAction === "initialize-proposed-budget") {
    initialization = initializationFor(command, review, input.current.inspectedAt);
    after = { revision: 1, headDigest: initialization.event.eventDigest };
  }
  const body: Omit<
    ProviderPolicyAdoptionRecord | VersionedProviderPolicyAdoptionRecord,
    "recordDigest"
  > = {
    recordVersion: version === null ? 1 : 2,
    kind: "provider-policy-adoption",
    scopeId: "candidate-quality-provider-policy-live",
    revision: head.data.revision + 1,
    previousDigest: head.data.headDigest,
    clientRequestId: command.clientRequestId,
    requestDigest: providerPolicyAdoptionRequestDigest(command),
    recordedAt: input.current.inspectedAt,
    command,
    reviewedProposal: proposal,
    approvedReview: review,
    budgetTransition: {
      kind: command.budgetAction,
      before,
      after,
      initializationRequestId: command.initialBudgetRequestId,
    },
    reservationAllowed: false,
    dispatchAllowed: false,
  };
  const record = { ...body, recordDigest: digest(body) };
  if (Buffer.byteLength(JSON.stringify(record)) > providerPolicyAdoptionLimits.recordBytes)
    return refuse("record-too-large");
  try {
    (version === null
      ? validateProviderPolicyAdoptionRecord
      : validateVersionedProviderPolicyAdoptionRecord)(record, input.current.registry, [
      ...(Array.isArray(input.current.budgetEvents) ? input.current.budgetEvents : []),
      ...(initialization ? [initialization.event] : []),
    ]);
  } catch {
    return refuse("archive-proof-invalid");
  }
  return {
    status: "prepared" as const,
    plan: (version === null
      ? providerPolicyAdoptionWritePlanSchema
      : versionedProviderPolicyAdoptionWritePlanSchema
    ).parse({
      planVersion: version === null ? 1 : 2,
      status: "prepared-not-committed",
      transaction: "single-immediate-transaction-required",
      record,
      initialization,
    }),
  };
}

/**
 * Retry identity only, never a commit/authorization proof. The store must first fully inspect
 * the persisted chain and referenced budget rows. It must look up retries before fresh expiry/CAS checks.
 * Frozen evidence is not regenerated using today's prompts/configuration during this comparison.
 */
export function compareProviderPolicyAdoptionRetry(
  rawCommand: unknown,
  rawRecord: unknown,
): "same-request" | "nonce-conflict" | "different-request" | "invalid-record" {
  const command = providerPolicyAdoptionCommandSchema.safeParse(rawCommand);
  const parsed = providerPolicyAdoptionRecordSchema.safeParse(rawRecord);
  if (!command.success || !parsed.success) return "invalid-record";
  const record = parsed.data,
    review = record.approvedReview,
    proposal = record.reviewedProposal;
  if (
    record.recordDigest !== digest(providerPolicyAdoptionRecordDigestInput(record)) ||
    record.requestDigest !== providerPolicyAdoptionRequestDigest(record.command) ||
    record.clientRequestId !== record.command.clientRequestId ||
    record.revision !== record.command.expectedPolicyHead.revision + 1 ||
    record.previousDigest !== record.command.expectedPolicyHead.headDigest ||
    record.command.approvedReviewDigest !== review.reviewDigest ||
    review.reviewDigest !== digest(providerPolicyReviewDigestInput(review)) ||
    proposal.viewDigest !== digest(providerReviewDigestInput(proposal)) ||
    !same(review.scope, proposal.scope) ||
    proposal.inspectedAt !== review.inspectedAt ||
    review.expiresAt !==
      new Date(
        Math.min(
          Date.parse(review.inspectedAt) + providerPolicyReviewLifetimeMs,
          ...proposal.proposal.sources.map((source) => Date.parse(source.validUntil)),
        ),
      ).toISOString() ||
    !same(review.bindings, {
      configurationDigest: proposal.proposal.configurationDigest,
      requestReviewDigest: digest(proposal.proposal.requestReview),
      financialBasisDigest: digest(proposal.financialBasis),
      retentionDigest: digest(proposal.retention),
      usagePolicyDigest: digest(proposal.proposal.usagePolicy),
      model: proposal.model,
    }) ||
    !same(review.proposedBudget, proposal.proposal.proposedBudget) ||
    !same(review.reservation, {
      generationUnits: proposal.financialBasis.costs.generation.totalUnits,
      reviewUnits: proposal.financialBasis.costs.review.totalUnits,
      totalUnits: proposal.financialBasis.costs.totalUnits,
    }) ||
    review.assessment.state === "budget-incompatible" ||
    record.command.version !== review.scope.version ||
    record.command.versionDigest !== review.scope.versionDigest ||
    record.command.candidateId !== review.scope.candidateId ||
    record.budgetTransition.kind !== record.command.budgetAction ||
    record.budgetTransition.initializationRequestId !== record.command.initialBudgetRequestId ||
    !same(record.budgetTransition.before, {
      revision: review.budget.revision,
      headDigest: review.budget.headDigest,
    }) ||
    Date.parse(record.command.approval.approvedAt) < Date.parse(review.inspectedAt) ||
    Date.parse(record.command.approval.approvedAt) > Date.parse(record.recordedAt) ||
    Date.parse(record.recordedAt) >= Date.parse(review.expiresAt)
  )
    return "invalid-record";
  if (record.command.budgetAction === "keep-existing-budget") {
    if (
      review.budget.revision === 0 ||
      !same(record.budgetTransition.before, record.budgetTransition.after)
    )
      return "invalid-record";
  } else if (
    review.budget.revision !== 0 ||
    record.budgetTransition.after.revision !== 1 ||
    record.budgetTransition.after.headDigest !==
      initializationFor(record.command, review, record.recordedAt).event.eventDigest
  )
    return "invalid-record";
  if (record.clientRequestId !== command.data.clientRequestId) return "different-request";
  return same(record.command, command.data) ? "same-request" : "nonce-conflict";
}

/** This digest is stable across transport retries; the caller must reuse the complete original command. */
export type { ProviderPolicyAdoptionCommand };
