import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { jsonResponse, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";
import { preparationRequestSchema } from "@/lib/studio-preparation-types";
import {
  localPreparationIsRunning,
  PreparationRequestError,
  runLocalPreparation,
} from "@/lib/studio-preparation";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ caseId: string }> };
function noQuery(request: Request) {
  if (new URL(request.url).search)
    throw new StudioError("요청 형식을 확인해 주세요.", 400, "INVALID_QUERY");
}
export function GET(request: Request, context: Context) {
  return studioRoute(request, async () => {
    noQuery(request);
    const { caseId } = await context.params;
    z.string().uuid().parse(caseId);
    const company = getStudioStore().get(caseId);
    return jsonResponse({
      companyRevision: company.revision,
      runs: company.preparationRuns,
      running: localPreparationIsRunning(caseId),
    });
  });
}
export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    noQuery(request);
    const { caseId } = await context.params;
    z.string().uuid().parse(caseId);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = preparationRequestSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))),
    );
    try {
      return jsonResponse(await runLocalPreparation(getStudioStore(), caseId, input));
    } catch (error) {
      if (error instanceof PreparationRequestError)
        return jsonResponse(
          { error: error.message, code: error.code, accepted: error.accepted },
          error.status,
        );
      throw error;
    }
  });
}
