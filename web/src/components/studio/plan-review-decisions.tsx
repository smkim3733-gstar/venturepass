"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { BusinessPlan, StudioCase } from "@/lib/studio-schema";
import {
  latestPlanReviewDecision,
  planReviewDecisionInputSchema,
  planReviewFindingSchema,
  planReviewLimits,
  planReviewStaleReasonLabels,
  planReviewStatusLabels,
  type PlanReviewDecisionInput,
} from "@/lib/studio-plan-review-types";
import { Notice, selectClass, useDirty, type PanelProps } from "./shared";

export function planReviewInputFor(
  company: StudioCase,
  plan: BusinessPlan,
  findingIndex: number,
): PlanReviewDecisionInput | null {
  const finding = planReviewFindingSchema.safeParse(plan.review[findingIndex]);
  if (!finding.success) return null;
  return {
    planId: plan.id,
    planVersion: plan.version,
    findingIndex,
    finding: finding.data,
    previousRecordId:
      latestPlanReviewDecision(company.planReviewDecisions ?? [], plan, findingIndex)?.id ?? null,
    status: "pending",
    reason: "",
    reviewer: "",
  };
}
export function planReviewSaveAcknowledged(
  saved: StudioCase | null,
  companyId: string,
  nonce: string,
  input: PlanReviewDecisionInput,
) {
  if (!saved || saved.id !== companyId) return false;
  const matches = saved.planReviewDecisions.filter((entry) => entry.clientRequestId === nonce);
  if (matches.length !== 1) return false;
  const record = matches[0];
  return (
    record.planId === input.planId &&
    record.planVersion === input.planVersion &&
    record.findingIndex === input.findingIndex &&
    record.previousRecordId === input.previousRecordId &&
    record.status === input.status &&
    record.reason === input.reason &&
    record.reviewer === input.reviewer &&
    JSON.stringify(record.finding) === JSON.stringify(input.finding)
  );
}
type Props = Pick<PanelProps, "company" | "mutate"> & {
  plan: BusinessPlan;
  blockedReason: string;
  onDirtyChange: (dirty: boolean) => void;
};
type Form = { input: PlanReviewDecisionInput; baseline: string; nonce: string; binding: string };

