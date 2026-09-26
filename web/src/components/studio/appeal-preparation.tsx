"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { isAgencyNoticeRecord, type AgencyNoticeRecord } from "@/lib/studio-agency-records";
import {
  appealPreparationContext,
  appealPreparationInputSchema,
  type AppealPreparation,
  type AppealPreparationInput,
  type AppealReference,
} from "@/lib/studio-appeal-types";
import type { StudioCase } from "@/lib/studio-schema";
import { Notice, selectClass, useDirty, type PanelProps } from "./shared";

type Reason = AppealPreparationInput["reasons"][number];
const intentLabels = {
  undecided: "진행 여부 미정",
  preparing: "소명 준비 중",
  "not-pursuing": "현재 진행하지 않음",
};

export function latestDecisionNotices(company: StudioCase): AgencyNoticeRecord[] {
  const latest = new Map<string, AgencyNoticeRecord>();
  for (const record of company.agencyRecords ?? []) {
    if (isAgencyNoticeRecord(record)) latest.set(record.noticeRecordId, record);
  }
  return [...latest.values()].filter((record) => record.details.category === "decision");
}

export function newAppealReason(): Reason {
  return {
    id: crypto.randomUUID(),
    noticeField: "reasons",
    noticeQuote: "",
    claim: "",
    planClaim: null,
    gap: "",
    evidence: [],
    additionalEvidence: [],
    draft: "",
  };
}

export function appealInputFor(
  notice: AgencyNoticeRecord,
  previous?: AppealPreparation,
): AppealPreparationInput {
  return {
    preparationId: previous?.preparationId ?? null,
    previousVersionId: previous?.id ?? null,
    noticeRecordId: notice.noticeRecordId,
    noticeVersionId: notice.id,
    title: previous?.title ?? `소명 준비: ${notice.title}`.slice(0, 300),
    intent: previous?.intent ?? "undecided",
    intentNote: previous?.intentNote ?? "",
    deadlineOn: previous?.deadlineOn ?? "",
    deadlineNote: previous?.deadlineNote ?? "",
    reasons: previous ? structuredClone(previous.reasons) : [newAppealReason()],
    review: { reviewed: false, reviewer: "", note: "" },
  };
}

export function resetAppealReviewAfterEdit(
  previous: AppealPreparationInput,
  next: AppealPreparationInput,
) {
  const before = { ...previous, review: null };
  const after = { ...next, review: null };
  return JSON.stringify(before) === JSON.stringify(after)
    ? next
    : { ...next, review: { ...next.review, reviewed: false } };
}

