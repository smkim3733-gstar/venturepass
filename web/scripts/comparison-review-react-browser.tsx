import { StrictMode, Suspense, startTransition, useEffect, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createComparisonReviewRetainer } from "../src/lib/studio-public-claim-comparison-review-retainer";
import { createComparisonReviewScreen } from "../src/lib/studio-public-claim-comparison-review-screen";
import { useComparisonReviewScreen, type ComparisonReviewReactFrame } from "../src/lib/studio-public-claim-comparison-review-react";
import type { ComparisonReviewRequestStart } from "../src/lib/studio-public-claim-comparison-review-invocation";

export type ReviewMountFixture = {
  snapshot: ComparisonReviewReactFrame["snapshot"];
  expected: ComparisonReviewReactFrame["expected"];
  query: Parameters<ComparisonReviewRequestStart>[0];
  success: string; error: string;
};
type Mode = "success" | "pending" | "error" | "cleanup-failed" | "unavailable" | "unsupported" | "missing-screen" | "close-on-attach";
type Screen = ReturnType<typeof createComparisonReviewScreen>;
type Adapter = ReturnType<typeof useComparisonReviewScreen>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** Test entry only. All company/wire bytes arrive as Node-validated synthetic JSON. */
function createHarness(data: ReviewMountFixture, mode: Mode) {
  const retainer = createComparisonReviewRetainer(), screen = createComparisonReviewScreen(retainer);
  const metrics = { attach: 0, detach: 0, subscribe: 0, unsubscribe: 0, close: 0, prepare: 0, start: 0,
    request: 0, inspect: 0, renderSideEffects: 0, commitFrame: 0, cancel: 0, release: 0, layoutSetup: 0, layoutCleanup: 0,
    passiveSetup: 0, passiveCleanup: 0, renders: 0, queryMatches: 0, aborted: 0,
    notifications: 0, terminalNotifications: 0, rendersRequested: 0 };
  let rendering = false, signalDetach = false, prepareDetach = false, reenter = false, lastCode = "";
  let prepareClose = false, signalClose = false;
  let latest: Adapter | null = null, saved: Adapter | null = null;
  let currentFrame: ComparisonReviewReactFrame = { snapshot: data.snapshot, expected: data.expected,
    open: true, blocked: false, dirty: false, aborted: false };
  const renderLog: { dirty: boolean; display: string | null }[] = [];
  const response = deferred<Response>(), completion = deferred<void>();
  const io = { started: true, delivered: false, settled: false, cleanupFailed: false };
  let lastSignal: AbortSignal | undefined;
  const record = (key: "attach" | "detach" | "subscribe" | "unsubscribe" | "close" | "prepare" | "start" | "inspect" | "commitFrame" | "cancel" | "release") => {
    metrics[key]++; if (rendering) metrics.renderSideEffects++;
  };
  const tracked: Screen = {
    ...screen,
    attachView() {
      record("attach"); const token = screen.attachView();
      if (token && mode === "close-on-attach") tracked.close();
      return token;
    },
    detachView(token) { record("detach"); return screen.detachView(token); },
    subscribe(token, listener) {
      record("subscribe");
      const off = screen.subscribe(token, () => {
        metrics.notifications++;
        if (screen.getSnapshot().state.closed) metrics.terminalNotifications++;
        listener();
      });
      return off ? () => { record("unsubscribe"); off(); } : null;
    },
    prepare(token, inputs) {
      record("prepare");
      if (reenter) { reenter = false; lastCode = String(latest?.read({ signal: new AbortController().signal, startRequest: port }).ok); }
      const value = screen.prepare(token, inputs);
      if (prepareDetach) { prepareDetach = false; flushSync(() => root.render(null)); }
      if (prepareClose) { prepareClose = false; tracked.close(); }
      return value;
    },
    start(token, handle, frame) { record("start"); return screen.start(token, handle, frame); },
    commitFrame(token, handle, frame) { record("commitFrame"); return screen.commitFrame(token, handle, frame); },
    cancel(token, handle) { record("cancel"); return screen.cancel(token, handle); },
    release(token, handle) { record("release"); return screen.release(token, handle); },
    close() { record("close"); screen.close(); },
  };
  let connection: Screen | null = mode === "missing-screen" ? null : tracked;
  const port: ComparisonReviewRequestStart = (query, signal) => {
    metrics.request++;
    if (JSON.stringify(query) === JSON.stringify(data.query)) metrics.queryMatches++;
    lastSignal = signal; signal.addEventListener("abort", () => { metrics.aborted++; }, { once: true });
    if (mode === "unavailable") return {} as ReturnType<ComparisonReviewRequestStart>;
    if (mode === "success") {
      io.delivered = true; io.settled = true;
      response.resolve(new Response(data.success, { headers: { "content-type": "application/json; charset=utf-8" } }));
      completion.resolve();
    }
    if (mode === "error") {
      io.delivered = true;
      response.resolve(new Response(data.error, { status: 409, headers: { "content-type": "application/json; charset=utf-8" } }));
    }
    return { response: response.promise, completion: completion.promise,
      inspect() { record("inspect"); return { ...io }; } };
  };
  const options = () => {
    const signal = new AbortController().signal;
    if (signalDetach || signalClose) {
      const closing = signalClose;
      signalDetach = false; signalClose = false;
      const listen = signal.addEventListener.bind(signal);
      let detached = false;
      Object.defineProperty(signal, "addEventListener", { value: (...args: Parameters<typeof signal.addEventListener>) => {
        listen(...args);
        if (!detached) {
          detached = true;
          if (closing) tracked.close(); else flushSync(() => root.render(null));
        }
      } });
    }
    return { signal, startRequest: mode === "unsupported" ? null : port };
  };
  const root = createRoot(document.getElementById("root")!);
  const never = new Promise<void>(() => {});
  function Probe({ frame, suspended }: { frame: ComparisonReviewReactFrame; suspended: boolean }) {
    rendering = true;
    const adapter = useComparisonReviewScreen(connection, frame);
    rendering = false;
    metrics.renders++;
    renderLog.push({ dirty: frame.dirty, display: adapter.display?.kind ?? null });
    useLayoutEffect(() => { latest = adapter; });
    useLayoutEffect(() => {
      metrics.layoutSetup++;
      return () => { metrics.layoutCleanup++; };
    }, []);
    useEffect(() => {
      metrics.passiveSetup++;
      return () => { metrics.passiveCleanup++; };
    }, []);
    if (suspended) throw never;
    return <><button id="read" onClick={() => { const result = adapter.read(options()); lastCode = result.ok ? "OK" : result.code; }}>Read</button>
      <button id="cancel" onClick={() => adapter.cancel()}>Cancel</button>
      <button id="release" onClick={() => adapter.release()}>Release</button>
      <output id="state">{JSON.stringify({ status: adapter.status, occupied: adapter.occupied,
        canForget: adapter.canForget, canPrepare: adapter.canPrepare, display: adapter.display })}</output></>;
  }
  function render(suspended = false) {
    metrics.rendersRequested++;
    root.render(<StrictMode><Suspense fallback={<p>Suspended</p>}><Probe frame={currentFrame} suspended={suspended} /></Suspense></StrictMode>);
  }
  flushSync(() => render());
  return {
    read() { const value = latest!.read(options()); lastCode = value.ok ? "OK" : value.code; return lastCode; },
    save() { saved = latest; },
    oldRead() { const value = saved!.read(options()); return value.ok ? "OK" : value.code; },
    oldCancel() { return saved!.cancel(); },
    update(kind: string) {
      if (kind === "restore") currentFrame = { snapshot: data.snapshot, expected: data.expected, open: true, blocked: false, dirty: false, aborted: false };
      else if (kind === "snapshot") currentFrame = { ...currentFrame, snapshot: { ...data.snapshot } };
      else if (kind === "revision") currentFrame = { ...currentFrame, snapshot: { ...data.snapshot, revision: data.snapshot.revision + 1 } };
      else if (kind === "selection") currentFrame = { ...currentFrame, expected: { ...data.expected, sectionKey: "other" } };
      else if (kind === "closed") currentFrame = { ...currentFrame, open: false };
      else if (kind === "connection") connection = { ...tracked };
      else if (kind === "missing") connection = null;
      else if (kind === "same") { /* same props, explicit rerender */ }
      else currentFrame = { ...currentFrame, [kind]: true };
      flushSync(() => render());
    },
    abandon() { currentFrame = { ...currentFrame, dirty: true }; startTransition(() => render(true)); },
    remount() { flushSync(() => root.render(null)); flushSync(() => render()); },
    detachDuringPrepare() { prepareDetach = true; },
    detachDuringConstruction() { signalDetach = true; },
    closeDuringPrepare() { prepareClose = true; },
    closeDuringConstruction() { signalClose = true; },
    reenterPrepare() { reenter = true; },
    unmount() { flushSync(() => root.render(null)); },
    dispose() { root.unmount(); },
    parentClose() { tracked.close(); },
    finishResponse() {
      io.delivered = true;
      response.resolve(new Response(data.success, { headers: { "content-type": "application/json; charset=utf-8" } }));
    },
    finishRequest(failed = false) { io.settled = true; io.cleanupFailed = failed; completion.resolve(); },
    snapshot() {
      const state = retainer.getSnapshot();
      return { metrics: { ...metrics }, lastCode, frameOpen: currentFrame.open,
        renderLog: [...renderLog], signalAborted: lastSignal?.aborted ?? false,
        retained: { occupied: state.occupied, closed: state.closed, canForget: state.canForget,
          requestCompleted: state.requestCompleted, responseCompleted: state.responseCompleted,
          observerFailed: state.observerFailed, io: state.io },
        display: latest?.display ?? null };
    },
  };
}
declare global { interface Window { reviewMount: ReturnType<typeof createHarness>; startReviewMount: typeof createHarness; } }
window.startReviewMount = createHarness;
