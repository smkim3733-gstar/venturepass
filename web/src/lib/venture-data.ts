import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  Company,
  CompanyFilters,
  CompanyQuery,
  CompanyQueryResult,
  VentureSummary,
} from "./venture-types";

let companiesCache: Company[] | undefined;
let searchCache: Map<number, string> | undefined;
let summaryCache: VentureSummary | undefined;

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR");
}

function getCompanies(): Company[] {
  if (!companiesCache) {
    companiesCache = JSON.parse(
      readFileSync(join(process.cwd(), "data", "venture-companies.json"), "utf8"),
    ) as Company[];
    searchCache = new Map(
      companiesCache.map((company) => [
        company.id,
        [company.name, company.product, company.detailIndustry, company.address]
          .map((value) => normalized(value).replace(/\s+/g, ""))
          .join("\n"),
      ]),
    );
  }
  return companiesCache;
}

export function getVentureSummary(): VentureSummary {
  summaryCache ??= JSON.parse(
    readFileSync(join(process.cwd(), "data", "venture-summary.json"), "utf8"),
  ) as VentureSummary;
  return summaryCache;
}

export function getCompanyFilters(): CompanyFilters {
  const summary = getVentureSummary();
  return {
    regions: summary.regions.map(({ label }) => label),
    industries: summary.industries.map(({ label }) => label),
    kinds: ["신규", "재확인"],
  };
}

export function queryCompanies(query: CompanyQuery = {}): CompanyQueryResult {
  const companies = getCompanies();
  const terms = normalized((query.q ?? "").trim().slice(0, 120))
    .split(/\s+/)
    .filter(Boolean);
  const region = query.region?.trim();
  const industry = query.industry?.trim();
  const kind = query.kind?.trim();
  const filtered = companies.filter((company) => {
    if (region && company.region !== region) return false;
    if (industry && company.industry !== industry) return false;
    if (kind && company.confirmationKind !== kind) return false;
    const searchable = searchCache!.get(company.id)!;
    return terms.every((term) => searchable.includes(term));
  });
  const pageSize = [10, 20, 50].includes(query.pageSize ?? 0) ? query.pageSize! : 20;
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = Number.isFinite(query.page) ? Math.max(1, Math.floor(query.page!)) : 1;
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * pageSize;

  return { items: filtered.slice(offset, offset + pageSize), total, page, pageSize, totalPages };
}
