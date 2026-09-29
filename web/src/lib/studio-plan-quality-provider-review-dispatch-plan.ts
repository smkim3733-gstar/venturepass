import "server-only";
import { z } from "zod";
import { inspectProviderTransmissionApprovalArchive } from "../../scripts/local-data-quality-provider-transmission-binding.mjs";
import {
  createProviderExecutionArtifact,
  createProviderExecutionEvent,
  createProviderExecutionReceipt,
  deriveProviderExecutionReviewRequest,
  providerExecutionOperationDigest,
} from "../../scripts/local-data-quality-provider-execution.mjs";
import { freezeProviderValue } from "../../scripts/local-data-quality-provider-usage.mjs";
import {
  providerDigest as digest,
  providerWireDigest,
} from "../../scripts/local-data-quality-provider.mjs";
import { providerGenerationValidationIdentitySchema } from "./studio-plan-quality-provider-generation-validation";
import { providerGenerationDispatchPlanLimits } from "./studio-plan-quality-provider-dispatch-plan";
import { createProviderTransmissionReview } from "./studio-plan-quality-provider-transmission-review";
import type {
  ProviderExecutionCommand,
  ProviderExecutionEvent,
} from "./studio-plan-quality-provider-execution-types";
import type { ProviderObservationPrepared } from "./studio-provider-observation";

export const providerReviewDispatchIdentitySchema = z
  .object({
    generation: providerGenerationValidationIdentitySchema,
    validationEventDigest: z.string().regex(/^[a-f0-9]{64}$/),
    preparedRequestId: z.string().uuid(),
    dispatchRequestId: z.string().uuid(),
  })
  .strict();
export type ProviderReviewDispatchIdentity = z.infer<typeof providerReviewDispatchIdentitySchema>;
export type ProviderReviewDispatchInput = {
  identity: unknown;
  inspectedAt: string;
  configuration: unknown;
  archive: Parameters<typeof inspectProviderTransmissionApprovalArchive>[0];
  /** Audited raw bytes outside native, reservation and transmission archives. */
  additionalUsedBytes: number;
};
type Refusal =
  | "invalid-input"
  | "archive-invalid"
  | "bindings-changed"
  | "generation-validation-required"
  | "execution-stopped"
  | "nonce-conflict"
  | "approval-expired-or-future"
  | "current-evidence-unavailable"
  | "policy-or-budget-blocked"
  | "review-request-unavailable"
  | "capacity-exceeded"
  | "planned-archive-invalid";
const refused = (reason: Refusal) => ({ status: "refused" as const, reason, plan: null });
const same = (a: unknown, b: unknown) => digest(a) === digest(b);

/** Read-only NEW review plan from audited r5. Stored validated output and the original template
 * determine the bytes. No new approval, extended deadline, reservation, transport or retry.
 * A future writer must regenerate this under its write lock; this plan conveys no ownership. */
