import { caseSchema } from "../../src/lib/studio-schema";
import { answerWorkflowCompany, answerWorkflowSource } from "./guided-answer-workflow";
/** Synthetic state AFTER adoption, matching appendManualPlan and evidence invalidation.
 * It does not execute or assert the adoption writer or represent a real AI response. */
export function reviewLinkCompany() {
  const company = answerWorkflowCompany();
  const original = company.plans[0];
  const plan = structuredClone(original);
  plan.id = "a0000000-0000-4000-8000-000000000002";
  plan.version = 2;
  plan.mode = "manual";
  plan.generatedAt = "2026-10-09T00:02:00.000Z";
  plan.content.sections[1].content = "외부 시험은 계획 단계입니다. 보완 답변을 반영한 문장입니다.";
  plan.content.sections.forEach((section) => {
    section.needsConfirmation = false;
  });
  plan.review = [
    {
      id: "info-0",
      severity: "info",
      category: "general",
      message: "참고 정보",
      action: "참고만",
      sectionKey: null,
      sourceIds: [],
    },
    {
      id: "error-1",
      severity: "error",
      category: "confirmation",
      message: "동일한 근거 대조 의견",
      action: "첫 번째 원래 근거를 대조하세요",
      sectionKey: "development",
      sourceIds: [],
    },
    {
      id: "warning-2",
      severity: "warning",
      category: "evidence",
      message: "동일한 근거 대조 의견",
      action: "두 번째 원래 근거를 대조하세요",
      sectionKey: "development",
      sourceIds: [],
    },
  ];
  return caseSchema.parse({
    ...company,
    revision: 6,
    sources: [answerWorkflowSource()],
    plans: [original, plan],
    guidedPreparationRuns: [
      {
        id: "d0000000-0000-4000-8000-000000000001",
        mode: "ai",
        approval: {
          caseId: company.id,
          revision: 2,
          provider: "OpenAI",
          model: "synthetic-disabled",
          inputFingerprint: "a".repeat(64),
          sourceIds: [],
          sourceNames: [],
          profileIncluded: true,
          businessNumberIncluded: false,
          originalFilesIncluded: false,
          derivedDraftIncluded: true,
          purpose: "analysis-plan-review",
        },
        approvedAt: original.generatedAt,
        status: "awaiting_review",
        phase: "plan",
        analysisDigest: "a".repeat(64),
        candidateId: original.candidateId,
        candidateDigest: "a".repeat(64),
        planId: original.id,
        code: null,
        requests: [
          { clientRequestId: "e0000000-0000-4000-8000-000000000001", digest: "a".repeat(64) },
        ],
        createdAt: original.generatedAt,
        updatedAt: original.generatedAt,
      },
    ],
  });
}
