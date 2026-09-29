import type { ProviderReviewView } from "@/lib/studio-plan-quality-provider-review-types";

type ProposalView = Omit<
  Extract<ProviderReviewView, { state: "proposal-only" }>,
  "viewVersion" | "blockers"
>;

export function QualityProviderExpiredDetails({
  view,
}: {
  view: Extract<ProviderReviewView, { state: "configuration-expired" }>;
}) {
  return (
    <div className="min-w-0 space-y-3 text-sm leading-6">
      <p>
        확인했던 운영 근거의 내부 재확인 기한이 지났습니다. 공식 자료를 다시 확인한 뒤
        모델·요율·보관 조건을 검토할 수 있습니다.
      </p>
      <p className="break-words [overflow-wrap:anywhere]">
        내부 재확인 기한: {view.expiry.validUntil}
      </p>
      <p>이 기한은 공급자의 가격 보증일이 아닙니다. 이전 금액으로 예약하거나 전송하지 않습니다.</p>
      <details className="min-w-0">
        <summary className="cursor-pointer text-xs">만료된 근거의 식별 기록</summary>
        <p className="mt-2 break-words text-xs [overflow-wrap:anywhere]">
          설정 제안 SHA-256: {view.expiry.configurationDigest}
        </p>
      </details>
    </div>
  );
}

/** Exact decimal rendering; financial units must never pass through Number. */
export function qualityProviderMoney(units: string, unitScale: number, currency: string) {
  if (
    !/^(0|[1-9]\d{0,79})$/.test(units) ||
    !Number.isInteger(unitScale) ||
    unitScale < 0 ||
    unitScale > 12 ||
    !/^[A-Z]{3}$/.test(currency)
  )
    throw new Error("금액 표시 범위를 확인해 주세요.");
  const padded = units.padStart(unitScale + 1, "0");
  const whole = unitScale ? padded.slice(0, -unitScale) : padded;
  const fraction = unitScale ? padded.slice(-unitScale).replace(/0+$/, "") : "";
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? "." + fraction : ""}`;
}

export function QualityProviderProposalDetails({ view }: { view: ProposalView }) {
  const costs = view.financialBasis.costs;
  const proposal = view.proposal;
  const request = proposal.requestReview;
  if (!costs) return <p>예약 계산 근거를 확인하지 못했습니다. 실행할 수 없습니다.</p>;
  const money = (units: string) => qualityProviderMoney(units, costs.unitScale, costs.currency);
  return (
    <div className="min-w-0 space-y-4">
      <p className="text-sm leading-6">
        공식 자료를 바탕으로 만든 검토 제안입니다. 이 조회로 운영 모델을 채택하거나 예산을
        설정하거나 전송을 승인하지 않습니다.
      </p>
      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-muted-foreground">제안 모델</dt>
          <dd className="break-words font-medium [overflow-wrap:anywhere]">{view.model}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">한 건의 보수적 예약 계산</dt>
          <dd className="break-words font-medium">{money(costs.totalUnits)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">생성 / 검토 예약</dt>
          <dd className="break-words">
            {money(costs.generation.totalUnits)} / {money(costs.review.totalUnits)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">제안 누적 한도 · 미승인</dt>
          <dd className="break-words">
            {qualityProviderMoney(
              proposal.proposedBudget.capUnits,
              proposal.proposedBudget.unitScale,
              proposal.proposedBudget.currency,
            )}
          </dd>
        </div>
      </dl>
      <p className="text-xs leading-6 text-muted-foreground">
        전체 문맥을 입력으로 잡고 출력 한도를 별도로 더한 계산입니다. 실제 사용량·견적이나 모든
        실패의 청구 상한을 보장하지 않습니다. 사용량이 확인되지 않으면 예약을 유지하고 자동으로
        재호출하지 않습니다.
      </p>
      <details className="min-w-0 rounded-lg border p-3">
        <summary className="cursor-pointer text-sm">전송할 내용과 요청 원문</summary>
        <div className="mt-3 min-w-0 space-y-3 text-xs leading-6">
          <p>목적지: https://api.openai.com/v1/responses</p>
          <p>
            등록한 합성 후보 한 건의 회사 설명·자료·신청 주제를 사용합니다. 생성 1회와 독립 검토
            1회, 자동 재시도·자동 수정은 없습니다.
          </p>
          <p>
            두 번째 요청은 같은 실행의 검증된 최초 원고를 고정 문맥에 넣어 만듭니다. 아직 생성되지
            않은 검토 본문을 확정하거나 승인한 것이 아닙니다.
          </p>
          <details>
            <summary className="cursor-pointer">정확한 생성 요청</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 [overflow-wrap:anywhere]">
              {JSON.stringify(request.generation.body)}
            </pre>
            <p className="mt-2 break-words [overflow-wrap:anywhere]">
              원문 SHA-256: {request.generation.sha256}
            </p>
          </details>
          <details>
            <summary className="cursor-pointer">검토 요청의 고정 문맥과 파생 규칙</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 [overflow-wrap:anywhere]">
              {JSON.stringify(request.reviewTemplate, null, 2)}
            </pre>
          </details>
        </div>
      </details>
      <details className="min-w-0 rounded-lg border p-3">
        <summary className="cursor-pointer text-sm">공식 출처·요율·보관 안내</summary>
        <div className="mt-3 min-w-0 space-y-3 text-xs leading-6">
          <p>{view.retention.notice}</p>
          <p>
            기한은 내부 재확인 기준이며 공급자의 가격 보증일이 아닙니다. 출처 기록의 해시와 실제
            페이지 원문 해시는 구분합니다.
          </p>
          <ul className="space-y-3">
            {proposal.sources.map((source) => (
              <li key={source.recordDigest} className="min-w-0">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="break-words underline [overflow-wrap:anywhere]"
                >
                  {source.title}
                </a>
                <p>{source.excerpt}</p>
                <p>
                  확인: {source.reviewedAt} · 재확인 기한: {source.validUntil}
                </p>
                <p className="break-words [overflow-wrap:anywhere]">
                  검토 기록 SHA-256: {source.recordDigest}
                </p>
                <p className="break-words [overflow-wrap:anywhere]">
                  페이지 원문 SHA-256: {source.bodySha256 ?? "별도 원문 바이트 미보관"}
                </p>
              </li>
            ))}
          </ul>
          <details>
            <summary className="cursor-pointer">예약 계산·사용량 해석 근거 원문</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 [overflow-wrap:anywhere]">
              {JSON.stringify(
                {
                  financialBasis: view.financialBasis,
                  usagePolicy: proposal.usagePolicy,
                  proposedBudget: proposal.proposedBudget,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      </details>
    </div>
  );
}
