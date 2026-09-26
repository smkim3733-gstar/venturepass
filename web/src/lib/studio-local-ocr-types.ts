import { z } from "zod";

export const localOcrMimeTypes = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export type LocalOcrMimeType = (typeof localOcrMimeTypes)[number];
export const localOcrLimits = {
  bytes: 12 * 1024 * 1024,
  pages: 20,
  imageDimension: 2200,
  imagePixels: 20_000_000,
  text: 100_000,
  timeoutMs: 120_000,
} as const;
export const localOcrPagesSchema = z
  .array(
    z
      .object({
        pageNumber: z.number().int().min(1).max(localOcrLimits.pages),
        text: z.string().max(localOcrLimits.text),
      })
      .strict(),
  )
  .min(1)
  .max(localOcrLimits.pages)
  .superRefine((pages, context) => {
    if (
      pages.some((page, index) => page.pageNumber !== index + 1) ||
      pages.reduce((sum, page) => sum + page.text.length, 0) > localOcrLimits.text
    )
      context.addIssue({
        code: "custom",
        message: "로컬 판독 결과의 페이지 또는 본문 한도를 확인해 주세요.",
      });
  });
export type LocalOcrPage = z.infer<typeof localOcrPagesSchema>[number];
export type LocalOcrPreview = {
  caseRevision: number;
  sourceId: string;
  sourceUpdatedAt: string;
  original: { originalName: string; mimeType: string | null; sizeBytes: number; sha256: string };
  engine: "windows-ko";
  observedAt: string;
  pages: LocalOcrPage[];
  text: string;
  warnings: string[];
  reviewStatus: "unreviewed";
  sourceChanged: false;
  externalTransmission: false;
};
