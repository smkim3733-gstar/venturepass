import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import { currentCandidateSelection } from "@/lib/studio-candidate-selection-types";
import {
  currentPreparationAutomationSetting,
  preparationAutomationBatchSchema,
  type PreparationAutomationBatch,
  type PreparationAutomationRequest,
  type PreparationAutomationSettingInput,
} from "@/lib/studio-preparation-automation-types";

export type AutomationInput = PreparationAutomationRequest | PreparationAutomationSettingInput;
export type AutomationPending = { companyId: string; input: AutomationInput; digest: string };
export type AutomationAction =
  | { action: "run-pending" }
  | { action: "resume-batch"; batchId: string }
  | { action: "continue-batch"; batchId: string; candidateId: string; candidateDigest: string };

/** One request only. An ambiguous mutation is reconciled through GET, never transport retries. */
export async function sendAutomationRequest(
  pending: AutomationPending,
  fetcher: typeof fetch = fetch,
) {
  const setting = pending.input.action === "set-preparation-automation";
  const response = await fetcher(
    `/api/studio/cases/${pending.companyId}${setting ? "" : "/preparation-automation"}`,
    {
      method: setting ? "PATCH" : "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pending.input),
    },
  );
  return { ok: response.ok, status: response.status, value: (await response.json()) as unknown };
}

export function automationFailureRejected(status: number, value: unknown): boolean {
  const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return (
    body.accepted !== true &&
    (body.accepted === false || [400, 403, 409, 413, 415, 422].includes(status))
  );
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;

export async function automationInputDigest(input: AutomationInput): Promise<string> {
  const { revision: _revision, clientRequestId: _nonce, ...rest } = input;
  void _revision;
  void _nonce;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(rest)));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function automationPendingEvents(company: StudioCase) {
  const state = company.preparationAutomation;
  const setting = currentPreparationAutomationSetting(state);
  if (!setting?.enabled || state.caseId !== company.id || state.overflow) return [];
  const assigned = new Set(state.batches.flatMap((batch) => batch.eventIds));
  return state.events.filter(
    (event) => event.settingVersion === setting.version && !assigned.has(event.id),
  );
}

export function automationChoiceAction(
  company: StudioCase,
  batch: PreparationAutomationBatch,
): AutomationAction | null {
  const setting = currentPreparationAutomationSetting(company.preparationAutomation);
  if (
    !setting?.enabled ||
    batch.settingVersion !== setting.version ||
    batch.status !== "awaiting_choice" ||
    !currentCandidateSelection(company)
  )
    return null;
  const runs = company.preparationRuns.filter((run) => run.id === batch.preparationRunId);
  if (runs.length !== 1 || runs[0].stale || runs[0].status !== "awaiting_choice") return null;
  const matches = runs[0].candidates.filter(
    (candidate) => candidate.id === company.selectedCandidateId,
  );
  if (matches.length !== 1) return null;
  return {
    action: "continue-batch",
    batchId: batch.id,
    candidateId: matches[0].id,
    candidateDigest: matches[0].digest,
  };
}

/** An interrupted request is never automatically resumed, even after a page reload. */
export function automationNextAction(company: StudioCase): AutomationAction | null {
  const state = company.preparationAutomation;
  if (
    !currentPreparationAutomationSetting(state)?.enabled ||
    state.caseId !== company.id ||
    state.overflow ||
    state.batches.some((batch) => batch.status === "running" || batch.status === "failed")
  )
    return null;
  if (automationPendingEvents(company).length) return { action: "run-pending" };
  const last = state.batches.at(-1);
  return last ? automationChoiceAction(company, last) : null;
}

/** Revision is deliberately absent: a rejected request cannot retry itself after a read refresh. */
export function automationActionKey(company: StudioCase, action: AutomationAction): string {
  return JSON.stringify([
    company.id,
    currentPreparationAutomationSetting(company.preparationAutomation)?.version,
    action,
    action.action === "run-pending"
      ? automationPendingEvents(company)
          .map((event) => event.id)
          .sort()
      : [],
  ]);
}

