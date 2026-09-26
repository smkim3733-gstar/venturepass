import { z } from "zod";
import { getStudioStore } from "@/lib/studio-storage";
import { StudioError, jsonResponse, readBoundedBody, studioRoute } from "@/lib/studio-http";
import {
  sourceIntakeLimits,
  sourceIntakeOriginalInputSchema,
} from "@/lib/studio-source-intake-types";
import {
  uploadSourceIntakeOriginal,
  SourceIntakeRequestError,
} from "@/lib/studio-source-intake-service";
import { validateSourceIntakeOriginal } from "@/lib/studio-source-intake-original";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
type Context = { params: Promise<{ caseId: string; itemId: string }> };
export async function PUT(request: Request, context: Context) {
  let acknowledged = false;
  const response = await studioRoute(request, async () => {
    if (new URL(request.url).search)
      throw new StudioError("요청 형식을 확인해 주세요.", 400, "INVALID_QUERY");
    const { caseId, itemId } = await context.params;
    z.string().uuid().parse(caseId);
    z.string().uuid().parse(itemId);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data;"))
      throw new StudioError("원본 파일 형식으로 요청해 주세요.", 415, "CONTENT_TYPE");
    const body = await readBoundedBody(request, sourceIntakeLimits.fileBytes + 65536);
    let form: FormData;
    try {
      form = await new Response(new Uint8Array(body), {
        headers: { "Content-Type": contentType },
      }).formData();
    } catch {
      throw new StudioError("파일 요청 형식을 확인해 주세요.", 400, "INVALID_MULTIPART");
    }
    const names = ["file", "revision", "clientRequestId", "expectedItemVersion"];
    if (
      [...form.keys()].some((name) => !names.includes(name)) ||
      names.some((name) => form.getAll(name).length !== 1)
    )
      throw new StudioError(
        "파일과 접수 정보를 각각 한 번만 보내 주세요.",
        400,
        "INVALID_MULTIPART",
      );
    const file = form.get("file");
    if (!(file instanceof File))
      throw new StudioError("원본 파일을 선택해 주세요.", 400, "FILE_REQUIRED");
    const integer = z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .transform(Number)
      .pipe(z.number().int().safe().nonnegative());
    const input = sourceIntakeOriginalInputSchema.parse({
      revision: integer.parse(form.get("revision")),
      clientRequestId: form.get("clientRequestId"),
      expectedItemVersion: integer.parse(form.get("expectedItemVersion")),
    });
    const original = validateSourceIntakeOriginal({
      name: file.name,
      mimeType: file.type || null,
      buffer: Buffer.from(await file.arrayBuffer()),
    });
    try {
      return jsonResponse(
        await uploadSourceIntakeOriginal(getStudioStore(), caseId, itemId, input, original),
      );
    } catch (error) {
      if (error instanceof SourceIntakeRequestError) {
        acknowledged = error.accepted;
        return jsonResponse(
          { error: error.message, code: error.code, accepted: error.accepted },
          error.status,
        );
      }
      throw error;
    }
  });
  if (response.ok) return response;
  const error = await response.json();
  return jsonResponse({ ...error, accepted: acknowledged }, response.status);
}
