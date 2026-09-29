import { qualityProviderReservationCommandRoute } from "@/lib/studio-plan-quality-provider-reservation-command-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ clientRequestId: string }> },
) {
  return qualityProviderReservationCommandRoute(request, "lookup", await context.params);
}
