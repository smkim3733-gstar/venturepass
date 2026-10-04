import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { guidedSourceSelectionPreview } from "@/lib/studio-guided-preparation-service";
import { jsonResponse, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ caseId: string }> };

/** Local preview only. The separate existing start/continue route still requires approval. */
export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
    const caseId = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 8192)));
    return jsonResponse(guidedSourceSelectionPreview(getStudioStore(), caseId, input));
  });
}
