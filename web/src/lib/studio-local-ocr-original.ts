import { StudioError } from "./studio-http";
import type { LocalOcrMimeType } from "./studio-local-ocr-types";

export function localOcrOriginalMime(
  name: string,
  savedMime: string | null,
  bytes: Buffer,
): LocalOcrMimeType {
  const extension = name.split(".").pop()?.toLowerCase();
  let mime: LocalOcrMimeType | null = null;
  if (extension === "pdf" && bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    mime = "application/pdf";
  if (
    extension === "png" &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    mime = "image/png";
  if (
    ["jpg", "jpeg"].includes(extension ?? "") &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    mime = "image/jpeg";
  if (
    extension === "webp" &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    mime = "image/webp";
  if (
    !mime ||
    (savedMime !== null && savedMime !== "application/octet-stream" && savedMime !== mime)
  )
    throw new StudioError(
      "로컬 판독은 원본 PDF·PNG·JPG·JPEG·WEBP만 지원합니다. 파일 형식을 확인해 주세요.",
      415,
      "OCR_UNSUPPORTED_FORMAT",
    );
  return mime;
}
