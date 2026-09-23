import type { Metadata } from "next";

import { CompanyExplorer } from "@/components/company-explorer";
import { getCompanyFilters, queryCompanies } from "@/lib/venture-data";
import type { CompanyQuery } from "@/lib/venture-types";

export const metadata: Metadata = {
  title: "확인기업 탐색",
  description: "2026년 8월 명단에 포함된 혁신성장유형 확인기업을 업종, 지역, 제품으로 탐색합니다.",
};

export const runtime = "nodejs";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const scalar = (key: string) => (typeof params[key] === "string" ? params[key].trim() : "");
  const query: Required<CompanyQuery> = {
    q: scalar("q").slice(0, 120),
    region: scalar("region"),
    industry: scalar("industry"),
    kind: scalar("kind"),
    page: Number(scalar("page")) || 1,
    pageSize: Number(scalar("pageSize")) || 20,
  };
  const initialResult = queryCompanies(query);
  const initialQuery = { ...query, page: initialResult.page, pageSize: initialResult.pageSize };

  return (
    <div className="min-w-0 space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold tracking-[0.12em] text-primary">
            COMPANY EXPLORER
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            확인기업 탐색
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
            2026년 8월 명단의 혁신성장유형 확인기업 26,525개 기록을 살펴보세요. 회사명과 제품,
            업종을 검색해 우리 기업과 가까운 사례를 찾을 수 있습니다.
          </p>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-500">
          데이터 기준 · 2026.08
        </span>
      </div>
      <CompanyExplorer
        initialQuery={initialQuery}
        initialResult={initialResult}
        filters={getCompanyFilters()}
      />
    </div>
  );
}
