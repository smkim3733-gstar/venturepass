import { qualityProviderPolicyRoute } from "@/lib/studio-plan-quality-provider-policy-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ clientRequestId: string }> },
) {
  return qualityProviderPolicyRoute(request, "lookup", await context.params);
}
