import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const sdkForbidden36 = vi.hoisted(() => vi.fn(() => { throw Error("SDK construction forbidden"); }));
vi.mock("openai", () => ({ default: class { constructor() { sdkForbidden36(); } } }));
vi.mock("openai/helpers/zod", async () => ({
  zodTextFormat: (await import("./studio-public-claim-comparison-format-test-fixture")).pinnedComparisonFormatFixture,
}));
vi.mock("openai/error", () => {
  class APIError extends Error {}
  return { APIError, APIConnectionError: class extends APIError {},
    APIConnectionTimeoutError: class extends APIError {}, APIUserAbortError: class extends APIError {} };
});
import { randomUUID } from "node:crypto";
import { comparisonReviewTestFixture } from "./studio-public-claim-comparison-review-test-helpers";
import {
  comparisonReviewSuccessWire, comparisonReviewErrorWire, comparisonReviewErrorStatus,
  copyComparisonReviewQuery, decodeComparisonReviewWire, comparisonReviewWireLimits as limits,
  type ComparisonReviewWireResult,
} from "./studio-public-claim-comparison-review-wire";
import { createComparisonReviewReceiver } from "./studio-public-claim-comparison-review-receive";
import { createComparisonReviewDisplayTicket } from "./studio-public-claim-comparison-review-display";
import { encodeStoredComparisonReview } from "./studio-public-claim-comparison-review-server";

