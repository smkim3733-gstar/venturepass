import "server-only";
import type { PlanPromptVersion } from "./studio-plan-prompt-versions";
import { createVersionedProviderPreparationBuilder } from "./studio-plan-quality-provider-core";

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
  deriveProviderExecutionReviewRequest,
  getProviderExecutionBudgetSnapshot,
  providerExecutionOperationDigest,
  providerExecutionLimits,
  validateProviderExecutionOutput,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import {
  captureProviderResponse,
  freezeProviderValue,
} from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  providerDigest as digest,
  providerWireDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import {
  providerGenerationDispatchIdentitySchema,
  providerGenerationDispatchPlanLimits,
} from "./studio-plan-quality-provider-dispatch-plan";
import { parseProviderResponseOutput } from "./studio-provider-observation";
import {
  getPlanExecutionContract,
  validateObservedPlanDraft,
  StudioEngineError,
} from "./studio-engine";
import { getPlanExecutionContractForVersion } from "./studio-engine-request-preparation";
import { candidateRegistryModelInput } from "./studio-plan-quality-candidate-registry";
import { caseSchema } from "./studio-schema";
import type {
  ProviderExecutionCommand,
  ProviderExecutionEvent,
} from "./studio-plan-quality-provider-execution-types";

export const providerGenerationValidationIdentitySchema = z
  .object({
    dispatch: providerGenerationDispatchIdentitySchema,
    responseRequestId: z.string().uuid(),
    responseEventDigest: z.string().regex(/^[a-f0-9]{64}$/),
    validationRequestId: z.string().uuid(),
  })
  .strict();
export type ProviderGenerationValidationIdentity = z.infer<
  typeof providerGenerationValidationIdentitySchema
>;
export type ProviderGenerationValidationInput = {
  identity: unknown;
  inspectedAt: string;
  archive: Parameters<typeof inspectProviderTransmissionApprovalArchive>[0];
  /** Raw audited bytes outside native + reservation + transmission archives. */
  additionalUsedBytes: number;
};

type Refusal =
  | "server-version-mismatch"
  | "invalid-input"
  | "archive-invalid"
  | "bindings-changed"
  | "generation-response-required"
  | "execution-stopped"
  | "nonce-conflict"
  | "usage-unknown"
  | "budget-bound-breached"
  | "validation-contract-changed"
  | "validation-unavailable"
  | "output-invalid"
  | "review-request-too-large"
  | "capacity-exceeded"
  | "planned-archive-invalid";
const refused = (reason: Refusal) => ({ status: "refused" as const, reason, plan: null });

/** Pure server preparation. Uses captured evidence and the current compatible domain validator;
 * it does NOT grant review sending, check fresh approval/configuration or commit any proposed row. */
export function prepareProviderGenerationValidation(
  input: ProviderGenerationValidationInput,
): ProviderGenerationValidationResult {
  // Frozen v1 entry: neither widening the reader nor changing historical plan bytes.
  return prepareGenerationValidation(input, null) as ProviderGenerationValidationResult;
}

