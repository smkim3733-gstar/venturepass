"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderReservationInspectionResponse } from "@/lib/studio-plan-quality-provider-reservation-http-types";
import type { ProviderReservationReview } from "@/lib/studio-plan-quality-provider-reservation-review-types";
import { qualityProviderMoney } from "./quality-provider-proposal-details";
import { policyOutboxKey } from "./quality-provider-policy-outbox";
import { reservationOutboxKey } from "./quality-provider-reservation-outbox";
import {
  fetchProviderReservationInspection,
  qualityProviderReservationArchive,
} from "./quality-provider-reservation-ui";

const buttonClass = "h-auto min-h-11 min-w-0 max-w-full whitespace-normal break-words py-2";
const blockers: Record<ProviderReservationReview["assessment"]["blockers"][number], string> = {
  "policy-not-adopted": "이 후보의 정책을 먼저 채택해 주세요.",
  "policy-changed": "채택 후 공식 설정이나 요청 조건이 바뀌었습니다. 정책을 다시 확인해 주세요.",
  "budget-not-configured": "운영 누적 예산이 아직 설정되지 않았습니다.",
  "budget-insufficient": "현재 가용액이 후보 한 건의 추가 예약액보다 적습니다.",
  "budget-incompatible": "현재 예산의 통화 또는 금액 단위가 제안과 다릅니다.",
  "budget-bound-breached": "이전 사용 내역의 누적 한도 초과를 먼저 확인해 주세요.",
  "candidate-unsettled": "같은 후보의 미정산 기록이 남아 있습니다.",
  "run-limit": "공유 실행 기록 20건 한도에 도달했습니다.",
};
const unavailable: Record<
  Extract<ProviderReservationInspectionResponse, { status: "unavailable" }>["reason"],
  string
