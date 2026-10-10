import { caseSchema, type StudioCase } from "@/lib/studio-schema";
import type { StudioMutation } from "./shared";

export type ManualPlanSave = {
  company: StudioCase;
  mutation: Extract<StudioMutation, { action: "save-plan" }>;
};

/** Read the saved version against the retained edit, never a generic success flag.
 * This is a content/version check, not a server request receipt or a replay permission.
 */
export function manualPlanSaveSnapshot(value: unknown, pending: ManualPlanSave): StudioCase {
  const parsed = caseSchema.safeParse(value);
  const base = pending.company;
  const targets = base.plans.filter((plan) => plan.id === pending.mutation.planId);
  const mismatch = () =>
    new Error(
      "수정본의 저장 결과를 아직 확인하지 못했습니다. 입력을 유지했습니다. 저장 상태를 다시 확인해 주세요.",
    );
  if (!parsed.success || targets.length !== 1) throw mismatch();
  const next = parsed.data;
  if (next.id !== base.id || next.revision <= base.revision) throw mismatch();
  const target = targets[0];
  // Previous manuscripts are immutable when a manual version is appended.
  for (const original of base.plans) {
    const matches = next.plans.filter((plan) => plan.id === original.id);
    if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(original))
      throw mismatch();
  }
  const version = Math.max(0, ...base.plans.map((plan) => plan.version)) + 1;
  const matches = next.plans.filter((plan) => plan.version === version);
  if (matches.length !== 1) throw mismatch();
  const saved = matches[0];
  if (
    base.plans.some((plan) => plan.id === saved.id) ||
    next.plans.filter((plan) => plan.id === saved.id).length !== 1 ||
    saved.mode !== "manual" ||
    saved.candidateId !== target.candidateId ||
    saved.sourceRevision !== target.sourceRevision ||
    saved.confirmedAt !== null ||
    JSON.stringify(saved.content) !== JSON.stringify(pending.mutation.content)
  )
    throw mismatch();
  return next;
}
