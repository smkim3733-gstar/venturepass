import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmationCompany } from "../../../scripts/fixtures/guided-plan-confirmation";
import { GuidedPlanHistory, GuidedStoredPlan } from "./guided-plan-history";

const fetchGuard = vi.fn(() => {
  throw Error("Read-only history must not fetch");
});
beforeEach(() => {
  vi.stubGlobal("fetch", fetchGuard);
  fetchGuard.mockClear();
});
afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
describe("간단 화면의 저장 원고 읽기", () => {
  it("버전을 자동 선택하지 않고 현재 편집 대상 유지 안내를 제공한다", () => {
    const html = renderToStaticMarkup(
      createElement(GuidedPlanHistory, { company: confirmationCompany() }),
    );
    expect(html).toContain("아직 읽을 원고를 선택하지 않았습니다.");
    expect(html).toContain("현재 수정할 원고와 신청 준비 대상은 바뀌지 않습니다.");
    expect(html).not.toContain("저장 원고 v1 원문");
  });
  it("선택한 이전 원문의 공백·줄바꿈·긴 본문과 검토 정보를 변경 없이 표시한다", () => {
    const company = confirmationCompany(),
      plan = company.plans[0];
    plan.content.summary = "  처음 요약\n확인 전  ";
    plan.content.sections[0].content =
      "  원래 본문\n" + "장문 확인 ".repeat(200) + "\n마지막 문장  ";
    plan.content.sections[0].needsConfirmation = true;
    plan.content.sections[0].evidence = [
      { sourceId: "profile", quote: "이전 인용", locator: "원래 위치" },
    ];
    plan.content.actionItems = ["확인 사항\n두 번째 줄"];
    plan.content.interviewQuestions = ["원래 질문"];
    plan.review = [
      {
        id: "synthetic-review",
        category: "synthetic",
        sourceIds: [],
        severity: "warning",
        sectionKey: "problem",
        message: "원래 검토 의견",
        action: "원래 권고",
      },
    ];
    const before = structuredClone(company);
    const html = renderToStaticMarkup(
      createElement(GuidedStoredPlan, { company, planId: plan.id }),
    );
    for (const text of [
      plan.content.summary,
      plan.content.sections[0].content,
      "이전 인용",
      "원래 위치",
      "확인 사항\n두 번째 줄",
      "원래 질문",
      "원래 검토 의견",
      "원래 권고",
      "항목 확인 필요",
      "전체 검토 미완료",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain(company.plans[1].content.title);
    expect(html).not.toContain("이 항목의 원고 고치기");
    expect(html).not.toContain("<textarea");
    expect(company).toEqual(before);
  });
  it("확인 기록이 있는 버전도 기관 완료로 표시하지 않는다", () => {
    const company = confirmationCompany(),
      plan = company.plans[1];
    plan.confirmedAt = plan.generatedAt;
    const html = renderToStaticMarkup(
      createElement(GuidedStoredPlan, { company, planId: plan.id }),
    );
    expect(html).toContain("저장된 내부 검토 시각:");
    expect(html).toContain("기관 제출·접수 완료를 뜻하지 않습니다.");
    expect(html).toContain("저장된 항목 확인 표시 있음");
    expect(html).not.toContain(company.plans[0].content.title);
  });
  it.each(["missing", "id", "version"] as const)(
    "없는 원고나 중복 %s를 임의 선택하지 않는다",
    (kind) => {
      const company = confirmationCompany(),
        planId = company.plans[0].id;
      if (kind === "id") company.plans[1].id = planId;
      if (kind === "version") company.plans[1].version = company.plans[0].version;
      const html = renderToStaticMarkup(
        createElement(GuidedStoredPlan, {
          company,
          planId: kind === "missing" ? "missing" : planId,
        }),
      );
      expect(html).toContain("선택한 원고를 하나로 확인하지 못했습니다.");
      expect(html).not.toContain(company.plans[0].content.title);
    },
  );
  it("미확인 저장 중에는 선택과 선택된 원문 표시를 차단한다", () => {
    const company = confirmationCompany(),
      blockedReason = "원래 저장 상태를 먼저 확인해 주세요.";
    const html = renderToStaticMarkup(createElement(GuidedPlanHistory, { company, blockedReason }));
    expect(html.match(/<select[^>]*>/)?.[0]).toContain("disabled");
    const selected = renderToStaticMarkup(
      createElement(GuidedStoredPlan, { company, planId: company.plans[0].id, blockedReason }),
    );
    expect(selected).toContain(blockedReason);
    expect(selected).not.toContain(company.plans[0].content.title);
  });
});
