import {
  ComparisonReviewReceiveError, comparisonReviewWireLimits,
  type ComparisonReviewReceiveCode,
} from "./studio-public-claim-comparison-review-wire";

type Failures = Readonly<{
  cancelled: ComparisonReviewReceiveCode; timeout: ComparisonReviewReceiveCode;
  invalid: ComparisonReviewReceiveCode; limit: ComparisonReviewReceiveCode; failed: ComparisonReviewReceiveCode;
}>;
type InitialBody = { body: ReadableStream<Uint8Array> | null; used: boolean };

/** Internal Request/Response byte lifetime. Policies come from adapters, never HTTP input.
 * This owns only its successfully acquired reader, not a service, session or another reader. */
export function createComparisonReviewBodyIO<T>(
  signal: AbortSignal, failures: Failures, initial?: InitialBody, startedAt = performance.now(),
) {
  const controller = new AbortController(), deadline = startedAt + comparisonReviewWireLimits.timeoutMs;
  let started = false, pumpDone = false, terminal = false, settled = false, cleanupFailed = false;
  let delivered = false, attached = false, cancelStarted = false, listening = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancellation: Promise<void> | undefined;
  let terminalCode: ComparisonReviewReceiveCode = failures.cancelled;
  let resolveDelivery!: (value: T) => void, rejectDelivery!: (error: ComparisonReviewReceiveError) => void;
  let resolveCompletion!: () => void;
  const delivery = new Promise<T>((resolve, reject) => { resolveDelivery = resolve; rejectDelivery = reject; });
  void delivery.catch(() => undefined);
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  const onAbort = () => stop(failures.cancelled);
  const timer = setTimeout(() => stop(failures.timeout), Math.max(0, deadline - performance.now()));
  const error = (code: ComparisonReviewReceiveCode): never => { throw new ComparisonReviewReceiveError(code); };
  function release() {
    if (!reader) return;
    reader.releaseLock();
    reader = undefined;
  }
  function unlisten() {
    if (!listening) return;
    signal.removeEventListener("abort", onAbort);
    listening = false;
  }
  function finish() {
    if (settled || !terminal || (started && !pumpDone) || cancellation) return;
    try { release(); } catch { cleanupFailed = true; }
    try { clearTimeout(timer); unlisten(); } catch { cleanupFailed = true; }
    settled = true;
    resolveCompletion();
  }
  function cancelBody() {
    if (cancelStarted || !reader) return;
    cancelStarted = true;
    try {
      cancellation = Promise.resolve(reader.cancel()).then(
        () => { cancellation = undefined; finish(); },
        () => { cleanupFailed = true; cancellation = undefined; finish(); },
      );
    } catch { cleanupFailed = true; }
  }
  function stop(code: ComparisonReviewReceiveCode) {
    if (!terminal) {
      terminal = true; terminalCode = code;
      rejectDelivery(new ComparisonReviewReceiveError(code));
      try { controller.abort(); } catch { cleanupFailed = true; }
    }
    if (!delivered) cancelBody();
    finish();
  }
  function check() {
    if (!terminal && signal.aborted) stop(failures.cancelled);
    if (!terminal && performance.now() >= deadline) stop(failures.timeout);
    if (terminal) error(terminalCode);
  }
  function attach(body: ReadableStream<Uint8Array> | null, used: boolean) {
    if (attached || used || body?.locked) error(failures.invalid);
    attached = true;
    // Do not retain/cancel a stream if acquiring its reader fails.
    if (body) reader = body.getReader();
    if (terminal) cancelBody();
  }
  async function collect(cap: number) {
    check();
    if (!reader) error(failures.invalid);
    const buffer = new Uint8Array(cap);
    let size = 0;
    for (;;) {
      check();
      const part = await reader!.read();
      check();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) error(failures.invalid);
      if (part.value.byteLength > cap - size) error(failures.limit);
      buffer.set(part.value, size); size += part.value.byteLength;
    }
    try { release(); } catch { cleanupFailed = true; error(failures.failed); }
    check();
    if (!size) error(failures.invalid);
    return buffer.subarray(0, size);
  }
  function beforeSync() {
    check();
    // Input is fully read/released. No async work follows before the synchronous service.
    try { unlisten(); } catch { cleanupFailed = true; error(failures.failed); }
    if (reader || cleanupFailed) error(failures.failed);
    check();
  }
  try {
    signal.addEventListener("abort", onAbort, { once: true }); listening = true;
    if (initial) attach(initial.body, initial.used);
    if (signal.aborted) stop(failures.cancelled);
  } catch (e) {
    stop(e instanceof ComparisonReviewReceiveError ? e.code : failures.failed);
  }
  return Object.freeze({
    delivery, completion, attach, collect, check, beforeSync,
    inspect: () => Object.freeze({ started, delivered, settled, cleanupFailed }),
    cancel: () => stop(failures.cancelled),
    reject: stop,
    start(work: (signal: AbortSignal) => Promise<T> | T) {
      if (started || terminal) return delivery;
      try { check(); } catch { return delivery; }
      started = true;
      let original: Promise<T> | T;
      try { original = work(controller.signal); }
      catch (e) { original = Promise.reject(e); }
      void Promise.resolve(original).then((value) => {
        check();
        delivered = true; terminal = true;
        resolveDelivery(value);
      }).catch((e: unknown) => {
        stop(e instanceof ComparisonReviewReceiveError ? e.code : failures.failed);
      }).then(() => { pumpDone = true; finish(); });
      return delivery;
    },
  });
}
