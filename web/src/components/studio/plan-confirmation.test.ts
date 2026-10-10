import { describe, expect, it } from "vitest";
import { confirmationCompany } from "../../../scripts/fixtures/guided-plan-confirmation";
import { planConfirmationSnapshot, type PlanConfirmation } from "./plan-confirmation";

function fixture() {
  const company = confirmationCompany();
  const pending: PlanConfirmation = { company, planId: company.plans[1].id };
  const next = structuredClone(company);
  next.revision++;
  next.plans[1].confirmedAt = "2026-10-10T01:00:00.000Z";
  return { pending, next };
}
describe("선택한 원고의 검토 완료 응답", () => {
  it("정확한 같은 원고의 완료와 이전 원고 보존을 확인한다", () => {
    const { pending, next } = fixture();
    expect(planConfirmationSnapshot(next, pending)).toEqual(next);
    expect(pending.company.plans[1].confirmedAt).toBeNull();
  });
  it("재검토에서 생긴 경고는 허용하되 본문과 확인 상태는 바꾸지 않는다", () => {
    const { pending, next } = fixture();
    next.plans[1].review = [
      {
        id: "synthetic-review",
        action: "합성 조치",
        sourceIds: [],
        severity: "warning",
        category: "quality",
        message: "합성 경고",
        sectionKey: null,
      },
    ];
    expect(planConfirmationSnapshot(next, pending)).toEqual(next);
  });
  it.each([
    "형식",
    "다른 회사",
    "같은 revision",
    "옛 revision",
    "완료 누락",
    "잘못된 완료 시각",
    "다른 제목",
    "다른 요약",
    "다른 본문",
    "다른 근거",
    "항목 미확인",
    "빈 항목",
    "검토 오류",
    "확인 의견",
    "이전 원고 변경",
    "원고 누락",
    "다른 대상",
    "새 원고",
    "ID 중복",
    "버전 중복",
    "회사 설명 변경",
    "자료 변경",
    "분석 변경",
    "주제 변경",
    "선택 이력 변경",
    "다른 생성 방식",
    "다른 근거 revision",
  ])("%s를 완료로 수락하지 않는다", (kind) => {
    const { pending, next } = fixture();
    const plan = next.plans[1];
    switch (kind) {
      case "형식":
        expect(() => planConfirmationSnapshot({ success: true }, pending)).toThrow();
        return;
      case "다른 회사":
        next.id = "99999999-9999-4999-8999-999999999999";
        break;
      case "같은 revision":
        next.revision = pending.company.revision;
        break;
      case "옛 revision":
        next.revision = 1;
        break;
      case "완료 누락":
        plan.confirmedAt = null;
        break;
      case "잘못된 완료 시각":
        plan.confirmedAt = "wrong";
        break;
      case "다른 제목":
        plan.content.title += " 변경";
        break;
      case "다른 요약":
        plan.content.summary += " 변경";
        break;
      case "다른 본문":
        plan.content.sections[0].content += " 변경";
        break;
      case "다른 근거":
        plan.content.sections[0].evidence.push({
          sourceId: "synthetic",
          quote: "다른 근거",
          locator: "합성",
        });
        break;
      case "항목 미확인":
        plan.content.sections[0].needsConfirmation = true;
        break;
      case "빈 항목":
        plan.content.sections = [];
        break;
      case "검토 오류":
        plan.review = [
          {
            id: "synthetic-review",
            action: "합성 조치",
            sourceIds: [],
            severity: "error",
            category: "quality",
            message: "합성 오류",
            sectionKey: null,
          },
        ];
        break;
      case "확인 의견":
        plan.review = [
          {
            id: "synthetic-review",
            action: "합성 조치",
            sourceIds: [],
            severity: "warning",
            category: "confirmation",
            message: "합성 확인",
            sectionKey: null,
          },
        ];
        break;
      case "이전 원고 변경":
        next.plans[0].content.summary += " 변경";
        break;
      case "원고 누락":
        next.plans.shift();
        break;
      case "다른 대상":
        plan.id = "99999999-9999-4999-8999-999999999999";
        break;
      case "새 원고":
        next.plans.push({
          ...structuredClone(plan),
          id: "99999999-9999-4999-8999-999999999999",
          version: 3,
        });
        break;
      case "ID 중복":
        next.plans[0].id = plan.id;
        break;
      case "버전 중복":
        next.plans[0].version = plan.version;
        break;
      case "회사 설명 변경":
        next.profile.technologySummary = "다른 설명";
        break;
      case "자료 변경":
        next.sources.push({
          id: "99999999-9999-4999-8999-999999999999",
          kind: "other",
          name: "합성 자료",
          text: "다른 자료",
          mimeType: "text/plain",
          originalName: null,
          extraction: "manual",
          warnings: [],
          createdAt: next.createdAt,
          updatedAt: next.updatedAt,
        });
        break;
      case "분석 변경":
        next.analysis!.summary += " 변경";
        break;
      case "주제 변경":
        next.selectedCandidateId = "other";
        break;
      case "선택 이력 변경":
        next.candidateSelections = [];
        break;
      case "다른 생성 방식":
        plan.mode = "ai";
        break;
      case "다른 근거 revision":
        plan.sourceRevision++;
        break;
    }
    expect(() => planConfirmationSnapshot(next, pending)).toThrow("아직 확인하지 못했습니다");
  });
  it("처음부터 완료였거나 최신이 아닌 요청 기준은 거절한다", () => {
    const { pending, next } = fixture();
    pending.company.plans[1].confirmedAt = next.plans[1].confirmedAt;
    expect(() => planConfirmationSnapshot(next, pending)).toThrow();
    pending.company.plans[1].confirmedAt = null;
    pending.planId = pending.company.plans[0].id;
    expect(() => planConfirmationSnapshot(next, pending)).toThrow();
  });
});
