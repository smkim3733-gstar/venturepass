import { z } from "zod";
import { inspectProviderTransmissionApprovalArchive } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  providerExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  providerDigest as digest,
  providerRawDigest,
  providerWireDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import { createProviderTransmissionReview } from "./studio-plan-quality-provider-transmission-review";
import type {
  ProviderExecutionCommand,
  ProviderExecutionEvent,
  ProviderExecutionReceipt,
} from "./studio-plan-quality-provider-execution-types";
import type { ProviderObservationPrepared } from "./studio-provider-observation";

export const providerGenerationDispatchIdentitySchema = z
  .object({
    runId: z.string().uuid(),
    runDigest: z.string().regex(/^[a-f0-9]{64}$/),
    approvalBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
    preparedRequestId: z.string().uuid(),
    dispatchRequestId: z.string().uuid(),
  })
  .strict();
export type ProviderGenerationDispatchIdentity = z.infer<
  typeof providerGenerationDispatchIdentitySchema
>;
export const providerGenerationDispatchPlanLimits = { databaseBytes: 256 * 1024 * 1024 } as const;
export type ProviderGenerationDispatchInput = {
  /** Server-created identities. This is not an HTTP request or a transport configuration. */
  identity: unknown;
  inspectedAt: string;
  configuration: unknown;
  /** Complete server-owned evidence; the writer must also audit schema/raw rows and all
   * application receipts under the SAME IMMEDIATE transaction before calling this planner. */
  archive: Parameters<typeof inspectProviderTransmissionApprovalArchive>[0];
  /** Audited bytes OUTSIDE native ledger + reservation archive + approval archive, including
   * unrelated application rows and raw encoding overhead. No archive bytes may be subtracted twice. */
  additionalUsedBytes: number;
};
export type ProviderGenerationDispatchPlan = {
  planVersion: 1;
  kind: "provider-generation-dispatch-plan";
  status: "prepared-not-committed";
  transaction: "single-immediate-transaction-required";
  inspectedAt: string;
  expiresAt: string;
  basis: {
    archiveDigest: string;
    runId: string;
    runDigest: string;
    snapshotDigest: string;
    revision: 1;
    approvalBindingDigest: string;
    approvalEventDigest: string;
    configurationDigest: string;
    policyHead: { revision: number; headDigest: string | null };
    budgetHead: { revision: number; headDigest: string };
  };
  request: ProviderObservationPrepared;
  commands: {
    prepared: ProviderExecutionCommand<"request-prepared">;
    dispatch: ProviderExecutionCommand<"dispatch-intent">;
  };
  rows: {
    events: [ProviderExecutionEvent, ProviderExecutionEvent];
    receipts: [ProviderExecutionReceipt, ProviderExecutionReceipt];
  };
  capacity: {
    additionalUsedBytes: number;
    totalExposureBytes: number;
    reservedBudgetEventSlots: number;
    reservedReceiptSlots: number;
  };
  /** Neither a plan, persisted historical receipt, nor digest is a transport capability. */
  ownership: "new-commit-owner-required";
  dispatchAllowed: false;
  budgetWriteAllowed: false;
  planDigest: string;
};
type Refusal =
  | "invalid-input"
  | "archive-invalid"
  | "selection-changed"
  | "approval-binding-required"
  | "first-generation-required"
  | "nonce-conflict"
  | "approval-expired-or-future"
  | "current-evidence-unavailable"
  | "policy-or-budget-blocked"
  | "bindings-changed"
  | "request-changed"
  | "capacity-exceeded"
  | "planned-archive-invalid";
export type ProviderGenerationDispatchResult =
  | { status: "prepared"; plan: ProviderGenerationDispatchPlan }
  | { status: "refused"; reason: Refusal; plan: null };
const refuse = (reason: Refusal): ProviderGenerationDispatchResult => ({
  status: "refused",
  reason,
  plan: null,
});
const same = (a: unknown, b: unknown) => digest(a) === digest(b);

/** NEW generation only, from a fully bound production r1 approval. No DB, SDK, credentials,
 * clock lookup or transport. Never replay this plan to obtain sending ownership. The durable
 * writer must rebuild it under its lock and return ownership only to a known NEW commit;
 * uncertain COMMIT and historical lookup/replay must never send. Existing synthetic gates stay shut. */
