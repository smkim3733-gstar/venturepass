"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowUpRight,
  Building2,
  Check,
  ClipboardCheck,
  LayoutDashboard,
  Menu,
  Sprout,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useState } from "react";

const navigation = [
  { href: "/", label: "한눈에 보기", icon: LayoutDashboard },
  { href: "/studio", label: "사업계획서 스튜디오", icon: Sparkles },
  { href: "/companies", label: "확인기업 탐색", icon: Building2 },
  { href: "/application", label: "우리 기업 신청 준비", icon: ClipboardCheck },
];
function Brand({ studio = false }: { studio?: boolean }) {
  return (
    <Link
      href={studio ? "/studio" : "/"}
      className="flex min-h-11 shrink-0 items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      aria-label={studio ? "벤처패스 신청 준비" : "벤처패스 홈"}
    >
      <span
        className={cn(
          "flex size-10 items-center justify-center bg-primary",
          studio
            ? "rounded-md border-b-[3px] border-gold font-semibold text-gold"
            : "rounded-xl text-white shadow-sm",
        )}
        aria-hidden="true"
      >
        {studio ? "V" : <Sprout className="size-6" />}
      </span>
      <span>
        <span className="block text-[21px] font-extrabold tracking-tight text-foreground">
          벤처패스
        </span>
        <span className="block text-[10px] font-semibold tracking-[.13em] text-muted-foreground">
          VENTUREPASS
        </span>
      </span>
    </Link>
  );
}
function Navigation({ close, label = "주 메뉴" }: { close?: () => void; label?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="space-y-2">
      {navigation.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          onClick={close}
          aria-current={pathname === href ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-xl px-4 py-3.5 text-sm font-semibold transition-colors",
            pathname === href
              ? "bg-primary/8 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon className="size-[19px]" aria-hidden="true" />
          {label}
          {pathname === href && <span className="ml-auto size-1.5 rounded-full bg-primary" />}
        </Link>
      ))}
    </nav>
  );
}
export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const isStudio = pathname === "/studio" || pathname.startsWith("/studio/");
  const skipLink = (
    <a
      href="#main-content"
      className="sr-only fixed left-4 top-4 z-[60] rounded-md bg-white px-4 py-3 text-primary shadow-sm focus:not-sr-only focus:outline-2 focus:outline-offset-2 focus:outline-ring"
    >
      본문으로 이동
    </a>
  );

  if (isStudio) {
    return (
      <div className="min-h-screen bg-background" data-app-shell="studio">
        {skipLink}
        <header className="border-b border-border bg-white">
          <div className="mx-auto flex min-h-20 max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-7 lg:px-10">
            <Brand studio />
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  className="min-h-11 gap-2 px-3 text-muted-foreground"
                  aria-label="다른 메뉴 열기"
                >
                  <Menu className="size-4" aria-hidden="true" />
                  다른 메뉴
                </Button>
              </SheetTrigger>
              <SheetContent
                side="right"
                className="gap-6 overflow-y-auto p-6 data-[side=right]:w-[calc(100%_-_2rem)] [&_[data-slot=sheet-close]]:size-11"
              >
                <div className="pr-10">
                  <SheetTitle>다른 메뉴</SheetTitle>
                  <SheetDescription className="mt-2">
                    필요한 업무 화면으로 이동하세요.
                  </SheetDescription>
                </div>
                <Navigation label="다른 메뉴" close={() => setOpen(false)} />
                <a
                  href="https://www.smes.go.kr/venturein/institution/requireGuide?rgCd=C"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-auto flex min-h-11 items-center gap-2 rounded-md px-4 text-sm text-muted-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  공식 제도 안내
                  <ArrowUpRight className="size-4" aria-hidden="true" />
                  <span className="sr-only">새 창에서 열기</span>
                </a>
              </SheetContent>
            </Sheet>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto min-w-0 max-w-5xl px-4 pb-12 pt-6 outline-none sm:px-7 sm:pt-8 lg:px-10"
        >
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {skipLink}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[252px] flex-col border-r border-border/70 bg-white px-5 py-8 lg:flex">
        <div className="px-3">
          <Brand />
        </div>
        <div className="mb-4 mt-12 px-4 text-[11px] font-bold tracking-wider text-muted-foreground/80">
          혁신성장 워크스페이스
        </div>
        <Navigation />
        <div className="mt-auto rounded-2xl border border-primary/10 bg-primary/[.035] p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold text-primary">
            <Check className="size-4" />
            혁신성장유형 전용
          </div>
          <p className="text-xs leading-6 text-muted-foreground">
            기술의 혁신성과 사업의 성장성을 뒷받침할 근거를 준비하세요.
          </p>
          <a
            href="https://www.smes.go.kr/venturein/institution/requireGuide?rgCd=C"
            target="_blank"
            rel="noreferrer"
            className="mt-4 flex items-center gap-1 text-xs font-semibold text-primary"
          >
            공식 제도 안내
            <ArrowUpRight className="size-3.5" />
          </a>
        </div>
        <div className="mt-5 px-3 text-[11px] text-muted-foreground">2026 제도 가이드 기준</div>
      </aside>
      <div className="lg:ml-[252px]">
        <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-border/60 bg-white/95 px-5 backdrop-blur-sm sm:px-9">
          <div className="hidden items-center gap-3 text-sm lg:flex">
            <span className="text-muted-foreground">워크스페이스</span>
            <span className="text-border">/</span>
            <span className="font-semibold">혁신성장유형</span>
          </div>
          <div className="flex items-center gap-3 lg:hidden">
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="메뉴 열기">
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-80 p-6">
                <SheetTitle className="sr-only">메인 메뉴</SheetTitle>
                <Brand />
                <div className="mt-8">
                  <Navigation close={() => setOpen(false)} />
                </div>
              </SheetContent>
            </Sheet>
            <Brand />
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 sm:inline-flex">
              혁신성장유형
            </span>
            <div
              className="flex size-9 items-center justify-center rounded-full border bg-muted text-xs font-bold text-foreground"
              aria-label="내 워크스페이스"
            >
              MY
            </div>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto max-w-[1510px] px-5 py-8 outline-none sm:px-9 sm:py-10"
        >
          {children}
        </main>
        <footer className="mx-auto flex max-w-[1510px] flex-wrap justify-between gap-2 px-5 pb-7 text-[11px] text-muted-foreground sm:px-9">
          <span>VENTURE PASS · 혁신성장유형 신청 준비</span>
          <span>기업현황 출처: 벤처기업명단(2026년 8월)</span>
        </footer>
      </div>
    </div>
  );
}
