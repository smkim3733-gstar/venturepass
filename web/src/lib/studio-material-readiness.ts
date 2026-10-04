import { serializeStudioAiInput, STUDIO_AI_INPUT_CHARACTER_LIMIT } from "./studio-ai-input";
import { MAX_COMPANY_SOURCES, occupiedSourceSlots } from "./studio-source-limits";
import type { StudioCase } from "./studio-schema";

export function intakeResultsAwaitingAdoption(items: StudioCase["sourceIntakes"]) {
  return new Set(
    items
      .filter(
        (item) =>
          item.phase !== "cancelled" &&
          item.result?.content &&
          !item.result.discardedAt &&
          item.adoption?.resultId !== item.result.id,
      )
      .map((item) => item.sourceId),
  );
}

/** Read-only projection of saved state, never a factual review or an AI execution approval. */
export function materialReadiness(
  company: Pick<StudioCase, "profile" | "sources" | "sourceIntakes">,
) {
  const reviewSourceIds = intakeResultsAwaitingAdoption(company.sourceIntakes);
  const rows = company.sources.map((source) => ({
    sourceId: source.id,
    name: source.name,
    included: source.extraction !== "pending",
    hasBody: source.extraction !== "pending" && Boolean(source.text.trim()),
    resultAwaitingAdoption: reviewSourceIds.has(source.id),
  }));
  const equalBodies = new Map<string, { sourceId: string; name: string }[]>();
  for (const source of company.sources) {
    if (source.extraction === "pending" || !source.text.trim()) continue;
    const group = equalBodies.get(source.text) ?? [];
    group.push({ sourceId: source.id, name: source.name });
    equalBodies.set(source.text, group);
  }
  const serializedCharacters = serializeStudioAiInput(company).length;
  return {
    stored: company.sources.length,
    occupied: occupiedSourceSlots(company),
    sourceLimit: MAX_COMPANY_SOURCES,
    withBody: rows.filter((row) => row.hasBody).length,
    pendingBody: rows.filter((row) => !row.hasBody).length,
    awaitingAdoption: rows.filter((row) => row.resultAwaitingAdoption).length,
    included: rows.filter((row) => row.included).length,
    excluded: rows.filter((row) => !row.included).length,
    includedEmpty: rows.filter((row) => row.included && !row.hasBody).length,
    hasDescription: Boolean(company.profile.technologySummary.trim()),
    serializedCharacters,
    characterLimit: STUDIO_AI_INPUT_CHARACTER_LIMIT,
    overLimit: serializedCharacters > STUDIO_AI_INPUT_CHARACTER_LIMIT,
    equalBodyGroups: [...equalBodies.values()].filter((group) => group.length > 1),
    rows,
  };
}
