import { readOriginalFile } from "@/lib/studio-case-session";
import { attachmentHeaders, studioRoute } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(
  request: Request,
  context: { params: Promise<{ caseId: string; sourceId: string }> },
) {
  return studioRoute(request, async () => {
    const { caseId, sourceId } = await context.params;
    const { source, buffer } = await readOriginalFile(caseId, sourceId);
    return new Response(new Uint8Array(buffer), {
      headers: attachmentHeaders(source.originalName!, "application/octet-stream"),
    });
  });
}