export function PlanReviewDecisions({
  company,
  plan,
  mutate,
  blockedReason,
  onDirtyChange,
}: Props) {
  const [selected, setSelected] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const binding = `${company.id}:${company.revision}:${plan.id}`;
  const context = useRef(binding);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    context.current = binding;
  }, [binding]);
  const dirty = !!form && JSON.stringify(form.input) !== form.baseline;
  useDirty(dirty || saving, onDirtyChange);
  const records = company.planReviewDecisions ?? [];
  const history = records.filter((entry) => entry.planId === plan.id);
  const atLimit = records.length >= planReviewLimits.records;
  const blocked = !!blockedReason || saving;
  function choose(value: string) {
    if (blocked || (dirty && !window.confirm("저장하지 않은 검토 판단 작성을 취소할까요?"))) return;
    const input = value === "" ? null : planReviewInputFor(company, plan, Number(value));
    setSelected(value);
    setError("");
    setForm(
      input
        ? { input, baseline: JSON.stringify(input), nonce: crypto.randomUUID(), binding }
        : null,
    );
  }
  function edit(input: PlanReviewDecisionInput) {
    if (form && !blocked) setForm({ ...form, input, nonce: crypto.randomUUID() });
  }
  async function save() {
    if (!form || blocked || atLimit || pending.current) return;
    if (form.binding !== binding) {
      setError("원고나 자료가 바뀌었습니다. 최신 검토 의견을 다시 선택해 주세요.");
      return;
    }
    const parsed = planReviewDecisionInputSchema.safeParse(form.input);
    if (!parsed.success) {
      setError("담당자와 판단 이유를 입력하고 검토 대상을 확인해 주세요.");
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await mutate({
        action: "append-plan-review",
        clientRequestId: form.nonce,
        decision: parsed.data,
      });
      if (mounted.current && context.current === binding) {
        if (planReviewSaveAcknowledged(saved, company.id, form.nonce, parsed.data)) {
          setForm(null);
          setSelected("");
        } else
          setError(
            "저장 결과를 확인하지 못했습니다. 작성 내용을 유지했습니다. 최신 이력을 확인해 주세요.",
          );
      }
    } catch {
      if (mounted.current && context.current === binding)
        setError("저장하지 못했습니다. 같은 요청 번호와 작성 내용을 보존했습니다.");
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <section aria-label="검토 의견 처리 이력" className="space-y-4 rounded-2xl border p-5">
      <h3 className="font-bold">검토 의견 처리 이력</h3>
      <p className="text-sm text-muted-foreground">
        원고 v{plan.version}의 의견별 해결 판단·보류 사유를 담당자 이름과 함께 남깁니다.
      </p>
      <Notice>
        ‘담당자 해결 판단’은 수동 기록입니다. 원고의 오류·확인 필요 표시나 검토 완료 제한은 그대로
        유지됩니다. 수정은 원고의 새 버전으로 저장해 주세요.
      </Notice>
      {blockedReason && <p className="text-sm text-amber-900">{blockedReason}</p>}
      {atLimit && (
        <p className="text-sm text-amber-900">
          검토 판단 200개 한도에 도달했습니다. 이전 이력은 보존합니다.
        </p>
      )}
      {!plan.review.length ? (
        <p className="text-sm">
          현재 저장 원고에 표시된 검토 의견이 없습니다. 사실과 증빙은 별도로 확인해 주세요.
        </p>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="plan-review-finding">판단할 검토 의견 직접 선택</Label>
          <select
            id="plan-review-finding"
            className={selectClass}
            value={selected}
            disabled={blocked || atLimit}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">검토 의견 선택</option>
            {plan.review.map((finding, index) => (
              <option key={index} value={index}>
                {index + 1}. {finding.message}
              </option>
            ))}
          </select>
        </div>
      )}
      {form && (
        <fieldset disabled={blocked || atLimit} className="space-y-4 rounded-xl border p-4">
          <legend className="px-2 font-semibold">의견에 대한 담당자 판단</legend>
          <p className="whitespace-pre-wrap text-sm">{form.input.finding.message}</p>
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">
            권고된 조치: {form.input.finding.action}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="plan-review-status">처리 상태</Label>
              <select
                id="plan-review-status"
                className={selectClass}
                value={form.input.status}
                onChange={(event) =>
                  edit({
                    ...form.input,
                    status: event.target.value as PlanReviewDecisionInput["status"],
                  })
                }
              >
                {Object.entries(planReviewStatusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-review-reviewer">판단 담당자 *</Label>
              <Input
                id="plan-review-reviewer"
                value={form.input.reviewer}
                maxLength={100}
                onChange={(event) => edit({ ...form.input, reviewer: event.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="plan-review-reason">확인한 내용과 판단 이유 *</Label>
            <Textarea
              id="plan-review-reason"
              value={form.input.reason}
              maxLength={3000}
              onChange={(event) => edit({ ...form.input, reason: event.target.value })}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void save()}>
              검토 판단 이력 저장
            </Button>
            <Button type="button" variant="outline" onClick={() => choose("")}>
              검토 판단 편집 취소
            </Button>
          </div>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!history.length && (
        <p className="text-sm text-muted-foreground">이 원고에 기록한 담당자 판단이 없습니다.</p>
      )}
      {!!history.length && (
        <details className="rounded-xl border p-4" open>
          <summary className="cursor-pointer text-sm font-semibold">
            원고 v{plan.version}의 판단 이력 {history.length}개
          </summary>
          {[...history].reverse().map((record) => (
            <article key={record.id} className="mt-4 space-y-2 border-t pt-3 text-sm">
              <h4 className="font-semibold">
                {planReviewStatusLabels[record.status]} · 판단 v{record.version}
              </h4>
              <p className="whitespace-pre-wrap">
                대상 의견 {record.findingIndex + 1}: {record.finding.message}
              </p>
              <p className="whitespace-pre-wrap">판단 이유: {record.reason}</p>
              <p className="text-xs">
                {record.reviewer} · {record.recordedAt}
              </p>
              <p className="text-xs">
                현재 근거 연결: {record.stale ? "재검토 필요" : "저장 기준 유지"} · 원고 내용
                검증이나 확정 결과는 아닙니다.
              </p>
              {record.staleReasons.length > 0 && (
                <ul className="list-inside list-disc text-xs text-amber-900">
                  {record.staleReasons.map((reason) => (
                    <li key={reason}>{planReviewStaleReasonLabels[reason]}</li>
                  ))}
                </ul>
              )}
              <details>
                <summary className="cursor-pointer text-xs">저장 당시 검토 기준</summary>
                <p className="mt-2 whitespace-pre-wrap text-xs">
                  권고 조치: {record.finding.action}
                </p>
                <p className="break-all text-xs">원고 SHA-256: {record.planContentSha256}</p>
                <p className="break-all text-xs">의견 SHA-256: {record.findingSha256}</p>
                <p className="text-xs">
                  원고 기준 자료 버전 {record.planSourceRevision} · 판단 당시 자료 버전{" "}
                  {record.evidenceRevision}
                </p>
              </details>
            </article>
          ))}
        </details>
      )}
    </section>
  );
}
