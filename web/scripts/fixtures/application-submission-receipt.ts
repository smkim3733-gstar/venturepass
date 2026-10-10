import { submissionReadCompany } from "./guided-submission-read";
import { caseSchema, type StudioCase } from "../../src/lib/studio-schema";
import {
  applicationEventSchema,
  isApplicationSubmission,
  latestApplicationSubmissions,
} from "../../src/lib/studio-application-types";
import type { SubmissionMutation } from "../../src/components/studio/application-submission-response";
export function submissionReceiptCompany() {
  const company = submissionReadCompany();
  company.profile.companyName = "합성 제출 저장 확인 기업";
  company.tasks = [
    {
      id: "d0000000-0000-4000-8000-000000000001",
      title: "합성 제출 담당 업무",
      category: "other",
      dueDate: "",
      status: "pending",
      notes: "",
      owners: { materials: "자료 담당자", writing: "작성 담당자", review: "" },
    },
  ];
  return caseSchema.parse(company);
}
// Synthetic snapshots only: no storage, originals, SDK or business mutation is imported.
export function submissionReceiptResult(
  base: StudioCase,
  input: SubmissionMutation,
  id: string,
  contentHash: string,
) {
  const saved = structuredClone(base),
    plan = base.plans.find((p) => p.id === input.planId)!;
  const prior =
    input.action === "correct-application-submission"
      ? latestApplicationSubmissions(base, input.applicationId).find(
          (r) => r.submissionRecordId === input.submissionRecordId,
        )
      : undefined;
  const example = base.applicationEvents.find(isApplicationSubmission)!;
  saved.applicationEvents.push(
    applicationEventSchema.parse({
      ...example,
      id,
      clientRequestId: input.clientRequestId,
      inputDigest: "a".repeat(64),
      recordedAt: "2026-10-10T09:30:00.000Z",
      kind: prior ? "submission-correction" : "submission-recorded",
      applicationId: input.applicationId,
      submissionRecordId: prior?.submissionRecordId ?? id,
      previousVersionId: prior?.id ?? null,
      version: prior ? prior.version + 1 : 1,
      occurredOn: input.occurredOn,
      recordedBy: input.recordedBy.trim(),
      note: input.note,
      companySnapshot: {
        caseId: base.id,
        revision: base.revision,
        companyName: base.profile.companyName,
        businessNumber: base.profile.businessNumber,
      },
      plan: {
        id: plan.id,
        version: plan.version,
        generatedAt: plan.generatedAt,
        mode: plan.mode,
        candidateId: plan.candidateId,
        sourceRevision: plan.sourceRevision,
        contentSha256: contentHash,
        confirmedAt: plan.confirmedAt,
        review: plan.review,
        sections: plan.content.sections.map((s) => ({
          key: s.key,
          needsConfirmation: s.needsConfirmation,
        })),
        latestVersion: base.plans.at(-1)?.id === plan.id,
        currentEvidence: false,
      },
      evidence: [],
      originals: input.sourceIds.map((sourceId) => {
        const s = base.sources.find((s) => s.id === sourceId)!;
        return {
          sourceId,
          sourceName: s.name,
          originalName: s.originalName,
          mimeType: s.mimeType,
          sizeBytes: 3,
          sha256: "c".repeat(64),
          sourceUpdatedAt: s.updatedAt,
        };
      }),
      owners: input.taskIds.map((taskId) => {
        const t = base.tasks.find((t) => t.id === taskId)!;
        return {
          taskId,
          title: t.title,
          agencyOrigin: t.agencyOrigin ?? null,
          owners: t.owners ?? { materials: "", writing: "", review: "" },
        };
      }),
      receiptRecordId: input.receiptRecordId,
    }),
  );
  saved.revision++;
  return caseSchema.parse(saved);
}
