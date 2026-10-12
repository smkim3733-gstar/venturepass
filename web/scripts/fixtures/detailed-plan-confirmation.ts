import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import { confirmationCompany } from "./guided-plan-confirmation";
export function detailedPlanConfirmationFixture() {
  const company = confirmationCompany();
  company.profile.companyName = "합성 상세 원고 검토 확인 기업";
  company.plans.forEach((p) => {
    p.content.summary = `  버전 ${p.version}의 원래 요약\n추가 확인 기록입니다.  `;
    p.content.sections.push({
      key: "development",
      title: "기술 개발",
      content: `  버전 ${p.version}의 개발 본문\n보관할 원문입니다.  `,
      evidence: [],
      needsConfirmation: false,
    });
  });
  return { company: caseSchema.parse(company) };
}
export function detailedPlanConfirmationResult(company: StudioCase, planId: string) {
  const next = structuredClone(company);
  const plan = next.plans.find((p) => p.id === planId);
  if (!plan) throw new Error("Synthetic target missing");
  next.revision++;
  next.updatedAt = "2026-10-12T07:52:00.000Z";
  plan.confirmedAt = next.updatedAt;
  plan.review = [
    {
      id: "synthetic-warning",
      severity: "warning",
      category: "quality",
      message: "합성 내부 검토 경고",
      action: "추가 자료를 확인하세요.",
      sectionKey: null,
      sourceIds: [],
    },
  ];
  return caseSchema.parse(next);
}
