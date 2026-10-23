import { cancellationHttpServer } from "@/lib/studio-comparison-cancellation-http";
import { jsonResponse } from "@/lib/studio-http";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await context.params;
    if (request.bodyUsed) throw Error("BODY_USED");
    const original = new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers),
      body: request.body,
      signal: request.signal,
      duplex: "half",
    } as RequestInit);
    const { openConfiguredCancellation } =
      await import("@/lib/studio-comparison-cancellation-open");
    return await cancellationHttpServer().handle(original, caseId, openConfiguredCancellation)
      .response;
  } catch {
    return jsonResponse(
      { kind: "comparison-cancellation-error", code: "INVALID_QUERY", runtimeObserved: false },
      400,
    );
  }
}
