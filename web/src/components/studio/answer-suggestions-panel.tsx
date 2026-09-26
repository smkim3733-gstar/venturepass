"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { StudioCase } from "@/lib/studio-schema";
import type {
  AnswerSuggestionAiPreview,
  AnswerSuggestionCandidate,
  AnswerSuggestionInput,
  AnswerSuggestions,
} from "@/lib/studio-answer-suggestion-types";
import {
  answerRequestOccurrences,
  answerSuggestionInput,
  sendAnswerSuggestion,
  sendApprovedAnswerSuggestion,
  validateAnswerAiPreview,
  validateAnswerSuggestions,
  type AnswerSuggestionScope,
} from "./answer-suggestions-ui";
import { SourceSuggestionPosition } from "./source-suggestions-panel";
import { Notice, formatDate, selectClass } from "./shared";

type Props = {
  company: StudioCase;
  scope: AnswerSuggestionScope;
  contextFingerprint: string;
  disabled: boolean;
  hasExistingContent: boolean;
  onePerSource: boolean;
  onBusyChange: (busy: boolean) => void;
  onApply: (
    result: AnswerSuggestions,
    selected: AnswerSuggestionCandidate[],
    replace: boolean,
  ) => string | null;
};
export function AnswerSuggestionsPanel(props: Props) {
  return (
    <AnswerSuggestionsEditor
      key={JSON.stringify([
        props.company.id,
        props.company.revision,
        props.scope,
        props.contextFingerprint,
      ])}
      {...props}
    />
  );
}
export function AnswerAiPreviewView({ preview }: { preview: AnswerSuggestionAiPreview }) {
  const { approval, transmission } = preview;
  return (
    <div className="space-y-3 rounded-xl border p-4">
      <p className="font-semibold text-sm">외부 AI로 전송할 정확한 본문</p>
      <dl className="grid gap-1 text-xs">
        <div>
          <dt className="inline font-semibold">제공자: </dt>
          <dd className="inline">{approval.provider}</dd>
        </div>
        <div className="break-all">
          <dt className="inline font-semibold">목적지: </dt>
          <dd className="inline">{approval.destination}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">모델: </dt>
          <dd className="inline">{approval.model}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">목적: </dt>
          <dd className="inline">요청·질문에 관련될 수 있는 정확한 원문 인용 후보 선택</dd>
        </div>
        <div>
          <dt className="inline font-semibold">승인 만료: </dt>
          <dd className="inline">{formatDate(approval.expiresAt)}</dd>
        </div>
      </dl>
      <details>
        <summary className="cursor-pointer text-sm">
          전송 요청·질문 본문 전체 ({transmission.targetText.length}자)
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
          {transmission.targetText}
        </pre>
      </details>
      {transmission.sources.map((source) => (
        <details key={source.sourceId}>
          <summary className="cursor-pointer text-sm">
            전송 자료: {source.sourceName} · 본문 전체 {source.text.length.toLocaleString()}자
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
            {source.text}
          </pre>
        </details>
      ))}
      <details className="text-xs">
        <summary className="cursor-pointer">전송 본문 식별 정보</summary>
        <p className="mt-2 break-all">SHA-256: {approval.payloadSha256}</p>
      </details>
      <p className="text-xs">
        선택한 자료 본문과 위 요청·질문을 전송합니다. 원본 파일·다른 자료·계정 정보는 포함하지
        않습니다. 처리 비용이 발생할 수 있으며 제안은 사실 검증·기관 발송이 아닙니다.
      </p>
    </div>
  );
}
function AnswerSuggestionsEditor({
  company,
  scope,
  disabled,
  hasExistingContent,
  onePerSource,
  onBusyChange,
  onApply,
}: Props) {
  const prefix = useId();
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [occurrence, setOccurrence] = useState<number | null>(null);
  const [result, setResult] = useState<AnswerSuggestions | null>(null);
  const [input, setInput] = useState<AnswerSuggestionInput | null>(null);
  const [preview, setPreview] = useState<AnswerSuggestionAiPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [approved, setApproved] = useState(false);
  const [replace, setReplace] = useState(false);
  const [unknownAi, setUnknownAi] = useState(false);
  const [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const mounted = useRef(false),
    inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!preview) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [preview]);
  const sources = company.sources.filter(
    (source) => source.extraction !== "pending" && !!source.text.trim(),
  );
  const positions = answerRequestOccurrences(company, scope);
  const ambiguous = scope.kind === "agency-request" && positions.length > 1;
  const targetMissing =
    scope.kind === "agency-request" &&
    (positions.length === 0 || (ambiguous && occurrence === null));
  const count = sources
    .filter((source) => sourceIds.includes(source.id))
    .reduce((sum, source) => sum + source.text.length, 0);
  const blocked = disabled || busy || applying;
  const canRequest =
    !blocked && sourceIds.length > 0 && sourceIds.length <= 6 && count <= 60_000 && !targetMissing;
  const expired = !!preview && Date.parse(preview.approval.expiresAt) <= now;
  function clearProposal() {
    setResult(null);
    setInput(null);
    setPreview(null);
    setSelected([]);
    setApproved(false);
    setReplace(false);
    setDuplicateAcknowledged(false);
    setError("");
  }
  async function request(action: "local" | "prepare-ai" | "run-ai") {
    if (blocked || inFlight.current || !canRequest) return;
    if (
      action === "run-ai" &&
      (!preview ||
        !input ||
        !approved ||
        (unknownAi && !duplicateAcknowledged) ||
        Date.parse(preview.approval.expiresAt) <= Date.now())
    )
      return;
    inFlight.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    setResult(null);
    setSelected([]);
    setReplace(false);
    const priorPreview = preview,
      priorInput = input;
    setPreview(null);
    setApproved(false);
    setDuplicateAcknowledged(false);
    try {
      const freshInput = await answerSuggestionInput(company, scope, sourceIds, occurrence);
      if (!mounted.current) return;
      if (!freshInput)
        throw new Error(
          "현재 요청·질문과 선택 자료를 다시 확인해 주세요. 미검토 자료는 선택할 수 없습니다.",
        );
      if (
        action === "run-ai" &&
        (!priorPreview || !priorInput || JSON.stringify(freshInput) !== JSON.stringify(priorInput))
      )
        throw new Error("전송 미리보기가 바뀌거나 만료되었습니다. 새로 확인해 주세요.");
      // Hash validation can outlive this exact company/editor instance.
      if (!mounted.current) return;
      const value =
        action === "run-ai"
          ? await sendApprovedAnswerSuggestion(
              company,
              freshInput,
              priorPreview!,
              () => mounted.current,
            )
          : await sendAnswerSuggestion(company.id, { action, input: freshInput });
      if (!mounted.current) return;
      if (action === "prepare-ai") {
        const next = await validateAnswerAiPreview(value, company, freshInput);
        if (!mounted.current) return;
        if (!next)
          throw new Error(
            "전송 본문·회사·자료 버전을 확인하지 못했습니다. 외부 전송 승인을 열지 않습니다.",
          );
        setInput(freshInput);
        setPreview(next);
        setApproved(false);
        setDuplicateAcknowledged(false);
        setNow(Date.now());
      } else {
        const next = await validateAnswerSuggestions(
          value,
          company,
          freshInput,
          action === "local" ? "assisted" : "ai",
          action === "local" ? null : priorPreview!.approval.model,
        );
        if (!mounted.current) return;
        if (!next)
          throw new Error(
            "제안의 원문·위치·회사 버전을 확인하지 못했습니다. 기존 답변은 유지합니다.",
          );
        setInput(freshInput);
        setResult(next);
        setPreview(null);
        setApproved(false);
        if (action === "run-ai") setUnknownAi(false);
      }
    } catch (caught) {
      if (mounted.current) {
        setError(caught instanceof Error ? caught.message : "제안을 확인하지 못했습니다.");
        if (action === "run-ai") setUnknownAi(true);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  async function apply() {
    if (
      blocked ||
      inFlight.current ||
      !result ||
      !input ||
      !selected.length ||
      (hasExistingContent && !replace)
    )
      return;
    inFlight.current = true;
    setApplying(true);
    try {
      const valid = await validateAnswerSuggestions(
        result,
        company,
        input,
        result.mode,
        result.model,
      );
      if (!mounted.current) return;
      if (!valid) throw new Error("제안과 현재 근거가 달라 적용하지 않았습니다.");
      const candidates = selected.map((id) =>
        valid.candidates.find((candidate) => candidate.id === id),
      );
      if (candidates.some((candidate) => !candidate))
        throw new Error("선택 후보를 다시 확인해 주세요.");
      const problem = onApply(valid, candidates as AnswerSuggestionCandidate[], replace);
      if (problem) setError(problem);
      else clearProposal();
    } catch (caught) {
      if (mounted.current)
        setError(caught instanceof Error ? caught.message : "선택한 제안을 적용하지 못했습니다.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setApplying(false);
    }
  }
  return (
    <details className="space-y-3 rounded-xl border bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold">
        선택 자료에서 미검토 답변 근거 제안
      </summary>
      <Notice>
        로컬 제안이 기본입니다. 선택한 등록 본문에서 인용 후보를 찾아 보여주며 사실·의미 적합성은
        검증하지 않습니다. 결과를 직접 선택해 편집기에 가져온 뒤 검토·저장하세요.
      </Notice>
      {scope.kind === "agency-request" && positions.length === 0 && (
        <p className="text-sm text-amber-900">최신 요청의 정확한 부분을 먼저 인용해 주세요.</p>
      )}
      {ambiguous && (
        <label className="block space-y-2 text-sm" htmlFor={`${prefix}-position`}>
          <span>동일한 요청 문장이 여러 곳에 있습니다. 정확한 위치 선택</span>
          <select
            id={`${prefix}-position`}
            disabled={blocked}
            className={selectClass}
            value={occurrence ?? ""}
            onChange={(event) => {
              clearProposal();
              setOccurrence(event.target.value === "" ? null : Number(event.target.value));
            }}
          >
            <option value="">위치 선택</option>
            {positions.map((start) => (
              <option key={start} value={start}>
                문자 {start}~{start + (scope.kind === "agency-request" ? scope.quote.length : 0)}
              </option>
            ))}
          </select>
        </label>
      )}
      <fieldset disabled={blocked} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">
          사용할 등록 본문 직접 선택 (최대 6개·합계 60,000자)
        </legend>
        {sources.map((source) => (
          <label key={source.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={sourceIds.includes(source.id)}
              disabled={!sourceIds.includes(source.id) && sourceIds.length >= 6}
              onChange={(event) => {
                clearProposal();
                setSourceIds(
                  event.target.checked
                    ? [...sourceIds, source.id]
                    : sourceIds.filter((id) => id !== source.id),
                );
              }}
            />
            <span>
              {source.name} · {source.text.length.toLocaleString()}자
            </span>
          </label>
        ))}
        {!sources.length && (
          <p className="text-sm">
            본문을 직접 입력하거나 판독문을 검토해 채택한 자료가 필요합니다.
          </p>
        )}
      </fieldset>
      <p className="text-xs text-muted-foreground">
        선택 {sourceIds.length}개 · {count.toLocaleString()}자. 원본만 보관·미검토 판독 결과는
        제외합니다.
      </p>
      {count > 60_000 && (
        <p role="alert" className="text-sm text-amber-900">
          합계 60,000자 한도입니다. 선택을 줄여 주세요.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!canRequest} onClick={() => void request("local")}>
          이 PC에서 근거 제안
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!canRequest}
          onClick={() => void request("prepare-ai")}
        >
          AI 전송 내용 먼저 확인
        </Button>
      </div>
      {unknownAi && (
        <Notice tone="warning">
          이전 AI 요청 결과를 확인하지 못했습니다. 처리·비용이 발생했을 수 있습니다. 자동 재전송하지
          않으며, 새 전송은 새 미리보기와 별도 동의가 필요합니다.
        </Notice>
      )}
      {preview && (
        <div className="space-y-3">
          <AnswerAiPreviewView preview={preview} />
          {expired && (
            <p className="text-sm text-amber-900">
              전송 승인이 만료되었습니다. 미리보기를 새로 열어 주세요.
            </p>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={approved && !expired}
              disabled={blocked || expired}
              onChange={(event) => setApproved(event.target.checked)}
            />
            <span>
              위 요청·질문과 선택 자료의 전체 본문을 표시된 OpenAI 목적지·모델로 1회 전송하는 데
              동의합니다.
            </span>
          </label>
          {unknownAi && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={duplicateAcknowledged}
                disabled={blocked || expired}
                onChange={(event) => setDuplicateAcknowledged(event.target.checked)}
              />
              <span>
                이전 요청과 중복 처리·비용이 발생할 수 있음을 확인하고 새 전송에 동의합니다.
              </span>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={blocked || !approved || expired || (unknownAi && !duplicateAcknowledged)}
              onClick={() => void request("run-ai")}
            >
              승인한 본문 1회 전송·인용 제안
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={blocked}
              onClick={() => {
                setPreview(null);
                setApproved(false);
                setDuplicateAcknowledged(false);
              }}
            >
              전송 미리보기 닫기
            </Button>
          </div>
        </div>
      )}
      {result && (
        <div className="space-y-3">
          <p className="font-semibold text-sm">
            {result.mode === "assisted" ? "로컬" : "AI"} 인용 후보 · 미검토 · 원본 파일 미대조
          </p>
          {result.warnings.map((warning, index) => (
            <p key={index} className="text-xs text-muted-foreground">
              {warning}
            </p>
          ))}
          {result.candidates.map((candidate) => {
            const checked = selected.includes(candidate.id);
            const duplicateSource =
              onePerSource &&
              selected.some(
                (id) =>
                  result.candidates.find((other) => other.id === id)?.sourceId ===
                  candidate.sourceId,
              );
            return (
              <div key={candidate.id} className="space-y-2 rounded-lg border p-3">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={blocked || (!checked && duplicateSource)}
                    onChange={(event) => {
                      setReplace(false);
                      setSelected(
                        event.target.checked
                          ? [...selected, candidate.id]
                          : selected.filter((id) => id !== candidate.id),
                      );
                    }}
                  />
                  <span>{candidate.sourceName}</span>
                </label>
                <blockquote className="whitespace-pre-wrap border-l-2 pl-3 text-sm">
                  {candidate.quote}
                </blockquote>
                <SourceSuggestionPosition position={candidate} />
              </div>
            );
          })}
          {onePerSource && (
            <p className="text-xs">한 대응 항목에는 같은 자료의 인용을 하나만 연결합니다.</p>
          )}
          {result.followUpQuestions.length > 0 && (
            <ul className="list-disc pl-5 text-sm">
              {result.followUpQuestions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ul>
          )}
          {hasExistingContent && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={replace}
                disabled={blocked}
                onChange={(event) => setReplace(event.target.checked)}
              />
              <span>
                {onePerSource
                  ? "기존 답변 초안과 선택한 자료의 연결 인용을 미검토 제안으로 바꿉니다. 다른 자료·원고 연결과 메모는 유지합니다."
                  : "기존 모의 답변과 인용 대조를 선택한 제안으로 바꾸고 내부 검토 표시를 해제합니다. 담당자·추가 확인 메모는 유지합니다."}
              </span>
            </label>
          )}
          <Button
            type="button"
            disabled={blocked || !selected.length || (hasExistingContent && !replace)}
            onClick={() => void apply()}
          >
            선택한 인용을 미검토 편집안에 적용
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </details>
  );
}
