import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  publicClaimComparisonBoundaries,
  publicClaimComparisonSelectionSchema,
} from "./studio-public-claim-comparison-types";
import { publicEvidenceDraftSchema, publicEvidenceText } from "./studio-public-evidence";
import type { PublicClaimComparisonPreparation } from "./studio-public-claim-comparison";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const d = publicEvidenceDraftSchema.shape;
const boundaryShape = Object.fromEntries(
  Object.entries(publicClaimComparisonBoundaries).map(([k, v]) => [k, z.literal(v)]),
);
const schema = z
  .object({
    contractVersion: z.literal("public-claim-comparison-v1"),
    ...boundaryShape,
    selection: publicClaimComparisonSelectionSchema,
    binding: z
      .object({
        claimId: uuid,
        claimRecordSha256: hash,
        planId: uuid,
        planVersion: z.number().int().positive(),
        planContentSha256: hash,
      })
      .strict(),
    input: z
      .object({
        claimQuote: z.string().min(1).max(1500),
        section: z
          .object({
            key: z.string().min(1).max(100),
            title: z.string().max(200),
            content: z.string().max(18000),
          })
          .strict(),
        selectedEvidence: z
          .array(
            z
              .object({
                sourceId: uuid,
                sourceUpdatedAt: z.string().datetime(),
                textSha256: hash,
                originalReference: z
                  .object({ quote: z.string().min(1).max(1500), locator: z.string().max(150) })
                  .strict(),
                metadata: z
                  .object({
                    title: d.title,
                    url: d.url,
                    publisher: d.publisher,
                    publishedOn: d.publishedOn,
                    period: d.period,
                    readOn: d.readOn,
                    sectionKey: d.sectionKey,
                  })
                  .strict(),
                excerpt: d.quote,
                manualNotes: z.object({ relevance: d.relevance, conflicts: d.conflicts }).strict(),
              })
              .strict(),
          )
          .min(1)
          .max(10),
        excludedSourceIds: z.array(uuid).max(10),
      })
      .strict(),
    preparationDigest: hash,
    inputCharacters: z.number().int().positive().max(240000),
  })
  .strict();
/** Only stored selection/context consistency. No original company/history/DB authenticity.
 * JSON input keeps accessors/hooks outside this historical read boundary. */
export function inspectArchivedPublicClaimPreparation(
  raw: string,
): PublicClaimComparisonPreparation {
  if (typeof raw !== "string" || raw.length > 242000)
    throw Error("PUBLIC_COMPARISON_CONTEXT_LIMIT");
  const supplied: unknown = JSON.parse(raw);
  const parsed = schema.parse(supplied);
  // Reject trimming, additions, coercion or alternate field order; preserve original v1 bytes.
  if (JSON.stringify(parsed) !== raw) throw Error("PUBLIC_COMPARISON_CONTEXT_FORMAT");
  const { preparationDigest, inputCharacters, ...payload } = parsed;
  const serialized = JSON.stringify(payload);
  const evidence = parsed.input.selectedEvidence;
  if (
    sha(serialized) !== preparationDigest ||
    serialized.length !== inputCharacters ||
    serialized.length > 240000 ||
    !parsed.input.claimQuote.trim() ||
    !parsed.input.section.content.includes(parsed.input.claimQuote) ||
    JSON.stringify(evidence.map((v) => v.sourceId)) !==
      JSON.stringify(parsed.selection.sourceIds) ||
    new Set([...parsed.selection.sourceIds, ...parsed.input.excludedSourceIds]).size !==
      evidence.length + parsed.input.excludedSourceIds.length
  )
    throw Error("PUBLIC_COMPARISON_CONTEXT_MISMATCH");
  for (const v of evidence) {
    if (
      !v.originalReference.quote.trim() ||
      !v.excerpt.includes(v.originalReference.quote) ||
      sha(publicEvidenceText({ ...v.metadata, quote: v.excerpt, ...v.manualNotes })) !==
        v.textSha256
    )
      throw Error("PUBLIC_COMPARISON_CONTEXT_MISMATCH");
  }
  // The dynamic literal shape above was checked against every fixed boundary value.
  return parsed as PublicClaimComparisonPreparation;
}
