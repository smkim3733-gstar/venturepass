import { candidateRegistryRoute } from "@/lib/studio-plan-quality-candidate-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  return candidateRegistryRoute(request, "register");
}
