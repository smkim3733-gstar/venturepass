import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  ClipboardCheck,
  Factory,
  Files,
  MapPin,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IndustryChart } from "@/components/overview-charts";
import { getVentureSummary } from "@/lib/venture-data";

export const runtime = "nodejs";

export default function Home() {
  const data = getVentureSummary();
  const manufacturing = data.industries.find((item) => item.label === "제조업")!;
  const renewal = data.kinds.find((item) => item.label === "재확인")!;
  const metrics = [
    {
      label: "혁신성장 확인기업",
      value: data.innovation.toLocaleString(),
      suffix: "개",
      description: `전체 벤처기업의 ${(data.innovationShare * 100).toFixed(1)}%`,
      icon: Building2,
    },
    {
      label: "제조업 비중",
      value: (manufacturing.share * 100).toFixed(1),
      suffix: "%",
      description: `${manufacturing.count.toLocaleString()}개 제조기업`,
      icon: Factory,
    },
    {
      label: "재확인 비중",
      value: (renewal.share * 100).toFixed(1),
      suffix: "%",
      description: `${renewal.count.toLocaleString()}개 재확인 기록`,
      icon: ShieldCheck,
    },
    {
      label: "세부업종",
      value: data.detailIndustryCount.toLocaleString(),
      suffix: "개",
      description: "업종명 11차 분류 기준",
      icon: Files,
    },
  ];
  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <div className="mb-2 text-xs font-bold tracking-wide text-primary">혁신성장유형 전용</div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-[29px]">
            벤처확인 준비, 여기서 시작하세요
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            확인기업의 현황을 살펴보고, 우리 기업에 필요한 근거를 차근차근 준비하세요.
          </p>
        </div>
        <Button asChild className="h-11 rounded-xl px-5">
          <Link href="/studio">
            <Sparkles className="size-4" />
            사업계획서 작성 시작
            <ArrowRight className="ml-1 size-4" />
          </Link>
        </Button>
      </div>
      <section aria-labelledby="data-heading">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 id="data-heading" className="text-sm font-bold">
            혁신성장 확인기업 현황
          </h2>
          <Badge variant="outline" className="bg-white font-normal text-muted-foreground">
            2026년 8월 명단
          </Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map(({ label, value, suffix, description, icon: Icon }) => (
            <Card key={label} className="gap-3 border-border/70 py-5 shadow-none">
              <CardContent className="px-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">{label}</span>
                  <span className="flex size-9 items-center justify-center rounded-xl bg-primary/[.06] text-primary">
                    <Icon className="size-[18px]" />
                  </span>
                </div>
                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-[34px] font-bold leading-tight tracking-tight tabular-nums">
                    {value}
                  </span>
                  <span className="text-sm text-muted-foreground">{suffix}</span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
      <div className="grid items-stretch gap-5 xl:grid-cols-[1.55fr_1fr]">
        <Card className="gap-3 border-border/70 shadow-none">
          <CardHeader className="flex-row items-start justify-between pb-0">
            <div>
              <CardTitle className="text-base">어떤 업종이 확인받았을까요?</CardTitle>
              <p className="mt-2 text-xs text-muted-foreground">
                혁신성장유형 26,525개 기록의 업종별 분포
              </p>
            </div>
            <Link
              href="/companies"
              aria-label="기업 전체 보기"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
            >
              <ArrowUpRight className="size-5" />
            </Link>
          </CardHeader>
          <CardContent className="px-4 sm:px-6">
            <IndustryChart data={data.industries} />
            <p className="mt-1 border-t pt-3 text-[11px] text-muted-foreground">
              확인기업 구성비입니다. 업종별 승인율을 의미하지 않습니다.
            </p>
          </CardContent>
        </Card>
        <Card className="gap-4 border-border/70 shadow-none">
          <CardHeader className="pb-0">
            <CardTitle className="text-base">지역별 확인기업</CardTitle>
            <p className="mt-2 text-xs text-muted-foreground">
              지역을 선택하면 해당 기업을 볼 수 있어요.
            </p>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.regions.slice(0, 6).map((region, index) => (
              <Link
                key={region.label}
                href={`/companies?region=${encodeURIComponent(region.label)}`}
                className="group flex items-center gap-3 rounded-lg px-1 py-2.5 hover:bg-muted"
              >
                <span className="w-5 text-xs tabular-nums text-muted-foreground">0{index + 1}</span>
                <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <MapPin className="size-4" />
                </span>
                <span className="text-sm font-medium">{region.label}</span>
                <span className="ml-auto text-sm font-semibold tabular-nums">
                  {region.count.toLocaleString()}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">개</span>
                </span>
                <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
                  {(region.share * 100).toFixed(1)}%
                </span>
                <ArrowUpRight className="ml-1 size-3.5 text-muted-foreground group-hover:text-primary" />
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
      <section aria-labelledby="next-heading">
        <h2 id="next-heading" className="mb-4 text-base font-bold">
          다음으로 무엇을 준비할까요?
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              number: "01",
              title: "우리 기업의 준비 경로 확인",
              body: "신규·재확인과 업력에 따라 필요한 준비 항목을 확인하세요.",
              href: "/application",
              icon: ClipboardCheck,
              action: "기업정보 입력",
            },
            {
              number: "02",
              title: "유사한 확인기업 살펴보기",
              body: "업종·제품·지역으로 실제 확인기업을 검색해 사업의 범위를 살펴보세요.",
              href: "/companies",
              icon: Search,
              action: "확인기업 탐색",
            },
            {
              number: "03",
              title: "주장에 맞는 증빙 준비",
              body: "기술혁신성과 사업성장성을 뒷받침하는 자료를 항목별로 점검하세요.",
              href: "/application#evidence",
              icon: Sparkles,
              action: "증빙 체크리스트",
            },
          ].map(({ number, title, body, href, icon: Icon, action }) => (
            <Link
              href={href}
              key={number}
              className="group rounded-2xl border border-border/70 bg-white p-6 transition-colors hover:border-primary/40"
            >
              <div className="flex items-center justify-between">
                <span className="flex size-10 items-center justify-center rounded-xl bg-primary/[.06] text-primary">
                  <Icon className="size-5" />
                </span>
                <span className="text-xs font-semibold text-muted-foreground/60">
                  STEP {number}
                </span>
              </div>
              <h3 className="mt-5 text-sm font-bold">{title}</h3>
              <p className="mt-2 min-h-12 text-xs leading-6 text-muted-foreground">{body}</p>
              <div className="mt-4 flex items-center gap-2 text-xs font-semibold text-primary">
                {action}
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" />
              </div>
            </Link>
          ))}
        </div>
      </section>
      <p className="text-xs leading-6 text-muted-foreground">
        명단에는 여러 연도의 유효시작 기록이 포함되어 있습니다. 기업 수는 원본 기록 기준이며, 같은
        이름의 기업도 원본 연번으로 구분했습니다.
      </p>
    </div>
  );
}
