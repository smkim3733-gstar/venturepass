import { z } from "zod";
import { publicClaimComparisonBoundaries, publicClaimComparisonSelectionSchema, comparisonLiteralShape } from "./studio-public-claim-comparison-types";
import { publicEvidenceDraftSchema } from "./studio-public-evidence";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const d = publicEvidenceDraftSchema.shape;
const boundaryShape = comparisonLiteralShape(publicClaimComparisonBoundaries);
export const publicClaimPreparationSchema = z
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
