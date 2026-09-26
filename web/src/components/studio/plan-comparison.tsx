"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { StudioCase } from "@/lib/studio-schema";
import {
  compareStoredPlans,
  compareTextExact,
  type PlanChangeState,
  type PlanComparisonItem,
  type StoredPlanComparison,
} from "@/lib/studio-plan-diff";
import { Notice, formatDate, selectClass } from "./shared";

const stateLabels: Record<PlanChangeState, string> = {
  same: "동일",
  added: "추가",
  removed: "삭제",
  changed: "변경",
  ambiguous: "연결 불명확",
  limited: "일부 비교 생략",
};
const groupLabels = { content: "본문·근거", context: "작성 맥락", review: "검토 정보" };
const statusMessages = {
  "not-selected": "비교할 두 저장 버전을 직접 선택해 주세요.",
  "same-version": "같은 버전을 선택했습니다. 서로 다른 두 저장 버전을 선택해 주세요.",
  missing: "선택한 원고를 현재 회사에서 찾지 못했습니다. 비교 대상을 다시 선택해 주세요.",
  ambiguous: "같은 원고 식별값이 중복되어 비교할 수 없습니다. 원고 기록을 확인해 주세요.",
};

export function PlanComparison({
  company,
  blockedReason = "",
}: {
  company: Pick<StudioCase, "id" | "revision" | "plans">;
  blockedReason?: string;
}) {
  // A changed company/revision or a new edit invalidates the explicit comparison selection.
  return (
    <ComparisonSelector
      key={`${company.id}:${company.revision}:${!!blockedReason}`}
      company={company}
      blockedReason={blockedReason}
    />
  );
}

