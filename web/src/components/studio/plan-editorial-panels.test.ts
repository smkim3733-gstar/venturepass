import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanLanguagePanel } from "./plan-language-panel";
import { PlanReviewPanel } from "./plan-review-panel";
import type { BusinessPlan, PlanContent, ReviewFinding } from "@/lib/studio-schema";

const content: PlanContent = {
  title: "합성 원고",
  summary: "planned",
  sections: [
    {
      key: "solution",
      title: "기술 구성",
      content: "reported로 설명",
      evidence: [],
      needsConfirmation: true,
    },
  ],
  actionItems: [],
  interviewQuestions: [],
};
const finding: ReviewFinding = {
  id: "r1",
  severity: "warning",
  category: "semantic-evidence",
  sectionKey: "solution",
  sourceIds: ["s1"],
  message: "사용 권한 확인",
  action: "계약 대조",
};
describe("editorial panels", () => {
  it("renders advice for unsaved edits and clears it after manual correction", () => {
    const render = (value: PlanContent) =>
      renderToStaticMarkup(
        createElement(PlanLanguagePanel, {
          content: value,
          onSection: () => {},
        }),
      );
    const before = render(content);
    expect(before).toContain("한국어 표현 점검");
    expect(before).toContain("담당자 설명");
    expect(before).toContain("핵심 요약");
    const corrected = structuredClone(content);
    corrected.summary = "향후 계획";
    corrected.sections[0].content = "담당자 설명";
    expect(render(corrected)).toContain("점검 대상 영어 표현이 없습니다.");
  });
  it("offers field navigation for summary and body while locking it during supporting edits", () => {
    const value = {
      ...content,
      actionItems: ["planned 비용"],
      interviewQuestions: ["unknown 권리"],
    };
    const before = JSON.stringify(value);
    const render = (editingDisabled: boolean) =>
      renderToStaticMarkup(
        createElement(PlanLanguagePanel, {
          content: value,
          onSection: () => {},
          onLocate: () => {},
          editingDisabled,
        }),
      );
    expect(render(false).match(/편집 위치로 이동/g)).toHaveLength(4);
    expect(render(true).match(/disabled=""/g)).toHaveLength(4);
    expect(JSON.stringify(value)).toBe(before);
  });
  it("shows one card for duplicates but preserves their original opinion numbers", () => {
    const plan: BusinessPlan = {
      id: "00000000-0000-4000-8000-000000000001",
      version: 1,
      generatedAt: "2026-09-30T00:00:00Z",
      mode: "manual",
      candidateId: "candidate",
      sourceRevision: 1,
      confirmedAt: null,
      content,
      review: [finding, { ...finding, id: "r2" }, { ...finding, id: "r3", severity: "error" }],
    };
    const before = JSON.stringify(plan);
    const html = renderToStaticMarkup(
      createElement(PlanReviewPanel, { plan, onSection: () => {} }),
    );
    expect(html.match(/사용 권한 확인/g)).toHaveLength(2);
    expect(html).toContain("동일 의견 2건 · 원본 1, 2번");
    expect(html).toContain("수정 필요");
    expect(html).toContain("확인 필요");
    expect(JSON.stringify(plan)).toBe(before);
  });
});
