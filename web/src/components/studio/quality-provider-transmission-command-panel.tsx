"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type { ProviderSnapshot } from "@/lib/studio-plan-quality-provider-types";
import type { ProviderTransmissionInspectionResponse } from "@/lib/studio-plan-quality-provider-transmission-http-types";
import type { ProviderTransmissionReview } from "@/lib/studio-plan-quality-provider-transmission-review-types";
import { qualityProviderMoney } from "./quality-provider-proposal-details";
import {
  browserTransmissionOutbox,
  transmissionOutboxKey,
  TransmissionOutboxError,
  type TransmissionOutbox,
  type TransmissionJournal,
} from "./quality-provider-transmission-outbox";
const buttonClass = "h-auto min-h-11 min-w-0 max-w-full whitespace-normal break-words py-2";
const noop = () => undefined;
const errorMessage = (error: unknown) =>
  error instanceof TransmissionOutboxError
    ? error.message
    : "보관 요청을 확인하지 못했습니다. 원래 요청으로 다시 확인해 주세요.";
const transmissionAcknowledgements = {
  external: true,
  currentPolicyAndBudget: true,
  generationAndReview: true,
  financial: true,
  retention: true,
  retry: true,
};
function transmissionText(review: ProviderTransmissionReview) {
  const money = review.financialBasis.costs;
  return `이 실행에 이미 예약된 금액: ${qualityProviderMoney(review.reservation.totalUnits, money.unitScale, money.currency)}`;
}
function saveJournal(journal: TransmissionJournal) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(journal, null, 2) + "\n"], { type: "application/json;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `venturepass-transmission-request-${journal.request.command.clientRequestId}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function QualityProviderTransmissionApprovalForm({
  view,
  disabled,
  onApprove,
}: {
  view: Extract<ProviderTransmissionInspectionResponse, { status: "review" }>;
  disabled: boolean;
  onApprove: () => void;
}) {
  const [checks, setChecks] = useState<boolean[]>([false, false, false, false, false, false]);
  const [expired, setExpired] = useState(false);
  const review = view.review;
  useEffect(() => {
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(review.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [review.expiresAt]);
  const locked = disabled || expired || review.assessment.state !== "conditions-met";
  return (
    <div className="min-w-0 space-y-3 text-sm leading-6">
      <p className="font-medium">
        {review.scope.label} · 등록 v{review.scope.version}
      </p>
      <p className="font-medium">{transmissionText(review)}</p>
      <p>
        고정 모델 {review.request.model}로 생성 1회와 생성 결과에 대한 검토 1회의 전송을 승인합니다.
        이번에는 승인 기록만 저장합니다. 실제 전송은 실행 기록 화면에서 별도로 시작합니다.
      </p>
      <p className="break-words text-xs [overflow-wrap:anywhere]">실행 번호: {review.run.id}</p>
      <p>재확인 기한: {review.expiresAt}</p>
      <div className="rounded-lg border p-3">
        <p className="font-medium">이번 승인의 보관 안내</p>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {review.retention.notice}
        </p>
        <a
          className="break-words underline [overflow-wrap:anywhere]"
          href={review.retention.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          보관 조건 근거 보기
        </a>
      </div>
      {[
        "선택한 실행의 요청 내용을 OpenAI로 외부 전송하는 데 동의합니다.",
        "생성 요청과 그 결과에서 파생할 검토 요청을 확인했습니다. 생성 1회·검토 1회 범위에 동의합니다.",
        "위에 표시된 요청·결과·사용량 기록의 정확한 보관 안내를 확인했습니다.",
        "이미 예약한 금액은 실제 토큰 적합성이나 결과 품질을 보장하지 않음을 확인했습니다.",
        "결과나 비용이 미확인이면 보류하고 원래 요청으로 확인합니다. 자동 재시도에 동의하지 않습니다.",
        "현재 채택 정책과 누적 예산·이 실행의 예약을 확인했습니다. 이번 승인으로 예산을 변경하지 않습니다.",
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
      {expired && <p role="status">검토 기한이 지났습니다. 전송 검토를 다시 조회해 주세요.</p>}
      {review.assessment.state !== "conditions-met" && (
        <p role="status">전송 검토의 보완 사항을 먼저 확인해 주세요.</p>
      )}
      <Button
        className={buttonClass}
        disabled={locked || !checks.every(Boolean)}
        onClick={() => {
          if (!locked && checks.every(Boolean) && Date.now() < Date.parse(review.expiresAt))
            onApprove();
        }}
      >
        선택 실행 전송 승인 저장
      </Button>
    </div>
  );
}
/** Mounted independently of the selected registry so pending commands survive a reload/selection change. */
export function QualityProviderTransmissionCommandPanel({
  registry,
  snapshot,
  view,
  disabled = false,
  onBusyChange = noop,
  onResolved = noop,
}: {
  registry: CandidateRegistrySnapshot | null;
  snapshot: ProviderSnapshot | null;
  view: ProviderTransmissionInspectionResponse | null;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onResolved?: () => void;
}) {
  const controller = useRef<TransmissionOutbox | null>(null);
  const mounted = useRef(false),
    busy = useRef(false),
    readToken = useRef<symbol | null>(null),
    observedResolution = useRef("");
  const [journal, setJournal] = useState<TransmissionJournal | null>(null);
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
        controller.current = browserTransmissionOutbox();
        await refresh();
      } catch (error) {
        if (mounted.current) setError(errorMessage(error));
      } finally {
        if (mounted.current) setAvailable(controller.current !== null);
      }
    };
    void initialize();
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === transmissionOutboxKey) void refresh();
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
  async function run(action: (outbox: TransmissionOutbox) => Promise<unknown>) {
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
  if (!journal && view?.status !== "review" && !error && !working) return null;
  const locked = working || disabled || !ready;
  return (
    <section
      aria-label="전송 승인·요청 복구"
      className="min-w-0 space-y-3 rounded-lg border bg-background p-3"
    >
      <h4 className="font-semibold">전송 승인·요청 복구</h4>
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
              ? "전송 승인 저장 확인"
              : journal.outcome.state === "refused"
                ? "첫 전송 승인 요청 거절 확인"
                : "전송 승인 결과 미확인 · 원래 요청 보관 중"}
          </p>
          <p>
            {journal.request.approvedReview.scope.label} · 등록 v
            {journal.request.approvedReview.scope.version}
          </p>
          <p>{transmissionText(journal.request.approvedReview)}</p>
          <p className="break-words text-xs [overflow-wrap:anywhere]">
            요청 번호: {journal.request.command.clientRequestId}
          </p>
          <p className="break-words text-xs [overflow-wrap:anywhere]">
            실행 번호: {journal.request.command.runId}
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
                  ? "승인 기록을 저장한 당시의 결과입니다. 실제 AI 전송은 실행하지 않았습니다. 현재 상태는 검토안·이력을 다시 열어 확인해 주세요."
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
            disabled={working || !ready}
            onClick={() => {
              // Read again before export; storage events can arrive after a visible render.
              if (!controller.current) return;
              void controller.current
                .read()
                .then((stored) => {
                  if (
                    !stored ||
                    stored.request.command.clientRequestId !==
                      journal.request.command.clientRequestId
                  )
                    throw new TransmissionOutboxError("CHANGED");
                  saveJournal(stored);
                })
                .catch((error) => {
                  if (mounted.current) {
                    setReady(false);
                    setError(errorMessage(error));
                  }
                });
            }}
          >
            원래 요청·확인 결과 JSON 내려받기
          </Button>
        </div>
      ) : view?.status === "review" && registry && snapshot && ready ? (
        <QualityProviderTransmissionApprovalForm
          key={view.review.reviewDigest}
          view={view}
          disabled={locked}
          onApprove={() =>
            void run((outbox) =>
              outbox.begin(view, registry, snapshot, transmissionAcknowledgements),
            )
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
