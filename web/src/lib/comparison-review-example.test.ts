import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("openai", () => { throw Error("SDK import forbidden"); });
vi.mock("openai/helpers/zod", () => { throw Error("SDK helper forbidden"); });
vi.mock("openai/error", () => { throw Error("SDK errors forbidden"); });
import { comparisonReviewExampleData } from "./comparison-review-example-data";
import { createExampleReviewRequest, exampleRequestMarker, exampleRequestReceipt } from "./comparison-review-example-http";
import { POST } from "../app/api/studio/cases/[caseId]/public-claim-comparison/stored-review/route";
import { decodeComparisonReviewWire } from "./studio-public-claim-comparison-review-wire";
import { createComparisonReviewRetainer } from "./studio-public-claim-comparison-review-retainer";
import { createComparisonReviewScreen } from "./studio-public-claim-comparison-review-screen";

const origin = "http://127.0.0.1:32145", data = comparisonReviewExampleData();
const path = "/api/studio/cases/" + data.frame.snapshot.id + "/public-claim-comparison/stored-review";
function request(options: { company?: string; marker?: string; origin?: string; body?: string; method?: string; type?: string } = {}) {
  const id = options.company ?? data.frame.snapshot.id;
  const req = new Request(origin + path.replace(data.frame.snapshot.id, id), {
    method: options.method ?? "POST", headers: { origin: options.origin ?? origin,
      host: "127.0.0.1:32145", "content-type": options.type ?? "application/json",
      [exampleRequestMarker]: options.marker ?? "1" },
    body: options.body ?? JSON.stringify(data.query),
  });
  return POST(req, { params: Promise.resolve({ caseId: id }) });
}
it("fixed fixture passes strict wire and preserves all false authority boundaries", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get(exampleRequestReceipt)).toBe("complete");
  expect(response.headers.get("cache-control")).toContain("no-store");
  const result = decodeComparisonReviewWire(await response.text(), 200, data.query);
  expect(Object.values(result.authority).every((value) => value === false)).toBe(true);
  expect(result).toMatchObject({ owner: null, runtimeObserved: false,
    historical: { currentContextVerified: false }, current: { status: "not-checked" } });
});
it("fixture copies cannot change later reads or original selection", async () => {
  const altered = comparisonReviewExampleData();
  altered.result.historical.prepared.input.claimQuote = "changed";
  altered.query.runId = "changed";
  expect(comparisonReviewExampleData()).toEqual(data);
  expect((await request()).status).toBe(200);
});
it.each([
  { company: "00000000-0000-4000-8000-000000000000", status: 404 },
  { marker: "0", status: 404 },
  { origin: "https://external.invalid", status: 403 },
  { body: JSON.stringify({ ...data.query, runId: "00000000-0000-4000-8000-000000000000" }), status: 400 },
  { body: JSON.stringify({ ...data.query, extra: "customer" }), status: 400 },
  { body: JSON.stringify(data.query) + " ", status: 400 },
  { body: "x".repeat(8193), status: 413 },
  { type: "text/plain", status: 415 },
])("rejects non-example/unmatched input %# without fallback", async ({ status, ...options }) => {
  expect((await request(options)).status).toBe(status);
});
it("client port is inert until explicit invocation and sends only the fixed query", async () => {
  const fetcher = vi.fn(async () => request());
  const start = createExampleReviewRequest(origin, data.frame.snapshot.id, data.query, fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  const signal = new AbortController().signal, op = start(data.query, signal);
  expect(op.inspect().settled).toBe(false);
  await op.response; await op.completion;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(origin + path, expect.objectContaining({
    method: "POST", body: JSON.stringify(data.query), signal, cache: "no-store", redirect: "error", credentials: "omit" }));
  expect(op.inspect()).toEqual({ started: true, delivered: true, settled: true, cleanupFailed: false });
});
it.each(["https://external.invalid", origin + "/extra"])("client rejects external or non-origin URLs %s", (url) => {
  expect(() => createExampleReviewRequest(url, data.frame.snapshot.id, data.query, vi.fn())).toThrow();
});
it("client rejects a changed selection before HTTP", () => {
  const fetcher = vi.fn();
  const start = createExampleReviewRequest(origin, data.frame.snapshot.id, data.query, fetcher);
  expect(() => start({ ...data.query, mode: "inspect-current" }, new AbortController().signal)).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("missing completion receipt cannot free the original I/O", async () => {
  const fetcher = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
  const op = createExampleReviewRequest(origin, data.frame.snapshot.id, data.query, fetcher)(data.query, new AbortController().signal);
  await op.response; await op.completion;
  expect(op.inspect()).toMatchObject({ settled: true, cleanupFailed: true });
});
it("network rejection has no retry and preserves unknown server cleanup", async () => {
  const fetcher = vi.fn(async () => { throw Error("network"); });
  const op = createExampleReviewRequest(origin, data.frame.snapshot.id, data.query, fetcher)(data.query, new AbortController().signal);
  await expect(op.response).rejects.toThrow("network"); await op.completion;
  expect(op.inspect()).toMatchObject({ settled: true, cleanupFailed: true, delivered: false });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("fixed HTTP receipt connects through the original screen and close clears display", async () => {
  const retainer = createComparisonReviewRetainer(), screen = createComparisonReviewScreen(retainer);
  const token = screen.attachView()!;
  const read = screen.prepare(token, { ...data.frame, signal: new AbortController().signal,
    startRequest: createExampleReviewRequest(origin, data.frame.snapshot.id, data.query, async () => request()) });
  expect(read.ok).toBe(true); if (!read.ok) throw Error();
  const frame = { ...data.frame, latest: read.handle.ticket, mounted: true };
  screen.start(token, read.handle, frame);
  await read.handle.delivery; await read.handle.completion;
  await Promise.resolve(); await Promise.resolve();
  screen.commitFrame(token, read.handle, frame);
  expect(screen.selectDisplay(token, frame)?.kind).toBe("result");
  screen.close();
  expect(screen.selectDisplay(token, frame)).toBeNull();
  expect(retainer.inspect().occupied).toBe(false);
});
it("unknown HTTP cleanup remains occupied after close", async () => {
  const retainer = createComparisonReviewRetainer(), screen = createComparisonReviewScreen(retainer);
  const token = screen.attachView()!;
  const read = screen.prepare(token, { ...data.frame, signal: new AbortController().signal,
    startRequest: createExampleReviewRequest(origin, data.frame.snapshot.id, data.query,
      async () => new Response("{}", { headers: { "content-type": "application/json" } })) });
  if (!read.ok) throw Error();
  screen.start(token, read.handle, { ...data.frame, latest: read.handle.ticket, mounted: true });
  await read.handle.delivery; await read.handle.completion;
  screen.close();
  expect(retainer.inspect()).toMatchObject({ occupied: true, closed: true });
});

it("accepts Next-style tracking proxies without weakening the native handler", async () => {
  const native = new Request(origin + path, { method: "POST",
    headers: { origin, "content-type": "application/json", [exampleRequestMarker]: "1" },
    body: JSON.stringify(data.query) });
  const proxy = new Proxy(native, { get(target, property) {
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const response = await POST(proxy, { params: Promise.resolve({ caseId: data.frame.snapshot.id }) });
  expect(response.status).toBe(200);
  expect(response.headers.get(exampleRequestReceipt)).toBe("complete");
  expect(decodeComparisonReviewWire(await response.text(), 200, data.query).resultIdentity.runId).toBe(data.query.runId);
});
