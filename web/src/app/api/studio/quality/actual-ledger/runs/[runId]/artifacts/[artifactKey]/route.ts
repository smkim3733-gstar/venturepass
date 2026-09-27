import { qualityActualLedgerRoute } from "@/lib/studio-plan-quality-actual-ledger-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string; artifactKey: string }> },
) {
  return qualityActualLedgerRoute(request, "artifact", await context.params);
}
