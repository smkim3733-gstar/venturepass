import JSZip from "jszip";
import {
  sectionDefinitions,
  type BusinessPlan,
  type StudioCase,
  type ReviewFinding,
} from "./studio-schema";

export const PLAN_DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const textWidth = 9638; // A4 with 20 mm side margins, in twips.

// Manuscript input never becomes markup, fields, links, relationships or macros.
function xml(value: string) {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        code >= 0x10000
      );
    })
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function run(text: string) {
  // Extraction tabs are spacing, not Word tab stops that can push quotes off the page.
  return text
    .replaceAll("\t", " ")
    .split(/\r\n|\r|\n/)
    .map(
      (line, index) =>
        `${index ? "<w:r><w:br/></w:r>" : ""}<w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r>`,
    )
    .join("");
}
function paragraph(text: string, style = "Normal", extra = "") {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extra}</w:pPr>${run(text)}</w:p>`;
}
const newPage = "<w:pageBreakBefore/>";

/** Reflow long single-line prose at sentence spaces only; never rewrite its claims. */
function prose(text: string, style = "Normal") {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      const result: string[] = [];
      let pending = "";
      for (const sentence of line.split(/(?<=[.!?。])\s+/u)) {
        if (pending.length >= 220) {
          result.push(paragraph(pending, style));
          pending = "";
        }
        pending += `${pending ? " " : ""}${sentence}`;
      }
      if (pending) result.push(paragraph(pending, style));
      return result;
    })
    .join("");
}
function reviewField(label: string, text: string) {
  // Bold lead-in keeps short fields compact while long explanations still flow across pages.
  const content = prose(text, "ReviewText");
  return content.replace(
    "<w:r>",
    `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xml(label)}: </w:t></w:r><w:r>`,
  );
}
function dateLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${get("year")}.${get("month")}.${get("day")} ${get("hour")}:${get("minute")} (한국시간)`;
}
function heading(text: string, index: number, startPage = false) {
  return `<w:p><w:pPr><w:pStyle w:val="Heading1"/>${startPage ? newPage : ""}</w:pPr><w:bookmarkStart w:id="${index}" w:name="section_${index}"/>${run(text)}<w:bookmarkEnd w:id="${index}"/></w:p>`;
}
function table(headers: string[], rows: string[][], widths: number[]) {
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:color="D9D9D9"/>`)
    .join("");
  const renderRow = (cells: string[], header: boolean, rowIndex: number) =>
    `<w:tr>${header ? "<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>" : "<w:trPr><w:cantSplit/></w:trPr>"}${cells
      .map(
        (text, i) =>
          `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/><w:shd w:fill="${header ? "E8EEF5" : rowIndex % 2 ? "F7F9FB" : "FFFFFF"}"/><w:vAlign w:val="center"/></w:tcPr>${paragraph(text, header ? "TableHeading" : "TableText", i === 0 ? '<w:jc w:val="center"/>' : "")}</w:tc>`,
      )
      .join("")}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${textWidth}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="130" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="130" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${renderRow(headers, true, 0)}${rows.map((row, i) => renderRow(row, false, i)).join("")}</w:tbl>${paragraph("", "TableAfter")}`;
}
function sourceName(record: StudioCase, id: string) {
  return id.startsWith("profile")
    ? "기업 기본정보"
    : (record.sources.find((source) => source.id === id)?.name ??
        "삭제되었거나 현재 자료에서 찾을 수 없는 출처");
}

type ReviewGroup = { findings: { finding: ReviewFinding; number: number }[] };

function reviewLocation(plan: BusinessPlan, key: string | null) {
  const matches = plan.content.sections.flatMap((section, index) =>
    section.key === key ? [`본문 ${String(index + 2).padStart(2, "0")} ${section.title}`] : [],
  );
  if (matches.length) return matches.join(" / ");
  if (key === "summary") return "본문 01 사업 개요";
  if (key === "title") return "표지 · 원고 제목";
  if (key === "actionItems") return "부록 2 추가 준비 과제";
  if (key === "interviewQuestions") return "부록 3 실사 예상 질문";
  if (key === null) return "문서 전반 · 대상 항목이 지정되지 않았습니다.";
  const known = sectionDefinitions.find((section) => section.key === key)?.title;
  return `현재 원고에서 찾을 수 없는 항목: ${known ?? key}`;
}

/** Only identical confirmation notices share a block. Distinct findings never disappear. */
function reviewAppendix(record: StudioCase, plan: BusinessPlan) {
  if (!plan.review.length)
    return paragraph(
      "자동 검토에서 표시된 항목이 없습니다. 사실 확인과 최종 검토는 별도로 필요합니다.",
    );
  const details: ReviewGroup[] = [];
  const common = new Map<string, ReviewGroup>();
  const scope: ReviewGroup[] = [];
  plan.review.forEach((finding, index) => {
    const member = { finding, number: index + 1 };
    if (finding.category === "review-scope" && finding.severity === "info") {
      scope.push({ findings: [member] });
    } else if (finding.category === "confirmation") {
      // Keep different actions, priorities and source bindings separate, even if wording is alike.
      const key = JSON.stringify([
        finding.severity,
        finding.message,
        finding.action,
        finding.sourceIds,
      ]);
      const group = common.get(key) ?? { findings: [] };
      group.findings.push(member);
      common.set(key, group);
    } else details.push({ findings: [member] });
  });
  const result = [
    paragraph(
      "대표·담당자가 원고와 자료를 대조할 때 사용하는 목록입니다. 확인할 내용을 먼저 읽고, 해당 본문과 원본 자료를 함께 확인해 주세요.",
      "ReviewText",
    ),
    paragraph(
      "‘우선 확인’은 원래 분류 ‘오류’, ‘확인 필요’는 ‘주의’에 해당합니다. 실제 오류가 확정되었거나 사람의 검토가 완료되었다는 뜻은 아닙니다.",
      "Secondary",
    ),
    paragraph(
      `원래 검토 의견 ${plan.review.length}건 · 개별 확인 ${details.length}건 · 공통 안내 ${common.size}묶음(${[...common.values()].reduce((n, group) => n + group.findings.length, 0)}건) · 검토 범위 안내 ${scope.length}건`,
      "Secondary",
    ),
  ];
  const renderGroup = (group: ReviewGroup, label: string) => {
    const finding = group.findings[0].finding;
    const priority = { error: "우선 확인", warning: "확인 필요", info: "참고" }[finding.severity];
    const original = { error: "오류", warning: "주의", info: "안내" }[finding.severity];
    result.push(paragraph(`${label} · ${priority}`, "FindingTitle"));
    result.push(
      paragraph(
        `원래 의견 ${group.findings.map((member) => member.number).join(", ")} · 원래 분류: ${original}`,
        "SourceId",
        "<w:keepNext/>",
      ),
    );
    result.push(
      reviewField(
        "해당 본문",
        group.findings
          .map(
            (member) =>
              `${group.findings.length > 1 ? `의견 ${member.number}: ` : ""}${reviewLocation(plan, member.finding.sectionKey)}`,
          )
          .join("\n"),
      ),
    );
    result.push(
      reviewField(
        "확인할 내용",
        finding.action || "별도 조치가 기록되어 있지 않습니다. 아래 의견을 담당자와 확인해 주세요.",
      ),
    );
    result.push(reviewField("확인 이유 · 원래 검토 의견", finding.message));
    if (finding.category === "numeric-evidence")
      result.push(
        paragraph(
          "수치 대조 안내: 인용 범위나 단위·표기 방식 때문에 표시될 수 있습니다. 원본과 산식을 확인하기 전에는 숫자 자체가 틀렸다고 단정하지 마세요.",
          "Secondary",
        ),
      );
    result.push(paragraph("확인할 자료", "ReviewLabel"));
    if (finding.sourceIds.length) {
      for (const id of finding.sourceIds)
        result.push(paragraph(`${sourceName(record, id)} · 출처 ID: ${id}`, "ReviewText"));
    } else {
      const keys = new Set(group.findings.map((member) => member.finding.sectionKey));
      let referenceNumber = 0;
      const references = plan.content.sections.flatMap((section) =>
        section.evidence.flatMap((reference) => {
          referenceNumber += 1;
          return keys.has(section.key)
            ? [
                `[${referenceNumber}] ${sourceName(record, reference.sourceId)} · ${reference.locator || "위치 미지정"}`,
              ]
            : [];
        }),
      );
      if (references.length) {
        result.push(
          paragraph(
            "검토 의견에 별도 자료가 지정되지 않아 해당 본문의 연결 근거를 안내합니다. 이 의견을 입증하는지는 원본과 대조해야 합니다. 인용·출처 ID는 부록 4를 확인하세요.",
            "Secondary",
          ),
        );
        for (const reference of references) result.push(paragraph(reference, "ReviewText"));
      } else
        result.push(
          paragraph(
            "연결된 자료가 지정되지 않았습니다. 위 ‘확인할 내용’에서 요청한 자료의 보유 여부와 원본을 담당자에게 확인해 주세요.",
            "ReviewText",
          ),
        );
    }
  };
  if (details.length) {
    result.push(paragraph("개별 확인사항", "Heading2"));
    const rank = { error: 0, warning: 1, info: 2 };
    details
      .toSorted(
        (a, b) => rank[a.findings[0].finding.severity] - rank[b.findings[0].finding.severity],
      )
      .forEach((group, index) => renderGroup(group, `확인 ${index + 1}`));
  }
  if (common.size) {
    result.push(paragraph("공통 확인 안내", "Heading2"));
    result.push(
      paragraph(
        "같은 확인 이유와 조치가 반복된 의견은 한 번 표시하고, 해당 본문과 원래 의견 번호를 모두 남겼습니다.",
        "Secondary",
      ),
    );
    [...common.values()].forEach((group, index) => renderGroup(group, `공통 확인 ${index + 1}`));
  }
  if (scope.length) {
    result.push(paragraph("검토 범위 안내", "Heading2"));
    scope.forEach((group, index) => renderGroup(group, `범위 안내 ${index + 1}`));
  }
  return result.join("");
}

/** A print report of the selected saved version; export has no write or AI side effects. */
export async function exportPlanDocx(record: StudioCase, plan: BusinessPlan, current: boolean) {
  const sectionTitles = ["사업 개요", ...plan.content.sections.map((section) => section.title)];
  const appendixTitles = [
    "대표·담당자 확인사항",
    "추가 준비 과제",
    "실사 예상 질문",
    "연결 근거",
    "입력자료 목록",
  ];
  const titles = [
    ...sectionTitles.map((title, index) => `${String(index + 1).padStart(2, "0")}  ${title}`),
    ...appendixTitles.map((title, index) => `부록 ${index + 1}  ${title}`),
  ];
  const references = plan.content.sections.flatMap((section, index) =>
    section.evidence.map((reference) => ({
      ...reference,
      sectionIndex: index,
      sectionTitle: section.title,
    })),
  );
  const compactCover = record.profile.companyName.length + plan.content.title.length > 240;
  const body: string[] = [
    paragraph(record.profile.companyName, compactCover ? "CoverCompanyCompact" : "CoverCompany"),
    paragraph("사업계획서", "Title"),
    paragraph(plan.content.title, compactCover ? "SubtitleCompact" : "Subtitle"),
    paragraph(`원고 버전 ${plan.version} · 대표 검토용`, "CoverVersion"),
    paragraph(`작성일: ${dateLabel(plan.generatedAt)}`, "Metadata"),
    paragraph(
      `작성 방식: ${plan.mode === "ai" ? "AI 작성" : plan.mode === "assisted" ? "입력자료 기반 작성 보조 (AI 미사용)" : "사용자 편집"}`,
      "Metadata",
    ),
    paragraph(`작성 근거: 기업 자료 revision ${plan.sourceRevision}`, "Metadata"),
    paragraph(
      `현재 자료와 일치: ${current ? "예" : "아니요 — 자료 또는 아이템 변경 후 재작성 필요"}`,
      "Metadata",
    ),
    paragraph(
      `사용자 검토 확인: ${plan.confirmedAt && current ? dateLabel(plan.confirmedAt) : "미확인"}`,
      "Metadata",
    ),
    paragraph(
      "신청 준비용 작성본입니다. 기관에 접수되거나 심사 통과가 확인된 문서가 아닙니다. 현재 실적과 향후 계획을 구분하고 제출 전 사실 및 근거를 확인해 주세요.",
      "Notice",
    ),
    paragraph("목차", "ContentsTitle", newPage),
    paragraph("항목을 누르면 해당 본문으로 이동합니다.", "Secondary"),
    ...titles.map(
      (title, index) =>
        `<w:p><w:pPr><w:pStyle w:val="Contents"/></w:pPr><w:hyperlink w:anchor="section_${index}" w:history="1">${run(title)}</w:hyperlink></w:p>`,
    ),
    heading(titles[0], 0, true),
    prose(plan.content.summary),
  ];
  plan.content.sections.forEach((section, index) => {
    body.push(heading(titles[index + 1], index + 1));
    if (section.needsConfirmation)
      body.push(paragraph("확인 필요: 내용과 증빙을 검토해 주세요.", "SectionNote"));
    const ids = references.flatMap((reference, i) =>
      reference.sectionIndex === index ? [`[${i + 1}]`] : [],
    );
    if (ids.length)
      body.push(
        paragraph(
          `연결 근거: ${ids.join(" ")} · 부록 4에서 인용과 출처를 확인하세요.`,
          "SectionNote",
        ),
      );
    body.push(prose(section.content));
  });
  const appendixSizes = [
    plan.review.reduce((size, item) => size + item.message.length + item.action.length, 0),
    plan.content.actionItems.join("").length,
    plan.content.interviewQuestions.join("").length,
    references.reduce((size, item) => size + item.quote.length + item.locator.length, 0),
    record.sources.reduce(
      (size, item) => size + item.name.length + item.warnings.join("").length,
      0,
    ),
  ];
  // A short appendix may share a page; do not manufacture almost-empty pages.
  const appendix = (index: number) =>
    heading(
      titles[sectionTitles.length + index],
      sectionTitles.length + index,
      index === 0 || appendixSizes[index - 1] > 1200,
    );
  body.push(appendix(0));
  body.push(reviewAppendix(record, plan));
  body.push(appendix(1));
  if (!plan.content.actionItems.length) {
    body.push(paragraph("등록된 추가 준비 과제가 없습니다."));
  } else if (plan.content.actionItems.some((action) => action.length > 240)) {
    // Long review explanations belong in prose, not multi-page narrative cells.
    plan.content.actionItems.forEach((action, index) => {
      body.push(paragraph(`과제 ${index + 1}`, "FindingTitle"), prose(action));
    });
  } else {
    body.push(
      table(
        ["번호", "준비 과제", "검토 메모"],
        plan.content.actionItems.map((action, index) => [String(index + 1), action, ""]),
        [850, 6200, 2588],
      ),
    );
  }
  body.push(appendix(2));
  if (!plan.content.interviewQuestions.length)
    body.push(paragraph("등록된 실사 예상 질문이 없습니다."));
  plan.content.interviewQuestions.forEach((question, index) =>
    body.push(paragraph(`${index + 1}. ${question}`, "Question")),
  );
  body.push(appendix(3));
  if (!references.length) body.push(paragraph("연결된 근거가 없습니다."));
  plan.content.sections.forEach((section, sectionIndex) => {
    if (!section.evidence.length) return;
    body.push(
      paragraph(`${String(sectionIndex + 2).padStart(2, "0")}  ${section.title}`, "Heading2"),
    );
    references.forEach((reference, i) => {
      if (reference.sectionIndex !== sectionIndex) return;
      body.push(
        paragraph(
          `[${i + 1}] ${sourceName(record, reference.sourceId)} · ${reference.locator || "위치 미지정"}`,
          "EvidenceTitle",
        ),
      );
      body.push(paragraph(`출처 ID: ${reference.sourceId}`, "SourceId", "<w:keepNext/>"));
      body.push(prose(`인용: ${reference.quote}`, "Quote"));
    });
  });
  body.push(appendix(4));
  if (!record.sources.length) body.push(paragraph("현재 등록된 입력자료가 없습니다."));
  record.sources.forEach((source, index) => {
    body.push(paragraph(`${index + 1}. ${source.name}`, "EvidenceTitle"));
    body.push(paragraph(`ID: ${source.id} · 최종 수정: ${source.updatedAt}`, "SourceId"));
    for (const warning of source.warnings)
      body.push(paragraph(`추출 확인사항: ${warning}`, "Secondary"));
  });
  // Preserve exact source timestamps alongside the human-readable cover dates.
  body.push(paragraph("원고 기록", "Heading2"));
  body.push(paragraph(`작성일 원본: ${plan.generatedAt}`, "Secondary", "<w:keepNext/>"));
  if (plan.confirmedAt && current)
    body.push(
      paragraph(`사용자 검토 확인 원본: ${plan.confirmedAt}`, "Secondary", "<w:keepNext/>"),
    );
  body.push(
    paragraph(
      "평가항목과 제출 양식은 신청 시점의 벤처기업확인기관 안내를 확인해 주세요.",
      "Secondary",
      "<w:keepNext/>",
    ),
  );
  body.push(
    paragraph("https://www.smes.go.kr/venturein/institution/requireGuide?rgCd=C", "SourceId"),
  );

  const style = (id: string, size: number, p = "", r = "", name = id) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr>${p}</w:pPr><w:rPr><w:sz w:val="${size}"/>${r}</w:rPr></w:style>`;
  const keep = "<w:keepNext/><w:keepLines/>";
  const styles = `${declaration}<w:styles xmlns:w="${ns}">
    <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="맑은 고딕" w:cs="Malgun Gothic"/><w:sz w:val="22"/><w:color w:val="222222"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:widowControl/><w:snapToGrid w:val="0"/><w:spacing w:after="120" w:line="340" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    ${style("CoverCompanyCompact", 24, '<w:spacing w:before="600" w:after="220"/>', "<w:b/>")}
    ${style("SubtitleCompact", 24, '<w:spacing w:after="260" w:line="310" w:lineRule="auto"/>')}
    ${style("CoverCompany", 28, '<w:spacing w:before="1000" w:after="300"/>', "<w:b/>")}
    ${style("Title", 56, '<w:spacing w:before="0" w:after="320"/>', '<w:b/><w:color w:val="000000"/>')}
    ${style("Subtitle", 28, '<w:spacing w:after="420" w:line="360" w:lineRule="auto"/>')}
    ${style("CoverVersion", 24, '<w:spacing w:after="420"/>', "<w:b/>")}
    ${style("Heading1", 30, `${keep}<w:spacing w:before="360" w:after="180"/><w:outlineLvl w:val="0"/>`, '<w:b/><w:color w:val="17365D"/>', "heading 1")}
    ${style("Heading2", 24, `${keep}<w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/>`, "<w:b/>", "heading 2")}
    ${style("ContentsTitle", 36, `${keep}<w:spacing w:after="300"/>`, "<w:b/>")}
    ${style("Contents", 22, '<w:spacing w:after="130" w:line="300" w:lineRule="auto"/>')}
    ${style("Metadata", 20, '<w:spacing w:after="90" w:line="300" w:lineRule="auto"/>')}
    ${style("Notice", 20, '<w:spacing w:before="160" w:after="160"/>', '<w:b/><w:color w:val="6B4A20"/>')}
    ${style("Secondary", 20, '<w:spacing w:after="120"/>', '<w:color w:val="526273"/>')}
    ${style("SourceId", 18, '<w:spacing w:after="200" w:line="280" w:lineRule="auto"/>', '<w:color w:val="526273"/>')}
    ${style("SectionNote", 20, `${keep}<w:spacing w:after="100"/>`, '<w:color w:val="6B4A20"/>')}
    ${style("FindingTitle", 23, `${keep}<w:spacing w:before="220" w:after="100"/>`, "<w:b/>")}
    ${style("ReviewLabel", 21, `${keep}<w:spacing w:before="140" w:after="50"/>`, "<w:b/>")}
    ${style("ReviewText", 22, '<w:spacing w:after="100" w:line="320" w:lineRule="auto"/>')}
    ${style("EvidenceTitle", 22, `${keep}<w:spacing w:before="160" w:after="80"/>`, "<w:b/>")}
    ${style("Quote", 20, '<w:ind w:left="240"/><w:spacing w:after="80" w:line="320" w:lineRule="auto"/>')}
    ${style("Question", 22, '<w:ind w:left="420" w:hanging="420"/><w:spacing w:after="240"/>')}
    ${style("TableHeading", 20, '<w:spacing w:after="0" w:line="300" w:lineRule="auto"/>', "<w:b/>")}
    ${style("TableText", 21, '<w:spacing w:after="0" w:line="320" w:lineRule="auto"/>')}
    ${style("TableAfter", 4, '<w:spacing w:after="120" w:line="120" w:lineRule="auto"/>')}
    ${style("Header", 18, '<w:spacing w:after="0"/>', '<w:color w:val="667788"/>')}
  </w:styles>`;
  const zip = new JSZip();
  const add = (name: string, content: string) =>
    zip.file(name, content, { date: new Date("2000-01-01T00:00:00Z") });
  const parts = ["styles", "header1", "footer1"];
  add(
    "[Content_Types].xml",
    `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${parts.map((part) => `<Override PartName="/word/${part}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${part.replace("1", "")}+xml"/>`).join("")}</Types>`,
  );
  add(
    "_rels/.rels",
    `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  add(
    "word/_rels/document.xml.rels",
    `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.map((part, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/${part.replace("1", "")}" Target="${part}.xml"/>`).join("")}</Relationships>`,
  );
  add("word/styles.xml", styles);
  add(
    "word/header1.xml",
    `${declaration}<w:hdr xmlns:w="${ns}">${paragraph(`사업계획서 · 원고 v${plan.version} · 대표 검토용`, "Header")}</w:hdr>`,
  );
  add(
    "word/footer1.xml",
    `${declaration}<w:ftr xmlns:w="${ns}"><w:p><w:pPr><w:pStyle w:val="Header"/><w:jc w:val="center"/></w:pPr><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple>${run(" / ")}<w:fldSimple w:instr="NUMPAGES"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`,
  );
  add(
    "word/document.xml",
    `${declaration}<w:document xmlns:w="${ns}" xmlns:r="${rel}"><w:body>${body.join("")}<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="510" w:footer="510" w:gutter="0"/><w:titlePg/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
