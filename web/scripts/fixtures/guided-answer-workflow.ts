import { caseSchema, emptyProfile, type SourceDocument } from "../../src/lib/studio-schema";
export const answerQuestion = "외부 성능 시험은 어느 단계인가요?";
export function answerWorkflowCompany() {
  return caseSchema.parse({
    id: "c0000000-0000-4000-8000-000000000001",
    profile: {
      ...emptyProfile(),
      companyName: "합성 답변 연결 기업",
      technologySummary: "합성 센서의 상태를 확인하는 기술",
    },
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "preparing",
    revision: 4,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    plans: [
      {
        id: "a0000000-0000-4000-8000-000000000001",
        version: 1,
        generatedAt: "2026-10-09T00:00:00.000Z",
        mode: "ai",
        candidateId: "synthetic",
        sourceRevision: 2,
        confirmedAt: null,
        review: [],
        content: {
          title: "합성 센서 사업계획서",
          summary: "사용자가 작성한 요약을 보존합니다.",
          sections: [
            {
              key: "problem",
              title: "고객의 문제",
              content: "다른 항목의 사용자 문장을 보존합니다.",
              evidence: [],
              needsConfirmation: false,
            },
            {
              key: "development",
              title: "기술 개발",
              content: "내부 시험을 진행했습니다. 외부 시험 여부는 확인이 필요합니다.",
              evidence: [],
              needsConfirmation: true,
            },
          ],
          actionItems: [],
          interviewQuestions: ["고객은 누구인가요?", answerQuestion],
        },
      },
    ],
  });
}
export function answerWorkflowSource(): SourceDocument {
  return {
    id: "b0000000-0000-4000-8000-000000000001",
    name: "사업계획서 준비 답변",
    kind: "consultation",
    text: "외부 시험은 아직 계획 단계입니다.",
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: "2026-10-09T00:01:00.000Z",
    updatedAt: "2026-10-09T00:01:00.000Z",
  };
}
