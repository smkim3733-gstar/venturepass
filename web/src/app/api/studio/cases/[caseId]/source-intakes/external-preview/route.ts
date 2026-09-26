import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { StudioError, jsonResponse, readBoundedBody, studioRoute } from "@/lib/studio-http";
import {
  sourceIntakeExternalApprovalPreviewInputSchema,
  sourceIntakeExternalLimits,
} from "@/lib/studio-source-intake-external-types";
import { previewSourceIntakeExternal } from "@/lib/studio-source-intake-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ caseId: string }> };

export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("요청 형식을 확인해 주세요.", 400, "INVALID_QUERY");
    const { caseId } = await context.params;
    z.string().uuid().parse(caseId);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = sourceIntakeExternalApprovalPreviewInputSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          await readBoundedBody(request, sourceIntakeExternalLimits.requestBytes),
        ),
      ),
    );
    return jsonResponse(previewSourceIntakeExternal(getStudioStore(), caseId, input));
  });
}
