import type { StudioCase } from "./studio-schema";
import type { useComparisonReviewScreen } from "./studio-public-claim-comparison-review-react";
import { claimReviewContext } from "./studio-claim-review-types";

export type ComparisonPlanReview = Extract<
  NonNullable<ReturnType<typeof useComparisonReviewScreen>["display"]>,
  { kind: "result" }
>["result"];

/** Navigation only, for an already decoded current review. Never adopts prose or a judgement. */
export function comparisonPlanTarget(company: StudioCase, result: ComparisonPlanReview | null) {
  if (
    !result ||
    result.source !== "comparison-stored-review" ||
    result.historical.result.state !== "comparison-ready" ||
    !result.historical.result.comparison ||
    result.current.status !== "exact-original-request" ||
    result.current.reason !== null ||
    result.current.originalRevision !== company.revision ||
    result.current.observedRevision !== company.revision
  )
    return null;
  const { selection, binding } = result.resultIdentity,
    prepared = result.historical.prepared;
  if (selection.companyId !== company.id || selection.companyRevision !== company.revision)
    return null;
  const records = company.claimReviews.filter((item) => item.id === selection.claimRecordId);
  if (records.length !== 1) return null;
  const record = records[0],
    plans = company.plans.filter((item) => item.id === binding.planId);
  if (
    record.version !== selection.claimVersion ||
    record.inputDigest !== selection.claimInputDigest ||
    record.claimId !== binding.claimId ||
    record.planId !== binding.planId ||
    record.planVersion !== binding.planVersion ||
    record.claimQuote !== prepared.input.claimQuote ||
    record.sectionKey !== prepared.input.section.key ||
    plans.length !== 1 ||
    plans[0].version !== binding.planVersion ||
    claimReviewContext(company, record).state !== "current"
  )
    return null;
  const plan = plans[0],
    sections = plan.content.sections.filter((item) => item.key === record.sectionKey);
  if (
    sections.length !== 1 ||
    sections[0].content !== prepared.input.section.content ||
    sections[0].title !== prepared.input.section.title
  )
    return null;
  return { record, plan, section: sections[0] };
}
async function sha(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Recheck the current browser snapshot's record, entire plan and selected source bytes. */
export async function resolveComparisonPlanReference(
  company: StudioCase,
  result: ComparisonPlanReview,
) {
  const target = comparisonPlanTarget(company, result);
  if (!target) return null;
  const binding = result.resultIdentity.binding;
  const [recordHash, planHash] = await Promise.all([
    sha(JSON.stringify(target.record)),
    sha(JSON.stringify(target.plan.content)),
  ]);
  if (recordHash !== binding.claimRecordSha256 || planHash !== binding.planContentSha256)
    return null;
  for (const evidence of result.historical.prepared.input.selectedEvidence) {
    const sources = company.sources.filter((source) => source.id === evidence.sourceId);
    if (
      sources.length !== 1 ||
      sources[0].updatedAt !== evidence.sourceUpdatedAt ||
      (await sha(sources[0].text)) !== evidence.textSha256
    )
      return null;
  }
  return { ...target, result: structuredClone(result) };
}
