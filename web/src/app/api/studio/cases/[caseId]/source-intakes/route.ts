import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { StudioError, jsonResponse, readBoundedBody, studioRoute } from "@/lib/studio-http";
import { sourceIntakeCommandSchema } from "@/lib/studio-source-intake-types";
import { sourceIntakeExternalLimits } from "@/lib/studio-source-intake-external-types";
import {
  runSourceIntakeCommand,
  sourceIntakeStatus,
  SourceIntakeRequestError,
} from "@/lib/studio-source-intake-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
type Context = { params: Promise<{ caseId: string }> };
function noQuery(request: Request) {
  if (new URL(request.url).search)
    throw new StudioError("요청 형식을 확인해 주세요.", 400, "INVALID_QUERY");
}
export function GET(request: Request, context: Context) {
  return studioRoute(request, async () => {
    noQuery(request);
    const { caseId } = await context.params;
    z.string().uuid().parse(caseId);
    return jsonResponse(sourceIntakeStatus(getStudioStore(), caseId));
  });
}
export async function POST(request: Request, context: Context) {
  // All rejected requests explicitly state whether a durable acknowledgment might exist.
  let acknowledged = false;
  const response = await studioRoute(request, async () => {
    noQuery(request);
    const { caseId } = await context.params;
    z.string().uuid().parse(caseId);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const bytes = await readBoundedBody(request, 512 * 1024);
    const input = sourceIntakeCommandSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (
      input.action === "run-external" &&
      bytes.byteLength > sourceIntakeExternalLimits.requestBytes
    )
      throw new StudioError("외부 처리 요청 용량을 확인해 주세요.", 413, "TOO_LARGE");
    try {
      return jsonResponse(await runSourceIntakeCommand(getStudioStore(), caseId, input));
    } catch (error) {
      if (error instanceof SourceIntakeRequestError) {
        acknowledged = error.accepted;
        return jsonResponse(
          { error: error.message, code: error.code, accepted: error.accepted },
          error.status,
        );
      }
      throw error;
    }
  });
  if (response.ok) return response;
  const error = await response.json();
  return jsonResponse({ ...error, accepted: acknowledged }, response.status);
}
