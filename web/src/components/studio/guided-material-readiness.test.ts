import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createPlanQualityFixtures } from "@/lib/studio-plan-quality-fixtures";
import { GuidedMaterialReadiness } from "./guided-material-readiness";

function render(company = createPlanQualityFixtures()[0].company, locked = false) {
  return renderToStaticMarkup(
    createElement(GuidedMaterialReadiness, { company, locked, onReviewSources: vi.fn() }),
  );
}
describe("guided material overview", () => {
  it("shows saved first-analysis scope separately from confirmation and tokens", () => {
    const html = render();
    expect(html).toContain("자료와 AI 입력 현황");
    expect(html).toContain("첫 분석 입력");
    expect(html).toContain("240,000");
    expect(html).toContain("최종 사용 전에 확인");
    expect(html).toContain("AI 토큰 한도나 결과 품질을 보장");
    expect(html).toContain("검색·필터는 이 입력 범위를 바꾸지 않습니다");
    expect(html).not.toContain("사실 확인 완료");
  });
  it("allows description-only drafts and locks the existing reading handoff while busy", () => {
    const c = createPlanQualityFixtures()[0].company;
    c.sources = [];
    c.sourceIntakes = [];
    c.profile.technologySummary = "합성 회사 설명";
    expect(render(c)).toContain("첨부 본문이 없어도 저장된 회사 설명으로");
    c.sources = [
      { ...createPlanQualityFixtures()[0].company.sources[0], extraction: "pending", text: "" },
    ];
    const html = render(c, true);
    expect(html).toContain("내용 제외 · 판독 대기");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>본문 판독·채택 확인/);
  });
  it("shows over-limit action before disclosure and escapes material names", () => {
    const c = createPlanQualityFixtures()[0].company;
    c.sources = [0, 1].map((n) => ({
      ...c.sources[0],
      id: n ? "11111111-1111-4111-8111-111111111111" : c.sources[0].id,
      name: "<script>합성</script>",
      text: '"'.repeat(65000),
    }));
    const html = render(c);
    expect(html.indexOf("현재 입력이 첫 분석 한도를 넘었습니다")).toBeLessThan(
      html.indexOf("<details"),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("원문을 자동으로 자르지 않습니다");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("같은 본문이 있는 자료 1묶음");
  });
});
