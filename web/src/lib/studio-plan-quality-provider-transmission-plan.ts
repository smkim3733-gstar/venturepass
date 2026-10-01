import { z } from "zod";
import { inspectVersionedProviderReservationArchive as inspectProviderReservationArchive } from "../../scripts/local-data-quality-provider-reservation-binding.mjs";
import {
  validateProviderTransmissionApprovalBinding,
  validateVersionedProviderTransmissionApprovalBinding,
} from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import {
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  providerExecutionOperationDigest,
  versionedProviderApprovalOperationDigest,
  createVersionedProviderApprovalEvent,
  versionedProviderApprovalCommandSchema,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import { providerTransmissionCommandSchema } from "./studio-plan-quality-provider-transmission-command";
import {
  providerTransmissionApprovalBindingSchema,
  type ProviderTransmissionApprovalBinding,
  versionedProviderTransmissionApprovalBindingSchema,
  type VersionedProviderTransmissionApprovalBinding,
} from "./studio-plan-quality-provider-transmission-approval-types";
import {
  providerTransmissionReviewInputSchema,
  providerTransmissionReviewSchema,
  versionedProviderTransmissionReviewSchema,
  providerTransmissionReviewManifestSchema,
} from "./studio-plan-quality-provider-transmission-review-types";
import {
  isProviderTransmissionReviewCurrent,
  isVersionedProviderTransmissionReviewCurrent,
  type ProviderTransmissionReviewInput,
} from "./studio-plan-quality-provider-transmission-review";
import type {
  ProviderExecutionCommand,
  ProviderExecutionEvent,
  ProviderExecutionReceipt,
  VersionedProviderApprovalCommand,
  VersionedProviderApprovalEvent,
} from "./studio-plan-quality-provider-execution-types";

import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { createVersionedProviderPreparationBuilder } from "./studio-plan-quality-provider-core";

const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
export const providerTransmissionPlanLimits = {
  databaseBytes: 256 * 1024 * 1024,
  bindingBytes: 128 * 1024,
} as const;

/** Retry identity includes all review/CAS/consent fields, unlike the frozen native input digest. */
export function providerTransmissionCommandDigest(value: unknown): string {
  return digest(providerTransmissionCommandSchema.parse(value));
}
export type ProviderTransmissionPlannerInput = {
  command: unknown;
  review: unknown;
  /** Fresh server-owned evidence under the writer's lock, never a client-supplied archive. */
  current: ProviderTransmissionReviewInput;
  /** Audited bytes outside the v8 archive: other DB tables, approval coverage/existing bindings and raw
   * row encoding overhead. The later durable writer must also check full approval coverage. */
  additionalUsedBytes: number;
};
export type ProviderTransmissionWritePlan = {
  planVersion: 1;
  status: "prepared-not-committed";
  transaction: "single-immediate-transaction-required";
  persistence: "audited-transmission-binding-transaction-required";
  execution: ProviderExecutionCommand<"transmission-approved">;
  rows: {
    event: ProviderExecutionEvent;
    receipt: ProviderExecutionReceipt;
    binding: ProviderTransmissionApprovalBinding;
  };
  capacity: {
    additionalUsedBytes: number;
    bindingBytes: number;
    totalExposureBytes: number;
    reservedBudgetEventSlots: number;
    reservedReceiptSlots: number;
  };
  dispatchAllowed: false;
  budgetWriteAllowed: false;
};
export type VersionedProviderTransmissionWritePlan = Omit<
  ProviderTransmissionWritePlan,
  "planVersion" | "execution" | "rows"
> & {
  planVersion: 2;
  execution: VersionedProviderApprovalCommand;
  rows: {
    event: VersionedProviderApprovalEvent;
    receipt: ProviderExecutionReceipt;
    binding: VersionedProviderTransmissionApprovalBinding;
  };
};
type Refusal =
  | "invalid-input"
  | "selection-changed"
  | "archive-invalid"
  | "nonce-conflict"
  | "review-not-current"
  | "approval-blocked"
  | "bindings-changed"
  | "approval-time-invalid"
  | "capacity-exceeded"
  | "planned-archive-invalid";
export type ProviderTransmissionPlanResult =
  | { status: "prepared"; plan: ProviderTransmissionWritePlan }
  | { status: "refused"; reason: Refusal; plan: null };
export type VersionedProviderTransmissionPlanResult =
  | {
      status: "prepared";
      plan: ProviderTransmissionWritePlan | VersionedProviderTransmissionWritePlan;
    }
  | Extract<ProviderTransmissionPlanResult, { status: "refused" }>;
const refuse = (reason: Refusal): ProviderTransmissionPlanResult => ({
  status: "refused",
  reason,
  plan: null,
});

/** NEW approval only, without IO or execution grants. A durable writer must first audit all
 * stored approval bindings and replay the exact existing command, BEFORE checking currentness.
 * Never feed an old native receipt into this planner to manufacture another approval/dispatch.
 * ProviderTransmissionApprovalStore commits native rows plus this binding atomically. */
export function prepareProviderTransmissionApproval(
  input: ProviderTransmissionPlannerInput,
): ProviderTransmissionPlanResult {
  // Null uses only frozen v1 shapes; the internal implementation cannot return a v2 plan.
  return prepareTransmissionApproval(input, null) as ProviderTransmissionPlanResult;
}
export function prepareVersionedProviderTransmissionApproval(
  version: PlanPromptVersion,
  input: ProviderTransmissionPlannerInput,
): VersionedProviderTransmissionPlanResult {
  createVersionedProviderPreparationBuilder(version); // Explicit unsupported selections never fall back.
  return prepareTransmissionApproval(input, version);
}
function prepareTransmissionApproval(
  input: ProviderTransmissionPlannerInput,
  version: PlanPromptVersion | null,
): VersionedProviderTransmissionPlanResult {
  const nativeV2 = version === "plan-observation-v2";
  const parsed = providerTransmissionCommandSchema.safeParse(input.command);
  const reviewed = (
    nativeV2 ? versionedProviderTransmissionReviewSchema : providerTransmissionReviewSchema
  ).safeParse(input.review);
  const selected = providerTransmissionReviewInputSchema.safeParse(input.current.selection);
  if (
    !parsed.success ||
    !reviewed.success ||
    !selected.success ||
    !z.string().datetime().safeParse(input.current.inspectedAt).success ||
    !Number.isSafeInteger(input.additionalUsedBytes) ||
    input.additionalUsedBytes < 0
  )
    return refuse("invalid-input");
  const command = parsed.data,
    review = reviewed.data;
  if (
    !same({ runId: command.runId, runDigest: command.runDigest }, selected.data) ||
    command.runId !== review.run.id ||
    command.runDigest !== review.run.runDigest
  )
    return refuse("selection-changed");

  let archive: ReturnType<typeof inspectProviderReservationArchive>;
  try {
    archive = inspectProviderReservationArchive(input.current.archive);
  } catch {
    return refuse("archive-invalid");
  }
  const state = archive.ledger;
  const used = [
    ...(input.current.archive.ledger.otherNonces ?? []),
    ...state.legacy.receipts.map((row) => row.clientRequestId),
    ...state.provider.receipts.map((row) => row.clientRequestId),
    ...state.policy.records.map((row) => row.clientRequestId),
  ];
  if (used.includes(command.clientRequestId)) return refuse("nonce-conflict");
  if (
    command.approvedReviewDigest !== review.reviewDigest ||
    !(version === null
      ? isProviderTransmissionReviewCurrent(review, input.current)
      : isVersionedProviderTransmissionReviewCurrent(version, review, input.current))
  )
    return refuse("review-not-current");
  if (review.assessment.state !== "conditions-met") return refuse("approval-blocked");
  if (
    command.expectedArchiveDigest !== review.archiveDigest ||
    command.expectedCoverageDigest !== review.coverageDigest ||
    command.expectedReservationBindingDigest !== review.reservation.bindingDigest ||
    command.expectedManifestDigest !== review.manifest.manifestDigest ||
    !same(command.expectedRun, {
      revision: review.run.revision,
      snapshotDigest: review.run.snapshotDigest,
    }) ||
    !same(command.expectedPolicyHead, review.policy.head) ||
    !same(command.expectedPolicyReference, review.policy.currentReference) ||
    !same(command.expectedPolicyReference, review.policy.reservedReference) ||
    !same(command.expectedBudgetHead, {
      revision: review.budget.revision,
      headDigest: review.budget.headDigest,
    }) ||
    command.approval.acknowledgedRetentionNoticeDigest !== digest(review.retention)
  )
    return refuse("bindings-changed");
  const approvedAt = Date.parse(command.approval.approvedAt),
    now = Date.parse(input.current.inspectedAt);
  if (
    approvedAt < Date.parse(review.inspectedAt) ||
    approvedAt > now ||
    approvedAt >= Date.parse(review.expiresAt)
  )
    return refuse("approval-time-invalid");

  try {
    const recordedAt = new Date(input.current.inspectedAt).toISOString();
    const executionBody = {
      clientRequestId: command.clientRequestId,
      expectedRevision: 0 as const,
      payload: {
        kind: "transmission-approved" as const,
        manifest: review.manifest,
        provenance: "explicit-user" as const,
        approvedAt: command.approval.approvedAt,
        expiresAt: review.expiresAt,
        acknowledgedExternalTransmission: true as const,
        acknowledgedGenerationAndDerivedReview: true as const,
        acknowledgedRetentionNoticeDigest: command.approval.acknowledgedRetentionNoticeDigest,
        acknowledgedFinancialReservationNotTokenFit: true as const,
        acknowledgedUnknownCostHoldAndNoRetry: true as const,
        budgetRevision: command.expectedBudgetHead.revision,
        budgetDigest: command.expectedBudgetHead.headDigest,
      },
    };
    const oldExecution = () => ({
      ...executionBody,
      payload: {
        ...executionBody.payload,
        manifest: providerTransmissionReviewManifestSchema.parse(review.manifest),
      },
    });
    const execution = nativeV2
      ? versionedProviderApprovalCommandSchema.parse(executionBody)
      : oldExecution();
    const executionInputDigest = nativeV2
      ? versionedProviderApprovalOperationDigest(
          command.runId,
          versionedProviderApprovalCommandSchema.parse(executionBody),
        )
      : providerExecutionOperationDigest(command.runId, oldExecution());
    const eventBody = {
      schemaVersion: 2 as const,
      runId: command.runId,
      revision: 1 as const,
      budgetRevision: command.expectedBudgetHead.revision,
      previousEventDigest: null,
      recordedAt,
    };
    const event = nativeV2
      ? createVersionedProviderApprovalEvent({
          ...eventBody,
          executionContractVersion: 2,
          payload: versionedProviderApprovalCommandSchema.parse(executionBody).payload,
        })
      : createProviderExecutionEvent({
          ...eventBody,
          executionContractVersion: 1,
          payload: oldExecution().payload,
        });
    const receipt = createProviderExecutionReceipt({
      schemaVersion: 2,
      scopeId: review.budget.scopeId,
      kind: "provider-approve",
      clientRequestId: command.clientRequestId,
      inputDigest: executionInputDigest,
      runId: command.runId,
      runRevision: 1,
      budgetRevision: event.budgetRevision,
      operationDigest: event.eventDigest,
      recordedAt,
    });
    const body = {
      recordVersion: nativeV2 ? 2 : 1,
      kind: "provider-transmission-approval-binding",
      clientRequestId: command.clientRequestId,
      command,
      commandDigest: providerTransmissionCommandDigest(command),
      approvedReview: review,
      runId: command.runId,
      runDigest: command.runDigest,
      executionInputDigest,
      approvalEventDigest: event.eventDigest,
      approvalRevision: 1,
      recordedAt,
      dispatchAllowed: false,
    };
    const binding = (
      nativeV2
        ? versionedProviderTransmissionApprovalBindingSchema
        : providerTransmissionApprovalBindingSchema
    ).parse({
      ...body,
      recordDigest: digest(body),
    });
    const bindingBytes = bytes(binding);
    if (
      bindingBytes > providerTransmissionPlanLimits.bindingBytes ||
      bytes(event) > 32768 ||
      bytes(receipt) > 4096
    )
      return refuse("capacity-exceeded");
    const nextArchive = {
      ...input.current.archive,
      ledger: {
        ...input.current.archive.ledger,
        events: [...input.current.archive.ledger.events, event],
        receipts: [...input.current.archive.ledger.receipts, receipt],
      },
    };
    const next = inspectProviderReservationArchive(nextArchive);
    (nativeV2
      ? validateVersionedProviderTransmissionApprovalBinding
      : validateProviderTransmissionApprovalBinding)(binding, nextArchive);
    const totalExposureBytes =
      next.ledger.usedBytes +
      next.ledger.reservedBytes +
      next.usedBytes +
      bindingBytes +
      input.additionalUsedBytes;
    if (
      !Number.isSafeInteger(totalExposureBytes) ||
      totalExposureBytes > providerTransmissionPlanLimits.databaseBytes
    )
      return refuse("capacity-exceeded");
    const common = {
      status: "prepared-not-committed" as const,
      transaction: "single-immediate-transaction-required" as const,
      persistence: "audited-transmission-binding-transaction-required" as const,

      capacity: {
        additionalUsedBytes: input.additionalUsedBytes,
        bindingBytes,
        totalExposureBytes,
        reservedBudgetEventSlots: next.ledger.reservedBudgetEventSlots,
        reservedReceiptSlots: next.ledger.reservedReceiptSlots,
      },
      dispatchAllowed: false as const,
      budgetWriteAllowed: false as const,
    };
    const materialize = <E, R>(execution: E, rows: R) => ({
      status: common.status,
      transaction: common.transaction,
      persistence: common.persistence,
      execution,
      rows,
      capacity: common.capacity,
      dispatchAllowed: common.dispatchAllowed,
      budgetWriteAllowed: common.budgetWriteAllowed,
    });
    // Reparse each branch to keep public plan types correlated with their stored versions.
    return nativeV2
      ? {
          status: "prepared",
          plan: {
            planVersion: 2,
            ...materialize(versionedProviderApprovalCommandSchema.parse(execution), {
              event: createVersionedProviderApprovalEvent({
                ...eventBody,
                executionContractVersion: 2,
                payload: versionedProviderApprovalCommandSchema.parse(execution).payload,
              }),
              receipt,
              binding: versionedProviderTransmissionApprovalBindingSchema.parse(binding),
            }),
          },
        }
      : {
          status: "prepared",
          plan: {
            planVersion: 1,
            ...materialize(oldExecution(), {
              event: createProviderExecutionEvent({
                ...eventBody,
                executionContractVersion: 1,
                payload: oldExecution().payload,
              }),
              receipt,
              binding: providerTransmissionApprovalBindingSchema.parse(binding),
            }),
          },
        };
  } catch {
    return refuse("planned-archive-invalid");
  }
}
