import { caseSchema, type StudioCase } from "@/lib/studio-schema";

/** Bind one new unreviewed manuscript to the retained generation request.
 * Generated prose is not known in advance; this does not assess its quality or authenticate a receipt.
 */
export function generatedPlanResponse(
  value: unknown,
  company: StudioCase,
  mode: "ai" | "assisted",
): StudioCase {
  const before = caseSchema.safeParse(company);
  const after = caseSchema.safeParse(value);
  const mismatch = () =>
    new Error(
      "새 원고의 작성 결과를 아직 확인하지 못했습니다. 기존 원고를 유지했습니다. 작성 상태를 확인해 주세요.",
    );
  if (!before.success || !after.success || !["ai", "assisted"].includes(mode)) throw mismatch();
  const base = before.data,
    next = after.data;
  if (
    !Number.isSafeInteger(base.revision) ||
    base.revision < 0 ||
    !Number.isSafeInteger(next.revision) ||
    next.revision <= base.revision ||
    next.id !== base.id ||
    !base.selectedCandidateId ||
    base.analysis?.candidates.filter((c) => c.id === base.selectedCandidateId).length !== 1
  )
    throw mismatch();
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  for (const key of [
    "profile",
    "sources",
    "analysis",
    "selectedCandidateId",
    "candidateSelections",
  ] as const)
    if (!same(base[key], next[key])) throw mismatch();
  for (const plans of [base.plans, next.plans]) {
    if (
      new Set(plans.map((p) => p.id)).size !== plans.length ||
      new Set(plans.map((p) => p.version)).size !== plans.length ||
      plans.some((p) => !Number.isSafeInteger(p.version) || p.version < 1)
    )
      throw mismatch();
  }
  if (next.plans.length !== base.plans.length + 1 || !same(next.plans.slice(0, -1), base.plans))
    throw mismatch();
  const saved = next.plans.at(-1)!;
  if (
    base.plans.some((p) => p.id === saved.id) ||
    saved.version !== Math.max(0, ...base.plans.map((p) => p.version)) + 1 ||
    saved.mode !== mode ||
    saved.candidateId !== base.selectedCandidateId ||
    saved.sourceRevision !== base.revision ||
    saved.confirmedAt !== null ||
    !Number.isFinite(Date.parse(saved.generatedAt))
  )
    throw mismatch();
  return next;
}