const h = "a".repeat(64), other = "b".repeat(64);
const { prepared, query, value } = comparisonReviewTestFixture();
function wire() { return comparisonReviewSuccessWire(query, value()); }
it("keeps legacy v1 bytes and versions owned reader results separately without upgrading authority", () => {
  expect(wire()).toBe(JSON.stringify({ wireVersion: 1, kind: "public-comparison-stored-review", query, result: value() }));
  const owned = { ...value(), source: "comparison-stored-review" as const };
  const text = comparisonReviewSuccessWire(query, owned);
  expect(JSON.parse(text).wireVersion).toBe(2);
  expect(decodeComparisonReviewWire(text, 200, query)).toEqual(owned);
  expect(Object.values(owned.authority).every((authority) => authority === false)).toBe(true);
  expect(owned.historical.result.evidenceOrigin).toBe("manual-unverified");
  for (const mismatch of [text.replace('"wireVersion":2', '"wireVersion":1'),
    wire().replace('"wireVersion":1', '"wireVersion":2')])
    expect(() => decodeComparisonReviewWire(mismatch, 200, query)).toThrow();
  expect(() => comparisonReviewSuccessWire(query, { ...owned, runtimeObserved: true })).toThrow();
});
const headers = { "Content-Type": "application/json; charset=utf-8" };
function response(text = wire(), status = 200, extra = {}) {
  return new Response(text, { status, headers: { ...headers, ...extra } });
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
async function receive(r: Response, code?: string) {
  const owner = createComparisonReviewReceiver(query, new AbortController().signal);
  const delivery = owner.start(async () => r);
  if (code) await expect(delivery).rejects.toMatchObject({ code });
  else await expect(delivery).resolves.toEqual(value());
  await owner.completion;
  expect(owner.inspect().settled).toBe(true);
  return owner;
}
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw Error("network forbidden"); })); });
afterEach(() => { expect(sdkForbidden36).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("4I36 strict stored review wire", () => {
  it("roundtrips original prepared/opinion bytes and false authority into a separate display copy", async () => {
    const decoded = decodeComparisonReviewWire(wire(), 200, query);
    expect(decoded).toEqual(value());
    const snapshot = { id: prepared.selection.companyId, revision: 7 };
    const expected = { ...query, selection: prepared.selection, binding: prepared.binding, sectionKey: prepared.input.section.key };
    const ticket = createComparisonReviewDisplayTicket(1, snapshot, expected);
    const frame = { latest: ticket, snapshot, expected, mounted: true, open: true, blocked: false, dirty: false, aborted: false };
    expect(ticket.accept(decoded, frame)).toEqual(decoded);
    expect(ticket.accept(decoded, { ...frame, latest: createComparisonReviewDisplayTicket(2, snapshot, expected) })).toBeNull();
    expect(ticket.isCurrent({ ...frame, aborted: true })).toBe(false);
    decoded.historical.prepared.input.section.content = "changed";
    expect(value().historical.prepared.input.section.content).not.toBe("changed");
    await receive(response());
  });
  it("rejects invalid query, oversize data, accessors and extra fields before execution", () => {
    const getter = vi.fn(() => query.runId);
    for (const q of [{ ...query, mode: "latest" }, { ...query, runId: "가".repeat(8193) },
      { ...query, extra: true }, Object.defineProperty({ ...query }, "runId", { get: getter }),
      { ...query, toJSON: getter }]) expect(() => copyComparisonReviewQuery(q)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const q = copyComparisonReviewQuery(query); q.runId = randomUUID();
    expect(query.runId).not.toBe(q.runId);
  });
  it.each(["whitespace", "duplicate", "unknown", "order", "BOM", "empty", "truncated"])("rejects noncanonical %s", (kind) => {
    const text = wire();
    const variants = { whitespace: text + " ", duplicate: text.replace('"wireVersion":1', '"wireVersion":1,"wireVersion":1'),
      unknown: text.replace('"wireVersion":1', '"wireVersion":1,"extra":0'),
      order: text.replace('"wireVersion":1,"kind":"public-comparison-stored-review"', '"kind":"public-comparison-stored-review","wireVersion":1'),
      BOM: "\uFEFF" + text, empty: "", truncated: text.slice(0, -1) };
    expect(() => decodeComparisonReviewWire(variants[kind as keyof typeof variants], 200, query)).toThrow();
  });
  it.each([
    ["run", (v: ComparisonReviewWireResult) => { v.resultIdentity.runId = randomUUID(); }],
    ["dispatch", (v: ComparisonReviewWireResult) => { v.resultIdentity.dispatchCommandDigest = other; }],
    ["response hash", (v: ComparisonReviewWireResult) => { v.historical.result.responseArtifactSha256 = other; }],
    ["request", (v: ComparisonReviewWireResult) => { v.historical.result.requestIdentity = { ...v.historical.result.requestIdentity, rawBodySha256: other }; }],
    ["binding", (v: ComparisonReviewWireResult) => { v.resultIdentity.binding = { ...v.resultIdentity.binding, planId: randomUUID() }; }],
    ["revision", (v: ComparisonReviewWireResult) => { v.current.originalRevision++; }],
    ["null ready", (v: ComparisonReviewWireResult) => { v.historical.result.comparison = null; }],
    ["nonready opinion", (v: ComparisonReviewWireResult) => { v.historical.result.state = "comparison-rejected"; }],
    ["unselected quote", (v: ComparisonReviewWireResult) => { v.historical.result.comparison!.comparison.evidence[0].quotes = ["not in original"]; }],
    ["duplicate evidence", (v: ComparisonReviewWireResult) => { v.historical.result.comparison!.comparison.evidence.push(v.historical.result.comparison!.comparison.evidence[0]); }],
    ["overall relation", (v: ComparisonReviewWireResult) => { v.historical.result.comparison!.comparison.overall.relation = "provided-text-support"; }],
    ["inputCharacters", (v: ComparisonReviewWireResult) => { v.historical.prepared.inputCharacters++; }],
  ])("rejects cross-linked %s", (_, mutate) => {
    const v = value(); mutate(v);
    expect(() => decodeComparisonReviewWire(JSON.stringify({ wireVersion: 1, kind: "public-comparison-stored-review", query, result: v }), 200, query)).toThrow();
  });
  it("rejects every authority escalation, extra nested key, bad event/hash and noncanonical metadata", () => {
    const original = wire();
    const mutations = [
      original.replace('"humanConsentVerified":false', '"humanConsentVerified":true'),
      original.replace('"currentContextVerified":false', '"currentContextVerified":true'),
      original.replace('"comparisonRecorded":true', '"comparisonRecorded":false'),
      original.replace('"runtimeObserved":false', '"runtimeObserved":true'),
      original.replace('"owner":null', '"owner":"a"'),
      original.replace('"validatedArtifactSha256":"' + h + '"', '"validatedArtifactSha256":"bad"'),
      original.replace('"comparisonEventDigest":"' + h + '"', '"comparisonEventDigest":null'),
      original.replace('"runHeldBytes":1234', '"runHeldBytes":1234,"path":"private"'),
      original.replace('"scopeHeldUnits":"123456789012345678901234567890"', '"scopeHeldUnits":0'),
      original.replace('"title":"합성 보고서 0"', '"title":" 합성 보고서 0 "'),
    ];
    for (const text of mutations) { expect(text).not.toBe(original); expect(() => decodeComparisonReviewWire(text, 200, query)).toThrow(); }
  });
  it("keeps explicit null policies and validates current statuses without granting present authority", () => {
    for (const state of ["comparison-rejected", "response-incomplete", "response-unsupported", "model-mismatch"] as const) {
      const v = value(); v.historical.result.state = state; v.historical.result.comparison = null;
      expect(decodeComparisonReviewWire(comparisonReviewSuccessWire(query, v), 200, query)).toEqual(v);
    }
    const q = { ...query, mode: "inspect-current" as const };
    for (const current of [
      { status: "exact-original-request" as const, originalRevision: 7, observedRevision: 7, reason: null },
      { status: "changed" as const, originalRevision: 7, observedRevision: 8, reason: "PUBLIC_CLAIM_STALE" as const },
      { status: "unavailable" as const, originalRevision: 7, observedRevision: null, reason: "COMPANY_ROW_INVALID" as const },
    ]) {
      const v = value(); v.current = current;
      expect(decodeComparisonReviewWire(comparisonReviewSuccessWire(q, v), 200, q)).toEqual(v);
      expect(() => comparisonReviewSuccessWire(query, v)).toThrow();
    }
    const v = value(); v.current = { status: "exact-original-request", originalRevision: 7, observedRevision: 8, reason: null };
    expect(() => comparisonReviewSuccessWire(q, v)).toThrow();
  });
  it("accepts only fixed error code/status pairs without reflecting private messages", async () => {
    for (const [code, status] of Object.entries(comparisonReviewErrorStatus)) {
      const text = comparisonReviewErrorWire(code as keyof typeof comparisonReviewErrorStatus);
      await receive(response(text, status), code);
      expect(() => decodeComparisonReviewWire(text, 200, query)).toThrow();
      expect(() => decodeComparisonReviewWire(text, 502, query)).toThrow();
    }
    await receive(response('{"error":"PRIVATE_CUSTOMER_PATH"}', 500), "INVALID_RESPONSE");
  });
});

describe("4I36 bounded receive lifetime", () => {
  it("uses one reader and one JSON parse after UTF-8 chunk boundaries, never response convenience decoding", async () => {
    const bytes = new TextEncoder().encode(wire());
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      for (let n = 0; n < bytes.length; n += 7) c.enqueue(bytes.slice(n, n + 7)); c.close();
    } });
    const r = new Response(stream, { headers });
    const forbidden = vi.fn(() => { throw Error("unbounded decoder"); });
    for (const name of ["json", "text", "arrayBuffer", "clone"] as const) vi.spyOn(r, name).mockImplementation(forbidden);
    const read = vi.spyOn(stream, "getReader"), parse = vi.spyOn(JSON, "parse");
    const owner = createComparisonReviewReceiver(query, new AbortController().signal);
    const result = await owner.start(async () => r); await owner.completion;
    expect(read).toHaveBeenCalledTimes(1); expect(parse).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled(); expect(result.historical.result.state).toBe("comparison-ready");
  });
  it.each([200, 500])("enforces actual bytes before decode at cap-1, cap and cap+1 for status %s", async (status) => {
    const cap = status === 200 ? limits.successBytes : limits.errorBytes;
    for (const offset of [-1, 0, 1]) {
      // Invalid whitespace demonstrates <=cap reaches strict JSON rejection, never a truncated success.
      await receive(response(" ".repeat(cap + offset), status, { "Content-Length": "1" }),
        offset > 0 ? "RECEIVE_LIMIT" : "INVALID_RESPONSE");
    }
    await receive(response("{}", status, { "Content-Length": String(cap + 1) }), "RECEIVE_LIMIT");
  });
  it("rejects malformed length/content type, zero/missing body, invalid UTF-8 and fake Response", async () => {
    for (const length of ["-1", "01", "1.5", "9007199254740992"])
      await receive(response("{}", 200, { "Content-Length": length }), "INVALID_RESPONSE");
    for (const type of ["text/html", "application/json; charset=latin1", "application/json; x=y"])
      await receive(response("{}", 200, { "Content-Type": type }), "INVALID_RESPONSE");
    await receive(new Response(null, { headers }), "INVALID_RESPONSE");
    await receive(response(""), "INVALID_RESPONSE");
    await receive(new Response(new Uint8Array([0xc3, 0x28]), { headers }), "INVALID_RESPONSE");
    await receive(Response.error(), "INVALID_RESPONSE");
    const owner = createComparisonReviewReceiver(query, new AbortController().signal);
    await expect(owner.start(async () => value() as unknown as Response)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await owner.completion;
  });
  it("rejects redirected, used or locked native bodies without releasing another reader", async () => {
    await receive(Response.redirect("https://example.invalid", 302), "INVALID_RESPONSE");
    const used = response(); await used.text(); await receive(used, "INVALID_RESPONSE");
    const r = response(), owned = r.body!.getReader();
    const cancelOther = vi.spyOn(owned, "cancel");
    const o = await receive(r, "INVALID_RESPONSE");
    expect(o.inspect().cleanupFailed).toBe(false);
    expect(cancelOther).not.toHaveBeenCalled();
    expect(r.body!.locked).toBe(true);
    await owned.cancel(); owned.releaseLock();
  });
  it("has no start after pre-abort or expired monotonic deadline, and starts only once", async () => {
    const aborted = new AbortController(); aborted.abort();
    const a = createComparisonReviewReceiver(query, aborted.signal), start = vi.fn(async () => response());
    await expect(a.start(start)).rejects.toMatchObject({ code: "CANCELLED" }); await a.completion;
    expect(start).not.toHaveBeenCalled();
    const clock = vi.spyOn(performance, "now").mockReturnValue(10);
    const b = createComparisonReviewReceiver(query, new AbortController().signal);
    clock.mockReturnValue(30010);
    await expect(b.start(start)).rejects.toMatchObject({ code: "TIMEOUT" }); await b.completion;
    expect(start).not.toHaveBeenCalled();
    clock.mockRestore();
    const c = createComparisonReviewReceiver(query, new AbortController().signal);
    const first = c.start(start); expect(c.start(start)).toBe(first);
    await first; await c.completion; c.cancel();
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("fast deadline failure retains a late Response and pending cancel until original cleanup completes", async () => {
    vi.useFakeTimers();
    const original = deferred<Response>(), cancel = deferred<void>();
    const onCancel = vi.fn(() => cancel.promise);
    const owner = createComparisonReviewReceiver(query, new AbortController().signal);
    let completed = false; void owner.completion.then(() => { completed = true; });
    owner.start(() => original.promise);
    await vi.advanceTimersByTimeAsync(30000);
    await expect(owner.delivery).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(owner.inspect().settled).toBe(false);
    original.resolve(new Response(new ReadableStream({ cancel: onCancel }), { headers }));
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1); expect(completed).toBe(false);
    cancel.resolve(); await owner.completion;
    expect(owner.inspect()).toMatchObject({ settled: true, delivered: false, cleanupFailed: false });
  });
  it("retains independent pending read even if cancel resolves, and observes later read rejection", async () => {
    const c = new AbortController(), pending = deferred<ReadableStreamReadResult<Uint8Array>>();
    const stream = new ReadableStream<Uint8Array>();
    const native = stream.getReader(), cancel = vi.spyOn(native, "cancel").mockResolvedValue();
    vi.spyOn(native, "read").mockImplementation(() => pending.promise);
    native.releaseLock(); vi.spyOn(stream, "getReader").mockReturnValue(native);
    const owner = createComparisonReviewReceiver(query, c.signal);
    owner.start(async () => new Response(stream, { headers }));
    await flush(); c.abort(); await expect(owner.delivery).rejects.toMatchObject({ code: "CANCELLED" });
    await flush(); expect(owner.inspect().settled).toBe(false); expect(cancel).toHaveBeenCalledTimes(1);
    pending.reject(Error("PRIVATE_READ_FAILURE")); await owner.completion;
    expect(owner.inspect().delivered).toBe(false);
  });
  it.each(["throw", "reject"])("records cancel %s without claiming success or retrying", async (mode) => {
    const c = new AbortController(), original = deferred<Response>();
    const onCancel = vi.fn(() => { if (mode === "throw") throw Error("PRIVATE"); return Promise.reject(Error("PRIVATE")); });
    const owner = createComparisonReviewReceiver(query, c.signal);
    owner.start(() => original.promise); c.abort();
    await expect(owner.delivery).rejects.toMatchObject({ code: "CANCELLED" });
    original.resolve(new Response(new ReadableStream({ cancel: onCancel }), { headers }));
    await owner.completion;
    expect(owner.inspect()).toMatchObject({ cleanupFailed: true, settled: true, delivered: false });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
  it("records release failure and observes original start rejection without exposing its details", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(wire())); c.close(); } });
    const original = stream.getReader.bind(stream);
    let release!: () => void;
    vi.spyOn(stream, "getReader").mockImplementation(() => {
      const reader = original(); release = reader.releaseLock.bind(reader);
      vi.spyOn(reader, "releaseLock").mockImplementation(() => { throw Error("PRIVATE"); });
      return reader;
    });
    const owner = await receive(new Response(stream, { headers }), "RECEIVE_FAILED");
    expect(owner.inspect().cleanupFailed).toBe(true); release();
    const rejected = createComparisonReviewReceiver(query, new AbortController().signal);
    await expect(rejected.start(async () => { throw Error("PRIVATE_START"); })).rejects.toMatchObject({ code: "RECEIVE_FAILED" });
    await rejected.completion;
  });
  it("does not renew deadline on chunks and discards decode that crosses the monotonic deadline", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(wire())); c.close(); } });
    const original = stream.getReader.bind(stream);
    vi.spyOn(stream, "getReader").mockImplementation(() => {
      const r = original(), read = r.read.bind(r);
      vi.spyOn(r, "read").mockImplementation(async () => { const part = await read(); clock.mockReturnValue(30000); return part; });
      return r;
    });
    await receive(new Response(stream, { headers }), "TIMEOUT");
    clock.mockReturnValue(0);
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text: string) => { const v = parse(text); clock.mockReturnValue(30000); return v; });
    await receive(response(), "TIMEOUT");
  });
});

