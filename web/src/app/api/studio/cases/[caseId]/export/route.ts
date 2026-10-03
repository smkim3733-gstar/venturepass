import { exportPlanDocx, PLAN_DOCX_MIME } from "@/lib/studio-export-docx";
import { exportPlanMarkdown } from "@/lib/studio-export";
import { getStudioStore } from "@/lib/studio-storage";
import { attachmentHeaders, studioRoute, StudioError } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    const store = getStudioStore();
    const record = store.get((await context.params).caseId);
    const planId = new URL(request.url).searchParams.get("planId");
    const plan = planId ? record.plans.find((item) => item.id === planId) : record.plans.at(-1);
    if (!plan)
      throw new StudioError("내보낼 사업계획서를 찾을 수 없습니다.", 404, "PLAN_NOT_FOUND");
    const format = new URL(request.url).searchParams.get("format") ?? "md";
    if (format !== "md" && format !== "docx")
      throw new StudioError("내려받을 문서 형식을 확인해 주세요.", 400, "INVALID_FORMAT");
    const current = store.isPlanCurrent(record.id, plan);
    if (format === "docx") {
      const content = await exportPlanDocx(record, plan, current);
      return new Response(new Uint8Array(content), {
        headers: {
          ...attachmentHeaders(
            `${record.profile.companyName}_사업계획서_v${plan.version}.docx`,
            PLAN_DOCX_MIME,
          ),
          "Content-Length": String(content.length),
        },
      });
    }
    const content = exportPlanMarkdown(record, plan, current);
    return new Response(content, {
      headers: attachmentHeaders(
        `${record.profile.companyName}_사업계획서_v${plan.version}.md`,
        "text/markdown; charset=utf-8",
      ),
    });
  });
}
