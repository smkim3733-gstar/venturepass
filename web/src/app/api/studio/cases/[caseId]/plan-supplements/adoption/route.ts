import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { reviewPlan } from "@/lib/studio-engine";
import { StudioError, jsonResponse, readBoundedBody, studioRoute } from "@/lib/studio-http";
import { planSupplementAdoptionApiSchema } from "@/lib/studio-plan-supplement-adoption-types";
import {
  auditPlanSupplementAdoptions,
  preparePlanSupplementAdoption,
  inspectPlanSupplementAdoption,
} from "@/lib/studio-plan-supplement-adoption";
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
    const id = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    const company = getStudioStore().get(id);
    auditPlanSupplementAdoptions(company);
    return jsonResponse({
      caseId: id,
      revision: company.revision,
      receipts: company.planSupplementAdoptions ?? [],
      databaseChanged: false,
      transmissionAllowed: false,
    });
  });
}
export function POST(request: Request, context: Context) {
  return studioRoute(request, async () => {
    noQuery(request);
    const id = z
      .string()
      .uuid()
      .parse((await context.params).caseId);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const command = planSupplementAdoptionApiSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 8192))),
    );
    const store = getStudioStore();
    if (command.action === "prepare-adoption")
      return jsonResponse(
        preparePlanSupplementAdoption(store.get(id), command.revision, command.executionId),
      );
    if (command.action === "inspect-adoption") {
      const company = store.get(id);
      return jsonResponse(inspectPlanSupplementAdoption(company, command.command));
    }
    return jsonResponse(store.adoptPlanSupplement(id, command, reviewPlan));
  });
}
