"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderReservationInspectionResponse } from "@/lib/studio-plan-quality-provider-reservation-http-types";
import type { ProviderReservationReview } from "@/lib/studio-plan-quality-provider-reservation-review-types";
import { qualityProviderMoney } from "./quality-provider-proposal-details";
import {
  browserReservationOutbox,
  reservationOutboxKey,
  ReservationOutboxError,
  type ReservationOutbox,
  type ReservationJournal,
} from "./quality-provider-reservation-outbox";
const buttonClass = "h-auto min-h-11 min-w-0 max-w-full whitespace-normal break-words py-2";
const noop = () => undefined;
const errorMessage = (error: unknown) =>
  error instanceof ReservationOutboxError
    ? error.message
    : "보관 요청을 확인하지 못했습니다. 원래 요청으로 다시 확인해 주세요.";
const reservationAcknowledgements = {
  candidate: true,
  budget: true,
  reservation: true,
  financial: true,
  retention: true,
  retry: true,
};
function reservationText(review: ProviderReservationReview) {
  const policy = review.policyReview;
  return `후보 한 건 예약액: ${qualityProviderMoney(policy.reservation.totalUnits, policy.proposedBudget.unitScale, policy.proposedBudget.currency)}`;
}
function saveJournal(journal: ReservationJournal) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(journal, null, 2) + "\n"], { type: "application/json;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `venturepass-reservation-request-${journal.request.command.clientRequestId}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function QualityProviderReservationApprovalForm({
  view,
  disabled,
  onApprove,
}: {
  view: Extract<ProviderReservationInspectionResponse, { status: "review" }>;
  disabled: boolean;
  onApprove: () => void;
}) {
  const [checks, setChecks] = useState<boolean[]>([false, false, false, false, false, false]);
  const [expired, setExpired] = useState(false);
  const review = view.review,
    policy = review.policyReview;
  useEffect(() => {
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(policy.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [policy.expiresAt]);
  const locked = disabled || expired || review.assessment.state !== "conditions-met";
  return (
    <div className="min-w-0 space-y-3 text-sm leading-6">
      <p className="font-medium">
        {policy.scope.label} · 등록 v{policy.scope.version}
      </p>
      <p className="font-medium">{reservationText(review)}</p>
      <p>
        현재 누적 예산 안에서 이 후보 한 건의 비용만 예약합니다. AI 전송은 별도 승인이 필요합니다.
      </p>
      {[
        "선택한 후보와 채택된 정책을 확인했습니다.",
        "위 예약액과 현재 가용액을 확인했습니다. 기존 누적 한도·사용액·다른 예약은 유지합니다.",
        "이번에는 후보 한 건의 비용만 예약하며 AI 전송을 승인하지 않습니다.",
        "비용 계산은 토큰이 실제로 적합하거나 결과 품질이 보장된다는 뜻이 아님을 확인했습니다.",
        "검토안에 표시된 요청·결과·사용량 기록의 보관 조건을 확인했습니다.",
        "응답을 받지 못하면 원래 요청으로 결과를 확인하며 새 요청으로 자동 재시도하지 않습니다.",
      ].map((label, index) => (
        <label key={label} className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={checks[index]}
            disabled={locked}
            onChange={(event) =>
              setChecks((old) =>
                old.map((value, i) => (i === index ? event.target.checked : value)),
              )
            }
          />
          <span>{label}</span>
        </label>
      ))}
      {expired && <p role="status">검토 기한이 지났습니다. 예약 검토를 다시 조회해 주세요.</p>}
      {review.assessment.state !== "conditions-met" && (
        <p role="status">예약 검토의 보완 사항을 먼저 확인해 주세요.</p>
      )}
      <Button
        className={buttonClass}
        disabled={locked || !checks.every(Boolean)}
        onClick={() => {
          if (!locked && checks.every(Boolean)) onApprove();
        }}
      >
        후보 한 건 비용 예약
      </Button>
    </div>
  );
}
/** Mounted independently of the selected registry so pending commands survive a reload/selection change. */
export function QualityProviderReservationCommandPanel({
  registry,
  view,
  disabled = false,
  onBusyChange = noop,
  onResolved = noop,
}: {
  registry: CandidateRegistrySnapshot | null;
  view: ProviderReservationInspectionResponse | null;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onResolved?: () => void;
}) {
  const controller = useRef<ReservationOutbox | null>(null);
  const mounted = useRef(false),
    busy = useRef(false),
    readToken = useRef<symbol | null>(null),
    observedResolution = useRef("");
  const [journal, setJournal] = useState<ReservationJournal | null>(null);
  const [ready, setReady] = useState(false),
    [available, setAvailable] = useState(false),
    [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const serial = Symbol();
    readToken.current = serial;
    if (!controller.current) return;
    try {
      const stored = await controller.current.read();
      if (!mounted.current || serial !== readToken.current) return;
      setJournal(stored);
      setReady(true);
      const resolution =
        stored && stored.outcome.state !== "pending"
          ? `${stored.request.command.clientRequestId}:${stored.outcome.state}`
          : "";
      if (resolution && resolution !== observedResolution.current) {
        setError("");
        onResolved();
      }
      observedResolution.current = resolution;
    } catch (error) {
      if (mounted.current && serial === readToken.current) {
        setReady(false);
        setError(errorMessage(error));
      }
    }
  }, [onResolved]);
  useEffect(() => {
    mounted.current = true;
    const initialize = async () => {
      try {
        controller.current = browserReservationOutbox();
        await refresh();
      } catch (error) {
        if (mounted.current) setError(errorMessage(error));
      } finally {
        if (mounted.current) setAvailable(controller.current !== null);
      }
    };
    void initialize();
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === reservationOutboxKey) void refresh();
    };
    const focus = () => {
      void refresh();
    };
    window.addEventListener("storage", changed);
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", focus);
    return () => {
      mounted.current = false;
      readToken.current = null;
      window.removeEventListener("storage", changed);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", focus);
    };
  }, [refresh]);
  useEffect(() => {
    onBusyChange(working);
    return () => onBusyChange(false);
  }, [working, onBusyChange]);
  async function run(action: (outbox: ReservationOutbox) => Promise<unknown>) {
    if (busy.current || !controller.current || disabled || !ready) return;
    busy.current = true;
    setWorking(true);
    setError("");
    try {
      await action(controller.current);
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    } finally {
      await refresh();
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  if (!journal && view?.status !== "review" && !error) return null;
  const locked = working || disabled || !ready;
  return (
    <section
      aria-label="후보 예약·요청 복구"
      className="min-w-0 space-y-3 rounded-lg border bg-background p-3"
    >
      <h4 className="font-semibold">후보 예약·요청 복구</h4>
      {working && (
        <p role="status" className="text-sm">
          요청 보관·결과 확인 중…
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-sm leading-6 text-destructive">
          {error}
        </p>
      )}
      {!ready && !error && (
        <p className="text-sm">이 브라우저에 보관한 요청을 확인하고 있습니다.</p>
      )}
      {journal ? (
        <div className="min-w-0 space-y-3 text-sm leading-6">
          <p className="font-medium" role="status">
            {journal.outcome.state === "committed"
              ? "후보 예약 저장 확인"
              : journal.outcome.state === "refused"
                ? "첫 예약 요청 거절 확인"
                : "예약 결과 미확인 · 원래 요청 보관 중"}
          </p>
          <p>
            {journal.request.approvedReview.policyReview.scope.label} · 등록 v
            {journal.request.command.version}
          </p>
          <p>{reservationText(journal.request.approvedReview)}</p>
          <p className="break-words text-xs [overflow-wrap:anywhere]">
            요청 번호: {journal.request.command.clientRequestId}
          </p>
          {journal.outcome.state === "pending" ? (
            <>
              <p>
                새 요청을 만들지 않고 원래 요청 번호로 확인합니다. 조회에서 기록을 찾지 못하거나
                재시도가 거절돼도 이전 요청의 실패로 단정하지 않습니다.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  className={buttonClass}
                  variant="outline"
                  disabled={locked}
                  onClick={() =>
                    void run((outbox) =>
                      outbox.recover(journal.request.command.clientRequestId, "lookup"),
                    )
                  }
                >
                  기존 요청 결과 조회
                </Button>
                <Button
                  className={buttonClass}
                  variant="outline"
                  disabled={locked}
                  onClick={() =>
                    void run((outbox) =>
                      outbox.recover(journal.request.command.clientRequestId, "replay"),
                    )
                  }
                >
                  동일 요청으로 복구
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>
                {journal.outcome.state === "committed"
                  ? "예약 저장 당시의 결과입니다. 현재 상태는 다시 조회해야 하며 AI 전송은 별도 승인이 필요합니다."
                  : "이번 첫 요청이 서버에서 거절됐습니다. 결과를 닫은 뒤 최신 검토안을 다시 확인해 주세요."}
              </p>
              {journal.outcome.state === "committed" && (
                <p className="text-xs">저장 시각: {journal.outcome.receipt.recordedAt}</p>
              )}
              <Button
                className={buttonClass}
                variant="outline"
                disabled={locked}
                onClick={() =>
                  void run(async (outbox) => {
                    await outbox.dismiss(journal.request.command.clientRequestId);
                    onResolved();
                  })
                }
              >
                확인 결과 닫기
              </Button>
            </>
          )}
          <Button
            className={buttonClass}
            variant="outline"
            disabled={working}
            onClick={() => saveJournal(journal)}
          >
            원래 요청·확인 결과 JSON 내려받기
          </Button>
        </div>
      ) : view?.status === "review" && registry && ready ? (
        <QualityProviderReservationApprovalForm
          key={view.review.reviewDigest}
          view={view}
          disabled={locked}
          onApprove={() =>
            void run((outbox) => outbox.begin(view, registry, reservationAcknowledgements))
          }
        />
      ) : null}
      <Button
        className={buttonClass}
        variant="outline"
        disabled={working || !available}
        onClick={() => {
          setError("");
          void refresh();
        }}
      >
        보관 요청 다시 읽기
      </Button>
    </section>
  );
}
