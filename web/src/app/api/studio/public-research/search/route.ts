import { StudioError, jsonResponse, readBoundedBody, studioRoute } from "@/lib/studio-http";
import { publicResearchCommandSchema } from "@/lib/studio-public-research-result";
import { searchPublicResearch } from "@/lib/studio-public-research-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Explicit public read only: no company, source writer, AI or key in the browser request. */
export function POST(request: Request) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const command = publicResearchCommandSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 1024))),
    );
    return jsonResponse(await searchPublicResearch(command, request.signal));
  });
}
