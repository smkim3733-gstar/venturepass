import type { BusinessPlan, SourceDocument, StudioCase } from "./studio-schema";
import { sectionDefinitions } from "./studio-schema";
import {
  publicEvidenceDraftSchema,
  publicEvidenceText,
  type PublicEvidenceDraft,
} from "./studio-public-evidence";

const opening = "공개 근거 후보 · 담당자가 입력한 발췌 및 출처 기록";
const excerptStart = "[원문 발췌 시작]";
const excerptEnd = "[원문 발췌 끝]";
const relevanceStart = "[담당자의 관련성 메모 · 원문 및 확인된 회사 사실과 구분]";
const conflictsStart = "[담당자의 상충·다른 시점·추가 확인 메모]";
const ending =
  "AI에 사용할 자료 선택과 전송 동의, 수정안 비교·채택, 회사 사실 확인은 별도로 필요합니다.";

/** A strict display reader for the existing manual text format, NOT authenticated provenance.
 * Do not infer metadata from arbitrary URLs/names or change any persisted source/schema. */
export function readManualPublicEvidence(source: SourceDocument): PublicEvidenceDraft | null {
  if (
    source.kind !== "market" ||
    source.extraction !== "manual" ||
    source.originalName !== null ||
    source.mimeType !== null
  )
    return null;
  const text = source.text;
  if (!text.startsWith(opening + "\n")) return null;
  for (const marker of [excerptStart, excerptEnd, relevanceStart, conflictsStart, ending])
    if (text.split(marker).length !== 2) return null;
  const lines = text.split("\n");
  if (lines[11] !== excerptStart) return null;
  const prefixes = [
    "자료 제목: ",
    "원문 URL: ",
    "발행처: ",
    "발행일 (원문 표기): ",
    "자료의 기준 기간·대상: ",
    "담당자가 원문을 읽었다고 기록한 날짜: ",
    "보완할 계획서 항목 (담당자 지정): ",
  ];
  if (prefixes.some((p, i) => !lines[i + 2]?.startsWith(p))) return null;
  const fields = prefixes.map((p, i) => lines[i + 2].slice(p.length));
  const section = sectionDefinitions.find((s) => s.title === fields[6]);
  if (!section) return null;
  const quoteAndNotes = text
    .slice(lines.slice(0, 12).join("\n").length + 1)
    .split(`\n${excerptEnd}\n\n${relevanceStart}\n`);
  if (quoteAndNotes.length !== 2) return null;
  const notes = quoteAndNotes[1].split(`\n${conflictsStart}\n`);
  if (notes.length !== 2 || !notes[1].endsWith("\n" + ending)) return null;
  const conflicts = notes[1].slice(0, -(ending.length + 1));
  const unknown = (s: string) => (s === "미확인" ? "" : s);
  const parsed = publicEvidenceDraftSchema.safeParse({
    title: fields[0],
    url: fields[1],
    publisher: unknown(fields[2]),
    publishedOn: unknown(fields[3]),
    period: unknown(fields[4]),
    readOn: fields[5],
    sectionKey: section.key,
    quote: quoteAndNotes[0],
    relevance: notes[0] === "미기록" ? "" : notes[0],
    conflicts: conflicts === "미기록 · 상충이 없다는 판단은 아님" ? "" : conflicts,
  });
  if (!parsed.success || publicEvidenceText(parsed.data) !== text) return null;
  return parsed.data;
}

export const PUBLIC_EVIDENCE_EXPORT_TITLE = "공개 근거 출처 확인";
export const PUBLIC_EVIDENCE_EXPORT_NOTICE =
  "이 원고가 인용한 공개 후보의 현재 보관 자료를 읽은 표시입니다. 담당자의 수동 기록이며, 원고 작성 당시의 출처 이력이나 사이트·사실·최신성 검증 결과가 아닙니다. 공개 산업 정보는 회사 고유 실적을 증명하지 않습니다.";
export function publicEvidenceExportEntries(
  record: StudioCase,
  plan: BusinessPlan,
  options?: { sourceListIds?: readonly string[] },
) {
  const refs = plan.content.sections.flatMap((section) =>
    section.evidence.map((reference) => ({ ...reference, sectionTitle: section.title })),
  );
  const orderedIds = [...new Set(refs.map((r) => r.sourceId))];
  return orderedIds.flatMap((id) => {
    if (options?.sourceListIds && !options.sourceListIds.includes(id)) return [];
    const matches = record.sources.filter((s) => s.id === id);
    const candidate = matches.some(
      (s) => s.name.startsWith("[공개 근거 후보]") || s.text.startsWith(opening),
    );
    if (!candidate) return [];
    const source = matches.length === 1 ? matches[0] : null;
    const draft = source ? readManualPublicEvidence(source) : null;
    const locations = refs.flatMap((r, i) => (r.sourceId === id ? [{ number: i + 1, ...r }] : []));
    const lines = [
      `출처 ID: ${id}`,
      `연결 인용: ${locations.map((r) => `[${r.number}] ${r.sectionTitle}`).join(" / ")}`,
      `현재 보관 자료 수정 시각: ${source?.updatedAt ?? "동일 ID 자료가 여러 개여서 미확인"}`,
      `원고 작성 근거 revision: ${plan.sourceRevision} · 현재 회사 revision: ${record.revision}`,
      "사이트 원문·회사 해당 여부·시점·사실 확인: 별도 확인 필요",
    ];
    if (draft) {
      lines.push(
        `수동 기록 제목: ${draft.title}`,
        `원문 URL (담당자 입력): ${draft.url}`,
        `발행처 (담당자 입력): ${draft.publisher || "미확인"}`,
        `발행일 (원문 표기 기록): ${draft.publishedOn || "미확인"}`,
        `자료의 기준 기간·대상 (담당자 입력): ${draft.period || "미확인"}`,
        `담당자가 원문을 읽었다고 기록한 날짜: ${draft.readOn}`,
        `보완할 항목 (담당자 지정): ${sectionDefinitions.find((s) => s.key === draft.sectionKey)!.title}`,
      );
      for (const r of locations)
        lines.push(
          `인용 [${r.number}] 문자 대조: ${r.quote.trim() && draft.quote.includes(r.quote) ? "현재 보관 발췌에 같은 문구 있음" : "현재 보관 발췌에서 같은 문구를 찾지 못함"} — 의미·수치·사실 검증은 아님`,
        );
      lines.push(
        `담당자 관련성 메모 (사실과 구분): ${draft.relevance || "미기록"}`,
        `담당자 상충·다른 시점·추가 확인 메모: ${draft.conflicts || "미기록 · 상충이 없다는 판단은 아님"}`,
      );
    } else {
      lines.push(
        "수동 출처 기록의 형식·경계를 확인하지 못했습니다. 제목이나 URL을 추정하지 않습니다. 현재 자료함에서 보관 본문을 직접 확인해 주세요.",
      );
    }
    return [
      {
        sourceId: id,
        title: source?.name ?? "공개 후보 표시가 있는 중복 자료",
        parsed: !!draft,
        lines,
      },
    ];
  });
}
