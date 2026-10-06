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


import { createComparisonReviewScreen } from "./studio-public-claim-comparison-review-screen";

function screen() { const r = holder(), s = createComparisonReviewScreen(r); return { r, s }; }
function prepared(s: ReturnType<typeof createComparisonReviewScreen>, f = fixture(), view = s.attachView()!) {
  const p = s.prepare(view, f.inputs); if (!p.ok) throw Error(p.code);
  const frame = { latest: p.handle.ticket, snapshot: f.snapshot, expected: f.expected,
    mounted: true, open: true, blocked: false, dirty: false, aborted: false };
  return { f, view, handle: p.handle, frame };
}
async function complete(s: ReturnType<typeof createComparisonReviewScreen>, x: ReturnType<typeof prepared>) {
  const begun = s.start(x.view, x.handle, x.frame); expect(begun.ok).toBe(true);
  await x.handle.delivery; await x.handle.completion; await flush();
}
it("4I44 empty connection and subscriptions create no request or timer; only one connection owns notifications", () => {
  const timer = vi.spyOn(globalThis, "setTimeout"), { r, s } = screen(), view = s.attachView()!;
  const snap = s.getSnapshot(), listener = vi.fn(), unsub = s.subscribe(view, listener)!;
  expect(s.getSnapshot()).toBe(snap); unsub(); unsub();
  expect(() => createComparisonReviewScreen(r)).toThrow("COMPARISON_SCREEN_ALREADY_CONNECTED");
  expect(timer).not.toHaveBeenCalled(); expect(r.inspect().occupied).toBe(false);
});
it("4I44 handler through native Request/receiver publishes exact immutable result without granting authority", async () => {
  const { r, s } = screen(), x = prepared(s), listener = vi.fn(); s.subscribe(x.view, listener);
  expect(x.f.port).not.toHaveBeenCalled(); await complete(s, x);
  const snap = s.getSnapshot(), value = s.selectDisplay(x.view, x.frame);
  expect(value).toEqual({ kind: "result", result: x.f.result });
  if (value?.kind !== "result") throw Error("expected result");
  expect(Object.isFrozen(value.result.historical.prepared.input.section)).toBe(true);
  expect(Reflect.set(value.result.historical.prepared.input.section, "content", "tampered")).toBe(false);
  expect(s.getSnapshot()).toBe(snap); expect(listener).toHaveBeenCalled();
  expect(x.f.read).toHaveBeenCalledTimes(1); expect(x.f.port).toHaveBeenCalledTimes(1);
  expect(r.inspect()).toMatchObject({ occupied: true, canForget: true });
  expect(s.release(x.view, x.handle)).toBe(true); expect(s.selectDisplay(x.view, x.frame)).toBeNull();
});
it("4I44 render reads invoke no Request inspect, timer, display, cancellation or microtask", async () => {
  const inspect = vi.fn(() => ended), f = fixture(() => ({ response: Promise.resolve(f.response()),
    completion: Promise.resolve(), inspect }));
  const { s } = screen(), x = prepared(s, f); await complete(s, x);
  inspect.mockClear(); const timer = vi.spyOn(globalThis, "setTimeout");
  const microtask = vi.spyOn(globalThis, "queueMicrotask"), snap = s.getSnapshot();
  for (let i = 0; i < 20; i++) { expect(s.getSnapshot()).toBe(snap); expect(s.selectDisplay(x.view, x.frame)).toBe(snap.display); }
  expect(inspect).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled(); expect(microtask).not.toHaveBeenCalled();
});
it.each(["snapshot", "revision", "selection", "ticket", "dirty", "blocked", "closed", "unmounted", "aborted"])(
  "4I44 pure render rejects %s before commit and committed invalidation never resurrects", async (kind) => {
    const { s } = screen(), x = prepared(s); await complete(s, x);
    const frame = { ...x.frame };
    if (kind === "snapshot") frame.snapshot = { ...x.frame.snapshot };
    if (kind === "revision") x.f.snapshot.revision++;
    if (kind === "selection") frame.expected = { ...frame.expected, sectionKey: "other" };
    if (kind === "ticket") frame.latest = {} as typeof frame.latest;
    if (kind === "dirty") frame.dirty = true;
    if (kind === "blocked") frame.blocked = true;
    if (kind === "closed") frame.open = false;
    if (kind === "unmounted") frame.mounted = false;
    if (kind === "aborted") frame.aborted = true;
    const snap = s.getSnapshot();
    expect(s.selectDisplay(x.view, frame)).toBeNull(); expect(s.getSnapshot()).toBe(snap);
    expect(s.commitFrame(x.view, x.handle, frame)).toBe(false);
    expect(s.commitFrame(x.view, x.handle, x.frame)).toBe(false);
    expect(s.selectDisplay(x.view, x.frame)).toBeNull(); expect(x.f.port).toHaveBeenCalledTimes(1);
  });
