import "server-only";
import { z } from "zod";
import { assertLocalRequest } from "./studio-http";
import { createComparisonReviewBodyIO } from "./studio-public-claim-comparison-review-body";
import { encodeStoredComparisonReview, comparisonReviewErrorResponse,
  type ComparisonReviewReadPort } from "./studio-public-claim-comparison-review-server";
import {
  copyComparisonReviewQuery, comparisonReviewWireLimits, ComparisonReviewReceiveError,
  type ComparisonReviewErrorCode,
} from "./studio-public-claim-comparison-review-wire";

type Binding = Readonly<{
  service: ComparisonReviewReadPort;
  companyId: string; runId: string; dispatchCommandDigest: string; localOrigin: string;
}>;
const reject = (code: ComparisonReviewErrorCode): never => { throw new ComparisonReviewReceiveError(code); };

/** Explicit inactive composition. Caller owns the authentic service and original selection.
 * No service acquisition, registry, default store, HTTP installation or server lifetime port. */
export function createComparisonReviewRequestHandler(binding: Binding | null) {
  let fixed: Omit<Binding, "service"> | null = null;
  let read: ComparisonReviewReadPort["readStoredReviewByRun"] | undefined;
  if (binding) {
    try {
      const query = copyComparisonReviewQuery({ runId: binding.runId,
        dispatchCommandDigest: binding.dispatchCommandDigest, mode: "historical" });
      const companyId = z.string().uuid().parse(binding.companyId), origin = new URL(binding.localOrigin);
      if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== binding.localOrigin ||
          !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) reject("INVALID_QUERY");
      fixed = Object.freeze({ companyId, runId: query.runId,
        dispatchCommandDigest: query.dispatchCommandDigest, localOrigin: origin.origin });
      read = binding.service.readStoredReviewByRun.bind(binding.service);
    } catch { reject("INVALID_QUERY"); }
  }
  const scope = fixed, originalRead = read;
  return Object.freeze({
    supported: !!scope,
    handle(raw: Request) {
      const startedAt = performance.now();
      let request: { url: string; method: string; headers: Headers;
        body: ReadableStream<Uint8Array> | null; used: boolean; signal: AbortSignal } | undefined;
      try {
        if (!(raw instanceof Request)) reject("INVALID_QUERY");
        const get = (key: string) => Object.getOwnPropertyDescriptor(Request.prototype, key)!.get!.call(raw);
        request = { url: get("url"), method: get("method"), headers: new Headers(get("headers")),
          body: get("body"), used: get("bodyUsed"), signal: get("signal") };
        if (!(request.signal instanceof AbortSignal)) reject("INVALID_QUERY");
      } catch { request = undefined; }
      const saved = request;
      const io = createComparisonReviewBodyIO<Response>(
        saved?.signal ?? new AbortController().signal,
        { cancelled: "REQUEST_CANCELLED", timeout: "REQUEST_TIMEOUT",
          invalid: "INVALID_QUERY", limit: "TOO_LARGE", failed: "READ_FAILED" },
        saved ? { body: saved.body, used: saved.used } : undefined, startedAt,
      );
      io.start(async () => {
        if (!saved) reject("INVALID_QUERY");
        const { url: rawUrl, method, headers } = saved!;
        let url: URL;
        try { url = new URL(rawUrl); } catch { return reject("INVALID_QUERY"); }
        if (url.username || url.password || url.hash) reject("INVALID_QUERY");
        if (!["http:", "https:"].includes(url.protocol)) reject("LOCAL_ONLY");
        try {
          // A native header-only Request freezes the exact values used by the existing helper.
          // This is not a body clone and performs no HTTP operation.
          assertLocalRequest(new Request(rawUrl, { headers }));
        } catch { reject("LOCAL_ONLY"); }
        const origin = headers.get("origin");
        if (!origin || origin === "null") reject("LOCAL_ONLY");
        if (method !== "POST") reject("METHOD_NOT_ALLOWED");
        if (url.search) reject("INVALID_QUERY");
        if (!scope || !originalRead) reject("RESULT_UNAVAILABLE");
        const effective = new URL(url.protocol + "//" + (headers.get("host") ?? url.host));
        if (origin !== scope!.localOrigin || effective.origin !== scope!.localOrigin) reject("LOCAL_ONLY");
        if (url.pathname !== "/api/studio/cases/" + scope!.companyId + "/public-claim-comparison/stored-review")
          reject("INVALID_QUERY");
        if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(headers.get("content-type") ?? "") ||
            ![null, "identity"].includes(headers.get("content-encoding"))) reject("CONTENT_TYPE");
        const length = headers.get("content-length");
        if (length !== null && (!/^(0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length))))
          reject("INVALID_QUERY");
        if (length !== null && Number(length) > comparisonReviewWireLimits.queryBytes) reject("TOO_LARGE");
        const bytes = await io.collect(comparisonReviewWireLimits.queryBytes);
        let query;
        try {
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          query = copyComparisonReviewQuery(JSON.parse(text));
          if (JSON.stringify(query) !== text) reject("INVALID_QUERY");
        } catch { return reject("INVALID_QUERY"); }
        if (query.runId !== scope!.runId || query.dispatchCommandDigest !== scope!.dispatchCommandDigest)
          reject("INVALID_QUERY");
        io.beforeSync();
        const response = encodeStoredComparisonReview({
          readStoredReviewByRun(selection) {
            const result = originalRead!(selection);
            if (result.resultIdentity.selection.companyId !== scope!.companyId ||
                result.resultIdentity.runId !== scope!.runId ||
                result.resultIdentity.dispatchCommandDigest !== scope!.dispatchCommandDigest)
              throw Error("PUBLIC_COMPARISON_READ_SCOPE_CHANGED");
            return result;
          },
        }, query);
        io.check();
        return response;
      });
      const response = io.delivery.catch((e: unknown) => comparisonReviewErrorResponse(
        e instanceof ComparisonReviewReceiveError && [
          "INVALID_QUERY", "LOCAL_ONLY", "RESULT_UNAVAILABLE", "READ_BLOCKED", "TOO_LARGE",
          "CONTENT_TYPE", "READ_FAILED", "METHOD_NOT_ALLOWED", "REQUEST_CANCELLED", "REQUEST_TIMEOUT",
        ].includes(e.code) ? e.code as ComparisonReviewErrorCode : "READ_FAILED",
      ));
      return Object.freeze({ response, completion: io.completion, inspect: io.inspect });
    },
  });
}
