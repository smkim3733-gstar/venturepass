import { randomUUID } from "node:crypto";
import { actualTestRegistry, actualTestNow } from "./studio-plan-quality-actual-test-helpers";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { createProviderPolicyReview } from "./studio-plan-quality-provider-policy-review";
import { prepareProviderPolicyAdoption } from "./studio-plan-quality-provider-policy-adoption";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import {
  createProviderReservationReview,
  type ProviderReservationReviewInput,
} from "./studio-plan-quality-provider-reservation-review";
import type { ProviderReservationReview } from "./studio-plan-quality-provider-reservation-review-types";
import {
  providerReservationCommandSchema,
  type ProviderReservationCommand,
} from "./studio-plan-quality-provider-reservation-command";
import {
  prepareProviderReservation,
  type ProviderReservationPlannerInput,
  type ProviderReservationWritePlan,
} from "./studio-plan-quality-provider-reservation-plan";
import {
  providerDigest as digest,
  validateProviderBudgetLedger,
  providerBudgetScope,
  createProviderBudgetEvent,
  createProviderRunEvent,
  createProviderReceipt,
  providerCancelDigestInput,
} from "../../scripts/local-data-quality-provider.mjs";
import { inspectQualityLedgers } from "../../scripts/local-data-quality-ledgers.mjs";
// All approvals and proposed rows are synthetic, in-memory fixtures. Nothing is committed or sent.
export const registry = actualTestRegistry();
export const reviewedAt = "2026-09-27T03:30:00.000Z";
export const approvedAt = "2026-09-27T03:31:00.000Z";
export const recordedAt = "2026-09-27T03:32:00.000Z";
export function config() {
  const value = getProviderConfigurationProposal();
  if (!value) throw new Error("Missing configuration fixture");
  return value;
}
export function adopt(
  ledger: ProviderReservationReviewInput["ledger"],
  index = 0,
  configuration = config(),
  at = actualTestNow,
) {
  const state = inspectQualityLedgers(ledger);
  const budgetEvents = state.provider.budgetEvents.filter(
    (row) => row.environment === "production",
  );
  const budget = validateProviderBudgetLedger(budgetEvents, providerBudgetScope("production"));
  const current = {
    registry,
    candidateId: registry.entries[index].candidateId,
    inspectedAt: at,
    configuration,
    budgetEvents,
    expectedBudgetHead: { revision: budget.revision, headDigest: budget.headDigest },
  };
  const reviewed = createProviderPolicyReview(current);
  if (reviewed.status !== "review") throw new Error(reviewed.reason);
  const head = { revision: state.policy.revision, headDigest: state.policy.headDigest };
  const command = providerPolicyAdoptionCommandSchema.parse({
    commandVersion: 1,
    kind: "adopt-provider-policy",
    clientRequestId: randomUUID(),
    version: registry.version,
    versionDigest: registry.versionDigest,
    candidateId: current.candidateId,
    expectedPolicyHead: head,
    approvedReviewDigest: reviewed.review.reviewDigest,
    budgetAction: budget.revision ? "keep-existing-budget" : "initialize-proposed-budget",
    initialBudgetRequestId: budget.revision ? null : randomUUID(),
    approval: {
      noticeVersion: 1,
      acknowledgedPolicy: true,
      acknowledgedBudgetAction: true,
      reservationAndTransmission: "separate-approval-required",
      approvedAt: at,
    },
  });
  const result = prepareProviderPolicyAdoption({
    command,
    review: reviewed.review,
    current,
    currentPolicyHead: head,
    usedRequestIds: [
      ...state.policy.records.map((row) => row.clientRequestId),
      ...state.provider.receipts.map((row) => row.clientRequestId),
    ],
  });
  if (result.status !== "prepared") throw new Error(result.reason);
  ledger.policies!.push(result.plan.record);
  if (result.plan.initialization) {
    ledger.budgetEvents.push(result.plan.initialization.event);
    ledger.receipts.push(result.plan.initialization.receipt);
  }
}
export function review(current: ProviderReservationReviewInput): ProviderReservationReview {
  const result = createProviderReservationReview(current);
  if (result.status !== "review") throw new Error(result.reason);
  return result.review;
}
export function commandFor(value: ProviderReservationReview): ProviderReservationCommand {
  return providerReservationCommandSchema.parse({
    commandVersion: 1,
    kind: "reserve-provider-candidate",
    clientRequestId: randomUUID(),
    version: value.policyReview.scope.version,
    versionDigest: value.policyReview.scope.versionDigest,
    candidateId: value.policyReview.scope.candidateId,
    approvedReviewDigest: value.reviewDigest,
    expectedLedgerDigest: value.ledgerDigest,
    expectedPolicyHead: value.policyHead,
    expectedPolicyReference: value.policy.reference,
    expectedBudgetHead: {
      revision: value.policyReview.budget.revision,
      headDigest: value.policyReview.budget.headDigest,
    },
    expectedGlobalRunCount: value.runs.globalCount,
    expectedProductionRunCount: value.runs.productionCount,
    approval: {
      noticeVersion: 1,
      acknowledgedCandidate: true,
      acknowledgedCurrentBudget: true,
      acknowledgedReservationOnly: true,
      acknowledgedFinancialBasisNotTokenFit: true,
      acknowledgedRetention: true,
      acknowledgedNoAutomaticRetry: true,
      transmission: "separate-approval-required",
      approvedAt,
    },
  });
}
export function fixture(configuration = config()) {
  const ledger: ProviderReservationReviewInput["ledger"] = {
    runs: [],
    events: [],
    artifacts: [],
    budgetEvents: [],
    receipts: [],
    policies: [],
    otherNonces: [randomUUID()],
    registries: [registry],
  };
  adopt(ledger, 0, configuration);
  const current: ProviderReservationReviewInput = {
    selection: {
      version: registry.version,
      versionDigest: registry.versionDigest,
      candidateId: registry.entries[0].candidateId,
    },
    inspectedAt: reviewedAt,
    configuration,
    ledger,
  };
  const value = review(current);
  return {
    command: commandFor(value),
    review: value,
    current: { ...current, inspectedAt: recordedAt },
    runId: randomUUID(),
    additionalUsedBytes: 0,
  };
}
export function prepared(input: ProviderReservationPlannerInput): ProviderReservationWritePlan {
  const result = prepareProviderReservation(input);
  if (result.status !== "prepared") throw new Error(result.reason);
  return result.plan;
}
export function withRows(
  input: ProviderReservationPlannerInput,
  plan: ProviderReservationWritePlan,
) {
  const ledger = input.current.ledger;
  ledger.runs.push(plan.rows.run);
  ledger.artifacts.push(plan.rows.artifact);
  ledger.budgetEvents.push(plan.rows.budgetEvent);
  ledger.receipts.push(plan.rows.receipt);
}
export function cancel(input: ProviderReservationPlannerInput, plan: ProviderReservationWritePlan) {
  const ledger = input.current.ledger,
    run = plan.rows.run;
  const budget = validateProviderBudgetLedger(
    inspectQualityLedgers(ledger).provider.budgetEvents,
    providerBudgetScope("production"),
  );
  const command = {
    clientRequestId: randomUUID(),
    expectedRevision: 0 as const,
    reason: "test-cleanup" as const,
  };
  const costs = run.preparation.financialBasis.costs!;
  const release = createProviderBudgetEvent({
    schemaVersion: 2,
    scopeId: budget.scopeId,
    environment: "production",
    provenance: "explicit-user",
    revision: budget.revision + 1,
    previousDigest: budget.headDigest,
    eventId: command.clientRequestId,
    recordedAt,
    currency: budget.currency!,
    unitScale: budget.unitScale!,
    payload: {
      kind: "release-run",
      runId: run.id,
      reservationDigest: run.reservationDigest,
      generationUnits: costs.generation.totalUnits,
      reviewUnits: costs.review.totalUnits,
      reason: "cancelled-before-dispatch",
    },
  });
  const event = createProviderRunEvent({
    schemaVersion: 2,
    runId: run.id,
    revision: 1,
    budgetRevision: release.revision,
    previousEventDigest: null,
    recordedAt,
    payload: {
      kind: "cancelled-before-dispatch",
      reason: command.reason,
      releaseBudgetEventDigest: release.eventDigest,
    },
  });
  ledger.budgetEvents.push(release);
  ledger.events.push(event);
  ledger.receipts.push(
    createProviderReceipt({
      schemaVersion: 2,
      scopeId: budget.scopeId,
      kind: "provider-cancel",
      clientRequestId: command.clientRequestId,
      inputDigest: digest(providerCancelDigestInput(run.id, command)),
      runId: run.id,
      runRevision: 1,
      budgetRevision: release.revision,
      operationDigest: event.eventDigest,
      recordedAt,
    }),
  );
}
export function refresh(input: ReturnType<typeof fixture>) {
  input.review = review(input.current);
  input.command = commandFor(input.review);
  input.command.approval.approvedAt = input.current.inspectedAt;
}
