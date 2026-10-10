import {
  caseSchema,
  mutationSchema,
  type CaseMutation,
  type StudioCase,
} from "@/lib/studio-schema";
export type WorkflowStageCommand = Extract<CaseMutation, { action: "stage" }>;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Match the manual stage command and its appended local history before accepting a response. */
export function workflowStageSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  command: WorkflowStageCommand,
) {
  const response = caseSchema.safeParse(raw),
    before = caseSchema.safeParse(company),
    input = mutationSchema.safeParse(command);
  if (!response.success || !before.success || !input.success || input.data.action !== "stage")
    return false;
  const saved = response.data,
    base = before.data,
    request = input.data;
  if (
    request.revision !== base.revision ||
    saved.id !== base.id ||
    saved.revision <= base.revision ||
    saved.stage !== request.stage
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
    "tasks",
    "agencyRecords",
    "applications",
    "applicationEvents",
  ] as const)
    if (!equal(saved[key], base[key])) return false;
  if (
    [base.stageHistory, saved.stageHistory].some(
      (records) => new Set(records.map((record) => record.id)).size !== records.length,
    )
  )
    return false;
  // The existing writer does not append a history entry when the stage is unchanged.
  if (base.stage === request.stage) return equal(saved.stageHistory, base.stageHistory);
  if (
    base.stageHistory.length >= 500 ||
    saved.stageHistory.length !== base.stageHistory.length + 1 ||
    !equal(saved.stageHistory.slice(0, -1), base.stageHistory)
  )
    return false;
  const entry = saved.stageHistory.at(-1)!;
  return (
    entry.from === base.stage &&
    entry.to === request.stage &&
    entry.origin === "manual" &&
    entry.occurredOn === (request.occurredOn ?? "") &&
    entry.note === (request.note ?? "")
  );
}
