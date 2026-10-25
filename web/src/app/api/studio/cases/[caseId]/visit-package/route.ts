import { z } from "zod";
import { buildVisitPackage } from "@/lib/studio-visit-package";
import { visitPackageLimits, visitPackageRequestSchema } from "@/lib/studio-visit-package-types";
import { withCaseStore } from "@/lib/studio-case-session";
import { assertZipDeliveryAvailable, deliverZip } from "@/lib/studio-package-delivery";
import { readBoundedBody, studioRoute, StudioError } from "@/lib/studio-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Web service: selected originals are read from storage and a ZIP is stored back.
export const maxDuration = 60;
export function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("이 요청에는 URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const caseId = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    const input = visitPackageRequestSchema.parse(
      JSON.parse(
        new TextDecoder().decode(await readBoundedBody(request, visitPackageLimits.requestBytes)),
      ),
    );
    assertZipDeliveryAvailable();
    const result = await withCaseStore(caseId, async ({ store, stageOriginals }) => {
      await stageOriginals(input.sourceIds);
      return buildVisitPackage(store, caseId, input);
    });
    return deliverZip(caseId, result);
  });
}
