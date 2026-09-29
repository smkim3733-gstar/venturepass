import { qualityProviderProductionStatusRoute } from "@/lib/studio-plan-quality-provider-production-status-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return qualityProviderProductionStatusRoute(request);
}
