"use client";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { StudioCase } from "@/lib/studio-schema";
import type { NumericObservation } from "@/lib/studio-numeric-check-types";
import {
  applyNumericSuggestion,
  numericSuggestionBasis,
  prepareNumericSuggestions,
  type PreparedNumericSuggestions,
} from "@/lib/studio-numeric-suggestions";
import { selectClass } from "./shared";

export function NumericSuggestions({
  company,
  value,
  onChange,
}: {
  company: StudioCase;
  value: NumericObservation;
  onChange: (value: NumericObservation) => void;
}) {
  const id = useId();
  const [prepared, setPrepared] = useState<PreparedNumericSuggestions | null>(null);
  const [selected, setSelected] = useState("");
  const [replacement, setReplacement] = useState("");
  const [message, setMessage] = useState("");
  const basis = numericSuggestionBasis(company, value);
  const current =
    prepared && basis?.identity === prepared.basis.identity && basis.text === prepared.basis.text
      ? prepared
      : null;
  const candidate = current?.candidates.find((c) => c.id === selected);
  const occupied = !!(value.valueText || value.reference?.quote);
  const replacementKey = JSON.stringify([value.valueText, value.reference?.quote, selected]);
  const replace = replacement === replacementKey;
  function clear() {
    setPrepared(null);
    setSelected("");
    setReplacement("");
    setMessage("");
  }
  return (
    <details
      className="rounded-lg border p-3"
      onToggle={(event) => {
        if (!event.currentTarget.open) clear();
      }}
    >
      <summary className="cursor-pointer font-medium">선택 본문에서 숫자 후보 찾기</summary>
      <div className="mt-3 min-w-0 space-y-3 [overflow-wrap:anywhere]" aria-label="숫자 후보 전사">
        <p className="text-xs text-muted-foreground">
          이 PC에서 숫자 표기를 찾습니다. 날짜·코드·금액의 의미는 구분하지 않습니다. 선택한 숫자와
          주변 인용만 옮기며 단위·기간·실적/목표 구분은 직접 확인하세요.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={!basis}
          onClick={() => {
            clear();
            try {
              setPrepared(prepareNumericSuggestions(company, value));
            } catch (error) {
              setMessage(
                error instanceof Error ? error.message : "숫자 후보를 확인하지 못했습니다.",
              );
            }
          }}
        >
          이 PC에서 숫자 후보 찾기
        </Button>
        {!basis && (
          <p className="text-sm">현재 자료 본문 또는 저장 원고 항목을 먼저 선택해 주세요.</p>
        )}
        {current && (
          <>
            <p role="status" className="text-sm">
              {current.candidates.length === 0
                ? "지원하는 숫자 후보가 없습니다. 필요한 수치는 직접 전사해 주세요."
                : `${current.candidates.length}개 후보${current.limited ? " · 앞 100개만 표시합니다. 이후 수치는 직접 전사해 주세요." : " · 원문과 대조해 직접 선택하세요."}`}
            </p>
            {!!current.candidates.length && (
              <>
                <label htmlFor={id} className="block text-sm font-medium">
                  가져올 숫자와 위치
                </label>
                <select
                  id={id}
                  className={selectClass}
                  value={selected}
                  onChange={(event) => {
                    setSelected(event.target.value);
                    setReplacement("");
                    setMessage("");
                  }}
                >
                  <option value="">숫자 후보 직접 선택</option>
                  {current.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.line}줄 · {c.valueText} · 문자 {c.start}~{c.end}
                    </option>
                  ))}
                </select>
              </>
            )}
            {candidate && (
              <>
                <p className="text-xs">
                  등록 본문 {candidate.line}줄 · UTF-16 [{candidate.start}, {candidate.end})
                </p>
                <pre
                  aria-label="숫자 후보 주변 인용"
                  className="whitespace-pre-wrap rounded bg-muted/40 p-3 text-sm [overflow-wrap:anywhere]"
                >
                  {candidate.quote.slice(0, candidate.start - candidate.quoteStart)}
                  <mark>{candidate.valueText}</mark>
                  {candidate.quote.slice(candidate.end - candidate.quoteStart)}
                </pre>
                {occupied && (
                  <label className="flex min-h-11 items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={replace}
                      onChange={(event) =>
                        setReplacement(event.target.checked ? replacementKey : "")
                      }
                    />
                    기존 숫자·인용을 선택한 후보로 바꾸기
                  </label>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={occupied && !replace}
                  onClick={() => {
                    try {
                      onChange(
                        applyNumericSuggestion(company, value, current, candidate.id, replace),
                      );
                      setReplacement("");
                      setMessage(
                        "숫자와 인용을 편집기에 옮겼습니다. 단위·기간·구분을 확인하고 대조안을 별도로 저장하세요.",
                      );
                      document.getElementById(`numeric-observation-${value.id}-value`)?.focus();
                    } catch (error) {
                      setMessage(
                        error instanceof Error ? error.message : "후보를 다시 확인해 주세요.",
                      );
                    }
                  }}
                >
                  선택한 숫자·인용 가져오기
                </Button>
              </>
            )}
          </>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </div>
    </details>
  );
}
