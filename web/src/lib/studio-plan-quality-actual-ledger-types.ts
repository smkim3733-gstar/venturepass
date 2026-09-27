import { z } from "zod";
import { qualityActualPreparationSchema } from "./studio-plan-quality-actual-types";
import {
  engineExecutionResponseSchema,
  engineExecutionOutputSchema,
} from "./studio-engine-execution-types";
import { qualityExecutionResultSchema } from "./studio-plan-quality-execution-types";

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid(),
  date = z.string().datetime();
const units = z.string().regex(/^(0|[1-9]\d{0,79})$/);
const phase = z.enum(["generation", "review"]);
export const actualLedgerScope = "candidate-quality-executions" as const;
export const actualLedgerNotice =
  "합성 가격·토큰·전송 어댑터의 비용 원장 시험 기록입니다. 실제 AI 호출·운영 승인·청구·사람 평가를 증명하지 않습니다.";
export const actualLedgerLimits = {
  runs: 20,
  events: 32,
  budgetEvents: 1000,
  receipts: 1000,
  runBudgetEvents: 16,
  runReceipts: 64,
  runBytes: 2 * 1024 * 1024,
  eventBytes: 32 * 1024,
  receiptBytes: 4096,
  reservationBytes: 32 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
} as const;
export const actualLedgerArtifactKeys = [
  "generation-request",
  "generation-response",
  "generation-validated",
  "review-request",
  "review-response",
  "review-validated",
  "final-result",
] as const;
export const actualLedgerArtifactKeySchema = z.enum(actualLedgerArtifactKeys);
export const actualLedgerArtifactSchema = z
  .object({
    runId: uuid,
    key: actualLedgerArtifactKeySchema,
    body: z.string(),
    sha256: hash,
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(8 * 1024 * 1024),
  })
  .strict();
export const actualLedgerArtifactRefSchema = actualLedgerArtifactSchema.omit({ body: true });
export const actualLedgerPolicySchema = z
  .object({
    provenance: z.literal("synthetic-test"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitScale: z.number().int().min(0).max(12),
    capUnits: units,
  })
  .strict();
export const actualLedgerApprovalSchema = z
  .object({
    provenance: z.literal("synthetic-test"),
    approvedPreparationDigest: hash,
    acknowledgedSyntheticOnly: z.literal(true),
    approvedAt: date,
  })
  .strict();
export const actualLedgerStartSchema = z
  .object({
    clientRequestId: uuid,
    expectedBudgetRevision: z.number().int().min(1).max(1000),
    expectedBudgetDigest: hash,
    expectedActualRunCount: z.number().int().min(0).max(19),
    preparation: qualityActualPreparationSchema,
    approval: actualLedgerApprovalSchema,
  })
  .strict();
export const actualLedgerBudgetPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("configure"), capUnits: units }).strict(),
  z
    .object({
      kind: z.literal("reserve-run"),
      runId: uuid,
      preparationDigest: hash,
      generationUnits: units,
      reviewUnits: units,
    })
    .strict(),
  z
    .object({
      kind: z.literal("recognize-usage"),
      runId: uuid,
      phase,
      reservationDigest: hash,
      requestDigest: hash,
      responseArtifactSha256: hash,
      recognizedUnits: units,
      consumedReservedUnits: units,
      unusedReleasedUnits: units,
      boundExcessUnits: units,
      tokenBoundBreached: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("release-unused"),
      runId: uuid,
      phase,
      reservationDigest: hash,
      units,
      reason: z.literal("not-dispatched"),
    })
    .strict(),
]);
export const actualLedgerBudgetEventSchema = z
  .object({
    scopeId: z.literal(actualLedgerScope),
    revision: z.number().int().min(1).max(1000),
    previousDigest: hash.nullable(),
    eventId: uuid,
    recordedAt: date,
    provenance: z.literal("synthetic-test"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitScale: z.number().int().min(0).max(12),
    payload: actualLedgerBudgetPayloadSchema,
    eventDigest: hash,
  })
  .strict();
export const actualLedgerRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    archiveFormatVersion: z.literal(1),
    id: uuid,
    clientRequestId: uuid,
    inputDigest: hash,
    recordedAt: date,
    executionKind: z.literal("actual-ledger-simulation"),
    environment: z.literal("synthetic-test"),
    observedTransport: z.literal("synthetic-adapter"),
    actualAiCalls: z.literal(0),
    preparation: qualityActualPreparationSchema,
    approval: actualLedgerApprovalSchema,
    expectedBudgetRevision: z.number().int().min(1).max(1000),
    expectedBudgetDigest: hash,
    expectedActualRunCount: z.number().int().min(0).max(19),
    reservedBudgetRevision: z.number().int().min(2).max(1000),
    reservationDigest: hash,
    storageReservationBytes: z.literal(actualLedgerLimits.reservationBytes),
    reservedSlots: z
      .object({ events: z.literal(32), budgetEvents: z.literal(16), receipts: z.literal(64) })
      .strict(),
    runDigest: hash,
  })
  .strict();