export function appealDraftText(company: StudioCase, record: AppealPreparation): string {
  const context = appealPreparationContext(company, record);
  const notice = company.agencyRecords.find((entry) => entry.id === record.noticeVersionId);
  const lines = [
    "# DRAFT · 소명 준비 검토안",
    "",
    record.title,
    `준비 v${record.version} · 로컬 기록 ${record.recordedAt}`,
    `기준 통보: ${notice && isAgencyNoticeRecord(notice) ? `${notice.title} · 통보 v${notice.version}` : "연결한 통보 버전 확인 필요"}`,
    "담당자 작성 자료입니다. 기관 제출·수용 또는 법률 검토 완료를 의미하지 않습니다.",
    `진행 판단: ${intentLabels[record.intent]}`,
    `담당자가 기입한 기한: ${record.deadlineOn || "미확인"}`,
    `기한 근거: ${record.deadlineNote || "미기재"}`,
    `현재 등록내용 대조: ${context.state === "current" ? "연결 유지" : "재확인 필요"}`,
    ...context.issues.map((issue) => `- ${issue}`),
  ];
  record.reasons.forEach((reason, index) => {
    lines.push(
      "",
      `## 사유 ${index + 1}`,
      `통보 사유 인용: ${reason.noticeQuote}`,
      `기존 주장: ${reason.claim || "미기재"}`,
      `연결 원고 인용: ${reason.planClaim?.quote || "미연결"}`,
      `보완할 사항: ${reason.gap || "미기재"}`,
      "",
      "### 소명 초안",
      reason.draft || "미작성",
    );
    if (reason.planClaim) {
      const snapshot = record.planSnapshots.find(
        (plan) => plan.planId === reason.planClaim!.planId,
      );
      lines.push(
        `연결 원고 기준: ${snapshot ? `원고 v${snapshot.version}` : "버전 확인 필요"} · 항목 ${reason.planClaim.sectionKey}`,
      );
    }
    for (const [label, refs] of [
      ["기존 근거", reason.evidence],
      ["추가 증빙", reason.additionalEvidence],
    ] as const) {
      lines.push("", `### ${label}`);
      for (const ref of refs) {
        const source = record.sourceSnapshots.find((item) => item.sourceId === ref.sourceId);
        lines.push(
          `- ${source?.sourceName || "자료 연결 확인 필요"} · 자료 버전 ${ref.sourceUpdatedAt}`,
          `  위치: ${ref.locator || "미기재"}`,
          `  인용: ${ref.quote || "원본 파일만 연결 · 본문 미확인"}`,
        );
        if (source?.original)
          lines.push(
            `  저장 당시 원본: ${source.original.sizeBytes} bytes · SHA256 ${source.original.sha256}`,
          );
      }
      if (!refs.length) lines.push("미연결");
    }
  });
  lines.push(
    "",
    "## 내부 검토 기록",
    `검토 기록일: ${record.review.reviewedAt || "미검토"}`,
    `검토자: ${record.review.reviewer || "미지정"}`,
    `메모: ${record.review.note || "미기재"}`,
    "원본 파일의 현재 바이트 일치 및 공식 처리 결과는 이 내려받기로 확인하지 않습니다.",
  );
  return lines.join("\n");
}

