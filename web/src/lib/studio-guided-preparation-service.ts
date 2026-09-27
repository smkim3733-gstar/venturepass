import {
  analyzeCompany,
  generatePlan,
  generatePlanWithRepair,
  getAiStatus,
  reviewPlan,
  StudioEngineError,
} from "./studio-engine";
import { studioGenerationJobs } from "./studio-generation-lock";
import { StudioError } from "./studio-http";
import { localPreparationIsRunning } from "./studio-preparation";
import { preparationAutomationIsRunning } from "./studio-preparation-automation-service";
import {
  guidedPreparationRequestSchema,
  type GuidedPreparationRequest,
  type GuidedPreparationRun,
} from "./studio-guided-preparation-types";
import {
  assertGuidedPreparationBinding,
  guidedPreparationApproval,
  guidedPreparationError,
} from "./studio-guided-preparation-state";
import type { StudioStore } from "./studio-storage";
import { assertVentureCompanyWritable } from "./venturein-input-lock";

export function guidedPreparationStatus(store: StudioStore, caseId: string) {
  const company = store.get(caseId),
    status = getAiStatus();
  return {
    company,
    active: studioGenerationJobs.has(caseId),
    aiConfigured: status.aiConfigured,
    approval: guidedPreparationApproval(company, status.model),
  };
}
export class GuidedPreparationRequestError extends StudioError {
  constructor(
    code: string,
    status: number,
    public accepted: boolean,
  ) {
    super(
      "AI 준비를 완료하지 못했습니다. 자료와 저장한 결과는 유지합니다. 상태를 확인한 뒤 이어가 주세요.",
      status,
      code,
    );
  }
}
export async function runGuidedPreparation(
  store: StudioStore,
  caseId: string,
  raw: GuidedPreparationRequest,
) {
  const input = guidedPreparationRequestSchema.parse(raw);
  let accepted = false;
  if (
    studioGenerationJobs.has(caseId) ||
    localPreparationIsRunning(caseId) ||
    preparationAutomationIsRunning(caseId)
  ) {
    let recorded = true;
    try {
      recorded = (store.get(caseId).guidedPreparationRuns ?? []).some((run) =>
        run.requests.some((receipt) => receipt.clientRequestId === input.clientRequestId),
      );
    } catch {
      /* Failure to read a durable receipt is uncertain. */
    }
    throw new GuidedPreparationRequestError("GUIDED_BUSY", 409, recorded);
  }
  studioGenerationJobs.add(caseId);
  let run: GuidedPreparationRun | undefined;
  let revision: number | undefined;
  try {
    assertVentureCompanyWritable(caseId);
    const configuration = getAiStatus();
    if (!configuration.aiConfigured) guidedPreparationError("AI_NOT_CONFIGURED", 503);
    const started = store.beginGuidedPreparation(caseId, input, configuration.model);
    accepted = true;
    run = started.run;
    revision = started.company.revision;
    if (started.replayed) return { company: started.company, run };
    const assertCurrent = () => {
      assertVentureCompanyWritable(caseId);
      const current = store.get(caseId),
        status = getAiStatus();
      if (current.revision !== revision) guidedPreparationError("GUIDED_INPUT_CHANGED");
      if (!status.aiConfigured || status.model !== run!.approval.model)
        guidedPreparationError("GUIDED_APPROVAL_CHANGED");
      assertGuidedPreparationBinding(current, run!);
    };
    assertCurrent();
    if (run.phase === "analysis") {
      const content = await analyzeCompany(started.company, "ai", assertCurrent);
      return store.commitGuidedPreparation(caseId, revision, run.id, {
        phase: "analysis",
        content,
      });
    }
    const candidate = started.company.analysis?.candidates.find(
      (item) => item.id === run!.candidateId,
    );
    if (!candidate) guidedPreparationError("GUIDED_SELECTION_REQUIRED");
    if (run.approval.autoRevisionLimit === 1) {
      const result = await generatePlanWithRepair(started.company, candidate, assertCurrent, {
        onInitial: (initial, initialReview) => {
          assertCurrent();
          const checkpoint = store.checkpointGuidedPlan(
            caseId,
            revision!,
            run!.id,
            initial,
            initialReview,
          );
          revision = checkpoint.revision;
        },
        beforeRepair: () => {
          assertCurrent();
          revision = store.beginGuidedRepair(caseId, revision!, run!.id).revision;
        },
      });
      assertCurrent();
      return store.commitGuidedPreparation(caseId, revision, run.id, {
        phase: "plan",
        content: result.content,
        review: result.finalReview,
        repair: {
          status: result.repairStatus,
          attempted: result.attempted,
          reason: result.repairReason,
        },
      });
    }
    const content = await generatePlan(started.company, candidate, "ai", assertCurrent);
    return store.commitGuidedPreparation(caseId, revision, run.id, {
      phase: "plan",
      content,
      review: reviewPlan(started.company, content),
    });
  } catch (error) {
    const code =
      error instanceof StudioError || error instanceof StudioEngineError
        ? error.code
        : "GUIDED_FAILED";
    if (accepted && run && revision !== undefined) {
      try {
        return store.failGuidedPreparation(caseId, revision, run.id, code);
      } catch {
        /* A changed company must never be overwritten by a late failure. */
      }
    }
    throw new GuidedPreparationRequestError(
      code,
      error instanceof StudioError || error instanceof StudioEngineError ? error.status : 500,
      accepted,
    );
  } finally {
    studioGenerationJobs.delete(caseId);
  }
}
