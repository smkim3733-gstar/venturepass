import { qualityProviderReservationCommandRoute } from "@/lib/studio-plan-quality-provider-reservation-command-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return qualityProviderReservationCommandRoute(request, "reserve");
}
