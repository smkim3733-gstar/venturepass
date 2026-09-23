import { getStudioStore } from "@/lib/studio-storage";
import { attachmentHeaders, studioRoute } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(
  request: Request,
  context: { params: Promise<{ caseId: string; sourceId: string }> },
) {
  return studioRoute(request, async () => {
    const { caseId, sourceId } = await context.params;
    const { source, buffer } = getStudioStore().original(caseId, sourceId);
    return new Response(new Uint8Array(buffer), {
      headers: attachmentHeaders(source.originalName!, "application/octet-stream"),
    });
  });
}
