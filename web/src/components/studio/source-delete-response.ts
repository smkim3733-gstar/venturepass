import { caseSchema, type StudioCase } from "@/lib/studio-schema";

/** Accept only removal of the one source chosen in the original company. */
export function sourceDeleteAcknowledged(
  value: unknown,
  original: StudioCase,
  sourceId: string,
): boolean {
  const before = caseSchema.safeParse(original);
  const after = caseSchema.safeParse(value);
  if (!before.success || !after.success) return false;
  const prior = before.data;
  const next = after.data;
  if (
    next.id !== prior.id ||
    !Number.isSafeInteger(prior.revision) ||
    prior.revision < 0 ||
    !Number.isSafeInteger(next.revision) ||
    next.revision <= prior.revision ||
    prior.sources.filter((source) => source.id === sourceId).length !== 1 ||
    new Set(prior.sources.map((source) => source.id)).size !== prior.sources.length ||
    new Set(next.sources.map((source) => source.id)).size !== next.sources.length
  ) return false;
  const expected = prior.sources.filter((source) => source.id !== sourceId);
  return (
    JSON.stringify(next.sources) === JSON.stringify(expected) &&
    JSON.stringify(next.sourceOcrReviews) === JSON.stringify(prior.sourceOcrReviews)
  );
}
