import { StudioError } from "./studio-http";
import { localOcrOriginalMime } from "./studio-local-ocr-original";
import { validateSourceIntakeAudio } from "./studio-source-intake-audio";
import { sourceIntakeAudioExtensions } from "./studio-source-intake-external-types";
import {
  sourceIntakeExtension,
  sourceIntakeLimits,
  sourceIntakeNameSchema,
} from "./studio-source-intake-types";

/** File admission only; it neither parses a document nor extracts/transmits its contents. */
export function validateSourceIntakeOriginal(original: {
  name: string;
  mimeType: string | null;
  buffer: Buffer;
}) {
  sourceIntakeNameSchema.parse(original.name);
  const { buffer } = original;
  const extension = sourceIntakeExtension(original.name);
  if ((sourceIntakeAudioExtensions as readonly string[]).includes(extension))
    return validateSourceIntakeAudio(original);
  const mimeType = original.mimeType?.trim().toLowerCase() || null;
  if (!buffer.length || buffer.length > sourceIntakeLimits.fileBytes)
    throw new StudioError("원본 크기를 확인해 주세요.", 413, "INTAKE_FILE_LIMIT");
  const fail = () => {
    throw new StudioError(
      "확장자와 실제 파일 형식을 확인해 주세요.",
      415,
      "INTAKE_ORIGINAL_FORMAT",
    );
  };
  if (["pdf", "png", "jpg", "jpeg", "webp"].includes(extension)) {
    try {
      localOcrOriginalMime(original.name, mimeType, buffer);
    } catch {
      fail();
    }
  } else if (["docx", "xlsx"].includes(extension)) {
    const expected =
      extension === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (
      buffer.length < 4 ||
      buffer.readUInt32LE(0) !== 0x04034b50 ||
      (mimeType !== null && mimeType !== "application/octet-stream" && mimeType !== expected)
    )
      fail();
  } else {
    if (
      mimeType !== null &&
      mimeType !== "application/octet-stream" &&
      !/^text\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; ?charset=(?:utf-8|us-ascii))?$/.test(mimeType) &&
      !(extension === "csv" && mimeType === "application/vnd.ms-excel")
    )
      fail();
    const utf16 =
      buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ||
      buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]));
    if (!utf16 && buffer.includes(0)) fail();
  }
  return { ...original, mimeType };
}
