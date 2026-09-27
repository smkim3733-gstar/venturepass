import { qualityExecutionRoute } from "@/lib/studio-plan-quality-execution-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  return qualityExecutionRoute(request, "prepare");
}
