import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { planSchema } from "@/lib/studio-schema";
import { compareStoredPlans, type PlanComparisonItem } from "@/lib/studio-plan-diff";
import { PlanComparison, PlanComparisonDetail, PlanComparisonResult } from "./plan-comparison";

const plans = [1, 2].map((version) =>
  planSchema.parse({
    id: `${version}1111111-1111-4111-8111-111111111111`,
    version,
    generatedAt: "2026-09-25T00:00:00Z",
    mode: "manual",
    candidateId: "sample",
    sourceRevision: 1,
    content: {
      title: `합성 v${version}`,
      summary: "요약",
      sections: [],
      actionItems: [],
      interviewQuestions: [],
    },
    review: [],
    confirmedAt: null,
  }),
);
const company = { id: "company", revision: 1, plans };
const result = () =>
  compareStoredPlans(plans, { leftPlanId: plans[0].id, rightPlanId: plans[1].id });

describe("저장 원고 비교 UI", () => {
  it("requires two explicit selections and never defaults to latest", () => {
    const html = renderToStaticMarkup(createElement(PlanComparison, { company }));
    expect(html.match(/value="" selected=""/g)).toHaveLength(2);
    expect(html).toContain("최신 버전을 자동 선택하지 않습니다");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>선택한 두 버전 비교/);
    expect(html).toContain("기준 버전 (왼쪽)");
    expect(html).toContain("대조 버전 (오른쪽)");
  });
  it("blocks comparisons while a manuscript has unsaved edits", () => {
    const html = renderToStaticMarkup(
      createElement(PlanComparison, {
        company,
        blockedReason: "수정본을 먼저 저장하거나 편집을 취소해 주세요.",
      }),
    );
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain("수정본을 먼저 저장하거나 편집을 취소");
    expect(html).not.toContain("본문·근거의 변경 또는 확인 필요 항목");
  });
  it("supports zero or one saved manuscript without claiming a result", () => {
    const html = renderToStaticMarkup(
      createElement(PlanComparison, { company: { ...company, plans: plans.slice(0, 1) } }),
    );
    expect(html).toContain("저장 원고가 두 개 이상이면 비교할 수 있습니다");
    expect(html).toContain('<fieldset disabled=""');
  });
  it("shows exact chosen versions and current review metadata boundaries", () => {
    const html = renderToStaticMarkup(createElement(PlanComparisonResult, { result: result() }));
    expect(html).toContain("기준 v1 → 대조 v2");
    expect(html).toContain("현재 저장된 각 버전의 메타데이터");
    expect(html).toContain("제출 당시 기록은 신청 회차 이력");
    expect(html).toContain("사실·수치·기관 승인이 확인되지는 않습니다");
    expect(html).not.toContain("합성 v1"); // Collapsed rows do not pre-render full raw values.
  });
  it("marks unavailable or ambiguous selections without replacing them", () => {
    for (const status of ["missing", "same-version", "ambiguous"] as const) {
      const html = renderToStaticMarkup(
        createElement(PlanComparisonResult, { result: { ...result(), status } }),
      );
      expect(html).not.toContain("본문·근거의 변경 또는 확인 필요 항목");
      expect(html).toContain(
        status === "missing"
          ? "현재 회사에서 찾지 못했습니다"
          : status === "same-version"
            ? "서로 다른 두 저장 버전"
            : "식별값이 중복",
      );
    }
  });
  it("announces incomplete comparison instead of a successful whole review", () => {
    const html = renderToStaticMarkup(
      createElement(PlanComparisonResult, { result: { ...result(), complete: false } }),
    );
    expect(html).toContain("전체 비교 완료가 아닙니다");
    expect(html).toContain("해당 버전을 선택해 확인");
  });
  it("escapes raw text in both original and changed views", () => {
    const item: PlanComparisonItem = {
      key: "text",
      title: "본문",
      group: "content",
      state: "changed",
      left: "<script>one()</script>\n",
      right: "<img src=x onerror=bad()>\n",
      leftLength: 23,
      rightLength: 27,
      orderOnly: false,
      note: null,
    };
    const html = renderToStaticMarkup(
      createElement(PlanComparisonDetail, { item, leftLabel: "기준 v1", rightLabel: "대조 v2" }),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img ");
    expect(html).toContain('aria-label="추가"');
    expect(html).toContain('aria-label="삭제"');
  });
  it("does not diff ambiguous groups or pretend excerpts are full text", () => {
    const item: PlanComparisonItem = {
      key: "text",
      title: "본문",
      group: "content",
      state: "limited",
      left: "앞부분",
      right: "다른앞부분",
      leftLength: 50000,
      rightLength: 50000,
      orderOnly: false,
      note: "생략된 범위를 원고 화면에서 직접 확인하세요.",
    };
    const html = renderToStaticMarkup(
      createElement(PlanComparisonDetail, { item, leftLabel: "기준 v1", rightLabel: "대조 v2" }),
    );
    expect(html).toContain("앞 3자만 표시");
    expect(html).toContain("생략된 범위");
    expect(html).not.toContain("변경 조각");
  });
});
