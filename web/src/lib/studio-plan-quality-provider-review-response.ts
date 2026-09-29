import "server-only";
import { z } from "zod";
import { inspectProviderTransmissionApprovalArchive } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  createProviderExecutionArtifact,
  createProviderExecutionBudgetEvent,
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  providerExecutionOperationDigest,
  providerUsageRecognitionPayload,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  assessProviderUsage,
  captureProviderResponse,
  freezeProviderValue,
  providerResponseMetadata,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { providerReviewDispatchIdentitySchema } from "./studio-plan-quality-provider-review-dispatch-plan";
import { providerGenerationDispatchPlanLimits } from "./studio-plan-quality-provider-dispatch-plan";
import type {
  ProviderExecutionCommand,
  ProviderExecutionEvent,
  ProviderExecutionSnapshot,
} from "./studio-plan-quality-provider-execution-types";
import type { ProviderGenerationResponseRecord } from "./studio-plan-quality-provider-generation-response";

const captureSchema = z
  .object({
    dispatch: providerReviewDispatchIdentitySchema,
    responseRequestId: z.string().uuid(),
    response: z.unknown(),
  })
  .strict();

/** Copy selected SDK JSON now, without invoking SDK accessors/toJSON or retaining caller objects. */
export function captureReviewResponseInput(raw: unknown) {
  const input = captureSchema.parse(raw);
  return freezeProviderValue({ ...input, response: captureProviderResponse(input.response) });
}
export type ProviderReviewResponseCapture = ReturnType<typeof captureReviewResponseInput>;
export type ProviderReviewResponseRecord = Omit<ProviderGenerationResponseRecord, "dispatch"> & {
  dispatch: ProviderReviewResponseCapture["dispatch"];
  late: boolean;
};
export type ProviderReviewResponseCommitResult = {
  record: ProviderReviewResponseRecord;
  newlyCommitted: boolean;
  replayed: boolean;
};
export type ProviderReviewResponseInput = {
  capture: unknown;
  inspectedAt: string;
  archive: Parameters<typeof inspectProviderTransmissionApprovalArchive>[0];
  /** Audited raw bytes outside native, reservation and transmission archives. */
  additionalUsedBytes: number;
};
type Refusal =
  | "invalid-input"
  | "response-not-capturable"
  | "archive-invalid"
  | "bindings-changed"
  | "review-dispatch-required"
  | "response-prefix-changed"
  | "nonce-conflict"
  | "capture-time-before-history"
  | "capacity-exceeded"
  | "planned-archive-invalid";
const refused = (reason: Refusal) => ({ status: "refused" as const, reason, plan: null });

/** Snapshot must have passed the full native/v9 audit. This command carries no cost assertions. */
export function reviewResponseCommand(
  input: ProviderReviewResponseCapture,
  snapshot: ProviderExecutionSnapshot,
  expectedRevision = snapshot.revision,
): ProviderExecutionCommand<"response-received"> {
  const dispatch = snapshot.events[6];
  if (dispatch?.payload.kind !== "dispatch-intent" || dispatch.payload.phase !== "review")
    throw Error("Review dispatch required");
  const artifact = createProviderExecutionArtifact({
    runId: snapshot.run.id,
    key: "review-response",
    body: JSON.stringify({ captureKind: "sdk-response-json-v2", response: input.response }),
  });
  return freezeProviderValue({
    clientRequestId: input.responseRequestId,
    expectedRevision,
    artifact,
    payload: {
      kind: "response-received",
      phase: "review",
      requestDigest: dispatch.payload.requestDigest,
      dispatchEventDigest: dispatch.eventDigest,
      artifactSha256: artifact.sha256,
      metadata: providerResponseMetadata(input.response, {
        configuredModel: snapshot.run.preparation.model,
      }),
    },
  });
}

/** NEW response plan only. An expired approval or changed current policy/configuration cannot
 * erase an already obtained response. Original frozen pricing/usage rules determine its cost.
 * A writer must regenerate under its lock; this read-only plan grants no sending or writing. */
