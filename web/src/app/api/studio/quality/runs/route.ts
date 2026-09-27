import { planQualityRoute } from "@/lib/studio-plan-quality-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return planQualityRoute(request, "list");
}
export function POST(request: Request) {
  return planQualityRoute(request, "create");
}
