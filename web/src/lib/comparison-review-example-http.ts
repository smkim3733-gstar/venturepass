import type { ComparisonReviewRequestStart } from "./studio-public-claim-comparison-review-invocation";
import { copyComparisonReviewQuery } from "./studio-public-claim-comparison-review-wire";

export const exampleRequestReceipt = "x-venturepass-example-request";
export const exampleRequestMarker = "x-venturepass-review-example";

/** Synthetic-only same-origin HTTP. Receipt covers the server Request reader,
 * NOT SQL/service recovery. A missing receipt never grants canForget. */
export function createExampleReviewRequest(origin: string, companyId: string,
  original: Parameters<ComparisonReviewRequestStart>[0], fetcher: typeof fetch): ComparisonReviewRequestStart {
  const local = new URL(origin);
  if (local.origin !== origin || !["http:", "https:"].includes(local.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) ||
      !/^[a-f0-9-]{36}$/.test(companyId)) throw Error("EXAMPLE_LOCAL_ONLY");
  const query = copyComparisonReviewQuery(original), body = JSON.stringify(query);
  const url = origin + "/api/studio/cases/" + companyId + "/public-claim-comparison/stored-review";
  return (selected, signal) => {
    if (JSON.stringify(copyComparisonReviewQuery(selected)) !== body) throw Error("EXAMPLE_SELECTION_CHANGED");
    let delivered = false, settled = false, cleanupFailed = false;
    // Invocation owns cancellation, timeout and bounded Response consumption.
    const response = Promise.resolve().then(() => fetcher(url, {
      method: "POST", headers: { "content-type": "application/json", [exampleRequestMarker]: "1" },
      body, signal, credentials: "omit", cache: "no-store", redirect: "error",
    })).then((value) => {
      delivered = true;
      cleanupFailed = value.headers.get(exampleRequestReceipt) !== "complete";
      return value;
    });
    const completion = response.then(() => { settled = true; }, () => {
      settled = true; cleanupFailed = true;
    });
    return Object.freeze({ response, completion,
      inspect: () => Object.freeze({ started: true, delivered, settled, cleanupFailed }) });
  };
}