export function prepareProviderReviewResponse(input: ProviderReviewResponseInput) {
  if (
    !captureSchema.safeParse(input.capture).success ||
    !z.string().datetime().safeParse(input.inspectedAt).success ||
    !Number.isSafeInteger(input.additionalUsedBytes) ||
    input.additionalUsedBytes < 0
  )
    return refused("invalid-input");
  let capture: ProviderReviewResponseCapture;
  try {
    capture = captureReviewResponseInput(input.capture);
  } catch {
    return refused("response-not-capturable");
  }
  let archive: ReturnType<typeof inspectProviderTransmissionApprovalArchive>;
  try {
    archive = inspectProviderTransmissionApprovalArchive(input.archive);
  } catch {
    return refused("archive-invalid");
  }
  const exposure = (value: typeof archive) =>
    value.reservationArchive.ledger.usedBytes +
    value.reservationArchive.ledger.reservedBytes +
    value.reservationArchive.usedBytes +
    value.usedBytes +
    input.additionalUsedBytes;
  const withinCapacity = (bytes: number) =>
    Number.isSafeInteger(bytes) && bytes <= providerGenerationDispatchPlanLimits.databaseBytes;
  if (!withinCapacity(exposure(archive))) return refused("capacity-exceeded");
  const identity = capture.dispatch,
    generation = identity.generation,
    id = generation.dispatch.runId,
    state = archive.reservationArchive.ledger,
    snapshot = state.provider.snapshots.find((row) => row.run.id === id),
    binding = archive.records.find((row) => row.runId === id);
  if (
    !snapshot ||
    snapshot.archiveFormatVersion !== 3 ||
    snapshot.run.environment !== "production" ||
    snapshot.run.runDigest !== generation.dispatch.runDigest ||
    !binding ||
    binding.recordDigest !== generation.dispatch.approvalBindingDigest
  )
    return refused("bindings-changed");
  const [approval, genPrepared, genDispatch, genResponse, validated, prepared, dispatch] =
    snapshot.events;
  if (
    prepared?.payload.kind !== "request-prepared" ||
    prepared.payload.phase !== "review" ||
    dispatch?.payload.kind !== "dispatch-intent" ||
    dispatch.payload.phase !== "review"
  )
    return refused("review-dispatch-required");
  const matches = (nonce: string, kind: string, event: ProviderExecutionEvent) =>
    state.provider.receipts.some(
      (row) =>
        row.clientRequestId === nonce &&
        row.kind === kind &&
        row.runId === id &&
        row.runRevision === event.revision &&
        row.operationDigest === event.eventDigest,
    );
  // The full archive audit already reconstructs every original command/input digest and artifact.
  // Here bind all caller identities to those exact audited receipts, not only the latest nonce.
  if (
    approval?.payload.kind !== "transmission-approved" ||
    approval.eventDigest !== binding.approvalEventDigest ||
    genPrepared?.payload.kind !== "request-prepared" ||
    genDispatch?.payload.kind !== "dispatch-intent" ||
    genResponse?.payload.kind !== "response-received" ||
    validated?.payload.kind !== "domain-validated" ||
    genResponse.eventDigest !== generation.responseEventDigest ||
    validated.eventDigest !== identity.validationEventDigest ||
    !matches(generation.dispatch.preparedRequestId, "provider-prepared", genPrepared) ||
    !matches(generation.dispatch.dispatchRequestId, "provider-dispatch", genDispatch) ||
    !matches(generation.responseRequestId, "provider-response", genResponse) ||
    !matches(generation.validationRequestId, "provider-validated", validated) ||
    !matches(identity.preparedRequestId, "provider-prepared", prepared) ||
    !matches(identity.dispatchRequestId, "provider-dispatch", dispatch)
  )
    return refused("bindings-changed");
  const last = snapshot.events.at(-1)!,
    late =
      snapshot.revision === 8 &&
      snapshot.terminal &&
      last.payload.kind === "execution-stopped" &&
      last.payload.outcome === "result-unobserved";
  if (!late && (snapshot.revision !== 7 || snapshot.terminal || snapshot.state !== "dispatching"))
    return refused("response-prefix-changed");
  const used = new Set([
    ...(input.archive.archive.ledger.otherNonces ?? []),
    ...state.provider.receipts.map((row) => row.clientRequestId),
    ...state.legacy.receipts.map((row) => row.clientRequestId),
    ...state.policy.records.map((row) => row.clientRequestId),
  ]);
  if (used.has(capture.responseRequestId)) return refused("nonce-conflict");
  const budget = state.provider.budgets.find(
    (row) => row.scopeId === snapshot.run.preparation.budget.scopeId,
  );
  if (!budget || !budget.currency || budget.unitScale === null) return refused("archive-invalid");
  const inspectedAt = new Date(input.inspectedAt).toISOString(),
    now = Date.parse(inspectedAt),
    head = state.provider.budgetEvents.find((row) => row.eventDigest === budget.headDigest);
  if (now < Date.parse(last.recordedAt) || (head && now < Date.parse(head.recordedAt)))
    return refused("capture-time-before-history");
  try {
    const command = reviewResponseCommand(capture, snapshot),
      artifact = command.artifact!,
      assessment = assessProviderUsage({
        response: capture.response,
        policy: approval.payload.manifest.executionContract.usagePolicy,
        financialBasis: snapshot.run.preparation.financialBasis,
        phase: "review",
      }),
      recognition = providerUsageRecognitionPayload(
        snapshot.run,
        "review",
        dispatch.eventDigest,
        artifact.sha256,
        assessment,
      );
    const usageEvent = recognition
      ? createProviderExecutionBudgetEvent({
          schemaVersion: 2,
          scopeId: budget.scopeId,
          environment: snapshot.run.environment,
          provenance: snapshot.run.approval.provenance,
          revision: budget.revision + 1,
          previousDigest: budget.headDigest,
          eventId: capture.responseRequestId,
          recordedAt: inspectedAt,
          currency: budget.currency,
          unitScale: budget.unitScale,
          payload: recognition,
        })
      : null;
    const event = createProviderExecutionEvent({
      schemaVersion: 2,
      executionContractVersion: 1,
      runId: id,
      revision: snapshot.revision + 1,
      budgetRevision: usageEvent?.revision ?? budget.revision,
      previousEventDigest: last.eventDigest,
      recordedAt: inspectedAt,
      payload: {
        ...command.payload,
        usageAssessment: assessment,
        usageBudgetEventDigest: usageEvent?.eventDigest ?? null,
      },
    });
    const receipt = createProviderExecutionReceipt({
      schemaVersion: 2,
      scopeId: budget.scopeId,
      kind: "provider-response",
      clientRequestId: capture.responseRequestId,
      inputDigest: providerExecutionOperationDigest(id, command),
      runId: id,
      runRevision: event.revision,
      budgetRevision: event.budgetRevision,
      operationDigest: event.eventDigest,
      recordedAt: inspectedAt,
    });
    const ledger = input.archive.archive.ledger;
    const next = inspectProviderTransmissionApprovalArchive({
      ...input.archive,
      archive: {
        ...input.archive.archive,
        ledger: {
          ...ledger,
          artifacts: [...ledger.artifacts, artifact],
          events: [...ledger.events, event],
          receipts: [...ledger.receipts, receipt],
          budgetEvents: [...ledger.budgetEvents, ...(usageEvent ? [usageEvent] : [])],
        },
      },
    });
    const totalExposureBytes = exposure(next);
    if (!withinCapacity(totalExposureBytes)) return refused("capacity-exceeded");
    const after = next.reservationArchive.ledger.provider,
      resultingSnapshot = after.snapshots.find((row) => row.run.id === id)!;
    if (resultingSnapshot.archiveFormatVersion !== 3) return refused("planned-archive-invalid");
    const plan = {
      planVersion: 1 as const,
      kind: "provider-review-response-plan" as const,
      status: "prepared-not-committed" as const,
      transaction: "single-immediate-transaction-required" as const,
      identity: { dispatch: identity, responseRequestId: capture.responseRequestId },
      inspectedAt,
      basis: {
        archiveDigest: digest(input.archive),
        runId: id,
        runDigest: snapshot.run.runDigest,
        snapshotDigest: snapshot.snapshotDigest,
        revision: snapshot.revision,
        approvalBindingDigest: binding.recordDigest,
        approvalEventDigest: approval.eventDigest,
        dispatchEventDigest: dispatch.eventDigest,
        budgetHead: { revision: budget.revision, headDigest: budget.headDigest },
      },
      late,
      command,
      rows: { artifact, event, receipt, usageEvent },
      usageAssessment: assessment,
      budget: {
        before: budget,
        after: after.budgets.find((row) => row.scopeId === budget.scopeId)!,
      },
      resultingState: {
        revision: resultingSnapshot.revision,
        state: resultingSnapshot.state,
        terminal: resultingSnapshot.terminal,
      },
      capacity: {
        additionalUsedBytes: input.additionalUsedBytes,
        previousExposureBytes: exposure(archive),
        totalExposureBytes,
        reservedBudgetEventSlots: next.reservationArchive.ledger.reservedBudgetEventSlots,
        reservedReceiptSlots: next.reservationArchive.ledger.reservedReceiptSlots,
      },
      responsePersisted: false as const,
      dispatchAllowed: false as const,
      budgetWriteAllowed: false as const,
      automaticRetryAllowed: false as const,
    };
    return {
      status: "prepared" as const,
      plan: freezeProviderValue(structuredClone({ ...plan, planDigest: digest(plan) })),
    };
  } catch {
    return refused("planned-archive-invalid");
  }
}
export type ProviderReviewResponseResult = ReturnType<typeof prepareProviderReviewResponse>;
export type ProviderReviewResponsePlan = Extract<
  ProviderReviewResponseResult,
  { status: "prepared" }
>["plan"];
