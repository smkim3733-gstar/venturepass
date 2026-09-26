import { z } from "zod";

export const sourceLocationLimits = {
  segments: 20_000,
  metadataBytes: 512 * 1024,
  retainedBytes: 2 * 1024 * 1024,
} as const;
const integer = z.number().int().nonnegative().safe();
export const sourceCoordinateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pdf-page"), pageNumber: z.number().int().min(1).max(120) }).strict(),
  z.object({ kind: z.literal("ocr-page"), pageNumber: z.number().int().min(1).max(20) }).strict(),
  z
    .object({
      kind: z.literal("spreadsheet-cell"),
      sheetIndex: z.number().int().min(1).max(30),
      sheetName: z.string().min(1).max(100),
      row: z.number().int().min(1).max(1_048_576),
      column: z.number().int().min(1).max(16_384),
      address: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/),
    })
    .strict()
    .refine((value) => {
      const match = /^([A-Z]+)(\d+)$/.exec(value.address);
      if (!match) return false;
      const column = [...match[1]].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
      return column === value.column && Number(match[2]) === value.row;
    }, "셀 주소와 행·열이 일치해야 합니다."),
  z
    .object({
      kind: z.literal("subtitle-cue"),
      format: z.enum(["srt", "vtt"]),
      startMs: integer,
      endMs: integer,
      startLabel: z.string().min(1).max(40),
      endLabel: z.string().min(1).max(40),
      cueId: z.string().max(200).nullable(),
    })
    .strict()
    .refine((value) => value.endMs >= value.startMs, "자막 시간 범위를 확인해 주세요."),
]);
export type SourceCoordinate = z.infer<typeof sourceCoordinateSchema>;
export const sourceLocationSegmentSchema = z
  .object({
    start: integer,
    end: integer,
    coordinate: sourceCoordinateSchema,
  })
  .strict()
  .refine((value) => value.end > value.start, "문자 범위를 확인해 주세요.");
export type SourceLocationSegment = z.infer<typeof sourceLocationSegmentSchema>;
export const sourceLocationMetadataSchema = z
  .object({
    version: z.literal(1),
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    coverage: z.enum(["complete", "partial"]),
    segments: z.array(sourceLocationSegmentSchema).max(sourceLocationLimits.segments),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.segments.some(
        (segment, index) => index > 0 && segment.start < value.segments[index - 1].end,
      )
    )
      context.addIssue({ code: "custom", message: "위치 범위 순서와 중복을 확인해 주세요." });
    if (new TextEncoder().encode(JSON.stringify(value)).length > sourceLocationLimits.metadataBytes)
      context.addIssue({ code: "custom", message: "위치 정보 보관 한도를 초과했습니다." });
  });
export type SourceLocationMetadata = z.infer<typeof sourceLocationMetadataSchema>;
/** Coordinates intersecting an exact canonical-text selection; generated labels may be unlocated. */
export function sourceLocationSegmentsForRange(
  metadata: SourceLocationMetadata,
  start: number,
  end: number,
) {
  return metadata.segments.filter((segment) => segment.start < end && segment.end > start);
}
