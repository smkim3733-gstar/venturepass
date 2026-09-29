import { z } from "zod";
import { inspectProviderReservationArchive } from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import {
  createProviderTransmissionManifest,
  getProviderExecutionBudgetSnapshot,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  providerBudgetScope,
  providerDigest as digest,
} from "../../scripts/local-data-quality-provider.mjs";
import { validateNewProviderPreparation } from "./studio-plan-quality-provider-core";
import {
  createProviderConfigurationProposalView,
  getProviderConfigurationExpiry,
} from "./studio-plan-quality-provider-configuration";
import {
  assessProviderTransmissionReview,
  providerTransmissionReviewDigestInput,
  providerTransmissionReviewInputSchema,
  providerTransmissionReviewLifetimeMs,
  providerTransmissionReviewNotice,
  providerTransmissionReviewSchema,
  type ProviderTransmissionReview,
} from "./studio-plan-quality-provider-transmission-review-types";

export type ProviderTransmissionReviewInput = {
  selection: unknown;
  inspectedAt: string;
  configuration: unknown;
  /** Complete server-owned v8 snapshot. Future DB callers must additionally audit schema/raw
   * rows and registration/evaluation receipts in the SAME read transaction. No client evidence. */
  archive: Parameters<typeof inspectProviderReservationArchive>[0];
};
export type ProviderTransmissionReviewResult =
  | { status: "review"; review: ProviderTransmissionReview }
  | {
      status: "unavailable";
      reason:
        | "selection-invalid"
        | "inspection-invalid"
        | "archive-invalid"
        | "archive-after-inspection"
        | "production-reservation-required"
        | "reservation-binding-required"
        | "reservation-expired"
        | "preparation-changed"
        | "configuration-missing-or-invalid"
        | "configuration-expired"
        | "configuration-changed";
      review: null;
    };
type Reason = Extract<ProviderTransmissionReviewResult, { status: "unavailable" }>["reason"];
const unavailable = (reason: Reason): ProviderTransmissionReviewResult => ({
  status: "unavailable",
  reason,
  review: null,
});
const same = (a: unknown, b: unknown) => digest(a) === digest(b);

/** Read-only first-transmission review. Does not reuse NEW-reservation eligibility, extend an
 * expired preparation, reserve more budget, create a command/approval, or access a credential. */
