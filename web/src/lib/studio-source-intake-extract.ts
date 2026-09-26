import "server-only";
import { extractSource, MAX_SOURCE_TEXT, MAX_UPLOAD_BYTES } from "./studio-extract";
import { StudioError } from "./studio-http";
import { localOcrOriginalMime } from "./studio-local-ocr";
import { localOcrPagesSchema } from "./studio-local-ocr-types";
import { runWindowsOcr } from "./studio-windows-ocr";
import {
  buildSourceLocationMetadata,
  pageSourceLocationSegments,
  validateSourceLocationMetadata,
} from "./studio-source-location";
import type { SourceLocationMetadata } from "./studio-source-location-types";

export type LocalIntakeExtraction = {
  content:
    | { kind: "plain"; text: string }
    | { kind: "pages"; pages: Array<{ pageNumber: number; text: string }> };
  warnings: string[];
  locations?: SourceLocationMetadata;
};
export class LocalIntakeExtractionError extends StudioError {
  constructor(
    code: string,
    public phase: "awaiting_method" | "retryable_failure" = "retryable_failure",
  ) {
    super("로컬 추출 결과를 확인하지 못했습니다. 원본과 판독 방법을 확인해 주세요.", 422, code);
  }
}
const localExtensions = new Set(["txt", "md", "csv", "tsv", "srt", "vtt", "docx", "xlsx"]);
const knownOcrCodes = new Set([
  "OCR_PLATFORM_UNSUPPORTED",
  "OCR_LANGUAGE_UNAVAILABLE",
  "OCR_BUSY",
  "OCR_PAGE_LIMIT",
  "OCR_IMAGE_LIMIT",
  "OCR_OUTPUT_LIMIT",
  "OCR_TIMEOUT",
  "OCR_MULTIFRAME_UNSUPPORTED",
  "OCR_FAILED",
  "OCR_CLEANUP_FAILED",
  "OCR_UNSUPPORTED_FORMAT",
]);

function checked(result: LocalIntakeExtraction): LocalIntakeExtraction {
  const text =
    result.content.kind === "plain"
      ? result.content.text
      : result.content.pages
          .map((page) => `[페이지 ${page.pageNumber}]\n${page.text}`)
          .join("\n\n");
  if (
    !text.trim() ||
    (result.content.kind === "pages" && result.content.pages.every((page) => !page.text.trim()))
  )
    throw new LocalIntakeExtractionError("INTAKE_NO_TEXT", "awaiting_method");
  if (
    text.length > MAX_SOURCE_TEXT ||
    result.warnings.length > 30 ||
    result.warnings.some((warning) => warning.length > 1000)
  )
    throw new LocalIntakeExtractionError("INTAKE_OUTPUT_LIMIT");
  if (result.locations && !validateSourceLocationMetadata(text, result.locations))
    throw new LocalIntakeExtractionError("INTAKE_LOCATIONS_INVALID");
  if (result.locations?.coverage === "partial" && result.warnings.length < 30)
    result.warnings = [
      ...result.warnings,
      "구조 위치 일부를 확인하거나 보관하지 못했습니다. 본문은 유지되며 누락 위치는 미확인입니다.",
    ];
  return result;
}

function pageLocations(
  pages: Array<{ pageNumber: number; text: string }>,
  kind: "pdf-page" | "ocr-page",
) {
  return buildSourceLocationMetadata(
    pages.map((page) => `[페이지 ${page.pageNumber}]\n${page.text}`).join("\n\n"),
    pageSourceLocationSegments(pages, kind),
  );
}

/** Fixed local engines only. No AI client is constructed and no format fallback transmits bytes. */
export async function extractLocalIntake(
  original: { name: string; mimeType: string | null; buffer: Buffer },
  engine: "local-document" | "windows-ko",
): Promise<LocalIntakeExtraction> {
  const { name, mimeType, buffer } = original;
  if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES)
    throw new LocalIntakeExtractionError("INTAKE_FILE_LIMIT");
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  try {
    if (engine === "windows-ko") {
      const mime = localOcrOriginalMime(name, mimeType, buffer);
      const output = await runWindowsOcr(buffer, mime);
      const parsed = localOcrPagesSchema.safeParse(output.pages);
      if (!parsed.success) throw new LocalIntakeExtractionError("INTAKE_OUTPUT_LIMIT");
      return checked({
        content: { kind: "pages", pages: parsed.data },
        locations: pageLocations(parsed.data, "ocr-page"),
        warnings: [
          "로컬 OCR 미검토 결과입니다. 원본과 대조한 뒤 본문으로 채택해 주세요.",
          ...output.warnings,
        ],
      });
    }
    if (engine !== "local-document")
      throw new LocalIntakeExtractionError("INTAKE_METHOD_UNSUPPORTED", "awaiting_method");
    if (extension === "pdf") {
      localOcrOriginalMime(name, mimeType, buffer);
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false });
      try {
        const info = await parser.getInfo();
        if (!Number.isInteger(info.total) || info.total < 1 || info.total > 120)
          throw new LocalIntakeExtractionError("INTAKE_PAGE_LIMIT");
        const result = await parser.getText();
        if (
          result.pages.length !== info.total ||
          result.pages.some(
            (page, index) => page.num !== index + 1 || typeof page.text !== "string",
          )
        )
          throw new LocalIntakeExtractionError("INTAKE_PAGES_INVALID");
        const emptyPages = result.pages.filter((page) => page.text.trim().length < 10).length;
        const pages = result.pages.map((page) => ({ pageNumber: page.num, text: page.text }));
        return checked({
          content: {
            kind: "pages",
            pages,
          },
          locations: pageLocations(pages, "pdf-page"),
          warnings: emptyPages
            ? ["텍스트가 적거나 없는 페이지가 있습니다. 스캔·도표는 원본과 대조해 주세요."]
            : [],
        });
      } finally {
        await parser.destroy();
      }
    }
    if (!localExtensions.has(extension))
      throw new LocalIntakeExtractionError("INTAKE_METHOD_UNSUPPORTED", "awaiting_method");
    const result = await extractSource(
      new File([new Uint8Array(buffer)], name, { type: mimeType ?? "application/octet-stream" }),
      { allowAi: false, preserveLocations: true },
    );
    if (result.extraction !== "local")
      throw new LocalIntakeExtractionError("INTAKE_METHOD_UNSUPPORTED");
    return checked({
      content: { kind: "plain", text: result.text },
      warnings: result.warnings,
      ...(result.locations ? { locations: result.locations } : {}),
    });
  } catch (error) {
    if (error instanceof LocalIntakeExtractionError) throw error;
    if (error instanceof StudioError && knownOcrCodes.has(error.code))
      throw new LocalIntakeExtractionError(error.code);
    throw new LocalIntakeExtractionError("INTAKE_EXTRACTION_FAILED");
  }
}
