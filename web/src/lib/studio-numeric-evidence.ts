type NumericTerm = { start: number; end: number; text: string; key: string };

/** Literal notation only: no unit conversion, arithmetic or semantic/factual judgement. */
function terms(text: string): NumericTerm[] {
  const pattern =
    /(?:[+\-−－﹣△▲▵]\s*|[（(]\s*)?(?:[$₩￦€¥£]\s*)?\d[\d,.]*\s*(?:천\s*만\s*원|백\s*만\s*원|억\s*원|만\s*원|원|[%％](?:[pP]|포인트)?|명|건|개사|배)/g;
  const result: NumericTerm[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    let end = start + match[0].length;
    // Preserve an explicit accounting/parenthetical notation without interpreting its sign.
    if (/^[（(]/.test(match[0])) {
      const close = text.slice(end).match(/^\s*[）)]/);
      if (close) end += close[0].length;
    }
    const literal = text.slice(start, end);
    // Do not accept the tail of an identifier, decimal, grouped number or signed value.
    if (/[A-Za-z0-9.+\-−－﹣△▲▵]/.test(text.charAt(start - 1))) continue;
    if (/[A-Za-z0-9]/.test(text.charAt(end))) continue;
    result.push({ start, end, text: literal, key: literal.replace(/\s+/g, "") });
  }
  return result;
}

/** Match complete terms inside exact quote occurrences in the original source.
 * A quote cropped from "15억원" to "5억원" must never provide a numeric match.
 * Full source text is used only to check boundaries, never as uncited evidence.
 */
export function unmatchedNumericEvidence(
  content: string,
  references: readonly { text: string; quote: string }[],
): string[] {
  const pending = new Map(terms(content).map((term) => [term.key, term.text]));
  const cache = new Map<string, NumericTerm[]>();
  for (const { text, quote } of references) {
    if (!pending.size) break;
    if (!quote.trim()) continue;
    const sourceTerms = cache.get(text) ?? terms(text);
    cache.set(text, sourceTerms);
    let occurrence = -1;
    let first = 0;
    while ((occurrence = text.indexOf(quote, occurrence + 1)) >= 0) {
      while (first < sourceTerms.length && sourceTerms[first].start < occurrence) first++;
      const end = occurrence + quote.length;
      for (let index = first; index < sourceTerms.length; index++) {
        const term = sourceTerms[index];
        if (term.end > end) break;
        pending.delete(term.key);
      }
      if (!pending.size) break;
    }
  }
  return [...pending.values()];
}
