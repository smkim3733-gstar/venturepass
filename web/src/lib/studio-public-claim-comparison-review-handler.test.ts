import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const forbidden = vi.hoisted(() => vi.fn(() => { throw Error("SDK/store import forbidden"); }));
vi.mock("openai", forbidden);
vi.mock("openai/helpers/zod", forbidden);
vi.mock("node:sqlite", forbidden);
vi.mock("./studio-storage", forbidden);
vi.mock("./studio-plan-quality-provider-production-server", forbidden);
vi.mock("./studio-plan-quality-provider-production-runtime", forbidden);
vi.mock("./studio-plan-quality-provider-production-service", forbidden);
vi.mock("./studio-plan-quality-provider-production-command-service", forbidden);
vi.mock("./studio-plan-quality-store", forbidden);
import { createComparisonReviewRequestHandler } from "./studio-public-claim-comparison-review-handler";
import { createComparisonReviewReceiver } from "./studio-public-claim-comparison-review-receive";
import { comparisonReviewErrorStatus, decodeComparisonReviewWire } from "./studio-public-claim-comparison-review-wire";

const companyId = "90fc6f51-2497-469d-92b8-6b4193565c70";
const query = { runId: "efc7fb1d-2bf0-4a43-b7ad-eed2a86b4bd8", dispatchCommandDigest: "a".repeat(64), mode: "historical" as const };
const origin = "http://127.0.0.1:3000";
const path = "/api/studio/cases/" + companyId + "/public-claim-comparison/stored-review";
const headers = { origin, host: "127.0.0.1:3000", "content-type": "application/json; charset=utf-8" };
function fixture() {
  const read = vi.fn(() => { throw Error("PUBLIC_COMPARISON_STORED_RESULT_MISSING"); });
  const service = { readStoredReviewByRun: read };
  const binding = { ...query, companyId, localOrigin: origin, service };
  return { read, binding, handler: createComparisonReviewRequestHandler(binding) };
}
function req(body: BodyInit | null = JSON.stringify(query), init: RequestInit = {}, url = origin + path) {
  return new Request(url, { method: "POST", headers, body, ...init, duplex: "half" } as RequestInit);
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush() { for (let n = 0; n < 16; n++) await Promise.resolve(); }
async function result(op: ReturnType<ReturnType<typeof createComparisonReviewRequestHandler>["handle"]>, code: keyof typeof comparisonReviewErrorStatus) {
  const r = await op.response;
  expect(r.status).toBe(comparisonReviewErrorStatus[code]);
  expect(r.headers.get("cache-control")).toContain("no-store");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  const text = await r.text();
  expect(text).toBe(JSON.stringify({ wireVersion: 1, kind: "public-comparison-stored-review-error", code }));
  expect(() => decodeComparisonReviewWire(text, r.status, query)).toThrow(expect.objectContaining({ code }));
  return r;
}
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw Error("network forbidden"); })));
afterEach(() => {
  expect(forbidden).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it("4I38 import remains SDK/SQLite/store/production free and reads the fixed service once", async () => {
  const f = fixture(), r = req();
  const bad = vi.fn(() => { throw Error("unbounded"); });
  for (const key of ["json", "text", "arrayBuffer", "clone"] as const) vi.spyOn(r, key).mockImplementation(bad);
  const parse = vi.spyOn(JSON, "parse"), reader = vi.spyOn(r.body!, "getReader");
  const op = f.handler.handle(r);
  const response = await op.response; await op.completion;
  expect(response.status).toBe(404);
  expect(parse.mock.calls.filter(([text]) => text === JSON.stringify(query))).toHaveLength(1);
  expect(reader).toHaveBeenCalledTimes(1); expect(bad).not.toHaveBeenCalled();
  expect(f.read).toHaveBeenCalledExactlyOnceWith(query);
  expect(op.inspect()).toEqual({ started: true, delivered: true, settled: true, cleanupFailed: false });
});

it.each([
  ["missing-origin", { origin: "" }], ["null-origin", { origin: "null" }],
  ["foreign-origin", { origin: "https://example.invalid" }], ["foreign-host", { host: "example.invalid:3000" }],
  ["wrong-port", { host: "127.0.0.1:3001" }], ["forwarded", { "x-forwarded-host": "example.invalid" }],
  ["cross-site", { "sec-fetch-site": "cross-site" }], ["same-site", { "sec-fetch-site": "same-site" }],
] as const)("4I38 rejects local request mismatch %s without invoking service", async (_name, extra) => {
  const f = fixture(), op = f.handler.handle(req(undefined, { headers: { ...headers, ...extra } }));
  await result(op, "LOCAL_ONLY"); await op.completion; expect(f.read).not.toHaveBeenCalled();
});
it.each(["GET", "HEAD", "PUT", "OPTIONS"])("4I38 rejects method %s with fixed Allow", async (method) => {
  const f = fixture(), op = f.handler.handle(req(null, { method }));
  expect((await result(op, "METHOD_NOT_ALLOWED")).headers.get("allow")).toBe("POST");
  await op.completion; expect(f.read).not.toHaveBeenCalled();
});
it.each(["?x=1", "/extra", "#fragment"])("4I38 rejects nonfixed URL %s", async (suffix) => {
  const f = fixture(), op = f.handler.handle(req(undefined, {}, origin + path + suffix));
  await result(op, "INVALID_QUERY"); await op.completion; expect(f.read).not.toHaveBeenCalled();
});
it("4I38 permits the Next loopback URL alias but refuses a different bound origin or company", async () => {
  const f = fixture();
  const ok = f.handler.handle(req(undefined, {}, "http://localhost:3000" + path));
  await result(ok, "RESULT_UNAVAILABLE"); await ok.completion; expect(f.read).toHaveBeenCalledTimes(1);
  for (const r of [
    req(undefined, { headers: { ...headers, host: "localhost:3000", origin: "http://localhost:3000" } }),
    req(undefined, {}, origin + path.replace(companyId, query.runId)),
  ]) {
    const op = f.handler.handle(r); const res = await op.response; expect([400, 403]).toContain(res.status); await op.completion;
  }
  expect(f.read).toHaveBeenCalledTimes(1);
});
it.each([
  ["type", { "content-type": "text/html" }], ["charset", { "content-type": "application/json; charset=latin1" }],
  ["parameter", { "content-type": "application/json; x=y" }], ["encoding", { "content-encoding": "gzip" }],
] as const)("4I38 rejects unsupported body format %s", async (_name, extra) => {
  const f = fixture(), op = f.handler.handle(req(undefined, { headers: { ...headers, ...extra } }));
  await result(op, "CONTENT_TYPE"); await op.completion; expect(f.read).not.toHaveBeenCalled();
});
it.each(["-1", "01", "1.5", "9007199254740992"])("4I38 rejects malformed length %s", async (length) => {
  const f = fixture(), op = f.handler.handle(req(undefined, { headers: { ...headers, "content-length": length } }));
  await result(op, "INVALID_QUERY"); await op.completion; expect(f.read).not.toHaveBeenCalled();
});
it.each([-1, 0, 1])("4I38 counts actual request bytes at cap %+i before decoding", async (offset) => {
  const f = fixture(), parse = vi.spyOn(JSON, "parse");
  const op = f.handler.handle(req(" ".repeat(8192 + offset), { headers: { ...headers, "content-length": "1" } }));
  const r = await op.response; await op.completion;
  expect(r.status).toBe(offset > 0 ? 413 : 400);
  expect(parse).toHaveBeenCalledTimes(offset > 0 ? 0 : 1); expect(f.read).not.toHaveBeenCalled();
});
it("4I38 rejects declared oversize before read and retains cancel completion", async () => {
  const f = fixture(), cancel = deferred<void>(), onCancel = vi.fn(() => cancel.promise);
  const stream = new ReadableStream<Uint8Array>({ cancel: onCancel });
  const op = f.handler.handle(req(stream, { headers: { ...headers, "content-length": "8193" } }));
  await result(op, "TOO_LARGE"); await flush();
  expect(op.inspect().settled).toBe(false); expect(onCancel).toHaveBeenCalledTimes(1);
  cancel.resolve(); await op.completion; expect(f.read).not.toHaveBeenCalled();
});
it.each([
  "", "{}", JSON.stringify(query) + " ", "\ufeff" + JSON.stringify(query),
  JSON.stringify(query).replace('"mode":"historical"', '"mode":"historical","mode":"historical"'),
  JSON.stringify({ ...query, extra: true }), JSON.stringify({ mode: query.mode, runId: query.runId, dispatchCommandDigest: query.dispatchCommandDigest }),
  JSON.stringify({ ...query, runId: companyId }), JSON.stringify({ ...query, dispatchCommandDigest: "b".repeat(64) }),
  JSON.stringify({ ...query, mode: "latest" }),
])("4I38 rejects invalid or noncanonical query %#", async (body) => {
  const f = fixture(), op = f.handler.handle(req(body));
  await result(op, "INVALID_QUERY"); await op.completion; expect(f.read).not.toHaveBeenCalled();
});
it("4I38 strictly decodes split UTF-8 and does not accept malformed bytes or missing body", async () => {
  const f = fixture();
  for (const bytes of [new TextEncoder().encode(JSON.stringify({ ...query, extra: "한글" })), new Uint8Array([0xc3, 0x28])]) {
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } });
    const op = f.handler.handle(req(stream)); await result(op, "INVALID_QUERY"); await op.completion;
  }
  const op = f.handler.handle(req(null)); await result(op, "INVALID_QUERY"); await op.completion; expect(f.read).not.toHaveBeenCalled();
});
it("4I38 absent binding stays unsupported without acquiring a service or leaking input errors", async () => {
  const handler = createComparisonReviewRequestHandler(null), op = handler.handle(req());
  expect(handler.supported).toBe(false); await result(op, "RESULT_UNAVAILABLE"); await op.completion;
});
it("4I38 pins original scalar/header snapshots and ignores subtype getters", async () => {
  const f = fixture(), body = deferred<void>();
  let c!: ReadableStreamDefaultController<Uint8Array>;
  const r = req(new ReadableStream({ start(v) { c = v; }, cancel() { return body.promise; } }));
  Object.defineProperty(r, "url", { get: () => "https://example.invalid" });
  Object.defineProperty(r, "headers", { get: () => new Headers() });
  const op = f.handler.handle(r);
  f.binding.runId = companyId; f.binding.localOrigin = "http://localhost:9000";
  const nativeHeaders = Object.getOwnPropertyDescriptor(Request.prototype, "headers")!.get!.call(r) as Headers;
  nativeHeaders.set("origin", "https://example.invalid");
  c.enqueue(new TextEncoder().encode(JSON.stringify(query))); c.close();
  await result(op, "RESULT_UNAVAILABLE"); await op.completion; expect(f.read).toHaveBeenCalledExactlyOnceWith(query);
});
it("4I38 refuses fake, used and foreign-locked requests without cancelling another reader", async () => {
  const f = fixture();
  const fake = f.handler.handle({} as Request); await result(fake, "INVALID_QUERY"); await fake.completion;
  const used = req(); await used.text(); const u = f.handler.handle(used); await result(u, "INVALID_QUERY"); await u.completion;
  const r = req(), stream = r.body!, reader = stream.getReader(), cancel = vi.spyOn(reader, "cancel"), release = vi.spyOn(reader, "releaseLock");
  const op = f.handler.handle(r); await result(op, "INVALID_QUERY"); await op.completion;
  expect(cancel).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); expect(stream.locked).toBe(true);
  expect(op.inspect().cleanupFailed).toBe(false); await reader.cancel(); reader.releaseLock(); expect(f.read).not.toHaveBeenCalled();
});
it("4I38 pre-abort cancels its unused body and never starts service", async () => {
  const f = fixture(), c = new AbortController(); c.abort();
  const cancel = vi.fn(), op = f.handler.handle(req(new ReadableStream({ cancel }), { signal: c.signal }));
  await result(op, "REQUEST_CANCELLED"); await op.completion; expect(cancel).toHaveBeenCalledTimes(1); expect(f.read).not.toHaveBeenCalled();
});
it.each(["abort", "timeout"])("4I38 fast %s retains pending request read and cancel", async (kind) => {
  vi.useFakeTimers();
  const f = fixture(), c = new AbortController(), pending = deferred<ReadableStreamReadResult<Uint8Array>>(), cancelled = deferred<void>();
  const stream = new ReadableStream<Uint8Array>(), reader = stream.getReader(); reader.releaseLock();
  vi.spyOn(stream, "getReader").mockReturnValue(reader);
  vi.spyOn(reader, "read").mockReturnValue(pending.promise); const cancel = vi.spyOn(reader, "cancel").mockReturnValue(cancelled.promise);
  const op = f.handler.handle(req(stream, { signal: c.signal })); await flush();
  if (kind === "abort") c.abort(); else await vi.advanceTimersByTimeAsync(30000);
  await result(op, kind === "abort" ? "REQUEST_CANCELLED" : "REQUEST_TIMEOUT");
  cancelled.resolve(); await flush(); expect(op.inspect().settled).toBe(false);
  pending.reject(Error("PRIVATE_READ")); await op.completion;
  expect(cancel).toHaveBeenCalledTimes(1); expect(f.read).not.toHaveBeenCalled();
});
it.each(["throw", "reject"])("4I38 records body cancel %s as failed cleanup", async (kind) => {
  const f = fixture(), c = new AbortController();
  const cancel = vi.fn(() => { if (kind === "throw") throw Error("PRIVATE_CANCEL"); return Promise.reject(Error("PRIVATE_CANCEL")); });
  const stream = new ReadableStream<Uint8Array>({ cancel });
  const op = f.handler.handle(req(stream, { signal: c.signal })); c.abort();
  await result(op, "REQUEST_CANCELLED");
  // A throwing stream cancel still completes its original native pending read.
  await op.completion; expect(op.inspect().cleanupFailed).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1); expect(f.read).not.toHaveBeenCalled();
});
it("4I38 refuses service on release or input observer cleanup failure", async () => {
  const f = fixture(), stream = req().body!, get = stream.getReader.bind(stream);
  let restoreRelease!: () => void;
  vi.spyOn(stream, "getReader").mockImplementation(() => {
    const reader = get(), release = reader.releaseLock.bind(reader);
    restoreRelease = release; vi.spyOn(reader, "releaseLock").mockImplementation(() => { throw Error("PRIVATE_RELEASE"); });
    return reader;
  });
  const op = f.handler.handle(req(stream)); await result(op, "READ_FAILED"); await op.completion;
  expect(op.inspect().cleanupFailed).toBe(true); restoreRelease(); expect(f.read).not.toHaveBeenCalled();
  const r = req(), signal = Object.getOwnPropertyDescriptor(Request.prototype, "signal")!.get!.call(r) as AbortSignal;
  vi.spyOn(signal, "removeEventListener").mockImplementation(() => { throw Error("PRIVATE_OBSERVER"); });
  const failed = f.handler.handle(r); await result(failed, "READ_FAILED"); await failed.completion;
  expect(failed.inspect().cleanupFailed).toBe(true); expect(f.read).not.toHaveBeenCalled();
});
it.each(["decode", "service"])("4I38 discards %s crossing its original deadline", async (phase) => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), f = fixture();
  if (phase === "decode") {
    const parse = JSON.parse; vi.spyOn(JSON, "parse").mockImplementation((s: string) => { const q = parse(s); if (s === JSON.stringify(query)) clock.mockReturnValue(30000); return q; });
  } else f.read.mockImplementation(() => { clock.mockReturnValue(30000); throw Error("PUBLIC_COMPARISON_STORED_RESULT_MISSING"); });
  const op = f.handler.handle(req()), r = await op.response; await op.completion;
  expect(r.status).toBe(408); expect(f.read).toHaveBeenCalledTimes(phase === "decode" ? 0 : 1);
});
it("4I38 abort during synchronous service discards delivery without a second call or lifecycle action", async () => {
  const c = new AbortController(), f = fixture();
  f.read.mockImplementation(() => { c.abort(); throw Error("PUBLIC_COMPARISON_STORED_RESULT_MISSING"); });
  const op = f.handler.handle(req(undefined, { signal: c.signal }));
  await result(op, "REQUEST_CANCELLED"); await op.completion; expect(f.read).toHaveBeenCalledTimes(1);
});
it("4I38 rejects a mismatched result scope before serializing its private content", async () => {
  const service = { readStoredReviewByRun: vi.fn(() => ({
    resultIdentity: { selection: { companyId: query.runId }, runId: query.runId, dispatchCommandDigest: query.dispatchCommandDigest },
    private: "PRIVATE_OTHER_COMPANY",
  })) } as unknown as NonNullable<Parameters<typeof createComparisonReviewRequestHandler>[0]>["service"];
  // This deliberately invalid result is input-failure injection, not an authentic saved result.
  const handler = createComparisonReviewRequestHandler({ companyId, ...query, localOrigin: origin,
    service: service as unknown as NonNullable<Parameters<typeof createComparisonReviewRequestHandler>[0]>["service"] });
  const op = handler.handle(req()); await result(op, "READ_FAILED"); await op.completion;
});
it("4I38 new fixed request codes pass through bounded response receiver", async () => {
  for (const mode of ["method", "abort"] as const) {
    const f = fixture(), c = new AbortController(); if (mode === "abort") c.abort();
    const op = f.handler.handle(mode === "method" ? req(null, { method: "PUT" }) : req(undefined, { signal: c.signal }));
    const receiver = createComparisonReviewReceiver(query, new AbortController().signal);
    await expect(receiver.start(() => op.response)).rejects.toMatchObject({ code: mode === "method" ? "METHOD_NOT_ALLOWED" : "REQUEST_CANCELLED" });
    await Promise.all([receiver.completion, op.completion]); expect(f.read).not.toHaveBeenCalled();
  }
});

