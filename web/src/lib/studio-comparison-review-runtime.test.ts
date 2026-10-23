import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  path: vi.fn(),
  guard: vi.fn(() => ({ kind: "comparison-company-guard" })),
  record: vi.fn(),
  revoke: vi.fn(),
  close: vi.fn(),
  construct: vi.fn(),
  forbidden: vi.fn(() => {
    throw Error("forbidden IO");
  }),
}));
vi.mock("openai", mocks.forbidden);
vi.mock("openai/helpers/zod", mocks.forbidden);
vi.mock("./studio-storage", mocks.forbidden);
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    isTransaction = false;
    constructor(path: string, options: unknown) {
      mocks.construct(path, options);
    }
    close = mocks.close;
  },
}));
vi.mock("./studio-public-comparison-file-identity", () => ({
  checkComparisonDatabasePath: mocks.path,
}));
vi.mock("./studio-comparison-company-capability", () => ({
  recordComparisonCompanyConnection: mocks.record,
  issueComparisonCompanyGuard: mocks.guard,
  revokeComparisonCompanyGuards: mocks.revoke,
}));
vi.mock("./studio-public-claim-comparison-database-v11", () => ({
  openPublicComparisonStoredReader: mocks.open,
}));
import {
  createStoredComparisonRuntime,
  storedComparisonRoute,
} from "./studio-comparison-review-runtime";
import { comparisonReviewTestFixture } from "./studio-public-claim-comparison-review-test-helpers";
import { storedReviewHeaders } from "./studio-comparison-review-catalog";
const f = comparisonReviewTestFixture(),
  company = {
    companyId: f.prepared.selection.companyId,
    companyRevision: f.prepared.selection.companyRevision,
  };
const origin = "http://127.0.0.1:30333";
const config = {
  dataRoot: "C:/synthetic-data",
  controlDirectory: "C:/synthetic-control",
  selection: {
    databaseInstanceId: f.query.runId,
    environment: "synthetic-test" as const,
    scopeId: "candidate-quality-provider-v2-synthetic" as const,
  },
};
function request(body = JSON.stringify(f.query)) {
  return new Request(
    `${origin}/api/studio/cases/${company.companyId}/public-claim-comparison/stored-review`,
    {
      method: "POST",
      headers: { origin, host: "127.0.0.1:30333", "content-type": "application/json" },
      body,
    },
  );
}
function fixture() {
  const value = { ...f.value(), source: "comparison-stored-review" as const };
  const reader = {
    readCompanyStoredReview: vi.fn(() => value),
    listStoredReviews: vi.fn(() => ({ source: "test-catalog" })),
    close: vi.fn(),
  };
  mocks.open.mockReturnValue(reader);
  vi.stubGlobal("fetch", mocks.forbidden);
  return reader;
}
const review = (runtime: ReturnType<typeof createStoredComparisonRuntime>, req = request()) =>
  runtime.review(
    req,
    company.companyId,
    company.companyRevision,
    origin,
    f.query.runId,
    f.query.dispatchCommandDigest,
  );
