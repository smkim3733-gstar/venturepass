"use client";

import { useSyncExternalStore } from "react";
import { Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { caseAttentionAt } from "@/lib/studio-case-summary";
import { stageLabels, type CaseSummary } from "@/lib/studio-schema";
import { formatDate } from "./shared";

export type CaseAttentionFilter = "all" | "overdue" | "due-soon" | "attention";
export type CaseAttentionSort = "due-date" | "recent";
export type CaseAttentionTab =
  "profile" | "sources" | "diagnosis" | "analysis" | "plan" | "workflow";

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function subscribeLocalDay(changed: () => void) {
  const timer = window.setInterval(changed, 60_000);
  return () => window.clearInterval(timer);
}
const unknownServerDay = () => "";
export function useLocalDay() {
  return useSyncExternalStore(subscribeLocalDay, localDay, unknownServerDay);
}

export function selectCaseSummaries(
  cases: CaseSummary[],
  options: {
    query: string;
    filter: CaseAttentionFilter;
    sort: CaseAttentionSort;
    today: string;
  },
) {
  const query = options.query.trim().toLocaleLowerCase("ko");
  return cases
    .filter((item) => {
      if (!`${item.companyName} ${item.industry}`.toLocaleLowerCase("ko").includes(query))
        return false;
      const attention = caseAttentionAt(item, options.today);
      switch (options.filter) {
        case "overdue":
          return attention.overdue > 0;
        case "due-soon":
          return attention.dueSoon > 0;
        case "attention":
          return attention.needsAttention || !item.attention;
        default:
          return true;
      }
    })
    .sort((left, right) => {
      if (options.sort === "due-date") {
        const a = caseAttentionAt(left, options.today).nextDueDate ?? "9999-99-99";
        const b = caseAttentionAt(right, options.today).nextDueDate ?? "9999-99-99";
        const due = a.localeCompare(b);
        if (due) return due;
      }
      return (
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.companyName.localeCompare(right.companyName, "ko") ||
        left.id.localeCompare(right.id)
      );
    });
}

export function caseAttentionActions(
  item: CaseSummary,
): { tab: CaseAttentionTab; label: string }[] {
  const attention = item.attention;
  if (!attention) return [{ tab: "workflow", label: "상세 현황 확인" }];
  const actions = new Map<CaseAttentionTab, string>();
  if (item.pendingTaskCount || attention.requestsWithoutSentResponse)
    actions.set("workflow", "업무·기관 요청");
  if (
    attention.certificate &&
    (attention.certificate.recordedUntilDates.length ||
      attention.certificate.missingUntilCount ||
      attention.certificate.needsPreparationCount ||
      attention.certificate.changedTaskCount)
  )
    actions.set("workflow", "확인서·차기 준비");
  if (attention.pendingSourceCount) actions.set("sources", "자료 본문 확인");
  if (attention.diagnosisState !== "current")
    actions.set(
      "diagnosis",
      attention.diagnosisState === "stale" ? "사전진단 갱신" : "사전진단 시작",
    );
  if (attention.unconfirmedSectionCount || item.planCount) actions.set("plan", "원고·검토 의견");
  if (attention.preparationState === "awaiting_choice") actions.set("analysis", "신청 아이템 선택");
  if (attention.preparationState === "awaiting_materials") actions.set("profile", "기술정보 보강");
  if (
    ["failed", "blocked", "stale", "running"].includes(attention.preparationState) &&
    !actions.has("diagnosis")
  )
    actions.set("diagnosis", "로컬 준비 상태 확인");
  return [...actions].map(([tab, label]) => ({ tab, label }));
}

const preparationLabels = {
  not_started: "로컬 준비 전",
  stale: "자료 변경 · 준비 상태 재확인",
  running: "로컬 준비 진행 기록 확인",
  awaiting_choice: "신청 아이템 선택 필요",
  awaiting_materials: "기술 설명·자료 보강 필요",
  awaiting_review: "원고·점검 결과 준비됨",
  blocked: "로컬 준비 보류",
  failed: "로컬 준비 중단 확인",
};
export function CaseAttentionCard({
  item,
  today,
  busy,
  onOpen,
}: {
  item: CaseSummary;
  today: string;
  busy: boolean;
  onOpen: (tab: CaseAttentionTab) => void;
}) {
  const current = caseAttentionAt(item, today);
  const attention = item.attention;
  return (
    <article className="space-y-4 rounded-2xl border bg-white p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/7 text-primary">
          <Building2 className="size-5" />
        </span>
        <Badge variant="outline" className="font-normal">
          {stageLabels[item.stage]}
        </Badge>
      </div>
      <div>
        <h3>
          <button
            type="button"
            disabled={busy}
            onClick={() => onOpen("profile")}
            className="text-left text-lg font-bold hover:text-primary hover:underline disabled:opacity-60"
          >
            {item.companyName}
          </button>
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">{item.industry || "업종 미입력"}</p>
      </div>
      <div className="grid grid-cols-3 divide-x rounded-xl bg-muted/40 py-3">
        {[
          ["자료", item.sourceCount],
          ["작성 버전", item.planCount],
          ["할 일", item.pendingTaskCount],
        ].map(([label, count]) => (
          <div key={label} className="text-center">
            <p className="text-base font-bold">{count}</p>
            <p className="mt-1 text-[10px] text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>
      <div className="space-y-2 text-xs leading-6">
        <div className="flex flex-wrap gap-2">
          {current.overdue > 0 && (
            <Badge variant="outline" className="border-red-200 bg-red-50 text-red-800">
              기한 경과 {current.overdue}건
            </Badge>
          )}
          {current.dueSoon > 0 && (
            <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-900">
              오늘~7일 내 {current.dueSoon}건
            </Badge>
          )}
          {current.needsAttention && <Badge variant="outline">확인 필요</Badge>}
        </div>
        {attention ? (
          <>
            <p>가장 이른 미완료 업무 기한: {current.nextDueDate || "기재된 기한 없음"}</p>
            {attention.undatedTaskCount > 0 && (
              <p>기한 미기재 업무 {attention.undatedTaskCount}건</p>
            )}
            {attention.pendingSourceCount > 0 && (
              <p>본문 미확인 원본 {attention.pendingSourceCount}건</p>
            )}
            {attention.unconfirmedSectionCount > 0 && (
              <p>최신 원고의 미확인 항목 {attention.unconfirmedSectionCount}개</p>
            )}
            {attention.planReviewRequired && <p>최신 원고의 내부 검토 확인 필요</p>}
            <p>
              사전진단:{" "}
              {attention.diagnosisState === "not_run"
                ? "아직 실행하지 않음"
                : attention.diagnosisState === "stale"
                  ? "자료·기준 변경으로 재확인 필요"
                  : "현재 자료 기준 결과 있음"}
            </p>
            <p>준비 기록: {preparationLabels[attention.preparationState]}</p>
            {attention.requestsWithoutSentResponse > 0 && (
              <p>요청 답변 발송 표시 확인 {attention.requestsWithoutSentResponse}건</p>
            )}
            {attention.certificate && (
              <>
                {!!attention.certificate.recordedUntilDates.length && (
                  <p>
                    가장 이른 기재 유효종료일: {attention.certificate.recordedUntilDates[0]} ·
                    종료일 기재 통보 {attention.certificate.recordedUntilDates.length}건 · 현재 효력
                    미확인
                  </p>
                )}
                {attention.certificate.missingUntilCount > 0 && (
                  <p>유효종료일 미기재 통보 {attention.certificate.missingUntilCount}건</p>
                )}
                {attention.certificate.needsPreparationCount > 0 && (
                  <p>
                    차기 준비 업무·날짜 확인 필요 {attention.certificate.needsPreparationCount}건
                  </p>
                )}
                {attention.certificate.changedTaskCount > 0 && (
                  <p>
                    확인서 통보 변경·연결 재확인 업무 {attention.certificate.changedTaskCount}건
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <p>상세 현황이 없는 이전 응답입니다. 기업을 열어 최신 상태를 확인해 주세요.</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {caseAttentionActions(item).map((action) => (
          <Button
            variant="outline"
            size="sm"
            key={action.tab}
            disabled={busy}
            onClick={() => onOpen(action.tab)}
          >
            {action.label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{formatDate(item.updatedAt)} 수정</p>
    </article>
  );
}
