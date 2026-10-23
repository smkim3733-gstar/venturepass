"use client";

import { useEffect, useRef, useState } from "react";
import type { BusinessPlan, StudioCase } from "@/lib/studio-schema";
import { planClaimSummary, planClaimStatusLabels } from "@/lib/studio-plan-claim-summary";
import { ClaimReviewRecordView } from "./claim-reviews";
import { Button } from "@/components/ui/button";

type PlanClaimSummaryProps = {
  company: StudioCase;
  plan: BusinessPlan;
  blocked?: boolean;
};

export function PlanClaimSummary(props: PlanClaimSummaryProps) {
  return (
    <PlanClaimSummaryView
      key={JSON.stringify([
        props.company.id,
        props.company.revision,
        props.plan.id,
        props.plan.version,
      ])}
      {...props}
    />
  );
}

function PlanClaimSummaryView({ company, plan, blocked = false }: PlanClaimSummaryProps) {
  const summary = planClaimSummary(company, plan.id, plan.version);
  const identity = JSON.stringify([company.id, company.revision, plan.id, plan.version]);
  const [selection, setSelection] = useState<{ identity: string; id: string } | null>(null);
  const detail = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const selected =
    selection?.identity === identity
      ? summary.entries.find((entry) => entry.record.id === selection.id)
      : undefined;
  const selectedId = selected?.record.id;
  useEffect(() => {
    if (!selectedId) return;
    detail.current?.focus({ preventScroll: true });
    detail.current?.scrollIntoView({ block: "nearest" });
  }, [identity, selectedId]);
  return (
    <section
      aria-label="원고별 주장 검토 요약"
      className="min-w-0 space-y-3 rounded-2xl border bg-muted/20 p-4 [overflow-wrap:anywhere]"
    >
      <h3 className="text-sm font-bold">원고 v{plan.version}의 주장 검토 기록</h3>
      <p className="text-xs leading-6 text-muted-foreground">
        이 저장 원고에 연결한 주장별 마지막 기록입니다. 미저장 수정과 기록하지 않은 문장은 포함하지
        않습니다. 담당자 판단·등록 정보 대조이며 원본 파일 재검사나 자동 사실 검증 결과가 아닙니다.
      </p>
      {!summary.available ? (
        <p role="status">원고 버전을 고유하게 찾을 수 없어 요약하지 않았습니다.</p>
      ) : (
        <>
          {summary.entries.length === 0 && summary.ambiguous === 0 ? (
            <p className="text-sm">
              이 원고에 연결된 주장 검토가 없습니다. 확인할 내용이 없다는 뜻은 아닙니다.
            </p>
          ) : (
            <>
              <p className="text-sm" aria-label="주장 검토 상태별 개수">
                {Object.entries(summary.counts)
                  .filter(([, count]) => count > 0)
                  .map(
                    ([status, count]) =>
                      `${planClaimStatusLabels[status as keyof typeof planClaimStatusLabels]} ${count}건`,
                  )
                  .join(" · ")}
              </p>
              {summary.ambiguous > 0 && (
                <p role="status" className="text-sm text-amber-900">
                  기록 버전을 고유하게 고를 수 없는 주장 {summary.ambiguous}건은 요약에서
                  제외했습니다. 전체 기록을 확인해 주세요.
                </p>
              )}
              <ul className="max-h-80 space-y-3 overflow-y-auto">
                {summary.entries.map((entry) => (
                  <li
                    key={entry.record.id}
                    className="space-y-1 rounded-xl border bg-white p-3 text-xs leading-6"
                  >
                    <p className="font-semibold">{planClaimStatusLabels[entry.status]}</p>
                    <p className="whitespace-pre-wrap">{entry.record.claimQuote}</p>
                    <p>
                      확인 담당자: {entry.record.owner || "미지정"} · 기한:{" "}
                      {entry.record.dueOn || "미기록"}
                    </p>
                    <p className="whitespace-pre-wrap">
                      다음 확인: {entry.record.nextCheck || "미기록"}
                    </p>
                    {entry.laterElsewhere && (
                      <p>
                        다른 원고에 후속 기록이 있습니다. 여기서는 이 원고에 남긴 당시 기록을
                        표시합니다.
                      </p>
                    )}
                    {entry.issues.map((issue) => (
                      <p key={issue} className="text-amber-900">
                        {issue}
                      </p>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={blocked}
                      aria-expanded={selected?.record.id === entry.record.id}
                      onClick={(event) => {
                        trigger.current = event.currentTarget;
                        setSelection({ identity, id: entry.record.id });
                      }}
                    >
                      이 주장 기록 보기 · v{entry.record.version}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {selected && (
        <div
          key={`${identity}:${selected.record.id}`}
          tabIndex={-1}
          aria-label="선택한 주장 검토 기록"
          className="min-w-0 space-y-2"
          ref={detail}
        >
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setSelection(null);
              trigger.current?.focus();
            }}
          >
            주장 기록 접기
          </Button>
          <ClaimReviewRecordView company={company} record={selected.record} anchor={false} />
        </div>
      )}
    </section>
  );
}
