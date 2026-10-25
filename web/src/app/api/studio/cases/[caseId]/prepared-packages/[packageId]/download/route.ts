import { z } from "zod";
import { downloadPreparedPackageForRequest } from "@/lib/studio-prepared-package-service";
import { studioRoute, StudioError } from "@/lib/studio-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Web service: the stored ZIP (up to 28MB) is read once to check its SHA-256 before the link.
export const maxDuration = 60;
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
    return downloadPreparedPackageForRequest(caseId, packageId);
  });
}
