import {
  copyComparisonReviewQuery, decodeComparisonReviewWire, comparisonReviewWireLimits as limits,
  ComparisonReviewReceiveError, type ComparisonReviewReceiveCode, type ComparisonReviewWireResult,
} from "./studio-public-claim-comparison-review-wire";

/** One injected local response, never fetch or a server lifetime capability.
 * Keep this object until completion; cancellation is only delivery/body cancellation. */
export function createComparisonReviewReceiver(rawQuery: unknown, signal: AbortSignal) {
  const query = copyComparisonReviewQuery(rawQuery);
  if (!(signal instanceof AbortSignal)) throw new ComparisonReviewReceiveError("INVALID_QUERY");
  const controller = new AbortController(), deadline = performance.now() + limits.timeoutMs;
  let started = false, pumpDone = false, terminal = false, settled = false, cleanupFailed = false;
  let delivered = false, cancelStarted = false;
  let stream: ReadableStream<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancellation: Promise<void> | undefined;
  let resolveDelivery!: (result: ComparisonReviewWireResult) => void;
  let rejectDelivery!: (error: ComparisonReviewReceiveError) => void;
  let resolveCompletion!: () => void;
  const delivery = new Promise<ComparisonReviewWireResult>((resolve, reject) => {
    resolveDelivery = resolve; rejectDelivery = reject;
  });
  void delivery.catch(() => undefined);
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  const onAbort = () => stop("CANCELLED");
  const timer = setTimeout(() => stop("TIMEOUT"), limits.timeoutMs);
  function finish() {
    if (settled || !terminal || (started && !pumpDone) || cancellation) return;
    try { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
    catch { cleanupFailed = true; }
    settled = true;
    resolveCompletion();
  }
  function cancelBody() {
    if (cancelStarted || !stream) return;
    cancelStarted = true;
    try {
      const original = reader ? reader.cancel() : stream.cancel();
      cancellation = Promise.resolve(original).then(
        () => { cancellation = undefined; finish(); },
        () => { cleanupFailed = true; cancellation = undefined; finish(); },
      );
    } catch { cleanupFailed = true; }
  }
  function stop(code: ComparisonReviewReceiveCode) {
    if (!terminal) {
      terminal = true;
      rejectDelivery(new ComparisonReviewReceiveError(code));
      try { controller.abort(); } catch { cleanupFailed = true; }
    }
    if (!delivered) cancelBody();
    finish();
  }
  function check() {
    if (!terminal && signal.aborted) stop("CANCELLED");
    if (!terminal && performance.now() >= deadline) stop("TIMEOUT");
    if (terminal) throw new ComparisonReviewReceiveError("CANCELLED");
  }
  function release() {
    if (!reader) return;
    reader.releaseLock();
    reader = undefined;
  }
  async function collect(raw: Response) {
    if (!(raw instanceof Response)) throw new ComparisonReviewReceiveError("INVALID_RESPONSE");
    const get = (key: string) => Object.getOwnPropertyDescriptor(Response.prototype, key)!.get!.call(raw);
    stream = get("body");
    check(); // A late response still belongs to our cancellation/settlement.
    const status: number = get("status");
    const headers = new Headers(get("headers"));
    if (status === 0 || get("redirected") || get("bodyUsed") || stream?.locked)
      throw new ComparisonReviewReceiveError("INVALID_RESPONSE");
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(headers.get("content-type") ?? ""))
      throw new ComparisonReviewReceiveError("INVALID_RESPONSE");
    const cap = status === 200 ? limits.successBytes : limits.errorBytes;
    const length = headers.get("content-length");
    if (length !== null && (!/^(0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length))))
      throw new ComparisonReviewReceiveError("INVALID_RESPONSE");
    if (length !== null && Number(length) > cap) throw new ComparisonReviewReceiveError("RECEIVE_LIMIT");
    if (!stream) throw new ComparisonReviewReceiveError("INVALID_RESPONSE");
    reader = stream.getReader();
    const buffer = new Uint8Array(cap);
    let size = 0;
    for (;;) {
      check();
      const part = await reader.read();
      check();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new ComparisonReviewReceiveError("INVALID_RESPONSE");
      if (part.value.byteLength > cap - size) throw new ComparisonReviewReceiveError("RECEIVE_LIMIT");
      buffer.set(part.value, size); size += part.value.byteLength;
    }
    try { release(); } catch { cleanupFailed = true; throw new ComparisonReviewReceiveError("RECEIVE_FAILED"); }
    if (!size) throw new ComparisonReviewReceiveError("INVALID_RESPONSE");
    check();
    // Retain a BOM for the strict decoder to reject it, rather than silently stripping it.
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size)); }
    catch { throw new ComparisonReviewReceiveError("INVALID_RESPONSE"); }
    const value = decodeComparisonReviewWire(text, status, query);
    check();
    delivered = true;
    terminal = true;
    resolveDelivery(value);
  }
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) stop("CANCELLED");
  return Object.freeze({
    delivery, completion,
    inspect: () => Object.freeze({ started, delivered, settled, cleanupFailed }),
    cancel: () => stop("CANCELLED"),
    start(start: (signal: AbortSignal) => Promise<Response>) {
      if (started || terminal) return delivery;
      try { check(); } catch { return delivery; }
      started = true;
      let original: Promise<Response>;
      try { original = start(controller.signal); } catch { original = Promise.reject(new ComparisonReviewReceiveError("RECEIVE_FAILED")); }
      void Promise.resolve(original).then(collect).catch((e: unknown) => {
        stop(e instanceof ComparisonReviewReceiveError ? e.code : "RECEIVE_FAILED");
      }).then(() => {
        pumpDone = true;
        if (reader) {
          try { release(); } catch { cleanupFailed = true; }
        }
        stream = null;
        finish();
      });
      return delivery;
    },
  });
}
