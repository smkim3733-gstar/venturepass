import { NextRequest, NextResponse } from "next/server";

import { queryCompanies } from "@/lib/venture-data";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const result = queryCompanies({
    q: params.get("q") ?? undefined,
    region: params.get("region") ?? undefined,
    industry: params.get("industry") ?? undefined,
    kind: params.get("kind") ?? undefined,
    page: params.has("page") ? Number(params.get("page")) : undefined,
    pageSize: params.has("pageSize") ? Number(params.get("pageSize")) : undefined,
  });

  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
