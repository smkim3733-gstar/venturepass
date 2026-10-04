import { z } from "zod";
import { caseSchema, sectionDefinitions, sourceSchema, type StudioCase } from "./studio-schema";
import { MAX_COMPANY_SOURCES, occupiedSourceSlots } from "./studio-source-limits";
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[\r\n\u0000-\u001f]/.test(s), "한 줄로 입력해 주세요.");
const date = z.union([z.literal(""), z.iso.date()]);
export const publicEvidenceDraftSchema = z
  .object({
    title: line(120).refine(Boolean, "자료 제목을 입력해 주세요."),
    url: line(2048).refine((value) => {
      try {
        const u = new URL(value);
        return u.protocol === "https:" && !u.username && !u.password && !!u.hostname;
      } catch {
        return false;
      }
    }, "로그인 정보가 없는 공개 HTTPS 원문 주소를 입력해 주세요."),
    publisher: line(120),
    publishedOn: date,
    period: line(300),
    readOn: z.iso.date(),
    sectionKey: z.enum(sectionDefinitions.map((s) => s.key)),
    quote: z
      .string()
      .min(1)
      .max(50000)
      .refine((s) => !!s.trim(), "원문 발췌를 입력해 주세요."),
    relevance: z.string().max(3000),
    conflicts: z.string().max(3000),
  })
  .strict();
export type PublicEvidenceDraft = z.infer<typeof publicEvidenceDraftSchema>;
export const emptyPublicEvidence: PublicEvidenceDraft = {
  title: "",
  url: "",
  publisher: "",
  publishedOn: "",
  period: "",
  readOn: "",
  sectionKey: "market",
  quote: "",
  relevance: "",
  conflicts: "",
};
export function publicEvidenceText(raw: PublicEvidenceDraft) {
  const d = publicEvidenceDraftSchema.parse(raw);
  return [
    "공개 근거 후보 · 담당자가 입력한 발췌 및 출처 기록",
    "사이트를 자동 조회하거나 사실·최신성·우리 회사 해당 여부를 검증한 결과가 아닙니다.",
    `자료 제목: ${d.title}`,
    `원문 URL: ${d.url}`,
    `발행처: ${d.publisher || "미확인"}`,
    `발행일 (원문 표기): ${d.publishedOn || "미확인"}`,
    `자료의 기준 기간·대상: ${d.period || "미확인"}`,
    `담당자가 원문을 읽었다고 기록한 날짜: ${d.readOn}`,
    `보완할 계획서 항목 (담당자 지정): ${sectionDefinitions.find((s) => s.key === d.sectionKey)!.title}`,
    "공개 시장·산업 정보는 우리 회사의 매출·계약·기술 실적을 증명하지 않습니다.",
    "",
    "[원문 발췌 시작]",
    d.quote,
    "[원문 발췌 끝]",
    "",
    "[담당자의 관련성 메모 · 원문 및 확인된 회사 사실과 구분]",
    d.relevance || "미기록",
    "[담당자의 상충·다른 시점·추가 확인 메모]",
    d.conflicts || "미기록 · 상충이 없다는 판단은 아님",
    "AI에 사용할 자료 선택과 전송 동의, 수정안 비교·채택, 회사 사실 확인은 별도로 필요합니다.",
  ].join("\n");
}
export function preparePublicEvidence(
  company: StudioCase,
  raw: PublicEvidenceDraft,
  id: string,
  now: string,
  confirmed: boolean,
) {
  if (!confirmed) throw Error("발췌와 출처를 후보 자료로 보관하는 내용을 확인해 주세요.");
  if (occupiedSourceSlots(company) >= MAX_COMPANY_SOURCES)
    throw Error("보관 자료와 접수 예약이 100개입니다. 자료함에서 현황을 확인해 주세요.");
  if (
    company.sources.some((s) => s.id === id) ||
    company.sourceIntakes.some((s) => s.sourceId === id)
  )
    throw Error("이미 사용한 자료 식별자입니다.");
  const d = publicEvidenceDraftSchema.parse(raw);
  const source = sourceSchema.parse({
    id,
    name: `[공개 근거 후보] ${d.title}`,
    kind: "market",
    text: publicEvidenceText(d),
    originalName: null,
    mimeType: null,
    extraction: "manual",
    warnings: [],
    createdAt: now,
    updatedAt: now,
  });
  return {
    caseId: company.id,
    command: { action: "source" as const, revision: company.revision, source },
    sectionKey: d.sectionKey,
  };
}
export type PublicEvidenceRequest = ReturnType<typeof preparePublicEvidence>;
/** The existing source writer owns timestamps; acknowledge only the exact new source contents. */
export function publicEvidenceSaved(
  raw: unknown,
  request: PublicEvidenceRequest,
  current?: Pick<StudioCase, "id" | "revision">,
) {
  const c = caseSchema.parse(raw),
    s = request.command.source;
  if (c.id !== request.caseId || c.revision <= request.command.revision) return null;
  if (current && (current.id !== c.id || current.revision > c.revision)) return null;
  const matches = c.sources.filter((item) => item.id === s.id);
  if (matches.length !== 1) return null;
  const actual = matches[0];
  if (
    actual.name !== s.name ||
    actual.kind !== s.kind ||
    actual.text !== s.text ||
    actual.originalName !== null ||
    actual.mimeType !== null ||
    actual.extraction !== "manual"
  )
    return null;
  return c;
}
