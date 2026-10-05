import { z } from "zod";
import {
  publicClaimComparisonLimits,
  publicClaimComparisonSelectionSchema,
} from "./studio-public-claim-comparison-types";
export const publicClaimComparisonRequestVersion = "public-claim-comparison-request-v1" as const;
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const publicClaimComparisonRequestAuthority = Object.freeze({
  transmissionAllowed: false as const,
  approvalVerified: false as const,
  budgetVerified: false as const,
  executionSupported: false as const,
  providerCompatibilityVerified: false as const,
  factVerified: false as const,
  officialProvenanceVerified: false as const,
  companyApplicabilityVerified: false as const,
  fullOriginalVerified: false as const,
  currentValidityVerified: false as const,
  semanticTruthVerified: false as const,
  humanAccepted: false as const,
  databaseChanged: false as const,
});
export const publicClaimComparisonRequestCommandSchema = z
  .object({
    requestVersion: z.literal(publicClaimComparisonRequestVersion),
    model,
    selection: publicClaimComparisonSelectionSchema,
  })
  .strict();
export type PublicClaimComparisonRequestCommand = z.infer<
  typeof publicClaimComparisonRequestCommandSchema
>;

// Request JSON has its own 240k character ceiling, including system, schema and JSON escaping.
export const publicClaimComparisonRequestCharacters = publicClaimComparisonLimits.inputCharacters;
export const publicClaimComparisonRequestIdentitySchema = z
  .object({
    requestVersion: z.literal(publicClaimComparisonRequestVersion),
    commandDigest: hash,
    preparationDigest: hash,
    contractDigest: hash,
    requestDigest: hash,
    rawBodySha256: hash,
    requestCharacters: z.number().int().positive().max(publicClaimComparisonRequestCharacters),
    requestUtf8Bytes: z
      .number()
      .int()
      .positive()
      .max(publicClaimComparisonRequestCharacters * 3),
  })
  .strict();
export type PublicClaimComparisonRequestIdentity = z.infer<
  typeof publicClaimComparisonRequestIdentitySchema
>;

export const publicClaimComparisonRequestPins = Object.freeze({
  systemDigest: "a2141237af61444485a4f148fe67e475603326579eba43dbe435d682eb34c751",
  schemaDigest: "d8efc457688932f3dc493b31481beb788aeef02fa922b34d226d2ba1e434446b",
  contractDigest: "cbcd450aa25801c2911d152f8d3257a9d021a33dfb30c86abec6e036938b8b5e",
});
