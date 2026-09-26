"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import { currentCandidateSelection } from "@/lib/studio-candidate-selection-types";
import {
  preparationRunSchema,
  type PreparationRequest,
  type PreparationRun,
} from "@/lib/studio-preparation-types";
import { Notice, formatDate, jsonBody, studioFetch } from "./shared";

type PreparationTab = "profile" | "sources" | "diagnosis" | "analysis" | "plan";
type PreparationAction =
  | { action: "start" }
  | { action: "resume"; runId: string }
  | { action: "continue"; runId: string; candidateId: string; candidateDigest: string };
type Props = {
  company: StudioCase;
  dirty: boolean;
  busy: boolean;
  externalBusy?: boolean;
  onBusyChange: (message: string) => void;
  onCompany: (company: StudioCase) => void;
  onUnsettledChange?: (unsettled: boolean) => void;
  goTo: (tab: PreparationTab) => void;
};

const statusLabels: Record<PreparationRun["status"], string> = {
  running: "저장된 지점에서 진행 확인 필요",
  awaiting_choice: "신청 아이템 선택 필요",
  awaiting_materials: "기술 설명·자료 보강 필요",
  awaiting_review: "초안과 점검 의견 준비 · 담당자 검토 필요",
  blocked: "조건이 달라져 진행 보류",
  failed: "중단 지점 확인 필요",
};
const phaseLabels: Record<PreparationRun["phase"], string> = {
  diagnosis: "사전진단",
  analysis: "자료 기반 아이템 분석",
  choice: "신청 아이템 선택",
  plan: "자료 기반 원고",
  review: "규칙 점검 결과",
};
const stepLabels: Record<PreparationRun["steps"][number]["phase"], string> = {
  diagnosis: "사전진단",
  analysis: "아이템 분석",
  selection: "아이템 선택",
  plan: "원고",
};
const stateLabels = { created: "새로 준비", reused: "기존 결과 사용", selected: "선택 반영" };

export function preparationWasRejected(status: number, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (body.accepted === true) return false;
  return (
    body.accepted === false ||
    ([400, 403, 413, 415].includes(status) && typeof body.code === "string")
  );
}

class PreparationHttpError extends Error {
  constructor(
    public rejected: boolean,
    message: string,
  ) {
    super(message);
  }
}

async function sendPreparation(endpoint: string, request: PreparationRequest): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    cache: "no-store",
    ...jsonBody(request),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const message =
      typeof body.error === "string" ? body.error : "로컬 준비 요청을 처리하지 못했습니다.";
    const code = typeof body.code === "string" ? ` (${body.code})` : "";
    throw new PreparationHttpError(preparationWasRejected(response.status, value), message + code);
  }
  return value;
}

export function preparationAction(
  company: StudioCase,
  run: PreparationRun | null,
): PreparationAction | null {
  if (!run || run.stale) return { action: "start" };
  if (run.status === "running" || run.status === "failed")
    return { action: "resume", runId: run.id };
  if (run.status !== "awaiting_choice") return null;
  if (!currentCandidateSelection(company)) return null;
  const selected = run.candidates.find((item) => item.id === company.selectedCandidateId);
  if (!selected || !company.analysis?.candidates.some((item) => item.id === selected.id))
    return null;
  return {
    action: "continue",
    runId: run.id,
    candidateId: selected.id,
    candidateDigest: selected.digest,
  };
}

/** Never accept a result for another company, an older revision, or a missing checkpoint. */
export function validatePreparationResponse(
  value: unknown,
  company: Pick<StudioCase, "id" | "revision">,
  request: PreparationRequest,
): { company: StudioCase; run: PreparationRun } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const next = caseSchema.safeParse(raw.company);
  const run = preparationRunSchema.safeParse(raw.run);
  if (
    !next.success ||
    !run.success ||
    next.data.id !== company.id ||
    next.data.revision < company.revision ||
    !run.data.requests.some((entry) => entry.clientRequestId === request.clientRequestId) ||
    (request.action !== "start" && run.data.id !== request.runId)
  )
    return null;
  const stored = next.data.preparationRuns.filter((entry) => entry.id === run.data.id);
  if (stored.length !== 1 || JSON.stringify(stored[0]) !== JSON.stringify(run.data)) return null;
  return { company: next.data, run: run.data };
}

