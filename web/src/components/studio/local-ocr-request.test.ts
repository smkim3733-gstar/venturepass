import { describe, expect, it, vi } from "vitest";
import { localOcrRequestIdentity } from "./local-ocr-request";

describe("local OCR edited request identity", () => {
  it("allocates on first submission and preserves raw text", () => {
    const create = vi.fn(() => "first");
    expect(localOcrRequestIdentity(null, "  본문\n둘째 줄  ", create)).toEqual({
      text: "  본문\n둘째 줄  ",
      clientRequestId: "first",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("reuses the exact request after failure without allocating", () => {
    const previous = Object.freeze({ text: "  본문\n둘째 줄  ", clientRequestId: "first" });
    const create = vi.fn(() => "unused");
    expect(localOcrRequestIdentity(previous, previous.text, create)).toBe(previous);
    expect(create).not.toHaveBeenCalled();
  });
  it.each([
    ["changed content", "  수정 본문\n둘째 줄  "],
    ["outer whitespace", "본문\n둘째 줄"],
    ["internal newline", "  본문 둘째 줄  "],
  ])("assigns a new ID for %s without changing the old request", (_, text) => {
    const previous = Object.freeze({ text: "  본문\n둘째 줄  ", clientRequestId: "first" });
    const create = vi.fn(() => "second");
    expect(localOcrRequestIdentity(previous, text, create)).toEqual({
      text,
      clientRequestId: "second",
    });
    expect(previous).toEqual({ text: "  본문\n둘째 줄  ", clientRequestId: "first" });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("does not recycle an earlier request after submitting different text", () => {
    const first = localOcrRequestIdentity(null, "A", () => "first");
    const second = localOcrRequestIdentity(first, "B", () => "second");
    expect(localOcrRequestIdentity(second, "A", () => "third")).toEqual({
      text: "A",
      clientRequestId: "third",
    });
  });
  it("starts a fresh request when a closed preview is reopened", () => {
    const first = localOcrRequestIdentity(null, "A", () => "first");
    expect(localOcrRequestIdentity(null, first.text, () => "new-preview").clientRequestId).toBe(
      "new-preview",
    );
  });
});
