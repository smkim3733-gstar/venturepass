import { readJson, studioRoute } from "@/lib/studio-http";
import { startDirectUpload } from "@/lib/studio-source-direct-upload";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () =>
    startDirectUpload((await context.params).caseId, await readJson(request)),
  );
}
