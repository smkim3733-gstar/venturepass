import { z } from "zod";
import { jsonResponse, readBoundedBody, StudioError, studioRoute } from "@/lib/studio-http";
import { getStudioStore } from "@/lib/studio-storage";
import { previewSourceOcr } from "@/lib/studio-local-ocr";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;

export function POST(
  request: Request,
  context: { params: Promise<{ caseId: string; sourceId: string }> },
) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("요청 형식을 확인해 주세요.", 400, "INVALID_INPUT");
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = z
      .object({ revision: z.number().int().nonnegative().safe() })
      .strict()
      .parse(JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 1024))));
    const params = z
      .object({ caseId: z.string().uuid(), sourceId: z.string().uuid() })
      .parse(await context.params);
    return jsonResponse(
      await previewSourceOcr(getStudioStore(), params.caseId, params.sourceId, input.revision),
    );
  });
}
