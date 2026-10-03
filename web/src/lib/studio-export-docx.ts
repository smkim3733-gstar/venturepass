import JSZip from "jszip";
import { exportPlanMarkdown } from "./studio-export";
import type { BusinessPlan, StudioCase } from "./studio-schema";

export const PLAN_DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// Text stays text: no HTML, external relationships, fields or macros from manuscript input.
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
function paragraph(text: string, style = "Normal", extra = "") {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extra}</w:pPr><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}
const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/** Readable rendering of the same saved manuscript and review/currentness facts as Markdown. */
export async function exportPlanDocx(record: StudioCase, plan: BusinessPlan, current: boolean) {
  const lines = exportPlanMarkdown(record, plan, current).split("\n");
  const body: string[] = [];
  let firstSection = true;
  let cover = true;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("# ")) {
      body.push(paragraph(line.slice(2), "Title"));
      continue;
    }
    if (line.startsWith("## ")) {
      if (firstSection) {
        body.push(paragraph("목차", "ContentsTitle"));
        for (const heading of lines.filter((entry) => entry.startsWith("## ")))
          body.push(paragraph(heading.slice(3), "Contents"));
        body.push(pageBreak);
        firstSection = false;
        cover = false;
      }
      body.push(paragraph(line.slice(3), "Heading1"));
    } else if (line.startsWith("### ")) {
      body.push(paragraph(line.slice(4), "Heading2"));
    } else if (line.startsWith("> ")) {
      body.push(paragraph(line.slice(2), "Notice"));
    } else if (line.startsWith("**확인 필요:**")) {
      body.push(paragraph(line.replace("**확인 필요:**", "확인 필요:"), "Notice"));
    } else if (line.startsWith("- [ ] ")) {
      body.push(paragraph(`☐ ${line.slice(6)}`, "ListParagraph"));
    } else if (/^\s*- /.test(line)) {
      const nested = line.startsWith("  ");
      body.push(
        paragraph(
          line.replace(/^\s*- /, ""),
          nested ? "Quote" : "ListParagraph",
          '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>',
        ),
      );
    } else {
      body.push(paragraph(line, cover ? "Metadata" : "Normal"));
    }
  }
  const styles = `${declaration}<w:styles xmlns:w="${ns}">
    <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="맑은 고딕"/><w:sz w:val="22"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>
      <w:pPrDefault><w:pPr><w:widowControl/><w:snapToGrid w:val="0"/><w:spacing w:after="120" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="500" w:after="360"/></w:pPr><w:rPr><w:b/><w:color w:val="17365D"/><w:sz w:val="40"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:keepLines/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="6" w:color="D3DFEA"/></w:pBdr><w:spacing w:before="300" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="17365D"/><w:sz w:val="30"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="ContentsTitle"><w:name w:val="Contents title"/><w:basedOn w:val="Heading2"/></w:style>
    <w:style w:type="paragraph" w:styleId="Contents"><w:name w:val="Contents entry"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40" w:line="240" w:lineRule="exact"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Metadata"><w:name w:val="Manuscript information"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60" w:line="260" w:lineRule="exact"/></w:pPr><w:rPr><w:color w:val="526273"/><w:sz w:val="20"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="Notice"><w:name w:val="Review notice"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:fill="FFF4DF"/><w:spacing w:before="120" w:after="160"/></w:pPr><w:rPr><w:color w:val="775116"/><w:sz w:val="20"/></w:rPr></w:style>
    <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="100"/><w:ind w:left="300"/></w:pPr></w:style>
    <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="100"/><w:ind w:left="600"/></w:pPr><w:rPr><w:color w:val="526273"/><w:sz w:val="20"/></w:rPr></w:style>
  </w:styles>`;
  const zip = new JSZip();
  const add = (name: string, content: string) =>
    zip.file(name, content, { date: new Date("2000-01-01T00:00:00Z") });
  add(
    "[Content_Types].xml",
    `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
  );
  add(
    "_rels/.rels",
    `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  add(
    "word/_rels/document.xml.rels",
    `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${["styles", "numbering", "header1", "footer1"].map((name, index) => `<Relationship Id="rId${index + 1}" Type="${rel}/${name.replace("1", "")}" Target="${name}.xml"/>`).join("")}</Relationships>`,
  );
  add("word/styles.xml", styles);
  add(
    "word/numbering.xml",
    `${declaration}<w:numbering xmlns:w="${ns}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="300" w:hanging="240"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
  );
  add(
    "word/header1.xml",
    `${declaration}<w:hdr xmlns:w="${ns}">${paragraph(`VenturePass · 사업계획서 v${plan.version} · 검토용`, "Metadata")}</w:hdr>`,
  );
  add(
    "word/footer1.xml",
    `${declaration}<w:ftr xmlns:w="${ns}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`,
  );
  add(
    "word/document.xml",
    `${declaration}<w:document xmlns:w="${ns}" xmlns:r="${rel}"><w:body>${body.join("")}<w:sectPr><w:headerReference w:type="default" r:id="rId3"/><w:footerReference w:type="default" r:id="rId4"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
