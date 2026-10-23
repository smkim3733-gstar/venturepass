import { z } from "zod";
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  revision = z.number().int().nonnegative().safe();
export const cancellationSelectionSchema = z
  .object({ companyId: uuid, companyRevision: revision, runId: uuid })
  .strict();
export const cancellationConsentSchema = z
  .object({
    reviewDigest: hash,
    cancelReservationAcknowledged: z.literal(true),
    retainedEvidenceAcknowledged: z.literal(true),
  })
  .strict();
export const cancellationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), selection: cancellationSelectionSchema }).strict(),
  z.object({ action: z.enum(["review", "inspect", "recover", "close"]) }).strict(),
  z.object({ action: z.literal("cancel"), consent: cancellationConsentSchema }).strict(),
]);
const amount = {
  currency: z.string().regex(/^[A-Z]{3}$/),
  unitScale: z.number().int().min(0).max(12),
  releasedUnits: z.string().regex(/^[1-9][0-9]{0,29}$/),
};
export const cancellationReviewSchema = cancellationSelectionSchema
  .extend({
    reviewDigest: hash,
    reservationCompanyRevision: revision,
    model: z.string().min(1).max(100),
    sectionTitle: z.string().min(1).max(10000),
    ...amount,
    inspectedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    notice: z.string().min(1).max(10000),
  })
  .strict();
export const cancellationReceiptSchema = cancellationSelectionSchema
  .extend({
    clientRequestId: uuid,
    reviewDigest: hash,
    commandDigest: hash,
    recordDigest: hash,
    recordedAt: z.string().datetime(),
    ...amount,
    cancelled: z.literal(true),
    finalized: z.literal(true),
    transmissionAllowed: z.literal(false),
    refundVerified: z.literal(false),
  })
  .strict();
export const cancellationStateSchema = z
  .object({
    kind: z.literal("comparison-cancellation-state"),
    registrationId: uuid,
    selection: cancellationSelectionSchema,
    status: z.enum([
      "unused",
      "review",
      "attempted",
      "recorded",
      "not-observed",
      "failed",
      "draining",
      "closed",
    ]),
    revoked: z.boolean(),
    retained: z.boolean(),
    clientRequestId: uuid.nullable(),
    receipt: cancellationReceiptSchema.nullable(),
    review: cancellationReviewSchema.nullable(),
    transmissionAllowed: z.literal(false),
    runtimeObserved: z.literal(false),
  })
  .strict();
export type CancellationSelection = z.infer<typeof cancellationSelectionSchema>;
export type CancellationState = z.infer<typeof cancellationStateSchema>;
export const cancellationNotice =
  "선택한 미전송 예약을 취소하고 표시된 예산 보유액을 해제합니다. 취소·예약·선택 문맥의 원장 증거는 남으며 삭제하지 않습니다. 이미 전송된 요청이나 실제 청구의 취소·환불 처리가 아닙니다. 응답이 끊기면 원래 취소 기록만 조회합니다.";
