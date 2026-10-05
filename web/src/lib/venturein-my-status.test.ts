import { describe, expect, it } from "vitest";
import { decodeVentureMyStatus, ventureMyStatusUrl, type VentureMyTable } from "./venturein-my-status";
import { myStatusExpected, myStatusFixture } from "./venturein-my-status-test-fixture";

function observed(table: VentureMyTable) {
  if (table.state !== "observed") throw new Error("fixture");
  return table;
}
describe("MY벤처현황 supplied read adapter", () => {
  it("selects the exact requested row, never the first, newest, or certificate number", () => {
    const out = decodeVentureMyStatus(myStatusFixture(), myStatusExpected);
    expect(out.target.state).toBe("matched");
    expect(out.target.row?.applicationNumber).toBe("SYNTHETIC-REQUEST-B");
    expect(out.target.row?.resultText).toBe("확인");
    expect(out.target.row?.notifiedDateText).toBeNull();
    expect(out.certificates.rows[0]?.certificateNumber).toBe("SYNTHETIC-CERT-9");
    expect(out).toMatchObject({ origin: "supplied-observation", officialStatusChecked: false,
      transmissionAllowed: false, databaseChanged: false, receiptVerified: false,
      progressAttribution: "unverified", certificateApplicationLink: "unverified" });
    expect(JSON.stringify(out)).not.toContain("PRIVATE");
    expect(JSON.stringify(out)).not.toContain("777");
  });
  it("reads the nine-column variant by its labels", () => {
    const f = myStatusFixture(), t = observed(f.applications);
    t.headers.splice(4, 0, "이의신청가능기간");
    t.rows.forEach((row) => row.splice(4, 0, "IGNORED-PERIOD"));
    expect(decodeVentureMyStatus(f, myStatusExpected).target.row?.resultText).toBe("확인");
  });
  it("accepts reordered recognized columns without moving field meaning", () => {
    const f = myStatusFixture(), t = observed(f.applications);
    t.headers.reverse(); t.rows.forEach((row) => row.reverse());
    expect(decodeVentureMyStatus(f, myStatusExpected).target.row?.applicationDateText).toBe("2030-01-01");
  });
  it("normalizes label layout whitespace only and preserves unknown literal result text", () => {
    const f = myStatusFixture(), t = observed(f.applications);
    t.headers[1] = " \n신청번호\t";
    t.rows[1][4] = "  확인\n추가 문구 <img src=x>  ";
    expect(decodeVentureMyStatus(f, myStatusExpected).target.row?.resultText).toBe("확인\n추가 문구 <img src=x>");
  });
  it.each([null, "MISSING", "synthetic-request-b", "SYNTHETIC-CERT-9"])("does not infer a target for %s", (applicationNumber) => {
    const out = decodeVentureMyStatus(myStatusFixture(), { ...myStatusExpected, applicationNumber });
    expect(out.target.row).toBeNull();
    expect(out.target.state).toBe(applicationNumber === null ? "not-requested" : "not-observed");
  });
  it("does not infer missing dates, valid-now, official success, or follow-up deadlines", () => {
    const f = myStatusFixture();
    observed(f.certificates).rows[0][3] = "";
    const out = decodeVentureMyStatus(f, myStatusExpected);
    expect(out.certificates.rows[0]?.validityText).toBeNull();
    expect(out).not.toHaveProperty("status");
    expect(out).not.toHaveProperty("lastCheckedAt");
    expect(out).not.toHaveProperty("confirmedAt");
  });
  it.each(["missing-column", "duplicate-column", "extra-column", "short-row", "long-row", "duplicate-id", "empty-id", "multiline-id", "masked-id"])(
    "leaves the whole application table unverified for %s", (kind) => {
      const f = myStatusFixture(), t = observed(f.applications);
      if (kind === "missing-column") t.headers.pop();
      if (kind === "duplicate-column") t.headers[4] = "신청번호";
      if (kind === "extra-column") t.headers.push("알 수 없음");
      if (kind === "short-row") t.rows[0].pop();
      if (kind === "long-row") t.rows[0].push("EXTRA");
      if (kind === "duplicate-id") t.rows[0][1] = t.rows[1][1];
      if (kind === "masked-id") t.rows[0][1] = "SYNTHETIC-***";
      if (kind === "empty-id") t.rows[0][1] = "";
      if (kind === "multiline-id") t.rows[0][1] = "BROKEN\nID";
      const out = decodeVentureMyStatus(f, myStatusExpected);
      expect(out.applications).toMatchObject({ state: "unsupported", rows: [] });
      expect(out.target.state).toBe("unverified");
      expect(out.certificates.state).toBe("observed");
    });
  it.each(["middle-blank", "extra-row-cell", "duplicate-id"])("rejects ambiguous certificate structure: %s", (kind) => {
    const f = myStatusFixture(), t = observed(f.certificates);
    if (kind === "middle-blank") { t.headers.pop(); t.headers.splice(3, 0, ""); }
    if (kind === "extra-row-cell") t.rows[0].push("");
    if (kind === "duplicate-id") t.rows.push([...t.rows[0]]);
    const out = decodeVentureMyStatus(f, myStatusExpected);
    expect(out.certificates).toMatchObject({ state: "unsupported", rows: [] });
    expect(out.target.state).toBe("matched");
  });
  it("distinguishes an observed empty table, missing table, and unsupported table", () => {
    const f = myStatusFixture(); observed(f.applications).rows = [];
    expect(decodeVentureMyStatus(f, myStatusExpected).target.state).toBe("not-observed");
    f.applications = { state: "not-present" };
    expect(decodeVentureMyStatus(f, myStatusExpected).target.state).toBe("unverified");
    f.applications = { state: "unsupported", reason: "observation-limit" };
    expect(decodeVentureMyStatus(f, myStatusExpected).applications).toMatchObject({ reason: "observation-limit" });
  });
  it.each(["other", "missing", "mixed", "masked", "truncated"])("refuses unverified company %s", (kind) => {
    const f = myStatusFixture();
    if (kind === "other") f.screen.companyEvidence[0].value = "888-88-00002";
    if (kind === "missing") f.screen.companyEvidence = [];
    if (kind === "mixed") f.screen.companyEvidence.push({ ...f.screen.companyEvidence[0], value: "888-88-00002" });
    if (kind === "masked") f.screen.companyEvidence[0].value = "777-**-00001";
    if (kind === "truncated") f.screen.truncated = true;
    expect(() => decodeVentureMyStatus(f, myStatusExpected)).toThrow(expect.objectContaining({ code: "COMPANY_UNVERIFIED" }));
  });
  it.each([ventureMyStatusUrl + "?private=x", "https://www.smes.go.kr/venturein/aply/v2", "https://example.test/venturein/myVntr/viewMyVntr"])(
    "refuses unsupported or unsanitized URL %s", (url) => {
      const f = myStatusFixture(); f.screen.url = url;
      expect(() => decodeVentureMyStatus(f, myStatusExpected)).toThrow();
    });
  it("rejects authority/extra field injection, oversized cells/rows, and malformed expectations", () => {
    const f = myStatusFixture();
    expect(() => decodeVentureMyStatus({ ...f, origin: "page-observation" }, myStatusExpected)).toThrow();
    expect(() => decodeVentureMyStatus(f, { ...myStatusExpected, confirmed: true })).toThrow();
    expect(() => decodeVentureMyStatus(f, { ...myStatusExpected, applicationNumber: " ID " })).toThrow();
    expect(() => decodeVentureMyStatus(f, { ...myStatusExpected, applicationNumber: "SYNTHETIC-***" })).toThrow();
    observed(f.applications).rows[0][4] = "x".repeat(501);
    expect(() => decodeVentureMyStatus(f, myStatusExpected)).toThrow();
    observed(f.applications).rows = Array.from({ length: 101 }, () => [""]);
    expect(() => decodeVentureMyStatus(f, myStatusExpected)).toThrow();
  });
  it("preserves caller objects and isolates every returned row including the selected copy", () => {
    const f = myStatusFixture(), before = structuredClone(f);
    const out = decodeVentureMyStatus(f, myStatusExpected);
    out.target.row!.resultText = "MUTATED";
    out.applications.rows[0].resultText = "CHANGED";
    out.certificates.rows[0].typeText = "OTHER";
    expect(f).toEqual(before);
    expect(out.applications.rows[1].resultText).toBe("확인");
    expect(decodeVentureMyStatus(f, myStatusExpected).target.row?.resultText).toBe("확인");
  });
});
