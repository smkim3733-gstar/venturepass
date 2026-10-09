import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GuidedWorkspace } from "./guided-workspace";
import { deriveGuidedFlow } from "@/lib/studio-guided-flow";
import { exportPlanMarkdown } from "@/lib/studio-export";
import {
  manuscriptReviewCompany,
  exportPlanDocx,
  documentXml,
} from "../../../scripts/fixtures/guided-manuscript-review";
function html(company = manuscriptReviewCompany(), busy = "", blocked = false) {
  return renderToStaticMarkup(
    createElement(GuidedWorkspace, {
      company,
      status: null,
      busy,
      blocked,
      onCompany: () => {},
      onBusyChange: () => {},
      onUnsettledChange: () => {},
      setDirty: () => {},
      mutate: async () => null,
      onDetails: () => {},
      onSettings: () => {},
    }),
  );
}
describe("saved manuscript review and export", () => {
  it("keeps the latest saved version accessible after evidence invalidates analysis", () => {
    const c = manuscriptReviewCompany(),
      before = structuredClone(c),
      text = html(c);
    expect(deriveGuidedFlow(c)).toMatchObject({
      planReady: false,
      planNeedsContextReview: true,
      guidedInputState: "changed",
    });
    expect(text).toContain("현재 원고 v2");
    expect(text).toContain("항목 확인 필요 1개");
    expect(text).toContain("전체 검토 미완료");
    expect(text).toContain("planId=" + c.plans[1].id + "&amp;format=docx");
    expect(text).not.toContain("planId=" + c.plans[0].id + "&amp;format=docx");
    expect(c).toEqual(before);
  });
  it("prioritizes the unconfirmed section instead of full regeneration", () => {
    const text = html();
    expect(text).toContain("확인이 필요한 부분 보기");
    expect(text).not.toContain("현재 자료로 다시 준비");
    expect(text).not.toContain("새 자료가 아직 원고에 반영되지 않았습니다");
  });
  it("does not offer a rejected confirmation when section flags are cleared but analysis is absent", () => {
    const c = manuscriptReviewCompany();
    c.plans[1].content.sections.forEach((s) => (s.needsConfirmation = false));
    const text = html(c);
    expect(text).toContain("자료·신청 방향 확인");
    expect(text).toContain("전체 검토 미완료");
    expect(text).not.toContain("검토 마치고 신청 준비");
    expect(text).not.toContain("현재 자료로 다시 준비");
  });
  it("keeps blocking review findings visible even with no unconfirmed sections", () => {
    const c = manuscriptReviewCompany();
    c.plans[1].content.sections.forEach((s) => (s.needsConfirmation = false));
    c.plans[1].review = [
      {
        id: "synthetic-review",
        sectionKey: "development",
        sourceIds: [],
        severity: "error",
        category: "confirmation",
        message: "근거 대조 필요",
        action: "근거를 대조하세요",
      },
    ];
    const text = html(c);
    expect(text).toContain("검토 의견 1개");
    expect(text).toContain("검토 의견 확인하기");
    expect(text).not.toContain("검토 마치고 신청 준비");
  });
  it("does not label an old confirmation as current completion", () => {
    const c = manuscriptReviewCompany();
    c.plans[1].confirmedAt = c.plans[1].generatedAt;
    const text = html(c);
    expect(text).toContain("전체 검토 미완료");
    expect(text).not.toContain("내부 검토 기록 있음");
  });
  it.each([
    ["busy", "", true],
    ["working", "진행 중", false],
  ] as const)("blocks the direct download while %s", (_name, busy, blocked) => {
    const text = html(manuscriptReviewCompany(), busy, blocked);
    if (busy) expect(text).toContain("완료되면 다음 내용을 보여 드립니다.");
    else expect(text).toContain("원고 v2 Word 내려받기");
    expect(text).not.toContain("format=docx");
  });
  it("exports precisely the saved version and unresolved review to Word and Markdown", async () => {
    const c = manuscriptReviewCompany(),
      plan = c.plans[1],
      before = structuredClone(c);
    const xml = await documentXml(await exportPlanDocx(c, plan, false));
    const md = exportPlanMarkdown(c, plan, false);
    for (const text of [xml, md]) {
      expect(text).toContain(plan.content.sections[1].content);
      expect(text).toContain(c.plans[0].content.sections[0].content);
      expect(text).toContain("미확인 — 변경 자료와 원고의 반영 범위 확인 필요");
      expect(text).not.toContain("재작성 필요");
      expect(text).toContain("확인 필요");
    }
    expect(xml).toContain("원고 버전 2");
    expect(c).toEqual(before);
  });
});
