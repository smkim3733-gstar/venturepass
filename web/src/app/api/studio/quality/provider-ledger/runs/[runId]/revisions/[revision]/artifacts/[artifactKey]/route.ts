import { qualityProviderLedgerRoute } from "@/lib/studio-plan-quality-provider-ledger-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string; revision: string; artifactKey: string }> },
) {
  return qualityProviderLedgerRoute(request, "artifact", await context.params);
}
