import { caseSchema, taskSchema, type StudioCase } from "@/lib/studio-schema";
import { buildCertificateTask, existingCertificateTask } from "@/lib/studio-certificate-renewal";
import { isAgencyNoticeRecord } from "@/lib/studio-agency-records";
import {
  createCertificateTaskMutationSchema,
  type CreateCertificateTask,
} from "@/lib/studio-certificate-renewal-types";
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Compare the chosen notice and user date without creating a task or reading original files. */
export function certificateTaskSaveAcknowledged(
  raw: unknown,
  company: StudioCase,
  command: CreateCertificateTask,
) {
  const response = caseSchema.safeParse(raw),
    before = caseSchema.safeParse(company),
    input = createCertificateTaskMutationSchema.safeParse(command);
  if (!response.success || !before.success || !input.success) return false;
  const saved = response.data,
    base = before.data,
    request = input.data;
  if (request.revision !== base.revision || saved.id !== base.id || saved.revision < base.revision)
    return false;
  for (const records of [base.tasks, saved.tasks, base.agencyRecords, saved.agencyRecords])
    if (new Set(records.map((record) => record.id)).size !== records.length) return false;
  const chain = base.agencyRecords.filter(
    (record) => isAgencyNoticeRecord(record) && record.noticeRecordId === request.noticeRecordId,
  );
  if (
    new Set(chain.map((record) => record.version)).size !== chain.length ||
    chain.some((record) => record.version > (chain.at(-1)?.version ?? 0))
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
  const matches = saved.tasks.filter(
    (task) =>
      task.certificateOrigin?.noticeRecordId === request.noticeRecordId &&
      task.certificateOrigin.noticeVersionId === request.noticeVersionId,
  );
  if (matches.length !== 1) return false;
  try {
    const original = existingCertificateTask(base, request);
    // A visible existing task can retain the owner's later changes on an explicit replay.
    if (original) return equal(saved.tasks, base.tasks);
    if (saved.revision <= base.revision) return false;
    const task = matches[0],
      expected = taskSchema.parse(buildCertificateTask(base, request, task.id));
    return equal(task, expected) && equal(saved.tasks, [...base.tasks, task]);
  } catch {
    return false;
  }
}
