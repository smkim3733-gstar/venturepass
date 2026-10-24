"use client";

import { useEffect, useRef, useState } from "react";
import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import { currentCandidateSelection } from "@/lib/studio-candidate-selection-types";
import {
  preparationRunSchema,
  type PreparationRequest,
  type PreparationRun,
} from "@/lib/studio-preparation-types";
import { jsonBody, studioFetch } from "./shared";

export type PreparationAction =
  | { action: "start" }
  | { action: "resume"; runId: string }
  | { action: "continue"; runId: string; candidateId: string; candidateDigest: string };

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

/** Browser network/parse failures carry English engine text; show what the user can do instead. */
export function preparationErrorMessage(caught: unknown, fallback: string) {
  if (caught instanceof PreparationHttpError) return caught.message;
  if (caught instanceof TypeError || caught instanceof SyntaxError)
    return "앱에서 응답을 받지 못했습니다. 이 PC에서 앱이 실행 중인지 확인한 뒤 저장 상태를 확인해 주세요.";
  return caught instanceof Error ? caught.message : fallback;
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

type Options = {
  company: StudioCase;
  /** Local edits or another busy surface; blocks both new requests and status reads. */
  disabled: boolean;
  /** Another tool is running; blocks new requests but still allows status reads. */
  externalBusy?: boolean;
  onBusyChange: (message: string) => void;
  onCompany: (company: StudioCase) => void;
  onUnsettledChange?: (unsettled: boolean) => void;
};

/**
 * Shared local preparation runner (no external AI). An uncertain response is never retried
 * automatically: the caller can only replay the identical request or read the saved state.
 */
export function useLocalPreparation({
  company,
  disabled: blockedByCaller,
  externalBusy = false,
  onBusyChange,
  onCompany,
  onUnsettledChange,
}: Options) {
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
  const disabled = blockedByCaller || requesting;
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
      setError(preparationErrorMessage(caught, "로컬 준비 결과를 확인하지 못했습니다."));
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
        setError(preparationErrorMessage(caught, "저장 상태를 확인하지 못했습니다."));
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setRequesting(false);
        onBusyChange("");
      }
    }
  }

  return {
    runs,
    run,
    action,
    disabled,
    error,
    uncertain,
    checkRequired,
    serverRunning,
    execute,
    refresh,
  };
}
