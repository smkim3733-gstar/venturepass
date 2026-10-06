import {
  copyComparisonReviewQuery, decodeComparisonReviewWire, comparisonReviewWireLimits as limits,
  ComparisonReviewReceiveError, type ComparisonReviewWireResult,
} from "./studio-public-claim-comparison-review-wire";
import { createComparisonReviewBodyIO } from "./studio-public-claim-comparison-review-body";

/** One injected local response, never fetch or a server lifetime capability.
 * Keep this object until completion; cancellation is only delivery/body cancellation. */
export function createComparisonReviewReceiver(rawQuery: unknown, signal: AbortSignal) {
  const query = copyComparisonReviewQuery(rawQuery);
  if (!(signal instanceof AbortSignal)) throw new ComparisonReviewReceiveError("INVALID_QUERY");
  const io = createComparisonReviewBodyIO<ComparisonReviewWireResult>(signal, {
    cancelled: "CANCELLED", timeout: "TIMEOUT", invalid: "INVALID_RESPONSE",
    limit: "RECEIVE_LIMIT", failed: "RECEIVE_FAILED",
  });
  return Object.freeze({
    delivery: io.delivery, completion: io.completion, inspect: io.inspect, cancel: io.cancel,
    start(start: (signal: AbortSignal) => Promise<Response>) {
      return io.start(async (ownedSignal) => {
        const raw = await start(ownedSignal);
        if (!(raw instanceof Response)) throw new ComparisonReviewReceiveError("INVALID_RESPONSE");
        const get = (key: string) => Object.getOwnPropertyDescriptor(Response.prototype, key)!.get!.call(raw);
        io.attach(get("body"), get("bodyUsed"));
        io.check(); // Late responses still retain their own body cancellation.
        const status: number = get("status"), headers = new Headers(get("headers"));
        if (status === 0 || get("redirected"))
          throw new ComparisonReviewReceiveError("INVALID_RESPONSE");
        if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(headers.get("content-type") ?? ""))
          throw new ComparisonReviewReceiveError("INVALID_RESPONSE");
        const cap = status === 200 ? limits.successBytes : limits.errorBytes;
        const length = headers.get("content-length");
        if (length !== null && (!/^(0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length))))
          throw new ComparisonReviewReceiveError("INVALID_RESPONSE");
        if (length !== null && Number(length) > cap) throw new ComparisonReviewReceiveError("RECEIVE_LIMIT");
        const bytes = await io.collect(cap);
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { throw new ComparisonReviewReceiveError("INVALID_RESPONSE"); }
        const value = decodeComparisonReviewWire(text, status, query);
        io.check();
        return value;
      });
    },
  });
}
