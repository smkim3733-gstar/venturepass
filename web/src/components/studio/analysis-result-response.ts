import { caseSchema, type StudioCase } from "@/lib/studio-schema";

/** Validate the retained analysis request and allowed reset, not the truth of generated prose. */
export function analysisResultResponse(
  value: unknown,
  company: StudioCase,
  mode: "ai" | "assisted",
): StudioCase {
  const before = caseSchema.safeParse(company),
    after = caseSchema.safeParse(value);
  const mismatch = () =>
    new Error(
      "아이템 분석 결과를 아직 확인하지 못했습니다. 기존 분석·선택과 원고를 유지했습니다. 분석 상태를 확인해 주세요.",
    );
  if (!before.success || !after.success || !["ai", "assisted"].includes(mode)) throw mismatch();
  const base = before.data,
    next = after.data,
    analysis = next.analysis;
  if (
    next.id !== base.id ||
    !Number.isSafeInteger(base.revision) ||
    base.revision < 0 ||
    !Number.isSafeInteger(next.revision) ||
    next.revision <= base.revision ||
    !analysis ||
    analysis.mode !== mode ||
    analysis.sourceRevision !== base.revision ||
    !Number.isFinite(Date.parse(analysis.generatedAt)) ||
    next.selectedCandidateId !== null
  )
    throw mismatch();
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  for (const key of ["profile", "sources", "candidateSelections", "stage"] as const)
    if (!same(next[key], base[key])) throw mismatch();
  const candidateIds = analysis.candidates.map((c) => c.id);
  if (candidateIds.some((id) => !id.trim()) || new Set(candidateIds).size !== candidateIds.length)
    throw mismatch();
  for (const plans of [base.plans, next.plans])
    if (
      new Set(plans.map((p) => p.id)).size !== plans.length ||
      new Set(plans.map((p) => p.version)).size !== plans.length
    )
      throw mismatch();
  // Re-analysis clears confirmation only. Saved prose, review findings and order stay intact.
  const expected = base.plans.map((p) => ({ ...p, confirmedAt: null }));
  if (!same(next.plans, expected)) throw mismatch();
  return next;
}
