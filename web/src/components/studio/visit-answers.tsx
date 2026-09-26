"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { isApplicationSubmission } from "@/lib/studio-application-types";
import type { BusinessPlan, StudioCase } from "@/lib/studio-schema";
import {
  buildVisitAnswerChecks,
  visitAnswerContext,
  visitAnswerInputSchema,
  visitAnswerLimits,
  visitRespondentLabels,
  type VisitAnswer,
  type VisitAnswerInput,
  type VisitAnswerPair,
} from "@/lib/studio-visit-answer-types";
import { AppealEvidenceEditor } from "./appeal-preparation";
import { AnswerSuggestionsPanel } from "./answer-suggestions-panel";
import { applyVisitAnswerSuggestions } from "./answer-suggestions-ui";
import { Notice, selectClass, useDirty, type PanelProps } from "./shared";

export function latestVisitAnswers(company: Pick<StudioCase, "visitAnswers">) {
  const latest = new Map<string, VisitAnswer>();
  for (const record of company.visitAnswers ?? []) latest.set(record.answerId, record);
  return [...latest.values()];
}
export function visitAnswerInputFor(
  plan: BusinessPlan,
  questionIndex: number,
  previous?: VisitAnswer,
): VisitAnswerInput {
  return {
    answerId: previous?.answerId ?? null,
    previousVersionId: previous?.id ?? null,
    planId: previous?.planId ?? plan.id,
    questionIndex: previous?.questionIndex ?? questionIndex,
    questionText: previous?.questionText ?? plan.content.interviewQuestions[questionIndex],
    submissionRecordId: previous?.submissionRecordId ?? null,
    respondentRole: previous?.respondentRole ?? "representative",
    respondentName: previous?.respondentName ?? "",
    answerText: previous?.answerText ?? "",
    pairs: previous ? structuredClone(previous.pairs) : [],
    followUpNote: previous?.followUpNote ?? "",
    review: { reviewed: false, reviewer: "", note: "" },
  };
}
export function resetVisitReviewAfterEdit(previous: VisitAnswerInput, next: VisitAnswerInput) {
  return JSON.stringify({ ...previous, review: null }) === JSON.stringify({ ...next, review: null })
    ? next
    : { ...next, review: { ...next.review, reviewed: false } };
}
export function visitAnswerDraftText(company: StudioCase, record: VisitAnswer): string {
  const context = visitAnswerContext(company, record);
  const question = record.questionSnapshot;
  const lines = [
    "# DRAFT · 실사 모의 답변",
    "",
    `답변 v${record.version} · ${record.recordedAt}`,
    `기준 원고: v${question.planVersion} · ${question.planTitle}`,
    `원고 내용 SHA256: ${question.planContentSha256}`,
    `질문 ${question.questionIndex + 1}: ${question.questionText}`,
    `질문 SHA256: ${question.questionSha256}`,
    "질문은 원고의 준비용 예상 질문이며 기관이 확정한 질문이 아닙니다.",
    `응답자: ${visitRespondentLabels[record.respondentRole]} · ${record.respondentName || "미지정"}`,
    record.submissionSnapshot
      ? `수동 제출 기록 연결: 해당 기록 v${record.submissionSnapshot.version} · ${record.submissionSnapshot.recordedAt} (실제 기관 제출은 확인하지 않음)`
      : "수동 제출 기록 연결: 없음",
    "",
    "## 담당자 답변",
    record.answerText || "미작성",
    "",
    "## 선택한 인용 대조",
  ];
  for (const [index, pair] of record.pairs.entries()) {
    lines.push(
      `### 대조 ${index + 1}`,
      `답변 인용: ${pair.answerQuote}`,
      pair.planReference
        ? `원고 v${question.planVersion} · 항목 ${pair.planReference.sectionKey}: ${pair.planReference.quote}`
        : "원고 항목 미연결",
      `기간·단위·대상 메모: ${pair.contextNote || "미기재"}`,
    );
    for (const source of pair.sources) {
      const snapshot = record.sourceSnapshots.find((item) => item.sourceId === source.sourceId);
      lines.push(
        `자료: ${snapshot?.sourceName || "연결 확인 필요"} · ${source.sourceUpdatedAt}`,
        `위치: ${source.locator || "미기재"}`,
        `인용: ${source.quote || "원본만 연결 · 본문 미확인"}`,
      );
      if (snapshot?.original)
        lines.push(
          `저장 당시 원본: ${snapshot.original.sizeBytes} bytes · SHA256 ${snapshot.original.sha256}`,
        );
    }
  }
  lines.push(
    "",
    "## 로컬 점검 안내",
    ...record.checks.map((check) => `- ${check.message}`),
    `추가 확인: ${record.followUpNote || "미기재"}`,
    `현재 등록정보·인용 대조: ${context.state === "current" ? "연결 유지" : "재확인 필요"}`,
    ...context.issues.map((issue) => `- ${issue}`),
    "",
    "## 내부 검토 기록",
    `기록일: ${record.review.reviewedAt || "미검토"}`,
    `검토자: ${record.review.reviewer || "미지정"}`,
    `메모: ${record.review.note || "미기재"}`,
    "내부 검토 기록은 사실 진위·답변의 정확성·기관 제출·실사 통과를 확정하지 않습니다.",
    "원본은 저장 시 안전하게 읽어 SHA를 고정했습니다. 현재 파일 바이트의 일치를 이 내려받기로 확인하지 않습니다.",
  );
  return lines.join("\n");
}
function download(company: StudioCase, record: VisitAnswer) {
  const url = URL.createObjectURL(
    new Blob([visitAnswerDraftText(company, record)], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `venturepass-visit-answer-v${record.version}-DRAFT.txt`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Field({
  id,
  label,
  value,
  max = 2000,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  max?: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        maxLength={max}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function VisitAnswerPairEditor({
  company,
  plan,
  pair,
  index,
  onChange,
  onRemove,
}: {
  company: StudioCase;
  plan: BusinessPlan;
  pair: VisitAnswerPair;
  index: number;
  onChange: (pair: VisitAnswerPair) => void;
  onRemove: () => void;
}) {
  const prefix = `visit-pair-${pair.id}`;
  const sections = plan.content.sections.filter(
    (section) => plan.content.sections.filter((item) => item.key === section.key).length === 1,
  );
  const selected = sections.find((section) => section.key === pair.planReference?.sectionKey);
  return (
    <fieldset className="space-y-4 rounded-xl border p-4">
      <legend className="px-2 font-semibold">인용 대조 {index + 1}</legend>
      <Field
        id={`${prefix}-answer`}
        label="작성한 답변에서 그대로 인용 *"
        value={pair.answerQuote}
        max={1500}
        onChange={(answerQuote) => onChange({ ...pair, answerQuote })}
      />
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-section`}>원고 v{plan.version}의 항목 (선택)</Label>
        <select
          id={`${prefix}-section`}
          className={selectClass}
          value={pair.planReference?.sectionKey ?? ""}
          onChange={(event) =>
            onChange({
              ...pair,
              planReference: event.target.value
                ? { sectionKey: event.target.value, quote: "" }
                : null,
            })
          }
        >
          <option value="">원고 항목 미연결</option>
          {sections.map((section) => (
            <option key={section.key} value={section.key}>
              {section.title}
            </option>
          ))}
        </select>
      </div>
      {pair.planReference && (
        <>
          <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/30 p-3 text-xs">
            {selected?.content ?? "연결한 항목을 고유하게 찾을 수 없습니다."}
          </pre>
          <Field
            id={`${prefix}-plan-quote`}
            label="위 원고 항목 그대로 인용 *"
            value={pair.planReference.quote}
            max={1500}
            onChange={(quote) =>
              onChange({ ...pair, planReference: { ...pair.planReference!, quote } })
            }
          />
        </>
      )}
      <AppealEvidenceEditor
        company={company}
        prefix={`${prefix}-sources`}
        label="대조할 자료"
        references={pair.sources}
        onChange={(sources) => onChange({ ...pair, sources })}
      />
      <Field
        id={`${prefix}-context`}
        label="기간·단위·대상·실적/계획 구분 메모 (수동)"
        value={pair.contextNote}
        onChange={(contextNote) => onChange({ ...pair, contextNote })}
      />
      <Button type="button" variant="outline" size="sm" onClick={onRemove}>
        이 대조 항목 삭제
      </Button>
    </fieldset>
  );
}

export function VisitAnswerView({ company, record }: { company: StudioCase; record: VisitAnswer }) {
  const context = visitAnswerContext(company, record);
  return (
    <article
      className="space-y-3 rounded-xl border p-4"
      aria-label={`실사 답변 v${record.version}`}
    >
      <h4 className="font-semibold">
        답변 v{record.version} · 원고 v{record.questionSnapshot.planVersion} · 질문{" "}
        {record.questionIndex + 1}
      </h4>
      <p className="text-xs text-muted-foreground">
        {record.recordedAt} · {visitRespondentLabels[record.respondentRole]} ·{" "}
        {record.respondentName || "응답자 미지정"}
      </p>
      <p className="whitespace-pre-wrap text-sm">{record.questionSnapshot.questionText}</p>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-sm">
        {record.answerText || "답변 미작성"}
      </pre>
      <p className="text-xs">
        {record.review.reviewedAt
          ? `내부 검토 기록: ${record.review.reviewer} · ${record.review.reviewedAt}`
          : "내부 검토 미기록"}
        {record.review.reviewedAt && !context.reviewCurrent ? " · 현재 연결 재확인 필요" : ""}
      </p>
      {context.issues.length > 0 && <Notice tone="warning">{context.issues.join(" ")}</Notice>}
      <ul className="list-disc space-y-1 pl-5 text-xs leading-6">
        {record.checks.map((check, index) => (
          <li key={`${check.pairId}-${check.code}-${index}`}>{check.message}</li>
        ))}
      </ul>
      <p className="whitespace-pre-wrap text-xs">추가 확인: {record.followUpNote || "미기재"}</p>
      <details>
        <summary className="cursor-pointer text-sm underline">
          고정한 인용·원본 SHA·검토 메모 보기
        </summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
          {visitAnswerDraftText(company, record)}
        </pre>
      </details>
      <Button type="button" size="sm" variant="outline" onClick={() => download(company, record)}>
        DRAFT 답변 기록 내려받기
      </Button>
    </article>
  );
}

type Props = Pick<PanelProps, "company" | "mutate"> & {
  blockedReason?: string;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange?: (message: string) => void;
};
export function VisitAnswers(props: Props) {
  return <VisitAnswersEditor key={`${props.company.id}:${props.company.revision}`} {...props} />;
}
function VisitAnswersEditor({
  company,
  mutate,
  blockedReason = "",
  onDirtyChange,
  onBusyChange,
}: Props) {
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [selectedQuestion, setSelectedQuestion] = useState("");
  const [editor, setEditor] = useState<VisitAnswerInput | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [suggestionBusy, setSuggestionBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const nonce = useRef<{ input: string; id: string } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useDirty(editor !== null || suggestionBusy, onDirtyChange);
  const latest = latestVisitAnswers(company);
  const selectedPlans = company.plans.filter((plan) => plan.id === selectedPlanId);
  const selectedPlan = selectedPlans.length === 1 ? selectedPlans[0] : undefined;
  const editingPlans = company.plans.filter((plan) => plan.id === editor?.planId);
  const editingPlan = editingPlans.length === 1 ? editingPlans[0] : undefined;
  const atLimit = company.visitAnswers.length >= visitAnswerLimits.versions;
  const blocked = Boolean(blockedReason) || saving || suggestionBusy;
  const exists = latest.some(
    (record) =>
      record.planId === selectedPlanId && String(record.questionIndex) === selectedQuestion,
  );
  function edit(next: VisitAnswerInput) {
    if (!editor || inFlight.current || suggestionBusy || blockedReason) return;
    setEditor(resetVisitReviewAfterEdit(editor, next));
    setError("");
  }
  async function save() {
    if (!editor || blocked || inFlight.current) return;
    const parsed = visitAnswerInputSchema.safeParse(editor);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "입력값을 확인해 주세요.");
      return;
    }
    const serialized = JSON.stringify(parsed.data);
    if (!nonce.current || nonce.current.input !== serialized)
      nonce.current = { input: serialized, id: crypto.randomUUID() };
    inFlight.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await mutate({
        action: "append-visit-answer",
        clientRequestId: nonce.current.id,
        answer: parsed.data,
      });
      if (!mounted.current) return;
      if (
        result?.id === company.id &&
        result.visitAnswers.some((record) => record.clientRequestId === nonce.current?.id)
      ) {
        setEditor(null);
        nonce.current = null;
      } else
        setError(
          "저장을 확인하지 못했습니다. 입력은 유지합니다. 같은 내용으로 다시 확인하거나 최신 기록을 확인해 주세요.",
        );
    } catch {
      if (mounted.current)
        setError(
          "저장을 확인하지 못했습니다. 입력은 유지합니다. 같은 내용으로 다시 확인해 주세요.",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <section aria-label="실사 모의 답변 기록" className="mt-6 space-y-4 rounded-2xl border p-5">
      <div>
        <h3 className="font-bold">실사 모의 답변 · 원고·근거 대조</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          준비용 예상 질문에 담당자의 답변을 기록합니다. 선택한 인용의 표기만 대조하며 사실
          진위·기관 확정 질문·실사 통과를 판정하지 않습니다.
        </p>
      </div>
      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      {!company.plans.length && (
        <p className="text-sm text-muted-foreground">
          예상 질문이 있는 원고를 저장하면 답변 준비를 시작할 수 있습니다.
        </p>
      )}
      {!editor && (
        <fieldset disabled={blocked || atLimit} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="visit-answer-plan">기준 원고 버전 직접 선택</Label>
            <select
              id="visit-answer-plan"
              className={selectClass}
              value={selectedPlanId}
              onChange={(event) => {
                setSelectedPlanId(event.target.value);
                setSelectedQuestion("");
              }}
            >
              <option value="">원고 선택</option>
              {[...company.plans].reverse().map((plan, index) => (
                <option
                  key={`${plan.id}-${index}`}
                  value={plan.id}
                  disabled={company.plans.filter((item) => item.id === plan.id).length !== 1}
                >
                  v{plan.version} · {plan.content.title}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="visit-answer-question">원고의 예상 질문 직접 선택</Label>
            <select
              id="visit-answer-question"
              className={selectClass}
              value={selectedQuestion}
              disabled={!selectedPlan}
              onChange={(event) => setSelectedQuestion(event.target.value)}
            >
              <option value="">질문 선택</option>
              {selectedPlan?.content.interviewQuestions.map((question, index) => (
                <option key={index} value={index}>
                  {index + 1}. {question}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!selectedPlan || selectedQuestion === "" || exists}
            onClick={() => {
              if (selectedPlan && selectedQuestion !== "") {
                setEditor(visitAnswerInputFor(selectedPlan, Number(selectedQuestion)));
                setError("");
                nonce.current = null;
              }
            }}
          >
            {exists ? "이 질문의 답변 이력 있음 · 아래에서 이어서 작성" : "미검토 답변 작성 시작"}
          </Button>
        </fieldset>
      )}
      {atLimit && (
        <Notice tone="warning">
          기업당 답변 버전 {visitAnswerLimits.versions}개 한도입니다. 이전 이력을 삭제하거나
          자동으로 줄이지 않습니다.
        </Notice>
      )}
      {editor && editingPlan && (
        <fieldset disabled={blocked} className="space-y-4 rounded-xl border bg-muted/10 p-4">
          <legend className="px-2 font-semibold">
            {editor.answerId ? "기존 답변의 새 버전" : "새 답변 초안"}
          </legend>
          <Notice>
            기준 원고 v{editingPlan.version} · 질문 {editor.questionIndex + 1}:{" "}
            {editor.questionText}
            <br />
            과거 원고도 의도적으로 선택할 수 있습니다. 제출본·최신 사실 여부는 별도 확인해 주세요.
          </Notice>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="visit-answer-role">응답자 역할</Label>
              <select
                id="visit-answer-role"
                className={selectClass}
                value={editor.respondentRole}
                onChange={(event) =>
                  edit({
                    ...editor,
                    respondentRole: event.target.value as VisitAnswerInput["respondentRole"],
                  })
                }
              >
                {Object.entries(visitRespondentLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="visit-answer-name">응답자 이름</Label>
              <Input
                id="visit-answer-name"
                maxLength={100}
                value={editor.respondentName}
                onChange={(event) => edit({ ...editor, respondentName: event.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="visit-answer-submission">같은 원고의 수동 제출 기록 연결 (선택)</Label>
            <select
              id="visit-answer-submission"
              className={selectClass}
              value={editor.submissionRecordId ?? ""}
              onChange={(event) =>
                edit({ ...editor, submissionRecordId: event.target.value || null })
              }
            >
              <option value="">연결 안 함 · 기관 제출 여부 미확인</option>
              {company.applicationEvents
                .filter(isApplicationSubmission)
                .filter((event) => event.plan.id === editor.planId)
                .map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.occurredOn} · 수동 제출 기록 v{event.version} · {event.recordedBy}
                  </option>
                ))}
            </select>
          </div>
          <AnswerSuggestionsPanel
            company={company}
            scope={{
              kind: "visit-question",
              planId: editingPlan.id,
              planVersion: editingPlan.version,
              questionIndex: editor.questionIndex,
              questionText: editor.questionText,
            }}
            contextFingerprint={JSON.stringify(editor)}
            disabled={blocked}
            hasExistingContent={!!editor.answerText || editor.pairs.length > 0}
            onePerSource={false}
            onBusyChange={(value) => {
              setSuggestionBusy(value);
              onBusyChange?.(value ? "실사 질문의 선택 자료 근거 제안을 확인하는 중입니다" : "");
            }}
            onApply={(result, selected, replace) => {
              if (blocked || inFlight.current)
                return "편집 상태가 바뀌었습니다. 제안을 다시 확인해 주세요.";
              const applied = applyVisitAnswerSuggestions(
                editor,
                result.binding.target,
                selected,
                replace,
              );
              if (!applied.value) return applied.error ?? "선택한 제안을 적용하지 못했습니다.";
              edit(applied.value);
              return null;
            }}
          />
          <Field
            id="visit-answer-text"
            label="담당자 모의 답변 (최대 10,000자)"
            value={editor.answerText}
            max={10000}
            onChange={(answerText) => edit({ ...editor, answerText })}
          />
          {editor.pairs.map((pair, index) => (
            <VisitAnswerPairEditor
              key={pair.id}
              company={company}
              plan={editingPlan}
              pair={pair}
              index={index}
              onChange={(value) =>
                edit({
                  ...editor,
                  pairs: editor.pairs.map((item, i) => (i === index ? value : item)),
                })
              }
              onRemove={() =>
                edit({ ...editor, pairs: editor.pairs.filter((_, i) => i !== index) })
              }
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={editor.pairs.length >= visitAnswerLimits.pairs}
            onClick={() =>
              edit({
                ...editor,
                pairs: [
                  ...editor.pairs,
                  {
                    id: crypto.randomUUID(),
                    answerQuote: "",
                    planReference: null,
                    sources: [],
                    contextNote: "",
                  },
                ],
              })
            }
          >
            답변·원고/자료 인용 대조 추가
          </Button>
          <Field
            id="visit-answer-followup"
            label="추가 자료·후속 확인"
            value={editor.followUpNote}
            onChange={(followUpNote) => edit({ ...editor, followUpNote })}
          />
          <Notice tone="warning">
            <ul className="list-disc pl-4">
              {buildVisitAnswerChecks(editor).map((check, index) => (
                <li key={index}>{check.message}</li>
              ))}
            </ul>
            이 안내는 저장 전 입력의 표기 대조입니다. 정확한 인용·원본 검사는 저장 시 서버에서 다시
            수행합니다.
          </Notice>
          {editor.answerId ? (
            <fieldset className="space-y-3 rounded-xl border p-3">
              <legend className="px-1 text-sm">이번 버전의 내부 검토 기록 (선택)</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editor.review.reviewed}
                  onChange={(event) =>
                    edit({
                      ...editor,
                      review: { ...editor.review, reviewed: event.target.checked },
                    })
                  }
                />
                원문과 답변을 대조한 담당자의 내부 검토를 기록합니다. 사실 진위·기관 수용을 확정하지
                않습니다.
              </label>
              <div className="space-y-2">
                <Label htmlFor="visit-answer-reviewer">검토 담당자</Label>
                <Input
                  id="visit-answer-reviewer"
                  value={editor.review.reviewer}
                  maxLength={100}
                  onChange={(event) =>
                    edit({ ...editor, review: { ...editor.review, reviewer: event.target.value } })
                  }
                />
              </div>
              <Field
                id="visit-answer-review-note"
                label="검토 메모·미해결 사항"
                value={editor.review.note}
                onChange={(note) => edit({ ...editor, review: { ...editor.review, note } })}
              />
            </fieldset>
          ) : (
            <p className="text-xs text-muted-foreground">
              최초 답변은 미검토로 저장합니다. 저장한 답변의 새 버전에서 내부 검토를 기록할 수
              있습니다.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={atLimit} onClick={() => void save()}>
              {saving ? "저장 중" : "답변 버전 저장"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!inFlight.current) {
                  setEditor(null);
                  setError("");
                  nonce.current = null;
                }
              }}
            >
              편집 취소
            </Button>
          </div>
        </fieldset>
      )}
      {editor && !editingPlan && (
        <Notice tone="warning">
          연결한 원고를 고유하게 찾을 수 없습니다. 새로고침해 현재 자료를 확인해 주세요.
        </Notice>
      )}
      <div className="space-y-4">
        {latest.map((record) => {
          const plan = company.plans.find((item) => item.id === record.planId);
          const history = company.visitAnswers.filter((item) => item.answerId === record.answerId);
          return (
            <div key={record.answerId} className="space-y-3">
              <VisitAnswerView company={company} record={record} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={blocked || atLimit || editor !== null || !plan}
                onClick={() => {
                  if (plan) {
                    setEditor(visitAnswerInputFor(plan, record.questionIndex, record));
                    nonce.current = null;
                    setError("");
                  }
                }}
              >
                이 답변에서 새 버전 작성
              </Button>
              {history.length > 1 && (
                <details>
                  <summary className="cursor-pointer text-sm underline">
                    이전 답변 버전 {history.length - 1}개
                  </summary>
                  <div className="mt-3 space-y-3">
                    {history
                      .slice(0, -1)
                      .reverse()
                      .map((entry) => (
                        <VisitAnswerView key={entry.id} company={company} record={entry} />
                      ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs leading-6 text-muted-foreground">
        원본은 저장 시 SHA를 고정합니다. 현재 화면은 등록정보·인용의 연결 상태만 대조하며 원본
        파일을 다시 읽지 않습니다. 답변 저장은 업무·회사 단계·원고 검토·기관 기록을 바꾸지 않습니다.
      </p>
    </section>
  );
}
