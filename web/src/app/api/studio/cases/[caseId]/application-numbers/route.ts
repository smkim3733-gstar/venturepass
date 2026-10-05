import { getStudioStore } from "@/lib/studio-storage";
import { jsonResponse, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";
import {
  applicationNumberInspectionSchema,
  inspectApplicationNumberRequest,
  readApplicationNumbers,
} from "@/lib/studio-application-number-read";
import { applicationLimits } from "@/lib/studio-application-types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ caseId: string }> };
function assertQuery(request: Request) {
  if (new URL(request.url).search)
    throw new StudioError("조회 주소를 확인해 주세요.", 400, "INVALID_QUERY");
}
export function GET(request: Request, context: Context) {
  return studioRoute(request, async () => {
    assertQuery(request);
    const { caseId } = await context.params;
    return jsonResponse(readApplicationNumbers(getStudioStore().get(caseId)));
  });
}
/** An explicit local inspection, never a save or an official observation. */
export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    assertQuery(request);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const input = applicationNumberInspectionSchema.parse(
      JSON.parse(
        new TextDecoder().decode(await readBoundedBody(request, applicationLimits.requestBytes)),
      ),
    );
    const { caseId } = await context.params;
    return jsonResponse(
      inspectApplicationNumberRequest(getStudioStore().get(caseId), input.command),
    );
  });
}
