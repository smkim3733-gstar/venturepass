import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { jsonResponse, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";
import { guidedPreparationRequestSchema } from "@/lib/studio-guided-preparation-types";
import {
  guidedPreparationStatus,
  GuidedPreparationRequestError,
  runGuidedPreparation,
} from "@/lib/studio-guided-preparation-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;
type Context = { params: Promise<{ caseId: string }> };
function noQuery(request: Request) {
  if (new URL(request.url).search)
    throw new StudioError("URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
}
export function GET(request: Request, context: Context) {
  return studioRoute(request, async () => {
    noQuery(request);
    const caseId = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    return jsonResponse(guidedPreparationStatus(getStudioStore(), caseId));
  });
}
export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    noQuery(request);
    const caseId = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = guidedPreparationRequestSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 32768))),
    );
    try {
      return jsonResponse(await runGuidedPreparation(getStudioStore(), caseId, input));
    } catch (error) {
      if (error instanceof GuidedPreparationRequestError)
        return jsonResponse(
          { error: error.message, code: error.code, accepted: error.accepted },
          error.status,
        );
      throw error;
    }
  });
}
