import { createComparisonReviewInvocation } from "./studio-public-claim-comparison-review-invocation";
import type { ComparisonReviewDisplayFrame } from "./studio-public-claim-comparison-review-display";

type Invocation = ReturnType<typeof createComparisonReviewInvocation>;
type Inputs = Omit<Parameters<typeof createComparisonReviewInvocation>[0], "sequence">;
type IO = ReturnType<Invocation["inspect"]>;
declare const viewBrand: unique symbol;
export type ComparisonReviewViewToken = Readonly<{ [viewBrand]: true }>;
export type ComparisonReviewCallHandle = Readonly<Pick<Invocation,
  "ticket" | "supported" | "delivery" | "requestCompletion" | "responseCompletion" | "completion">>;
type Code = "CLOSED" | "STALE_VIEW" | "STALE_CALL" | "BUSY" | "INVALID_INPUT" | "SEQUENCE_EXHAUSTED";
type Failure = Readonly<{ ok: false; code: Code }>;
type Entry = {
  view: ComparisonReviewViewToken;
  call?: Invocation;
  handle?: ComparisonReviewCallHandle;
  detached: boolean;
  cancelSent: boolean;
  completionObserved: boolean;
  observerFailed: boolean;
  delivered?: boolean;
  requestCompleted?: boolean;
  responseCompleted?: boolean;
  io?: IO | null;
};
const failure = (code: Code): Failure => Object.freeze({ ok: false, code });

/** Caller-owned, single-slot retention across views/companies. No React/global registry,
 * transport acquisition or server lifetime capability. Keep even a closed holder while
 * occupied: unknown receipts and cleanup failures are never forcibly forgotten. */