/** Explicit server selection; planned rows convey no commit or transmission ownership. */
export function prepareVersionedProviderGenerationValidation(
  version: PlanPromptVersion,
  input: ProviderGenerationValidationInput,
): VersionedProviderGenerationValidationResult {
  createVersionedProviderPreparationBuilder(version);
  if (
    !input ||
    Object.keys(input).some(
      (key) => !["identity", "inspectedAt", "archive", "additionalUsedBytes"].includes(key),
    )
  )
    return refused("invalid-input");
  return prepareGenerationValidation(input, version);
}
function prepareGenerationValidation(
  input: ProviderGenerationValidationInput,
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
  const parsed = providerGenerationValidationIdentitySchema.safeParse(input.identity);
  if (
    !parsed.success ||
    !z.string().datetime().safeParse(input.inspectedAt).success ||
    !Number.isSafeInteger(input.additionalUsedBytes) ||
    input.additionalUsedBytes < 0
  )
    return refused("invalid-input");
  const identity = parsed.data,
    id = identity.dispatch.runId;
  let archive: ReturnType<typeof inspectVersionedProviderTransmissionApprovalArchive>;
  try {
    archive = inspect(input.archive);
  } catch {
    return refused("archive-invalid");
  }
  const state = archive.reservationArchive.ledger;
  const snapshot = state.provider.snapshots.find((row) => row.run.id === id);
  const binding = archive.records.find((row) => row.runId === id);
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
    snapshot.run.runDigest !== identity.dispatch.runDigest ||
    !binding ||
    binding.recordDigest !== identity.dispatch.approvalBindingDigest
  )
    return refused("bindings-changed");
  const approval = snapshot.events[0],
    prepared = snapshot.events[1],
    dispatch = snapshot.events[2];
  const matchesReceipt = (nonce: string, kind: string, revision: number, eventDigest: string) =>
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
    dispatch?.payload.kind !== "dispatch-intent" ||
    dispatch.payload.phase !== "generation" ||
    !matchesReceipt(
      identity.dispatch.preparedRequestId,
      "provider-prepared",
      2,
      prepared.eventDigest,
    ) ||
    !matchesReceipt(
      identity.dispatch.dispatchRequestId,
      "provider-dispatch",
      3,
      dispatch.eventDigest,
    )
  )
    return refused("bindings-changed");
  if (snapshot.terminal) return refused("execution-stopped");
  const response = snapshot.events[3];
  if (
    snapshot.revision !== 4 ||
    snapshot.state !== "response-recorded" ||
    response?.payload.kind !== "response-received" ||
    response.payload.phase !== "generation"
  )
    return refused("generation-response-required");
  if (
    response.eventDigest !== identity.responseEventDigest ||
    !matchesReceipt(identity.responseRequestId, "provider-response", 4, response.eventDigest)
  )
    return refused("bindings-changed");
  const used = new Set(
    [...state.provider.receipts, ...state.legacy.receipts, ...state.policy.records].map(
      (row) => row.clientRequestId,
    ),
  );
  for (const nonce of input.archive.archive.ledger.otherNonces ?? []) used.add(nonce);
  if (used.has(identity.validationRequestId)) return refused("nonce-conflict");
  if (Date.parse(input.inspectedAt) < Date.parse(response.recordedAt))
    return refused("invalid-input");
  if (
    response.payload.usageAssessment.status !== "known" ||
    !response.payload.usageBudgetEventDigest
  )
    return refused("usage-unknown");
  const budget = getProviderExecutionBudgetSnapshot(
    state.provider.budgetEvents.filter(
      (row) => row.scopeId === snapshot.run.preparation.budget.scopeId,
    ),
    snapshot.run.preparation.budget.scopeId,
  );
  if (
    budget.boundBreached ||
    BigInt(budget.deficitUnits) > BigInt(0) ||
    response.payload.usageAssessment.violations.length
  )
    return refused("budget-bound-breached");
  const run = snapshot.run,
    prep = run.preparation;
  if (
    (version === null ? getPlanExecutionContract() : getPlanExecutionContractForVersion(version))
      .contractDigest !== prep.contract.baseContract.contractDigest
  )
    return refused("validation-contract-changed");
  const registry = input.archive.archive.ledger.registries.find(
    (row) => row.version === prep.scope.version && row.versionDigest === prep.scope.versionDigest,
  );
  const entry = registry?.entries.find((row) => row.candidateId === prep.scope.candidateId);
  const raw = state.provider.artifacts.find(
    (row) => row.runId === id && row.key === "generation-response",
  );
  if (!registry || !entry || !raw || raw.sha256 !== response.payload.artifactSha256)
    return refused("bindings-changed");
  let company, captured;
  try {
    const source = candidateRegistryModelInput(entry);
    captured = captureProviderResponse(JSON.parse(raw.body).response);
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
  let draft;
  try {
    draft = validateObservedPlanDraft(company, parseProviderResponseOutput(captured));
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      (error instanceof StudioEngineError &&
        [
          "AI_INCOMPLETE",
          "AI_INVALID_OUTPUT",
          "AI_INVALID_PLAN",
          "AI_INVALID_EVIDENCE",
          "AI_INVALID_CLAIM",
        ].includes(error.code))
    )
      return refused("output-invalid");
    return refused("validation-unavailable");
  }
  let output;
  try {
    output = validateProviderExecutionOutput(
      "generation",
      { kind: "plan", content: draft },
      captured,
      run,
      registry,
    );
  } catch (error) {
    return refused(
      error instanceof z.ZodError ||
        (error instanceof Error && error.message === "QUALITY_PROVIDER_EXECUTION_INVALID")
        ? "output-invalid"
        : "validation-unavailable",
    );
  }
  let artifact;
  const outputBody = JSON.stringify(output);
  if (Buffer.byteLength(outputBody, "utf8") > providerExecutionLimits.validatedBytes)
    return refused("output-invalid");
  try {
    artifact = createProviderExecutionArtifact({
      runId: id,
      key: "generation-validated",
      body: outputBody,
    });
  } catch {
    return refused("validation-unavailable");
  }
  const command: ProviderExecutionCommand<"domain-validated"> = {
    clientRequestId: identity.validationRequestId,
    expectedRevision: 4,
    artifact,
    payload: {
      kind: "domain-validated",
      phase: "generation",
      requestDigest: response.payload.requestDigest,
      responseEventDigest: response.eventDigest,
      artifactSha256: artifact.sha256,
      outputDigest: digest(output),
    },
  };
  const eventInput = {
    schemaVersion: 2 as const,
    runId: id,
    revision: 5,
    budgetRevision: budget.revision,
    previousEventDigest: response.eventDigest,
    recordedAt: input.inspectedAt,
    payload: command.payload,
  };
  const event = nativeV2
    ? createVersionedProviderExecutionEvent({ ...eventInput, executionContractVersion: 2 })
    : createProviderExecutionEvent({ ...eventInput, executionContractVersion: 1 });
  const receipt = createProviderExecutionReceipt({
    schemaVersion: 2,
    scopeId: budget.scopeId,
    kind: "provider-validated",
    clientRequestId: identity.validationRequestId,
    inputDigest: operationDigest(id, command),
    runId: id,
    runRevision: 5,
    budgetRevision: budget.revision,
    operationDigest: event.eventDigest,
    recordedAt: input.inspectedAt,
  });
  let review;
  try {
    const body = deriveProviderExecutionReviewRequest(run, output);
    const requestArtifact = createProviderExecutionArtifact({
      runId: id,
      key: "review-request",
      body: JSON.stringify(body),
    });
    review = {
      status: "derived-not-prepared" as const,
      body,
      rawBody: requestArtifact.body,
      requestDigest: providerWireDigest(body),
      artifactSha256: requestArtifact.sha256,
      sizeBytes: requestArtifact.sizeBytes,
      derivedFrom: {
        generationEventDigest: event.eventDigest,
        artifactSha256: artifact.sha256,
        outputDigest: digest(output),
      },
    };
  } catch {
    return refused("review-request-too-large");
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
    const native = after.reservationArchive.ledger;
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
      return refused("capacity-exceeded");
    const plan = {
      planVersion: nativeV2 ? (2 as const) : (1 as const),
      kind: "provider-generation-validation-plan" as const,
      status: "prepared-not-committed" as const,
      transaction: "single-immediate-transaction-required" as const,
      identity,
      inspectedAt: input.inspectedAt,
      basis: {
        archiveDigest: digest(input.archive),
        snapshotDigest: snapshot.snapshotDigest,
        approvalBindingDigest: binding.recordDigest,
        responseArtifactSha256: raw.sha256,
        budgetHead: { revision: budget.revision, headDigest: budget.headDigest },
        validationContractDigest: prep.contract.baseContract.contractDigest,
      },
      output,
      command,
      rows: { artifact, event, receipt },
      review,
      capacity: { additionalUsedBytes: input.additionalUsedBytes, totalExposureBytes },
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
export type VersionedProviderGenerationValidationResult = ReturnType<
  typeof prepareGenerationValidation
>;
type SharedPlan = Extract<
  VersionedProviderGenerationValidationResult,
  { status: "prepared" }
>["plan"];
export type VersionedProviderGenerationValidationPlan = SharedPlan;
export type ProviderGenerationValidationPlan = Omit<SharedPlan, "planVersion" | "rows"> & {
  planVersion: 1;
  rows: Omit<SharedPlan["rows"], "event"> & { event: ProviderExecutionEvent };
};
export type ProviderGenerationValidationResult =
  { status: "prepared"; plan: ProviderGenerationValidationPlan } | ReturnType<typeof refused>;

/** Historical validation evidence only. It grants no review preparation or sending authority. */
export type ProviderGenerationValidationRecord = ProviderGenerationValidationIdentity & {
  state: "committed";
  inputDigest: string;
  responseArtifactSha256: string;
  validationEventDigest: string;
  validatedArtifactSha256: string;
  outputDigest: string;
  revision: 5;
  recordedAt: string;
  validationPersisted: true;
  reviewPrepared: false;
  dispatchAllowed: false;
  budgetWriteAllowed: false;
  automaticRetryAllowed: false;
};
export type ProviderGenerationValidationCommitResult = {
  record: ProviderGenerationValidationRecord;
  newlyCommitted: boolean;
  replayed: boolean;
};
