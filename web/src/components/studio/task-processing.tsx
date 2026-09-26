"use client";

import { useId } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  resolveTaskPlanReference,
  taskProcessingStageLabels,
  taskProcessingStages,
  type TaskProcessing,
  type TaskProcessingPlan,
} from "@/lib/studio-task-processing-types";
import { selectClass } from "./shared";

const explanation =
  "담당자가 기록한 내부 처리 단계입니다. 기관 송수신·법적 검토·원고 검토 완료를 뜻하지 않으며, 업무의 진행 필요·완료 표시는 별도로 관리합니다.";

export function TaskProcessingEditor({
  processing,
  plans,
  onChange,
}: {
  processing: TaskProcessing | undefined;
  plans: readonly TaskProcessingPlan[];
  onChange: (processing: TaskProcessing) => void;
}) {
  const id = useId();
  const stageId = `${id}-stage`;
  function updateReference(index: number, change: Partial<TaskProcessing["planRefs"][number]>) {
    if (!processing) return;
    onChange({
      ...processing,
      planRefs: processing.planRefs.map((reference, i) =>
        i === index ? { ...reference, ...change } : reference,
      ),
    });
  }
  return (
    <fieldset className="mt-5 space-y-4 rounded-xl border p-4">
      <legend className="px-1 text-sm font-semibold">내부 처리 단계·원고 연결 (선택)</legend>
      <div className="space-y-2">
        <Label htmlFor={stageId}>담당자 기록 단계</Label>
        <select
          id={stageId}
          className={selectClass}
          value={processing?.stage ?? ""}
          onChange={(event) => {
            const stage = event.target.value as TaskProcessing["stage"];
            if (!taskProcessingStages.includes(stage)) return;
            onChange({ stage, planRefs: processing?.planRefs ?? [] });
          }}
        >
          <option value="" disabled>
            미지정 · 단계를 선택해 주세요
          </option>
          {taskProcessingStages.map((stage) => (
            <option key={stage} value={stage}>
              {taskProcessingStageLabels[stage]}
            </option>
          ))}
        </select>
        <p className="text-xs leading-6 text-muted-foreground">{explanation}</p>
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h5 className="text-sm font-semibold">연결한 작성본·항목·정확한 인용</h5>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!processing || !plans.length || processing.planRefs.length >= 10}
            onClick={() => {
              if (!processing || !plans.length || processing.planRefs.length >= 10) return;
              onChange({
                ...processing,
                planRefs: [...processing.planRefs, { planId: "", sectionKey: "", quote: "" }],
              });
            }}
          >
            <Plus /> 원고 항목 연결 추가
          </Button>
        </div>
        <p className="text-xs leading-6 text-muted-foreground">
          최대 10개. 해당 기업의 저장된 원고에서 버전과 항목을 고른 뒤 필요한 문장을 그대로
          인용하세요. 이전 작성본도 연결할 수 있으며 새 버전으로 자동 변경되지 않습니다. 작성본이나
          항목을 바꾸면 해당 인용은 초기화됩니다.
        </p>
        {!plans.length && (
          <p className="text-xs text-muted-foreground">저장된 작성본이 없습니다.</p>
        )}
        {(processing?.planRefs ?? []).map((reference, index) => {
          const matchingPlans = plans.filter((plan) => plan.id === reference.planId);
          const selected = matchingPlans.length === 1 ? matchingPlans[0] : undefined;
          const sections =
            selected?.content.sections.filter((section) => section.key === reference.sectionKey) ??
            [];
          const section = sections.length === 1 ? sections[0] : undefined;
          const resolved = resolveTaskPlanReference(plans, reference);
          const prefix = `${id}-reference-${index}`;
          function confirmClear() {
            return (
              !reference.quote || window.confirm("작성 중인 인용을 비우고 연결 대상을 바꿀까요?")
            );
          }
          return (
            <div key={index} className="space-y-3 rounded-lg border bg-white p-3">
              <div className="flex items-center justify-between">
                <h6 className="text-xs font-semibold">원고 연결 {index + 1}</h6>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`원고 연결 ${index + 1} 제거`}
                  onClick={() => {
                    if (processing)
                      onChange({
                        ...processing,
                        planRefs: processing.planRefs.filter((_, i) => i !== index),
                      });
                  }}
                >
                  <X /> 연결 제거
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`${prefix}-plan`}>작성본 버전</Label>
                  <select
                    id={`${prefix}-plan`}
                    className={selectClass}
                    value={reference.planId}
                    onChange={(event) => {
                      if (confirmClear())
                        updateReference(index, {
                          planId: event.target.value,
                          sectionKey: "",
                          quote: "",
                        });
                    }}
                  >
                    <option value="">작성본 선택</option>
                    {reference.planId && !selected && (
                      <option value={reference.planId}>연결 작성본 확인 필요</option>
                    )}
                    {[...plans].reverse().map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        v{plan.version} · {plan.content.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${prefix}-section`}>연결 항목</Label>
                  <select
                    id={`${prefix}-section`}
                    className={selectClass}
                    value={reference.sectionKey}
                    disabled={!selected}
                    onChange={(event) => {
                      if (confirmClear())
                        updateReference(index, { sectionKey: event.target.value, quote: "" });
                    }}
                  >
                    <option value="">항목 선택</option>
                    {reference.sectionKey && !section && (
                      <option value={reference.sectionKey}>연결 항목 확인 필요</option>
                    )}
                    {selected?.content.sections.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {section && (
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-xs font-semibold">
                    선택한 원고 항목 읽기
                  </summary>
                  <p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">
                    {section.content}
                  </p>
                </details>
              )}
              <div className="space-y-2">
                <Label htmlFor={`${prefix}-quote`}>해당 항목의 정확한 인용</Label>
                <Textarea
                  id={`${prefix}-quote`}
                  maxLength={1500}
                  value={reference.quote}
                  onChange={(event) => updateReference(index, { quote: event.target.value })}
                  placeholder="위 작성본 항목에 실제로 있는 문장을 입력하세요."
                />
              </div>
              {resolved.state !== "matched" ? (
                <p role="status" className="text-xs leading-6 text-amber-800">
                  작성본·항목·인용을 확인해 주세요. 선택한 원고에 정확히 포함된 인용만 저장할 수
                  있습니다.
                </p>
              ) : (
                <p className="text-xs leading-6 text-muted-foreground">
                  선택한 v{resolved.plan.version} 항목에 인용이 있습니다. 사실·근거 검토 완료를
                  뜻하지 않습니다.
                  {!resolved.latest && " 현재 최신 버전과 다른 작성본입니다."}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

export function TaskProcessingSummary({
  processing,
  plans,
}: {
  processing: TaskProcessing | undefined;
  plans: readonly TaskProcessingPlan[];
}) {
  return (
    <div className="mt-3 space-y-2 rounded-lg border p-3 text-xs leading-6">
      <p className="font-semibold">
        내부 처리 단계: {processing ? taskProcessingStageLabels[processing.stage] : "미지정"}
      </p>
      <p className="text-muted-foreground">{explanation}</p>
      {processing?.planRefs.map((reference, index) => {
        const resolved = resolveTaskPlanReference(plans, reference);
        return (
          <details key={index} className="border-t pt-2">
            <summary className="cursor-pointer font-medium">
              {resolved.state === "matched"
                ? `작성본 v${resolved.plan.version} · ${resolved.section.title}`
                : `원고 연결 ${index + 1} · 확인 필요`}
            </summary>
            <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 pl-3">
              {reference.quote}
            </blockquote>
            {resolved.state === "matched" ? (
              <p className="mt-1 text-muted-foreground">
                저장된 작성본의 인용입니다. 인용 연결은 사실 검토나 기관 제출 확인이 아닙니다.
                {!resolved.latest && " 현재 최신 버전과 다른 작성본을 연결했습니다."}
              </p>
            ) : (
              <p className="mt-1 text-amber-800">
                연결한 작성본·항목·인용을 확인할 수 없습니다. 다른 원고로 대체하지 않습니다.
              </p>
            )}
          </details>
        );
      })}
    </div>
  );
}