export function validatePreparationSnapshot(
  value: unknown,
  companyValue: unknown,
  binding: Pick<StudioCase, "id" | "revision">,
): { company: StudioCase; running: boolean } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const runs = preparationRunSchema.array().safeParse(raw.runs);
  const next = caseSchema.safeParse(companyValue);
  if (!runs.success || !next.success || typeof raw.running !== "boolean") return null;
  const requests = runs.data.flatMap((entry) => entry.requests.map((item) => item.clientRequestId));
  if (
    next.data.id !== binding.id ||
    next.data.revision < binding.revision ||
    next.data.revision !== raw.companyRevision ||
    JSON.stringify(next.data.preparationRuns) !== JSON.stringify(runs.data) ||
    new Set(runs.data.map((entry) => entry.id)).size !== runs.data.length ||
    new Set(requests).size !== requests.length
  )
    return null;
  return { company: next.data, running: raw.running };
}

export function PreparationRunView({
  run,
  plans = [],
}: {
  run: PreparationRun;
  plans?: StudioCase["plans"];
}) {
  const linked = plans.filter((plan) => plan.id === run.planId);
  const plan = linked.length === 1 ? linked[0] : null;
  const latestVersion = Math.max(0, ...plans.map((item) => item.version));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{statusLabels[run.status]}</Badge>
        {run.stale && <Badge variant="outline">현재 자료·선택과 달라진 기록</Badge>}
        <span className="text-xs text-muted-foreground">{formatDate(run.updatedAt)}</span>
      </div>
      <p className="text-sm">기록된 지점: {phaseLabels[run.phase]}</p>
      {run.steps.length > 0 && (
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          {run.steps.map((step) => (
            <li key={step.phase}>
              {stepLabels[step.phase]} · {stateLabels[step.state]} · {formatDate(step.at)}
            </li>
          ))}
        </ul>
      )}
      {run.planId && (
        <p className="text-sm leading-6">
          {plan
            ? `이 준비 기록의 원고 v${plan.version}`
            : "이 준비 기록의 원고 버전을 확인하지 못했습니다."}
          {plan && latestVersion !== plan.version && ` · 현재 최신 원고는 v${latestVersion}`}
          {plan && (
            <span className="block text-xs text-muted-foreground">
              원고 화면에서 해당 버전을 선택해 확인해 주세요.
            </span>
          )}
        </p>
      )}
      {run.status === "awaiting_review" && (
        <p className="text-sm leading-6">
          규칙 점검 의견까지 준비했습니다. 본문·수치·증빙 대조와 내부 검토 완료 표시는 담당자가
          별도로 진행합니다. 기관 제출 준비 완료를 뜻하지 않습니다.
        </p>
      )}
      {run.status === "awaiting_materials" && (
        <p className="text-sm leading-6">
          현재 자료로 신청 아이템을 묶지 못했습니다. 기술·제품 설명이나 본문을 확인한 기술 자료를
          보강한 뒤 다시 이어가세요.
        </p>
      )}
      {run.status === "awaiting_choice" && (
        <p className="text-sm leading-6">
          아이템 분석에서 근거와 부족한 자료를 읽고 신청 아이템을 직접 선택해 주세요. 후보가
          하나여도 자동 선택하지 않습니다.
        </p>
      )}
      {(run.status === "blocked" || run.status === "failed") && (
        <p className="text-sm leading-6">
          저장된 산출물은 보존했습니다. 현재 기업정보·자료와 아래 중단 코드를 확인해 주세요.
        </p>
      )}
      {run.code && <p className="text-xs text-muted-foreground">중단 코드: {run.code}</p>}
    </div>
  );
}

