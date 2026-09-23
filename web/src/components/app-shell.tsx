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
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useState } from "react";

const navigation = [
  { href: "/", label: "한눈에 보기", icon: LayoutDashboard },
  { href: "/studio", label: "사업계획서 스튜디오", icon: Sparkles },
  { href: "/companies", label: "확인기업 탐색", icon: Building2 },
  { href: "/application", label: "우리 기업 신청 준비", icon: ClipboardCheck },
];
function Brand() {
  return (
    <Link href="/" className="flex items-center gap-3" aria-label="벤처패스 홈">
      <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-white shadow-sm">
        <Sprout className="size-6" />
      </span>
      <span>
        <span className="block text-[21px] font-extrabold tracking-tight text-foreground">
          벤처패스
        </span>
        <span className="block text-[10px] font-semibold tracking-[.13em] text-muted-foreground">
          VENTURE PASS
        </span>
      </span>
    </Link>
  );
}
function Navigation({ close }: { close?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="주 메뉴" className="space-y-2">
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
          <Icon className="size-[19px]" />
          {label}
          {pathname === href && <span className="ml-auto size-1.5 rounded-full bg-primary" />}
        </Link>
      ))}
    </nav>
  );
}
export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen">
      <a
        href="#main-content"
        className="sr-only fixed left-4 top-4 z-50 rounded bg-white px-4 py-2 focus:not-sr-only"
      >
        본문으로 이동
      </a>
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
        <main id="main-content" className="mx-auto max-w-[1510px] px-5 py-8 sm:px-9 sm:py-10">
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
