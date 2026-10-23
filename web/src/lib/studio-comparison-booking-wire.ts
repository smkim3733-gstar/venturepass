import { z } from "zod";
import { publicClaimComparisonSelectionSchema } from "./studio-public-claim-comparison-types";
import {
  publicClaimComparisonRequestCommandSchema,
  publicClaimComparisonRequestIdentitySchema,
} from "./studio-public-claim-comparison-request-types";
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid();
const units = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const revision = z.number().int().nonnegative().safe();
export const comparisonReservationConsentSchema = z
  .object({
    reviewDigest: hash,
    comparisonPurposeAcknowledged: z.literal(true),
    selectedContentRetentionAcknowledged: z.literal(true),
    currentBudgetReservationAcknowledged: z.literal(true),
    financialBasisNotTokenFitAcknowledged: z.literal(true),
    noAutomaticRetryAcknowledged: z.literal(true),
  })
  .strict();
export const bookingActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), selection: publicClaimComparisonSelectionSchema }).strict(),
  z.object({ action: z.enum(["review", "inspect", "recover", "close"]) }).strict(),
  z.object({ action: z.literal("reserve"), consent: comparisonReservationConsentSchema }).strict(),
]);
export const bookingReviewSchema = z
  .object({
    reviewDigest: hash,
    inspectedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    companyId: uuid,
    companyRevision: revision,
    request: publicClaimComparisonRequestCommandSchema,
    identity: publicClaimComparisonRequestIdentitySchema,
    budget: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        unitScale: z.number().int().min(0).max(12),
        availableUnits: units,
        heldUnits: units,
      })
      .strict(),
    costs: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        unitScale: z.number().int().min(0).max(12),
        reservedUnits: units,
        inputUnits: units,
        outputUnits: units,
      })
      .strict(),
    notice: z.string().min(1).max(10000),
    retention: z
      .object({
        localNotice: z.string().min(1).max(10000),
        providerNotice: z.string().min(1).max(10000),
      })
      .strict(),
    sources: z
      .array(
        z
          .object({
            title: z.string().min(1).max(10000),
            url: z.string().url().max(10000),
            excerpt: z.string().min(1).max(10000),
            reviewedAt: z.string().datetime(),
            validUntil: z.string().datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export const bookingReceiptSchema = z
  .object({
    kind: z.literal("comparison-reservation-receipt"),
    companyId: uuid,
    companyRevision: revision,
    clientRequestId: uuid,
    runId: uuid,
    reviewDigest: hash,
    commandDigest: hash,
    recordDigest: hash,
    recordedAt: z.string().datetime(),
    acknowledgedReservationOnly: z.literal(true),
    transmissionAllowed: z.literal(false),
    transmissionConsentRecorded: z.literal(false),
    runtimeObserved: z.literal(false),
  })
  .strict();
export const bookingStateSchema = z
  .object({
    kind: z.literal("comparison-booking-state"),
    registrationId: uuid,
    selection: publicClaimComparisonSelectionSchema,
    source: z.literal("comparison-reservation-booking"),
    status: z.enum([
      "unused",
      "review",
      "attempted",
      "recorded",
      "not-observed",
      "blocked",
      "failed",
      "closed",
      "draining",
    ]),
    revoked: z.boolean(),
    retained: z.boolean(),
    clientRequestId: uuid.nullable(),
    runId: uuid.nullable(),
    receipt: bookingReceiptSchema.nullable(),
    transmissionAllowed: z.literal(false),
    runtimeObserved: z.literal(false),
    review: bookingReviewSchema.nullable(),
  })
  .strict();
export type BookingState = z.infer<typeof bookingStateSchema>;
export type BookingSelection = z.infer<typeof publicClaimComparisonSelectionSchema>;
export const bookingConsents = [
  ["comparisonPurposeAcknowledged", "선택한 공개 주장과 공개 근거를 비교할 목적으로 예약합니다."],
  [
    "selectedContentRetentionAcknowledged",
    "표시된 선택 내용·요청·응답의 보관 안내와 회사 변경·삭제 뒤에도 남는 원장 증거를 확인했습니다.",
  ],
  [
    "currentBudgetReservationAcknowledged",
    "표시된 상한 금액을 현재 예산에서 예약하는 데 동의합니다.",
  ],
  [
    "financialBasisNotTokenFitAcknowledged",
    "예약 금액 근거가 토큰 적합성·응답 품질·사실 확인을 보장하지 않음을 확인했습니다.",
  ],
  [
    "noAutomaticRetryAcknowledged",
    "자동 재시도가 없으며 외부 전송에는 별도 승인이 필요함을 확인했습니다.",
  ],
] as const;