export function createProviderTransmissionReview(
  input: ProviderTransmissionReviewInput,
): ProviderTransmissionReviewResult {
  const selection = providerTransmissionReviewInputSchema.safeParse(input.selection);
  if (!selection.success) return unavailable("selection-invalid");
  if (!z.string().datetime().safeParse(input.inspectedAt).success)
    return unavailable("inspection-invalid");
  const inspectedAt = new Date(input.inspectedAt).toISOString(),
    now = Date.parse(inspectedAt);
  let archive: ReturnType<typeof inspectProviderReservationArchive>;
  try {
    archive = inspectProviderReservationArchive(input.archive);
  } catch {
    return unavailable("archive-invalid");
  }
  const state = archive.ledger;
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
  if (timed.some((row) => "recordedAt" in row && Date.parse(row.recordedAt) > now))
    return unavailable("archive-after-inspection");
  const snapshot = state.provider.snapshots.find((row) => row.run.id === selection.data.runId);
  if (!snapshot || snapshot.run.runDigest !== selection.data.runDigest)
    return unavailable("selection-invalid");
  const run = snapshot.run,
    prep = run.preparation;
  if (run.environment !== "production") return unavailable("production-reservation-required");
  const binding = archive.records.find((row) => row.runId === run.id);
  if (!binding) return unavailable("reservation-binding-required");
  // Coverage may preserve older unbound production records, but never confers a new approval.
  if (now >= Date.parse(prep.expiresAt)) return unavailable("reservation-expired");
  const registry = input.archive.ledger.registries.find(
    (row) => row.version === prep.scope.version,
  );
  if (!registry) return unavailable("archive-invalid");
  try {
    validateNewProviderPreparation(prep, registry, inspectedAt);
  } catch {
    return unavailable("preparation-changed");
  }
  const proposalInput = {
    registry,
    candidateId: prep.scope.candidateId,
    configuration: input.configuration,
    inspectedAt,
  };
  let current, reserved;
  try {
    current = createProviderConfigurationProposalView(proposalInput);
    if (!current)
      return unavailable(
        getProviderConfigurationExpiry(proposalInput)
          ? "configuration-expired"
          : "configuration-missing-or-invalid",
      );
    // An exact configuration match is deliberate. Even semantically similar new evidence must
    // not silently replace the reserved financial/retention/usage contract.
    if (
      current.proposal.configurationDigest !==
      binding.approvedReview.policyReview.bindings.configurationDigest
    )
      return unavailable("configuration-changed");
    reserved = createProviderConfigurationProposalView({
      ...proposalInput,
      inspectedAt: prep.preparedAt,
    });
  } catch {
    return unavailable("configuration-missing-or-invalid");
  }
  const request = {
    scope: prep.scope,
    model: prep.model,
    contract: prep.contract,
    generation: prep.generation,
    reviewTemplate: prep.reviewTemplate,
  };
  if (
    !reserved ||
    !same(reserved.financialBasis, prep.financialBasis) ||
    !same(reserved.proposal.requestReview, request) ||
    !same(reserved.retention, prep.retention) ||
    digest(reserved.proposal.usagePolicy) !==
      binding.approvedReview.policyReview.bindings.usagePolicyDigest
  )
    return unavailable("preparation-changed");
  const latestPolicy = state.policy.records.findLast(
    (row) =>
      row.command.version === prep.scope.version &&
      row.command.candidateId === prep.scope.candidateId,
  );
  const currentReference = latestPolicy
    ? {
        revision: latestPolicy.revision,
        recordDigest: latestPolicy.recordDigest,
        clientRequestId: latestPolicy.clientRequestId,
        recordedAt: latestPolicy.recordedAt,
      }
    : null;
  const reservedReference = binding.command.expectedPolicyReference;
  try {
    const manifest = createProviderTransmissionManifest(run, reserved.proposal.usagePolicy);
    const scope = providerBudgetScope("production");
    const budget = getProviderExecutionBudgetSnapshot(
      state.provider.budgetEvents.filter((row) => row.scopeId === scope),
      scope,
    );
    const held = budget.reservations.find((row) => row.runId === run.id);
    const generation = held?.phases.find((row) => row.phase === "generation"),
      review = held?.phases.find((row) => row.phase === "review");
    if (!held || !generation || !review) return unavailable("archive-invalid");
    const costs = reserved.financialBasis.costs;
    const facts = {
      policyUnchanged: same(currentReference, reservedReference),
      runUntouched:
        snapshot.archiveFormatVersion === 2 &&
        snapshot.revision === 0 &&
        snapshot.state === "reserved",
      reservationIntact:
        !generation.settled &&
        !review.settled &&
        generation.heldUnits === costs.generation.totalUnits &&
        review.heldUnits === costs.review.totalUnits,
      budgetCompatible: budget.currency === costs.currency && budget.unitScale === costs.unitScale,
      budgetWithinBound: !budget.boundBreached && budget.deficitUnits === "0",
    };
    const value = {
      schemaVersion: 1 as const,
      kind: "provider-transmission-review" as const,
      environment: "production" as const,
      inputProvenance: "registered-synthetic-candidate" as const,
      scope: binding.approvedReview.policyReview.scope,
      inspectedAt,
      expiresAt: new Date(
        Math.min(
          now + providerTransmissionReviewLifetimeMs,
          Date.parse(prep.expiresAt),
          ...current.proposal.sources.map((row) => Date.parse(row.validUntil)),
        ),
      ).toISOString(),
      archiveDigest: digest(input.archive),
      coverageDigest: archive.coverage.coverageDigest,
      configurationDigest: current.proposal.configurationDigest,
      run: {
        id: run.id,
        runDigest: run.runDigest,
        preparationDigest: prep.preparationDigest,
        recordedAt: run.recordedAt,
        preparedAt: prep.preparedAt,
        preparationExpiresAt: prep.expiresAt,
        revision: snapshot.revision,
        archiveFormatVersion: snapshot.archiveFormatVersion,
        state: snapshot.state,
        snapshotDigest: snapshot.snapshotDigest,
      },
      reservation: {
        bindingDigest: binding.recordDigest,
        clientRequestId: binding.clientRequestId,
        approvedReviewDigest: binding.command.approvedReviewDigest,
        reservationDigest: run.reservationDigest,
        generationUnits: costs.generation.totalUnits,
        reviewUnits: costs.review.totalUnits,
        totalUnits: costs.totalUnits,
        heldUnits: held.heldUnits,
        generationHeldUnits: generation.heldUnits,
        reviewHeldUnits: review.heldUnits,
        generationSettled: generation.settled,
        reviewSettled: review.settled,
      },
      policy: {
        head: { revision: state.policy.revision, headDigest: state.policy.headDigest },
        reservedReference,
        currentReference,
      },
      budget: {
        scopeId: scope,
        revision: budget.revision,
        headDigest: budget.headDigest,
        currency: budget.currency,
        unitScale: budget.unitScale,
        capUnits: budget.capUnits,
        heldUnits: budget.heldUnits,
        recognizedUnits: budget.recognizedUnits,
        availableUnits: budget.availableUnits,
        deficitUnits: budget.deficitUnits,
        boundBreached: budget.boundBreached,
      },
      request,
      financialBasis: prep.financialBasis,
      retention: prep.retention,
      manifest,
      facts,
      assessment: assessProviderTransmissionReview(facts),
      accountAccess: "not-checked" as const,
      actions: {
        approvalWriteAllowed: false as const,
        dispatchAllowed: false as const,
        budgetWriteAllowed: false as const,
      },
      nextStep: "separate-transmission-approval-required" as const,
      notice: providerTransmissionReviewNotice,
    };
    const parsed = providerTransmissionReviewSchema.safeParse({
      ...value,
      reviewDigest: digest(value),
    });
    return parsed.success
      ? { status: "review", review: parsed.data }
      : unavailable("archive-invalid");
  } catch {
    return unavailable("archive-invalid");
  }
}

/** Currentness only, never an execution grant. A future writer must supply fresh audited evidence
 * under its write lock and separately require conditions-met and explicit transmission consent. */
export function isProviderTransmissionReviewCurrent(
  value: unknown,
  current: ProviderTransmissionReviewInput,
): boolean {
  const parsed = providerTransmissionReviewSchema.safeParse(value);
  if (!parsed.success || !z.string().datetime().safeParse(current.inspectedAt).success)
    return false;
  const review = parsed.data,
    now = Date.parse(current.inspectedAt);
  if (
    now < Date.parse(review.inspectedAt) ||
    now >= Date.parse(review.expiresAt) ||
    review.reviewDigest !== digest(providerTransmissionReviewDigestInput(review))
  )
    return false;
  const rebuilt = createProviderTransmissionReview({ ...current, inspectedAt: review.inspectedAt });
  return rebuilt.status === "review" && rebuilt.review.reviewDigest === review.reviewDigest;
}
