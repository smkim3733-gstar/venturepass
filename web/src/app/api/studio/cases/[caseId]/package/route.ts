import { z } from "zod";
import { buildPreparationPackage } from "@/lib/studio-package";
import { packageRequestSchema } from "@/lib/studio-package-types";
import { getStudioStore } from "@/lib/studio-storage";
import { attachmentHeaders, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("요청 형식을 확인해 주세요.", 400, "INVALID_QUERY");
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const caseId = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    const input = packageRequestSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))),
    );
    const result = await buildPreparationPackage(getStudioStore(), caseId, input);
    return new Response(new Uint8Array(result.buffer), {
      headers: {
        ...attachmentHeaders(result.fileName, "application/zip"),
        "Content-Length": String(result.buffer.length),
      },
    });
  });
}
