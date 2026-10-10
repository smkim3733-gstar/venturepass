import { caseSchema, companyProfileSchema } from "../../src/lib/studio-schema";
import { workflowTaskFixture } from "./workflow-task-receipt";
export function profileReceiptFixture() {
  const company = workflowTaskFixture().company;
  company.profile.companyName = "합성 상세 기업정보 기업";
  const request = {
    action: "profile" as const,
    revision: company.revision,
    profile: companyProfileSchema.parse({
      ...company.profile,
      companyName: "합성 상세 정보 수정 기업",
      businessNumber: "합성 등록번호",
      industry: "합성 설비 제조",
      foundedOn: "2018-05-01",
      paidInCapital: "15000000",
      closingMonth: "12",
      applicationDate: "2026-10-10",
      applicationKind: "renewal",
      technologySummary: "  합성 기술 설명\n기술 둘째 줄  ",
      customers: "  합성 고객 설명\n고객 둘째 줄  ",
      team: "합성 담당 인력",
      financials: "합성 재무 설명",
      developmentPlan: "합성 향후 계획",
      patents: "합성 지식재산 설명",
    }),
  };
  const saved = structuredClone(company);
  saved.profile = structuredClone(request.profile);
  saved.revision++;
  // Reflect existing evidence invalidation in memory; no storage/writer is imported.
  saved.analysis = null;
  saved.selectedCandidateId = null;
  saved.plans = saved.plans.map((plan) => ({ ...plan, confirmedAt: null }));
  for (const key of ["sme", "industryEligibility"] as const)
    saved.diagnosisAnswers[key] = {
      ...saved.diagnosisAnswers[key],
      status: "unknown",
      reviewed: false,
    };
  return { company: caseSchema.parse(company), request, saved: caseSchema.parse(saved) };
}
