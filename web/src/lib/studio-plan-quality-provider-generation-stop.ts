import "server-only";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { createVersionedProviderPreparationBuilder } from "./studio-plan-quality-provider-core";
import { z } from "zod";
import {
  inspectProviderTransmissionApprovalArchive,
  inspectVersionedProviderTransmissionApprovalArchive,
} from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  createProviderExecutionBudgetEvent,
  createProviderExecutionEvent,
  createVersionedProviderExecutionEvent,
  versionedProviderExecutionOperationDigest,
  createProviderExecutionReceipt,
  getProviderExecutionBudgetSnapshot,
  providerExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  providerGenerationDispatchIdentitySchema,
  providerGenerationDispatchPlanLimits,
} from "./studio-plan-quality-provider-dispatch-plan";
import {
  prepareProviderGenerationValidation,
  prepareVersionedProviderGenerationValidation,
} from "./studio-plan-quality-provider-generation-validation";
import type {
  ProviderExecutionCommand,
  ProviderExecutionEvent,
} from "./studio-plan-quality-provider-execution-types";

export const providerGenerationStopIdentitySchema = z
  .object({
    dispatch: providerGenerationDispatchIdentitySchema,
    stopRequestId: z.string().uuid(),
    observation: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("unobserved"),
          // Explicit server stop intent. Absence in the DB does not prove the provider failed/stopped.
          disposition: z.literal("stop-with-possible-in-flight-response"),
        })
        .strict(),
      z
        .object({
          kind: z.literal("response"),
          responseRequestId: z.string().uuid(),
          responseEventDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
  })
  .strict();
export type ProviderGenerationStopIdentity = z.infer<typeof providerGenerationStopIdentitySchema>;
export type ProviderGenerationStopInput = {
  identity: unknown;
  inspectedAt: string;
  archive: Parameters<typeof inspectProviderTransmissionApprovalArchive>[0];
  /** Already audited raw bytes outside the three native/reservation/approval archives. */
  additionalUsedBytes: number;
};
type Refusal =
  | "server-version-mismatch"
  | "invalid-input"
  | "archive-invalid"
  | "bindings-changed"
  | "nonce-conflict"
  | "generation-prefix-changed"
  | "observation-changed"
  | "generation-valid"
  | "validation-unavailable"
  | "validation-contract-changed"
  | "review-request-too-large"
  | "capacity-exceeded"
  | "planned-archive-invalid";
const refuse = (reason: Refusal) => ({ status: "refused" as const, reason, plan: null });

/** Pure stop preparation only. Rebuild under the writer lock before saving. An unobserved stop
 * means "do not continue or resend", not "the provider can no longer return/charge a response". */
