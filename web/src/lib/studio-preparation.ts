// Fixed local-only orchestration. This module never calls the official portal runner.
import { analyzeCompany, generatePlan, reviewPlan } from "./studio-engine";
import { StudioError } from "./studio-http";
import {
  preparationRequestSchema,
  type PreparationRequest,
  type PreparationRun,
} from "./studio-preparation-types";
import type { StudioCase } from "./studio-schema";
import type { StudioStore } from "./studio-storage";
import { assertVentureCompanyWritable } from "./venturein-input-lock";
import { currentVerifiedCandidateSelection } from "./studio-candidate-selection";
import { studioGenerationJobs } from "./studio-generation-lock";

const shared = globalThis as typeof globalThis & { __venturepassPreparationJobs?: Set<string> };
const jobs = (shared.__venturepassPreparationJobs ??= new Set<string>());
export class PreparationRequestError extends StudioError {
  constructor(
    code: string,
    status: number,
    public accepted: boolean,
  ) {
    super(
      "로컬 준비 상태와 최신 기업 버전을 확인해 주세요. 완료된 산출물은 보존합니다.",
      status,
      code,
    );
  }
}
export function localPreparationIsRunning(caseId: string) {
  return jobs.has(caseId);
}
export type PreparationResponse = { company: StudioCase; run: PreparationRun };

export async function runLocalPreparation(
  store: StudioStore,
  caseId: string,
  rawInput: PreparationRequest,
): Promise<PreparationResponse> {
  const input = preparationRequestSchema.parse(rawInput);
  if (jobs.has(caseId) || studioGenerationJobs.has(caseId))
    throw new PreparationRequestError("PREPARATION_BUSY", 409, false);
  jobs.add(caseId);
  let accepted = false;
  let company: StudioCase | undefined;
  let runId: string | undefined;
  try {
    assertVentureCompanyWritable(caseId);
    company = store.beginPreparation(caseId, input);
    accepted = true;
    const run = company.preparationRuns.find((item) =>
      item.requests.some((request) => request.clientRequestId === input.clientRequestId),
    );
    if (!run)
      throw new StudioError("로컬 준비 요청 기록을 확인해 주세요.", 409, "PREPARATION_NOT_FOUND");
    runId = run.id;
    // An acknowledged request is never converted into a new request on replay.
    // A stale result remains visible but cannot generate additional artifacts.
    if (run.stale || run.status !== "running") return { company, run };
    for (let steps = 0; steps < 3; steps++) {
      const current = company.preparationRuns.find((item) => item.id === runId)!;
      if (current.status !== "running") return { company, run: current };
      assertVentureCompanyWritable(caseId);
      if (current.phase === "diagnosis") {
        company = store.commitPreparation(caseId, company.revision, runId, { phase: "diagnosis" });
      } else if (current.phase === "analysis") {
        const content = company.analysis ? null : await analyzeCompany(company, "assisted");
        company = store.commitPreparation(caseId, company.revision, runId, {
          phase: "analysis",
          content,
        });
      } else if (current.phase === "plan") {
        if (
          !currentVerifiedCandidateSelection(company) ||
          company.selectedCandidateId !== current.selectedCandidateId
        )
          throw new StudioError(
            "현재 분석의 후보와 선택 이유를 먼저 저장해 주세요.",
            409,
            "PREPARATION_SELECTION_REQUIRED",
          );
        const candidate = company.analysis?.candidates.find(
          (item) => item.id === current.selectedCandidateId,
        );
        if (!candidate)
          throw new StudioError(
            "선택한 후보를 확인해 주세요.",
            409,
            "PREPARATION_CANDIDATE_CHANGED",
          );
        const content = current.planId ? null : await generatePlan(company, candidate, "assisted");
        if (content)
          content.sections = content.sections.map((section) => ({
            ...section,
            needsConfirmation: true,
          }));
        const review = content ? reviewPlan(company, content) : [];
        company = store.commitPreparation(caseId, company.revision, runId, {
          phase: "plan",
          content,
          review,
        });
      } else
        throw new StudioError("로컬 준비 단계를 확인해 주세요.", 409, "PREPARATION_STEP_INVALID");
    }
    return { company, run: company.preparationRuns.find((item) => item.id === runId)! };
  } catch (error) {
    if (accepted && company && runId) {
      try {
        company = store.failPreparation(
          caseId,
          company.revision,
          runId,
          error instanceof StudioError && error.code === "PREPARATION_STALE"
            ? "PREPARATION_STALE"
            : "PREPARATION_FAILED",
        );
        return { company, run: company.preparationRuns.find((item) => item.id === runId)! };
      } catch {
        /* A changed company or active official input lock must not be overwritten. */
      }
    }
    throw new PreparationRequestError(
      error instanceof StudioError ? error.code : "PREPARATION_FAILED",
      error instanceof StudioError ? error.status : 500,
      accepted,
    );
  } finally {
    jobs.delete(caseId);
  }
}
