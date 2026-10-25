import { exportPlanMarkdown } from "@/lib/studio-export";
import { withCaseStore } from "@/lib/studio-case-session";
import { attachmentHeaders, studioRoute, StudioError } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    const { caseId } = await context.params;
    const { record, plan, current } = await withCaseStore(caseId, ({ store }) => {
      const record = store.get(caseId);
      const planId = new URL(request.url).searchParams.get("planId");
      const plan = planId ? record.plans.find((item) => item.id === planId) : record.plans.at(-1);
      if (!plan)
        throw new StudioError("내보낼 사업계획서를 찾을 수 없습니다.", 404, "PLAN_NOT_FOUND");
      return { record, plan, current: store.isPlanCurrent(record.id, plan) };
    });
    const content = exportPlanMarkdown(record, plan, current);
    return new Response(content, {
      headers: attachmentHeaders(
        `${record.profile.companyName}_사업계획서_v${plan.version}.md`,
        "text/markdown; charset=utf-8",
      ),
    });
  });
}
