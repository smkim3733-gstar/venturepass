// Pure memory state: no analyzer, store, SDK or original-file reads.
import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import { generatedPlanReceiptFixture } from "./generated-plan-receipt";
export function analysisResultReceiptFixture() {
  const { company } = generatedPlanReceiptFixture();
  company.profile.companyName = "합성 아이템 재분석 확인 기업";
  company.analysis!.summary = "  기존 합성 분석\n보존할 선택 근거입니다.  ";
  company.plans[0].confirmedAt = company.updatedAt;
  company.sources = [0, 1].map((index) => ({
    id: `00000000-0000-4000-8000-00000000010${index}`,
    name: `합성 분석 자료 ${index + 1}`,
    kind: "technology" as const,
    text: `  합성 기술 자료 ${index + 1}\n원문을 보존합니다.  `,
    originalName: null,
    mimeType: null,
    extraction: "manual" as const,
    warnings: ["합성 자료이며 원본 검증 전입니다."],
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
  }));
  return { company: caseSchema.parse(company) };
}
export function analysisResultReceiptResult(
  company: StudioCase,
  mode: "ai" | "assisted" = "assisted",
) {
  const next = structuredClone(company);
  next.revision++;
  next.updatedAt = "2026-10-12T08:31:00.000Z";
  const basis = company.analysis?.candidates[0] ?? {
    id: "synthetic",
    title: "",
    problem: "",
    solution: "",
    targetCustomer: "",
    differentiation: "",
    stage: "",
    businessModel: "",
    recommendation: "",
    evidence: [],
    gaps: [],
  };
  next.analysis = {
    summary: "  합성 재분석 요약\n두 후보를 다시 검토해야 합니다.  ",
    mode,
    sourceRevision: company.revision,
    generatedAt: next.updatedAt,
    candidates: [
      {
        ...structuredClone(basis),
        title: "합성 재분석 후보 하나",
        recommendation: "  첫 후보의 합성 추천 이유\n담당자 확인 전입니다.  ",
      },
      {
        ...structuredClone(basis),
        id: "synthetic-second",
        title: "합성 재분석 후보 둘",
        solution: "  두 번째 후보의 합성 기술\n추가 검증 전입니다.  ",
        gaps: ["합성 시험 근거를 확인하세요."],
      },
    ],
    facts: [
      {
        id: "synthetic-fact",
        statement: "합성 기술 설명은 담당자 확인 전입니다.",
        status: "unverified",
        evidence: [],
      },
    ],
    questions: [
      {
        id: "synthetic-question",
        question: "합성 시험 결과를 확인했나요?",
        reason: "실제 근거는 아직 검토 전입니다.",
        priority: "high",
      },
    ],
    warnings: ["합성 분석은 사실 확인이나 기관 판단이 아닙니다."],
  };
  next.selectedCandidateId = null;
  next.plans = next.plans.map((p) => ({ ...p, confirmedAt: null }));
  return caseSchema.parse(next);
}
