import { z } from "zod";
import { withCaseStore } from "@/lib/studio-case-session";
import { buildPreparationPackage } from "@/lib/studio-package";
import { assertZipDeliveryAvailable, deliverZip } from "@/lib/studio-package-delivery";
import { packageRequestSchema } from "@/lib/studio-package-types";
import { readBoundedBody, studioRoute, StudioError } from "@/lib/studio-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Web service: up to 24MB of originals are read from storage and a ZIP is stored back.
export const maxDuration = 60;
export function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("요청 형식을 확인해 주세요.", 400, "INVALID_QUERY");
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const caseId = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    const input = packageRequestSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))),
    );
    assertZipDeliveryAvailable();
    const result = await withCaseStore(caseId, async ({ store, stageOriginals }) => {
      await stageOriginals(input.sourceIds);
      return buildPreparationPackage(store, caseId, input);
    });
    return deliverZip(caseId, result);
  });
}
