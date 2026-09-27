"use client";

import { useEffect, type ReactNode } from "react";
import { FileSearch, Info, LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { CaseMutation, StudioCase } from "@/lib/studio-schema";

export type StudioMutation = CaseMutation extends infer M
  ? M extends CaseMutation
    ? Omit<M, "revision">
    : never
  : never;
export type PanelProps = {
  company: StudioCase;
  mutate: (mutation: StudioMutation) => Promise<StudioCase | null>;
  setDirty: (dirty: boolean) => void;
};
export const selectClass =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50";
export const fieldClass = "space-y-2";
export function useDirty(dirty: boolean, setDirty: (value: boolean) => void) {
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);
}
export function PanelHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        )}
      </div>
      {actions}
    </div>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning";
}) {
  return (
    <div
      className={`flex gap-3 rounded-xl border p-4 text-sm leading-6 ${tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-950" : "border-primary/15 bg-primary/5 text-foreground"}`}
    >
      <Info className="mt-1 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
export function EmptyPanel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed bg-muted/25 px-5 py-14 text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <FileSearch className="size-6" />
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{description}</p>
      {children && <div className="mt-5 flex justify-center">{children}</div>}
    </div>
  );
}
export function Loading({ text = "불러오는 중입니다" }: { text?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" />
      {text}
    </div>
  );
}
export function ModeBadge({ mode }: { mode: "ai" | "assisted" | "manual" }) {
  return (
    <Badge
      variant="outline"
      className={mode === "ai" ? "border-primary/20 bg-primary/5 text-primary" : "bg-muted/70"}
    >
      {mode === "ai" ? "AI 작성" : mode === "assisted" ? "자료 기반 정리본" : "직접 편집"}
    </Badge>
  );
}
export function formatDate(value: string) {
  return new Date(value).toLocaleString("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export async function studioFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response
    .json()
    .catch(() => ({ error: "서버 응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." }));
  if (!response.ok)
    throw new StudioApiError(
      body.error || "요청을 처리하지 못했습니다.",
      response.status,
      typeof body.code === "string" && /^[A-Z0-9_]{1,100}$/.test(body.code) ? body.code : undefined,
    );
  return body as T;
}
export class StudioApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export function jsonBody(value: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}
