import "server-only";
import { providerTransportSdkOptions } from "./studio-plan-quality-provider-sdk-options";

export const comparisonBodyLimits = Object.freeze({
  successBytes: 4 * 1024 * 1024,
  errorBytes: 64 * 1024,
  timeoutMs: providerTransportSdkOptions.timeout,
});
const failure = () => Error("PUBLIC_COMPARISON_BODY_UNKNOWN");

/** Internal byte/IO mechanism, not a send capability. The execution owner constructs it
 * after its fresh dispatch acknowledgement. No SDK, fetch fallback, config or JSON parser. */
export function createComparisonBodyBoundary() {
  const controller = new AbortController();
  const deadline = performance.now() + comparisonBodyLimits.timeoutMs;
  let sealed = false, started = false, pumpDone = false, delivered = false;
  let terminal = false, settled = false, cleanupFailed = false, cancelStarted = false;
  let stream: ReadableStream<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancellation: Promise<void> | undefined;
  let wireSignal: AbortSignal | undefined;
  let rejectDelivery: ((reason: Error) => void) | undefined;
  let resolveSettlement!: () => void;
  const completion = new Promise<void>((resolve) => { resolveSettlement = resolve; });
  const onAbort = () => stop();
  const timer = setTimeout(onAbort, comparisonBodyLimits.timeoutMs);

  function checkSettlement() {
    if (settled || !sealed || (started && !pumpDone) || cancellation) return;
    try {
      clearTimeout(timer);
      wireSignal?.removeEventListener("abort", onAbort);
    } catch {
      cleanupFailed = true;
    }
    wireSignal = undefined;
    settled = true;
    resolveSettlement();
  }
  function cancelBody() {
    if (cancelStarted || !stream) return;
    cancelStarted = true;
    try {
      const original = reader ? reader.cancel() : stream!.cancel();
      cancellation = Promise.resolve(original).then(
        () => { cancellation = undefined; checkSettlement(); },
        () => { cleanupFailed = true; cancellation = undefined; checkSettlement(); },
      );
    } catch {
      cleanupFailed = true;
    }
  }
  function stop() {
    if (!terminal) {
      terminal = true;
      const reject = rejectDelivery;
      rejectDelivery = undefined;
      reject?.(failure());
      try { controller.abort(); } catch { cleanupFailed = true; }
    }
    // A late Response creates a cancellation responsibility even after the fast rejection.
    if (!delivered) cancelBody();
  }
  function check() {
    if (terminal || controller.signal.aborted || wireSignal?.aborted ||
        performance.now() >= deadline) {
      stop();
      throw failure();
    }
  }
  async function collect(raw: Response) {
    if (!(raw instanceof Response)) throw failure();
    // Use native Response accessors; subclass getters are not response evidence.
    const get = (key: string) => Object.getOwnPropertyDescriptor(Response.prototype, key)!.get!.call(raw);
    stream = get("body");
    check();
    const status: number = get("status"), statusText: string = get("statusText");
    const headers = new Headers(get("headers"));
    if (status === 0 || get("redirected") || get("bodyUsed") || stream?.locked) throw failure();
    const cap = get("ok") ? comparisonBodyLimits.successBytes : comparisonBodyLimits.errorBytes;
    const length = headers.get("content-length");
    if (length !== null && (!/^(0|[1-9]\d*)$/.test(length) ||
        !Number.isSafeInteger(Number(length)) || Number(length) > cap)) throw failure();
    let buffer: Uint8Array<ArrayBuffer> | undefined;
    let size = 0;
    if (stream) {
      reader = stream.getReader();
      buffer = new Uint8Array(cap);
      for (;;) {
        check();
        const part = await reader.read();
        check();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || part.value.byteLength > cap - size)
          throw failure();
        buffer.set(part.value, size);
        size += part.value.byteLength;
      }
      try { reader.releaseLock(); } catch {
        cleanupFailed = true;
        throw failure();
      }
      reader = undefined;
    }
    check();
    headers.delete("content-encoding");
    headers.set("content-length", String(size));
    // Response's own copy is bounded. Never expose a truncated prefix or reserialize JSON.
    const bounded = new Response(buffer ? buffer.subarray(0, size) : null,
      { status, statusText, headers });
    check();
    delivered = true;
    return bounded;
  }
  function start(wire: RequestInit, network: (wire: RequestInit) => Promise<Response>) {
    if (sealed || started) return Promise.reject(failure());
    check();
    if (!(wire.signal instanceof AbortSignal)) throw failure();
    wireSignal = wire.signal;
    check();
    wireSignal.addEventListener("abort", onAbort, { once: true });
    started = true;
    let resolveDelivery!: (response: Response) => void;
    const delivery = new Promise<Response>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    // Install observers synchronously before returning from the caller's final SQL guard.
    void delivery.catch(() => undefined);
    let original: Promise<Response>;
    try { original = network(wire); } catch { original = Promise.reject(failure()); }
    void Promise.resolve(original).then(collect).then(
      (bounded) => { if (!terminal) { rejectDelivery = undefined; resolveDelivery(bounded); } else stop(); },
      () => { stop(); },
    ).then(() => {
      pumpDone = true;
      // Cancel may unblock an outstanding read. Its own promise must also settle.
      if (reader) {
        try { reader.releaseLock(); reader = undefined; } catch { cleanupFailed = true; }
      }
      stream = null;
      checkSettlement();
    });
    return delivery;
  }
  return Object.freeze({
    signal: controller.signal,
    start,
    completion,
    seal() {
      if (sealed) return;
      sealed = true;
      if (!delivered) stop();
      checkSettlement();
    },
    inspect: () => Object.freeze({ settled, cleanupFailed, delivered }),
  });
}
