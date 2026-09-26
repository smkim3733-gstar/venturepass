import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mock = vi.hoisted(() => ({
  extract: vi.fn(),
  ocr: vi.fn(),
  info: vi.fn(),
  text: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("./studio-extract", () => ({
  extractSource: mock.extract,
  MAX_SOURCE_TEXT: 100000,
  MAX_UPLOAD_BYTES: 12 * 1024 * 1024,
}));
vi.mock("./studio-windows-ocr", () => ({ runWindowsOcr: mock.ocr }));
vi.mock("pdf-parse", () => ({
  PDFParse: class {
    getInfo = mock.info;
    getText = mock.text;
    destroy = mock.destroy;
  },
}));
import { extractLocalIntake } from "./studio-source-intake-extract";
import { StudioError } from "./studio-http";
import { buildSourceLocationMetadata } from "./studio-source-location";

beforeEach(() => {
  vi.clearAllMocks();
  mock.extract.mockResolvedValue({
    text: "[시트: 합성] A1=100",
    extraction: "local",
    warnings: [],
  });
  mock.info.mockResolvedValue({ total: 2 });
  mock.text.mockResolvedValue({
    pages: [
      { num: 1, text: "first" },
      { num: 2, text: "second" },
    ],
  });
  mock.destroy.mockResolvedValue(undefined);
  mock.ocr.mockResolvedValue({ pages: [{ pageNumber: 1, text: "합성 판독" }], warnings: [] });
});
const pdf = {
  name: "test.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\nsynthetic"),
};
describe("접수 자료의 로컬 추출 어댑터", () => {
  it.each(["txt", "md", "csv", "tsv", "srt", "vtt", "docx", "xlsx"])(
    "%s의 위치 표기를 보존하고 AI를 허용하지 않는다",
    async (extension) => {
      const result = await extractLocalIntake(
        { name: `test.${extension}`, mimeType: null, buffer: Buffer.from("synthetic") },
        "local-document",
      );
      expect(result.content).toEqual({ kind: "plain", text: "[시트: 합성] A1=100" });
      expect(mock.extract).toHaveBeenCalledWith(expect.any(File), {
        allowAi: false,
        preserveLocations: true,
      });
      expect(mock.ocr).not.toHaveBeenCalled();
    },
  );
  it("PDF 실제 페이지 배열을 보존하고 parser를 정리한다", async () => {
    expect((await extractLocalIntake(pdf, "local-document")).content).toEqual({
      kind: "pages",
      pages: [
        { pageNumber: 1, text: "first" },
        { pageNumber: 2, text: "second" },
      ],
    });
    expect(mock.destroy).toHaveBeenCalledOnce();
    expect(mock.extract).not.toHaveBeenCalled();
    expect(mock.ocr).not.toHaveBeenCalled();
  });
  it("본문 없는 PDF는 방법 선택 대기이며 OCR/AI 자동 호출하지 않는다", async () => {
    mock.text.mockResolvedValue({
      pages: [
        { num: 1, text: " " },
        { num: 2, text: "" },
      ],
    });
    await expect(extractLocalIntake(pdf, "local-document")).rejects.toMatchObject({
      code: "INTAKE_NO_TEXT",
      phase: "awaiting_method",
    });
    expect(mock.ocr).not.toHaveBeenCalled();
    expect(mock.extract).not.toHaveBeenCalled();
    expect(mock.destroy).toHaveBeenCalledOnce();
  });
  it.each([121, 0, 1.5])("PDF 페이지 한도/형식 %s를 거부한다", async (total) => {
    mock.info.mockResolvedValue({ total });
    await expect(extractLocalIntake(pdf, "local-document")).rejects.toMatchObject({
      code: "INTAKE_PAGE_LIMIT",
    });
    expect(mock.text).not.toHaveBeenCalled();
    expect(mock.destroy).toHaveBeenCalledOnce();
  });
  it("부분 페이지 누락과 순서 변경을 성공 처리하지 않는다", async () => {
    mock.text.mockResolvedValue({ pages: [{ num: 2, text: "second" }] });
    await expect(extractLocalIntake(pdf, "local-document")).rejects.toMatchObject({
      code: "INTAKE_PAGES_INVALID",
    });
  });
  it("명시 Windows OCR만 실행하며 페이지 결과는 미검토다", async () => {
    const result = await extractLocalIntake(pdf, "windows-ko");
    expect(mock.ocr).toHaveBeenCalledWith(pdf.buffer, "application/pdf");
    expect(result.content).toEqual({
      kind: "pages",
      pages: [{ pageNumber: 1, text: "합성 판독" }],
    });
    expect(result.warnings.join(" ")).toContain("미검토");
    expect(result.locations?.segments).toEqual([
      { start: 8, end: 13, coordinate: { kind: "ocr-page", pageNumber: 1 } },
    ]);
    expect(mock.extract).not.toHaveBeenCalled();
  });
  it("다른 본문에 붙은 구조 위치는 성공 결과로 내보내지 않는다", async () => {
    mock.extract.mockResolvedValue({
      text: "actual",
      extraction: "local",
      warnings: [],
      locations: {
        version: 1,
        textSha256: "0".repeat(64),
        coverage: "complete",
        segments: [],
      },
    });
    await expect(
      extractLocalIntake({ ...pdf, name: "test.xlsx" }, "local-document"),
    ).rejects.toMatchObject({ code: "INTAKE_LOCATIONS_INVALID" });
  });
  it("부분 위치도 본문을 보존하고 위치 미확인 안내를 남긴다", async () => {
    mock.extract.mockResolvedValue({
      text: "actual",
      extraction: "local",
      warnings: [],
      locations: buildSourceLocationMetadata("actual", [], "partial"),
    });
    const result = await extractLocalIntake({ ...pdf, name: "test.vtt" }, "local-document");
    expect(result.content).toEqual({ kind: "plain", text: "actual" });
    expect(result.warnings.join(" ")).toContain("누락 위치는 미확인");
  });
  it.each(["png", "mp3", "m4a", "webm", "hwp"])(
    "%s는 로컬 문서에서 외부 인식으로 전환하지 않는다",
    async (extension) => {
      await expect(
        extractLocalIntake({ ...pdf, name: `test.${extension}` }, "local-document"),
      ).rejects.toMatchObject({ code: "INTAKE_METHOD_UNSUPPORTED", phase: "awaiting_method" });
      expect(mock.extract).not.toHaveBeenCalled();
      expect(mock.ocr).not.toHaveBeenCalled();
    },
  );
  it("위장 PDF 및 OCR MIME 불일치를 판독 전에 거부한다", async () => {
    await expect(
      extractLocalIntake({ ...pdf, buffer: Buffer.from("not a PDF") }, "windows-ko"),
    ).rejects.toMatchObject({ code: "OCR_UNSUPPORTED_FORMAT" });
    await expect(
      extractLocalIntake({ ...pdf, mimeType: "image/png" }, "windows-ko"),
    ).rejects.toMatchObject({ code: "OCR_UNSUPPORTED_FORMAT" });
    expect(mock.ocr).not.toHaveBeenCalled();
  });
  it("판독 원문 오류는 반환하지 않고 고정 코드만 노출한다", async () => {
    mock.ocr.mockRejectedValue(new Error("SECRET_PATH AND CONTENT"));
    await expect(extractLocalIntake(pdf, "windows-ko")).rejects.toMatchObject({
      code: "INTAKE_EXTRACTION_FAILED",
    });
    mock.ocr.mockRejectedValue(new StudioError("SECRET_PATH AND CONTENT", 504, "OCR_TIMEOUT"));
    await expect(extractLocalIntake(pdf, "windows-ko")).rejects.toMatchObject({
      code: "OCR_TIMEOUT",
    });
    try {
      await extractLocalIntake(pdf, "windows-ko");
    } catch (error) {
      expect(String(error)).not.toContain("SECRET");
    }
  });
  it("결과 본문·경고 한도 및 잘못된 OCR 페이지를 자르지 않고 거부한다", async () => {
    mock.extract.mockResolvedValue({ text: "x".repeat(100001), extraction: "local", warnings: [] });
    await expect(
      extractLocalIntake({ ...pdf, name: "test.txt" }, "local-document"),
    ).rejects.toMatchObject({ code: "INTAKE_OUTPUT_LIMIT" });
    mock.ocr.mockResolvedValue({ pages: [{ pageNumber: 2, text: "text" }], warnings: [] });
    await expect(extractLocalIntake(pdf, "windows-ko")).rejects.toMatchObject({
      code: "INTAKE_OUTPUT_LIMIT",
    });
  });
  it("빈 파일과 파일 크기 초과를 파서 전에 거부한다", async () => {
    for (const buffer of [Buffer.alloc(0), Buffer.alloc(12 * 1024 * 1024 + 1)])
      await expect(extractLocalIntake({ ...pdf, buffer }, "local-document")).rejects.toMatchObject({
        code: "INTAKE_FILE_LIMIT",
      });
    expect(mock.info).not.toHaveBeenCalled();
  });
});
