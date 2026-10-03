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

describe("보고서용 다운로드 서식", () => {
  it("표지와 목차를 별도 쪽으로 두고 본문 근거 번호를 부록 인용에 연결한다", async () => {
    const { record, plan } = fixture();
    plan.content.sections.push({
      key: "market",
      title: "고객 검증",
      content: "현재는 면담 계획입니다.",
      needsConfirmation: false,
      evidence: [
        { sourceId: "profile-company", locator: "입력 항목", quote: "고객\t조건\n확인 예정" },
      ],
    });
    const zip = await JSZip.loadAsync(await exportPlanDocx(record, plan, true));
    const document = await zip.file("word/document.xml")!.async("string");
    const tocAnchors = [...document.matchAll(/w:anchor="(section_\d+)"/g)].map((m) => m[1]);
    const bookmarks = [...document.matchAll(/w:name="(section_\d+)"/g)].map((m) => m[1]);
    expect(tocAnchors).toEqual(bookmarks);
    expect(new Set(bookmarks).size).toBe(8);
    expect(document.match(/<w:pageBreakBefore\/>/g)).toHaveLength(3);
    expect(document).toContain("<w:titlePg/>");
    expect(document).toContain("<w:tblHeader/>");
    expect(document).toContain('<w:gridCol w:w="850"/>');
    expect(document).not.toContain("w:trHeight");
    const text = (
      await mammoth.extractRawText({ buffer: await exportPlanDocx(record, plan, true) })
    ).value;
    expect(text).toContain("연결 근거: [1]");
    expect(text).toContain("연결 근거: [2]");
    expect(text.indexOf("현재는 면담 계획입니다.")).toBeLessThan(
      text.indexOf("일부 조건에서 시험했습니다."),
    );
    expect(text).toContain("기업 기본정보");
    expect(text.replace(/\s+/g, " ")).toContain("고객 조건 확인 예정");
  });

  it("입력된 #·XML·관계 문자열은 목차나 명령이 아닌 일반 원문으로 보존한다", async () => {
    const { record, plan } = fixture();
    plan.content.summary = "# 임의 제목\n## 목차 조작\n<w:sectPr/>\nDDE https://example.com";
    plan.content.sections[0].evidence[0].quote = '<w:hyperlink r:id="evil">원문</w:hyperlink>';
    const buffer = await exportPlanDocx(record, plan, true);
    const zip = await JSZip.loadAsync(buffer);
    const document = await zip.file("word/document.xml")!.async("string");
    const text = (await mammoth.extractRawText({ buffer })).value;
    expect(text).toContain("# 임의 제목");
    expect(text).toContain("## 목차 조작");
    expect(text).toContain('<w:hyperlink r:id="evil">원문</w:hyperlink>');
    expect(document.match(/<w:bookmarkStart /g)).toHaveLength(7);
    expect(document).not.toContain('r:id="evil"');
    expect(document).not.toContain("<w:fldSimple");
  });

  it("긴 원고·과제·인용의 모든 문장과 수치를 보존하고 표를 고정 높이로 자르지 않는다", async () => {
    const { record, plan } = fixture();
    const sentences = Array.from(
      { length: 80 },
      (_, i) => `계획 ${i + 1}의 측정값은 3.14이며 금액은 1,000,000원입니다.`,
    ).join(" ");
    plan.content.sections[0].content = sentences;
    plan.content.actionItems = ["조건을 확인합니다. ".repeat(220)];
    plan.content.sections[0].evidence[0].quote = "긴 인용 원문을 보존합니다. ".repeat(80);
    const before = JSON.stringify(record);
    const buffer = await exportPlanDocx(record, plan, false);
    const zip = await JSZip.loadAsync(buffer);
    const document = await zip.file("word/document.xml")!.async("string");
    const text = (await mammoth.extractRawText({ buffer })).value.replace(/\s+/g, " ");
    expect(text).toContain(sentences);
    expect(text).toContain(plan.content.actionItems[0].trim());
    expect(text).toContain(plan.content.sections[0].evidence[0].quote.trim());
    expect(document).not.toContain("<w:tbl>");
    expect(text).toContain("과제 1");
    expect(document).not.toContain("w:trHeight");
    expect(document).not.toContain("<w:cantSplit/>");
    expect(JSON.stringify(record)).toBe(before);
    expect(await exportPlanDocx(record, plan, false)).toEqual(buffer);
  });

  it("문서 상태와 빈 목록을 구분하며 한국시간과 원래 기록 시각을 함께 보존한다", async () => {
    const { record, plan } = fixture();
    plan.content.sections = [];
    plan.content.actionItems = [];
    plan.content.interviewQuestions = [];
    plan.review = [];
    const buffer = await exportPlanDocx(record, plan, true);
    const text = (await mammoth.extractRawText({ buffer })).value;
    expect(text).toContain("2026.10.04 09:00 (한국시간)");
    expect(text).toContain(`작성일 원본: ${plan.generatedAt}`);
    expect(text).toContain(`사용자 검토 확인 원본: ${plan.confirmedAt}`);
    expect(text).toContain("등록된 추가 준비 과제가 없습니다.");
    expect(text).toContain("연결된 근거가 없습니다.");
    expect(text).toContain("사실 확인과 최종 검토는 별도로 필요합니다.");
    plan.generatedAt = "과거 입력 시각";
    expect(
      (await mammoth.extractRawText({ buffer: await exportPlanDocx(record, plan, false) })).value,
    ).toContain("작성일: 과거 입력 시각");
  });
});