it("4I44 early wire error is visible while original Request completion still occupies the slot", async () => {
  const done = deferred<void>(), state = { ...ended, settled: false };
  const f = fixture(() => ({ response: Promise.resolve(new Response(comparisonReviewErrorWire("READ_BLOCKED"),
    { status: 409, headers })), completion: done.promise, inspect: () => state }));
  const { r, s } = screen(), x = prepared(s, f); s.start(x.view, x.handle, x.frame);
  await x.handle.delivery; await x.handle.responseCompletion; await flush();
  expect(s.selectDisplay(x.view, x.frame)).toMatchObject({ kind: "error", code: "READ_BLOCKED" });
  expect(s.getSnapshot().state).toMatchObject({ occupied: true, canForget: false, requestCompleted: false });
  const g = fixture(), timer = vi.spyOn(globalThis, "setTimeout");
  expect(s.prepare(x.view, g.inputs)).toMatchObject({ code: "BUSY" }); expect(timer).not.toHaveBeenCalled();
  expect(s.selectDisplay(x.view, x.frame)).toMatchObject({ kind: "error" });
  state.settled = true; done.resolve(); await x.handle.completion; await flush();
  expect(r.inspect().canForget).toBe(true); expect(g.port).not.toHaveBeenCalled();
});
it("4I44 unsubscribe retains original call and completed snapshot; resubscribe does not repeat transport", async () => {
  const response = deferred<Response>(), f = fixture(() => ({ response: response.promise,
    completion: Promise.resolve(), inspect: () => ended }));
  const { r, s } = screen(), x = prepared(s, f), listener = vi.fn(), unsub = s.subscribe(x.view, listener)!;
  s.start(x.view, x.handle, x.frame); await flush(); listener.mockClear(); unsub();
  response.resolve(f.response()); await x.handle.completion; await flush();
  expect(listener).not.toHaveBeenCalled(); expect(s.getSnapshot().display?.kind).toBe("result");
  const next = vi.fn(); s.subscribe(x.view, next); expect(s.getSnapshot().display?.kind).toBe("result");
  expect(f.port).toHaveBeenCalledTimes(1); expect(r.inspect().occupied).toBe(true);
});
it("4I44 replacing a subscriber while notification is queued cannot lose the latest change", async () => {
  const { s } = screen(), view = s.attachView()!, old = vi.fn(), current = vi.fn();
  const unsubscribe = s.subscribe(view, old)!; const x = prepared(s, fixture(), view);
  s.subscribe(view, current); unsubscribe();
  s.start(view, x.handle, x.frame); await x.handle.completion; await flush();
  expect(old).not.toHaveBeenCalled(); expect(current).toHaveBeenCalled();
  expect(s.getSnapshot().display?.kind).toBe("result");
});
it.each(["detach", "replace", "close"])("4I44 %s during prepare reports hidden completion without an exposed handle", async (kind) => {
  const { r, s } = screen(), f = fixture(), view = s.attachView()!, input = { ...f.inputs };
  Object.defineProperty(input, "snapshot", { get() {
    if (kind === "detach") s.detachView(view);
    if (kind === "replace") s.attachView();
    if (kind === "close") s.close();
    return f.snapshot;
  } });
  expect(s.prepare(view, input)).toMatchObject({ ok: false });
  expect(r.inspect().occupied).toBe(true); expect(f.port).not.toHaveBeenCalled();
  await flush();
  expect(s.getSnapshot().state.occupied).toBe(false);
  expect(s.getSnapshot().state.canForget).toBe(true); expect(f.port).not.toHaveBeenCalled();
});
it("4I44 closed view retains a late Response and delayed cancellation until original completion", async () => {
  const response = deferred<Response>(), cleanup = deferred<void>(), cancel = vi.fn(() => cleanup.promise);
  const f = fixture(() => ({ response: response.promise, completion: Promise.resolve(), inspect: () => ended }));
  const { s } = screen(), x = prepared(s, f); s.start(x.view, x.handle, x.frame); await x.handle.requestCompletion;
  s.close(); response.resolve(new Response(new ReadableStream({ cancel }), { headers })); await flush();
  expect(s.getSnapshot().state).toMatchObject({ closed: true, occupied: true, canForget: false });
  expect(cancel).toHaveBeenCalledTimes(1); cleanup.resolve(); await x.handle.completion; await flush();
  expect(s.getSnapshot().state).toMatchObject({ occupied: false, canForget: true });
});
it.each(["unavailable", "cleanup", "cancel-failure"])("4I44 %s survives missing UI subscribers and close", async (kind) => {
  const f = fixture(kind === "unavailable" ? (() => { throw Error("PRIVATE"); }) :
    (() => ({ response: Promise.resolve(kind === "cancel-failure" ?
      new Response(new ReadableStream({ cancel() { throw Error("PRIVATE"); } }), { headers }) : f.response()),
      completion: Promise.resolve(), inspect: () => ({ ...ended, cleanupFailed: kind === "cleanup" }) })));
  const { s } = screen(), x = prepared(s, f); s.start(x.view, x.handle, x.frame);
  if (kind === "cancel-failure") s.cancel(x.view, x.handle);
  await x.handle.delivery; await x.handle.responseCompletion; await flush(); s.close(); await flush();
  expect(s.getSnapshot().state).toMatchObject({ occupied: true, canForget: false });
  expect(JSON.stringify(s.getSnapshot())).not.toContain("PRIVATE");
});
it("4I44 listener throw is a notification failure, not Request cleanup or server completion", async () => {
  const { r, s } = screen(), x = prepared(s);
  s.subscribe(x.view, () => { throw Error("PRIVATE"); }); await complete(s, x);
  expect(s.getSnapshot()).toMatchObject({ notificationFailed: true, state: { canForget: true, occupied: true } });
  expect(r.inspect().io?.requestCleanupFailed).toBe(false);
  const next = vi.fn(); s.subscribe(x.view, next); expect(s.selectDisplay(x.view, x.frame)?.kind).toBe("result");
  expect(JSON.stringify(s.getSnapshot())).not.toContain("PRIVATE");
});
it("4I44 notification reentry cannot prepare/start and detach intent is retained", async () => {
  const { s } = screen(), x = prepared(s), nested: unknown[] = [];
  s.subscribe(x.view, () => {
    nested.push(s.prepare(x.view, x.f.inputs), s.start(x.view, x.handle, x.frame));
    s.detachView(x.view);
  });
  s.start(x.view, x.handle, x.frame); await x.handle.completion; await flush();
  expect(nested.slice(0, 2)).toEqual([{ ok: false, code: "BUSY" }, { ok: false, code: "BUSY" }]);
  expect(s.getSnapshot().viewToken).toBeNull(); expect(x.f.port).toHaveBeenCalledTimes(1);
});
it("4I44 no-change observations do not create notification loops", async () => {
  const { r, s } = screen(), x = prepared(s); await complete(s, x);
  const listener = vi.fn(); s.subscribe(x.view, listener); const snap = s.getSnapshot();
  for (let i = 0; i < 5; i++) { r.inspect(); s.commitFrame(x.view, x.handle, x.frame); await flush(); }
  expect(listener).not.toHaveBeenCalled(); expect(s.getSnapshot()).toBe(snap);
});
it("4I44 direct holder replacement suppresses cached display before its notification", async () => {
  const { r, s } = screen(), x = prepared(s); await complete(s, x);
  r.attachView(); expect(s.selectDisplay(x.view, x.frame)).toBeNull();
  await flush(); expect(s.getSnapshot().display).toBeNull();
});
it("4I44 setup/cleanup/setup preserves one holder, old cleanup cannot detach the new view", async () => {
  const { r, s } = screen(), a = s.attachView()!, unsubscribe = s.subscribe(a, vi.fn())!;
  unsubscribe(); s.detachView(a); const b = s.attachView()!, x = prepared(s, fixture(), b);
  unsubscribe(); expect(s.detachView(a)).toBe(false); await complete(s, x);
  expect(s.getSnapshot().viewToken).toBe(b); expect(r.inspect().closed).toBe(false);
});
it("4I44 invalid frame cancels only its call, no automatic transport on commit or subscribe", async () => {
  const { s } = screen(), x = prepared(s);
  expect(s.commitFrame(x.view, x.handle, { ...x.frame, open: "yes" as unknown as boolean })).toBe(false);
  s.subscribe(x.view, vi.fn()); await x.handle.completion; await flush();
  expect(x.f.port).not.toHaveBeenCalled(); expect(s.getSnapshot().display).toBeNull();
});
it("4I44 explicit clean replacement discards old exact and failed new preparation cannot restore it", async () => {
  const { s } = screen(), x = prepared(s); await complete(s, x);
  expect(s.prepare(x.view, { ...x.f.inputs, expected: { ...x.f.expected, runId: "invalid" } })).toMatchObject({ code: "INVALID_INPUT" });
  expect(s.selectDisplay(x.view, x.frame)).toBeNull();
  const y = prepared(s, fixture(), x.view); await complete(s, y);
  expect(y.handle.ticket.sequence).toBeGreaterThan(x.handle.ticket.sequence);
});
it("4I44 holder notifications run after synchronous Request port critical section", async () => {
  const r = holder(), notification = vi.fn(() => {
    expect(inPort).toBe(false); r.inspect();
  });
  let inPort = false;
  expect(r.claimNotifications(notification)).toBe(true); expect(r.claimNotifications(vi.fn())).toBe(false);
  const f = fixture(() => { inPort = true; expect(notification).not.toHaveBeenCalled(); inPort = false;
    return { response: Promise.resolve(f.response()), completion: Promise.resolve(), inspect: () => ended }; });
  const x = prepare(r, f); await finish(r, x); await flush();
  expect(notification).toHaveBeenCalled(); const count = notification.mock.calls.length;
  r.inspect(); await flush(); expect(notification).toHaveBeenCalledTimes(count);
});
it("4I44 internal notification throw never changes I/O cleanup authority", async () => {
  const r = holder(), f = fixture(), x = prepare(r, f);
  r.claimNotifications(() => { throw Error("PRIVATE"); });
  await finish(r, x); await flush(); expect(r.getSnapshot().notificationFailed).toBe(true);
  expect(r.inspect().canForget).toBe(true); expect(r.release(x.handle)).toBe(true);
});
it("4I44 fixed null port remains unsupported without acquiring any service", async () => {
  const { s } = screen(), x = prepared(s, fixture(null)); await complete(s, x);
  expect(x.handle.supported).toBe(false); expect(s.selectDisplay(x.view, x.frame)).toMatchObject({ code: "RESULT_UNAVAILABLE" });
  expect(x.f.port).not.toHaveBeenCalled();
});

