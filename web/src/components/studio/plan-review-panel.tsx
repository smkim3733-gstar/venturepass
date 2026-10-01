"use client";

import { CircleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { groupPlanReviewFindings } from "@/lib/studio-plan-editorial";
import type { BusinessPlan } from "@/lib/studio-schema";

export function PlanReviewPanel({
  plan,
  onSection,
}: {
  plan: BusinessPlan;
  onSection: (key: string) => void;
}) {
  const groups = groupPlanReviewFindings(plan.review);
  return (
    <section className="rounded-2xl border bg-muted/25 p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-bold">
        <CircleAlert className="size-4 text-primary" />
        검토 의견 <Badge variant="secondary">{plan.review.length}</Badge>
      </h3>
      <p className="mb-4 text-xs leading-6 text-muted-foreground">
        저장된 버전을 기준으로 표시합니다. 내용이 같은 의견은 묶어 보여주며, 개별 의견의 검토 판단은
        아래에서 기록합니다. 수정 후 저장하면 다시 검토합니다.
      </p>
      {plan.review.length === 0 ? (
        <p className="text-xs leading-6 text-muted-foreground">
          자동 점검에서 표시할 의견이 없습니다. 사실과 증빙은 직접 확인해 주세요.
        </p>
      ) : (
        <div className="max-h-[560px] space-y-3 overflow-y-auto pr-1">
          {groups.map(({ finding, indices }) => (
            <div key={indices[0]} className="rounded-xl border bg-white p-3">
              <p className="mb-2 text-xs font-bold leading-5 text-primary">
                {plan.content.sections.find((section) => section.key === finding.sectionKey)
                  ?.title || "사업계획서 전체"}
              </p>
              <Badge
                variant="outline"
                className={
                  finding.severity === "error"
                    ? "border-red-200 text-red-700"
                    : finding.severity === "warning"
                      ? "border-amber-200 text-amber-800"
                      : "text-muted-foreground"
                }
              >
                {finding.severity === "error"
                  ? "수정 필요"
                  : finding.severity === "warning"
                    ? "확인 필요"
                    : "참고"}
              </Badge>
              <p className="mt-2 text-xs font-semibold leading-6">{finding.message}</p>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">{finding.action}</p>
              {indices.length > 1 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {`동일 의견 ${indices.length}건 · 원본 ${indices.map((index) => index + 1).join(", ")}번`}
                </p>
              )}
              {finding.sectionKey && (
                <button
                  type="button"
                  className="mt-2 text-xs font-semibold text-primary hover:underline"
                  onClick={() => onSection(finding.sectionKey!)}
                >
                  해당 항목 보기 →
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