export function prepareProviderReviewDispatch(input: ProviderReviewDispatchInput) {
  const parsed = providerReviewDispatchIdentitySchema.safeParse(input.identity);
  if (
    !parsed.success ||
    !z.string().datetime().safeParse(input.inspectedAt).success ||
    !Number.isSafeInteger(input.additionalUsedBytes) ||
    input.additionalUsedBytes < 0
  )
    return refused("invalid-input");
  const identity = parsed.data,
    generation = identity.generation,
    id = generation.dispatch.runId;
  if (identity.preparedRequestId === identity.dispatchRequestId) return refused("nonce-conflict");
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
  const state = archive.reservationArchive.ledger;
  const snapshot = state.provider.snapshots.find((row) => row.run.id === id);
  const binding = archive.records.find((row) => row.runId === id);
  if (
    !snapshot ||
    snapshot.archiveFormatVersion !== 3 ||
    snapshot.run.environment !== "production" ||
    snapshot.run.runDigest !== generation.dispatch.runDigest ||
    !binding ||
    binding.recordDigest !== generation.dispatch.approvalBindingDigest
  )
    return refused("bindings-changed");
  if (snapshot.terminal) return refused("execution-stopped");
  const [approval, preparedGeneration, dispatchedGeneration, response, validated] = snapshot.events;
  if (
    snapshot.revision !== 5 ||
    snapshot.state !== "validated" ||
    snapshot.events.length !== 5 ||
    response?.payload.kind !== "response-received" ||
    response.payload.phase !== "generation" ||
    validated?.payload.kind !== "domain-validated" ||
    validated.payload.phase !== "generation"
  )
    return refused("generation-validation-required");
  const matches = (nonce: string, kind: string, event: ProviderExecutionEvent) =>
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
    preparedGeneration?.payload.kind !== "request-prepared" ||
    preparedGeneration.payload.phase !== "generation" ||
    dispatchedGeneration?.payload.kind !== "dispatch-intent" ||
    dispatchedGeneration.payload.phase !== "generation" ||
    !matches(generation.dispatch.preparedRequestId, "provider-prepared", preparedGeneration) ||
    !matches(generation.dispatch.dispatchRequestId, "provider-dispatch", dispatchedGeneration) ||
    response.eventDigest !== generation.responseEventDigest ||
    !matches(generation.responseRequestId, "provider-response", response) ||
    validated.eventDigest !== identity.validationEventDigest ||
    !matches(generation.validationRequestId, "provider-validated", validated)
  )
    return refused("bindings-changed");
  const used = new Set([
    ...(input.archive.archive.ledger.otherNonces ?? []),
    ...state.provider.receipts.map((row) => row.clientRequestId),
    ...state.legacy.receipts.map((row) => row.clientRequestId),
    ...state.policy.records.map((row) => row.clientRequestId),
  ]);
  if (used.has(identity.preparedRequestId) || used.has(identity.dispatchRequestId))
    return refused("nonce-conflict");
  const inspectedAt = new Date(input.inspectedAt).toISOString(),
    now = Date.parse(inspectedAt);
  if (
    now < Date.parse(validated.recordedAt) ||
    now < Date.parse(binding.recordedAt) ||
    now < Date.parse(approval.payload.approvedAt) ||
    now >= Date.parse(approval.payload.expiresAt) ||
    now >= Date.parse(binding.approvedReview.expiresAt)
  )
    return refused("approval-expired-or-future");
  const current = createProviderTransmissionReview({
    selection: { runId: id, runDigest: generation.dispatch.runDigest },
    inspectedAt,
    configuration: input.configuration,
    archive: input.archive.archive,
  });
  if (current.status !== "review") return refused("current-evidence-unavailable");
  const review = current.review;
  // First-approval runUntouched/reservationIntact are intentionally false after generation.
  // Require its known settlement and the exact original, still untouched review hold instead.
  if (
    !review.facts.policyUnchanged ||
    !review.facts.budgetCompatible ||
    !review.facts.budgetWithinBound ||
    response.payload.usageAssessment.status !== "known" ||
    response.payload.usageAssessment.violations.length ||
    !response.payload.usageBudgetEventDigest ||
    !review.reservation.generationSettled ||
    review.reservation.generationHeldUnits !== "0" ||
    review.reservation.reviewSettled ||
    review.reservation.reviewHeldUnits !== review.reservation.reviewUnits ||
    !review.budget.headDigest
  )
    return refused("policy-or-budget-blocked");
  if (
    review.configurationDigest !== binding.approvedReview.configurationDigest ||
    review.reservation.bindingDigest !== binding.approvedReview.reservation.bindingDigest ||
    review.run.snapshotDigest !== snapshot.snapshotDigest ||
    !same(review.manifest, binding.approvedReview.manifest) ||
    !same(review.manifest, approval.payload.manifest) ||
    !same(review.request, binding.approvedReview.request) ||
    !same(review.retention, binding.approvedReview.retention)
  )
    return refused("bindings-changed");
  const output = state.provider.artifacts.find(
    (row) => row.runId === id && row.key === "generation-validated",
  );
  if (!output || output.sha256 !== validated.payload.artifactSha256)
    return refused("bindings-changed");
  let body, artifact;
  try {
    body = deriveProviderExecutionReviewRequest(snapshot.run, JSON.parse(output.body));
    artifact = createProviderExecutionArtifact({
      runId: id,
      key: "review-request",
      body: JSON.stringify(body),
    });
  } catch {
    return refused("review-request-unavailable");
  }
  const requestDigest = providerWireDigest(body);
  const derivedFrom = {
    generationEventDigest: validated.eventDigest,
    artifactSha256: output.sha256,
    outputDigest: validated.payload.outputDigest,
  };
  try {
    const prepared: ProviderExecutionCommand<"request-prepared"> = {
      clientRequestId: identity.preparedRequestId,
      expectedRevision: 5,
      artifact,
      payload: {
        kind: "request-prepared",
        phase: "review",
        requestDigest,
        artifactSha256: artifact.sha256,
        derivedFrom,
        budgetRevision: review.budget.revision,
        budgetDigest: review.budget.headDigest,
      },
    };
    const event = createProviderExecutionEvent({
      schemaVersion: 2,
      executionContractVersion: 1,
      runId: id,
      revision: 6,
      budgetRevision: review.budget.revision,
      previousEventDigest: validated.eventDigest,
      recordedAt: inspectedAt,
      payload: prepared.payload,
    });
    const dispatch: ProviderExecutionCommand<"dispatch-intent"> = {
      clientRequestId: identity.dispatchRequestId,
      expectedRevision: 6,
      payload: {
        kind: "dispatch-intent",
        phase: "review",
        requestDigest,
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
      runId: id,
      revision: 7,
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
        inputDigest: providerExecutionOperationDigest(id, command),
        runId: id,
        runRevision: row.revision,
        budgetRevision: row.budgetRevision,
        operationDigest: row.eventDigest,
        recordedAt: inspectedAt,
      });
    const rows = {
      artifact,
      events: [event, dispatchEvent] as const,
      receipts: [
        receipt(prepared, event, "provider-prepared"),
        receipt(dispatch, dispatchEvent, "provider-dispatch"),
      ] as const,
    };
    const ledger = input.archive.archive.ledger;
    const next = inspectProviderTransmissionApprovalArchive({
      ...input.archive,
      archive: {
        ...input.archive.archive,
        ledger: {
          ...ledger,
          artifacts: [...ledger.artifacts, artifact],
          events: [...ledger.events, ...rows.events],
          receipts: [...ledger.receipts, ...rows.receipts],
        },
      },
    });
    const totalExposureBytes = exposure(next);
    if (!withinCapacity(totalExposureBytes)) return refused("capacity-exceeded");
    const request: ProviderObservationPrepared = {
      request: {
        phase: "review",
        sequence: 2,
        model: body.model,
        contractDigest: review.manifest.executionContract.contractDigest,
        requestDigest,
        artifactSha256: artifact.sha256,
        inputChars: body.input.reduce((n, row) => n + row.content.length, 0),
        maxOutputTokens: body.max_output_tokens,
      },
      body,
      rawBody: artifact.body,
    };
    const plan = {
      planVersion: 1 as const,
      kind: "provider-review-dispatch-plan" as const,
      status: "prepared-not-committed" as const,
      transaction: "single-immediate-transaction-required" as const,
      identity,
      inspectedAt,
      expiresAt: approval.payload.expiresAt,
      basis: {
        archiveDigest: digest(input.archive),
        runId: id,
        runDigest: snapshot.run.runDigest,
        snapshotDigest: snapshot.snapshotDigest,
        revision: 5 as const,
        approvalBindingDigest: binding.recordDigest,
        approvalEventDigest: approval.eventDigest,
        configurationDigest: review.configurationDigest,
        policyHead: review.policy.head,
        budgetHead: { revision: review.budget.revision, headDigest: review.budget.headDigest },
        derivedFrom,
      },
      request,
      commands: { prepared, dispatch },
      rows,
      capacity: {
        additionalUsedBytes: input.additionalUsedBytes,
        totalExposureBytes,
        reservedBudgetEventSlots: next.reservationArchive.ledger.reservedBudgetEventSlots,
        reservedReceiptSlots: next.reservationArchive.ledger.reservedReceiptSlots,
      },
      ownership: "new-commit-owner-required" as const,
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
export type ProviderReviewDispatchResult = ReturnType<typeof prepareProviderReviewDispatch>;
export type ProviderReviewDispatchPlan = Extract<
  ProviderReviewDispatchResult,
  { status: "prepared" }
>["plan"];
