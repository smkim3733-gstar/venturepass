// Node-side evidence history projections. No original bytes or browser actions.
import { isApplicationSubmission } from "./studio-application-types";
import type { StudioCase } from "./studio-schema";

type OriginalIdentity = {
  sourceId: string;
  sha256: string;
  sizeBytes: number;
  originalName: string;
  mimeType: string | null;
};
type PlanIdentity = { planId: string; version: number; contentSha256: string };
type PreparationHistory = {
  sourceSnapshots: { original: OriginalIdentity | null }[];
  planSnapshots: PlanIdentity[];
};
type VisitHistory = {
  sourceSnapshots: { original: OriginalIdentity | null }[];
  questionSnapshot: { planId: string; planVersion: number; planContentSha256: string };
};
type History = Pick<StudioCase, "agencyRecords" | "applicationEvents" | "appealPreparations"> & {
  responsePreparations?: PreparationHistory[];
  numericChecks?: PreparationHistory[];
  claimReviews?: PreparationHistory[];
  visitAnswers?: VisitHistory[];
  planReviewDecisions?: { planId: string; planVersion: number; planContentSha256: string }[];
  sourceIntakes?: { sourceId: string; original: Omit<OriginalIdentity, "sourceId"> | null }[];
  sourceSuggestionAdoptions?: { binding: { original: OriginalIdentity | null } }[];
  applicationProcedures?: { sourceSnapshots: { original: OriginalIdentity | null }[] }[];
};

export function frozenOriginals(company: History): OriginalIdentity[] {
  return [
    ...(company.sourceIntakes ?? []).flatMap((item) =>
      item.original ? [{ sourceId: item.sourceId, ...item.original }] : [],
    ),
    ...(company.sourceSuggestionAdoptions ?? []).flatMap((entry) =>
      entry.binding.original ? [entry.binding.original] : [],
    ),
    ...company.agencyRecords.flatMap((entry) => entry.evidence),
    ...company.applicationEvents.flatMap((event) =>
      isApplicationSubmission(event) ? event.originals : [],
    ),
    ...[
      ...company.appealPreparations,
      ...(company.responsePreparations ?? []),
      ...(company.numericChecks ?? []),
      ...(company.claimReviews ?? []),
      ...(company.visitAnswers ?? []),
      ...(company.applicationProcedures ?? []),
    ].flatMap((entry) =>
      entry.sourceSnapshots.flatMap((source) => (source.original ? [source.original] : [])),
    ),
  ];
}

export function frozenPlans(company: History): PlanIdentity[] {
  return [
    ...company.applicationEvents.flatMap((event) =>
      isApplicationSubmission(event)
        ? [
            {
              planId: event.plan.id,
              version: event.plan.version,
              contentSha256: event.plan.contentSha256,
            },
          ]
        : [],
    ),
    ...[
      ...company.appealPreparations,
      ...(company.responsePreparations ?? []),
      ...(company.numericChecks ?? []),
      ...(company.claimReviews ?? []),
    ].flatMap((entry) => entry.planSnapshots),
    ...(company.visitAnswers ?? []).map(({ questionSnapshot }) => ({
      planId: questionSnapshot.planId,
      version: questionSnapshot.planVersion,
      contentSha256: questionSnapshot.planContentSha256,
    })),
    ...(company.planReviewDecisions ?? []).map((entry) => ({
      planId: entry.planId,
      version: entry.planVersion,
      contentSha256: entry.planContentSha256,
    })),
  ];
}

export function originalConflicts(company: History, value: OriginalIdentity) {
  return frozenOriginals(company).some(
    (saved) =>
      saved.sourceId === value.sourceId &&
      (saved.sha256 !== value.sha256 ||
        saved.sizeBytes !== value.sizeBytes ||
        saved.originalName !== value.originalName ||
        saved.mimeType !== value.mimeType),
  );
}

export function planConflicts(company: History, value: PlanIdentity) {
  return frozenPlans(company).some(
    (saved) =>
      saved.planId === value.planId &&
      (saved.version !== value.version || saved.contentSha256 !== value.contentSha256),
  );
}
