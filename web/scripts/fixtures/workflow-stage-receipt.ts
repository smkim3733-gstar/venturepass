import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import { workflowTaskFixture, agencyId } from "./workflow-task-receipt";
import type { WorkflowStageCommand } from "../../src/components/studio/workflow-stage-response";
export { agencyId };
export function workflowStageFixture() {
  const company = workflowTaskFixture().company;
  company.profile.companyName = "합성 진행 단계 기록 기업";
  company.stageHistory = [
    {
      id: agencyId(70),
      from: "drafting",
      to: "submitted",
      origin: "manual",
      recordedAt: "2026-10-09T00:00:00.000Z",
      occurredOn: "2026-10-08",
      note: "원래 담당자 기록",
    },
  ];
  const request: WorkflowStageCommand = {
    action: "stage",
    revision: company.revision,
    stage: "visit",
    occurredOn: "2026-10-10",
    note: "  확인한 합성 안내\n둘째 줄 근거  ",
  };
  return {
    company: caseSchema.parse(company),
    request,
    saved: workflowStageResult(company, request),
  };
}
// Memory-only synthetic response; no storage or institution execution.
export function workflowStageResult(base: StudioCase, command: WorkflowStageCommand) {
  const saved = structuredClone(base);
  if (base.stage !== command.stage)
    saved.stageHistory.push({
      id: agencyId(70 + base.stageHistory.length),
      from: base.stage,
      to: command.stage,
      origin: "manual",
      recordedAt: "2026-10-10T10:58:00.000Z",
      occurredOn: command.occurredOn ?? "",
      note: command.note ?? "",
    });
  saved.stage = command.stage;
  saved.revision++;
  return caseSchema.parse(saved);
}
