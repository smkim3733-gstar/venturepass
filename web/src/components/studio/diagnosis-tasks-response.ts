import {
  caseSchema,
  mutationSchema,
  taskSchema,
  type CaseMutation,
  type StudioCase,
} from "@/lib/studio-schema";
import { diagnosisCriteriaVersion } from "@/lib/studio-diagnosis-types";
export type DiagnosisTasksCommand = Extract<CaseMutation, { action: "diagnosis-tasks" }>;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Confirm only the selected actions' appended tasks, keeping existing owner edits intact. */
export function diagnosisTasksSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  command: DiagnosisTasksCommand,
) {
  const response = caseSchema.safeParse(raw),
    before = caseSchema.safeParse(company),
    input = mutationSchema.safeParse(command);
  if (
    !response.success ||
    !before.success ||
    !input.success ||
    input.data.action !== "diagnosis-tasks"
  )
    return false;
  const saved = response.data,
    base = before.data,
    request = input.data;
  if (request.revision !== base.revision || saved.id !== base.id || saved.revision < base.revision)
    return false;
  for (const records of [base.tasks, saved.tasks, base.diagnoses, saved.diagnoses])
    if (new Set(records.map((record) => record.id)).size !== records.length) return false;
  if (new Set(base.diagnoses.map((d) => d.version)).size !== base.diagnoses.length) return false;
  const diagnosis = base.diagnoses.at(-1);
  if (
    !diagnosis ||
    diagnosis.id !== request.diagnosisId ||
    diagnosis.stale ||
    diagnosis.criteriaVersion !== diagnosisCriteriaVersion ||
    base.diagnoses.some((d) => d.version > diagnosis.version) ||
    new Set(diagnosis.actions.map((action) => action.id)).size !== diagnosis.actions.length
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
    "diagnosisAnswers",
    "diagnoses",
  ] as const)
    if (!equal(saved[key], base[key])) return false;
  const added: StudioCase["tasks"] = [];
  for (const actionId of request.actionIds) {
    const action = diagnosis.actions.find((value) => value.id === actionId);
    if (!action) return false;
    const matches = (task: StudioCase["tasks"][number]) =>
      task.diagnosisOrigin?.diagnosisId === diagnosis.id &&
      task.diagnosisOrigin.actionId === actionId;
    const previous = base.tasks.filter(matches),
      results = saved.tasks.filter(matches);
    if (previous.length > 1 || results.length !== 1) return false;
    if (previous.length === 1) continue; // Existing task must match the entire preserved base array below.
    const task = results[0];
    const expected = taskSchema.safeParse({
      id: task.id,
      title: action.title,
      notes: action.notes,
      category: "evidence",
      dueDate: "",
      status: "pending",
      diagnosisOrigin: { diagnosisId: diagnosis.id, actionId },
    });
    if (!expected.success || !equal(task, expected.data)) return false;
    added.push(task);
  }
  if (
    base.tasks.length + added.length > 200 ||
    (added.length > 0 && saved.revision <= base.revision)
  )
    return false;
  return equal(saved.tasks, [...base.tasks, ...added]);
}