> = {
  "configuration-missing-or-invalid":
    "공식 운영 설정을 확인하지 못했습니다. 설정을 확인한 뒤 다시 조회해 주세요.",
  "configuration-expired": "공식 운영 근거가 만료됐습니다. 근거를 갱신한 뒤 다시 조회해 주세요.",
  "selection-invalid": "선택한 등록본과 후보가 일치하지 않습니다. 등록본을 다시 열어 주세요.",
  "ledger-after-inspection":
    "현재 시각보다 미래의 기록이 있습니다. PC 시각과 기록을 확인해 주세요.",
};
export function QualityProviderReservationDetails({
  value,
  expired,
}: {
  value: ProviderReservationInspectionResponse;
  expired: boolean;
}) {
  if (value.status === "unavailable")
    return (
      <p role="status" className="text-sm leading-6">
        {unavailable[value.reason]}
      </p>
    );
  const review = value.review,
    policy = review.policyReview,
    budget = policy.budget;
  const money = (units: string) =>
    budget.currency !== null && budget.unitScale !== null
      ? qualityProviderMoney(units, budget.unitScale, budget.currency)
      : "미설정";
  return (
    <div className="min-w-0 space-y-3 text-sm leading-6">
      <p className="font-semibold" role="status">
        {expired
          ? "예약 검토 기한 경과 · 다시 조회 필요"
          : review.assessment.state === "conditions-met"
            ? "조회 당시 예약 검토 조건 충족 · 별도 예약 필요"
            : "예약 검토 보완 필요"}
      </p>
      <p>
        {policy.scope.label} · 등록 v{policy.scope.version}
      </p>
      <p>
        선택 후보의 채택 기록:{" "}
        {review.policy.reference
          ? `r${review.policy.reference.revision} · ${review.policy.state === "matched" ? "현재 조건과 일치" : "현재 조건과 달라짐"}`
          : "미채택"}
        . 전체 정책 기록: {review.policyHead.revision}건.
      </p>
      {!!review.assessment.blockers.length && (
        <ul className="list-disc space-y-1 pl-5">
          {review.assessment.blockers.map((code) => (
            <li key={code}>{blockers[code]}</li>
          ))}
        </ul>
      )}
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
        {[
          ["현재 누적 한도", money(budget.capUnits)],
          ["확인된 사용 금액", money(budget.recognizedUnits)],
          ["미정산 예약 금액", money(budget.heldUnits)],
          ["현재 가용액", money(budget.availableUnits)],
          [
            "추가 예약 계산액",
            qualityProviderMoney(
              policy.reservation.totalUnits,
              policy.proposedBudget.unitScale,
              policy.proposedBudget.currency,
            ),
          ],
        ].map(([label, amount]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words font-medium [overflow-wrap:anywhere]">{amount}</dd>
          </div>
        ))}
      </dl>
      <p>
        전체 실행 기록 {review.runs.globalCount}/20건 · 운영 기록 {review.runs.productionCount}건 ·
        이 후보 미정산 {review.runs.unsettledCandidateRunIds.length}건
      </p>
      <p className="break-words text-xs [overflow-wrap:anywhere]">
        조회 시각: {policy.inspectedAt}
        <br />
        재확인 기한: {policy.expiresAt}
        <br />
        현재 예산 기록: r{budget.revision}
      </p>
      <p className="text-xs text-muted-foreground">
        조회 시점의 검토입니다. 기한이 남아 있어도 정책·예산·실행 기록이 바뀌면 다시 확인해야
        합니다. 검토 조건 충족은 예약이나 전송 승인을 뜻하지 않습니다.
      </p>
      <details className="min-w-0 text-xs">
        <summary className="cursor-pointer">채택·원장 연결 정보</summary>
        <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {JSON.stringify(
            {
              policy: review.policy,
              policyHead: review.policyHead,
              budgetHead: budget.headDigest,
              ledgerDigest: review.ledgerDigest,
              reviewDigest: review.reviewDigest,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
/** Parent remounts on selection/policy changes; only a current read may publish or download. */
export function QualityProviderReservationPanel({
  registry,
  candidateId,
  disabled,
  onBusyChange,
  onReviewChange,
}: {
  registry: CandidateRegistrySnapshot;
  candidateId: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onReviewChange: (value: ProviderReservationInspectionResponse | null) => void;
}) {
  const [value, setValue] = useState<ProviderReservationInspectionResponse | null>(null);
  const [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const mounted = useRef(false),
    sequence = useRef(0),
    busy = useRef(false),
    controller = useRef<AbortController | null>(null);
  const invalidate = useCallback(() => {
    sequence.current++;
    controller.current?.abort();
    setValue(null);
    onReviewChange(null);
    setExpired(false);
    setError("");
  }, [onReviewChange]);
  useEffect(() => {
    mounted.current = true;
    onReviewChange(null);
    const mountSequence = ++sequence.current;
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === policyOutboxKey || event.key === reservationOutboxKey)
        invalidate();
    };
    const changed = () => invalidate();
    window.addEventListener("storage", storage);
    window.addEventListener("focus", changed);
    window.addEventListener("pageshow", changed);
    return () => {
      mounted.current = false;
      sequence.current = mountSequence + 1;
      controller.current?.abort();
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", changed);
      window.removeEventListener("pageshow", changed);
    };
  }, [invalidate, onReviewChange]);
  useEffect(() => {
    onBusyChange(working);
    return () => onBusyChange(false);
  }, [working, onBusyChange]);
  useEffect(() => {
    if (value?.status !== "review") return;
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(value.review.policyReview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [value]);
  async function work(download = false) {
    if (disabled || busy.current || (download && !value)) return;
    busy.current = true;
    setWorking(true);
    setError("");
    const serial = ++sequence.current;
    const active = () => mounted.current && serial === sequence.current;
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 30000);
    if (!download) {
      setValue(null);
      onReviewChange(null);
      setExpired(false);
    }
    try {
      if (download) {
        const archive = await qualityProviderReservationArchive(value, registry, candidateId);
        if (!active()) return;
        const url = URL.createObjectURL(
          new Blob([archive.text], { type: "application/json;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = archive.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const result = await fetchProviderReservationInspection(
          registry,
          candidateId,
          abort.signal,
        );
        if (active() && !abort.signal.aborted) {
          setValue(result);
          onReviewChange(result);
        }
      }
    } catch {
      if (active()) {
        setValue(null);
        onReviewChange(null);
        setError("예약 검토를 확인하지 못했습니다. 다시 조회해 주세요.");
      }
    } finally {
      clearTimeout(timer);
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  return (
    <section
      aria-label="후보 예약 검토"
      className="min-w-0 space-y-3 rounded-xl border bg-background p-4"
    >
      <h4 className="font-semibold">후보 예약 검토</h4>
      <p className="text-sm leading-6 text-muted-foreground">
        채택한 정책과 현재 예산을 함께 확인합니다. 조회·다운로드로 비용 예약이나 AI 전송은 실행되지
        않습니다.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          className={buttonClass}
          variant="outline"
          disabled={disabled || working}
          onClick={() => void work()}
        >
          {working ? "예약 검토 확인 중…" : value ? "예약 검토 다시 조회" : "예약 검토 조회"}
        </Button>
        {value && (
          <Button
            className={buttonClass}
            variant="outline"
            disabled={disabled || working}
            onClick={() => void work(true)}
          >
            예약 검토 조회본 JSON 내려받기
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {value && <QualityProviderReservationDetails value={value} expired={expired} />}
    </section>
  );
}
