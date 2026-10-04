import { expect, it, vi } from "vitest";
import JSZip from "jszip";
import mammoth from "mammoth";
import { publicEvidenceExportFixture } from "./studio-public-evidence-export-test-helpers";
import { publicEvidenceText } from "./studio-public-evidence";
import {
  publicEvidenceExportEntries,
  readManualPublicEvidence,
  PUBLIC_EVIDENCE_EXPORT_TITLE,
  PUBLIC_EVIDENCE_EXPORT_NOTICE,
} from "./studio-public-evidence-export";
import { exportPlanMarkdown } from "./studio-export";
import { exportPlanDocx } from "./studio-export-docx";
vi.mock("server-only", () => ({}));
const { getStore } = vi.hoisted(() => ({ getStore: vi.fn() }));
vi.mock("./studio-storage", () => ({ getStudioStore: getStore }));
import { GET } from "@/app/api/studio/cases/[caseId]/export/route";
it("reads exact manual format and preserves excerpt whitespace without authenticating the source", () => {
  const { source, draft } = publicEvidenceExportFixture();
  const before = JSON.stringify(source);
  expect(readManualPublicEvidence(source)).toEqual(draft);
  expect(JSON.stringify(source)).toBe(before);
  const copy = readManualPublicEvidence(source)!;
  copy.quote = "changed";
  expect(readManualPublicEvidence(source)!.quote).toBe(draft.quote);
});
it("keeps unknown dates and unspecified notes separate instead of filling today or claiming no conflicts", () => {
  const { source, draft, record, plan } = publicEvidenceExportFixture();
  source.text = publicEvidenceText({
    ...draft,
    publishedOn: "",
    publisher: "",
    period: "",
    relevance: "",
    conflicts: "",
  });
  const text = publicEvidenceExportEntries(record, plan)[0].lines.join("\n");
  expect(text).toContain("발행일 (원문 표기 기록): 미확인");
  expect(text).toContain("기준 기간·대상 (담당자 입력): 미확인");
  expect(text).toContain("상충이 없다는 판단은 아님");
  expect(text).toContain("2026-10-05");
});
it.each(["[원문 발췌 끝]", "[원문 발췌 시작]", "[담당자의 상충·다른 시점·추가 확인 메모]"])(
  "does not guess boundaries when a reserved marker occurs in user content %s",
  (marker) => {
    const { source, draft } = publicEvidenceExportFixture();
    source.text = publicEvidenceText({ ...draft, quote: draft.quote + marker });
    expect(readManualPublicEvidence(source)).toBeNull();
  },
);
it.each(["changed header", "missing field", "invalid date", "extra text", "file metadata"])(
  "does not parse altered or nonmanual records %s",
  (kind) => {
    const { source } = publicEvidenceExportFixture();
    if (kind === "changed header")
      source.text = source.text.replace("검증한 결과가 아닙니다.", "검증했습니다.");
    if (kind === "missing field") source.text = source.text.replace("발행처: 합성 발행기관\n", "");
    if (kind === "invalid date") source.text = source.text.replace("2024-03-02", "2024-02-31");
    if (kind === "extra text") source.text += "\n추가 내용";
    if (kind === "file metadata") source.originalName = "copied.pdf";
    expect(readManualPublicEvidence(source)).toBeNull();
  },
);
it("groups only this plan's cited public sources and retains every citation number and section", () => {
  const { record, plan, source } = publicEvidenceExportFixture();
  plan.content.sections[1].evidence.push({
    sourceId: source.id,
    quote: "없는 문구",
    locator: "다른 인용",
  });
  record.sources.push({
    ...source,
    id: "unrelated",
    text: source.text.replace("합성 발행기관", "PRIVATE_UNUSED_PUBLISHER"),
  });
  const rows = publicEvidenceExportEntries(record, plan);
  expect(rows).toHaveLength(1);
  expect(rows[0].lines.join("\n")).toContain("[1] 목표 시장 / [2] 기술 개발 계획");
  expect(rows[0].lines.join("\n")).toContain("인용 [1] 문자 대조: 현재 보관 발췌에 같은 문구 있음");
  expect(rows[0].lines.join("\n")).toContain(
    "인용 [2] 문자 대조: 현재 보관 발췌에서 같은 문구를 찾지 못함",
  );
  expect(JSON.stringify(rows)).not.toContain("PRIVATE_UNUSED_PUBLISHER");
});
it("does not count metadata or whitespace-normalized matches as an excerpt match", () => {
  const { record, plan } = publicEvidenceExportFixture();
  for (const quote of ["합성 발행기관", "2023년  합성 산업의 표본 수는 120개입니다.", "   "]) {
    plan.content.sections[0].evidence[0].quote = quote;
    expect(publicEvidenceExportEntries(record, plan)[0].lines.join("\n")).toContain(
      "같은 문구를 찾지 못함",
    );
  }
});
it("labels current manual metadata without reassigning it to the historical manuscript", () => {
  const { record, plan, source, draft } = publicEvidenceExportFixture();
  source.text = publicEvidenceText({
    ...draft,
    url: "https://example.invalid/new-period",
    readOn: "2026-10-06",
  });
  const before = JSON.stringify(record);
  const lines = publicEvidenceExportEntries(record, plan)[0].lines.join("\n");
  expect(lines).toContain("원고 작성 근거 revision: 2 · 현재 회사 revision: 5");
  expect(lines).toContain("현재 보관 자료 수정 시각:");
  expect(lines).toContain("2026-10-06");
  expect(PUBLIC_EVIDENCE_EXPORT_NOTICE).toContain("원고 작성 당시의 출처 이력");
  expect(JSON.stringify(record)).toBe(before);
});
it("preserves invalid source hints and refuses metadata from duplicate IDs", () => {
  const { record, plan, source } = publicEvidenceExportFixture();
  source.text = "edited manual note";
  let entry = publicEvidenceExportEntries(record, plan)[0];
  expect(entry.parsed).toBe(false);
  expect(entry.lines.join("\n")).toContain("추정하지 않습니다");
  record.sources.push({ ...source });
  entry = publicEvidenceExportEntries(record, plan)[0];
  expect(entry.parsed).toBe(false);
  expect(entry.lines.join("\n")).toContain("동일 ID 자료가 여러 개");
});
it("does not infer public status from an arbitrary URL, missing source, or uncited source", () => {
  const { record, plan, source } = publicEvidenceExportFixture();
  source.name = "일반 자료";
  source.text = "https://example.invalid/report";
  expect(publicEvidenceExportEntries(record, plan)).toEqual([]);
  record.sources = [];
  expect(publicEvidenceExportEntries(record, plan)).toEqual([]);
  expect(exportPlanMarkdown(record, plan, false)).toContain(
    "삭제되었거나 현재 자료에서 찾을 수 없는 출처",
  );
});
it("honors explicit package source restrictions in the added metadata appendix", () => {
  const { record, plan } = publicEvidenceExportFixture();
  expect(publicEvidenceExportEntries(record, plan, { sourceListIds: [] })).toEqual([]);
  const md = exportPlanMarkdown(record, plan, false, { sourceListIds: [] });
  expect(md).not.toContain(PUBLIC_EVIDENCE_EXPORT_TITLE);
  expect(md).not.toContain("합성 발행기관");
  expect(md).toContain(plan.content.sections[0].evidence[0].quote);
});
it("adds the same scoped source metadata to Markdown and Word without source or plan writes", async () => {
  const { record, plan, source } = publicEvidenceExportFixture();
  const before = JSON.stringify(record);
  const markdown = exportPlanMarkdown(record, plan, false);
  const docx = await exportPlanDocx(record, plan, false);
  const text = (await mammoth.extractRawText({ buffer: docx })).value;
  expect(markdown).toContain("[1]");
  for (const value of [
    PUBLIC_EVIDENCE_EXPORT_TITLE,
    "합성 발행기관",
    "현재 보관 자료",
    "문자 대조",
    "의미·수치·사실 검증은 아님",
  ]) {
    expect(markdown).toContain(value);
    expect(text).toContain(value);
  }
  expect(text).toContain("2024-03-02");
  expect(text).toContain("2023년 국내 산업 전체");
  expect(text).toContain("담당자가 원문을 읽었다고 기록한 날짜: 2026-10-05");
  expect(text).toContain("사용자 검토 확인: 미확인");
  expect(text).toContain(plan.content.sections[1].content);
  expect(text).toContain(source.id);
  expect(JSON.stringify(record)).toBe(before);
  expect(await exportPlanDocx(record, plan, false)).toEqual(docx);
  const zip = await JSZip.loadAsync(docx);
  const xml = await zip.file("word/document.xml")!.async("string");
  expect([...xml.matchAll(/w:anchor="(section_\d+)"/g)].map((m) => m[1])).toEqual(
    [...xml.matchAll(/w:name="(section_\d+)"/g)].map((m) => m[1]),
  );
  for (const name of Object.keys(zip.files).filter((n) => n.endsWith(".rels")))
    expect(await zip.file(name)!.async("string")).not.toContain('TargetMode="External"');
});
it("escapes new metadata instead of treating it as Markdown, HTML, XML or remote relationships", async () => {
  const { record, plan, source, draft } = publicEvidenceExportFixture();
  source.text = publicEvidenceText({
    ...draft,
    relevance:
      '![remote](https://evil.invalid/x)\n<script>alert(1)</script>\n<w:hyperlink r:id="evil"/>',
    conflicts: "메모 끝",
  });
  const md = exportPlanMarkdown(record, plan, false);
  expect(md).not.toContain("![remote]");
  expect(md).not.toContain("<script>");
  const buffer = await exportPlanDocx(record, plan, false);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")!.async("string");
  expect(xml).toContain("&lt;script&gt;");
  expect(xml).not.toContain('<w:hyperlink r:id="evil"');
  expect((await mammoth.extractRawText({ buffer })).value).toContain("<script>alert(1)</script>");
});
it("keeps complete long notes and safe plain-text URLs without truncating the record", async () => {
  const { record, plan, source, draft } = publicEvidenceExportFixture();
  const note = "확인메모 ".repeat(599) + "마지막";
  source.text = publicEvidenceText({
    ...draft,
    relevance: note,
    conflicts: note,
    url: "https://example.invalid/" + "a".repeat(1900),
  });
  const text = (await mammoth.extractRawText({ buffer: await exportPlanDocx(record, plan, false) }))
    .value;
  expect(text).toContain(note);
  expect(text).toContain("a".repeat(1900));
  expect(text.match(/마지막/g)).toHaveLength(2);
});
it("returns only the requested saved version via existing read-only export API", async () => {
  const { record, plan } = publicEvidenceExportFixture();
  record.plans.push({
    ...structuredClone(plan),
    id: "22222222-2222-4222-8222-222222222222",
    version: 2,
    content: { ...plan.content, title: "OTHER_VERSION" },
  });
  const before = JSON.stringify(record);
  const get = vi.fn(() => structuredClone(record));
  getStore.mockReturnValue({ get, isPlanCurrent: () => false });
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("No network"));
  try {
    for (const format of ["md", "docx"]) {
      const response = await GET(
        new Request(
          `http://127.0.0.1:3000/api/studio/cases/${record.id}/export?planId=${plan.id}&format=${format}`,
        ),
        { params: Promise.resolve({ caseId: record.id }) },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const text =
        format === "md"
          ? await response.text()
          : (await mammoth.extractRawText({ buffer: Buffer.from(await response.arrayBuffer()) }))
              .value;
      expect(text).toContain(PUBLIC_EVIDENCE_EXPORT_TITLE);
      expect(text).not.toContain("OTHER_VERSION");
    }
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(record)).toBe(before);
  } finally {
    network.mockRestore();
  }
});
