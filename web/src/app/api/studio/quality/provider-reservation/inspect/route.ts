import { qualityProviderReservationReviewRoute } from "@/lib/studio-plan-quality-provider-reservation-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return qualityProviderReservationReviewRoute(request);
}
