import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const open = vi.hoisted(() => vi.fn());
vi.mock("./studio-public-claim-comparison-database-v11", () => ({
  openPublicComparisonStoredReader: open,
}));
const forbidden = vi.hoisted(() =>
  vi.fn(() => {
    throw Error("external IO forbidden");
  }),
);
vi.mock("node:sqlite", forbidden);
vi.mock("openai", forbidden);
vi.mock("openai/helpers/zod", forbidden);
import {
  createOwnedComparisonReviewServer,
  createCompanyComparisonReviewServer,
} from "./studio-public-claim-comparison-review-owned-server";
import { comparisonReviewTestFixture } from "./studio-public-claim-comparison-review-test-helpers";
import { decodeComparisonReviewWire } from "./studio-public-claim-comparison-review-wire";

const f = comparisonReviewTestFixture(),
  origin = "http://127.0.0.1:3000";
const binding = () =>
  ({
    paths: { dataRoot: "synthetic-root" },
    selection: { scopeId: "synthetic-scope" },
    companyGuard: { kind: "comparison-company-guard" },
    companyId: f.prepared.selection.companyId,
    ...f.query,
    localOrigin: origin,
  }) as unknown as Parameters<typeof createOwnedComparisonReviewServer>[0];
function request(body: BodyInit = JSON.stringify(f.query), extra: RequestInit = {}) {
  return new Request(
    origin +
      "/api/studio/cases/" +
      f.prepared.selection.companyId +
      "/public-claim-comparison/stored-review",
    {
      method: "POST",
      headers: { origin, host: "127.0.0.1:3000", "content-type": "application/json" },
      body,
      ...extra,
      duplex: "half",
    } as RequestInit,
  );
}
const fixture = () => {
  let cleanupRequired = false;
  const reader = {
    listStoredReviews: vi.fn(() => ({
      source: "comparison-stored-catalog" as const,
      companyId: f.prepared.selection.companyId,
      companyRevision: f.prepared.selection.companyRevision,
      reviews: [
        {
          ...f.value().resultIdentity,
          sectionKey: f.prepared.input.section.key,
          sectionTitle: f.prepared.input.section.title,
          claimQuote: f.prepared.input.claimQuote,
        },
      ],
      currentContextVerified: false as const,
      runtimeObserved: false as const,
      authority: f.value().authority,
    })),
    readStoredReviewByRun: vi.fn(() => ({
      ...f.value(),
      source: "comparison-stored-review" as const,
    })),
    inspect: vi.fn(() => ({ cleanupRequired })),
    close: vi.fn(() => {
      cleanupRequired = false;
      return { status: "closed" };
    }),
  };
  open.mockReturnValue(reader);
  return {
    reader,
    requireCleanup: () => {
      cleanupRequired = true;
    },
  };
};
async function response(
  server: ReturnType<typeof createOwnedComparisonReviewServer>,
  req = request(),
) {
  const operation = server.handle(req),
    value = await operation.response;
  await operation.completion;
  return value;
}
beforeEach(() => vi.stubGlobal("fetch", forbidden));
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  open.mockReset();
});

function companyBinding() {
  const { runId, dispatchCommandDigest, ...rest } = binding();
  void runId;
  void dispatchCommandDigest;
  return { ...rest, companyRevision: f.prepared.selection.companyRevision };
}

it("company catalog requires an explicit audited selection and pins it despite caller mutations", async () => {
  const { reader } = fixture(),
    settings = companyBinding();
  const server = createCompanyComparisonReviewServer(settings);
  settings.companyId = "00000000-0000-4000-8000-000000000000";
  expect(open).not.toHaveBeenCalled();
  const unused = request();
  expect((await response(server, unused)).status).toBe(404);
  expect(unused.bodyUsed).toBe(false);
  expect(open).not.toHaveBeenCalled();
  expect(() => server.select(f.query.runId, f.query.dispatchCommandDigest)).toThrow(
    "SELECTION_MISSING",
  );
  const catalog = server.list();
  expect(reader.listStoredReviews).toHaveBeenCalledExactlyOnceWith({
    companyId: f.prepared.selection.companyId,
    companyRevision: f.prepared.selection.companyRevision,
  });
  catalog.reviews[0].runId = "00000000-0000-4000-8000-000000000000";
  expect(() => server.select(catalog.reviews[0].runId, f.query.dispatchCommandDigest)).toThrow(
    "SELECTION_MISSING",
  );
  const entry = server.select(f.query.runId, f.query.dispatchCommandDigest);
  entry.runId = catalog.reviews[0].runId;
  expect(() => server.list()).toThrow("SELECTION_BLOCKED");
  expect(() => server.select(f.query.runId, f.query.dispatchCommandDigest)).toThrow(
    "SELECTION_BLOCKED",
  );
  expect((await response(server)).status).toBe(200);
  expect(open).toHaveBeenCalledTimes(1);
  expect(reader.readStoredReviewByRun).toHaveBeenCalledExactlyOnceWith(f.query);
  expect(server.close().status).toBe("closed");
});

