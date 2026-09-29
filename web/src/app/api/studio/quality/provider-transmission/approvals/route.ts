import { qualityProviderTransmissionApprovalRoute } from "@/lib/studio-plan-quality-provider-transmission-approval-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return qualityProviderTransmissionApprovalRoute(request, "approve");
}
