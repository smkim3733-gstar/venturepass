import { qualityExecutionRoute } from "@/lib/studio-plan-quality-execution-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ executionId: string; revision: string }> },
) {
  return qualityExecutionRoute(request, "get", await context.params);
}
