"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { caseSchema, sourceKindLabels, type StudioCase } from "@/lib/studio-schema";
import type { SourceCoordinate } from "@/lib/studio-source-location-types";
import {
  sourceSuggestionTargetLabels,
  sourceSuggestionTargets,
  sourceSuggestionLimits,
  type SourceSuggestionReceipt,
  type SourceSuggestionTarget,
  type SourceSuggestionsPreview,
} from "@/lib/studio-source-suggestion-types";
import { Notice, formatDate, selectClass, useDirty } from "./shared";
import {
  selectedSuggestionInput,
  suggestionAdoptionAcknowledged,
  suggestionBasisOptions,
  suggestionRequestCanClose,
  sendSourceSuggestionAdoption,
  SourceSuggestionHttpError,
  validateSourceSuggestions,
  type SuggestionChoices,
  type SuggestionPending,
} from "./source-suggestions-ui";

export function suggestionDisplayValue(target: SourceSuggestionTarget, value: string) {
  if (!value) return "미기록";
  if (target === "sourceKind")
    return sourceKindLabels[value as keyof typeof sourceKindLabels] ?? value;
  if (target === "paidInCapital") return `${value}원`;
  if (target === "closingMonth") return `${value}월`;
  return value;
}
export function SourceSuggestionPosition({
  position,
}: {
  position: {
    start: number;
    end: number;
    lineStart: number;
    lineEnd: number;
    coordinate: SourceCoordinate | null;
  };
}) {
  const coordinate = position.coordinate;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        본문{" "}
        {position.lineStart === position.lineEnd
          ? `${position.lineStart}줄`
          : `${position.lineStart}~${position.lineEnd}줄`}
      </p>
      {coordinate ? (
        <p>
          {coordinate.kind === "pdf-page"
            ? `추출된 PDF ${coordinate.pageNumber}페이지`
            : coordinate.kind === "ocr-page"
              ? `Windows OCR ${coordinate.pageNumber}페이지`
              : coordinate.kind === "spreadsheet-cell"
                ? `시트 ${coordinate.sheetIndex} · ${coordinate.sheetName} · ${coordinate.address} (${coordinate.row}행 ${coordinate.column}열)`
                : `${coordinate.format.toUpperCase()} ${coordinate.startLabel}~${coordinate.endLabel}${coordinate.cueId ? ` · 구간 ${coordinate.cueId}` : ""}`}
        </p>
      ) : (
        <p>페이지·시트·시간 좌표 미확인 · 본문의 위치 설명에서 추정하지 않습니다.</p>
      )}
      <details>
        <summary>정확한 문자 구간</summary>
        <p>
          UTF-16 [{position.start}, {position.end}) · 끝 위치 제외
        </p>
      </details>
    </div>
  );
}
export function SourceSuggestionChoices({
  company,
  preview,
  choices,
  reviewed,
  disabled,
  onSelect,
  onReviewed,
}: {
  company: StudioCase;
  preview: SourceSuggestionsPreview;
  choices: SuggestionChoices;
  reviewed: boolean;
  disabled: boolean;
  onSelect: (target: SourceSuggestionTarget, candidateId: string) => void;
  onReviewed: (reviewed: boolean) => void;
}) {
  const prefix = useId();
  const current = preview.companyRevision === company.revision;
  return (
    <fieldset disabled={disabled || !current} className="space-y-4">
      <Notice>
        규칙으로 찾은 미검토 제안입니다. 값의 진위·최신성·기업 요건 충족을 확인한 결과가 아닙니다.
        원문과 현재 값을 대조해 항목별로 선택해 주세요.
      </Notice>
      {!current && (
        <Notice tone="warning">
          기업 자료가 바뀌어 이 제안을 채택할 수 없습니다. 최신 자료에서 새로 제안받아 주세요.
        </Notice>
      )}
      <p className="text-xs">
        규칙 버전: {preview.ruleVersion} ·{" "}
        {preview.binding.basis.kind === "intake-result"
          ? "보관한 미검토 판독 결과 기준"
          : "현재 등록 본문 기준"}
      </p>
      {preview.binding.original && (
        <div className="space-y-2 text-xs">
          <a
            className="underline"
            download
            href={`/api/studio/cases/${company.id}/sources/${preview.binding.sourceId}`}
          >
            현재 보관 원본 내려받아 대조
          </a>
          <p>다운로드는 현재 파일입니다. 채택할 때 제안 당시의 원본 해시와 다시 대조합니다.</p>
          <details>
            <summary>제안 당시 원본 식별값</summary>
            <p className="break-words">{preview.binding.original.originalName}</p>
            <p className="break-all">SHA-256: {preview.binding.original.sha256}</p>
          </details>
        </div>
      )}
      <Notice tone={preview.profileAllowed ? "info" : "warning"}>
        기업번호 대조:{" "}
        {preview.identity.status === "matched"
          ? "표기 일치"
          : preview.identity.status === "mismatch"
            ? "불일치"
            : "미확인"}
        . {preview.identity.reason}
        {!preview.profileAllowed &&
          " 기업정보 후보는 채택할 수 없습니다. 자료 종류는 원문과 대조한 뒤 별도로 선택할 수 있습니다."}
      </Notice>
      {sourceSuggestionTargets.map((target) => {
        const candidates = preview.candidates.filter((entry) => entry.target === target);
        if (!candidates.length) return null;
        const targetBlock = preview.blockedTargets.find((entry) => entry.target === target);
        const unavailable =
          Boolean(targetBlock) || (target !== "sourceKind" && !preview.profileAllowed);
        return (
          <fieldset key={target} disabled={unavailable} className="space-y-3 rounded-xl border p-4">
            <legend className="px-2 text-sm font-semibold">
              {sourceSuggestionTargetLabels[target]}
            </legend>
            {targetBlock && <Notice tone="warning">{targetBlock.reason}</Notice>}
            <p className="text-sm">
              현재 값:{" "}
              <strong className="whitespace-pre-wrap break-words">
                {suggestionDisplayValue(target, candidates[0].currentValue)}
              </strong>
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${prefix}-${target}`}
                checked={!choices[target]}
                onChange={() => onSelect(target, "")}
              />
              선택하지 않음
            </label>
            {candidates.map((candidate) => (
              <article
                key={candidate.id}
                className="block space-y-2 rounded-lg border bg-muted/20 p-3"
              >
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    className="mt-1"
                    name={`${prefix}-${target}`}
                    checked={choices[target] === candidate.id}
                    onChange={() => onSelect(target, candidate.id)}
                  />
                  <span>
                    제안 값:{" "}
                    <strong className="break-words">
                      {suggestionDisplayValue(target, candidate.value)}
                    </strong>
                  </span>
                </label>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm leading-6">
                  {candidate.quote}
                </pre>
                <SourceSuggestionPosition position={candidate} />
              </article>
            ))}
          </fieldset>
        );
      })}
      {preview.candidates.length === 0 && (
        <p className="text-sm">
          명시된 표기에서 채택 가능한 값을 찾지 못했습니다. 필요한 값은 원본을 확인한 뒤
          기업정보에서 직접 기록할 수 있습니다.
        </p>
      )}
      {preview.unresolved.length > 0 && (
        <section aria-label="추가 확인할 원문" className="space-y-3">
          <h4 className="text-sm font-semibold">확인할 항목</h4>
          {preview.unresolved.map((entry, index) => (
            <article
              key={`${entry.code}:${entry.start}:${index}`}
              className="space-y-2 rounded-lg border p-3"
            >
              <p className="text-sm">{entry.message}</p>
              <pre className="whitespace-pre-wrap break-words text-xs">{entry.quote}</pre>
              <SourceSuggestionPosition position={entry} />
            </article>
          ))}
        </section>
      )}
      <label className="flex items-start gap-2 text-sm leading-6">
        <input
          type="checkbox"
          className="mt-1"
          checked={current && reviewed}
          onChange={(event) => onReviewed(event.target.checked)}
        />
        <span>
          선택한 원문과 현재 값을 대조했으며, 선택값만 자료 종류·기업정보에 채택하는 내용을
          확인했습니다. 판독 본문 전체를 분석 근거로 채택하는 것은 아닙니다.
        </span>
      </label>
      <p className="text-xs">
        채택하면 해당 근거에 의존한 분석과 원고는 재검토가 필요합니다. 과거 원고·기관 기록은 자동
        수정하지 않습니다.
      </p>
    </fieldset>
  );
}
export function SourceSuggestionReceiptView({ receipt }: { receipt: SourceSuggestionReceipt }) {
  return (
    <article
      className="space-y-3 rounded-xl border p-4"
      aria-label={`제안 채택 기록 v${receipt.version}`}
    >
      <div className="flex flex-wrap gap-2">
        <h4 className="text-sm font-semibold">채택 기록 v{receipt.version}</h4>
        <Badge variant="outline">담당자 선택 기록</Badge>
      </div>
      <p className="text-xs">
        {formatDate(receipt.recordedAt)} · {receipt.binding.ruleVersion} ·{" "}
        {receipt.binding.basis.kind === "intake-result" ? "보관 판독 결과" : "등록 본문"} 기준
      </p>
      <p className="text-xs">
        당시 선택값·인용을 보존한 기록입니다. 현재 값·원본의 최신성이나 사실 검증 완료를 뜻하지
        않습니다.
      </p>
      {receipt.selections.map((entry) => (
        <div key={entry.candidateId} className="space-y-2 rounded-lg bg-muted/20 p-3">
          <p className="text-sm font-semibold">{sourceSuggestionTargetLabels[entry.target]}</p>
          <p className="whitespace-pre-wrap break-words text-sm">
            {suggestionDisplayValue(entry.target, entry.previousValue)} →{" "}
            {suggestionDisplayValue(entry.target, entry.value)}
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
            {entry.quote}
          </pre>
          <SourceSuggestionPosition position={entry} />
        </div>
      ))}
      <details className="text-xs">
        <summary>당시 근거 식별값</summary>
        <p className="break-all">본문 SHA-256: {receipt.binding.textSha256}</p>
        {receipt.binding.original && (
          <>
            <p className="break-words">보관 원본: {receipt.binding.original.originalName}</p>
            <p className="break-all">원본 SHA-256: {receipt.binding.original.sha256}</p>
          </>
        )}
        <p>자료 수정시각: {formatDate(receipt.binding.sourceUpdatedAt)}</p>
      </details>
    </article>
  );
}

type Props = {
  company: StudioCase;
  busy: boolean;
  blockedReason?: string;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (message: string) => void;
  onCompany: (company: StudioCase) => void;
};
type Editor = { preview: SourceSuggestionsPreview; choices: SuggestionChoices; reviewed: boolean };
export function SourceSuggestionsPanel(props: Props) {
  return <SourceSuggestionsPanelInner key={props.company.id} {...props} />;
}
function SourceSuggestionsPanelInner({
  company,
  busy,
  blockedReason = "",
  onDirtyChange,
  onBusyChange,
  onCompany,
}: Props) {
  const prefix = useId();
  const [sourceId, setSourceId] = useState(""),
    [basisKey, setBasisKey] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null),
    [pending, setPending] = useState<SuggestionPending | null>(null);
  const [loading, setLoading] = useState(false),
    [checkedPending, setCheckedPending] = useState<number | null>(null),
    [definitelyRejected, setDefinitelyRejected] = useState(false),
    [errorCode, setErrorCode] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const mounted = useRef(false),
    inFlight = useRef(false),
    current = useRef(company);
  const activeEditor = editor?.preview.companyRevision === company.revision ? editor : null;
  const stale = Boolean(editor && !activeEditor);
  const options = suggestionBasisOptions(company, sourceId),
    basis = options.find((entry) => entry.key === basisKey);
  const blocked = Boolean(blockedReason) || busy || loading;
  const input = activeEditor
    ? selectedSuggestionInput(
        company,
        activeEditor.preview,
        activeEditor.choices,
        activeEditor.reviewed,
      )
    : null;
  const records = company.sourceSuggestionAdoptions ?? [];
  const atLimit = records.length >= sourceSuggestionLimits.receipts;
  useEffect(() => {
    current.current = company;
  }, [company]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useDirty(Boolean(activeEditor || pending || loading), onDirtyChange);

  function begin(label: string, global = true) {
    inFlight.current = true;
    setLoading(true);
    setError("");
    setErrorCode("");
    setMessage("");
    if (global) onBusyChange(label);
  }
  function finish(global = true) {
    inFlight.current = false;
    if (mounted.current) {
      setLoading(false);
      if (global) onBusyChange("");
    }
  }
  async function preview() {
    if (blocked || inFlight.current || pending || !basis) return;
    const baseline = current.current,
      request = { revision: baseline.revision, sourceId, basis: basis.basis };
    begin("등록 본문에서 미검토 제안을 준비하는 중입니다");
    setEditor(null);
    try {
      const response = await fetch(`/api/studio/cases/${baseline.id}/source-suggestions/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        cache: "no-store",
      });
      const raw: unknown = await response.json().catch(() => null);
      const result = response.ok ? await validateSourceSuggestions(raw, baseline, request) : null;
      if (!mounted.current) return;
      if (
        !result ||
        current.current.id !== baseline.id ||
        current.current.revision !== baseline.revision
      )
        throw new Error();
      setEditor({ preview: result, choices: {}, reviewed: false });
      setCheckedPending(null);
    } catch {
      if (mounted.current)
        setError(
          "현재 자료·원본·판독 결과와 맞는 제안을 확인하지 못했습니다. 최신 자료에서 다시 준비해 주세요. 자료 종류와 기업정보는 변경하지 않았습니다.",
        );
    } finally {
      finish();
    }
  }
  async function send(value: SuggestionPending) {
    if (
      blocked ||
      inFlight.current ||
      value.companyId !== company.id ||
      value.revision !== company.revision
    )
      return;
    begin("선택한 제안의 채택 기록을 저장하는 중입니다");
    setPending(value);
    setCheckedPending(null);
    setDefinitelyRejected(false);
    try {
      const response = await sendSourceSuggestionAdoption(value);
      if (!mounted.current) return;
      const saved = suggestionAdoptionAcknowledged(
        response,
        value,
        Math.max(value.revision, current.current.revision),
      );
      if (!saved) throw new Error();
      current.current = saved;
      onCompany(saved);
      setPending(null);
      setEditor(null);
      setMessage(
        "선택한 제안의 채택 기록을 확인했습니다. 변경된 근거로 분석과 원고를 다시 검토해 주세요.",
      );
    } catch (caught) {
      if (mounted.current) {
        const rejected = caught instanceof SourceSuggestionHttpError && caught.rejected;
        setDefinitelyRejected(rejected);
        setErrorCode(
          caught instanceof SourceSuggestionHttpError ? caught.code : "SUGGESTION_RESULT_UNKNOWN",
        );
        setError(
          rejected
            ? "채택 요청이 거절되었습니다. 보낸 선택값과 요청 번호는 보존합니다. 저장된 기록을 확인한 뒤 원문·현재 값 조건을 다시 검토하고 새 제안을 준비할 수 있습니다."
            : "채택 결과를 확인하지 못했습니다. 보낸 선택값과 요청 번호를 보존했습니다. 저장된 기록을 확인하기 전에는 새 채택 요청을 보내지 않습니다.",
        );
      }
    } finally {
      finish();
    }
  }
  async function checkSaved() {
    if (blocked || inFlight.current || !pending) return;
    const request = pending;
    begin("기업의 저장된 채택 기록만 확인하는 중입니다");
    try {
      const response = await fetch(`/api/studio/cases/${request.companyId}`, { cache: "no-store" });
      const parsed = caseSchema.safeParse(await response.json().catch(() => null));
      if (!mounted.current) return;
      if (
        !response.ok ||
        !parsed.success ||
        parsed.data.id !== request.companyId ||
        parsed.data.revision < Math.max(request.revision, current.current.revision)
      )
        throw new Error();
      const saved = suggestionAdoptionAcknowledged(parsed.data, request, current.current.revision);
      current.current = parsed.data;
      onCompany(parsed.data);
      setCheckedPending(parsed.data.revision);
      if (saved) {
        setPending(null);
        setEditor(null);
        setMessage(
          "이 요청의 채택 기록을 확인했습니다. 같은 채택을 다시 실행하지 않습니다. 이후 변경은 현재 자료에서 확인해 주세요.",
        );
      } else
        setError(
          "이 요청의 정확한 채택 기록을 아직 확인하지 못했습니다. 확인된 성공으로 표시하지 않습니다. 같은 선택값·요청 번호로 결과를 다시 확인할 수 있습니다.",
        );
    } catch {
      if (mounted.current)
        setError(
          "최신 채택 기록을 확인하지 못했습니다. 자동 재시도하거나 새 요청 번호를 만들지 않았습니다.",
        );
    } finally {
      finish();
    }
  }
  return (
    <section aria-label="자료 분류·기업정보 제안" className="mb-7 space-y-4 rounded-2xl border p-5">
      <h3 className="font-bold">자료 분류·기업정보 제안</h3>
      <Notice>
        현재 본문 또는 직접 고른 판독 결과의 명시 표기에서 로컬 규칙으로 제안합니다. 외부 AI
        전송·자동 적용·사실 확정을 하지 않습니다. 모호한 값은 확인할 항목으로 남깁니다.
      </Notice>
      {blockedReason && <Notice tone="warning">{blockedReason}</Notice>}
      {atLimit && (
        <Notice tone="warning">
          제안 채택 이력 {sourceSuggestionLimits.receipts}개 한도입니다. 이전 기록을 보존하며 새
          채택은 추가할 수 없습니다.
        </Notice>
      )}
      <fieldset disabled={blocked || !!pending} className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-source`}>제안에 사용할 자료</Label>
          <select
            id={`${prefix}-source`}
            className={selectClass}
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
              setBasisKey("");
              setEditor(null);
              setError("");
            }}
          >
            <option value="">자료 직접 선택</option>
            {company.sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${prefix}-basis`}>정확한 본문·판독 결과</Label>
          <select
            id={`${prefix}-basis`}
            className={selectClass}
            value={basisKey}
            onChange={(event) => {
              setBasisKey(event.target.value);
              setEditor(null);
              setError("");
            }}
          >
            <option value="">사용할 버전 직접 선택</option>
            {options.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        {sourceId && options.length === 0 && (
          <p className="text-sm sm:col-span-2">
            제안에 사용할 본문이나 보관 판독 결과가 없습니다. 먼저 본문을 기록하거나 로컬 판독을
            진행해 주세요.
          </p>
        )}
        <Button
          type="button"
          disabled={!basis}
          onClick={() => void preview()}
          className="sm:col-span-2"
        >
          미검토 제안 보기 · 아직 적용하지 않음
        </Button>
      </fieldset>
      {stale && !pending && (
        <Notice tone="warning">
          기업 자료가 갱신되어 이전 제안의 선택·확인은 해제되었습니다. 사용할 자료 버전을 확인하고
          새로 제안받아 주세요.
        </Notice>
      )}
      {error && (
        <div role="alert">
          <Notice tone="warning">{error}</Notice>
          {errorCode && (
            <details className="mt-2 text-xs">
              <summary>진단정보</summary>
              {errorCode}
            </details>
          )}
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {pending ? (
        <section
          className="space-y-3 rounded-xl border p-4"
          aria-label="결과 확인이 필요한 제안 채택 요청"
        >
          <h4 className="text-sm font-semibold">보낸 채택 요청 · 결과 확인 필요</h4>
          <p className="text-xs">
            아래 값은 요청 당시의 선택입니다. 현재 저장 성공이나 현재 값으로 단정하지 않습니다.
          </p>
          {company.revision !== pending.revision && (
            <Notice tone="warning">
              기업 자료가 바뀌어 이전 선택값을 새 버전에 재전송하지 않습니다. 저장된 기록을 먼저
              확인해 주세요.
            </Notice>
          )}
          {pending.input.selections.map((entry) => {
            const candidate = pending.preview.candidates.find(
              (value) => value.id === entry.candidateId,
            )!;
            return (
              <p className="whitespace-pre-wrap break-words text-sm" key={entry.target}>
                {sourceSuggestionTargetLabels[entry.target]}:{" "}
                {suggestionDisplayValue(entry.target, entry.expectedCurrentValue)} →{" "}
                {suggestionDisplayValue(entry.target, candidate.value)}
              </p>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={blocked}
              onClick={() => void checkSaved()}
            >
              저장된 채택 기록 확인
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={
                blocked ||
                checkedPending !== company.revision ||
                pending.revision !== company.revision
              }
              onClick={() => void send(pending)}
            >
              같은 요청으로 결과 재확인
            </Button>
            {suggestionRequestCanClose(
              company,
              pending,
              checkedPending === company.revision,
              definitelyRejected,
            ) && (
              <Button
                type="button"
                variant="outline"
                disabled={blocked}
                onClick={() => {
                  setPending(null);
                  setEditor(null);
                  setCheckedPending(null);
                  setError("");
                  setMessage(
                    "저장된 채택 기록과 거절·버전 상태를 확인하고 이전 요청을 닫았습니다. 새 제안에서 다시 선택·확인해 주세요.",
                  );
                }}
              >
                이전 요청 닫고 새 제안 준비
              </Button>
            )}
          </div>
        </section>
      ) : (
        activeEditor && (
          <div className="space-y-4">
            <SourceSuggestionChoices
              company={company}
              preview={activeEditor.preview}
              choices={activeEditor.choices}
              reviewed={activeEditor.reviewed}
              disabled={blocked}
              onSelect={(target, candidateId) => {
                if (!blocked)
                  setEditor({
                    ...activeEditor,
                    choices: { ...activeEditor.choices, [target]: candidateId },
                    reviewed: false,
                  });
              }}
              onReviewed={(reviewed) => {
                if (!blocked) setEditor({ ...activeEditor, reviewed });
              }}
            />
            {activeEditor.reviewed &&
              Object.values(activeEditor.choices).some(Boolean) &&
              !input && (
                <Notice tone="warning">
                  선택한 후보의 현재 값·자료 상태·기업정보 형식을 다시 확인해 주세요. 설립일과
                  신청예정일 등 기존 기업정보 조건을 어기는 조합은 채택하지 않습니다.
                </Notice>
              )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={blocked || atLimit || !input}
                onClick={() => {
                  if (input && !atLimit)
                    void send({
                      companyId: company.id,
                      revision: company.revision,
                      clientRequestId: crypto.randomUUID(),
                      input,
                      preview: activeEditor.preview,
                    });
                }}
              >
                확인한 선택값만 채택
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={blocked}
                onClick={() => {
                  setEditor(null);
                  setMessage("제안 검토를 닫았습니다. 자료 종류·기업정보는 변경하지 않았습니다.");
                }}
              >
                제안 닫기
              </Button>
            </div>
          </div>
        )
      )}
      {records.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">
            지난 제안 채택 {records.length}개 기록
          </summary>
          <div className="mt-4 space-y-4">
            {[...records].reverse().map((receipt) => (
              <SourceSuggestionReceiptView key={receipt.id} receipt={receipt} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
