import { randomUUID } from "node:crypto";
import { z } from "zod";
import { extractSource, SourceExtractionError, MAX_UPLOAD_BYTES } from "@/lib/studio-extract";
import { sourceKinds, sourceSchema } from "@/lib/studio-schema";
import { getStudioStore } from "@/lib/studio-storage";
import { jsonResponse, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
const MAX_FILE = MAX_UPLOAD_BYTES;
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
    const metadata = z
      .object({
        kind: z.enum(sourceKinds),
        revision: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative()),
        allowAi: z.enum(["true", "false"]),
      })
      .parse({
        kind: form.get("kind"),
        revision: form.get("revision"),
        allowAi: form.get("allowAi") ?? "false",
      });
    const { caseId } = await context.params;
    const store = getStudioStore();
    const record = store.get(caseId);
    if (record.revision !== metadata.revision)
      throw new StudioError(
        "기업정보가 변경되었습니다. 다시 불러와 주세요.",
        409,
        "STALE_REVISION",
      );
    if (record.sources.length >= 40)
      throw new StudioError("기업별 자료는 40개까지 등록할 수 있습니다.", 413, "SOURCE_LIMIT");
    const extracted = await extractSource(file, { allowAi: metadata.allowAi === "true" }).catch(
      (error: unknown) => {
        if (error instanceof SourceExtractionError)
          throw new StudioError(error.message, error.status, error.code);
        throw error;
      },
    );
    if (!extracted.text.trim())
      throw new StudioError(
        "파일에서 본문을 추출하지 못했습니다. 내용을 직접 입력하거나 다른 파일을 등록해 주세요.",
        422,
        "NO_TEXT",
      );
    const now = new Date().toISOString();
    const source = sourceSchema.parse({
      id: randomUUID(),
      name: file.name,
      originalName: file.name,
      mimeType: file.type || "application/octet-stream",
      kind: metadata.kind,
      text: extracted.text,
      extraction: extracted.extraction,
      warnings: extracted.warnings,
      createdAt: now,
      updatedAt: now,
    });
    return jsonResponse(
      store.addUpload(caseId, metadata.revision, source, new Uint8Array(await file.arrayBuffer())),
      201,
    );
  });
}