export function prepareProviderGenerationStop(
  input: ProviderGenerationStopInput,
): ProviderGenerationStopResult {
  // Frozen entry point preserves v1 archive acceptance and complete plan bytes.
  return prepareGenerationStop(input, null) as ProviderGenerationStopResult;
}
/** Server-selected stop planning grants no write, dispatch or retry capability. */
export function prepareVersionedProviderGenerationStop(
  version: PlanPromptVersion,
  input: ProviderGenerationStopInput,
): VersionedProviderGenerationStopResult {
  createVersionedProviderPreparationBuilder(version);
  if (
    !input ||
    Object.keys(input).some(
      (key) => !["identity", "inspectedAt", "archive", "additionalUsedBytes"].includes(key),
    )
  )
    return refuse("invalid-input");
  return prepareGenerationStop(input, version);
}
function prepareGenerationStop(
  input: ProviderGenerationStopInput,
  version: PlanPromptVersion | null,
) {
  const nativeV2 = version === "plan-observation-v2";
  const inspect =
    version === null
      ? inspectProviderTransmissionApprovalArchive
      : inspectVersionedProviderTransmissionApprovalArchive;
  const operationDigest = nativeV2
    ? versionedProviderExecutionOperationDigest
    : providerExecutionOperationDigest;
  const parsed = providerGenerationStopIdentitySchema.safeParse(input.identity);
  if (
    !parsed.success ||
    !z.string().datetime().safeParse(input.inspectedAt).success ||
    !Number.isSafeInteger(input.additionalUsedBytes) ||
    input.additionalUsedBytes < 0
  )
    return refuse("invalid-input");
  const identity = parsed.data,
    id = identity.dispatch.runId;
  let archive: ReturnType<typeof inspectVersionedProviderTransmissionApprovalArchive>;
  try {
    archive = inspect(input.archive);
  } catch {
    return refuse("archive-invalid");
  }
  const state = archive.reservationArchive.ledger,
    snapshot = state.provider.snapshots.find((row) => row.run.id === id),
    binding = archive.records.find((row) => row.runId === id);
  if (
    snapshot &&
    version !== null &&
    snapshot.run.preparation.contract.baseContract.engineVersion !== version
  )
    return refuse("server-version-mismatch");
  if (
    !snapshot ||
    (snapshot.archiveFormatVersion !== 3 && snapshot.archiveFormatVersion !== 5) ||
    snapshot.archiveFormatVersion !== (nativeV2 ? 5 : 3) ||
    snapshot.run.environment !== "production" ||
    snapshot.run.runDigest !== identity.dispatch.runDigest ||
    !binding ||
    binding.recordDigest !== identity.dispatch.approvalBindingDigest
  )
    return refuse("bindings-changed");
  const approval = snapshot.events[0],
    prepared = snapshot.events[1],
    dispatched = snapshot.events[2];
  const receiptMatches = (nonce: string, kind: string, revision: number, eventDigest: string) =>
    state.provider.receipts.some(
      (row) =>
        row.clientRequestId === nonce &&
        row.kind === kind &&
        row.runId === id &&
        row.runRevision === revision &&
        row.operationDigest === eventDigest,
    );
  if (
    approval?.payload.kind !== "transmission-approved" ||
    approval.eventDigest !== binding.approvalEventDigest ||
    prepared?.payload.kind !== "request-prepared" ||
    prepared.payload.phase !== "generation" ||
    dispatched?.payload.kind !== "dispatch-intent" ||
    dispatched.payload.phase !== "generation" ||
    !receiptMatches(
      identity.dispatch.preparedRequestId,
      "provider-prepared",
      2,
      prepared.eventDigest,
    ) ||
    !receiptMatches(
      identity.dispatch.dispatchRequestId,
      "provider-dispatch",
      3,
      dispatched.eventDigest,
    )
  )
    return refuse("bindings-changed");
  if (snapshot.terminal || (snapshot.revision !== 3 && snapshot.revision !== 4))
    return refuse("generation-prefix-changed");
  const used = new Set([
    ...state.provider.receipts.map((row) => row.clientRequestId),
    ...state.legacy.receipts.map((row) => row.clientRequestId),
    ...state.policy.records.map((row) => row.clientRequestId),
    ...(input.archive.archive.ledger.otherNonces ?? []),
  ]);
  if (used.has(identity.stopRequestId)) return refuse("nonce-conflict");
  const beforeExposure =
    state.usedBytes +
    state.reservedBytes +
    archive.reservationArchive.usedBytes +
    archive.usedBytes +
    input.additionalUsedBytes;
  if (
    !Number.isSafeInteger(beforeExposure) ||
    beforeExposure > providerGenerationDispatchPlanLimits.databaseBytes
  )
    return refuse("capacity-exceeded");
  const run = snapshot.run,
    budgetEvents = state.provider.budgetEvents.filter(
      (row) => row.scopeId === run.preparation.budget.scopeId,
    ),
    budget = getProviderExecutionBudgetSnapshot(budgetEvents, run.preparation.budget.scopeId),
    reservation = budget.reservations.find((row) => row.runId === id),
    generation = reservation?.phases.find((row) => row.phase === "generation"),
    review = reservation?.phases.find((row) => row.phase === "review");
  if (!generation || !review || review.settled || !budget.currency || budget.unitScale === null)
    return refuse("bindings-changed");
  if (
    Date.parse(input.inspectedAt) < Date.parse(snapshot.events.at(-1)!.recordedAt) ||
    Date.parse(input.inspectedAt) < Date.parse(budgetEvents.at(-1)!.recordedAt)
  )
    return refuse("invalid-input");
  let payload: ProviderExecutionCommand<"execution-stopped">["payload"];
  const observation = identity.observation;
  if (observation.kind === "unobserved") {
    if (snapshot.revision !== 3 || snapshot.state !== "dispatching")
      return refuse("observation-changed");
    payload = {
      kind: "execution-stopped",
      outcome: "result-unobserved",
      failureCode: "INTERRUPTED",
      finalArtifactSha256: null,
    };
  } else {
    const response = snapshot.events[3];
    if (
      snapshot.revision !== 4 ||
      snapshot.state !== "response-recorded" ||
      response?.payload.kind !== "response-received" ||
      response.payload.phase !== "generation" ||
      response.eventDigest !== observation.responseEventDigest ||
      !receiptMatches(observation.responseRequestId, "provider-response", 4, response.eventDigest)
    )
      return refuse("observation-changed");
    // Reuse the exact validated-output decision. Do not classify storage/contract/capacity errors
    // as invalid output, and never accept an outcome or failure code supplied by a caller.
    let validation: ReturnType<typeof prepareVersionedProviderGenerationValidation>;
    try {
      const validationInput = {
        ...input,
        identity: {
          dispatch: identity.dispatch,
          responseRequestId: observation.responseRequestId,
          responseEventDigest: observation.responseEventDigest,
          validationRequestId: identity.stopRequestId,
        },
      };
      validation =
        version === null
          ? prepareProviderGenerationValidation(validationInput)
          : prepareVersionedProviderGenerationValidation(version, validationInput);
    } catch {
      return refuse("validation-unavailable");
    }
    if (validation.status === "prepared") return refuse("generation-valid");
    if (validation.reason === "usage-unknown")
      payload = {
        kind: "execution-stopped",
        outcome: "needs-cost-review",
        failureCode: "COST_UNSETTLED",
        finalArtifactSha256: null,
      };
    else if (validation.reason === "budget-bound-breached" && budget.boundBreached)
      payload = {
        kind: "execution-stopped",
        outcome: "bound-breached",
        failureCode: "BOUND_BREACHED",
        finalArtifactSha256: null,
      };
    else if (validation.reason === "output-invalid")
      payload = {
        kind: "execution-stopped",
        outcome: "output-invalid",
        failureCode: "OUTPUT_INVALID",
        finalArtifactSha256: null,
      };
    else if (
      validation.reason === "validation-contract-changed" ||
      validation.reason === "review-request-too-large" ||
      validation.reason === "capacity-exceeded"
    )
      return refuse(validation.reason);
    else return refuse("validation-unavailable");
  }
  try {
    const release = createProviderExecutionBudgetEvent({
      schemaVersion: 2,
      scopeId: budget.scopeId,
      environment: run.environment,
      provenance: run.approval.provenance,
      revision: budget.revision + 1,
      previousDigest: budget.headDigest,
      eventId: identity.stopRequestId,
      recordedAt: input.inspectedAt,
      currency: budget.currency,
      unitScale: budget.unitScale,
      payload: {
        kind: "release-phase",
        phase: "review",
        runId: id,
        reservationDigest: run.reservationDigest,
        releasedUnits: review.heldUnits,
        reason: "not-dispatched",
      },
    });
    const command: ProviderExecutionCommand<"execution-stopped"> = {
      clientRequestId: identity.stopRequestId,
      expectedRevision: snapshot.revision,
      payload,
    };
    const eventBody = {
      runId: id,
      revision: snapshot.revision + 1,
      budgetRevision: release.revision,
      previousEventDigest: snapshot.events.at(-1)!.eventDigest,
      recordedAt: input.inspectedAt,
      payload: { ...payload, releasedBudgetEventDigests: [release.eventDigest] },
    };
    const event = nativeV2
      ? createVersionedProviderExecutionEvent({
          schemaVersion: 2,
          executionContractVersion: 2,
          ...eventBody,
        })
      : createProviderExecutionEvent({
          schemaVersion: 2,
          executionContractVersion: 1,
          ...eventBody,
        });
    const receipt = createProviderExecutionReceipt({
      schemaVersion: 2,
      scopeId: budget.scopeId,
      kind: "provider-finish",
      clientRequestId: identity.stopRequestId,
      inputDigest: operationDigest(id, command),
      runId: id,
      runRevision: event.revision,
      budgetRevision: release.revision,
      operationDigest: event.eventDigest,
      recordedAt: input.inspectedAt,
    });
    const ledger = input.archive.archive.ledger;
    const after = inspect({
      ...input.archive,
      archive: {
        ...input.archive.archive,
        ledger: {
          ...ledger,
          budgetEvents: [...ledger.budgetEvents, release],
          events: [...ledger.events, event],
          receipts: [...ledger.receipts, receipt],
        },
      },
    });
    const native = after.reservationArchive.ledger,
      nextBudget = getProviderExecutionBudgetSnapshot([...budgetEvents, release], budget.scopeId),
      nextReservation = nextBudget.reservations.find((row) => row.runId === id)!;
    if (
      digest(nextReservation.phases.find((row) => row.phase === "generation")) !==
        digest(generation) ||
      nextBudget.recognizedUnits !== budget.recognizedUnits
    )
      return refuse("planned-archive-invalid");
    const totalExposureBytes =
      native.usedBytes +
      native.reservedBytes +
      after.reservationArchive.usedBytes +
      after.usedBytes +
      input.additionalUsedBytes;
    if (
      !Number.isSafeInteger(totalExposureBytes) ||
      totalExposureBytes > providerGenerationDispatchPlanLimits.databaseBytes
    )
      return refuse("capacity-exceeded");
    const plan = {
      planVersion: nativeV2 ? (2 as const) : (1 as const),
      kind: "provider-generation-stop-plan" as const,
      status: "prepared-not-committed" as const,
      transaction: "single-immediate-transaction-required" as const,
      identity,
      inspectedAt: input.inspectedAt,
      basis: {
        archiveDigest: digest(input.archive),
        snapshotDigest: snapshot.snapshotDigest,
        approvalBindingDigest: binding.recordDigest,
        dispatchEventDigest: dispatched.eventDigest,
        budgetHead: { revision: budget.revision, headDigest: budget.headDigest },
      },
      command,
      rows: { budgetEvent: release, event, receipt },
      budget: {
        generationHeldUnits: generation.heldUnits,
        recognizedUnits: budget.recognizedUnits,
        reviewReleasedUnits: review.heldUnits,
        afterHead: { revision: nextBudget.revision, headDigest: nextBudget.headDigest },
      },
      capacity: {
        additionalUsedBytes: input.additionalUsedBytes,
        beforeExposureBytes: beforeExposure,
        totalExposureBytes,
      },
      dispatchAllowed: false as const,
      budgetWriteAllowed: false as const,
      automaticRetryAllowed: false as const,
    };
    return {
      status: "prepared" as const,
      plan: freezeProviderValue(structuredClone({ ...plan, planDigest: digest(plan) })),
    };
  } catch {
    return refuse("planned-archive-invalid");
  }
}
export type VersionedProviderGenerationStopResult = ReturnType<typeof prepareGenerationStop>;
export type VersionedProviderGenerationStopPlan = Extract<
  VersionedProviderGenerationStopResult,
  { status: "prepared" }
