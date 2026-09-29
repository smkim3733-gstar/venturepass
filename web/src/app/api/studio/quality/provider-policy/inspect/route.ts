import { qualityProviderReviewRoute } from "@/lib/studio-plan-quality-provider-review-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return qualityProviderReviewRoute(request, "adoption");
}
