import {
  caseSchema,
  sourceSchema,
  originalOnlyWarnings,
  type StudioCase,
} from "@/lib/studio-schema";
import { MAX_COMPANY_SOURCES, occupiedSourceSlots } from "@/lib/studio-source-limits";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unique = (ids: string[]) => new Set(ids).size === ids.length;
/** Verify the source assigned by the server before accepting its company or closing the editor. */
export function manualSourceSaveAcknowledged(
  value: unknown,
  original: StudioCase,
  input: unknown,
): boolean {
  const before = caseSchema.safeParse(original),
    after = caseSchema.safeParse(value),
    parsed = sourceSchema.safeParse(input);
  if (!before.success || !after.success || !parsed.success) return false;
  const prior = before.data,
    next = after.data,
    request = parsed.data;
  if (
    next.id !== prior.id ||
    !Number.isSafeInteger(prior.revision) ||
    prior.revision < 0 ||
    !Number.isSafeInteger(next.revision) ||
    next.revision <= prior.revision ||
    !request.text.trim()
  )
    return false;
  if (!unique(prior.sources.map((s) => s.id)) || !unique(next.sources.map((s) => s.id)))
    return false;
  const existing = prior.sources.find((s) => s.id === request.id);
  if (
    !existing &&
    (occupiedSourceSlots(prior) >= MAX_COMPANY_SOURCES ||
      prior.sourceIntakes.some((item) => item.sourceId === request.id))
  )
    return false;
  const saved = next.sources.find((s) => s.id === request.id);
  if (!saved) return false;
  const savedAt = Date.parse(saved.updatedAt),
    priorAt = Date.parse(existing?.updatedAt ?? "");
  if (
    !Number.isFinite(savedAt) ||
    (existing &&
      (saved.updatedAt === existing.updatedAt || (Number.isFinite(priorAt) && savedAt <= priorAt)))
  )
    return false;
  const expected = {
    ...request,
    originalName: existing?.originalName ?? null,
    mimeType: existing?.mimeType ?? null,
    extraction: "manual" as const,
    warnings:
      existing?.extraction === "pending"
        ? existing.warnings.filter((w) => !(originalOnlyWarnings as readonly string[]).includes(w))
        : (existing?.warnings ?? []),
    createdAt: existing?.createdAt ?? saved.updatedAt,
    updatedAt: saved.updatedAt,
  };
  const expectedSources = existing
    ? prior.sources.map((s) => (s.id === request.id ? expected : s))
    : [...prior.sources, expected];
  return same(next.sources, expectedSources) && same(next.sourceOcrReviews, prior.sourceOcrReviews);
}