export const actualLedgerRunPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("request-prepared"),
      phase,
      requestDigest: hash,
      artifactSha256: hash,
      inputTokenUpperBound: z.number().int().positive().safe(),
      derivedFrom: z
        .object({ generationEventDigest: hash, artifactSha256: hash })
        .strict()
        .nullable(),
      budgetRevision: z.number().int().min(1).max(1000),
      budgetDigest: hash,
    })
    .strict(),
  z
    .object({
      kind: z.literal("dispatch-intent"),
      phase,
      requestDigest: hash,
      preparedEventDigest: hash,
      artifactSha256: hash,
      budgetRevision: z.number().int().min(1).max(1000),
      budgetDigest: hash,
    })
    .strict(),
  z
    .object({
      kind: z.literal("response-received"),
      phase,
      requestDigest: hash,
      dispatchEventDigest: hash,
      artifactSha256: hash,
      metadata: engineExecutionResponseSchema,
      usageBudgetEventDigest: hash.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("domain-validated"),
      phase,
      requestDigest: hash,
      responseEventDigest: hash,
      artifactSha256: hash,
      outputDigest: hash,
    })
    .strict(),
  z
    .object({
      kind: z.literal("execution-stopped"),
      outcome: z.enum([
        "completed",
        "before-dispatch",
        "result-unobserved",
        "needs-cost-review",
        "output-invalid",
        "bound-breached",
      ]),
      failureCode: z
        .enum([
          "INTERRUPTED",
          "STORAGE_FAILED",
          "OUTPUT_INVALID",
          "COST_UNSETTLED",
          "BOUND_BREACHED",
        ])
        .nullable(),
      finalArtifactSha256: hash.nullable(),
      releasedBudgetEventDigests: z.array(hash).max(2),
    })
    .strict(),
]);
export const actualLedgerRunEventSchema = z
  .object({
    runId: uuid,
    revision: z.number().int().min(1).max(32),
    budgetRevision: z.number().int().min(1).max(1000),
    previousEventDigest: hash.nullable(),
    recordedAt: date,
    payload: actualLedgerRunPayloadSchema,
    eventDigest: hash,
  })
  .strict();
export const actualLedgerReceiptSchema = z
  .object({
    kind: z.enum([
      "actual-budget-configure",
      "actual-start",
      "actual-prepare",
      "actual-dispatch",
      "actual-response",
      "actual-validate",
      "actual-stop",
    ]),
    clientRequestId: uuid,
    inputDigest: hash,
    runId: uuid.nullable(),
    runRevision: z.number().int().min(0).max(32).nullable(),
    budgetRevision: z.number().int().min(1).max(1000),
    operationDigest: hash,
    recordedAt: date,
  })
  .strict();
export const actualLedgerUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    totalTokens: z.number().int().nonnegative().safe(),
    cachedInputTokens: z.number().int().nonnegative().safe().nullable(),
    reasoningOutputTokens: z.number().int().nonnegative().safe().nullable(),
  })
  .strict();
export const actualLedgerResponseArtifactSchema = z
  .object({
    captureKind: z.literal("sdk-response-json"),
    response: z
      .object({
        id: z.json().optional(),
        _request_id: z.json().optional(),
        model: z.json().optional(),
        status: z.json().optional(),
        usage: z.json().optional(),
        output: z.array(z.json()),
      })
      .strict(),
  })
  .strict();
