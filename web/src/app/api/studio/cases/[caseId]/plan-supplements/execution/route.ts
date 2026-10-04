import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { StudioError, jsonResponse, readBoundedBody, studioRoute } from "@/lib/studio-http";
import {
  getPlanSupplementService,
  PlanSupplementRequestError,
  planSupplementServiceCommandSchema,
} from "@/lib/studio-plan-supplement-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
type Context = { params: Promise<{ caseId: string }> };
function noQuery(request: Request) {
  if (new URL(request.url).search)
    throw new StudioError("URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
}
export function GET(request: Request, context: Context) {
  return studioRoute(request, async () => {
    noQuery(request);
    const id = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    return jsonResponse(getPlanSupplementService(getStudioStore()).status(id));
  });
}
export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    noQuery(request);
    const id = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const command = planSupplementServiceCommandSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 128 * 1024))),
    );
    const service = getPlanSupplementService(getStudioStore());
    try {
      if (command.action === "prepare-ai") return jsonResponse(service.preview(id, command.input));
      if (command.action === "recover") return jsonResponse(service.recover(id, command.command));
      return jsonResponse(await service.run(id, command));
    } catch (error) {
      if (error instanceof PlanSupplementRequestError)
        return jsonResponse(
          { error: error.message, code: error.code, accepted: error.accepted },
          error.status,
        );
      throw error;
    }
  });
}
