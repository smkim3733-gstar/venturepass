import { inputPreparationRoute } from "@/lib/studio-comparison-input-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ caseId: string }> };
export async function POST(request: Request, context: Context) {
  return inputPreparationRoute(request, (await context.params).caseId);
}
export async function DELETE(request: Request, context: Context) {
  return inputPreparationRoute(request, (await context.params).caseId);
}
