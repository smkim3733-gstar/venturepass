import { z } from "zod";
import { buildCriteriaReference } from "@/lib/studio-criteria-version";
import { criteriaReferenceDownloadName } from "@/lib/studio-criteria-version-types";
import { attachmentHeaders, StudioError, studioRoute } from "@/lib/studio-http";
import { withCaseStore } from "@/lib/studio-case-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ caseId: string; bindingId: string }> };
export function GET(request: Request, context: Context) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError(
        "출력 요청에는 URL 매개변수를 사용할 수 없습니다.",
        400,
        "INVALID_QUERY",
      );
    const { caseId, bindingId } = z
      .object({ caseId: z.string().uuid(), bindingId: z.string().uuid() })
      .strict()
      .parse(await context.params);
    const markdown = await withCaseStore(caseId, ({ store }) =>
      buildCriteriaReference(store, caseId, bindingId),
    );
    return new Response(markdown, {
      headers: {
        ...attachmentHeaders(criteriaReferenceDownloadName, "text/markdown; charset=utf-8"),
        "Content-Length": String(Buffer.byteLength(markdown)),
      },
    });
  });
}
