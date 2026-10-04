import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createPublicResearchService } from "./studio-public-research-service";
import {
  publicResearchCandidateFields,
  publicResearchTableUrl,
  readPublicResearchResult,
} from "./studio-public-research-result";
import { POST } from "@/app/api/studio/public-research/search/route";
import { PublicResearchLinks } from "@/components/studio/public-research-links";
vi.mock("server-only", () => ({}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const now = "2026-10-05T02:00:00.000Z";
const row = {
  ORG_ID: "101",
  ORG_NM: "합성 제공기관",
  TBL_ID: "DT_TEST",
  TBL_NM: "합성 통계표",
  STRT_PRD_DE: "202301",
  END_PRD_DE: "202412",
  LINK_URL: "http://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=DT_TEST&secret=UNWANTED#fragment",
  CONTENTS: "untrusted body must not be included",
  ITEM03: "untrusted notes",
  QUERY: "untrusted echo",
};
function setup(
  fetcher: typeof fetch = vi.fn(async () => Response.json([row])),
  key: string | undefined = "synthetic-test-key",
) {
  const fetch = vi.fn(fetcher);
  return {
    fetch,
    search: createPublicResearchService({ apiKey: () => key, fetch, now: () => now }),
  };
}
function request(body: unknown = { topic: "services" }, extra: RequestInit = {}, suffix = "") {
  return new Request(`http://127.0.0.1:3000/api/studio/public-research/search${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    body: JSON.stringify(body),
    ...extra,
  });
}
it("sends only the fixed topic and server key once, strips untrusted content, and separates dates", async () => {
  const s = setup();
  const result = await s.search({ topic: "services" });
  expect(s.fetch).toHaveBeenCalledTimes(1);
  const [url, options] = s.fetch.mock.calls[0];
  const u = new URL(String(url));
  expect(u.origin + u.pathname).toBe("https://kosis.kr/openapi/statisticsSearch.do");
  expect(Object.fromEntries(u.searchParams)).toEqual({
    method: "getList",
    apiKey: "synthetic-test-key",
    searchNm: "서비스업",
    format: "json",
    content: "json",
    sort: "RANK",
    startCount: "1",
    resultCount: "10",
  });
  expect(options).toMatchObject({
    method: "GET",
    redirect: "error",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" },
  });
  expect(result).toMatchObject({
    query: "서비스업",
    retrievedAt: now,
    originalRead: false,
    databaseChanged: false,
    pageSize: 10,
  });
  expect(result.candidates[0]).toEqual({
    organizationId: "101",
    tableId: "DT_TEST",
    title: row.TBL_NM,
    organization: row.ORG_NM,
    periodStart: "202301",
    periodEnd: "202412",
    originalUrl: "https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=DT_TEST",
  });
  expect(JSON.stringify(result)).not.toMatch(
    /synthetic-test-key|untrusted|UNWANTED|readOn|publishedOn/,
  );
});
it.each([undefined, "", "  "])(
  "reports missing configuration without fetching (%s)",
  async (key) => {
    const fetch = vi.fn();
    const s = createPublicResearchService({ apiKey: () => key, fetch, now: () => now });
    expect(await s({ topic: "services" })).toMatchObject({
      status: "not-configured",
      retrievedAt: null,
      candidates: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([
  { topic: "PRIVATE_COMPANY" },
  { topic: "services", company: "private" },
  { topic: "services", query: "private" },
  { topic: "services", apiKey: "caller-key" },
  { topic: "__proto__" },
])("rejects private or extra input before network %j", async (input) => {
  const s = setup();
  await expect(s.search(input)).rejects.toThrow();
  expect(s.fetch).not.toHaveBeenCalled();
});
it.each([
  "https://evil.invalid/statHtml/statHtml.do?orgId=101&tblId=DT_TEST",
  "https://kosis.kr.evil.invalid/statHtml/statHtml.do?orgId=101&tblId=DT_TEST",
  "https://name:password@kosis.kr/statHtml/statHtml.do?orgId=101&tblId=DT_TEST",
  "https://kosis.kr/search/search.do?orgId=101&tblId=DT_TEST",
  "https://kosis.kr/statHtml/statHtml.do?orgId=101&tblId=OTHER",
  "https://kosis.kr/statHtml/statHtml.do?orgId=101&orgId=101&tblId=DT_TEST",
  "javascript:alert(1)",
])("keeps a candidate but removes unsafe or mismatched link %s", async (LINK_URL) => {
  const s = setup(vi.fn(async () => Response.json([{ ...row, LINK_URL }])));
  const r = await s.search({ topic: "services" });
  expect(r.candidates[0].originalUrl).toBeNull();
  expect(() => publicResearchCandidateFields(r.candidates[0])).toThrow();
  expect(s.fetch).toHaveBeenCalledTimes(1);
});
it("copies only exact title and canonical URL; never dates, body or review state", async () => {
  const r = await setup().search({ topic: "services" });
  const before = JSON.stringify(r);
  expect(publicResearchCandidateFields(r.candidates[0])).toEqual({
    title: row.TBL_NM,
    url: r.candidates[0].originalUrl,
  });
  expect(() =>
    publicResearchCandidateFields({ ...r.candidates[0], title: "a".repeat(121) }),
  ).toThrow();
  expect(JSON.stringify(r)).toBe(before);
  expect(publicResearchTableUrl(row.LINK_URL, "OTHER", row.TBL_ID)).toBeNull();
});
it("treats an empty array as no candidates, not missing facts", async () => {
  const r = await setup(vi.fn(async () => Response.json([]))).search({ topic: "services" });
  expect(r.status).toBe("results");
  expect(r.candidates).toEqual([]);
  expect(r.originalRead).toBe(false);
});
it.each([
  { err: "20", errMsg: "upstream secret" },
  [{ ...row, TBL_NM: null }],
  [row, row],
  Array.from({ length: 11 }, (_, i) => ({ ...row, TBL_ID: `DT_${i}` })),
])("rejects invalid, duplicate or excess result without pretending empty %j", async (body) => {
  const s = setup(vi.fn(async () => Response.json(body)));
  await expect(s.search({ topic: "services" })).rejects.toMatchObject({
    code: "PUBLIC_RESEARCH_UNAVAILABLE",
  });
  expect(s.fetch).toHaveBeenCalledTimes(1);
});
it.each([429, 302, 500])(
  "does not retry provider status %s or leak upstream errors",
  async (status) => {
    const s = setup(
      vi.fn(async () => new Response("synthetic-test-key upstream secret", { status })),
    );
    await expect(s.search({ topic: "services" })).rejects.toThrow(
      "공개 검색 결과를 확인하지 못했습니다",
    );
    expect(s.fetch).toHaveBeenCalledTimes(1);
  },
);
it("rejects oversized streamed bytes without silent truncation", async () => {
  const canceled = vi.fn();
  const s = setup(
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(512 * 1024 + 1));
            },
            cancel: canceled,
          }),
        ),
    ),
  );
  await expect(s.search({ topic: "services" })).rejects.toMatchObject({
    code: "PUBLIC_RESEARCH_UNAVAILABLE",
  });
  expect(canceled).toHaveBeenCalledOnce();
});
it("limits declared length and rejects malformed JSON without returning upstream text", async () => {
  for (const response of [
    new Response("[]", { headers: { "content-length": "524289" } }),
    new Response("secret not json"),
  ]) {
    await expect(
      setup(vi.fn(async () => response)).search({ topic: "services" }),
    ).rejects.toMatchObject({ code: "PUBLIC_RESEARCH_UNAVAILABLE" });
  }
});
it("allows one in-flight public read per service, then allows an explicit later lookup", async () => {
  let resolve!: (r: Response) => void;
  const s = setup(
    vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  );
  const pending = s.search({ topic: "services" });
  await expect(s.search({ topic: "manufacturing" })).rejects.toMatchObject({
    code: "PUBLIC_RESEARCH_BUSY",
  });
  expect(s.fetch).toHaveBeenCalledOnce();
  resolve(Response.json([row]));
  await pending;
  const next = s.search({ topic: "services" });
  resolve(Response.json([]));
  await next;
  expect(s.fetch).toHaveBeenCalledTimes(2);
});
it("aborts at 20 seconds and releases the read lock with no retry", async () => {
  vi.useFakeTimers();
  const s = setup(
    vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(Error("secret")));
        }),
    ),
  );
  const pending = expect(s.search({ topic: "services" })).rejects.toMatchObject({
    code: "PUBLIC_RESEARCH_UNAVAILABLE",
  });
  await vi.advanceTimersByTimeAsync(20_000);
  await pending;
  expect(s.fetch).toHaveBeenCalledOnce();
});
it("does not dispatch an already aborted request", async () => {
  const s = setup();
  await expect(s.search({ topic: "services" }, AbortSignal.abort())).rejects.toThrow();
  expect(s.fetch).not.toHaveBeenCalled();
});
it("rejects wrong topic, altered links and extra response fields in the browser", async () => {
  const result = await setup().search({ topic: "services" });
  expect(() => readPublicResearchResult(result, "manufacturing")).toThrow();
  expect(() => readPublicResearchResult({ ...result, reviewed: true }, "services")).toThrow();
  expect(() =>
    readPublicResearchResult(
      { ...result, candidates: [{ ...result.candidates[0], originalUrl: row.LINK_URL }] },
      "services",
    ),
  ).toThrow();
});
it("serves keyless unavailable and configured results with private headers without company context", async () => {
  vi.stubEnv("KOSIS_API_KEY", "");
  const fetch = vi.fn(async () => Response.json([row]));
  vi.stubGlobal("fetch", fetch);
  const missing = await POST(request());
  expect(missing.status).toBe(200);
  expect((await missing.json()).status).toBe("not-configured");
  expect(fetch).not.toHaveBeenCalled();
  vi.stubEnv("KOSIS_API_KEY", "synthetic-test-key");
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(readPublicResearchResult(await response.json(), "services").candidates).toHaveLength(1);
  expect(fetch).toHaveBeenCalledOnce();
});
it("blocks foreign origin, query, wrong content type, extra fields and oversized local body before fetch", async () => {
  vi.stubEnv("KOSIS_API_KEY", "synthetic-test-key");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const inputs: [Request, number][] = [
    [
      request(undefined, {
        headers: { origin: "https://evil.invalid", "content-type": "application/json" },
      }),
      403,
    ],
    [request(undefined, {}, "?q=private"), 400],
    [request(undefined, { headers: { "content-type": "text/plain" } }), 415],
    [request({ topic: "services", company: "private" }), 400],
    [request({ topic: "a".repeat(1024) }), 413],
  ];
  for (const [req, status] of inputs) expect((await POST(req)).status).toBe(status);
  expect(fetch).not.toHaveBeenCalled();
});
it("SSR performs no lookup and renders no API key, candidate or external link before selection", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const html = renderToStaticMarkup(createElement(PublicResearchLinks, { disabled: false }));
  expect(fetch).not.toHaveBeenCalled();
  expect(html).not.toContain("href=");
  expect(html).not.toContain("KOSIS_API_KEY");
});
