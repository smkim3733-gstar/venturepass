import { candidateRegistryRoute } from "@/lib/studio-plan-quality-candidate-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return candidateRegistryRoute(request, "list");
}
