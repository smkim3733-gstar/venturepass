import { z } from "zod";
import { inspectQualityLedgers } from "../../scripts/local-data-quality-ledgers.mjs";
import {
  validateProviderBudgetLedger,
  providerBudgetScope,
} from "../../scripts/local-data-quality-provider.mjs";
import { validateCandidateRegistrySnapshot } from "./studio-plan-quality-candidate-registry";
import { planQualityEvaluationDigest as digest } from "./studio-plan-quality-evaluation";
import { providerReviewInputSchema } from "./studio-plan-quality-provider-review-types";
import { createProviderConfigurationProposalView } from "./studio-plan-quality-provider-configuration";
import {
  createProviderPolicyReview,
  type ProviderPolicyReviewResult,
} from "./studio-plan-quality-provider-policy-review";
import {
  assessProviderReservationReview,
  providerReservationReviewDigestInput,
  providerReservationReviewNotice,
  providerReservationReviewSchema,
  type ProviderReservationReview,
} from "./studio-plan-quality-provider-reservation-review-types";

export type ProviderReservationReviewInput = {
  selection: unknown;
  inspectedAt: string;
  configuration: unknown;
  /** One immutable, server-owned read snapshot, including all environments and all operation nonces.
   * A future store caller must also audit database schema, evaluation/registration receipts and raw rows.
   * This pure contract never authenticates client-supplied arrays or establishes their committed origin.
   */
  ledger: Parameters<typeof inspectQualityLedgers>[0];
};
type UnavailableReason =
  | Extract<ProviderPolicyReviewResult, { status: "unavailable" }>["reason"]
  | "selection-invalid"
  | "ledger-invalid"
  | "ledger-after-inspection";
export type ProviderReservationReviewResult =
  | { status: "review"; review: ProviderReservationReview }
  | { status: "unavailable"; reason: UnavailableReason; review: null };
const unavailable = (reason: UnavailableReason): ProviderReservationReviewResult => ({
  status: "unavailable",
  reason,
  review: null,
});

/** Pure, read-only assessment. No write plan, preparation, credential lookup or provider capability. */
export function createProviderReservationReview(
  input: ProviderReservationReviewInput,
): ProviderReservationReviewResult {
  const selection = providerReviewInputSchema.safeParse(input.selection);
  if (!selection.success) return unavailable("selection-invalid");
  if (!z.string().datetime().safeParse(input.inspectedAt).success)
    return unavailable("inspection-invalid");
  const inspectedAt = new Date(input.inspectedAt).toISOString();
  let state: ReturnType<typeof inspectQualityLedgers>;
  try {
    state = inspectQualityLedgers(input.ledger);
  } catch {
    return unavailable("ledger-invalid");
  }
  const candidates = input.ledger.registries.filter(
    (row) => row.version === selection.data.version,
  );
  if (candidates.length !== 1) return unavailable("selection-invalid");
  let registry;
  try {
    registry = validateCandidateRegistrySnapshot(candidates[0]);
  } catch {
    return unavailable("selection-invalid");
  }
  if (
    registry.versionDigest !== selection.data.versionDigest ||
    !registry.entries.some((row) => row.candidateId === selection.data.candidateId)
  )
    return unavailable("selection-invalid");
  const timed = [
    ...state.legacy.runs,
    ...state.legacy.events,
    ...state.legacy.budgetEvents,
    ...state.legacy.receipts,
    ...state.provider.runs,
    ...state.provider.events,
    ...state.provider.budgetEvents,
    ...state.provider.receipts,
    ...state.policy.records,
  ];
  if (
    timed.some((row) => "recordedAt" in row && Date.parse(row.recordedAt) > Date.parse(inspectedAt))
  )
    return unavailable("ledger-after-inspection");
  const scope = providerBudgetScope("production");
  const events = state.provider.budgetEvents.filter((row) => row.scopeId === scope);
  const budget = validateProviderBudgetLedger(events, scope);
  const policyInput = {
    registry,
    candidateId: selection.data.candidateId,
    inspectedAt,
    configuration: input.configuration,
    budgetEvents: events,
    expectedBudgetHead: { revision: budget.revision, headDigest: budget.headDigest },
  };
  const current = createProviderPolicyReview(policyInput);
  if (current.status !== "review") return current;
  // Newer records for this registered candidate supersede older ones. Never fall back to an older match.
  const record = state.policy.records.findLast(
    (row) =>
      row.command.version === registry.version &&
      row.command.candidateId === selection.data.candidateId,
  );
  let policy: ProviderReservationReview["policy"] = { state: "not-adopted", reference: null };
  if (record) {
    // Rebuild at the original inspection instant so calculatedAt-dependent financial/usage digests
    // remain comparable. Current authority validity was separately checked at inspectedAt above.
    // A consumed adoption approval's 15-minute review window is not the lifetime of the policy.
    const rebuilt = createProviderConfigurationProposalView({
      ...policyInput,
      inspectedAt: record.approvedReview.inspectedAt,
    });
    policy = {
      state: rebuilt?.viewDigest === record.reviewedProposal.viewDigest ? "matched" : "changed",
      reference: {
        revision: record.revision,
        recordDigest: record.recordDigest,
        clientRequestId: record.clientRequestId,
        recordedAt: record.recordedAt,
      },
    };
  }
  const runs = {
    globalCount: state.globalRunCount,
    productionCount: state.provider.runs.filter((row) => row.environment === "production").length,
    // Same candidate across registry versions: a new registration cannot clear unresolved exposure.
    unsettledCandidateRunIds: state.provider.snapshots
      .filter(
        (row) =>
          row.run.environment === "production" &&
          row.run.preparation.scope.candidateId === selection.data.candidateId &&
          (row.state === "reserved" ||
            ("eligibleForNewCandidateRun" in row && !row.eligibleForNewCandidateRun)),
      )
      .map((row) => row.run.id),
  };
  const body: Omit<ProviderReservationReview, "reviewDigest"> = {
    schemaVersion: 1,
    kind: "provider-reservation-review",
    policyReview: current.review,
    ledgerDigest: digest(input.ledger),
    policyHead: { revision: state.policy.revision, headDigest: state.policy.headDigest },
    policy,
    runs,
    assessment: assessProviderReservationReview(policy, current.review.assessment.state, runs),
    nextStep: "separate-reservation-command-required",
    actions: { reservationAllowed: false, dispatchAllowed: false, budgetWriteAllowed: false },
    notice: providerReservationReviewNotice,
  };
  const parsed = providerReservationReviewSchema.safeParse({ ...body, reviewDigest: digest(body) });
  return parsed.success ? { status: "review", review: parsed.data } : unavailable("ledger-invalid");
}

/** A future writer must call this using fresh server evidence under its write lock. Still no grant. */
export function isProviderReservationReviewCurrent(
  value: unknown,
  current: ProviderReservationReviewInput,
): boolean {
  const parsed = providerReservationReviewSchema.safeParse(value);
  if (!parsed.success || !z.string().datetime().safeParse(current.inspectedAt).success)
    return false;
  const review = parsed.data,
    now = Date.parse(current.inspectedAt);
  if (
    now < Date.parse(review.policyReview.inspectedAt) ||
    now >= Date.parse(review.policyReview.expiresAt) ||
    review.reviewDigest !== digest(providerReservationReviewDigestInput(review))
  )
    return false;
  const rebuilt = createProviderReservationReview({
    ...current,
    inspectedAt: review.policyReview.inspectedAt,
  });
  return rebuilt.status === "review" && rebuilt.review.reviewDigest === review.reviewDigest;
}
