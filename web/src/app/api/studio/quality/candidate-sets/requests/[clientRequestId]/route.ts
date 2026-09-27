import { candidateRegistryRoute } from "@/lib/studio-plan-quality-candidate-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ clientRequestId: string }> },
) {
  return candidateRegistryRoute(request, "lookup", await context.params);
}