>["plan"];
type SharedPlan = VersionedProviderGenerationStopPlan;
export type ProviderGenerationStopPlan = Omit<SharedPlan, "planVersion" | "rows"> & {
  planVersion: 1;
  rows: Omit<SharedPlan["rows"], "event"> & { event: ProviderExecutionEvent };
};
export type ProviderGenerationStopResult =
  { status: "prepared"; plan: ProviderGenerationStopPlan } | ReturnType<typeof refuse>;

/** Historical stop evidence. A late response can change current costs, but never this record. */
export type ProviderGenerationStopRecord = ProviderGenerationStopIdentity & {
  state: "committed";
  inputDigest: string;
  stopEventDigest: string;
  releaseEventDigest: string;
  revision: 4 | 5;
  budgetRevision: number;
  outcome: "result-unobserved" | "needs-cost-review" | "bound-breached" | "output-invalid";
  recordedAt: string;
  generationHeldUnitsAtStop: string;
  recognizedUnitsAtStop: string;
  reviewReleasedUnits: string;
  stopPersisted: true;
  dispatchAllowed: false;
  budgetWriteAllowed: false;
  automaticRetryAllowed: false;
};
export type ProviderGenerationStopCommitResult = {
  record: ProviderGenerationStopRecord;
  newlyCommitted: boolean;
  replayed: boolean;
};
