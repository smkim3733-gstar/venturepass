import { expect, it } from "vitest";
import {
  decodePublicStatisticsCell,
  readPublicStatisticsCellTarget,
} from "./studio-public-statistics-cell";
import { syntheticCellTarget, syntheticCellRow } from "./studio-public-statistics-test-fixture";

it.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "matches all %i selected classification identities and preserves literal data",
  (n) => {
    const target = syntheticCellTarget(n),
      row = syntheticCellRow(target);
    const before = JSON.stringify({ target, row });
    const result = decodePublicStatisticsCell([row], target);
    expect(result).toMatchObject({
      status: "matched",
      source: "supplied-response",
      factChecked: false,
      wholeTableRead: false,
      companyApplicabilityChecked: false,
      databaseChanged: false,
      aiInputApproved: false,
    });
    expect(result.cell?.classifications.map((c) => c.code)).toEqual(target.classifications);
    expect(result.cell).toMatchObject({
      value: "12,345.00",
      unitName: "합성 단위",
      lastChangedText: "2025-01-01",
    });
    expect(result.originalUrl).toBe(
      "https://kosis.kr/statHtml/statHtml.do?orgId=999&tblId=DT_SYNTHETIC",
    );
    result.target.classifications[0] = "changed";
    result.cell!.classifications[0].code = "changed";
    expect(JSON.stringify({ target, row })).toBe(before);
  },
);
it.each([
  ["Y", "0001"],
  ["Y", "2024"],
  ["M", "202401"],
  ["M", "202412"],
  ["Q", "202401"],
  ["Q", "202404"],
  ["S", "202401"],
  ["S", "202402"],
])("accepts explicit period %s/%s", (cycle, point) => {
  expect(
    readPublicStatisticsCellTarget({ ...syntheticCellTarget(), period: { cycle, point } }).period,
  ).toEqual({ cycle, point });
});
it.each([
  ["Y", "0000"],
  ["Y", "202401"],
  ["Y", " 2024"],
  ["Y", "2024 "],
  ["M", "202400"],
  ["M", "202413"],
  ["M", "2024"],
  ["Q", "202405"],
  ["S", "202403"],
  ["D", "20240101"],
  ["F", "2024"],
  ["IR", "2024"],
  ["Y", "２０２４"],
  ["Y", "2024\n"],
  ["Q", "2024Q1"],
])("rejects unsupported or ambiguous period %s/%s", (cycle, point) => {
  expect(() =>
    readPublicStatisticsCellTarget({ ...syntheticCellTarget(), period: { cycle, point } }),
  ).toThrow();
});
it.each([
  "ALL",
  "all",
  "All",
  "*",
  "A+B",
  "A,B",
  "A B",
  "A&B",
  "A/B",
  "",
  "a".repeat(41),
  "x\u0000y",
  "x\ny",
])("rejects non-single item code %j", (itemId) => {
  expect(() => readPublicStatisticsCellTarget({ ...syntheticCellTarget(), itemId })).toThrow();
});
it.each([
  { classifications: [] },
  { classifications: Array(9).fill("001") },
  { classifications: ["ALL"] },
  { organizationId: "999&key=x" },
  { tableId: "https://evil.invalid" },
  { period: { cycle: "Y", point: "2024", newEstPrdCnt: 1 } },
  { company: "private" },
  { source: { text: "private" } },
  { apiKey: "synthetic-caller-key" },
  { url: "https://evil.invalid" },
  { outputFields: "DT" },
  { confirmed: true },
])("rejects extra or invalid target fields %j", (patch) => {
  expect(() => readPublicStatisticsCellTarget({ ...syntheticCellTarget(), ...patch })).toThrow();
});
it("bounds raw input and reports no caller content for cyclic or oversized data", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const input of [
    cyclic,
    { ...syntheticCellTarget(), company: "PRIVATE".repeat(2000) },
    undefined,
  ]) {
    expect(() => readPublicStatisticsCellTarget(input)).toThrow("선택한 통계 수치");
    try {
      readPublicStatisticsCellTarget(input);
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE");
    }
  }
});
it.each([
  "0",
  "",
  ":",
  "-",
  "…",
  "1,000.000",
  " 1 ",
  "<img src=x onerror=alert(1)>",
  "a".repeat(100),
])("preserves DT without numeric/HTML conversion %j", (DT) => {
  expect(
    decodePublicStatisticsCell([{ ...syntheticCellRow(), DT }], syntheticCellTarget()).cell?.value,
  ).toBe(DT);
});
it.each([
  { ORG_ID: "998" },
  { TBL_ID: "dt_SYNTHETIC" },
  { ITM_ID: "t001" },
  { C1: "1" },
  { C2: "002a" },
  { PRD_SE: "M" },
  { PRD_DE: "2023" },
  { C3: "003" },
  { C3_NM: "hidden dimension" },
  { C3: null },
  { C9: "009" },
  { DT: 0 },
  { DT: null },
  { DT: "x".repeat(101) },
  { TBL_NM: "x".repeat(301) },
  { C1_NM: "x".repeat(3001) },
  { UNIT_NM: "x".repeat(1001) },
  { LST_CHN_DE: "x".repeat(11) },
  { officialStatusChecked: true },
])("rejects mismatched identities, omitted scope, overflow and authority fields %j", (patch) => {
  expect(() =>
    decodePublicStatisticsCell([{ ...syntheticCellRow(), ...patch }], syntheticCellTarget()),
  ).toThrow();
});
it.each(["ORG_ID", "TBL_ID", "ITM_ID", "C1", "C2", "PRD_SE", "PRD_DE", "DT"])(
  "requires identity/value field %s",
  (field) => {
    const row = syntheticCellRow();
    delete row[field];
    expect(() => decodePublicStatisticsCell([row], syntheticCellTarget())).toThrow();
  },
);
it("does not invent missing Korean labels, units or dates from English labels", () => {
  const row = syntheticCellRow();
  for (const key of ["ITM_NM", "UNIT_ID", "UNIT_NM", "LST_CHN_DE", "C1_OBJ_NM", "C1_NM"])
    delete row[key];
  row.ITM_NM_ENG = "Synthetic English";
  row.UNIT_NM_ENG = "Synthetic unit";
  row.C1_NM_ENG = "Synthetic class";
  const result = decodePublicStatisticsCell([row], syntheticCellTarget());
  expect(result.cell).toMatchObject({
    itemName: null,
    unitId: null,
    unitName: null,
    lastChangedText: null,
  });
  expect(result.cell?.classifications[0]).toEqual({
    code: "001",
    dimensionName: null,
    valueName: null,
  });
});
it("preserves long labels and unknown date/unit literals, null separately from empty", () => {
  const row = {
    ...syntheticCellRow(),
    ITM_NM: "가".repeat(3000),
    UNIT_NM: "가".repeat(1000),
    LST_CHN_DE: "unknown",
    C1_NM: null,
  };
  const result = decodePublicStatisticsCell([row], syntheticCellTarget());
  expect(result.cell?.itemName).toHaveLength(3000);
  expect(result.cell?.unitName).toHaveLength(1000);
  expect(result.cell?.lastChangedText).toBe("unknown");
  expect(result.cell?.classifications[0].valueName).toBeNull();
  expect(
    decodePublicStatisticsCell([{ ...row, UNIT_NM: "" }], syntheticCellTarget()).cell?.unitName,
  ).toBe("");
});
it("keeps no observed row distinct from zero, provider error and duplicate records", () => {
  expect(decodePublicStatisticsCell([], syntheticCellTarget())).toMatchObject({
    status: "empty",
    cell: null,
    source: "supplied-response",
  });
  for (const raw of [
    { err: "30", errMsg: "private" },
    null,
    [syntheticCellRow(), syntheticCellRow()],
    "[]",
  ])
    expect(() => decodePublicStatisticsCell(raw, syntheticCellTarget())).toThrow();
});
it("does not normalize single code case or leading zeros", () => {
  const target = { ...syntheticCellTarget(), itemId: "t-001_Ab" };
  expect(decodePublicStatisticsCell([syntheticCellRow(target)], target).target.itemId).toBe(
    "t-001_Ab",
  );
});
