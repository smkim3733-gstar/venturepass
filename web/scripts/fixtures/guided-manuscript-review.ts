import { caseSchema } from "../../src/lib/studio-schema";
import { answerWorkflowCompany, answerWorkflowSource } from "./guided-answer-workflow";
import { exportPlanDocx, PLAN_DOCX_MIME } from "../../src/lib/studio-export-docx";
import JSZip from "jszip";
export { exportPlanDocx, PLAN_DOCX_MIME };
export async function documentXml(bytes: Uint8Array) {
  return (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
}
/** Synthetic state AFTER adoption, matching appendManualPlan and evidence invalidation.
 * It does not execute or assert the adoption writer or represent a real AI response. */
export function manuscriptReviewCompany() {
  const company = answerWorkflowCompany();
  const original = company.plans[0];
  const plan = structuredClone(original);
  plan.id = "a0000000-0000-4000-8000-000000000002";
  plan.version = 2;
  plan.mode = "manual";
  plan.generatedAt = "2026-10-09T00:02:00.000Z";
  plan.content.sections[1].content = "외부 시험은 계획 단계입니다. 보완 답변을 반영한 문장입니다.";
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
