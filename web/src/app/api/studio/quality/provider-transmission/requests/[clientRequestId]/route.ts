import { qualityProviderTransmissionApprovalRoute } from "@/lib/studio-plan-quality-provider-transmission-approval-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ clientRequestId: string }> },
) {
  return qualityProviderTransmissionApprovalRoute(request, "lookup", await context.params);
}
