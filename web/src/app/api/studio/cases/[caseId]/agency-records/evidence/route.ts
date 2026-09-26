import { z } from "zod";
import { inspectAgencyEvidence } from "@/lib/studio-agency-evidence";
import { jsonResponse, studioRoute, StudioError } from "@/lib/studio-http";
import { getStudioStore } from "@/lib/studio-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    const query = new URL(request.url).searchParams;
    if (
      query.getAll("recordId").length !== 1 ||
      query.getAll("revision").length !== 1 ||
      [...query.keys()].some((key) => !["recordId", "revision"].includes(key))
    )
      throw new StudioError("기록과 기업자료 버전을 확인해 주세요.", 400, "INVALID_INPUT");
    const recordId = z.string().uuid().parse(query.get("recordId"));
    const revision = z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .parse(query.get("revision"));
    const expectedRevision = z.number().int().nonnegative().safe().parse(Number(revision));
    const caseId = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    return jsonResponse(
      inspectAgencyEvidence(getStudioStore(), caseId, recordId, expectedRevision),
    );
  });
}