it("4I38 chunks never renew the original request deadline", async () => {
  vi.useFakeTimers();
  const f = fixture(); let push!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { push = c; } });
  const op = f.handler.handle(req(stream));
  push.enqueue(new TextEncoder().encode("{")); await flush();
  await vi.advanceTimersByTimeAsync(29000);
  push.enqueue(new TextEncoder().encode('"')); await flush();
  await vi.advanceTimersByTimeAsync(1000);
  await result(op, "REQUEST_TIMEOUT"); await op.completion;
  expect(f.read).not.toHaveBeenCalled();
});
it("4I38 failed reader acquisition and original read rejection cannot reach service", async () => {
  const f = fixture(), first = req(), cancel = vi.spyOn(first.body!, "cancel");
  vi.spyOn(first.body!, "getReader").mockImplementation(() => { throw Error("PRIVATE_ACQUIRE"); });
  const a = f.handler.handle(first); await result(a, "READ_FAILED"); await a.completion;
  expect(cancel).not.toHaveBeenCalled();
  const second = req(new ReadableStream({ start(c) { c.error(Error("PRIVATE_READ")); } }));
  const b = f.handler.handle(second); await result(b, "READ_FAILED"); await b.completion;
  expect(f.read).not.toHaveBeenCalled();
});
it("4I38 refuses invalid fixed binding before it can acquire or choose a service", () => {
  const f = fixture();
  for (const patch of [{ companyId: "bad" }, { runId: "bad" }, { dispatchCommandDigest: "bad" },
    { localOrigin: "https://foreign.invalid" }, { localOrigin: origin + "/" }]) {
    expect(() => createComparisonReviewRequestHandler({ ...f.binding, ...patch })).toThrow(expect.objectContaining({ code: "INVALID_QUERY" }));
  }
  expect(f.read).not.toHaveBeenCalled();
});
it("4I38 another handle cannot cancel the original request reader", async () => {
  const f = fixture(); let push!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(), r = req(new ReadableStream<Uint8Array>({ start(c) { push = c; }, cancel }));
  const original = f.handler.handle(r), other = f.handler.handle(r);
  await result(other, "INVALID_QUERY"); await other.completion;
  expect(cancel).not.toHaveBeenCalled(); expect(original.inspect().settled).toBe(false);
  push.enqueue(new TextEncoder().encode(JSON.stringify(query))); push.close();
  await result(original, "RESULT_UNAVAILABLE"); await original.completion;
  expect(f.read).toHaveBeenCalledTimes(1); expect(cancel).not.toHaveBeenCalled();
});
it("4I38 request cap counts UTF-8 bytes before JSON parsing", async () => {
  const f = fixture(), parse = vi.spyOn(JSON, "parse");
  for (const count of [2730, 2731]) {
    const text = '"' + "가".repeat(count) + '"', op = f.handler.handle(req(text));
    await result(op, count === 2730 ? "INVALID_QUERY" : "TOO_LARGE"); await op.completion;
    expect(parse.mock.calls.filter(([s]) => s === text)).toHaveLength(count === 2730 ? 1 : 0);
  }
  expect(f.read).not.toHaveBeenCalled();
});
