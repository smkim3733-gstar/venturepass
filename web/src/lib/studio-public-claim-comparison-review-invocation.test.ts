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
import {
  createComparisonReviewInvocation, type ComparisonReviewRequestStart,
} from "./studio-public-claim-comparison-review-invocation";
import { createComparisonReviewDisplayTicket } from "./studio-public-claim-comparison-review-display";
import { createComparisonReviewRequestHandler } from "./studio-public-claim-comparison-review-handler";
import { comparisonReviewTestFixture } from "./studio-public-claim-comparison-review-test-helpers";
import { comparisonReviewSuccessWire, comparisonReviewErrorWire, type ComparisonReviewQuery } from "./studio-public-claim-comparison-review-wire";

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 32; i++) await Promise.resolve(); }
const ended = { started: true, delivered: true, settled: true, cleanupFailed: false };
const headers = { "content-type": "application/json; charset=utf-8" };
function fixture(start?: ComparisonReviewRequestStart | null) {
  const f = comparisonReviewTestFixture(), result = f.value();
  const expected = { ...f.query, selection: structuredClone(result.resultIdentity.selection),
    binding: structuredClone(result.resultIdentity.binding), sectionKey: result.historical.prepared.input.section.key };
  const snapshot = { id: expected.selection.companyId, revision: 7 }, controller = new AbortController();
  const response = () => new Response(comparisonReviewSuccessWire(f.query, result), { headers });
  const read = vi.fn(() => result);
  const origin = "http://127.0.0.1:3000";
  const handler = createComparisonReviewRequestHandler({ service: { readStoredReviewByRun: read },
    companyId: snapshot.id, ...f.query, localOrigin: origin });
  const requestStart = vi.fn(start === undefined ? ((query: ComparisonReviewQuery, signal: AbortSignal) => handler.handle(new Request(
    origin + "/api/studio/cases/" + snapshot.id + "/public-claim-comparison/stored-review", {
      method: "POST", headers: { ...headers, host: "127.0.0.1:3000", origin }, signal, body: JSON.stringify(query),
    }))) : start ?? (() => { throw Error("must not call"); }));
  const options: Parameters<typeof createComparisonReviewInvocation>[0] = { sequence: 1, snapshot, expected, signal: controller.signal,
    startRequest: start === null ? null : requestStart };
  const invocation = createComparisonReviewInvocation(options);
  const frame = { latest: invocation.ticket, snapshot, expected, mounted: true, open: true,
    blocked: false, dirty: false, aborted: false };
  return { ...f, result, expected, snapshot, controller, response, read, requestStart, options, invocation, frame };
}
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw Error("network forbidden"); })); });
afterEach(() => {
  expect(sdkForbidden).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it("4I40 retains before start, calls the fixed handler once and copies delivery/display independently", async () => {
  const f = fixture(), op = f.invocation;
  expect(f.read).not.toHaveBeenCalled(); expect(f.requestStart).not.toHaveBeenCalled();
  expect(op.start(f.frame)).toBe(op.delivery); expect(op.start(f.frame)).toBe(op.delivery);
  const outcome = await op.delivery; await op.completion;
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.requestStart).toHaveBeenCalledTimes(1);
  expect(outcome).toEqual({ kind: "result", result: f.result });
  expect(op.inspect()).toMatchObject({ settled: true, requestStatus: "settled", canForget: true });
  if (outcome.kind !== "result") throw Error("expected result");
  outcome.result.database.scopeHeldUnits = "0";
  const first = op.display(f.frame);
  expect(first).toEqual({ kind: "result", result: f.result });
  if (first?.kind !== "result") throw Error("expected display");
  first.result.historical.prepared.input.section.content = "mutated";
  expect(op.display(f.frame)).toEqual({ kind: "result", result: f.result });
  expect(Object.isFrozen(op)).toBe(true);
});
it("4I40 captures selection and function references before caller mutation", async () => {
  const f = fixture(), expected = structuredClone(f.expected);
  f.expected.mode = "inspect-current"; f.expected.selection.sourceIds.reverse();
  f.options.startRequest = vi.fn(() => { throw Error("replaced"); });
  const frame = { ...f.frame, expected };
  await f.invocation.start(frame); await f.invocation.completion;
  expect(f.requestStart).toHaveBeenCalledTimes(1); expect(f.options.startRequest).not.toHaveBeenCalled();
  expect(f.requestStart.mock.calls[0][0]).toEqual(f.query);
  expect(f.invocation.display(frame)?.kind).toBe("result");
});
it.each(["closed", "unmounted", "dirty", "blocked", "aborted", "revision", "snapshot", "ticket", "selection"])(
  "4I40 rejects %s before start without losing completion", async (kind) => {
    const f = fixture(), frame = { ...f.frame };
    if (kind === "closed") frame.open = false;
    if (kind === "unmounted") frame.mounted = false;
    if (kind === "dirty") frame.dirty = true;
    if (kind === "blocked") frame.blocked = true;
    if (kind === "aborted") frame.aborted = true;
    if (kind === "revision") f.snapshot.revision++;
    if (kind === "snapshot") frame.snapshot = { ...frame.snapshot };
    if (kind === "ticket") frame.latest = createComparisonReviewDisplayTicket(1, f.snapshot, f.expected);
    if (kind === "selection") frame.expected = { ...f.expected, sectionKey: "changed" };
    expect(await f.invocation.start(frame)).toMatchObject({ kind: "error", code: "CANCELLED" });
    await f.invocation.completion; expect(f.requestStart).not.toHaveBeenCalled();
    expect(f.invocation.inspect()).toMatchObject({ requestStatus: "not-started", canForget: true });
    expect(f.invocation.display(f.frame)).toBeNull();
  },
);
it("4I40 missing injection is unsupported without request acquisition", async () => {
  const f = fixture(null);
  expect(f.invocation.supported).toBe(false);
  expect(await f.invocation.start(f.frame)).toMatchObject({ code: "RESULT_UNAVAILABLE" });
  await f.invocation.completion; expect(f.requestStart).not.toHaveBeenCalled();
  expect(f.invocation.display(f.frame)).toMatchObject({ kind: "error", code: "RESULT_UNAVAILABLE" });
});
it("4I40 preabort and elapsed receiver deadline do not start an injected request", async () => {
  const f = fixture(); f.controller.abort();
  expect(await f.invocation.start(f.frame)).toMatchObject({ code: "CANCELLED" });
  await f.invocation.completion; expect(f.requestStart).not.toHaveBeenCalled();
  const clock = vi.spyOn(performance, "now").mockReturnValue(0), g = fixture();
  clock.mockReturnValue(30000);
  expect(await g.invocation.start(g.frame)).toMatchObject({ code: "TIMEOUT" });
  await g.invocation.completion; expect(g.requestStart).not.toHaveBeenCalled();
});
it.each(["query", "source", "binding", "section", "sequence", "accessor"])(
  "4I40 invalid %s fails before allocating any operation timer", (kind) => {
    const f = fixture(); f.invocation.cancel();
    const options = { ...f.options, expected: structuredClone(f.expected) };
    if (kind === "query") options.expected.runId = "invalid";
    if (kind === "source") options.expected.selection.sourceIds = [];
    if (kind === "binding") options.expected.binding.planContentSha256 = "bad";
    if (kind === "section") options.expected.sectionKey = "";
    if (kind === "sequence") options.sequence = -1;
    const getter = vi.fn(() => f.expected.runId);
    if (kind === "accessor") Object.defineProperty(options.expected, "runId", { get: getter });
    const timer = vi.spyOn(globalThis, "setTimeout");
    expect(() => createComparisonReviewInvocation(options)).toThrow(expect.objectContaining({ code: "INVALID_QUERY" }));
    expect(timer).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
  },
);
it("4I40 waits for Request completion even after a valid response was received", async () => {
  const done = deferred<void>(), response = deferred<Response>(), state = { ...ended, settled: false };
  const f = fixture(() => ({ response: response.promise, completion: done.promise, inspect: () => state }));
  let delivered = false; void f.invocation.delivery.then(() => { delivered = true; });
  f.invocation.start(f.frame); response.resolve(f.response());
  await f.invocation.responseCompletion; expect(delivered).toBe(false);
  expect(f.invocation.display(f.frame)).toBeNull(); expect(f.invocation.inspect().settled).toBe(false);
  state.settled = true; done.resolve(); await f.invocation.completion; await f.invocation.delivery;
  expect(f.invocation.display(f.frame)?.kind).toBe("result");
});
it("4I40 keeps a fast wire error and its unfinished Request cancel independently", async () => {
  const done = deferred<void>(), state = { ...ended, settled: false };
  const f = fixture(() => ({ response: Promise.resolve(new Response(comparisonReviewErrorWire("READ_BLOCKED"), {
    status: 409, headers,
  })), completion: done.promise, inspect: () => state }));
  expect(await f.invocation.start(f.frame)).toMatchObject({ code: "READ_BLOCKED" });
  await f.invocation.responseCompletion;
  expect(f.invocation.inspect()).toMatchObject({ settled: false, requestStatus: "pending" });
  state.settled = true; done.resolve(); await f.invocation.completion;
  expect(f.invocation.display(f.frame)).toMatchObject({ code: "READ_BLOCKED" });
});
it("4I40 abort after response EOF still fails fast while Request completion remains retained", async () => {
  const done = deferred<void>(), response = deferred<Response>(), state = { ...ended, settled: false };
  const f = fixture(() => ({ response: response.promise, completion: done.promise, inspect: () => state }));
  f.invocation.start(f.frame); response.resolve(f.response()); await f.invocation.responseCompletion;
  f.controller.abort(); expect(await f.invocation.delivery).toMatchObject({ code: "CANCELLED" });
  expect(f.invocation.inspect().settled).toBe(false);
  state.settled = true; done.resolve(); await f.invocation.completion;
  expect(f.invocation.display(f.frame)).toBeNull();
});
it.each(["success", "error"])("4I40 stale %s never overwrites a replacement screen", async (kind) => {
  const response = deferred<Response>();
  const f = fixture(() => ({ response: response.promise, completion: Promise.resolve(), inspect: () => ended }));
  f.invocation.start(f.frame);
  const latest = createComparisonReviewDisplayTicket(2, f.snapshot, f.expected);
  response.resolve(kind === "success" ? f.response() :
    new Response(comparisonReviewErrorWire("READ_FAILED"), { status: 500, headers }));
  await f.invocation.delivery; await f.invocation.completion;
  expect(f.invocation.display({ ...f.frame, latest })).toBeNull();
  expect(f.invocation.display({ ...f.frame, snapshot: { ...f.snapshot } })).toBeNull();
  f.snapshot.revision++;
  expect(f.invocation.display(f.frame)).toBeNull();
  expect(f.invocation.inspect().settled).toBe(true);
});
it("4I40 cancelled caller retains late Response read/cancel until original completion", async () => {
  const response = deferred<Response>(), cleanup = deferred<void>(), requestDone = deferred<void>();
  let signal!: AbortSignal; const state = { ...ended, settled: false };
  const f = fixture((_q, s) => { signal = s; return {
    response: response.promise, completion: requestDone.promise, inspect: () => state,
  }; });
  f.invocation.start(f.frame); const retained = f.invocation;
  retained.cancel(); expect(signal.aborted).toBe(true);
  expect(await retained.delivery).toMatchObject({ code: "CANCELLED" });
  const cancel = vi.fn(() => cleanup.promise);
  response.resolve(new Response(new ReadableStream({ cancel }), { headers }));
  await flush(); expect(cancel).toHaveBeenCalledTimes(1); expect(retained.inspect().response.settled).toBe(false);
  state.settled = true; requestDone.resolve(); await retained.requestCompletion;
  expect(retained.inspect().settled).toBe(false);
  cleanup.resolve(); await retained.completion;
  expect(retained.display(f.frame)).toBeNull(); expect(retained.inspect().canForget).toBe(true);
});
it.each(["throw", "reject"])("4I40 retains Response cancel %s as cleanup failure", async (kind) => {
  const response = deferred<Response>();
  const f = fixture(() => ({ response: response.promise, completion: Promise.resolve(), inspect: () => ended }));
  f.invocation.start(f.frame); f.invocation.cancel();
  response.resolve(new Response(new ReadableStream({ cancel() {
    if (kind === "throw") throw Error("PRIVATE");
    return Promise.reject(Error("PRIVATE"));
  } }), { headers }));
  await f.invocation.completion;
  expect(f.invocation.inspect()).toMatchObject({ canForget: false, response: { cleanupFailed: true } });
});
it.each(["cleanup", "inspect-throw", "inspect-unsettled", "completion-reject"])(
  "4I40 Request %s cannot turn a successful DTO into a displayed result", async (kind) => {
    const response = deferred<Response>();
    const f = fixture(() => ({ response: response.promise,
      completion: kind === "completion-reject" ? Promise.reject(Error("PRIVATE")) : Promise.resolve(),
      inspect: () => {
        if (kind === "inspect-throw") throw Error("PRIVATE");
        return { ...ended, cleanupFailed: kind === "cleanup", settled: kind !== "inspect-unsettled" };
      },
    }));
    f.invocation.start(f.frame); response.resolve(f.response());
    expect(await f.invocation.delivery).toMatchObject({ kind: "error", code: "RECEIVE_FAILED" });
    await f.invocation.responseCompletion;
    expect(f.invocation.inspect().canForget).toBe(false);
    expect(f.invocation.display(f.frame)?.kind).toBe("error");
    if (kind === "cleanup") { await f.invocation.completion; expect(f.invocation.inspect().settled).toBe(true); }
    else expect(f.invocation.inspect()).toMatchObject({ requestStatus: "unavailable", settled: false });
  },
);
it.each(["throw", "promise", "missing-completion", "missing-inspect"])(
  "4I40 malformed %s receipt keeps Request completion unknown", async (kind) => {
    const response = deferred<Response>(), cancel = vi.fn();
    const f = fixture((() => {
      if (kind === "throw") throw Error("PRIVATE");
      if (kind === "promise") return Promise.reject(Error("PRIVATE"));
      return { response: response.promise,
        ...(kind !== "missing-completion" ? { completion: Promise.reject(Error("PRIVATE")) } : {}),
        ...(kind !== "missing-inspect" ? { inspect: () => ended } : {}) };
    }) as ComparisonReviewRequestStart);
    f.invocation.start(f.frame);
    expect(await f.invocation.delivery).toMatchObject({ code: "RECEIVE_FAILED" });
    response.resolve(new Response(new ReadableStream({ cancel }), { headers }));
    await f.invocation.responseCompletion;
    expect(f.invocation.inspect()).toMatchObject({ requestStatus: "unavailable", settled: false, canForget: false });
    expect(f.requestStart).toHaveBeenCalledTimes(1);
    if (kind.startsWith("missing")) expect(cancel).toHaveBeenCalledTimes(1);
  },
);
it("4I40 response rejection and invalid wire use fixed errors with no retry", async () => {
  const f = fixture(() => ({ response: Promise.reject(Error("PRIVATE_PATH")),
    completion: Promise.resolve(), inspect: () => ended }));
  expect(await f.invocation.start(f.frame)).toMatchObject({ code: "RECEIVE_FAILED" });
  await f.invocation.completion;
  expect(JSON.stringify(f.invocation.display(f.frame))).not.toContain("PRIVATE");
  const g = fixture(() => ({ response: Promise.resolve(new Response('{"authority":true}', { headers })),
    completion: Promise.resolve(), inspect: () => ended }));
  expect(await g.invocation.start(g.frame)).toMatchObject({ code: "INVALID_RESPONSE" });
  await g.invocation.completion; expect(g.requestStart).toHaveBeenCalledTimes(1);
});
it("4I40 pending body read remains retained when screen closes", async () => {
  const response = deferred<Response>(), cleanup = deferred<void>(), cancel = vi.fn(() => cleanup.promise);
  const f = fixture(() => ({ response: response.promise, completion: Promise.resolve(), inspect: () => ended }));
  f.invocation.start(f.frame);
  response.resolve(new Response(new ReadableStream({ cancel }), { headers }));
  await flush(); f.invocation.cancel();
  await f.invocation.delivery; expect(f.invocation.inspect().settled).toBe(false);
  cleanup.resolve(); await f.invocation.completion;
  expect(cancel).toHaveBeenCalledTimes(1); expect(f.invocation.display({ ...f.frame, open: false })).toBeNull();
});
it("4I40 observer cleanup failure blocks normal disposal and result display", async () => {
  const f = fixture();
  const remove = f.controller.signal.removeEventListener.bind(f.controller.signal);
  vi.spyOn(f.controller.signal, "removeEventListener").mockImplementation(() => { throw Error("PRIVATE"); });
  const result = await f.invocation.start(f.frame); await f.invocation.completion;
  expect(result).toMatchObject({ kind: "error", code: "RECEIVE_FAILED" });
  expect(f.invocation.inspect()).toMatchObject({ canForget: false });
  vi.restoreAllMocks(); f.controller.abort(); void remove;
});
