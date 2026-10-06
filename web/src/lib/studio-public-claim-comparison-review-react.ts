"use client";

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { createComparisonReviewScreen } from "./studio-public-claim-comparison-review-screen";
import type { ComparisonReviewDisplayFrame } from "./studio-public-claim-comparison-review-display";
import type { ComparisonReviewCallHandle, ComparisonReviewViewToken } from "./studio-public-claim-comparison-review-retainer";

type Screen = ReturnType<typeof createComparisonReviewScreen>;
type Handle = ComparisonReviewCallHandle;
export type ComparisonReviewReactFrame = Omit<ComparisonReviewDisplayFrame, "latest" | "mounted">;
type Options = Pick<Parameters<Screen["prepare"]>[1], "startRequest" | "signal">;
type Setup = Readonly<{ screen: Screen; token: ComparisonReviewViewToken }>;
type OwnedCall = Readonly<{ setup: Setup; handle: Handle }>;
type Commit = { setup: Setup; snapshot: ComparisonReviewReactFrame["snapshot"] | null; signature: string; call: Handle | null; busy: boolean };
const emptySnapshot = () => null;
const failure = (code: "NOT_ATTACHED" | "STALE_VIEW" | "INVALID_INPUT" | "BUSY") =>
  Object.freeze({ ok: false as const, code });
function signature(frame: ComparisonReviewReactFrame) {
  try {
    return JSON.stringify([frame.snapshot.id, frame.snapshot.revision, frame.expected,
      frame.open, frame.blocked, frame.dirty, frame.aborted]);
  } catch { return ""; }
}

/** Inactive adapter: the caller retains the single screen/retainer outside React.
 * Cleanup only detaches its own view. It never closes or replaces that owner. */
export function useComparisonReviewScreen(connection: Screen | null, frame: ComparisonReviewReactFrame) {
  // Pure initial reference only; no factory/claim in render or repeated initializer.
  const [pinned] = useState(() => connection);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [owned, setOwned] = useState<OwnedCall | null>(null);
  const active = useRef<Commit | null>(null);
  const rejected = useRef(false);
  const frameSignature = signature(frame);

  useLayoutEffect(() => {
    if (connection !== pinned) rejected.current = true;
    if (!pinned || connection !== pinned || rejected.current) return;
    const token = pinned.attachView();
    if (!token) return;
    const own = Object.freeze({ screen: pinned, token });
    active.current = { setup: own, snapshot: null, signature: "", call: null, busy: false };
    // The token exists only after committing the external attachment, never in render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSetup(own);
    return () => {
      if (active.current?.setup === own) active.current = null;
      pinned.detachView(token);
    };
    // Frame updates are committed separately without detaching/recreating the view.
  }, [connection, pinned]);

  useLayoutEffect(() => {
    const current = active.current;
    if (!current || connection !== pinned) return;
    current.snapshot = frame.snapshot;
    current.signature = frameSignature;
    if (current.call) current.setup.screen.commitFrame(current.setup.token, current.call,
      { ...frame, latest: current.call.ticket, mounted: true });
  });

  const subscribe = useCallback((listener: () => void) => {
    if (!setup || connection !== pinned || active.current?.setup !== setup) return () => {};
    const before = setup.screen.getSnapshot();
    let subscribed = true;
    const notify = () => {
      if (subscribed && active.current?.setup === setup) listener();
    };
    const unsubscribe = setup.screen.subscribe(setup.token, notify);
    if (before !== setup.screen.getSnapshot()) notify();
    return () => { subscribed = false; unsubscribe?.(); };
  }, [setup, connection, pinned]);
  const snapshot = useSyncExternalStore(subscribe, pinned?.getSnapshot ?? emptySnapshot, emptySnapshot);

  function current() {
    const committed = active.current;
    return setup && connection === pinned && committed?.setup === setup &&
      committed.snapshot === frame.snapshot && frameSignature !== "" &&
      committed.signature === frameSignature ? committed : null;
  }
  function read(options: Options) {
    const committed = current();
    if (!committed) return failure("STALE_VIEW");
    if (committed.busy) return failure("BUSY");
    if (!frame.open || frame.dirty || frame.blocked || frame.aborted) return failure("STALE_VIEW");
    committed.busy = true;
    try {
      const inputs = { snapshot: frame.snapshot, expected: structuredClone(frame.expected),
        signal: options.signal, startRequest: options.startRequest };
      if (current() !== committed || signature(frame) !== committed.signature) return failure("STALE_VIEW");
      const prepared = committed.setup.screen.prepare(committed.setup.token, inputs);
      if (!prepared.ok) return prepared;
      // Retain the original handle before start and before any possible asynchronous yield.
      committed.call = prepared.handle;
      if (current() !== committed) {
        committed.setup.screen.cancel(committed.setup.token, prepared.handle);
        return failure("STALE_VIEW");
      }
      setOwned(Object.freeze({ setup: committed.setup, handle: prepared.handle }));
      return committed.setup.screen.start(committed.setup.token, prepared.handle,
        { ...frame, latest: prepared.handle.ticket, mounted: true });
    } catch { return failure("INVALID_INPUT"); }
    finally { committed.busy = false; }
  }
  function cancel() {
    const committed = current();
    return !!committed?.call && committed.setup.screen.cancel(committed.setup.token, committed.call);
  }
  function release() {
    const committed = current();
    return !!committed?.call && committed.setup.screen.release(committed.setup.token, committed.call);
  }
  // Never expose the raw candidate. Current props gate display even before effects run.
  const display = connection === pinned && setup && owned?.setup === setup
    ? setup.screen.selectDisplay(setup.token, { ...frame, mounted: true, latest: owned.handle.ticket })
    : null;
  return {
    display,
    status: !pinned ? "UNAVAILABLE" as const : connection !== pinned ? "CONNECTION_CHANGED" as const
      : !setup || snapshot?.viewToken !== setup.token ? "NOT_ATTACHED" as const : "ATTACHED" as const,
    occupied: snapshot?.state.occupied ?? false,
    canPrepare: snapshot?.state.canPrepare ?? false,
    canForget: snapshot?.state.canForget ?? false,
    notificationFailed: snapshot?.notificationFailed ?? false,
    observationFailed: snapshot?.observationFailed ?? false,
    read, cancel, release,
  } as const;
}
