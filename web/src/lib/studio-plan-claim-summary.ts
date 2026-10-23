import type { StudioCase } from "./studio-schema";
import { claimReviewContext, type ClaimReviewRecord } from "./studio-claim-review-types";

export const planClaimStatusLabels = {
  missing: "연결 확인 불가",
  stale: "연결 재확인 필요",
  unreviewed: "미검토",
  conflict: "충돌 발견 (담당자)",
  insufficient: "근거 부족 (담당자)",
  consistent: "일치한다고 판단 (담당자)",
} as const;
export type PlanClaimStatus = keyof typeof planClaimStatusLabels;

/** A reading aid for one saved manuscript, never a completeness or approval gate. */
export function planClaimSummary(company: StudioCase, planId: string, planVersion: number) {
  const plans = company.plans.filter((plan) => plan.id === planId);
  const available = plans.length === 1 && plans[0].version === planVersion;
  const entries: {
    record: ClaimReviewRecord;
    status: PlanClaimStatus;
    issues: string[];
    laterElsewhere: boolean;
  }[] = [];
  let ambiguous = 0;
  if (available) {
    const groups = new Map<string, ClaimReviewRecord[]>();
    for (const record of company.claimReviews) {
      if (record.planId !== planId) continue;
      groups.set(record.claimId, [...(groups.get(record.claimId) ?? []), record]);
    }
    for (const records of groups.values()) {
      const version = Math.max(...records.map((record) => record.version));
      const matches = records.filter((record) => record.version === version);
      if (
        matches.length !== 1 ||
        company.claimReviews.filter((r) => r.id === matches[0].id).length !== 1
      ) {
        ambiguous++;
        continue;
      }
      const record = matches[0];
      const context = claimReviewContext(company, record);
      entries.push({
        record,
        status: context.state === "current" ? record.judgement.state : context.state,
        issues: context.issues,
        laterElsewhere: company.claimReviews.some(
          (r) => r.claimId === record.claimId && r.version > record.version && r.planId !== planId,
        ),
      });
    }
  }
  const counts: Record<PlanClaimStatus, number> = {
    missing: 0,
    stale: 0,
    unreviewed: 0,
    conflict: 0,
    insufficient: 0,
    consistent: 0,
  };
  for (const entry of entries) counts[entry.status]++;
  // Retain manuscript order within each priority; never select a newer manuscript.
  const priority = Object.keys(counts) as PlanClaimStatus[];
  entries.sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status));
  return { available, entries, counts, ambiguous };
}
