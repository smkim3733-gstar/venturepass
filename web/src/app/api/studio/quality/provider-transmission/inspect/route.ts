import { qualityProviderTransmissionReviewRoute } from "@/lib/studio-plan-quality-provider-transmission-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return qualityProviderTransmissionReviewRoute(request);
}
