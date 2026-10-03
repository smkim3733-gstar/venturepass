import JSZip from "jszip";
import mammoth from "mammoth";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { caseSchema, emptyProfile } from "./studio-schema";
import { exportPlanDocx, PLAN_DOCX_MIME } from "./studio-export-docx";
import { exportPlanMarkdown } from "./studio-export";
import { PackagePanel } from "@/components/studio/package-panel";

vi.mock("server-only", () => ({}));
const { getStore } = vi.hoisted(() => ({ getStore: vi.fn() }));
vi.mock("./studio-storage", () => ({ getStudioStore: getStore }));
import { GET } from "@/app/api/studio/cases/[caseId]/export/route";

function fixture() {
  const record = caseSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    profile: { ...emptyProfile(), companyName: "가상 & 검증 기업" },
    plans: [1, 2].map((version) => ({
      id:
        version === 1
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
      version,
      generatedAt: "2026-10-04T00:00:00Z",
      mode: "manual",
      candidateId: "sample",
      sourceRevision: 1,
      confirmedAt: "2026-10-04T01:00:00Z",
      content: {
        title: `저장 원고 v${version}`,
        summary: "가상 자료 기반 요약 <원문> & 계획",
        sections: [
          {
            key: "solution",
            title: "기술 개발 계획",
            content: "실적은 검증 중입니다.\n향후 시험을 진행할 계획입니다.",
            needsConfirmation: true,
            evidence: [
              { sourceId: "missing", locator: "페이지 2", quote: "일부 조건에서 시험했습니다." },
            ],
          },
        ],
        actionItems: ["시험 조건과 성적서 확인"],
        interviewQuestions: ["시험 범위는 어디까지입니까?"],
      },
      review: [
        {
          id: "r",
          severity: "warning",
          category: "evidence",
          message: "시험 결과를 확인해 주세요.",
          action: "근거 보강",
          sourceIds: [],
          sectionKey: "solution",
        },
      ],
    })),
    sources: [],
    analysis: null,
    selectedCandidateId: null,
    tasks: [],
    stage: "drafting",
    revision: 2,
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
  });
  return { record, plan: record.plans[0] };
}

describe("읽기 쉬운 Word 원고", () => {
  it("원문·근거·의견·과제·질문·미확인 상태를 읽을 수 있는 DOCX로 보존한다", async () => {
    const { record, plan } = fixture();
    const original = JSON.stringify(record);
    const buffer = await exportPlanDocx(record, plan, false);
    const extracted = await mammoth.extractRawText({ buffer });
    for (const text of [
      plan.content.title,
      plan.content.summary,
      ...plan.content.sections[0].content.split("\n"),
      "목차",
      "페이지 2",
      "일부 조건에서 시험했습니다.",
      "삭제되었거나",
      "근거 보강",
      "시험 조건과 성적서 확인",
      "시험 범위는 어디까지입니까?",
      "재작성 필요",
      "사용자 검토 확인: 미확인",
    ])
      expect(extracted.value).toContain(text);
    expect(extracted.messages).toEqual([]);
    expect(JSON.stringify(record)).toBe(original);
  });
  it("A4·한글 글꼴·제목 계층·쪽 번호와 안전한 내부 관계만 포함한다", async () => {
    const { record, plan } = fixture();
    plan.content.summary += ' <w:fldSimple w:instr="DDE">\u0001';
    const zip = await JSZip.loadAsync(await exportPlanDocx(record, plan, true));
    const document = await zip.file("word/document.xml")!.async("string");
    expect(document).toContain('w:w="11906"');
    expect(document).toContain('w:pStyle w:val="Heading1"');
    expect(document).toContain("&lt;w:fldSimple w:instr=&quot;DDE&quot;&gt;");
    expect(document).not.toContain("\u0001");
    expect(await zip.file("word/styles.xml")!.async("string")).toContain("맑은 고딕");
    expect(await zip.file("word/footer1.xml")!.async("string")).toContain('w:instr="PAGE"');
    for (const name of Object.keys(zip.files).filter((name) => name.endsWith(".rels")))
      expect(await zip.file(name)!.async("string")).not.toContain('TargetMode="External"');
    expect(Object.keys(zip.files).some((name) => /vba|macro/i.test(name))).toBe(false);
  });
  it("선택한 과거 버전만 내보내며 기존 Markdown 응답과 읽기 전용 동작을 유지한다", async () => {
    const { record, plan } = fixture();
    const store = { get: vi.fn(() => record), isPlanCurrent: vi.fn(() => false) };
    getStore.mockReturnValue(store);
    const context = { params: Promise.resolve({ caseId: record.id }) };
    const base = `http://127.0.0.1:3000/api/studio/cases/${record.id}/export?planId=${plan.id}`;
    const response = await GET(new Request(base + "&format=docx"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(PLAN_DOCX_MIME);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toContain("_v1.docx");
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(Number(response.headers.get("content-length"))).toBe(buffer.length);
    const text = (await mammoth.extractRawText({ buffer })).value;
    expect(text).toContain("저장 원고 v1");
    expect(text).not.toContain("저장 원고 v2");
    expect(await (await GET(new Request(base), context)).text()).toBe(
      exportPlanMarkdown(record, plan, false),
    );
    expect(store.isPlanCurrent).toHaveBeenCalledWith(record.id, plan);
  });
  it("다른 사이트·없는 원고·지원하지 않는 형식은 파일로 내보내지 않는다", async () => {
    const { record } = fixture();
    getStore.mockReturnValue({ get: () => record, isPlanCurrent: () => true });
    const context = { params: Promise.resolve({ caseId: record.id }) };
    const base = `http://127.0.0.1:3000/api/studio/cases/${record.id}/export`;
    expect(
      (
        await GET(
          new Request(base + "?format=docx", { headers: { origin: "https://example.com" } }),
          context,
        )
      ).status,
    ).toBe(403);
    expect((await GET(new Request(base + "?planId=missing&format=docx"), context)).status).toBe(
      404,
    );
    expect((await GET(new Request(base + "?format=exe"), context)).status).toBe(400);
  });
  it("화면에 선택 버전 Word 링크를 표시하고 편집 미저장 때 차단한다", () => {
    const { record, plan } = fixture();
    const props = { company: record, plan, dirty: false, onBusyChange: vi.fn() };
    const html = renderToStaticMarkup(createElement(PackagePanel, props));
    expect(html).toContain("원고 v1 Word 내려받기");
    expect(html).toContain(`planId=${plan.id}&amp;format=docx`);
    const locked = renderToStaticMarkup(createElement(PackagePanel, { ...props, dirty: true }));
    expect(locked).toContain("원고 v1 Word 내려받기");
    expect(locked).not.toContain("format=docx");
  });
});
