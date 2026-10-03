import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
vi.mock("@/lib/studio-engine", () => ({
  getAiStatus: () => ({ aiConfigured: false, model: "test-model" }),
}));
import { extractSource, validateOfficeArchive } from "@/lib/studio-extract";

function makePdf(stream: string) {
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
  return pdf;
}

describe("자료 원문 추출", () => {
  it("한글과 단위를 보존하고 녹취의 시간표시를 유지한다", async () => {
    const text = "[00:12] 대표: 현재 매출은 1억 원입니다.\n[01:05] 목표는 내년 2억 원입니다.";
    const result = await extractSource(new File([text], "상담.txt"), { allowAi: false });
    expect(result).toEqual({ text, extraction: "local", warnings: [] });
  });
  it("빈 파일, 바이너리 위장, 초과 텍스트, 미지원 형식을 조용히 저장하지 않는다", async () => {
    await expect(extractSource(new File([], "빈파일.txt"), { allowAi: false })).rejects.toThrow(
      "비어",
    );
    await expect(
      extractSource(new File(["abc\0def"], "binary.txt"), { allowAi: false }),
    ).rejects.toThrow("바이너리");
    await expect(
      extractSource(new File(["가".repeat(100001)], "장문.txt"), { allowAi: false }),
    ).rejects.toThrow("10만 자");
    await expect(
      extractSource(new File(["document"], "신청서.hwp"), { allowAi: false }),
    ).rejects.toThrow("지원하지 않는");
  });
  it("키가 없는 음성 인식을 성공으로 가장하지 않는다", async () => {
    const file = new File(["RIFF test"], "녹음.wav");
    await expect(extractSource(file, { allowAi: false })).rejects.toThrow("AI 연결이 필요");
    await expect(extractSource(file, { allowAi: true })).rejects.toThrow("설정되지 않았");
  });
  it("XLSX 시트·셀 위치·수식의 저장된 값을 추출한다", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("매출");
    sheet.addRow(["연도", "매출(원)"]);
    sheet.addRow([2025, 100000000]);
    sheet.getCell("C2").value = { formula: "B2*2", result: 200000000 };
    const bytes = await book.xlsx.writeBuffer();
    const result = await extractSource(new File([new Uint8Array(bytes)], "재무.xlsx"), {
      allowAi: false,
    });
    expect(result.text).toContain("[시트: 매출]");
    expect(result.text).toContain("B2=100000000");
    expect(result.text).toContain("C2=200000000");
    expect(result.warnings.join(" ")).toContain("수식은 실행하지");
  });
  it("DOCX로 위장한 손상 압축을 거부한다", async () => {
    await expect(
      extractSource(new File(["PKgarbage"], "기술.docx"), { allowAi: false }),
    ).rejects.toThrow("손상");
  });
  // 실제 PDF.js의 첫 모듈·worker 초기화를 포함하므로 전체 검사 중의 부하 변동을 허용한다.
  it("PDF 페이지 번호와 실제 본문을 함께 추출한다", { timeout: 15_000 }, async () => {
    const stream = "BT /F1 12 Tf 40 200 Td (Prototype test 2026) Tj ET";
    const pdf = makePdf(stream);
    const result = await extractSource(new File([pdf], "개발.pdf"), { allowAi: false });
    expect(result.text).toContain("[페이지 1]");
    expect(result.text).toContain("Prototype test 2026");
  });
  it(
    "본문 없는 PDF는 AI 동의 없이 전송하지 않고 원본 보관 가능한 NO_TEXT만 반환한다",
    { timeout: 15_000 },
    async () => {
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network"));
      try {
        const file = new File([makePdf("")], "스캔.pdf");
        await expect(extractSource(file, { allowAi: false })).rejects.toMatchObject({
          code: "NO_TEXT",
          status: 422,
        });
        await expect(extractSource(file, { allowAi: true })).rejects.toMatchObject({
          code: "SOURCE_EXTRACTION",
          status: 422,
        });
        expect(network).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
      }
    },
  );
  it("손상 PDF와 빈 DOCX를 본문 없는 정상 PDF로 분류하지 않는다", async () => {
    for (const file of [
      new File(["not-pdf"], "손상.pdf"),
      new File(["PKgarbage"], "손상.docx"),
      new File([], "빈.pdf"),
    ])
      await expect(extractSource(file, { allowAi: false })).rejects.toMatchObject({
        code: "SOURCE_EXTRACTION",
      });
  });
  it("압축 해제 폭증 파일을 파싱 전에 거부한다", () => {
    const buffer = Buffer.alloc(68);
    buffer.writeUInt32LE(0x02014b50, 0);
    buffer.writeUInt32LE(10, 20);
    buffer.writeUInt32LE(40 * 1024 * 1024, 24);
    buffer.writeUInt32LE(0x06054b50, 46);
    buffer.writeUInt16LE(1, 56);
    buffer.writeUInt32LE(46, 58);
    expect(() => validateOfficeArchive(buffer)).toThrow("압축 해제");
  });
});
