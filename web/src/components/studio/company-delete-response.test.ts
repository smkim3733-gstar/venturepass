import { describe, expect, it } from "vitest";
import { companyDeletionAcknowledged } from "./company-delete-response";

describe("company deletion acknowledgement", () => {
  it("accepts only the explicit successful route response without changing it", () => {
    const value = Object.freeze({ ok: true });
    expect(companyDeletionAcknowledged(value)).toBe(true);
    expect(value).toEqual({ ok: true });
  });
  it.each([
    ["negative acknowledgement", { ok: false }],
    ["missing acknowledgement", {}],
    ["null response", null],
    ["absent response", undefined],
    ["string acknowledgement", { ok: "true" }],
    ["numeric acknowledgement", { ok: 1 }],
    ["bare boolean", true],
    ["array response", [{ ok: true }]],
    ["conflicting error", { ok: true, error: "Deletion was not completed" }],
    ["unexpected target metadata", { ok: true, caseId: "another-company" }],
  ])("rejects %s", (_label, value) => {
    expect(companyDeletionAcknowledged(value)).toBe(false);
  });
});
