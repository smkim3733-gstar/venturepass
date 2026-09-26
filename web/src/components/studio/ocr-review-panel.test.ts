import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SourceDocument } from "@/lib/studio-schema";
import type { LocalOcrPreview } from "@/lib/studio-local-ocr-types";
import {
  OcrReviewPanel,
  ocrReviewSaveBlockedReason,
  supportsLocalOcr,
  validateLocalOcrPreview,
} from "./ocr-review-panel";

const source: SourceDocument = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "가상 스캔 자료",
  kind: "other",
  text: "",
  originalName: "test-scan.pdf",
  mimeType: "application/pdf",
  extraction: "pending",
  warnings: [],
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
};
function preview(): LocalOcrPreview {
  return {
    caseRevision: 3,
    sourceId: source.id,
    sourceUpdatedAt: source.updatedAt,
    original: {
      originalName: source.originalName!,
      mimeType: source.mimeType,
      sizeBytes: 1024,
      sha256: "a".repeat(64),
    },
    engine: "windows-ko",
    observedAt: "2026-09-25T01:00:00.000Z",
    pages: [
      { pageNumber: 1, text: "첫 페이지 초안 <script>내용</script>" },
      { pageNumber: 2, text: "두 번째 페이지 초안" },
    ],
    text: "[페이지 1]\n첫 페이지 초안 <script>내용</script>\n\n[페이지 2]\n두 번째 페이지 초안",
    warnings: ["숫자와 표의 배열을 확인해 주세요."],
    reviewStatus: "unreviewed",
    sourceChanged: false,
    externalTransmission: false,
  };
}
function render(
  options: { blockedReason?: string; busy?: boolean; error?: string; value?: LocalOcrPreview } = {},
) {
  const onSave = vi.fn(),
    onClose = vi.fn();
  const html = renderToStaticMarkup(
    createElement(OcrReviewPanel, {
      caseId: "11111111-1111-4111-8111-111111111111",
      source,
      preview: options.value ?? preview(),
      busy: options.busy ?? false,
      blockedReason: options.blockedReason ?? "",
      error: options.error ?? "",
      onSave,
      onClose,
    }),
  );
  expect(onSave).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  return html;
}

