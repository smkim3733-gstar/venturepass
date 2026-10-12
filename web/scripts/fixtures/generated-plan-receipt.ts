// Memory-only results; no generation engine, writer, original files or services.
import { randomUUID } from "node:crypto";
import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import { detailedPlanConfirmationFixture } from "./detailed-plan-confirmation";
export function generatedPlanReceiptFixture() {
  const { company } = detailedPlanConfirmationFixture();
  company.profile.companyName = "합성 새 원고 작성 확인 기업";
  company.stage = "drafting";
  company.plans[1].version = 3;
  return { company: caseSchema.parse(company) };
}
export function generatedPlanReceiptResult(
  company: StudioCase,
  mode: "ai" | "assisted" = "assisted",
) {
  const next = structuredClone(company);
  next.revision++;
  next.updatedAt = "2026-10-12T08:10:00.000Z";
  next.plans.push({
    id: randomUUID(),
    version: Math.max(0, ...company.plans.map((p) => p.version)) + 1,
    mode,
    candidateId: company.selectedCandidateId!,
    sourceRevision: company.revision,
    generatedAt: next.updatedAt,
    confirmedAt: null,
    content: {
      title: "합성 자료 기반 새 원고",
      summary: "  합성 수량과 계획을 정리했습니다.\n담당자 확인 전입니다.  ",
      sections: [
        {
          key: "problem",
          title: "고객의 문제",
          content: "  합성 문제의 초안\n근거를 확인해 주세요.  ",
          evidence: [],
          needsConfirmation: true,
        },
        {
          key: "development",
          title: "기술 개발",
          content: "  합성 개발 계획 1,200개\n아직 확인하지 않은 내용입니다.  ",
          evidence: [],
          needsConfirmation: true,
        },
      ],
      actionItems: ["합성 근거 확인"],
      interviewQuestions: ["합성 계획의 근거는 무엇인가요?"],
    },
    review: [
      {
        id: "synthetic-warning",
        severity: "warning",
        category: "quality",
        message: "합성 초안은 검토 전입니다.",
        action: "담당자가 확인하세요.",
        sectionKey: null,
        sourceIds: [],
      },
    ],
  });
  return caseSchema.parse(next);
}
