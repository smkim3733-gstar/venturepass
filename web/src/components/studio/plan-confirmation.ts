import { caseSchema, type StudioCase } from "@/lib/studio-schema";

export type PlanConfirmation = { company: StudioCase; planId: string };
export const planConfirmationMessage =
  "원고의 검토 완료 상태를 아직 확인하지 못했습니다. 원래 원고를 유지하고 있습니다. 검토 완료 상태를 확인해 주세요.";

/** Match the reviewed manuscript, not a generic company response or success flag.
 * This confirms stored content/status, not attribution to a server request receipt.
 */
export function planConfirmationSnapshot(value: unknown, pending: PlanConfirmation): StudioCase {
  const mismatch = () => new Error(planConfirmationMessage);
  const parsed = caseSchema.safeParse(value);
  const base = pending.company;
  if (!parsed.success || parsed.data.id !== base.id || parsed.data.revision <= base.revision)
    throw mismatch();
  const next = parsed.data;
  const targets = base.plans.filter((plan) => plan.id === pending.planId);
  if (targets.length !== 1) throw mismatch();
  const target = targets[0];
  if (target.confirmedAt || target.version !== Math.max(...base.plans.map((plan) => plan.version)))
    throw mismatch();
  // Review recalculation and its completion time may change. The reviewed content,
  // manuscript identity/history and evidence context must not silently change.
  for (const field of [
    "profile",
    "sources",
    "analysis",
    "selectedCandidateId",
    "candidateSelections",
  ] as const)
    if (JSON.stringify(next[field]) !== JSON.stringify(base[field])) throw mismatch();
  if (
    next.plans.length !== base.plans.length ||
    new Set(next.plans.map((plan) => plan.id)).size !== next.plans.length ||
    new Set(next.plans.map((plan) => plan.version)).size !== next.plans.length
  )
    throw mismatch();
  for (const original of base.plans) {
    const matches = next.plans.filter((plan) => plan.id === original.id);
    if (matches.length !== 1) throw mismatch();
    const plan = matches[0];
    if (original.id !== target.id) {
      if (JSON.stringify(plan) !== JSON.stringify(original)) throw mismatch();
      continue;
    }
    const { review, confirmedAt } = plan;
    if (
      JSON.stringify(original) !==
        JSON.stringify({ ...plan, review: original.review, confirmedAt: original.confirmedAt }) ||
      !confirmedAt ||
      !Number.isFinite(Date.parse(confirmedAt)) ||
      !plan.content.sections.length ||
      plan.content.sections.some(
        (section) => !section.content.trim() || section.needsConfirmation,
      ) ||
      review.some((finding) => finding.severity === "error" || finding.category === "confirmation")
    )
      throw mismatch();
  }
  return next;
}
