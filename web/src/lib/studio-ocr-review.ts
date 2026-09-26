import { z } from "zod";

export const MAX_OCR_REVIEWS = 200;

/** A manual transcription review; it does not certify OCR accuracy or an official fact. */
export const reviewLocalOcrMutationSchema = z
  .object({
    action: z.literal("review-local-ocr"),
    revision: z.number().int().nonnegative().safe(),
    clientRequestId: z.string().uuid(),
    sourceId: z.string().uuid(),
    sourceUpdatedAt: z.string().min(1).max(100),
    originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().trim().min(1).max(100_000),
    reviewed: z.literal(true),
  })
  .strict();

/** Keep only binding/digest metadata; reviewed text remains in the source document. */
export const sourceOcrReviewSchema = z
  .object({
    id: z.string().uuid(),
    clientRequestId: z.string().uuid(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceId: z.string().uuid(),
    originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedAt: z.string().datetime(),
    sourceUpdatedAt: z.string().datetime(),
  })
  .strict();
export type SourceOcrReview = z.infer<typeof sourceOcrReviewSchema>;
export const localOcrReviewedWarning =
  "사용자가 원본과 대조하여 저장한 판독문입니다. 앱이 판독 정확성이나 기재 사실의 진위를 확인한 자료는 아닙니다.";
