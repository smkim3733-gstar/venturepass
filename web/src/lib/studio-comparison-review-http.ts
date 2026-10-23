import type { ComparisonReviewRequestStart } from "./studio-public-claim-comparison-review-invocation";
import { copyComparisonReviewQuery } from "./studio-public-claim-comparison-review-wire";
import { decodeStoredReviewCatalog, storedReviewHeaders } from "./studio-comparison-review-catalog";

export async function fetchStoredReviewCatalog(
  company: { id: string; revision: number },
  signal: AbortSignal,
) {
  const response = await fetch(
    `/api/studio/cases/${company.id}/public-claim-comparison/stored-reviews?revision=${company.revision}`,
    {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    },
  );
  if (!response.body) throw Error("CATALOG_UNAVAILABLE");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.byteLength;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw Error("CATALOG_LIMIT");
      }
      chunks.push(value.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!response.ok)
    throw Error(
      value?.code === "NOT_CONFIGURED"
        ? "NOT_CONFIGURED"
        : value?.code === "CLEANUP_REQUIRED"
          ? "CLEANUP_REQUIRED"
          : "CATALOG_UNAVAILABLE",
    );
  return decodeStoredReviewCatalog(value, company);
}
export function createStoredReviewRequest(
  origin: string,
  company: { id: string; revision: number },
  original: Parameters<ComparisonReviewRequestStart>[0],
  fetcher: typeof fetch,
): ComparisonReviewRequestStart {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^[a-f0-9-]{36}$/.test(company.id) ||
    !Number.isSafeInteger(company.revision) ||
    company.revision < 0
  )
    throw Error("INVALID_QUERY");
  const query = copyComparisonReviewQuery(original),
    body = JSON.stringify(query);
  const endpoint = `${origin}/api/studio/cases/${company.id}/public-claim-comparison/stored-review`;
  const headers = {
    "content-type": "application/json",
    [storedReviewHeaders.revision]: String(company.revision),
    [storedReviewHeaders.run]: query.runId,
    [storedReviewHeaders.dispatch]: query.dispatchCommandDigest,
  };
  return (selected, signal) => {
    if (JSON.stringify(copyComparisonReviewQuery(selected)) !== body)
      throw Error("SELECTION_CHANGED");
    let delivered = false,
      settled = false,
      cleanupFailed = false;
    const response = Promise.resolve()
      .then(() =>
        fetcher(endpoint, {
          method: "POST",
          headers,
          body,
          signal,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
        }),
      )
      .then((value) => {
        delivered = true;
        cleanupFailed = value.headers.get(storedReviewHeaders.receipt) !== "complete";
        return value;
      });
    const completion = response.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
        cleanupFailed = true;
      },
    );
    return Object.freeze({
      response,
      completion,
      inspect: () => ({ started: true, delivered, settled, cleanupFailed }),
    });
  };
}
