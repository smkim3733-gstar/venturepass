"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { StudioCase } from "@/lib/studio-schema";
import {
  canRequestPreparationAutomation,
  currentPreparationAutomationSetting,
  type PreparationAutomationBatch,
} from "@/lib/studio-preparation-automation-types";
import {
  automationActionKey,
  automationChoiceAction,
  automationErrorMessage,
  automationFailureRejected,
  automationInputDigest,
  automationNextAction,
  automationPendingEvents,
  automationReconcile,
  automationResponse,
  automationSnapshot,
  sendAutomationRequest,
  type AutomationAction,
  type AutomationInput,
  type AutomationPending,
} from "./preparation-automation-ui";
import { PreparationRunView } from "./preparation-panel";
import { Notice, formatDate } from "./shared";

type PreparationTab = "profile" | "sources" | "diagnosis" | "analysis" | "plan" | "workflow";
type Props = {
  company: StudioCase;
  dirty: boolean;
  busy: boolean;
  suspended: boolean;
  manualUnsettled: boolean;
  onBusyChange: (message: string) => void;
  onCompany: (company: StudioCase) => void;
  onUnsettledChange: (unsettled: boolean) => void;
  goTo: (tab: PreparationTab) => void;
};
export const automationStatusLabels: Record<PreparationAutomationBatch["status"], string> = {
  running: "중단 지점·저장 상태 확인 필요",
  awaiting_choice: "신청 아이템·선택 이유 기록 필요",
  awaiting_materials: "자료·기술 설명 보강 필요",
  awaiting_review: "원고·규칙 점검 준비 · 담당자 검토 필요",
  "source-review": "판독문·자료 본문 검토 필요",
  "request-review": "기관 요청·답변 직접 확인 필요",
  failed: "처리 중단 · 명시 재개 필요",
  blocked: "연결 보류",
  superseded: "현재 자료·설정과 달라진 과거 기록",
};

export function PreparationAutomationBatchView({
  company,
  batch,
}: {
  company: StudioCase;
  batch: PreparationAutomationBatch;
}) {
  const run = company.preparationRuns.filter((entry) => entry.id === batch.preparationRunId);
  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{automationStatusLabels[batch.status]}</Badge>
        <span className="text-xs text-muted-foreground">{formatDate(batch.updatedAt)}</span>
      </div>
      <p className="text-sm">
        묶인 변경 {batch.eventIds.length}건 · 본문 확인 필요 {batch.pendingSourceIds.length}건 ·
        기관 기록 {batch.agencyRecordIds.length}건
      </p>
      {batch.pendingSourceIds.length > 0 && (
        <p className="text-sm">
          원본 보관·판독만으로 본문 검토를 완료하지 않습니다. 자료함에서 원문을 대조해 주세요.
        </p>
      )}
      {batch.agencyRecordIds.length > 0 && (
        <p className="text-sm">
          기관 요청·답변은 확인 대상으로 연결했습니다. 답변 작성·발송이나 기관 처리 상태를 자동
          확정하지 않습니다.
        </p>
      )}
      {run.length === 1 && <PreparationRunView run={run[0]} plans={company.plans} />}
      {batch.code && (
        <details className="text-xs text-muted-foreground">
          <summary>진단 정보</summary>
          <p className="mt-2">{batch.code}</p>
        </details>
      )}
    </div>
  );
}

