"use client";

import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type ColumnDef,
  flexRender,
  rowPaginationFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import {
  ArrowRight,
  Building2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  LoaderCircle,
  MapPin,
  RotateCcw,
  Search,
  SearchX,
  SlidersHorizontal,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  Company,
  CompanyFilters,
  CompanyQuery,
  CompanyQueryResult,
} from "@/lib/venture-types";

interface Props {
  initialQuery: Required<CompanyQuery>;
  initialResult: CompanyQueryResult;
  filters: CompanyFilters;
}

const number = new Intl.NumberFormat("ko-KR");
const ALL = "__all__";
const features = tableFeatures({ rowPaginationFeature });

async function fetchCompanies(
  query: Required<CompanyQuery>,
  signal: AbortSignal,
): Promise<CompanyQueryResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== "") params.set(key, String(value));
  }
  const response = await fetch(`/api/companies?${params}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("기업 목록을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.");
  return response.json() as Promise<CompanyQueryResult>;
}

export function CompanyExplorer({ initialQuery, initialResult, filters }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [searchDraft, setSearchDraft] = useState(initialQuery.q);
  const [selected, setSelected] = useState<Company | null>(null);
  const { data, isPending, isFetching, isPlaceholderData, isError, error, refetch } = useQuery({
    queryKey: ["companies", query],
    queryFn: ({ signal }) => fetchCompanies(query, signal),
    initialData: JSON.stringify(query) === JSON.stringify(initialQuery) ? initialResult : undefined,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: 1,
  });

  function setFilter(key: "region" | "industry" | "kind", value: string) {
    setQuery((current) => ({ ...current, [key]: value === ALL ? "" : value, page: 1 }));
  }

  function reset() {
    setSearchDraft("");
    setQuery({ q: "", region: "", industry: "", kind: "", page: 1, pageSize: query.pageSize });
  }

  const columns = useMemo<ColumnDef<typeof features, Company>[]>(
    () => [
      {
        accessorKey: "id",
        header: "원본 연번",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-slate-400">{row.original.id}</span>
        ),
      },
      {
        accessorKey: "name",
        header: "기업명 / 지역",
        cell: ({ row }) => (
          <div className="min-w-52 max-w-72 py-1">
            <button
              className="block max-w-full truncate text-left text-sm font-semibold text-slate-900 underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
              onClick={() => setSelected(row.original)}
              aria-label={`${row.original.name} 상세보기`}
            >
              {row.original.name}
            </button>
            <span className="mt-1.5 flex items-center gap-1 text-xs text-slate-500">
              <MapPin className="size-3" aria-hidden="true" />
              {row.original.address}
            </span>
          </div>
        ),
      },
      {
        accessorKey: "detailIndustry",
        header: "업종",
        cell: ({ row }) => (
          <div className="w-52 whitespace-normal">
            <p className="text-[13px] leading-5 text-slate-700">{row.original.detailIndustry}</p>
            <p className="mt-1 text-xs text-slate-400">{row.original.industry}</p>
          </div>
        ),
      },
      {
        accessorKey: "product",
        header: "주생산품",
        cell: ({ row }) => (
          <p className="max-w-60 truncate text-[13px] text-slate-600" title={row.original.product}>
            {row.original.product || "기재 없음"}
          </p>
        ),
      },
      {
        accessorKey: "confirmationKind",
        header: "신청 구분",
        cell: ({ row }) => (
          <Badge
            variant="secondary"
            className={
              row.original.confirmationKind === "재확인"
                ? "border-0 bg-indigo-50 font-medium text-indigo-600"
                : "border-0 bg-teal-50 font-medium text-teal-700"
            }
          >
            {row.original.confirmationKind}
          </Badge>
        ),
      },
      {
        id: "detail",
        header: () => <span className="sr-only">기업 상세</span>,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSelected(row.original)}
            aria-label={`${row.original.name} 원본 ${row.original.id} 상세보기`}
          >
            <ArrowRight className="size-4 text-slate-400" />
          </Button>
        ),
      },
    ],
    [],
  );

  // Only this server response page enters the table; filtering and pagination remain on the server.
  const table = useTable({
    features,
    data: data?.items ?? [],
    columns,
    getRowId: (company) => String(company.id),
    manualPagination: true,
    rowCount: data?.total ?? 0,
    pageCount: data?.totalPages ?? 1,
    state: { pagination: { pageIndex: (data?.page ?? query.page) - 1, pageSize: query.pageSize } },
    onPaginationChange: (updater) => {
      const current = { pageIndex: (data?.page ?? query.page) - 1, pageSize: query.pageSize };
      const next = typeof updater === "function" ? updater(current) : updater;
      setQuery((value) => ({ ...value, page: next.pageIndex + 1, pageSize: next.pageSize }));
    },
  });

  const hasFilters = Boolean(query.q || query.region || query.industry || query.kind);
  const from = data?.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const until = data ? Math.min(data.page * data.pageSize, data.total) : 0;
  const page = data?.page ?? query.page;
  const pages = data?.totalPages ?? 1;
  const pagingDisabled = isFetching || isError || !data?.total;

  return (
    <div className="min-w-0 space-y-5">
      <Card className="gap-0 border-slate-200 bg-white py-0 shadow-none">
        <CardContent className="space-y-5 p-5 sm:p-6">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery((current) => ({ ...current, q: searchDraft.trim(), page: 1 }));
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <Label htmlFor="company-search" className="sr-only">
                회사명, 제품, 세부업종 또는 주소 검색
              </Label>
              <Input
                id="company-search"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="회사명, 제품, 세부업종 또는 주소 검색"
                maxLength={120}
                className="h-11 bg-slate-50/60 pl-10 text-sm shadow-none"
              />
            </div>
            <Button type="submit" className="h-11 px-5" disabled={isFetching}>
              <Search className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">검색</span>
              <span className="sr-only sm:hidden">기업 검색</span>
            </Button>
          </form>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <span className="flex items-center gap-2 text-xs font-medium text-slate-500">
              <SlidersHorizontal className="size-3.5" aria-hidden="true" /> 필터
            </span>
            <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
              <Select
                value={query.region || ALL}
                onValueChange={(value) => setFilter("region", value)}
              >
                <SelectTrigger className="h-10 w-full bg-white text-xs" aria-label="지역 필터">
                  <SelectValue>{query.region || "전체 지역"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>전체 지역</SelectItem>
                  {filters.regions.map((region) => (
                    <SelectItem key={region} value={region}>
                      {region}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={query.industry || ALL}
                onValueChange={(value) => setFilter("industry", value)}
              >
                <SelectTrigger className="h-10 w-full bg-white text-xs" aria-label="업종 필터">
                  <SelectValue>{query.industry || "전체 업종"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>전체 업종</SelectItem>
                  {filters.industries.map((industry) => (
                    <SelectItem key={industry} value={industry}>
                      {industry}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={query.kind || ALL} onValueChange={(value) => setFilter("kind", value)}>
                <SelectTrigger className="h-10 w-full bg-white text-xs" aria-label="신청 구분 필터">
                  <SelectValue>{query.kind || "신규 · 재확인 전체"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>신규 · 재확인 전체</SelectItem>
                  {filters.kinds.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {kind}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={reset}
              disabled={!hasFilters && !searchDraft}
              className="self-end text-xs text-slate-500 sm:self-auto"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" /> 초기화
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2" role="status" aria-live="polite">
          <h2 className="text-sm font-semibold text-slate-800">
            {hasFilters ? "검색 결과" : "전체 확인기업"}
          </h2>
          <span className="rounded-md bg-primary/10 px-2 py-0.5 text-sm font-semibold text-primary">
            {number.format(data?.total ?? 0)}
          </span>
          <span className="text-xs text-slate-400">개 기록</span>
          {isFetching && (
            <span className="flex items-center gap-1 text-xs text-slate-500">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> 조회 중
            </span>
          )}
        </div>
        <p className="text-xs text-slate-400">
          원본 연번 순 · 기업을 선택하면 상세정보를 확인할 수 있어요
        </p>
      </div>

      <Card className="min-w-0 gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-none">
        {isError ? (
          <div
            className="flex min-h-72 flex-col items-center justify-center gap-3 p-8 text-center"
            role="alert"
          >
            <CircleAlert className="size-8 text-amber-500" aria-hidden="true" />
            <p className="font-semibold text-slate-800">목록을 불러오지 못했어요</p>
            <p className="max-w-md text-sm leading-6 text-slate-500">
              {error instanceof Error ? error.message : "연결 상태를 확인하고 다시 시도해 주세요."}
            </p>
            <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
              다시 시도
            </Button>
          </div>
        ) : isPending ? (
          <div className="space-y-5 p-6" aria-label="기업 목록 불러오는 중">
            {Array.from({ length: 7 }, (_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : data?.total === 0 ? (
          <div className="flex min-h-80 flex-col items-center justify-center gap-3 p-8 text-center">
            <div className="rounded-2xl bg-slate-50 p-4">
              <SearchX className="size-7 text-slate-400" aria-hidden="true" />
            </div>
            <p className="mt-1 font-semibold text-slate-800">검색 조건에 맞는 기업이 없어요</p>
            <p className="max-w-md text-sm leading-6 text-slate-500">
              다른 검색어를 입력하거나 지역·업종 필터를 넓혀 보세요.
            </p>
            <Button variant="outline" size="sm" onClick={reset}>
              검색 조건 초기화
            </Button>
          </div>
        ) : (
          <div
            className={`min-w-0 max-w-full ${isPlaceholderData ? "opacity-50" : ""}`}
            aria-busy={isFetching}
          >
            <Table className="min-w-[980px]">
              <TableHeader>
                {table.getHeaderGroups().map((group) => (
                  <TableRow key={group.id} className="bg-slate-50/80 hover:bg-slate-50/80">
                    {group.headers.map((header) => (
                      <TableHead
                        key={header.id}
                        className="h-12 px-5 text-xs font-medium text-slate-500"
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} className="border-slate-100 hover:bg-slate-50/60">
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id} className="px-5 py-3.5">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 px-5 py-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span>
              {number.format(data?.total ?? 0)}개 중 {number.format(from)}–{number.format(until)}
            </span>
            <Select
              value={String(query.pageSize)}
              onValueChange={(value) =>
                setQuery((current) => ({ ...current, page: 1, pageSize: Number(value) }))
              }
            >
              <SelectTrigger className="h-8 w-28 bg-white text-xs" aria-label="페이지당 기록 수">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 20, 50].map((size) => (
                  <SelectItem value={String(size)} key={size}>
                    {size}개씩 보기
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <nav className="flex items-center gap-1" aria-label="기업 목록 페이지">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => table.firstPage()}
              disabled={pagingDisabled || page === 1}
              aria-label="첫 페이지"
            >
              <ChevronsLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.previousPage()}
              disabled={pagingDisabled || page === 1}
              aria-label="이전 페이지"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-24 px-2 text-center text-xs text-slate-500">
              <strong className="font-semibold text-slate-900">{number.format(page)}</strong> /{" "}
              {number.format(pages)}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.nextPage()}
              disabled={pagingDisabled || page >= pages}
              aria-label="다음 페이지"
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => table.lastPage()}
              disabled={pagingDisabled || page >= pages}
              aria-label="마지막 페이지"
            >
              <ChevronsRight className="size-4" />
            </Button>
          </nav>
        </div>
      </Card>

      <p className="px-1 text-xs leading-6 text-slate-400">
        출처: 벤처기업명단(2026년8월).xlsx · 같은 이름의 기업도 원본 연번별로 표시합니다. 신규는
        벤처확인 신청 구분이며 창업 여부를 뜻하지 않습니다. 이 명단으로 현재 확인 상태, 선정 이유
        또는 합격률을 판단할 수 없습니다.
      </p>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10">
              <Building2 className="size-5 text-primary" aria-hidden="true" />
            </div>
            <DialogTitle className="break-keep text-xl leading-7">{selected?.name}</DialogTitle>
            <DialogDescription>
              2026년 8월 원본 명단의 기업 정보 · 원본 연번 {selected?.id}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-5 rounded-xl border border-slate-100 bg-slate-50/60 p-5 sm:grid-cols-2">
                {[
                  ["원본 연번", String(selected.id)],
                  ["기업명", selected.name],
                  ["확인유형", "혁신성장유형"],
                  ["신청 구분", selected.confirmationKind],
                  ["지역 (원본)", selected.region],
                  ["주소 (원본)", selected.address],
                  ["업종분류 (기보)", selected.industry],
                  ["세부업종 (11차)", selected.detailIndustry],
                  ["확인 유효시작일", selected.validFrom],
                  ["확인 유효종료일", selected.validUntil],
                  ["주생산품", selected.product || "기재 없음"],
                ].map(([label, value]) => (
                  <div key={label} className={label === "주생산품" ? "sm:col-span-2" : "min-w-0"}>
                    <dt className="text-xs text-slate-500">{label}</dt>
                    <dd className="mt-1.5 break-words text-sm font-medium leading-6 text-slate-900">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs leading-5 text-slate-500">
                표시된 날짜는 벤처확인 유효기간입니다. 설립일이나 업력 정보가 아니며, 현재 유효
                상태를 새로 조회한 결과가 아닙니다.
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
