import type { ProviderPolicyReview } from "@/lib/studio-plan-quality-provider-policy-review-types";
import type { ProviderPolicyInspection } from "@/lib/studio-plan-quality-provider-policy-http-types";
import { qualityProviderMoney } from "./quality-provider-proposal-details";

const messages: Record<ProviderPolicyReview["assessment"]["state"], string> = {
  "budget-not-configured": "운영 예산 미설정 · 아래 제안은 아직 승인되지 않았습니다.",
  "budget-configured":
    "현재 예산에서 한 건의 추가 예약액을 확보할 수 있습니다. 예약은 아직 하지 않았습니다.",
  "budget-insufficient":
    "현재 가용액이 한 건의 추가 예약액보다 적습니다. 예산과 미정산 내역을 먼저 확인해 주세요.",
  "budget-incompatible":
    "현재 예산과 제안의 통화 또는 금액 단위가 다릅니다. 같은 조건으로 확인하기 전에는 비교할 수 없습니다.",
  "budget-bound-breached":
    "이전 실행에서 한도 초과가 확인됐습니다. 잔액과 관계없이 해당 사용 내역을 먼저 확인해 주세요.",
};
export function QualityProviderPolicyDetails({
  review,
  policyHead,
}: {
  review: ProviderPolicyReview;
  policyHead?: ProviderPolicyInspection["policyHead"];
}) {
  const { budget, assessment, proposedBudget } = review;
  const currentMoney = (units: string) =>
    budget.currency !== null && budget.unitScale !== null
      ? qualityProviderMoney(units, budget.unitScale, budget.currency)
      : "미설정";
  const proposalMoney = (units: string) =>
    qualityProviderMoney(units, proposedBudget.unitScale, proposedBudget.currency);
  return (
    <section
      aria-label="누적 예산 검토"
      className="min-w-0 space-y-3 rounded-lg border bg-background p-3 text-sm leading-6"
    >
      <h4 className="font-semibold">누적 예산 검토 · 마지막 조회 기준</h4>
      {policyHead && (
        <p className="text-xs text-muted-foreground">
          함께 확인한 전체 정책 채택 기록: {policyHead.revision}건. 이번 제안의 새 채택은 실행되지
          않았습니다.
        </p>
      )}
      <p role="status">{messages[assessment.state]}</p>
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
        {(
          [
            ["현재 누적 한도", currentMoney(budget.capUnits)],
            ["확인된 사용 금액", currentMoney(budget.recognizedUnits)],
            ["미정산 예약 금액", currentMoney(budget.heldUnits)],
            ["현재 가용액", currentMoney(budget.availableUnits)],
          ] as const
        ).map(([label, amount]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words font-medium [overflow-wrap:anywhere]">{amount}</dd>
          </div>
        ))}
      </dl>
      {budget.deficitUnits !== "0" && (
        <p>이미 발생한 누적 초과액: {currentMoney(budget.deficitUnits)}</p>
      )}
      {assessment.basis !== "incompatible" && (
        <div className="space-y-1">
          <p className="font-medium">
            {assessment.basis === "unapproved-proposal"
              ? "미승인 제안 한도를 적용했을 때의 가정 계산"
              : "현재 예산에서 한 건을 추가 예약했을 때의 가정 계산"}
          </p>
          <p>추가 예약 계산액: {proposalMoney(review.reservation.totalUnits)}</p>
          <p>추가 예약 후 가용액: {proposalMoney(assessment.availableAfterReservationUnits!)}</p>
          <p>추가 예약에 부족한 금액: {proposalMoney(assessment.shortfallUnits!)}</p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        조회로 예산·사용액·예약액은 바뀌지 않습니다. 제안 한도는 기존 예산을 덮어쓰지 않습니다.
      </p>
      <p className="break-words text-xs [overflow-wrap:anywhere]">
        재확인 기한: {review.expiresAt}. 기한이 지나거나 예산이 바뀌면 다시 읽기로 확인해 주세요.
      </p>
      <p className="text-xs text-muted-foreground">
        정책 채택은 별도 확인이 필요합니다. 조회로 추가 예약·전송이 실행되지는 않습니다.
      </p>
    </section>
  );
}
