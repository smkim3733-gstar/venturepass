import "server-only";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { createVersionedProviderPreparationBuilder } from "./studio-plan-quality-provider-core";
import { z } from "zod";
import {
  inspectProviderTransmissionApprovalArchive,
  inspectVersionedProviderTransmissionApprovalArchive,
} from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  createProviderExecutionEvent,
  createVersionedProviderExecutionEvent,
  versionedProviderExecutionOperationDigest,
  createProviderExecutionReceipt,
  getProviderExecutionBudgetSnapshot,
  providerExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import { providerReviewDispatchIdentitySchema } from "./studio-plan-quality-provider-review-dispatch-plan";
import { providerGenerationDispatchPlanLimits } from "./studio-plan-quality-provider-dispatch-plan";
import {
  prepareProviderReviewValidation,
  prepareVersionedProviderReviewValidation,
} from "./studio-plan-quality-provider-review-validation";
import type {
  ProviderExecutionCommand,
  ProviderExecutionEvent,
  VersionedProviderExecutionEvent,
} from "./studio-plan-quality-provider-execution-types";

export const providerReviewStopIdentitySchema = z
  .object({
    dispatch: providerReviewDispatchIdentitySchema,
    stopRequestId: z.string().uuid(),
    observation: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("unobserved"),
          // An explicit server stop intent, not an inference that a missing response cannot arrive.
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
export type ProviderReviewStopIdentity = z.infer<typeof providerReviewStopIdentitySchema>;
export type ProviderReviewStopInput = {
  identity: unknown;
  inspectedAt: string;
  archive: Parameters<typeof inspectProviderTransmissionApprovalArchive>[0];
  /** Audited raw bytes outside native, reservation and transmission archives. */
  additionalUsedBytes: number;
};
type Refusal =
  | "server-version-mismatch"
  | "invalid-input"
  | "archive-invalid"
  | "bindings-changed"
  | "nonce-conflict"
  | "review-prefix-changed"
  | "observation-changed"
  | "review-valid"
  | "validation-unavailable"
  | "validation-contract-changed"
  | "finalization-unavailable"
  | "final-result-too-large"
  | "capacity-exceeded"
  | "planned-archive-invalid";
const refused = (reason: Refusal) => ({ status: "refused" as const, reason, plan: null });

/** Pure r7/r8 stop plan only. Both phases were dispatched: no release or recognition is
 * permitted here. A late review response can still be captured without reopening the run. */
export function prepareProviderReviewStop(
  input: ProviderReviewStopInput,
): ProviderReviewStopResult {
  // Frozen entry point preserves v1 archive acceptance and complete plan bytes.
  return prepareReviewStop(input, null) as ProviderReviewStopResult;
}
/** Server-selected stop planning grants no write, dispatch or retry capability. */
export function prepareVersionedProviderReviewStop(
  version: PlanPromptVersion,
  input: ProviderReviewStopInput,
): VersionedProviderReviewStopResult {
  createVersionedProviderPreparationBuilder(version);
  if (
    !input ||
    Object.keys(input).some(
      (key) => !["identity", "inspectedAt", "archive", "additionalUsedBytes"].includes(key),
    )
  )
    return refused("invalid-input");
  return prepareReviewStop(input, version);
}
function prepareReviewStop(input: ProviderReviewStopInput, version: PlanPromptVersion | null) {
  const nativeV2 = version === "plan-observation-v2";
  const inspect =
    version === null
      ? inspectProviderTransmissionApprovalArchive
      : inspectVersionedProviderTransmissionApprovalArchive;
  const operationDigest = nativeV2
    ? versionedProviderExecutionOperationDigest
    : providerExecutionOperationDigest;
  const parsed = providerReviewStopIdentitySchema.safeParse(input.identity);
  if (
    !parsed.success ||
    !z.string().datetime().safeParse(input.inspectedAt).success ||
    !Number.isSafeInteger(input.additionalUsedBytes) ||
    input.additionalUsedBytes < 0
  )
    return refused("invalid-input");
  const identity = parsed.data,
    generationIdentity = identity.dispatch.generation,
    id = generationIdentity.dispatch.runId;
  let archive: ReturnType<typeof inspectVersionedProviderTransmissionApprovalArchive>;
  try {
    archive = inspect(input.archive);
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
  const state = archive.reservationArchive.ledger,
    snapshot = state.provider.snapshots.find((row) => row.run.id === id),
    binding = archive.records.find((row) => row.runId === id);
  if (
    snapshot &&
    version !== null &&
    snapshot.run.preparation.contract.baseContract.engineVersion !== version
  )
    return refused("server-version-mismatch");
  if (
    !snapshot ||
    (snapshot.archiveFormatVersion !== 3 && snapshot.archiveFormatVersion !== 5) ||
    snapshot.archiveFormatVersion !== (nativeV2 ? 5 : 3) ||
    snapshot.run.environment !== "production" ||
    snapshot.run.runDigest !== generationIdentity.dispatch.runDigest ||
    !binding ||
    binding.recordDigest !== generationIdentity.dispatch.approvalBindingDigest
  )
    return refused("bindings-changed");
  const [approval, genPrepared, genDispatch, genResponse, genValidated, prepared, dispatch] =
    snapshot.events;
  const matches = (
    nonce: string,
    kind: string,
    event: ProviderExecutionEvent | VersionedProviderExecutionEvent,
  ) =>
    state.provider.receipts.some(
      (row) =>
        row.clientRequestId === nonce &&
        row.kind === kind &&
        row.runId === id &&
        row.runRevision === event.revision &&
        row.operationDigest === event.eventDigest,
    );
  if (
    approval?.payload.kind !== "transmission-approved" ||
    approval.eventDigest !== binding.approvalEventDigest ||
    genPrepared?.payload.kind !== "request-prepared" ||
    genDispatch?.payload.kind !== "dispatch-intent" ||
    genResponse?.payload.kind !== "response-received" ||
    genValidated?.payload.kind !== "domain-validated" ||
    prepared?.payload.kind !== "request-prepared" ||
    prepared.payload.phase !== "review" ||
    dispatch?.payload.kind !== "dispatch-intent" ||
    dispatch.payload.phase !== "review" ||
    genResponse.eventDigest !== generationIdentity.responseEventDigest ||
    genValidated.eventDigest !== identity.dispatch.validationEventDigest ||
    !matches(generationIdentity.dispatch.preparedRequestId, "provider-prepared", genPrepared) ||
    !matches(generationIdentity.dispatch.dispatchRequestId, "provider-dispatch", genDispatch) ||
    !matches(generationIdentity.responseRequestId, "provider-response", genResponse) ||
    !matches(generationIdentity.validationRequestId, "provider-validated", genValidated) ||
    !matches(identity.dispatch.preparedRequestId, "provider-prepared", prepared) ||
    !matches(identity.dispatch.dispatchRequestId, "provider-dispatch", dispatch)
  )
    return refused("bindings-changed");
  if (snapshot.terminal || (snapshot.revision !== 7 && snapshot.revision !== 8))
    return refused("review-prefix-changed");
  const used = new Set([
    ...(input.archive.archive.ledger.otherNonces ?? []),
    ...[...state.provider.receipts, ...state.legacy.receipts, ...state.policy.records].map(
      (row) => row.clientRequestId,
    ),
  ]);
  if (used.has(identity.stopRequestId)) return refused("nonce-conflict");
  const budgetEvents = state.provider.budgetEvents.filter(
      (row) => row.scopeId === snapshot.run.preparation.budget.scopeId,
    ),
    budget = getProviderExecutionBudgetSnapshot(
      budgetEvents,
      snapshot.run.preparation.budget.scopeId,
    ),
    own = budget.reservations.find((row) => row.runId === id),
    generation = own?.phases.find((row) => row.phase === "generation"),
    review = own?.phases.find((row) => row.phase === "review");
  if (!generation || !generation.settled || generation.heldUnits !== "0" || !review)
    return refused("bindings-changed");
  if (
    Date.parse(input.inspectedAt) < Date.parse(snapshot.events.at(-1)!.recordedAt) ||
    Date.parse(input.inspectedAt) < Date.parse(budgetEvents.at(-1)!.recordedAt)
  )
    return refused("invalid-input");
  const observation = identity.observation,
    response = snapshot.events[7];
  let payload: ProviderExecutionCommand<"execution-stopped">["payload"];
  if (observation.kind === "unobserved") {
    if (snapshot.revision !== 7 || snapshot.state !== "dispatching")
      return refused("observation-changed");
    payload = {
      kind: "execution-stopped",
      outcome: "result-unobserved",
      failureCode: "INTERRUPTED",
      finalArtifactSha256: null,
    };
  } else {
    if (
      snapshot.revision !== 8 ||
      snapshot.state !== "response-recorded" ||
      response?.payload.kind !== "response-received" ||
      response.payload.phase !== "review" ||
      response.eventDigest !== observation.responseEventDigest ||
      !matches(observation.responseRequestId, "provider-response", response)
    )
      return refused("observation-changed");
    // Reuse application validation. A native test fixture's permissive stop constructor is
    // not eligibility evidence, and internal/contract/finalization failures are not bad output.
    let validation: ReturnType<typeof prepareVersionedProviderReviewValidation>;
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
          ? prepareProviderReviewValidation(validationInput)
          : prepareVersionedProviderReviewValidation(version, validationInput);
    } catch {
      return refused("validation-unavailable");
    }
    if (validation.status === "prepared") return refused("review-valid");
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
      validation.reason === "finalization-unavailable" ||
      validation.reason === "final-result-too-large" ||
      validation.reason === "capacity-exceeded"
    )
      return refused(validation.reason);
    else return refused("validation-unavailable");
  }
  try {
    const command: ProviderExecutionCommand<"execution-stopped"> = {
        clientRequestId: identity.stopRequestId,
        expectedRevision: snapshot.revision,
        payload,
      },
      eventBody = {
        runId: id,
        revision: snapshot.revision + 1,
        budgetRevision: budget.revision,
        previousEventDigest: snapshot.events.at(-1)!.eventDigest,
        recordedAt: input.inspectedAt,
        payload: { ...payload, releasedBudgetEventDigests: [] },
      },
      event = nativeV2
        ? createVersionedProviderExecutionEvent({
            schemaVersion: 2,
            executionContractVersion: 2,
            ...eventBody,
          })
        : createProviderExecutionEvent({
            schemaVersion: 2,
            executionContractVersion: 1,
            ...eventBody,
          }),
      receipt = createProviderExecutionReceipt({
        schemaVersion: 2,
        scopeId: budget.scopeId,
        kind: "provider-finish",
        clientRequestId: identity.stopRequestId,
        inputDigest: operationDigest(id, command),
        runId: id,
        runRevision: event.revision,
        budgetRevision: budget.revision,
        operationDigest: event.eventDigest,
        recordedAt: input.inspectedAt,
      }),
      ledger = input.archive.archive.ledger,
      after = inspect({
        ...input.archive,
        archive: {
          ...input.archive.archive,
          ledger: {
            ...ledger,
            events: [...ledger.events, event],
            receipts: [...ledger.receipts, receipt],
          },
        },
      }),
      native = after.reservationArchive.ledger.provider,
      nextBudget = getProviderExecutionBudgetSnapshot(
        native.budgetEvents.filter((row) => row.scopeId === budget.scopeId),
        budget.scopeId,
      ),
      stopped = native.snapshots.find((row) => row.run.id === id);
    if (
      digest(nextBudget) !== digest(budget) ||
      stopped?.archiveFormatVersion !== (nativeV2 ? 5 : 3) ||
      !stopped.terminal ||
      stopped.revision !== event.revision ||
      stopped.state !== payload.outcome
    )
      return refused("planned-archive-invalid");
    const totalExposureBytes = exposure(after);
    if (!withinCapacity(totalExposureBytes)) return refused("capacity-exceeded");
    const plan = {
      planVersion: nativeV2 ? (2 as const) : (1 as const),
      kind: "provider-review-stop-plan" as const,
      status: "prepared-not-committed" as const,
      transaction: "single-immediate-transaction-required" as const,
      identity,
      inspectedAt: input.inspectedAt,
      basis: {
        archiveDigest: digest(input.archive),
        snapshotDigest: snapshot.snapshotDigest,
        approvalBindingDigest: binding.recordDigest,
        dispatchEventDigest: dispatch.eventDigest,
        responseArtifactSha256:
          response?.payload.kind === "response-received" ? response.payload.artifactSha256 : null,
        budgetHead: { revision: budget.revision, headDigest: budget.headDigest },
      },
      command,
      rows: { event, receipt },
      budget: {
        generationHeldUnits: generation.heldUnits,
        reviewHeldUnits: review.heldUnits,
        recognizedUnits: budget.recognizedUnits,
        afterHead: { revision: nextBudget.revision, headDigest: nextBudget.headDigest },
      },
      capacity: {
        additionalUsedBytes: input.additionalUsedBytes,
        beforeExposureBytes: exposure(archive),
        totalExposureBytes,
      },
      stopPersisted: false as const,
      finalResultPersisted: false as const,
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
export type VersionedProviderReviewStopResult = ReturnType<typeof prepareReviewStop>;
export type VersionedProviderReviewStopPlan = Extract<
  VersionedProviderReviewStopResult,
  { status: "prepared" }
>["plan"];
type SharedPlan = VersionedProviderReviewStopPlan;
export type ProviderReviewStopPlan = Omit<SharedPlan, "planVersion" | "rows"> & {
  planVersion: 1;
  rows: Omit<SharedPlan["rows"], "event"> & { event: ProviderExecutionEvent };
};
export type ProviderReviewStopResult =
  { status: "prepared"; plan: ProviderReviewStopPlan } | ReturnType<typeof refused>;

/** Immutable historical evidence. A late capture can change today's budget, never this record. */
export type ProviderReviewStopRecord = ProviderReviewStopIdentity & {
  state: "committed";
  inputDigest: string;
  stopEventDigest: string;
  revision: 8 | 9;
  budgetRevision: number;
  budgetHeadDigest: string | null;
  outcome: "result-unobserved" | "needs-cost-review" | "bound-breached" | "output-invalid";
  recordedAt: string;
  generationHeldUnitsAtStop: string;
  reviewHeldUnitsAtStop: string;
  recognizedUnitsAtStop: string;
  stopPersisted: true;
  finalResultPersisted: false;
  dispatchAllowed: false;
  budgetWriteAllowed: false;
  automaticRetryAllowed: false;
};
export type ProviderReviewStopCommitResult = {
  record: ProviderReviewStopRecord;
  newlyCommitted: boolean;
  replayed: boolean;
};
