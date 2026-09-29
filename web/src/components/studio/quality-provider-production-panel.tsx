"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  ProviderProductionInspectionInput,
  ProviderProductionSelection,
  ProviderProductionView,
} from "@/lib/studio-plan-quality-provider-production-service-types";
import { fetchProviderProductionStatus } from "./quality-provider-production-ui";
import {
  canStartProviderProduction,
  fetchProviderProductionCommand,
  productionCommandError,
  type ProductionAction,
} from "./quality-provider-production-command-ui";

const noop = () => undefined;
const buttonClass = "h-auto min-h-11 max-w-full whitespace-normal break-words py-2";
const unavailableReasons: Record<NonNullable<ProviderProductionView["reason"]>, string> = {
  "invalid-selection": "선택한 실행의 승인 기록을 다시 확인해 주세요.",
  "execution-unavailable":
    "현재 서버에서 운영 실행을 사용할 수 없습니다. 운영 실행 설정과 원래 실행 기록을 확인해 주세요.",
  "execution-in-progress": "원래 실행을 처리 중입니다. 잠시 후 실행 기록을 조회해 주세요.",
  "recovery-capacity-full":
    "서버에서 확인이 필요한 실행이 남아 있습니다. 기존 실행을 확인한 뒤 다시 조회해 주세요.",
  "capture-not-retained":
    "서버에서 보관된 응답을 찾지 못했습니다. 원래 전송의 응답과 비용을 확인해 주세요.",
  "capture-recovery-unconfirmed":
    "응답 복구 결과를 확정하지 못했습니다. 원래 실행 기록을 확인해 주세요.",
};

const stages: Record<NonNullable<ProviderProductionView["generation"]>["lastConfirmed"], string> = {
  none: "기록 없음",
  approved: "전송 승인 저장",
  prepared: "요청 준비 저장",
  "dispatch-recorded": "전송 시작 기록",
  "response-recorded": "응답 저장",
  validated: "검증 결과 저장",
  stopped: "실행 종료",
  completed: "최종 결과 저장 완료",
};
const outcomes: Record<
  NonNullable<NonNullable<ProviderProductionView["generation"]>["stopOutcome"]>,
  string
> = {
  "before-dispatch": "전송 전 종료",
  "result-unobserved": "응답 결과 확인 필요",
  "needs-cost-review": "사용 비용 확인 필요",
  "bound-breached": "비용 한도 확인 필요",
  "output-invalid": "응답 내용 검증 실패",
};
export function QualityProviderProductionDetails({ value }: { value: ProviderProductionView }) {
  return (
    <div className="min-w-0 space-y-3 text-sm leading-6">
      <p role="status" className="font-semibold">
        {value.executionCompleted
          ? "생성·검토 최종 결과 저장 완료"
          : value.status === "stopped"
            ? "실행 종료 기록 확인"
            : value.status === "capture-recovery-required"
              ? "보관된 응답의 저장 확인 필요"
              : value.status === "unavailable"
                ? "실행 결과 확인 필요"
                : "확인된 실행 단계"}
      </p>
      {value.reason && <p>{unavailableReasons[value.reason]}</p>}
      <dl className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["생성", value.generation],
            ["검토", value.review],
          ] as const
        ).map(([name, phase]) => (
          <div key={name}>
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="font-medium">
              {phase ? stages[phase.lastConfirmed] : "아직 시작 기록 없음"}
            </dd>
            {phase?.response === "unobserved" && <dd>응답 저장을 확인하지 못했습니다.</dd>}
            {phase?.response === "recorded" && <dd>응답 저장 확인</dd>}
            {phase?.response === "captured-not-confirmed" && (
              <dd>서버가 받은 응답의 저장을 확인하지 못했습니다.</dd>
            )}
            {phase?.stopOutcome && <dd>{outcomes[phase.stopOutcome]}</dd>}
          </div>
        ))}
      </dl>
      <p>
        {value.lastAuditedRevision === null
          ? "확인된 저장 시점 없음"
          : `저장 기록 r${value.lastAuditedRevision}`}{" "}
        ·{" "}
        {value.lastAuditedBudget === "unsettled"
          ? "미정산 예약 남음"
          : value.lastAuditedBudget === "settled"
            ? "예약 정산 확인"
            : "예약 정산 확인 필요"}
      </p>
      {value.recovery === "reconcile-before-continuing" && (
        <p>원래 실행의 응답과 비용 기록을 확인해 주세요. 미확인 전송을 다시 보내지 않습니다.</p>
      )}
      {!value.executionCompleted &&
        (value.generation?.lastConfirmed === "validated" ||
          value.review?.lastConfirmed === "validated") && (
          <p>검증 기록은 저장됐으며 최종 결과 저장 완료는 아직 확인되지 않았습니다.</p>
        )}
    </div>
  );
}

