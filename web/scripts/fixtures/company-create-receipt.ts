import { caseSchema, companyProfileSchema, emptyProfile, type CompanyProfile } from "../../src/lib/studio-schema";
import { answerWorkflowCompany } from "./guided-answer-workflow";
export function companyCreateFixture() {
  const existing = answerWorkflowCompany();
  existing.profile.companyName = "기존 보존 기업";
  const profile: CompanyProfile = { ...emptyProfile(), companyName: "새 합성 준비 기업", industry: "합성 소프트웨어 개발", applicationKind: "renewal" };
  return { existing, profile, id: "d0000000-0000-4000-8000-000000000009" };
}
export function companyCreateResult(profile: CompanyProfile, id: string) {
  const at="2026-10-12T06:10:00.000Z";
  return caseSchema.parse({ id, profile: companyProfileSchema.parse(profile), sources: [], analysis: null, selectedCandidateId: null, plans: [], tasks: [], stage: "preparing", revision: 0, createdAt: at, updatedAt: at, applicationCriteriaContexts: [] });
}
