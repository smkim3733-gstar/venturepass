import "server-only";
import { z } from "zod";
import { StudioError } from "./studio-http";
import { publicStatisticsSearch } from "./studio-public-research";
import {
  createKosisReadTransport,
  type KosisReadDependencies,
} from "./studio-kosis-read-transport";
import {
  publicResearchCommandSchema,
  publicResearchTableUrl,
  readPublicResearchResult,
  type PublicResearchResult,
  type PublicResearchCandidate,
} from "./studio-public-research-result";

// Official search metadata contract (2026-10-05); not statistical values.
const rowSchema = z.object({
  ORG_ID: z.string().min(1).max(40),
  TBL_ID: z.string().min(1).max(40),
  TBL_NM: z.string().min(1).max(300),
  ORG_NM: z.string().max(300),
  STRT_PRD_DE: z.string().max(20).optional(),
  END_PRD_DE: z.string().max(20).optional(),
  LINK_URL: z.string().max(4000),
});
const fail = () =>
  new StudioError(
    "공개 검색 결과를 확인하지 못했습니다. 원문 검색을 이용하거나 나중에 다시 조회해 주세요.",
    502,
    "PUBLIC_RESEARCH_UNAVAILABLE",
  );
export function createPublicResearchService(deps: KosisReadDependencies) {
  const read = createKosisReadTransport(deps, fail);
  return async function search(
    raw: unknown,
    callerSignal?: AbortSignal,
  ): Promise<PublicResearchResult> {
    const { topic } = publicResearchCommandSchema.parse(raw);
    const selection = publicStatisticsSearch(topic);
    const base = {
      topic,
      query: selection.query,
      provider: selection.provider,
      page: 1 as const,
      pageSize: 10 as const,
      originalRead: false as const,
      databaseChanged: false as const,
    };
    const response = await read(
      "search",
      {
        method: "getList",
        searchNm: selection.query,
        format: "json",
        // Matches the official statisticsSearch URL generator (2026-10-07).
        jsonVD: "Y",
        content: "json",
        sort: "RANK",
        startCount: "1",
        resultCount: "10",
      },
      callerSignal,
    );
    if (response.status === "not-configured")
      return { ...base, status: "not-configured", candidates: [], retrievedAt: null };
    try {
      const rows = z.array(rowSchema).max(10).parse(response.body);
      return readPublicResearchResult(
        {
          ...base,
          status: "results",
          retrievedAt: response.retrievedAt,
          candidates: rows.map((r) => ({
            organizationId: r.ORG_ID,
            tableId: r.TBL_ID,
            title: r.TBL_NM,
            organization: r.ORG_NM,
            periodStart: r.STRT_PRD_DE ?? "",
            periodEnd: r.END_PRD_DE ?? "",
            originalUrl: publicResearchTableUrl(r.LINK_URL, r.ORG_ID, r.TBL_ID),
          })),
        },
        topic,
      );
    } catch {
      throw fail();
    }
  };
}
export const searchPublicResearch = createPublicResearchService({
  apiKey: () => process.env.KOSIS_API_KEY,
  fetch: (...args) => globalThis.fetch(...args),
  now: () => new Date().toISOString(),
});

/** Both explicit table reads require the complete candidate in the fresh bounded search. */
export function requireCurrentPublicTableCandidate(
  current: PublicResearchResult,
  expected: PublicResearchCandidate,
) {
  const candidate = current.candidates.find(
    (c) => c.organizationId === expected.organizationId && c.tableId === expected.tableId,
  );
  if (!candidate || JSON.stringify(candidate) !== JSON.stringify(expected))
    throw new StudioError(
      "검색 후보가 바뀌었거나 선택한 표를 확인할 수 없습니다. 후보를 다시 조회해 주세요.",
      409,
      "PUBLIC_TABLE_SELECTION_CHANGED",
    );
  return candidate;
}
