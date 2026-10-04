import { trackContext } from "./studio-preparation-context";
import { sourceKindLabels, type StudioCase } from "./studio-schema";

export const STUDIO_AI_INPUT_CHARACTER_LIMIT = 240000;

/** Exact existing user-message JSON. No truncation, selection, validation or dispatch authority. */
export function serializeStudioAiInput(
  value: Pick<StudioCase, "profile" | "sources">,
  extra: object = {},
): string {
  const profile = { ...value.profile, businessNumber: undefined };
  const input = JSON.stringify({
    profile,
    preparationContext: trackContext(value),
    unextractedSourceCount: value.sources.filter((source) => source.extraction === "pending")
      .length,
    sources: value.sources
      .filter((source) => source.extraction !== "pending")
      .map(({ id, name, kind, text, warnings }) => ({
        sourceId: id,
        name,
        kind: sourceKindLabels[kind],
        text,
        warnings,
      })),
    ...extra,
  });
  return input;
}
