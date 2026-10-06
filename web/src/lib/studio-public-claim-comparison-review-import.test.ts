import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() => vi.fn(() => { throw Error("SDK/DB import forbidden"); }));
vi.mock("openai", forbidden);
vi.mock("openai/helpers/zod", forbidden);
vi.mock("node:sqlite", forbidden);
import { encodeStoredComparisonReview } from "./studio-public-claim-comparison-review-server";
it("4I36 encoder import never loads SDK or database modules", async () => {
  const read = vi.fn(() => { throw Error("PUBLIC_COMPARISON_STORED_RESULT_MISSING"); });
  const service = { readStoredReviewByRun: read } as unknown as Parameters<typeof encodeStoredComparisonReview>[0];
  const result = encodeStoredComparisonReview(service, {
    runId: "efc7fb1d-2bf0-4a43-b7ad-eed2a86b4bd8", dispatchCommandDigest: "a".repeat(64), mode: "historical",
  });
  expect(result.status).toBe(404);
  expect(await result.text()).toBe('{"wireVersion":1,"kind":"public-comparison-stored-review-error","code":"RESULT_UNAVAILABLE"}');
  expect(read).toHaveBeenCalledTimes(1); expect(forbidden).not.toHaveBeenCalled();
});
