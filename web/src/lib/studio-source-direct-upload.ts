import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withCaseStore } from "./studio-case-session";
import { MAX_UPLOAD_BYTES } from "./studio-extract";
import { jsonResponse, StudioError } from "./studio-http";
import {
  removeOldTemporaryObjects,
  stagingMaxAgeMs,
  stagingObjectKey,
} from "./studio-original-store";
import { currentRequestScope } from "./studio-request-scope";
import { sourceKinds } from "./studio-schema";
import { registerSourceUpload } from "./studio-source-upload";

const fileName = z.string().trim().min(1).max(200);
const startSchema = z
  .object({
    fileName,
    size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    contentType: z.string().max(150).default("application/octet-stream"),
  })
  .strict();
const completeSchema = z
  .object({
    uploadId: z.string().uuid(),
    fileName,
    contentType: z.string().max(150).default("application/octet-stream"),
    kind: z.enum(sourceKinds),
    revision: z.number().int().nonnegative(),
    allowAi: z.boolean().default(false),
    extractionMode: z.enum(["extract", "original-only"]).default("extract"),
  })
  .strict();

/** Server mode only: the organization's object storage with signed uploads. */
function serverOriginals() {
  const scope = currentRequestScope();
  if (!scope) throw new StudioError("이 기능은 웹 서비스에서만 사용합니다.", 404, "SERVER_ONLY");
  if (!scope.originals?.createSignedUpload)
    throw new StudioError(
      "웹 서비스의 원본 저장소가 설정되지 않았습니다.",
      503,
      "ORIGINALS_NOT_CONFIGURED",
    );
  return { store: scope.originals, organizationId: scope.principal.organizationId };
}

/** Issues a one-object upload URL for a staging key; nothing is registered yet. */
export async function startDirectUpload(caseId: string, raw: unknown) {
  const input = startSchema.parse(raw);
  const originals = serverOriginals();
  await withCaseStore(caseId, ({ store }) => {
    if (store.get(caseId).sources.length >= 40)
      throw new StudioError("기업별 자료는 40개까지 등록할 수 있습니다.", 413, "SOURCE_LIMIT");
  });
  // Uploads a browser never completed would otherwise stay in storage indefinitely.
  await removeOldTemporaryObjects(
    originals.store,
    originals.organizationId,
    caseId,
    "staging",
    stagingMaxAgeMs,
  );
  const uploadId = randomUUID();
  const uploadUrl = await originals.store.createSignedUpload!(
    stagingObjectKey(originals.organizationId, caseId, uploadId),
  );
  return jsonResponse({ uploadId, uploadUrl, maxBytes: MAX_UPLOAD_BYTES, size: input.size });
}

/**
 * Reads the staged object, applies the same checks and registration as a multipart upload,
 * then drops the staging copy. The registered original is stored under its own source key.
 */
export async function completeDirectUpload(caseId: string, raw: unknown) {
  const input = completeSchema.parse(raw);
  const originals = serverOriginals();
  const key = stagingObjectKey(originals.organizationId, caseId, input.uploadId);
  const bytes = await originals.store.get(key);
  if (!bytes)
    throw new StudioError(
      "파일이 아직 저장소에 올라오지 않았습니다. 다시 올려 주세요.",
      409,
      "UPLOAD_NOT_FOUND",
    );
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
    await originals.store.remove(key).catch(() => {});
    throw new StudioError("파일은 12MB까지 업로드할 수 있습니다.", 413, "TOO_LARGE");
  }
  const file = new File([new Uint8Array(bytes)], input.fileName, { type: input.contentType });
  try {
    return await registerSourceUpload(caseId, file, {
      kind: input.kind,
      revision: String(input.revision),
      allowAi: String(input.allowAi),
      extractionMode: input.extractionMode,
    });
  } finally {
    // Every attempt uses a fresh upload id, so the staging copy is never needed again.
    await originals.store.remove(key).catch(() => {});
  }
}
