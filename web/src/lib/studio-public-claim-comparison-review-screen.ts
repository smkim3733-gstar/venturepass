import type { createComparisonReviewRetainer, ComparisonReviewViewToken, ComparisonReviewCallHandle } from "./studio-public-claim-comparison-review-retainer";
import type { ComparisonReviewDisplayFrame } from "./studio-public-claim-comparison-review-display";

type Retainer = ReturnType<typeof createComparisonReviewRetainer>;
type Token = ComparisonReviewViewToken;
type Handle = ComparisonReviewCallHandle;
type Frame = ComparisonReviewDisplayFrame;
type Outcome = ReturnType<Retainer["display"]>;
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
function immutable<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
function fixedFrame(frame: Frame): Frame {
  if (["mounted", "open", "blocked", "dirty", "aborted"].some(
    (k) => typeof frame[k as keyof Frame] !== "boolean")) throw Error("INVALID_FRAME");
  // Preserve the original snapshot reference; never freeze the caller's company.
  return Object.freeze({ latest: frame.latest, snapshot: frame.snapshot,
    expected: structuredClone(frame.expected), mounted: frame.mounted, open: frame.open,
    blocked: frame.blocked, dirty: frame.dirty, aborted: frame.aborted });
}
const failure = (code: "BUSY" | "CLOSED" | "STALE_VIEW" | "STALE_CALL" | "INVALID_FRAME") =>
  Object.freeze({ ok: false as const, code });

/** One caller-owned inactive screen connection. Its internal notification remains
 * retained even without a UI subscriber. No React, transport or server ownership. */
