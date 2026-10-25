import { MAX_UPLOAD_BYTES } from "@/lib/studio-extract";
import { originalsAvailable } from "@/lib/studio-case-session";
import { currentRequestScope } from "@/lib/studio-request-scope";
import { registerSourceUpload } from "@/lib/studio-source-upload";
import { readBoundedBody, studioRoute, StudioError } from "@/lib/studio-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
const MAX_FILE = MAX_UPLOAD_BYTES;
/** Vercel functions accept about 4.5MB per request body; larger files need direct upload. */
const MAX_SERVER_FILE = 4 * 1024 * 1024;

export function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  return studioRoute(request, async () => {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data;"))
      throw new StudioError("파일을 선택해 주세요.", 415, "CONTENT_TYPE");
    const body = await readBoundedBody(request, MAX_FILE + 65536);
    let form: FormData;
    try {
      form = await new Response(new Uint8Array(body), {
        headers: { "Content-Type": contentType },
      }).formData();
    } catch {
      throw new StudioError("업로드 형식을 확인해 주세요.", 400, "INVALID_MULTIPART");
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0)
      throw new StudioError("내용이 있는 파일을 선택해 주세요.", 400, "FILE_REQUIRED");
    if (file.size > MAX_FILE)
      throw new StudioError("파일은 12MB까지 업로드할 수 있습니다.", 413, "TOO_LARGE");
    if (currentRequestScope()) {
      if (!originalsAvailable())
        throw new StudioError(
          "웹 서비스의 원본 저장소가 설정되지 않았습니다.",
          503,
          "ORIGINALS_NOT_CONFIGURED",
        );
      if (file.size > MAX_SERVER_FILE)
        throw new StudioError("웹 서비스에서는 파일당 4MB까지 올릴 수 있습니다.", 413, "TOO_LARGE");
    }
    const { caseId } = await context.params;
    return registerSourceUpload(caseId, file, {
      kind: form.get("kind"),
      revision: form.get("revision"),
      allowAi: form.get("allowAi") ?? "false",
      extractionMode: form.get("extractionMode") ?? "extract",
    });
  });
}
