import type { CaseSummary, StudioCase } from "./studio-schema";
import {
  certificateAttention,
  type CertificateAttention,
} from "./studio-certificate-renewal-types";

export type CaseAttention = {
  pendingSourceCount: number;
  unconfirmedSectionCount: number;
  planReviewRequired: boolean;
  diagnosisState: "not_run" | "current" | "stale";
  preparationState: "not_started" | "stale" | StudioCase["preparationRuns"][number]["status"];
  pendingDueDates: string[];
  undatedTaskCount: number;
  requestsWithoutSentResponse: number;
  certificate?: CertificateAttention;
};

/** Return only counts and entered dates; no original text, account or response bodies. */
export function summarizeCase(company: StudioCase): CaseSummary {
  const pending = company.tasks.filter((task) => task.status === "pending");
  const diagnosis = company.diagnoses.at(-1);
  const preparation = company.preparationRuns.at(-1);
  const plan = company.plans.at(-1);
  const roots = company.agencyRecords.filter((record) => record.kind === "request");
  // Count the latest answer status against the latest request version, even when
  // an earlier answer was reported sent. This never claims agency acceptance.
  const requestsWithoutSentResponse = roots.filter((root) => {
    const related = company.agencyRecords.filter(
      (record) => "requestRecordId" in record && record.requestRecordId === root.id,
    );
    const latestRequest = related.filter((record) => record.kind !== "response").at(-1)!;
    const response = related.filter((record) => record.kind === "response").at(-1);
    return (
      !response ||
      !("responseStatus" in response) ||
      response.responseStatus !== "reported-sent" ||
      response.requestVersionId !== latestRequest.id
    );
  }).length;
  return {
    id: company.id,
    companyName: company.profile.companyName,
    industry: company.profile.industry,
    stage: company.stage,
    revision: company.revision,
    sourceCount: company.sources.length,
    planCount: company.plans.length,
    pendingTaskCount: pending.length,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
    attention: {
      pendingSourceCount: company.sources.filter((source) => source.extraction === "pending")
        .length,
      unconfirmedSectionCount:
        plan?.content.sections.filter((section) => section.needsConfirmation).length ?? 0,
      planReviewRequired: Boolean(
        plan &&
        (!plan.confirmedAt ||
          plan.content.sections.some((section) => section.needsConfirmation) ||
          plan.review.some(
            (finding) => finding.severity === "error" || finding.category === "confirmation",
          )),
      ),
      diagnosisState: !diagnosis ? "not_run" : diagnosis.stale ? "stale" : "current",
      preparationState: !preparation
        ? "not_started"
        : preparation.stale
          ? "stale"
          : preparation.status,
      pendingDueDates: pending
        .map((task) => task.dueDate)
        .filter(Boolean)
        .sort(),
      undatedTaskCount: pending.filter((task) => !task.dueDate).length,
      requestsWithoutSentResponse,
      certificate: certificateAttention(company),
    },
  };
}

export function caseAttentionAt(summary: CaseSummary, today: string) {
  const attention = summary.attention;
  const validDate =
    /^\d{4}-\d{2}-\d{2}$/.test(today) &&
    Number.isFinite(Date.parse(`${today}T00:00:00.000Z`)) &&
    new Date(`${today}T00:00:00.000Z`).toISOString().slice(0, 10) === today;
  const end = validDate ? new Date(`${today}T00:00:00.000Z`) : null;
  if (end) end.setUTCDate(end.getUTCDate() + 7);
  const through = end?.toISOString().slice(0, 10) ?? "";
  const dates = attention?.pendingDueDates ?? [];
  const overdue = validDate ? dates.filter((date) => date < today).length : 0;
  const dueSoon = validDate ? dates.filter((date) => date >= today && date <= through).length : 0;
  const needsAttention = Boolean(
    summary.pendingTaskCount ||
    (attention &&
      (attention.pendingSourceCount ||
        attention.planReviewRequired ||
        attention.unconfirmedSectionCount ||
        attention.diagnosisState !== "current" ||
        attention.requestsWithoutSentResponse ||
        attention.certificate?.needsPreparationCount ||
        attention.certificate?.missingUntilCount ||
        attention.certificate?.changedTaskCount ||
        ["failed", "blocked", "stale", "awaiting_choice", "awaiting_materials"].includes(
          attention.preparationState,
        ))),
  );
  return { overdue, dueSoon, nextDueDate: dates[0] ?? null, needsAttention };
}
