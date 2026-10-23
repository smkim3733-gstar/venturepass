import { z } from "zod";
import { publicClaimPreparationSchema } from "./studio-public-claim-comparison-preparation-types";
import {
  comparisonLiteralShape,
  comparisonPlanAuthority,
} from "./studio-public-claim-comparison-types";
import { publicClaimComparisonRequestIdentitySchema } from "./studio-public-claim-comparison-request-types";

export const storedReviewHeaders = Object.freeze({
  receipt: "x-venturepass-comparison-request",
  revision: "x-venturepass-company-revision",
  run: "x-venturepass-comparison-run",
  dispatch: "x-venturepass-comparison-dispatch",
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const p = publicClaimPreparationSchema.shape;
export const storedReviewCatalogSchema = z
  .object({
    source: z.literal("comparison-stored-catalog"),
    companyId: z.string().uuid(),
    companyRevision: z.number().int().nonnegative().safe(),
    reviews: z
      .array(
        z
          .object({
            runId: z.string().uuid(),
            dispatchCommandDigest: hash,
            comparisonEventDigest: hash,
            responseArtifactSha256: hash,
            validatedArtifactSha256: hash,
            requestIdentity: publicClaimComparisonRequestIdentitySchema,
            preparationDigest: hash,
            selection: p.selection,
            binding: p.binding,
            sectionKey: p.input.shape.section.shape.key,
            sectionTitle: p.input.shape.section.shape.title,
            claimQuote: p.input.shape.claimQuote,
          })
          .strict(),
      )
      .max(1000),
    currentContextVerified: z.literal(false),
    runtimeObserved: z.literal(false),
    authority: z.object(comparisonLiteralShape(comparisonPlanAuthority)).strict(),
  })
  .strict();
export type StoredReviewCatalog = z.infer<typeof storedReviewCatalogSchema>;
export type StoredReviewCatalogEntry = StoredReviewCatalog["reviews"][number];
export function decodeStoredReviewCatalog(
  value: unknown,
  company: { id: string; revision: number },
) {
  const result = storedReviewCatalogSchema.parse(value);
  if (
    result.companyId !== company.id ||
    result.companyRevision !== company.revision ||
    new Set(result.reviews.map((r) => r.runId)).size !== result.reviews.length ||
    result.reviews.some(
      (r) =>
        r.selection.companyId !== company.id ||
        r.requestIdentity.preparationDigest !== r.preparationDigest,
    )
  )
    throw Error("CATALOG_MISMATCH");
  return result;
}
