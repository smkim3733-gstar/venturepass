import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { jsonResponse, studioRoute, StudioError } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(
  request: Request,
  context: { params: Promise<{ caseId: string; packageId: string }> },
) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
    const { caseId, packageId } = z
      .object({ caseId: z.string().uuid(), packageId: z.string().uuid() })
      .parse(await context.params);
    return jsonResponse({ package: getStudioStore().getPreparedPackage(caseId, packageId) });
  });
}
