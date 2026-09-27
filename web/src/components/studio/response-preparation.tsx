"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AgencyRequestRecord } from "@/lib/studio-agency-records";
import type { StudioCase } from "@/lib/studio-schema";
import { compareTextExact } from "@/lib/studio-plan-diff";
import {
  validateGuidedWorkflowTarget,
  type GuidedWorkflowTarget,
} from "@/lib/studio-guided-followup";
import {
  buildLocalResponseDraft,
  preparedResponseBody,
  responsePreparationContext,
  responsePreparationInputSchema,
  responsePreparationLimits,
  type ResponsePreparation,
  type ResponsePreparationInput,
  type ResponsePreparationItem,
} from "@/lib/studio-response-preparation-types";
import { AppealEvidenceEditor } from "./appeal-preparation";
import { AnswerSuggestionsPanel } from "./answer-suggestions-panel";
import { applyResponseAnswerSuggestions } from "./answer-suggestions-ui";
import { Notice, selectClass, useDirty, type PanelProps } from "./shared";

export function latestResponseRequests(company: StudioCase): AgencyRequestRecord[] {
  const latest = new Map<string, AgencyRequestRecord>();
  for (const record of company.agencyRecords ?? [])
    if (record.kind === "request" || record.kind === "request-correction")
      latest.set(record.requestRecordId, record);
  return [...latest.values()];
}
export function newResponseItem(): ResponsePreparationItem {
  return {
    id: crypto.randomUUID(),
    requestQuote: "",
    summary: "",
    planClaim: null,
    evidence: [],
    gap: "",
    draft: "",
  };
}
export function responseInputFor(
  request: AgencyRequestRecord,
  previous?: ResponsePreparation,
): ResponsePreparationInput {
  return {
    preparationId: previous?.preparationId ?? null,
    previousVersionId: previous?.id ?? null,
    requestRecordId: request.requestRecordId,
    requestVersionId: request.id,
    title: previous?.title ?? `답변 준비: ${request.title}`.slice(0, 300),
    items: previous ? structuredClone(previous.items) : [newResponseItem()],
  };
}
export function responseSuggestionContext(
  company: Pick<StudioCase, "id" | "revision">,
  input: ResponsePreparationInput,
) {
  return JSON.stringify([company.id, company.revision, input]);
}
export function latestAgencyResponse(company: StudioCase, rootId: string) {
  return company.agencyRecords
    .filter(
      (record): record is AgencyRequestRecord =>
        record.kind === "response" && record.requestRecordId === rootId,
    )
    .at(-1);
}
export function preparedResponseAlreadyRegistered(
  company: StudioCase,
  record: ResponsePreparation,
) {
  return company.agencyRecords.some(
    (entry) => entry.kind === "response" && entry.preparedFrom?.preparationVersionId === record.id,
  );
}
export function responsePreparationSaveAcknowledged(
  saved: StudioCase | null,
  companyId: string,
  nonce: string,
  input: ResponsePreparationInput,
) {
  if (!saved || saved.id !== companyId) return false;
  const matches = saved.responsePreparations.filter((entry) => entry.clientRequestId === nonce);
  const record = matches[0];
  return (
    matches.length === 1 &&
    record.requestRecordId === input.requestRecordId &&
    record.requestVersionId === input.requestVersionId &&
    record.previousVersionId === input.previousVersionId &&
    (input.preparationId === null || record.preparationId === input.preparationId) &&
    record.title === input.title &&
    JSON.stringify(record.items) === JSON.stringify(input.items)
  );
}
export function responseRegistrationAcknowledged(
  saved: StudioCase | null,
  companyId: string,
  nonce: string,
  preparation: ResponsePreparation,
  previousResponseId: string | null,
) {
  if (!saved || saved.id !== companyId) return false;
  const matches = saved.agencyRecords.filter((entry) => entry.clientRequestId === nonce);
  const record = matches[0];
  return (
    matches.length === 1 &&
    record.kind === "response" &&
    record.responseStatus === "draft" &&
    record.preparedFrom?.preparationId === preparation.preparationId &&
    record.preparedFrom.preparationVersionId === preparation.id &&
    record.requestRecordId === preparation.requestRecordId &&
    record.requestVersionId === preparation.requestVersionId &&
    record.previousVersionId === previousResponseId &&
    record.body === preparedResponseBody(preparation).trim()
  );
}

