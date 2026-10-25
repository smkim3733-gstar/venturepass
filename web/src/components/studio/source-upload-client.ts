/** Above this size the web service uploads straight to object storage (function body limit). */
export const directUploadThreshold = 4 * 1024 * 1024;

export type SourceUploadFields = {
  kind: string;
  revision: number;
  allowAi: boolean;
  extractionMode: "extract" | "original-only";
};

function failure(message: string, code: string, status = 502) {
  return Response.json({ error: message, code }, { status });
}

/**
 * Sends one file and returns the final API response, so callers keep their status handling
 * (409/413/422 and so on) for both the multipart and the direct-to-storage path.
 */
export async function uploadSourceFile(
  caseId: string,
  file: File,
  fields: SourceUploadFields,
  serverMode: boolean,
): Promise<Response> {
  if (!serverMode || file.size <= directUploadThreshold) {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", fields.kind);
    form.append("revision", String(fields.revision));
    form.append("allowAi", String(fields.allowAi));
    form.append("extractionMode", fields.extractionMode);
    return fetch(`/api/studio/cases/${caseId}/sources`, { method: "POST", body: form });
  }
  const contentType = file.type || "application/octet-stream";
  const start = await fetch(`/api/studio/cases/${caseId}/sources/direct-upload`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: file.name, size: file.size, contentType }),
  });
  if (!start.ok) return start;
  const { uploadId, uploadUrl } = (await start.json()) as { uploadId: string; uploadUrl: string };
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "x-upsert": "false" },
    body: file,
  }).catch(() => null);
  if (!put?.ok)
    return failure(
      "파일을 저장소에 올리지 못했습니다. 다시 시도해 주세요.",
      "DIRECT_UPLOAD_FAILED",
    );
  return fetch(`/api/studio/cases/${caseId}/sources/direct-upload/complete`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadId, fileName: file.name, contentType, ...fields }),
  });
}
