import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ValidationJournal } from "../../scripts/operational-validation-journal.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import { createCandidateRegistrySource } from "./studio-plan-quality-candidate-registry";
import {
  candidateRegistryRegisterSchema,
  candidateRegistryRequestDigestInput,
  candidateRegistryReceiptSchema,
} from "./studio-plan-quality-candidate-registry-types";
import { getProviderConfigurationProposal } from "./studio-plan-quality-provider-configuration";
import { createProviderPolicyReview } from "./studio-plan-quality-provider-policy-review";
import {
  providerPolicyReviewSchema,
  providerPolicyReviewDigestInput,
} from "./studio-plan-quality-provider-policy-review-types";
import { isProviderPolicyApprovalBeforeReview } from "./studio-plan-quality-provider-policy-adoption";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import { providerPolicyAdoptionRecordSchema } from "./studio-plan-quality-provider-policy-adoption-types";
import { providerReservationCommandSchema } from "./studio-plan-quality-provider-reservation-command";
import { providerReservationReviewSchema } from "./studio-plan-quality-provider-reservation-review-types";
import { providerReservationBindingSchema } from "./studio-plan-quality-provider-reservation-archive-types";
import { providerTransmissionCommandSchema } from "./studio-plan-quality-provider-transmission-command";
import { providerTransmissionReviewSchema } from "./studio-plan-quality-provider-transmission-review-types";
import { providerTransmissionApprovalBindingSchema } from "./studio-plan-quality-provider-transmission-approval-types";

export const operationalCandidateId = "validation-candidate-mfg-new-seal-inspection";
const stages = ["register", "policy", "reserve", "approve-transmission"] as const;
type Stage = (typeof stages)[number];
const schemas = {
  register: z.object({ command: candidateRegistryRegisterSchema, review: z.null() }).strict(),
  policy: z
    .object({ command: providerPolicyAdoptionCommandSchema, review: providerPolicyReviewSchema })
    .strict(),
  reserve: z
    .object({ command: providerReservationCommandSchema, review: providerReservationReviewSchema })
    .strict(),
  "approve-transmission": z
    .object({
      command: providerTransmissionCommandSchema,
      review: providerTransmissionReviewSchema,
    })
    .strict(),
};
type Envelope = { command: { clientRequestId: string } & Record<string, unknown>; review: unknown };
const requireSame = (one: unknown, two: unknown) => {
  if (digest(one) !== digest(two)) throw Error("VALIDATION_HISTORY_MISMATCH");
};
const fail = (): never => {
  throw Error("VALIDATION_HISTORY_MISMATCH");
};
const rejectionEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  reason: z.literal("approval-before-review"),
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
  registrationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  databaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Trusted local composition of existing audited writers. No fixture, SQL, key or transport. */
