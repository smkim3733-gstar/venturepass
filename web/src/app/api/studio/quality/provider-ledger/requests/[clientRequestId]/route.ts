import { qualityProviderLedgerRoute } from "@/lib/studio-plan-quality-provider-ledger-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ clientRequestId: string }> },
) {
  return qualityProviderLedgerRoute(request, "lookup", await context.params);
}