export function automationAcknowledged(company: StudioCase, pending: AutomationPending): boolean {
  const state = company.preparationAutomation;
  if (
    company.id !== pending.companyId ||
    company.revision < pending.input.revision ||
    state.caseId !== company.id
  )
    return false;
  const settings = state.settings.filter(
    (entry) => entry.clientRequestId === pending.input.clientRequestId,
  );
  const batches = state.batches.filter((batch) =>
    batch.requests.some((entry) => entry.clientRequestId === pending.input.clientRequestId),
  );
  const count =
    settings.length +
    batches.flatMap((batch) =>
      batch.requests.filter((entry) => entry.clientRequestId === pending.input.clientRequestId),
    ).length;
  if (count !== 1) return false;
  if (pending.input.action === "set-preparation-automation") {
    return (
      settings.length === 1 &&
      settings[0].inputDigest === pending.digest &&
      settings[0].version === pending.input.expectedSettingVersion + 1 &&
      settings[0].enabled === pending.input.enabled
    );
  }
  const batch = batches[0];
  return (
    settings.length === 0 &&
    !!batch &&
    batch.requests.some(
      (entry) =>
        entry.clientRequestId === pending.input.clientRequestId && entry.digest === pending.digest,
    ) &&
    (pending.input.action === "run-pending"
      ? batch.settingVersion === pending.input.expectedSettingVersion
      : batch.id === pending.input.batchId)
  );
}

export function automationSnapshot(
  value: unknown,
  binding: Pick<StudioCase, "id" | "revision">,
): { company: StudioCase; active: boolean } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const parsed = caseSchema.safeParse(raw.company);
  if (
    !parsed.success ||
    typeof raw.active !== "boolean" ||
    parsed.data.id !== binding.id ||
    parsed.data.revision < binding.revision
  )
    return null;
  const state = parsed.data.preparationAutomation;
  if (
    (state.caseId !== null && state.caseId !== binding.id) ||
    (state.caseId === null &&
      (state.settings.length || state.events.length || state.batches.length || state.overflow))
  )
    return null;
  const ids = [
    ...state.settings.map((entry) => entry.clientRequestId),
    ...state.batches.flatMap((batch) => batch.requests.map((entry) => entry.clientRequestId)),
  ];
  if (
    new Set(ids).size !== ids.length ||
    new Set(state.batches.map((batch) => batch.id)).size !== state.batches.length
  )
    return null;
  return { company: parsed.data, active: raw.active };
}

export function automationResponse(value: unknown, pending: AutomationPending): StudioCase | null {
  const setting = pending.input.action === "set-preparation-automation";
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const snapshot = automationSnapshot(
    { company: setting ? value : raw.company, active: false },
    { id: pending.companyId, revision: pending.input.revision },
  );
  if (!snapshot || !automationAcknowledged(snapshot.company, pending)) return null;
  if (!setting) {
    const batch = preparationAutomationBatchSchema.safeParse(raw.batch);
    if (
      !batch.success ||
      !batch.data.requests.some(
        (entry) =>
          entry.clientRequestId === pending.input.clientRequestId &&
          entry.digest === pending.digest,
      ) ||
      !snapshot.company.preparationAutomation.batches.some(
        (entry) =>
          entry.id === batch.data.id && JSON.stringify(entry) === JSON.stringify(batch.data),
      )
    )
      return null;
  }
  return snapshot.company;
}

export function automationReconcile(
  company: StudioCase,
  active: boolean,
  pending: AutomationPending,
  rejected: boolean,
): "acknowledged" | "rejected" | "unknown" {
  if (automationAcknowledged(company, pending)) return "acknowledged";
  const state = company.preparationAutomation;
  const exists =
    state.settings.some((entry) => entry.clientRequestId === pending.input.clientRequestId) ||
    state.batches.some((batch) =>
      batch.requests.some((entry) => entry.clientRequestId === pending.input.clientRequestId),
    );
  if (
    company.id === pending.companyId &&
    company.revision >= pending.input.revision &&
    rejected &&
    !active &&
    !exists
  )
    return "rejected";
  return "unknown";
}

export function automationErrorMessage(code: string): string {
  if (["AUTOMATION_BUSY", "CASE_BUSY"].includes(code))
    return "다른 준비 작업이 진행 중입니다. 저장 상태를 확인한 뒤 이어가세요.";
  if (["STALE_REVISION", "AUTOMATION_STALE", "AUTOMATION_PERMISSION_CHANGED"].includes(code))
    return "기업 자료나 연결 설정이 바뀌었습니다. 최신 저장 상태를 확인해 주세요.";
  if (code === "AUTOMATION_LIMIT")
    return "연결 기록의 보관 한도에 도달했습니다. 자동 연결을 멈추고 기존 기록과 자료를 확인해 주세요.";
  if (code === "AUTOMATION_SELECTION_REQUIRED")
    return "현재 분석의 신청 아이템과 선택 이유를 먼저 직접 기록해 주세요.";
  if (code === "AUTOMATION_NO_CHANGES") return "이 설정 이후 새로 연결할 변경 기록이 없습니다.";
  return "요청 결과를 확인하지 못했습니다. 저장 기록 확인 전에는 다음 요청을 보내지 않습니다.";
}
