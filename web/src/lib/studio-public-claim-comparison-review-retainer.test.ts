import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const sdkForbidden = vi.hoisted(() => vi.fn(() => { throw Error("SDK construction forbidden"); }));
vi.mock("openai", () => ({ default: class { constructor() { sdkForbidden(); } } }));
vi.mock("openai/helpers/zod", async () => ({
  zodTextFormat: (await import("./studio-public-claim-comparison-format-test-fixture")).pinnedComparisonFormatFixture,
}));
vi.mock("openai/error", () => {
  class APIError extends Error {}
  return { APIError, APIConnectionError: class extends APIError {},
    APIConnectionTimeoutError: class extends APIError {}, APIUserAbortError: class extends APIError {} };
});
import { createComparisonReviewRetainer } from "./studio-public-claim-comparison-review-retainer";
import type { ComparisonReviewRequestStart } from "./studio-public-claim-comparison-review-invocation";
import { createComparisonReviewRequestHandler } from "./studio-public-claim-comparison-review-handler";
import { comparisonReviewTestFixture } from "./studio-public-claim-comparison-review-test-helpers";
import { comparisonReviewSuccessWire, comparisonReviewErrorWire, type ComparisonReviewQuery } from "./studio-public-claim-comparison-review-wire";

type Retainer = ReturnType<typeof createComparisonReviewRetainer>;
type Inputs = Parameters<Retainer["prepare"]>[1];
const holders: Retainer[] = [];
function holder() { const r = createComparisonReviewRetainer(); holders.push(r); return r; }
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
const ended = { started: true, delivered: true, settled: true, cleanupFailed: false };
const headers = { "content-type": "application/json; charset=utf-8" };
function fixture(start?: ComparisonReviewRequestStart | null) {
  const f = comparisonReviewTestFixture(), result = f.value();
  const expected = { ...f.query, selection: structuredClone(result.resultIdentity.selection),
    binding: structuredClone(result.resultIdentity.binding), sectionKey: result.historical.prepared.input.section.key };
  const snapshot = { id: expected.selection.companyId, revision: 7 }, controller = new AbortController();
  const response = () => new Response(comparisonReviewSuccessWire(f.query, result), { headers });
  const read = vi.fn(() => result), origin = "http://127.0.0.1:3000";
  const handler = createComparisonReviewRequestHandler({ service: { readStoredReviewByRun: read },
    companyId: snapshot.id, ...f.query, localOrigin: origin });
  const port = vi.fn(start === undefined ? ((query: ComparisonReviewQuery, signal: AbortSignal) => handler.handle(new Request(
    origin + "/api/studio/cases/" + snapshot.id + "/public-claim-comparison/stored-review", {
      method: "POST", headers: { ...headers, host: "127.0.0.1:3000", origin }, signal, body: JSON.stringify(query),
    }))) : start ?? (() => { throw Error("must not call"); }));
  const inputs: Inputs = { snapshot, expected, signal: controller.signal, startRequest: start === null ? null : port };
  return { ...f, result, expected, snapshot, controller, response, read, port, inputs };
}
function prepare(r: Retainer, f: ReturnType<typeof fixture>, view = r.attachView()!) {
  const prepared = r.prepare(view, f.inputs);
  if (!prepared.ok) throw Error(prepared.code);
  const handle = prepared.handle, frame = { latest: handle.ticket, snapshot: f.snapshot, expected: f.expected,
    mounted: true, open: true, blocked: false, dirty: false, aborted: false };
  return { view, handle, frame };
}
async function finish(r: Retainer, x: ReturnType<typeof prepare>) {
  const start = r.start(x.view, x.handle, x.frame);
  expect(start.ok).toBe(true);
  if (!start.ok) throw Error(start.code);
  const result = await start.delivery; await x.handle.completion;
  return result;
}
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw Error("network forbidden"); })); });
afterEach(async () => {
  for (const h of holders.splice(0)) h.close();
  await flush();
  expect(sdkForbidden).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it("4I42 constructs no call/timer until admitted and retains before explicit start once", async () => {
  const f = fixture(), timer = vi.spyOn(globalThis, "setTimeout"), r = holder(), view = r.attachView()!;
  expect(timer).not.toHaveBeenCalled(); expect(r.inspect()).toMatchObject({ occupied: false, canPrepare: true });
  const x = prepare(r, f, view);
  expect(f.port).not.toHaveBeenCalled(); expect(r.inspect().occupied).toBe(true);
  expect(await finish(r, x)).toEqual({ kind: "result", result: f.result });
  expect(r.start(view, x.handle, x.frame)).toEqual({ ok: true, delivery: x.handle.delivery });
  expect(f.port).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1);
  expect(r.inspect()).toMatchObject({ occupied: true, canPrepare: true, canForget: true });
  const result = r.display(view, x.handle, x.frame);
  if (result?.kind !== "result") throw Error("result required");
  result.result.historical.prepared.input.section.content = "changed copy";
  expect(r.display(view, x.handle, x.frame)).toEqual({ kind: "result", result: f.result });
  expect(r.release(x.handle)).toBe(true); expect(r.display(view, x.handle, x.frame)).toBeNull();
  expect(r.inspect().occupied).toBe(false);
});
it("4I42 Request pending occupies the only slot across companies and views without new timers", async () => {
  const done = deferred<void>(), response = deferred<Response>(), state = { ...ended, settled: false };
  const f = fixture(() => ({ response: response.promise, completion: done.promise, inspect: () => state }));
  const r = holder(), x = prepare(r, f);
  r.start(x.view, x.handle, x.frame); response.resolve(f.response()); await x.handle.responseCompletion;
  const next = fixture(), view = r.attachView()!, timer = vi.spyOn(globalThis, "setTimeout");
  expect(next.snapshot.id).not.toBe(f.snapshot.id);
  expect(r.prepare(view, next.inputs)).toEqual({ ok: false, code: "BUSY" });
  expect(timer).not.toHaveBeenCalled(); expect(next.port).not.toHaveBeenCalled();
  expect(r.release(x.handle)).toBe(false); expect(r.inspect().occupied).toBe(true);
  state.settled = true; done.resolve(); await x.handle.completion; await flush();
  expect(r.inspect().occupied).toBe(false);
  const y = prepare(r, next, view); expect(y.handle.ticket.sequence).toBe(2);
  expect(r.detachView(x.view)).toBe(false);
  expect(await finish(r, y)).toMatchObject({ kind: "result" });
});
it("4I42 Response pending and delayed cancel retain closed holder until original cleanup", async () => {
  const response = deferred<Response>(), cleanup = deferred<void>(), cancel = vi.fn(() => cleanup.promise);
  const f = fixture(() => ({ response: response.promise, completion: Promise.resolve(), inspect: () => ended }));
  const r = holder(), x = prepare(r, f); r.start(x.view, x.handle, x.frame);
  await x.handle.requestCompletion;
  expect(r.prepare(x.view, f.inputs)).toMatchObject({ code: "BUSY" });
  r.close(); expect(r.attachView()).toBeNull();
  expect(r.prepare(x.view, f.inputs)).toMatchObject({ code: "CLOSED" });
  response.resolve(new Response(new ReadableStream({ cancel }), { headers })); await flush();
  expect(cancel).toHaveBeenCalledTimes(1); expect(r.inspect()).toMatchObject({ closed: true, occupied: true, canForget: false });
  cleanup.resolve(); await x.handle.completion; await flush();
  expect(r.inspect()).toMatchObject({ closed: true, occupied: false, canForget: true, canPrepare: false });
});
it.each(["success", "error"])("4I42 late %s after view replacement is discarded and old cleanup cannot remove next call", async (kind) => {
  const response = deferred<Response>();
  const f = fixture(() => ({ response: response.promise, completion: Promise.resolve(), inspect: () => ended }));
  const r = holder(), x = prepare(r, f); r.start(x.view, x.handle, x.frame);
  const view = r.attachView()!;
  response.resolve(kind === "success" ? f.response() :
    new Response(comparisonReviewErrorWire("READ_BLOCKED"), { status: 409, headers }));
  await x.handle.completion; await flush();
  const g = fixture(), y = prepare(r, g, view);
  expect(r.detachView(x.view)).toBe(false); expect(r.release(x.handle)).toBe(false);
  expect(r.cancel(x.view, x.handle)).toBe(false);
  expect(r.display(x.view, x.handle, x.frame)).toBeNull();
  expect(await finish(r, y)).toMatchObject({ kind: "result" });
  await flush(); expect(r.inspect().occupied).toBe(true); expect(r.display(view, y.handle, y.frame)?.kind).toBe("result");
});
it("4I42 clean explicit replacement removes old exact result and preserves increasing sequence", async () => {
  const r = holder(), f = fixture(), x = prepare(r, f); await finish(r, x);
  const y = prepare(r, f, x.view); expect(y.handle.ticket.sequence).toBe(2);
  expect(r.display(x.view, x.handle, x.frame)).toBeNull();
  expect(r.start(x.view, x.handle, x.frame)).toMatchObject({ code: "STALE_CALL" });
  expect(await finish(r, y)).toMatchObject({ kind: "result" });
  const bad = { ...f.inputs, expected: { ...f.expected, runId: "invalid" } };
  expect(r.prepare(x.view, bad)).toMatchObject({ code: "INVALID_INPUT" });
  expect(r.inspect().occupied).toBe(false); expect(r.display(x.view, y.handle, y.frame)).toBeNull();
});
it("4I42 foreign tokens and handles cannot start, display, cancel or release another holder", async () => {
  const f = fixture(), a = holder(), b = holder(), x = prepare(a, f), y = prepare(b, f);
  const timer = vi.spyOn(globalThis, "setTimeout");
  expect(a.prepare(y.view, f.inputs)).toMatchObject({ code: "STALE_VIEW" });
  expect(a.start(x.view, y.handle, x.frame)).toMatchObject({ code: "STALE_CALL" });
  expect(a.cancel(x.view, y.handle)).toBe(false); expect(a.release(y.handle)).toBe(false);
  expect(a.detachView(y.view)).toBe(false); expect(a.display(x.view, y.handle, x.frame)).toBeNull();
  expect(timer).not.toHaveBeenCalled(); expect(f.port).not.toHaveBeenCalled();
  a.close(); b.close(); await Promise.all([x.handle.completion, y.handle.completion]);
});
it.each(["revision", "snapshot", "selection", "dirty", "closed"])("4I42 display honors current frame %s even with current holder token", async (kind) => {
  const f = fixture(), r = holder(), x = prepare(r, f); await finish(r, x);
  const frame = { ...x.frame };
  if (kind === "revision") f.snapshot.revision++;
  if (kind === "snapshot") frame.snapshot = { ...f.snapshot };
  if (kind === "selection") frame.expected = { ...f.expected, sectionKey: "changed" };
  if (kind === "dirty") frame.dirty = true;
  if (kind === "closed") frame.open = false;
  expect(r.display(x.view, x.handle, frame)).toBeNull();
  expect(r.inspect().occupied).toBe(true);
});
it.each(["throw", "promise", "missing-completion", "missing-inspect"])("4I42 %s receipt permanently occupies slot after screen close", async (kind) => {
  const f = fixture((() => {
    if (kind === "throw") throw Error("PRIVATE");
    if (kind === "promise") return Promise.reject(Error("PRIVATE"));
    return { response: Promise.resolve(new Response("{}", { headers })),
      ...(kind !== "missing-completion" ? { completion: Promise.resolve() } : {}),
      ...(kind !== "missing-inspect" ? { inspect: () => ended } : {}) };
  }) as ComparisonReviewRequestStart);
  const r = holder(), x = prepare(r, f); r.start(x.view, x.handle, x.frame);
  expect(await x.handle.delivery).toMatchObject({ code: "RECEIVE_FAILED" }); await x.handle.responseCompletion;
  const view = r.attachView()!, timer = vi.spyOn(globalThis, "setTimeout");
  expect(r.prepare(view, f.inputs)).toMatchObject({ code: "BUSY" }); expect(timer).not.toHaveBeenCalled();
  expect(r.release(x.handle)).toBe(false); r.close();
  expect(r.inspect()).toMatchObject({ closed: true, occupied: true, canForget: false, io: { requestStatus: "unavailable" } });
  expect(JSON.stringify(r.inspect())).not.toContain("PRIVATE"); expect(f.port).toHaveBeenCalledTimes(1);
});
it.each(["request-cleanup", "request-inspect", "response-cancel", "observer"])("4I42 %s failure is not freed by completion or close", async (kind) => {
  const response = deferred<Response>();
  const f = fixture(() => ({ response: response.promise, completion: Promise.resolve(), inspect: () => {
    if (kind === "request-inspect") throw Error("PRIVATE");
    return { ...ended, cleanupFailed: kind === "request-cleanup" };
  } }));
  const r = holder(), x = prepare(r, f);
  if (kind === "observer") vi.spyOn(f.controller.signal, "removeEventListener").mockImplementation(() => { throw Error("PRIVATE"); });
  r.start(x.view, x.handle, x.frame);
  if (kind === "response-cancel") {
    r.detachView(x.view);
    response.resolve(new Response(new ReadableStream({ cancel() { return Promise.reject(Error("PRIVATE")); } }), { headers }));
  } else response.resolve(f.response());
  await x.handle.delivery; await x.handle.responseCompletion; await flush();
  if (kind !== "request-inspect") await x.handle.completion;
  expect(r.release(x.handle)).toBe(false); expect(r.inspect()).toMatchObject({ occupied: true, canForget: false });
  r.close(); expect(r.inspect().occupied).toBe(true);
});
it("4I42 reentrant prepare reserves before input access and invokes original port only once", async () => {
  const f = fixture(), r = holder(), view = r.attachView()!;
  const input = { ...f.inputs };
  const nested: unknown[] = [];
  Object.defineProperty(input, "snapshot", { get() {
    nested.push(r.prepare(view, f.inputs), r.inspect()); return f.snapshot;
  } });
  const p = r.prepare(view, input); if (!p.ok) throw Error(p.code);
  expect(nested[0]).toMatchObject({ code: "BUSY" }); expect(nested[1]).toMatchObject({ occupied: true, creating: true });
  const x = { view, handle: p.handle, frame: { latest: p.handle.ticket, snapshot: f.snapshot, expected: f.expected,
    mounted: true, open: true, blocked: false, dirty: false, aborted: false } };
  expect(await finish(r, x)).toMatchObject({ kind: "result" }); expect(f.port).toHaveBeenCalledTimes(1);
});
it.each(["close", "detach", "replace"])("4I42 %s during construction retains then cancels without a Request", async (kind) => {
  const f = fixture(), r = holder(), view = r.attachView()!;
  const input = { ...f.inputs };
  Object.defineProperty(input, "snapshot", { get() {
    if (kind === "close") r.close();
    if (kind === "detach") r.detachView(view);
    if (kind === "replace") r.attachView();
    return f.snapshot;
  } });
  expect(r.prepare(view, input)).toMatchObject({ ok: false, code: kind === "close" ? "CLOSED" : "STALE_VIEW" });
  expect(r.inspect().occupied).toBe(true); expect(f.port).not.toHaveBeenCalled();
  await flush(); expect(r.inspect().occupied).toBe(false);
});
it("4I42 synchronous start callback cannot create/release another call and close is not lost", async () => {
  const r = holder();
  const f = fixture(() => {
    expect(r.inspect()).toMatchObject({ occupied: true, canPrepare: false });
    expect(r.prepare(x.view, f.inputs)).toMatchObject({ code: "BUSY" });
    expect(r.release(x.handle)).toBe(false); r.close();
    return { response: Promise.resolve(f.response()), completion: Promise.resolve(), inspect: () => ended };
  });
  const x = prepare(r, f); r.start(x.view, x.handle, x.frame);
  expect(await x.handle.delivery).toMatchObject({ code: "CANCELLED" });
  await x.handle.completion; await flush();
  expect(f.port).toHaveBeenCalledTimes(1); expect(r.inspect()).toMatchObject({ closed: true, occupied: false });
});
it.each(["close", "replace"])("4I42 %s inside original inspect cannot reap a replacement entry or resurrect display", async (kind) => {
  const r = holder(); let inspectHook = () => {};
  const f = fixture(() => ({ response: Promise.resolve(f.response()), completion: Promise.resolve(), inspect: () => {
    inspectHook(); return ended;
  } }));
  const x = prepare(r, f); await finish(r, x);
  let nextView: ReturnType<Retainer["attachView"]> = null;
  inspectHook = () => {
    inspectHook = () => {};
    expect(r.prepare(x.view, f.inputs)).toMatchObject({ code: "BUSY" });
    expect(r.release(x.handle)).toBe(false);
    if (kind === "close") r.close(); else nextView = r.attachView();
  };
  r.inspect(); expect(r.display(x.view, x.handle, x.frame)).toBeNull();
  expect(r.inspect().occupied).toBe(false);
  if (kind === "replace") {
    const y = prepare(r, f, nextView!); await finish(r, y);
    expect(r.detachView(x.view)).toBe(false); expect(r.inspect().occupied).toBe(true);
  }
});
it("4I42 null port and preaborted prepared call are releasable without transmission", async () => {
  const r = holder(), f = fixture(null), x = prepare(r, f);
  expect(x.handle.supported).toBe(false); expect(await finish(r, x)).toMatchObject({ code: "RESULT_UNAVAILABLE" });
  expect(r.release(x.handle)).toBe(true);
  const g = fixture(); g.controller.abort(); const y = prepare(r, g, x.view);
  await y.handle.completion; expect(r.release(y.handle)).toBe(true);
  expect(f.port).not.toHaveBeenCalled(); expect(g.port).not.toHaveBeenCalled();
});
it("4I42 prepared call deadline waits for original completion and never starts automatically", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const f = fixture(), r = holder(), x = prepare(r, f);
  clock.mockReturnValue(30000); await vi.advanceTimersByTimeAsync(30000);
  expect(await x.handle.delivery).toMatchObject({ code: "TIMEOUT" });
  await x.handle.completion; expect(f.port).not.toHaveBeenCalled();
  expect(r.inspect().occupied).toBe(true); r.detachView(x.view);
  expect(r.inspect().occupied).toBe(false);
});

it("4I42 no attached view and forged null token cannot allocate or start a call", () => {
  const f = fixture(), r = holder(), timer = vi.spyOn(globalThis, "setTimeout");
  const token = null as unknown as Parameters<Retainer["prepare"]>[0];
  expect(r.prepare(token, f.inputs)).toMatchObject({ code: "STALE_VIEW" });
  expect(r.detachView(token)).toBe(false);
  const fake = Object.freeze({}) as Parameters<Retainer["prepare"]>[0];
  r.attachView(); expect(r.prepare(fake, f.inputs)).toMatchObject({ code: "STALE_VIEW" });
  expect(r.inspect().occupied).toBe(false); expect(timer).not.toHaveBeenCalled();
});
