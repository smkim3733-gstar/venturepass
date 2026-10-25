import { z } from "zod";
import {
  listPreparedPackagesForRequest,
  preservePreparedPackageForRequest,
} from "@/lib/studio-prepared-package-service";
import { preparedPackageRequestSchema } from "@/lib/studio-prepared-package-types";
import { jsonResponse, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Web service: up to 24MB of originals are read from storage and the ZIP is stored back.
export const maxDuration = 60;
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
    return jsonResponse(await listPreparedPackagesForRequest(caseId));
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
    return jsonResponse(await preservePreparedPackageForRequest(caseId, input));
  });
}
