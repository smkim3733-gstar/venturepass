import { planQualityRoute } from "@/lib/studio-plan-quality-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ runId: string }> };
export async function GET(request: Request, context: Context) {
  return planQualityRoute(request, "get", await context.params);
}
