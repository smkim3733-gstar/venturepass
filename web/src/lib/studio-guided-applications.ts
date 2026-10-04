import { z } from "zod";
import {
  applicationCycleSchema,
  applicationEventSchema,
  applicationMetadata,
  isApplicationSubmission,
  latestApplicationSubmissions,
} from "./studio-application-types";
import type { StudioCase } from "./studio-schema";

/** A local navigation address, never an approval or proof of official submission. */
export const guidedApplicationTargetSchema = z
  .object({
    kind: z.literal("application"),
    caseId: z.string().uuid(),
    companyRevision: z.number().int().nonnegative().safe(),
    applicationId: z.string().uuid(),
    metadataVersionId: z.string().uuid(),
    submissionVersionId: z.string().uuid().nullable(),
  })
  .strict();
export type GuidedApplicationTarget = z.infer<typeof guidedApplicationTargetSchema>;

export function guidedApplicationHistory(company: StudioCase) {
  const state = {
    applications: company.applications,
    applicationEvents: company.applicationEvents,
  };
  const ids = [...state.applications, ...state.applicationEvents].map((item) => item.id);
  // Limit this projection to coherent local addresses. Do not repair or rewrite history.
  const malformed =
    new Set(ids).size !== ids.length ||
    state.applications.some((item) => !applicationCycleSchema.safeParse(item).success) ||
    state.applicationEvents.some((item) => !applicationEventSchema.safeParse(item).success);
  const cycles = malformed
    ? []
    : state.applications.flatMap((cycle) => {
        const events = state.applicationEvents.filter((item) => item.applicationId === cycle.id);
        let metadataVersionId = cycle.id;
        const submissions = new Map<string, { id: string; version: number }>();
        for (const item of events) {
          if (item.kind === "cycle-correction") {
            if (item.previousVersionId !== metadataVersionId) return [];
            metadataVersionId = item.id;
          } else if (isApplicationSubmission(item)) {
            const prior = submissions.get(item.submissionRecordId);
            if (
              item.companySnapshot.caseId !== company.id ||
              (prior
                ? item.kind !== "submission-correction" ||
                  item.previousVersionId !== prior.id ||
                  item.version !== prior.version + 1
                : item.kind !== "submission-recorded" ||
                  item.submissionRecordId !== item.id ||
                  item.previousVersionId !== null ||
                  item.version !== 1)
            )
              return [];
            submissions.set(item.submissionRecordId, item);
          }
        }
        const metadata = applicationMetadata(state, cycle.id)!;
        const target: GuidedApplicationTarget = {
          kind: "application",
          caseId: company.id,
          companyRevision: company.revision,
          applicationId: cycle.id,
          metadataVersionId,
          submissionVersionId: null,
        };
        return [
          {
            id: cycle.id,
            title: metadata.title,
            kind: metadata.kind,
            plannedOn: metadata.plannedOn,
            target,
            submissions: latestApplicationSubmissions(state, cycle.id).map((item) => {
              const receipt = company.agencyRecords.filter((r) => r.id === item.receiptRecordId);
              const linked =
                receipt.length === 1 &&
                (receipt[0].kind === "notice" || receipt[0].kind === "notice-correction") &&
                receipt[0].details.category === "receipt";
              return {
                id: item.id,
                version: item.version,
                occurredOn: item.occurredOn,
                recordedAt: item.recordedAt,
                planVersion: item.plan.version,
                receipt: !item.receiptRecordId
                  ? "접수 기록 연결 없음"
                  : linked
                    ? "접수 기록의 고정 버전 연결 · 기관 확인 미실시"
                    : "연결한 접수 기록 확인 필요",
                target: { ...target, submissionVersionId: item.id },
              };
            }),
          },
        ];
      });
  const orphan = state.applicationEvents.some(
    (item) =>
      item.applicationId !== null &&
      !state.applications.some((cycle) => cycle.id === item.applicationId),
  );
  return {
    cycles,
    needsInspection: malformed || orphan || cycles.length !== state.applications.length,
  };
}

export function validGuidedApplicationTarget(company: StudioCase, input: unknown) {
  const parsed = guidedApplicationTargetSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.caseId !== company.id ||
    parsed.data.companyRevision !== company.revision
  )
    return false;
  const target = parsed.data;
  const history = guidedApplicationHistory(company);
  if (history.needsInspection) return false;
  const cycle = history.cycles.find(
    (item) =>
      item.id === target.applicationId &&
      item.target.metadataVersionId === target.metadataVersionId,
  );
  return (
    !!cycle &&
    (target.submissionVersionId === null ||
      cycle.submissions.some((item) => item.id === target.submissionVersionId))
  );
}