describe("로컬 OCR 미검토 초안 화면", () => {
  it("페이지별 초안·원본 링크를 제공하고 자동 저장이나 확인 완료를 만들지 않는다", () => {
    const html = render();
    expect(html).toContain("글자 읽기 초안 · 미검토");
    expect(html).toContain("원본 내려받아 1페이지 대조");
    expect(html).toContain("원본 내려받아 2페이지 대조");
    expect(html).toContain("아직 자료 본문을 저장하지 않았으며");
    expect(html).toContain("원본을 외부 AI로 보내지 않습니다");
    expect(html).toContain("사업계획서의 검토 완료나 기관 제출이 아닙니다");
    expect(html).toContain("분석과 기존 사업계획서는 다시 검토해야 합니다");
    expect(html).toContain("&lt;script&gt;내용&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/<input[^>]*\schecked=""/);
    expect(
      html.match(/<button\b[^>]*disabled=""[^>]*>[\s\S]*?확인한 본문 저장<\/button>/),
    ).not.toBeNull();
    expect(html).toContain(source.id);
    expect(html).toContain("a".repeat(64));
  });
  it("버전이 바뀌면 초안·교정 본문을 남긴 채 저장을 막는다", () => {
    const html = render({ blockedReason: "기업 또는 자료 버전이 바뀌었습니다." });
    expect(html).toContain("교정 내용은 이 화면에 유지했습니다");
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain("첫 페이지 초안");
    expect(html).toContain("기업 또는 자료 버전이 바뀌었습니다");
  });
  it("저장 실패는 본문을 보존하며 지속적인 오류로 표시한다", () => {
    const html = render({ error: "원본이 변경되어 저장하지 않았습니다." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("원본이 변경되어 저장하지 않았습니다");
    expect(html).toContain("두 번째 페이지 초안");
  });
  it("본문 저장 중에는 확인·편집·닫기를 막는다", () => {
    const html = render({ busy: true });
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*aria-label="글자 읽기 초안 닫기"[^>]*disabled=""/);
    expect(html).toContain("본문 저장 중");
  });
  it("읽힌 글자가 없는 페이지는 원본 직접 확인 대상으로 남긴다", () => {
    const value = preview();
    value.pages[1].text = "";
    expect(render({ value })).toContain("읽힌 글자가 없습니다. 원본을 직접 확인해 주세요");
  });
});

describe("로컬 OCR 검토 저장 조건", () => {
  it("별도 원본 대조 확인 없이 비어 있지 않은 초안도 저장할 수 없다", () => {
    expect(ocrReviewSaveBlockedReason("초안", false, "", false)).toContain(
      "원본과 교정 본문을 대조",
    );
    expect(ocrReviewSaveBlockedReason("초안", true, "", false)).toBe("");
  });
  it("확인이 있어도 빈 본문·상한 초과·오래된 버전·진행 중 요청은 차단한다", () => {
    expect(ocrReviewSaveBlockedReason("  ", true, "", false)).not.toBe("");
    expect(ocrReviewSaveBlockedReason("a".repeat(100001), true, "", false)).toContain(
      "자동으로 자르지 않습니다",
    );
    expect(ocrReviewSaveBlockedReason("본문", true, "자료 버전 변경", false)).toBe(
      "자료 버전 변경",
    );
    expect(ocrReviewSaveBlockedReason("본문", true, "", true)).not.toBe("");
  });
});

describe("로컬 OCR 응답·원본 바인딩", () => {
  it("같은 자료·버전·미검토·무전송 응답만 수용한다", () => {
    const value = preview();
    expect(validateLocalOcrPreview(value, source, 3)).toBe(value);
  });
  it.each([
    { caseRevision: 2 },
    { sourceId: "other" },
    { sourceUpdatedAt: "changed" },
    { reviewStatus: "reviewed" },
    { sourceChanged: true },
    { externalTransmission: true },
    { engine: "remote-ai" },
    { observedAt: "invalid" },
    { pages: [] },
    { pages: [{ pageNumber: 2, text: "본문" }] },
    {
      pages: [
        { pageNumber: 1, text: "본문" },
        { pageNumber: 1, text: "중복" },
      ],
    },
    {
      pages: [
        { pageNumber: 1, text: "a".repeat(50001) },
        { pageNumber: 2, text: "a".repeat(50000) },
      ],
    },
    { text: "a".repeat(100001) },
    { warnings: [null] },
    { original: null },
  ])("불일치 응답은 저장 검토안으로 사용하지 않는다 (%#)", (change) => {
    expect(() => validateLocalOcrPreview({ ...preview(), ...change }, source, 3)).toThrow(
      "현재 자료가 일치하지 않습니다",
    );
  });
  it.each([
    { originalName: "other.pdf" },
    { mimeType: "image/png" },
    { sha256: "invalid" },
    { sizeBytes: 0 },
    { sizeBytes: 12 * 1024 * 1024 + 1 },
  ])("원본 메타데이터·해시·크기 오류를 거부한다 (%#)", (change) => {
    const value = preview();
    expect(() =>
      validateLocalOcrPreview({ ...value, original: { ...value.original, ...change } }, source, 3),
    ).toThrow("현재 자료가 일치하지 않습니다");
  });
  it.each([
    ["application/pdf", "pdf"],
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/jpeg", "jpeg"],
    ["image/webp", "webp"],
  ])("pending %s 원본만 로컬 글자 읽기를 제공한다", (mimeType, extension) => {
    expect(supportsLocalOcr({ ...source, mimeType, originalName: `sample.${extension}` })).toBe(
      true,
    );
  });
  it.each([null, "application/octet-stream"])(
    "legacy MIME %s도 확장자로 후보를 노출하고 서버가 원본을 검증하게 한다",
    (mimeType) => {
      const legacy = { ...source, mimeType };
      expect(supportsLocalOcr(legacy)).toBe(true);
      const value = preview();
      value.original.mimeType = mimeType;
      expect(validateLocalOcrPreview(value, legacy, 3)).toBe(value);
      expect(supportsLocalOcr({ ...legacy, originalName: "unknown.bin" })).toBe(false);
      expect(supportsLocalOcr({ ...legacy, originalName: "name.constructor" })).toBe(false);
    },
  );
  it("명시 MIME·확장자 불일치와 페이지·합본 불일치, 전체 빈 본문을 거부한다", () => {
    expect(supportsLocalOcr({ ...source, mimeType: "image/png" })).toBe(false);
    expect(() =>
      validateLocalOcrPreview({ ...preview(), text: "페이지와 다른 본문" }, source, 3),
    ).toThrow();
    expect(() =>
      validateLocalOcrPreview(
        { ...preview(), pages: [{ pageNumber: 1, text: " \n" }], text: "[페이지 1]\n \n" },
        source,
        3,
      ),
    ).toThrow();
  });
  it.each([
    { extraction: "manual" as const },
    { extraction: "local" as const },
    { originalName: null },
    { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ])("이미 처리한 본문이나 지원하지 않는 자료는 제외한다 (%#)", (change) => {
    expect(supportsLocalOcr({ ...source, ...change })).toBe(false);
    expect(() => validateLocalOcrPreview(preview(), { ...source, ...change }, 3)).toThrow();
  });
});