export const actualLedgerValidatedArtifactSchema = engineExecutionOutputSchema;
export const actualLedgerFinalArtifactSchema = qualityExecutionResultSchema;

export type ActualLedgerArtifact = z.infer<typeof actualLedgerArtifactSchema>;
export type ActualLedgerArtifactRef = z.infer<typeof actualLedgerArtifactRefSchema>;
export type ActualLedgerPolicy = z.infer<typeof actualLedgerPolicySchema>;
export type ActualLedgerApproval = z.infer<typeof actualLedgerApprovalSchema>;
export type ActualLedgerStart = z.infer<typeof actualLedgerStartSchema>;
export type ActualLedgerBudgetEvent = z.infer<typeof actualLedgerBudgetEventSchema>;
export type ActualLedgerBudgetPayload = z.infer<typeof actualLedgerBudgetPayloadSchema>;
export type ActualLedgerRun = z.infer<typeof actualLedgerRunSchema>;
export type ActualLedgerRunEvent = z.infer<typeof actualLedgerRunEventSchema>;
export type ActualLedgerRunPayload = z.infer<typeof actualLedgerRunPayloadSchema>;
export type ActualLedgerReceipt = z.infer<typeof actualLedgerReceiptSchema>;
export type ActualLedgerUsage = z.infer<typeof actualLedgerUsageSchema>;
export type ActualLedgerResponseArtifact = z.infer<typeof actualLedgerResponseArtifactSchema>;
export type ActualLedgerReservation = {
  runId: string;
  phase: "generation" | "review";
  reservationDigest: string;
  reservedUnits: string;
  heldUnits: string;
  recognizedUnits: string;
  releasedUnits: string;
  boundExcessUnits: string;
  settled: boolean;
};
export type ActualLedgerBudgetSnapshot = {
  scopeId: typeof actualLedgerScope;
  revision: number;
  headDigest: string | null;
  currency: string | null;
  unitScale: number | null;
  capUnits: string;
  recognizedUsageUnits: string;
  heldUnits: string;
  exposureUnits: string;
  availableUnits: string;
  deficitUnits: string;
  boundBreached: boolean;
  reservations: ActualLedgerReservation[];
};
export type ActualLedgerSnapshot = {
  schemaVersion: 1;
  archiveFormatVersion: 1;
  run: ActualLedgerRun;
  revision: number;
  events: ActualLedgerRunEvent[];
  artifacts: ActualLedgerArtifactRef[];
  budgetEvents: ActualLedgerBudgetEvent[];
  state:
    | "reserved"
    | "request-prepared"
    | "dispatch-intent"
    | "response-received"
    | "domain-validated"
    | "completed"
    | "stopped-before-dispatch"
    | "result-unobserved"
    | "stopped-needs-cost-review"
    | "stopped-output-invalid"
    | "stopped-bound-breached";
  costState: "held" | "settled" | "bound-breached";
  sameCandidateBlocked: boolean;
  canResume: false;
  actualAiCalls: 0;
  storage: {
    usedBytes: number;
    heldBytes: number;
    remainingEventSlots: number;
    remainingBudgetEventSlots: number;
    remainingReceiptSlots: number;
  };
  notice: string;
  snapshotDigest: string;
};
export function actualLedgerDigestInput<T extends object>(
  value: T,
  key: "eventDigest" | "runDigest" | "snapshotDigest",
) {
  const copy = { ...value };
  delete (copy as Record<string, unknown>)[key];
  return copy;
}
export function actualLedgerStartDigestInput(input: ActualLedgerStart) {
  return {
    kind: "actual-start",
    clientRequestId: input.clientRequestId,
    approvedPreparationDigest: input.preparation.preparationDigest,
    approval: input.approval,
    expectedBudgetRevision: input.expectedBudgetRevision,
    expectedBudgetDigest: input.expectedBudgetDigest,
    expectedActualRunCount: input.expectedActualRunCount,
  };
}
