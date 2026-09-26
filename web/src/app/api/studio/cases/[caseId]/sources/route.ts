import { randomUUID } from "node:crypto";
import { z } from "zod";
import { extractSource, SourceExtractionError, MAX_UPLOAD_BYTES } from "@/lib/studio-extract";
import { originalOnlyWarnings, sourceKinds, sourceSchema } from "@/lib/studio-schema";
import { getStudioStore } from "@/lib/studio-storage";
import { jsonResponse, readBoundedBody, studioRoute, StudioError } from "@/lib/studio-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
const MAX_FILE = MAX_UPLOAD_BYTES;

/** Recognize the allowed original formats without parsing, OCR, or external requests. */
function originalMime(name: string, bytes: Uint8Array) {
  const extension = name.split(".").pop()?.toLowerCase();
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (extension === "pdf" && buffer.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    return "application/pdf";
  if (
    extension === "png" &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    (extension === "jpg" || extension === "jpeg") &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  )
    return "image/jpeg";
  if (
    extension === "webp" &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  throw new StudioError(
    "원본만 보관은 실제 PDF·PNG·JPG·JPEG·WEBP 파일만 지원합니다. 파일 형식을 확인해 주세요.",
    415,
    "ORIGINAL_FORMAT",
  );
}
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
        extractionMode: z.enum(["extract", "original-only"]),
      })
      .parse({
        kind: form.get("kind"),
        revision: form.get("revision"),
        allowAi: form.get("allowAi") ?? "false",
        extractionMode: form.get("extractionMode") ?? "extract",
      });
    if (metadata.extractionMode === "original-only" && metadata.allowAi === "true")
      throw new StudioError(
        "원본만 보관할 때는 AI 전송을 선택할 수 없습니다.",
        400,
        "ORIGINAL_ONLY_AI",
      );
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pending = metadata.extractionMode === "original-only";
    const mimeType = pending
      ? originalMime(file.name, bytes)
      : file.type || "application/octet-stream";
    const extracted = pending
      ? { text: "", extraction: "pending" as const, warnings: [...originalOnlyWarnings] }
      : await extractSource(file, { allowAi: metadata.allowAi === "true" }).catch(
          (error: unknown) => {
            if (error instanceof SourceExtractionError)
              throw new StudioError(error.message, error.status, error.code);
            throw error;
          },
        );
    if (!pending && !extracted.text.trim())
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
      mimeType,
      kind: metadata.kind,
      text: extracted.text,
      extraction: extracted.extraction,
      warnings: extracted.warnings,
      createdAt: now,
      updatedAt: now,
    });
    return jsonResponse(store.addUpload(caseId, metadata.revision, source, bytes), 201);
  });
}
