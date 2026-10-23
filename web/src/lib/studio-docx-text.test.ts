import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { extractDocxText } from "./studio-docx-text";
import { unmatchedNumericEvidence } from "./studio-numeric-evidence";
vi.mock("./studio-engine", () => ({
  getAiStatus: () => ({ aiConfigured: false, model: "synthetic" }),
}));
import { extractSource } from "./studio-extract";

async function document(body: string) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("Word 본문 줄바꿈", () => {
  it("표의 가격과 인원 사이 줄바꿈을 보존해 서로 다른 수치가 붙지 않는다", async () => {
    const buffer = await document('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>연 US$2,400</w:t><w:br/><w:t>120명</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
    const original = Buffer.from(buffer);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External request forbidden"));
    try {
      const result = await extractSource(new File([new Uint8Array(buffer)], "synthetic.docx"), { allowAi: false });
      expect(result.text).toBe("연 US$2,400\n120명");
      expect(unmatchedNumericEvidence("인원 120명", [{ text: result.text, quote: result.text }])).toEqual([]);
      expect(buffer).toEqual(original);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("같은 문장의 서식 run은 이어 쓰되 명시적 줄·페이지·단 나누기와 탭은 보존한다", async () => {
    const buffer = await document('<w:p><w:r><w:t>1</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>00만 원</w:t><w:br/><w:t>계획</w:t><w:br w:type="page"/><w:t>다음</w:t><w:br w:type="column"/><w:t>열</w:t><w:tab/><w:t>끝 &amp; 확인</w:t></w:r></w:p><w:p><w:r><w:t>다음 문단</w:t></w:r></w:p>');
    expect((await extractDocxText(buffer)).value).toBe("100만 원\n계획\n다음\n열\t끝 & 확인\n\n다음 문단\n\n");
  });

  it("판독기가 지원하지 않는 요소의 원본 확인 경고를 숨기지 않는다", async () => {
    const buffer = await document('<w:p><w:r><w:t>앞</w:t><w:cr/><w:t>뒤</w:t></w:r></w:p>');
    const result = await extractDocxText(buffer);
    expect(result.messages.some((message) => message.type === "warning" && message.message.includes("w:cr"))).toBe(true);
  });
});
