import { qualityProviderProductionExecuteRoute } from "@/lib/studio-plan-quality-provider-production-command-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return qualityProviderProductionExecuteRoute(request);
}
