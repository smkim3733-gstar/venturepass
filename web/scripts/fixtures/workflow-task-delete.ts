import { caseSchema } from "../../src/lib/studio-schema";
import { workflowTaskFixture, agencyId } from "./workflow-task-receipt";
import type { WorkflowTaskDeleteCommand } from "../../src/components/studio/workflow-task-response";
export { agencyId };
export function workflowTaskDeleteFixture() {
  const company = workflowTaskFixture().company;
  company.profile.companyName = "합성 업무 삭제 결과 기업";
  company.tasks.forEach((task) => {
    task.title = "같은 이름의 담당 업무";
  });
  const request: WorkflowTaskDeleteCommand = {
    action: "delete-task",
    revision: company.revision,
    taskId: company.tasks.at(-1)!.id,
  };
  const saved = structuredClone(company);
  saved.tasks = saved.tasks.filter((task) => task.id !== request.taskId);
  saved.revision++;
  return { company: caseSchema.parse(company), request, saved: caseSchema.parse(saved) };
}
