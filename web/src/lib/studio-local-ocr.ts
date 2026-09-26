import "server-only";
import type { StudioStore } from "./studio-storage";
import { StudioError } from "./studio-http";
import { assertVentureCompanyWritable } from "./venturein-input-lock";
import {
  localOcrLimits,
  localOcrPagesSchema,
  type LocalOcrPreview,
} from "./studio-local-ocr-types";
import { runWindowsOcr } from "./studio-windows-ocr";
import { localOcrOriginalMime } from "./studio-local-ocr-original";

export { localOcrOriginalMime } from "./studio-local-ocr-original";

/** A local unreviewed preview only. Nothing is saved, transmitted or promoted to evidence. */
export async function previewSourceOcr(
  store: StudioStore,
  caseId: string,
  sourceId: string,
  revision: number,
): Promise<LocalOcrPreview> {
  const assertCurrent = () => {
    assertVentureCompanyWritable(caseId);
    if (store.get(caseId).revision !== revision)
      throw new StudioError(
        "기업자료가 변경되었습니다. 새로 불러온 뒤 다시 판독해 주세요.",
        409,
        "STALE_REVISION",
      );
  };
  assertCurrent();
  const source = store.get(caseId).sources.find((item) => item.id === sourceId);
  if (!source)
    throw new StudioError("해당 기업의 자료를 찾을 수 없습니다.", 404, "SOURCE_NOT_FOUND");
  if (source.extraction !== "pending")
    throw new StudioError(
      "원본만 보관한 미판독 자료에서 로컬 판독 초안을 만들 수 있습니다.",
      409,
      "OCR_PENDING_REQUIRED",
    );
  const original = store.originalForVentureInput(caseId, sourceId);
  const mimeType = localOcrOriginalMime(
    original.source.originalName!,
    original.source.mimeType,
    original.buffer,
  );
  assertCurrent();
  const result = await runWindowsOcr(original.buffer, mimeType);
  assertCurrent();
  let current: ReturnType<StudioStore["originalForVentureInput"]>;
  try {
    current = store.originalForVentureInput(caseId, sourceId);
  } catch {
    throw new StudioError(
      "원본이 변경되었거나 안전하게 확인할 수 없습니다. 다시 확인해 주세요.",
      409,
      "OCR_SOURCE_CHANGED",
    );
  }
  assertCurrent();
  if (
    current.sha256 !== original.sha256 ||
    current.buffer.length !== original.buffer.length ||
    JSON.stringify(current.source) !== JSON.stringify(original.source)
  )
    throw new StudioError(
      "판독 중 원본 또는 자료 정보가 변경되었습니다. 다시 확인해 주세요.",
      409,
      "OCR_SOURCE_CHANGED",
    );
  const parsed = localOcrPagesSchema.safeParse(result.pages);
  if (!parsed.success)
    throw new StudioError(
      "판독 결과가 페이지·본문 한도를 초과했습니다. 자료를 나누어 주세요.",
      413,
      "OCR_OUTPUT_LIMIT",
    );
  const text = parsed.data.map((page) => `[페이지 ${page.pageNumber}]\n${page.text}`).join("\n\n");
  if (text.length > localOcrLimits.text)
    throw new StudioError(
      "판독 본문은 10만 자까지 지원합니다. 자료를 나누어 주세요.",
      413,
      "OCR_OUTPUT_LIMIT",
    );
  if (parsed.data.every((page) => !page.text.trim()))
    throw new StudioError(
      "판독된 본문이 없습니다. 원본을 확인하고 필요한 내용을 직접 입력해 주세요.",
      422,
      "OCR_NO_TEXT",
    );
  const warnings = [...result.warnings];
  if (parsed.data.some((page) => !page.text.trim()))
    warnings.push("본문을 판독하지 못한 페이지가 있습니다. 빈 페이지도 원본과 대조해 주세요.");
  return {
    caseRevision: revision,
    sourceId,
    sourceUpdatedAt: original.source.updatedAt,
    original: {
      originalName: original.source.originalName!,
      mimeType: original.source.mimeType,
      sizeBytes: original.buffer.length,
      sha256: original.sha256,
    },
    engine: "windows-ko",
    observedAt: new Date().toISOString(),
    pages: parsed.data,
    text,
    warnings,
    reviewStatus: "unreviewed",
    sourceChanged: false,
    externalTransmission: false,
  };
}
