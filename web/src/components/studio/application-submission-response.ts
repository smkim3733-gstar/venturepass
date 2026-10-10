import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import {
  applicationMutationSchema,
  latestApplicationSubmissions,
  type ApplicationMutation,
} from "@/lib/studio-application-types";

export type SubmissionMutation = Extract<
  ApplicationMutation,
  { action: "record-application-submission" | "correct-application-submission" }
>;
export function isSubmissionMutation(value: { action: string }): value is SubmissionMutation {
  return (
    value.action === "record-application-submission" ||
    value.action === "correct-application-submission"
  );
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Compare the selected submission, never execute a writer or authenticate an agency receipt. */
export async function applicationSubmissionAcknowledged(
  raw: unknown,
  company: StudioCase,
  value: SubmissionMutation,
) {
  const response = caseSchema.safeParse(raw),
    before = caseSchema.safeParse(company),
    command = applicationMutationSchema.safeParse(value);
  if (
    !response.success ||
    !before.success ||
    !command.success ||
    !isSubmissionMutation(command.data)
  )
    return false;
  const saved = response.data,
    base = before.data,
    input = command.data;
  if (saved.id !== base.id || saved.revision <= base.revision || input.revision !== base.revision)
    return false;
  const all = [...saved.applications, ...saved.applicationEvents];
  const originals = [...base.applications, ...base.applicationEvents];
  if (
    new Set(all.map((r) => r.id)).size !== all.length ||
    new Set(originals.map((r) => r.id)).size !== originals.length
  )
    return false;
  const matches = all.filter((r) => r.clientRequestId === input.clientRequestId);
  // The editor retains the original pre-send company for a same-request retry.
  if (matches.length !== 1 || originals.some((r) => r.clientRequestId === input.clientRequestId))
    return false;
  const record = matches[0];
  if (record.kind !== "submission-recorded" && record.kind !== "submission-correction")
    return false;
  if (
    !equal(saved.applications, base.applications) ||
    !equal(saved.applicationEvents, [...base.applicationEvents, record])
  )
    return false;
  if (
    base.applications.filter((c) => c.id === input.applicationId).length !== 1 ||
    record.applicationId !== input.applicationId ||
    record.occurredOn !== input.occurredOn ||
    record.recordedBy !== input.recordedBy ||
    record.note !== input.note ||
    record.receiptRecordId !== input.receiptRecordId
  )
    return false;
  if (input.action === "record-application-submission") {
    if (
      record.kind !== "submission-recorded" ||
      record.submissionRecordId !== record.id ||
      record.previousVersionId !== null ||
      record.version !== 1
    )
      return false;
  } else {
    const prior = latestApplicationSubmissions(base, input.applicationId).filter(
      (r) => r.submissionRecordId === input.submissionRecordId,
    );
    if (
      prior.length !== 1 ||
      prior[0].id !== input.previousVersionId ||
      record.kind !== "submission-correction" ||
      record.submissionRecordId !== input.submissionRecordId ||
      record.previousVersionId !== input.previousVersionId ||
      record.version !== prior[0].version + 1
    )
      return false;
  }
  if (
    !equal(record.companySnapshot, {
      companyName: base.profile.companyName,
      businessNumber: base.profile.businessNumber,
      caseId: base.id,
      revision: base.revision,
    })
  )
    return false;
  const plans = base.plans.filter((p) => p.id === input.planId),
    plan = plans[0];
  if (plans.length !== 1 || !equal(saved.plans, base.plans)) return false;
  for (const key of [
    "id",
    "version",
    "generatedAt",
    "mode",
    "candidateId",
    "sourceRevision",
    "confirmedAt",
    "review",
  ] as const)
    if (!equal(record.plan[key], plan[key])) return false;
  if (
    !equal(
      record.plan.sections,
      plan.content.sections.map((s) => ({ key: s.key, needsConfirmation: s.needsConfirmation })),
    ) ||
    record.plan.latestVersion !== (base.plans.at(-1)?.id === plan.id)
  )
    return false;
  // The server computes currentEvidence using its evidence revision. This client does not recreate that revision.
  if (
    record.plan.currentEvidence &&
    (!base.analysis || plan.candidateId !== base.selectedCandidateId)
  )
    return false;
  if (
    !equal(
      record.originals.map((r) => r.sourceId),
      input.sourceIds,
    ) ||
    !equal(
      record.owners.map((r) => r.taskId),
      input.taskIds,
    )
  )
    return false;
  for (const original of record.originals) {
    const sources = base.sources.filter((s) => s.id === original.sourceId);
    if (sources.length !== 1 || !sources[0].originalName) return false;
    const source = sources[0];
    if (
      original.sourceName !== source.name ||
      original.originalName !== source.originalName ||
      original.mimeType !== source.mimeType ||
      original.sourceUpdatedAt !== source.updatedAt
    )
      return false;
  }
  for (const owner of record.owners) {
    const tasks = base.tasks.filter((t) => t.id === owner.taskId);
    if (
      tasks.length !== 1 ||
      !equal(owner, {
        taskId: tasks[0].id,
        title: tasks[0].title,
        agencyOrigin: tasks[0].agencyOrigin ?? null,
        owners: tasks[0].owners ?? { materials: "", writing: "", review: "" },
      })
    )
      return false;
  }
  if (input.receiptRecordId) {
    const receipts = base.agencyRecords.filter((r) => r.id === input.receiptRecordId);
    if (
      receipts.length !== 1 ||
      (receipts[0].kind !== "notice" && receipts[0].kind !== "notice-correction") ||
      receipts[0].details.category !== "receipt"
    )
      return false;
  }
  try {
    if (!globalThis.crypto?.subtle) return false;
    const hash = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(plan.content)),
        ),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return record.plan.contentSha256 === hash;
  } catch {
    return false;
  }
}
