import { planQualityRoute } from "@/lib/studio-plan-quality-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ clientRequestId: string }> };
export async function GET(request: Request, context: Context) {
  return planQualityRoute(request, "lookup", await context.params);
}
