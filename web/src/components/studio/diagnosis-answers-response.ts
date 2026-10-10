import {
  caseSchema,
  mutationSchema,
  type CaseMutation,
  type StudioCase,
} from "@/lib/studio-schema";

export type DiagnosisAnswersCommand = Extract<CaseMutation, { action: "diagnosis-answers" }>;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Match the complete submitted assessment before replacing the editor's company. */
export function diagnosisAnswersSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  command: DiagnosisAnswersCommand,
) {
  const response = caseSchema.safeParse(raw),
    before = caseSchema.safeParse(company),
    input = mutationSchema.safeParse(command);
  if (
    !response.success ||
    !before.success ||
    !input.success ||
    input.data.action !== "diagnosis-answers"
  )
    return false;
  const saved = response.data,
    base = before.data,
    request = input.data;
  if (
    request.revision !== base.revision ||
    saved.id !== base.id ||
    saved.revision <= base.revision ||
    !equal(saved.diagnosisAnswers, request.answers)
  )
    return false;
  // Saving assessments invalidates analysis and whole-plan review in the existing writer.
  // Derived diagnosis freshness and plan evidence freshness are not recomputed here.
  for (const key of [
    "profile",
    "companyContacts",
    "sources",
    "tasks",
    "agencyRecords",
    "applications",
    "applicationEvents",
    "stage",
    "stageHistory",
    "candidateSelections",
    "planReviewDecisions",
  ] as const)
    if (!equal(saved[key], base[key])) return false;
  return true;
}