export function prepareProviderGenerationDispatch(
  input: ProviderGenerationDispatchInput,
): ProviderGenerationDispatchResult {
  const parsed = providerGenerationDispatchIdentitySchema.safeParse(input.identity);
  if (
    !parsed.success ||
    !z.string().datetime().safeParse(input.inspectedAt).success ||
    !Number.isSafeInteger(input.additionalUsedBytes) ||
    input.additionalUsedBytes < 0
  )
    return refuse("invalid-input");
  const identity = parsed.data;
  if (identity.preparedRequestId === identity.dispatchRequestId) return refuse("nonce-conflict");
  const inspectedAt = new Date(input.inspectedAt).toISOString(),
    now = Date.parse(inspectedAt);
  let archive: ReturnType<typeof inspectProviderTransmissionApprovalArchive>;
  try {
    archive = inspectProviderTransmissionApprovalArchive(input.archive);
  } catch {
    return refuse("archive-invalid");
  }
  const state = archive.reservationArchive.ledger;
  const snapshot = state.provider.snapshots.find((row) => row.run.id === identity.runId);
  if (!snapshot || snapshot.run.runDigest !== identity.runDigest)
    return refuse("selection-changed");
  const binding = archive.records.find((row) => row.runId === identity.runId);
  if (!binding || binding.recordDigest !== identity.approvalBindingDigest)
    return refuse("approval-binding-required");
  if (
    snapshot.run.environment !== "production" ||
    snapshot.archiveFormatVersion !== 3 ||
    snapshot.revision !== 1 ||
    snapshot.state !== "approved" ||
    snapshot.events.length !== 1
  )
    return refuse("first-generation-required");
  const approval = snapshot.events[0];
  if (
    approval.payload.kind !== "transmission-approved" ||
    approval.eventDigest !== binding.approvalEventDigest
  )
    return refuse("bindings-changed");
  const used = new Set([
    ...(input.archive.archive.ledger.otherNonces ?? []),
    ...state.legacy.receipts.map((row) => row.clientRequestId),
    ...state.provider.receipts.map((row) => row.clientRequestId),
    ...state.policy.records.map((row) => row.clientRequestId),
  ]);
  if (used.has(identity.preparedRequestId) || used.has(identity.dispatchRequestId))
    return refuse("nonce-conflict");
  if (
    now < Date.parse(binding.recordedAt) ||
    now < Date.parse(approval.payload.approvedAt) ||
    now >= Date.parse(approval.payload.expiresAt) ||
    now >= Date.parse(binding.approvedReview.expiresAt)
  )
    return refuse("approval-expired-or-future");

  // This read-only review deliberately reports runUntouched=false for r1. We use its other
  // reconstructed facts, never its approval eligibility or its newly calculated review expiry.
  const current = createProviderTransmissionReview({
    selection: { runId: identity.runId, runDigest: identity.runDigest },
    inspectedAt,
    configuration: input.configuration,
    archive: input.archive.archive,
  });
  if (current.status !== "review") return refuse("current-evidence-unavailable");
  const review = current.review;
  if (
    !review.facts.policyUnchanged ||
    !review.facts.reservationIntact ||
    !review.facts.budgetCompatible ||
    !review.facts.budgetWithinBound
  )
    return refuse("policy-or-budget-blocked");
  if (
    review.configurationDigest !== binding.approvedReview.configurationDigest ||
    review.reservation.bindingDigest !== binding.approvedReview.reservation.bindingDigest ||
    review.run.snapshotDigest !== snapshot.snapshotDigest ||
    !same(review.manifest, binding.approvedReview.manifest) ||
    !same(review.manifest, approval.payload.manifest) ||
    !same(review.request, binding.approvedReview.request) ||
    !same(review.retention, binding.approvedReview.retention)
  )
    return refuse("bindings-changed");
  const prep = snapshot.run.preparation;
  const artifact = state.provider.artifacts.find(
    (row) => row.runId === identity.runId && row.key === "generation-request",
  );
  if (
    !artifact ||
    artifact.body !== JSON.stringify(prep.generation.body) ||
    artifact.sha256 !== prep.generation.sha256 ||
    providerRawDigest(artifact.body) !== artifact.sha256 ||
    providerWireDigest(prep.generation.body) !== prep.generation.requestDigest ||
    prep.generation.body.model !== prep.model
  )
    return refuse("request-changed");
  if (!review.budget.headDigest) return refuse("policy-or-budget-blocked");

  try {
    const prepared: ProviderExecutionCommand<"request-prepared"> = {
      clientRequestId: identity.preparedRequestId,
      expectedRevision: 1,
      payload: {
        kind: "request-prepared",
        phase: "generation",
        requestDigest: prep.generation.requestDigest,
        artifactSha256: artifact.sha256,
        derivedFrom: null,
        budgetRevision: review.budget.revision,
        budgetDigest: review.budget.headDigest,
      },
    };
    const event = createProviderExecutionEvent({
      schemaVersion: 2,
      executionContractVersion: 1,
      runId: identity.runId,
      revision: 2,
      budgetRevision: review.budget.revision,
      previousEventDigest: approval.eventDigest,
      recordedAt: inspectedAt,
      payload: prepared.payload,
    });
    const dispatch: ProviderExecutionCommand<"dispatch-intent"> = {
      clientRequestId: identity.dispatchRequestId,
      expectedRevision: 2,
      payload: {
        kind: "dispatch-intent",
        phase: "generation",
        requestDigest: prep.generation.requestDigest,
        artifactSha256: artifact.sha256,
        preparedEventDigest: event.eventDigest,
        approvalEventDigest: approval.eventDigest,
        budgetRevision: review.budget.revision,
        budgetDigest: review.budget.headDigest,
      },
    };
    const dispatchEvent = createProviderExecutionEvent({
      schemaVersion: 2,
      executionContractVersion: 1,
      runId: identity.runId,
      revision: 3,
      budgetRevision: review.budget.revision,
      previousEventDigest: event.eventDigest,
      recordedAt: inspectedAt,
      payload: dispatch.payload,
    });
    const receipt = (
      command: typeof prepared | typeof dispatch,
      row: ProviderExecutionEvent,
      kind: "provider-prepared" | "provider-dispatch",
    ) =>
      createProviderExecutionReceipt({
        schemaVersion: 2,
        scopeId: review.budget.scopeId,
        kind,
        clientRequestId: command.clientRequestId,
        inputDigest: providerExecutionOperationDigest(identity.runId, command),
        runId: identity.runId,
        runRevision: row.revision,
        budgetRevision: row.budgetRevision,
        operationDigest: row.eventDigest,
        recordedAt: inspectedAt,
      });
    const rows: ProviderGenerationDispatchPlan["rows"] = {
      events: [event, dispatchEvent],
      receipts: [
        receipt(prepared, event, "provider-prepared"),
        receipt(dispatch, dispatchEvent, "provider-dispatch"),
      ],
    };
    const ledger = input.archive.archive.ledger;
    const next = inspectProviderTransmissionApprovalArchive({
      ...input.archive,
      archive: {
        ...input.archive.archive,
        ledger: {
          ...ledger,
          events: [...ledger.events, ...rows.events],
          receipts: [...ledger.receipts, ...rows.receipts],
        },
      },
    });
    const native = next.reservationArchive.ledger;
    const totalExposureBytes =
      native.usedBytes +
      native.reservedBytes +
      next.reservationArchive.usedBytes +
      next.usedBytes +
      input.additionalUsedBytes;
    if (
      !Number.isSafeInteger(totalExposureBytes) ||
      totalExposureBytes > providerGenerationDispatchPlanLimits.databaseBytes
    )
      return refuse("capacity-exceeded");
    const plan: Omit<ProviderGenerationDispatchPlan, "planDigest"> = {
      planVersion: 1,
      kind: "provider-generation-dispatch-plan",
      status: "prepared-not-committed",
      transaction: "single-immediate-transaction-required",
      inspectedAt,
      expiresAt: approval.payload.expiresAt,
      basis: {
        archiveDigest: digest(input.archive),
        runId: identity.runId,
        runDigest: identity.runDigest,
        snapshotDigest: snapshot.snapshotDigest,
        revision: 1,
        approvalBindingDigest: binding.recordDigest,
        approvalEventDigest: approval.eventDigest,
        configurationDigest: review.configurationDigest,
        policyHead: review.policy.head,
        budgetHead: { revision: review.budget.revision, headDigest: review.budget.headDigest },
      },
      request: {
        request: {
          phase: "generation",
          sequence: 1,
          model: prep.model,
          contractDigest: review.manifest.executionContract.contractDigest,
          requestDigest: prep.generation.requestDigest,
          artifactSha256: artifact.sha256,
          inputChars: prep.generation.inputChars,
          maxOutputTokens: 16000,
        },
        body: prep.generation.body,
        rawBody: artifact.body,
      },
      commands: { prepared, dispatch },
      rows,
      capacity: {
        additionalUsedBytes: input.additionalUsedBytes,
        totalExposureBytes,
        reservedBudgetEventSlots: native.reservedBudgetEventSlots,
        reservedReceiptSlots: native.reservedReceiptSlots,
      },
      ownership: "new-commit-owner-required",
      dispatchAllowed: false,
      budgetWriteAllowed: false,
    };
    return {
      status: "prepared",
      plan: freezeProviderValue(structuredClone({ ...plan, planDigest: digest(plan) })),
    };
  } catch {
    return refuse("planned-archive-invalid");
  }
}
