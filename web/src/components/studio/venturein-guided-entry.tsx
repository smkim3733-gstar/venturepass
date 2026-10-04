"use client";
import { useEffect, useRef, type RefObject } from "react";
import type { StudioCase } from "@/lib/studio-schema";
import type { VentureConnectionStatus } from "@/lib/venturein-schema";
import type { VentureWorkflowStatus } from "@/lib/venturein-workflow";
import type { VentureOverview } from "@/lib/venturein-overview-types";
import { resolveVentureGuidedNavigation } from "@/lib/venturein-guided-navigation";
import { formatDate } from "./shared";

export function VentureinGuidedEntry({
  target,
  company,
  connection,
  workflow,
  root,
}: {
  target: VentureOverview;
  company: StudioCase;
  connection: VentureConnectionStatus;
  workflow: VentureWorkflowStatus;
  root: RefObject<HTMLDivElement | null>;
}) {
  const result = resolveVentureGuidedNavigation(target, company, connection, workflow);
  const section = result.valid ? result.section : null;
  const focused = useRef(false);
  const notice = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused.current) return;
    const destination = section
      ? root.current?.querySelector<HTMLElement>(`[data-venture-section="${section}"]`)
      : notice.current;
    if (!destination) return;
    focused.current = true;
    destination.focus({ preventScroll: true });
    destination.scrollIntoView({ block: "start", behavior: "instant" });
  }, [root, section]);
  return (
    <section
      ref={notice}
      tabIndex={-1}
      aria-label="간단 화면에서 이어가기"
      className="rounded-xl border bg-muted/30 p-4 text-sm leading-6"
    >
      {result.valid ? (
        <>
          <p className="font-semibold">이어서 확인할 부분: {result.label}</p>
          <p className="break-words">
            기업: {company.profile.companyName} · 계정:{" "}
            {connection.account.saved ? connection.account.maskedLoginId || "저장됨" : "미등록"}
          </p>
          <p>
            보관 화면 관측:{" "}
            {workflow.snapshot ? formatDate(workflow.snapshot.screen.observedAt) : "기록 없음"}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            보관 기록을 대조해 해당 영역으로 이동했습니다. 로그인·화면 다시 읽기·입력·첨부는
            실행하지 않았습니다. 아래 원고·파일과 별도 동의를 확인해 주세요.
          </p>
        </>
      ) : (
        <p role="alert">{result.reason}</p>
      )}
    </section>
  );
}