export function PreparationPanel({
  company,
  dirty,
  busy,
  externalBusy = false,
  onBusyChange,
  onCompany,
  onUnsettledChange,
  goTo,
}: Props) {
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [checkRequired, setCheckRequired] = useState(false);
  const [serverRunning, setServerRunning] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const pending = useRef<PreparationRequest | null>(null);
  const pendingRejected = useRef(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const context = useRef({ id: company.id, revision: company.revision });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    context.current = { id: company.id, revision: company.revision };
  }, [company.id, company.revision]);
  const runs = company.preparationRuns ?? [];
  const run = runs.at(-1) ?? null;
  const action = preparationAction(company, run);
  const disabled = dirty || busy || requesting;
  const pendingCount = company.sources.filter((source) => source.extraction === "pending").length;
  const endpoint = `/api/studio/cases/${company.id}/preparation`;
  useEffect(() => {
    onUnsettledChange?.(uncertain || checkRequired || serverRunning);
    return () => onUnsettledChange?.(false);
  }, [uncertain, checkRequired, serverRunning, onUnsettledChange]);

  function sameContext(binding: { id: string; revision: number }) {
    return (
      mounted.current &&
      context.current.id === binding.id &&
      context.current.revision === binding.revision
    );
  }
  async function execute(replay = false) {
    if (
      disabled ||
      externalBusy ||
      inFlight.current ||
      serverRunning ||
      (!replay && (uncertain || checkRequired))
    )
      return;
    const request = replay
      ? pending.current
      : action
        ? { ...action, revision: company.revision, clientRequestId: crypto.randomUUID() }
        : null;
    if (!request) return;
    const binding = { id: company.id, revision: company.revision };
    pending.current = request;
    pendingRejected.current = false;
    inFlight.current = true;
    setRequesting(true);
    setError("");
    onBusyChange("이 PC에서 사전진단·아이템·원고의 준비 상태를 이어가는 중입니다");
    try {
      const response = await sendPreparation(endpoint, request);
      if (!sameContext(binding)) return;
      const result = validatePreparationResponse(response, binding, request);
      if (!result) throw new Error("준비 결과의 기업·버전·저장 기록을 확인하지 못했습니다.");
      pending.current = null;
      setUncertain(false);
      setCheckRequired(false);
      setServerRunning(false);
      onCompany(result.company);
    } catch (caught) {
      if (!sameContext(binding)) return;
      pendingRejected.current = caught instanceof PreparationHttpError && caught.rejected;
      setUncertain(!pendingRejected.current);
      setCheckRequired(true);
      setError(caught instanceof Error ? caught.message : "로컬 준비 결과를 확인하지 못했습니다.");
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setRequesting(false);
        onBusyChange("");
      }
    }
  }
  async function refresh() {
    if (disabled || inFlight.current) return;
    const binding = { id: company.id, revision: company.revision };
    inFlight.current = true;
    setRequesting(true);
    setError("");
    onBusyChange("저장된 로컬 준비 기록을 확인하는 중입니다");
    try {
      const response = await studioFetch<unknown>(endpoint);
      const companyValue = await studioFetch<unknown>(`/api/studio/cases/${binding.id}`);
      if (!sameContext(binding)) return;
      const snapshot = validatePreparationSnapshot(response, companyValue, binding);
      if (!snapshot)
        throw new Error(
          "조회 중 기업 자료가 바뀌었거나 준비 기록을 확인하지 못했습니다. 저장 상태를 다시 확인해 주세요.",
        );
      const next = snapshot.company;
      if (pending.current) {
        const requestId = pending.current.clientRequestId;
        const matches = next.preparationRuns.filter((entry) =>
          entry.requests.some((request) => request.clientRequestId === requestId),
        );
        if (matches.length === 1) {
          pending.current = null;
          setUncertain(false);
        } else if (pendingRejected.current && !snapshot.running) {
          pending.current = null;
          setUncertain(false);
        } else if (!pendingRejected.current) {
          setUncertain(true);
          setError(
            "이 요청의 저장 기록을 아직 확인하지 못했습니다. 같은 요청으로 결과를 확인할 수 있습니다.",
          );
        }
      }
      setServerRunning(snapshot.running);
      setCheckRequired(snapshot.running);
      onCompany(next);
    } catch (caught) {
      if (sameContext(binding))
        setError(caught instanceof Error ? caught.message : "저장 상태를 확인하지 못했습니다.");
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setRequesting(false);
        onBusyChange("");
      }
    }
  }

  return (
    <section
      aria-labelledby="local-preparation-title"
      className="space-y-4 rounded-2xl border bg-white p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="local-preparation-title" className="font-bold">
            로컬 준비 이어가기
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            사전진단 → 자료 기반 아이템 분석 → 직접 선택한 아이템의 원고 → 규칙 점검을 이어갑니다.
            현재 자료에 맞는 기존 결과와 원고는 재사용합니다. 외부 AI로 전송하지 않습니다.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void execute()}
            disabled={
              disabled || externalBusy || uncertain || checkRequired || serverRunning || !action
            }
          >
            <ArrowRight />
            {action?.action === "continue"
              ? "선택한 아이템으로 이어가기"
              : action?.action === "resume"
                ? "저장된 지점부터 이어가기"
                : "로컬 준비 이어가기"}
          </Button>
          <Button variant="outline" onClick={() => void refresh()} disabled={disabled}>
            <RefreshCw />
            저장 상태 확인
          </Button>
        </div>
      </div>
      {dirty && (
        <p className="text-sm text-amber-800">편집 중인 내용을 먼저 저장하거나 취소해 주세요.</p>
      )}
      {company.selectedCandidateId && !currentCandidateSelection(company) && (
        <Notice tone="warning">
          현재 분석의 아이템 선택 이유를 먼저 기록해 주세요. 기존 선택만으로 원고 준비를 이어가지
          않습니다. 아이템 분석에서 근거를 확인하고 직접 이유를 저장할 수 있습니다.
        </Notice>
      )}
      {pendingCount > 0 && (
        <p className="text-sm text-muted-foreground">
          원본만 보관한 자료 {pendingCount}건은 본문 확인 전까지 분석 근거에서 제외합니다. 글자
          읽기·본문 검토도 자동 완료하지 않습니다.
        </p>
      )}
      {run && <PreparationRunView run={run} plans={company.plans} />}
      {run?.stale && (
        <Notice tone="warning">
          위 기록은 과거 자료·선택 기준입니다. 현재 저장한 자료로 새 준비를 시작할 수 있습니다.
        </Notice>
      )}
      {checkRequired && !uncertain && (
        <Notice tone="warning">
          {serverRunning
            ? "서버에서 준비 요청이 진행 중입니다. 저장 상태를 다시 확인해 주세요."
            : "요청이 접수되지 않았습니다. 현재 저장 상태를 확인한 뒤 이어가세요."}
        </Notice>
      )}
      {uncertain && (
        <Notice tone="warning">
          <p>
            응답을 확인하지 못했어도 일부 단계가 저장되었을 수 있습니다. 자동 재실행하지 않습니다.
            먼저 저장 상태를 확인해 주세요.
          </p>
          <Button
            className="mt-3"
            variant="outline"
            disabled={disabled || externalBusy || serverRunning}
            onClick={() => void execute(true)}
          >
            같은 요청으로 결과 확인
          </Button>
        </Notice>
      )}
      {error && (
        <div role="alert">
          <Notice tone="warning">{error}</Notice>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {run?.diagnosisId && (
          <Button variant="outline" disabled={disabled} onClick={() => goTo("diagnosis")}>
            사전진단 확인
          </Button>
        )}
        {(run?.status === "awaiting_choice" ||
          (company.selectedCandidateId && !currentCandidateSelection(company))) && (
          <Button variant="outline" disabled={disabled} onClick={() => goTo("analysis")}>
            아이템 근거·선택 이유 기록
          </Button>
        )}
        {(run?.status === "awaiting_materials" || run?.status === "blocked") && (
          <>
            <Button variant="outline" disabled={disabled} onClick={() => goTo("profile")}>
              기업정보 보강
            </Button>
            <Button variant="outline" disabled={disabled} onClick={() => goTo("sources")}>
              자료함 확인
            </Button>
          </>
        )}
        {run?.planId && (
          <Button variant="outline" disabled={disabled} onClick={() => goTo("plan")}>
            원고 버전·검토 의견 확인
          </Button>
        )}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        저장된 준비 기록을 통해 다시 이어갈 수 있습니다. 실제 자료 검토, 내부 검토 완료 표시, 벤처인
        입력·동의·제출은 이 동작에 포함되지 않습니다.
      </p>
      {runs.length > 1 && (
        <details className="border-t pt-3">
          <summary className="cursor-pointer text-sm font-semibold">
            이전 준비 기록 {runs.length - 1}개
          </summary>
          <div className="mt-4 space-y-4">
            {runs
              .slice(0, -1)
              .toReversed()
              .map((previous) => (
                <div className="rounded-xl border p-4" key={previous.id}>
                  <PreparationRunView run={previous} plans={company.plans} />
                </div>
              ))}
          </div>
        </details>
      )}
    </section>
  );
}
