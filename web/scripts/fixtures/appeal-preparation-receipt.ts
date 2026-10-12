import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  appealPreparationInputSchema,
  appealPreparationSchema,
  type AppealPreparationInput,
} from "../../src/lib/studio-appeal-types";
import type { AgencyNoticeRecord } from "../../src/lib/studio-agency-records";
import { workflowTaskFixture, agencyId } from "./workflow-task-receipt";
export { agencyId };
export function appealReceiptResult(
  base: StudioCase,
  raw: AppealPreparationInput,
  nonce: string,
  id = agencyId(191),
) {
  const input = appealPreparationInputSchema.parse(raw);
  const company = structuredClone(base);
  const previous = company.appealPreparations.find((r) => r.id === input.previousVersionId);
  const recordedAt = "2026-10-12T03:35:00.000Z";
  const planIds = [
    ...new Set(input.reasons.flatMap((r) => (r.planClaim ? [r.planClaim.planId] : []))),
  ];
  company.appealPreparations.push(
    appealPreparationSchema.parse({
      ...input,
      id,
      preparationId: input.preparationId ?? id,
      version: (previous?.version ?? 0) + 1,
      clientRequestId: nonce,
      inputDigest: "a".repeat(64),
      origin: "manual",
      recordedAt,
      review: {
        reviewedAt: input.review.reviewed ? recordedAt : null,
        reviewer: input.review.reviewer,
        note: input.review.note,
      },
      sourceSnapshots: [],
      planSnapshots: planIds.map((planId) => ({
        planId,
        version: company.plans.find((p) => p.id === planId)!.version,
        contentSha256: "b".repeat(64),
      })),
    }),
  );
  company.revision++;
  return caseSchema.parse(company);
}
export function appealReceiptFixture() {
  let company = workflowTaskFixture().company;
  company.profile.companyName = "합성 소명 준비 저장 기업";
  company.appealPreparations = [];
  const notice: AgencyNoticeRecord = {
    id: agencyId(170),
    noticeRecordId: agencyId(170),
    previousVersionId: null,
    version: 1,
    clientRequestId: agencyId(171),
    inputDigest: "c".repeat(64),
    kind: "notice",
    origin: "manual",
    recordedAt: "2026-10-10T00:00:00.000Z",
    institution: "합성 기관",
    title: "합성 결과 통보",
    body: "합성 결과 원문",
    occurredOn: "",
    note: "",
    evidence: [],
    details: {
      category: "decision",
      decisionText: "담당자 수기 통보",
      notifiedOn: "",
      reasons: "기술 설명 부족\n실적 근거 부족",
    },
  };
  company.agencyRecords.push(notice);
  const plan = company.plans.at(-1)!,
    section = plan.content.sections[0];
  const initial = appealPreparationInputSchema.parse({
    preparationId: null,
    previousVersionId: null,
    noticeRecordId: notice.id,
    noticeVersionId: notice.id,
    title: "이전 소명 준비",
    intent: "undecided",
    intentNote: "이전 판단",
    deadlineOn: "",
    deadlineNote: "",
    reasons: ["기술 설명 부족", "실적 근거 부족"].map((quote, i) => ({
      id: agencyId(182 + i),
      noticeField: "reasons",
      noticeQuote: quote,
      claim: `이전 주장 ${i + 1}`,
      planClaim: { planId: plan.id, sectionKey: section.key, quote: section.content },
      gap: "이전 보강 사항",
      evidence: [],
      additionalEvidence: [],
      draft: `이전 소명 ${i + 1}`,
    })),
    review: { reviewed: false, reviewer: "", note: "" },
  });
  company = appealReceiptResult(company, initial, agencyId(180), agencyId(181));
  const corrected: AgencyNoticeRecord = {
    ...structuredClone(notice),
    id: agencyId(172),
    kind: "notice-correction",
    previousVersionId: notice.id,
    version: 2,
    clientRequestId: agencyId(173),
    body: "정정된 합성 결과 원문",
  };
  company.agencyRecords.push(corrected);
  const raw = {
    title: "  새 소명 준비  ",
    intentNote: "  현재 진행하지 않는 이유\n추후 확인  ",
    deadlineOn: "2026-11-03",
    deadlineNote: "  담당자가 확인한 안내\n기한 근거  ",
    reviewer: "  새 검토자  ",
    reviewNote: "  내부 검토 메모\n둘째 줄  ",
    reasons: [0, 1].map((i) => ({
      claim: `  새 주장 ${i + 1}\n설명  `,
      gap: `  새 보강 ${i + 1}\n확인할 자료  `,
      draft: `  새 소명 ${i + 1}\n초안 둘째 줄  `,
    })),
  };
  const input = appealPreparationInputSchema.parse({
    ...initial,
    preparationId: agencyId(181),
    previousVersionId: agencyId(181),
    noticeVersionId: corrected.id,
    title: raw.title,
    intent: "not-pursuing",
    intentNote: raw.intentNote,
    deadlineOn: raw.deadlineOn,
    deadlineNote: raw.deadlineNote,
    reasons: initial.reasons.map((reason, i) => ({ ...reason, ...raw.reasons[i] })),
    review: { reviewed: true, reviewer: raw.reviewer, note: raw.reviewNote },
  });
  const nonce = agencyId(190);
  return {
    company: caseSchema.parse(company),
    raw,
    input,
    nonce,
    saved: appealReceiptResult(company, input, nonce),
  };
}
