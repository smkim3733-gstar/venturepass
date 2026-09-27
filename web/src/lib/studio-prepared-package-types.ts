import { z } from "zod";
import { packageLimits, packageRequestSchema } from "./studio-package-types";
import { planSchema, companyProfileSchema, reviewSchema, sourceSchema } from "./studio-schema";

export const MAX_PREPARED_PACKAGES = 20;
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().safe();
export const preparedPackageRequestSchema = packageRequestSchema
  .extend({
    clientRequestId: uuid,
  })
  .strict();
export type PreparedPackageRequest = z.infer<typeof preparedPackageRequestSchema>;

export const preparedPackageRecordSchema = z
  .object({
    id: uuid,
    version: z.number().int().min(1).max(MAX_PREPARED_PACKAGES),
    caseId: uuid,
    caseRevision: revision,
    clientRequestId: uuid,
    requestDigest: hash,
    input: preparedPackageRequestSchema,
    createdAt: z.string().datetime(),
    scope: z.literal("local-preparation-only"),
    company: z.object({ profile: companyProfileSchema, snapshotSha256: hash }).strict(),
    plan: planSchema.extend({ contentSha256: hash }).strict(),
    sourceIds: z.array(uuid).max(packageLimits.files),
    sources: z
      .array(
        z
          .object({
            source: z.object(sourceSchema.shape).omit({ text: true }).strict(),
            sourceSha256: hash,
            textSha256: hash,
            originalSha256: hash,
            originalSizeBytes: z.number().int().min(1).max(packageLimits.originalBytes),
          })
          .strict(),
      )
      .max(packageLimits.files),
    review: z
      .object({
        storedFindings: z.array(reviewSchema),
        currentRuleFindings: z.array(reviewSchema),
        confirmedAt: z.string().nullable(),
        unconfirmedSectionKeys: z.array(z.string()).max(20),
        currentEvidence: z.boolean(),
        latestPlanVersion: z.boolean(),
        draft: z.boolean(),
        draftReasons: z.array(z.string().max(100)),
      })
      .strict(),
    zip: z
      .object({
        fileName: z.literal("venturepass-preparation-package.zip"),
        sha256: hash,
        sizeBytes: z.number().int().min(1).max(packageLimits.zipBytes),
      })
      .strict(),
  })
  .strict();
export type PreparedPackageRecord = z.infer<typeof preparedPackageRecordSchema>;
export const preparedPackageSummarySchema = z
  .object({
    id: uuid,
    version: z.number().int().min(1).max(MAX_PREPARED_PACKAGES),
    caseId: uuid,
    caseRevision: revision,
    clientRequestId: uuid,
    createdAt: z.string().datetime(),
    scope: z.literal("local-preparation-only"),
    planId: uuid,
    planVersion: z.number().int(),
    planTitle: z.string().max(300),
    planContentSha256: hash,
    sourceIds: z.array(uuid).max(packageLimits.files),
    zipSha256: hash,
    sizeBytes: z.number().int().min(1).max(packageLimits.zipBytes),
    draft: z.boolean(),
    draftReasons: z.array(z.string().max(100)),
    storedReviewCount: z.number().int().nonnegative(),
    currentRuleReviewCount: z.number().int().nonnegative(),
    confirmedAt: z.string().nullable(),
  })
  .strict();
export type PreparedPackageSummary = z.infer<typeof preparedPackageSummarySchema>;
export const preparedPackageListSchema = z
  .object({
    caseId: uuid,
    caseRevision: revision,
    packages: z.array(preparedPackageSummarySchema).max(MAX_PREPARED_PACKAGES),
  })
  .strict();
export const preparedPackageResponseSchema = z
  .object({
    package: preparedPackageRecordSchema,
    replayed: z.boolean(),
  })
  .strict();
export function preparedPackageSummary(record: PreparedPackageRecord): PreparedPackageSummary {
  return preparedPackageSummarySchema.parse({
    id: record.id,
    version: record.version,
    caseId: record.caseId,
    caseRevision: record.caseRevision,
    clientRequestId: record.clientRequestId,
    createdAt: record.createdAt,
    scope: record.scope,
    planId: record.plan.id,
    planVersion: record.plan.version,
    planTitle: record.plan.content.title,
    planContentSha256: record.plan.contentSha256,
    sourceIds: record.sourceIds,
    zipSha256: record.zip.sha256,
    sizeBytes: record.zip.sizeBytes,
    draft: record.review.draft,
    draftReasons: record.review.draftReasons,
    storedReviewCount: record.review.storedFindings.filter((item) => item.severity !== "info")
      .length,
    currentRuleReviewCount: record.review.currentRuleFindings.filter(
      (item) => item.severity !== "info",
    ).length,
    confirmedAt: record.review.confirmedAt,
  });
}
