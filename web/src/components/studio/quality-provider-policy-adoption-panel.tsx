"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CandidateRegistrySnapshot } from "@/lib/studio-plan-quality-candidate-registry-types";
import type {
  ProviderPolicyInspection,
  ProviderPolicyInspectionResponse,
} from "@/lib/studio-plan-quality-provider-policy-http-types";
import { qualityProviderMoney } from "./quality-provider-proposal-details";
import {
  browserPolicyOutbox,
  policyOutboxKey,
  PolicyOutboxError,
  type PolicyAdoptionOutbox,
  type PolicyJournal,
} from "./quality-provider-policy-outbox";

const buttonClass = "h-auto min-h-11 min-w-0 max-w-full whitespace-normal break-words py-2";
const noop = () => undefined;
const errorMessage = (error: unknown) =>
  error instanceof PolicyOutboxError
    ? error.message
    : "보관 요청을 확인하지 못했습니다. 원래 요청으로 다시 확인해 주세요.";
function budgetText(review: ProviderPolicyInspection["policyReview"]) {
  const keep = review.budget.revision > 0;
  const budget = keep ? review.budget : review.proposedBudget;
  return `${keep ? "기존 누적 한도 유지" : "최초 누적 예산 설정"}: ${qualityProviderMoney(budget.capUnits, budget.unitScale!, budget.currency!)}`;
}
function saveJournal(journal: PolicyJournal) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(journal, null, 2) + "\n"], { type: "application/json;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `venturepass-policy-request-${journal.request.command.clientRequestId}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function QualityProviderPolicyApprovalForm({
  view,
  disabled,
  onApprove,
}: {
  view: ProviderPolicyInspection;
  disabled: boolean;
  onApprove: () => void;
}) {
  const [policy, setPolicy] = useState(false),
    [budget, setBudget] = useState(false);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(view.policyReview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [view.policyReview.expiresAt]);
  const incompatible = view.policyReview.assessment.state === "budget-incompatible";
  const limit = view.policyHead.revision >= 100;
  const locked = disabled || expired || incompatible || limit;
  return (
    <div className="min-w-0 space-y-3 text-sm leading-6">
      <p className="break-words font-medium">
        {view.scope.label} · 등록 v{view.scope.version}
      </p>
      <p className="break-words [overflow-wrap:anywhere]">고정 모델: {view.model}</p>
      <p className="font-medium">{budgetText(view.policyReview)}</p>
      <p>
        정책과 예산 선택만 저장합니다. 후보 한 건의 비용 예약과 AI 전송은 별도 승인이 필요합니다.
      </p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0"
          checked={policy}
          disabled={locked}
          onChange={(event) => setPolicy(event.target.checked)}
        />
        <span>위 후보의 고정 모델·공식 근거·비용·보관 조건을 확인하고 이 정책을 채택합니다.</span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0"
          checked={budget}
          disabled={locked}
          onChange={(event) => setBudget(event.target.checked)}
        />
        <span>
          {budgetText(view.policyReview)}에 동의합니다. 기존 사용액·예약액을 초기화하거나 한도를
          증액하지 않습니다.
        </span>
      </label>
      {expired && <p role="status">검토 기한이 지났습니다. 검토안을 다시 읽어 주세요.</p>}
      {incompatible && <p role="status">기존 예산과 통화·단위가 달라 채택할 수 없습니다.</p>}
      {limit && <p role="status">정책 기록 보관 한도에 도달했습니다.</p>}
      <Button
        className={buttonClass}
        disabled={locked || !policy || !budget}
        onClick={() => {
          if (policy && budget && !locked) onApprove();
        }}
      >
        {view.policyReview.budget.revision
          ? "정책 채택 · 기존 예산 유지"
          : "정책 채택 및 최초 예산 설정"}
      </Button>
    </div>
  );
}

/** Mounted independently of the selected registry so pending commands survive a reload/selection change. */
export function QualityProviderPolicyAdoptionPanel({
  registry,
  view,
  disabled = false,
  onBusyChange = noop,
  onResolved = noop,
}: {
  registry: CandidateRegistrySnapshot | null;
  view: ProviderPolicyInspectionResponse | null;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onResolved?: () => void;
}) {
  const controller = useRef<PolicyAdoptionOutbox | null>(null);
  const mounted = useRef(false),
    busy = useRef(false),
    readToken = useRef<symbol | null>(null),
    observedResolution = useRef("");
  const [journal, setJournal] = useState<PolicyJournal | null>(null);
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
        controller.current = browserPolicyOutbox();
        await refresh();
      } catch (error) {
        if (mounted.current) setError(errorMessage(error));
      } finally {
        if (mounted.current) setAvailable(controller.current !== null);
      }
    };
    void initialize();
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === policyOutboxKey) void refresh();
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
  async function run(action: (outbox: PolicyAdoptionOutbox) => Promise<unknown>) {
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
  if (!journal && view?.viewVersion !== 5 && !error) return null;
  const locked = working || disabled || !ready;
  return (
    <section
      aria-label="정책 채택·요청 복구"
      className="min-w-0 space-y-3 rounded-lg border bg-background p-3"
    >
      <h4 className="font-semibold">정책 채택·요청 복구</h4>
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
              ? "정책 채택 저장 확인"
              : journal.outcome.state === "refused"
                ? "첫 채택 요청 거절 확인"
                : "채택 결과 미확인 · 원래 요청 보관 중"}
          </p>
          <p>
            {journal.request.approvedReview.scope.label} · 등록 v{journal.request.command.version}
          </p>
          <p>{budgetText(journal.request.approvedReview)}</p>
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
                  ? "정책과 예산 선택을 저장했습니다. 비용 예약·AI 전송은 실행하지 않았습니다."
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
      ) : view?.viewVersion === 5 && registry && ready ? (
        <QualityProviderPolicyApprovalForm
          key={view.viewDigest}
          view={view}
          disabled={locked}
          onApprove={() =>
            void run((outbox) => outbox.begin(view, registry, { policy: true, budget: true }))
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
