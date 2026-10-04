import "server-only";
import { getStudioStore } from "./studio-storage";
import { getVentureAccountStatus } from "./venturein-vault";
import { getVentureSession } from "./venturein-runner";
import { getVentureWorkflow } from "./venturein-workflow";
import { StudioError } from "./studio-http";
import { ventureOverviewSchema } from "./venturein-overview-types";

/** Reuses the existing local journey; no browser operation, decryption or persistent write. */
export function getVentureOverview(caseId: string) {
  const store = getStudioStore();
  const company = store.get(caseId);
  const workflow = getVentureWorkflow(caseId);
  const account = getVentureAccountStatus(store, caseId);
  if (
    store.get(caseId).revision !== company.revision ||
    store.getVentureWorkflowEnvelope(caseId).revision !== workflow.revision ||
    account.revision !== workflow.accountRevision ||
    JSON.stringify(getVentureSession(caseId)) !== JSON.stringify(workflow.session)
  )
    throw new StudioError("연결 기록이 변경되었습니다. 다시 확인해 주세요.", 409, "STALE_OVERVIEW");
  return ventureOverviewSchema.parse({
    caseId,
    companyRevision: company.revision,
    workflowRevision: workflow.revision,
    accountRevision: account.revision,
    accountSaved: account.saved,
    sessionState: workflow.session.state,
    sessionUpdatedAt: workflow.session.updatedAt,
    screenObservedAt: workflow.snapshot?.screen.observedAt ?? null,
    phase: workflow.journey.phase,
    previousInputNeedsCheck: Boolean(
      workflow.execution &&
      (workflow.execution.status !== "completed" ||
        workflow.execution.code === "INPUT_RESULT_UNKNOWN"),
    ),
    readAt: new Date().toISOString(),
    automaticSubmissionAvailable: false,
    officialStatusChecked: false,
    transmissionAllowed: false,
  });
}
