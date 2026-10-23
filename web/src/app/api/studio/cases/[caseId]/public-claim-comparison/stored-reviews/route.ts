import { storedComparisonRoute } from "@/lib/studio-comparison-review-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ caseId: string }> };
export async function GET(request: Request, context: Context) {
  return storedComparisonRoute(request, (await context.params).caseId, "catalog");
}
export async function DELETE(request: Request, context: Context) {
  return storedComparisonRoute(request, (await context.params).caseId, "catalog");
}