it("4I44 a valid result waits for Request completion even after the Response has ended", async () => {
  const done = deferred<void>(), state = { ...ended, settled: false };
  const f = fixture(() => ({ response: Promise.resolve(f.response()), completion: done.promise, inspect: () => state }));
  const { s } = screen(), x = prepared(s, f); s.start(x.view, x.handle, x.frame);
  await x.handle.responseCompletion; await flush();
  expect(s.getSnapshot().state).toMatchObject({ responseCompleted: true, requestCompleted: false, occupied: true });
  expect(s.selectDisplay(x.view, x.frame)).toBeNull();
  state.settled = true; done.resolve(); await x.handle.completion; await flush();
  expect(s.selectDisplay(x.view, x.frame)?.kind).toBe("result");
});
it("4I44 changing the screen inside original Request inspect cannot publish old exact", async () => {
  let hook = () => {};
  const f = fixture(() => ({ response: Promise.resolve(f.response()), completion: Promise.resolve(),
    inspect: () => { hook(); return ended; } }));
  const { s } = screen(), x = prepared(s, f); await complete(s, x);
  let next: ReturnType<typeof s.attachView> = null;
  hook = () => { hook = () => {}; next = s.attachView(); };
  s.commitFrame(x.view, x.handle, x.frame); await flush();
  expect(s.getSnapshot().viewToken).toBe(next); expect(s.getSnapshot().display).toBeNull();
  expect(s.detachView(x.view)).toBe(false); expect(s.selectDisplay(x.view, x.frame)).toBeNull();
});
it("4I44 frame fields are captured without freezing or adopting a mutated caller frame", async () => {
  const response = deferred<Response>(), f = fixture(() => ({ response: response.promise,
    completion: Promise.resolve(), inspect: () => ended }));
  const { s } = screen(), x = prepared(s, f); s.start(x.view, x.handle, x.frame);
  x.frame.expected = { ...x.frame.expected, sectionKey: "mutated-after-start" };
  expect(Object.isFrozen(f.snapshot)).toBe(false);
  response.resolve(f.response()); await x.handle.completion; await flush();
  expect(s.selectDisplay(x.view, x.frame)).toBeNull();
  expect(s.selectDisplay(x.view, { ...x.frame, expected: f.expected })?.kind).toBe("result");
});

