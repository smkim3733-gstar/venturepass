import { describe, expect, it } from "vitest";
import {
  buildSourceLocationMetadata,
  normalizeSourceLocations,
  pageSourceLocationSegments,
  sourceLocationTextSha,
  subtitleSourceLocations,
  validateSourceLocationMetadata,
} from "./studio-source-location";
import {
  sourceCoordinateSchema,
  sourceLocationLimits,
  sourceLocationMetadataSchema,
  type SourceLocationSegment,
} from "./studio-source-location-types";

const page = { kind: "pdf-page" as const, pageNumber: 1 };
const segment = (start: number, end: number): SourceLocationSegment => ({
  start,
  end,
  coordinate: page,
});
describe("실제 파서 좌표의 canonical 본문 바인딩", () => {
  it("UTF-16 범위와 정확 SHA를 보존하고 같은 문구도 별도 위치로 남긴다", () => {
    const text = "😀같은\n같은";
    const result = buildSourceLocationMetadata(text, [segment(2, 4), segment(5, 7)]);
    expect(result.textSha256).toBe(sourceLocationTextSha(text));
    expect(result.segments.map((item) => text.slice(item.start, item.end))).toEqual([
      "같은",
      "같은",
    ]);
    expect(validateSourceLocationMetadata(text, result)).toBe(true);
    expect(validateSourceLocationMetadata(text + " ", result)).toBe(false);
  });
  it.each([
    [1, 2],
    [0, 1],
    [2, 99],
  ])("서로게이트/본문 경계 %s~%s를 거부한다", (start, end) => {
    expect(() => buildSourceLocationMetadata("😀끝", [segment(start, end)])).toThrow();
  });
  it("순서·겹침·버전·해시 형식 오류를 거부한다", () => {
    expect(() => buildSourceLocationMetadata("abc", [segment(1, 3), segment(0, 1)])).toThrow();
    const valid = buildSourceLocationMetadata("abc", [segment(0, 2)]);
    expect(sourceLocationMetadataSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
    expect(
      validateSourceLocationMetadata("abc", { ...valid, segments: [segment(0, 2), segment(1, 3)] }),
    ).toBe(false);
  });
  it("실제 페이지 본문만 가리키고 생성한 표지·빈 페이지는 제외한다", () => {
    const pages = [
      { pageNumber: 1, text: "same" },
      { pageNumber: 2, text: "" },
      { pageNumber: 3, text: "same" },
    ];
    const text = pages.map((item) => `[페이지 ${item.pageNumber}]\n${item.text}`).join("\n\n");
    const result = buildSourceLocationMetadata(text, pageSourceLocationSegments(pages, "pdf-page"));
    expect(
      result.segments.map((item) => [text.slice(item.start, item.end), item.coordinate]),
    ).toEqual([
      ["same", { kind: "pdf-page", pageNumber: 1 }],
      ["same", { kind: "pdf-page", pageNumber: 3 }],
    ]);
  });
  it("기존 NUL/CRLF/trim 정규화와 정확히 같은 본문에 실제 범위를 옮긴다", () => {
    const raw = " \r\n😀A\r\u0000\nB  ";
    const text = "😀A\nB";
    const result = normalizeSourceLocations(raw, text, [segment(3, raw.length)]);
    expect(result.segments).toEqual([segment(0, text.length)]);
    expect(validateSourceLocationMetadata(text, result)).toBe(true);
    expect(() => normalizeSourceLocations(raw, "다른 본문", [])).toThrow();
  });
  it("범위를 잘라내지 않고 위치 보관 한도만 partial로 표시한다", () => {
    const text = "x".repeat(20001);
    const result = buildSourceLocationMetadata(
      text,
      Array.from({ length: text.length }, (_, index) => segment(index, index + 1)),
    );
    expect(result.coverage).toBe("partial");
    expect(result.textSha256).toBe(sourceLocationTextSha(text));
    expect(result.segments.length).toBeLessThanOrEqual(sourceLocationLimits.segments);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      sourceLocationLimits.metadataBytes,
    );
    expect(validateSourceLocationMetadata(text, result)).toBe(true);
  });
  it("셀의 행·열과 A1 주소 불일치를 거부한다", () => {
    const value = {
      kind: "spreadsheet-cell",
      sheetIndex: 1,
      sheetName: "Sheet",
      row: 1,
      column: 27,
      address: "AA1",
    };
    expect(sourceCoordinateSchema.safeParse(value).success).toBe(true);
    expect(sourceCoordinateSchema.safeParse({ ...value, address: "A1" }).success).toBe(false);
    expect(sourceCoordinateSchema.safeParse({ ...value, address: "?" }).success).toBe(false);
  });
});
describe("실제 SRT/VTT cue의 시간과 문자 범위", () => {
  it("SRT 동일 문구를 서로 다른 실제 시간으로 구분한다", () => {
    const text =
      "1\n00:00:01,000 --> 00:00:02,500\n같은😀\n\n2\n00:01:00,000 --> 00:01:01,000\n같은😀";
    const result = subtitleSourceLocations(text, "srt");
    expect(result.coverage).toBe("complete");
    expect(result.segments.map((item) => text.slice(item.start, item.end))).toEqual([
      "같은😀",
      "같은😀",
    ]);
    expect(result.segments[1].coordinate).toMatchObject({
      kind: "subtitle-cue",
      format: "srt",
      startMs: 60000,
      endMs: 61000,
      cueId: "2",
    });
  });
  it("VTT 헤더/주석/스타일을 위치로 만들지 않고 cue ID·설정과 다중행 본문을 보존한다", () => {
    const text =
      "WEBVTT\n\nNOTE hidden\n00:00.000 --> 00:01.000\nignore\n\nSTYLE\n::cue { color: red }\n\ncue-id\n00:01.250 --> 00:03.000 align:start\n첫행\n둘째행";
    const result = subtitleSourceLocations(text, "vtt");
    expect(result.segments).toHaveLength(1);
    const first = result.segments[0];
    expect(text.slice(first.start, first.end)).toBe("첫행\n둘째행");
    expect(first.coordinate).toMatchObject({ startMs: 1250, endMs: 3000, cueId: "cue-id" });
  });
  it.each(["00:99:01,000 --> 00:00:02,000", "00:00:02,000 --> 00:00:01,000", "시간 없음"])(
    "잘못된 시간 %s는 추정하지 않는다",
    (timing) => {
      const text = `1\n${timing}\n본문`;
      expect(subtitleSourceLocations(text, "srt")).toMatchObject({
        coverage: "partial",
        segments: [],
      });
    },
  );
  it("수기 위치 표지만 있거나 VTT 헤더가 없으면 구조 좌표를 만들지 않는다", () => {
    expect(subtitleSourceLocations("[페이지 2] 회사명", "srt").segments).toEqual([]);
    expect(subtitleSourceLocations("00:01.000 --> 00:02.000\n회사명", "vtt")).toMatchObject({
      coverage: "partial",
      segments: [],
    });
  });
});
