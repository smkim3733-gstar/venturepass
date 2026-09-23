import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getCompanyFilters, getVentureSummary, queryCompanies } from "./venture-data";
import type { Company } from "./venture-types";

describe("audited innovation company data", () => {
  it("keeps all 26,525 innovation records and the audited distributions", () => {
    expect(queryCompanies().total).toBe(26525);
    const summary = getVentureSummary();
    expect(summary.total).toBe(40858);
    expect(summary.detailIndustryCount).toBe(870);
    expect(summary.industries.find(({ label }) => label === "제조업")?.count).toBe(16846);
    expect(summary.kinds.find(({ label }) => label === "재확인")?.count).toBe(15454);
    expect(getCompanyFilters().regions).toContain("전남광주");
  });

  it("searches Korean names, products, detail industries and addresses with flexible spaces", () => {
    const named = queryCompanies({ q: "  제이  솔루션  " }).items;
    expect(named.some(({ id }) => id === 4)).toBe(true);
    expect(queryCompanies({ q: "이형삽입기 로봇" }).items.some(({ id }) => id === 4)).toBe(true);
    expect(
      queryCompanies({ q: "경기도평택시 반도체제조용기계제조업" }).items.some(({ id }) => id === 4),
    ).toBe(true);
    expect(queryCompanies({ q: "iot우산" }).items.some(({ id }) => id === 7)).toBe(true);
  });

  it("combines exact filters while preserving original regional labels", () => {
    const result = queryCompanies({
      region: "부산",
      industry: "제조업",
      kind: "재확인",
      pageSize: 50,
    });
    expect(result.total).toBeGreaterThan(0);
    expect(
      result.items.every(
        (company) =>
          company.region === "부산" &&
          company.industry === "제조업" &&
          company.confirmationKind === "재확인",
      ),
    ).toBe(true);
    expect(result.items.some(({ id }) => id === 2)).toBe(true);
    expect(queryCompanies({ region: "없는 지역" }).total).toBe(0);
  });

  it("bounds page size and clamps invalid or out-of-range pages", () => {
    expect(queryCompanies({ page: -2, pageSize: 100000 }).page).toBe(1);
    expect(queryCompanies({ pageSize: 100000 }).items).toHaveLength(20);
    expect(queryCompanies({ page: Number.NaN }).page).toBe(1);
    expect(queryCompanies({ page: Number.POSITIVE_INFINITY }).page).toBe(1);
    const last = queryCompanies({ page: 9999999, pageSize: 50 });
    expect(last.page).toBe(531);
    expect(last.totalPages).toBe(531);
    expect(last.items).toHaveLength(25);
    const empty = queryCompanies({ q: "결과가존재하지않는검색어739194", page: 30 });
    expect(empty).toMatchObject({ total: 0, page: 1, totalPages: 1, items: [] });
  });

  it("keeps distinct original IDs for same-name records across pages", () => {
    const all: Company[] = [];
    const first = queryCompanies({ pageSize: 50 });
    for (let page = 1; page <= first.totalPages; page += 1) {
      all.push(...queryCompanies({ page, pageSize: 50 }).items);
    }
    expect(new Set(all.map(({ id }) => id)).size).toBe(26525);
    expect(all.length - new Set(all.map(({ name }) => name)).size).toBe(271);
    const duplicate = all.find(
      (company, index) => all.findIndex(({ name }) => name === company.name) !== index,
    )!;
    const sameName = all.filter(({ name }) => name === duplicate.name);
    expect(sameName.length).toBeGreaterThan(1);
    expect(new Set(sameName.map(({ id }) => id)).size).toBe(sameName.length);
  });
});
