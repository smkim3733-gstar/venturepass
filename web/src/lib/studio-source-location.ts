// Node-side metadata construction. Never infer a coordinate from a user-written location label.
import { createHash } from "node:crypto";
import {
  sourceLocationLimits,
  sourceLocationMetadataSchema,
  sourceLocationSegmentSchema,
  type SourceLocationMetadata,
  type SourceLocationSegment,
} from "./studio-source-location-types";

export const sourceLocationTextSha = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function boundary(text: string, position: number) {
  return !(
    position > 0 &&
    position < text.length &&
    text.charCodeAt(position - 1) >= 0xd800 &&
    text.charCodeAt(position - 1) <= 0xdbff &&
    text.charCodeAt(position) >= 0xdc00 &&
    text.charCodeAt(position) <= 0xdfff
  );
}
export function validateSourceLocationMetadata(
  text: string,
  metadata: unknown,
): metadata is SourceLocationMetadata {
  const parsed = sourceLocationMetadataSchema.safeParse(metadata);
  return (
    parsed.success &&
    parsed.data.textSha256 === sourceLocationTextSha(text) &&
    parsed.data.segments.every(
      (segment) =>
        segment.end <= text.length && boundary(text, segment.start) && boundary(text, segment.end),
    )
  );
}
/** Keep every text byte; only optional coordinates may be explicitly marked partial at their cap. */
export function buildSourceLocationMetadata(
  text: string,
  input: SourceLocationSegment[],
  coverage: "complete" | "partial" = "complete",
): SourceLocationMetadata {
  const result: SourceLocationMetadata = {
    version: 1,
    textSha256: sourceLocationTextSha(text),
    coverage,
    segments: [],
  };
  let size = Buffer.byteLength(JSON.stringify(result));
  let lastEnd = 0;
  for (const raw of input) {
    const segment = sourceLocationSegmentSchema.parse(raw);
    if (
      segment.start < lastEnd ||
      segment.end > text.length ||
      !boundary(text, segment.start) ||
      !boundary(text, segment.end)
    )
      throw new Error("Invalid structured source coordinate");
    lastEnd = segment.end;
    const bytes = Buffer.byteLength(JSON.stringify(segment)) + (result.segments.length ? 1 : 0);
    if (
      result.segments.length >= sourceLocationLimits.segments ||
      size + bytes > sourceLocationLimits.metadataBytes - 8
    ) {
      result.coverage = "partial";
      continue;
    }
    result.segments.push(segment);
    size += bytes;
  }
  return sourceLocationMetadataSchema.parse(result);
}
export function pageSourceLocationSegments(
  pages: Array<{ pageNumber: number; text: string }>,
  kind: "pdf-page" | "ocr-page",
): SourceLocationSegment[] {
  let offset = 0;
  return pages.flatMap((page, index) => {
    if (index) offset += 2;
    const start = offset + `[페이지 ${page.pageNumber}]\n`.length;
    offset = start + page.text.length;
    return page.text.length
      ? [{ start, end: offset, coordinate: { kind, pageNumber: page.pageNumber } }]
      : [];
  });
}

/** Map parser-owned offsets through the existing extraction normalization, without reparsing labels. */
export function normalizeSourceLocations(
  raw: string,
  text: string,
  segments: SourceLocationSegment[],
) {
  const normalized = raw.replace(/\u0000/g, "").replace(/\r\n/g, "\n");
  if (normalized.trim() !== text) throw new Error("Source normalization mismatch");
  const leading = normalized.length - normalized.trimStart().length;
  const positions = [...new Set(segments.flatMap((segment) => [segment.start, segment.end]))].sort(
    (a, b) => a - b,
  );
  const mapped = new Map<number, number>();
  let next = 0;
  let count = 0;
  let previous = "";
  for (let index = 0; index <= raw.length; index++) {
    while (positions[next] === index) {
      mapped.set(index, count);
      next++;
    }
    if (index === raw.length) break;
    if (raw[index] === "\u0000") continue;
    if (!(raw[index] === "\n" && previous === "\r")) count++;
    previous = raw[index];
  }
  return buildSourceLocationMetadata(
    text,
    segments.flatMap((segment) => {
      const rawStart = mapped.get(segment.start);
      const rawEnd = mapped.get(segment.end);
      if (rawStart === undefined || rawEnd === undefined) throw new Error("Source offset mismatch");
      const start = Math.max(0, Math.min(text.length, rawStart - leading));
      const end = Math.max(0, Math.min(text.length, rawEnd - leading));
      return end > start ? [{ ...segment, start, end }] : [];
    }),
  );
}

function timestamp(value: string, format: "srt" | "vtt"): number | null {
  const match =
    format === "srt"
      ? /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/.exec(value)
      : /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return null;
  const ms =
    ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 +
    Number(match[4]);
  return Number.isSafeInteger(ms) ? ms : null;
}
/** SRT/VTT only. The caller supplies the actual file format; generic text labels are never parsed. */
export function subtitleSourceLocations(
  text: string,
  format: "srt" | "vtt",
): SourceLocationMetadata {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (const line of text.split("\n")) {
    lines.push({ text: line, start, end: start + line.length });
    start += line.length + 1;
  }
  const segments: SourceLocationSegment[] = [];
  let partial = false;
  let cursor = 0;
  if (format === "vtt") {
    if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0]?.text ?? ""))
      return buildSourceLocationMetadata(text, [], "partial");
    while (cursor < lines.length && lines[cursor].text.trim()) cursor++;
  }
  while (cursor < lines.length) {
    if (!lines[cursor].text.trim()) {
      cursor++;
      continue;
    }
    const blockStart = cursor;
    while (cursor < lines.length && lines[cursor].text.trim()) cursor++;
    const block = lines.slice(blockStart, cursor);
    if (format === "vtt" && /^(NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(block[0].text)) continue;
    const timingIndex = block[0].text.includes("-->") ? 0 : 1;
    const timing = block[timingIndex];
    const match = timing && /^(\S+)\s+-->\s+(\S+)(?:[ \t]+.*)?$/.exec(timing.text);
    const begin = match ? timestamp(match[1], format) : null;
    const end = match ? timestamp(match[2], format) : null;
    const cueId = timingIndex ? block[0].text : null;
    if (
      !match ||
      begin === null ||
      end === null ||
      end < begin ||
      (cueId && cueId.length > 200) ||
      (format === "srt" && (timingIndex !== 1 || !/^\d+$/.test(cueId ?? "")))
    ) {
      partial = true;
      continue;
    }
    const body = block.slice(timingIndex + 1);
    if (!body.length) {
      partial = true;
      continue;
    }
    segments.push({
      start: body[0].start,
      end: body.at(-1)!.end,
      coordinate: {
        kind: "subtitle-cue",
        format,
        startMs: begin,
        endMs: end,
        startLabel: match[1],
        endLabel: match[2],
        cueId,
      },
    });
  }
  return buildSourceLocationMetadata(text, segments, partial ? "partial" : "complete");
}
