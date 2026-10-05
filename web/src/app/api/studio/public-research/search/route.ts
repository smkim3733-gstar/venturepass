import { StudioError, jsonResponse, readBoundedBody, studioRoute } from "@/lib/studio-http";
import { publicResearchCommandSchema } from "@/lib/studio-public-research-result";
import { searchPublicResearch } from "@/lib/studio-public-research-service";
import { publicTableMetadataCommandSchema } from "@/lib/studio-public-table-metadata";
import { readSelectedPublicTableMetadata } from "@/lib/studio-public-table-metadata-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Explicit public read only: no company, source writer, AI or key in the browser request. */
export function POST(request: Request) {
  return studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("URL 매개변수를 사용할 수 없습니다.", 400, "INVALID_QUERY");
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new StudioError("JSON 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const body = await readBoundedBody(request, 8192);
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (raw && typeof raw === "object" && Object.hasOwn(raw, "action"))
      return jsonResponse(
        await readSelectedPublicTableMetadata(
          publicTableMetadataCommandSchema.parse(raw),
          request.signal,
        ),
      );
    if (body.byteLength > 1024)
      throw new StudioError("검색 요청이 너무 큽니다.", 413, "BODY_TOO_LARGE");
    const command = publicResearchCommandSchema.parse(raw);
    return jsonResponse(await searchPublicResearch(command, request.signal));
  });
}