export function ResponsePreparationEvidence({ record }: { record: ResponsePreparation }) {
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        초안 등록에 함께 연결할 근거 {record.sourceSnapshots.length}개 확인
      </summary>
      <p className="mt-2 text-xs text-muted-foreground">
        등록하면 아래 근거가 로컬 기관 답변 이력에 연결됩니다. 원본 파일 전송은 실행하지 않습니다.
      </p>
      {!record.sourceSnapshots.length && <p className="mt-2 text-xs">연결한 자료 없음</p>}
      {record.sourceSnapshots.map((source) => (
        <div key={source.sourceId} className="mt-3 space-y-1 border-t pt-2 text-xs">
          <p className="font-semibold">{source.sourceName}</p>
          <p>기준 자료 수정 시각: {source.sourceUpdatedAt}</p>
          <p>
            {source.extraction === "pending" ? "본문 미추출" : "등록 본문 있음"} ·{" "}
            {record.items.some((item) =>
              item.evidence.some((ref) => ref.sourceId === source.sourceId && !!ref.quote),
            )
              ? "선택한 원문 인용 있음"
              : "선택한 원문 인용 없음"}
          </p>
          {source.original ? (
            <>
              <p>
                원본: {source.original.originalName} · {source.original.sizeBytes.toLocaleString()}{" "}
                bytes · {source.original.mimeType}
              </p>
              <p className="break-all">저장 당시 SHA-256: {source.original.sha256}</p>
            </>
          ) : (
            <p>첨부할 원본 파일 없음</p>
          )}
          {record.items
            .flatMap((item) =>
              item.evidence
                .filter((ref) => ref.sourceId === source.sourceId)
                .map((ref) => ({ itemId: item.id, ref })),
            )
            .map(({ itemId, ref }) => (
              <blockquote key={itemId} className="whitespace-pre-wrap border-l-2 pl-2">
                {ref.quote || "원본만 연결"} · {ref.locator || "위치 미기재"}
              </blockquote>
            ))}
        </div>
      ))}
      {record.planSnapshots.map((plan) => (
        <p key={plan.planId} className="mt-3 break-all text-xs">
          연결 원고 v{plan.version} · 저장 당시 SHA-256: {plan.contentSha256}
        </p>
      ))}
      {record.items.map((item, index) => (
        <div key={item.id} className="mt-3 space-y-2 border-t pt-3 text-xs">
          <p className="font-semibold">
            대응 {index + 1}. {item.summary}
          </p>
          <p className="whitespace-pre-wrap">요청 원문 인용: {item.requestQuote}</p>
          {item.planClaim && (
            <p className="whitespace-pre-wrap">
              연결 원고 v
              {record.planSnapshots.find((plan) => plan.planId === item.planClaim?.planId)
                ?.version ?? "?"}{" "}
              · {item.planClaim.sectionKey}: {item.planClaim.quote}
            </p>
          )}
          <p className="whitespace-pre-wrap">부족한 자료·확보 이유: {item.gap || "미기재"}</p>
        </div>
      ))}
    </details>
  );
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

