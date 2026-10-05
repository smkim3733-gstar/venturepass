import { z } from "zod";
import { publicResearchTopics, publicStatisticsSearch } from "./studio-public-research";

export const publicResearchIdentifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

const topicSchema = z.enum(publicResearchTopics().map((t) => t.id));
export const publicResearchCommandSchema = z.object({ topic: topicSchema }).strict();
export const publicResearchCandidateSchema = z
  .object({
    organizationId: z.string().min(1).max(40),
    tableId: z.string().min(1).max(40),
    title: z.string().min(1).max(300),
    organization: z.string().max(300),
    periodStart: z.string().max(20),
    periodEnd: z.string().max(20),
    originalUrl: z.string().url().nullable(),
  })
  .strict();
export type PublicResearchCandidate = z.infer<typeof publicResearchCandidateSchema>;
export const publicResearchResultSchema = z
  .object({
    topic: topicSchema,
    query: z.string(),
    provider: z.literal("KOSIS 국가통계포털"),
    status: z.enum(["results", "not-configured"]),
    retrievedAt: z.iso.datetime().nullable(),
    page: z.literal(1),
    pageSize: z.literal(10),
    candidates: z.array(publicResearchCandidateSchema).max(10),
    originalRead: z.literal(false),
    databaseChanged: z.literal(false),
  })
  .strict();
export type PublicResearchResult = z.infer<typeof publicResearchResultSchema>;

/** Only an individual KOSIS table with matching IDs can become a clickable candidate.
 * Rebuild its HTTPS URL: never forward upstream query values, credentials or fragments. */
export function publicResearchTableUrl(raw: string, organizationId: string, tableId: string) {
  try {
    const u = new URL(raw);
    if (
      !/^https?:$/.test(u.protocol) ||
      !["kosis.kr", "www.kosis.kr"].includes(u.hostname) ||
      u.port ||
      u.username ||
      u.password ||
      u.pathname !== "/statHtml/statHtml.do" ||
      u.searchParams.getAll("orgId").length !== 1 ||
      u.searchParams.getAll("tblId").length !== 1 ||
      u.searchParams.get("orgId") !== organizationId ||
      u.searchParams.get("tblId") !== tableId ||
      !publicResearchIdentifierSchema.safeParse(organizationId).success ||
      !publicResearchIdentifierSchema.safeParse(tableId).success
    )
      return null;
    const safe = new URL("https://kosis.kr/statHtml/statHtml.do");
    safe.searchParams.set("orgId", organizationId);
    safe.searchParams.set("tblId", tableId);
    return safe.href;
  } catch {
    return null;
  }
}
export function readPublicResearchResult(raw: unknown, topic: unknown) {
  const expected = publicStatisticsSearch(topic);
  const result = publicResearchResultSchema.parse(raw);
  if (
    result.topic !== expected.topic ||
    result.query !== expected.query ||
    (result.status === "not-configured" && (result.candidates.length || result.retrievedAt)) ||
    (result.status === "results" && !result.retrievedAt)
  )
    throw Error("선택한 주제의 조회 결과가 아닙니다.");
  const seen = new Set<string>();
  for (const c of result.candidates) {
    const id = JSON.stringify([c.organizationId, c.tableId]);
    if (
      seen.has(id) ||
      (c.originalUrl &&
        publicResearchTableUrl(c.originalUrl, c.organizationId, c.tableId) !== c.originalUrl)
    )
      throw Error("공개 검색 후보의 신원을 확인할 수 없습니다.");
    seen.add(id);
  }
  return result;
}
/** Copy only title and URL into an empty pair of fields. No excerpt, dates or review state. */
export function publicResearchCandidateFields(raw: unknown) {
  const c = publicResearchCandidateSchema.parse(raw);
  if (
    !c.originalUrl ||
    publicResearchTableUrl(c.originalUrl, c.organizationId, c.tableId) !== c.originalUrl ||
    c.title.length > 120 ||
    /[\r\n]/.test(c.title)
  )
    throw Error("제목과 원문 주소를 직접 확인해 입력해 주세요.");
  return { title: c.title, url: c.originalUrl };
}
