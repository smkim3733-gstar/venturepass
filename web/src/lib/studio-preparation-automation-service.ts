// Inject the existing assisted preparation service; this module never creates another engine.
import { z } from "zod";
import { StudioError } from "./studio-http";
import { assertVentureCompanyWritable } from "./venturein-input-lock";
import {
  preparationAutomationFingerprint,
  preparationAutomationRequestDigest,
  type AutomationTransition,
  type PreparationAutomationCompany,
} from "./studio-preparation-automation";
import {
  currentPreparationAutomationSetting,
  preparationAutomationRequestSchema,
  type PreparationAutomationBatch,
  type PreparationAutomationRequest,
  type PreparationAutomationSettingInput,
} from "./studio-preparation-automation-types";
import type { PreparationRequest, PreparationRun } from "./studio-preparation-types";

export type PreparationAutomationResponse = {
  company: PreparationAutomationCompany;
  batch: PreparationAutomationBatch;
};
/** Each mutating method must use the existing company transaction/CAS and official-input lock. */
export interface PreparationAutomationStore {
  get(caseId: string): PreparationAutomationCompany;
  setPreparationAutomation(
    caseId: string,
    input: PreparationAutomationSettingInput,
  ): PreparationAutomationCompany;
  beginPreparationAutomation(
    caseId: string,
    input: PreparationAutomationRequest,
  ): PreparationAutomationResponse & Pick<AutomationTransition, "command" | "replayed">;
  finishPreparationAutomation(
    caseId: string,
    expectedRevision: number,
    batchId: string,
    runId: string,
  ): PreparationAutomationResponse;
}
export type PreparationAutomationRuntime = {
  runPreparation(
    caseId: string,
    input: PreparationRequest,
  ): Promise<{ company: PreparationAutomationCompany; run: PreparationRun }>;
  preparationIsRunning(caseId: string): boolean;
};
const shared = globalThis as typeof globalThis & {
  __venturepassPreparationAutomationJobs?: Set<string>;
};
const jobs = (shared.__venturepassPreparationAutomationJobs ??= new Set<string>());
export class PreparationAutomationRequestError extends StudioError {
  constructor(
    code: string,
    status: number,
    public accepted: boolean,
  ) {
    super(
      "로컬 준비 연결의 저장 상태를 확인해 주세요. 같은 요청 번호와 기존 산출물을 보존합니다.",
      status,
      code,
    );
  }
}
export function preparationAutomationIsRunning(caseId: string) {
  return jobs.has(caseId);
}
function fail(code: string): never {
  throw new StudioError("로컬 준비 연결을 다시 확인해 주세요.", 409, code);
}
export function getPreparationAutomationStatus(
  store: PreparationAutomationStore,
  runtime: PreparationAutomationRuntime,
  caseId: string,
) {
  z.string().uuid().parse(caseId);
  const company = store.get(caseId);
  if (company.id !== caseId) fail("AUTOMATION_RECORD_INVALID");
  return { company, active: jobs.has(caseId) || runtime.preparationIsRunning(caseId) };
}
function savedRequest(store: PreparationAutomationStore, caseId: string, nonce: string) {
  try {
    return Boolean(
      store
        .get(caseId)
        .preparationAutomation?.batches.some((batch) =>
          batch.requests.some((request) => request.clientRequestId === nonce),
        ),
    );
  } catch {
    return true;
  } // A failed read cannot establish that a checkpoint was never accepted.
}
export async function runPreparationAutomation(
  store: PreparationAutomationStore,
  runtime: PreparationAutomationRuntime,
  caseId: string,
  raw: PreparationAutomationRequest,
): Promise<PreparationAutomationResponse> {
  z.string().uuid().parse(caseId);
  const input = preparationAutomationRequestSchema.parse(raw);
  if (jobs.has(caseId) || runtime.preparationIsRunning(caseId))
    throw new PreparationAutomationRequestError(
      "AUTOMATION_BUSY",
      409,
      savedRequest(store, caseId, input.clientRequestId),
    );
  jobs.add(caseId);
  let accepted = false;
  try {
    assertVentureCompanyWritable(caseId);
    const started = store.beginPreparationAutomation(caseId, input);
    accepted = true;
    const { company, batch, command } = started;
    if (
      company.id !== caseId ||
      !batch.requests.some(
        (request) =>
          request.clientRequestId === input.clientRequestId &&
          request.digest === preparationAutomationRequestDigest(input),
      )
    )
      fail("AUTOMATION_RECORD_INVALID");
    if (started.replayed || !command) return { company, batch };
    // A permission or company edit between durable checkpoint and execution must stop here.
    const current = store.get(caseId),
      currentBatch = current.preparationAutomation?.batches.find((item) => item.id === batch.id),
      permission = currentPreparationAutomationSetting(current.preparationAutomation);
    if (
      current.id !== caseId ||
      current.revision !== company.revision ||
      !permission?.enabled ||
      permission.version !== batch.settingVersion ||
      current.preparationAutomation?.caseId !== caseId ||
      JSON.stringify(currentBatch) !== JSON.stringify(batch) ||
      batch.inputFingerprint !== preparationAutomationFingerprint(current)
    )
      fail("AUTOMATION_STALE");
    assertVentureCompanyWritable(caseId);
    if (runtime.preparationIsRunning(caseId)) fail("AUTOMATION_BUSY");
    const result = await runtime.runPreparation(caseId, { ...command, revision: current.revision });
    if (
      result.company.id !== caseId ||
      result.run.mode !== "assisted" ||
      !result.run.requests.some((request) => request.clientRequestId === command.clientRequestId) ||
      !result.company.preparationRuns.some(
        (run) => run.id === result.run.id && JSON.stringify(run) === JSON.stringify(result.run),
      )
    )
      fail("AUTOMATION_RECORD_INVALID");
    return store.finishPreparationAutomation(
      caseId,
      result.company.revision,
      batch.id,
      result.run.id,
    );
  } catch (error) {
    throw new PreparationAutomationRequestError(
      error instanceof StudioError && /^[A-Z0-9_]{1,100}$/.test(error.code)
        ? error.code
        : "AUTOMATION_FAILED",
      error instanceof StudioError && error.status >= 400 && error.status <= 599
        ? error.status
        : 500,
      accepted || savedRequest(store, caseId, input.clientRequestId),
    );
  } finally {
    jobs.delete(caseId);
  }
}