export class OperationalValidationPreparation {
  constructor(
    private readonly store: PlanQualityStore,
    private readonly journal: ValidationJournal,
  ) {}
  private impossiblePolicy(raw: unknown) {
    const envelope = schemas.policy.parse(raw);
    const { command, review } = envelope;
    if (!isProviderPolicyApprovalBeforeReview(command, review) ||
      command.expectedPolicyHead.revision !== 0 ||
      command.budgetAction !== "initialize-proposed-budget" ||
      review.budget.revision !== 0 ||
      command.candidateId !== review.scope.candidateId ||
      command.version !== review.scope.version ||
      command.versionDigest !== review.scope.versionDigest) fail();
    requireSame(command.approvedReviewDigest, review.reviewDigest);
    requireSame(digest(providerPolicyReviewDigestInput(review)), review.reviewDigest);
    if (this.lookup("policy", envelope) !== null) fail();
    return envelope;
  }
  private registrationOnlySnapshot() {
    const snapshot = this.store.inspectDatabase();
    if (snapshot.storageVersion !== 9 || snapshot.candidateVersions !== 1 ||
      snapshot.candidateRequests !== 1 || snapshot.providerPolicies !== 0 ||
      snapshot.providerReservationBindings !== 0 || snapshot.providerTransmissionBindings !== 0 ||
      snapshot.runs !== 0 || snapshot.revisions !== 0 || snapshot.requests !== 0 ||
      snapshot.executionRuns !== 0 || snapshot.executionEvents !== 0 || snapshot.executionRequests !== 0 ||
      snapshot.actualBudgetEvents !== 0 || snapshot.actualRuns !== 0 || snapshot.actualEvents !== 0 ||
      snapshot.actualArtifacts !== 0 || snapshot.actualRequests !== 0) fail();
    return snapshot;
  }
  private replacementIdentity(raw: unknown) {
    const rejection = this.journal.readPolicyRejection();
    if (!rejection || raw === null) return;
    const original = schemas.policy.parse(rejection.command).command;
    const replacement = schemas.policy.parse(raw).command;
    const previousIds = [original.clientRequestId, original.initialBudgetRequestId];
    if (previousIds.includes(replacement.clientRequestId) ||
      previousIds.includes(replacement.initialBudgetRequestId)) fail();
  }
  private lookup(stage: Stage, envelope: Envelope): object | null {
    const nonce = envelope.command.clientRequestId;
    if (stage === "register") {
      const command = candidateRegistryRegisterSchema.parse(envelope.command);
      if (
        command.expectedVersion !== 0 ||
        command.sourceDigest !== createCandidateRegistrySource().sourceDigest
      )
        fail();
      const result = this.store.candidateRegistryLookup(nonce);
      if (result.state !== "committed") return null;
      requireSame(result.receipt.inputDigest, digest(candidateRegistryRequestDigestInput(command)));
      return result.receipt;
    }
    if (stage === "policy" || stage === "reserve") {
      if (
        envelope.command.candidateId !== operationalCandidateId ||
        envelope.command.version !== 1 ||
        envelope.command.versionDigest !== this.store.candidateRegistryGet(1).versionDigest
      )
        fail();
    }
    const result =
      stage === "policy"
        ? this.store.providerPolicyLookup(nonce)
        : stage === "reserve"
          ? this.store.providerReservationLookup(nonce)
          : this.store.providerTransmissionApprovalLookup(nonce);
    if (result.state !== "committed") return null;
    requireSame(result.record.command, envelope.command);
    requireSame(result.record.approvedReview, envelope.review);
    return result.record;
  }
  audit() {
    const rejection = this.journal.readPolicyRejection();
    const rejected = rejection ? this.impossiblePolicy(rejection.command) : null;
    if (rejected) {
      this.replacementIdentity(this.journal.readStep("policy").command);
    }
    const records: Partial<Record<Stage, object>> = {};
    for (const stage of stages) {
      const saved = this.journal.readStep(stage);
      if (saved.command === null) {
        if (saved.receipt !== null) fail();
        continue;
      }
      const envelope = schemas[stage].parse(saved.command);
      const found = this.lookup(stage, envelope);
      if (saved.receipt !== null) {
        if (!found) fail(); // journaled COMMIT cannot be recreated after DB rollback/loss
        requireSame(saved.receipt, { recordDigest: digest(found) });
      }
      if (found) records[stage] = found;
    }
    const registered = records.register
      ? candidateRegistryReceiptSchema.parse(records.register)
      : null;
    const policy = records.policy ? providerPolicyAdoptionRecordSchema.parse(records.policy) : null;
    const reservation = records.reserve
      ? providerReservationBindingSchema.parse(records.reserve)
      : null;
    const approval = records["approve-transmission"]
      ? providerTransmissionApprovalBindingSchema.parse(records["approve-transmission"])
      : null;
    if (rejection && rejected) {
      if (!registered) fail();
      const evidence = rejectionEvidenceSchema.parse(rejection.evidence);
      requireSame(evidence.commandDigest, digest(rejected));
      requireSame(evidence.registrationDigest, digest(registered));
      // Until the replacement commits, the full registration-only DB must be unchanged.
      if (!policy) requireSame(evidence.databaseDigest, this.registrationOnlySnapshot().digest);
    }
    const catalog = this.store.candidateRegistryList();
    if (catalog.versions.length !== (registered ? 1 : 0)) fail();
    if (registered) {
      const registry = this.store.candidateRegistryGet(registered.version);
      requireSame(registry.sourceDigest, createCandidateRegistrySource().sourceDigest);
      requireSame(registry.clientRequestId, registered.clientRequestId);
      requireSame(registry.versionDigest, registered.versionDigest);
      if (registry.version !== 1) fail();
    }
    requireSame(
      this.store.providerPolicyHead(),
      policy ? { revision: 1, headDigest: policy.recordDigest } : { revision: 0, headDigest: null },
    );
    const budget = this.store.providerBudgetGet("production");
    if (policy) {
      if (
        !registered ||
        policy.command.candidateId !== operationalCandidateId ||
        policy.command.versionDigest !== registered.versionDigest ||
        budget.revision < 1 ||
        budget.currency !== "USD" ||
        budget.unitScale !== 6 ||
        budget.capUnits !== "15000000" ||
        BigInt(budget.heldUnits) + BigInt(budget.recognizedUnits) > BigInt("15000000")
      )
        fail();
    } else if (budget.revision !== 0) fail();
    const runs = this.store.providerList().executions;
    if (runs.length !== (reservation ? 1 : 0)) fail();
    if (reservation) {
      if (
        !policy ||
        reservation.command.candidateId !== operationalCandidateId ||
        reservation.command.expectedPolicyReference.recordDigest !== policy.recordDigest
      )
        fail();
      requireSame(
        { runId: runs[0].run.id, runDigest: runs[0].run.runDigest },
        { runId: reservation.runId, runDigest: reservation.runDigest },
      );
      requireSame(runs[0].run.preparation.scope.candidateId, operationalCandidateId);
      if (runs[0].run.environment !== "production") fail();
    }
    if (
      approval &&
      (!reservation ||
        approval.runId !== reservation.runId ||
        approval.runDigest !== reservation.runDigest)
    )
      fail();
    return { registered, policy, reservation, approval, budget, run: runs[0] ?? null };
  }
  private build(stage: Stage): Envelope {
    if (stage === "register")
      return {
        command: {
          expectedVersion: 0,
          clientRequestId: randomUUID(),
          sourceDigest: createCandidateRegistrySource().sourceDigest,
          acknowledgedCandidateStatus: true,
        },
        review: null,
      };
    const registered = this.store.candidateRegistryGet(1);
    const selection = {
      version: registered.version,
      versionDigest: registered.versionDigest,
      candidateId: operationalCandidateId,
    };
    if (stage === "policy") {
      const context = this.store.providerPolicyReviewContext(selection.version);
      if (context.expectedPolicyHead.revision !== 0 || context.expectedBudgetHead.revision !== 0)
        fail();
      const configuration = getProviderConfigurationProposal();
      if (
        !configuration ||
        configuration.model !== "gpt-5.4-2026-03-05" ||
        configuration.proposedBudget.capUnits !== "15000000" ||
        configuration.conditions.maxCalls !== 2 ||
        configuration.conditions.retries !== 0
      )
        fail();
      const result = createProviderPolicyReview({
        ...context,
        candidateId: selection.candidateId,
        configuration,
      });
      if (result.status !== "review") throw Error("VALIDATION_REVIEW_UNAVAILABLE");
      return {
        review: result.review,
        command: {
          commandVersion: 1,
          kind: "adopt-provider-policy",
          clientRequestId: randomUUID(),
          ...selection,
          expectedPolicyHead: context.expectedPolicyHead,
          approvedReviewDigest: result.review.reviewDigest,
          budgetAction: context.expectedBudgetHead.revision
            ? "keep-existing-budget"
            : "initialize-proposed-budget",
          initialBudgetRequestId: context.expectedBudgetHead.revision ? null : randomUUID(),
          approval: {
            noticeVersion: 1,
            acknowledgedPolicy: true,
            acknowledgedBudgetAction: true,
            reservationAndTransmission: "separate-approval-required",
            // Approval follows the completed review, including time spent auditing storage.
            approvedAt: new Date().toISOString(),
          },
        },
      };
    }
    if (stage === "reserve") {
      const result = this.store.providerReservationReview(selection);
      if (result.status !== "review" || result.review.assessment.state !== "conditions-met")
        throw Error("VALIDATION_REVIEW_UNAVAILABLE");
      const v = result.review;
      if (v.runs.globalCount !== 0 || v.policyHead.revision !== 1) fail();
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
    const reservedEnvelope = schemas.reserve.parse(this.journal.readStep("reserve").command);
    const reservation = providerReservationBindingSchema.parse(
      this.lookup("reserve", reservedEnvelope),
    );
    const result = this.store.providerTransmissionReview({
      runId: reservation.runId,
      runDigest: reservation.runDigest,
    });
    if (result.status !== "review" || result.review.assessment.state !== "conditions-met")
      throw Error("VALIDATION_REVIEW_UNAVAILABLE");
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
    const initial = this.audit(); // Reconcile ALL existing steps before any new write.
    if (initial.approval && this.journal.readStep("approve-transmission").receipt !== null)
      return {
        runId: initial.approval.runId,
        runDigest: initial.approval.runDigest,
        approvalBindingDigest: initial.approval.recordDigest,
      };
    for (const stage of stages) {
      const saved = this.journal.readStep(stage);
      const envelope = schemas[stage].parse(
        saved.command ?? this.journal.prepare(stage, this.build(stage)),
      );
      if (stage === "policy") this.replacementIdentity(envelope);
      let found = this.lookup(stage, envelope);
      if (!found) {
        if (saved.receipt !== null) fail();
        if (stage === "register")
          this.store.candidateRegistryRegister(
            candidateRegistryRegisterSchema.parse(envelope.command),
          );
        else if (stage === "policy")
          this.store.providerPolicyAdopt(envelope.command, envelope.review);
        else if (stage === "reserve") this.store.providerReserve(envelope.command, envelope.review);
        else this.store.providerApproveTransmission(envelope.command, envelope.review);
        found = this.lookup(stage, envelope);
      }
      if (!found) fail();
      // Each core writer/lookup audits its transaction. Audit the complete resulting prefix
      // once below, before exposing an executable selection, rather than redoing it per row.
      this.journal.acknowledge(stage, { recordDigest: digest(found) });
    }
    const result = this.audit();
    if (!result.approval) return fail();
    return {
      runId: result.approval.runId,
      runDigest: result.approval.runDigest,
      approvalBindingDigest: result.approval.recordDigest,
    };
  }
  /** Explicit, transport-free recovery. Never rewrite a command or infer failure from lookup alone. */
  recoverPolicy() {
    const state = this.audit();
    if (!state.registered || state.policy || state.reservation || state.approval || state.run ||
      state.budget.revision !== 0 || this.journal.readStep("execute").command !== null) fail();
    const snapshot = this.registrationOnlySnapshot();
    const previous = this.journal.readPolicyRejection();
    if (!previous) {
      const saved = this.journal.readStep("policy");
      if (saved.command === null || saved.receipt !== null) fail();
      const original = this.impossiblePolicy(saved.command);
      this.journal.rejectPendingPolicy({
        schemaVersion: 1,
        reason: "approval-before-review",
        commandDigest: digest(original),
        registrationDigest: digest(state.registered),
        databaseDigest: snapshot.digest,
      });
    }
    // A new review is created only by a subsequent explicit prepare, immediately before
    // its DB write. The user can pause here without consuming that review's short lifetime.
    this.audit();
    return { state: "impossible-policy-rejection-preserved" as const, transmissionAllowed: false as const };
  }
}
