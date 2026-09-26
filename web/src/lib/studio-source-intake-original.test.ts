import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { validateSourceIntakeOriginal } from "./studio-source-intake-original";

describe("접수 원본의 파서 없는 형식 검사", () => {
  it.each([
    ["test.pdf", "application/pdf", Buffer.from("%PDF-1.4\nsynthetic")],
    ["test.png", "image/png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ["test.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["test.webp", "image/webp", Buffer.from("RIFF0000WEBP")],
    [
      "test.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      Buffer.from([0x50, 0x4b, 3, 4]),
    ],
    ["test.xlsx", null, Buffer.from([0x50, 0x4b, 3, 4])],
    ["test.csv", "application/vnd.ms-excel", Buffer.from("연도,금액")],
    ["test.txt", "text/plain;charset=utf-8", Buffer.from("한글 텍스트")],
    ["test.txt", null, Buffer.from([0xff, 0xfe, 0x41, 0])],
  ] as const)("%s 원본을 파싱·추출 없이 보관 대상으로 허용한다", (name, mimeType, buffer) => {
    expect(validateSourceIntakeOriginal({ name, mimeType, buffer })).toEqual({
      name,
      mimeType,
      buffer,
    });
  });
  it.each([
    ["test.pdf", "application/pdf", Buffer.from("not-pdf")],
    ["test.jpg", "image/png", Buffer.from([0xff, 0xd8, 0xff])],
    ["test.xlsx", null, Buffer.from("not-zip")],
    ["test.txt", null, Buffer.from("abc\0def")],
    ["test.txt", "application/pdf", Buffer.from("plain text")],
    ["test.pdf", "text/plain", Buffer.from("%PDF-1.4")],
  ] as const)("%s 위장 형식을 거부한다", (name, mimeType, buffer) => {
    expect(() => validateSourceIntakeOriginal({ name, mimeType, buffer })).toThrow();
  });
  it.each(["../test.txt", "C:\\test.txt", "test.txt.", "nul.txt", "test.mp3"])(
    "안전하지 않거나 이번 지원 범위 밖 이름 %s를 거부한다",
    (name) => {
      expect(() =>
        validateSourceIntakeOriginal({ name, mimeType: null, buffer: Buffer.from("text") }),
      ).toThrow();
    },
  );
  it("빈 파일·12MiB 초과는 원본 접수 전 거부한다", () => {
    for (const buffer of [Buffer.alloc(0), Buffer.alloc(12 * 1024 * 1024 + 1)])
      expect(() =>
        validateSourceIntakeOriginal({ name: "test.txt", mimeType: null, buffer }),
      ).toThrow();
  });
});
