import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  visitAnswerInputSchema,
  visitAnswerSchema,
  buildVisitAnswerChecks,
  type VisitAnswerInput,
} from "../../src/lib/studio-visit-answer-types";
import { workflowTaskFixture, agencyId } from "./workflow-task-receipt";
export { agencyId };
export function visitReceiptResult(
  base: StudioCase,
  raw: VisitAnswerInput,
  nonce: string,
  id = agencyId(91),
) {
  const input = visitAnswerInputSchema.parse(raw);
  const company = structuredClone(base);
  const plan = company.plans.find((p) => p.id === input.planId)!;
  const previous = company.visitAnswers.find((r) => r.id === input.previousVersionId);
  const recordedAt = "2026-10-12T03:05:00.000Z";
  company.visitAnswers.push(
    visitAnswerSchema.parse({
      ...input,
      id,
      answerId: input.answerId ?? id,
      version: (previous?.version ?? 0) + 1,
      clientRequestId: nonce,
      inputDigest: "a".repeat(64),
      origin: "manual",
      recordedAt,
      questionSnapshot: {
        planId: plan.id,
        planVersion: plan.version,
        planTitle: plan.content.title,
        planContentSha256: "b".repeat(64),
        questionIndex: input.questionIndex,
        questionText: input.questionText,
        questionSha256: "c".repeat(64),
      },
      submissionSnapshot: null,
      sourceSnapshots: [],
      checkVersion: "paired-spelling-v1",
      checks: buildVisitAnswerChecks(input),
      review: {
        reviewedAt: input.review.reviewed ? recordedAt : null,
        reviewer: input.review.reviewer,
        note: input.review.note,
      },
    }),
  );
  company.revision++;
  return caseSchema.parse(company);
}
export function visitReceiptFixture() {
  let company = workflowTaskFixture().company;
  company.profile.companyName = "합성 실사 답변 저장 기업";
  company.visitAnswers = [];
  const plan = company.plans.at(-1)!;
  plan.content.interviewQuestions = ["기술을 어떻게 설명하나요?", "기술을 어떻게 설명하나요?"];
  const initial = visitAnswerInputSchema.parse({
    answerId: null,
    previousVersionId: null,
    planId: plan.id,
    questionIndex: 1,
    questionText: plan.content.interviewQuestions[1],
    submissionRecordId: null,
    respondentRole: "representative",
    respondentName: "이전 응답자",
    answerText: "이전 모의 답변",
    pairs: [0, 1].map((i) => ({
      id: agencyId(82 + i),
      answerQuote: "이전 모의 답변",
      planReference: {
        sectionKey: plan.content.sections[0].key,
        quote: plan.content.sections[0].content,
      },
      sources: [],
      contextNote: `이전 대조 ${i + 1}`,
    })),
    followUpNote: "이전 후속 확인",
    review: { reviewed: false, reviewer: "", note: "" },
  });
  company = visitReceiptResult(company, initial, agencyId(80), agencyId(81));
  const prior = company.visitAnswers[0];
  const raw = {
    respondentName: "  새 응답자  ",
    answerText: "  새 모의 답변\n확인할 사실  ",
    followUpNote: "  추가 확인\n다음 줄  ",
    reviewer: "  새 검토자  ",
    reviewNote: "  검토 메모\n다음 줄  ",
  };
  const input = visitAnswerInputSchema.parse({
    ...initial,
    answerId: prior.answerId,
    previousVersionId: prior.id,
    respondentRole: "technical",
    respondentName: raw.respondentName,
    answerText: raw.answerText,
    followUpNote: raw.followUpNote,
    pairs: prior.pairs.map((p, i) => ({
      ...p,
      answerQuote: "새 모의 답변",
      contextNote: `새 대조 ${i + 1}`,
    })),
    review: { reviewed: true, reviewer: raw.reviewer, note: raw.reviewNote },
  });
  const nonce = agencyId(90);
  return { company, raw, input, nonce, saved: visitReceiptResult(company, input, nonce) };
}