function TextField({
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

export function AppealEvidenceEditor({
  company,
  prefix,
  label,
  references,
  onChange,
  maxReferences = 10,
}: {
  company: StudioCase;
  prefix: string;
  label: string;
  references: AppealReference[];
  onChange: (references: AppealReference[]) => void;
  maxReferences?: number;
}) {
  const available = company.sources.filter(
    (source) => source.originalName || source.extraction !== "pending",
  );
  return (
    <fieldset className="space-y-3 rounded-xl border p-3">
      <legend className="px-1 text-sm font-semibold">{label}</legend>
      <Label htmlFor={`${prefix}-add`}>연결할 자료</Label>
      <select
        id={`${prefix}-add`}
        className={selectClass}
        value=""
        disabled={references.length >= maxReferences}
        onChange={(event) => {
          const source = available.find((item) => item.id === event.target.value);
          if (
            !source ||
            references.length >= maxReferences ||
            references.some((item) => item.sourceId === source.id)
          )
            return;
          onChange([
            ...references,
            { sourceId: source.id, sourceUpdatedAt: source.updatedAt, quote: "", locator: "" },
          ]);
        }}
      >
        <option value="">자료 선택</option>
        {available.map((source) => (
          <option
            key={source.id}
            value={source.id}
            disabled={references.some((ref) => ref.sourceId === source.id)}
          >
            {source.name}
          </option>
        ))}
      </select>
      {references.map((ref, index) => {
        const source = company.sources.find((item) => item.id === ref.sourceId);
        const stale = !source || source.updatedAt !== ref.sourceUpdatedAt;
        const update = (patch: Partial<AppealReference>) =>
          onChange(references.map((item, i) => (i === index ? { ...item, ...patch } : item)));
        return (
          <div key={ref.sourceId} className="space-y-2 rounded-lg bg-muted/30 p-3">
            <p className="text-sm font-medium">{source?.name || "자료를 찾지 못했습니다"}</p>
            {stale && (
              <p className="text-xs text-amber-900">
                연결 뒤 자료가 변경되었습니다. 원문을 대조한 뒤 이 연결을 제거하고 다시 선택해
                주세요.
              </p>
            )}
            {source && (
              <details>
                <summary className="cursor-pointer text-xs underline">등록 본문 대조</summary>
                <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap text-xs">
                  {source.extraction === "pending"
                    ? "본문 확인 필요 · 원본 파일만 연결할 수 있습니다."
                    : source.text}
                </pre>
              </details>
            )}
            <TextField
              id={`${prefix}-${index}-quote`}
              label="등록 본문 그대로 인용 (원본만 연결하면 비움)"
              value={ref.quote}
              max={1500}
              onChange={(quote) => update({ quote })}
            />
            <div className="space-y-2">
              <Label htmlFor={`${prefix}-${index}-locator`}>쪽·위치 (선택)</Label>
              <Input
                id={`${prefix}-${index}-locator`}
                value={ref.locator}
                maxLength={150}
                onChange={(event) => update({ locator: event.target.value })}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onChange(references.filter((_, i) => i !== index))}
            >
              이 자료 연결 해제
            </Button>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        빈 인용은 보관 원본이 있는 자료에만 허용됩니다. 연결만으로 자료 내용이 확인되지는 않습니다.
      </p>
    </fieldset>
  );
}

export function AppealReasonEditor({
  company,
  notice,
  reason,
  index,
  onChange,
  onRemove,
}: {
  company: StudioCase;
  notice: AgencyNoticeRecord;
  reason: Reason;
  index: number;
  onChange: (reason: Reason) => void;
  onRemove: () => void;
}) {
  const prefix = `appeal-reason-${reason.id}`;
  const selectedPlan = company.plans.find((plan) => plan.id === reason.planClaim?.planId);
  const section = selectedPlan?.content.sections.find(
    (item) => item.key === reason.planClaim?.sectionKey,
  );
  const noticeText =
    reason.noticeField === "body"
      ? notice.body
      : notice.details.category === "decision"
        ? notice.details.reasons
        : "";
  return (
    <fieldset className="space-y-4 rounded-xl border p-4">
      <legend className="px-2 font-semibold">사유 {index + 1}</legend>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-field`}>사유를 가져올 통보 항목</Label>
        <select
          id={`${prefix}-field`}
          className={selectClass}
          value={reason.noticeField}
          onChange={(event) =>
            onChange({
              ...reason,
              noticeField: event.target.value as Reason["noticeField"],
              noticeQuote: "",
            })
          }
        >
          <option value="reasons">심사 결과의 사유</option>
          <option value="body">통보 본문</option>
        </select>
      </div>
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/30 p-3 text-xs">
        {noticeText || "등록된 내용이 없습니다. 통보 원문을 먼저 확인해 주세요."}
      </pre>
      <TextField
        id={`${prefix}-notice-quote`}
        label="대응할 사유를 위 원문 그대로 인용 *"
        value={reason.noticeQuote}
        max={1500}
        onChange={(noticeQuote) => onChange({ ...reason, noticeQuote })}
      />
      <TextField
        id={`${prefix}-claim`}
        label="기존 주장·설명"
        value={reason.claim}
        onChange={(claim) => onChange({ ...reason, claim })}
      />
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-plan`}>기존 원고 버전 연결 (선택)</Label>
        <select
          id={`${prefix}-plan`}
          className={selectClass}
          value={reason.planClaim?.planId ?? ""}
          onChange={(event) =>
            onChange({
              ...reason,
              planClaim: event.target.value
                ? { planId: event.target.value, sectionKey: "", quote: "" }
                : null,
            })
          }
        >
          <option value="">원고 연결 없음</option>
          {[...company.plans].reverse().map((plan) => (
            <option key={plan.id} value={plan.id}>
              원고 v{plan.version} · {plan.content.title}
            </option>
          ))}
        </select>
      </div>
      {reason.planClaim && (
        <div className="space-y-3 rounded-lg border p-3">
          <Label htmlFor={`${prefix}-section`}>원고 항목</Label>
          <select
            id={`${prefix}-section`}
            className={selectClass}
            value={reason.planClaim.sectionKey}
            onChange={(event) =>
              onChange({
                ...reason,
                planClaim: { ...reason.planClaim!, sectionKey: event.target.value, quote: "" },
              })
            }
          >
            <option value="">항목 선택</option>
            {selectedPlan?.content.sections.map((item, i) => (
              <option key={`${item.key}-${i}`} value={item.key}>
                {item.title}
              </option>
            ))}
          </select>
          {section && (
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap text-xs">
              {section.content}
            </pre>
          )}
          <TextField
            id={`${prefix}-plan-quote`}
            label="선택 원고의 해당 부분 그대로 인용 *"
            value={reason.planClaim.quote}
            max={1500}
            onChange={(quote) =>
              onChange({ ...reason, planClaim: { ...reason.planClaim!, quote } })
            }
          />
        </div>
      )}
      <TextField
        id={`${prefix}-gap`}
        label="추가 설명·보강이 필요한 사항"
        value={reason.gap}
        onChange={(gap) => onChange({ ...reason, gap })}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <AppealEvidenceEditor
          company={company}
          prefix={`${prefix}-existing`}
          label="기존 근거"
          references={reason.evidence}
          onChange={(evidence) => onChange({ ...reason, evidence })}
        />
        <AppealEvidenceEditor
          company={company}
          prefix={`${prefix}-additional`}
          label="추가 증빙"
          references={reason.additionalEvidence}
          onChange={(additionalEvidence) => onChange({ ...reason, additionalEvidence })}
        />
      </div>
      <TextField
        id={`${prefix}-draft`}
        label="이 사유에 대한 소명 초안"
        value={reason.draft}
        max={10000}
        onChange={(draft) => onChange({ ...reason, draft })}
      />
      <Button type="button" variant="outline" size="sm" onClick={onRemove}>
        이 사유 제거
      </Button>
    </fieldset>
  );
}

export function AppealPreparationView({
  company,
  record,
}: {
  company: StudioCase;
  record: AppealPreparation;
}) {
  const context = appealPreparationContext(company, record);
  return (
    <article
      className="space-y-3 rounded-xl border p-4"
      aria-label={`소명 준비 v${record.version}`}
    >
      <h4 className="font-semibold">
        {record.title} · 준비 v{record.version}
      </h4>
      <p className="text-xs text-muted-foreground">
        {intentLabels[record.intent]} · 담당자 기록 {record.recordedAt}
      </p>
      <p className="text-xs text-muted-foreground">
        원본은 저장할 때 대조했습니다. 현재 파일을 다시 검사한 결과는 아닙니다.
      </p>
      <p className="text-sm">
        등록내용 연결: {context.state === "current" ? "유지됨" : "재확인 필요"} · 내부 검토:{" "}
        {context.reviewCurrent
          ? "담당자 검토 기록 있음"
          : record.review.reviewedAt
            ? "과거 검토 · 현재 내용 재확인 필요"
            : "미검토"}
      </p>
      {!!context.issues.length && (
        <ul className="list-inside list-disc text-xs text-amber-900">
          {context.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      <p className="text-xs">
        기입한 기한: {record.deadlineOn || "미확인"} · 근거: {record.deadlineNote || "미기재"}
      </p>
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          사유·근거·소명·검토 기록 펼치기
        </summary>
        <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap text-sm leading-6">
          {appealDraftText(company, record)}
        </pre>
      </details>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          const url = URL.createObjectURL(
            new Blob([appealDraftText(company, record)], { type: "text/plain;charset=utf-8" }),
          );
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = `appeal-draft-v${record.version}.md`;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        소명 검토안 내려받기
      </Button>
    </article>
  );
}

type Form = { input: AppealPreparationInput; baseline: string; nonce: string; binding: string };
type Props = Pick<PanelProps, "company" | "mutate"> & {
  blockedReason: string;
  onDirtyChange: (dirty: boolean) => void;
};

export function AppealPreparations({ company, mutate, blockedReason, onDirtyChange }: Props) {
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const binding = `${company.id}:${company.revision}`;
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
  const notices = latestDecisionNotices(company);
  const records = company.appealPreparations ?? [];
  const roots = records.filter((record) => record.previousVersionId === null);
  const selectedNotice = form
    ? notices.find((record) => record.id === form.input.noticeVersionId)
    : undefined;
  const limit = records.length >= 50;
  const blocked = !!blockedReason || saving;
  function open(notice: AgencyNoticeRecord, previous?: AppealPreparation) {
    if (blocked || limit || (dirty && !window.confirm("저장하지 않은 소명 편집을 취소할까요?")))
      return;
    const input = appealInputFor(notice, previous);
    setForm({ input, baseline: JSON.stringify(input), nonce: crypto.randomUUID(), binding });
    setError("");
  }
  function edit(input: AppealPreparationInput) {
    if (!form) return;
    setForm({
      ...form,
      input: resetAppealReviewAfterEdit(form.input, input),
      nonce: crypto.randomUUID(),
    });
  }
  async function save() {
    if (!form || blocked || pending.current) return;
    if (form.binding !== binding) {
      setError("기업 기록이 변경되었습니다. 최신 기록에서 내용을 다시 대조해 주세요.");
      return;
    }
    const parsed = appealPreparationInputSchema.safeParse(form.input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "입력 내용을 확인해 주세요.");
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await mutate({
        action: "append-appeal-preparation",
        clientRequestId: form.nonce,
        preparation: parsed.data,
      });
      if (mounted.current && context.current === binding) {
        if (saved) setForm(null);
        else
          setError(
            "저장하지 못했습니다. 편집 내용은 유지했습니다. 오류 안내와 최신 저장 상태를 확인해 주세요.",
          );
      }
    } catch {
      if (mounted.current && context.current === binding)
        setError("저장 결과를 확인하지 못했습니다. 최신 기록을 확인해 주세요.");
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <section
      id="appeal-preparations"
      aria-label="결과 사유별 소명 준비"
      className="my-7 space-y-4 rounded-2xl border p-5"
    >
      <div>
        <h3 className="font-bold">결과 사유별 소명 준비</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          결과 통보의 사유를 원문에서 선택하고 기존 주장·추가 증빙·소명 초안을 묶습니다. 이전 버전은
          그대로 보관됩니다.
        </p>
      </div>
      <Notice>
        로컬 검토안입니다. 기한과 진행 여부는 확인한 안내에 따라 직접 기록하며, 기관 제출·발송은
        별도로 진행합니다.
      </Notice>
      {blockedReason && <p className="text-sm text-amber-900">{blockedReason}</p>}
      {limit && (
        <p className="text-sm text-amber-900">
          소명 준비 이력 50개 한도에 도달했습니다. 기존 기록을 보존합니다.
        </p>
      )}
      {!notices.length && (
        <p className="text-sm text-muted-foreground">
          먼저 위의 기관 통보에 심사 결과 원문과 사유를 기록해 주세요.
        </p>
      )}
      <div className="space-y-2">
        {notices.map((notice) => (
          <div
            key={notice.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/25 p-3"
          >
            <a className="text-sm underline" href={`#agency-record-${notice.id}`}>
              {notice.title} · 통보 v{notice.version}
            </a>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                blocked ||
                limit ||
                roots.some((root) => root.noticeRecordId === notice.noticeRecordId)
              }
              onClick={() => open(notice)}
            >
              {roots.some((root) => root.noticeRecordId === notice.noticeRecordId)
                ? "아래 준비안에서 새 버전 작성"
                : "이 통보의 새 소명 준비"}
            </Button>
          </div>
        ))}
      </div>
      {form && selectedNotice && (
        <fieldset disabled={blocked} className="space-y-4 rounded-xl border border-primary/30 p-4">
          <legend className="px-2 font-semibold">
            {form.input.previousVersionId ? "소명 준비 새 버전" : "새 소명 준비"}
          </legend>
          <p className="text-xs">
            기준: {selectedNotice.title} · 통보 v{selectedNotice.version}
          </p>
          <div className="space-y-2">
            <Label htmlFor="appeal-title">준비안 제목 *</Label>
            <Input
              id="appeal-title"
              value={form.input.title}
              maxLength={300}
              onChange={(event) => edit({ ...form.input, title: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="appeal-intent">진행 판단</Label>
            <select
              id="appeal-intent"
              className={selectClass}
              value={form.input.intent}
              onChange={(event) =>
                edit({
                  ...form.input,
                  intent: event.target.value as AppealPreparationInput["intent"],
                })
              }
            >
              {Object.entries(intentLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <TextField
            id="appeal-intent-note"
            label="진행 판단 메모"
            value={form.input.intentNote}
            onChange={(intentNote) => edit({ ...form.input, intentNote })}
          />
          <div className="space-y-2">
            <Label htmlFor="appeal-deadline">확인한 안내의 기한 (미확인은 비움)</Label>
            <Input
              id="appeal-deadline"
              type="date"
              value={form.input.deadlineOn}
              onChange={(event) => edit({ ...form.input, deadlineOn: event.target.value })}
            />
          </div>
          <TextField
            id="appeal-deadline-note"
            label="기한을 확인한 원문·근거"
            value={form.input.deadlineNote}
            onChange={(deadlineNote) => edit({ ...form.input, deadlineNote })}
          />
          {form.input.reasons.map((reason, index) => (
            <AppealReasonEditor
              key={reason.id}
              company={company}
              notice={selectedNotice}
              reason={reason}
              index={index}
              onChange={(next) =>
                edit({
                  ...form.input,
                  reasons: form.input.reasons.map((item, i) => (i === index ? next : item)),
                  review: { ...form.input.review, reviewed: false },
                })
              }
              onRemove={() =>
                edit({
                  ...form.input,
                  reasons: form.input.reasons.filter((_, i) => i !== index),
                  review: { ...form.input.review, reviewed: false },
                })
              }
            />
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={form.input.reasons.length >= 20}
            onClick={() =>
              edit({
                ...form.input,
                reasons: [...form.input.reasons, newAppealReason()],
                review: { ...form.input.review, reviewed: false },
              })
            }
          >
            대응 사유 추가
          </Button>
          <div className="space-y-3 rounded-xl bg-muted/30 p-4">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.input.review.reviewed}
                onChange={(event) =>
                  edit({
                    ...form.input,
                    review: { ...form.input.review, reviewed: event.target.checked },
                  })
                }
              />
              통보 원문과 연결 근거를 대조하고 이 검토안을 내부 확인했습니다.
            </label>
            <Label htmlFor="appeal-reviewer">내부 검토자 (검토 기록 시 필수)</Label>
            <Input
              id="appeal-reviewer"
              maxLength={100}
              value={form.input.review.reviewer}
              onChange={(event) =>
                edit({
                  ...form.input,
                  review: { ...form.input.review, reviewer: event.target.value },
                })
              }
            />
            <TextField
              id="appeal-review-note"
              label="내부 검토 메모"
              value={form.input.review.note}
              onChange={(note) => edit({ ...form.input, review: { ...form.input.review, note } })}
            />
            <p className="text-xs text-muted-foreground">
              내부 확인은 법률 검토·기한 확정·기관 수용을 의미하지 않습니다.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void save()}>
              {saving ? "저장 중" : "새 버전으로 저장"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!dirty || window.confirm("저장하지 않은 소명 편집을 취소할까요?")) {
                  setForm(null);
                  setError("");
                }
              }}
            >
              소명 편집 취소
            </Button>
          </div>
        </fieldset>
      )}
      {form && !selectedNotice && (
        <Notice tone="warning">
          기준 결과 통보가 정정되었습니다. 작성 내용을 최신 통보와 다시 대조해야 합니다.
        </Notice>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {[...roots].reverse().map((root) => {
        const history = records.filter((record) => record.preparationId === root.preparationId);
        const latest = history.at(-1) ?? root;
        const notice = notices.find((entry) => entry.noticeRecordId === latest.noticeRecordId);
        return (
          <div key={root.id} className="space-y-3">
            <AppealPreparationView company={company} record={latest} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={blocked || limit || !notice}
              onClick={() => {
                if (notice) open(notice, latest);
              }}
            >
              이 준비안 새 버전 작성
            </Button>
            {history.length > 1 && (
              <details>
                <summary className="cursor-pointer text-sm">
                  이전 준비 버전 {history.length - 1}개
                </summary>
                <div className="mt-3 space-y-3">
                  {history
                    .slice(0, -1)
                    .reverse()
                    .map((record) => (
                      <AppealPreparationView key={record.id} company={company} record={record} />
                    ))}
                </div>
              </details>
            )}
          </div>
        );
      })}
    </section>
  );
}
