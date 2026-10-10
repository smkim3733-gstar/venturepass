"use client";

import type { BusinessPlan, StudioCase } from "@/lib/studio-schema";
import { Button } from "@/components/ui/button";
import { PlanReviewDecisions } from "./plan-review-decisions";
import {
  latestPlanReviewDecision,
  planReviewStatusLabels,
  planReviewStaleReasonLabels,
} from "@/lib/studio-plan-review-types";
import type { StudioMutation } from "./shared";

export type GuidedReviewTarget = {
  companyId: string;
  plan: BusinessPlan;
  findingIndex?: number;
};

export function guidedReviewTargetCurrent(company: StudioCase, target: GuidedReviewTarget) {
  if (company.id !== target.companyId) return false;
  const latestVersion = Math.max(...company.plans.map((plan) => plan.version));
  const matches = company.plans.filter((plan) => plan.version === latestVersion);
  return matches.length === 1 && JSON.stringify(matches[0]) === JSON.stringify(target.plan);
}

export function GuidedPlanReview({
  company,
  target,
  busy,
  blocked,
  dirty,
  mutate,
  onDirtyChange,
  onClose,
}: {
  company: StudioCase;
  target: GuidedReviewTarget;
  busy: boolean;
  blocked: boolean;
  dirty: boolean;
  mutate: (mutation: StudioMutation) => Promise<StudioCase | null>;
  onDirtyChange: (value: boolean) => void;
  onClose: () => void;
}) {
  const current = guidedReviewTargetCurrent(company, target);
  return (
    <div className="space-y-4" aria-label="간단 원고 검토 판단">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">원고 v{target.plan.version} 검토 의견 확인</h2>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (
              !dirty ||
              window.confirm("저장하지 않은 검토 판단 작성을 취소하고 원고로 돌아갈까요?")
            )
              onClose();
          }}
        >
          원고로 돌아가기
        </Button>
      </div>
      <PlanReviewDecisions
        company={company}
        plan={target.plan}
        initialFindingIndex={current ? target.findingIndex : undefined}
        mutate={mutate}
        onDirtyChange={onDirtyChange}
        blockedReason={
          !current
            ? "현재 회사나 원고가 바뀌었습니다. 작성 내용은 유지했습니다. 원고로 돌아가 최신 의견을 선택해 주세요."
            : busy || blocked
              ? "진행 중인 작업이 끝난 뒤 검토 판단을 저장해 주세요."
              : ""
        }
      />
    </div>
  );
}

/** Read-only projection of this company's existing manual record. No confirmation or write. */
export function GuidedReviewDecisionSummary({
  company,
  plan,
  findingIndex,
}: {
  company: StudioCase;
  plan: BusinessPlan;
  findingIndex: number;
}) {
  const record = latestPlanReviewDecision(company.planReviewDecisions ?? [], plan, findingIndex);
  return (
    <div
      aria-label={`의견 ${findingIndex + 1}의 최근 담당자 판단`}
      className="mt-2 space-y-1 text-xs text-muted-foreground [overflow-wrap:anywhere]"
    >
      {record ? (
        <>
          <p>
            최근 수동 판단: {planReviewStatusLabels[record.status]} · {record.reviewer}
          </p>
          <p>현재 근거 연결: {record.stale ? "재검토 필요" : "저장 기준 유지"}</p>
          {record.staleReasons.length > 0 && (
            <ul className="list-inside list-disc text-amber-900">
              {record.staleReasons.map((reason) => (
                <li key={reason}>{planReviewStaleReasonLabels[reason]}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p>담당자 판단 미기록</p>
      )}
    </div>
  );
}

/** Opens only the unique section explicitly named by this stored review finding. */
export function GuidedReviewSectionEdit({
  company,
  plan,
  findingIndex,
  onEditSection,
  editBlockedReason = "",
}: {
  company: StudioCase;
  plan: BusinessPlan;
  findingIndex: number;
  onEditSection: (sectionKey: string) => void;
  editBlockedReason?: string;
}) {
  if (
    !Number.isInteger(findingIndex) ||
    findingIndex < 0 ||
    company.plans.filter((item) => item.id === plan.id).length !== 1 ||
    !guidedReviewTargetCurrent(company, { companyId: company.id, plan })
  )
    return null;
  const finding = plan.review[findingIndex];
  if (!finding) return null;
  const matches = finding.sectionKey
    ? plan.content.sections.filter((section) => section.key === finding.sectionKey)
    : [];
  if (matches.length !== 1)
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        연결된 항목을 특정할 수 없습니다. 전체 원고에서 확인해 주세요.
      </p>
    );
  const section = matches[0];
  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!!editBlockedReason}
        title={editBlockedReason || undefined}
        onClick={() => {
          if (!editBlockedReason) onEditSection(section.key);
        }}
      >
        연결된 원고 항목 고치기
        <span className="sr-only">
          {" "}
          · 의견 {findingIndex + 1}: {section.title}
        </span>
      </Button>
    </div>
  );
}
