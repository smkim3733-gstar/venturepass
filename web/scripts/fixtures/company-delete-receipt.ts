import { answerWorkflowCompany } from "./guided-answer-workflow";

export function companyDeleteFixture() {
  const target = answerWorkflowCompany();
  target.profile.companyName = "삭제 대상 합성 기업";
  const retained = structuredClone(target);
  retained.id = "d0000000-0000-4000-8000-000000000017";
  retained.profile.companyName = "보존할 합성 기업";
  retained.profile.industry = "보존할 합성 업종";
  return { target, retained };
}