it("4I44 a nested inspect cannot publish a half-created entry as the final snapshot", async () => {
  const r = holder(), view = r.attachView()!, before = r.getSnapshot(), f = fixture(), input = { ...f.inputs };
  Object.defineProperty(input, "snapshot", { get() {
    expect(r.inspect()).toMatchObject({ creating: true });
    expect(r.getSnapshot()).toBe(before);
    return f.snapshot;
  } });
  const p = r.prepare(view, input); if (!p.ok) throw Error(p.code);
  expect(r.getSnapshot()).toMatchObject({ creating: false, occupied: true, ticket: p.handle.ticket });
  r.detachView(view); await p.handle.completion; await flush();
});

it("4I44 an outer attach superseded during cleanup never returns the newer view token", async () => {
  let hook = () => {};
  const f = fixture(() => ({ response: Promise.resolve(f.response()), completion: Promise.resolve(),
    inspect: () => { hook(); return ended; } }));
  const { s } = screen(), x = prepared(s, f); await complete(s, x);
  let inner: ReturnType<typeof s.attachView> = null;
  hook = () => { hook = () => {}; inner = s.attachView(); };
  expect(s.attachView()).toBeNull();
  expect(s.getSnapshot().viewToken).toBe(inner);
  expect(s.detachView(x.view)).toBe(false);
  const y = prepared(s, fixture(), inner!); await complete(s, y);
  expect(s.selectDisplay(y.view, y.frame)?.kind).toBe("result");
});