export function ResponseItemEditor({
  company,
  request,
  item,
  index,
  onChange,
  onRemove,
  disabled = false,
  onSuggestionBusyChange = () => {},
  onSuggestionApply,
  suggestionContextFingerprint,
}: {
  company: StudioCase;
  request: AgencyRequestRecord;
  item: ResponsePreparationItem;
  index: number;
  onChange: (item: ResponsePreparationItem) => void;
  onRemove: () => void;
  disabled?: boolean;
  onSuggestionBusyChange?: (busy: boolean) => void;
  onSuggestionApply?: (item: ResponsePreparationItem) => string | null;
  suggestionContextFingerprint?: string;
}) {
  const id = `response-item-${item.id}`;
  const plan = company.plans.find((entry) => entry.id === item.planClaim?.planId);
  const section = plan?.content.sections.find((entry) => entry.key === item.planClaim?.sectionKey);
  return (
    <fieldset className="space-y-4 rounded-xl border p-4">
      <legend className="px-2 font-semibold">대응 항목 {index + 1}</legend>
      <details>
        <summary className="cursor-pointer text-sm">기준 요청 원문 읽기</summary>
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs">
          {request.body}
        </pre>
      </details>
      <Field
        id={`${id}-request`}
        label="대응할 요청 부분을 원문 그대로 인용 *"
        value={item.requestQuote}
        max={1500}
        onChange={(requestQuote) => onChange({ ...item, requestQuote })}
      />
      <AnswerSuggestionsPanel
        company={company}
        scope={{
          kind: "agency-request",
          requestRecordId: request.requestRecordId,
          requestVersionId: request.id,
          quote: item.requestQuote,
        }}
        contextFingerprint={suggestionContextFingerprint ?? JSON.stringify(item)}
        disabled={disabled}
        hasExistingContent={!!item.draft || item.evidence.length > 0}
        onePerSource
        onBusyChange={onSuggestionBusyChange}
        onApply={(result, selected, replace) => {
          const applied = applyResponseAnswerSuggestions(
            item,
            result.binding.target,
            selected,
            replace,
          );
          if (!applied.value) return applied.error ?? "선택한 제안을 적용하지 못했습니다.";
          if (onSuggestionApply) return onSuggestionApply(applied.value);
          onChange(applied.value);
          return null;
        }}
      />
      <div className="space-y-2">
        <Label htmlFor={`${id}-summary`}>이 항목의 담당자 요약 *</Label>
        <Input
          id={`${id}-summary`}
          value={item.summary}
          maxLength={200}
          onChange={(event) => onChange({ ...item, summary: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-plan`}>관련 원고 버전 (선택)</Label>
        <select
          id={`${id}-plan`}
          className={selectClass}
          value={item.planClaim?.planId ?? ""}
          onChange={(event) =>
            onChange({
              ...item,
              planClaim: event.target.value
                ? { planId: event.target.value, sectionKey: "", quote: "" }
                : null,
            })
          }
        >
          <option value="">원고 연결 없음</option>
          {[...company.plans].reverse().map((entry) => (
            <option key={entry.id} value={entry.id}>
              원고 v{entry.version} · {entry.content.title}
            </option>
          ))}
        </select>
      </div>
      {item.planClaim && (
        <div className="space-y-3 rounded-lg border p-3">
          <Label htmlFor={`${id}-section`}>원고 항목</Label>
          <select
            id={`${id}-section`}
            className={selectClass}
            value={item.planClaim.sectionKey}
            onChange={(event) =>
              onChange({
                ...item,
                planClaim: { ...item.planClaim!, sectionKey: event.target.value, quote: "" },
              })
            }
          >
            <option value="">항목 선택</option>
            {plan?.content.sections.map((entry, i) => (
              <option key={`${entry.key}-${i}`} value={entry.key}>
                {entry.title}
              </option>
            ))}
          </select>
          {section && (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-xs">
              {section.content}
            </pre>
          )}
          <Field
            id={`${id}-plan-quote`}
            label="해당 원고 부분 그대로 인용 *"
            value={item.planClaim.quote}
            max={1500}
            onChange={(quote) => onChange({ ...item, planClaim: { ...item.planClaim!, quote } })}
          />
        </div>
      )}
      <AppealEvidenceEditor
        company={company}
        prefix={`${id}-evidence`}
        label="답변 근거 자료"
        references={item.evidence}
        maxReferences={6}
        onChange={(evidence) => onChange({ ...item, evidence })}
      />
      <p className="text-xs text-muted-foreground">
        한 대응 항목에 자료 최대 6개, 전체 준비안에 서로 다른 자료 최대 10개를 연결합니다.
      </p>
      <Field
        id={`${id}-gap`}
        label="부족한 자료와 확보할 이유"
        value={item.gap}
        onChange={(gap) => onChange({ ...item, gap })}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          if (
            !item.draft ||
            window.confirm("작성한 답변을 선택 근거를 배치한 미검토 초안으로 바꿀까요?")
          )
            onChange({ ...item, draft: buildLocalResponseDraft(item) });
        }}
      >
        선택 근거로 답변 틀 채우기
      </Button>
      <p className="text-xs text-muted-foreground">
        이 PC에서 선택한 문장을 배치합니다. 새 사실이나 미확인 답변은 만들지 않습니다.
      </p>
      <Field
        id={`${id}-draft`}
        label="담당자가 검토할 답변 초안"
        value={item.draft}
        max={responsePreparationLimits.body}
        onChange={(draft) => onChange({ ...item, draft })}
      />
      <Button type="button" variant="outline" size="sm" onClick={onRemove}>
        이 대응 항목 제거
      </Button>
    </fieldset>
  );
}

export function ResponsePreparationComparison({
  record,
  previous,
  response,
}: {
  record: ResponsePreparation;
  previous?: ResponsePreparation;
  response?: ReturnType<typeof latestAgencyResponse>;
}) {
  const options = [
    ...(previous
      ? [
          {
            key: "preparation",
            label: `이전 준비 v${previous.version}`,
            body: preparedResponseBody(previous),
          },
        ]
      : []),
    ...(response
      ? [
          {
            key: "response",
            label: `기존 기관 답변 v${response.version} · ${response.responseStatus === "reported-sent" ? "담당자 발송 기록" : "초안"}`,
            body: response.body,
          },
        ]
      : []),
  ];
  const [selected, setSelected] = useState(options[0]?.key ?? "");
  const before = options.find((option) => option.key === selected) ?? options[0];
  const after = preparedResponseBody(record);
  const diff = before ? compareTextExact(before.body, after) : null;
  const id = `response-compare-${record.id}`;
  if (!before)
    return (
      <p className="text-xs text-muted-foreground">비교할 이전 답변이나 준비 버전이 없습니다.</p>
    );
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer text-sm font-medium">수정 전후 답변 비교</summary>
      <div className="my-3 space-y-2">
        <Label htmlFor={id}>비교 기준 버전</Label>
        <select
          id={id}
          className={selectClass}
          value={before.key}
          onChange={(event) => setSelected(event.target.value)}
        >
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <p className="mb-3 text-xs">
        본문 {before.body === after ? "동일" : "변경됨"} · 문구 비교이며 사실 확인·기관 수용 판정은
        아닙니다.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h5 className="mb-2 text-sm font-semibold">{before.label}</h5>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-6">
            {before.body}
          </pre>
        </div>
        <div>
          <h5 className="mb-2 text-sm font-semibold">현재 준비 v{record.version}</h5>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-6">
            {after}
          </pre>
        </div>
      </div>
      {diff?.complete && diff.state === "changed" && (
        <div className="mt-3 rounded-lg border p-3">
          <h5 className="mb-2 text-sm font-semibold">변경 부분 · [−] 삭제 / [+] 추가</h5>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">
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
                {span.kind === "added" ? "[+] " : span.kind === "removed" ? "[−] " : ""}
                {span.text}
              </span>
            ))}
          </pre>
        </div>
      )}
      {diff && !diff.complete && (
        <p className="mt-2 text-xs">
          긴 본문은 위 원문으로 비교합니다. 변경 부분 강조는 생략했습니다.
        </p>
      )}
    </details>
  );
}

type Form = {
  input: ResponsePreparationInput;
  baseline: string;
  nonce: string;
  binding: string;
  request: AgencyRequestRecord;
};

/** Opens only one exact current-request draft. Older or ambiguous drafts remain readable. */
export function guidedResponsePreparation(company: StudioCase, target?: GuidedWorkflowTarget) {
  if (target?.kind !== "response" || !validateGuidedWorkflowTarget(company, target).valid)
    return null;
  const request = latestResponseRequests(company).find(
    (entry) => entry.id === target.requestVersionId,
  )!;
  const records = company.responsePreparations ?? [];
  const roots = records.filter(
    (entry) => entry.previousVersionId === null && entry.requestRecordId === target.requestRecordId,
  );
  const previous =
    roots.length === 1
      ? (records.filter((entry) => entry.preparationId === roots[0].preparationId).at(-1) ?? null)
      : null;
  const reason =
    records.length >= responsePreparationLimits.versions
      ? "답변 준비 버전 한도에 도달했습니다. 기존 준비안을 확인해 주세요."
      : roots.length > 1
        ? "이 요청의 준비안이 여러 개입니다. 아래에서 이어 쓸 준비안을 선택해 주세요."
        : previous && previous.requestVersionId !== target.requestVersionId
          ? "이전 요청 기준의 준비안이 있습니다. 정정된 요청과 비교한 뒤 새 버전 작성을 선택해 주세요."
          : "";
  return { request, previous, canEdit: !reason, reason };
}

/** Refresh display only after a valid entry. Never writes or reopens an editor. */
export function guidedResponseGuidance(
  company: StudioCase,
  target: GuidedWorkflowTarget | undefined,
  acceptedEntry: boolean,
) {
  return acceptedEntry && target
    ? guidedResponsePreparation(company, { ...target, companyRevision: company.revision })
    : null;
}

type Props = Pick<PanelProps, "company" | "mutate"> & {
  blockedReason: string;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange?: (message: string) => void;
  guidedTarget?: GuidedWorkflowTarget;
};

export function ResponsePreparations({
  company,
  mutate,
  blockedReason,
  onDirtyChange,
  onBusyChange,
  guidedTarget,
}: Props) {
  const [guidedSelection] = useState(() => guidedResponsePreparation(company, guidedTarget));
  const [entryTarget] = useState(guidedTarget);
  const [form, setForm] = useState<Form | null>(() => {
    if (!guidedSelection?.canEdit || blockedReason) return null;
    const input = responseInputFor(guidedSelection.request, guidedSelection.previous ?? undefined);
    return {
      input,
      baseline: JSON.stringify(input),
      nonce: crypto.randomUUID(),
      binding: `${company.id}:${company.revision}`,
      request: structuredClone(guidedSelection.request),
    };
  });
  const [guidedFocus] = useState(() =>
    !guidedSelection
      ? null
      : form
        ? "response-preparation-title"
        : guidedSelection.previous
          ? `response-preparation-${guidedSelection.previous.id}`
          : `response-request-${guidedSelection.request.id}`,
  );
  const [saving, setSaving] = useState(false);
  const [suggestionBusy, setSuggestionBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(false);
  const registrations = useRef(new Map<string, string>());
  const binding = `${company.id}:${company.revision}`;
  const context = useRef(binding);
  useEffect(() => {
    if (!guidedFocus) return;
    const element = document.getElementById(guidedFocus);
    element?.scrollIntoView({ block: "start" });
    element?.focus({ preventScroll: true });
  }, [guidedFocus]);
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
  useDirty(dirty || saving || suggestionBusy, onDirtyChange);
  const blocked = !!blockedReason || saving || suggestionBusy;
  const requests = latestResponseRequests(company);
  const records = company.responsePreparations ?? [];
  const roots = records.filter((entry) => entry.previousVersionId === null);
  const selectedRequest = form
    ? (company.agencyRecords.find(
        (entry): entry is AgencyRequestRecord =>
          (entry.kind === "request" || entry.kind === "request-correction") &&
          entry.id === form.input.requestVersionId,
      ) ?? form.request)
    : undefined;
  const limit = records.length >= responsePreparationLimits.versions;
  const currentGuidance = guidedResponseGuidance(
    company,
    guidedTarget,
    !!guidedSelection && JSON.stringify(entryTarget) === JSON.stringify(guidedTarget),
  );
  function open(request: AgencyRequestRecord, previous?: ResponsePreparation) {
    if (
      blocked ||
      limit ||
      (dirty && !window.confirm("저장하지 않은 답변 준비 편집을 취소할까요?"))
    )
      return;
    const input = responseInputFor(request, previous);
    setForm({
      input,
      baseline: JSON.stringify(input),
      nonce: crypto.randomUUID(),
      binding,
      request: structuredClone(request),
    });
    setError("");
  }
  function edit(input: ResponsePreparationInput) {
    if (form && !blocked) setForm({ ...form, input, nonce: crypto.randomUUID() });
  }
  async function save() {
    if (!form || blocked || pending.current) return;
    if (form.binding !== binding) {
      setError("기업 기록이 변경되었습니다. 최신 요청과 자료를 다시 확인해 주세요.");
      return;
    }
    const parsed = responsePreparationInputSchema.safeParse(form.input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "요청 인용과 입력 내용을 확인해 주세요.");
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await mutate({
        action: "append-response-preparation",
        clientRequestId: form.nonce,
        preparation: parsed.data,
      });
      if (mounted.current && context.current === binding) {
        if (responsePreparationSaveAcknowledged(saved, company.id, form.nonce, parsed.data))
          setForm(null);
        else
          setError(
            "저장 결과를 확인하지 못했습니다. 편집 내용은 유지했습니다. 최신 기록을 확인해 주세요.",
          );
      }
    } catch {
      if (mounted.current && context.current === binding)
        setError("저장하지 못했습니다. 최신 기록을 확인한 뒤 다시 준비해 주세요.");
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  async function register(record: ResponsePreparation) {
    if (blocked || dirty || pending.current || preparedResponseAlreadyRegistered(company, record))
      return;
    const previous = latestAgencyResponse(company, record.requestRecordId);
    const key = `${record.id}:${previous?.id ?? "none"}`;
    const nonce = registrations.current.get(key) ?? crypto.randomUUID();
    registrations.current.set(key, nonce);
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const saved = await mutate({
        action: "register-prepared-response",
        clientRequestId: nonce,
        preparationId: record.preparationId,
        preparationVersionId: record.id,
        previousResponseId: previous?.id ?? null,
      });
      if (
        mounted.current &&
        context.current === binding &&
        !responseRegistrationAcknowledged(saved, company.id, nonce, record, previous?.id ?? null)
      )
        setError(
          "초안 등록 결과를 확인하지 못했습니다. 새 답변을 만들기 전에 기관 기록을 확인해 주세요.",
        );
    } catch {
      if (mounted.current && context.current === binding)
        setError("초안 등록을 확인하지 못했습니다. 같은 요청 번호를 보존했습니다.");
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <section aria-label="보완 답변 작성 보조" className="my-7 space-y-4 rounded-2xl border p-5">
      <h3 className="font-bold">보완 답변 작성 보조</h3>
      <p className="text-sm leading-6 text-muted-foreground">
        요청의 정확한 부분과 원고·자료를 연결해 답변 틀을 만들고 수정 전후를 비교합니다. 로컬 제안이
        기본이며 외부 AI 제안은 전송 본문 확인·별도 동의 후 실행합니다. 기관으로 발송하지 않습니다.
      </p>
      <Notice>
        준비안은 항상 미검토 초안입니다. 저장한 최신 준비안을 직접 선택해 기관 기록의 답변 초안으로
        등록할 수 있습니다. 발송 여부와 내용 검토는 별도로 확인합니다.
      </Notice>
      {blockedReason && <p className="text-sm text-amber-900">{blockedReason}</p>}
      {currentGuidance?.reason && (
        <p className="text-sm text-amber-900">{currentGuidance.reason}</p>
      )}
      {guidedTarget?.kind === "response" &&
        (!guidedSelection ||
          JSON.stringify(entryTarget) !== JSON.stringify(guidedTarget) ||
          !validateGuidedWorkflowTarget(company, {
            ...guidedTarget,
            companyRevision: company.revision,
          }).valid) && (
          <p role="alert" className="text-sm text-amber-900">
            기업이나 요청 버전이 변경되었습니다. 입력은 보존하며 다른 요청으로 바꾸지 않습니다.
          </p>
        )}
      {limit && (
        <p className="text-sm text-amber-900">
          답변 준비 버전 50개 한도에 도달했습니다. 이전 기록은 보존합니다.
        </p>
      )}
      {!requests.length && <p className="text-sm">기관 요청 원문을 먼저 기록해 주세요.</p>}
      {requests.map((request) => {
        const selection = guidedResponsePreparation(company, {
          caseId: company.id,
          companyRevision: company.revision,
          kind: "response",
          requestRecordId: request.requestRecordId,
          requestVersionId: request.id,
        });
        const hasPreparation = roots.some(
          (root) => root.requestRecordId === request.requestRecordId,
        );
        return (
          <div
            key={request.id}
            id={`response-request-${request.id}`}
            tabIndex={-1}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/25 p-3"
          >
            <a className="text-sm underline" href={`#agency-record-${request.id}`}>
              {request.title} · 요청 v{request.version}
            </a>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto min-h-11 max-w-full whitespace-normal break-words"
              disabled={blocked || limit || !selection?.canEdit}
              onClick={() => {
                if (selection?.canEdit) open(request, selection.previous ?? undefined);
              }}
            >
              {hasPreparation
                ? selection?.canEdit
                  ? "이 요청의 답변 이어 작성"
                  : "아래 준비안에서 이어 작성"
                : "이 요청의 답변 준비"}
            </Button>
          </div>
        );
      })}
      {form && selectedRequest && (
        <fieldset disabled={blocked} className="space-y-4 rounded-xl border border-primary/30 p-4">
          <legend className="px-2 font-semibold">답변 준비 편집</legend>
          <p className="text-xs">
            기준 요청: {selectedRequest.title} · 요청 v{selectedRequest.version}
          </p>
          {form.binding !== binding && (
            <p role="alert" className="text-sm text-amber-900">
              기업 기록이 변경되어 저장을 멈췄습니다. 작성한 내용은 보존했습니다. 최신 원문을 확인한
              뒤 다시 작성해 주세요.
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="response-preparation-title">답변 준비안 제목 *</Label>
            <Input
              id="response-preparation-title"
              value={form.input.title}
              maxLength={300}
              onChange={(event) => edit({ ...form.input, title: event.target.value })}
            />
          </div>
          {form.input.items.map((item, index) => (
            <ResponseItemEditor
              key={item.id}
              company={company}
              request={selectedRequest}
              item={item}
              index={index}
              disabled={blocked || form.binding !== binding}
              suggestionContextFingerprint={responseSuggestionContext(company, form.input)}
              onSuggestionBusyChange={(value) => {
                setSuggestionBusy(value);
                onBusyChange?.(value ? "선택 자료의 답변 근거 제안을 확인하는 중입니다" : "");
              }}
              onSuggestionApply={(next) => {
                if (blocked || form.binding !== binding)
                  return "기업·편집 상태가 바뀌었습니다. 제안을 다시 확인해 주세요.";
                const input = {
                  ...form.input,
                  items: form.input.items.map((entry, i) => (i === index ? next : entry)),
                };
                if (
                  preparedResponseBody(input).length > 20_000 ||
                  new Set(input.items.flatMap((entry) => entry.evidence.map((ref) => ref.sourceId)))
                    .size > 10
                )
                  return "준비안 전체 본문 20,000자·자료 10개 한도를 넘습니다. 선택을 줄여 주세요.";
                edit(input);
                return null;
              }}
              onChange={(next) =>
                edit({
                  ...form.input,
                  items: form.input.items.map((entry, i) => (i === index ? next : entry)),
                })
              }
              onRemove={() =>
                edit({ ...form.input, items: form.input.items.filter((_, i) => i !== index) })
              }
            />
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={form.input.items.length >= responsePreparationLimits.items}
            onClick={() => edit({ ...form.input, items: [...form.input.items, newResponseItem()] })}
          >
            대응 항목 추가
          </Button>
          <p className="text-xs">
            합쳐진 답변 본문 {preparedResponseBody(form.input).length.toLocaleString()} / 20,000자
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={form.binding !== binding} onClick={() => void save()}>
              답변 준비 새 버전 저장
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (!dirty || window.confirm("작성 중인 답변 준비를 취소할까요?")) {
                  setForm(null);
                  setError("");
                }
              }}
            >
              답변 준비 편집 취소
            </Button>
          </div>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {[...roots].reverse().map((root) => {
        const history = records.filter((entry) => entry.preparationId === root.preparationId);
        const record = history.at(-1) ?? root;
        const current = responsePreparationContext(company, record);
        const request = requests.find((entry) => entry.requestRecordId === record.requestRecordId);
        const exactRequest = company.agencyRecords.find(
          (entry) => entry.id === record.requestVersionId,
        );
        const registered = preparedResponseAlreadyRegistered(company, record);
        return (
          <article
            key={root.id}
            id={`response-preparation-${record.id}`}
            tabIndex={-1}
            className="space-y-3 rounded-xl border p-4"
          >
            <h4 className="font-semibold">
              {record.title} · 준비 v{record.version}
            </h4>
            <p className="text-xs">
              기준 요청: {exactRequest?.title || "확인 필요"} · v{exactRequest?.version ?? "?"} ·
              미검토 초안
            </p>
            <p className="text-xs">
              등록내용 연결: {current.state === "current" ? "유지됨" : "재확인 필요"}. 원본은 저장
              시 대조했으며 현재 파일을 다시 검사한 결과는 아닙니다.
            </p>
            {!!current.issues.length && (
              <ul className="list-inside list-disc text-xs text-amber-900">
                {current.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
            <details open={guidedSelection?.previous?.id === record.id || undefined}>
              <summary className="cursor-pointer text-sm">준비한 답변 초안 펼치기</summary>
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-sm leading-6">
                {preparedResponseBody(record)}
              </pre>
            </details>
            <ResponsePreparationComparison
              record={record}
              previous={history.at(-2)}
              response={latestAgencyResponse(company, record.requestRecordId)}
            />
            <ResponsePreparationEvidence record={record} />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto min-h-11 max-w-full whitespace-normal break-words"
                disabled={blocked || limit || !request}
                onClick={() => {
                  if (request) open(request, record);
                }}
              >
                답변 준비 새 버전 작성
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={
                  blocked ||
                  dirty ||
                  current.state !== "current" ||
                  registered ||
                  company.agencyRecords.length >= 200
                }
                onClick={() => void register(record)}
              >
                {registered ? "이 준비 버전은 답변 초안으로 등록됨" : "기관 기록에 답변 초안 등록"}
              </Button>
            </div>
            {registered && (
              <p className="text-xs text-muted-foreground">
                위 기관 요청·답변 이력에 로컬 초안이 연결됐습니다. 기관 발송 기록으로 변경하지
                않았습니다.
              </p>
            )}
            {history.length > 1 && (
              <details>
                <summary className="cursor-pointer text-sm">
                  이전 답변 준비 {history.length - 1}개
                </summary>
                {history
                  .slice(0, -1)
                  .reverse()
                  .map((past) => (
                    <div key={past.id} className="mt-3 border-t pt-3">
                      <p className="text-sm font-semibold">
                        {past.title} · 준비 v{past.version}
                      </p>
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs">
                        {preparedResponseBody(past)}
                      </pre>
                      <ResponsePreparationEvidence record={past} />
                    </div>
                  ))}
              </details>
            )}
          </article>
        );
      })}
    </section>
  );
}
