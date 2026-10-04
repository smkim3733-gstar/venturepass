import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { StudioError, jsonResponse, readBoundedBody, studioRoute } from "@/lib/studio-http";
import {
  comparePlanSupplement,
  preparePlanSupplement,
  planSupplementPreviewCommandSchema,
} from "@/lib/studio-plan-supplement";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ caseId: string }> };
/** Local read/compare only. No AI command, provider approval, or manuscript writer. */
export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
    const caseId = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const command = planSupplementPreviewCommandSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 128 * 1024))),
    );
    const company = getStudioStore().get(caseId);
    return jsonResponse(
      command.action === "prepare"
        ? preparePlanSupplement(company, command.input)
        : comparePlanSupplement(company, command.input, command.binding, command.draft),
    );
  });
}
