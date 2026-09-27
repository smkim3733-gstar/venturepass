import { qualityActualPreparationRoute } from "@/lib/studio-plan-quality-actual-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return qualityActualPreparationRoute(request);
}
