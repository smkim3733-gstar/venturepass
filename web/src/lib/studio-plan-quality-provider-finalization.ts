import "server-only";
import { z } from "zod";
import { inspectProviderTransmissionApprovalArchive } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  createProviderExecutionArtifact,
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  getProviderExecutionBudgetSnapshot,
  providerExecutionOperationDigest,
  providerExecutionLimits,
  validateProviderExecutionFinalResult,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { providerReviewValidationIdentitySchema } from "./studio-plan-quality-provider-review-validation";
import { providerGenerationDispatchPlanLimits } from "./studio-plan-quality-provider-dispatch-plan";
import { getPlanExecutionContract, finalizeObservedPlanReview } from "./studio-engine";
import { candidateRegistryModelInput } from "./studio-plan-quality-candidate-registry";
import { caseSchema } from "./studio-schema";
import type {
  ProviderExecutionCommand,
  ProviderExecutionEvent,
  ProviderExecutionOutput,
} from "./studio-plan-quality-provider-execution-types";

export const providerFinalizationIdentitySchema = z
  .object({
    validation: providerReviewValidationIdentitySchema,
    validationEventDigest: z.string().regex(/^[a-f0-9]{64}$/),
    finalizationRequestId: z.string().uuid(),
  })
  .strict();
export type ProviderFinalizationIdentity = z.infer<typeof providerFinalizationIdentitySchema>;
export type ProviderFinalizationInput = {
  identity: unknown;
  inspectedAt: string;
  archive: Parameters<typeof inspectProviderTransmissionApprovalArchive>[0];
  /** Audited raw bytes outside native, reservation and transmission archives. */
  additionalUsedBytes: number;
};
type Refusal =
  | "invalid-input"
  | "archive-invalid"
  | "bindings-changed"
  | "review-validation-required"
  | "execution-stopped"
  | "nonce-conflict"
  | "budget-unsettled"
  | "budget-bound-breached"
  | "validation-contract-changed"
  | "validation-unavailable"
  | "finalization-unavailable"
  | "final-result-too-large"
  | "capacity-exceeded"
  | "planned-archive-invalid";
const refused = (reason: Refusal) => ({ status: "refused" as const, reason, plan: null });

/** Pure r9 -> proposed completed r10. Derives only from audited stored outputs, never a
 * caller's final body or an earlier preview. No persistence, budget change or dispatch. */
