import { qualityProviderPolicyRoute } from "@/lib/studio-plan-quality-provider-policy-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return qualityProviderPolicyRoute(request, "adopt");
}
