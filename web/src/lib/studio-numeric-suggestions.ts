import type { StudioCase } from "./studio-schema";
import { numericLiteralAt, type NumericObservation } from "./studio-numeric-check-types";

export const numericSuggestionLimits = { characters: 200_000, candidates: 100 } as const;
export type NumericSuggestion = {
  id: string;
  start: number;
  end: number;
  line: number;
  valueText: string;
  quote: string;
  quoteStart: number;
};
/** Text already registered by the user. No original-file read, fetch or semantic inference. */
export function numericSuggestionBasis(company: StudioCase, value: NumericObservation) {
  const ref = value.reference;
  if (!ref) return null;
  let text: string, version: string | number;
  if (ref.kind === "source") {
    const matches = company.sources.filter((s) => s.id === ref.sourceId);
    if (
      matches.length !== 1 ||
      matches[0].extraction === "pending" ||
      matches[0].updatedAt !== ref.sourceUpdatedAt
    )
      return null;
    text = matches[0].text;
    version = matches[0].updatedAt;
  } else {
    const matches = company.plans.filter((p) => p.id === ref.planId);
    if (matches.length !== 1) return null;
    const sections = matches[0].content.sections.filter((s) => s.key === ref.sectionKey);
    if (sections.length !== 1) return null;
    text = sections[0].content;
    version = matches[0].version;
  }
  return {
    identity: JSON.stringify([
      company.id,
      company.revision,
      value.id,
      ref.kind,
      ref.kind === "source" ? ref.sourceId : ref.planId,
      ref.kind === "source" ? ref.sourceUpdatedAt : ref.sectionKey,
      version,
    ]),
    text,
  };
}
export function numericSuggestions(text: string) {
  if (text.length > numericSuggestionLimits.characters)
    throw Error("본문 200,000자 이내에서만 숫자 후보를 찾습니다. 직접 전사해 주세요.");
  const candidates: NumericSuggestion[] = [];
  let line = 1,
    previous = 0;
  for (const match of text.matchAll(/[+-]?\d[\d,]*(?:\.\d+)?/g)) {
    const start = match.index,
      valueText = match[0],
      end = start + valueText.length;
    if (valueText.length > 32 || !numericLiteralAt(text, start, valueText)) continue;
    if (/^[+-]/.test(valueText) && /\d\s*$/.test(text.slice(0, start))) continue;
    // Extra notation unsupported by this picker is left for manual review, never converted.
    if (/[（±]\s*[$₩￦€¥£]?\s*$/.test(text.slice(0, start)) || /^\s*[）)]/.test(text.slice(end)))
      continue;
    if (candidates.length === numericSuggestionLimits.candidates)
      return { candidates, limited: true };
    line += (text.slice(previous, start).match(/\n/g) ?? []).length;
    previous = start;
    const quoteStart = Math.max(text.lastIndexOf("\n", start - 1) + 1, start - 80);
    const nextLine = text.indexOf("\n", end);
    const quoteEnd = Math.min(nextLine < 0 ? text.length : nextLine, end + 80);
    candidates.push({
      id: `${start}:${end}`,
      start,
      end,
      line,
      valueText,
      quote: text.slice(quoteStart, quoteEnd),
      quoteStart,
    });
  }
  return { candidates, limited: false };
}
export function prepareNumericSuggestions(company: StudioCase, value: NumericObservation) {
  const basis = numericSuggestionBasis(company, value);
  if (!basis) throw Error("고유한 현재 자료 또는 저장 원고 항목을 선택해 주세요.");
  return { basis, ...numericSuggestions(basis.text) };
}
export type PreparedNumericSuggestions = ReturnType<typeof prepareNumericSuggestions>;
/** Only two editable fields change. Existing units, dates, notes and references are preserved. */
export function applyNumericSuggestion(
  company: StudioCase,
  value: NumericObservation,
  prepared: PreparedNumericSuggestions,
  candidateId: string,
  replace: boolean,
) {
  const current = numericSuggestionBasis(company, value);
  if (
    !current ||
    current.identity !== prepared.basis.identity ||
    current.text !== prepared.basis.text
  )
    throw Error("자료나 원고 연결이 바뀌었습니다. 후보를 다시 찾아 주세요.");
  // Recompute from current text instead of trusting mutable candidate data supplied by a caller.
  const candidate = numericSuggestions(current.text).candidates.find((c) => c.id === candidateId);
  if (!candidate || !value.reference)
    throw Error("현재 본문에서 선택한 숫자를 확인할 수 없습니다.");
  if ((value.valueText || value.reference.quote) && !replace)
    throw Error("기존 숫자·인용을 바꿀지 먼저 선택해 주세요.");
  return {
    ...value,
    valueText: candidate.valueText,
    reference: { ...value.reference, quote: candidate.quote },
  };
}
