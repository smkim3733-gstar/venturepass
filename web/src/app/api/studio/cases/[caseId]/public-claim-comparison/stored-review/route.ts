import { comparisonReviewExampleData } from "@/lib/comparison-review-example-data";
import { createComparisonReviewRequestHandler } from "@/lib/studio-public-claim-comparison-review-handler";
import { comparisonReviewErrorResponse } from "@/lib/studio-public-claim-comparison-review-server";
import { exampleRequestMarker, exampleRequestReceipt } from "@/lib/comparison-review-example-http";
import { assertLocalRequest } from "@/lib/studio-http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  try { assertLocalRequest(request); } catch { return comparisonReviewErrorResponse("LOCAL_ONLY"); }
  const { caseId } = await context.params, data = comparisonReviewExampleData();
  if (!request.headers.has(exampleRequestMarker)) {
    const { storedComparisonRoute } = await import("@/lib/studio-comparison-review-runtime");
    return storedComparisonRoute(request, caseId, "review");
  }
  // Explicit example requests stay on their fixed fixture and never acquire storage.
  if (caseId !== data.frame.snapshot.id || request.headers.get(exampleRequestMarker) !== "1")
    return comparisonReviewErrorResponse("RESULT_UNAVAILABLE");
  const origin = request.headers.get("origin");
  if (!origin) return comparisonReviewErrorResponse("LOCAL_ONLY");
  const handler = createComparisonReviewRequestHandler({
    companyId: caseId, ...data.query, localOrigin: origin,
    service: { readStoredReviewByRun(query) {
      if (JSON.stringify(query) !== JSON.stringify(data.query)) throw Error("EXAMPLE_SELECTION_CHANGED");
      return structuredClone(data.result);
    } },
  });
  // Next wraps route Requests in a tracking Proxy. Native prototype getters
  // cannot brand-check that proxy. Transfer its original stream (no clone/tee)
  // through public accessors into the native boundary expected by the handler.
  let native: Request;
  try {
    if (request.bodyUsed) return comparisonReviewErrorResponse("INVALID_QUERY");
    const init: RequestInit & { duplex: "half" } = {
      method: request.method, headers: new Headers(request.headers), body: request.body,
      signal: request.signal, duplex: "half",
    };
    native = new Request(request.url, init);
  } catch { return comparisonReviewErrorResponse("INVALID_QUERY"); }
  const operation = handler.handle(native);
  const response = await operation.response;
  await operation.completion;
  const state = operation.inspect();
  const headers = new Headers(response.headers);
  if (state.settled && !state.cleanupFailed) headers.set(exampleRequestReceipt, "complete");
  return new Response(response.body, { status: response.status, headers });
}