function ComparisonSelector({
  company,
  blockedReason,
}: {
  company: Pick<StudioCase, "id" | "revision" | "plans">;
  blockedReason: string;
}) {
  const id = useId();
  const [leftPlanId, setLeft] = useState("");
  const [rightPlanId, setRight] = useState("");
  const [result, setResult] = useState<StoredPlanComparison | null>(null);
  const plans = [...company.plans].sort((a, b) => b.version - a.version);
  return (
    <section
      className="space-y-4 rounded-2xl border bg-white p-4 sm:p-5"
      aria-labelledby={`${id}-title`}
    >
      <div>
        <h3 id={`${id}-title`} className="text-sm font-bold">
          저장 원고 버전 비교
        </h3>
        <p className="mt-2 text-xs leading-6 text-muted-foreground">
          두 버전의 제목·본문·근거·확인 표시를 비교합니다. 원고 저장, 사실 검토나 기관 제출 상태는
          바뀌지 않습니다.
        </p>
      </div>
      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      {plans.length < 2 && (
        <p className="text-sm text-muted-foreground">
          저장 원고가 두 개 이상이면 비교할 수 있습니다.
        </p>
      )}
      <fieldset disabled={!!blockedReason || plans.length < 2} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ["left", "기준 버전 (왼쪽)", leftPlanId, setLeft],
              ["right", "대조 버전 (오른쪽)", rightPlanId, setRight],
            ] as const
          ).map(([side, label, value, setValue]) => (
            <div key={side} className="space-y-2">
              <label htmlFor={`${id}-${side}`} className="text-xs font-semibold">
                {label}
              </label>
              <select
                id={`${id}-${side}`}
                className={selectClass}
                value={value}
                onChange={(event) => {
                  if (blockedReason) return;
                  setValue(event.target.value);
                  setResult(null);
                }}
              >
                <option value="">저장 버전 직접 선택</option>
                {plans.map((plan, index) => (
                  <option key={`${plan.id}:${index}`} value={plan.id}>
                    v{plan.version} · {formatDate(plan.generatedAt)} · {plan.content.title}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!leftPlanId || !rightPlanId}
          onClick={() => {
            if (!blockedReason)
              setResult(compareStoredPlans(company.plans, { leftPlanId, rightPlanId }));
          }}
        >
          선택한 두 버전 비교
        </Button>
      </fieldset>
      {!blockedReason &&
        (result ? (
          <PlanComparisonResult result={result} />
        ) : (
          <p className="text-xs text-muted-foreground">
            비교할 두 저장 버전을 직접 선택해 주세요. 최신 버전을 자동 선택하지 않습니다.
          </p>
        ))}
    </section>
  );
}

export function PlanComparisonResult({ result }: { result: StoredPlanComparison }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (result.status !== "ready" || !result.left || !result.right)
    return (
      <Notice tone="warning">
        {statusMessages[result.status === "ready" ? "missing" : result.status]}
      </Notice>
    );
  const changes = result.items.filter(
    (item) => item.group === "content" && item.state !== "same",
  ).length;
  const leftLabel = `기준 v${result.left.version}`;
  const rightLabel = `대조 v${result.right.version}`;
  return (
    <div className="space-y-4" aria-live="polite">
      <p className="text-sm font-semibold">
        {leftLabel} → {rightLabel} · 본문·근거의 변경 또는 확인 필요 항목 {changes}개
      </p>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <p>
          {leftLabel} 작성: {formatDate(result.left.generatedAt)}
        </p>
        <p>
          {rightLabel} 작성: {formatDate(result.right.generatedAt)}
        </p>
      </div>
      {!result.complete && (
        <Notice tone="warning">
          일부 항목은 중복 또는 표시 한도로 비교하지 못했습니다. 전체 비교 완료가 아닙니다. 생략한
          범위는 원고 화면에서 해당 버전을 선택해 확인해 주세요.
        </Notice>
      )}
      {result.warnings.map((warning, index) => (
        <Notice key={index} tone="warning">
          {warning}
        </Notice>
      ))}
      <p className="text-xs leading-6 text-muted-foreground">
        검토 정보는 현재 저장된 각 버전의 메타데이터입니다. 제출 당시 기록은 신청 회차 이력에서
        확인하세요. 확인 표시의 변화만으로 사실·수치·기관 승인이 확인되지는 않습니다. 실사 질문은
        준비용 질문입니다.
      </p>
      <div className="divide-y rounded-xl border">
        {result.items.map((item) => (
          <div key={item.key} className="p-3">
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-2 text-left text-sm"
              aria-expanded={expanded === item.key}
              onClick={() => setExpanded(expanded === item.key ? null : item.key)}
            >
              <span className="font-medium">{item.title}</span>
              <Badge variant="outline">
                {item.orderOnly ? "순서 변경" : stateLabels[item.state]}
              </Badge>
              <span className="ml-auto text-xs text-muted-foreground">
                {groupLabels[item.group]} · {expanded === item.key ? "접기" : "원문 보기"}
              </span>
            </button>
            {expanded === item.key && (
              <PlanComparisonDetail item={item} leftLabel={leftLabel} rightLabel={rightLabel} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PlanComparisonDetail({
  item,
  leftLabel,
  rightLabel,
}: {
  item: PlanComparisonItem;
  leftLabel: string;
  rightLabel: string;
}) {
  const diff =
    item.state === "limited" || item.state === "ambiguous"
      ? null
      : compareTextExact(item.left ?? "", item.right ?? "");
  return (
    <div className="mt-3 space-y-3 text-xs leading-6">
      {item.note && <Notice tone="warning">{item.note}</Notice>}
      <div className="grid gap-3 lg:grid-cols-2">
        {(
          [
            [leftLabel, item.left, item.leftLength],
            [rightLabel, item.right, item.rightLength],
          ] as const
        ).map(([label, value, length], index) => (
          <div key={index} className="min-w-0 rounded-lg bg-muted/30 p-3">
            <h4 className="font-semibold">{label}</h4>
            <p className="text-muted-foreground">
              원문 표시 값 {length.toLocaleString()}자
              {value !== null && value.length < length
                ? ` · 앞 ${value.length.toLocaleString()}자만 표시`
                : ""}
            </p>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans">
              {value === null ? "이 버전에 없음" : value || "(빈 값)"}
            </pre>
          </div>
        ))}
      </div>
      {diff?.complete && diff.state === "changed" && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 font-semibold">
            변경 조각 · <span className="text-red-800">− 기준에서 삭제</span> /{" "}
            <span className="text-emerald-800">+ 대조에서 추가</span>
          </p>
          {diff.mode === "block" && (
            <p className="mb-2 text-muted-foreground">
              긴 내용은 변경 블록으로 표시합니다. 문장 의미를 비교한 결과가 아닙니다.
            </p>
          )}
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans">
            {diff.spans.map((span, index) => (
              <span
                key={index}
                className={
                  span.kind === "added"
                    ? "bg-emerald-100 text-emerald-950"
                    : span.kind === "removed"
                      ? "bg-red-100 text-red-950"
                      : undefined
                }
              >
                {span.kind !== "same" && (
                  <span className="font-bold" aria-label={span.kind === "added" ? "추가" : "삭제"}>
                    {span.kind === "added" ? "[+] " : "[−] "}
                  </span>
                )}
                {span.text}
              </span>
            ))}
          </pre>
        </div>
      )}
      <p className="text-muted-foreground">
        원문은 공백·개행을 바꾸지 않고 비교합니다. 목록은 순서와 중복을 보존한 문자열 표기로
        보여줍니다.
      </p>
    </div>
  );
}
