import { z } from "zod";
import { planContentSchema, reviewSchema } from "./studio-schema";
import { candidateRegistrySetId } from "./studio-plan-quality-candidate-registry-types";
import {
  engineExecutionContractSchema,
  engineExecutionRequestSchema,
  engineExecutionResponseSchema,
  engineExecutionValidatedSchema,
} from "./studio-engine-execution-types";

export const qualityExecutionLimits = {
  runs: 20,
  events: 7,
  runBytes: 32 * 1024,
  eventBytes: 1024 * 1024,
  bodyBytes: 48 * 1024,
} as const;
export const qualityExecutionMockModel = "venturepass-synthetic-plan-v1" as const;
export const qualityExecutionNotice =
  "로컬 모의 공급자 실행 기록입니다. 실제 AI 호출·청구·사람 검토·품질 합격 또는 독립 검증을 증명하지 않습니다.";
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid();
export const qualityExecutionCostSchema = z
  .object({
    kind: z.literal("mock-no-charge"),
    actualCharge: z.literal(0),
    currency: z.null(),
    priceEvidence: z.null(),
    actualAiAllowed: z.literal(false),
    actualAiBudget: z.null(),
    inputTokenEstimate: z.null(),
  })
  .strict();
export const qualityExecutionPreparationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("mock-candidate-execution"),
    mode: z.literal("mock"),
    provider: z.literal("mock"),
    model: z.literal(qualityExecutionMockModel),
    destination: z.literal("local-mock-transport"),
    setId: z.literal(candidateRegistrySetId),
    version: z.number().int().min(1).max(20),
    versionDigest: hash,
    registrySourceDigest: hash,
    manifestDigest: hash,
    candidateId: z
      .string()
      .regex(/^validation-candidate-[a-z0-9-]+$/)
      .max(120),
    label: z.string().min(1).max(200),
    sourceDigest: hash,
    candidateDigest: hash,
    modelInputDigest: hash,
    engine: engineExecutionContractSchema,
    expectedRunCount: z.number().int().min(0).max(qualityExecutionLimits.runs),
    cost: qualityExecutionCostSchema,
    purpose: z.literal("synthetic-candidate-generation-and-review"),
    humanAnswerKey: z.null(),
    independentHoldoutConfirmed: z.literal(false),
    performanceEvaluation: z.literal("not-performed"),
    actualExecutionBlockReason: z.literal(
      "실제 AI 실행의 가격 근거·금액 상한·전송 승인이 준비되지 않아 실행할 수 없습니다.",
    ),
    planDigest: hash,
  })
  .strict();
export const qualityExecutionStartSchema = z
  .object({
    clientRequestId: uuid,
    preparation: qualityExecutionPreparationSchema,
    acknowledgedMockOnly: z.literal(true),
  })
  .strict();
export const qualityExecutionRunSchema = z
  .object({
    id: uuid,
    clientRequestId: uuid,
    inputDigest: hash,
    authorizedAt: z.string().datetime(),
    preparation: qualityExecutionPreparationSchema,
    runDigest: hash,
  })
  .strict();
export const qualityExecutionReceiptSchema = z
  .object({
    kind: z.literal("start-candidate-execution"),
    executionId: uuid,
    clientRequestId: uuid,
    inputDigest: hash,
    runDigest: hash,
    planDigest: hash,
  })
  .strict();
export const qualityExecutionResultSchema = z
  .object({
    content: planContentSchema,
    review: z.array(reviewSchema).max(250),
    semanticReview: z.array(reviewSchema).max(12),
    contractDigest: hash,
  })
  .strict();
