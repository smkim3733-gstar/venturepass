import { z } from "zod";
import { STUDIO_AI_INPUT_CHARACTER_LIMIT } from "./studio-ai-input";
import { claimReviewLimits } from "./studio-claim-review-types";
// Shared data contracts only. No preparation, storage, credentials or network access.
export const publicClaimComparisonLimits = Object.freeze({
  selectionBytes: 8 * 1024,
  inputCharacters: STUDIO_AI_INPUT_CHARACTER_LIMIT,
  responseCharacters: 240000,
  sources: claimReviewLimits.sources,
  quoteCharacters: 1500,
  quotesPerSource: 3,
});
export const publicClaimComparisonBoundaries = Object.freeze({
  scope: "selected-public-excerpts" as const,
  evidenceOrigin: "manual-unverified" as const,
  factVerified: false,
  officialProvenanceVerified: false,
  companyApplicabilityVerified: false,
  fullOriginalVerified: false,
  currentValidityVerified: false,
  semanticTruthVerified: false,
  humanAccepted: false,
  transmissionAllowed: false,
  databaseChanged: false,
});
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nonblank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => Boolean(value.trim()));
const distinctIds = z
  .array(uuid)
  .max(publicClaimComparisonLimits.sources)
  .refine((ids) => new Set(ids).size === ids.length);
export const publicClaimComparisonSelectionSchema = z
  .object({
    companyId: uuid,
    companyRevision: z.number().int().nonnegative().safe(),
    claimRecordId: uuid,
    claimVersion: z.number().int().min(1).max(claimReviewLimits.versions),
    claimInputDigest: digest,
    sourceIds: distinctIds.refine((ids) => ids.length > 0),
  })
  .strict();
export type PublicClaimComparisonSelection = z.infer<typeof publicClaimComparisonSelectionSchema>;

const relation = z.enum([
  "provided-text-support",
  "provided-text-conflict",
  "insufficient",
  "undetermined",
]);
const sourceOpinion = z
  .object({
    sourceId: uuid,
    relation,
    quotes: z
      .array(nonblank(publicClaimComparisonLimits.quoteCharacters))
      .max(publicClaimComparisonLimits.quotesPerSource)
      .refine((quotes) => new Set(quotes).size === quotes.length),
    reason: nonblank(2000),
    nextCheck: z.string().max(2000),
  })
  .strict()
  .refine(
    (value) =>
      !["provided-text-support", "provided-text-conflict"].includes(value.relation) ||
      value.quotes.length > 0,
  );
export const publicClaimComparisonResponseSchema = z
  .object({
    preparationDigest: digest,
    claimQuote: nonblank(publicClaimComparisonLimits.quoteCharacters),
    overall: z.object({ relation, reason: nonblank(2000) }).strict(),
    evidence: z.array(sourceOpinion).min(1).max(publicClaimComparisonLimits.sources),
    checks: z
      .array(
        z
          .object({
            dimension: z.enum([
              "period",
              "unit",
              "population",
              "company-applicability",
              "provenance",
              "other",
            ]),
            sourceIds: distinctIds,
            message: nonblank(1000),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
