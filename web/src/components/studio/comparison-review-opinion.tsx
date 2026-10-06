import type { useComparisonReviewScreen } from "@/lib/studio-public-claim-comparison-review-react";

type DisplayResult = Extract<NonNullable<ReturnType<typeof useComparisonReviewScreen>["display"]>,
  { kind: "result" }>["result"];

const relationLabels = {
  "provided-text-support": "제공된 발췌가 뒷받침함",
  "provided-text-conflict": "제공된 발췌와 상충함",
  insufficient: "근거 부족",
  undetermined: "판단 유보",
} as const;
const checkLabels = {
  period: "기간", unit: "단위", population: "대상 집단",
  "company-applicability": "회사 적용", provenance: "출처", other: "기타",
} as const;

const noOpinionMessages = {
  "comparison-rejected": "저장된 응답이 비교 검증을 통과하지 못해 표시할 의견이 없습니다.",
  "response-incomplete": "저장된 응답이 완료되지 않아 표시할 비교 의견이 없습니다.",
  "response-unsupported": "저장된 응답 형식이 지원 범위와 맞지 않아 표시할 비교 의견이 없습니다.",
  "model-mismatch": "저장된 응답의 모델이 원래 요청과 일치하지 않아 표시할 비교 의견이 없습니다."
} satisfies Record<Exclude<DisplayResult["historical"]["result"]["state"], "comparison-ready">, string>;

/** Receives only the current display accepted by the existing review hook. */
export function ComparisonReviewOpinion({ result }: { result: DisplayResult | null }) {
  if (!result) return null;
  const stored = result.historical.result;
  if (stored.state !== "comparison-ready") {
    if (stored.comparison !== null) return null;
    return <div data-testid="example-result-state" role="status"
      className="space-y-3 rounded-xl border bg-white p-5 text-sm">
      <h2 className="font-semibold">비교 의견이 없는 저장 결과</h2>
      <p data-testid="stored-state-message">{noOpinionMessages[stored.state]}</p>
      <p className="text-muted-foreground">합성 자료의 저장 상태입니다. 자동으로 다시 요청하지 않습니다.</p>
    </div>;
  }
  const { prepared } = result.historical;
  const opinion = result.historical.result.comparison?.comparison;
  if (!opinion) return null;
  const sources = new Map(prepared.input.selectedEvidence.map((source) => [source.sourceId, source]));
  // The receiver already checks the full wire contract. A missing join never
  // falls back to another source, even if an incorrect caller bypasses it.
  if (opinion.evidence.some((e) => !sources.has(e.sourceId)) ||
      opinion.checks.some((check) => check.sourceIds.some((id) => !sources.has(id)))) return null;
  return <div data-testid="example-result" className="space-y-5 rounded-xl border border-primary/20 bg-white p-5">
    <div>
      <h2 className="font-semibold">저장된 검토 의견</h2>
      <p className="mt-1 text-sm text-muted-foreground">합성 자료로 만든 의견입니다. 실제 AI 분석이나 사실 확인 결과가 아닙니다.</p>
    </div>
    <div className="space-y-2 text-sm">
      <p className="whitespace-pre-wrap break-words">검토한 주장: {opinion.claimQuote}</p>
      <p data-testid="overall-relation" className="font-semibold">전체 판단: {relationLabels[opinion.overall.relation]}</p>
      <p data-testid="overall-reason" className="whitespace-pre-wrap break-words">{opinion.overall.reason}</p>
    </div>
    {opinion.evidence.map((evidence) => {
      // Exact source identity only; array order and similar titles are not a match.
      const source = sources.get(evidence.sourceId)!;
      return <section key={evidence.sourceId} data-source-id={evidence.sourceId}
        aria-label={source.metadata.title} className="space-y-3 border-t pt-4 text-sm">
        <h3 className="whitespace-pre-wrap break-words font-semibold">{source.metadata.title}</h3>
        <p className="font-medium">근거 판단: {relationLabels[evidence.relation]}</p>
        <p className="whitespace-pre-wrap break-words">{evidence.reason}</p>
        {evidence.quotes.length > 0 && <div className="space-y-2">
          <p className="text-xs text-muted-foreground">의견에 인용된 발췌</p>
          {evidence.quotes.map((quote, index) => <blockquote key={index}
            className="whitespace-pre-wrap break-words border-l-2 pl-3">{quote}</blockquote>)}
        </div>}
        <details className="rounded-lg bg-muted/40 p-3">
          <summary className="cursor-pointer font-medium">보관된 발췌 보기</summary>
          <p data-testid="source-excerpt" className="mt-3 whitespace-pre-wrap break-words leading-6">{source.excerpt}</p>
        </details>
        <div>
          <p className="font-medium">추가 확인 메모</p>
          <p data-testid="next-check" className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
            {evidence.nextCheck.trim() ? evidence.nextCheck : "저장된 추가 확인 메모가 없습니다."}
          </p>
        </div>
      </section>;
    })}
    {opinion.checks.length > 0 && <section className="space-y-3 border-t pt-4 text-sm" aria-label="검토 시 확인할 항목">
      <h3 className="font-semibold">검토 시 확인할 항목</h3>
      <ul className="space-y-3">{opinion.checks.map((check, index) => <li key={index}>
        <p className="font-medium">{checkLabels[check.dimension]} · {check.sourceIds.length
          ? check.sourceIds.map((id) => sources.get(id)!.metadata.title).join(" · ") : "전체 근거"}</p>
        <p className="whitespace-pre-wrap break-words">{check.message}</p>
      </li>)}</ul>
    </section>}
  </div>;
}
