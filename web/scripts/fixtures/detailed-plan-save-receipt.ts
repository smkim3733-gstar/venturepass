import {
  caseSchema,
  planContentSchema,
  type StudioCase,
  type PlanContent,
} from "../../src/lib/studio-schema";
import { answerWorkflowCompany } from "./guided-answer-workflow";
export const planSaveId = (n: number) =>
  `${String(n).padStart(8, "0")}-6666-4666-8666-666666666666`;
export function detailedPlanSaveFixture() {
  const company = answerWorkflowCompany();
  company.profile.companyName = "합성 원고 수정본 확인 기업";
  company.stage = "drafting";
  const old = company.plans[0];
  old.content.actionItems = ["원래 보강 과제"];
  const latest = structuredClone(old);
  latest.id = planSaveId(3);
  latest.version = 3;
  latest.content.title = "이전 최신 원고 제목";
  latest.content.summary = "이전 최신 원고 요약을 보존합니다.";
  latest.content.sections[1].content = "이전 최신 원고의 개발 본문입니다.";
  company.plans.push(latest);
  const content = structuredClone(old.content);
  content.title = "  사용자가 고친 원고 제목  ";
  content.summary = "  고객 문제를 직접 정리했습니다.\n수량은 추가 확인이 필요합니다.  ";
  content.sections[0].title = "  수정한 고객 문제  ";
  content.sections[0].content =
    "  현장 고객의 작업 시간을 확인할 계획입니다.\n합성 계획 수량 1,200개입니다.  ";
  content.sections[0].needsConfirmation = false;
  content.sections[1].title = "  수정한 기술 개발  ";
  content.sections[1].content =
    "  내부 시험 설명을 수정했습니다.\n외부 시험은 아직 미확인입니다.  ";
  content.sections[1].needsConfirmation = true;
  content.actionItems[0] = "  추가 시험 자료 확보\n담당자는 미정입니다.  ";
  content.interviewQuestions[1] = "  외부 시험 계획을 누가 확인하나요?  ";
  return { company: caseSchema.parse(company), content, planId: old.id, savedId: planSaveId(4) };
}
export function detailedPlanSaveResult(company: StudioCase, planId: string, content: PlanContent) {
  const next = structuredClone(company);
  const target = next.plans.find((p) => p.id === planId);
  if (!target) throw new Error("Synthetic manuscript missing");
  const now = "2026-10-12T07:30:00.000Z";
  next.plans.push({
    ...structuredClone(target),
    id: planSaveId(4),
    version: Math.max(...next.plans.map((p) => p.version)) + 1,
    generatedAt: now,
    mode: "manual",
    content: planContentSchema.parse(content),
    confirmedAt: null,
    review: [],
  });
  next.revision++;
  next.updatedAt = now;
  return caseSchema.parse(next);
}
