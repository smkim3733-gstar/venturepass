import { reservationRoute } from "@/lib/studio-comparison-reservations-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ caseId: string }> };
export async function GET(request: Request, context: Context) {
  return reservationRoute(request, (await context.params).caseId);
}
export async function DELETE(request: Request, context: Context) {
  return reservationRoute(request, (await context.params).caseId);
}
