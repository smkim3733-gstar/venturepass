import { describe, expect, it } from "vitest";
import { studioStatusResponse } from "./studio-status-response";
const valid = () => ({ aiConfigured: true, model: "synthetic-model", storage: "local", supportedFiles: [".pdf", ".txt"] });
describe("studio connection status response", () => {
  it("accepts connected status preserving all values and original input", () => {
    const value = valid(), snapshot = JSON.stringify(value);
    expect(studioStatusResponse(value)).toEqual(value);
    expect(JSON.stringify(value)).toBe(snapshot);
  });
  it("accepts explicit disconnected status and an empty format list", () => {
    const value = { ...valid(), aiConfigured: false, supportedFiles: [] };
    expect(studioStatusResponse(value)).toEqual(value);
  });
  it("preserves model spelling, extension case and order", () => {
    const value = { ...valid(), model: "  custom model  ", supportedFiles: [".TXT", ".pdf"] };
    expect(studioStatusResponse(value)).toEqual(value);
  });
  const invalid: [string, unknown][] = [
    ["null", null], ["missing", {}], ["array", []], ["boolean", true],
    ["string false", { ...valid(), aiConfigured: "false" }],
    ["string true", { ...valid(), aiConfigured: "true" }],
    ["numeric flag", { ...valid(), aiConfigured: 1 }],
    ["missing flag", { model: "test", storage: "local", supportedFiles: [] }],
    ["null flag", { ...valid(), aiConfigured: null }],
    ["null model", { ...valid(), model: null }],
    ["empty model", { ...valid(), model: "" }],
    ["blank model", { ...valid(), model: "   " }],
    ["other storage", { ...valid(), storage: "cloud" }],
    ["string formats", { ...valid(), supportedFiles: ".pdf" }],
    ["null formats", { ...valid(), supportedFiles: null }],
    ["null extension", { ...valid(), supportedFiles: [null] }],
    ["number extension", { ...valid(), supportedFiles: [1] }],
    ["empty extension", { ...valid(), supportedFiles: [""] }],
    ["invalid extension", { ...valid(), supportedFiles: ["image/*"] }],
    ["duplicate extension", { ...valid(), supportedFiles: [".pdf", ".pdf"] }],
    ["mixed error", { ...valid(), error: "unavailable" }],
  ];
  it.each(invalid)("rejects %s without coercion", (_, value) => expect(studioStatusResponse(value)).toBeNull());
});
