// Synthetic UI/contract fixture only. Never imported by the product.
import { randomUUID } from "node:crypto";
import { publicClaimComparisonFixture } from "../../src/lib/studio-public-claim-comparison-test-helpers";
import { buildPublicClaimComparisonRequest } from "../../src/lib/studio-public-claim-comparison-request";
export function comparisonExecutionFixture() {
  const f = publicClaimComparisonFixture();
  f.company.profile.companyName = "합성 비교 실행 기업";
  const command = {
    requestVersion: "public-claim-comparison-request-v1" as const,
    model: "synthetic-model",
    selection: f.select(),
  };
  const preview = buildPublicClaimComparisonRequest(f.company, command),
    hash = "a".repeat(64);
  const session = {
    kind: "comparison-execution-session",
    sessionId: randomUUID(),
    runId: randomUUID(),
    companyId: f.company.id,
    companyRevision: f.company.revision,
    closed: false,
    runtimeObserved: false,
    dispatchAllowed: false,
  };
  const status = {
    ...session,
    kind: "comparison-execution-status",
    status: "reviewed",
    outcome: null as string | null,
    reviewDigest: hash,
    selection: null,
    bodyCleanupRequired: false,
    postcapture: {
      record: "unattempted",
      settlement: "unattempted",
      review: {
        reviewDigest: hash,
        comparisonState: "completed",
        comparisonRecorded: false,
        costSettled: false,
        finalized: false,
        usageStatus: "known",
        units: "123",
        currency: "USD",
        unitScale: 6,
        hasPolicyViolations: false,
      },
    },
    execution: null,
  };
  const source = {
    title: "합성 검토 근거 — 실제 요금 아님",
    url: "https://example.invalid/synthetic",
    excerpt: "합성 표시 검증용이며 실제 요금·승인 근거가 아닙니다.",
    reviewedAt: "2026-10-01T00:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z",
  };
  const prepared = {
    review: {
      runId: session.runId,
      companyId: f.company.id,
      companyRevision: f.company.revision,
      reviewDigest: hash,
      expiresAt: "2099-01-01T00:00:00.000Z",
      request: command,
      identity: preview.identity,
      financialBasisDigest: hash,
      retentionNoticeDigest: hash,
      basis: {
        model: command.model,
        destination: "https://api.openai.com/v1/responses",
        store: false,
        maxCalls: 1,
        automaticRetryLimit: 0,
        notice: { text: "합성 전송 안내. 실제 AI 호출 없이 화면만 검증합니다." },
        sources: [source],
      },
    },
    reservation: {
      financialBasis: {
        basisDigest: hash,
        model: command.model,
        costs: {
          currency: "USD",
          unitScale: 6,
          inputUnits: "1000",
          outputUnits: "250",
          reservedUnits: "1250",
        },
        evidence: { sources: [source] },
      },
      retentionNotice: {
        localNotice: "합성 로컬 보관 안내",
        providerNotice: "합성 공급자 보관 안내",
      },
      retentionNoticeDigest: hash,
    },
  };
  return { company: f.company, preview, session, status, prepared };
}

export function comparisonBookingFixture() {
  const f = comparisonExecutionFixture(),
    request = f.preview.command;
  const review = {
    reviewDigest: "a".repeat(64),
    inspectedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    companyId: f.company.id,
    companyRevision: f.company.revision,
    request,
    identity: f.preview.identity,
    budget: { currency: "USD", unitScale: 6, availableUnits: "100000", heldUnits: "0" },
    costs: f.prepared.reservation.financialBasis.costs,
    notice: "합성 예약 검토입니다. 실제 요금·정책 근거가 아닙니다.",
    retention: f.prepared.reservation.retentionNotice,
    sources: f.prepared.review.basis.sources,
  };
  const receipt = {
    kind: "comparison-reservation-receipt" as const,
    companyId: f.company.id,
    companyRevision: f.company.revision,
    clientRequestId: randomUUID(),
    runId: randomUUID(),
    reviewDigest: review.reviewDigest,
    commandDigest: "b".repeat(64),
    recordDigest: "c".repeat(64),
    recordedAt: "2026-10-14T09:00:00.000Z",
    acknowledgedReservationOnly: true as const,
    transmissionAllowed: false as const,
    transmissionConsentRecorded: false as const,
    runtimeObserved: false as const,
  };
  const state = {
    kind: "comparison-booking-state" as const,
    registrationId: randomUUID(),
    selection: request.selection,
    source: "comparison-reservation-booking" as const,
    status: "unused" as const,
    revoked: false,
    retained: false,
    clientRequestId: null,
    runId: null,
    receipt: null,
    transmissionAllowed: false as const,
    runtimeObserved: false as const,
    review: null,
  };
  const rawReview = {
    ...review,
    financialBasis: { costs: review.costs, evidence: { sources: review.sources } },
    retentionNotice: review.retention,
    notice: { text: review.notice },
  };
  return { ...f, review, receipt, booking: state, rawReview };
}

export function comparisonCancellationFixture() {
  const f = comparisonExecutionFixture();
  const selection = {
    companyId: f.company.id,
    companyRevision: f.company.revision,
    runId: f.session.runId,
  };
  const review = {
    ...selection,
    reviewDigest: "a".repeat(64),
    reservationCompanyRevision: f.company.revision - 1,
    model: "synthetic-model",
    sectionTitle: "합성 취소 검토",
    currency: "USD",
    unitScale: 6,
    releasedUnits: "1250",
    inspectedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    notice: "합성 취소 검증입니다. 기록은 보존하며 실제 청구 환불이 아닙니다.",
  };
  const receipt = {
    ...selection,
    clientRequestId: randomUUID(),
    reviewDigest: review.reviewDigest,
    commandDigest: "b".repeat(64),
    recordDigest: "c".repeat(64),
    recordedAt: "2026-10-14T09:40:00.000Z",
    currency: "USD",
    unitScale: 6,
    releasedUnits: "1250",
    cancelled: true as const,
    finalized: true as const,
    transmissionAllowed: false as const,
    refundVerified: false as const,
  };
  const cancellation = {
    kind: "comparison-cancellation-state" as const,
    registrationId: randomUUID(),
    selection,
    status: "unused" as const,
    revoked: false,
    retained: false,
    clientRequestId: null,
    receipt: null,
    review: null,
    transmissionAllowed: false as const,
    runtimeObserved: false as const,
  };
  return { ...f, cancellation, cancellationReview: review, cancellationReceipt: receipt };
}
