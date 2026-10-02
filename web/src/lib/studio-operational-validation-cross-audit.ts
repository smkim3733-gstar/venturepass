import "server-only";
import { z } from "zod";
import type { AdditionalValidationJournal } from "../../scripts/operational-validation-journal.mjs";
import { createAdditionalValidationApproval } from "../../scripts/operational-validation-additional-records.mjs";
import type {
  AdditionalValidationEvidence,
  AdditionalValidationApproval,
} from "../../scripts/operational-validation-additional-records.mjs";
import {
  providerDigest as digest,
  providerBudgetScope,
} from "../../scripts/local-data-quality-provider.mjs";
import { getProviderExecutionBudgetSnapshot } from "../../scripts/local-data-quality-provider-execution.mjs";
import type { PlanQualityStore } from "./studio-plan-quality-store";
import { validateAdditionalDatabaseProof } from "./studio-operational-validation-history";
import { providerArchivedSnapshot } from "./studio-plan-quality-provider-store";
import type { inspectLedgerDatabase } from "./studio-plan-quality-ledger-database";
import {
  candidateRegistrySnapshotSchema,
  candidateRegistryReceiptSchema,
  candidateRegistryRegisterSchema,
  candidateRegistryRequestDigestInput,
} from "./studio-plan-quality-candidate-registry-types";
import {
  providerPolicyAdoptionRecordSchema,
  versionedProviderPolicyAdoptionRecordSchema,
} from "./studio-plan-quality-provider-policy-adoption-types";
import { providerPolicyAdoptionCommandSchema } from "./studio-plan-quality-provider-policy-adoption-command";
import {
  providerPolicyReviewSchema,
  providerPolicyReviewDigestInput,
} from "./studio-plan-quality-provider-policy-review-types";
import { isProviderPolicyApprovalBeforeReview } from "./studio-plan-quality-provider-policy-adoption";
import {
  providerReservationBindingSchema,
  versionedProviderReservationBindingSchema,
} from "./studio-plan-quality-provider-reservation-archive-types";
import { providerReservationCommandSchema } from "./studio-plan-quality-provider-reservation-command";
import { providerReservationReviewSchema } from "./studio-plan-quality-provider-reservation-review-types";
import {
  providerTransmissionApprovalBindingSchema,
  versionedProviderTransmissionApprovalBindingSchema,
} from "./studio-plan-quality-provider-transmission-approval-types";
import { providerTransmissionCommandSchema } from "./studio-plan-quality-provider-transmission-command";
import {
  providerTransmissionReviewSchema,
  versionedProviderTransmissionReviewSchema,
} from "./studio-plan-quality-provider-transmission-review-types";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const units = z.string().regex(/^(0|[1-9]\d{0,79})$/);
const selectionSchema = z
  .object({ runId: z.string().uuid(), runDigest: hash, approvalBindingDigest: hash })
  .strict();
const attemptSchema = z
  .object({ selection: selectionSchema, automaticRetryAllowed: z.literal(false) })
  .strict();
const checkpointSchema = z
  .object({
    runRevision: z.number().int().min(1).max(20),
    snapshotDigest: hash,
    budgetRevision: z.number().int().positive().max(1000),
    budgetHeadDigest: hash,
    recognizedUnits: units,
    heldUnits: units,
  })
  .strict();
type PreparationStage = "policy" | "reserve" | "approve-transmission";
const candidateId = "validation-candidate-mfg-new-seal-inspection";
const fail = (): never => {
  throw Error("VALIDATION_HISTORY_MISMATCH");
};
const same = (a: unknown, b: unknown) => {
  if (digest(a) !== digest(b)) fail();
};
const envelope = <T extends z.ZodType>(command: T, review: z.ZodType) =>
  z.object({ command, review }).strict();

/** Read-only reconciliation. File identities/lease are checked on both sides of ONE full DB
 * snapshot. A missing file acknowledgement can recover its exact stored record; a file ack
 * without that record is never authority to recreate it. No clock, configuration or transport.
 */
