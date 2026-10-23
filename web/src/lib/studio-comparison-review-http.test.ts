import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { comparisonReviewExampleData } from "./comparison-review-example-data";
import { storedReviewHeaders, decodeStoredReviewCatalog } from "./studio-comparison-review-catalog";
import {
  createStoredReviewRequest,
  fetchStoredReviewCatalog,
} from "./studio-comparison-review-http";
const data = comparisonReviewExampleData(),
  company = data.frame.snapshot;
function catalog() {
  const p = data.result.historical.prepared;
  return {
    source: "comparison-stored-catalog",
    companyId: company.id,
    companyRevision: company.revision,
    currentContextVerified: false,
    runtimeObserved: false,
    authority: data.result.authority,
    reviews: [
      {
        ...data.result.resultIdentity,
        sectionKey: p.input.section.key,
        sectionTitle: p.input.section.title,
        claimQuote: p.input.claimQuote,
      },
    ],
  };
}
afterEach(() => vi.unstubAllGlobals());
it("catalog validates company, revision, source identity and duplicate runs", () => {
  expect(decodeStoredReviewCatalog(catalog(), company).reviews).toHaveLength(1);
  for (const edit of [
    (c: ReturnType<typeof catalog>) => c.companyRevision++,
    (c: ReturnType<typeof catalog>) => c.reviews.push(c.reviews[0]),
    (c: ReturnType<typeof catalog>) =>
      (c.reviews[0].selection.companyId = "00000000-0000-4000-8000-000000000000"),
    (c: ReturnType<typeof catalog>) => (c.reviews[0].preparationDigest = "a".repeat(64)),
  ]) {
    const value = structuredClone(catalog());
    edit(value);
    expect(() => decodeStoredReviewCatalog(value, company)).toThrow();
  }
});
it("explicit catalog fetch bounds the response and distinguishes missing configuration", async () => {
  const fetcher = vi.fn(async () => Response.json(catalog()));
  vi.stubGlobal("fetch", fetcher);
  expect((await fetchStoredReviewCatalog(company, new AbortController().signal)).companyId).toBe(
    company.id,
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(Response.json({ code: "NOT_CONFIGURED" }, { status: 503 }));
  await expect(fetchStoredReviewCatalog(company, new AbortController().signal)).rejects.toThrow(
    "NOT_CONFIGURED",
  );
  fetcher.mockResolvedValueOnce(new Response(" ".repeat(4 * 1024 * 1024 + 1)));
  await expect(fetchStoredReviewCatalog(company, new AbortController().signal)).rejects.toThrow(
    "CATALOG_LIMIT",
  );
});
it("stored request captures selection and revision and requires a complete cleanup receipt", async () => {
  const fetcher = vi.fn(
    async () => new Response("{}", { headers: { [storedReviewHeaders.receipt]: "complete" } }),
  );
  const snapshot = { ...company },
    start = createStoredReviewRequest("http://127.0.0.1:3000", snapshot, data.query, fetcher);
  snapshot.revision++;
  const operation = start(data.query, new AbortController().signal);
  await operation.response;
  await operation.completion;
  expect(operation.inspect().cleanupFailed).toBe(false);
  expect(fetcher.mock.calls[0]).toBeDefined();
  expect(fetcher).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      headers: expect.objectContaining({
        [storedReviewHeaders.revision]: String(company.revision),
        [storedReviewHeaders.run]: data.query.runId,
      }),
    }),
  );
  fetcher.mockResolvedValueOnce(new Response("{}"));
  const unknown = start(data.query, new AbortController().signal);
  await unknown.completion;
  expect(unknown.inspect().cleanupFailed).toBe(true);
  expect(() =>
    start({ ...data.query, mode: "inspect-current" }, new AbortController().signal),
  ).toThrow();
});