export function createComparisonReviewScreen(retainer: Retainer) {
  // Pin the original port; no registry, retainer creation, fetch or lifecycle fallback.
  const r = {
    attachView: retainer.attachView, detachView: retainer.detachView, prepare: retainer.prepare,
    start: retainer.start, display: retainer.display, cancel: retainer.cancel, release: retainer.release,
    close: retainer.close, inspect: retainer.inspect, getSnapshot: retainer.getSnapshot,
    claimNotifications: retainer.claimNotifications,
  };
  let view: Token | null = null, handle: Handle | null = null, frame: Frame | null = null;
  let closed = false, invalidated = false, busy = false, notifying = false, epoch = 0;
  let notificationFailed = false, observationFailed = false, queued = false;
  let subscriber: { view: Token; listener: () => void } | undefined;
  let candidate: DeepReadonly<Outcome> = null;
  const capture = () => Object.freeze({ viewToken: view, ticket: handle?.ticket ?? null,
    state: r.getSnapshot(), display: candidate, notificationFailed, observationFailed });
  let snapshot = capture();

  function publish() {
    const next = capture();
    if (next.viewToken === snapshot.viewToken && next.ticket === snapshot.ticket &&
        next.state === snapshot.state && next.display === snapshot.display &&
        next.notificationFailed === snapshot.notificationFailed && next.observationFailed === snapshot.observationFailed) return;
    snapshot = next;
    if (queued || !subscriber) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const registration = subscriber;
      if (!registration || view !== registration.view) return;
      notifying = true;
      try { registration.listener(); }
      catch {
        if (subscriber === registration) subscriber = undefined;
        notificationFailed = true;
      } finally { notifying = false; publish(); }
    });
  }
  function current(token: Token, call: Handle | null = handle) {
    return !closed && view !== null && token === view && call !== null && call === handle &&
      r.getSnapshot().viewToken === token && r.getSnapshot().ticket === call.ticket && !r.getSnapshot().detached;
  }
  function clearCandidate() { candidate = null; epoch++; publish(); }
  function invalidate() {
    invalidated = true; frame = null; clearCandidate();
  }
  function refresh() {
    if (busy) return;
    busy = true;
    const originalEpoch = epoch, originalView = view, originalHandle = handle, originalFrame = frame;
    try {
      r.inspect(); // Explicit observation outside render; getSnapshot below is post-cleanup.
      let value: Outcome = null;
      if (!invalidated && originalView && originalHandle && originalFrame && current(originalView, originalHandle))
        value = r.display(originalView, originalHandle, originalFrame);
      if (value) r.inspect(); // Publish any cleanup failure discovered while validating display.
      if (value?.kind === "result" && !r.getSnapshot().canForget) value = null;
      if (originalEpoch !== epoch || !originalView || !current(originalView, originalHandle)) value = null;
      // Equal observations retain the published reference; these comparisons never run in render.
      if (JSON.stringify(value) !== JSON.stringify(candidate)) candidate = immutable(value);
    } catch { observationFailed = true; candidate = null; }
    finally { busy = false; publish(); }
  }
  function begin(token: Token, call?: Handle) {
    if (closed) return failure("CLOSED");
    if (!view || token !== view || r.getSnapshot().viewToken !== token) return failure("STALE_VIEW");
    if (call && handle !== call) return failure("STALE_CALL");
    if (busy || notifying) return failure("BUSY");
    return null;
  }
  function commit(token: Token, call: Handle, next: Frame) {
    if (!current(token, call) || invalidated) return false;
    try {
      const fixed = fixedFrame(next);
      if (!call.ticket.isCurrent(fixed)) throw Error("INVALID_FRAME");
      frame = fixed;
      return true;
    } catch {
      invalidate(); r.cancel(token, call); return false;
    }
  }
  if (!r.claimNotifications(refresh)) throw Error("COMPARISON_SCREEN_ALREADY_CONNECTED");
  return Object.freeze({
    // Both getters are pure: no inspect/display, new promises, cloning or cancellation.
    getSnapshot: () => snapshot,
    selectDisplay(token: Token, currentFrame: Frame): DeepReadonly<Outcome> {
      if (!current(token) || invalidated || !candidate || !handle) return null;
      try { return handle.ticket.isCurrent(currentFrame) ? candidate : null; } catch { return null; }
    },
    attachView() {
      if (closed) return null;
      subscriber = undefined; view = null; handle = null; frame = null; invalidated = false;
      clearCandidate(); const turn = epoch;
      const next = r.attachView();
      if (turn === epoch && !closed) view = next;
      refresh(); return turn === epoch && !closed && view === next ? next : null;
    },
    detachView(token: Token) {
      if (!view || view !== token) return false;
      subscriber = undefined; view = null; handle = null; invalidate();
      const result = r.detachView(token); refresh(); return result;
    },
    subscribe(token: Token, listener: () => void) {
      if (closed || !view || token !== view || typeof listener !== "function") return null;
      const registration = { view: token, listener };
      subscriber = registration;
      return () => { if (subscriber === registration) subscriber = undefined; };
    },
    prepare(token: Token, inputs: Parameters<Retainer["prepare"]>[1]) {
      const blocked = begin(token); if (blocked) return blocked;
      const previous = { handle, frame, invalidated };
      handle = null; frame = null; invalidated = false; clearCandidate();
      const turn = epoch;
      busy = true;
      try {
        const prepared = r.prepare(token, inputs);
        if (!prepared.ok && prepared.code === "BUSY" && turn === epoch && view === token && !closed) {
          handle = previous.handle; frame = previous.frame; invalidated = previous.invalidated;
        }
        if (prepared.ok && turn === epoch && view === token && !closed &&
            r.getSnapshot().viewToken === token) handle = prepared.handle;
        return prepared.ok && handle !== prepared.handle ? failure(closed ? "CLOSED" : "STALE_VIEW") : prepared;
      } finally { busy = false; refresh(); }
    },
    start(token: Token, call: Handle, next: Frame) {
      const blocked = begin(token, call); if (blocked) return blocked;
      if (!commit(token, call, next)) { refresh(); return failure("INVALID_FRAME"); }
      busy = true;
      try { return r.start(token, call, frame!); }
      finally { busy = false; refresh(); }
    },
    commitFrame(token: Token, call: Handle, next: Frame) {
      const valid = commit(token, call, next); refresh(); return valid;
    },
    cancel(token: Token, call: Handle) {
      if (!current(token, call)) return false;
      invalidate(); const result = r.cancel(token, call); refresh(); return result;
    },
    release(token: Token, call: Handle) {
      if (!current(token, call) || busy || notifying) return false;
      invalidate(); const released = r.release(call);
      if (released && handle === call) handle = null;
      refresh(); return released;
    },
    close() {
      closed = true; subscriber = undefined; view = null; handle = null; invalidate();
      r.close(); refresh();
    },
  });
}
