import { readJson, studioRoute } from "@/lib/studio-route";
import { completeDirectUpload } from "@/lib/studio-source-direct-upload";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
export function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () =>
    completeDirectUpload((await context.params).caseId, await readJson(request)),
  );
}
