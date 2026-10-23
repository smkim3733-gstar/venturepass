import { comparisonExecutionHttpServer } from "@/lib/studio-comparison-execution-http-server";
import { jsonResponse } from "@/lib/studio-http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await context.params;
    if (request.bodyUsed) throw Error("BODY_USED");
    const init: RequestInit & { duplex: "half" } = {
      method: request.method,
      headers: new Headers(request.headers),
      body: request.body,
      signal: request.signal,
      duplex: "half",
    };
    const original = new Request(request.url, init);
    return await comparisonExecutionHttpServer().handle(
      original,
      caseId,
      async (companyId, revision) => {
        const { openConfiguredComparison } = await import("@/lib/studio-comparison-execution-open");
        return openConfiguredComparison(companyId, revision);
      },
    ).response;
  } catch {
    return jsonResponse(
      { kind: "comparison-execution-error", code: "INVALID_QUERY", runtimeObserved: false },
      400,
    );
  }
}
