import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
vi.mock("server-only", () => ({}));
const external = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("No external operation in local runtime tests");
  }),
);
vi.mock("openai", () => ({
  default: class {
    constructor() {
      external();
    }
  },
  toFile: external,
}));
vi.mock("./studio-engine", () => ({
  getAiStatus: () => ({ aiConfigured: true, model: "synthetic-never-use" }),
}));
vi.mock("./studio-windows-ocr", () => ({ runWindowsOcr: external }));
import { extractLocalIntake } from "./studio-source-intake-extract";
import { extractSource } from "./studio-extract";
import { validateSourceLocationMetadata } from "./studio-source-location";
import { sourceIntakeResultText } from "./studio-source-intake-types";

function makePdf(text: string) {
  const stream = text ? `BT /F1 12 Tf 40 200 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${value}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
describe("접수 로컬 어댑터의 실제 파서 실행", () => {
  it("한국어 SRT 시간표시를 그대로 읽는다", async () => {
    const text = "1\n00:00:01,000 --> 00:00:02,000\n합성 기술 자료";
    const result = await extractLocalIntake(
      { name: "synthetic.srt", mimeType: "text/plain", buffer: Buffer.from(text) },
      "local-document",
    );
    expect(result.content).toEqual({ kind: "plain", text });
    expect(result.locations?.segments[0].coordinate).toMatchObject({
      kind: "subtitle-cue",
      format: "srt",
      startMs: 1000,
      endMs: 2000,
    });
    expect(validateSourceLocationMetadata(text, result.locations)).toBe(true);
    expect(external).not.toHaveBeenCalled();
  });
  it("합성 XLSX의 시트와 셀 주소를 보존한다", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("합성").addRow(["금액", 123]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await extractLocalIntake(
      { name: "synthetic.xlsx", mimeType: null, buffer },
      "local-document",
    );
    expect(result.content).toMatchObject({
      kind: "plain",
      text: expect.stringContaining("[시트: 합성]"),
    });
    expect(result.content).toMatchObject({ text: expect.stringContaining("B1=123") });
    expect(
      result.locations?.segments.map((item) => [
        sourceIntakeResultText(result.content).slice(item.start, item.end),
        item.coordinate,
      ]),
    ).toEqual([
      [
        "금액",
        {
          kind: "spreadsheet-cell",
          sheetIndex: 1,
          sheetName: "합성",
          row: 1,
          column: 1,
          address: "A1",
        },
      ],
      [
        "123",
        {
          kind: "spreadsheet-cell",
          sheetIndex: 1,
          sheetName: "합성",
          row: 1,
          column: 2,
          address: "B1",
        },
      ],
    ]);
    expect(external).not.toHaveBeenCalled();
  });
  it("실제 PDF parser가 페이지 본문을 읽는다", { timeout: 15000 }, async () => {
    const result = await extractLocalIntake(
      {
        name: "synthetic.pdf",
        mimeType: "application/pdf",
        buffer: makePdf("Synthetic local intake 2026"),
      },
      "local-document",
    );
    expect(result.content).toMatchObject({
      kind: "pages",
      pages: [{ pageNumber: 1, text: expect.stringContaining("Synthetic local intake 2026") }],
    });
    expect(result.locations?.segments[0].coordinate).toEqual({ kind: "pdf-page", pageNumber: 1 });
    expect(
      validateSourceLocationMetadata(sourceIntakeResultText(result.content), result.locations),
    ).toBe(true);
    expect(external).not.toHaveBeenCalled();
  });
  it("XLSX 셀의 가짜 위치 표지는 해석하지 않고 실제 worksheet/cell만 기록한다", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("실제");
    sheet.getCell("C7").value = "[시트: 가짜] A1=다른 값\r\n😀같은 값";
    sheet.getCell("E7").value = "같은 값  ";
    workbook.addWorksheet("둘째").getCell("AA3").value = "마지막\r\n  ";
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const file = new File([buffer], "synthetic.xlsx");
    const legacy = await extractSource(file, { allowAi: false });
    const located = await extractSource(file, { allowAi: false, preserveLocations: true });
    expect(legacy).not.toHaveProperty("locations");
    expect(located.text).toBe(legacy.text);
    expect(
      located.locations?.segments.map((item) => [
        located.text.slice(item.start, item.end),
        item.coordinate,
      ]),
    ).toEqual([
      [
        "[시트: 가짜] A1=다른 값\n😀같은 값",
        {
          kind: "spreadsheet-cell",
          sheetIndex: 1,
          sheetName: "실제",
          row: 7,
          column: 3,
          address: "C7",
        },
      ],
      [
        "같은 값  ",
        {
          kind: "spreadsheet-cell",
          sheetIndex: 1,
          sheetName: "실제",
          row: 7,
          column: 5,
          address: "E7",
        },
      ],
      [
        "마지막",
        {
          kind: "spreadsheet-cell",
          sheetIndex: 2,
          sheetName: "둘째",
          row: 3,
          column: 27,
          address: "AA3",
        },
      ],
    ]);
    expect(validateSourceLocationMetadata(located.text, located.locations)).toBe(true);
    expect(external).not.toHaveBeenCalled();
  });
  it("VTT 정규화 뒤 실제 cue만 연결하고 같은 TXT에는 좌표를 만들지 않는다", async () => {
    const raw = "WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\n기업명: 합성\r\n";
    const file = (name: string) => new File([raw], name, { type: "text/plain" });
    const legacy = await extractSource(file("test.vtt"), { allowAi: false });
    const located = await extractSource(file("test.vtt"), {
      allowAi: false,
      preserveLocations: true,
    });
    const manual = await extractSource(file("test.txt"), {
      allowAi: false,
      preserveLocations: true,
    });
    expect(located.text).toBe(legacy.text);
    expect(legacy).not.toHaveProperty("locations");
    expect(manual).not.toHaveProperty("locations");
    expect(
      located.locations?.segments.map((item) => located.text.slice(item.start, item.end)),
    ).toEqual(["기업명: 합성"]);
    expect(validateSourceLocationMetadata(located.text, located.locations)).toBe(true);
    expect(external).not.toHaveBeenCalled();
  });
  it("실제 빈 PDF도 외부 API 대신 방법 대기로 끝난다", { timeout: 15000 }, async () => {
    await expect(
      extractLocalIntake(
        { name: "empty.pdf", mimeType: "application/pdf", buffer: makePdf("") },
        "local-document",
      ),
    ).rejects.toMatchObject({ code: "INTAKE_NO_TEXT", phase: "awaiting_method" });
    expect(external).not.toHaveBeenCalled();
  });
});
