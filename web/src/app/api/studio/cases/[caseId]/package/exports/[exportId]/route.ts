import { z } from "zod";
import { redirectToExport } from "@/lib/studio-package-delivery";
import { PACKAGE_DOWNLOAD_NAME } from "@/lib/studio-package-types";
import { studioRoute, StudioError } from "@/lib/studio-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Web service: a package ZIP stored by POST .../package, downloaded through a short-lived link. */
export function GET(
  request: Request,
  context: { params: Promise<{ caseId: string; exportId: string }> },
) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
    const { caseId, exportId } = z
      .object({ caseId: z.string().uuid(), exportId: z.string().uuid() })
      .parse(await context.params);
    return redirectToExport(caseId, exportId, PACKAGE_DOWNLOAD_NAME);
  });
}