it("company catalog drops an old selectable list after a failed explicit refresh", () => {
  const { reader } = fixture(),
    server = createCompanyComparisonReviewServer(companyBinding());
  server.list();
  reader.listStoredReviews.mockImplementationOnce(() => {
    throw Error("company changed");
  });
  expect(() => server.list()).toThrow("company changed");
  expect(() => server.select(f.query.runId, f.query.dispatchCommandDigest)).toThrow(
    "SELECTION_MISSING",
  );
  expect(reader.listStoredReviews).toHaveBeenCalledTimes(2);
  server.list();
  expect(server.select(f.query.runId, f.query.dispatchCommandDigest).runId).toBe(f.query.runId);
  server.close();
});

it("company catalog blocks selection on retained cleanup and never substitutes another reader", () => {
  const { reader, requireCleanup } = fixture(),
    server = createCompanyComparisonReviewServer(companyBinding());
  server.list();
  requireCleanup();
  expect(() => server.select(f.query.runId, f.query.dispatchCommandDigest)).toThrow(
    "CLEANUP_REQUIRED",
  );
  expect(() => server.list()).toThrow("CLEANUP_REQUIRED");
  expect(reader.listStoredReviews).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);
  reader.close.mockImplementationOnce(() => {
    throw Error("close failed");
  });
  expect(() => server.close()).toThrow("close failed");
  expect(server.inspect().status).toBe("draining");
  expect(() => server.list()).toThrow("SELECTION_BLOCKED");
  expect(server.close().status).toBe("closed");
  expect(reader.close).toHaveBeenCalledTimes(2);
});

it("company catalog validates trusted company configuration before opening storage", () => {
  fixture();
  expect(() =>
    createCompanyComparisonReviewServer({ ...companyBinding(), companyRevision: -1 }),
  ).toThrow();
  expect(() =>
    createCompanyComparisonReviewServer({ ...companyBinding(), companyId: "invalid" }),
  ).toThrow();
  expect(() =>
    createCompanyComparisonReviewServer({
      ...companyBinding(),
      localOrigin: "https://example.com",
    }),
  ).toThrow();
  expect(open).not.toHaveBeenCalled();
});

it("opens only after a validated request, freezes settings and reuses the same retained reader", async () => {
  const { reader } = fixture(),
    settings = binding();
  const server = createOwnedComparisonReviewServer(settings),
    original = structuredClone(settings.paths);
  settings.paths = { dataRoot: "changed" };
  expect(open).not.toHaveBeenCalled();
  const first = await response(server),
    text = await first.text();
  expect(first.status).toBe(200);
  expect(JSON.parse(text).wireVersion).toBe(2);
  expect(decodeComparisonReviewWire(text, 200, f.query)).toEqual(
    reader.readStoredReviewByRun.mock.results[0].value,
  );
  expect(open).toHaveBeenCalledExactlyOnceWith(original, settings.selection, settings.companyGuard);
  expect((await response(server)).status).toBe(200);
  expect(open).toHaveBeenCalledTimes(1);
  expect(server.close().status).toBe("closed");
  expect(server.close().status).toBe("closed");
  expect(reader.close).toHaveBeenCalledTimes(1);
  const unused = request();
  expect((await response(server, unused)).status).toBe(409);
  expect(unused.bodyUsed).toBe(false);
  expect(reader.readStoredReviewByRun).toHaveBeenCalledTimes(2);
});

