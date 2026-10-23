import { bookingHttpServer } from "@/lib/studio-comparison-booking-http";
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
    // Import only the passive server factory; no runtime/key/provider is opened here.
    const { openConfiguredBooking } = await import("@/lib/studio-comparison-booking-open");
    return await bookingHttpServer().handle(original, caseId, openConfiguredBooking).response;
  } catch {
    return jsonResponse(
      { kind: "comparison-booking-error", code: "INVALID_QUERY", runtimeObserved: false },
      400,
    );
  }
}