export function PreparationAutomationPanel({
  company,
  dirty,
  busy,
  suspended,
  manualUnsettled,
  onBusyChange,
  onCompany,
  onUnsettledChange,
  goTo,
}: Props) {
  const [visible, setVisible] = useState(false);
  const [checked, setChecked] = useState(false);
  const [active, setActive] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [enableAcknowledged, setEnableAcknowledged] = useState(false);
  const [autoPaused, setAutoPaused] = useState(false);
  const mounted = useRef(false);
  const current = useRef(company);
  const inFlight = useRef(false);
  const pending = useRef<AutomationPending | null>(null);
  const rejected = useRef(false);
  const attempted = useRef(new Set<string>());
  const endpoint = `/api/studio/cases/${company.id}/preparation-automation`;
  const setting = currentPreparationAutomationSetting(company.preparationAutomation);
  const enabled = setting?.enabled ?? false;
  const batches = company.preparationAutomation.batches;
  const latest = batches.at(-1) ?? null;
  const events = automationPendingEvents(company);
  const refreshDisabled = dirty || busy || requesting || suspended || !visible;
  const disabled = refreshDisabled || manualUnsettled;

  useEffect(() => {
    mounted.current = true;
    const update = () => setVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  useEffect(() => {
    current.current = company;
  }, [company]);
  useEffect(() => {
    onUnsettledChange(uncertain || active);
    return () => onUnsettledChange(false);
  }, [uncertain, active, onUnsettledChange]);
  function same(binding: StudioCase) {
    return (
      mounted.current &&
      current.current.id === binding.id &&
      current.current.revision === binding.revision
    );
  }
  function preserveChangedRequest(binding: StudioCase) {
    if (!mounted.current || current.current.id !== binding.id || !pending.current) return;
    setUncertain(true);
    setAutoPaused(true);
    setError(
      "조회·요청 중 기업 버전이 바뀌었습니다. 원래 요청 번호를 보존하며 최신 저장 상태를 확인해야 합니다.",
    );
  }

  const refresh = useCallback(async () => {
    if (inFlight.current || dirty || busy || suspended || document.visibilityState !== "visible")
      return;
    const binding = current.current;
    inFlight.current = true;
    setRequesting(true);
    setError("");
    onBusyChange("저장된 자동 준비 연결 상태를 확인하는 중입니다");
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("상태 확인 실패");
      const snapshot = automationSnapshot(await response.json(), binding);
      if (!same(binding)) {
        preserveChangedRequest(binding);
        return;
      }
      if (!snapshot) throw new Error("기업·설정·요청 기록 불일치");
      if (pending.current) {
        const resolution = automationReconcile(
          snapshot.company,
          snapshot.active,
          pending.current,
          rejected.current,
        );
        if (resolution === "unknown") {
          setUncertain(true);
          setError(
            "이 요청의 저장 여부를 아직 확인하지 못했습니다. 요청 번호를 보존하며 상태 확인만 허용합니다.",
          );
        } else {
          pending.current = null;
          rejected.current = false;
          setUncertain(false);
        }
      }
      setActive(snapshot.active);
      setChecked(true);
      current.current = snapshot.company;
      onCompany(snapshot.company);
    } catch {
      if (same(binding)) {
        setError(
          "저장 상태를 확인하지 못했습니다. 자동 요청을 보류합니다. 상태 확인을 다시 눌러 주세요.",
        );
        setAutoPaused(true);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setRequesting(false);
        onBusyChange("");
      }
    }
  }, [dirty, busy, suspended, endpoint, onBusyChange, onCompany]);

  const send = useCallback(
    async (
      action: AutomationAction | { action: "set-preparation-automation"; enabled: boolean },
    ) => {
      if (
        inFlight.current ||
        dirty ||
        busy ||
        manualUnsettled ||
        suspended ||
        uncertain ||
        pending.current ||
        document.visibilityState !== "visible"
      )
        return;
      const binding = current.current;
      const currentSetting = currentPreparationAutomationSetting(binding.preparationAutomation);
      if (
        action.action === "set-preparation-automation" &&
        (action.enabled === (currentSetting?.enabled ?? false) ||
          (action.enabled && !enableAcknowledged))
      )
        return;
      if (
        action.action !== "set-preparation-automation" &&
        (!checked || active || !currentSetting?.enabled)
      )
        return;
      const input: AutomationInput = {
        ...action,
        revision: binding.revision,
        clientRequestId: crypto.randomUUID(),
        expectedSettingVersion: currentSetting?.version ?? 0,
      };
      inFlight.current = true;
      setRequesting(true);
      setError("");
      setErrorCode("");
      onBusyChange(
        action.action === "set-preparation-automation"
          ? "로컬 준비 연결 설정을 저장하는 중입니다"
          : "변경된 자료의 로컬 준비를 이어가는 중입니다",
      );
      try {
        const request: AutomationPending = {
          companyId: binding.id,
          input,
          digest: await automationInputDigest(input),
        };
        if (!same(binding)) return;
        pending.current = request;
        rejected.current = false;
        const response = await sendAutomationRequest(request);
        const value = response.value;
        if (!same(binding)) {
          preserveChangedRequest(binding);
          return;
        }
        if (!response.ok) {
          const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
          rejected.current = automationFailureRejected(response.status, value);
          const code =
            typeof body.code === "string" && /^[A-Z0-9_]{1,100}$/.test(body.code) ? body.code : "";
          setErrorCode(code);
          setError(automationErrorMessage(code));
          setUncertain(true);
          setAutoPaused(true);
          return;
        }
        const next = automationResponse(value, request);
        if (!next) throw new Error("응답 기록 불일치");
        pending.current = null;
        setUncertain(false);
        setActive(false);
        setChecked(true);
        setEnableAcknowledged(false);
        current.current = next;
        onCompany(next);
      } catch {
        if (same(binding)) {
          setError(
            "응답을 확인하지 못했습니다. 일부 단계가 저장되었을 수 있어 자동 재시도하지 않습니다.",
          );
          setUncertain(!!pending.current);
          setAutoPaused(true);
        } else preserveChangedRequest(binding);
      } finally {
        inFlight.current = false;
        if (mounted.current) {
          setRequesting(false);
          onBusyChange("");
        }
      }
    },
    [
      dirty,
      busy,
      manualUnsettled,
      suspended,
      uncertain,
      checked,
      active,
      onBusyChange,
      onCompany,
      enableAcknowledged,
    ],
  );

  // Debounce visible, idle state. A new batch coalesces all saved unassigned changes.
  useEffect(() => {
    if (disabled || checked || autoPaused || uncertain) return;
    const timer = setTimeout(() => void refresh(), 100);
    return () => clearTimeout(timer);
  }, [disabled, checked, autoPaused, uncertain, refresh]);
  useEffect(() => {
    if (
      !checked ||
      uncertain ||
      active ||
      autoPaused ||
      manualUnsettled ||
      requesting ||
      suspended ||
      !canRequestPreparationAutomation({
        enabled,
        overflow: !!company.preparationAutomation.overflow,
        sameCompanyRevision: true,
        visible,
        dirty,
        busy,
        officialInput: suspended,
      })
    )
      return;
    const action = automationNextAction(company);
    if (!action) return;
    const key = automationActionKey(company, action);
    if (attempted.current.has(key)) return;
    const timer = setTimeout(() => {
      if (document.visibilityState !== "visible" || inFlight.current) return;
      attempted.current.add(key);
      void send(action);
    }, 600);
    return () => clearTimeout(timer);
  }, [
    checked,
    uncertain,
    active,
    autoPaused,
    manualUnsettled,
    requesting,
    suspended,
    enabled,
    company,
    visible,
    dirty,
    busy,
    send,
  ]);

  const next = automationNextAction(company);
  const recoverable = batches.filter((batch) =>
    ["running", "failed", "awaiting_choice"].includes(batch.status),
  );
  return (
    <section
      aria-labelledby="preparation-automation-title"
      className="space-y-4 rounded-2xl border bg-white p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="preparation-automation-title" className="font-bold">
          자료 변경 후 로컬 준비 연결
        </h2>
        <Badge variant="outline">{enabled ? "연결 켜짐" : "연결 꺼짐 · 기본값"}</Badge>
      </div>
      <p className="text-sm leading-6">
        켜기 이후 저장한 기업정보·자료·기관 요청과 답변의 변경을 모읍니다. 이 기업 화면이 열려 있고
        편집·다른 작업이 없을 때 사전진단·자료 기반 분석·직접 선택한 아이템의 원고와 규칙 점검을
        이어갑니다. 화면을 닫으면 새 자동 작업을 시작하지 않습니다. 이미 시작한 로컬 작업은 저장
        상태에서 확인합니다.
      </p>
      <Notice>
        외부 AI 전송, 자료 본문 검토, 아이템 자동 선택, 내부 검토 완료 표시, 기관 답변 발송, 벤처인
        입력·제출은 포함하지 않습니다. 기존 원고와 확인 필요 항목은 보존합니다.
      </Notice>
      {!enabled && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={enableAcknowledged}
            disabled={disabled || uncertain}
            onChange={(event) => setEnableAcknowledged(event.target.checked)}
          />
          <span>위 로컬 준비 범위와 켜기 이후의 변경만 연결함을 확인했습니다.</span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={enabled ? "outline" : "default"}
          disabled={disabled || uncertain || (!enabled && !enableAcknowledged)}
          onClick={() => void send({ action: "set-preparation-automation", enabled: !enabled })}
        >
          {enabled ? "연결 끄기" : "로컬 준비 연결 켜기"}
        </Button>
        <Button variant="outline" disabled={refreshDisabled} onClick={() => void refresh()}>
          연결 저장 상태 확인
        </Button>
        {enabled && next && (
          <Button
            disabled={disabled || uncertain || active || !checked}
            onClick={() => void send(next)}
          >
            {next.action === "continue-batch"
              ? "선택한 아이템으로 연결 이어가기"
              : "모인 변경 지금 연결"}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        아직 묶이지 않은 변경 {events.length}건. 짧은 시간에 저장한 변경은 한 요청으로 모읍니다.
        원본만 접수한 자료와 기관 기록은 담당자 확인 안내로 연결합니다.
      </p>
      {(dirty || manualUnsettled || suspended) && (
        <p className="text-sm text-amber-800">
          편집·수동 준비의 미확인 요청 또는 벤처인 화면·열린 대화상자가 있어 자동 연결을 보류합니다.
        </p>
      )}
      {active && (
        <Notice tone="warning">
          서버의 준비 작업이 진행 중입니다. 새 작업을 시작하지 않고 저장 상태 확인으로 결과를 조회해
          주세요.
        </Notice>
      )}
      {uncertain && (
        <Notice tone="warning">
          요청 결과 확인이 필요합니다. 같은 요청 번호를 보존하며 저장 상태 조회만 수행합니다.
          조회에서 저장 기록이 없어도 전송 실패로 단정하거나 자동 재실행하지 않습니다.
        </Notice>
      )}
      {error && (
        <div role="alert">
          <Notice tone="warning">{error}</Notice>
        </div>
      )}
      {errorCode && (
        <details className="text-xs text-muted-foreground">
          <summary>진단 정보</summary>
          {errorCode}
        </details>
      )}
      {autoPaused && !uncertain && !active && (
        <div className="space-y-2">
          <p className="text-sm">
            오류 뒤 자동 연결을 일시 보류했습니다. 상태 확인 후 명시적으로 다시 허용할 수 있습니다.
          </p>
          <Button
            variant="outline"
            disabled={disabled || !checked}
            onClick={() => setAutoPaused(false)}
          >
            이후 새 변경 자동 연결 허용
          </Button>
        </div>
      )}
      {company.preparationAutomation.overflow && (
        <Notice tone="warning">
          연결 이력의 보관 한도에 도달해 자동 진행을 멈췄습니다. 기존 기록을 삭제하지 않았으며 연결
          끄기는 가능합니다.
        </Notice>
      )}
      {latest && <PreparationAutomationBatchView company={company} batch={latest} />}
      {recoverable.length > 0 && (
        <div className="space-y-3">
          {recoverable.map((batch) => {
            const choice = automationChoiceAction(company, batch);
            const oldPermission = batch.settingVersion !== (setting?.version ?? 0);
            return (
              <div
                key={batch.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border p-3"
              >
                <span className="text-sm">
                  {formatDate(batch.createdAt)} · {automationStatusLabels[batch.status]}
                </span>
                <Button
                  variant="outline"
                  disabled={
                    disabled ||
                    uncertain ||
                    active ||
                    !enabled ||
                    !checked ||
                    (batch.status === "awaiting_choice" && !choice && !oldPermission)
                  }
                  onClick={() => void send(choice ?? { action: "resume-batch", batchId: batch.id })}
                >
                  {oldPermission
                    ? "이전 설정의 중단 기록 정리"
                    : choice
                      ? "선택한 아이템으로 이어가기"
                      : batch.status === "awaiting_choice"
                        ? "아이템·선택 이유 기록 필요"
                        : "저장 지점 확인·명시 재개"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={disabled || uncertain} onClick={() => goTo("sources")}>
          자료 본문 확인
        </Button>
        <Button variant="outline" disabled={disabled || uncertain} onClick={() => goTo("analysis")}>
          아이템·선택 이유 확인
        </Button>
        <Button variant="outline" disabled={disabled || uncertain} onClick={() => goTo("workflow")}>
          기관 요청·답변 확인
        </Button>
        <Button variant="outline" disabled={disabled || uncertain} onClick={() => goTo("plan")}>
          원고 버전·검토 의견 확인
        </Button>
      </div>
      {batches.length > 1 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold">
            이전 연결 기록 {batches.length - 1}개
          </summary>
          <div className="mt-3 space-y-3">
            {batches
              .slice(0, -1)
              .toReversed()
              .map((batch) => (
                <PreparationAutomationBatchView key={batch.id} company={company} batch={batch} />
              ))}
          </div>
        </details>
      )}
    </section>
  );
}