export const qualityExecutionEventPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dispatch"), request: engineExecutionRequestSchema }).strict(),
  z.object({ kind: z.literal("response"), response: engineExecutionResponseSchema }).strict(),
  z.object({ kind: z.literal("validated"), validated: engineExecutionValidatedSchema }).strict(),
  z
    .object({
      kind: z.literal("finished"),
      outcome: z.enum(["completed", "failed", "unknown"]),
      failureCode: z
        .enum(["ENGINE_FAILED", "OUTPUT_INVALID", "RESPONSE_UNRECORDED", "INTERRUPTED"])
        .nullable(),
      result: qualityExecutionResultSchema.nullable(),
    })
    .strict(),
]);
export const qualityExecutionEventSchema = z
  .object({
    executionId: uuid,
    revision: z.number().int().min(1).max(qualityExecutionLimits.events),
    previousEventDigest: hash.nullable(),
    recordedAt: z.string().datetime(),
    payload: qualityExecutionEventPayloadSchema,
    eventDigest: hash,
  })
  .strict();
export const qualityExecutionStateSchema = z.enum([
  "authorized",
  "dispatch-recorded",
  "response-observed",
  "output-validated",
  "completed",
  "failed",
  "unknown",
]);
export const qualityExecutionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    run: qualityExecutionRunSchema,
    revision: z.number().int().min(0).max(qualityExecutionLimits.events),
    events: z.array(qualityExecutionEventSchema).max(qualityExecutionLimits.events),
    state: qualityExecutionStateSchema,
    canResume: z.literal(false),
    dispatchCount: z.number().int().min(0).max(2),
    responseCount: z.number().int().min(0).max(2),
    validatedCount: z.number().int().min(0).max(2),
    actualAiCalls: z.literal(0),
    cost: qualityExecutionCostSchema,
    output: z
      .object({
        plan: planContentSchema.nullable(),
        review: z.array(reviewSchema).max(250).nullable(),
      })
      .strict(),
    notice: z.literal(qualityExecutionNotice),
    snapshotDigest: hash,
  })
  .strict();
export const qualityExecutionLookupSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("committed"), receipt: qualityExecutionReceiptSchema }).strict(),
  z.object({ state: z.literal("not-observed") }).strict(),
]);
export const qualityExecutionListSchema = z
  .object({ executions: z.array(qualityExecutionSnapshotSchema).max(qualityExecutionLimits.runs) })
  .strict();
export type QualityExecutionPreparation = z.infer<typeof qualityExecutionPreparationSchema>;
export type QualityExecutionStart = z.infer<typeof qualityExecutionStartSchema>;
export type QualityExecutionRun = z.infer<typeof qualityExecutionRunSchema>;
export type QualityExecutionReceipt = z.infer<typeof qualityExecutionReceiptSchema>;
export type QualityExecutionEventPayload = z.infer<typeof qualityExecutionEventPayloadSchema>;
export type QualityExecutionEvent = z.infer<typeof qualityExecutionEventSchema>;
export type QualityExecutionSnapshot = z.infer<typeof qualityExecutionSnapshotSchema>;
export function qualityExecutionPreparationDigestInput(
  value: QualityExecutionPreparation | Omit<QualityExecutionPreparation, "planDigest">,
) {
  const { planDigest: _ignored, ...rest } = value as QualityExecutionPreparation;
  void _ignored;
  return rest;
}
export function qualityExecutionRunDigestInput(
  value: QualityExecutionRun | Omit<QualityExecutionRun, "runDigest">,
) {
  const { runDigest: _ignored, ...rest } = value as QualityExecutionRun;
  void _ignored;
  return rest;
}
export function qualityExecutionEventDigestInput(
  value: QualityExecutionEvent | Omit<QualityExecutionEvent, "eventDigest">,
) {
  const { eventDigest: _ignored, ...rest } = value as QualityExecutionEvent;
  void _ignored;
  return rest;
}
export function qualityExecutionSnapshotDigestInput(
  value: QualityExecutionSnapshot | Omit<QualityExecutionSnapshot, "snapshotDigest">,
) {
  const { snapshotDigest: _ignored, ...rest } = value as QualityExecutionSnapshot;
  void _ignored;
  return rest;
}
export function qualityExecutionRequestDigestInput(input: QualityExecutionStart) {
  return { kind: "start-candidate-execution" as const, input };
}
export function qualityExecutionDownloadName(id: string, revision: number) {
  return `venturepass-quality-execution-${id}-r${revision}.json`;
}
