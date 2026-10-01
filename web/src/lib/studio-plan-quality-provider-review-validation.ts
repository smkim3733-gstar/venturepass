import "server-only";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { createVersionedProviderPreparationBuilder } from "./studio-plan-quality-provider-core";
import { getPlanExecutionContractForVersion } from "./studio-engine-request-preparation";
import { z } from "zod";
import {
  inspectProviderTransmissionApprovalArchive,
  inspectVersionedProviderTransmissionApprovalArchive,
} from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  createProviderExecutionArtifact,
  createProviderExecutionEvent,
  createVersionedProviderExecutionEvent,
  versionedProviderExecutionOperationDigest,
  createProviderExecutionReceipt,
  getProviderExecutionBudgetSnapshot,
  providerExecutionOperationDigest,
  providerExecutionLimits,
  validateProviderExecutionOutput,
  validateProviderExecutionFinalResult,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  captureProviderResponse,
  freezeProviderValue,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import { providerDigest as digest } from "../../scripts/local-data-quality-provider.mjs";
import { providerReviewDispatchIdentitySchema } from "./studio-plan-quality-provider-review-dispatch-plan";
import { providerGenerationDispatchPlanLimits } from "./studio-plan-quality-provider-dispatch-plan";
import { parseProviderResponseOutput } from "./studio-provider-observation";
import {
  getPlanExecutionContract,
  validateObservedPlanReview,
  finalizeObservedPlanReview,
  StudioEngineError,
} from "./studio-engine";
import { candidateRegistryModelInput } from "./studio-plan-quality-candidate-registry";
import { caseSchema } from "./studio-schema";
import type {
  ProviderExecutionCommand,
  ProviderExecutionEvent,
  VersionedProviderExecutionEvent,
  ProviderExecutionOutput,
} from "./studio-plan-quality-provider-execution-types";

export const providerReviewValidationIdentitySchema = z
  .object({
    dispatch: providerReviewDispatchIdentitySchema,
    responseRequestId: z.string().uuid(),
    responseEventDigest: z.string().regex(/^[a-f0-9]{64}$/),
    validationRequestId: z.string().uuid(),
  })
  .strict();
export type ProviderReviewValidationIdentity = z.infer<
  typeof providerReviewValidationIdentitySchema
