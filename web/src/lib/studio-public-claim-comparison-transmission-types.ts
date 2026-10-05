import "server-only";
import { z } from "zod";
import {
  comparisonHashSchema as hash,
  comparisonFinancialEvidenceSchema,
} from "./studio-public-claim-comparison-financial";

export const comparisonTransmissionNotice = Object.freeze({
  noticeVersion: 1 as const,
  text: "저장한 공개 주장 한 개와 직접 선택한 공개 발췌, 해당 원고 항목 전체 및 수동 메타데이터를 표시된 모델의 Responses API에 한 번 전송합니다. 자동 재시도와 반복 클릭 재전송은 없습니다. 응답은 로컬 원장에 보관하며 공급자 보관 조건은 별도입니다. store:false는 공급자 무보관 보장이 아닙니다. 비용이 불명하면 예약 금액을 유지합니다. 비교 의견은 사실 확인이나 사람의 최종 인수를 대신하지 않습니다.",
});
export const comparisonTransmissionTime = z.string().datetime();
export const comparisonTransmissionUuid = z.string().uuid();
const integer = z.number().int().nonnegative().safe();
export const comparisonTransmissionHead = z
  .object({ revision: integer, headDigest: hash })
  .strict();
const purpose = z.literal("compare-public-claim");
export const comparisonTransmissionBasisSchema = comparisonFinancialEvidenceSchema
  .pick({
    provenance: true,
    model: true,
    requestVersion: true,
    contractDigest: true,
    destination: true,
    store: true,
    requestedTier: true,
    maxCalls: true,
    automaticRetryLimit: true,
    maxOutputTokens: true,
    omissions: true,
    sources: true,
  })
  .extend({
    kind: z.literal("public-comparison-transmission-basis"),
    basisVersion: z.literal(1),
    purpose,
    method: z.literal("POST"),
    strict: z.literal(true),
    schemaDigest: hash,
    financialBasisDigest: hash,
    retentionNoticeDigest: hash,
    notice: z
      .object({
        noticeVersion: z.literal(1),
        text: z.string().min(1).max(10000),
        noticeDigest: hash,
      })
      .strict(),
  })
  .strict();
export const comparisonDispatchCommandSchema = z
  .object({
    commandVersion: z.literal(1),
    kind: z.literal("approve-dispatch-public-claim-comparison"),
    purpose,
    clientRequestId: comparisonTransmissionUuid,
    runId: comparisonTransmissionUuid,
    runDigest: hash,
    expectedReservationBindingDigest: hash,
    approvedReviewDigest: hash,
    expectedTransmissionArchiveDigest: hash,
    expectedCoverageDigest: hash,
    expectedRunHead: comparisonTransmissionHead,
    expectedBudgetHead: comparisonTransmissionHead,
    approval: z
      .object({
        noticeVersion: z.literal(1),
        noticeDigest: hash,
        retentionNoticeDigest: hash,
        exactRequestIdentityDigest: hash,
        approvedAt: comparisonTransmissionTime,
        expiresAt: comparisonTransmissionTime,
        externalTransmissionAcknowledged: z.literal(true),
        comparisonPurposeAcknowledged: z.literal(true),
        singleCallAcknowledged: z.literal(true),
        noAutomaticRetryAcknowledged: z.literal(true),
        unknownCostHoldAcknowledged: z.literal(true),
        noResendAcknowledged: z.literal(true),
        localRetentionAcknowledged: z.literal(true),
      })
      .strict(),
  })
  .strict();
const continuation = {
  commandVersion: z.literal(1),
  purpose,
  clientRequestId: comparisonTransmissionUuid,
  runId: comparisonTransmissionUuid,
  transmissionBindingDigest: hash,
  dispatchEventDigest: hash,
  expectedRunHead: comparisonTransmissionHead,
};
export const comparisonUnknownCommandSchema = z
  .object({
    ...continuation,
    kind: z.literal("mark-public-comparison-unknown"),
    reason: z.enum(["not-started-unconfirmed", "transport-unknown", "restart-unknown"]),
  })
  .strict();
export const comparisonCaptureCommandSchema = z
  .object({
    ...continuation,
    kind: z.literal("persist-public-comparison-capture"),
    responseArtifactSha256: hash,
    sizeBytes: integer.positive().max(4 * 1024 * 1024),
  })
  .strict();
export const comparisonTransmissionBindingSchema = z
  .object({
    recordVersion: z.literal(3),
    kind: z.literal("public-comparison-transmission-binding"),
    purpose,
    clientRequestId: comparisonTransmissionUuid,
    command: comparisonDispatchCommandSchema,
    commandDigest: hash,
    approvedReview: z.unknown(),
    reviewDigest: hash,
    runId: comparisonTransmissionUuid,
    runDigest: hash,
    reservationBindingDigest: hash,
    reservationDigest: hash,
    manifestDigest: hash,
    requestIdentityDigest: hash,
    dispatchEventDigest: hash,
    dispatchRevision: integer.positive(),
    nativeInputDigest: hash,
    recordedAt: comparisonTransmissionTime,
    dispatchAllowed: z.literal(false),
    recordDigest: hash,
  })
  .strict();
export type ComparisonTransmissionBasis = z.infer<typeof comparisonTransmissionBasisSchema>;
export type ComparisonTransmissionBinding = z.infer<typeof comparisonTransmissionBindingSchema>;
export type ComparisonDispatchCommand = z.infer<typeof comparisonDispatchCommandSchema>;
export type ComparisonUnknownCommand = z.infer<typeof comparisonUnknownCommandSchema>;
export type ComparisonCaptureCommand = z.infer<typeof comparisonCaptureCommandSchema>;