type PanelProps = {
  selection: ProviderProductionInspectionInput;
  minimumRevision: number;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
};

/** Each selection/revision/availability owns its transient confirmation and async results. */
export function QualityProviderProductionPanel(props: PanelProps) {
  return (
    <ProductionSession
      key={`${props.selection.runId}:${props.selection.runDigest}:${props.minimumRevision}:${!!props.disabled}`}
      {...props}
    />
  );
}

function ProductionSession({
  selection,
  minimumRevision,
  disabled = false,
  onBusyChange = noop,
}: PanelProps) {
  const [observation, setObservation] = useState<ProviderProductionView | null>(null);
  const [trustedSelection, setTrustedSelection] = useState<ProviderProductionSelection | null>(
    null,
  );
  const [working, setWorking] = useState<"inspect" | ProductionAction | null>(null);
  const [fresh, setFresh] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const [uncertain, setUncertain] = useState(false),
    [error, setError] = useState("");
  const revisionFloor = useRef(minimumRevision);
  const mounted = useRef(false),
    serial = useRef(0),
    busy = useRef<"inspect" | ProductionAction | null>(null),
    controller = useRef<AbortController | null>(null);
  const abandon = useCallback(() => {
    serial.current++;
    controller.current?.abort();
    controller.current = null;
    if (busy.current) onBusyChange(false);
    busy.current = null;
  }, [onBusyChange]);
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      // Returning to the page invalidates consent, never dispatches or interrupts a command.
      if (busy.current) return;
      setFresh(false);
      setConfirmed(false);
    };
    window.addEventListener("focus", invalidate);
    window.addEventListener("pageshow", invalidate);
    window.addEventListener("storage", invalidate);
    document.addEventListener("visibilitychange", invalidate);
    return () => {
      mounted.current = false;
      abandon();
      window.removeEventListener("focus", invalidate);
      window.removeEventListener("pageshow", invalidate);
      window.removeEventListener("storage", invalidate);
      document.removeEventListener("visibilitychange", invalidate);
    };
  }, [abandon]);
  const stopWaiting = useCallback(() => {
    const pendingCommand = busy.current && busy.current !== "inspect";
    abandon();
    setWorking(null);
    setFresh(false);
    setConfirmed(false);
    if (pendingCommand) {
      setUncertain(true);
      setError(
        "응답 대기만 종료했습니다. 서버의 실행은 계속될 수 있습니다. 원래 실행 기록을 조회하거나 보관된 응답을 복구해 주세요.",
      );
    }
  }, [abandon]);
  const executable = fresh && observation !== null && canStartProviderProduction(observation);
  const recoverable =
    trustedSelection !== null &&
    (uncertain ||
      observation?.recovery === "server-capture" ||
      observation?.reason === "execution-unavailable" ||
      observation?.reason === "execution-in-progress" ||
      [observation?.generation?.response, observation?.review?.response].includes("unobserved"));

  async function perform(action: "inspect" | ProductionAction) {
    if (disabled || busy.current) return;
    if (action === "execute" && (!executable || !confirmed || !trustedSelection)) return;
    if (action === "recover" && !recoverable) return;
    busy.current = action;
    onBusyChange(true);
    setWorking(action);
    setFresh(false);
    setConfirmed(false);
    setError("");
    // A failed status read must not erase the known capture's recovery control.
    if (action !== "inspect") setObservation(null);
    const token = ++serial.current,
      abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    try {
      const view =
        action === "inspect"
          ? await fetchProviderProductionStatus(selection, revisionFloor.current, abort.signal)
          : await fetchProviderProductionCommand(
              action,
              trustedSelection!,
              revisionFloor.current,
              abort.signal,
            );
      if (mounted.current && token === serial.current && !abort.signal.aborted) {
        setObservation(view);
        setUncertain(false);
        if (view.lastAuditedRevision !== null)
          revisionFloor.current = Math.max(revisionFloor.current, view.lastAuditedRevision);
        if (action === "inspect") {
          setTrustedSelection(view.selection);
          setFresh(true);
        }
      }
    } catch {
      if (mounted.current && token === serial.current && !abort.signal.aborted) {
        if (action !== "inspect") setUncertain(true);
        setError(
          action === "inspect"
            ? "저장된 실행 기록을 확인하지 못했습니다. 다시 조회해 주세요."
            : productionCommandError,
        );
      }
    } finally {
      if (mounted.current && token === serial.current) {
        busy.current = null;
        controller.current = null;
        setWorking(null);
        onBusyChange(false);
      }
    }
  }
  return (
    <section
      aria-label="현재 저장된 AI 실행 기록"
      className="min-w-0 space-y-3 rounded-lg border p-3"
    >
      <h4 className="font-semibold">현재 저장된 AI 실행 기록</h4>
      <p className="text-sm leading-6">
        선택한 실행의 승인 이후 진행 단계와 예약 정산 기록을 확인합니다.
      </p>
      <Button
        variant="outline"
        className={buttonClass}
        disabled={disabled || working !== null}
        onClick={() => void perform("inspect")}
      >
        {working === "inspect" ? "실행 기록 조회 중" : "실행 기록 조회"}
      </Button>
      {executable && (
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-sm leading-6">
            운영 실행이 활성화된 서버에서 선택한 원래 승인 범위의 유료 AI 호출을 진행합니다. 자동
            재시도는 하지 않습니다.
          </p>
          <label className="flex items-start gap-2 text-sm leading-6">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmed}
              disabled={disabled || working !== null}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            선택한 승인 범위에서 유료 AI 호출을 시작함을 확인했습니다.
          </label>
          <Button
            className={buttonClass}
            disabled={disabled || working !== null || !confirmed}
            onClick={() => void perform("execute")}
          >
            {observation?.lastAuditedRevision === 5
              ? "승인된 AI 검토 이어가기"
              : "승인된 AI 실행 시작"}
          </Button>
        </div>
      )}
      {recoverable && (
        <div className="space-y-2">
          <p className="text-sm leading-6">
            서버 메모리에 남아 있는 원래 응답의 저장을 확인합니다. 복구는 새로운 AI 호출을 만들지
            않습니다. 서버가 재시작되어 응답이 사라졌다면 원래 전송의 응답과 비용을 별도로 확인해야
            합니다.
          </p>
          <Button
            variant="outline"
            className={buttonClass}
            disabled={disabled || working !== null}
            onClick={() => void perform("recover")}
          >
            서버에 보관된 응답 복구
          </Button>
        </div>
      )}
      {working && (
        <div className="space-y-2">
          <p role="status" className="text-sm">
            {working === "execute"
              ? "승인된 AI 실행 응답 대기 중"
              : working === "recover"
                ? "보관된 응답 복구 중"
                : "실행 기록 확인 중"}
          </p>
          <Button variant="outline" className={buttonClass} onClick={stopWaiting}>
            응답 대기 종료
          </Button>
        </div>
      )}
      <p className="text-xs leading-6 text-muted-foreground">
        페이지를 닫거나 응답 대기를 끝내도 서버의 실행이 취소되지는 않습니다. 다시 열었을 때 원래
        실행 기록을 조회해 주세요.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {observation && <QualityProviderProductionDetails value={observation} />}
    </section>
  );
}
