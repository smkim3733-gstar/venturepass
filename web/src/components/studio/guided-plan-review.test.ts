import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GuidedWorkspace } from "./guided-workspace";
import { GuidedPlanReview, guidedReviewTargetCurrent } from "./guided-plan-review";
import { PlanReviewDecisions, planReviewInputFor } from "./plan-review-decisions";
import { reviewLinkCompany } from "../../../scripts/fixtures/guided-review-link";
function target(c = reviewLinkCompany()) {
  return { companyId: c.id, plan: structuredClone(c.plans[1]), findingIndex: 2 };
}
describe("guided review opinion connection", () => {
  it("opens the original index despite hidden info and duplicate messages without copying a judgement", () => {
    const c = reviewLinkCompany();
    const h = renderToStaticMarkup(
      createElement(PlanReviewDecisions, {
        company: c,
        plan: c.plans[1],
        initialFindingIndex: 2,
        blockedReason: "",
        mutate: vi.fn(),
        onDirtyChange: vi.fn(),
      }),
    );
    expect(h).toContain('value="2" selected=""');
    expect(h).toContain('id="plan-review-reviewer"');
    expect(h).toContain('value="pending" selected=""');
    expect(h).toContain(c.plans[1].review[2].action);
    expect(planReviewInputFor(c, c.plans[1], 2)?.finding.id).toBe("warning-2");
  });
  it.each([-1, 0.5, 200, NaN])("rejects an invalid original index %s", (index) => {
    const c = reviewLinkCompany();
    expect(planReviewInputFor(c, c.plans[1], index)).toBeNull();
  });
  it("accepts a new company revision without changing the pinned manuscript", () => {
    const c = reviewLinkCompany(),
      t = target(c);
    c.revision++;
    expect(guidedReviewTargetCurrent(c, t)).toBe(true);
    expect(c.plans[1].confirmedAt).toBeNull();
  });
  it.each(["company", "version", "content", "finding", "new-plan", "duplicate", "missing"])(
    "rejects a changed review target: %s",
    (change) => {
      const c = reviewLinkCompany(),
        t = target(c);
      if (change === "company") c.id = "c0000000-0000-4000-8000-000000000002";
      if (change === "version") c.plans[1].version++;
      if (change === "content") c.plans[1].content.summary += " changed";
      if (change === "finding") c.plans[1].review[2].action += " changed";
      if (change === "new-plan") c.plans.push({ ...c.plans[1], id: c.id, version: 3 });
      if (change === "duplicate") c.plans.push(structuredClone(c.plans[1]));
      if (change === "missing") c.plans = [];
      expect(guidedReviewTargetCurrent(c, t)).toBe(false);
      const h = renderToStaticMarkup(
        createElement(GuidedPlanReview, {
          company: c,
          target: t,
          busy: false,
          blocked: false,
          dirty: false,
          mutate: vi.fn(),
          onDirtyChange: vi.fn(),
          onClose: vi.fn(),
        }),
      );
      expect(h).toContain("현재 회사나 원고가 바뀌었습니다");
      expect(h).toMatch(/<select[^>]*disabled=""/);
      expect(h).not.toContain('id="plan-review-reviewer"');
    },
  );
  it("shows exact original opinion numbers and keeps existing confirmation restrictions", () => {
    const c = reviewLinkCompany(),
      before = structuredClone(c);
    const h = renderToStaticMarkup(
      createElement(GuidedWorkspace, {
        company: c,
        status: null,
        busy: "",
        blocked: false,
        onCompany: vi.fn(),
        onBusyChange: vi.fn(),
        onUnsettledChange: vi.fn(),
        setDirty: vi.fn(),
        mutate: vi.fn(),
        onDetails: vi.fn(),
        onSettings: vi.fn(),
      }),
    );
    expect(h).toContain("의견 2: 동일한 근거 대조 의견");
    expect(h).toContain("의견 3: 동일한 근거 대조 의견");
    expect(h).not.toContain("의견 1: 참고 정보");
    expect(h).toContain("검토 의견 확인하기");
    expect(h).toContain("전체 검토 미완료");
    expect(h).not.toContain("검토 마치고 신청 준비");
    expect(c).toEqual(before);
  });
});
