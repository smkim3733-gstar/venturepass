import { caseSchema, taskSchema, type StudioCase } from "../../src/lib/studio-schema";
import { agencyTaskFixture, agencyId } from "./agency-task-receipt";
import type { WorkflowTaskCommand } from "../../src/components/studio/workflow-task-response";
export { agencyId };
export function workflowTaskFixture() {
  const company = agencyTaskFixture().saved;
  company.profile.companyName = "합성 담당 업무 수정 기업";
  const task = company.tasks.at(-1)!;
  const plan = company.plans.at(-1)!,
    section = plan.content.sections[0];
  task.owners = {
    materials: "원래 자료 담당",
    writing: "원래 작성 담당",
    review: "원래 검토 담당",
  };
  task.processing = {
    stage: "collecting",
    planRefs: [
      { planId: plan.id, sectionKey: section.key, quote: section.content.split("\n")[0].trim() },
    ],
  };
  const request: WorkflowTaskCommand = {
    action: "task",
    revision: company.revision,
    task: {
      ...structuredClone(task),
      title: "  수정 업무 제목  ",
      dueDate: "2026-11-03",
      notes: "  수정 업무 메모\n둘째 줄  ",
      owners: {
        materials: "  새 자료 담당  ",
        writing: "  새 작성 담당  ",
        review: "  새 검토 담당  ",
      },
      processing: { ...structuredClone(task.processing), stage: "reviewing" },
    },
  };
  return {
    company: caseSchema.parse(company),
    request,
    saved: workflowTaskResult(company, request),
  };
}
// This synthetic fixture replaces exactly one task with the submitted canonical task.
export function workflowTaskResult(base: StudioCase, command: WorkflowTaskCommand) {
  const saved = structuredClone(base),
    task = taskSchema.parse(command.task);
  saved.tasks = saved.tasks.map((t) => (t.id === task.id ? task : t));
  saved.revision++;
  return caseSchema.parse(saved);
}
