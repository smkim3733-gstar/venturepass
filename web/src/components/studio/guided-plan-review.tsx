"use client";

import type { BusinessPlan, StudioCase } from "@/lib/studio-schema";
import { Button } from "@/components/ui/button";
import { PlanReviewDecisions } from "./plan-review-decisions";
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
