import { caseSchema, taskSchema, type StudioCase, type WorkflowTask } from "@/lib/studio-schema";
import { resolveTaskPlanReference } from "@/lib/studio-task-processing-types";

export type WorkflowTaskCommand = { action: "task"; revision: number; task: WorkflowTask };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Compare the existing task save contract before accepting the response; no writer is invoked. */
export function workflowTaskSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  command: WorkflowTaskCommand,
) {
  const response = caseSchema.safeParse(raw),
    before = caseSchema.safeParse(company),
    parsed = taskSchema.safeParse(command.task);
  if (!response.success || !before.success || !parsed.success) return false;
  const saved = response.data,
    base = before.data;
  if (
    command.action !== "task" ||
    command.revision !== base.revision ||
    saved.id !== base.id ||
    saved.revision <= base.revision
  )
    return false;
  if (
    [base.tasks, saved.tasks].some((tasks) => new Set(tasks.map((t) => t.id)).size !== tasks.length)
  )
    return false;
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
    if (!equal(saved[key], base[key])) return false;
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
