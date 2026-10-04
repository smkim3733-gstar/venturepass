import { getVentureOverview } from "@/lib/venturein-overview";
import { jsonResponse, studioRoute, StudioError } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError(
        "연결 기록 조회에는 추가 입력을 사용할 수 없습니다.",
        400,
        "INVALID_INPUT",
      );
    const { caseId } = await context.params;
    return jsonResponse(getVentureOverview(caseId));
  });
}