it.each(["origin", "selection", "cancelled"])(
  "rejects %s before acquiring any storage",
  async (kind) => {
    fixture();
    const server = createOwnedComparisonReviewServer(binding());
    const controller = new AbortController();
    controller.abort();
    const req =
      kind === "origin"
        ? request(undefined, { headers: { origin: "https://example.invalid" } })
        : kind === "selection"
          ? request(JSON.stringify({ ...f.query, dispatchCommandDigest: "b".repeat(64) }))
          : request(undefined, { signal: controller.signal });
    expect((await response(server, req)).status).not.toBe(200);
    expect(open).not.toHaveBeenCalled();
    expect(server.close().status).toBe("closed");
  },
);

it("an acquisition failure is not retried automatically and the next explicit request can acquire", async () => {
  const { reader } = fixture();
  open.mockImplementationOnce(() => {
    throw Error("private path must not escape");
  });
  const server = createOwnedComparisonReviewServer(binding());
  const failed = await response(server);
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("private path");
  expect(open).toHaveBeenCalledTimes(1);
  expect(server.inspect().readerAcquired).toBe(false);
  expect((await response(server)).status).toBe(200);
  expect(open).toHaveBeenCalledTimes(2);
  server.close();
  expect(reader.close).toHaveBeenCalledTimes(1);
});

it("failed storage cleanup retains the same reader, blocks new reads and retries only explicit close", async () => {
  const f = fixture(),
    server = createOwnedComparisonReviewServer(binding());
  f.reader.readStoredReviewByRun.mockImplementationOnce(() => {
    f.requireCleanup();
    throw Error("PUBLIC_COMPARISON_LEASE_CLEANUP_REQUIRED");
  });
  expect((await response(server)).status).toBe(409);
  expect((await response(server)).status).toBe(409);
  expect(open).toHaveBeenCalledTimes(1);
  expect(f.reader.readStoredReviewByRun).toHaveBeenCalledTimes(1);
  f.reader.close.mockImplementationOnce(() => {
    throw Error("same reader still needs cleanup");
  });
  expect(() => server.close()).toThrow();
  expect(server.inspect()).toMatchObject({
    status: "draining",
    storageCleanupRequired: true,
    readerAcquired: true,
  });
  expect((await response(server)).status).toBe(409);
  expect(server.close()).toMatchObject({ status: "closed", storageCleanupRequired: false });
  expect(open).toHaveBeenCalledTimes(1);
  expect(f.reader.close).toHaveBeenCalledTimes(2);
});

it("close waits for the original request completion and late body completion cannot acquire a reader", async () => {
  fixture();
  const server = createOwnedComparisonReviewServer(binding());
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const operation = server.handle(
    request(
      new ReadableStream({
        start(c) {
          stream = c;
        },
      }),
    ),
  );
  expect(server.inspect().pendingRequests).toBe(1);
  const second = request();
  expect((await response(server, second)).status).toBe(409);
  expect(second.bodyUsed).toBe(false);
  expect(server.close().status).toBe("draining");
  stream.enqueue(new TextEncoder().encode(JSON.stringify(f.query)));
  stream.close();
  expect((await operation.response).status).toBe(409);
  await operation.completion;
  expect(open).not.toHaveBeenCalled();
  expect(server.close().status).toBe("closed");
});

it("retains the original operation after failed body cleanup instead of declaring the server closed", async () => {
  fixture();
  const server = createOwnedComparisonReviewServer(binding()),
    req = request();
  const acquire = req.body!.getReader.bind(req.body);
  let owned!: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>, release!: () => void;
  vi.spyOn(req.body!, "getReader").mockImplementation((...args: unknown[]) => {
    expect(args).toHaveLength(0);
    owned = acquire();
    release = owned.releaseLock.bind(owned);
    vi.spyOn(owned, "releaseLock").mockImplementation(() => {
      throw Error("synthetic release loss");
    });
    return owned;
  });
  try {
    expect((await response(server, req)).status).toBe(500);
    expect(server.close()).toMatchObject({
      status: "draining",
      pendingRequests: 0,
      bodyCleanupRequired: true,
    });
    expect(open).not.toHaveBeenCalled();
    expect((await response(server)).status).toBe(409);
  } finally {
    release();
  }
});
