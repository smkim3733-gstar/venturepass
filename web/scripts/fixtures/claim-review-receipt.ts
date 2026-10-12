import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  claimReviewInputSchema,
  claimReviewRecordSchema,
  type ClaimReviewInput,
} from "../../src/lib/studio-claim-review-types";
import { numericReceiptFixture, agencyId } from "./numeric-check-receipt";
export { agencyId };
export function claimReceiptResult(
  base: StudioCase,
  raw: ClaimReviewInput,
  nonce: string,
  id = agencyId(311),
) {
  const input = claimReviewInputSchema.parse(raw),
    company = structuredClone(base);
  const prior = company.claimReviews.find((r) => r.id === input.previousVersionId),
    plan = company.plans.find((p) => p.id === input.planId)!;
  const recordedAt = "2026-10-12T04:15:00.000Z";
  company.claimReviews.push(
    claimReviewRecordSchema.parse({
      ...input,
      id,
      claimId: input.claimId ?? id,
      version: (prior?.version ?? 0) + 1,
      clientRequestId: nonce,
      inputDigest: "c".repeat(64),
      origin: "manual",
      recordedAt,
      sourceSnapshots: [],
      planSnapshots: [{ planId: plan.id, version: plan.version, contentSha256: "b".repeat(64) }],
      auxiliarySnapshots: input.numericReferences.map((ref) => {
        const record = company.numericChecks.find((r) => r.id === ref.id)!;
        return {
          kind: "numeric",
          id: ref.id,
          version: ref.version,
          inputDigest: record.inputDigest,
          recordedAt: record.recordedAt,
          contentSha256: "d".repeat(64),
        };
      }),
      judgement: {
        ...input.judgement,
        recordedAt: input.judgement.state === "unreviewed" ? null : recordedAt,
      },
    }),
  );
  company.revision++;
  return caseSchema.parse(company);
}
export function claimReceiptFixture() {
  let company = numericReceiptFixture().saved;
  company.profile.companyName = "합성 주장 검토 저장 기업";
  company.claimReviews = [];
  const plan = company.plans.at(-1)!;
  const initial = claimReviewInputSchema.parse({
    claimId: null,
    previousVersionId: null,
    planId: plan.id,
    planVersion: plan.version,
    sectionKey: plan.content.sections[0].key,
    claimQuote: "이전 수량 10개, 20개, 합계 30개.",
    nature: "unknown",
    references: [],
    contextNote: "이전 해석 메모",
    owner: "이전 담당자",
    dueOn: "",
    nextCheck: "이전 확인 사항",
    method: "unreviewed",
    externalCheck: { target: "", content: "", occurredOn: "" },
    judgement: { state: "unreviewed", reviewer: "", reason: "", checkedOn: "" },
    numericReferences: [],
    planReviewReferences: [],
  });
  company = claimReceiptResult(company, initial, agencyId(307), agencyId(306));
  const raw = {
    claimQuote: "새 수량 1,200.50개, 2,300.25개, 합계 3,500.75개.",
    contextNote: "  새 범위 해석\n기간과 수량의 확인 범위  ",
    owner: "  새 확인 담당자  ",
    dueOn: "2026-11-03",
    nextCheck: "  추가 증빙 확인\n담당자 후속 사항  ",
    target: "  합성 확인 대상  ",
    content: "  합성 담당자 수기 내용\n추가 확인 필요  ",
    occurredOn: "2026-10-11",
    reviewer: "  새 판단자  ",
    reason: "  합성 근거 부족 판단\n추가 설명 요청  ",
    checkedOn: "2026-10-12",
  };
  const input = claimReviewInputSchema.parse({
    ...initial,
    claimId: agencyId(306),
    previousVersionId: agencyId(306),
    claimQuote: raw.claimQuote,
    nature: "assumption",
    contextNote: raw.contextNote,
    owner: raw.owner,
    dueOn: raw.dueOn,
    nextCheck: raw.nextCheck,
    method: "multiple",
    externalCheck: { target: raw.target, content: raw.content, occurredOn: raw.occurredOn },
    numericReferences: company.numericChecks.map((r) => ({ id: r.id, version: r.version })),
    judgement: {
      state: "insufficient",
      reviewer: raw.reviewer,
      reason: raw.reason,
      checkedOn: raw.checkedOn,
    },
  });
  const nonce = agencyId(310);
  return {
    company: caseSchema.parse(company),
    initial,
    raw,
    input,
    nonce,
    saved: claimReceiptResult(company, input, nonce),
  };
}