>;
export type ProviderReviewValidationInput = {
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
  | "review-response-required"
  | "execution-stopped"
  | "nonce-conflict"
  | "usage-unknown"
  | "budget-unsettled"
  | "budget-bound-breached"
  | "validation-contract-changed"
  | "validation-unavailable"
  | "output-invalid"
  | "finalization-unavailable"
  | "final-result-too-large"
  | "capacity-exceeded"
  | "planned-archive-invalid";
const refused = (reason: Refusal) => ({ status: "refused" as const, reason, plan: null });

/** Pure r8 -> proposed r9 validation. Final output is only derived; no r10, final artifact,
 * budget mutation, transmission capability or retry is persisted by this preparation. */
export function prepareProviderReviewValidation(
  input: ProviderReviewValidationInput,
): ProviderReviewValidationResult {
  // Frozen v1 entry point retains historical reader and complete plan bytes.
  return prepareReviewValidation(input, null) as ProviderReviewValidationResult;
}

/** Server-selected version. Proposed evidence grants neither storage nor execution authority. */
export function prepareVersionedProviderReviewValidation(
  version: PlanPromptVersion,
  input: ProviderReviewValidationInput,
): VersionedProviderReviewValidationResult {
  createVersionedProviderPreparationBuilder(version);
  if (
    !input ||
    Object.keys(input).some(
      (key) => !["identity", "inspectedAt", "archive", "additionalUsedBytes"].includes(key),
    )
  )
    return refused("invalid-input");
  return prepareReviewValidation(input, version);
}
function prepareReviewValidation(
  input: ProviderReviewValidationInput,
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
  const parsed = providerReviewValidationIdentitySchema.safeParse(input.identity);
  if (
    !parsed.success ||
    !z.string().datetime().safeParse(input.inspectedAt).success ||
    !Number.isSafeInteger(input.additionalUsedBytes) ||
    input.additionalUsedBytes < 0
  )
    return refused("invalid-input");
  const identity = parsed.data,
    dispatchIdentity = identity.dispatch,
    generationIdentity = dispatchIdentity.generation,
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
  // Full native auditing reconstructs command/input hashes. Bind each caller-selected identity
  // to those audited receipts, including the original generation response and validation.
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
  const response = snapshot.events[7];
  if (
    snapshot.revision !== 8 ||
    snapshot.state !== "response-recorded" ||
    response?.payload.kind !== "response-received" ||
    response.payload.phase !== "review"
  )
    return refused("review-response-required");
  if (
    response.eventDigest !== identity.responseEventDigest ||
    !matches(identity.responseRequestId, "provider-response", response)
  )
    return refused("bindings-changed");
  const used = new Set([
    ...(input.archive.archive.ledger.otherNonces ?? []),
    ...[...state.provider.receipts, ...state.legacy.receipts, ...state.policy.records].map(
      (row) => row.clientRequestId,
    ),
  ]);
  if (used.has(identity.validationRequestId)) return refused("nonce-conflict");
  const scopeId = snapshot.run.preparation.budget.scopeId,
    budget = getProviderExecutionBudgetSnapshot(
      state.provider.budgetEvents.filter((row) => row.scopeId === scopeId),
      scopeId,
    );
  const head = state.provider.budgetEvents.find((row) => row.eventDigest === budget.headDigest);
  if (
    Date.parse(input.inspectedAt) < Date.parse(response.recordedAt) ||
    (head && Date.parse(input.inspectedAt) < Date.parse(head.recordedAt))
  )
    return refused("invalid-input");
  if (
    response.payload.usageAssessment.status !== "known" ||
    !response.payload.usageBudgetEventDigest
  )
    return refused("usage-unknown");
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
  const run = snapshot.run,
    prep = run.preparation;
  try {
    if (
      (version === null ? getPlanExecutionContract() : getPlanExecutionContractForVersion(version))
        .contractDigest !== prep.contract.baseContract.contractDigest
    )
      return refused("validation-contract-changed");
  } catch {
    return refused("validation-unavailable");
  }
  const registry = input.archive.archive.ledger.registries.find(
      (row) => row.version === prep.scope.version && row.versionDigest === prep.scope.versionDigest,
    ),
    entry = registry?.entries.find((row) => row.candidateId === prep.scope.candidateId),
    raw = state.provider.artifacts.find((row) => row.runId === id && row.key === "review-response"),
    initial = state.provider.artifacts.find(
      (row) => row.runId === id && row.key === "generation-validated",
    );
  if (
    !registry ||
    !entry ||
    !raw ||
    raw.sha256 !== response.payload.artifactSha256 ||
    !initial ||
    initial.sha256 !== genValidated.payload.artifactSha256
  )
    return refused("bindings-changed");
  let company, captured, generation: ProviderExecutionOutput;
  try {
    const source = candidateRegistryModelInput(entry);
    captured = captureProviderResponse(JSON.parse(raw.body).response);
    generation = JSON.parse(initial.body) as ProviderExecutionOutput;
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
    });
  } catch {
    return refused("validation-unavailable");
  }
  let findings;
  try {
    findings = validateObservedPlanReview(company, parseProviderResponseOutput(captured));
  } catch (error) {
    return refused(
      error instanceof z.ZodError ||
        (error instanceof StudioEngineError &&
          ["AI_INCOMPLETE", "AI_INVALID_OUTPUT", "AI_INVALID_REVIEW"].includes(error.code))
        ? "output-invalid"
        : "validation-unavailable",
    );
  }
  let output;
  try {
    output = validateProviderExecutionOutput(
      "review",
      { kind: "review", findings },
      captured,
      run,
      registry,
      generation,
    );
  } catch (error) {
    return refused(
      error instanceof z.ZodError ||
        (error instanceof Error && error.message === "QUALITY_PROVIDER_EXECUTION_INVALID")
        ? "output-invalid"
        : "validation-unavailable",
    );
  }
  const outputBody = JSON.stringify(output);
  if (Buffer.byteLength(outputBody, "utf8") > providerExecutionLimits.validatedBytes)
    return refused("output-invalid");
  let artifact;
  try {
    artifact = createProviderExecutionArtifact({
      runId: id,
      key: "review-validated",
      body: outputBody,
    });
  } catch {
    return refused("validation-unavailable");
  }
  const command: ProviderExecutionCommand<"domain-validated"> = {
    clientRequestId: identity.validationRequestId,
    expectedRevision: 8,
    artifact,
    payload: {
      kind: "domain-validated",
      phase: "review",
      requestDigest: response.payload.requestDigest,
      responseEventDigest: response.eventDigest,
      artifactSha256: artifact.sha256,
      outputDigest: digest(output),
    },
  };
  const eventBody = {
    runId: id,
    revision: 9,
    budgetRevision: budget.revision,
    previousEventDigest: response.eventDigest,
    recordedAt: input.inspectedAt,
    payload: command.payload,
  };
  const event = nativeV2
    ? createVersionedProviderExecutionEvent({
        schemaVersion: 2,
        executionContractVersion: 2,
        ...eventBody,
      })
    : createProviderExecutionEvent({ schemaVersion: 2, executionContractVersion: 1, ...eventBody });
  const receipt = createProviderExecutionReceipt({
    schemaVersion: 2,
    scopeId: budget.scopeId,
    kind: "provider-validated",
    clientRequestId: identity.validationRequestId,
    inputDigest: operationDigest(id, command),
    runId: id,
    runRevision: 9,
    budgetRevision: budget.revision,
    operationDigest: event.eventDigest,
    recordedAt: input.inspectedAt,
  });
  let finalization;
  try {
    if (generation.kind !== "plan" || output.kind !== "review")
      return refused("validation-unavailable");
    const body = validateProviderExecutionFinalResult(
      {
        ...finalizeObservedPlanReview(
          company,
          structuredClone(generation.content),
          structuredClone(output.findings),
        ),
        contractDigest: approval.payload.manifest.executionContract.contractDigest,
      },
      approval.payload.manifest.executionContract.contractDigest,
      generation,
      output,
    );
    const rawBody = JSON.stringify(body);
    if (Buffer.byteLength(rawBody, "utf8") > providerExecutionLimits.finalBytes)
      return refused("final-result-too-large");
    const preview = createProviderExecutionArtifact({
      runId: id,
      key: "final-result",
      body: rawBody,
    });
    finalization = {
      status: "derived-not-finalized" as const,
      body,
      rawBody,
      artifactSha256: preview.sha256,
      sizeBytes: preview.sizeBytes,
      derivedFrom: {
        generationEventDigest: genValidated.eventDigest,
        generationArtifactSha256: initial.sha256,
        reviewEventDigest: event.eventDigest,
        reviewArtifactSha256: artifact.sha256,
        reviewOutputDigest: digest(output),
      },
    };
  } catch {
    return refused("finalization-unavailable");
  }
  try {
    const ledger = input.archive.archive.ledger;
    const after = inspect({
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
    });
    const totalExposureBytes = exposure(after);
    if (!withinCapacity(totalExposureBytes)) return refused("capacity-exceeded");
    const plan = {
      planVersion: nativeV2 ? (2 as const) : (1 as const),
      kind: "provider-review-validation-plan" as const,
      status: "prepared-not-committed" as const,
      transaction: "single-immediate-transaction-required" as const,
      identity,
      inspectedAt: input.inspectedAt,
      basis: {
        archiveDigest: digest(input.archive),
        snapshotDigest: snapshot.snapshotDigest,
        approvalBindingDigest: binding.recordDigest,
        responseArtifactSha256: raw.sha256,
        generationArtifactSha256: initial.sha256,
        budgetHead: { revision: budget.revision, headDigest: budget.headDigest },
        validationContractDigest: prep.contract.baseContract.contractDigest,
      },
      output,
      command,
      rows: { artifact, event, receipt },
      finalization,
      capacity: {
        additionalUsedBytes: input.additionalUsedBytes,
        previousExposureBytes: exposure(archive),
        totalExposureBytes,
      },
      validationPersisted: false as const,
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
export type VersionedProviderReviewValidationResult = ReturnType<typeof prepareReviewValidation>;
export type VersionedProviderReviewValidationPlan = Extract<
  VersionedProviderReviewValidationResult,
  { status: "prepared" }
>["plan"];
type SharedPlan = VersionedProviderReviewValidationPlan;
export type ProviderReviewValidationPlan = Omit<SharedPlan, "planVersion" | "rows"> & {
  planVersion: 1;
  rows: Omit<SharedPlan["rows"], "event"> & { event: ProviderExecutionEvent };
};
export type ProviderReviewValidationResult =
  { status: "prepared"; plan: ProviderReviewValidationPlan } | ReturnType<typeof refused>;

/** Historical r9 evidence only. No final preview, completion or execution capability is restored. */
export type ProviderReviewValidationRecord = ProviderReviewValidationIdentity & {
  state: "committed";
  inputDigest: string;
  generationArtifactSha256: string;
  responseArtifactSha256: string;
  validationEventDigest: string;
  validatedArtifactSha256: string;
  outputDigest: string;
  revision: 9;
  recordedAt: string;
  validationPersisted: true;
  finalResultPersisted: false;
  dispatchAllowed: false;
  budgetWriteAllowed: false;
  automaticRetryAllowed: false;
};
export type ProviderReviewValidationCommitResult = {
  record: ProviderReviewValidationRecord;
  newlyCommitted: boolean;
  replayed: boolean;
};
