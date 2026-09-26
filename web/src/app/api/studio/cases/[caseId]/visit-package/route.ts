import { z } from "zod";
import { buildVisitPackage } from "@/lib/studio-visit-package";
import { visitPackageLimits, visitPackageRequestSchema } from "@/lib/studio-visit-package-types";
import { getStudioStore } from "@/lib/studio-storage";
import { attachmentHeaders, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("이 요청에는 URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const caseId = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    const input = visitPackageRequestSchema.parse(
      JSON.parse(
        new TextDecoder().decode(await readBoundedBody(request, visitPackageLimits.requestBytes)),
      ),
    );
    const result = await buildVisitPackage(getStudioStore(), caseId, input);
    return new Response(new Uint8Array(result.buffer), {
      headers: {
        ...attachmentHeaders(result.fileName, "application/zip"),
        "Content-Length": String(result.buffer.length),
      },
    });
  });
}