it("4I48 close publishes one final immutable closed snapshot and rejects every new admission", async () => {
  const { r, s } = screen(), x = prepared(s); await complete(s, x);
  const observed: ReturnType<typeof s.getSnapshot>[] = [], admission: unknown[] = [];
  s.subscribe(x.view, () => {
    observed.push(s.getSnapshot());
    admission.push(s.attachView(), s.subscribe(x.view, vi.fn()),
      s.prepare(x.view, x.f.inputs), s.start(x.view, x.handle, x.frame));
    s.close();
  });
  s.close(); expect(observed).toEqual([]);
  await flush();
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ viewToken: null, ticket: null, display: null,
    state: { closed: true, canPrepare: false, occupied: false, canForget: true } });
  expect(Object.isFrozen(observed[0])).toBe(true);
  expect(admission).toEqual([null, null, { ok: false, code: "CLOSED" }, { ok: false, code: "CLOSED" }]);
  expect(s.selectDisplay(x.view, x.frame)).toBeNull();
  expect(r.inspect().closed).toBe(true); expect(x.f.port).toHaveBeenCalledTimes(1);
});
it("4I48 closing an early error clears display once while original Request completion remains pending", async () => {
  const done = deferred<void>(), io = { ...ended, settled: false };
  const f = fixture(() => ({ response: Promise.resolve(new Response(comparisonReviewErrorWire("READ_BLOCKED"),
    { status: 409, headers })), completion: done.promise, inspect: () => io }));
  const { s } = screen(), x = prepared(s, f); s.start(x.view, x.handle, x.frame);
  await x.handle.delivery; await x.handle.responseCompletion; await flush();
  expect(s.selectDisplay(x.view, x.frame)?.kind).toBe("error");
  const listener = vi.fn(); s.subscribe(x.view, listener); s.close(); await flush();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(s.getSnapshot()).toMatchObject({ display: null, state: { closed: true, occupied: true, canForget: false } });
  io.settled = true; done.resolve(); await x.handle.completion; await flush();
  expect(s.getSnapshot().state).toMatchObject({ occupied: false, canForget: true });
  expect(listener).toHaveBeenCalledTimes(1);
});
it("4I48 close coalesces an already queued ordinary change into only the final closed notice", async () => {
  const { s } = screen(), view = s.attachView()!, f = fixture();
  const snapshots: ReturnType<typeof s.getSnapshot>[] = [];
  s.subscribe(view, () => snapshots.push(s.getSnapshot()));
  const x = prepared(s, f, view); s.close(); s.close();
  await x.handle.completion; await flush();
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ viewToken: null, ticket: null, display: null,
    state: { closed: true, creating: false, canPrepare: false } });
  expect(f.port).not.toHaveBeenCalled();
});
it.each(["same-view", "new-view"])("4I48 %s old unsubscribe cannot cancel the current terminal registration", async (kind) => {
  const { s } = screen(), oldView = s.attachView()!, old = vi.fn(), current = vi.fn();
  const oldOff = s.subscribe(oldView, old)!;
  const view = kind === "new-view" ? s.attachView()! : oldView;
  s.subscribe(view, current); s.close(); oldOff();
  expect(s.detachView(oldView)).toBe(false);
  await flush(); expect(old).not.toHaveBeenCalled(); expect(current).toHaveBeenCalledTimes(1);
});
it.each(["before", "after"])("4I48 current unsubscribe %s close cancels its terminal callback without a replacement", async (when) => {
  const { s } = screen(), view = s.attachView()!, listener = vi.fn(), off = s.subscribe(view, listener)!;
  if (when === "before") off();
  s.close(); if (when === "after") off();
  off(); await flush();
  expect(listener).not.toHaveBeenCalled(); expect(s.subscribe(view, vi.fn())).toBeNull();
  expect(s.getSnapshot().state.closed).toBe(true);
});
it("4I48 detach and close without a current subscriber never resurrect a registration", async () => {
  const { s } = screen(), view = s.attachView()!, listener = vi.fn();
  s.subscribe(view, listener); s.detachView(view); s.close(); await flush();
  expect(listener).not.toHaveBeenCalled(); expect(s.attachView()).toBeNull();
});
it("4I48 close inside an ordinary listener sends a single deferred terminal notice without recursion", async () => {
  const { s } = screen(), view = s.attachView()!, states: boolean[] = [];
  let depth = 0, maximum = 0;
  s.subscribe(view, () => {
    depth++; maximum = Math.max(maximum, depth);
    states.push(s.getSnapshot().state.closed); s.close(); depth--;
  });
  const x = prepared(s, fixture(), view); await x.handle.completion; await flush();
  expect(states).toEqual([false, true]); expect(maximum).toBe(1);
  expect(x.f.port).not.toHaveBeenCalled();
});
it("4I48 an ordinary listener that closes then throws is retired before its terminal notice", async () => {
  const { s } = screen(), view = s.attachView()!, listener = vi.fn(() => { s.close(); throw Error("PRIVATE"); });
  s.subscribe(view, listener); const x = prepared(s, fixture(), view);
  await x.handle.completion; await flush();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(s.getSnapshot()).toMatchObject({ notificationFailed: true, display: null, state: { closed: true } });
  expect(JSON.stringify(s.getSnapshot())).not.toContain("PRIVATE");
});
it("4I48 terminal listener failure is not an I/O cleanup failure and never retries", async () => {
  const { r, s } = screen(), view = s.attachView()!, listener = vi.fn(() => { throw Error("PRIVATE"); });
  s.subscribe(view, listener); s.close(); await flush(); s.close(); await flush();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(s.getSnapshot()).toMatchObject({ notificationFailed: true, state: { canForget: true, observerFailed: false } });
  expect(r.inspect()).toMatchObject({ occupied: false, observerFailed: false });
  expect(JSON.stringify(s.getSnapshot())).not.toContain("PRIVATE");
});
it("4I48 close while creating retains the hidden original invocation and publishes only after the outer boundary", async () => {
  const { r, s } = screen(), view = s.attachView()!, f = fixture(), input = { ...f.inputs };
  const observed: ReturnType<typeof s.getSnapshot>[] = [], inner: ReturnType<typeof s.getSnapshot>[] = [];
  s.subscribe(view, () => observed.push(s.getSnapshot()));
  Object.defineProperty(input, "snapshot", { get() {
    s.close(); inner.push(s.getSnapshot()); return f.snapshot;
  } });
  expect(s.prepare(view, input)).toMatchObject({ ok: false, code: "CLOSED" });
  expect(observed).toEqual([]); expect(inner.every((v) => !v.state.closed)).toBe(true);
  expect(r.inspect()).toMatchObject({ closed: true, occupied: true });
  await flush();
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ viewToken: null, ticket: null, display: null, state: { closed: true, creating: false } });
  expect(s.getSnapshot().state).toMatchObject({ occupied: false, canForget: true });
  expect(f.port).not.toHaveBeenCalled();
});
it("4I48 close from original inspect never publishes an intermediate terminal snapshot", async () => {
  let hook = () => {};
  const f = fixture(() => ({ response: Promise.resolve(f.response()), completion: Promise.resolve(),
    inspect: () => { hook(); return ended; } }));
  const { s } = screen(), x = prepared(s, f); await complete(s, x);
  const before = s.getSnapshot(), inner: ReturnType<typeof s.getSnapshot>[] = [], listener = vi.fn();
  s.subscribe(x.view, listener);
  hook = () => { hook = () => {}; s.close(); inner.push(s.getSnapshot()); };
  s.commitFrame(x.view, x.handle, x.frame);
  expect(inner).toEqual([before]); expect(listener).not.toHaveBeenCalled();
  await flush(); expect(listener).toHaveBeenCalledTimes(1);
  expect(s.getSnapshot()).toMatchObject({ display: null, viewToken: null, state: { closed: true, canPrepare: false } });
});
it("4I48 close inside explicit start preserves one port and defers the terminal observation", async () => {
  const { s } = screen(), listener = vi.fn();
  const f = fixture(() => { s.close(); return { response: Promise.resolve(f.response()),
    completion: Promise.resolve(), inspect: () => ended }; });
  const x = prepared(s, f); s.subscribe(x.view, listener);
  s.start(x.view, x.handle, x.frame);
  expect(listener).not.toHaveBeenCalled();
  await x.handle.completion; await flush();
  expect(listener).toHaveBeenCalledTimes(1); expect(f.port).toHaveBeenCalledTimes(1);
  expect(s.getSnapshot().state).toMatchObject({ closed: true, occupied: false });
});
it("4I48 abort callback reentry cannot reopen admission or repeat cancellation", async () => {
  const { s } = screen(), done = deferred<void>(), response = deferred<Response>(), io = { ...ended, settled: false }, abort = vi.fn(() => s.close());
  const f = fixture((_query, signal) => {
    signal.addEventListener("abort", abort, { once: true });
    return { response: response.promise, completion: done.promise, inspect: () => io };
  });
  const x = prepared(s, f); s.start(x.view, x.handle, x.frame); await flush();
  const listener = vi.fn(); s.subscribe(x.view, listener); s.close(); await flush();
  expect(abort).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenCalledTimes(1);
  expect(s.getSnapshot().state).toMatchObject({ closed: true, occupied: true, canForget: false });
  response.resolve(f.response()); io.settled = true; done.resolve(); await x.handle.completion; await flush();
  expect(listener).toHaveBeenCalledTimes(1); expect(s.getSnapshot().state.occupied).toBe(false);
});
it.each(["cleanup-failed", "unavailable"])("4I48 %s remains occupied after the final notice without additional subscriptions", async (kind) => {
  const f = fixture(kind === "unavailable" ? (() => { throw Error("PRIVATE"); }) :
    (() => ({ response: Promise.resolve(f.response()), completion: Promise.resolve(),
      inspect: () => ({ ...ended, cleanupFailed: true }) })));
  const { s } = screen(), x = prepared(s, f); s.start(x.view, x.handle, x.frame);
  await x.handle.delivery; await x.handle.responseCompletion; await flush();
  const listener = vi.fn(); s.subscribe(x.view, listener); s.close(); await flush();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(s.getSnapshot()).toMatchObject({ display: null, state: { closed: true, occupied: true, canForget: false } });
  s.close(); await flush(); expect(listener).toHaveBeenCalledTimes(1); expect(f.port).toHaveBeenCalledTimes(1);
});
it("4I48 getters and repeated close after final notification perform no transport inspection or scheduling", async () => {
  const { s } = screen(), x = prepared(s); await complete(s, x);
  s.subscribe(x.view, vi.fn()); s.close(); await flush();
  const snapshot = s.getSnapshot(), timer = vi.spyOn(globalThis, "setTimeout"), queued = vi.spyOn(globalThis, "queueMicrotask");
  for (let i = 0; i < 20; i++) { s.close(); expect(s.getSnapshot()).toBe(snapshot); expect(s.selectDisplay(x.view, x.frame)).toBeNull(); }
  expect(timer).not.toHaveBeenCalled(); expect(queued).not.toHaveBeenCalled();
});
