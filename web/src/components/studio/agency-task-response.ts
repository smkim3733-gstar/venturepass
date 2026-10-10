import { caseSchema, taskSchema, type StudioCase, type CaseMutation } from "@/lib/studio-schema";
import { currentAgencyTaskRequest } from "@/lib/studio-agency-tasks";

export type AgencyTaskCommand = Extract<CaseMutation, { action: "create-agency-task" }>;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Read-only task/result comparison; origin identifies a request version, not a server receipt. */
export function agencyTaskSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  input: AgencyTaskCommand,
) {
  const response = caseSchema.safeParse(raw),
    before = caseSchema.safeParse(company);
  if (!response.success || !before.success) return false;
  const saved = response.data,
    base = before.data;
  if (
    input.action !== "create-agency-task" ||
    input.revision !== base.revision ||
    saved.id !== base.id ||
    saved.revision < base.revision
  )
    return false;
  for (const records of [base.agencyRecords, saved.agencyRecords, base.tasks, saved.tasks])
    if (new Set(records.map((r) => r.id)).size !== records.length) return false;
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
  const matches = (task: StudioCase["tasks"][number]) =>
    task.agencyOrigin?.requestRecordId === input.requestRecordId &&
    task.agencyOrigin.requestVersionId === input.requestVersionId;
  const originals = base.tasks.filter(matches),
    results = saved.tasks.filter(matches);
  if (originals.length > 1 || results.length !== 1) return false;
  try {
    const request = currentAgencyTaskRequest(base, input.requestRecordId, input.requestVersionId);
    // A task already visible to the caller may have been edited by its owner.
    // A replay can confirm that exact task, but must never reset it to creation defaults.
    if (originals.length === 1) return equal(saved.tasks, base.tasks);
    if (saved.revision <= base.revision || base.tasks.length >= 200) return false;
    const task = results[0];
    if (!equal(saved.tasks, [...base.tasks, task])) return false;
    const expected = taskSchema.parse({
      id: task.id,
      title: `기관 요청 대응: ${request.title}`.slice(0, 300),
      category: "supplement",
      dueDate: request.dueOn,
      status: "pending",
      notes: `기관 요청 v${request.version}에 연결한 업무입니다.
기관: ${request.institution}
기록된 요청 기한: ${request.dueOn || "미확인"}
기한 근거: ${request.dueNote || "미확인"}
요청 원문과 연결 증빙은 위 기관 요청 기록에서 확인하세요. 업무 완료는 기관 발송·접수 확인이 아닙니다.`,
      agencyOrigin: {
        requestRecordId: input.requestRecordId,
        requestVersionId: input.requestVersionId,
      },
    });
    return equal(task, expected);
  } catch {
    return false;
  }
}