it("4I36 server encoder preserves fixed errors/size gates and never acquires a new service", async () => {
  const read = vi.fn(() => value());
  // Explicit synthetic narrow port; full authentic session composition is tested with SQL13 separately.
  const service = { readStoredReviewByRun: read } as unknown as Parameters<typeof encodeStoredComparisonReview>[0];
  const r = encodeStoredComparisonReview(service, query);
  expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toContain("no-store");
  await receive(r);
  expect(read).toHaveBeenCalledTimes(1);
  expect(encodeStoredComparisonReview(service, { ...query, extra: true }).status).toBe(400);
  expect(read).toHaveBeenCalledTimes(1);
  for (const [error, status] of [
    ["PUBLIC_COMPARISON_STORED_RESULT_MISSING", 404],
    ["PUBLIC_COMPARISON_POSTCAPTURE_RECOVERY_REQUIRED", 409],
    ["PUBLIC_COMPARISON_POSTCAPTURE_CLEANUP_REQUIRED", 409],
    ["PUBLIC_COMPARISON_POSTCAPTURE_EXECUTION_PENDING", 409],
    ["PRIVATE_CUSTOMER_FILE", 500],
  ] as const) {
    read.mockImplementation(() => { throw Error(error); });
    const failure = encodeStoredComparisonReview(service, query);
    expect(failure.status).toBe(status);
    expect(await failure.text()).not.toContain(error);
  }
  const oversized = { ...value(), excess: "한".repeat(Math.floor(limits.resultBytes / 3) + 1) };
  read.mockReturnValue(oversized);
  expect(encodeStoredComparisonReview(service, query).status).toBe(413);
});