export function auditAdditionalValidationJournal(
  store: Pick<PlanQualityStore, "inspectOperationalValidationHistory">,
  journal: Pick<AdditionalValidationJournal, "readAuditView">,
) {
  const before = journal.readAuditView();
  const originalAttempt = attemptSchema.parse(before.steps.execute.command);
  const completed =
    before.steps["continue-review"].command === null
      ? before.steps.execute
      : before.steps["continue-review"];
  const completion = checkpointSchema.parse(completed.receipt);
  if (completion.runRevision !== 10 || completion.heldUnits !== "0") fail();
  const proof = store.inspectOperationalValidationHistory({
    runId: originalAttempt.selection.runId,
    budgetRevision: completion.budgetRevision,
  });
  const evidence = createAdditionalValidationApproval({
    original: before.original,
    selection: originalAttempt.selection,
    checkpoint: completion,
    databaseDigest: proof.databaseDigest,
  }).payload as AdditionalValidationApproval;
  validateAdditionalDatabaseProof(proof, evidence);
  const material = proof.material ?? fail();
  const registries = z.array(candidateRegistrySnapshotSchema).length(1).parse(material.registries);
  const registry = registries[0];
  const registered = z
    .array(candidateRegistryReceiptSchema)
    .length(1)
    .parse(material.registrationReceipts)[0];
  const registration = envelope(candidateRegistryRegisterSchema, z.null()).parse(
    before.steps.register.command,
  );
  if (registry.version !== 1 || registration.command.expectedVersion !== 0) fail();
  same(registration.command.sourceDigest, registry.sourceDigest);
  same(registered.clientRequestId, registration.command.clientRequestId);
  same(registered.inputDigest, digest(candidateRegistryRequestDigestInput(registration.command)));
  same(registered.versionDigest, registry.versionDigest);
  same(registry.clientRequestId, registered.clientRequestId);
  same(before.steps.register.receipt, { recordDigest: digest(registered) });

  const policies = z
    .array(
      z.union([providerPolicyAdoptionRecordSchema, versionedProviderPolicyAdoptionRecordSchema]),
    )
    .parse(material.policies);
  const reservations = z
    .array(z.union([providerReservationBindingSchema, versionedProviderReservationBindingSchema]))
    .parse(material.reservations);
  const approvals = z
    .array(
      z.union([
        providerTransmissionApprovalBindingSchema,
        versionedProviderTransmissionApprovalBindingSchema,
      ]),
    )
    .parse(material.approvals);
  const state = material.provider as ReturnType<typeof inspectLedgerDatabase>["provider"];
  const scope = providerBudgetScope("production");
  if (
    state.runs.some((run) => run.environment !== "production") ||
    state.budgetEvents.some((event) => event.scopeId !== scope) ||
    proof.current.providerReservationCoverage !== 1 ||
    proof.current.providerTransmissionCoverage !== 1
  )
    fail();
  const used = new Set<string>();
  const recoverable: Array<{ stage: PreparationStage; record: object }> = [];
  function candidate(command: { candidateId: string; version: number; versionDigest: string }) {
    if (
      command.candidateId !== candidateId ||
      command.version !== 1 ||
      command.versionDigest !== registry.versionDigest
    )
      fail();
  }
  function bind(stage: PreparationStage, additional: boolean) {
    const saved = additional ? before.additional?.steps[stage] : before.steps[stage];
    if (!saved || saved.command === null) {
      if (saved?.receipt !== null && saved?.receipt !== undefined) fail();
      return null;
    }
    const parsed =
      stage === "policy"
        ? envelope(providerPolicyAdoptionCommandSchema, providerPolicyReviewSchema).parse(
            saved.command,
          )
        : stage === "reserve"
          ? envelope(providerReservationCommandSchema, providerReservationReviewSchema).parse(
              saved.command,
            )
          : envelope(
              providerTransmissionCommandSchema,
              additional
                ? versionedProviderTransmissionReviewSchema
                : providerTransmissionReviewSchema,
            ).parse(saved.command);
    if ("candidateId" in parsed.command) candidate(parsed.command);
    const nonce = parsed.command.clientRequestId;
    if (used.has(nonce)) fail();
    used.add(nonce);
    const rows = stage === "policy" ? policies : stage === "reserve" ? reservations : approvals;
    const found = rows.find((row) => row.clientRequestId === nonce);
    if (!found) {
      if (!additional || saved.receipt !== null || material.nonces.includes(nonce)) fail();
      return null;
    }
    if (found.recordVersion !== (additional ? 2 : 1)) fail();
    same(found.command, parsed.command);
    same(found.approvedReview, parsed.review);
    if (saved.receipt !== null) same(saved.receipt, { recordDigest: digest(found) });
    else if (additional) recoverable.push({ stage, record: found });
    else fail();
    return found;
  }
  const policy = providerPolicyAdoptionRecordSchema.parse(bind("policy", false));
  const reservation = providerReservationBindingSchema.parse(bind("reserve", false));
  const approval = providerTransmissionApprovalBindingSchema.parse(
    bind("approve-transmission", false),
  );
  if (policy.revision !== 1 || policy.command.budgetAction !== "initialize-proposed-budget") fail();
  same(policy.command.expectedPolicyHead, { revision: 0, headDigest: null });
  const budgetOnly = state.receipts.filter((receipt) => receipt.runId === null);
  if (
    budgetOnly.length !== 1 ||
    budgetOnly[0].clientRequestId !== policy.command.initialBudgetRequestId
  )
    fail();
  same(reservation.command.expectedPolicyReference, {
    revision: 1,
    recordDigest: policy.recordDigest,
    clientRequestId: policy.clientRequestId,
    recordedAt: policy.recordedAt,
  });
  same(originalAttempt.selection, {
    runId: approval.runId,
    runDigest: approval.runDigest,
    approvalBindingDigest: approval.recordDigest,
  });
  same(
    { runId: reservation.runId, runDigest: reservation.runDigest },
    { runId: approval.runId, runDigest: approval.runDigest },
  );

  function checkpoint(raw: unknown, selection: z.infer<typeof selectionSchema>) {
    const value = checkpointSchema.parse(raw);
    const snapshot = providerArchivedSnapshot(
      state,
      selection.runId,
      (version) => {
        if (version !== registry.version) return fail();
        return registry;
      },
      value.runRevision,
    );
    if (snapshot.archiveFormatVersion !== 3 && snapshot.archiveFormatVersion !== 5) return fail();
    if (snapshot.run.runDigest !== selection.runDigest) fail();
    const events = state.budgetEvents.filter(
      (event) => event.scopeId === scope && event.revision <= value.budgetRevision,
    );
    const budget = getProviderExecutionBudgetSnapshot(events, scope);
    if (snapshot.events.at(-1)!.budgetRevision > budget.revision) fail();
    same(value, {
      runRevision: snapshot.revision,
      snapshotDigest: snapshot.snapshotDigest,
      budgetRevision: budget.revision,
      budgetHeadDigest: budget.headDigest,
      recognizedUnits: budget.recognizedUnits,
      heldUnits: budget.heldUnits,
    });
    return snapshot;
  }
  function attempts(
    steps: typeof before.steps | NonNullable<typeof before.additional>["steps"],
    selection: z.infer<typeof selectionSchema>,
    required: boolean,
  ) {
    for (const stage of ["execute", "continue-review"] as const) {
      const saved = steps[stage];
      if (saved.command === null) {
        if (saved.receipt !== null || (required && stage === "execute")) fail();
        continue;
      }
      same(attemptSchema.parse(saved.command).selection, selection);
      if (stage === "continue-review") {
        if (steps.execute.command === null) fail();
        const initial = checkpoint(steps.execute.receipt, selection);
        if (
          initial.revision !== 5 ||
          initial.state !== "validated" ||
          initial.dispatchIntentCount !== 1
        )
          fail();
      }
      if (saved.receipt !== null) {
        const observed = checkpoint(saved.receipt, selection);
        if (
          stage === "execute" &&
          observed.revision === 5 &&
          steps["continue-review"].command === null &&
          state.events.some((event) => event.runId === selection.runId && event.revision > 5)
        )
          fail();
      } else if (required) fail();
    }
  }
  attempts(before.steps, originalAttempt.selection, true);
  if (before.rejection) {
    const rejected = envelope(
      providerPolicyAdoptionCommandSchema,
      providerPolicyReviewSchema,
    ).parse(before.rejection.command);
    candidate(rejected.command);
    const review = providerPolicyReviewSchema.parse(rejected.review);
    if (
      !isProviderPolicyApprovalBeforeReview(rejected.command, review) ||
      rejected.command.expectedPolicyHead.revision !== 0 ||
      rejected.command.budgetAction !== "initialize-proposed-budget" ||
      review.budget.revision !== 0
    )
      fail();
    same(rejected.command.approvedReviewDigest, review.reviewDigest);
    same(review.reviewDigest, digest(providerPolicyReviewDigestInput(review)));
    same(
      {
        candidateId: review.scope.candidateId,
        version: review.scope.version,
        versionDigest: review.scope.versionDigest,
      },
      {
        candidateId: rejected.command.candidateId,
        version: rejected.command.version,
        versionDigest: rejected.command.versionDigest,
      },
    );
    const nonces = [rejected.command.clientRequestId, rejected.command.initialBudgetRequestId];
    if (
      nonces.some(
        (nonce) =>
          nonce === null ||
          material.nonces.includes(nonce) ||
          nonce === policy.command.clientRequestId ||
          nonce === policy.command.initialBudgetRequestId,
      )
    )
      fail();
    same(before.rejection.evidence, {
      schemaVersion: 1,
      reason: "approval-before-review",
      commandDigest: digest(rejected),
      registrationDigest: digest(registered),
      databaseDigest: material.registrationDatabaseDigest,
    });
  }

  let additionalPolicy: z.infer<typeof versionedProviderPolicyAdoptionRecordSchema> | null = null;
  let additionalReservation: z.infer<typeof versionedProviderReservationBindingSchema> | null =
    null;
  let additionalApproval: z.infer<
    typeof versionedProviderTransmissionApprovalBindingSchema
  > | null = null;
  if (before.additional) {
    same(before.additional.approval, evidence);
    const rawPolicy = bind("policy", true);
    additionalPolicy = rawPolicy
      ? versionedProviderPolicyAdoptionRecordSchema.parse(rawPolicy)
      : null;
    // Enforce the same candidate and existing budget even before an unacknowledged write.
    const pendingPolicy = before.additional.steps.policy.command;
    if (pendingPolicy !== null) {
      const command = envelope(
        providerPolicyAdoptionCommandSchema,
        providerPolicyReviewSchema,
      ).parse(pendingPolicy).command;
      if (
        command.budgetAction !== "keep-existing-budget" ||
        command.initialBudgetRequestId !== null
      )
        fail();
      same(command.expectedPolicyHead, { revision: 1, headDigest: policy.recordDigest });
    }
    if (
      additionalPolicy &&
      (additionalPolicy.revision !== 2 ||
        additionalPolicy.reviewedProposal.proposal.requestReview.contract.baseContract
          .engineVersion !== "plan-observation-v2")
    )
      fail();
    const rawReservation = bind("reserve", true);
    additionalReservation = rawReservation
      ? versionedProviderReservationBindingSchema.parse(rawReservation)
      : null;
    if (before.additional.steps.reserve.command !== null) {
      if (!additionalPolicy) return fail();
      const command = envelope(
        providerReservationCommandSchema,
        providerReservationReviewSchema,
      ).parse(before.additional.steps.reserve.command).command;
      same(command.expectedPolicyReference, {
        revision: 2,
        recordDigest: additionalPolicy.recordDigest,
        clientRequestId: additionalPolicy.clientRequestId,
        recordedAt: additionalPolicy.recordedAt,
      });
    }
    const rawApproval = bind("approve-transmission", true);
    additionalApproval = rawApproval
      ? versionedProviderTransmissionApprovalBindingSchema.parse(rawApproval)
      : null;
    if (before.additional.steps["approve-transmission"].command !== null) {
      if (!additionalReservation) return fail();
      const command = envelope(
        providerTransmissionCommandSchema,
        versionedProviderTransmissionReviewSchema,
      ).parse(before.additional.steps["approve-transmission"].command).command;
      same(
        { runId: command.runId, runDigest: command.runDigest },
        { runId: additionalReservation.runId, runDigest: additionalReservation.runDigest },
      );
    }
    if (additionalReservation) {
      const runId = additionalReservation.runId;
      const run = state.runs.find((run) => run.id === runId);
      if (!run || run.preparation.contract.baseContract.engineVersion !== "plan-observation-v2")
        fail();
    }
    if (
      additionalReservation &&
      before.additional.steps.execute.command === null &&
      state.events.some(
        (event) => event.runId === additionalReservation?.runId && event.revision > 1,
      )
    )
      fail();
    if (additionalApproval)
      attempts(
        before.additional.steps,
        {
          runId: additionalApproval.runId,
          runDigest: additionalApproval.runDigest,
          approvalBindingDigest: additionalApproval.recordDigest,
        },
        false,
      );
    else if (
      before.additional.steps.execute.command !== null ||
      before.additional.steps["continue-review"].command !== null
    )
      fail();
  }
  if (
    policies.length !== 1 + Number(!!additionalPolicy) ||
    reservations.length !== 1 + Number(!!additionalReservation) ||
    approvals.length !== 1 + Number(!!additionalApproval) ||
    state.runs.length !== reservations.length
  )
    fail();
  same(journal.readAuditView(), before); // No file advance/substitution across the DB snapshot.
  const { scope: _scope, ...approvalEvidence } = evidence;
  void _scope;
  return {
    evidence: approvalEvidence as AdditionalValidationEvidence,
    current: proof.current,
    currentBudget: proof.currentBudget,
    // All values below come from this same fully audited snapshot, not current authority.
    registry,
    journal: before,
    additionalPolicy,
    additionalReservation,
    additionalApproval,
    additionalSnapshot: additionalReservation
      ? (state.snapshots.find((row) => row.run.id === additionalReservation.runId) ?? fail())
      : null,
    recoverable,
    originalCommandsAudited: true as const,
    additionalCommandsAudited: true as const,
    fileIdentityAudited: true as const,
    ledgerAudited: true as const,
    transmissionAllowed: false as const,
  };
}
