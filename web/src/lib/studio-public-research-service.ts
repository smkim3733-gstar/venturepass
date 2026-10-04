import "server-only";
import { z } from "zod";
import { StudioError } from "./studio-http";
import { publicStatisticsSearch } from "./studio-public-research";
import {
  publicResearchCommandSchema,
  publicResearchTableUrl,
  readPublicResearchResult,
  type PublicResearchResult,
} from "./studio-public-research-result";

// Official contract: https://kosis.kr/openapi/devGuide/devGuide_0701List.do (2026-10-05).
// This reads search metadata, not statistical values or the linked original document.
const rowSchema = z.object({
  ORG_ID: z.string().min(1).max(40),
  TBL_ID: z.string().min(1).max(40),
  TBL_NM: z.string().min(1).max(300),
  ORG_NM: z.string().max(300),
  STRT_PRD_DE: z.string().max(20).optional(),
  END_PRD_DE: z.string().max(20).optional(),
  LINK_URL: z.string().max(4000),
});
const MAX_BYTES = 512 * 1024;
const fail = () =>
  new StudioError(
    "공개 검색 결과를 확인하지 못했습니다. 원문 검색을 이용하거나 나중에 다시 조회해 주세요.",
    502,
    "PUBLIC_RESEARCH_UNAVAILABLE",
  );
async function readResultBody(response: Response) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    await response.body?.cancel();
    throw fail();
  }
  if (!response.body) throw fail();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw fail();
      parts.push(value);
    }
  } finally {
    // Cancel unread bytes on a rejected body, and release the response in all cases.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function createPublicResearchService(deps: {
  apiKey: () => string | undefined;
  fetch: typeof globalThis.fetch;
  now: () => string;
}) {
  let busy = false;
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
    const key = deps.apiKey()?.trim();
    if (!key) return { ...base, status: "not-configured", candidates: [], retrievedAt: null };
    if (key.length > 1024 || /[\s\u0000-\u001f]/.test(key)) throw fail();
    if (busy)
      throw new StudioError(
        "다른 공개 조회가 진행 중입니다. 완료 후 다시 조회해 주세요.",
        409,
        "PUBLIC_RESEARCH_BUSY",
      );
    if (callerSignal?.aborted) throw fail();
    busy = true;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    callerSignal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 20_000);
    try {
      const url = new URL("https://kosis.kr/openapi/statisticsSearch.do");
      for (const [k, v] of Object.entries({
        method: "getList",
        apiKey: key,
        searchNm: selection.query,
        format: "json",
        content: "json",
        sort: "RANK",
        startCount: "1",
        resultCount: "10",
      }))
        url.searchParams.set(k, v);
      // Never forward local request headers/cookies, company data, arbitrary URLs, or upstream errors.
      const response = await deps.fetch(url, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok || response.redirected) {
        await response.body?.cancel();
        throw fail();
      }
      const rows = z
        .array(rowSchema)
        .max(10)
        .parse(await readResultBody(response));
      if (controller.signal.aborted) throw fail();
      return readPublicResearchResult(
        {
          ...base,
          status: "results",
          retrievedAt: deps.now(),
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
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
      busy = false;
    }
  };
}
export const searchPublicResearch = createPublicResearchService({
  apiKey: () => process.env.KOSIS_API_KEY,
  fetch: (...args) => globalThis.fetch(...args),
  now: () => new Date().toISOString(),
});
