import { readBoundVentureMyStatus } from "@/lib/venturein-bound-my-status-service";
import { jsonResponse, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// No GET collection: only a user's explicit read of the current app-owned session.
export function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search ||
      request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      throw new StudioError("현재 화면 읽기 요청 형식을 확인해 주세요.", 400, "INVALID_INPUT");
    const body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 8 * 1024)));
    const { caseId } = await context.params;
    return jsonResponse(await readBoundVentureMyStatus(caseId, body));
  });
}
