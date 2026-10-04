import type { StudioCase } from "@/lib/studio-schema";
import { serializeStudioAiInput, STUDIO_AI_INPUT_CHARACTER_LIMIT } from "@/lib/studio-ai-input";
import type { GuidedPreparationApproval } from "@/lib/studio-guided-preparation-types";
import { guidedPreparationSnapshot } from "./guided-preparation-ui";

export function initialEvidenceSelection(company: StudioCase) {
  const previous = company.guidedPreparationRuns?.at(-1)?.approval;
  const usable = company.sources.filter((source) => source.extraction !== "pending");
  // New material is never silently added to an existing selected scope.
  return usable
    .filter((source) => !previous?.sourceScope || previous.sourceIds.includes(source.id))
    .map((source) => source.id);
}
export function selectedEvidenceInput(company: StudioCase, ids: string[]) {
  const selected = company.sources.filter(
    (source) => source.extraction !== "pending" && ids.includes(source.id),
  );
  if (ids.length > 100 || new Set(ids).size !== ids.length || selected.length !== ids.length)
    return null;
  const inputCharacters = serializeStudioAiInput({
    ...company,
    sources: company.sources.filter(
      (source) => source.extraction === "pending" || ids.includes(source.id),
    ),
  }).length;
  return {
    sourceIds: selected.map((source) => source.id),
    sourceNames: selected.map((source) => source.name),
    inputCharacters,
    inputCharacterLimit: STUDIO_AI_INPUT_CHARACTER_LIMIT,
    overInputLimit: inputCharacters > STUDIO_AI_INPUT_CHARACTER_LIMIT,
  };
}
export function selectedEvidenceSnapshot(raw: unknown, company: StudioCase, ids: string[]) {
  const snapshot = guidedPreparationSnapshot(raw, company),
    expected = selectedEvidenceInput(company, ids);
  if (
    !snapshot ||
    !expected ||
    snapshot.company.revision !== company.revision ||
    snapshot.approval.sourceScope !== "selected-sources-v1"
  )
    return null;
  const received = selectedEvidenceInput(snapshot.company, ids);
  const value = raw as Record<string, unknown>;
  if (
    !received ||
    JSON.stringify(expected) !== JSON.stringify(received) ||
    JSON.stringify(snapshot.approval.sourceIds) !== JSON.stringify(expected.sourceIds) ||
    JSON.stringify(snapshot.approval.sourceNames) !== JSON.stringify(expected.sourceNames) ||
    value.inputCharacters !== expected.inputCharacters ||
    value.inputCharacterLimit !== expected.inputCharacterLimit ||
    value.overInputLimit !== expected.overInputLimit ||
    value.transmissionAllowed !== false
  )
    return null;
  return { ...snapshot, ...expected, transmissionAllowed: false as const };
}
export type SelectedEvidenceSnapshot = NonNullable<ReturnType<typeof selectedEvidenceSnapshot>>;

/** Read-only status plus the same scope as the durable run; never use the full-scope GET to validate a selected run. */
export async function loadCurrentPreparation(
  company: Pick<StudioCase, "id" | "revision">,
  read: (url: string, init?: RequestInit) => Promise<unknown>,
) {
  const path = `/api/studio/cases/${company.id}/guided-preparation`;
  const snapshot = guidedPreparationSnapshot(await read(path), company);
  if (!snapshot) throw Error("최신 준비 상태를 확인하지 못했습니다.");
  let currentApproval: GuidedPreparationApproval | null = snapshot.approval;
  const previous = snapshot.company.guidedPreparationRuns?.at(-1)?.approval;
  if (previous?.sourceScope) {
    currentApproval = null;
    try {
      const raw = await read(`${path}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision: snapshot.company.revision,
          sourceIds: previous.sourceIds,
        }),
      });
      currentApproval =
        selectedEvidenceSnapshot(raw, snapshot.company, previous.sourceIds)?.approval ?? null;
    } catch {
      /* A failed scope read cannot establish validity or initiate execution. */
    }
  }
  return { ...snapshot, currentApproval };
}
