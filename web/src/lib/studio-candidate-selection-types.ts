import { z } from "zod";
import { candidateClassificationSchema } from "./studio-candidate-classification";
import type { Candidate, CompanyAnalysis } from "./studio-schema";

export const candidateSelectionLimits = {
  records: 100,
  characters: 200_000,
  requestBytes: 16 * 1024,
} as const;
const text = (maximum: number) => z.string().max(maximum);
// A bounded copy of the existing candidate contract. No source body or entire analysis is saved.
export const candidateSelectionSnapshotSchema = z
  .object({
    id: z.string().max(300),
    classification: candidateClassificationSchema.optional(),
    title: text(250),
    problem: text(3000),
    solution: text(4000),
    targetCustomer: text(2000),
    differentiation: text(4000),
    stage: text(1000),
    businessModel: text(2000),
    recommendation: text(3000),
    evidence: z.array(z.object({ sourceId: z.string(), quote: text(1500), locator: text(150) })),
    gaps: z.array(text(2000)),
  })
  .strict();
export const candidateSelectionMutationSchema = z
  .object({
    action: z.literal("select-candidate"),
    revision: z.number().int().nonnegative().safe(),
    clientRequestId: z.string().uuid(),
    candidateId: z.string().min(1).max(300),
    analysisGeneratedAt: z.string().min(1).max(100),
    analysisSourceRevision: z.number().int().nonnegative().safe(),
    expectedSelectedCandidateId: z.string().max(300).nullable(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type CandidateSelectionInput = z.infer<typeof candidateSelectionMutationSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const candidateSelectionSchema = z
  .object({
    id: z.string().uuid(),
    clientRequestId: z.string().uuid(),
    inputDigest: hash,
    recordedAt: z.string().datetime(),
    origin: z.literal("manual"),
    event: z.enum(["selection", "reason-recorded"]),
    reason: z.string().trim().min(1).max(2000),
    previousCandidateId: z.string().max(300).nullable(),
    candidateId: z.string().min(1).max(300),
    analysisGeneratedAt: z.string().min(1).max(100),
    analysisSourceRevision: z.number().int().nonnegative().safe(),
    analysisMode: z.enum(["ai", "assisted"]),
    analysisDigest: hash,
    candidateDigest: hash,
    candidate: candidateSelectionSnapshotSchema,
    previousCandidate: candidateSelectionSnapshotSchema.nullable(),
    previousContext: z.enum(["none", "available", "unavailable"]),
    previousRecordId: z.string().uuid().nullable(),
  })
  .strict();
export type CandidateSelection = z.infer<typeof candidateSelectionSchema>;
export type CandidateSelectionCompany = {
  analysis: CompanyAnalysis | null;
  selectedCandidateId: string | null;
  candidateSelections?: CandidateSelection[];
};

/** Canonical public metadata only. Server callers additionally verify the SHA-256 digests. */
export function canonicalSelectionValue(value: unknown): string {
  const normalized = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalized);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, normalized(entry)]),
      );
    return item;
  };
  return JSON.stringify(normalized(value));
}
export function currentCandidateSelection(
  company: CandidateSelectionCompany,
): CandidateSelection | null {
  const analysis = company.analysis;
  const saved = company.candidateSelections?.at(-1);
  if (
    !analysis ||
    !saved ||
    !company.selectedCandidateId ||
    saved.candidateId !== company.selectedCandidateId ||
    saved.analysisGeneratedAt !== analysis.generatedAt ||
    saved.analysisSourceRevision !== analysis.sourceRevision ||
    saved.analysisMode !== analysis.mode
  )
    return null;
  const matches = analysis.candidates.filter(
    (candidate) => candidate.id === company.selectedCandidateId,
  );
  if (
    matches.length !== 1 ||
    canonicalSelectionValue(matches[0]) !== canonicalSelectionValue(saved.candidate)
  )
    return null;
  return saved;
}

export function selectionSnapshotMatches(left: Candidate, right: Candidate): boolean {
  return canonicalSelectionValue(left) === canonicalSelectionValue(right);
}
