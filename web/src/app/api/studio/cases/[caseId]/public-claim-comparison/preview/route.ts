import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { StudioError, jsonResponse, readBoundedBody, studioRoute } from "@/lib/studio-http";
import {
  buildPublicClaimComparisonRequest,
  publicClaimComparisonRequestCommandSchema,
} from "@/lib/studio-public-claim-comparison-request";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ caseId: string }> };
/** Explicit local preview only. No model configuration, credentials, dispatch or writer. */
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
    const command = publicClaimComparisonRequestCommandSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, 8192)),
      ),
    );
    if (command.selection.companyId !== caseId)
      throw new StudioError("원래 기업과 요청이 일치하지 않습니다.", 409, "PUBLIC_CLAIM_STALE");
    if (request.signal.aborted)
      throw new StudioError("미리보기가 취소되었습니다.", 409, "PREVIEW_CANCELLED");
    return jsonResponse(buildPublicClaimComparisonRequest(getStudioStore().get(caseId), command));
  });
}
