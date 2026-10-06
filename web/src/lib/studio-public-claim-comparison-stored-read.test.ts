import { it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { copyComparisonStoredRead } from "./studio-public-claim-comparison-stored-read";
for (const kind of ["selection", "result"] as const) {
  const limit = kind === "selection" ? 8192 : 4 * 1024 * 1024;
  it("4I32 " + kind + " accepts the exact UTF8 byte cap without truncation", () => {
    const value = { text: "가".repeat(Math.floor((limit - 11) / 3)) };
    value.text += "a".repeat(limit - Buffer.byteLength(JSON.stringify(value)));
    const copied = copyComparisonStoredRead(value, kind);
    expect(copied).not.toBe(value);
    expect(Buffer.compare(Buffer.from(JSON.stringify(copied)), Buffer.from(JSON.stringify(value)))).toBe(0);
    copied.text = "changed";
    expect(value.text).not.toBe("changed");
  });
  it("4I32 " + kind + " refuses cap plus one and accessor input without executing it", () => {
    expect(() => copyComparisonStoredRead({ text: "a".repeat(limit - 10) }, kind)).toThrow(/LIMIT/);
    const getter = vi.fn(() => "secret");
    expect(() => copyComparisonStoredRead(Object.defineProperty({}, "text", { enumerable: true, get: getter }), kind)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
}