export function prepareProviderFinalization(input: ProviderFinalizationInput) {
  const parsed = providerFinalizationIdentitySchema.safeParse(input.identity);
  if (
    !parsed.success ||
    !z.string().datetime().safeParse(input.inspectedAt).success ||
    !Number.isSafeInteger(input.additionalUsedBytes) ||
    input.additionalUsedBytes < 0
  )
    return refused("invalid-input");
  const identity = parsed.data,
    validation = identity.validation,
    dispatchIdentity = validation.dispatch,
    generationIdentity = dispatchIdentity.generation,
    id = generationIdentity.dispatch.runId;
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
  const state = archive.reservationArchive.ledger,
    snapshot = state.provider.snapshots.find((row) => row.run.id === id),
    binding = archive.records.find((row) => row.runId === id);
  if (
    !snapshot ||
    snapshot.archiveFormatVersion !== 3 ||
    snapshot.run.environment !== "production" ||
    snapshot.run.runDigest !== generationIdentity.dispatch.runDigest ||
    !binding ||
    binding.recordDigest !== generationIdentity.dispatch.approvalBindingDigest
  )
    return refused("bindings-changed");
  const [approval, genPrepared, genDispatch, genResponse, genValidated, prepared, dispatch] =
    snapshot.events;
  const matches = (nonce: string, kind: string, event: ProviderExecutionEvent) =>
    state.provider.receipts.some(
      (row) =>
        row.clientRequestId === nonce &&
        row.kind === kind &&
        row.runId === id &&
        row.runRevision === event.revision &&
        row.operationDigest === event.eventDigest,
    );
  // Native inspection has reconstructed each command hash; now bind every selected receipt.
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
    genValidated.eventDigest !== dispatchIdentity.validationEventDigest ||
    !matches(generationIdentity.dispatch.preparedRequestId, "provider-prepared", genPrepared) ||
    !matches(generationIdentity.dispatch.dispatchRequestId, "provider-dispatch", genDispatch) ||
    !matches(generationIdentity.responseRequestId, "provider-response", genResponse) ||
    !matches(generationIdentity.validationRequestId, "provider-validated", genValidated) ||
    !matches(dispatchIdentity.preparedRequestId, "provider-prepared", prepared) ||
    !matches(dispatchIdentity.dispatchRequestId, "provider-dispatch", dispatch)
  )
    return refused("bindings-changed");
  if (snapshot.terminal) return refused("execution-stopped");
  const response = snapshot.events[7],
    validated = snapshot.events[8];
  if (
    snapshot.revision !== 9 ||
    snapshot.state !== "validated" ||
    response?.payload.kind !== "response-received" ||
    response.payload.phase !== "review" ||
    validated?.payload.kind !== "domain-validated" ||
    validated.payload.phase !== "review"
  )
    return refused("review-validation-required");
  if (
    response.eventDigest !== validation.responseEventDigest ||
    validated.eventDigest !== identity.validationEventDigest ||
    !matches(validation.responseRequestId, "provider-response", response) ||
    !matches(validation.validationRequestId, "provider-validated", validated)
  )
    return refused("bindings-changed");
  const used = new Set([
    ...(input.archive.archive.ledger.otherNonces ?? []),
    ...[...state.provider.receipts, ...state.legacy.receipts, ...state.policy.records].map(
      (row) => row.clientRequestId,
    ),
  ]);
  if (used.has(identity.finalizationRequestId)) return refused("nonce-conflict");
  const scopeId = snapshot.run.preparation.budget.scopeId,
    budget = getProviderExecutionBudgetSnapshot(
      state.provider.budgetEvents.filter((row) => row.scopeId === scopeId),
      scopeId,
    ),
    head = state.provider.budgetEvents.find((row) => row.eventDigest === budget.headDigest);
  if (
    Date.parse(input.inspectedAt) < Date.parse(validated.recordedAt) ||
    (head && Date.parse(input.inspectedAt) < Date.parse(head.recordedAt))
  )
    return refused("invalid-input");
  if (
    budget.boundBreached ||
    BigInt(budget.deficitUnits) > BigInt(0) ||
    response.payload.usageAssessment.violations.length ||
    genResponse.payload.usageAssessment.violations.length
  )
    return refused("budget-bound-breached");
  const own = budget.reservations.find((row) => row.runId === id);
  if (
    !own ||
    ["generation", "review"].some((phase) => {
      const held = own.phases.find((row) => row.phase === phase);
      return !held?.settled || held.heldUnits !== "0";
    })
  )
    return refused("budget-unsettled");
  const prep = snapshot.run.preparation;
  try {
    if (getPlanExecutionContract().contractDigest !== prep.contract.baseContract.contractDigest)
      return refused("validation-contract-changed");
  } catch {
    return refused("validation-unavailable");
  }
  const registry = input.archive.archive.ledger.registries.find(
      (row) => row.version === prep.scope.version && row.versionDigest === prep.scope.versionDigest,
    ),
    entry = registry?.entries.find((row) => row.candidateId === prep.scope.candidateId),
    initial = state.provider.artifacts.find(
      (row) => row.runId === id && row.key === "generation-validated",
    ),
    reviewed = state.provider.artifacts.find(
      (row) => row.runId === id && row.key === "review-validated",
    );
  if (
    !registry ||
    !entry ||
    !initial ||
    initial.sha256 !== genValidated.payload.artifactSha256 ||
    !reviewed ||
    reviewed.sha256 !== validated.payload.artifactSha256
  )
    return refused("bindings-changed");
  let body, artifact;
  try {
    const source = candidateRegistryModelInput(entry),
      company = caseSchema.parse({
        id,
        profile: source.profile,
        sources: source.sources,
        analysis: null,
        selectedCandidateId: source.candidate.id,
        plans: [],
        tasks: [],
        stage: "preparing",
        revision: 0,
        createdAt: prep.preparedAt,
        updatedAt: prep.preparedAt,
      }),
      generation = JSON.parse(initial.body) as ProviderExecutionOutput,
      review = JSON.parse(reviewed.body) as ProviderExecutionOutput;
    if (generation.kind !== "plan" || review.kind !== "review")
      return refused("finalization-unavailable");
    body = validateProviderExecutionFinalResult(
      {
        ...finalizeObservedPlanReview(
          company,
          structuredClone(generation.content),
          structuredClone(review.findings),
        ),
        contractDigest: approval.payload.manifest.executionContract.contractDigest,
      },
      approval.payload.manifest.executionContract.contractDigest,
      generation,
      review,
    );
    const rawBody = JSON.stringify(body);
    if (Buffer.byteLength(rawBody, "utf8") > providerExecutionLimits.finalBytes)
      return refused("final-result-too-large");
    artifact = createProviderExecutionArtifact({ runId: id, key: "final-result", body: rawBody });
  } catch {
    return refused("finalization-unavailable");
  }
  try {
    const command: ProviderExecutionCommand<"execution-stopped"> = {
      clientRequestId: identity.finalizationRequestId,
      expectedRevision: 9,
      artifact,
      payload: {
        kind: "execution-stopped",
        outcome: "completed",
        failureCode: null,
        finalArtifactSha256: artifact.sha256,
      },
    };
    const event = createProviderExecutionEvent({
      schemaVersion: 2,
      executionContractVersion: 1,
      runId: id,
      revision: 10,
      budgetRevision: budget.revision,
      previousEventDigest: validated.eventDigest,
      recordedAt: input.inspectedAt,
      payload: { ...command.payload, releasedBudgetEventDigests: [] },
    });
    const receipt = createProviderExecutionReceipt({
      schemaVersion: 2,
      scopeId,
      kind: "provider-finish",
      clientRequestId: identity.finalizationRequestId,
      inputDigest: providerExecutionOperationDigest(id, command),
      runId: id,
      runRevision: 10,
      budgetRevision: budget.revision,
      operationDigest: event.eventDigest,
      recordedAt: input.inspectedAt,
    });
    const ledger = input.archive.archive.ledger,
      after = inspectProviderTransmissionApprovalArchive({
        ...input.archive,
        archive: {
          ...input.archive.archive,
          ledger: {
            ...ledger,
            events: [...ledger.events, event],
            artifacts: [...ledger.artifacts, artifact],
            receipts: [...ledger.receipts, receipt],
          },
        },
      }),
      totalExposureBytes = exposure(after);
    if (!withinCapacity(totalExposureBytes)) return refused("capacity-exceeded");
    const completed = after.reservationArchive.ledger.provider.snapshots.find(
      (row) => row.run.id === id,
    );
    if (
      completed?.archiveFormatVersion !== 3 ||
      !completed.terminal ||
      completed.state !== "completed" ||
      completed.revision !== 10
    )
      return refused("planned-archive-invalid");
    const plan = {
      planVersion: 1 as const,
      kind: "provider-finalization-plan" as const,
      status: "prepared-not-committed" as const,
      transaction: "single-immediate-transaction-required" as const,
      identity,
      inspectedAt: input.inspectedAt,
      basis: {
        archiveDigest: digest(input.archive),
        snapshotDigest: snapshot.snapshotDigest,
        approvalBindingDigest: binding.recordDigest,
        generationEventDigest: genValidated.eventDigest,
        generationArtifactSha256: initial.sha256,
        reviewEventDigest: validated.eventDigest,
        reviewArtifactSha256: reviewed.sha256,
        reviewOutputDigest: validated.payload.outputDigest,
        budgetHead: { revision: budget.revision, headDigest: budget.headDigest },
        validationContractDigest: prep.contract.baseContract.contractDigest,
      },
      body,
      command,
      rows: { artifact, event, receipt },
      capacity: {
        additionalUsedBytes: input.additionalUsedBytes,
        previousExposureBytes: exposure(archive),
        totalExposureBytes,
      },
      completionPersisted: false as const,
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
export type ProviderFinalizationResult = ReturnType<typeof prepareProviderFinalization>;
export type ProviderFinalizationPlan = Extract<
  ProviderFinalizationResult,
  { status: "prepared" }
>["plan"];

/** Historical completion evidence. The final body is read from its audited stored artifact;
 * neither recovery nor replay derives a new body or creates an execution capability. */
export type ProviderFinalizationRecord = ProviderFinalizationIdentity & {
  state: "committed";
  inputDigest: string;
  completionEventDigest: string;
  finalArtifactSha256: string;
  finalArtifactSizeBytes: number;
  generationArtifactSha256: string;
  reviewArtifactSha256: string;
  revision: 10;
  recordedAt: string;
  completionPersisted: true;
  finalResultPersisted: true;
  dispatchAllowed: false;
  budgetWriteAllowed: false;
  automaticRetryAllowed: false;
};
export type ProviderFinalizationCommitResult = {
  record: ProviderFinalizationRecord;
  newlyCommitted: boolean;
  replayed: boolean;
};