afterEach(() => {
  expect(mocks.forbidden).not.toHaveBeenCalled();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("unconfigured app reports unavailable and releases the original request without SQL", async () => {
  fixture();
  const runtime = createStoredComparisonRuntime(null);
  expect(runtime.catalog(company.companyId, company.companyRevision, origin).status).toBe(503);
  const response = await review(runtime);
  expect(response.status).toBe(404);
  expect(response.headers.get(storedReviewHeaders.receipt)).toBe("complete");
  expect(runtime.inspect().retained).toBe(0);
  expect(mocks.construct).not.toHaveBeenCalled();
});
it("canonical body validation precedes any company or quality acquisition", async () => {
  fixture();
  const runtime = createStoredComparisonRuntime(config);
  expect((await review(runtime, request(JSON.stringify(f.query) + " "))).status).toBe(400);
  expect(mocks.construct).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(runtime.inspect().retained).toBe(0);
});
it("configured request reads only existing files and publishes completion after both closes", async () => {
  const reader = fixture(),
    runtime = createStoredComparisonRuntime(config);
  const response = await review(runtime);
  expect(response.status).toBe(200);
  expect(response.headers.get(storedReviewHeaders.receipt)).toBe("complete");
  expect(reader.readCompanyStoredReview).toHaveBeenCalledExactlyOnceWith(f.query, company);
  expect(mocks.construct).toHaveBeenCalledWith(expect.stringContaining("studio.sqlite"), {
    readOnly: true,
  });
  expect(reader.close).toHaveBeenCalledTimes(1);
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.revoke).toHaveBeenCalledTimes(1);
  expect(runtime.inspect().retained).toBe(0);
});
it("catalog response is returned after explicit read cleanup with no persistent connection", () => {
  const reader = fixture(),
    runtime = createStoredComparisonRuntime(config);
  expect(runtime.catalog(company.companyId, company.companyRevision, origin).status).toBe(200);
  expect(reader.listStoredReviews).toHaveBeenCalledExactlyOnceWith(company);
  expect(reader.close).toHaveBeenCalledTimes(1);
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(runtime.inspect().retained).toBe(0);
});
it("failed cleanup retains the exact connection and requires an explicit same-origin retry", async () => {
  const reader = fixture(),
    runtime = createStoredComparisonRuntime(config);
  reader.close.mockImplementationOnce(() => {
    throw Error("close failed");
  });
  const response = await review(runtime);
  expect(response.status).toBe(409);
  expect(response.headers.has(storedReviewHeaders.receipt)).toBe(false);
  expect(runtime.inspect().retained).toBe(1);
  expect(mocks.close).not.toHaveBeenCalled();
  const unused = request();
  expect((await review(runtime, unused)).status).toBe(409);
  expect(unused.bodyUsed).toBe(false);
  expect(runtime.cleanup(company.companyId, "http://localhost:30333").status).toBe(409);
  expect(runtime.cleanup(company.companyId, origin).status).toBe(200);
  expect(mocks.open).toHaveBeenCalledTimes(1);
  expect(runtime.inspect().retained).toBe(0);
});
it("route rejects foreign origins and ambiguous revisions before reading configuration or files", async () => {
  fixture();
  const base = `${origin}/api/studio/cases/${company.companyId}/public-claim-comparison/stored-reviews`;
  for (const query of ["", "?revision=01", "?revision=1&revision=2", "?revision=1&path=secret"]) {
    expect(
      (await storedComparisonRoute(new Request(base + query), company.companyId, "catalog")).status,
    ).toBe(400);
  }
  expect(
    (
      await storedComparisonRoute(
        new Request(base + "?revision=1", { headers: { origin: "https://foreign.invalid" } }),
        company.companyId,
        "catalog",
      )
    ).status,
  ).toBe(403);
  expect(mocks.construct).not.toHaveBeenCalled();
});
it("actual route transfers selection headers and retains cleanup across a configuration change", async () => {
  const reader = fixture();
  vi.stubEnv("VENTURE_DATA_DIR", "C:/synthetic-data");
  vi.stubEnv("VENTUREPASS_COMPARISON_REVIEW_CONTROL_DIR", "C:/synthetic-control");
  vi.stubEnv("VENTUREPASS_COMPARISON_REVIEW_DATABASE_ID", f.query.runId);
  const req = request();
  req.headers.set(storedReviewHeaders.revision, String(company.companyRevision));
  req.headers.set(storedReviewHeaders.run, f.query.runId);
  req.headers.set(storedReviewHeaders.dispatch, f.query.dispatchCommandDigest);
  reader.close.mockImplementationOnce(() => {
    throw Error("retained original cleanup");
  });
  const result = await storedComparisonRoute(req, company.companyId, "review");
  expect(result.status).toBe(409);
  expect(reader.readCompanyStoredReview).toHaveBeenCalledExactlyOnceWith(f.query, company);
  vi.stubEnv("VENTUREPASS_COMPARISON_REVIEW_DATABASE_ID", "changed-invalid-config");
  const base = `${origin}/api/studio/cases/${company.companyId}/public-claim-comparison/stored-reviews`;
  expect(
    (await storedComparisonRoute(new Request(base + "?revision=1"), company.companyId, "catalog"))
      .status,
  ).toBe(400);
  expect(
    (
      await storedComparisonRoute(
        new Request(base, {
          method: "DELETE",
          headers: { origin },
          body: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit),
        company.companyId,
        "catalog",
      )
    ).status,
  ).toBe(200);
  expect(mocks.open).toHaveBeenCalledTimes(1);
  expect(reader.close).toHaveBeenCalledTimes(2);
});
it("cleanup rejects a DELETE payload before releasing the retained owner", async () => {
  fixture();
  const base = `${origin}/api/studio/cases/${company.companyId}/public-claim-comparison/stored-reviews`;
  const req = new Request(base, { method: "DELETE", headers: { origin }, body: "unexpected" });
  const result = await storedComparisonRoute(req, company.companyId, "catalog");
  expect(result.status).toBe(400);
  expect(req.bodyUsed).toBe(true);
  expect(mocks.construct).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
});
