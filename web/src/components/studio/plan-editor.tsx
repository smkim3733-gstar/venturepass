"use client";

import { useEffect, useState } from "react";
import { BadgeCheck, CircleAlert, Copy, Download, FileCheck2, Save, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { BusinessPlan, PlanContent, StudioCase } from "@/lib/studio-schema";
import { currentCandidateSelection } from "@/lib/studio-candidate-selection-types";
import { cn } from "@/lib/utils";
import {
  EmptyPanel,
  ModeBadge,
  Notice,
  PanelHeading,
  formatDate,
  selectClass,
  useDirty,
  type PanelProps,
} from "./shared";
import { EvidenceList } from "./evidence";
import { PackagePanel } from "./package-panel";
import { PlanComparison } from "./plan-comparison";
import { PlanReviewDecisions } from "./plan-review-decisions";
import { NumericChecks } from "./numeric-checks";
import { ClaimReviews } from "./claim-reviews";

export type PlanReviewTarget = {
  companyId: string;
  revision: number;
  planId: string;
  sectionKey: string | null;
  recordKind: string;
  recordId: string;
};
export function resolvePlanReviewTarget(company: StudioCase, target?: PlanReviewTarget) {
  if (!target) return null;
  const planMatches = company.plans.filter((item) => item.id === target.planId);
  const plan = planMatches.length === 1 ? planMatches[0] : null;
  const sections =
    target.sectionKey === null
      ? []
      : (plan?.content.sections.filter((item) => item.key === target.sectionKey) ?? []);
  const claims =
    target.recordKind === "claim"
      ? (company.claimReviews ?? []).filter(
          (item) =>
            item.id === target.recordId &&
            item.planId === target.planId &&
            item.sectionKey === target.sectionKey,
        )
      : null;
  const valid =
    target.companyId === company.id &&
    target.revision === company.revision &&
    !!plan &&
    (target.sectionKey === null || sections.length === 1) &&
    (!claims || claims.length === 1);
  return {
    valid,
    plan: valid ? plan : null,
    sectionKey: valid ? (target.sectionKey ?? "") : "",
    anchor: valid && claims ? `claim-review-${target.recordId}` : null,
  };
}

export function PlanEditor({
  company,
  mutate,
  setDirty,
  generate,
  goToAnalysis,
  onBusyChange,
  reviewTarget,
}: PanelProps & {
  generate: () => void;
  goToAnalysis: () => void;
  onBusyChange: (message: string) => void;
  reviewTarget?: PlanReviewTarget;
}) {
  const sortedPlans = [...company.plans].sort((a, b) => b.version - a.version);
  const [initialTarget] = useState(() => resolvePlanReviewTarget(company, reviewTarget));
  const [planId, setPlanId] = useState(
    initialTarget ? (initialTarget.plan?.id ?? "") : sortedPlans[0]?.id || "",
  );
  const planMatches = company.plans.filter((item) => item.id === planId);
  const plan = planMatches.length === 1 ? planMatches[0] : undefined;
  const [content, setContent] = useState<PlanContent | null>(
    plan ? structuredClone(plan.content) : null,
  );
  const [sectionKey, setSectionKey] = useState(
    initialTarget ? initialTarget.sectionKey : plan?.content.sections[0]?.key || "",
  );
  const [reviewDecisionDirty, setReviewDecisionDirty] = useState(false);
  const [numericDirty, setNumericDirty] = useState(false);
  const [claimDirty, setClaimDirty] = useState(false);
  const supportingEditDirty = reviewDecisionDirty || numericDirty || claimDirty;
  const contentDirty = !!plan && JSON.stringify(content) !== JSON.stringify(plan.content);
  const dirty = contentDirty || supportingEditDirty;
  const selection = currentCandidateSelection(company);
  useDirty(dirty, setDirty);
  useEffect(() => {
    if (!initialTarget?.anchor) return;
    const target = document.getElementById(initialTarget.anchor);
    if (!target) return;
    for (let parent = target.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    target.scrollIntoView({ block: "start" });
  }, [initialTarget]);
  const section = content?.sections.find((item) => item.key === sectionKey);
  function selectVersion(id: string) {
    if (supportingEditDirty) {
      toast.error("검토 판단·수치 대조·주장 근거 편집을 먼저 저장하거나 취소해 주세요.");
      return;
    }
    if (dirty && !window.confirm("저장하지 않은 수정을 취소하고 다른 버전을 볼까요?")) return;
    const matches = company.plans.filter((item) => item.id === id);
    const selected = matches.length === 1 ? matches[0] : undefined;
    if (!selected) return;
    setPlanId(id);
    setContent(structuredClone(selected.content));
    setSectionKey(selected.content.sections[0]?.key || "");
  }
  function changeSection(value: string) {
    if (supportingEditDirty) return;
    setContent((current) =>
      current
        ? {
            ...current,
            sections: current.sections.map((item) =>
              item.key === sectionKey ? { ...item, content: value, needsConfirmation: true } : item,
            ),
          }
        : current,
    );
  }
  async function save() {
    if (supportingEditDirty) {
      toast.error("검토 판단·수치 대조·주장 근거 편집을 먼저 저장하거나 취소해 주세요.");
      return;
    }
    if (plan && content) await mutate({ action: "save-plan", planId: plan.id, content });
  }
  async function copySection() {
    if (!section) return;
    try {
      await navigator.clipboard.writeText(section.content);
      toast.success("항목 본문을 복사했습니다.");
    } catch {
      toast.error("클립보드에 접근하지 못했습니다. 본문을 선택해 직접 복사해 주세요.");
    }
  }
  async function confirm() {
    if (!plan) return;
    if (dirty) {
      toast.error("수정본을 먼저 저장한 후 검토 완료를 표시해 주세요.");
      return;
    }
    if (
      window.confirm(
        "기업의 실제 상황, 수치와 증빙을 확인했나요? ‘검토 완료’는 내부 검토 기록이며 기관 제출·통과를 의미하지 않습니다.",
      )
    )
      await mutate({ action: "confirm-plan", planId: plan.id });
  }
  function generation() {
    if (dirty) {
      toast.error("수정본을 먼저 저장하거나 다른 버전을 선택해 편집을 취소해 주세요.");
      return;
    }
    if (!selection) {
      toast.error("아이템 분석에서 현재 후보를 확인하고 선택 이유를 먼저 기록해 주세요.");
      return;
    }
    generate();
  }
  return (
    <div>
      <PanelHeading
        title="근거가 연결된 사업계획서"
        description="온라인 신청 항목에 맞춰 내용을 검토하세요. 자료를 보강하면 새 버전으로 다시 작성할 수 있습니다."
        actions={
          <Button className="h-10" disabled={dirty || !selection} onClick={generation}>
            <Sparkles />
            {plan ? "새 버전 작성" : "사업계획서 작성"}
          </Button>
        }
      />
      {initialTarget && (
        <div className="mb-5">
          <Notice tone={initialTarget.valid ? "info" : "warning"}>
            {initialTarget.valid
              ? `자료 변경 영향에서 지정한 원고 v${initialTarget.plan?.version}${initialTarget.sectionKey ? ` · 항목 ${initialTarget.sectionKey}` : ""}을 열었습니다. 현재성·사실 확인을 완료한 것은 아닙니다.`
              : "지정한 기업·원고·항목·기록을 고유하게 찾을 수 없습니다. 최신 원고로 자동 대체하지 않습니다."}
          </Notice>
          {!initialTarget.valid && (
            <div className="mt-3 space-y-2">
              <Label htmlFor="review-target-plan">보려는 저장 원고 직접 선택</Label>
              <select
                id="review-target-plan"
                className={selectClass}
                value={planId}
                disabled={dirty}
                onChange={(event) => selectVersion(event.target.value)}
              >
                <option value="">직접 선택</option>
                {sortedPlans.map((item, index) => (
                  <option
                    key={`${item.id}-${index}`}
                    value={item.id}
                    disabled={
                      company.plans.filter((candidate) => candidate.id === item.id).length !== 1
                    }
                  >
                    원고 v{item.version}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
      {!plan || !content ? (
        <EmptyPanel
          title={
            selection
              ? "선택한 아이템을 사업계획서로 완성하세요"
              : "신청 아이템과 선택 이유를 먼저 확인해 주세요"
          }
          description={
            selection
              ? "기술 설명부터 개발·시장·자금계획까지 항목별 초안을 작성하고 근거와 함께 검토합니다."
              : "아이템 분석에서 현재 후보의 근거를 검토하고 선택 이유를 직접 기록하면 새 사업계획서를 작성할 수 있습니다."
          }
        >
          {!selection && (
            <Button variant="outline" onClick={goToAnalysis}>
              아이템 분석으로 이동
            </Button>
          )}
        </EmptyPanel>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <label htmlFor="plan-version" className="text-xs font-semibold">
                작성 이력
              </label>
              <select
                id="plan-version"
                className={`${selectClass} !w-auto max-w-full`}
                value={planId}
                disabled={supportingEditDirty}
                onChange={(event) => selectVersion(event.target.value)}
              >
                {sortedPlans.map((item) => (
                  <option key={item.id} value={item.id}>
                    버전 {item.version} · {formatDate(item.generatedAt)}
                    {item.confirmedAt ? " · 검토 완료" : ""}
                  </option>
                ))}
              </select>
              <ModeBadge mode={plan.mode} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={dirty} asChild={!dirty}>
                {dirty ? (
                  <span>
                    <Download className="mr-1 inline size-4" />
                    저장 후 내려받기
                  </span>
                ) : (
                  <a href={`/api/studio/cases/${company.id}/export?planId=${plan.id}`} download>
                    <Download />
                    Markdown 다운로드
                  </a>
                )}
              </Button>
              <Button disabled={!contentDirty || supportingEditDirty} onClick={save}>
                <Save />
                수정본 저장
              </Button>
            </div>
          </div>
          <PackagePanel
            key={`${company.id}:${company.revision}:${plan.id}`}
            company={company}
            plan={plan}
            dirty={dirty}
            onBusyChange={onBusyChange}
          />
          <PlanComparison
            company={company}
            blockedReason={dirty ? "수정본을 먼저 저장하거나 편집을 취소한 뒤 비교해 주세요." : ""}
          />
          {!selection && (
            <Notice tone="warning">
              <p>
                새 원고를 생성하려면 현재 분석의 아이템 선택 이유를 먼저 기록해 주세요. 기존 원고의
                조회·내려받기·직접 편집은 유지합니다.
              </p>
              <Button
                className="mt-3"
                variant="outline"
                disabled={dirty}
                onClick={() => {
                  if (!dirty) goToAnalysis();
                }}
              >
                아이템 선택 이유 확인
              </Button>
            </Notice>
          )}
          {plan.confirmedAt ? (
            <Notice>
              <span className="flex flex-wrap items-center gap-2">
                <BadgeCheck className="size-4 text-primary" />
                <strong>내부 검토 완료</strong>
                <span>{formatDate(plan.confirmedAt)}</span>
              </span>
              <p>기관 제출 전 최종 입력 내용과 첨부자료를 다시 확인해 주세요.</p>
            </Notice>
          ) : (
            <Notice>
              현재 초안입니다. 확인이 필요한 항목과 검토 의견을 확인해 주세요. 내부 검토 완료와
              벤처인 제출은 별도로 관리합니다.
            </Notice>
          )}
          {!company.analysis && (
            <Notice tone="warning">
              기업정보 또는 자료가 변경되었습니다. 아이템을 다시 분석·선택하고 최신 자료로 새
              사업계획서를 작성해 주세요.
            </Notice>
          )}
          <div className="grid gap-5 2xl:grid-cols-[1fr_300px]">
            <div className="min-w-0 space-y-5">
              <div className="space-y-2">
                <Label htmlFor="plan-title">사업계획서 제목</Label>
                <Input
                  id="plan-title"
                  disabled={supportingEditDirty}
                  value={content.title}
                  maxLength={300}
                  onChange={(event) => setContent({ ...content, title: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="plan-summary">핵심 요약</Label>
                <Textarea
                  id="plan-summary"
                  disabled={supportingEditDirty}
                  className="min-h-32 bg-white leading-7"
                  maxLength={6000}
                  value={content.summary}
                  onChange={(event) => setContent({ ...content, summary: event.target.value })}
                />
              </div>
              <div className="grid overflow-hidden rounded-2xl border xl:grid-cols-[190px_1fr]">
                <nav
                  aria-label="사업계획서 항목"
                  className="flex gap-1 overflow-x-auto border-b bg-muted/35 p-2 xl:flex-col xl:border-b-0 xl:border-r"
                >
                  {content.sections.map((item, index) => (
                    <button
                      type="button"
                      key={item.key}
                      onClick={() => setSectionKey(item.key)}
                      className={cn(
                        "flex min-w-36 shrink-0 items-start gap-2 rounded-lg px-3 py-3 text-left text-xs leading-5 transition-colors xl:min-w-0",
                        sectionKey === item.key
                          ? "bg-white font-semibold text-primary shadow-sm"
                          : "text-muted-foreground hover:bg-white/70",
                      )}
                    >
                      <span className="mt-0.5 text-[10px] opacity-60">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span>
                        {item.title}
                        {item.needsConfirmation && (
                          <span className="mt-1 block text-[10px] font-normal text-amber-700">
                            확인 필요
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </nav>
                <div className="min-w-0 bg-white p-4 sm:p-5">
                  {section && (
                    <>
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <Label htmlFor="plan-section" className="text-sm font-bold">
                          {section.title}
                        </Label>
                        <span className="text-[11px] text-muted-foreground">
                          {section.content.length.toLocaleString()}자
                        </span>
                        <Button variant="outline" size="sm" onClick={copySection}>
                          <Copy />
                          본문 복사
                        </Button>
                      </div>
                      <Textarea
                        id="plan-section"
                        disabled={supportingEditDirty}
                        className="min-h-[390px] resize-y border-0 bg-muted/20 p-4 text-sm leading-8 shadow-none focus-visible:ring-1"
                        value={section.content}
                        maxLength={18000}
                        onChange={(event) => changeSection(event.target.value)}
                      />
                      <label className="mt-4 flex items-start gap-2 text-xs leading-6 text-muted-foreground">
                        <input
                          type="checkbox"
                          disabled={supportingEditDirty}
                          className="mt-1.5 accent-teal-700"
                          checked={!section.needsConfirmation}
                          onChange={(event) =>
                            setContent({
                              ...content,
                              sections: content.sections.map((item) =>
                                item.key === sectionKey
                                  ? { ...item, needsConfirmation: !event.target.checked }
                                  : item,
                              ),
                            })
                          }
                        />
                        <span>이 항목의 사실·수치·증빙과 실행계획을 확인했습니다.</span>
                      </label>
                      <div className="mt-5 border-t pt-4">
                        <h4 className="mb-3 text-xs font-bold">이 항목에 연결된 근거</h4>
                        <EvidenceList company={company} evidence={section.evidence} />
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                <ListBox title="보강할 자료와 실행 과제" items={content.actionItems} />
                <ListBox title="실사 예상 질문" items={content.interviewQuestions} />
              </div>
            </div>
            <aside className="min-w-0">
              <ReviewPanel plan={plan} onSection={setSectionKey} />
              <div className="mt-4 rounded-2xl border bg-white p-5">
                <FileCheck2 className="mb-3 size-6 text-primary" />
                <h3 className="text-sm font-bold">제출 전 내부 검토</h3>
                <p className="my-3 text-xs leading-6 text-muted-foreground">
                  기업이 설명할 수 있는 내용인지 확인하세요. 검토 완료는 심사 통과나 기관 접수를
                  의미하지 않습니다.
                </p>
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={
                    dirty || !!plan.confirmedAt || !company.analysis || !company.selectedCandidateId
                  }
                  onClick={confirm}
                >
                  <BadgeCheck />
                  {plan.confirmedAt ? "검토 완료한 문서" : "검토 완료 표시"}
                </Button>
              </div>
            </aside>
          </div>
          <PlanReviewDecisions
            key={`${company.id}:${company.revision}:${plan.id}`}
            company={company}
            plan={plan}
            mutate={mutate}
            blockedReason={
              contentDirty || numericDirty || claimDirty
                ? "원고·수치 대조·주장 근거 편집을 먼저 저장하거나 취소해 주세요."
                : ""
            }
            onDirtyChange={setReviewDecisionDirty}
          />
          <NumericChecks
            company={company}
            mutate={mutate}
            blockedReason={
              contentDirty || reviewDecisionDirty || claimDirty
                ? "원고·검토 판단·주장 근거 편집을 먼저 저장하거나 취소해 주세요."
                : ""
            }
            onDirtyChange={setNumericDirty}
          />
          <ClaimReviews
            company={company}
            mutate={mutate}
            blockedReason={
              contentDirty || reviewDecisionDirty || numericDirty
                ? "원고·검토 판단·수치 대조 편집을 먼저 저장하거나 취소해 주세요."
                : ""
            }
            onDirtyChange={setClaimDirty}
          />
          <div className="flex items-center justify-end gap-3 border-t pt-4">
            <span className="text-xs text-muted-foreground">
              {dirty ? "저장하지 않은 수정이 있습니다." : `버전 ${plan.version} 저장됨`}
            </span>
            <Button disabled={!contentDirty || supportingEditDirty} onClick={save}>
              <Save />
              수정본 저장
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
function ReviewPanel({
  plan,
  onSection,
}: {
  plan: BusinessPlan;
  onSection: (key: string) => void;
}) {
  return (
    <section className="rounded-2xl border bg-muted/25 p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-bold">
        <CircleAlert className="size-4 text-primary" />
        검토 의견 <Badge variant="secondary">{plan.review.length}</Badge>
      </h3>
      <p className="mb-4 text-xs leading-6 text-muted-foreground">
        저장된 버전을 기준으로 표시합니다. 수정 후 저장하면 다시 검토합니다.
      </p>
      {plan.review.length === 0 ? (
        <p className="text-xs leading-6 text-muted-foreground">
          자동 점검에서 표시할 의견이 없습니다. 사실과 증빙은 직접 확인해 주세요.
        </p>
      ) : (
        <div className="max-h-[560px] space-y-3 overflow-y-auto pr-1">
          {plan.review.map((finding) => (
            <div key={finding.id} className="rounded-xl border bg-white p-3">
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
function ListBox({ title, items }: { title: string; items: string[] }) {
  return (
    <details className="rounded-xl border bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        {title} <span className="ml-1 text-muted-foreground">{items.length}</span>
      </summary>
      <ol className="mt-3 list-outside list-decimal space-y-2 pl-5 text-xs leading-6 text-muted-foreground">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ol>
    </details>
  );
}