export function createComparisonReviewRetainer() {
  let closed = false, critical = false, sequence = 0;
  let view: ComparisonReviewViewToken | null = null, entry: Entry | undefined;

  let notification: (() => void) | undefined, claimed = false, queued = false, notifying = false;
  let notificationFailed = false;
  let signature: unknown[] = [];
  function state() {
    const io = entry?.io ?? null;
    const clean = !entry || (entry.completionObserved && !entry.observerFailed && io?.canForget === true);
    return Object.freeze({ closed, viewToken: view, ticket: entry?.handle?.ticket ?? null, occupied: !!entry, creating: !!entry && !entry.call,
      detached: entry?.detached ?? false, observerFailed: entry?.observerFailed ?? false,
      delivered: entry?.delivered ?? false, requestCompleted: entry?.requestCompleted ?? false,
      responseCompleted: entry?.responseCompleted ?? false, completionObserved: entry?.completionObserved ?? false,
      notificationFailed, io, canPrepare: !closed && view !== null && clean, canForget: clean });
  }
  let snapshot = state();
  function schedule() {
    if (queued || !notification) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const listener = notification;
      if (!listener) return;
      notifying = true;
      try { listener(); }
      catch { notificationFailed = true; notification = undefined; }
      finally { notifying = false; notice(); }
    });
  }
  function notice() {
    if (critical) return; // The outer operation publishes the stable post-cleanup state.
    // Only private scalars/references: never inspect a Request while publishing.
    const next = [closed, view, entry, entry?.call, entry?.handle, entry?.detached, entry?.observerFailed, entry?.completionObserved,
      entry?.delivered, entry?.requestCompleted, entry?.responseCompleted, notificationFailed,
      JSON.stringify(entry?.io ?? null)];
    if (next.length === signature.length && next.every((v, i) => v === signature[i])) return;
    signature = next;
    snapshot = state();
    schedule();
  }
  notice();
  function read(e: Entry): IO | null {
    if (!e.call) return null;
    try { return e.io = e.call.inspect(); }
    catch { e.observerFailed = true; e.io = null; return null; }
  }
  function cancelEntry(e: Entry) {
    if (!e.detached || !e.call || e.cancelSent) return;
    e.cancelSent = true; // Reentrant abort listeners cannot cancel it twice.
    try { e.call.cancel(); } catch { e.observerFailed = true; }
  }
  // Runs only under the critical guard; inspect/abort callbacks may detach/close,
  // but cannot create, start, release, or inspect a second call in the middle.
  function reap(e: Entry) {
    if (entry !== e || !e.detached) return;
    cancelEntry(e);
    if (!e.completionObserved || e.observerFailed) return;
    const state = read(e);
    if (entry === e && e.detached && !e.observerFailed && state?.canForget) entry = undefined;
  }
  function maintain() {
    if (critical || !entry?.detached) return;
    critical = true;
    try { reap(entry); } finally { critical = false; }
  }
  function detach(e: Entry | undefined) {
    if (e) e.detached = true;
    maintain();
  }
  function current(token: ComparisonReviewViewToken, handle: ComparisonReviewCallHandle) {
    return !closed && view !== null && view === token && entry?.view === token && entry.handle === handle && !entry.detached;
  }

  const api = {
    attachView(): ComparisonReviewViewToken | null {
      if (closed) return null;
      const token = Object.freeze({}) as ComparisonReviewViewToken;
      view = token;
      detach(entry);
      // A synchronous abort/inspect callback can close or replace this view.
      return !closed && view === token ? token : null;
    },
    detachView(token: ComparisonReviewViewToken) {
      if (!view || view !== token) return false;
      view = null; detach(entry);
      return true;
    },
    prepare(token: ComparisonReviewViewToken, inputs: Inputs):
      Readonly<{ ok: true; handle: ComparisonReviewCallHandle }> | Failure {
      if (closed) return failure("CLOSED");
      if (!view || view !== token) return failure("STALE_VIEW");
      if (critical || notifying) return failure("BUSY");
      critical = true;
      let creating: Entry | undefined;
      try {
        if (entry) {
          const previous = entry;
          if (!previous.completionObserved || previous.observerFailed || !read(previous)?.canForget)
            return failure("BUSY");
          if (closed || view !== token || entry !== previous) return failure(closed ? "CLOSED" : "STALE_VIEW");
          previous.detached = true;
          reap(previous);
          if (entry) return failure("BUSY");
        }
        if (closed || view !== token) return failure(closed ? "CLOSED" : "STALE_VIEW");
        if (sequence >= Number.MAX_SAFE_INTEGER) return failure("SEQUENCE_EXHAUSTED");
        creating = { view: token, detached: false, cancelSent: false,
          completionObserved: false, observerFailed: false };
        entry = creating; // Reserve before reading inputs or constructing any receiver/timer.
        const { snapshot, expected, signal, startRequest } = inputs;
        const call = createComparisonReviewInvocation({ sequence: ++sequence, snapshot, expected, signal, startRequest });
        creating.call = call; // Retain before observing or exposing the original promises.
        const handle = Object.freeze({ ticket: call.ticket, supported: call.supported,
          delivery: call.delivery, requestCompletion: call.requestCompletion,
          responseCompletion: call.responseCompletion, completion: call.completion });
        creating.handle = handle;
        const retained = creating;
        // Observe originals before exposing the handle, including a failed prepare.
        for (const [promise, key] of [
          [call.delivery, "delivered"], [call.requestCompletion, "requestCompleted"],
          [call.responseCompletion, "responseCompleted"], [call.completion, "completionObserved"],
        ] as const) {
          void Promise.prototype.then.call(promise, () => {
            retained[key] = true;
            if (entry === retained) maintain();
            notice();
          }, () => {
            retained.observerFailed = true;
            notice();
          });
        }
        if (closed || view !== token || retained.detached) {
          retained.detached = true;
          return failure(closed ? "CLOSED" : "STALE_VIEW");
        }
        return Object.freeze({ ok: true, handle });
      } catch {
        // The fixed invocation factory validates input before creating its receiver.
        // Once a call exists, retain it even if observing/exposing it failed.
        if (creating && entry === creating) {
          if (creating.call) { creating.observerFailed = true; creating.detached = true; }
          else entry = undefined;
        }
        return failure("INVALID_INPUT");
      } finally { critical = false; maintain(); }
    },
    start(token: ComparisonReviewViewToken, handle: ComparisonReviewCallHandle, frame: ComparisonReviewDisplayFrame):
      Readonly<{ ok: true; delivery: Invocation["delivery"] }> | Failure {
      if (closed) return failure("CLOSED");
      if (!view || view !== token) return failure("STALE_VIEW");
      if (!current(token, handle)) return failure("STALE_CALL");
      if (critical || notifying) return failure("BUSY");
      const retained = entry!;
      critical = true;
      try {
        const delivery = retained.call!.start(frame);
        return Object.freeze({ ok: true, delivery });
      } catch {
        retained.observerFailed = true; retained.detached = true;
        return failure("INVALID_INPUT");
      } finally { critical = false; maintain(); }
    },
    display(token: ComparisonReviewViewToken, handle: ComparisonReviewCallHandle, frame: ComparisonReviewDisplayFrame):
      ReturnType<Invocation["display"]> {
      if (critical || !current(token, handle)) return null;
      const retained = entry!;
      critical = true;
      try {
        const result = retained.call!.display(frame);
        return current(token, handle) && entry === retained ? result : null;
      } catch { retained.observerFailed = true; return null; }
      finally { critical = false; maintain(); }
    },
    cancel(token: ComparisonReviewViewToken, handle: ComparisonReviewCallHandle) {
      if (!current(token, handle)) return false;
      detach(entry); return true;
    },
    release(handle: ComparisonReviewCallHandle) {
      if (critical || !entry || entry.handle !== handle) return false;
      const retained = entry;
      detach(retained);
      return entry !== retained;
    },
    close() {
      closed = true; view = null; detach(entry);
    },
    inspect() {
      const retained = entry;
      if (critical) return Object.freeze({ closed, viewAttached: view !== null,
        occupied: !!retained, creating: !!retained && !retained.call,
        observerFailed: retained?.observerFailed ?? false, io: null,
        canPrepare: false, canForget: false });
      critical = true;
      try {
        const io = retained ? read(retained) : null;
        const clean = !retained || (retained.completionObserved && !retained.observerFailed && io?.canForget === true);
        return Object.freeze({ closed, viewAttached: view !== null, occupied: !!entry,
          creating: !!entry && !entry.call, observerFailed: entry?.observerFailed ?? false, io,
          canPrepare: !closed && view !== null && clean,
          canForget: clean });
      } finally { critical = false; maintain(); }
    },
  };
  // Every observation is published after the original critical/finally cleanup.
  function invoke<T>(action: () => T): T {
    try { return action(); } finally { notice(); }
  }
  return Object.freeze({
    attachView: () => invoke(() => api.attachView()),
    detachView: (token: ComparisonReviewViewToken) => invoke(() => api.detachView(token)),
    prepare: (...args: Parameters<typeof api.prepare>) => invoke(() => api.prepare(...args)),
    start: (...args: Parameters<typeof api.start>) => invoke(() => api.start(...args)),
    display: (...args: Parameters<typeof api.display>) => invoke(() => api.display(...args)),
    cancel: (...args: Parameters<typeof api.cancel>) => invoke(() => api.cancel(...args)),
    release: (...args: Parameters<typeof api.release>) => invoke(() => api.release(...args)),
    close: () => invoke(() => api.close()),
    inspect: () => invoke(() => api.inspect()),
    // A last-observed immutable snapshot, not a fresh admission/release proof.
    getSnapshot: () => snapshot,
    claimNotifications(listener: () => void) {
      if (claimed || typeof listener !== "function") return false;
      claimed = true; notification = listener; return true;
    },
  });
}
