import { z } from "zod";
import { inspectAgencyEvidence } from "@/lib/studio-agency-evidence";
import { jsonResponse, studioRoute, StudioError } from "@/lib/studio-route";
import { withCaseStore } from "@/lib/studio-case-session";

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
      await withCaseStore(caseId, async ({ store, stageOriginals }) => {
        // Web service: the recorded evidence originals come from storage (a no-op locally).
        const record = store.get(caseId).agencyRecords.find((entry) => entry.id === recordId);
        if (record) await stageOriginals(record.evidence.map((item) => item.sourceId));
        return inspectAgencyEvidence(store, caseId, recordId, expectedRevision);
      }),
    );
  });
}
