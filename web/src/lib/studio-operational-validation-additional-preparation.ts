import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AdditionalValidationJournal } from "../../scripts/operational-validation-journal.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import { auditAdditionalValidationJournal } from "./studio-operational-validation-cross-audit";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { providerPolicyReviewSchema } from "./studio-plan-quality-provider-policy-review-types";
import { providerReservationCommandSchema } from "./studio-plan-quality-provider-reservation-command";
import { providerReservationReviewSchema } from "./studio-plan-quality-provider-reservation-review-types";
import { providerTransmissionCommandSchema } from "./studio-plan-quality-provider-transmission-command";
import { versionedProviderTransmissionReviewSchema } from "./studio-plan-quality-provider-transmission-review-types";

const stages = ["policy", "reserve", "approve-transmission"] as const;
type Stage = (typeof stages)[number];
const schemas = {
  policy: z
    .object({ command: providerPolicyAdoptionCommandSchema, review: providerPolicyReviewSchema })
    .strict(),
  reserve: z
    .object({ command: providerReservationCommandSchema, review: providerReservationReviewSchema })
    .strict(),
  "approve-transmission": z
    .object({
      command: providerTransmissionCommandSchema,
      review: versionedProviderTransmissionReviewSchema,
    })
    .strict(),
};
const fail = (): never => {
  throw Error("VALIDATION_ADDITIONAL_PREPARATION_UNAVAILABLE");
};
type Audit = ReturnType<typeof auditAdditionalValidationJournal>;

/** Same file lease and DB, no registration/budget initialization. The lazy writer must belong
 * to the session's single authentic v2 runtime. Recovery never needs that runtime or its key. */
export class AdditionalOperationalValidationPreparation {
  constructor(
    private readonly store: PlanQualityStore,
    private readonly journal: AdditionalValidationJournal,
    private readonly writer: () => PlanQualityStore,
  ) {}
  audit() {
    return auditAdditionalValidationJournal(this.store, this.journal);
  }
  reconcile() {
    const state = this.audit();
    for (const item of state.recoverable)
      this.journal.acknowledgeAdditional(item.stage, { recordDigest: digest(item.record) });
    return state.recoverable.length ? this.audit() : state;
  }
  private build(stage: Stage, state: Audit) {
    const store = this.writer();
    const selection = {
      version: state.registry.version,
      versionDigest: state.registry.versionDigest,
      candidateId: "validation-candidate-mfg-new-seal-inspection",
    };
    if (stage === "policy") {
      const { result, expectedPolicyHead } = store.providerPolicyReview(
        selection.version,
        selection.candidateId,
      );
      if (
        result.status !== "review" ||
        expectedPolicyHead.revision !== 1 ||
        result.review.budget.revision === 0
      )
        return fail();
      return {
        review: result.review,
        command: {
          commandVersion: 1,
          kind: "adopt-provider-policy",
          clientRequestId: randomUUID(),
          ...selection,
          expectedPolicyHead,
          approvedReviewDigest: result.review.reviewDigest,
          budgetAction: "keep-existing-budget",
          initialBudgetRequestId: null,
          approval: {
            noticeVersion: 1,
            acknowledgedPolicy: true,
            acknowledgedBudgetAction: true,
            reservationAndTransmission: "separate-approval-required",
            approvedAt: new Date().toISOString(),
          },
        },
      };
    }
    if (stage === "reserve") {
      const result = store.providerReservationReview(selection);
      if (result.status !== "review" || result.review.assessment.state !== "conditions-met")
        return fail();
      const v = result.review;
      if (v.runs.globalCount !== 1 || v.runs.productionCount !== 1 || v.policyHead.revision !== 2)
        return fail();
      return {
        review: v,
        command: {
          commandVersion: 1,
          kind: "reserve-provider-candidate",
          clientRequestId: randomUUID(),
          ...selection,
          approvedReviewDigest: v.reviewDigest,
          expectedLedgerDigest: v.ledgerDigest,
          expectedPolicyHead: v.policyHead,
          expectedPolicyReference: v.policy.reference,
          expectedBudgetHead: {
            revision: v.policyReview.budget.revision,
            headDigest: v.policyReview.budget.headDigest,
          },
          expectedGlobalRunCount: v.runs.globalCount,
          expectedProductionRunCount: v.runs.productionCount,
          approval: {
            noticeVersion: 1,
            acknowledgedCandidate: true,
            acknowledgedCurrentBudget: true,
            acknowledgedReservationOnly: true,
            acknowledgedFinancialBasisNotTokenFit: true,
            acknowledgedRetention: true,
            acknowledgedNoAutomaticRetry: true,
            transmission: "separate-approval-required",
            approvedAt: new Date().toISOString(),
          },
        },
      };
    }
    if (!state.additionalReservation) return fail();
    const result = store.providerTransmissionReview({
      runId: state.additionalReservation.runId,
      runDigest: state.additionalReservation.runDigest,
    });
    if (
      result.status !== "review" ||
      result.review.schemaVersion !== 2 ||
      result.review.assessment.state !== "conditions-met"
    )
      return fail();
    const v = result.review;
    return {
      review: v,
      command: {
        commandVersion: 1,
        kind: "approve-provider-transmission",
        clientRequestId: randomUUID(),
        runId: v.run.id,
        runDigest: v.run.runDigest,
        approvedReviewDigest: v.reviewDigest,
        expectedArchiveDigest: v.archiveDigest,
        expectedCoverageDigest: v.coverageDigest,
        expectedReservationBindingDigest: v.reservation.bindingDigest,
        expectedManifestDigest: v.manifest.manifestDigest,
        expectedRun: { revision: 0, snapshotDigest: v.run.snapshotDigest },
        expectedPolicyHead: v.policy.head,
        expectedPolicyReference: v.policy.reservedReference,
        expectedBudgetHead: { revision: v.budget.revision, headDigest: v.budget.headDigest },
        approval: {
          noticeVersion: 1,
          acknowledgedExternalTransmission: true,
          acknowledgedGenerationAndDerivedReview: true,
          acknowledgedRetentionNoticeDigest: digest(v.retention),
          acknowledgedFinancialReservationNotTokenFit: true,
          acknowledgedUnknownCostHoldAndNoRetry: true,
          acknowledgedCurrentPolicyAndBudget: true,
          approvedAt: new Date().toISOString(),
        },
      },
    };
  }
  prepare() {
    let state = this.reconcile(); // All original/suffix commands BEFORE current key/configuration.
    if (!state.journal.additional) {
      this.journal.appendAdditionalApproval(state.evidence);
      state = this.audit();
    }
    for (const stage of stages) {
      const saved = state.journal.additional?.steps[stage] ?? fail();
      if (saved.receipt !== null) continue;
      const envelope = schemas[stage].parse(
        saved.command ?? this.journal.prepareAdditional(stage, this.build(stage, state)),
      );
      // Audit the durable command before any writer; the core then audits/CAS-checks under its lock.
      this.audit();
      const store = this.writer();
      if (stage === "policy") store.providerPolicyAdopt(envelope.command, envelope.review);
      else if (stage === "reserve") store.providerReserve(envelope.command, envelope.review);
      else store.providerApproveTransmission(envelope.command, envelope.review);
      // Only the independently audited exact original record may acknowledge a COMMIT.
      state = this.reconcile();
      if (state.journal.additional?.steps[stage].receipt === null) return fail();
    }
    const approval = state.additionalApproval ?? fail();
    return {
      runId: approval.runId,
      runDigest: approval.runDigest,
      approvalBindingDigest: approval.recordDigest,
    };
  }
}
