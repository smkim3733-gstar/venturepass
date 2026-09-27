import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { preservePreparedPackage } from "@/lib/studio-prepared-package";
import { preparedPackageRequestSchema } from "@/lib/studio-prepared-package-types";
import { jsonResponse, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
    return jsonResponse(getStudioStore().listPreparedPackages(caseId));
  });
}
export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    noQuery(request);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const caseId = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    const input = preparedPackageRequestSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))),
    );
    return jsonResponse(await preservePreparedPackage(getStudioStore(), caseId, input));
  });
}
