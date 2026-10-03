import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { sourceSchema, type SourceDocument } from "@/lib/studio-schema";
import {
  AttachmentCard,
  GuidedMaterials,
  attachmentFormat,
  attachmentSize,
  filterMaterials,
} from "./guided-materials";
const now = "2026-10-03T10:00:00.000Z";
function source(index: number, change: Partial<SourceDocument> = {}) {
  return sourceSchema.parse({
    id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    name: `합성자료-${index}.pdf`,
    originalName: `합성자료-${index}.pdf`,
    mimeType: "application/pdf",
    kind: "other",
    text: "내부 시험 결과이며 매출 실적이 아닙니다.",
    extraction: "local",
    warnings: [],
    createdAt: now,
    updatedAt: now,
    ...change,
  });
}
const caseId = "22222222-2222-4222-8222-222222222222";
function render(sources: SourceDocument[], locked = false) {
  return renderToStaticMarkup(
    createElement(GuidedMaterials, { company: { id: caseId, sources }, locked, onReview: vi.fn() }),
  );
}
describe("첨부 자료 보관함", () => {
  it("선택 직후 파일명·형식·크기·미저장 상태를 표시한다", () => {
    const html = renderToStaticMarkup(
      createElement(AttachmentCard, {
        name: "한글 사업계획.docx",
        state: "waiting",
        label: "전송 대기",
        meta: attachmentSize(2097152),
      }),
    );
    expect(html).toContain("한글 사업계획.docx");
    expect(html).toContain("WORD");
    expect(html).toContain("2.0 MB");
    expect(html).toContain("전송 대기");
    expect(html).not.toContain("저장 완료");
    expect(attachmentFormat("재무.XLSX")).toBe("EXCEL");
    expect(attachmentFormat("메모")).toBe("자료");
  });
  it("읽은 본문·출처 버튼·미확인 사실을 함께 보여 준다", () => {
    const html = render([source(1)]);
    expect(html).toContain("저장된 자료 1개");
    expect(html).toContain("저장 완료 · 본문 있음");
    expect(html).toContain("매출 실적이 아닙니다.");
    expect(html).toContain("사실 확인은 별도");
    expect(html).toContain(
      `/api/studio/cases/${caseId}/sources/11111111-1111-4111-8111-000000000001`,
    );
    expect(html).not.toContain("AI 검토 완료");
  });
  it("원본만 보관한 PDF와 본문이 빈 수동 자료는 본문 있음으로 오인하지 않는다", () => {
    const html = render([
      source(1, { extraction: "pending", text: "" }),
      source(2, { extraction: "manual", originalName: null, text: " " }),
    ]);
    expect(html).toContain("본문 있음 0개 · 본문 확인 필요 2개");
    expect(html.match(/아직 읽은 본문이 없습니다/g)).toHaveLength(2);
    expect(html.match(/원본 내려받기/g)).toHaveLength(1);
    expect(html.match(/원본 보관 · 본문 확인 필요/g)).toHaveLength(1);
  });
  it("자료 200개라는 UI 입력에서도 12개 카드만 먼저 표시하고 원문은 변경하지 않는다", () => {
    const sources = Array.from({ length: 200 }, (_, i) => source(i + 1));
    const before = JSON.stringify(sources);
    const html = render(sources);
    expect(html.match(/<li\b/g)).toHaveLength(12);
    expect(html).toContain("현재 12개 표시");
    expect(html).toContain("188개 남음");
    expect(JSON.stringify(sources)).toBe(before);
  });
  it("파일명·원래 이름·본문을 검색하되 배열/파일 신원/내용을 바꾸지 않는다", () => {
    const files = [
      source(1, { name: "별칭.docx", originalName: "original.DOCX", text: "기술 한계 20개 표본" }),
      source(2, { text: "양산 성능은 미확인", extraction: "local" }),
      source(3, { extraction: "pending", text: "" }),
    ];
    const before = JSON.stringify(files);
    expect(filterMaterials(files, "ORIGINAL", "all").map((x) => x.id)).toEqual([files[0].id]);
    expect(filterMaterials(files, "표본", "ready").map((x) => x.id)).toEqual([files[0].id]);
    expect(filterMaterials(files, "", "pending").map((x) => x.id)).toEqual([files[2].id]);
    expect(filterMaterials(files, "없는 단어", "all")).toEqual([]);
    expect(JSON.stringify(files)).toBe(before);
  });
  it("문서 안 HTML은 실행 가능한 내용으로 삽입하지 않으며 긴 본문은 미리보기만 제한한다", () => {
    const item = source(1, {
      name: "<script>name</script>.pdf",
      text: "<script>window.bad=true</script>" + "가".repeat(400),
    });
    const html = render([item]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("가".repeat(400));
    expect(item.text.length).toBeGreaterThan(400);
  });
  it("다른 작업 중에는 교정 동작이 잠기고 보관/검색이 AI 전송을 뜻하지 않는다", () => {
    const html = render([source(1)], true);
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain("검색·필터는 목록만 바꿉니다");
    expect(html).toContain("AI에 보낼 자료는 다음 단계에서 별도로 확인합니다");
  });
});