describe("모든 Word 원고의 대표·담당자 확인사항", () => {
  async function appendix(
    record: ReturnType<typeof fixture>["record"],
    plan: ReturnType<typeof fixture>["plan"],
  ) {
    const buffer = await exportPlanDocx(record, plan, false);
    const text = (await mammoth.extractRawText({ buffer })).value;
    return text.slice(text.lastIndexOf("부록 1"), text.lastIndexOf("부록 2"));
  }
  it("구체 의견을 우선순위와 본문·조치·이유·원래 자료로 표시하고 원래 번호를 보존한다", async () => {
    const { record, plan } = fixture();
    plan.review.push({
      ...plan.review[0],
      id: "urgent",
      severity: "error",
      message: "사업 범위를 먼저 확정해야 합니다.",
      action: "대상 제품과 사업을 확인하세요.",
      sourceIds: ["profile-company", "missing-original"],
    });
    const text = await appendix(record, plan);
    expect(text).toContain("대표·담당자 확인사항");
    expect(text).toContain("확인 1 · 우선 확인");
    expect(text).toContain("원래 의견 2 · 원래 분류: 오류");
    expect(text).toContain("본문 02 기술 개발 계획");
    expect(text.indexOf("대상 제품과 사업을 확인하세요.")).toBeLessThan(
      text.indexOf("사업 범위를 먼저 확정해야 합니다."),
    );
    expect(text.indexOf("사업 범위를 먼저 확정해야 합니다.")).toBeLessThan(
      text.indexOf("시험 결과를 확인해 주세요."),
    );
    expect(text).toContain("기업 기본정보 · 출처 ID: profile-company");
    expect(text).toContain(
      "삭제되었거나 현재 자료에서 찾을 수 없는 출처 · 출처 ID: missing-original",
    );
    expect(text).toContain("실제 오류가 확정되었거나 사람의 검토가 완료되었다는 뜻은 아닙니다.");
    for (const label of ["해당 본문", "확인할 내용", "확인 이유 · 원래 검토 의견", "확인할 자료"])
      expect(text).toContain(label);
  });
  it("동일한 확인 안내만 묶고 서로 다른 본문·원래 번호와 모든 개별 의견을 남긴다", async () => {
    const { record, plan } = fixture();
    plan.content.sections.push({
      ...structuredClone(plan.content.sections[0]),
      key: "team",
      title: "운영 인력",
    });
    const common = {
      ...plan.review[0],
      category: "confirmation",
      message: "추가 확인 또는 자료 보강이 필요한 항목입니다.",
      action: "담당자에게 확인해 주세요.",
    };
    plan.review = [
      common,
      { ...common, id: "second", sectionKey: "team" },
      {
        ...common,
        id: "detail-a",
        category: "semantic",
        message: "개별 의견은 내용이 같아도 보존합니다.",
      },
      {
        ...common,
        id: "detail-b",
        category: "semantic",
        message: "개별 의견은 내용이 같아도 보존합니다.",
      },
    ];
    const before = JSON.stringify(record);
    const text = await appendix(record, plan);
    expect(text).toContain("공통 안내 1묶음(2건)");
    expect(text.match(/추가 확인 또는 자료 보강이 필요한 항목입니다\./g)).toHaveLength(1);
    expect(text.match(/개별 의견은 내용이 같아도 보존합니다\./g)).toHaveLength(2);
    expect(text).toContain("의견 1: 본문 02 기술 개발 계획");
    expect(text).toContain("의견 2: 본문 03 운영 인력");
    expect(text).toContain("원래 의견 1, 2");
    expect(JSON.stringify(record)).toBe(before);
  });
  it("안내 문구가 같아도 조치·중요도·자료 연결이 다르면 합치지 않는다", async () => {
    const { record, plan } = fixture();
    const common = { ...plan.review[0], category: "confirmation" };
    plan.review = [
      common,
      { ...common, id: "action", action: "별도 계약서 확인" },
      { ...common, id: "priority", severity: "error" },
      { ...common, id: "source", sourceIds: ["profile"] },
    ];
    const text = await appendix(record, plan);
    expect(text).toContain("공통 안내 4묶음(4건)");
    expect(text).toContain("별도 계약서 확인");
    expect(text).toContain("공통 확인 3 · 우선 확인");
    for (let n = 1; n <= 4; n++) expect(text).toContain(`원래 의견 ${n} ·`);
  });
  it("수치 확인과 검토 범위를 구분하고 미지정·과거 항목·삭제 자료를 추측하지 않는다", async () => {
    const { record, plan } = fixture();
    plan.review = [
      {
        ...plan.review[0],
        category: "numeric-evidence",
        message: "인용과 대조할 수치: 3.14%, 1,000,000원",
      },
      {
        ...plan.review[0],
        id: "scope",
        category: "review-scope",
        severity: "info",
        message: "검토 범위를 확인하세요.",
        sectionKey: null,
      },
      { ...plan.review[0], id: "unknown", sectionKey: "old-section<xml>" },
      { ...plan.review[0], id: "summary", sectionKey: "summary" },
    ];
    const text = await appendix(record, plan);
    expect(text).toContain("숫자 자체가 틀렸다고 단정하지 마세요.");
    expect(text).toContain("인용과 대조할 수치: 3.14%, 1,000,000원");
    expect(text).toContain("이 의견을 입증하는지는 원본과 대조해야 합니다.");
    expect(text).toContain("[1] 삭제되었거나 현재 자료에서 찾을 수 없는 출처 · 페이지 2");
    expect(text).toContain("문서 전반 · 대상 항목이 지정되지 않았습니다.");
    expect(text).toContain("현재 원고에서 찾을 수 없는 항목: old-section<xml>");
    expect(text).toContain("본문 01 사업 개요");
    expect(text).toContain("연결된 자료가 지정되지 않았습니다.");
    expect(text.indexOf("범위 안내 1 · 참고")).toBeGreaterThan(text.indexOf("원래 의견 4 ·"));
  });
  it("동일 key의 복수 본문도 모두 안내하고 없는 기본 항목은 한국어 이름으로 표시한다", async () => {
    const { record, plan } = fixture();
    plan.content.sections.push({
      ...structuredClone(plan.content.sections[0]),
      title: "개발 단계",
    });
    plan.review.push({
      ...plan.review[0],
      id: "missing",
      category: "missing-section",
      sectionKey: "team",
    });
    const text = await appendix(record, plan);
    expect(text).toContain("본문 02 기술 개발 계획 / 본문 03 개발 단계");
    expect(text).toContain("현재 원고에서 찾을 수 없는 항목:");
    expect(text).not.toContain("현재 원고에서 찾을 수 없는 항목: team");
  });
  it("회사·선택 버전과 무관하게 기존 Word 내려받기 경로에서 공통 서식을 적용한다", async () => {
    const { record } = fixture();
    record.profile.companyName = "다른 가상 회사";
    getStore.mockReturnValue({ get: () => record, isPlanCurrent: () => true });
    const before = JSON.stringify(record);
    for (const plan of record.plans) {
      const response = await GET(
        new Request(
          `http://127.0.0.1:3000/api/studio/cases/${record.id}/export?planId=${plan.id}&format=docx`,
        ),
        { params: Promise.resolve({ caseId: record.id }) },
      );
      expect(response.status).toBe(200);
      const text = (
        await mammoth.extractRawText({ buffer: Buffer.from(await response.arrayBuffer()) })
      ).value;
      expect(text).toContain(`저장 원고 v${plan.version}`);
      expect(text).toContain("다른 가상 회사");
      expect(text).toContain("대표·담당자 확인사항");
      expect(text).toContain("해당 본문");
      expect(text).not.toContain("사전 검토 결과");
    }
    expect(JSON.stringify(record)).toBe(before);
  });
});
