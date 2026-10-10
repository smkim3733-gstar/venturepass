import { caseSchema, taskSchema, type StudioCase, type WorkflowTask } from "@/lib/studio-schema";
import { resolveTaskPlanReference } from "@/lib/studio-task-processing-types";

export type WorkflowTaskCommand = { action: "task"; revision: number; task: WorkflowTask };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export type WorkflowTaskDeleteCommand = { action: "delete-task"; revision: number; taskId: string };

function unchangedTaskContext(raw: unknown, company: StudioCase, revision: number) {
  const response = caseSchema.safeParse(raw),
    before = caseSchema.safeParse(company);
  if (!response.success || !before.success) return null;
  const saved = response.data,
    base = before.data;
  if (revision !== base.revision || saved.id !== base.id || saved.revision <= base.revision)
    return null;
  if (
    [base.tasks, saved.tasks].some((tasks) => new Set(tasks.map((t) => t.id)).size !== tasks.length)
  )
    return null;
  for (const key of [
    "profile",
    "companyContacts",
    "sources",
    "analysis",
    "selectedCandidateId",
    "candidateSelections",
    "plans",
    "planReviewDecisions",
    "agencyRecords",
    "applications",
    "applicationEvents",
    "stage",
    "stageHistory",
  ] as const)
    if (!equal(saved[key], base[key])) return null;
  return { saved, base };
}

/** Only the explicitly selected, unique task may disappear. No writer is invoked. */
export function workflowTaskDeleteAcknowledged(
  raw: unknown,
  company: StudioCase,
  command: WorkflowTaskDeleteCommand,
) {
  const context = unchangedTaskContext(raw, company, command.revision);
  if (command.action !== "delete-task" || !context) return false;
  const { saved, base } = context;
  if (!base.tasks.some((task) => task.id === command.taskId)) return false;
  return equal(
    saved.tasks,
    base.tasks.filter((task) => task.id !== command.taskId),
  );
}

/** Compare the existing task save contract before accepting the response; no writer is invoked. */
export function workflowTaskSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  command: WorkflowTaskCommand,
) {
  const context = unchangedTaskContext(raw, company, command.revision),
    parsed = taskSchema.safeParse(command.task);
  if (command.action !== "task" || !context || !parsed.success) return false;
  const { saved, base } = context;
  const previous = base.tasks.find((t) => t.id === parsed.data.id),
    input = { ...parsed.data };
  // These origins belong to the existing task and cannot be forged/reassigned by an edit.
  delete input.diagnosisOrigin;
  delete input.agencyOrigin;
  delete input.certificateOrigin;
  if (
    input.processing?.planRefs.some(
      (ref) => resolveTaskPlanReference(base.plans, ref).state !== "matched",
    )
  )
    return false;
  const task = taskSchema.parse({
    ...input,
    ...(input.processing === undefined && previous?.processing
      ? { processing: previous.processing }
      : {}),
    ...(input.owners === undefined && previous?.owners ? { owners: previous.owners } : {}),
    ...(previous?.diagnosisOrigin ? { diagnosisOrigin: previous.diagnosisOrigin } : {}),
    ...(previous?.agencyOrigin ? { agencyOrigin: previous.agencyOrigin } : {}),
    ...(previous?.certificateOrigin ? { certificateOrigin: previous.certificateOrigin } : {}),
  });
  const expected = previous
    ? base.tasks.map((t) => (t.id === task.id ? task : t))
    : [...base.tasks, task];
  return equal(saved.tasks, expected);
}
